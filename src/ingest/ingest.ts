/**
 * `aivis-mcp --ingest`: Para Code が起動する常駐の子（設計 3.1・3.6 R1・N1・N5）。
 *
 * 標準入出力は全部「型 1 バイト ＋ 長さ 4 バイト ＋ 中身」の枠で運ぶ。ログは標準エラーだけに出す。
 * 取り決めの正は docs/ingest-protocol.md。
 */

import { createClient, type RedisClientType } from 'redis';
import { version, type AppConfig } from '../config.js';
import { buildGainTable, loadLearnedGains, MAX_BOOST_DB, TARGET_LUFS } from '../audio/gain-table.js';
import { validatePreludePath } from '../audio/prelude.js';
import { AudioStreamWriter, MAX_STREAM_BYTES } from '../queue/audio-stream.js';
import { enqueueJob, withdrawJob } from '../queue/enqueue.js';
import { clearHold, isValidHoldOwner, setHold } from '../queue/hold.js';
import { isValidStreamId, type Job, type JobPriority, type PreludeSpec } from '../queue/jobs.js';
import { audioStreamKey, WORKER_LOCK_KEY } from '../queue/keys.js';
import { pushStatus, readStatuses, TERMINAL_STATUSES } from '../queue/status.js';
import { ensureWorkerRunning, tryStartRedis } from '../services/redis-service.js';
import {
  encodeControl, FrameDecoder, FrameProtocolError, INGEST_PROTOCOL_VERSION, type Frame,
} from '../streaming/frame-protocol.js';

/** 溜まっている Stream の合計の上限。 */
export const MAX_TOTAL_STREAM_BYTES = 32 * 1024 * 1024;
/** 列で待つ間・hold の間に Stream の期限を延ばす間隔。 */
export const STREAM_TOUCH_INTERVAL_MS = 30_000;
/** worker の lock がこれだけ無ければ、まだ取り出されていないジョブを取り下げる。 */
export const WORKER_MISSING_WITHDRAW_MS = 30_000;
const STATUS_POLL_MS = 200;
/** 終わりの知らせが来ないまま（知らせの期限切れなど）これだけ経った件は追うのをやめる。 */
const TRACK_LIMIT_MS = 15 * 60_000;
const WORKER_CHECK_MS = 5_000;

interface TrackedJob {
  readonly id: string;
  readonly kind: 'stream' | 'sound';
  readonly priority: JobPriority;
  raw: string;
  readonly writer: AudioStreamWriter | undefined;
  readonly openedAt: number;
  statusIndex: number;
  started: boolean;
}

export interface IngestIo {
  readonly input: NodeJS.ReadableStream;
  readonly write: (frame: Buffer) => void;
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

export class IngestSession {
  private readonly decoder = new FrameDecoder();
  private readonly jobs = new Map<string, TrackedJob>();
  private readonly holds = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private workerMissingSince: number | undefined;
  private closed = false;
  private resolveClosed!: () => void;
  readonly closedPromise: Promise<void>;

  constructor(
    private readonly client: RedisClientType,
    private readonly config: AppConfig,
    private readonly preludeDirs: readonly string[],
    private readonly io: IngestIo,
    private readonly options: { readonly spawnWorker?: boolean } = {},
  ) {
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve; });
  }

  /** 名乗ってから標準入力を読み始める。 */
  start(): void {
    this.send({ type: 'hello', protocol: INGEST_PROTOCOL_VERSION, version });
    this.timers.push(setInterval(() => { void this.pollStatuses(); }, STATUS_POLL_MS));
    this.timers.push(setInterval(() => { void this.touchStreams(); }, STREAM_TOUCH_INTERVAL_MS));
    this.timers.push(setInterval(() => { void this.checkWorker(); }, WORKER_CHECK_MS));
    this.io.input.on('data', (chunk: Buffer) => this.onInput(chunk));
    this.io.input.once('end', () => { void this.close(); });
    this.io.input.once('close', () => { void this.close(); });
    this.io.input.once('error', () => { void this.close(); });
    void this.ensureWorker();
  }

  private send(message: Record<string, unknown>): void {
    if (!this.closed) {
      this.io.write(encodeControl(message));
    }
  }

  private onInput(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      // 枠が壊れたら以後の境目が分からない。知らせて終わる
      this.send({ type: 'error', reason: 'protocol', message: error instanceof FrameProtocolError ? error.message : 'broken frame' });
      void this.close();
      return;
    }
    for (const frame of frames) {
      this.chain = this.chain.then(() => this.handleFrame(frame)).catch(error => {
        console.error('[ingest] frame error:', error instanceof Error ? error.message : error);
      });
    }
  }

  private async handleFrame(frame: Frame): Promise<void> {
    if (frame.kind === 'audio') {
      this.handleData(frame.id, frame.data);
      return;
    }
    const message = frame.message;
    switch (message.type) {
      case 'open': return this.handleOpen(message);
      case 'end': return this.handleEnd(message);
      case 'abort': return this.handleAbort(message);
      case 'hold': return this.handleHold(message);
      case 'gain?': return this.handleGain(message);
      case 'withdraw': return this.handleWithdraw(message);
      case 'ping':
        this.send({ type: 'pong', requestId: message.requestId });
        return;
      default:
        this.send({ type: 'error', reason: 'unknown-type', requestType: String(message.type).slice(0, 32) });
    }
  }

  private totalPendingBytes(): number {
    let total = 0;
    for (const job of this.jobs.values()) {
      if (job.writer && !job.writer.isClosed) {
        total += job.writer.bytes;
      }
    }
    return total;
  }

  private async handleOpen(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (!isValidStreamId(id)) {
      this.send({ type: 'status', id: typeof id === 'string' ? id.slice(0, 64) : null, status: 'failed', reason: 'invalid-id' });
      return;
    }
    if (this.jobs.has(id)) {
      this.send({ type: 'status', id, status: 'failed', reason: 'duplicate-id' });
      return;
    }
    const kind = message.kind === 'sound' ? 'sound' : 'stream';
    const priority: JobPriority = message.priority === 'high' ? 'high' : 'normal';
    let prelude: PreludeSpec | undefined;
    let preludeRejected: string | undefined;
    const preludeInput = message.prelude as { path?: unknown; volume?: unknown } | undefined;
    if (preludeInput !== undefined && preludeInput !== null) {
      const check = typeof preludeInput.path === 'string'
        ? validatePreludePath(preludeInput.path, this.preludeDirs)
        : { ok: false as const, reason: 'invalid' };
      if (check.ok) {
        prelude = { path: check.path, volume: numberInRange(preludeInput.volume, 0, 1) ?? 1 };
      } else {
        preludeRejected = check.reason;
      }
    }
    if (kind === 'sound' && prelude === undefined) {
      this.send({ type: 'status', id, status: 'failed', reason: preludeRejected ? `prelude-${preludeRejected}` : 'prelude-required' });
      return;
    }
    this.send(preludeRejected === undefined ? { type: 'accepted', id } : { type: 'accepted', id, preludeRejected });

    const enqueuedAt = Date.now();
    let job: Job;
    let writer: AudioStreamWriter | undefined;
    if (kind === 'sound') {
      job = { v: 2, type: 'sound', id, priority, source: 'ingest', enqueuedAt, prelude: prelude! };
    } else {
      const gainKey = typeof message.gainKey === 'string' && message.gainKey.length <= 300 ? message.gainKey : undefined;
      job = {
        v: 2,
        type: 'stream',
        id,
        priority,
        source: 'ingest',
        enqueuedAt,
        ...(prelude ? { prelude } : {}),
        ...(gainKey ? { gainKey } : {}),
        ...(numberInRange(message.volumeDb, -60, 20) !== undefined ? { volumeDb: message.volumeDb as number } : {}),
        ...(message.tagged === true ? { tagged: true } : {}),
      };
      writer = new AudioStreamWriter(this.client, id, MAX_STREAM_BYTES);
    }
    const tracked: TrackedJob = { id, kind, priority, raw: '', writer, openedAt: enqueuedAt, statusIndex: 0, started: false };
    this.jobs.set(id, tracked);
    try {
      // Stream を先に作る（取り出した worker が「Stream が無い」と捨てないように）
      if (writer) {
        await writer.open();
        await writer.settled();
      }
      const raw = await enqueueJob(this.client, job);
      tracked.raw = raw;
      tracked.statusIndex = 1;
      this.send({ type: 'status', id, status: 'queued' });
    } catch (error) {
      this.jobs.delete(id);
      console.error('[ingest] enqueue error:', error instanceof Error ? error.message : error);
      this.send({ type: 'status', id, status: 'failed', reason: 'redis-error' });
      return;
    }
    // open のたびに worker の lock が生きているか確かめ、無ければ起こす
    void this.ensureWorker();
  }

  private handleData(id: string, data: Buffer): void {
    const job = this.jobs.get(id);
    if (!job || !job.writer) {
      this.send({ type: 'error', reason: 'unknown-stream', id });
      return;
    }
    if (job.writer.isClosed) {
      return;
    }
    if (this.totalPendingBytes() + data.length > MAX_TOTAL_STREAM_BYTES || !job.writer.write(data)) {
      void job.writer.abort('too-large');
      this.send({ type: 'status', id, status: 'failed', reason: 'too-large' });
    }
  }

  private async handleEnd(message: Record<string, unknown>): Promise<void> {
    const job = typeof message.id === 'string' ? this.jobs.get(message.id) : undefined;
    if (!job || !job.writer) {
      this.send({ type: 'error', reason: 'unknown-stream', id: message.id ?? null });
      return;
    }
    await job.writer.end();
  }

  private async handleAbort(message: Record<string, unknown>): Promise<void> {
    const job = typeof message.id === 'string' ? this.jobs.get(message.id) : undefined;
    if (!job) {
      this.send({ type: 'error', reason: 'unknown-stream', id: message.id ?? null });
      return;
    }
    const reason = typeof message.reason === 'string' ? message.reason.slice(0, 64) : 'aborted';
    await job.writer?.abort(reason);
    // まだ取り出されていなければ列から外す（鳴り始めた後なら worker が届いた分で終える）
    if (!job.started && job.raw && await withdrawJob(this.client, job.priority, job.raw)) {
      await pushStatus(this.client, job.id, 'skipped', reason);
    }
  }

  private async handleHold(message: Record<string, unknown>): Promise<void> {
    const owner = message.owner;
    if (!isValidHoldOwner(owner)) {
      this.send({ type: 'error', reason: 'invalid-owner' });
      return;
    }
    if (message.active === false) {
      this.holds.delete(owner);
      await clearHold(this.client, owner);
    } else {
      this.holds.add(owner);
      await setHold(this.client, owner);
    }
    this.send({ type: 'hold', owner, active: message.active !== false });
  }

  private async handleGain(message: Record<string, unknown>): Promise<void> {
    this.send({
      type: 'gain',
      requestId: message.requestId ?? null,
      target: TARGET_LUFS,
      maxBoostDb: MAX_BOOST_DB,
      defaultDb: 0,
      entries: buildGainTable(loadLearnedGains()),
      volumeOffsetDb: this.config.volumeOffsetDb,
      elevenLabsVolumeOffsetDb: this.config.elevenLabsVolumeOffsetDb,
    });
  }

  private async handleWithdraw(message: Record<string, unknown>): Promise<void> {
    const job = typeof message.id === 'string' ? this.jobs.get(message.id) : undefined;
    if (!job || !job.raw) {
      this.send({ type: 'withdrawn', id: message.id ?? null, removed: false });
      return;
    }
    const removed = !job.started && await withdrawJob(this.client, job.priority, job.raw);
    if (removed) {
      await job.writer?.abort('withdrawn');
      this.jobs.delete(job.id);
      await pushStatus(this.client, job.id, 'skipped', 'withdrawn');
      await this.client.del(audioStreamKey(job.id));
    }
    this.send({ type: 'withdrawn', id: job.id, removed });
  }

  private async pollStatuses(): Promise<void> {
    if (this.closed) {
      return;
    }
    for (const job of [...this.jobs.values()]) {
      if (!job.raw) {
        continue;
      }
      if (Date.now() - job.openedAt > TRACK_LIMIT_MS) {
        this.jobs.delete(job.id);
        continue;
      }
      try {
        const { entries, next } = await readStatuses(this.client, job.id, job.statusIndex);
        job.statusIndex = next;
        for (const entry of entries) {
          if (entry.status === 'queued') {
            continue;
          }
          if (entry.status === 'playing') {
            job.started = true;
          }
          this.send(entry.reason === undefined
            ? { type: 'status', id: job.id, status: entry.status }
            : { type: 'status', id: job.id, status: entry.status, reason: entry.reason });
          if (TERMINAL_STATUSES.has(entry.status)) {
            this.jobs.delete(job.id);
            break;
          }
        }
      } catch {
        // Redis が一時的に読めないだけなら次で読む
      }
    }
  }

  private async touchStreams(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.writer) {
        await job.writer.touch().catch(() => undefined);
      }
    }
  }

  private async ensureWorker(): Promise<void> {
    if (this.options.spawnWorker === false) {
      return;
    }
    try {
      await ensureWorkerRunning(this.client, this.config);
    } catch (error) {
      console.error('[ingest] worker check error:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * worker の lock が 30 秒無いときは、まだ取り出されていないジョブを取り下げ（LREM が 1 のときだけ）、
   * Para Code に「取り下げた」と知らせる。Para Code はその件だけ自分で鳴らしてよい。
   */
  async checkWorker(now = Date.now()): Promise<void> {
    if (this.closed) {
      return;
    }
    let lock: string | null;
    try {
      lock = await this.client.get(WORKER_LOCK_KEY);
    } catch {
      return;
    }
    if (lock) {
      this.workerMissingSince = undefined;
      return;
    }
    this.workerMissingSince ??= now;
    void this.ensureWorker();
    if (now - this.workerMissingSince < WORKER_MISSING_WITHDRAW_MS) {
      return;
    }
    for (const job of [...this.jobs.values()]) {
      if (job.started || !job.raw) {
        continue;
      }
      if (await withdrawJob(this.client, job.priority, job.raw)) {
        this.jobs.delete(job.id);
        await pushStatus(this.client, job.id, 'failed', 'worker-unavailable');
        this.send({ type: 'status', id: job.id, status: 'failed', reason: 'worker-unavailable', withdrawn: true });
      }
    }
  }

  /** 親の標準入力が閉じた。書きかけの流れは中断し、自分の hold を外して終わる。 */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.chain.catch(() => undefined);
    this.closed = true;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    for (const job of this.jobs.values()) {
      if (job.writer && !job.writer.isClosed) {
        await job.writer.abort('ingest-closed').catch(() => undefined);
      }
    }
    for (const owner of this.holds) {
      await clearHold(this.client, owner).catch(() => undefined);
    }
    this.holds.clear();
    this.resolveClosed();
  }
}

async function connectForIngest(redisUrl: string): Promise<RedisClientType | undefined> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const client = createClient({ url: redisUrl }) as RedisClientType;
    client.on('error', () => undefined);
    try {
      await client.connect();
      return client;
    } catch {
      await client.disconnect().catch(() => undefined);
      if (attempt === 0) {
        await tryStartRedis();
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  return undefined;
}

/** `aivis-mcp --ingest` の入口。 */
export async function runIngest(config: AppConfig, preludeDirs: readonly string[]): Promise<void> {
  const write = (frame: Buffer) => {
    process.stdout.write(frame);
  };
  // 標準出力は枠だけに使う。うっかり console.log されても枠を壊さないよう、標準エラーへ回す
  console.log = (...args: unknown[]) => console.error(...args);
  const client = await connectForIngest(config.redisUrl);
  if (client === undefined) {
    write(encodeControl({ type: 'hello', protocol: INGEST_PROTOCOL_VERSION, version }));
    write(encodeControl({ type: 'error', reason: 'redis-unavailable' }));
    await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
    process.exit(1);
  }
  client.on('error', error => console.error('[ingest] redis error:', error instanceof Error ? error.message : error));
  const session = new IngestSession(client, config, preludeDirs, { input: process.stdin, write });
  session.start();
  await session.closedPromise;
  await client.disconnect().catch(() => undefined);
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  process.exit(0);
}

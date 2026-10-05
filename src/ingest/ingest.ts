/**
 * `aivis-mcp --ingest`: Para Code が起動する常駐の子（設計 3.1・3.6 R1・N1・N5）。
 *
 * 標準入出力は全部「型 1 バイト ＋ 長さ 4 バイト ＋ 中身」の枠で運ぶ。ログは標準エラーだけに出す。
 * 取り決めの正は docs/ingest-protocol.md。
 */

import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createClient, type RedisClientType } from 'redis';
import { version, type AppConfig } from '../config.js';
import { buildGainTable, loadLearnedGains, MAX_BOOST_DB, TARGET_LUFS } from '../audio/gain-table.js';
import { validatePreludePath } from '../audio/prelude.js';
import { MAX_UTTERANCE_MS } from '../streaming/playback-policy.js';
import { AudioStreamWriter, cancelStreamById, MAX_STREAM_BYTES, STREAM_TTL_SECONDS } from '../queue/audio-stream.js';
import { enqueueJob, findQueuedJob, isJobRegistered, withdrawJob, withdrawJobByIdDetailed } from '../queue/enqueue.js';
import { anyHoldActive, clearHold, holdStartedAt, isValidHoldOwner, loadHoldIntervals, setHold } from '../queue/hold.js';
import { heldOverlapMs, isValidStreamId, type Job, type JobPriority, type PreludeSpec } from '../queue/jobs.js';
import {
  audioStreamKey, PLAY_LOCK_KEY, preludeDirsKey, PRELUDE_DIRS_TTL_SECONDS, queueKeyFor, statusKey, WORKER_LOCK_KEY,
} from '../queue/keys.js';
import { decodeStatus, pushStatus, readStatuses, STATUS_TTL_SECONDS, TERMINAL_STATUSES, type JobStatus } from '../queue/status.js';
import { OperationTimeoutError, REDIS_OP_TIMEOUT_MS } from '../queue/timeout.js';
import { ensureWorkerRunning, tryStartRedis } from '../services/redis-service.js';
import {
  encodeControl, FrameDecoder, FrameProtocolError, INGEST_PROTOCOL_VERSION, type Frame,
} from '../streaming/frame-protocol.js';

/** 溜まっている Stream の合計の上限。 */
export const MAX_TOTAL_STREAM_BYTES = 32 * 1024 * 1024;
/** 列で待つ間・hold の間に Stream と知らせの期限を延ばす間隔。 */
export const STREAM_TOUCH_INTERVAL_MS = 30_000;
/** worker の lock がこれだけ無ければ、まだ取り出されていないジョブを取り下げる。 */
export const WORKER_MISSING_WITHDRAW_MS = 30_000;
/** 列から消えたのに playing が来ないまま、これだけ経ったら見失ったとみなす。 */
export const DEQUEUED_SILENT_MS = 30_000;
/** playing の後、終わりの知らせが来ないまま、これだけ経ったら見失ったとみなす。 */
export const PLAYING_SILENT_MS = MAX_UTTERANCE_MS + 60_000;
/** 終わりの知らせが来ないまま、これだけ経った件は追うのをやめる。 */
export const TRACK_LIMIT_MS = 15 * 60_000;
/** 処理待ちの枠がこれを超えたら標準入力を止める（背圧）。 */
export const BACKPRESSURE_FRAMES = 256;
export const BACKPRESSURE_BYTES = 4 * 1024 * 1024;
/** 終わった件の ID を覚えておく時間（後から来た枠を黙って捨てる）。 */
const FINISHED_MEMORY_MS = 5 * 60_000;
const FINISHED_MEMORY_MAX = 4096;
const STATUS_POLL_MS = 200;
const WORKER_CHECK_MS = 5_000;
const CLOSE_WAIT_MS = 3_000;
/** 背圧で止めてから進まないまま、これだけ経ったら読むのを再開する。 */
const PAUSE_WATCHDOG_MS = 10_000;
/** end の後、Redis へ書き残しを送り終えるまで待つ上限（過ぎたらその流れを redis-error で終える）。 */
const END_FLUSH_TIMEOUT_MS = 10_000;

interface TrackedJob {
  readonly id: string;
  readonly kind: 'stream' | 'sound';
  readonly priority: JobPriority;
  raw: string;
  readonly writer: AudioStreamWriter | undefined;
  readonly openedAt: number;
  statusIndex: number;
  started: boolean;
  startedAt: number | undefined;
  /** worker が取り出した（dequeued が来た） */
  dequeued: boolean;
  /** 列に見当たらないまま数えた時間（再生 lock をほかが持つ間は数えない） */
  lostMs: number;
  lastLostCheck: number | undefined;
  /** open した時点での hold の累計（追跡の上限から hold の時間を除くため） */
  readonly heldAtOpen: number;
  /** 列に積めたか。unknown は積む要求の応答が失われた（積めたかどうか、ID で確かめ直す） */
  registration: 'pending' | 'confirmed' | 'unknown';
  /** 取り出した worker の ID（dequeued に載る） */
  dequeuedBy: string | undefined;
  /** 中断（abort）を受け付けた */
  abortRequested: boolean;
  /** 前の --ingest から引き継いだ（Stream はこの子が書いていない） */
  adopted?: boolean;
}

export interface IngestIo {
  readonly input: NodeJS.ReadableStream;
  readonly write: (frame: Buffer) => void;
}

export interface IngestOptions {
  readonly spawnWorker?: boolean;
  /** テスト用: 時計 */
  readonly now?: () => number;
  /** テスト用: 背圧のバイト数の閾値 */
  readonly backpressureBytes?: number;
  /** テスト用: Redis の 1 つの操作を待つ上限 */
  readonly opTimeoutMs?: number;
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}


export class IngestSession {
  private readonly decoder = new FrameDecoder();
  private readonly jobs = new Map<string, TrackedJob>();
  /** 終わった件の ID と、覚えておく期限 */
  private readonly finished = new Map<string, number>();
  private readonly holds = new Set<string>();
  /** open・音声・end・abort・withdraw（同じ流れの中で順を保つ） */
  private chain: Promise<void> = Promise.resolve();
  /** hold・gain?・ping（音声の書き込み待ちに巻き込まない） */
  private controlChain: Promise<void> = Promise.resolve();
  /** 枠の処理から切り離して走らせている後始末（閉じるときに待つ） */
  private readonly background = new Set<Promise<void>>();
  private chainFrames = 0;
  private chainBytes = 0;
  private paused = false;
  private pausedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private workerMissingSince: number | undefined;
  private protocolFailed = false;
  private closing = false;
  private closed = false;
  private resolveClosed!: () => void;
  readonly closedPromise: Promise<void>;
  private readonly now: () => number;
  /** この --ingest の ID（許可フォルダのキーに使う） */
  readonly ingestId = uuidv4();
  /** hold が掛かっていた時間の累計（5 秒ごとに数える） */
  private heldAccumMs = 0;
  private lastHoldCheck: number | undefined;

  constructor(
    private readonly client: RedisClientType,
    private readonly loadConfig: () => AppConfig,
    private readonly preludeDirs: readonly string[],
    private readonly io: IngestIo,
    private readonly options: IngestOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve; });
  }

  /** Redis の操作に上限を付ける。 */
  private op<T>(promise: Promise<T>, ms = this.options.opTimeoutMs ?? REDIS_OP_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OperationTimeoutError(ms)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  /** 枠の処理を止めずに走らせる（閉じるときは待つ）。 */
  private runInBackground(task: () => Promise<void>): void {
    const promise = task().catch(error => {
      console.error('[ingest] background error:', error instanceof Error ? error.message : error);
    });
    this.background.add(promise);
    void promise.finally(() => this.background.delete(promise));
  }

  /** 名乗ってから標準入力を読み始める。 */
  start(): void {
    this.send({ type: 'hello', protocol: INGEST_PROTOCOL_VERSION, version });
    this.schedulePoll();
    this.timers.push(setInterval(() => { void this.touch(); }, STREAM_TOUCH_INTERVAL_MS));
    this.timers.push(setInterval(() => { void this.checkWorker(); }, WORKER_CHECK_MS));
    // 止めたまま進まない（Redis が応答しない）ときも、親が閉じたことに気付けるよう読むのを再開する
    this.timers.push(setInterval(() => {
      if (this.paused && this.now() - this.pausedAt >= PAUSE_WATCHDOG_MS) {
        this.paused = false;
        if (!this.closing) {
          this.io.input.resume();
        }
      }
    }, 1000));
    this.io.input.on('data', (chunk: Buffer) => this.onInput(chunk));
    this.io.input.once('end', () => { void this.close(); });
    this.io.input.once('close', () => { void this.close(); });
    this.io.input.once('error', () => { void this.close(); });
    void this.ensureWorker();
  }

  /** テスト用: 追っている件の数。 */
  get trackedCount(): number {
    return this.jobs.size;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.closed) {
      this.io.write(encodeControl(message));
    }
  }

  /**
   * worker が鳴らす前に確かめられるよう、許可フォルダを Redis に置く（実パスに直して）。
   * `--ingest` ごとのキーで期限 90 秒、30 秒ごとに置き直す。起動時は名乗る前に置く。
   */
  async publishPreludeDirs(): Promise<void> {
    const dirs: string[] = [];
    for (const dir of this.preludeDirs) {
      try {
        dirs.push(fs.realpathSync(dir));
      } catch {
        // 無いフォルダは置かない
      }
    }
    if (dirs.length === 0) {
      return;
    }
    try {
      const key = preludeDirsKey(this.ingestId);
      await this.op(this.client.multi().sAdd(key, dirs).expire(key, PRELUDE_DIRS_TTL_SECONDS).exec());
    } catch {
      // 次の延長で置き直す
    }
  }

  private onInput(chunk: Buffer): void {
    if (this.protocolFailed || this.closing) {
      return;
    }
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      // 枠が壊れたら以後の境目が分からない。1 回だけ知らせ、以後の入力は捨てて終わる
      this.protocolFailed = true;
      this.send({ type: 'error', reason: 'protocol', message: error instanceof FrameProtocolError ? error.message : 'broken frame' });
      void this.close();
      return;
    }
    for (const frame of frames) {
      const size = frame.kind === 'audio' ? frame.data.length : 0;
      this.chainFrames++;
      this.chainBytes += size;
      const done = () => {
        this.chainFrames--;
        this.chainBytes -= size;
        this.updateBackpressure();
      };
      const report = (error: unknown) => {
        console.error('[ingest] frame error:', error instanceof Error ? error.message : error);
      };
      if (frame.kind === 'control' && isControlOnly(frame.message.type)) {
        // hold などは、Redis への音声の書き込みが詰まっていても待たせない
        this.controlChain = this.controlChain.then(() => this.handleFrame(frame)).catch(report).finally(done);
      } else {
        this.chain = this.chain.then(() => this.handleFrame(frame)).catch(report).finally(done);
      }
    }
    this.updateBackpressure();
  }

  /** 処理待ちが溜まったら標準入力を止め、半分まで減ったら再開する。 */
  private updateBackpressure(): void {
    let writerFrames = 0;
    let writerBytes = 0;
    for (const job of this.jobs.values()) {
      writerFrames += job.writer?.backlog ?? 0;
      writerBytes += job.writer?.backlogBytes ?? 0;
    }
    const frames = this.chainFrames + writerFrames;
    const bytes = this.chainBytes + writerBytes;
    const limit = this.options.backpressureBytes ?? BACKPRESSURE_BYTES;
    if (!this.paused && (frames > BACKPRESSURE_FRAMES || bytes > limit)) {
      this.paused = true;
      this.pausedAt = this.now();
      this.io.input.pause();
    } else if (this.paused && frames <= BACKPRESSURE_FRAMES / 2 && bytes <= limit / 2) {
      this.paused = false;
      if (!this.closing) {
        this.io.input.resume();
      }
    }
  }

  private isFinished(id: unknown): boolean {
    if (typeof id !== 'string') {
      return false;
    }
    const until = this.finished.get(id);
    if (until === undefined) {
      return false;
    }
    if (until < this.now()) {
      this.finished.delete(id);
      return false;
    }
    return true;
  }

  private rememberFinished(id: string): void {
    this.finished.set(id, this.now() + FINISHED_MEMORY_MS);
    if (this.finished.size > FINISHED_MEMORY_MAX) {
      const oldest = this.finished.keys().next().value;
      if (oldest !== undefined) {
        this.finished.delete(oldest);
      }
    }
  }

  /**
   * 終わった件を片付ける。親への終わりの知らせはここからだけ出す（1 件に 1 回）。
   * 以後の書き込みは捨て、後から来た枠も黙って捨てる。
   */
  private finishJob(job: TrackedJob, status: JobStatus, reason?: string, extra: Record<string, unknown> = {}, removeStream = true): void {
    if (!this.jobs.has(job.id)) {
      return;
    }
    this.jobs.delete(job.id);
    this.rememberFinished(job.id);
    const writer = job.writer;
    if (writer) {
      writer.discard();
      if (removeStream) {
        // worker が Stream を消した後に、送りかけていた断片がキーを作り直していたら消す
        void writer.settled().catch(() => undefined).then(() => this.client.del(writer.key)).catch(() => undefined);
      }
    }
    this.send({ type: 'status', id: job.id, status, ...(reason === undefined ? {} : { reason }), ...extra });
    this.updateBackpressure();
  }

  private async handleFrame(frame: Frame): Promise<void> {
    if (this.closed) {
      return;
    }
    if (frame.kind === 'audio') {
      await this.handleData(frame.id, frame.data);
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
      case 'adopt': return this.handleAdopt(message);
      case 'ping':
        this.send({ type: 'pong', requestId: message.requestId });
        return;
      default:
        this.send({ type: 'error', reason: 'unknown-type', requestType: String(message.type).slice(0, 32) });
    }
  }

  /**
   * この --ingest が積んで、まだ終わりの知らせを返していない流れの合計（end を受けた流れも、
   * 鳴り終わる・取り下げる・消すまで数える。Redis に残っている間は Redis のメモリを使うため）。
   */
  private totalPendingBytes(): number {
    let total = 0;
    for (const job of this.jobs.values()) {
      total += job.writer?.bytes ?? 0;
    }
    return total;
  }

  private async handleOpen(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (!isValidStreamId(id)) {
      this.send({ type: 'status', id: typeof id === 'string' ? id.slice(0, 64) : null, status: 'failed', reason: 'invalid-id', withdrawn: true });
      return;
    }
    if (this.jobs.has(id) || this.isFinished(id)) {
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
      this.rememberFinished(id);
      this.send({ type: 'status', id, status: 'failed', reason: preludeRejected ? `prelude-${preludeRejected}` : 'prelude-required', withdrawn: true });
      return;
    }
    this.send(preludeRejected === undefined ? { type: 'accepted', id } : { type: 'accepted', id, preludeRejected });

    const enqueuedAt = this.now();
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
      writer = new AudioStreamWriter(this.client, id, MAX_STREAM_BYTES, {
        // Redis への書き残しが減ったら背圧を解く（止めたままにしない）
        onProgress: () => this.updateBackpressure(),
        // 途中の断片が抜けた流れは鳴らさない
        onError: () => { void this.failWriter(id); },
      });
    }
    const tracked: TrackedJob = {
      id, kind, priority, raw: '', writer, openedAt: enqueuedAt, statusIndex: 0, started: false, startedAt: undefined,
      dequeued: false, lostMs: 0, lastLostCheck: undefined, heldAtOpen: this.heldAccumMs,
      registration: 'pending', dequeuedBy: undefined, abortRequested: false,
    };
    this.jobs.set(id, tracked);
    try {
      // Stream を先に作る（取り出した worker が「Stream が無い」と捨てないように）
      if (writer) {
        await this.op(writer.open());
        await this.op(writer.settled());
      }
    } catch (error) {
      // まだ積んでいない。積めていないことが確かなので、親は自分で鳴らしてよい
      console.error('[ingest] stream open error:', error instanceof Error ? error.message : error);
      writer?.discard();
      this.finishJob(tracked, 'failed', 'redis-error', { withdrawn: true });
      return;
    }
    const raw = JSON.stringify(job);
    tracked.raw = raw;
    try {
      // 積むのと queued の知らせは 1 回（MULTI）で送る
      await this.op(enqueueJob(this.client, job));
      this.confirmQueued(tracked);
    } catch (error) {
      console.error('[ingest] enqueue error:', error instanceof Error ? error.message : error);
      // 応答だけが失われたかもしれない。ID で確かめるまで「積めていない」とは扱わない
      const registered = await this.op(isJobRegistered(this.client, job, raw)).catch(() => undefined);
      if (registered === true) {
        this.confirmQueued(tracked);
      } else if (registered === false) {
        this.finishJob(tracked, 'failed', 'redis-error', { withdrawn: true });
        return;
      } else {
        // 確かめられない。追い続け、Redis が戻ったら確かめ直す（その間は queued を返さない）
        tracked.registration = 'unknown';
      }
    }
    // open のたびに worker の lock が生きているか確かめ、無ければ起こす
    void this.ensureWorker();
  }

  /** 積めたと確かめた。queued を返す。 */
  private confirmQueued(job: TrackedJob): void {
    if (job.registration === 'confirmed' || !this.jobs.has(job.id)) {
      return;
    }
    job.registration = 'confirmed';
    job.statusIndex = Math.max(job.statusIndex, 1);
    this.send({ type: 'status', id: job.id, status: 'queued' });
  }

  private async handleData(id: string, data: Buffer): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || !job.writer) {
      if (!this.isFinished(id)) {
        this.send({ type: 'error', reason: 'unknown-stream', id });
      }
      return;
    }
    if (job.writer.isClosed) {
      return;
    }
    if (this.totalPendingBytes() + data.length > MAX_TOTAL_STREAM_BYTES || !job.writer.write(data)) {
      // 中断の印は worker に届ける（鳴り始めていれば届いた分で終える）。親への終わりは 1 回だけ
      // 中断の印を書き終えてから片付ける（片付けると以後の書き込みは捨てるので）。待つのは上限まで
      await this.op(job.writer.abort('too-large')).catch(() => undefined);
      const withdrawn = !job.started && job.raw !== ''
        && await this.op(withdrawJob(this.client, job.priority, job.raw)).catch(() => false);
      // 鳴り始めていれば、worker が中断の印を読んで届いた分で終えるまで Stream を残す
      this.finishJob(job, 'failed', 'too-large', withdrawn ? { withdrawn: true } : {}, withdrawn);
    }
  }

  private async handleEnd(message: Record<string, unknown>): Promise<void> {
    const job = typeof message.id === 'string' ? this.jobs.get(message.id) : undefined;
    if (!job || !job.writer) {
      if (!this.isFinished(message.id)) {
        this.send({ type: 'error', reason: 'unknown-stream', id: message.id ?? null });
      }
      return;
    }
    // 書き残しを送り終えるのを、ほかの枠の処理を止めずに待つ。期限を過ぎたら以後の書き込みを捨て、
    // 途中が抜けた音声を鳴らさないよう redis-error で終える
    const writer = job.writer;
    const flushed = writer.end();
    this.runInBackground(async () => {
      try {
        await this.op(flushed, END_FLUSH_TIMEOUT_MS);
        if (writer.failed) {
          await this.failWriter(job.id);
        }
      } catch {
        // 書き残しが詰まっている。後ろに並ばない中断の印を上限つきで直接書いてから、以後の書き込みを捨てる
        await this.op(this.client.multi().xAdd(writer.key, '*', { a: 'redis-error' }).expire(writer.key, STREAM_TTL_SECONDS).exec(), 1000).catch(() => undefined);
        writer.discard();
        await this.failWriter(job.id);
      }
    });
  }

  /**
   * Redis への書き込みに失敗した（Redis が一瞬切れたなど）。途中が抜けた音声を鳴らさないよう、
   * 中断の印を書いて failed（redis-error）で終える。worker は中断された流れを覚え直しにも使わない。
   */
  private async failWriter(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || !job.writer) {
      return;
    }
    if (job.registration === 'pending') {
      // まだ積んでいる途中。積めたかどうかは open の処理が確かめて終える
      return;
    }
    if (!job.writer.isDiscarded) {
      await this.op(job.writer.abort('redis-error'), 2000).catch(() => undefined);
    }
    // 書き込みが詰まったままなら、以後の書き込みを捨てる（後から途中の断片が書かれないように）
    job.writer.discard();
    const withdrawn = !job.started && job.raw !== ''
      && await this.op(withdrawJob(this.client, job.priority, job.raw)).catch(() => false);
    this.finishJob(job, 'failed', 'redis-error', withdrawn ? { withdrawn: true } : {}, withdrawn);
  }

  private async handleAbort(message: Record<string, unknown>): Promise<void> {
    const job = typeof message.id === 'string' ? this.jobs.get(message.id) : undefined;
    if (!job) {
      if (!this.isFinished(message.id)) {
        this.send({ type: 'error', reason: 'unknown-stream', id: message.id ?? null });
      }
      return;
    }
    if (job.abortRequested) {
      return;
    }
    job.abortRequested = true;
    const reason = typeof message.reason === 'string' ? message.reason.slice(0, 64) : 'aborted';
    const writer = job.writer;
    // 入力の途中なら中断の印、end の後なら「鳴らすのをやめる」印を書く（worker は鳴らし始める前なら捨てる）。
    // 書き込みの完了は待たない（Redis が詰まっていても、後ろの枠を止めない）
    // 引き継いだ件は書く側がいないので、Stream に「鳴らすのをやめる印」を直接書く（取り出した後・鳴り始める前でも効く）
    const marked = writer !== undefined
      ? (writer.isClosed ? writer.cancel(reason) : writer.abort(reason))
      : (job.adopted && job.kind === 'stream' ? cancelStreamById(this.client, job.id, reason).then(() => undefined) : Promise.resolve());
    this.runInBackground(async () => {
      await this.op(marked).catch(() => undefined);
      // まだ取り出されていなければ列から外す（鳴り始めた後なら worker が届いた分で終える）
      if (!job.started && job.raw && this.jobs.has(job.id) && await this.withdrawTracked(job)) {
        await this.op(pushStatus(this.client, job.id, 'skipped', reason)).catch(() => undefined);
        this.finishJob(job, 'skipped', reason);
      }
    });
  }

  /**
   * 追っている件を列から外す（LREM が 1 のときだけ true）。引き継いだ件は書く側がいないので、外せたら
   * Stream もここで消す（この子の件は finishJob が writer 越しに消す）。
   */
  private async withdrawTracked(job: TrackedJob): Promise<boolean> {
    const removed = await this.op(withdrawJob(this.client, job.priority, job.raw)).catch(() => false);
    if (removed && job.adopted && job.kind === 'stream') {
      await this.op(this.client.del(audioStreamKey(job.id))).catch(() => undefined);
    }
    return removed;
  }

  private async handleHold(message: Record<string, unknown>): Promise<void> {
    const owner = message.owner;
    if (!isValidHoldOwner(owner)) {
      this.send({ type: 'error', reason: 'invalid-owner' });
      return;
    }
    try {
      if (message.active === false) {
        this.holds.delete(owner);
        await this.op(clearHold(this.client, owner));
      } else {
        this.holds.add(owner);
        await this.op(setHold(this.client, owner));
      }
      this.send({ type: 'hold', owner, active: message.active !== false });
    } catch {
      this.send({ type: 'error', reason: 'redis-error', owner });
    }
  }

  private async handleGain(message: Record<string, unknown>): Promise<void> {
    // 上乗せは毎回いまの設定から読む（tts-configure で変えたものを反映する）
    const config = this.loadConfig();
    this.send({
      type: 'gain',
      requestId: message.requestId ?? null,
      target: TARGET_LUFS,
      maxBoostDb: MAX_BOOST_DB,
      defaultDb: 0,
      entries: { ...buildGainTable(loadLearnedGains()) },
      volumeOffsetDb: config.volumeOffsetDb,
      elevenLabsVolumeOffsetDb: config.elevenLabsVolumeOffsetDb,
    });
  }

  /**
   * まだ worker が取り出していないジョブを列から外す。前の `--ingest`（落ちた子）が積んだジョブも、
   * ID で列を探して外す。外せたら Stream と知らせを消す。取り出し済み（dequeued・playing がある）なら外さない。
   */
  private async handleWithdraw(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (!isValidStreamId(id)) {
      this.send({ type: 'withdrawn', id: typeof id === 'string' ? id.slice(0, 64) : null, removed: false });
      return;
    }
    const job = this.jobs.get(id);
    if (job?.started) {
      this.send({ type: 'withdrawn', id, removed: false, taken: true });
      return;
    }
    // 列にあれば外し、無ければ「積まれていない」と「取り出し済み」を分ける（1 つのスクリプトで判定する）。
    // 同じ子の open の後ろに並ぶので、この子が送った積む要求は判定より先に Redis に届いている
    let result: Awaited<ReturnType<typeof withdrawJobByIdDetailed>> | undefined;
    try {
      result = await this.op(withdrawJobByIdDetailed(this.client, id));
    } catch {
      result = undefined;
    }
    if (result === 'removed' || result === 'not-queued') {
      if (job) {
        this.jobs.delete(id);
        job.writer?.discard();
        this.updateBackpressure();
        // 送りかけていた断片がキーを作り直さないよう、書き終わってから消し直す
        const writer = job.writer;
        if (writer) {
          this.runInBackground(async () => {
            await this.op(writer.settled(), 2000).catch(() => undefined);
            await this.op(this.client.del([audioStreamKey(id), statusKey(id)])).catch(() => undefined);
          });
        }
      }
      this.rememberFinished(id);
    }
    if (result === 'removed') {
      this.send({ type: 'withdrawn', id, removed: true });
    } else if (result === 'not-queued') {
      this.send({ type: 'withdrawn', id, removed: false, notQueued: true });
    } else if (result === 'taken') {
      this.send({ type: 'withdrawn', id, removed: false, taken: true });
    } else {
      // Redis に確かめられなかった。どちらとも言えない
      this.send({ type: 'withdrawn', id, removed: false });
    }
  }

  /**
   * 前の `--ingest`（落ちた・入れ替えた子）が積んだ件の追跡を引き継ぐ。以後、Stream と知らせの期限の延長と、
   * 知らせの読み取り・親への中継をこの子が行う。列にも知らせにも無い ID は引き継がない。
   */
  private async handleAdopt(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (!isValidStreamId(id)) {
      this.send({ type: 'adopted', id: typeof id === 'string' ? id.slice(0, 64) : null, adopted: false });
      return;
    }
    if (this.jobs.has(id)) {
      this.send({ type: 'adopted', id, adopted: true });
      return;
    }
    let queued: Awaited<ReturnType<typeof findQueuedJob>>;
    let statuses: Awaited<ReturnType<typeof readStatuses>>;
    try {
      [queued, statuses] = await this.op(Promise.all([findQueuedJob(this.client, id), readStatuses(this.client, id, 0)]));
    } catch {
      this.send({ type: 'adopted', id, adopted: false });
      return;
    }
    if (queued === undefined && statuses.entries.length === 0) {
      this.send({ type: 'adopted', id, adopted: false });
      return;
    }
    const first = statuses.entries[0];
    const openedAt = first?.at || this.now();
    // 引き継ぐ前（前の子が追っていた間）の hold の時間も追跡の上限から除く。累積は Redis の hold の記録から読む
    const heldBeforeAdopt = await this.heldMsBetween(openedAt, this.now());
    if (this.jobs.has(id)) {
      this.send({ type: 'adopted', id, adopted: true });
      return;
    }
    const tracked: TrackedJob = {
      id,
      kind: queued?.type === 'sound' ? 'sound' : 'stream',
      priority: queued?.priority ?? 'normal',
      // 取り出し済みなら積んだ文字列は分からない（列から外す・位置を探すのには使えない値にしておく）
      raw: queued?.raw ?? `adopted:${id}`,
      writer: undefined,
      openedAt,
      statusIndex: 0,
      started: false,
      startedAt: undefined,
      dequeued: false,
      lostMs: 0,
      lastLostCheck: undefined,
      heldAtOpen: this.heldAccumMs - heldBeforeAdopt,
      registration: 'confirmed',
      dequeuedBy: undefined,
      abortRequested: false,
      adopted: true,
    };
    this.finished.delete(id);
    this.jobs.set(id, tracked);
    this.send({ type: 'adopted', id, adopted: true });
    // 知らせは頭から読み直し、playing と終わりを中継する（queued は返さない）
    void this.pollStatuses();
  }

  /** `from` から `to` までに hold が掛かっていた時間（Redis の hold の記録から。読めなければ 0）。 */
  private async heldMsBetween(from: number, to: number): Promise<number> {
    try {
      const [intervals, since] = await this.op(Promise.all([loadHoldIntervals(this.client), holdStartedAt(this.client)]));
      if (since !== undefined) {
        intervals.push([since, to]);
      }
      return heldOverlapMs(intervals, from, to);
    } catch {
      return 0;
    }
  }

  private schedulePoll(): void {
    if (this.closed) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void this.pollStatuses().finally(() => this.schedulePoll());
    }, STATUS_POLL_MS);
  }

  /** 進み具合を読んで親へ返す。前の読み取りが終わってから次を予約する（重ならない）。 */
  async pollStatuses(): Promise<void> {
    if (this.closed || this.polling) {
      return;
    }
    this.polling = true;
    try {
      for (const job of [...this.jobs.values()]) {
        if (!job.raw || !this.jobs.has(job.id)) {
          continue;
        }
        // hold の間は数えない
        if (this.now() - job.openedAt - (this.heldAccumMs - job.heldAtOpen) > TRACK_LIMIT_MS) {
          // 追うのをやめる前に、まだ列にあれば外す。外せたときだけ withdrawn を付ける（外せなければ鳴るかもしれない）
          const withdrawn = !job.started && await this.withdrawTracked(job);
          this.finishJob(job, 'failed', 'untracked', withdrawn ? { withdrawn: true } : {});
          continue;
        }
        if (job.registration === 'unknown') {
          // 積む要求の応答が失われた件。積めたかを ID で確かめ直す
          const registered = await this.op(isJobRegistered(this.client, job, job.raw)).catch(() => undefined);
          if (registered === undefined) {
            continue;
          }
          if (!registered) {
            this.finishJob(job, 'failed', 'redis-error', { withdrawn: true });
            continue;
          }
          this.confirmQueued(job);
        }
        try {
          // 知らせのキーが期限切れで作り直されたら、頭から読み直す（先頭は必ず queued なので、そうでなければ作り直し）
          if (job.statusIndex > 0) {
            const first = await this.op(this.client.lIndex(statusKey(job.id), 0));
            if (first === null || decodeStatus(first)?.status !== 'queued') {
              job.statusIndex = 0;
            }
          }
          const { entries, next } = await this.op(readStatuses(this.client, job.id, job.statusIndex));
          job.statusIndex = next;
          for (const entry of entries) {
            if (!this.jobs.has(job.id)) {
              break;
            }
            if (entry.status === 'queued') {
              continue;
            }
            if (entry.status === 'dequeued') {
              job.dequeued = true;
              job.dequeuedBy = entry.worker;
              job.lostMs = 0;
              job.lastLostCheck = undefined;
              continue;
            }
            if (entry.status === 'requeued') {
              // worker が列へ戻した（hold・lock の取り直し・優先の入れ替え）。また列で待つ
              job.dequeued = false;
              job.dequeuedBy = undefined;
              job.lostMs = 0;
              job.lastLostCheck = undefined;
              continue;
            }
            if (TERMINAL_STATUSES.has(entry.status)) {
              this.finishJob(job, entry.status, entry.reason);
              break;
            }
            if (entry.status === 'playing' && !job.started) {
              job.started = true;
              job.startedAt = this.now();
              this.send({ type: 'status', id: job.id, status: 'playing' });
            }
          }
        } catch {
          // Redis が一時的に読めないだけなら次で読む
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** Stream・知らせ・許可フォルダの期限を延ばす（列で待つ間・hold の間に消えないように）。 */
  private async touch(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.writer) {
        await this.op(job.writer.touch()).catch(() => undefined);
      } else if (job.adopted && job.kind === 'stream') {
        // 引き継いだ件の Stream も延ばす（EXPIRE はキーを作らない）
        await this.op(this.client.expire(audioStreamKey(job.id), STREAM_TTL_SECONDS)).catch(() => undefined);
      }
      await this.op(this.client.expire(statusKey(job.id), STATUS_TTL_SECONDS)).catch(() => undefined);
    }
    await this.publishPreludeDirs();
  }

  private async ensureWorker(): Promise<void> {
    if (this.options.spawnWorker === false) {
      return;
    }
    try {
      await this.op(ensureWorkerRunning(this.client, this.loadConfig()));
    } catch (error) {
      console.error('[ingest] worker check error:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * worker の様子を確かめる。
   * - lock が 30 秒無いときは、まだ取り出されていないジョブを取り下げ（LREM が 1 のときだけ）、
   *   `failed`（worker-unavailable、withdrawn）を返す。親はその件だけ自分で鳴らしてよい
   * - 取り出されたのに playing が来ない件、playing の後に終わりが来ない件は `failed`（lost）を返す
   */
  async checkWorker(now = this.now()): Promise<void> {
    if (this.closed) {
      return;
    }
    let lock: string | null;
    try {
      lock = await this.op(this.client.get(WORKER_LOCK_KEY));
    } catch {
      return;
    }
    // 追跡の上限から除く hold の時間を数える
    try {
      const holding = await this.op(anyHoldActive(this.client));
      if (holding && this.lastHoldCheck !== undefined) {
        this.heldAccumMs += Math.max(0, now - this.lastHoldCheck);
      }
      this.lastHoldCheck = now;
    } catch {
      // 数えられなかった回は飛ばす
    }
    if (lock) {
      this.workerMissingSince = undefined;
    } else {
      this.workerMissingSince ??= now;
      void this.ensureWorker();
    }
    const workerGone = this.workerMissingSince !== undefined && now - this.workerMissingSince >= WORKER_MISSING_WITHDRAW_MS;
    for (const job of [...this.jobs.values()]) {
      if (!job.raw || !this.jobs.has(job.id) || job.registration !== 'confirmed') {
        continue;
      }
      if (job.started) {
        if (workerGone || (job.startedAt !== undefined && now - job.startedAt >= PLAYING_SILENT_MS)) {
          this.finishJob(job, 'failed', 'lost', {}, false);
        }
        continue;
      }
      if (workerGone) {
        if (await this.withdrawTracked(job)) {
          await this.op(pushStatus(this.client, job.id, 'failed', 'worker-unavailable')).catch(() => undefined);
          this.finishJob(job, 'failed', 'worker-unavailable', { withdrawn: true });
          continue;
        }
      }
      if (job.dequeued) {
        // worker が取り出し、再生 lock を待っている。worker が生きている間は見失ったとみなさない
        if (workerGone) {
          this.finishJob(job, 'failed', 'lost', {}, false);
          continue;
        }
        // 取り出した worker が入れ替わった（lock がほかの worker に移った）。取り出した worker が
        // 再生 lock も持っていない間を数え、30 秒続いたら見失ったとみなす
        if (job.dequeuedBy !== undefined && lock !== null && lock !== job.dequeuedBy) {
          let playLockHolder: string | null;
          try {
            playLockHolder = await this.op(this.client.get(PLAY_LOCK_KEY));
          } catch {
            continue;
          }
          const elapsedSinceCheck = job.lastLostCheck === undefined ? 0 : Math.max(0, now - job.lastLostCheck);
          job.lastLostCheck = now;
          if (playLockHolder === job.dequeuedBy) {
            job.lostMs = 0;
            continue;
          }
          job.lostMs += elapsedSinceCheck;
          if (job.lostMs >= DEQUEUED_SILENT_MS) {
            this.finishJob(job, 'failed', 'lost', {}, false);
          }
        }
        continue;
      }
      // 列から消えたのに dequeued も playing も来ない（取り出した worker が落ちた）
      let position: number | null;
      let playLock: string | null;
      try {
        position = await this.op(this.client.lPos(queueKeyFor(job.priority), job.raw));
        playLock = await this.op(this.client.get(PLAY_LOCK_KEY));
      } catch {
        continue;
      }
      const elapsed = job.lastLostCheck === undefined ? 0 : Math.max(0, now - job.lastLostCheck);
      job.lastLostCheck = now;
      if (position !== null) {
        job.lostMs = 0;
        continue;
      }
      // 再生 lock を worker 以外（古い版の worker など）が持つ間は数えない
      if (playLock !== null && playLock !== lock) {
        continue;
      }
      job.lostMs += elapsed;
      if (job.lostMs >= DEQUEUED_SILENT_MS) {
        // Stream は消さず期限切れに任せる（まだ読んでいる worker がいるかもしれない）
        this.finishJob(job, 'failed', 'lost', {}, false);
      }
    }
  }

  /** 親の標準入力が閉じた・止められた。書きかけの流れは中断し、自分の hold を外して終わる。 */
  async close(): Promise<void> {
    if (this.closing) {
      return this.closedPromise;
    }
    this.closing = true;
    // 処理中の枠は待つが、Redis が応答しないときに閉じられなくならないよう上限を置く
    let waitTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([this.chain, this.controlChain, ...this.background]).catch(() => undefined),
      new Promise(resolve => { waitTimer = setTimeout(resolve, CLOSE_WAIT_MS); }),
    ]);
    clearTimeout(waitTimer);
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    for (const job of this.jobs.values()) {
      if (job.writer && !job.writer.isClosed) {
        await this.op(job.writer.abort('ingest-closed'), 1000).catch(() => undefined);
      }
    }
    for (const owner of this.holds) {
      await this.op(clearHold(this.client, owner), 1000).catch(() => undefined);
    }
    this.holds.clear();
    this.closed = true;
    this.resolveClosed();
  }
}

/** 音声の書き込み待ちに巻き込まない制御の枠。 */
function isControlOnly(type: unknown): boolean {
  return type === 'hold' || type === 'gain?' || type === 'ping';
}

/** `--ingest` 用の接続。Redis が止まったらコマンドを溜めずにすぐ失敗させる。 */
export function createIngestClient(redisUrl: string): RedisClientType {
  const client = createClient({
    url: redisUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 2000,
    socket: { connectTimeout: 3000, reconnectStrategy: retries => Math.min(retries * 200, 2000) },
  }) as RedisClientType;
  client.on('error', () => undefined);
  return client;
}

async function connectForIngest(redisUrl: string): Promise<RedisClientType | undefined> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const client = createClient({ url: redisUrl, socket: { connectTimeout: 1000, reconnectStrategy: false } }) as RedisClientType;
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.disconnect();
      const session = createIngestClient(redisUrl);
      await session.connect();
      return session;
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
export async function runIngest(loadConfig: () => AppConfig, preludeDirs: readonly string[]): Promise<void> {
  const write = (frame: Buffer) => {
    if (process.stdout.writable) {
      process.stdout.write(frame);
    }
  };
  // 標準出力は枠だけに使う。うっかり console.log・console.info されても枠を壊さないよう、標準エラーへ回す
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);
  const flushAndExit = async (code: number) => {
    await new Promise<void>(resolve => {
      if (!process.stdout.writable) {
        resolve();
        return;
      }
      process.stdout.write('', () => resolve());
      setTimeout(resolve, 1000);
    });
    process.exit(code);
  };
  const client = await connectForIngest(loadConfig().redisUrl);
  if (client === undefined) {
    write(encodeControl({ type: 'hello', protocol: INGEST_PROTOCOL_VERSION, version }));
    write(encodeControl({ type: 'error', reason: 'redis-unavailable' }));
    await flushAndExit(1);
    return;
  }
  client.on('error', error => console.error('[ingest] redis error:', error instanceof Error ? error.message : error));
  const session = new IngestSession(client, loadConfig, preludeDirs, { input: process.stdin, write });
  // 許可フォルダは名乗る前に置く（起動直後の着信音も worker が確かめられるように）
  await session.publishPreludeDirs();
  // 親が先に落ちて標準出力が EPIPE になった・止められたときも、hold を外し、書きかけを中断してから終わる
  process.stdout.on('error', () => { void session.close(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => { void session.close(); });
  }
  session.start();
  await session.closedPromise;
  await client.disconnect().catch(() => undefined);
  await flushAndExit(0);
}

/**
 * 鳴らすのは Redis 全体でこの worker 1 つだけ（設計 3.1）。
 *
 * - 列は q2:high → q2:normal → 2.4 までの列の順に BRPOP で取り出す（どれも LPUSH で積むので先入れ先出し）
 * - 音声は `aivis-mcp:audio:<id>` の Stream から XREAD BLOCK（BRPOP とは別の接続）で読み、1 つのデコーダに流す
 * - 着信音 → 声の順に鳴らす。5 秒以上待った着信音は飛ばす。ミュート中は着信音も鳴らさない
 * - hold の間は取り出さない。鳴っている発話は止め（読み直さない）、待っているものは残す
 * - 古い版の worker から lock を引き取る。lock を失ったら終わる
 */

import { createClient, type RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig } from '../config.js';
import type { AudioBackend, VoicePlayback } from '../audio/player.js';
import { finalGainDb, isLearnable, loadLearnedGains, recordMeasurement, resolveGainDb } from '../audio/gain-table.js';
import type { LoudnessResult } from '../audio/loudness.js';
import { validatePreludePath } from '../audio/prelude.js';
import { providerOf, summarizeError, synthesisSetupError, type SynthesizeFunction } from '../audio/synthesize.js';
import { estimateMp3Duration, findFirstFrame } from '../streaming/mp3.js';
import { MAX_UTTERANCE_MS, PlaybackMonitor, shouldStartPlayback } from '../streaming/playback-policy.js';
import { AudioStreamReader, AudioStreamWriter, MAX_STREAM_BYTES } from '../queue/audio-stream.js';
import { anyHoldActive, appendHoldInterval, HOLD_SCAN_INTERVAL_MS, loadHoldIntervals } from '../queue/hold.js';
import {
  gainKeyFor, hasEmotionTags, heldOverlapMs, isJobExpired, parseJob, shouldPlayPrelude,
  type Job, type PreludeSpec, type SoundJob, type StreamJob, type SynthJob,
} from '../queue/jobs.js';
import { audioStreamKey, DEQUEUE_ORDER, HOLD_CHANNEL, PRELUDE_DIRS_PREFIX } from '../queue/keys.js';
import { pushStatus, type JobStatus } from '../queue/status.js';
import {
  acquirePlayLock, acquireWorkerLock, extendPlayLock, PLAY_LOCK_EXTEND_MS, refreshWorkerLock,
  releasePlayLock, releaseWorkerLock, WORKER_HEARTBEAT_MS,
} from '../queue/worker-lock.js';
import { isMuted } from '../services/mute-service.js';
import { isParaCodeVoiceTarget } from '../services/para-code-voice.js';
import { startParaCodeForward, type ParaCodeForward } from './para-code-forward.js';

export interface WorkerDependencies {
  readonly redisUrl: string;
  readonly version: string;
  readonly loadConfig: () => AppConfig;
  readonly backend: AudioBackend;
  readonly synthesize: SynthesizeFunction;
  readonly measure?: (audio: Buffer) => Promise<LoudnessResult | undefined>;
  readonly gainFile?: string;
  readonly debug?: boolean;
  /** テスト用。既定は Date.now */
  readonly now?: () => number;
}

interface Outcome {
  readonly status: JobStatus;
  readonly reason?: string;
}

/** いま扱っている 1 件。止められたときに知らせと後始末をするために持つ。 */
interface JobContext {
  readonly id: string | undefined;
  /** 終わりの知らせをもう積んだか（止めたときに先に積む） */
  reported: boolean;
  cancelled: boolean;
  /** 止めた理由（既定は worker-stopped） */
  cancelReason?: string;
  readonly kills: Set<() => void>;
}

interface StreamPlayRequest {
  readonly job: Job;
  readonly ctx: JobContext;
  readonly streamKey: string;
  readonly gainKey: string | undefined;
  readonly extraGainDb: number;
  readonly tagged: boolean;
  readonly prelude: PreludeSpec | undefined;
  readonly handlingStartedAt: number;
  readonly heldMs: number;
}

type PreludeResult = 'played' | 'held' | 'stale' | 'no-player' | 'cancelled' | `rejected:${string}`;

interface PreludeHandle {
  readonly result: Promise<PreludeResult>;
  kill(): void;
}

const POLL_MS = 100;
const HOLD_INTERRUPTED = 'hold';
const CANCELLED = 'cancelled';
/** 先に返るとき、合成の流れの後始末を待つ上限。 */
const SYNTHESIS_SETTLE_MS = 5_000;
/** Para Code が引き受けた発話の合成を送り終えるまで待つ上限。 */
const SYNTHESIS_FORWARD_MS = MAX_UTTERANCE_MS + 10_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 上限つきで待つ。上限を過ぎたら false。 */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class PlaybackWorker {
  private readonly workerId = uuidv4();
  private readonly command: RedisClientType;
  private readonly popper: RedisClientType;
  private readonly reader: RedisClientType;
  private readonly subscriber: RedisClientType;
  private active = false;
  private held = false;
  private holdStartedAt: number | undefined;
  /** hold を確かめた順番。遅れて返った古い結果で状態を戻さない */
  private holdCheckSeq = 0;
  private holdAppliedSeq = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private holdScan: NodeJS.Timeout | undefined;
  private holdWaiters = new Set<() => void>();
  private current: JobContext | undefined;
  private readonly now: () => number;
  /** 覚え直しの測定（テストで待てるように持っておく） */
  private pendingMeasurements = new Set<Promise<void>>();

  constructor(private readonly deps: WorkerDependencies) {
    this.now = deps.now ?? Date.now;
    this.command = createClient({ url: deps.redisUrl }) as RedisClientType;
    this.popper = createClient({ url: deps.redisUrl }) as RedisClientType;
    this.reader = createClient({ url: deps.redisUrl }) as RedisClientType;
    this.subscriber = createClient({ url: deps.redisUrl }) as RedisClientType;
    for (const client of [this.command, this.popper, this.reader, this.subscriber]) {
      client.on('error', error => console.error('Redis worker error:', summarizeError(error)));
    }
  }

  get id(): string {
    return this.workerId;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** テスト用: 待ち手の数（タイムアウトで外れることを確かめる）。 */
  get holdWaiterCount(): number {
    return this.holdWaiters.size;
  }

  private log(...args: unknown[]): void {
    if (this.deps.debug) {
      console.error('[worker]', ...args);
    }
  }

  /**
   * lock を取って列を読み続ける。lock が取れなかったら 'busy'、止まったら 'stopped' を返す。
   */
  async run(): Promise<'busy' | 'stopped'> {
    await Promise.all([this.command.connect(), this.popper.connect(), this.reader.connect(), this.subscriber.connect()]);
    const acquired = await acquireWorkerLock(this.command, this.workerId, this.deps.version);
    if (acquired === 'busy') {
      this.log('lock not acquired', { instance: this.workerId });
      await this.close();
      return 'busy';
    }
    this.log(acquired === 'took-over' ? 'took over lock from an older worker' : 'lock acquired', { instance: this.workerId });
    this.active = true;
    this.heartbeat = setInterval(() => {
      void this.refreshLock();
    }, WORKER_HEARTBEAT_MS);
    await this.subscriber.subscribe(HOLD_CHANNEL, () => {
      void this.updateHold();
    });
    this.holdScan = setInterval(() => {
      void this.updateHold();
    }, HOLD_SCAN_INTERVAL_MS);
    await this.updateHold();

    while (this.active) {
      try {
        if (this.held) {
          await this.waitForHoldChange(1000);
          continue;
        }
        const popped = await this.popper.brPop([...DEQUEUE_ORDER], 1);
        if (!popped) {
          continue;
        }
        if (this.held || !this.active) {
          // 取り出した直後に hold が掛かった・lock を失った。取り出した位置（右端）へ戻す
          await this.command.rPush(popped.key, popped.element);
          continue;
        }
        await this.handle(popped.key, popped.element);
      } catch (error) {
        if (this.active) {
          console.error('Queue worker error:', summarizeError(error));
          await delay(200);
        }
      }
    }
    await Promise.allSettled([...this.pendingMeasurements]);
    await this.close();
    return 'stopped';
  }

  /** 止める（今鳴っている発話は鳴らし切る）。 */
  stop(): void {
    this.active = false;
    this.wakeHoldWaiters();
  }

  /**
   * 止められた（SIGTERM など）。今の件に failed（worker-stopped）を積み、鳴らしている途中ならプレイヤーを止め、
   * 再生の lock と worker の lock をすぐ手放す。手放さないと次の worker がしばらく鳴らせない。
   */
  async shutdown(reason = 'worker-stopped'): Promise<void> {
    this.active = false;
    const current = this.current;
    if (current) {
      this.cancel(current, reason);
      if (current.id !== undefined && !current.reported && this.command.isOpen) {
        current.reported = true;
        await this.setStatus(current.id, 'failed', reason);
      }
    }
    this.wakeHoldWaiters();
    if (this.command.isOpen) {
      await releasePlayLock(this.command, this.workerId).catch(() => undefined);
      await releaseWorkerLock(this.command, this.workerId).catch(() => undefined);
    }
  }

  /** 今の件を止める（プレイヤー・着信音・合成を止める）。 */
  private cancel(ctx: JobContext, reason: string): void {
    if (ctx.cancelled) {
      return;
    }
    ctx.cancelled = true;
    ctx.cancelReason = reason;
    for (const kill of ctx.kills) {
      kill();
    }
  }

  /** 互換のための別名（2.5.0 の SIGTERM の受け手）。 */
  async releaseLockNow(): Promise<void> {
    await this.shutdown();
  }

  /** テスト用: 裏で走っている覚え直しを待つ。 */
  async flushMeasurements(): Promise<void> {
    await Promise.allSettled([...this.pendingMeasurements]);
  }

  private async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.holdScan) {
      clearInterval(this.holdScan);
      this.holdScan = undefined;
    }
    if (this.command.isOpen) {
      await releaseWorkerLock(this.command, this.workerId).catch(() => undefined);
    }
    for (const client of [this.subscriber, this.reader, this.popper, this.command]) {
      if (client.isOpen) {
        await client.disconnect().catch(() => undefined);
      }
    }
  }

  private async refreshLock(): Promise<void> {
    if (!this.active || !this.command.isOpen) {
      return;
    }
    try {
      const kept = await refreshWorkerLock(this.command, this.workerId, this.deps.version);
      if (!kept) {
        // 新しい版の worker に引き取られた。今の発話を鳴らし切ったら終わる
        this.log('lock lost', { instance: this.workerId });
        this.stop();
      }
    } catch (error) {
      console.error('Worker lock refresh error:', summarizeError(error));
    }
  }

  private async updateHold(): Promise<void> {
    if (!this.command.isOpen) {
      return;
    }
    const seq = ++this.holdCheckSeq;
    let active: boolean;
    try {
      active = await anyHoldActive(this.command);
    } catch {
      return;
    }
    // 知らせと 10 秒ごとの確認が重なったとき、後から始めた確認の結果だけを使う
    if (seq < this.holdAppliedSeq) {
      return;
    }
    this.holdAppliedSeq = seq;
    if (active === this.held) {
      return;
    }
    const now = this.now();
    this.held = active;
    if (active) {
      this.holdStartedAt = now;
      this.log('hold on');
    } else {
      const startedAt = this.holdStartedAt;
      this.holdStartedAt = undefined;
      this.log('hold off');
      if (startedAt !== undefined) {
        await appendHoldInterval(this.command, startedAt, now).catch(() => undefined);
      }
    }
    this.wakeHoldWaiters();
  }

  private wakeHoldWaiters(): void {
    const waiters = [...this.holdWaiters];
    this.holdWaiters.clear();
    for (const wake of waiters) {
      wake();
    }
  }

  /** hold が変わるか `timeoutMs` 経つまで待つ。タイムアウトしたら待ち手を外す。 */
  private waitForHoldChange(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const waiter = () => {
        clearTimeout(timer);
        this.holdWaiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(waiter, timeoutMs);
      this.holdWaiters.add(waiter);
    });
  }

  /** ジョブが列に入ってから今までのうち、hold で止まっていた時間。 */
  private async heldMsSince(from: number, now: number): Promise<number> {
    const intervals = await loadHoldIntervals(this.command).catch(() => [] as [number, number][]);
    if (this.holdStartedAt !== undefined) {
      intervals.push([this.holdStartedAt, now]);
    }
    return heldOverlapMs(intervals, from, now);
  }

  private async setStatus(id: string, status: JobStatus, reason?: string): Promise<void> {
    await pushStatus(this.command, id, status, reason).catch(() => undefined);
  }

  private async handle(queueKey: string, raw: string): Promise<void> {
    // hold で取り出しを諦めたら、取り出した位置（右端）へそのまま戻す
    const requeue = async () => {
      await this.command.rPush(queueKey, raw);
    };
    const parsed = parseJob(raw);
    if (parsed.kind === 'invalid') {
      console.error('壊れたジョブを捨てました');
      return;
    }
    if (parsed.kind === 'legacy') {
      await this.handleLegacy(parsed.payload, requeue);
      return;
    }
    await this.handleJob(parsed.job, requeue);
  }

  /** 再生の lock を取り、鳴らしている間は延長し続ける。 */
  private async withPlayLock<T>(body: () => Promise<T>): Promise<T> {
    const owner = this.workerId;
    await acquirePlayLock(this.command, owner);
    const extender = setInterval(() => {
      void extendPlayLock(this.command, owner).then(extended => {
        if (!extended && this.current) {
          // 期限切れでほかに取られた。重ならないよう、この件は止めて failed で終える
          console.error('再生の lock を失ったので、鳴らしている発話を止めます');
          this.cancel(this.current, 'play-lock-lost');
        }
      }).catch(() => undefined);
    }, PLAY_LOCK_EXTEND_MS);
    try {
      return await body();
    } finally {
      clearInterval(extender);
      await releasePlayLock(this.command, owner).catch(() => undefined);
    }
  }

  /** 2.4 までの列のジョブ（古い CLI・MCP の合成、`--play-audio` の合成済み MP3）。 */
  private async handleLegacy(payload: Record<string, unknown>, requeue: () => Promise<void>): Promise<void> {
    if (typeof payload._audioBase64 === 'string') {
      if (await isMuted(this.command)) {
        return;
      }
      const audio = Buffer.from(payload._audioBase64, 'base64');
      if (audio.length === 0) {
        return;
      }
      const ctx: JobContext = { id: undefined, reported: false, cancelled: false, kills: new Set() };
      this.current = ctx;
      try {
        await this.withPlayLock(async () => {
          if (this.held || !this.active) {
            await requeue();
            return;
          }
          // 表も当てる（鍵が無ければ表の補正は 0dB で、利用者の上乗せだけ）
          const gainKey = typeof payload.gainKey === 'string' && payload.gainKey.length <= 300 ? payload.gainKey : undefined;
          const playback = this.deps.backend.startVoice(this.gainFor(gainKey, 0));
          ctx.kills.add(() => playback.kill());
          playback.write(audio);
          playback.end();
          await this.raceHold(playback.done, () => playback.kill(), ctx);
        });
      } finally {
        this.current = undefined;
      }
      return;
    }
    const job: SynthJob = {
      v: 2,
      type: 'synth',
      id: uuidv4(),
      priority: 'normal',
      source: 'agent',
      enqueuedAt: this.now(),
      params: payload,
    };
    await this.handleJob(job, requeue);
  }

  private async handleJob(job: Job, requeue: () => Promise<void>): Promise<void> {
    const requestId = job.type === 'synth' && typeof job.params._requestId === 'string' ? job.params._requestId : undefined;
    const ctx: JobContext = { id: job.id, reported: false, cancelled: false, kills: new Set() };
    this.current = ctx;
    try {
      // 取り出した印（--ingest は、ここから playing までの再生 lock の待ちを「見失った」に数えない）
      await this.setStatus(job.id, 'dequeued');
      const outcome = await this.process(job, ctx);
      if (outcome === 'requeue') {
        await requeue();
        return;
      }
      if (!ctx.reported) {
        ctx.reported = true;
        await this.setStatus(job.id, outcome.status, outcome.reason);
      }
      this.log('job finished', { id: job.id, type: job.type, ...outcome });
    } catch (error) {
      console.error('Job error:', summarizeError(error));
      if (!ctx.reported) {
        ctx.reported = true;
        await this.setStatus(job.id, 'failed', 'internal-error');
      }
    } finally {
      this.current = undefined;
    }
    if (job.type !== 'sound') {
      await this.command.del(audioStreamKey(job.id)).catch(() => undefined);
    }
    if (requestId !== undefined) {
      await this.notifyCompletion(requestId);
    }
  }

  private async notifyCompletion(requestId: string): Promise<void> {
    try {
      const key = `aivis-mcp:done:${requestId}`;
      await this.command.rPush(key, 'done');
      await this.command.expire(key, 10);
    } catch (error) {
      console.error('notifyCompletion error:', summarizeError(error));
    }
  }

  private async process(job: Job, ctx: JobContext): Promise<Outcome | 'requeue'> {
    const dequeuedAt = this.now();
    // ミュート中は着信音も鳴らさない（Q206 B）。合成もしない
    if (await isMuted(this.command)) {
      return { status: 'muted' };
    }
    const heldMs = await this.heldMsSince(job.enqueuedAt, dequeuedAt);
    if (isJobExpired(job, dequeuedAt, heldMs)) {
      return { status: 'skipped', reason: 'expired' };
    }
    if (job.type === 'stream' && (await this.command.exists(audioStreamKey(job.id))) === 0) {
      // 古いジョブ（Stream の期限が切れた・積んだ側が落ちた）。待たずに捨てる
      return { status: 'skipped', reason: 'stream-missing' };
    }

    return this.withPlayLock(async () => {
      if (this.held || !this.active) {
        // lock を待つ間に hold が掛かった・lock を失った。列の先頭へ戻す
        return 'requeue' as const;
      }
      // 打ち切りの時計は、再生の lock を取った後から数える（lock の待ちを含めない）
      const handlingStartedAt = this.now();
      await this.setStatus(job.id, 'playing');
      if (job.type === 'sound') {
        return this.playSound(job, ctx, heldMs);
      }
      if (job.type === 'stream') {
        return this.playStreamJob(job, ctx, handlingStartedAt, heldMs);
      }
      return this.playSynthJob(job, ctx, heldMs);
    });
  }

  /** 許可フォルダ（`--ingest` が置いたもの）の中の着信音か確かめる。 */
  private async checkPrelude(prelude: PreludeSpec): Promise<{ ok: true; path: string; format: string } | { ok: false; reason: string }> {
    const dirs = new Set<string>();
    try {
      for await (const key of this.command.scanIterator({ MATCH: `${PRELUDE_DIRS_PREFIX}*`, COUNT: 100 })) {
        for (const dir of await this.command.sMembers(key)) {
          dirs.add(dir);
        }
      }
    } catch {
      // 読めなければ許可フォルダは無いものとして扱う（鳴らさない）
    }
    return validatePreludePath(prelude.path, [...dirs]);
  }

  /** 着信音を鳴らし始める。待ちすぎ・検査で弾いた・プレイヤーが無いときは鳴らさない。 */
  private startPrelude(job: Job, prelude: PreludeSpec, heldMs: number, ctx: JobContext): PreludeHandle {
    let killPlayback: (() => void) | undefined;
    let killed = false;
    const kill = () => {
      killed = true;
      killPlayback?.();
    };
    ctx.kills.add(kill);
    const result = (async (): Promise<PreludeResult> => {
      if (!shouldPlayPrelude(job, this.now(), heldMs)) {
        this.log('prelude skipped (waited too long)', { id: job.id });
        return 'stale';
      }
      const file = await this.checkPrelude(prelude);
      if (!file.ok) {
        this.log('prelude rejected', { id: job.id, reason: file.reason });
        return `rejected:${file.reason}`;
      }
      if (this.deps.backend.kind === 'none') {
        return 'no-player';
      }
      if (killed) {
        return 'cancelled';
      }
      const playback = this.deps.backend.playPrelude(file.path, file.format, prelude.volume);
      killPlayback = () => playback.kill();
      const raced = await this.raceHold(playback.done, () => playback.kill(), ctx);
      if (raced === HOLD_INTERRUPTED) {
        return 'held';
      }
      return raced === CANCELLED || killed ? 'cancelled' : 'played';
    })().finally(() => ctx.kills.delete(kill));
    return { result, kill };
  }

  private async playSound(job: SoundJob, ctx: JobContext, heldMs: number): Promise<Outcome> {
    const result = await this.startPrelude(job, job.prelude, heldMs, ctx).result;
    switch (result) {
      case 'played': return { status: 'done' };
      case 'held': return { status: 'held' };
      case 'stale': return { status: 'skipped', reason: 'prelude-stale' };
      case 'no-player': return { status: 'failed', reason: 'no-player' };
      case 'cancelled': return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
      default: return { status: 'failed', reason: `prelude-${result.slice('rejected:'.length)}` };
    }
  }

  private gainFor(gainKey: string | undefined, extraDb: number): number {
    const config = this.deps.loadConfig();
    const learned = loadLearnedGains(this.deps.gainFile);
    const providerOffset = gainKey?.startsWith('elevenlabs:') ? config.elevenLabsVolumeOffsetDb : 0;
    return finalGainDb(resolveGainDb(gainKey, learned), extraDb, config.volumeOffsetDb, providerOffset);
  }

  private async playStreamJob(job: StreamJob, ctx: JobContext, handlingStartedAt: number, heldMs: number): Promise<Outcome> {
    return this.playFromStream({
      job,
      ctx,
      streamKey: audioStreamKey(job.id),
      gainKey: job.gainKey,
      extraGainDb: job.volumeDb ?? 0,
      tagged: job.tagged === true,
      prelude: job.prelude,
      handlingStartedAt,
      heldMs,
    });
  }

  /**
   * この機械のエージェントの声。合成しながら Stream に流し、同じ Stream から鳴らす。
   * Para Code から起動されていれば、同じ音声を Para Code へも送る（取込の発話は送り返さない）。
   */
  private async playSynthJob(job: SynthJob, ctx: JobContext, heldMs: number): Promise<Outcome> {
    const config = this.deps.loadConfig();
    const params = job.params;
    const setupError = synthesisSetupError(config, params);
    if (setupError !== undefined) {
      console.error(setupError);
      return { status: 'failed', reason: 'not-configured' };
    }
    if (typeof params.wait_ms === 'number' && params.wait_ms > 0) {
      await delay(Math.min(params.wait_ms as number, 60000));
    }
    // 最初の音・1 発話の上限は、待ち（wait_ms）の後から数える
    const handlingStartedAt = this.now();
    const provider = providerOf(params);
    const gainKey = provider === 'elevenlabs'
      ? gainKeyFor('elevenlabs', (params.voice_id as string | undefined) || config.elevenLabsVoiceId, (params.model_id as string | undefined) || config.elevenLabsModelId)
      : gainKeyFor('aivis', (params.model_uuid as string | undefined) || config.modelUuid, undefined);

    const writer = new AudioStreamWriter(this.command, job.id);
    await writer.open();
    const target = params._paraCodeVoiceTarget;
    const forward: ParaCodeForward | undefined = job.source === 'agent' && isParaCodeVoiceTarget(target)
      ? startParaCodeForward(target, { gainKey })
      : undefined;

    let overflow = false;
    let synthesisFailed = false;
    let source: NodeJS.ReadableStream | undefined;
    let finished = false;
    const synthesis = (async () => {
      try {
        source = await this.deps.synthesize(config, params);
      } catch (error) {
        synthesisFailed = true;
        finished = true;
        console.error('Error in synthesize:', summarizeError(error));
        await writer.abort('synthesis-failed');
        forward?.abort();
        return;
      }
      const stream = source;
      await new Promise<void>(resolve => {
        const done = () => {
          finished = true;
          resolve();
        };
        stream.on('data', (value: Buffer | string) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (!writer.write(chunk)) {
            if (!overflow) {
              overflow = true;
              void writer.abort('too-large');
            }
          }
          forward?.push(chunk);
        });
        stream.once('end', () => {
          void writer.end();
          forward?.end();
          done();
        });
        stream.once('error', (error: unknown) => {
          synthesisFailed = true;
          console.error('Stream error:', summarizeError(error));
          void writer.abort('synthesis-failed');
          forward?.abort();
          done();
        });
        // destroy された・相手が切った（end も error も来ない）ときも待ちを終える
        stream.once('close', () => {
          if (!finished) {
            void writer.abort('synthesis-closed');
            forward?.abort();
          }
          done();
        });
      });
    })();
    /** 合成をやめる（流れを閉じる）。 */
    const stopSynthesis = () => {
      const stream = source as (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | undefined;
      if (!finished && stream && typeof stream.destroy === 'function') {
        stream.destroy();
      }
    };
    ctx.kills.add(stopSynthesis);

    let keepSynthesizing = false;
    try {
      if (forward !== undefined && isParaCodeVoiceTarget(target) && target.localPlayback === true) {
        // SSH 先から発話し、Para Code が手元の PC で鳴らす。引き受けたと分かったら、この機械では鳴らさない
        const decision = await forward.decision;
        if (decision === 'remote') {
          keepSynthesizing = true;
          if (!(await settleWithin(synthesis, SYNTHESIS_FORWARD_MS))) {
            stopSynthesis();
          }
          return { status: 'done', reason: 'played-by-para-code' };
        }
        if (!(await settleWithin(synthesis, SYNTHESIS_FORWARD_MS))) {
          stopSynthesis();
          return { status: 'failed', reason: 'synthesis-timeout' };
        }
        if (overflow) {
          // 大きすぎて Stream に収まらなかった。読み捨てた分は戻らないので、合成し直して鳴らす
          console.error('Para Code へ音声を渡せなかったので、この機械で鳴らします');
          // 合成を作り直すジョブには着信音を付けない
          const retry: SynthJob = { ...job, id: uuidv4(), prelude: undefined, params: { ...params, wait_ms: undefined, _paraCodeVoiceTarget: undefined } };
          try {
            return await this.playSynthJob(retry, ctx, 0);
          } finally {
            await this.command.del(audioStreamKey(retry.id)).catch(() => undefined);
          }
        }
      }
      const outcome = await this.playFromStream({
        job,
        ctx,
        streamKey: writer.key,
        gainKey,
        extraGainDb: job.volumeDb ?? 0,
        tagged: hasEmotionTags(params.text),
        prelude: job.prelude,
        handlingStartedAt,
        heldMs,
      });
      if (synthesisFailed && outcome.status !== 'done') {
        return { status: 'failed', reason: 'synthesis-failed' };
      }
      return outcome;
    } finally {
      ctx.kills.delete(stopSynthesis);
      if (!keepSynthesizing && !finished) {
        // 先に返った（止めた・hold・打ち切り）。合成はもう要らない
        stopSynthesis();
      }
      await settleWithin(synthesis, SYNTHESIS_SETTLE_MS);
      await settleWithin(writer.settled(), SYNTHESIS_SETTLE_MS);
    }
  }

  /** 鳴っている間に hold が掛かる・止められたら止める。 */
  private async raceHold<T>(done: Promise<T>, stop: () => void, ctx?: JobContext): Promise<T | typeof HOLD_INTERRUPTED | typeof CANCELLED> {
    let finished = false;
    const watcher = (async (): Promise<typeof HOLD_INTERRUPTED | typeof CANCELLED | undefined> => {
      while (!finished) {
        if (ctx?.cancelled) {
          stop();
          return CANCELLED;
        }
        if (this.held) {
          stop();
          return HOLD_INTERRUPTED;
        }
        await this.waitForHoldChange(250);
      }
      return undefined;
    })();
    const result = await Promise.race([done.then(value => ({ value })), watcher.then(stopped => ({ stopped }))]);
    finished = true;
    if ('stopped' in result && result.stopped !== undefined) {
      await done.catch(() => undefined);
      return result.stopped;
    }
    if ('value' in result) {
      return result.value;
    }
    return done;
  }

  /**
   * Stream を読みながら 1 つのデコーダで鳴らす。着信音は合成の最初の音を待つ間に鳴らす。
   * どこで返っても、鳴っている着信音は止めてから返る。
   */
  private async playFromStream(request: StreamPlayRequest): Promise<Outcome> {
    let prelude: PreludeHandle | undefined;
    try {
      if (request.prelude !== undefined) {
        prelude = this.startPrelude(request.job, request.prelude, request.heldMs, request.ctx);
      }
      return await this.readAndPlay(request, prelude);
    } finally {
      if (prelude) {
        prelude.kill();
        await prelude.result.catch(() => undefined);
      }
    }
  }

  private async readAndPlay(request: StreamPlayRequest, prelude: PreludeHandle | undefined): Promise<Outcome> {
    const { streamKey, ctx } = request;
    const reader = new AudioStreamReader(this.reader, streamKey);
    const monitor = new PlaybackMonitor(request.handlingStartedAt);
    const received: Buffer[] = [];
    let receivedBytes = 0;
    let buffered: Buffer[] = [];
    let bufferedBytes = 0;
    let bitrateKbps: number | undefined;
    let ended = false;
    let aborted = false;
    let abortReason: string | undefined;
    let playback: VoicePlayback | undefined;
    let playbackDone = false;
    let lastExistsCheck = this.now();

    const preludeState: { value: 'playing' | 'finished' | 'held' } = { value: prelude ? 'playing' : 'finished' };
    void prelude?.result.then(result => {
      preludeState.value = result === 'held' ? 'held' : 'finished';
    });

    const stopPlayback = () => {
      playback?.kill();
    };
    ctx.kills.add(stopPlayback);
    const finishStopped = async (): Promise<void> => {
      stopPlayback();
      if (playback) {
        await playback.done;
      }
    };

    try {
      while (true) {
        if (ctx.cancelled) {
          await finishStopped();
          return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
        }
        if (this.held || preludeState.value === 'held') {
          await finishStopped();
          return { status: 'held' };
        }

        if (!ended && !aborted) {
          const events = await reader.read(POLL_MS);
          const now = this.now();
          for (const event of events) {
            if (event.kind === 'data') {
              monitor.onAudio(now, event.data.length);
              if (receivedBytes + event.data.length <= MAX_STREAM_BYTES) {
                received.push(event.data);
                receivedBytes += event.data.length;
              }
              if (playback) {
                playback.write(event.data);
              } else {
                buffered.push(event.data);
                bufferedBytes += event.data.length;
              }
            } else if (event.kind === 'end') {
              ended = true;
              monitor.onEnded();
            } else {
              aborted = true;
              abortReason = event.reason;
              monitor.onEnded();
            }
          }
          if (events.length === 0 && now - lastExistsCheck >= 1000) {
            lastExistsCheck = now;
            if ((await this.command.exists(streamKey)) === 0) {
              aborted = true;
              abortReason = 'stream-expired';
              monitor.onEnded();
            }
          }
        } else {
          await this.waitForHoldChange(POLL_MS);
        }

        if (bitrateKbps === undefined && bufferedBytes > 0 && !playback) {
          const frame = findFirstFrame(Buffer.concat(buffered, bufferedBytes));
          if (frame !== undefined) {
            bitrateKbps = frame.bitrateKbps;
            monitor.setBitrate(frame.bitrateKbps);
          }
        }

        const cutoff = monitor.check(this.now());
        if (cutoff === 'first-audio-timeout') {
          return { status: 'failed', reason: cutoff };
        }
        if (cutoff === 'max-duration') {
          await finishStopped();
          return { status: 'failed', reason: cutoff };
        }
        if (cutoff === 'slow-arrival') {
          // 届いた分は鳴らし切って終える
          if (playback) {
            playback.end();
            const result = await this.raceHold(playback.done, stopPlayback, ctx);
            if (result === HOLD_INTERRUPTED) {
              return { status: 'held' };
            }
            if (result === CANCELLED || ctx.cancelled) {
              return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
            }
            return { status: 'done', reason: cutoff };
          }
          return { status: 'failed', reason: cutoff };
        }

        if (aborted && !playback) {
          // 鳴り始める前の中断は捨てる
          return { status: 'skipped', reason: abortReason ?? 'aborted' };
        }

        if (!playback && preludeState.value === 'finished' && shouldStartPlayback({ bufferedBytes, bitrateKbps, ended })) {
          playback = this.deps.backend.startVoice(this.gainFor(request.gainKey, request.extraGainDb));
          void playback.done.then(() => { playbackDone = true; });
          for (const chunk of buffered) {
            playback.write(chunk);
          }
          buffered = [];
          bufferedBytes = 0;
        }

        if (ended && !playback && bufferedBytes === 0) {
          return { status: 'done', reason: 'empty' };
        }

        if ((ended || aborted) && playback) {
          playback.end();
          const deadline = request.handlingStartedAt + MAX_UTTERANCE_MS;
          const current = playback;
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - this.now()));
          });
          const result = await this.raceHold(Promise.race([current.done.then(() => 'finished' as const), timeout]), stopPlayback, ctx);
          clearTimeout(timer);
          if (result === HOLD_INTERRUPTED) {
            return { status: 'held' };
          }
          // 止めた（プレイヤーを kill した）結果として鳴り終わった場合も、止めた扱いにする
          if (result === CANCELLED || ctx.cancelled) {
            return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
          }
          if (result === 'timeout') {
            await finishStopped();
            return { status: 'failed', reason: 'max-duration' };
          }
          const completed = ended && !aborted;
          if (completed) {
            this.scheduleLearning(request, Buffer.concat(received, receivedBytes));
          }
          return completed ? { status: 'done' } : { status: 'done', reason: abortReason ?? 'aborted' };
        }

        if (playback && playbackDone && !ended && !aborted) {
          // デコーダが先に落ちた
          return { status: 'failed', reason: 'player-exited' };
        }
      }
    } finally {
      ctx.kills.delete(stopPlayback);
    }
  }

  /** 鳴らし切った発話の、補正前の音声を測って表を覚え直す（鳴らした後に裏で）。 */
  private scheduleLearning(request: StreamPlayRequest, audio: Buffer): void {
    const measure = this.deps.measure;
    if (measure === undefined || !this.deps.backend.canMeasure || request.gainKey === undefined) {
      return;
    }
    // 長さは Xing/VBRI ヘッダー、無ければ全フレームの合計で数える（可変ビットレートでも外さない）
    const estimated = estimateMp3Duration(audio);
    if (!isLearnable({ tagged: request.tagged, durationSeconds: estimated, completed: true })) {
      return;
    }
    const gainKey = request.gainKey;
    const task = (async () => {
      const result = await measure(audio);
      if (result === undefined) {
        return;
      }
      if (!isLearnable({ tagged: request.tagged, durationSeconds: result.durationSeconds ?? estimated, completed: true, measuredLufs: result.integratedLufs })) {
        return;
      }
      const learned = recordMeasurement(gainKey, result.integratedLufs, this.deps.gainFile);
      this.log('gain learned', { gainKey, lufs: result.integratedLufs, db: learned.db });
    })().catch(error => console.error('Gain learning error:', summarizeError(error)));
    this.pendingMeasurements.add(task);
    void task.finally(() => this.pendingMeasurements.delete(task));
  }
}

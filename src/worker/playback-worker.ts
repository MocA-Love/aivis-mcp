/**
 * 鳴らすのは Redis 全体でこの worker 1 つだけ（設計 3.1）。
 *
 * - 列は q2:high → q2:normal → 移した古い列 → 2.4 までの列の順に BRPOP で取り出す（どれも LPUSH で積むので先入れ先出し）
 * - 音声は `aivis-mcp:audio:<id>` の Stream から XREAD BLOCK（BRPOP とは別の接続）で読み、1 つのデコーダに流す
 * - 着信音 → 声の順に鳴らす。5 秒以上待った着信音は飛ばす。ミュート中は着信音も鳴らさない
 * - hold の間は取り出さない。鳴っている発話は止め（読み直さない）、待っているものは残す
 * - 古い版の worker から lock を引き取る。lock を失ったら終わる
 * - Redis に届かない間も、再生の lock の期限はこの worker の時計で数え、期限の前に鳴らすのを止める
 * - どこで返っても（例外・中断を含む）、プレイヤーを止めて終わったのを確かめてから再生の lock を手放す
 */

import { createClient, type RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig } from '../config.js';
import { PLAYER_KILL_GRACE_MS, type AudioBackend, type PlayResult, type VoicePlayback } from '../audio/player.js';
import { finalGainDb, isLearnable, loadLearnedGains, recordMeasurement, resolveGainDb } from '../audio/gain-table.js';
import type { LoudnessResult } from '../audio/loudness.js';
import { validatePreludePath } from '../audio/prelude.js';
import { providerOf, summarizeError, synthesisSetupError, type SynthesizeFunction } from '../audio/synthesize.js';
import { estimateMp3Duration, findFirstFrame } from '../streaming/mp3.js';
import { MAX_UTTERANCE_MS, PlaybackMonitor, shouldStartPlayback } from '../streaming/playback-policy.js';
import { AudioStreamReader, AudioStreamWriter, MAX_STREAM_BYTES, MAX_STREAM_ENTRY_BYTES } from '../queue/audio-stream.js';
import {
  anyHoldActive, closeHoldInterval, holdStartedAt, HOLD_SCAN_INTERVAL_MS, loadHoldIntervals, markHoldStarted,
} from '../queue/hold.js';
import {
  gainKeyFor, hasEmotionTags, heldOverlapMs, isJobExpired, parseJob, shouldPlayPrelude,
  type Job, type PreludeSpec, type SoundJob, type StreamJob, type SynthJob,
} from '../queue/jobs.js';
import {
  audioStreamKey, DEQUEUE_ORDER, HIGH_QUEUE_KEY, HOLD_CHANNEL, LEGACY_QUEUE_KEY, NORMAL_QUEUE_KEY, PLAY_LOCK_KEY, PRELUDE_DIRS_PREFIX,
} from '../queue/keys.js';
import { pushStatus, type JobStatus } from '../queue/status.js';
import { OperationTimeoutError, REDIS_OP_TIMEOUT_MS, settleWithin } from '../queue/timeout.js';
import {
  acquireWorkerLockDetailed, drainLegacyQueue, extendPlayLock, LEGACY_WORKER_GRACE_MS, PLAY_LOCK_EXTEND_MS, PLAY_LOCK_TTL_MS,
  refreshWorkerLock, releasePlayLock, releaseWorkerLock, tryAcquirePlayLock, WORKER_HEARTBEAT_MS, WORKER_LOCK_TTL_MS,
} from '../queue/worker-lock.js';
import { isMuted } from '../services/mute-service.js';
import { isParaCodeVoiceTarget, type ParaCodeVoiceTarget } from '../services/para-code-voice.js';
import { isVoiceRequester, requestVoiceTicket, VOICE_TICKET_REMOTE_WAIT_MS, VOICE_TICKET_WAIT_MS } from '../services/voice-ticket.js';
import { FORWARD_IDLE_TIMEOUT_MS, startParaCodeForward, type ParaCodeForward } from './para-code-forward.js';

/** テストで短くできる時間の決まり。 */
export interface WorkerTimings {
  /** 再生の lock の期限 */
  readonly playLockTtlMs: number;
  /** 再生の lock を延長する間隔 */
  readonly playLockExtendMs: number;
  /** 最後に延長できた時刻から数えた期限の、これだけ前に鳴らすのを止める（プレイヤーの強制終了の分を含む） */
  readonly playLockSafetyMs: number;
  /** 1 つの Redis の操作を待つ上限 */
  readonly opTimeoutMs: number;
  /** 2.4 の worker から引き取った後、古い列を 2.4 が読めない場所へ移し続ける間 */
  readonly legacyGraceMs: number;
  /** 鳴らし始めるときに ticket の返事を待つ上限（手元のペイン） */
  readonly voiceTicketWaitMs: number;
  /** 同じ（SSH 先のペイン） */
  readonly voiceTicketRemoteWaitMs: number;
  /** テスト用: 1 件の全体の上限（既定はジョブの種類ごとに 1 発話の上限から決める） */
  readonly jobHardLimitMs?: number;
}

export const DEFAULT_WORKER_TIMINGS: WorkerTimings = {
  playLockTtlMs: PLAY_LOCK_TTL_MS,
  playLockExtendMs: PLAY_LOCK_EXTEND_MS,
  playLockSafetyMs: PLAYER_KILL_GRACE_MS + 1_000,
  opTimeoutMs: REDIS_OP_TIMEOUT_MS,
  legacyGraceMs: LEGACY_WORKER_GRACE_MS,
  voiceTicketWaitMs: VOICE_TICKET_WAIT_MS,
  voiceTicketRemoteWaitMs: VOICE_TICKET_REMOTE_WAIT_MS,
};

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
  /** テスト用。既定は DEFAULT_WORKER_TIMINGS */
  readonly timings?: Partial<WorkerTimings>;
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

type PreludeResult = 'played' | 'held' | 'stale' | 'cancelled' | `rejected:${string}` | `failed:${string}`;

interface PreludeHandle {
  readonly result: Promise<PreludeResult>;
  kill(): void;
}

/** 鳴らし始めるときに Para Code へ送る先（ticket）を得る手立て。 */
interface VoiceRoute {
  /** 1 回だけ ticket を取る（2 回目以降は同じ結果） */
  readonly obtain: () => Promise<ParaCodeVoiceTarget | undefined>;
  /** SSH 先のペインで、Para Code が手元の PC で鳴らす前提か */
  readonly expectLocalPlayback: boolean;
  /** ミュート中なら送らないと控えの ticket で分かっている（依頼を省く） */
  readonly unsendableWhenMuted: boolean;
}

/** 合成の流れ 1 本。 */
interface SynthesisRun {
  /** 合成の流れが終わった（最後まで・失敗・止めた）ら解決する */
  readonly done: Promise<void>;
  /** 最後まで受け取った */
  readonly completed: boolean;
  readonly failed: boolean;
  /** Stream に収まらなかった */
  readonly overflow: boolean;
  /** 合成をやめる（HTTP も取り消す） */
  stop(): void;
}

type Bounded<T> = { readonly value: T } | 'held' | 'cancelled' | 'timeout';

const POLL_MS = 100;
const HOLD_INTERRUPTED = 'hold';
const CANCELLED = 'cancelled';
/** 先に返るとき、合成の流れの後始末を待つ上限。 */
const SYNTHESIS_SETTLE_MS = 5_000;
/** プレイヤーを止めてから、終わったのを確かめるまで待つ上限（強制終了の後の分を含む）。 */
const PLAYER_STOP_WAIT_MS = PLAYER_KILL_GRACE_MS + 1_000;
/** 合成するジョブの全体の上限に足す、Para Code の返事を待つ分。 */
const SYNTH_EXTRA_LIMIT_MS = 30_000;
/** 控えの ticket を使うのに残っていてほしい時間。 */
const FALLBACK_MIN_REMAINING_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 2.4 の列の名残りか、2.5 の列か（優先の順の比べに使う）。 */
function queueRank(queueKey: string): number {
  if (queueKey === HIGH_QUEUE_KEY) {
    return 0;
  }
  if (queueKey === NORMAL_QUEUE_KEY) {
    return 1;
  }
  return 2;
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
  private holdChecked = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private holdScan: NodeJS.Timeout | undefined;
  private holdWaiters = new Set<() => void>();
  private current: JobContext | undefined;
  private readonly now: () => number;
  private readonly timings: WorkerTimings;
  /** 覚え直しの測定（テストで待てるように持っておく） */
  private pendingMeasurements = new Set<Promise<void>>();
  /** worker の lock を最後に延長できた時刻から数えた期限 */
  private workerLockValidUntil = 0;
  private refreshing = false;
  /** 2.4 の worker から引き取った後、古い列を移し続ける期限と、前の持ち主 */
  private migrationUntil: number | undefined;
  private previousHolder: string | undefined;

  constructor(private readonly deps: WorkerDependencies) {
    this.now = deps.now ?? Date.now;
    this.timings = { ...DEFAULT_WORKER_TIMINGS, ...deps.timings };
    // Redis が切れている間はコマンドを溜めずにすぐ失敗させる（溜めると、戻ったときに古い操作が流れる）
    const options = {
      url: deps.redisUrl,
      disableOfflineQueue: true,
      socket: { connectTimeout: 3000, reconnectStrategy: (retries: number) => Math.min(retries * 200, 2000) },
    };
    this.command = createClient(options) as RedisClientType;
    this.popper = createClient(options) as RedisClientType;
    this.reader = createClient(options) as RedisClientType;
    this.subscriber = createClient({ url: deps.redisUrl, socket: options.socket }) as RedisClientType;
    for (const client of [this.command, this.popper, this.reader, this.subscriber]) {
      client.on('error', error => {
        if (this.deps.debug) {
          console.error('Redis worker error:', summarizeError(error));
        }
      });
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

  /** テスト用: 2.4 の worker から引き取った後の移し替えの最中か。 */
  get isMigratingLegacy(): boolean {
    return this.migrationUntil !== undefined;
  }

  private log(...args: unknown[]): void {
    if (this.deps.debug) {
      console.error('[worker]', ...args);
    }
  }

  /** Redis の操作に上限を付ける。 */
  private op<T>(promise: Promise<T>, ms = this.timings.opTimeoutMs): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OperationTimeoutError(ms)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * lock を取って列を読み続ける。lock が取れなかったら 'busy'、止まったら 'stopped' を返す。
   */
  async run(): Promise<'busy' | 'stopped'> {
    await Promise.all([this.command.connect(), this.popper.connect(), this.reader.connect(), this.subscriber.connect()]);
    const sentAt = this.now();
    const acquired = await this.op(acquireWorkerLockDetailed(this.command, this.workerId, this.deps.version));
    if (acquired.result === 'busy') {
      this.log('lock not acquired', { instance: this.workerId });
      await this.close();
      return 'busy';
    }
    this.workerLockValidUntil = sentAt + WORKER_LOCK_TTL_MS;
    this.log(acquired.result === 'took-over' ? 'took over lock from an older worker' : 'lock acquired', { instance: this.workerId });
    this.active = true;
    if (acquired.result === 'took-over') {
      // 引き取られた古い worker は、次の延長で気付くまで古い列を読める。待っているジョブを先に移しておく
      this.previousHolder = acquired.previousHolder;
      this.migrationUntil = this.now() + this.timings.legacyGraceMs;
      await this.op(drainLegacyQueue(this.command)).catch(() => undefined);
    }
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
        const order = await this.dequeueOrder();
        const popped = await this.popNext(order);
        if (!popped) {
          continue;
        }
        if (this.held || !this.active) {
          // 取り出した直後に hold が掛かった・lock を失った。取り出した位置（右端）へ戻す
          await this.op(this.command.rPush(popped.key, popped.element));
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

  /** 取り出す列の順。2.4 の worker から引き取った直後は、古い列を移しながら、古い列からは読まない。 */
  private async dequeueOrder(): Promise<string[]> {
    if (this.migrationUntil === undefined) {
      return [...DEQUEUE_ORDER];
    }
    await this.op(drainLegacyQueue(this.command)).catch(() => undefined);
    if (this.now() >= this.migrationUntil) {
      // 古い worker が鳴らしている（再生 lock を持っている）間は、まだ止まっていない
      const playLock = await this.op(this.command.get(PLAY_LOCK_KEY)).catch(() => undefined);
      if (playLock !== undefined && playLock !== this.previousHolder) {
        this.migrationUntil = undefined;
        this.log('legacy worker migration finished');
        return [...DEQUEUE_ORDER];
      }
    }
    return DEQUEUE_ORDER.filter(key => key !== LEGACY_QUEUE_KEY);
  }

  /** BRPOP（1 秒）。Redis が応答しないときは接続を張り直す（溜まった要求で固まらない）。 */
  private async popNext(order: string[]): Promise<{ key: string; element: string } | null> {
    try {
      return await this.op(this.popper.brPop(order, 1), 1000 + this.timings.opTimeoutMs);
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        await this.popper.disconnect().catch(() => undefined);
        await this.op(this.popper.connect()).catch(() => undefined);
      }
      throw error;
    }
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
    // 鳴らしている件が、プレイヤーを止めて終わるのを待ってから lock を手放す（重ならないように）
    const handling = this.handling;
    if (handling !== undefined) {
      await settleWithin(handling, PLAYER_STOP_WAIT_MS + 1_000);
    }
    if (this.command.isOpen) {
      await this.op(releasePlayLock(this.command, this.workerId), 1000).catch(() => undefined);
      await this.op(releaseWorkerLock(this.command, this.workerId), 1000).catch(() => undefined);
    }
  }

  /** 今の件を止める（プレイヤー・着信音・合成を止める）。 */
  private cancel(ctx: JobContext, reason: string): void {
    if (ctx.cancelled) {
      return;
    }
    ctx.cancelled = true;
    ctx.cancelReason = reason;
    for (const kill of [...ctx.kills]) {
      kill();
    }
    this.wakeHoldWaiters();
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
      await this.op(releaseWorkerLock(this.command, this.workerId), 1000).catch(() => undefined);
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
    // Redis に届かないまま lock の期限を過ぎそうなら、ほかの worker が起きる前に自分から止まる
    if (this.now() >= this.workerLockValidUntil - this.timings.playLockSafetyMs) {
      console.error('worker の lock を延長できないまま期限が近いので、止まります');
      this.stop();
      return;
    }
    // 前の延長が返ってくる前に重ねない
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    const sentAt = this.now();
    try {
      const kept = await this.op(refreshWorkerLock(this.command, this.workerId, this.deps.version));
      if (kept) {
        this.workerLockValidUntil = sentAt + WORKER_LOCK_TTL_MS;
      } else {
        // 新しい版の worker に引き取られた。今の発話を鳴らし切ったら終わる
        this.log('lock lost', { instance: this.workerId });
        this.stop();
      }
    } catch (error) {
      console.error('Worker lock refresh error:', summarizeError(error));
    } finally {
      this.refreshing = false;
    }
  }

  private async updateHold(): Promise<void> {
    if (!this.command.isOpen) {
      return;
    }
    const seq = ++this.holdCheckSeq;
    let active: boolean;
    try {
      active = await this.op(anyHoldActive(this.command));
    } catch {
      return;
    }
    // 知らせと 10 秒ごとの確認が重なったとき、後から始めた確認の結果だけを使う
    if (seq < this.holdAppliedSeq) {
      return;
    }
    this.holdAppliedSeq = seq;
    const first = !this.holdChecked;
    this.holdChecked = true;
    const now = this.now();
    if (active) {
      // 始まりは Redis に残す（worker が入れ替わっても、hold の時間を数え直せるように）
      await this.op(markHoldStarted(this.command, now)).catch(() => undefined);
      if (!this.held) {
        const since = await this.op(holdStartedAt(this.command)).catch(() => undefined);
        this.held = true;
        this.holdStartedAt = since ?? now;
        this.log('hold on');
        this.wakeHoldWaiters();
      }
      return;
    }
    if (this.held || first) {
      // 外れた（または前の worker の間に外れていた）。続いていた区間を閉じて残す
      await this.op(closeHoldInterval(this.command, now)).catch(() => undefined);
    }
    if (this.held) {
      this.held = false;
      this.holdStartedAt = undefined;
      this.log('hold off');
      this.wakeHoldWaiters();
    }
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

  /** ジョブが列に入ってから今までのうち、hold で止まっていた時間（worker が入れ替わっても Redis から数え直す）。 */
  private async heldMsSince(from: number, now: number): Promise<number> {
    const intervals = await this.op(loadHoldIntervals(this.command)).catch(() => [] as [number, number][]);
    const since = await this.op(holdStartedAt(this.command)).catch(() => undefined) ?? this.holdStartedAt;
    if (since !== undefined) {
      intervals.push([since, now]);
    }
    return heldOverlapMs(intervals, from, now);
  }

  private async setStatus(id: string, status: JobStatus, reason?: string, worker?: string): Promise<void> {
    await this.op(pushStatus(this.command, id, status, reason, worker)).catch(() => undefined);
  }

  private async muted(): Promise<boolean> {
    return this.op(isMuted(this.command));
  }

  /** いま扱っている 1 件の処理（止められたとき、終わるのを待ってから lock を手放す）。 */
  private handling: Promise<void> | undefined;

  private async handle(queueKey: string, raw: string): Promise<void> {
    const task = this.handleOne(queueKey, raw);
    this.handling = task;
    try {
      await task;
    } finally {
      if (this.handling === task) {
        this.handling = undefined;
      }
    }
  }

  private async handleOne(queueKey: string, raw: string): Promise<void> {
    // hold などで取り出しを諦めたら、取り出した位置（右端）へそのまま戻す
    const requeue = async (id?: string) => {
      try {
        await this.op(this.command.rPush(queueKey, raw));
      } catch (error) {
        // 時間切れでも、要求は遅れて通るかもしれない（通ればその件は後で鳴る）。分かるように残す
        console.error(`列へ戻せたか分かりません（${id ?? '2.4 の形のジョブ'}）。遅れて戻った場合は後で鳴ります:`, summarizeError(error));
        throw error;
      }
      if (id !== undefined) {
        await this.setStatus(id, 'requeued', undefined, this.workerId);
      }
    };
    const parsed = parseJob(raw);
    if (parsed.kind === 'invalid') {
      console.error('壊れたジョブを捨てました');
      return;
    }
    if (parsed.kind === 'legacy') {
      await this.handleLegacy(parsed.payload, queueKey, requeue);
      return;
    }
    await this.handleJob(parsed.job, queueKey, requeue);
  }

  /** 後から来た優先の高いジョブがあれば、まだ鳴らし始めていないこの件は譲る。 */
  private async shouldYield(queueKey: string): Promise<boolean> {
    const rank = queueRank(queueKey);
    if (rank === 0) {
      return false;
    }
    const higher = rank === 1 ? [HIGH_QUEUE_KEY] : [HIGH_QUEUE_KEY, NORMAL_QUEUE_KEY];
    const lengths = await this.op(Promise.all(higher.map(key => this.command.lLen(key))));
    return lengths.some(length => length > 0);
  }

  /**
   * 再生の lock を取り、鳴らしている間は延長し続ける。延長できないまま期限が近づいたら、
   * ほかの worker が lock を取れるようになる前に、この件を止める（play-lock-lost）。
   * lock を取る前に止められた（worker が止まる）ときは 'requeue'。
   */
  private async withPlayLock<T>(ctx: JobContext, body: () => Promise<T>): Promise<T | 'requeue'> {
    const owner = this.workerId;
    const { playLockTtlMs, playLockExtendMs, playLockSafetyMs } = this.timings;
    let validUntil = 0;
    while (true) {
      if (ctx.cancelled || !this.active) {
        return 'requeue';
      }
      const sentAt = this.now();
      const acquired = await this.op(tryAcquirePlayLock(this.command, owner, playLockTtlMs)).catch(() => false);
      if (acquired) {
        validUntil = sentAt + playLockTtlMs;
        break;
      }
      await delay(100);
    }
    let extending = false;
    const lost = () => {
      console.error('再生の lock を保てないので、鳴らしている発話を止めます');
      this.cancel(ctx, 'play-lock-lost');
    };
    const extender = setInterval(() => {
      // 前の延長が返ってくる前に重ねない
      if (extending || ctx.cancelled) {
        return;
      }
      extending = true;
      const sentAt = this.now();
      void this.op(extendPlayLock(this.command, owner, playLockTtlMs), Math.min(this.timings.opTimeoutMs, playLockExtendMs))
        .then(extended => {
          if (extended) {
            validUntil = Math.max(validUntil, sentAt + playLockTtlMs);
          } else {
            // 期限切れでほかに取られた。重ならないよう、この件は止めて failed で終える
            lost();
          }
        })
        .catch(() => undefined)
        .finally(() => { extending = false; });
    }, playLockExtendMs);
    // Redis に届かなくても、最後に延長できた時刻から数えた期限の前に止める
    const watchdog = setInterval(() => {
      if (!ctx.cancelled && this.now() >= validUntil - playLockSafetyMs) {
        lost();
      }
    }, 100);
    try {
      return await body();
    } finally {
      clearInterval(extender);
      clearInterval(watchdog);
      await this.op(releasePlayLock(this.command, owner), 1000).catch(() => undefined);
    }
  }

  /** この件の全体の上限（ジョブの種類を問わない実時間）。過ぎたら max-duration で止める。 */
  private armHardLimit(ctx: JobContext, ms: number): () => void {
    const timer = setTimeout(() => this.cancel(ctx, 'max-duration'), ms);
    return () => clearTimeout(timer);
  }

  /** 2.4 までの形のジョブ（古い CLI・MCP の合成、`--play-audio` の合成済み MP3）。 */
  private async handleLegacy(payload: Record<string, unknown>, queueKey: string, requeue: () => Promise<void>): Promise<void> {
    if (typeof payload._audioBase64 === 'string') {
      // 大きすぎる音声は鳴らさない（Redis から直接来るので、ここでも上限を確かめる）
      if (payload._audioBase64.length > Math.ceil(MAX_STREAM_BYTES / 3) * 4 + 4) {
        console.error('大きすぎる音声を捨てました');
        return;
      }
      const audio = Buffer.from(payload._audioBase64, 'base64');
      if (audio.length === 0) {
        return;
      }
      if (await this.muted()) {
        return;
      }
      const ctx: JobContext = { id: undefined, reported: false, cancelled: false, kills: new Set() };
      this.current = ctx;
      try {
        const outcome = await this.withPlayLock(ctx, async () => {
          if (this.held || !this.active || await this.shouldYield(queueKey)) {
            return 'requeue' as const;
          }
          // lock を待つ間にミュートされた
          if (await this.muted()) {
            return 'muted' as const;
          }
          const disarm = this.armHardLimit(ctx, this.timings.jobHardLimitMs ?? MAX_UTTERANCE_MS);
          try {
            // 表も当てる（鍵が無ければ表の補正は 0dB で、利用者の上乗せだけ）
            const gainKey = typeof payload.gainKey === 'string' && payload.gainKey.length <= 300 ? payload.gainKey : undefined;
            await this.playWhole(audio, this.gainFor(gainKey, 0), ctx);
          } finally {
            disarm();
          }
          return 'played' as const;
        });
        if (outcome === 'requeue') {
          await requeue();
        }
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
    await this.handleJob(job, queueKey, requeue);
  }

  /** 合成済みの音声をまとめて鳴らす。止められたら止め、プレイヤーが終わったのを確かめてから返る。 */
  private async playWhole(audio: Buffer, gainDb: number, ctx: JobContext): Promise<PlayResult | typeof HOLD_INTERRUPTED | typeof CANCELLED> {
    const playback = this.deps.backend.startVoice(gainDb);
    const stop = () => playback.kill();
    ctx.kills.add(stop);
    let finished = false;
    void playback.done.then(() => { finished = true; });
    try {
      if (ctx.cancelled) {
        return CANCELLED;
      }
      await this.writeToPlayer(playback, audio, ctx);
      playback.end();
      return await this.raceHold(playback.done, stop, ctx);
    } finally {
      ctx.kills.delete(stop);
      if (!finished) {
        playback.kill();
        await settleWithin(playback.done, PLAYER_STOP_WAIT_MS);
      }
    }
  }

  private async handleJob(job: Job, queueKey: string, requeue: (id?: string) => Promise<void>): Promise<void> {
    const requestId = job.type === 'synth' && typeof job.params._requestId === 'string' ? job.params._requestId : undefined;
    const ctx: JobContext = { id: job.id, reported: false, cancelled: false, kills: new Set() };
    this.current = ctx;
    try {
      // 取り出した印（--ingest は、ここから playing までの再生 lock の待ちを「見失った」に数えない）。
      // 取り出した worker の ID を添える（worker が入れ替わったら --ingest が見失ったと判断できるように）
      await this.setStatus(job.id, 'dequeued', undefined, this.workerId);
      const outcome = await this.process(job, queueKey, ctx);
      if (outcome === 'requeue') {
        if (!ctx.reported) {
          await requeue(job.id);
          return;
        }
        // 止められて、もう終わりを知らせた
      } else if (!ctx.reported) {
        ctx.reported = true;
        await this.setStatus(job.id, outcome.status, outcome.reason);
      }
      this.log('job finished', { id: job.id, type: job.type, ...(outcome === 'requeue' ? {} : outcome) });
    } catch (error) {
      console.error('Job error:', summarizeError(error));
      if (!ctx.reported) {
        ctx.reported = true;
        await this.setStatus(job.id, 'failed', error instanceof OperationTimeoutError ? 'redis-error' : 'internal-error');
      }
    } finally {
      this.current = undefined;
    }
    if (job.type !== 'sound') {
      await this.op(this.command.del(audioStreamKey(job.id))).catch(() => undefined);
    }
    if (requestId !== undefined) {
      await this.notifyCompletion(requestId);
    }
  }

  private async notifyCompletion(requestId: string): Promise<void> {
    try {
      const key = `aivis-mcp:done:${requestId}`;
      await this.op(this.command.multi().rPush(key, 'done').expire(key, 10).exec());
    } catch (error) {
      console.error('notifyCompletion error:', summarizeError(error));
    }
  }

  /** エージェントの声を Para Code へ送る手立て（Para Code から積まれていなければ undefined）。 */
  private voiceRouteFor(job: Job): VoiceRoute | undefined {
    if (job.type !== 'synth' || job.source !== 'agent') {
      // 取込の発話（通知・SSH）は Para Code へ送り返さない
      return undefined;
    }
    const params = job.params;
    const memo = <T>(make: () => Promise<T>) => {
      let value: Promise<T> | undefined;
      return () => (value ??= make());
    };
    const fallback = isParaCodeVoiceTarget(params._paraCodeVoiceTarget) ? params._paraCodeVoiceTarget : undefined;
    // 期限間近の控えは使わない（送っている途中で切れると Para Code に断られる）
    const fallbackUsable = () => fallback !== undefined && fallback.expiresAt - Date.now() >= FALLBACK_MIN_REMAINING_MS;
    // ミュート中に送らないと控えで分かる（手元で鳴らす ticket で、Para Code がミュートの印を解さない）
    const unsendableWhenMuted = fallback !== undefined && fallback.localPlayback === true && fallback.muteAware !== true;
    const requester = params._voiceRequester;
    if (isVoiceRequester(requester)) {
      // 積んだ MCP サーバーに、鳴らし始めるいま ticket を頼む。返事が無ければ（MCP サーバーが終わっている・
      // 時間切れ）、積む時に取った控えがまだ使えればそれを使う
      const waitMs = requester.remote === true ? this.timings.voiceTicketRemoteWaitMs : this.timings.voiceTicketWaitMs;
      return {
        obtain: memo(async () => {
          // 前の依頼で時間切れの直後に届いた ticket があれば、それを使う（頼み直さない）
          const late = this.takeLateTicket(requester.id);
          if (late !== undefined) {
            return late;
          }
          const fresh = await requestVoiceTicket(this.command, this.subscriber, requester, job.id, waitMs, target => this.keepLateTicket(requester.id, target));
          if (fresh !== undefined) {
            return fresh;
          }
          return fallbackUsable() ? fallback : undefined;
        }),
        expectLocalPlayback: requester.localPlayback || fallback?.localPlayback === true,
        unsendableWhenMuted,
      };
    }
    if (fallback !== undefined) {
      // 一回きりの aivis コマンドが積む時に取った ticket
      return { obtain: memo(async () => (fallbackUsable() ? fallback : undefined)), expectLocalPlayback: fallback.localPlayback === true, unsendableWhenMuted };
    }
    return undefined;
  }

  /** 時間切れの直後に届いた ticket（頼み先ごとに 1 枚。次の依頼で使う）。 */
  private readonly lateTickets = new Map<string, ParaCodeVoiceTarget>();

  private keepLateTicket(requesterId: string, target: ParaCodeVoiceTarget): void {
    this.lateTickets.set(requesterId, target);
    if (this.lateTickets.size > 64) {
      const oldest = this.lateTickets.keys().next().value;
      if (oldest !== undefined) {
        this.lateTickets.delete(oldest);
      }
    }
  }

  private takeLateTicket(requesterId: string): ParaCodeVoiceTarget | undefined {
    const target = this.lateTickets.get(requesterId);
    this.lateTickets.delete(requesterId);
    return target !== undefined && target.expiresAt - Date.now() >= FALLBACK_MIN_REMAINING_MS ? target : undefined;
  }

  private async process(job: Job, queueKey: string, ctx: JobContext): Promise<Outcome | 'requeue'> {
    const dequeuedAt = this.now();
    const route = this.voiceRouteFor(job);
    // ミュート中は着信音も鳴らさない（Q206 B）。合成もしない。ただし Para Code へ送れる声はモバイルへ届ける（Q209 B）
    if (route === undefined && await this.muted()) {
      return { status: 'muted' };
    }
    const heldMs = await this.heldMsSince(job.enqueuedAt, dequeuedAt);
    if (isJobExpired(job, dequeuedAt, heldMs)) {
      return { status: 'skipped', reason: 'expired' };
    }
    if (job.type === 'stream' && (await this.op(this.command.exists(audioStreamKey(job.id)))) === 0) {
      // 古いジョブ（Stream の期限が切れた・積んだ側が落ちた）。待たずに捨てる
      return { status: 'skipped', reason: 'stream-missing' };
    }

    const result = await this.withPlayLock(ctx, async (): Promise<Outcome | 'requeue'> => {
      if (this.held || !this.active) {
        // lock を待つ間に hold が掛かった・lock を失った。列の先頭へ戻す
        return 'requeue';
      }
      // lock を待つ間に、後から優先の高いジョブが来た。まだ鳴らし始めていないので譲る
      if (await this.shouldYield(queueKey)) {
        return 'requeue';
      }
      // lock を待つ間にミュートされた。鳴らす直前にも確かめる
      const muted = await this.muted();
      if (muted && route === undefined) {
        return { status: 'muted' };
      }
      const wait = job.type === 'synth' && typeof job.params.wait_ms === 'number' ? Math.min(Math.max(0, job.params.wait_ms), 60_000) : 0;
      const disarm = this.armHardLimit(ctx, this.timings.jobHardLimitMs
        ?? (job.type === 'synth' ? wait + MAX_UTTERANCE_MS + SYNTH_EXTRA_LIMIT_MS : MAX_UTTERANCE_MS + 5_000));
      try {
        // 打ち切りの時計は、再生の lock を取った後から数える（lock の待ちを含めない）
        const handlingStartedAt = this.now();
        if (!muted) {
          await this.setStatus(job.id, 'playing');
        }
        if (job.type === 'sound') {
          return await this.playSound(job, ctx, heldMs);
        }
        if (job.type === 'stream') {
          return await this.playStreamJob(job, ctx, handlingStartedAt, heldMs);
        }
        return await this.playSynthJob(job, ctx, heldMs, { muted, route });
      } finally {
        disarm();
      }
    });
    if (result === 'requeue' && ctx.cancelled) {
      // lock を待つ間に止められた
      return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
    }
    return result;
  }

  /** 許可フォルダ（`--ingest` が置いたもの）の中の着信音か確かめる。 */
  private async checkPrelude(prelude: PreludeSpec): Promise<{ ok: true; path: string; format: string } | { ok: false; reason: string }> {
    const dirs = new Set<string>();
    try {
      await this.op((async () => {
        for await (const key of this.command.scanIterator({ MATCH: `${PRELUDE_DIRS_PREFIX}*`, COUNT: 100 })) {
          for (const dir of await this.command.sMembers(key)) {
            dirs.add(dir);
          }
        }
      })());
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
      if (killed) {
        return 'cancelled';
      }
      const playback = this.deps.backend.playPrelude(file.path, file.format, prelude.volume);
      let exited = false;
      void playback.done.then(() => { exited = true; });
      killPlayback = () => playback.kill();
      try {
        const raced = await this.raceHold(playback.done, () => playback.kill(), ctx);
        if (raced === HOLD_INTERRUPTED) {
          return 'held';
        }
        if (raced === CANCELLED || killed) {
          return 'cancelled';
        }
        return raced.ok ? 'played' : `failed:${raced.reason}`;
      } finally {
        if (!exited) {
          playback.kill();
          await settleWithin(playback.done, PLAYER_STOP_WAIT_MS);
        }
      }
    })().finally(() => ctx.kills.delete(kill));
    return { result, kill };
  }

  private async playSound(job: SoundJob, ctx: JobContext, heldMs: number): Promise<Outcome> {
    const result = await this.startPrelude(job, job.prelude, heldMs, ctx).result;
    switch (result) {
      case 'played': return { status: 'done' };
      case 'held': return { status: 'held' };
      case 'stale': return { status: 'skipped', reason: 'prelude-stale' };
      case 'cancelled': return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
      default:
        if (result.startsWith('failed:')) {
          return { status: 'failed', reason: result.slice('failed:'.length) };
        }
        return { status: 'failed', reason: `prelude-${result.slice('rejected:'.length)}` };
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

  /** 合成を始める。届いた断片は Stream と Para Code へ流す。止めたら HTTP も取り消す。 */
  private runSynthesis(config: AppConfig, params: Record<string, unknown>, ctx: JobContext, writer: AudioStreamWriter | undefined, forward: ParaCodeForward | undefined): SynthesisRun {
    const controller = new AbortController();
    let source: (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | undefined;
    let stopped = false;
    let finished = false;
    const state = { completed: false, failed: false, overflow: false };
    const destroySource = () => {
      if (source && typeof source.destroy === 'function') {
        source.destroy();
      }
    };
    const fail = (reason: string) => {
      if (writer && !writer.isClosed) {
        void writer.abort(reason).catch(() => undefined);
      }
      forward?.abort();
    };
    const done = (async () => {
      try {
        source = await this.deps.synthesize(config, params, controller.signal) as typeof source;
      } catch (error) {
        state.failed = true;
        finished = true;
        if (!stopped) {
          console.error('Error in synthesize:', summarizeError(error));
        }
        fail('synthesis-failed');
        return;
      }
      // 応答を待つ間に止められた。受け取り始めない
      if (stopped || ctx.cancelled) {
        finished = true;
        destroySource();
        fail('stopped');
        return;
      }
      const stream = source!;
      await new Promise<void>(resolve => {
        const finish = () => {
          finished = true;
          resolve();
        };
        stream.on('data', (value: Buffer | string) => {
          if (stopped) {
            return;
          }
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (writer && !writer.isDiscarded && !writer.write(chunk) && !state.overflow && !writer.isClosed) {
            state.overflow = true;
            void writer.abort('too-large').catch(() => undefined);
          }
          forward?.push(chunk);
        });
        stream.once('end', () => {
          if (!stopped) {
            state.completed = true;
            if (writer && !writer.isClosed) {
              void writer.end().catch(() => undefined);
            }
            forward?.end();
          }
          finish();
        });
        stream.once('error', (error: unknown) => {
          if (!stopped) {
            state.failed = true;
            console.error('Stream error:', summarizeError(error));
          }
          fail('synthesis-failed');
          finish();
        });
        // destroy された・相手が切った（end も error も来ない）ときも待ちを終える
        stream.once('close', () => {
          if (!finished && !state.completed) {
            fail('synthesis-closed');
          }
          finish();
        });
      });
    })();
    return {
      done,
      get completed() { return state.completed; },
      get failed() { return state.failed; },
      get overflow() { return state.overflow; },
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        controller.abort();
        if (!finished) {
          destroySource();
        }
      },
    };
  }

  /** 止められる・hold・期限のどれかまで待つ。 */
  private async waitBounded<T>(promise: Promise<T>, ctx: JobContext, deadline: number): Promise<Bounded<T>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - this.now())); });
    try {
      const raced = await this.raceHold(Promise.race([promise.then(value => ({ value })), timeout]), () => undefined, ctx);
      if (raced === HOLD_INTERRUPTED) {
        return 'held';
      }
      if (raced === CANCELLED) {
        return 'cancelled';
      }
      return raced;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * この機械のエージェントの声。合成しながら Stream に流し、同じ Stream から鳴らす。
   * Para Code から起動されていれば、同じ音声を Para Code へも送る（取込の発話は送り返さない）。
   * ミュート中は、Para Code へ送れるときだけ合成して送り、この機械では鳴らさない（Q209 B）。
   */
  private async playSynthJob(job: SynthJob, ctx: JobContext, heldMs: number, options: { muted: boolean; route: VoiceRoute | undefined }): Promise<Outcome> {
    const config = this.deps.loadConfig();
    const params = job.params;
    const setupError = synthesisSetupError(config, params);
    if (setupError !== undefined) {
      console.error(setupError);
      return { status: 'failed', reason: 'not-configured' };
    }
    if (typeof params.wait_ms === 'number' && params.wait_ms > 0) {
      const waited = await this.waitBounded(delay(Math.min(params.wait_ms, 60000)), ctx, Number.MAX_SAFE_INTEGER);
      if (waited === 'held') {
        return { status: 'held' };
      }
      if (waited === 'cancelled') {
        return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
      }
    }
    // 最初の音・1 発話の上限は、待ち（wait_ms）の後から数える
    const handlingStartedAt = this.now();
    const deadline = handlingStartedAt + MAX_UTTERANCE_MS;
    const provider = providerOf(params);
    const gainKey = provider === 'elevenlabs'
      ? gainKeyFor('elevenlabs', (params.voice_id as string | undefined) || config.elevenLabsVoiceId, (params.model_id as string | undefined) || config.elevenLabsModelId)
      : gainKeyFor('aivis', (params.model_uuid as string | undefined) || config.modelUuid, undefined);
    const tagged = hasEmotionTags(params.text);
    const route = options.route;

    if (options.muted) {
      return this.forwardOnly(config, params, ctx, route, { gainKey, tagged, deadline });
    }

    const writer = new AudioStreamWriter(this.command, job.id);
    await this.op(writer.open());
    // ticket は、送り始めるいま取る（取れるまでの断片は溜めておく）
    const forward = route === undefined ? undefined : startParaCodeForward(route.obtain(), { gainKey, tagged });
    const synthesis = this.runSynthesis(config, params, ctx, writer, forward);
    ctx.kills.add(synthesis.stop);

    const stopAll = () => {
      synthesis.stop();
      forward?.abort();
    };
    const stoppedOutcome = (bounded: 'held' | 'cancelled' | 'timeout'): Outcome => {
      stopAll();
      if (bounded === 'held') {
        return { status: 'held' };
      }
      if (bounded === 'cancelled') {
        return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
      }
      return { status: 'failed', reason: 'max-duration' };
    };

    try {
      if (forward !== undefined && route?.expectLocalPlayback === true) {
        // SSH 先から発話し、Para Code が手元の PC で鳴らす。引き受けたと分かったら、この機械では鳴らさない
        const decision = await this.waitBounded(forward.decision, ctx, deadline);
        if (typeof decision === 'string') {
          return stoppedOutcome(decision);
        }
        if (decision.value === 'unavailable') {
          // ticket が取れなかった。手元の PC で鳴らす前提のペインなので、接続先では鳴らさない（Q208 A）
          stopAll();
          return { status: 'failed', reason: 'ticket-unavailable' };
        }
        if (decision.value === 'remote') {
          // 引き受けた後に止める（hold・中断・打ち切り）ときも、この機械の再生へは切り替えない
          const synthesized = await this.waitBounded(synthesis.done, ctx, deadline);
          if (typeof synthesized === 'string') {
            return stoppedOutcome(synthesized);
          }
          if (!synthesis.completed) {
            return { status: 'failed', reason: 'synthesis-failed' };
          }
          // 本文の返事まで見る。引き受けた後に localPlayback:false が返ったら、この機械で鳴らす
          const outcome = await this.waitBounded(forward.outcome, ctx, this.now() + FORWARD_IDLE_TIMEOUT_MS + 5_000);
          if (typeof outcome === 'string') {
            if (outcome === 'timeout') {
              return { status: 'done', reason: 'played-by-para-code' };
            }
            return stoppedOutcome(outcome);
          }
          if (outcome.value !== 'local') {
            return { status: 'done', reason: 'played-by-para-code' };
          }
          console.error('Para Code が手元で鳴らせなかったので、この機械で鳴らします');
        } else {
          // 拒否された・届かなかった。合成を受け取り終えてから、この機械で鳴らす
          const synthesized = await this.waitBounded(synthesis.done, ctx, deadline);
          if (typeof synthesized === 'string') {
            return stoppedOutcome(synthesized);
          }
        }
        if (synthesis.overflow || (!synthesis.completed && !synthesis.failed)) {
          // Stream に収まらなかった。読み捨てた分は戻らないので、合成し直して鳴らす
          console.error('Para Code へ音声を渡せなかったので、合成し直してこの機械で鳴らします');
          return await this.resynthesizeAndPlay(job, ctx);
        }
      }
      const outcome = await this.playFromStream({
        job,
        ctx,
        streamKey: writer.key,
        gainKey,
        extraGainDb: job.volumeDb ?? 0,
        tagged,
        prelude: job.prelude,
        handlingStartedAt: route?.expectLocalPlayback === true ? this.now() : handlingStartedAt,
        heldMs,
      });
      if (synthesis.failed && outcome.status !== 'done') {
        return { status: 'failed', reason: 'synthesis-failed' };
      }
      return outcome;
    } finally {
      ctx.kills.delete(synthesis.stop);
      if (!synthesis.completed) {
        // 先に返った（止めた・hold・打ち切り・失敗）。合成も送り出しももう要らない。書きかけも捨てる
        stopAll();
        writer.discard();
      }
      await settleWithin(synthesis.done, SYNTHESIS_SETTLE_MS);
      await settleWithin(writer.settled(), SYNTHESIS_SETTLE_MS);
    }
  }

  /** 合成し直して、この機械で鳴らす（Para Code へ渡せなかったとき）。 */
  private async resynthesizeAndPlay(job: SynthJob, ctx: JobContext): Promise<Outcome> {
    // 合成を作り直すジョブには着信音も送り先も付けない
    const retry: SynthJob = {
      ...job,
      id: uuidv4(),
      prelude: undefined,
      params: { ...job.params, wait_ms: undefined, _paraCodeVoiceTarget: undefined, _voiceRequester: undefined },
    };
    try {
      return await this.playSynthJob(retry, ctx, 0, { muted: false, route: undefined });
    } finally {
      await this.op(this.command.del(audioStreamKey(retry.id))).catch(() => undefined);
    }
  }

  /** ミュート中: Para Code へ送れるときだけ合成して送る（モバイルへ届ける）。この機械では鳴らさない。 */
  private async forwardOnly(
    config: AppConfig,
    params: Record<string, unknown>,
    ctx: JobContext,
    route: VoiceRoute | undefined,
    options: { gainKey: string | undefined; tagged: boolean; deadline: number },
  ): Promise<Outcome> {
    if (route === undefined || route.unsendableWhenMuted) {
      // 送らないと分かっている件は、ticket を頼まない（無駄に取らない）
      return { status: 'muted' };
    }
    const target = await this.waitBounded(route.obtain(), ctx, options.deadline);
    if (typeof target === 'string') {
      return target === 'held' ? { status: 'held' } : { status: 'muted' };
    }
    if (target.value === undefined) {
      return { status: 'muted' };
    }
    if (target.value.localPlayback === true && target.value.muteAware !== true) {
      // 手元の PC で鳴らす ticket で、Para Code がミュートの印を解さない。送ると手元で鳴ってしまうので送らない
      return { status: 'muted' };
    }
    // 手元で鳴らす ticket なら `X-Para-Muted: 1` を付ける（Para Code は手元で鳴らさず、モバイルへだけ流す）
    const forward = startParaCodeForward(target.value, { gainKey: options.gainKey, tagged: options.tagged, muted: true });
    const synthesis = this.runSynthesis(config, params, ctx, undefined, forward);
    ctx.kills.add(synthesis.stop);
    try {
      const synthesized = await this.waitBounded(synthesis.done, ctx, options.deadline);
      if (typeof synthesized === 'string') {
        synthesis.stop();
        forward.abort();
        return synthesized === 'held' ? { status: 'held' } : { status: 'muted' };
      }
      await settleWithin(forward.settled, FORWARD_IDLE_TIMEOUT_MS);
      return { status: 'muted', reason: 'forwarded' };
    } finally {
      ctx.kills.delete(synthesis.stop);
      await settleWithin(synthesis.done, SYNTHESIS_SETTLE_MS);
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
      await settleWithin(done, PLAYER_STOP_WAIT_MS);
      return result.stopped;
    }
    if ('value' in result) {
      return result.value;
    }
    return done;
  }

  /**
   * プレイヤーへ書く。入力が詰まっていれば空くまで待つ（溜め込まない）。待つ間に止められた・hold が
   * 掛かったら、待つのをやめて返る（呼び出し側がプレイヤーを止める）。
   */
  private async writeToPlayer(playback: VoicePlayback, chunk: Buffer, ctx: JobContext): Promise<void> {
    let written = false;
    const writing = playback.write(chunk).then(() => { written = true; });
    while (!written) {
      if (ctx.cancelled || this.held) {
        return;
      }
      await Promise.race([writing, this.waitForHoldChange(250)]);
    }
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
        await settleWithin(prelude.result, PLAYER_STOP_WAIT_MS);
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
    let playResult: PlayResult | undefined;
    let lastExistsCheck = this.now();

    const preludeState: { value: 'playing' | 'finished' | 'held' } = { value: prelude ? 'playing' : 'finished' };
    void prelude?.result.then(result => {
      preludeState.value = result === 'held' ? 'held' : 'finished';
    });

    const stopPlayback = () => {
      playback?.kill();
    };
    ctx.kills.add(stopPlayback);
    const cancelledOutcome = (): Outcome => ({ status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' });
    /** プレイヤーの結果を知らせに直す（止めた・失敗した）。 */
    const failedPlayback = (result: PlayResult | undefined): Outcome => {
      if (ctx.cancelled) {
        return cancelledOutcome();
      }
      return { status: 'failed', reason: result !== undefined && !result.ok && result.reason !== 'killed' ? result.reason : 'player-exited' };
    };

    try {
      while (true) {
        if (ctx.cancelled) {
          return cancelledOutcome();
        }
        if (this.held || preludeState.value === 'held') {
          return { status: 'held' };
        }

        // 鳴らし始めるまでは、end の後も読み続ける（鳴らすのをやめる印を見落とさない）
        if (!((ended || aborted) && playback)) {
          let events: Awaited<ReturnType<AudioStreamReader['read']>>;
          try {
            events = await this.op(reader.read(POLL_MS), POLL_MS + this.timings.opTimeoutMs);
          } catch (error) {
            // 読めない（Redis が切れた・応答しない・キーが壊れた）。鳴らしている途中ならプレイヤーを止めて終える
            console.error('音声を読めませんでした:', summarizeError(error));
            return { status: 'failed', reason: 'redis-error' };
          }
          const now = this.now();
          for (const event of events) {
            if (event.kind === 'data') {
              if (ended || aborted) {
                continue;
              }
              // Redis から直接来るので、ここでも項目の大きさと合計を確かめる
              if (event.data.length > MAX_STREAM_ENTRY_BYTES || receivedBytes + event.data.length > MAX_STREAM_BYTES) {
                return { status: 'failed', reason: 'too-large' };
              }
              monitor.onAudio(now, event.data.length);
              received.push(event.data);
              receivedBytes += event.data.length;
              if (playback) {
                await this.writeToPlayer(playback, event.data, ctx);
              } else {
                buffered.push(event.data);
                bufferedBytes += event.data.length;
              }
            } else if (event.kind === 'end') {
              ended = true;
              monitor.onEnded();
            } else if (event.kind === 'abort') {
              aborted = true;
              abortReason = event.reason;
              monitor.onEnded();
            } else if (!playback) {
              // 鳴らし始める前に、鳴らすのをやめる印が来た（end の後の abort）
              return { status: 'skipped', reason: event.reason };
            }
          }
          if (events.length === 0 && !ended && !aborted && now - lastExistsCheck >= 1000) {
            lastExistsCheck = now;
            if ((await this.op(this.command.exists(streamKey)).catch(() => 1)) === 0) {
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
              return cancelledOutcome();
            }
            return result.ok ? { status: 'done', reason: cutoff } : failedPlayback(result);
          }
          return { status: 'failed', reason: cutoff };
        }

        if (aborted && !playback) {
          // 鳴り始める前の中断は捨てる
          return { status: 'skipped', reason: abortReason ?? 'aborted' };
        }

        if (!playback && preludeState.value === 'finished' && shouldStartPlayback({ bufferedBytes, bitrateKbps, ended })) {
          const started = this.deps.backend.startVoice(this.gainFor(request.gainKey, request.extraGainDb));
          playback = started;
          void started.done.then(result => {
            playbackDone = true;
            playResult = result;
          });
          const pending = buffered;
          buffered = [];
          bufferedBytes = 0;
          for (const chunk of pending) {
            await this.writeToPlayer(started, chunk, ctx);
          }
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
          const result = await this.raceHold(Promise.race([current.done, timeout]), stopPlayback, ctx);
          clearTimeout(timer);
          if (result === HOLD_INTERRUPTED) {
            return { status: 'held' };
          }
          // 止めた（プレイヤーを kill した）結果として鳴り終わった場合も、止めた扱いにする
          if (result === CANCELLED || ctx.cancelled) {
            return cancelledOutcome();
          }
          if (result === 'timeout') {
            return { status: 'failed', reason: 'max-duration' };
          }
          if (!result.ok) {
            // プレイヤーが無い・起動できない・0 以外で終わった。鳴らせていないので覚え直しにも使わない
            return failedPlayback(result);
          }
          const completed = ended && !aborted;
          if (completed) {
            this.scheduleLearning(request, Buffer.concat(received, receivedBytes));
          }
          return completed ? { status: 'done' } : { status: 'done', reason: abortReason ?? 'aborted' };
        }

        if (playback && playbackDone && !ended && !aborted) {
          // デコーダが先に落ちた
          return failedPlayback(playResult);
        }
      }
    } finally {
      ctx.kills.delete(stopPlayback);
      // どこで返っても（例外を含む）、鳴っているプレイヤーを止め、終わったのを確かめてから返る
      if (playback !== undefined && !playbackDone) {
        playback.kill();
        await settleWithin(playback.done, PLAYER_STOP_WAIT_MS);
      }
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

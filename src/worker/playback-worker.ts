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
import { publishWorkerGainSettings } from '../queue/worker-gain-settings.js';
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
  audioStreamKey, DEQUEUE_ORDER, HIGH_QUEUE_KEY, HOLD_CHANNEL, LEGACY_QUEUE_KEY, NORMAL_QUEUE_KEY, PLAY_LOCK_KEY, PRELUDE_DIRS_PREFIX, presynthKey,
} from '../queue/keys.js';
import { pushStatus, type JobStatus } from '../queue/status.js';
import { OperationTimeoutError, REDIS_OP_TIMEOUT_MS, settleWithin } from '../queue/timeout.js';
import {
  acquireWorkerLockDetailed, drainLegacyQueue, extendPlayLock, LEGACY_WORKER_GRACE_MS, PLAY_LOCK_EXTEND_MS, PLAY_LOCK_TTL_MS,
  refreshWorkerLock, releasePlayLock, releaseWorkerLock, tryAcquirePlayLock, WORKER_HEARTBEAT_MS, WORKER_LOCK_TTL_MS,
} from '../queue/worker-lock.js';
import { isMuted } from '../services/mute-service.js';
import { isParaCodeVoiceTarget, mobileListening, releaseParaCodeVoiceTicket, type ParaCodeVoiceTarget } from '../services/para-code-voice.js';
import { routeLog, shortId } from '../services/route-log.js';
import { isVoiceRequester, requestVoiceTicket, VOICE_TICKET_REMOTE_WAIT_MS, VOICE_TICKET_WAIT_MS } from '../services/voice-ticket.js';
import { FORWARD_IDLE_TIMEOUT_MS, startParaCodeForward, type ForwardOptions, type ParaCodeForward } from './para-code-forward.js';
import {
  jobsInDequeueOrder, prevVoiceBefore, PRESYNTH_MARKER_TTL_SECONDS, PRESYNTH_MAX_BYTES, PRESYNTH_MAX_ENTRIES, PRESYNTH_SCAN_MS, PRESYNTH_TOUCH_MS,
  SynthesisGate,
} from './presynth.js';

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
  /** 先送り（モバイルへ先に合成して送る）のために列を見直す間隔 */
  readonly presynthScanMs: number;
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
  presynthScanMs: PRESYNTH_SCAN_MS,
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
  /** 積む時に取った控えの ticket */
  readonly fallback: ParaCodeVoiceTarget | undefined;
  /** obtain で得た ticket（まだ得ていない・得られなかったら undefined） */
  obtained?: ParaCodeVoiceTarget;
  /** Para Code へ送るのに使った ticket（使わなかった ticket は終わったら返す） */
  readonly used: Set<string>;
}

/** 先送り（PC の再生待ちの間にモバイルへ先に合成して送る）している 1 件。 */
interface PresynthEntry {
  readonly jobId: string;
  /** 先送りするか決まったら解決する（ticket が取れない・モバイルが聞いていなければ declined） */
  readonly decision: Promise<'presynth' | 'declined'>;
  /** 合成が終わった（最後まで・失敗・止めた）ら解決する */
  done: Promise<void>;
  writer: AudioStreamWriter | undefined;
  run: SynthesisRun | undefined;
  /** PC の側がこの件を扱い終えた（Stream を消してよい） */
  released: boolean;
  /** 列にも PC の番にも見えなくなった時刻（片付けの判断） */
  missingSince?: number;
  /** Para Code への送り出しに最初の断片を渡した（ticket を使った） */
  connected: boolean;
}

/** 合成の番と、ElevenLabs の文脈をつなぐかを決める手がかり。 */
interface SynthesisLink {
  readonly jobId: string;
  /** 聞こえる順でこの件の直前に来る声の件の ID（番が来たときに読む） */
  readonly prevVoiceId: () => string | undefined | Promise<string | undefined>;
  readonly priority: 'main' | 'presynth';
  /** 合成の番が来たときに呼ぶ（Para Code への送り出しをここでつなぐ。{@link PlaybackWorker.gatedForward}） */
  readonly onStart?: () => void;
}

/** 合成の流れ 1 本。 */
interface SynthesisRun {
  /** 合成の流れが終わった（最後まで・失敗・止めた）ら解決する */
  readonly done: Promise<void>;
  /** 合成の番が来た（ほかの合成を待ち終えた）ら解決する */
  readonly started: Promise<void>;
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
/** setTimeout に渡せる最長（これを超えると Node は 1 ms に縮める）。 */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** {@link PlaybackWorker.waitBounded} に渡す「期限なし」。 */
const NO_DEADLINE = Number.POSITIVE_INFINITY;
/** 引き継いだ先送りの Stream が書き終わるのを待つ上限。 */
const INHERITED_END_WAIT_MS = 5_000;
/** 期限切れの声を裏でモバイルへ送る件の上限（待っている件を含む）。 */
const EXPIRED_FORWARD_MAX_PENDING = 4;
/** 先送りの見回りで読む列の長さ（取り出す側の端から）。 */
const PRESYNTH_SCAN_WINDOW = 64;
/** 列にも PC の番にも見えない先送りの件を片付けるまで。 */
const PRESYNTH_ORPHAN_MS = 10_000;

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
  /** 合成を 1 本ずつに絞る（PC の番を先に通す） */
  private readonly synthesisGate = new SynthesisGate();
  /** 先送りしている件（ジョブ ID ごと） */
  private readonly presynths = new Map<string, PresynthEntry>();
  /** 先送りを見送った件（もう一度は試さない） */
  private readonly presynthDeclined = new Set<string>();
  /** PC の番が自分で合成すると決めた件（先送りと取り合わない） */
  private readonly mainClaimed = new Set<string>();
  /** ジョブごとの送り先（先送りと PC の番で同じ ticket を使う） */
  private readonly routes = new Map<string, VoiceRoute>();
  /** 裏で走らせている送り出し（期限切れの声をモバイルへ） */
  private readonly backgroundForwards = new Set<Promise<void>>();
  private presynthWake: (() => void) | undefined;
  private presynthLoop: Promise<void> | undefined;
  /** 最後に合成を始めた件の ID（文脈をつなぐかの判断） */
  private lastSynthesizedId: string | undefined;
  /** PC の番で最後に扱った声の件の ID と、いま扱っている声の件の ID */
  private lastVoiceId: string | undefined;
  private currentVoiceId: string | undefined;

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
    void this.publishGainSettings();
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
    this.presynthLoop = this.runPresynthLoop();

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
    await this.stopPresynth(false);
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
    this.presynthWake?.();
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
    // 先送りの合成も止める（書きかけの Stream は中断の印で終わる。次の worker は鳴らさずに捨てる）
    void this.stopPresynth(true);
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
        void this.publishGainSettings();
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

  /** 覚え直しに使っている窓と最短秒数（と文脈を付ける時間）を、lock と同じ寿命で Redis に置く（`tts-get-settings` が見る）。 */
  private async publishGainSettings(): Promise<void> {
    try {
      const config = this.deps.loadConfig();
      await this.op(publishWorkerGainSettings(this.command, {
        learnWindow: config.gainLearnWindow,
        minLearnSeconds: config.gainMinLearnSeconds,
        version: this.deps.version,
        elevenLabsContextWindowMinutes: config.elevenLabsContextWindowMinutes,
      }));
    } catch (error) {
      console.error('Worker gain settings publish error:', summarizeError(error));
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
          // 合成を通らない声。次の合成の文脈はつなげない
          this.markVoice(undefined);
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
    if (job.type !== 'sound') {
      this.currentVoiceId = job.id;
    }
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
      if (outcome !== 'requeue' && outcome.status === 'skipped' && outcome.reason === 'expired') {
        routeLog('queue.expired', { job: shortId(job.id), type: job.type, priority: job.priority });
      }
    } catch (error) {
      console.error('Job error:', summarizeError(error));
      if (!ctx.reported) {
        ctx.reported = true;
        await this.setStatus(job.id, 'failed', error instanceof OperationTimeoutError ? 'redis-error' : 'internal-error');
      }
    } finally {
      this.current = undefined;
      this.currentVoiceId = undefined;
      this.mainClaimed.delete(job.id);
    }
    const presynth = this.presynths.get(job.id);
    if (presynth !== undefined) {
      // Stream は先送りの合成が終わってから消す（書いている途中で消すと、書き足しがキーを作り直す）
      this.releasePresynth(presynth);
    } else if (job.type === 'synth') {
      // 入れ替わる前の worker が先送りした件の印も消す
      await this.op(this.command.del([audioStreamKey(job.id), presynthKey(job.id)])).catch(() => undefined);
    } else if (job.type !== 'sound') {
      await this.op(this.command.del(audioStreamKey(job.id))).catch(() => undefined);
    }
    this.finishRoute(job.id);
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

  /**
   * エージェントの声を Para Code へ送る手立て（Para Code から積まれていなければ undefined）。ジョブごとに 1 つ作って
   * 覚える（先送りと PC の番で同じ ticket を使い、頼み先へ 2 回頼まない）。
   */
  private voiceRouteFor(job: Job): VoiceRoute | undefined {
    const cached = this.routes.get(job.id);
    if (cached !== undefined) {
      return cached;
    }
    const route = this.createVoiceRoute(job);
    if (route !== undefined) {
      this.routes.set(job.id, route);
    }
    return route;
  }

  /** 扱い終えた件の送り先を忘れ、使わなかった ticket を返す（裏で送っている件は送り終えてから）。 */
  private finishRoute(jobId: string): void {
    const route = this.routes.get(jobId);
    this.routes.delete(jobId);
    if (route !== undefined && !this.backgroundRoutes.has(route)) {
      this.releaseUnusedTickets(jobId, route);
    }
  }

  /** 裏で送り出しに使っている送り先（扱い終えても ticket を返さない） */
  private readonly backgroundRoutes = new Set<VoiceRoute>();

  /** 使わなかった ticket（積む時の控え・頼んで得たもの）を Para Code へ返す。 */
  private releaseUnusedTickets(jobId: string, route: VoiceRoute): void {
    const unused = new Map<string, ParaCodeVoiceTarget>();
    for (const target of [route.fallback, route.obtained]) {
      if (target !== undefined && !route.used.has(target.ticket) && target.release === true) {
        unused.set(target.ticket, target);
      }
    }
    for (const target of unused.values()) {
      void releaseParaCodeVoiceTicket(target).then(released => {
        routeLog('ticket.release', { job: shortId(jobId), ok: released });
      }).catch(() => undefined);
    }
  }

  /** 送り先の ticket を、送り出しに使うものとして取る（使った印を付ける）。 */
  private obtainForForward(route: VoiceRoute, jobId: string, when: string): Promise<ParaCodeVoiceTarget | undefined> {
    return route.obtain().then(target => {
      if (target !== undefined) {
        route.used.add(target.ticket);
        routeLog('forward.start', { job: shortId(jobId), when, listeners: target.mobileListeners, local: target.localPlayback === true ? true : undefined });
      }
      return target;
    });
  }

  private createVoiceRoute(job: Job): VoiceRoute | undefined {
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
      const route: VoiceRoute = {
        obtain: memo(async () => {
          // 前の依頼で時間切れの直後に届いた ticket があれば、それを使う（頼み直さない）
          const late = this.takeLateTicket(requester.id);
          const fresh = late ?? await requestVoiceTicket(this.command, this.subscriber, requester, job.id, waitMs, target => this.keepLateTicket(requester.id, target));
          route.obtained = fresh ?? (fallbackUsable() ? fallback : undefined);
          if (route.obtained === undefined) {
            routeLog('ticket.unavailable', { job: shortId(job.id), via: 'mcp' });
          }
          return route.obtained;
        }),
        expectLocalPlayback: requester.localPlayback || fallback?.localPlayback === true,
        unsendableWhenMuted,
        fallback,
        used: new Set(),
      };
      return route;
    }
    if (fallback !== undefined) {
      // 一回きりの aivis コマンドが積む時に取った ticket
      const route: VoiceRoute = {
        obtain: memo(async () => {
          route.obtained = fallbackUsable() ? fallback : undefined;
          if (route.obtained === undefined) {
            routeLog('ticket.unavailable', { job: shortId(job.id), via: 'enqueue' });
          }
          return route.obtained;
        }),
        expectLocalPlayback: fallback.localPlayback === true,
        unsendableWhenMuted,
        fallback,
        used: new Set(),
      };
      return route;
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
    // 先送り（モバイルへ先に合成して送る）している件か。していなければ、PC の番がこの件を自分で合成すると決める
    // （ここまで await を挟まないので、先送りの側と取り合わない）
    const pending = this.presynths.get(job.id);
    if (pending === undefined && job.type === 'synth') {
      this.mainClaimed.add(job.id);
    }
    let presynth: { readonly entry: PresynthEntry | undefined } | undefined;
    if (pending !== undefined && (await pending.decision) === 'presynth') {
      presynth = { entry: pending };
    } else if (job.type === 'synth') {
      const owner = await this.op(this.command.get(presynthKey(job.id))).catch(() => null);
      if (owner !== null && owner !== this.workerId) {
        // 入れ替わる前の worker（またはほかの worker）が先送りした件。モバイルへは送ってあるので、合成し直さずに Stream から鳴らす
        presynth = { entry: undefined };
      }
    }
    const route = presynth !== undefined ? undefined : this.voiceRouteFor(job);
    // ミュート中は着信音も鳴らさない（Q206 B）。合成もしない。ただし Para Code へ送れる声はモバイルへ届ける（Q209 B）
    if (route === undefined && await this.muted()) {
      // 先送りした件は、もうモバイルへ送ってある（送っている）
      return presynth !== undefined ? { status: 'muted', reason: 'forwarded' } : { status: 'muted' };
    }
    const heldMs = await this.heldMsSince(job.enqueuedAt, dequeuedAt);
    if (isJobExpired(job, dequeuedAt, heldMs)) {
      // 期限切れは PC で鳴らさないだけ。モバイルが聞いていれば、先送りしていない声も合成して送る（Q309 A）
      if (job.type === 'synth' && route !== undefined) {
        this.forwardExpiredInBackground(job, route);
      }
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
        return presynth !== undefined ? { status: 'muted', reason: 'forwarded' } : { status: 'muted' };
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
        if (presynth !== undefined) {
          return await this.playPresynthesized(job, ctx, heldMs, presynth.entry);
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
    // 取込の声（Para Code の通知・SSH 先の発話）が挟まった。聞き手には声なので、前の ElevenLabs の発話とはつなげない
    this.deps.synthesize.forgetContext?.();
    this.markVoice(job.id);
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
   * 合成を始める。届いた断片は Stream と Para Code へ流す。止めたら HTTP も取り消す。合成は worker 全体で 1 本ずつ
   * （{@link SynthesisGate}）。番が来たときに、ElevenLabs の文脈をつなぐかを決める（{@link beginSynthesisContext}）。
   */
  private runSynthesis(config: AppConfig, params: Record<string, unknown>, ctx: JobContext, writer: AudioStreamWriter | undefined, forward: ParaCodeForward | undefined, link: SynthesisLink): SynthesisRun {
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
    const synthesizeOnce = async () => {
      // 番を待つ間に止められた。合成しない
      if (stopped || ctx.cancelled) {
        finished = true;
        fail('stopped');
        return;
      }
      const prevVoiceId = await link.prevVoiceId();
      if (stopped || ctx.cancelled) {
        finished = true;
        fail('stopped');
        return;
      }
      this.beginSynthesisContext(link.jobId, prevVoiceId);
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
    };
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const done = (async () => {
      const releaseGate = await this.synthesisGate.acquire(link.priority, link.jobId);
      markStarted();
      try {
        // 止められていても呼ぶ（送り出しは ticket を受け取ってから、止めた印を見て終わる）
        link.onStart?.();
        await synthesizeOnce();
      } finally {
        releaseGate();
      }
    })();
    return {
      done,
      started,
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

  /**
   * 止められる・hold・期限のどれかまで待つ。`deadline` が {@link NO_DEADLINE}（または setTimeout に渡せない遠さ）なら
   * 期限では打ち切らない（2^31-1 ms を超える setTimeout は Node が 1 ms に縮めるため）。
   */
  private async waitBounded<T>(promise: Promise<T>, ctx: JobContext, deadline: number): Promise<Bounded<T>> {
    let timer: NodeJS.Timeout | undefined;
    const remaining = Math.max(0, deadline - this.now());
    const timeout = remaining > MAX_TIMER_MS
      ? new Promise<'timeout'>(() => undefined)
      : new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), remaining); });
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
      const waited = await this.waitBounded(delay(Math.min(params.wait_ms, 60000)), ctx, NO_DEADLINE);
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
    const gainKey = this.synthGainKey(config, params);
    const tagged = hasEmotionTags(params.text);
    const route = options.route;
    // 聞こえる順で直前の声を合成していたときだけ、ElevenLabs の文脈をつなぐ
    const prevVoiceId = this.markVoice(job.id);
    const link: SynthesisLink = { jobId: job.id, prevVoiceId: () => prevVoiceId, priority: 'main' };

    if (options.muted) {
      return this.forwardOnly(config, params, ctx, route, { gainKey, tagged, deadline, link, jobId: job.id });
    }

    const writer = new AudioStreamWriter(this.command, job.id);
    await this.op(writer.open());
    // ticket は、送り始めるいま取る（取れるまでの断片は溜めておく）
    const gated = route === undefined ? undefined : this.gatedForward(() => this.obtainForForward(route, job.id, 'play'), { gainKey, tagged });
    const forward = gated?.forward;
    const synthesis = this.runSynthesis(config, params, ctx, writer, forward, { ...link, onStart: gated?.onStart });
    ctx.kills.add(synthesis.stop);

    const stopAll = () => {
      synthesis.stop();
      forward?.abort();
    };
    let playStartedAt = handlingStartedAt;
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
      // 先送りの合成が走っていれば、それが終わるまで待つ（合成は 1 本ずつ）。hold・中断で抜ける。最初の音の時計は番が来てから数える
      const begun = await this.waitBounded(Promise.race([synthesis.started, synthesis.done]), ctx, NO_DEADLINE);
      if (typeof begun === 'string') {
        return stoppedOutcome(begun);
      }
      playStartedAt = Math.max(handlingStartedAt, this.now());
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
        handlingStartedAt: route?.expectLocalPlayback === true ? this.now() : playStartedAt,
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
    // 最初の合成が読み終えていれば、この発話自体が「直前の発話」として残っている。自分につなげないよう消す
    this.deps.synthesize.forgetContext?.();
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
    options: { gainKey: string | undefined; tagged: boolean; deadline: number; link: SynthesisLink; jobId: string },
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
    route!.used.add(target.value.ticket);
    routeLog('forward.start', { job: shortId(options.jobId), when: 'muted', listeners: target.value.mobileListeners });
    // 手元で鳴らす ticket なら `X-Para-Muted: 1` を付ける（Para Code は手元で鳴らさず、モバイルへだけ流す）
    const resolved = target.value;
    const { forward, onStart } = this.gatedForward(() => resolved, { gainKey: options.gainKey, tagged: options.tagged, muted: true });
    const synthesis = this.runSynthesis(config, params, ctx, undefined, forward, { ...options.link, onStart });
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

  /**
   * 合成の番が来てから Para Code へつなぐ送り出し。番を待つ間に先につなぐと、Para Code が最初の音を 10 秒で
   * 待ちきれずに切る（ticket は 1 回限りなので送り直せない）。`onStart` を {@link SynthesisLink} に渡す。
   */
  private gatedForward(target: () => Promise<ParaCodeVoiceTarget | undefined> | ParaCodeVoiceTarget | undefined, options: ForwardOptions): { readonly forward: ParaCodeForward; readonly onStart: () => void } {
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    return { forward: startParaCodeForward(gate.then(target), options), onStart: open };
  }

  /** PC の番で声の件を扱い始めた（`undefined` は ID の無い 2.4 の形の声）。直前に扱った声の件の ID を返す。 */
  private markVoice(id: string | undefined): string | undefined {
    const previous = this.lastVoiceId;
    this.lastVoiceId = id ?? `legacy-${uuidv4()}`;
    return previous;
  }

  /**
   * 合成の番が来た。聞こえる順で直前に来る声の件（`prevVoiceId`）を最後に合成していたときだけ、ElevenLabs の文脈
   * （前の発話の ID）をつなぐ。先送りで合成の順と聞こえる順がずれても、間に別の声が入る発話はつながない。
   */
  private beginSynthesisContext(jobId: string, prevVoiceId: string | undefined): void {
    if (prevVoiceId === undefined || prevVoiceId !== this.lastSynthesizedId) {
      this.deps.synthesize.forgetContext?.();
    }
    this.lastSynthesizedId = jobId;
  }

  /** 合成の設定から音量の表の鍵を作る。 */
  private synthGainKey(config: AppConfig, params: Record<string, unknown>): string | undefined {
    return providerOf(params) === 'elevenlabs'
      ? gainKeyFor('elevenlabs', (params.voice_id as string | undefined) || config.elevenLabsVoiceId, (params.model_id as string | undefined) || config.elevenLabsModelId)
      : gainKeyFor('aivis', (params.model_uuid as string | undefined) || config.modelUuid, undefined);
  }

  /** 先送りで合成済み（合成中）の声を、Stream から鳴らす。モバイルへはもう送ってある。 */
  private async playPresynthesized(job: SynthJob, ctx: JobContext, heldMs: number, entry: PresynthEntry | undefined): Promise<Outcome> {
    const streamKey = audioStreamKey(job.id);
    if (entry === undefined) {
      const state = await this.inheritedStreamState(streamKey, ctx);
      if (state !== 'complete') {
        // 入れ替わる前の worker が先送りした Stream が切れていた・中断された・終わらない。モバイルへは送ってあるので、
        // 送らずに合成し直して鳴らす
        routeLog('presynth.inherited-broken', { job: shortId(job.id), state });
        await this.op(this.command.del(streamKey)).catch(() => undefined);
        return this.playSynthJob(job, ctx, heldMs, { muted: false, route: undefined });
      }
    }
    if (entry?.run !== undefined) {
      // 先送りの合成がまだ番を待っていれば PC の番に上げ、番が来るまで待つ（最初の音の時計はその後から数える）
      this.synthesisGate.promote(job.id);
      const begun = await this.waitBounded(Promise.race([entry.run.started, entry.done]), ctx, NO_DEADLINE);
      if (begun === 'held') {
        return { status: 'held' };
      }
      if (typeof begun === 'string') {
        return { status: 'failed', reason: ctx.cancelReason ?? 'worker-stopped' };
      }
    }
    this.markVoice(job.id);
    const config = this.deps.loadConfig();
    const outcome = await this.playFromStream({
      job,
      ctx,
      streamKey,
      gainKey: this.synthGainKey(config, job.params),
      extraGainDb: job.volumeDb ?? 0,
      tagged: hasEmotionTags(job.params.text),
      prelude: job.prelude,
      handlingStartedAt: this.now(),
      heldMs,
    });
    routeLog('presynth.played', { job: shortId(job.id), status: outcome.status, reason: outcome.reason });
    if (entry !== undefined && outcome.status !== 'done' && outcome.status !== 'held' && !ctx.cancelled && (entry.writer?.bytes ?? 0) === 0) {
      // 先送りの合成が音を書かずに終わった（429 などの失敗・止めた）。PC の番で合成し直し、同じ ticket でモバイルへも送る。
      // 音が無いので ticket は Para Code へ届いていないはず。届いていても 1 回限りなので Para Code が 401 で断り、二重には届かない
      await settleWithin(entry.done, SYNTHESIS_SETTLE_MS);
      routeLog('presynth.resynthesize', { job: shortId(job.id), status: outcome.status, reason: outcome.reason });
      await this.op(this.command.del(streamKey)).catch(() => undefined);
      return this.playSynthJob(job, ctx, heldMs, { muted: false, route: this.voiceRouteFor(job) });
    }
    if (outcome.status !== 'done' && entry?.run?.failed === true) {
      return { status: 'failed', reason: 'synthesis-failed' };
    }
    return outcome;
  }

  /**
   * 入れ替わる前の worker が先送りした Stream の終わり方。最後の項目が終わりの印なら complete。まだ書いている途中なら
   * 少しだけ（{@link INHERITED_END_WAIT_MS}）待つ。中断の印・無い・待っても終わらないときはそれぞれ返す。
   */
  private async inheritedStreamState(streamKey: string, ctx: JobContext): Promise<'complete' | 'missing' | 'aborted' | 'unfinished'> {
    const deadline = this.now() + INHERITED_END_WAIT_MS;
    while (true) {
      const last = await this.op(this.command.xRevRange(streamKey, '+', '-', { COUNT: 1 })).catch(() => []);
      if (last.length === 0) {
        return 'missing';
      }
      const message = last[0].message as Record<string, string>;
      if (message.e !== undefined) {
        return 'complete';
      }
      if (message.a !== undefined || message.c !== undefined) {
        return 'aborted';
      }
      if (this.now() >= deadline || ctx.cancelled || !this.active) {
        return 'unfinished';
      }
      await delay(100);
    }
  }

  /**
   * 列で期限切れになった声（PC では鳴らさない）を、モバイルが聞いていれば合成して Para Code へ送る（Q309 A）。
   * PC の番を止めないよう裏で走らせる。モバイルが聞いているか分からない（古い Para Code）ときは今どおり送らない。
   */
  private forwardExpiredInBackground(job: SynthJob, route: VoiceRoute): void {
    if (route.expectLocalPlayback || mobileListening(route.fallback) !== true) {
      routeLog('expired.dropped', { job: shortId(job.id), reason: route.expectLocalPlayback ? 'local-ticket' : 'no-listeners' });
      return;
    }
    if (this.backgroundForwards.size >= EXPIRED_FORWARD_MAX_PENDING) {
      // 期限切れが続くほど混んでいる。古い声を裏で溜め続けない（使わなかった ticket は扱い終えたときに返す）
      routeLog('expired.dropped', { job: shortId(job.id), reason: 'backlog' });
      return;
    }
    const config = this.deps.loadConfig();
    if (synthesisSetupError(config, job.params) !== undefined) {
      return;
    }
    this.backgroundRoutes.add(route);
    const ctx: JobContext = { id: job.id, reported: true, cancelled: false, kills: new Set() };
    this.backgroundContexts.add(ctx);
    const task = (async () => {
      const tagged = hasEmotionTags(job.params.text);
      // ticket は番を待つ前に取る（番を握ったまま MCP サーバーの返事を待たない。ticket は 10 分使える）
      const target = await route.obtain();
      if (target === undefined || target.localPlayback === true || mobileListening(target) !== true) {
        routeLog('expired.dropped', { job: shortId(job.id), reason: target === undefined ? 'no-ticket' : 'no-listeners' });
        return;
      }
      route.used.add(target.ticket);
      const { forward, onStart } = this.gatedForward(() => target, { gainKey: this.synthGainKey(config, job.params), tagged });
      // 聞こえる順には入らない（PC では鳴らさない）ので、前の発話の文脈はつながない
      const synthesis = this.runSynthesis(config, job.params, ctx, undefined, forward, { jobId: job.id, prevVoiceId: () => undefined, priority: 'presynth', onStart });
      ctx.kills.add(synthesis.stop);
      // 1 発話の上限は番が来てから数える
      await Promise.race([synthesis.started, synthesis.done]);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([synthesis.done, new Promise<void>(resolve => { timer = setTimeout(resolve, MAX_UTTERANCE_MS); })]);
      clearTimeout(timer);
      if (!synthesis.completed) {
        synthesis.stop();
        forward.abort();
      }
      await settleWithin(synthesis.done, SYNTHESIS_SETTLE_MS);
      routeLog('expired.forwarded', { job: shortId(job.id), ok: synthesis.completed, listeners: target.mobileListeners });
    })().catch(error => {
      console.error('Expired forward error:', summarizeError(error));
    }).finally(() => {
      this.backgroundContexts.delete(ctx);
      this.backgroundRoutes.delete(route);
      this.releaseUnusedTickets(job.id, route);
    });
    this.backgroundForwards.add(task);
    void task.finally(() => this.backgroundForwards.delete(task));
  }

  /** 裏で送っている件（止めるときに取り消す） */
  private readonly backgroundContexts = new Set<JobContext>();
  /** 先送りの合成が走っているか（1 本ずつ） */
  private presynthRunning = false;
  private lastPresynthTouch = 0;

  /** 先送りの見回り。PC で鳴らしている間・hold の間だけ列を見る。 */
  private async runPresynthLoop(): Promise<void> {
    while (this.active) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.presynthWake = undefined;
          resolve();
        }, this.timings.presynthScanMs);
        this.presynthWake = () => {
          clearTimeout(timer);
          this.presynthWake = undefined;
          resolve();
        };
      });
      if (!this.active) {
        break;
      }
      try {
        await this.presynthScan();
      } catch (error) {
        this.log('presynth scan error', summarizeError(error));
      }
    }
  }

  private async presynthScan(): Promise<void> {
    const now = this.now();
    if (now - this.lastPresynthTouch >= PRESYNTH_TOUCH_MS) {
      // 持っている Stream と印の期限を延ばす（hold や長い列で待つ間に切れないように）
      this.lastPresynthTouch = now;
      for (const entry of this.presynths.values()) {
        if (entry.writer !== undefined && !entry.released) {
          void entry.writer.touch().catch(() => undefined);
          void this.op(this.command.expire(presynthKey(entry.jobId), PRESYNTH_MARKER_TTL_SECONDS)).catch(() => undefined);
        }
      }
    }
    // PC が手すきなら、列の先頭はすぐ PC の番で合成されてモバイルへも送られる（先送りは要らない）。
    // 2.5 の worker から引き取った直後は、古い worker も列から取り出すので先送りしない（印を知らずに合成し直す）
    if ((this.current === undefined && !this.held) || this.presynthRunning || this.migrationUntil !== undefined) {
      return;
    }
    let bytes = 0;
    for (const entry of this.presynths.values()) {
      bytes += entry.writer?.bytes ?? 0;
    }
    if (this.presynths.size >= PRESYNTH_MAX_ENTRIES || bytes >= PRESYNTH_MAX_BYTES) {
      return;
    }
    // 取り出す側の端（右端）から決まった数だけ読む（250ms ごとに列を全部読まない）
    const [high, normal] = await this.op(Promise.all([
      this.command.lRange(HIGH_QUEUE_KEY, -PRESYNTH_SCAN_WINDOW, -1),
      this.command.lRange(NORMAL_QUEUE_KEY, -PRESYNTH_SCAN_WINDOW, -1),
    ]));
    if (!this.active || this.presynthRunning) {
      return;
    }
    const jobs = jobsInDequeueOrder(high, normal);
    if (high.length < PRESYNTH_SCAN_WINDOW && normal.length < PRESYNTH_SCAN_WINDOW) {
      // 列を全部読めたときだけ、見えない件を片付ける（読んだ窓の外の件を消えたと取り違えない）
      this.dropOrphanedPresynths(new Set(jobs.map(queued => queued.id)));
    }
    let config: AppConfig | undefined;
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      if (job.type !== 'synth' || this.presynths.has(job.id) || this.presynthDeclined.has(job.id) || this.mainClaimed.has(job.id)) {
        continue;
      }
      if (!this.isPresynthCandidate(job, () => (config ??= this.deps.loadConfig()))) {
        continue;
      }
      // 1 回の見回りで 1 件。合成が終わったら次の件へ（合成は 1 本ずつ）
      this.startPresynth(job, prevVoiceBefore(jobs, index, this.currentVoiceId ?? this.lastVoiceId));
      return;
    }
  }

  /**
   * 先送りしてよい件か。この機械のエージェントの声で、積む時の ticket が「モバイルへ送るだけ」（手元で鳴らす SSH 先の
   * ticket ではない）で、Para Code がモバイルは聞いていると答えたもの。`wait_ms` 付きは今どおり順番が来てから。
   */
  private isPresynthCandidate(job: SynthJob, config: () => AppConfig): boolean {
    const params = job.params;
    if (job.source !== 'agent' || (typeof params.wait_ms === 'number' && params.wait_ms > 0)) {
      return false;
    }
    if (isVoiceRequester(params._voiceRequester) && params._voiceRequester.localPlayback) {
      return false;
    }
    const fallback = isParaCodeVoiceTarget(params._paraCodeVoiceTarget) ? params._paraCodeVoiceTarget : undefined;
    return fallback !== undefined && fallback.localPlayback !== true && mobileListening(fallback) === true
      && synthesisSetupError(config(), params) === undefined;
  }

  /** 先送りを始める（ticket を取り、Stream に書きながら Para Code へ送る）。登録はこの関数の中で await の前に済ませる。 */
  private startPresynth(job: SynthJob, prevVoiceId: string | undefined): void {
    let decided = false;
    let decide!: (value: 'presynth' | 'declined') => void;
    const entry: PresynthEntry = {
      jobId: job.id,
      decision: new Promise(resolve => { decide = resolve; }),
      done: Promise.resolve(),
      writer: undefined,
      run: undefined,
      released: false,
      connected: false,
    };
    this.presynths.set(job.id, entry);
    let decidedPresynth = false;
    const settle = (value: 'presynth' | 'declined', reason?: string) => {
      if (decided) {
        return;
      }
      decided = true;
      decidedPresynth = value === 'presynth';
      if (value === 'declined') {
        this.presynths.delete(job.id);
        this.presynthDeclined.add(job.id);
        if (this.presynthDeclined.size > 1024) {
          const oldest = this.presynthDeclined.values().next().value;
          if (oldest !== undefined) {
            this.presynthDeclined.delete(oldest);
          }
        }
        routeLog('presynth.skip', { job: shortId(job.id), reason });
      }
      decide(value);
    };
    this.presynthRunning = true;
    let ownsMarker = false;
    void (async () => {
      // 先送りの印を取る（ほかの worker が先送りした件・している件は触らない）。印はこの worker の ID
      const claimed = await this.op(this.command.set(presynthKey(job.id), this.workerId, { NX: true, EX: PRESYNTH_MARKER_TTL_SECONDS })).catch(() => undefined);
      if (claimed === undefined) {
        return settle('declined', 'redis-error');
      }
      if (claimed !== 'OK') {
        return settle('declined', 'claimed-elsewhere');
      }
      ownsMarker = true;
      const route = this.voiceRouteFor(job);
      const target = route === undefined ? undefined : await route.obtain();
      const reason = target === undefined ? 'no-ticket'
        : target.localPlayback === true ? 'local-ticket'
          // PC の番が今どおり送る（同じ ticket を使う）
          : mobileListening(target) !== true ? 'no-listeners'
            : !this.active ? 'stopping'
              : undefined;
      if (reason !== undefined || target === undefined) {
        return settle('declined', reason);
      }
      const writer = new AudioStreamWriter(this.command, job.id);
      try {
        // 前の worker が書きかけた Stream が残っていれば消してから書く（読み手は先頭から読む）
        await this.op(this.command.del(audioStreamKey(job.id)));
        await this.op(writer.open());
      } catch {
        writer.discard();
        await this.op(this.command.del(audioStreamKey(job.id))).catch(() => undefined);
        return settle('declined', 'redis-error');
      }
      const config = this.deps.loadConfig();
      const params = job.params;
      const ctx: JobContext = { id: job.id, reported: true, cancelled: false, kills: new Set() };
      const gated = this.gatedForward(() => target, { gainKey: this.synthGainKey(config, params), tagged: hasEmotionTags(params.text) });
      const inner = gated.forward;
      // 最初の断片を渡した時点で「送った」とみなす（Node の http.request は本文を書くまでヘッダーも送らないので、
      // 断片が無いまま終わった件の ticket は Para Code へ届いていない）
      const forward: ParaCodeForward = {
        push: chunk => {
          if (!entry.connected) {
            entry.connected = true;
            route!.used.add(target.ticket);
          }
          inner.push(chunk);
        },
        end: () => inner.end(),
        abort: () => inner.abort(),
        decision: inner.decision,
        outcome: inner.outcome,
        settled: inner.settled,
      };
      let stopRun: (() => void) | undefined;
      const onStart = () => {
        if (!this.active) {
          // worker が止まるところ。つないでモバイルへ送らない（次の worker が今どおり送る）
          forward.abort();
          stopRun?.();
        }
        gated.onStart();
      };
      const startedAt = this.now();
      // 文脈は番が来たときの列で決め直す（見回りの後に high の声が前に入ることがある）
      const prevVoiceAtTurn = async () => {
        try {
          const [high, normal] = await this.op(Promise.all([
            this.command.lRange(HIGH_QUEUE_KEY, -PRESYNTH_SCAN_WINDOW, -1),
            this.command.lRange(NORMAL_QUEUE_KEY, -PRESYNTH_SCAN_WINDOW, -1),
          ]));
          const jobs = jobsInDequeueOrder(high, normal);
          const index = jobs.findIndex(queued => queued.id === job.id);
          const prev = index < 0 ? undefined : prevVoiceBefore(jobs, index, this.currentVoiceId ?? this.lastVoiceId);
          return prev === prevVoiceId ? prev : undefined;
        } catch {
          return undefined;
        }
      };
      const run = this.runSynthesis(config, params, ctx, writer, forward, { jobId: job.id, prevVoiceId: prevVoiceAtTurn, priority: 'presynth', onStart });
      stopRun = run.stop;
      // 1 発話の上限（番を待つ間を含む）。止まった合成で先送りの枠を握り続けない
      entry.writer = writer;
      entry.run = run;
      entry.done = (async () => {
        // 1 発話の上限は番が来てから数える（番を待つ間で使い切らない）
        await Promise.race([run.started, run.done]);
        const limit = setTimeout(() => {
          run.stop();
          forward.abort();
        }, MAX_UTTERANCE_MS + SYNTH_EXTRA_LIMIT_MS);
        await run.done;
        clearTimeout(limit);
        await settleWithin(writer.settled(), SYNTHESIS_SETTLE_MS);
      })();
      routeLog('presynth.start', { job: shortId(job.id), listeners: target.mobileListeners });
      void entry.done.then(() => {
        routeLog('presynth.done', { job: shortId(job.id), ok: run.completed, bytes: writer.bytes, ms: this.now() - startedAt });
      });
      settle('presynth');
    })().catch(error => {
      this.log('presynth error', summarizeError(error));
      settle('declined', 'error');
    }).finally(() => {
      if (!decidedPresynth && ownsMarker) {
        // 見送った。印を外す（PC の番が今どおり合成して送る）
        void this.op(this.command.del(presynthKey(job.id))).catch(() => undefined);
      }
      void entry.done.finally(() => {
        this.presynthRunning = false;
        this.presynthWake?.();
      });
    });
  }

  /**
   * 列からも PC の番からも消えた先送りの件（ほかの worker が取り出した・古い版へ戻したなど）を片付ける。
   * 列へ戻す間に一瞬だけ見えないことがあるので、しばらく見えないままの件だけ。
   */
  private dropOrphanedPresynths(queued: ReadonlySet<string>): void {
    const now = this.now();
    for (const entry of [...this.presynths.values()]) {
      if (entry.released || queued.has(entry.jobId) || this.currentVoiceId === entry.jobId || this.mainClaimed.has(entry.jobId)) {
        entry.missingSince = undefined;
        continue;
      }
      entry.missingSince ??= now;
      if (now - entry.missingSince >= PRESYNTH_ORPHAN_MS) {
        routeLog('presynth.orphaned', { job: shortId(entry.jobId) });
        this.releasePresynth(entry);
        // ほかの worker が積む時の控えで送っているかもしれないので、ticket は返さずに忘れるだけ
        this.routes.delete(entry.jobId);
      }
    }
    // 先送りを見送った件の送り先も、この worker が扱わずに列から消えたら忘れる
    for (const jobId of [...this.routes.keys()]) {
      if (queued.has(jobId) || this.currentVoiceId === jobId || this.mainClaimed.has(jobId) || this.presynths.has(jobId) || this.backgroundRoutes.has(this.routes.get(jobId)!)) {
        this.routeMissingSince.delete(jobId);
        continue;
      }
      const since = this.routeMissingSince.get(jobId) ?? now;
      this.routeMissingSince.set(jobId, since);
      if (now - since >= PRESYNTH_ORPHAN_MS) {
        this.routes.delete(jobId);
        this.routeMissingSince.delete(jobId);
      }
    }
  }

  /** 送り先が列にも PC の番にも見えなくなった時刻 */
  private readonly routeMissingSince = new Map<string, number>();

  /** PC の側がこの件を扱い終えた。合成が終わってから Stream と印を消す。 */
  private releasePresynth(entry: PresynthEntry): void {
    entry.released = true;
    // 先送りするかを決めている途中なら、決まってから（合成を始めていればその終わりを）待つ
    void entry.decision.then(() => entry.done).finally(() => {
      if (this.presynths.get(entry.jobId) === entry) {
        this.presynths.delete(entry.jobId);
      }
      entry.writer?.discard();
      void this.op(this.command.del([audioStreamKey(entry.jobId), presynthKey(entry.jobId)])).catch(() => undefined);
    });
  }

  /**
   * 先送りの見回りを止める。`abort` なら走っている合成を止める（worker が止められた）。そうでなければ走っている合成が
   * 終わるのを待つ（次の worker が Stream から鳴らせるように）。裏の送り出しも同じ。
   */
  private async stopPresynth(abort: boolean): Promise<void> {
    this.presynthWake?.();
    if (abort) {
      for (const entry of this.presynths.values()) {
        entry.run?.stop();
        if (!entry.connected) {
          // まだ Para Code へ送っていない。印を外して、次の worker が今どおり合成してモバイルへも送れるようにする
          entry.writer?.discard();
          void this.op(this.command.del([audioStreamKey(entry.jobId), presynthKey(entry.jobId)]), 1_000).catch(() => undefined);
        }
      }
      for (const ctx of this.backgroundContexts) {
        this.cancel(ctx, 'worker-stopped');
      }
    }
    await settleWithin(this.presynthLoop ?? Promise.resolve(), 1_000);
    await settleWithin(Promise.allSettled([...[...this.presynths.values()].map(entry => entry.done), ...this.backgroundForwards]), abort ? SYNTHESIS_SETTLE_MS : MAX_UTTERANCE_MS);
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
    // 窓と最短秒数は発話ごとに読み直す（config.json を書き換えれば --reboot 無しで効く）
    const config = this.deps.loadConfig();
    const minLearnSeconds = config.gainMinLearnSeconds;
    const learnWindow = config.gainLearnWindow;
    if (!isLearnable({ tagged: request.tagged, durationSeconds: estimated, completed: true }, minLearnSeconds)) {
      return;
    }
    const gainKey = request.gainKey;
    const task = (async () => {
      const result = await measure(audio);
      if (result === undefined) {
        return;
      }
      if (!isLearnable({ tagged: request.tagged, durationSeconds: result.durationSeconds ?? estimated, completed: true, measuredLufs: result.integratedLufs }, minLearnSeconds)) {
        return;
      }
      const learned = await recordMeasurement(gainKey, result.integratedLufs, this.deps.gainFile, learnWindow);
      this.log('gain learned', { gainKey, lufs: result.integratedLufs, db: learned.db });
    })().catch(error => console.error('Gain learning error:', summarizeError(error)));
    this.pendingMeasurements.add(task);
    void task.finally(() => this.pendingMeasurements.delete(task));
  }
}

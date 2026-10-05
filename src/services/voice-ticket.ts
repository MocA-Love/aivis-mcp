/**
 * Para Code の ticket を、worker が鳴らし始める（転送を始める）時に取る（Q208 A）。
 *
 * ticket は 1 回限り・10 分で切れ、ペインごとに数の上限もある。列に積む時に取ると、hold や長い列の間に
 * 切れたり、上限に当たったりする。そこで、積む側の MCP サーバー（ペインごとに常駐する）が
 * `aivis-mcp:voice-ticket:req:<requester>` を購読して待ち、worker が鳴らし始めるときに頼む。
 * MCP サーバーはその場で Para Code から ticket を取り、`aivis-mcp:voice-ticket:res:<jobId>` に返す。
 *
 * - ペインのトークンは Redis に出さない。返すのは 1 回限りの ticket だけで、pub/sub なので Redis に残らない
 * - MCP サーバーは自分が積んだジョブの ID にだけ、1 回だけ答える
 * - 一回きりの `aivis` コマンドは常駐しないので、従来どおり積む時に ticket を取る
 * - MCP サーバーも積む時に 1 枚取ってジョブに控えとして載せる（MCP サーバーが先に終わっても鳴らせるように）。
 *   頼まれたときは、その控えがまだ 60 秒以上使えればそれを返し、新しく取らない（使われない ticket で
 *   ペインごとの上限を埋めないため）。返事が届かなかった新しい ticket は捨てずに次の依頼に回す
 * - 依頼の中身はジョブ ID だけで、誰でも publish できる。MCP サーバーは自分が積んだ ID にしか答えないので、
 *   偽の依頼で取れるのは、その ID のジョブのための ticket（1 回限り）だけ
 */

import type { RedisClientType } from 'redis';
import { VOICE_TICKET_REPLY_PREFIX, VOICE_TICKET_REQUEST_PREFIX } from '../queue/keys.js';
import { withTimeout } from '../queue/timeout.js';
import { captureParaCodeVoiceTarget, isParaCodeVoiceTarget, isRemoteParaCodePane, type InstanceIdCache, type ParaCodeVoiceTarget } from './para-code-voice.js';

/** worker が返事を待つ上限（手元のペイン）。 */
export const VOICE_TICKET_WAIT_MS = 1_500;
/** SSH 先のペイン。MCP サーバーが戻り経路越しに health と ticket を取る分（最大 3 秒）を見込む。 */
export const VOICE_TICKET_REMOTE_WAIT_MS = 3_500;
/** 控え・取り置きの ticket を使うのに残っていてほしい時間。 */
const TICKET_MIN_REMAINING_MS = 60_000;
/** MCP サーバーが終わるとき、答えている途中の依頼を待つ上限。 */
export const RESPONDER_CLOSE_GRACE_MS = 2_000;
/** 積んだジョブの ID を覚えておく時間（列で待てる最長＋ hold の分の余裕）。 */
const REMEMBER_MS = 30 * 60_000;
const REMEMBER_MAX = 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** ジョブに添える「ticket の頼み先」。 */
export interface VoiceRequester {
  /** 頼み先の MCP サーバーの ID */
  readonly id: string;
  /** SSH 先のペインで、Para Code が手元の PC で鳴らす前提か（取れなければ接続先では鳴らさない） */
  readonly localPlayback: boolean;
  /** SSH 先のペインか（返事を長めに待つ） */
  readonly remote?: boolean;
}

export function isVoiceRequester(value: unknown): value is VoiceRequester {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const requester = value as Partial<VoiceRequester>;
  return typeof requester.id === 'string' && ID_PATTERN.test(requester.id) && typeof requester.localPlayback === 'boolean'
    && (requester.remote === undefined || typeof requester.remote === 'boolean');
}

function usable(target: ParaCodeVoiceTarget | undefined, now: number): target is ParaCodeVoiceTarget {
  return target !== undefined && target.expiresAt - now >= TICKET_MIN_REMAINING_MS;
}

/**
 * MCP サーバー側。自分が積んだジョブについて worker から頼まれたら、その場で ticket を取って返す。
 */
export class VoiceTicketResponder {
  /** 積んだジョブの ID → 覚えておく期限と、積む時に取った控えの ticket */
  private readonly known = new Map<string, { until: number; fallback: ParaCodeVoiceTarget | undefined }>();
  private started = false;
  private closing = false;
  /** 最後に取れた ticket の localPlayback（Para Code の設定で手元で鳴らさないときは false） */
  private lastLocalPlayback: boolean | undefined;
  /** 返事が届かなかった（worker が待ちきれなかった）新しい ticket。次の依頼に回す */
  private spare: ParaCodeVoiceTarget | undefined;
  private readonly inflight = new Set<Promise<void>>();
  private readonly instanceCache: InstanceIdCache = {};
  private readonly capture: () => Promise<ParaCodeVoiceTarget | undefined>;

  constructor(
    private readonly subscriber: RedisClientType,
    private readonly publisher: RedisClientType,
    readonly id: string,
    capture?: () => Promise<ParaCodeVoiceTarget | undefined>,
    private readonly isRemotePane: () => boolean = () => isRemoteParaCodePane(),
  ) {
    this.capture = capture ?? (() => captureParaCodeVoiceTarget(process.env, this.instanceCache));
  }

  /** 購読を始める。失敗したら例外（呼び出し側は積む時に ticket を取る方へ戻る）。 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.subscriber.isOpen) {
      await withTimeout(this.subscriber.connect());
    }
    await withTimeout(this.subscriber.subscribe(VOICE_TICKET_REQUEST_PREFIX + this.id, message => {
      const task = this.onRequest(message).catch(() => undefined);
      this.inflight.add(task);
      void task.finally(() => this.inflight.delete(task));
    }));
    this.started = true;
  }

  get isStarted(): boolean {
    return this.started && !this.closing && this.subscriber.isOpen;
  }

  /** 積む時の控えの ticket を取る（取り置きがあればそれを使う）。 */
  async captureFallback(): Promise<ParaCodeVoiceTarget | undefined> {
    const now = Date.now();
    if (usable(this.spare, now)) {
      const spare = this.spare;
      this.spare = undefined;
      return spare;
    }
    const target = await this.capture().catch(() => undefined);
    if (target !== undefined) {
      this.lastLocalPlayback = target.localPlayback === true;
    }
    return target;
  }

  /** これから積むジョブを覚え、ジョブに添える頼み先を返す（積む前に呼ぶ）。 */
  register(jobId: string, fallback?: ParaCodeVoiceTarget): VoiceRequester {
    const now = Date.now();
    for (const [id, entry] of this.known) {
      if (entry.until < now) {
        this.known.delete(id);
      }
    }
    this.known.set(jobId, { until: now + REMEMBER_MS, fallback });
    if (this.known.size > REMEMBER_MAX) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) {
        this.known.delete(oldest);
      }
    }
    const remote = this.isRemotePane();
    const localPlayback = fallback !== undefined ? fallback.localPlayback === true : remote && this.lastLocalPlayback !== false;
    return { id: this.id, localPlayback, remote };
  }

  /** 答えている途中の依頼を最大 `graceMs` 待ってから購読をやめる（MCP サーバーが終わるとき）。 */
  async stop(graceMs = 0): Promise<void> {
    this.closing = true;
    if (graceMs > 0 && this.inflight.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise(resolve => { timer = setTimeout(resolve, graceMs); }),
      ]);
      clearTimeout(timer);
    }
    this.started = false;
    if (this.subscriber.isOpen) {
      await this.subscriber.disconnect().catch(() => undefined);
    }
  }

  private async onRequest(message: string): Promise<void> {
    let jobId: unknown;
    try {
      jobId = (JSON.parse(message) as { id?: unknown }).id;
    } catch {
      return;
    }
    // 自分が積んだジョブにだけ、1 回だけ答える
    if (typeof jobId !== 'string' || !ID_PATTERN.test(jobId)) {
      return;
    }
    const entry = this.known.get(jobId);
    if (entry === undefined) {
      return;
    }
    this.known.delete(jobId);
    const now = Date.now();
    if (entry.until < now) {
      return;
    }
    let target: ParaCodeVoiceTarget | undefined;
    let fresh = false;
    if (usable(entry.fallback, now)) {
      // 積む時に取った控えがまだ使える。新しく取らない
      target = entry.fallback;
    } else if (usable(this.spare, now)) {
      target = this.spare;
      this.spare = undefined;
      fresh = true;
    } else {
      target = await this.capture().catch(() => undefined);
      fresh = target !== undefined;
    }
    if (target !== undefined) {
      this.lastLocalPlayback = target.localPlayback === true;
    }
    const reply = JSON.stringify(target === undefined ? { none: true } : { target });
    const receivers = await withTimeout(this.publisher.publish(VOICE_TICKET_REPLY_PREFIX + jobId, reply)).catch(() => undefined);
    if (fresh && Number(receivers) === 0 && usable(target, Date.now())) {
      // worker は待ちきれなかった。使われていない ticket なので、次の依頼に回す
      this.spare = target;
    }
  }
}

/**
 * worker 側。鳴らし始めるときに、積んだ MCP サーバーへ ticket を頼む。返事が無い（MCP サーバーが
 * 終わっている・`waitMs` を過ぎた）・取れなかったときは undefined。
 */
export async function requestVoiceTicket(
  publisher: RedisClientType,
  subscriber: RedisClientType,
  requester: VoiceRequester,
  jobId: string,
  waitMs = VOICE_TICKET_WAIT_MS,
): Promise<ParaCodeVoiceTarget | undefined> {
  const channel = VOICE_TICKET_REPLY_PREFIX + jobId;
  let resolveReply!: (value: ParaCodeVoiceTarget | undefined) => void;
  const reply = new Promise<ParaCodeVoiceTarget | undefined>(resolve => { resolveReply = resolve; });
  const listener = (message: string) => {
    try {
      const parsed = JSON.parse(message) as { target?: unknown };
      resolveReply(isParaCodeVoiceTarget(parsed.target) ? parsed.target : undefined);
    } catch {
      resolveReply(undefined);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await withTimeout(subscriber.subscribe(channel, listener), waitMs);
    const receivers = await withTimeout(publisher.publish(VOICE_TICKET_REQUEST_PREFIX + requester.id, JSON.stringify({ id: jobId })), waitMs);
    if (Number(receivers) === 0) {
      // 頼み先が購読していない（MCP サーバーが終わっている）
      return undefined;
    }
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); });
    return await Promise.race([reply, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    await withTimeout(subscriber.unsubscribe(channel, listener), 1000).catch(() => undefined);
  }
}

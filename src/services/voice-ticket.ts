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
 */

import type { RedisClientType } from 'redis';
import { VOICE_TICKET_REPLY_PREFIX, VOICE_TICKET_REQUEST_PREFIX } from '../queue/keys.js';
import { withTimeout } from '../queue/timeout.js';
import { captureParaCodeVoiceTarget, isParaCodeVoiceTarget, isRemoteParaCodePane, type ParaCodeVoiceTarget } from './para-code-voice.js';

/** worker が返事を待つ上限。 */
export const VOICE_TICKET_WAIT_MS = 1_500;
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
}

export function isVoiceRequester(value: unknown): value is VoiceRequester {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const requester = value as Partial<VoiceRequester>;
  return typeof requester.id === 'string' && ID_PATTERN.test(requester.id) && typeof requester.localPlayback === 'boolean';
}

/**
 * MCP サーバー側。自分が積んだジョブについて worker から頼まれたら、その場で ticket を取って返す。
 */
export class VoiceTicketResponder {
  private readonly known = new Map<string, number>();
  private started = false;
  /** 最後に取れた ticket の localPlayback（Para Code の設定で手元で鳴らさないときは false） */
  private lastLocalPlayback: boolean | undefined;

  constructor(
    private readonly subscriber: RedisClientType,
    private readonly publisher: RedisClientType,
    readonly id: string,
    private readonly capture: () => Promise<ParaCodeVoiceTarget | undefined> = () => captureParaCodeVoiceTarget(),
    private readonly isRemotePane: () => boolean = () => isRemoteParaCodePane(),
  ) { }

  /** 購読を始める。失敗したら例外（呼び出し側は積む時に ticket を取る方へ戻る）。 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.subscriber.isOpen) {
      await withTimeout(this.subscriber.connect());
    }
    await withTimeout(this.subscriber.subscribe(VOICE_TICKET_REQUEST_PREFIX + this.id, message => {
      void this.onRequest(message);
    }));
    this.started = true;
  }

  get isStarted(): boolean {
    return this.started && this.subscriber.isOpen;
  }

  /** これから積むジョブを覚え、ジョブに添える頼み先を返す（積む前に呼ぶ）。 */
  register(jobId: string): VoiceRequester {
    const now = Date.now();
    for (const [id, until] of this.known) {
      if (until < now) {
        this.known.delete(id);
      }
    }
    this.known.set(jobId, now + REMEMBER_MS);
    if (this.known.size > REMEMBER_MAX) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) {
        this.known.delete(oldest);
      }
    }
    return { id: this.id, localPlayback: this.isRemotePane() && this.lastLocalPlayback !== false };
  }

  async stop(): Promise<void> {
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
    if (typeof jobId !== 'string' || !ID_PATTERN.test(jobId) || !this.known.has(jobId)) {
      return;
    }
    const until = this.known.get(jobId)!;
    this.known.delete(jobId);
    if (until < Date.now()) {
      return;
    }
    const target = await this.capture().catch(() => undefined);
    if (target !== undefined) {
      this.lastLocalPlayback = target.localPlayback === true;
    }
    const reply = JSON.stringify(target === undefined ? { none: true } : { target });
    await withTimeout(this.publisher.publish(VOICE_TICKET_REPLY_PREFIX + jobId, reply)).catch(() => undefined);
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

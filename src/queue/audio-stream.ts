/**
 * 音声を運ぶ Redis Stream `aivis-mcp:audio:<id>`（設計 3.1・3.6 N5）。
 *
 * 項目: `o` = 開いた印、`d` = MP3 の断片、`e` = 終わりの印、`a` = 中断の印（値は理由）。
 * MAXLEN は使わず、書く側がバイト数で上限を数える。
 */

import { commandOptions, type RedisClientType } from 'redis';
import { audioStreamKey } from './keys.js';

export const STREAM_TTL_SECONDS = 180;
/** 流れ 1 本の上限。 */
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** まとめて XADD する大きさと間隔。 */
export const FLUSH_BYTES = 8 * 1024;
export const FLUSH_INTERVAL_MS = 100;

export class AudioStreamWriter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private totalBytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private discarded = false;
  private failure: unknown;
  private queuedTasks = 0;

  readonly key: string;

  constructor(
    private readonly client: RedisClientType,
    readonly id: string,
    private readonly maxBytes = MAX_STREAM_BYTES,
  ) {
    this.key = audioStreamKey(id);
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isDiscarded(): boolean {
    return this.discarded;
  }

  /** まだ Redis へ書いていない書き込みの数（背圧の目安）。 */
  get backlog(): number {
    return this.queuedTasks;
  }

  /** Stream を作る（列から取り出した worker が「Stream が無い」と捨てないように、積む前に呼ぶ）。 */
  open(): Promise<void> {
    return this.enqueueAdd({ o: '1' });
  }

  /** 断片を足す。上限を超えたら false を返し、何も書かない（呼び出し側が abort する）。 */
  write(chunk: Buffer): boolean {
    if (this.closed || this.discarded) {
      return false;
    }
    if (this.totalBytes + chunk.length > this.maxBytes) {
      return false;
    }
    this.totalBytes += chunk.length;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= FLUSH_BYTES) {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
    return true;
  }

  end(): Promise<void> {
    return this.close({ e: '1' });
  }

  abort(reason = 'aborted'): Promise<void> {
    // 中断の前の断片は捨てる（鳴り始めていなければ worker も捨てる）
    if (!this.closed) {
      this.clearPending();
    }
    return this.close({ a: reason.slice(0, 64) || 'aborted' });
  }

  /**
   * 以後の書き込みをすべて捨てる（タイマーも止める）。worker が終わりの知らせを積んで Stream を消した後に、
   * 書きかけの断片がキーを作り直さないようにする。まだ Redis へ送っていない書き込みも捨てる。
   */
  discard(): void {
    this.discarded = true;
    this.closed = true;
    this.clearPending();
  }

  /** 列で待つ間・hold の間に期限を延ばす（EXPIRE はキーを作らない）。 */
  touch(): Promise<void> {
    if (this.discarded) {
      return this.chain;
    }
    return this.enqueue(async () => {
      await this.client.expire(this.key, STREAM_TTL_SECONDS);
    });
  }

  /** ここまでの書き込みが終わるのを待つ。 */
  async settled(): Promise<void> {
    await this.chain;
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  private clearPending(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
    this.pendingBytes = 0;
  }

  private close(marker: Record<string, string>): Promise<void> {
    if (this.closed) {
      return this.chain;
    }
    this.flush();
    this.closed = true;
    return this.enqueueAdd(marker);
  }

  private flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0 || this.discarded) {
      return;
    }
    const data = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    void this.enqueueAdd({ d: data });
  }

  /** XADD と EXPIRE を 1 回（MULTI）で送る。期限の無いキーを残さない。 */
  private enqueueAdd(message: Record<string, string | Buffer>): Promise<void> {
    return this.enqueue(async () => {
      await this.client.multi().xAdd(this.key, '*', message).expire(this.key, STREAM_TTL_SECONDS).exec();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queuedTasks++;
    this.chain = this.chain.then(async () => {
      try {
        if (!this.discarded) {
          await task();
        }
      } finally {
        this.queuedTasks--;
      }
    }).catch(error => {
      this.failure = error;
    });
    return this.chain;
  }
}

export type StreamEvent =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'end' }
  | { readonly kind: 'abort'; readonly reason: string };

/** Stream の項目を読む側の事件に直す（`o` は読み飛ばす）。 */
export function decodeStreamEntry(message: Record<string, Buffer | string>): StreamEvent | undefined {
  const field = (name: string): Buffer | undefined => {
    const value = message[name];
    if (value === undefined) {
      return undefined;
    }
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  };
  const data = field('d');
  if (data !== undefined) {
    return { kind: 'data', data };
  }
  if (field('e') !== undefined) {
    return { kind: 'end' };
  }
  const abort = field('a');
  if (abort !== undefined) {
    return { kind: 'abort', reason: abort.toString('utf8') || 'aborted' };
  }
  return undefined;
}

/**
 * Stream を頭から読む。XREAD BLOCK は BRPOP とは別の接続（`client`）で行う。
 */
export class AudioStreamReader {
  private lastId = '0';

  constructor(private readonly client: RedisClientType, readonly key: string) { }

  /** 最大 `blockMs` 待って、届いた事件を返す（無ければ空）。 */
  async read(blockMs: number): Promise<StreamEvent[]> {
    const result = await this.client.xRead(
      commandOptions({ returnBuffers: true }),
      [{ key: this.key, id: this.lastId }],
      { BLOCK: blockMs, COUNT: 256 },
    );
    if (!result) {
      return [];
    }
    const events: StreamEvent[] = [];
    for (const stream of result) {
      for (const entry of stream.messages) {
        this.lastId = Buffer.isBuffer(entry.id) ? entry.id.toString('utf8') : String(entry.id);
        const event = decodeStreamEntry(entry.message as unknown as Record<string, Buffer | string>);
        if (event !== undefined) {
          events.push(event);
        }
      }
    }
    return events;
  }
}

/**
 * 音声を運ぶ Redis Stream `aivis-mcp:audio:<id>`（設計 3.1・3.6 N5）。
 *
 * 項目: `o` = 開いた印、`d` = MP3 の断片、`e` = 終わりの印、`a` = 中断の印（値は理由）、
 * `c` = 鳴らすのをやめる印（値は理由。入力の終わりとは別に、`e` の後にも書ける）。
 * MAXLEN は使わず、書く側がバイト数で上限を数える。
 */

import { commandOptions, type RedisClientType } from 'redis';
import { audioStreamKey } from './keys.js';

export const STREAM_TTL_SECONDS = 180;
/** 流れ 1 本の上限。 */
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** 1 つの項目の上限（`--ingest` の枠の中身は 1 MiB まで。書く側はそれより小さくまとめる）。 */
export const MAX_STREAM_ENTRY_BYTES = 1024 * 1024 + 64 * 1024;
/** まとめて XADD する大きさと間隔。 */
export const FLUSH_BYTES = 8 * 1024;
export const FLUSH_INTERVAL_MS = 100;

export interface AudioStreamWriterHooks {
  /** Redis への書き込みが 1 件終わるたび（成功・失敗とも）に呼ぶ（背圧の解除に使う） */
  readonly onProgress?: () => void;
  /** 書き込みに失敗したら 1 回だけ呼ぶ（途中の断片が抜けた流れは鳴らさない） */
  readonly onError?: (error: unknown) => void;
}

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
  private queuedBytes = 0;

  readonly key: string;

  constructor(
    private readonly client: RedisClientType,
    readonly id: string,
    private readonly maxBytes = MAX_STREAM_BYTES,
    private readonly hooks: AudioStreamWriterHooks = {},
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

  /** まだ Redis へ書いていないバイト数（溜めている断片を含む）。 */
  get backlogBytes(): number {
    return this.queuedBytes + this.pendingBytes;
  }

  /** 書き込みに失敗したか。 */
  get failed(): boolean {
    return this.failure !== undefined;
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
   * 鳴らすのをやめる印を書く。入力を閉じた（end の）後でも書ける。worker は、まだ鳴らし始めていなければ
   * この印を見て捨てる（鳴らし始めていれば、届いた分を鳴らし切る）。
   */
  cancel(reason = 'aborted'): Promise<void> {
    if (this.discarded) {
      return this.chain;
    }
    if (!this.closed) {
      this.clearPending();
      this.closed = true;
    }
    return this.enqueueAdd({ c: reason.slice(0, 64) || 'aborted' });
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
    void this.enqueueAdd({ d: data }, data.length);
  }

  /** XADD と EXPIRE を 1 回（MULTI）で送る。期限の無いキーを残さない。 */
  private enqueueAdd(message: Record<string, string | Buffer>, bytes = 0): Promise<void> {
    return this.enqueue(async () => {
      await this.client.multi().xAdd(this.key, '*', message).expire(this.key, STREAM_TTL_SECONDS).exec();
    }, bytes);
  }

  private enqueue(task: () => Promise<void>, bytes = 0): Promise<void> {
    this.queuedTasks++;
    this.queuedBytes += bytes;
    this.chain = this.chain.then(async () => {
      try {
        if (!this.discarded) {
          await task();
        }
      } finally {
        this.queuedTasks--;
        this.queuedBytes -= bytes;
      }
    }).catch(error => {
      const first = this.failure === undefined;
      this.failure = error;
      if (first) {
        this.hooks.onError?.(error);
      }
    }).finally(() => {
      this.hooks.onProgress?.();
    });
    return this.chain;
  }
}

const CANCEL_IF_EXISTS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('XADD', KEYS[1], '*', 'c', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1`;

/**
 * 書く側（writer）がいない Stream（前の `--ingest` から引き継いだ件）に、鳴らすのをやめる印 `c` を直接書く。
 * Stream が無ければ作らない（worker が消した後にキーを作り直さない）。書けたら true。
 */
export async function cancelStreamById(client: RedisClientType, id: string, reason = 'aborted'): Promise<boolean> {
  const result = await client.eval(CANCEL_IF_EXISTS_SCRIPT, {
    keys: [audioStreamKey(id)],
    arguments: [reason.slice(0, 64) || 'aborted', String(STREAM_TTL_SECONDS)],
  });
  return Number(result) === 1;
}

export type StreamEvent =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'end' }
  | { readonly kind: 'abort'; readonly reason: string }
  | { readonly kind: 'cancel'; readonly reason: string };

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
    return { kind: 'abort', reason: reasonOf(abort) };
  }
  const cancel = field('c');
  if (cancel !== undefined) {
    return { kind: 'cancel', reason: reasonOf(cancel) };
  }
  return undefined;
}

/** 理由の文字列（Redis から来るので長さと文字を絞る）。 */
function reasonOf(value: Buffer): string {
  const text = value.subarray(0, 64).toString('utf8').replace(/[^A-Za-z0-9_.:-]/g, '');
  return text || 'aborted';
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

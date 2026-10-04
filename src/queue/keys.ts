/**
 * Redis のキー。2.4 以前と同じ Redis を共有するので、古い名前は変えない。
 */

/** 2.4 までの列。2.5 も読み続ける（古い CLI・MCP・`--play-audio` のジョブ）。 */
export const LEGACY_QUEUE_KEY = 'aivis-mcp:queue';
/** 2.5 の列（許可・質問などを先に読む）。2.4 の worker は読まない。 */
export const HIGH_QUEUE_KEY = 'aivis-mcp:q2:high';
/** 2.5 の列（ふつうの発話）。 */
export const NORMAL_QUEUE_KEY = 'aivis-mcp:q2:normal';
/** BRPOP で取り出す順（先に書いたキーが優先）。 */
export const DEQUEUE_ORDER = [HIGH_QUEUE_KEY, NORMAL_QUEUE_KEY, LEGACY_QUEUE_KEY] as const;

export const WORKER_LOCK_KEY = 'aivis-mcp:worker-lock';
/** 動いている worker の版（worker が lock と同じ寿命で書く）。 */
export const WORKER_VERSION_KEY = 'aivis-mcp:worker-version';
/** 再生の lock（2.4 と同じキー。版の違う worker 同士でも重ならないように）。 */
export const PLAY_LOCK_KEY = 'aivis-mcp:play-lock';

export const AUDIO_STREAM_PREFIX = 'aivis-mcp:audio:';
export const STATUS_PREFIX = 'aivis-mcp:status:';
export const HOLD_PREFIX = 'aivis-mcp:hold:';
/** hold を置いた・消したときの知らせ。 */
export const HOLD_CHANNEL = 'aivis-mcp:hold-events';
/** 終わった hold の区間（ジョブの期限から hold の時間を除くため）。 */
export const HOLD_LOG_KEY = 'aivis-mcp:hold-log';

export function audioStreamKey(id: string): string {
  return AUDIO_STREAM_PREFIX + id;
}

export function statusKey(id: string): string {
  return STATUS_PREFIX + id;
}

export function holdKey(owner: string): string {
  return HOLD_PREFIX + owner;
}

export function queueKeyFor(priority: 'high' | 'normal'): string {
  return priority === 'high' ? HIGH_QUEUE_KEY : NORMAL_QUEUE_KEY;
}

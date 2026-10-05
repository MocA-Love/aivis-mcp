/**
 * 進み具合の知らせ `aivis-mcp:status:<id>`（期限 300 秒）。
 * 積む側が queued、worker が dequeued（取り出した。内部用。取り出した worker の ID を持つ）→ playing →
 * done | skipped | held | muted | failed を積む。worker が列へ戻したときは requeued（内部用）を積む。
 */

import type { RedisClientType } from 'redis';
import { statusKey, takenKey } from './keys.js';

export const STATUS_TTL_SECONDS = 300;
/** 取り出した印（`aivis-mcp:taken:<id>`）を残す時間。知らせより長く残す。 */
export const TAKEN_TTL_SECONDS = 30 * 60;

export type JobStatus = 'queued' | 'dequeued' | 'requeued' | 'playing' | 'done' | 'skipped' | 'held' | 'muted' | 'failed';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['done', 'skipped', 'held', 'muted', 'failed']);

export interface StatusEntry {
  readonly status: JobStatus;
  readonly reason?: string;
  readonly at: number;
  /** dequeued・requeued を積んだ worker の ID */
  readonly worker?: string;
}

const STATUSES: ReadonlySet<string> = new Set(['queued', 'dequeued', 'requeued', 'playing', 'done', 'skipped', 'held', 'muted', 'failed']);

export function encodeStatus(entry: StatusEntry): string {
  return JSON.stringify({
    s: entry.status,
    ...(entry.reason === undefined ? {} : { r: entry.reason }),
    t: entry.at,
    ...(entry.worker === undefined ? {} : { w: entry.worker }),
  });
}

export function decodeStatus(raw: string): StatusEntry | undefined {
  try {
    const value = JSON.parse(raw) as { s?: unknown; r?: unknown; t?: unknown; w?: unknown };
    if (typeof value.s !== 'string' || !STATUSES.has(value.s)) {
      return undefined;
    }
    return {
      status: value.s as JobStatus,
      reason: typeof value.r === 'string' ? value.r : undefined,
      at: typeof value.t === 'number' ? value.t : 0,
      ...(typeof value.w === 'string' && value.w.length <= 64 ? { worker: value.w } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function pushStatus(client: RedisClientType, id: string, status: JobStatus, reason?: string, worker?: string): Promise<void> {
  const key = statusKey(id);
  // 期限の無いキーを残さないよう、積むのと期限を 1 回（MULTI）で送る
  const multi = client.multi()
    .rPush(key, encodeStatus({ status, reason, at: Date.now(), ...(worker === undefined ? {} : { worker }) }))
    .expire(key, STATUS_TTL_SECONDS);
  if (status === 'dequeued') {
    // 取り出した印は知らせより長く残す（知らせが切れた後の withdraw が「積まれていない」と答えないように）
    multi.set(takenKey(id), '1', { EX: TAKEN_TTL_SECONDS });
  }
  await multi.exec();
}

/** `from` 番目以降の知らせを読む。`next` は次に読み始める位置。 */
export async function readStatuses(client: RedisClientType, id: string, from: number): Promise<{ entries: StatusEntry[]; next: number }> {
  const raw = await client.lRange(statusKey(id), from, -1);
  return {
    entries: raw.map(decodeStatus).filter((entry): entry is StatusEntry => entry !== undefined),
    next: from + raw.length,
  };
}

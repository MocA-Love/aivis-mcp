/**
 * 進み具合の知らせ `aivis-mcp:status:<id>`（期限 300 秒）。
 * 積む側が queued、worker が dequeued（取り出した。内部用）→ playing → done | skipped | held | muted | failed を積む。
 */

import type { RedisClientType } from 'redis';
import { statusKey } from './keys.js';

export const STATUS_TTL_SECONDS = 300;

export type JobStatus = 'queued' | 'dequeued' | 'playing' | 'done' | 'skipped' | 'held' | 'muted' | 'failed';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['done', 'skipped', 'held', 'muted', 'failed']);

export interface StatusEntry {
  readonly status: JobStatus;
  readonly reason?: string;
  readonly at: number;
}

const STATUSES: ReadonlySet<string> = new Set(['queued', 'dequeued', 'playing', 'done', 'skipped', 'held', 'muted', 'failed']);

export function encodeStatus(entry: StatusEntry): string {
  return JSON.stringify(entry.reason === undefined ? { s: entry.status, t: entry.at } : { s: entry.status, r: entry.reason, t: entry.at });
}

export function decodeStatus(raw: string): StatusEntry | undefined {
  try {
    const value = JSON.parse(raw) as { s?: unknown; r?: unknown; t?: unknown };
    if (typeof value.s !== 'string' || !STATUSES.has(value.s)) {
      return undefined;
    }
    return {
      status: value.s as JobStatus,
      reason: typeof value.r === 'string' ? value.r : undefined,
      at: typeof value.t === 'number' ? value.t : 0,
    };
  } catch {
    return undefined;
  }
}

export async function pushStatus(client: RedisClientType, id: string, status: JobStatus, reason?: string): Promise<void> {
  const key = statusKey(id);
  await client.rPush(key, encodeStatus({ status, reason, at: Date.now() }));
  await client.expire(key, STATUS_TTL_SECONDS);
}

/** `from` 番目以降の知らせを読む。`next` は次に読み始める位置。 */
export async function readStatuses(client: RedisClientType, id: string, from: number): Promise<{ entries: StatusEntry[]; next: number }> {
  const raw = await client.lRange(statusKey(id), from, -1);
  return {
    entries: raw.map(decodeStatus).filter((entry): entry is StatusEntry => entry !== undefined),
    next: from + raw.length,
  };
}

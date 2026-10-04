/**
 * hold（音声入力中は鳴らさない、設計 3.1・3.6 N6）。
 * 持ち主ごとのキー `aivis-mcp:hold:<owner>`（期限 60 秒）が 1 つでもあれば止める。ミュートとは別のキー。
 */

import type { RedisClientType } from 'redis';
import { HOLD_CHANNEL, HOLD_LOG_KEY, HOLD_PREFIX, holdKey } from './keys.js';

export const HOLD_TTL_MS = 60_000;
/** worker が知らせを取りこぼしても、この間隔で確かめ直す。 */
export const HOLD_SCAN_INTERVAL_MS = 10_000;

const OWNER_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isValidHoldOwner(value: unknown): value is string {
  return typeof value === 'string' && OWNER_PATTERN.test(value);
}

/** hold を置く（延長も同じ）。 */
export async function setHold(client: RedisClientType, owner: string, ttlMs = HOLD_TTL_MS): Promise<void> {
  await client.set(holdKey(owner), String(Date.now()), { PX: ttlMs });
  await client.publish(HOLD_CHANNEL, `set:${owner}`);
}

export async function clearHold(client: RedisClientType, owner: string): Promise<void> {
  await client.del(holdKey(owner));
  await client.publish(HOLD_CHANNEL, `clear:${owner}`);
}

/** hold のキーが 1 つでもあるか（SCAN で探す）。 */
export async function anyHoldActive(client: RedisClientType): Promise<boolean> {
  for await (const key of client.scanIterator({ MATCH: `${HOLD_PREFIX}*`, COUNT: 100 })) {
    if (key) {
      return true;
    }
  }
  return false;
}

/** 終わった hold の区間を残す（ジョブの期限から hold の時間を除くため）。 */
export async function appendHoldInterval(client: RedisClientType, start: number, end: number): Promise<void> {
  if (end <= start) {
    return;
  }
  await client.rPush(HOLD_LOG_KEY, `${start}-${end}`);
  await client.lTrim(HOLD_LOG_KEY, -200, -1);
  await client.expire(HOLD_LOG_KEY, 2 * 60 * 60);
}

export function parseHoldIntervals(raw: readonly string[]): [number, number][] {
  const intervals: [number, number][] = [];
  for (const entry of raw) {
    const match = /^(\d+)-(\d+)$/.exec(entry);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      if (end > start) {
        intervals.push([start, end]);
      }
    }
  }
  return intervals;
}

export async function loadHoldIntervals(client: RedisClientType): Promise<[number, number][]> {
  return parseHoldIntervals(await client.lRange(HOLD_LOG_KEY, 0, -1));
}

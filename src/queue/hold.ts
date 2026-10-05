/**
 * hold（音声入力中は鳴らさない、設計 3.1・3.6 N6）。
 * 持ち主ごとのキー `aivis-mcp:hold:<owner>`（期限 60 秒）が 1 つでもあれば止める。ミュートとは別のキー。
 */

import type { RedisClientType } from 'redis';
import { HOLD_CHANNEL, HOLD_LOG_KEY, HOLD_PREFIX, HOLD_SINCE_KEY, holdKey } from './keys.js';

export const HOLD_TTL_MS = 60_000;
/** worker が知らせを取りこぼしても、この間隔で確かめ直す。 */
export const HOLD_SCAN_INTERVAL_MS = 10_000;

const OWNER_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isValidHoldOwner(value: unknown): value is string {
  return typeof value === 'string' && OWNER_PATTERN.test(value);
}

/** hold の始まりの記録を残す時間（これより長い hold は無いものとして消える）。 */
const HOLD_SINCE_TTL_SECONDS = 2 * 60 * 60;

/** hold を置く（延長も同じ）。続いている hold の始まりが無ければ、いまを始まりとして残す。 */
export async function setHold(client: RedisClientType, owner: string, ttlMs = HOLD_TTL_MS): Promise<void> {
  const now = String(Date.now());
  await client.multi()
    .set(holdKey(owner), now, { PX: ttlMs })
    .set(HOLD_SINCE_KEY, now, { NX: true, EX: HOLD_SINCE_TTL_SECONDS })
    .exec();
  await client.publish(HOLD_CHANNEL, `set:${owner}`);
}

/** hold を外す。ほかに hold が残っていなければ、続いていた区間を閉じる。 */
export async function clearHold(client: RedisClientType, owner: string): Promise<void> {
  await client.del(holdKey(owner));
  if (!(await anyHoldActive(client))) {
    await closeHoldInterval(client, Date.now());
  }
  await client.publish(HOLD_CHANNEL, `clear:${owner}`);
}

/** hold が掛かっているのに始まりの記録が無い（期限切れ・古い版が置いた）ときに、いまを始まりとして残す。 */
export async function markHoldStarted(client: RedisClientType, at: number): Promise<void> {
  await client.set(HOLD_SINCE_KEY, String(at), { NX: true, EX: HOLD_SINCE_TTL_SECONDS });
}

/** 続いている hold の始まり（無ければ undefined）。 */
export async function holdStartedAt(client: RedisClientType): Promise<number | undefined> {
  const value = await client.get(HOLD_SINCE_KEY);
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  return parseInt(value, 10);
}

const CLOSE_INTERVAL_SCRIPT = `
local since = redis.call('GET', KEYS[1])
if not since then return 0 end
redis.call('DEL', KEYS[1])
if tonumber(ARGV[1]) > tonumber(since) then
  redis.call('RPUSH', KEYS[2], since .. '-' .. ARGV[1])
  redis.call('LTRIM', KEYS[2], -200, -1)
  redis.call('EXPIRE', KEYS[2], 7200)
end
return 1`;

/**
 * 続いていた hold の区間を閉じて残す（始まりの記録を消して、区間を 1 回だけ足す）。
 * hold を外した側と worker のどちらが呼んでも、二重には足さない。
 */
export async function closeHoldInterval(client: RedisClientType, end: number): Promise<void> {
  await client.eval(CLOSE_INTERVAL_SCRIPT, { keys: [HOLD_SINCE_KEY, HOLD_LOG_KEY], arguments: [String(end)] });
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

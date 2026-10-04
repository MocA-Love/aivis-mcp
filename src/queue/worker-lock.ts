/**
 * worker の lock と再生の lock（設計 3.1 の lock の引き継ぎ・3.6 R2）。
 */

import type { RedisClientType } from 'redis';
import { PLAY_LOCK_KEY, WORKER_LOCK_KEY, WORKER_VERSION_KEY } from './keys.js';

export const WORKER_LOCK_TTL_MS = 20_000;
export const WORKER_HEARTBEAT_MS = 5_000;
/** 再生の lock の期限。worker が落ちても長く残らないよう短くし、鳴らしている間は延長し続ける。 */
export const PLAY_LOCK_TTL_MS = 10_000;
/** 鳴らしている間、再生の lock をこの間隔で延長する。 */
export const PLAY_LOCK_EXTEND_MS = 3_000;

/** `2.5.0` のような版を比べる（-beta などの後ろは無視）。a が古ければ負。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split('-')[0].split('.').map(part => {
    const parsed = parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 新しい worker を起こすべきか。lock が無い、または動いている worker の版が自分より古い
 * （版が分からないのは 2.4 より前）ときに起こす。起きた worker が lock を引き取る。
 */
export function shouldSpawnWorker(lockValue: string | null, workerVersion: string | null, myVersion: string): boolean {
  if (!lockValue) {
    return true;
  }
  return workerVersion === null || compareVersions(workerVersion, myVersion) < 0;
}

const ACQUIRE_SCRIPT = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[3]) then
  redis.call("SET", KEYS[2], ARGV[2], "PX", ARGV[3])
  return 1
end
return 0`;

const TAKEOVER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[4] then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[3])
  redis.call("SET", KEYS[2], ARGV[2], "PX", ARGV[3])
  return 1
end
return 0`;

const REFRESH_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[3])
  redis.call("SET", KEYS[2], ARGV[2], "PX", ARGV[3])
  return 1
end
return 0`;

const COMPARE_PEXPIRE_SCRIPT = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end';
const COMPARE_DELETE_SCRIPT = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

export type AcquireResult = 'acquired' | 'took-over' | 'busy';

/**
 * worker の lock を取る。空いていれば取り、古い版の worker が持っていれば値を自分の ID に
 * 書き換えて引き取る。古い worker は次の延長（5 秒以内）で失ったと気付いて止まる。
 */
export async function acquireWorkerLock(client: RedisClientType, workerId: string, version: string): Promise<AcquireResult> {
  const ttl = String(WORKER_LOCK_TTL_MS);
  const acquired = await client.eval(ACQUIRE_SCRIPT, { keys: [WORKER_LOCK_KEY, WORKER_VERSION_KEY], arguments: [workerId, version, ttl] });
  if (Number(acquired) === 1) {
    return 'acquired';
  }
  const [holder, holderVersion] = await Promise.all([client.get(WORKER_LOCK_KEY), client.get(WORKER_VERSION_KEY)]);
  if (holder === null) {
    // 取ろうとした間に空いた。もう一度だけ試す
    const retry = await client.eval(ACQUIRE_SCRIPT, { keys: [WORKER_LOCK_KEY, WORKER_VERSION_KEY], arguments: [workerId, version, ttl] });
    return Number(retry) === 1 ? 'acquired' : 'busy';
  }
  if (!shouldSpawnWorker(holder, holderVersion, version)) {
    return 'busy';
  }
  const tookOver = await client.eval(TAKEOVER_SCRIPT, { keys: [WORKER_LOCK_KEY, WORKER_VERSION_KEY], arguments: [workerId, version, ttl, holder] });
  return Number(tookOver) === 1 ? 'took-over' : 'busy';
}

/** lock を延長する。失っていたら false。 */
export async function refreshWorkerLock(client: RedisClientType, workerId: string, version: string): Promise<boolean> {
  const updated = await client.eval(REFRESH_SCRIPT, {
    keys: [WORKER_LOCK_KEY, WORKER_VERSION_KEY],
    arguments: [workerId, version, String(WORKER_LOCK_TTL_MS)],
  });
  return Number(updated) === 1;
}

export async function releaseWorkerLock(client: RedisClientType, workerId: string): Promise<void> {
  await client.eval(COMPARE_DELETE_SCRIPT, { keys: [WORKER_LOCK_KEY], arguments: [workerId] });
}

/** 再生の lock を取るまで待つ（2.4 の worker が鳴らしている間も重ならない）。 */
export async function acquirePlayLock(client: RedisClientType, owner: string, isCancelled: () => boolean = () => false): Promise<boolean> {
  while (!isCancelled()) {
    const acquired = await client.set(PLAY_LOCK_KEY, owner, { NX: true, PX: PLAY_LOCK_TTL_MS });
    if (acquired) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

export async function extendPlayLock(client: RedisClientType, owner: string): Promise<boolean> {
  const extended = await client.eval(COMPARE_PEXPIRE_SCRIPT, { keys: [PLAY_LOCK_KEY], arguments: [owner, String(PLAY_LOCK_TTL_MS)] });
  return Number(extended) === 1;
}

export async function releasePlayLock(client: RedisClientType, owner: string): Promise<void> {
  await client.eval(COMPARE_DELETE_SCRIPT, { keys: [PLAY_LOCK_KEY], arguments: [owner] });
}

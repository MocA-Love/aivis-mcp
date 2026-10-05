/**
 * 列に積む側。2.5 の列は LPUSH で積み、worker は BRPOP で取り出す（先入れ先出し）。
 */

import type { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { audioStreamKey, HIGH_QUEUE_KEY, LEGACY_QUEUE_KEY, MIGRATED_LEGACY_QUEUE_KEY, NORMAL_QUEUE_KEY, queueKeyFor, statusKey } from './keys.js';
import type { Job, JobPriority, SynthJob } from './jobs.js';
import { encodeStatus, STATUS_TTL_SECONDS } from './status.js';

/**
 * ジョブを積み、queued を知らせる。積むのと最初の知らせは 1 回（MULTI）で送るので、片方だけが残ることはない。
 * 積んだ文字列を返す（取り下げの LREM に使う）。
 *
 * 失敗したときは、積めたかどうかは分からない（送った後に応答だけが失われたかもしれない）。
 * 確かめるには `isJobRegistered` を使う。
 */
export async function enqueueJob(client: RedisClientType, job: Job): Promise<string> {
  const raw = JSON.stringify(job);
  const key = statusKey(job.id);
  await client.multi()
    .lPush(queueKeyFor(job.priority), raw)
    .rPush(key, encodeStatus({ status: 'queued', at: Date.now() }))
    .expire(key, STATUS_TTL_SECONDS)
    .exec();
  return raw;
}

/**
 * `enqueueJob` の結果を ID で確かめる。知らせのキーがあるか、列に積んだ文字列が残っていれば積めている。
 * 同じ接続の後ろに並ぶので、先に送った MULTI が実行された後の状態を読む。
 */
export async function isJobRegistered(client: RedisClientType, job: Pick<Job, 'id' | 'priority'>, raw: string): Promise<boolean> {
  const [exists, position] = await Promise.all([
    client.exists(statusKey(job.id)),
    client.lPos(queueKeyFor(job.priority), raw),
  ]);
  return exists === 1 || position !== null;
}

/** 列からまだ取り出されていないジョブを取り除く。取り除けたら true。 */
export async function withdrawJob(client: RedisClientType, priority: JobPriority, raw: string): Promise<boolean> {
  const removed = await client.lRem(queueKeyFor(priority), 1, raw);
  return removed === 1;
}

/**
 * ID でジョブを探して列から外し、外せたらその件の Stream と知らせも消す。ここまでを 1 つのスクリプトで行う
 * （worker が同時に取り出す・列へ戻すのと入れ違わない）。
 */
const WITHDRAW_BY_ID_SCRIPT = `
local needle = '"id":"' .. ARGV[1] .. '"'
for _, key in ipairs({KEYS[1], KEYS[2]}) do
  local items = redis.call('LRANGE', key, 0, -1)
  for _, raw in ipairs(items) do
    -- 大きな要素（2.4 の形の音声など）を毎回 JSON として読まないよう、ID の文字列で先に絞る
    if string.find(raw, needle, 1, true) then
      local ok, job = pcall(cjson.decode, raw)
      if ok and type(job) == 'table' and job['v'] == 2 and job['id'] == ARGV[1] then
        if redis.call('LREM', key, 1, raw) == 1 then
          redis.call('DEL', KEYS[3], KEYS[4])
          return 1
        end
      end
    end
  end
end
-- 列に無い。知らせ（status）も無ければ、積む要求は届いていない（Stream だけ残っていれば消す）
if redis.call('EXISTS', KEYS[4]) == 0 then
  redis.call('DEL', KEYS[3])
  return 2
end
-- 取り出し済み・鳴っている（または終わった）
return 3`;

/**
 * ID でジョブを探して列（q2:high・q2:normal）から外す。積んだのが別の `--ingest`（落ちた前の子など）でも外せる。
 * ID が一致する要素だけを LREM するので、ほかのジョブを巻き込まない。外せたらその件の Stream と知らせも消す。
 * worker が取り出していれば（列に無ければ）false。
 */
export async function withdrawJobById(client: RedisClientType, id: string): Promise<boolean> {
  return (await withdrawJobByIdDetailed(client, id)) === 'removed';
}

/**
 * `withdrawJobById` と同じ。外せなかったときの理由も返す（1 つのスクリプトで判定する）。
 * - removed: 列から外した（Stream と知らせも消した）
 * - not-queued: 列にも知らせにも痕跡が無い（積む要求が届いていない）。残っていた Stream は消した
 * - taken: 列に無く知らせはある（worker が取り出した・鳴っている・終わった）
 */
export type WithdrawResult = 'removed' | 'not-queued' | 'taken';

export async function withdrawJobByIdDetailed(client: RedisClientType, id: string): Promise<WithdrawResult> {
  const result = Number(await client.eval(WITHDRAW_BY_ID_SCRIPT, {
    keys: [HIGH_QUEUE_KEY, NORMAL_QUEUE_KEY, audioStreamKey(id), statusKey(id)],
    arguments: [id],
  }));
  return result === 1 ? 'removed' : result === 2 ? 'not-queued' : 'taken';
}

/** 2.5 の列（high・normal）から ID でジョブを探す。見つかれば積んだ文字列と中身を返す。 */
export async function findQueuedJob(client: RedisClientType, id: string): Promise<{ raw: string; priority: JobPriority; type: string } | undefined> {
  const needle = `"id":"${id}"`;
  for (const [key, priority] of [[HIGH_QUEUE_KEY, 'high'], [NORMAL_QUEUE_KEY, 'normal']] as const) {
    for (const raw of await client.lRange(key, 0, -1)) {
      if (!raw.includes(needle)) {
        continue;
      }
      try {
        const job = JSON.parse(raw) as { v?: unknown; id?: unknown; type?: unknown };
        if (job.v === 2 && job.id === id) {
          return { raw, priority, type: typeof job.type === 'string' ? job.type : 'stream' };
        }
      } catch {
        // 壊れた要素は飛ばす
      }
    }
  }
  return undefined;
}

/** この機械のエージェントの発話（worker が合成しながら鳴らす）を積む。`id` を渡すとその ID で積む。 */
export async function enqueueSynthesis(client: RedisClientType, params: Record<string, unknown>, priority: JobPriority = 'normal', id: string = uuidv4()): Promise<SynthJob> {
  const job: SynthJob = {
    v: 2,
    type: 'synth',
    id,
    priority,
    source: 'agent',
    enqueuedAt: Date.now(),
    params,
  };
  await enqueueJob(client, job);
  return job;
}

/**
 * 合成済みの MP3（`--play-audio`）を積む。2.5 の worker なら `q2:normal`、2.4 の worker なら古い列に積む
 * （2.4 の worker は 2.5 の列を読まない）。中身は 2.4 と同じ形（`_audioBase64`）。
 */
export async function enqueueAudio(client: RedisClientType, payload: Record<string, unknown>, target: 'q2' | 'legacy'): Promise<void> {
  await client.lPush(target === 'q2' ? NORMAL_QUEUE_KEY : LEGACY_QUEUE_KEY, JSON.stringify(payload));
}

/**
 * 2.4 までの列に積む。以前は RPUSH で積んで BRPOP で取り出していたので後入れ先出しになっていた。LPUSH に直す。
 */
export async function enqueueLegacy(client: RedisClientType, payload: Record<string, unknown>): Promise<void> {
  await enqueueAudio(client, payload, 'legacy');
}

const RESTORE_LEGACY_SCRIPT = `
local moved = 0
while true do
  local item = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
  if not item then break end
  moved = moved + 1
end
return moved`;

/**
 * `aivis-mcp:q2:legacy`（2.5.1 が 2.4 の worker から引き取ったときに移した古い列）を、古い列 `aivis-mcp:queue` へ
 * 順を保って戻す。2.5.0 以前へ戻したとき、古い worker はこの列を読まないので使う。戻した件数を返す。
 */
export async function restoreLegacyQueue(client: RedisClientType): Promise<number> {
  return Number(await client.eval(RESTORE_LEGACY_SCRIPT, { keys: [MIGRATED_LEGACY_QUEUE_KEY, LEGACY_QUEUE_KEY] }));
}

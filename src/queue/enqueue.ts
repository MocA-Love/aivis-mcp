/**
 * 列に積む側。2.5 の列は LPUSH で積み、worker は BRPOP で取り出す（先入れ先出し）。
 */

import type { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { AUDIO_STREAM_PREFIX, HIGH_QUEUE_KEY, LEGACY_QUEUE_KEY, NORMAL_QUEUE_KEY, queueKeyFor, STATUS_PREFIX, statusKey } from './keys.js';
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
for _, key in ipairs({KEYS[1], KEYS[2]}) do
  local items = redis.call('LRANGE', key, 0, -1)
  for _, raw in ipairs(items) do
    local ok, job = pcall(cjson.decode, raw)
    if ok and type(job) == 'table' and job['v'] == 2 and job['id'] == ARGV[1] then
      if redis.call('LREM', key, 1, raw) == 1 then
        redis.call('DEL', ARGV[2] .. ARGV[1], ARGV[3] .. ARGV[1])
        return 1
      end
    end
  end
end
return 0`;

/**
 * ID でジョブを探して列（q2:high・q2:normal）から外す。積んだのが別の `--ingest`（落ちた前の子など）でも外せる。
 * ID が一致する要素だけを LREM するので、ほかのジョブを巻き込まない。外せたらその件の Stream と知らせも消す。
 * worker が取り出していれば（列に無ければ）false。
 */
export async function withdrawJobById(client: RedisClientType, id: string): Promise<boolean> {
  const removed = await client.eval(WITHDRAW_BY_ID_SCRIPT, {
    keys: [HIGH_QUEUE_KEY, NORMAL_QUEUE_KEY],
    arguments: [id, AUDIO_STREAM_PREFIX, STATUS_PREFIX],
  });
  return Number(removed) === 1;
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

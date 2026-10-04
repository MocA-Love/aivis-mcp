/**
 * 列に積む側。2.5 の列は LPUSH で積み、worker は BRPOP で取り出す（先入れ先出し）。
 */

import type { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { HIGH_QUEUE_KEY, LEGACY_QUEUE_KEY, NORMAL_QUEUE_KEY, queueKeyFor } from './keys.js';
import type { Job, JobPriority, SynthJob } from './jobs.js';
import { pushStatus } from './status.js';

/** ジョブを積み、queued を知らせる。積んだ文字列を返す（取り下げの LREM に使う）。 */
export async function enqueueJob(client: RedisClientType, job: Job): Promise<string> {
  const raw = JSON.stringify(job);
  await client.lPush(queueKeyFor(job.priority), raw);
  await pushStatus(client, job.id, 'queued');
  return raw;
}

/** 列からまだ取り出されていないジョブを取り除く。取り除けたら true。 */
export async function withdrawJob(client: RedisClientType, priority: JobPriority, raw: string): Promise<boolean> {
  const removed = await client.lRem(queueKeyFor(priority), 1, raw);
  return removed === 1;
}

/**
 * ID でジョブを探して列（q2:high・q2:normal）から外す。積んだのが別の `--ingest`（落ちた前の子など）でも外せる。
 * 列を読んで ID が一致する要素だけを、その文字列そのままで LREM するので、ほかのジョブを巻き込まない。
 * worker が同時に取り出していれば LREM は 0 になり、外せなかった（false）とする。
 */
export async function withdrawJobById(client: RedisClientType, id: string): Promise<boolean> {
  for (const key of [HIGH_QUEUE_KEY, NORMAL_QUEUE_KEY]) {
    const items = await client.lRange(key, 0, -1);
    for (const raw of items) {
      let jobId: unknown;
      try {
        const parsed = JSON.parse(raw) as { v?: unknown; id?: unknown };
        jobId = parsed.v === 2 ? parsed.id : undefined;
      } catch {
        continue;
      }
      if (jobId === id && await client.lRem(key, 1, raw) === 1) {
        return true;
      }
    }
  }
  return false;
}

/** この機械のエージェントの発話（worker が合成しながら鳴らす）を積む。 */
export async function enqueueSynthesis(client: RedisClientType, params: Record<string, unknown>, priority: JobPriority = 'normal'): Promise<SynthJob> {
  const job: SynthJob = {
    v: 2,
    type: 'synth',
    id: uuidv4(),
    priority,
    source: 'agent',
    enqueuedAt: Date.now(),
    params,
  };
  await enqueueJob(client, job);
  return job;
}

/**
 * 2.4 までの列に積む（`--play-audio`）。以前は RPUSH で積んで BRPOP で取り出していたので
 * 後入れ先出しになっていた。LPUSH に直す。
 */
export async function enqueueLegacy(client: RedisClientType, payload: Record<string, unknown>): Promise<void> {
  await client.lPush(LEGACY_QUEUE_KEY, JSON.stringify(payload));
}

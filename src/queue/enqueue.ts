/**
 * 列に積む側。2.5 の列は LPUSH で積み、worker は BRPOP で取り出す（先入れ先出し）。
 */

import type { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { LEGACY_QUEUE_KEY, queueKeyFor } from './keys.js';
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

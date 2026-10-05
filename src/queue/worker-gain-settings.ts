/**
 * worker が実際に使っている音量の覚え直し方（窓と最短秒数）を Redis に置く。
 * 環境変数は worker を起こしたプロセスのものが効くので、`tts-get-settings` はこちらを優先して見せる。
 */

import type { RedisClientType } from 'redis';
import type { GainLearningSettings } from '../audio/gain-table.js';
import { WORKER_GAIN_SETTINGS_KEY } from './keys.js';
import { WORKER_LOCK_TTL_MS } from './worker-lock.js';

export interface WorkerGainSettings extends GainLearningSettings {
  /** 書いた worker の版 */
  readonly version: string;
}

/** worker の lock と同じ寿命で書く（lock を延ばすたびに書き直す）。 */
export async function publishWorkerGainSettings(client: RedisClientType, settings: WorkerGainSettings): Promise<void> {
  await client.set(WORKER_GAIN_SETTINGS_KEY, JSON.stringify(settings), { PX: WORKER_LOCK_TTL_MS });
}

/** 動いている worker の値。worker がいない・形が違うときは undefined。 */
export async function readWorkerGainSettings(client: RedisClientType): Promise<WorkerGainSettings | undefined> {
  const raw = await client.get(WORKER_GAIN_SETTINGS_KEY);
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkerGainSettings>;
    if (typeof parsed.learnWindow === 'number' && Number.isFinite(parsed.learnWindow)
      && typeof parsed.minLearnSeconds === 'number' && Number.isFinite(parsed.minLearnSeconds)
      && typeof parsed.version === 'string') {
      return { learnWindow: parsed.learnWindow, minLearnSeconds: parsed.minLearnSeconds, version: parsed.version };
    }
  } catch {
    // 壊れた値は無視する
  }
  return undefined;
}

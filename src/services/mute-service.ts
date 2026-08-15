import type { RedisClientType } from 'redis';

/**
 * ミュート状態を保持するRedisキー。
 * 値は解除予定のepoch ms文字列、または無期限を表す 'forever'。
 * キーが存在しなければミュートされていない。
 */
export const MUTE_KEY = 'aivis-mcp:muted';

const FOREVER = 'forever';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

export interface MuteStatus {
  muted: boolean;
  until: number | undefined;
}

/**
 * "30m" / "1h" / "90s" / "5000ms" のような相対時間文字列をミリ秒へ変換する。
 * パースできなければ undefined。
 */
export function parseMuteDuration(raw: string): number | undefined {
  const matched = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/i.exec(raw);
  if (!matched) return undefined;
  const value = parseFloat(matched[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = UNIT_MS[matched[2].toLowerCase()];
  const ms = Math.round(value * unit);
  if (ms <= 0) return undefined;
  return ms;
}

/**
 * ミュートを設定する。durationMs があればTTLで自動失効、無ければ無期限。
 */
export async function setMute(
  client: RedisClientType,
  durationMs: number | undefined
): Promise<{ until: number | undefined }> {
  if (durationMs === undefined) {
    await client.set(MUTE_KEY, FOREVER);
    return { until: undefined };
  }
  const until = Date.now() + durationMs;
  await client.set(MUTE_KEY, String(until), { PX: durationMs });
  return { until };
}

export async function clearMute(client: RedisClientType): Promise<void> {
  await client.del(MUTE_KEY);
}

export async function getMuteStatus(client: RedisClientType): Promise<MuteStatus> {
  const value = await client.get(MUTE_KEY);
  if (value === null || value === undefined) {
    return { muted: false, until: undefined };
  }
  if (value === FOREVER) {
    return { muted: true, until: undefined };
  }
  const until = parseInt(value, 10);
  return { muted: true, until: Number.isFinite(until) ? until : undefined };
}

/**
 * Worker側のホットパスから呼ぶ軽量版
 */
export async function isMuted(client: RedisClientType): Promise<boolean> {
  const status = await getMuteStatus(client);
  return status.muted;
}

/**
 * 声の行き先の判断を 1 行ずつファイルへ残す（Para Code の ticket・モバイルへの先送り・期限切れ・取り下げ）。
 *
 * worker は標準エラーを捨てる子として起きるので、判断の跡をファイルに置かないと後から追えない。
 * 音声の本文・ticket・ペインのトークンは書かない（呼び出し側が渡すのは ID の頭と数と理由だけ）。
 * 1 MiB を超えたら `.1` へ回し、2 つまでしか持たない。書けなくても発話は止めない。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** 1 つのファイルの上限。 */
export const ROUTE_LOG_MAX_BYTES = 1024 * 1024;

export type RouteLogValue = string | number | boolean | undefined;

/** 書き先。`AIVIS_ROUTE_LOG_FILE` が `off` なら書かない。 */
export function routeLogFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.AIVIS_ROUTE_LOG_FILE;
  if (configured === 'off') {
    return undefined;
  }
  return configured || path.join(os.homedir(), '.config', 'aivis-mcp', 'logs', 'voice-route.log');
}

/** 値は ID・数・短い理由だけ。ほかの文字は `_` に置き換え、64 文字で切る。 */
function sanitize(value: string | number | boolean): string {
  return String(value).replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 64);
}

/** ジョブの ID の頭 8 文字（行を追うのに足りる長さ）。 */
export function shortId(id: string | undefined): string | undefined {
  return id === undefined ? undefined : id.slice(0, 8);
}

/** 判断を 1 行残す（例: `2026-10-09T03:15:00.000Z 12345 presynth.start job=1a2b3c4d listeners=1`）。 */
export function routeLog(event: string, fields: Record<string, RouteLogValue> = {}, file = routeLogFile()): void {
  if (file === undefined) {
    return;
  }
  const parts = [new Date().toISOString(), String(process.pid), sanitize(event)];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      parts.push(`${sanitize(key)}=${sanitize(value)}`);
    }
  }
  const line = parts.join(' ') + '\n';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size + line.length > ROUTE_LOG_MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // まだ無い
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // 書けなくても発話は続ける
  }
}

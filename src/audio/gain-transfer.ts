/**
 * 音量の表の書き出し・読み込み（別の PC で覚えた値を持ち込む）。形式は gain.json と同じ `{version, target, entries}`。
 */

import fs from 'fs';
import path from 'path';
import {
  clampTableDb, gainFilePath, loadLearnedGains, MAX_LEARN_WINDOW, pruneLearnedGains, saveLearnedGains, TARGET_LUFS, withGainFileLock, writeFileAtomic,
  type GainFile, type LearnedGain,
} from './gain-table.js';

export interface GainExportFilter {
  /** 声（鍵の真ん中。Aivis はモデル UUID）。どれかに一致する行だけ。空なら絞らない */
  readonly voices?: readonly string[];
  /** モデル（鍵の最後。Aivis は `default`）。一致する行だけ */
  readonly model?: string;
}

function keyParts(key: string): { voice: string; model: string } | undefined {
  const first = key.indexOf(':');
  const last = key.lastIndexOf(':');
  if (first <= 0 || last <= first || last === key.length - 1) {
    return undefined;
  }
  return { voice: key.slice(first + 1, last), model: key.slice(last + 1) };
}

/** 表から絞り込んだ行を、gain.json と同じ形にする。 */
export function selectGainEntries(entries: Readonly<Record<string, LearnedGain>>, filter: GainExportFilter = {}): GainFile {
  const voices = filter.voices !== undefined && filter.voices.length > 0 ? new Set(filter.voices) : undefined;
  const selected: Record<string, LearnedGain> = {};
  for (const key of Object.keys(entries).sort()) {
    const parts = keyParts(key);
    if (parts === undefined) {
      continue;
    }
    if (voices !== undefined && !voices.has(parts.voice)) {
      continue;
    }
    if (filter.model !== undefined && parts.model !== filter.model) {
      continue;
    }
    selected[key] = entries[key];
  }
  return { version: 1, target: TARGET_LUFS, entries: selected };
}

/** 実体のパス（シンボリックリンクをたどる。まだ無いファイルは親フォルダをたどって名前を足す）。 */
function canonicalPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** 表を書き出す。書き出した行数を返す。書き出し先が自分の表そのものなら拒む（絞り込んだ行で上書きして消さない）。 */
export function exportGains(outputPath: string, filter: GainExportFilter = {}, gainFile = gainFilePath()): number {
  if (canonicalPath(outputPath) === canonicalPath(gainFile)) {
    throw new GainImportError(`書き出し先が音量の表そのもの（${gainFile}）です。別のファイルを指定してください`);
  }
  const body = selectGainEntries(loadLearnedGains(gainFile), filter);
  writeFileAtomic(outputPath, JSON.stringify(body, null, 2) + '\n', 0o644);
  return Object.keys(body.entries).length;
}

/** 読み込むファイルが壊れている・形が違う・target が違うときに投げる。 */
export class GainImportError extends Error {}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 読み込むファイルを厳しく検査する。1 行でもおかしければ全体を拒む（半端に取り込まない）。
 * target が自分と違うファイルも拒む（揃える大きさが違う値は、そのまま混ぜられない）。
 */
export function parseGainFile(text: string): Record<string, LearnedGain> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GainImportError(`JSON として読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GainImportError('音量の表の形ではありません（{version, target, entries} を期待）');
  }
  const file = parsed as Partial<Record<keyof GainFile, unknown>>;
  if (file.version !== 1) {
    throw new GainImportError(`知らない version です: ${String(file.version)}`);
  }
  if (!isFiniteNumber(file.target)) {
    throw new GainImportError('target がありません');
  }
  if (file.target !== TARGET_LUFS) {
    throw new GainImportError(`target が違います（ファイル ${file.target} LUFS、この版 ${TARGET_LUFS} LUFS）。取り込みません`);
  }
  if (typeof file.entries !== 'object' || file.entries === null || Array.isArray(file.entries)) {
    throw new GainImportError('entries がありません');
  }
  const result: Record<string, LearnedGain> = Object.create(null);
  for (const [key, value] of Object.entries(file.entries as Record<string, unknown>)) {
    if (key.length > 300 || key === '__proto__' || keyParts(key) === undefined) {
      throw new GainImportError(`鍵の形が違います: ${key.slice(0, 80)}`);
    }
    if (typeof value !== 'object' || value === null) {
      throw new GainImportError(`${key} の値が違います`);
    }
    const entry = value as Partial<Record<keyof LearnedGain, unknown>>;
    if (!isFiniteNumber(entry.db) || !Array.isArray(entry.samples) || !entry.samples.every(isFiniteNumber)) {
      throw new GainImportError(`${key} の db / samples が違います`);
    }
    if (entry.updatedAt !== undefined && !isFiniteNumber(entry.updatedAt)) {
      throw new GainImportError(`${key} の updatedAt が違います`);
    }
    result[key] = {
      db: clampTableDb(entry.db),
      samples: (entry.samples as number[]).map(clampTableDb).slice(-MAX_LEARN_WINDOW),
      ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
    };
  }
  return result;
}

export interface GainImportResult {
  /** 新しく足した行（表の上限で落ちたものを除く） */
  readonly added: number;
  /** 受け取った値で上書きした行（表の上限で落ちたものを除く） */
  readonly overwritten: number;
  /** 自分の表にあったので残した行 */
  readonly kept: number;
  /** 取り込んだが、表の上限（200 行）を超えたので入らなかった行 */
  readonly dropped: number;
  /** 取り込んだ行に押し出されて、表から消えた自分の行 */
  readonly evicted: number;
}

/**
 * 読み込んだ行を自分の表に足し、上限で刈り込む。`overwrite` が無ければ自分の表にある行は自分の値を残す。
 * 取り込んだ行は更新時刻を `now` にする（刈り込みで、取り込んだばかりの行から消えないように）。
 * 件数は刈り込んだ後に残った鍵で数え直す。
 */
export function mergeGainEntries(
  current: Readonly<Record<string, LearnedGain>>,
  incoming: Readonly<Record<string, LearnedGain>>,
  overwrite: boolean,
  now = Date.now(),
): { entries: Record<string, LearnedGain>; result: GainImportResult } {
  const merged: Record<string, LearnedGain> = Object.assign(Object.create(null), current);
  const addedKeys: string[] = [];
  const overwrittenKeys: string[] = [];
  let kept = 0;
  for (const [key, entry] of Object.entries(incoming)) {
    const exists = Object.prototype.hasOwnProperty.call(current, key);
    if (exists && !overwrite) {
      kept++;
      continue;
    }
    merged[key] = { ...entry, updatedAt: now };
    (exists ? overwrittenKeys : addedKeys).push(key);
  }
  const entries = pruneLearnedGains(merged);
  const remains = (key: string) => Object.prototype.hasOwnProperty.call(entries, key);
  const added = addedKeys.filter(remains).length;
  const overwritten = overwrittenKeys.filter(remains).length;
  const touched = new Set([...addedKeys, ...overwrittenKeys]);
  const evicted = Object.keys(current).filter(key => !touched.has(key) && !remains(key)).length;
  return {
    entries,
    result: { added, overwritten, kept, dropped: addedKeys.length + overwrittenKeys.length - added - overwritten, evicted },
  };
}

/** ファイルを読み込んで自分の表に足し、表のロックを持ったまま原子的に書き戻す。 */
export async function importGains(inputPath: string, overwrite: boolean, gainFile = gainFilePath()): Promise<GainImportResult> {
  let text: string;
  try {
    text = fs.readFileSync(inputPath, 'utf8');
  } catch (error) {
    throw new GainImportError(`読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
  const incoming = parseGainFile(text);
  return withGainFileLock(gainFile, () => {
    const merged = mergeGainEntries(loadLearnedGains(gainFile), incoming, overwrite);
    saveLearnedGains(merged.entries, gainFile);
    return merged.result;
  });
}

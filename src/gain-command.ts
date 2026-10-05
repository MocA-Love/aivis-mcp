/**
 * 音量の表を Para Code などから読む・直す口。
 *
 * - `--list-gains [--json]`: 表を出す。`--json` なら標準出力に JSON を 1 つだけ出す
 * - `--reset-gain --key <key>`: その行の測定を捨てる（行ごと消して最初の値・既定の解決に戻す）
 * - `--set-gain-learning [--window N] [--min-seconds S]`: config.json の `gain.learnWindow` / `gain.minLearnSeconds` を書く
 *
 * `--reset-gain` / `--set-gain-learning` の出力は `--set-dictionary` と同じ（成功は `ok`、失敗は `error: <理由>` と終了コード 1）。
 * Redis・API は使わない。
 */

import fs from 'fs';
import type { ArgValue } from './config.js';
import {
  buildGainTable, gainFilePath, loadLearnedGains, MAX_LEARN_WINDOW, MIN_LEARN_SECONDS_LOWER, MIN_LEARN_SECONDS_UPPER,
  MIN_LEARN_WINDOW, resolveGainLearningSettings, saveLearnedGains, splitKey, TARGET_LUFS, withGainFileLock,
  type GainLearningSettings, type LearnedGain,
} from './audio/gain-table.js';
import { loadSettings, modifySettings, type UserSettings } from './settings.js';

export class GainCommandError extends Error {}

/** `--list-gains --json` の 1 行 */
export interface GainListEntry {
  readonly key: string;
  readonly provider: string;
  readonly voice: string;
  readonly model: string;
  /** 今使っている値（学習済みなら直近の測定の中央値、未学習なら最初の値） */
  readonly gainDb: number;
  /** 保存している測定の数（窓に入る数ではない。最初の値だけの行は 0） */
  readonly sampleCount: number;
  /** 最後に覚え直した時刻（epoch ms）。最初の値だけの行・時刻の無い行は null */
  readonly updatedAt: number | null;
}

/** `--list-gains --json` の出力 */
export interface GainList {
  readonly version: 1;
  readonly target: number;
  readonly learnWindow: number;
  readonly minLearnSeconds: number;
  readonly entries: readonly GainListEntry[];
}

/**
 * 表を一覧にする。学習済みの行と最初の値の行を合わせ（音量の解決と同じ）、鍵の順に並べる。
 * 表に無い組（同じ provider・モデルの平均や 0dB で鳴らすもの）は行が無いので出さない。
 */
export function listGains(learned: Readonly<Record<string, LearnedGain>>, learning: GainLearningSettings): GainList {
  const table = buildGainTable(learned);
  const entries: GainListEntry[] = [];
  for (const key of Object.keys(table).sort()) {
    const parts = splitKey(key);
    if (parts === undefined) {
      continue;
    }
    const entry = Object.prototype.hasOwnProperty.call(learned, key) ? learned[key] : undefined;
    entries.push({
      key,
      provider: parts.provider,
      voice: parts.voice,
      model: parts.model,
      gainDb: table[key],
      sampleCount: entry?.samples.length ?? 0,
      updatedAt: entry?.updatedAt ?? null,
    });
  }
  return { version: 1, target: TARGET_LUFS, learnWindow: learning.learnWindow, minLearnSeconds: learning.minLearnSeconds, entries };
}

/** 今の覚え直し方（環境変数 > config.json > 既定。worker と同じ解決。config.json は書かない） */
function currentLearningSettings(): GainLearningSettings {
  const settings = loadSettings();
  return resolveGainLearningSettings({
    learnWindow: [
      { source: 'AIVIS_GAIN_LEARN_WINDOW', value: process.env.AIVIS_GAIN_LEARN_WINDOW },
      { source: 'config.json', value: settings.gain?.learnWindow },
    ],
    minLearnSeconds: [
      { source: 'AIVIS_GAIN_MIN_LEARN_SECONDS', value: process.env.AIVIS_GAIN_MIN_LEARN_SECONDS },
      { source: 'config.json', value: settings.gain?.minLearnSeconds },
    ],
  });
}

function printGainList(list: GainList): void {
  console.log(`音量の表（目標 ${list.target} LUFS、窓 ${list.learnWindow} 回、${list.minLearnSeconds} 秒未満は覚え直しに使わない）: ${gainFilePath()}`);
  for (const entry of list.entries) {
    const progress = entry.sampleCount === 0 ? '最初の値' : `測定 ${entry.sampleCount}/${list.learnWindow}`;
    console.log(`  ${entry.key}  ${entry.gainDb.toFixed(1)} dB  （${progress}）`);
  }
}

const GAIN_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;

/**
 * 表の 1 行を消す。表のロックを持ったまま読み書きする。行が無ければ書かずに false を返す。
 * 表のファイルが壊れていたら書かずに投げる（ほかの行を消さないため）。
 */
export async function resetGain(key: string, filePath = gainFilePath()): Promise<boolean> {
  if (!GAIN_KEY_PATTERN.test(key) || splitKey(key) === undefined) {
    throw new GainCommandError(`音量の表の鍵の形ではありません（provider:voice:model）: ${key.slice(0, 80)}`);
  }
  return withGainFileLock(filePath, () => {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw new GainCommandError(`音量の表を読めないので書きません: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
    } catch {
      throw new GainCommandError('音量の表が JSON として読めないので書きません（直すか消してからやり直してください）');
    }
    const entries = loadLearnedGains(filePath);
    if (!Object.prototype.hasOwnProperty.call(entries, key)) {
      return false;
    }
    delete entries[key];
    saveLearnedGains(entries, filePath);
    return true;
  });
}

/** `--set-gain-learning` の変更 */
export interface GainLearningPatch {
  readonly learnWindow?: number;
  readonly minLearnSeconds?: number;
}

function numberArgument(value: ArgValue, flag: string, isValid: (value: number) => boolean, range: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = typeof value === 'string' ? value.trim() : '';
  const parsed = text === '' ? NaN : Number(text);
  if (!Number.isFinite(parsed) || !isValid(parsed)) {
    throw new GainCommandError(`${flag} には ${range} を指定してください`);
  }
  return parsed;
}

/** `--set-gain-learning` の引数を確かめる（書かない）。範囲は config.json を読むときと同じ。 */
export function parseGainLearningCommand(values: Record<string, ArgValue>): GainLearningPatch {
  const learnWindow = numberArgument(
    values.window,
    '--window',
    value => Number.isInteger(value) && value >= MIN_LEARN_WINDOW && value <= MAX_LEARN_WINDOW,
    `${MIN_LEARN_WINDOW}〜${MAX_LEARN_WINDOW} の整数`,
  );
  const minLearnSeconds = numberArgument(
    values['min-seconds'],
    '--min-seconds',
    value => value >= MIN_LEARN_SECONDS_LOWER && value <= MIN_LEARN_SECONDS_UPPER,
    `${MIN_LEARN_SECONDS_LOWER}〜${MIN_LEARN_SECONDS_UPPER} の秒数`,
  );
  if (learnWindow === undefined && minLearnSeconds === undefined) {
    throw new GainCommandError('--window か --min-seconds の少なくとも一方を指定してください');
  }
  return { ...(learnWindow !== undefined ? { learnWindow } : {}), ...(minLearnSeconds !== undefined ? { minLearnSeconds } : {}) };
}

/** 読んだ設定の `gain` に変更を重ねる（ほかの gain の項目は残す） */
export function applyGainLearningPatch(current: UserSettings, patch: GainLearningPatch): UserSettings {
  const gain = current.gain !== null && typeof current.gain === 'object' && !Array.isArray(current.gain) ? current.gain : {};
  return { ...current, gain: { ...gain, ...patch } };
}

function reportError(error: unknown): void {
  console.error(`error: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')}`);
  process.exitCode = 1;
}

/**
 * `--list-gains` / `--reset-gain` / `--set-gain-learning` が指定されていれば実行して true を返す
 * （終了コードは `process.exitCode`）。
 */
export async function runGainCommand(values: Record<string, ArgValue>): Promise<boolean> {
  const chosen = (['list-gains', 'reset-gain', 'set-gain-learning'] as const).filter(name => values[name] === true);
  if (chosen.length === 0) {
    return false;
  }
  if (chosen.length > 1) {
    reportError(new GainCommandError(`${chosen.map(name => `--${name}`).join(' と ')} は同時に使えません`));
    return true;
  }
  try {
    if (chosen[0] === 'list-gains') {
      const list = listGains(loadLearnedGains(), currentLearningSettings());
      if (values.json === true) {
        console.log(JSON.stringify(list));
      } else {
        printGainList(list);
      }
      return true;
    }
    if (chosen[0] === 'reset-gain') {
      const key = typeof values.key === 'string' ? values.key.trim() : '';
      if (key === '') {
        throw new GainCommandError('--key に音量の表の鍵（provider:voice:model）を指定してください');
      }
      await resetGain(key);
      console.log('ok');
      return true;
    }
    const patch = parseGainLearningCommand(values);
    await modifySettings(current => applyGainLearningPatch(current, patch));
    console.log('ok');
  } catch (error) {
    reportError(error);
  }
  return true;
}

/**
 * 声とモデルの組ごとの音量の表（設計 3.2）。どの声も -20 LUFS に揃えて鳴らす。
 *
 * 表は ~/.config/aivis-mcp/gain.json に置く（Redis は永続化しないので使わない）。
 * 鍵は `provider:voice:model`（Aivis は `aivis:<model_uuid>:default`）。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** 揃える大きさ（Q205 B）。 */
export const TARGET_LUFS = -20;
/** 上げる方向の上限（表の値にも、最後の合計にも掛ける）。 */
export const MAX_BOOST_DB = 8;
/** 下げる方向の下限（壊れた測定で無音にしないため）。 */
export const MIN_TABLE_DB = -30;
export const MIN_FINAL_DB = -60;
/** 覚え直しに使う直近の回数。 */
export const LEARN_WINDOW = 5;
/** これより短い発話は覚え直しに使わない。 */
export const MIN_LEARN_SECONDS = 1.5;
/** 表に覚える組の上限。超えたら更新の古いものから消す。 */
export const MAX_LEARNED_ENTRIES = 200;
/** 頭打ち（-1dBTP 相当）。 */
export const LIMITER_FILTER = 'alimiter=limit=0.89';

/**
 * 最初の値（目標 -20 − 実測 LUFS、2026-10 に測ったもの）。
 * ElevenLabs の声 ID は ElevenLabs の voice_id。
 */
export const INITIAL_GAIN_DB: Readonly<Record<string, number>> = {
  'elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_v4_turbo': -7.4,
  'elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_v3': -10.4,
  'elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_flash_v2_5': -11.0,
  'elevenlabs:ZVu8zjKuHze7jtI0hoZK:eleven_v4_turbo': 0.0,
  'elevenlabs:ZVu8zjKuHze7jtI0hoZK:eleven_v3': -5.1,
  'elevenlabs:ZVu8zjKuHze7jtI0hoZK:eleven_flash_v2_5': -3.6,
  'elevenlabs:LSiB0PSif0xwvbQ34IjW:eleven_v4_turbo': 0.0,
  'elevenlabs:LSiB0PSif0xwvbQ34IjW:eleven_v3': -3.1,
  'elevenlabs:LSiB0PSif0xwvbQ34IjW:eleven_flash_v2_5': -4.6,
  'elevenlabs:fzUpiMn8RWy33hh3Oyex:eleven_v4_turbo': 0.5,
  'elevenlabs:fzUpiMn8RWy33hh3Oyex:eleven_v3': -2.1,
  'elevenlabs:fzUpiMn8RWy33hh3Oyex:eleven_flash_v2_5': -3.8,
  'elevenlabs:wdu0pCCtM4iELsmsPURL:eleven_v4_turbo': 1.4,
  'elevenlabs:wdu0pCCtM4iELsmsPURL:eleven_v3': -2.5,
  'elevenlabs:wdu0pCCtM4iELsmsPURL:eleven_flash_v2_5': -3.2,
  'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default': 4.1,
  'aivis:f13c2ec8-1069-403f-a23e-503b3a270c57:default': 4.9,
  'aivis:734c12b6-eaf2-4dbd-8596-8663c72d2afa:default': 4.5,
};

export interface LearnedGain {
  /** 表の値（直近の測定の中央値） */
  readonly db: number;
  /** 直近の測定から出した値（新しいものが後ろ） */
  readonly samples: readonly number[];
  /** 最後に覚え直した時刻（epoch ms）。上限を超えたときに古いものから消すのに使う */
  readonly updatedAt?: number;
}

export interface GainFile {
  readonly version: 1;
  readonly target: number;
  readonly entries: Readonly<Record<string, LearnedGain>>;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function clampTableDb(value: number): number {
  return Math.min(MAX_BOOST_DB, Math.max(MIN_TABLE_DB, value));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function splitKey(key: string): { provider: string; voice: string; model: string } | undefined {
  const first = key.indexOf(':');
  const last = key.lastIndexOf(':');
  if (first <= 0 || last <= first || last === key.length - 1) {
    return undefined;
  }
  return { provider: key.slice(0, first), voice: key.slice(first + 1, last), model: key.slice(last + 1) };
}

/** 学習済みの値と最初の値を合わせた表。 */
export function buildGainTable(learned: Readonly<Record<string, LearnedGain>>): Record<string, number> {
  // `__proto__` のような鍵で Object の性質を書き換えないよう、原型の無いオブジェクトに入れる
  const table: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, INITIAL_GAIN_DB);
  for (const [key, entry] of Object.entries(learned)) {
    table[key] = entry.db;
  }
  return table;
}

/**
 * 鍵の補正値を引く。知らない組は同じ provider・同じモデルの平均、それも無ければ 0dB。
 */
export function resolveGainDb(key: string | undefined, learned: Readonly<Record<string, LearnedGain>>): number {
  if (key === undefined) {
    return 0;
  }
  const table = buildGainTable(learned);
  if (table[key] !== undefined) {
    return table[key];
  }
  const parts = splitKey(key);
  if (parts === undefined) {
    return 0;
  }
  const sameModel = Object.entries(table)
    .filter(([candidate]) => {
      const other = splitKey(candidate);
      return other !== undefined && other.provider === parts.provider && other.model === parts.model;
    })
    .map(([, value]) => value);
  if (sameModel.length === 0) {
    return 0;
  }
  return round1(sameModel.reduce((sum, value) => sum + value, 0) / sameModel.length);
}

/** 測った大きさ（LUFS）を 1 回分の補正値として足し、直近 5 回の中央値を表の値にする。 */
export function learnSample(previous: LearnedGain | undefined, measuredLufs: number, now = Date.now()): LearnedGain {
  const sample = round1(clampTableDb(TARGET_LUFS - measuredLufs));
  const samples = [...(previous?.samples ?? []), sample].slice(-LEARN_WINDOW);
  return { db: round1(median(samples)), samples, updatedAt: now };
}

/** 上限を超えた分を、更新の古いものから消す。 */
export function pruneLearnedGains(entries: Readonly<Record<string, LearnedGain>>, limit = MAX_LEARNED_ENTRIES): Record<string, LearnedGain> {
  const sorted = Object.entries(entries).sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0)).slice(0, limit);
  const result: Record<string, LearnedGain> = Object.create(null);
  for (const [key, entry] of sorted) {
    result[key] = entry;
  }
  return result;
}

/** 覚え直しに使ってよい発話か。 */
export function isLearnable(input: {
  readonly tagged: boolean;
  readonly durationSeconds: number | undefined;
  readonly completed: boolean;
  readonly measuredLufs?: number;
}): boolean {
  if (input.tagged || !input.completed || input.durationSeconds === undefined || input.durationSeconds < MIN_LEARN_SECONDS) {
    return false;
  }
  if (input.measuredLufs !== undefined && (!Number.isFinite(input.measuredLufs) || input.measuredLufs < -70 || input.measuredLufs > 0)) {
    return false;
  }
  return true;
}

/** 表の値 ＋ 呼び出し側の音量 ＋ 利用者の上乗せ。合計にも上げる方向の上限を掛ける。 */
export function finalGainDb(...parts: readonly (number | undefined)[]): number {
  const total = parts.reduce<number>((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
  return round1(Math.min(MAX_BOOST_DB, Math.max(MIN_FINAL_DB, total)));
}

/** ffplay / mpv に当てるフィルター。 */
export function voiceFilter(gainDb: number): string {
  return `volume=${gainDb.toFixed(1)}dB,${LIMITER_FILTER}`;
}

/** afplay の -v（1.0 を超える値は使わない）。 */
export function afplayVolume(gainDb: number): number {
  return Math.min(1, Math.pow(10, gainDb / 20));
}

/**
 * 一時ファイルに書いて fsync してから置き換える（書きかけや電源断で中身の無いファイルを残さない）。
 */
export function writeFileAtomic(target: string, content: string, mode: number): void {
  // シンボリックリンクなら実体へたどってから書く（リンクを普通のファイルで置き換えて壊さない）
  let filePath = target;
  try {
    filePath = fs.realpathSync(target);
  } catch {
    // まだ無いファイルはそのまま作る
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'w', mode);
  try {
    fs.writeSync(fd, content, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** 音量の表の置き場。`AIVIS_GAIN_FILE` での差し替えはテスト用（起こした worker には引き継がない）。 */
export function gainFilePath(): string {
  return process.env.AIVIS_GAIN_FILE || path.join(os.homedir(), '.config', 'aivis-mcp', 'gain.json');
}

function isLearnedGain(value: unknown): value is LearnedGain {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<LearnedGain>;
  return typeof entry.db === 'number' && Number.isFinite(entry.db)
    && Array.isArray(entry.samples) && entry.samples.every(sample => typeof sample === 'number' && Number.isFinite(sample));
}

/** 表を読む。無い・壊れているときは空の表。 */
export function loadLearnedGains(filePath = gainFilePath()): Record<string, LearnedGain> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<GainFile>;
    const result: Record<string, LearnedGain> = Object.create(null);
    if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) {
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (key.length <= 300 && key !== '__proto__' && isLearnedGain(entry)) {
          result[key] = {
            db: clampTableDb(entry.db),
            samples: entry.samples.slice(-LEARN_WINDOW),
            ...(typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? { updatedAt: entry.updatedAt } : {}),
          };
        }
      }
    }
    return pruneLearnedGains(result);
  } catch {
    return Object.create(null);
  }
}

/** 一時ファイルに書いてから置き換える（書きかけを読ませない）。 */
export function saveLearnedGains(entries: Readonly<Record<string, LearnedGain>>, filePath = gainFilePath()): void {
  const body: GainFile = { version: 1, target: TARGET_LUFS, entries: { ...pruneLearnedGains(entries) } };
  writeFileAtomic(filePath, JSON.stringify(body, null, 2) + '\n', 0o644);
}

/** 1 回分の測定を表に足して保存する。 */
export function recordMeasurement(key: string, measuredLufs: number, filePath = gainFilePath()): LearnedGain {
  const entries = loadLearnedGains(filePath);
  const next = learnSample(entries[key], measuredLufs);
  const merged: Record<string, LearnedGain> = Object.assign(Object.create(null), entries);
  merged[key] = next;
  saveLearnedGains(merged, filePath);
  return next;
}

/** 2.4 まで ElevenLabs に掛けていた固定の補正（`volume_db` の既定）。 */
export const LEGACY_ELEVENLABS_VOLUME_DB = -13;

/** 2.4 の `volume_db`（ElevenLabs に掛ける絶対値）を、2.5 の上乗せ（0 が既定）に直す。 */
export function legacyElevenLabsVolumeToOffset(volumeDb: number): number {
  return round1(volumeDb - LEGACY_ELEVENLABS_VOLUME_DB);
}

export interface VolumeMigrationInput {
  readonly elevenlabs?: {
    readonly volumeDb?: number;
    readonly volumeOffsetDb?: number;
    readonly volumeMigrated?: boolean;
  };
}

/**
 * 設定ファイルの `elevenlabs.volumeDb` を 1 回だけ読み替える。読み替えたら移行済みの印を残し、
 * 2 回目以降は何もしない。`volumeDb` は 2.4 が読むので消さない。
 */
export function migrateVolumeSettings<T extends VolumeMigrationInput>(settings: T): { settings: T; changed: boolean } {
  const elevenlabs = settings.elevenlabs;
  if (elevenlabs === undefined || elevenlabs.volumeMigrated === true) {
    return { settings, changed: false };
  }
  if (typeof elevenlabs.volumeDb !== 'number' || !Number.isFinite(elevenlabs.volumeDb)) {
    return { settings, changed: false };
  }
  return {
    settings: {
      ...settings,
      elevenlabs: {
        ...elevenlabs,
        volumeOffsetDb: elevenlabs.volumeOffsetDb ?? legacyElevenLabsVolumeToOffset(elevenlabs.volumeDb),
        volumeMigrated: true,
      },
    },
    changed: true,
  };
}

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
/**
 * 覚え直しに使う直近の回数（既定）。10 声 × 20 文の実測で、窓 5 だと採用値のずれが p99 1.24dB、
 * 9 だと p99 0.99dB（耳で気付く 1dB 以内）。15 は p99 0.79dB だが落ち着くまでが遅い。
 * `config.json` の `gain.learnWindow` か `AIVIS_GAIN_LEARN_WINDOW` で変えられる。
 */
export const LEARN_WINDOW = 9;
/**
 * これより短い発話は覚え直しに使わない（既定、秒）。2.5 秒以下の短い文は声により約 -0.8dB 偏る。
 * `config.json` の `gain.minLearnSeconds` か `AIVIS_GAIN_MIN_LEARN_SECONDS` で変えられる。
 */
export const MIN_LEARN_SECONDS = 2.5;
/** 窓に指定できる範囲。表のファイルにも上限の分までは測定を残す（窓を増やしたときに使う）。 */
export const MIN_LEARN_WINDOW = 1;
export const MAX_LEARN_WINDOW = 50;
/** 最短の秒数に指定できる範囲。 */
export const MIN_LEARN_SECONDS_LOWER = 0.5;
export const MIN_LEARN_SECONDS_UPPER = 30;
/** 表に覚える組の上限。超えたら更新の古いものから消す。 */
export const MAX_LEARNED_ENTRIES = 200;
/**
 * 頭打ち（-1dBTP 相当）。ffmpeg の alimiter は既定で出力を持ち上げる（level が on）ので、
 * 補正した大きさがずれないよう切る。
 */
export const LIMITER_FILTER = 'alimiter=limit=0.89:level=false';

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

export function splitKey(key: string): { provider: string; voice: string; model: string } | undefined {
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

/**
 * 測った大きさ（LUFS）を 1 回分の補正値として足し、直近 `window` 回の中央値を表の値にする。
 * 測定は窓に関わらず上限（`MAX_LEARN_WINDOW` 回）まで残す。窓を減らしても後で増やせば古い測定を使え、
 * 増やしたときは残っている分だけで中央値を取る。
 */
export function learnSample(previous: LearnedGain | undefined, measuredLufs: number, now = Date.now(), window = LEARN_WINDOW): LearnedGain {
  const sample = round1(clampTableDb(TARGET_LUFS - measuredLufs));
  const samples = [...(previous?.samples ?? []), sample].slice(-MAX_LEARN_WINDOW);
  return { db: round1(median(samples.slice(-clampLearnWindow(window)))), samples, updatedAt: now };
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

/** 覚え直しに使ってよい発話か（`minLearnSeconds` より短いものは使わない）。 */
export function isLearnable(input: {
  readonly tagged: boolean;
  readonly durationSeconds: number | undefined;
  readonly completed: boolean;
  readonly measuredLufs?: number;
}, minLearnSeconds = MIN_LEARN_SECONDS): boolean {
  if (input.tagged || !input.completed || input.durationSeconds === undefined || input.durationSeconds < minLearnSeconds) {
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
 * シンボリックリンクをたどった先のパス。指し先がまだ無いリンクは、リンクの中身を解決した場所を返す
 * （`realpath` は指し先が無いと失敗するので、自分で readlink をたどる）。リンクでなければそのまま。
 */
export function resolveLinkTarget(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // 指し先が無い、またはまだ無いファイル
  }
  let current = path.resolve(filePath);
  for (let hops = 0; hops < 40; hops++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break;
    }
    if (!stat.isSymbolicLink()) {
      break;
    }
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  // 親フォルダがあれば、そちらのリンクもたどる
  try {
    return path.join(fs.realpathSync(path.dirname(current)), path.basename(current));
  } catch {
    return current;
  }
}

/**
 * 一時ファイルに書いて fsync してから置き換える（書きかけや電源断で中身の無いファイルを残さない）。
 */
export function writeFileAtomic(target: string, content: string, mode: number): void {
  // シンボリックリンクなら実体へたどってから書く（リンクを普通のファイルで置き換えて壊さない。
  // 指し先がまだ無いリンクでも、リンクを残したまま指し先に作る）
  const filePath = resolveLinkTarget(target);
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

function clampLearnWindow(window: number): number {
  if (!Number.isFinite(window)) {
    return LEARN_WINDOW;
  }
  return Math.min(MAX_LEARN_WINDOW, Math.max(MIN_LEARN_WINDOW, Math.floor(window)));
}

export interface GainLearningSettings {
  /** 覚え直しに使う直近の回数 */
  readonly learnWindow: number;
  /** これより短い発話は覚え直しに使わない（秒） */
  readonly minLearnSeconds: number;
}

/** 候補（優先の高い順）。`source` は警告に出す名前。 */
export interface GainSettingCandidate {
  readonly source: string;
  readonly value: unknown;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value.trim());
  }
  return undefined;
}

/**
 * 候補のうち最初に値があるものを使う。範囲外・数でないときは既定に戻して `warn` で知らせる
 * （下の優先度の候補へは落とさない。指定した人に、効いていないことを気付かせるため）。
 */
function pickSetting(
  name: string,
  candidates: readonly GainSettingCandidate[],
  fallback: number,
  isValid: (value: number) => boolean,
  range: string,
  warn: (message: string) => void,
): number {
  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null || candidate.value === '') {
      continue;
    }
    const value = toNumber(candidate.value);
    if (value !== undefined && Number.isFinite(value) && isValid(value)) {
      return value;
    }
    const reason = value === undefined || !Number.isFinite(value) ? '数ではありません' : '範囲外です';
    warn(`${candidate.source} の ${name}=${String(candidate.value)} は${reason}（${range}）。既定の ${fallback} を使います`);
    return fallback;
  }
  return fallback;
}

/** 窓と最短秒数を、優先の高い順に並べた候補から決める。 */
export function resolveGainLearningSettings(
  candidates: { readonly learnWindow: readonly GainSettingCandidate[]; readonly minLearnSeconds: readonly GainSettingCandidate[] },
  warn: (message: string) => void = message => console.error(`[aivis-mcp] ${message}`),
): GainLearningSettings {
  return {
    learnWindow: pickSetting(
      'learnWindow',
      candidates.learnWindow,
      LEARN_WINDOW,
      value => Number.isInteger(value) && value >= MIN_LEARN_WINDOW && value <= MAX_LEARN_WINDOW,
      `${MIN_LEARN_WINDOW}〜${MAX_LEARN_WINDOW} の整数`,
      warn,
    ),
    minLearnSeconds: pickSetting(
      'minLearnSeconds',
      candidates.minLearnSeconds,
      MIN_LEARN_SECONDS,
      value => value >= MIN_LEARN_SECONDS_LOWER && value <= MIN_LEARN_SECONDS_UPPER,
      `${MIN_LEARN_SECONDS_LOWER}〜${MIN_LEARN_SECONDS_UPPER} 秒`,
      warn,
    ),
  };
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
            // 窓を後から増やしても使えるよう、指定できる上限の分まで残す
            samples: entry.samples.slice(-MAX_LEARN_WINDOW),
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

/** ロックを持ったままの時間がこれを超えたら、持ち主が落ちたとみなして消す。 */
export const GAIN_LOCK_STALE_MS = 10_000;
/** ロックが空くのを待つ上限。 */
export const GAIN_LOCK_WAIT_MS = 5_000;
const GAIN_LOCK_RETRY_MS = 50;

/** ロックが空かなかった。 */
export class GainLockError extends Error {}

/** 表のロックの置き場（シンボリックリンクなら指し先の隣。指し先がまだ無くても、書く前後で変わらない）。 */
export function gainLockPath(filePath = gainFilePath()): string {
  return `${resolveLinkTarget(filePath)}.lock`;
}

/** 古いロックを、stat したときと同じ持ち主のままなら退けて消す。消せたら true。 */
function removeStaleLock(lockPath: string, staleMs: number): boolean {
  let owner: string;
  try {
    owner = fs.readFileSync(lockPath, 'utf8');
    if (Date.now() - fs.statSync(lockPath).mtimeMs <= staleMs) {
      return false;
    }
  } catch {
    // 調べている間に消えた。取り直せばよい
    return true;
  }
  // rename で退けてから中身を確かめる。退けたのが別の持ち主の新しいロックだったら、元に戻す
  const aside = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return true;
  }
  try {
    if (fs.readFileSync(aside, 'utf8') !== owner) {
      try {
        // 誰かが先に取り直していなければ戻す（link は置き場が空いているときだけ成功する）
        fs.linkSync(aside, lockPath);
      } catch {
        // 置き場が埋まっているなら、そちらが今の持ち主
      }
      return false;
    }
    return true;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** ロックのファイルを排他で作る。作れたら true、ほかが持っていたら false */
function acquireLockFile(lockPath: string, token: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o644);
    try {
      fs.writeSync(fd, token, null, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    return false;
  }
}

function releaseLockFile(lockPath: string, token: string): void {
  try {
    // 古いとみなされて別のプロセスに取り直されていたら、そのロックは消さない
    if (fs.readFileSync(lockPath, 'utf8') === token) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // もう無い
  }
}

function newLockToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/**
 * ファイルを読んで書き戻す間、`<file>.lock` を排他で作って持つ。持ち主が {@link GAIN_LOCK_STALE_MS} を
 * 超えて残したロックは消して取り直す。音量の表（`gain.json`）と設定（`config.json`）で使う。
 */
export async function withFileLock<T>(
  filePath: string,
  body: () => T | Promise<T>,
  options: { readonly staleMs?: number; readonly waitMs?: number; readonly lockError?: (lockPath: string) => Error } = {},
): Promise<T> {
  const staleMs = options.staleMs ?? GAIN_LOCK_STALE_MS;
  const waitMs = options.waitMs ?? GAIN_LOCK_WAIT_MS;
  const lockPath = gainLockPath(filePath);
  const token = newLockToken();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (acquireLockFile(lockPath, token)) {
      break;
    }
    if (removeStaleLock(lockPath, staleMs)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw options.lockError?.(lockPath) ?? new GainLockError(`ロック（${lockPath}）が空きません。ほかのプロセスが書いています`);
    }
    await new Promise(resolve => setTimeout(resolve, GAIN_LOCK_RETRY_MS));
  }
  try {
    return await body();
  } finally {
    releaseLockFile(lockPath, token);
  }
}

/**
 * 待たずに 1 回だけロックを取りにいく同期版。取れなければ body を呼ばずに undefined を返す
 * （同期で読む途中の、書けなくても困らない書き込み向け）。
 */
export function tryWithFileLockSync<T>(filePath: string, body: () => T, staleMs = GAIN_LOCK_STALE_MS): T | undefined {
  const lockPath = gainLockPath(filePath);
  const token = newLockToken();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (!acquireLockFile(lockPath, token) && !(removeStaleLock(lockPath, staleMs) && acquireLockFile(lockPath, token))) {
    return undefined;
  }
  try {
    return body();
  } finally {
    releaseLockFile(lockPath, token);
  }
}

/**
 * 表を読んで書き戻す間、`gain.json.lock` を排他で作って持つ（worker の覚え直しと `--import-gains` が
 * 互いの書き込みを消さないように）。持ち主が {@link GAIN_LOCK_STALE_MS} を超えて残したロックは消して取り直す。
 */
export async function withGainFileLock<T>(
  filePath: string,
  body: () => T | Promise<T>,
  options: { readonly staleMs?: number; readonly waitMs?: number } = {},
): Promise<T> {
  return withFileLock(filePath, body, {
    ...options,
    lockError: lockPath => new GainLockError(`音量の表のロック（${lockPath}）が空きません。ほかのプロセスが書いています`),
  });
}

/** 1 回分の測定を表に足して保存する（表のロックを持って読み書きする）。 */
export async function recordMeasurement(key: string, measuredLufs: number, filePath = gainFilePath(), window = LEARN_WINDOW): Promise<LearnedGain> {
  return withGainFileLock(filePath, () => {
    const entries = loadLearnedGains(filePath);
    const next = learnSample(entries[key], measuredLufs, Date.now(), window);
    const merged: Record<string, LearnedGain> = Object.assign(Object.create(null), entries);
    merged[key] = next;
    saveLearnedGains(merged, filePath);
    return next;
  });
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

import fs from 'fs';
import path from 'path';
import os from 'os';
import * as readline from 'node:readline';
import { migrateVolumeSettings, tryWithFileLockSync, withFileLock, writeFileAtomic } from './audio/gain-table.js';

/** 設定ファイル。`AIVIS_CONFIG_FILE` で差し替えられる（テスト用）。 */
function configFile(): string {
  return process.env.AIVIS_CONFIG_FILE || path.join(os.homedir(), '.config', 'aivis-mcp', 'config.json');
}

export type TtsProvider = 'aivis' | 'elevenlabs';

export const TTS_PROVIDERS: readonly TtsProvider[] = ['aivis', 'elevenlabs'];

export function isTtsProvider(value: unknown): value is TtsProvider {
  return typeof value === 'string' && (TTS_PROVIDERS as readonly string[]).includes(value);
}

export interface ElevenLabsSettings {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  /** 2.4 までの ElevenLabs の音量（絶対値、既定 -13）。2.4 が読むので残す */
  volumeDb?: number;
  /** 2.5 からの ElevenLabs だけに足す上乗せ（dB、既定 0） */
  volumeOffsetDb?: number;
  /** volumeDb を volumeOffsetDb へ読み替え済みの印 */
  volumeMigrated?: boolean;
  /** 前の発話の文脈を付ける時間（分、既定 5、0 で付けない） */
  contextWindowMinutes?: number;
  /** 合成に使う発音辞書の ID */
  pronunciationDictionaryId?: string;
  /** 発音辞書の版（無ければ最新の版を使う） */
  pronunciationDictionaryVersionId?: string;
}

/** Aivis だけに効く設定（APIキーとモデルは互換のため最上位に置いたまま） */
export interface AivisSettings {
  /** 合成に使うユーザー辞書の UUID */
  userDictionaryUuid?: string;
}

/** 音量の表の覚え直し方 */
export interface GainSettings {
  /** 覚え直しに使う直近の回数（1〜50、既定 9） */
  learnWindow?: number;
  /** これより短い発話は覚え直しに使わない（0.5〜30 秒、既定 2.5） */
  minLearnSeconds?: number;
}

export interface UserSettings {
  provider?: TtsProvider;
  apiKey?: string;
  apiUrl?: string;
  modelUuid?: string;
  redisUrl?: string;
  /** すべての声に足す上乗せ（dB、既定 0） */
  volumeOffsetDb?: number;
  elevenlabs?: ElevenLabsSettings;
  aivis?: AivisSettings;
  gain?: GainSettings;
}

/** 入れ子の設定の変更。undefined は変えない、null は消す */
type NestedPatch<T> = { [K in keyof T]?: T[K] | null };

export type SettingsPatch = Omit<UserSettings, 'elevenlabs' | 'aivis'> & {
  elevenlabs?: NestedPatch<ElevenLabsSettings>;
  aivis?: NestedPatch<AivisSettings>;
};

export function loadSettings(): UserSettings {
  try {
    const data = fs.readFileSync(configFile(), 'utf-8');
    return JSON.parse(data) as UserSettings;
  } catch {
    return {};
  }
}

/**
 * 設定を読み、2.4 の `elevenlabs.volumeDb` を 1 回だけ 2.5 の上乗せへ読み替える（移行済みの印を残す）。
 */
export function loadSettingsWithMigration(): UserSettings {
  const migrated = migrateVolumeSettings(loadSettings());
  if (!migrated.changed) {
    return migrated.settings;
  }
  try {
    // 書く直前に読み直し、ほかのプロセスが先に読み替えていたら（印があれば）書かない。
    // 読み替えは 1 回だけで、ほかのプロセスが書いた別の項目も消さない。
    // ほかのプロセスが設定を書いている（ロックが空かない）ときは書かずに、次に読むときに読み替え直す
    const written = tryWithFileLockSync(configFile(), () => {
      const fresh = migrateVolumeSettings(loadSettings());
      if (fresh.changed) {
        saveSettings(fresh.settings);
      }
      return fresh.settings;
    });
    return written ?? migrated.settings;
  } catch {
    // 書けなくても、今回の値は読み替えたものを使う
    return migrated.settings;
  }
}

export function saveSettings(settings: UserSettings): void {
  // APIキーを含むので本人以外から読めないようにする。一時ファイルを 0600 で作ってから置き換える
  // （書きかけのファイルを読ませない）
  writeFileAtomic(configFile(), JSON.stringify(settings, null, 2) + '\n', 0o600);
  fs.chmodSync(configFile(), 0o600);
}

/** 入れ子の設定へ変更を重ねる。undefined は変えない、null は消す。空になったら undefined を返す */
function mergeNested<T extends object>(current: T | undefined, patch: NestedPatch<T> | undefined): T | undefined {
  if (patch === undefined) {
    return current;
  }
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return Object.keys(next).length > 0 ? next as T : undefined;
}

/** 読んだ設定に変更を重ねたもの（書かない）。 */
function applySettingsPatch(current: UserSettings, patch: SettingsPatch): UserSettings {
  const next: UserSettings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'elevenlabs' || key === 'aivis' || value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  const elevenlabs = mergeNested(current.elevenlabs, patch.elevenlabs);
  if (elevenlabs === undefined) {
    delete next.elevenlabs;
  } else {
    next.elevenlabs = elevenlabs;
  }
  const aivis = mergeNested(current.aivis, patch.aivis);
  if (aivis === undefined) {
    delete next.aivis;
  } else {
    next.aivis = aivis;
  }
  return next;
}

/** 設定ファイルのロックが空かなかった */
export class SettingsLockError extends Error {}

/**
 * 既存の設定に部分的な変更を重ねて保存する。undefined のキーは変更しない（入れ子の項目は null で消す）。
 * 読んでから書き戻すまで `config.json.lock` を持つ（MCP の tts-configure と `--set-dictionary` が
 * 同時に書いても互いの変更を消さないように。音量の表と同じ方式）。
 */
export async function updateSettings(patch: SettingsPatch): Promise<UserSettings> {
  return withFileLock(configFile(), () => {
    const next = applySettingsPatch(loadSettings(), patch);
    saveSettings(next);
    return next;
  }, { lockError: lockPath => new SettingsLockError(`設定ファイルのロック（${lockPath}）が空きません。ほかのプロセスが書いています`) });
}

export function getConfigPath(): string {
  return configFile();
}

function ask(rl: readline.Interface, question: string, currentValue?: string): Promise<string> {
  const hint = currentValue ? ` [${currentValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      resolve(answer.trim() || currentValue || '');
    });
  });
}

export async function runInit(): Promise<void> {
  console.log('');
  console.log('=== aivis-mcp 初期設定 ===');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const current = loadSettings();

    let provider = await ask(rl, '使用する音声合成サービス (aivis / elevenlabs)', current.provider ?? 'aivis');
    while (!isTtsProvider(provider)) {
      provider = await ask(rl, 'aivis か elevenlabs を入力してください', current.provider ?? 'aivis');
    }

    const settings: UserSettings = { ...current, provider };

    if (provider === 'aivis') {
      const apiKey = await ask(
        rl,
        'AIVIS_API_KEY (https://hub.aivis-project.com/cloud-api/api-keys)',
        current.apiKey
      );

      const modelUuid = await ask(
        rl,
        'モデルUUID (空欄でスキップ)',
        current.modelUuid
      );

      if (apiKey) settings.apiKey = apiKey;
      if (modelUuid) settings.modelUuid = modelUuid;
    } else {
      const apiKey = await ask(
        rl,
        'ELEVENLABS_API_KEY (https://elevenlabs.io/app/settings/api-keys)',
        current.elevenlabs?.apiKey
      );

      const voiceId = await ask(
        rl,
        'Voice ID (空欄でスキップ)',
        current.elevenlabs?.voiceId
      );

      const modelId = await ask(
        rl,
        'Model ID (空欄でスキップ)',
        current.elevenlabs?.modelId
      );

      const elevenlabs: ElevenLabsSettings = { ...current.elevenlabs };
      if (apiKey) elevenlabs.apiKey = apiKey;
      if (voiceId) elevenlabs.voiceId = voiceId;
      if (modelId) elevenlabs.modelId = modelId;
      settings.elevenlabs = elevenlabs;
    }

    // 尋ねている間にほかのプロセスが書いた項目を消さないよう、答えた項目だけを重ねる
    await updateSettings({
      provider: settings.provider,
      apiKey: settings.apiKey,
      modelUuid: settings.modelUuid,
      elevenlabs: settings.elevenlabs,
    });
    console.log('');
    console.log(`設定を保存しました: ${configFile()}`);
  } finally {
    rl.close();
  }
}

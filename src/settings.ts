import fs from 'fs';
import path from 'path';
import os from 'os';
import * as readline from 'node:readline';
import { migrateVolumeSettings, writeFileAtomic } from './audio/gain-table.js';

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
}

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
    // 読み替えは 1 回だけで、ほかのプロセスが書いた別の項目も消さない
    const fresh = migrateVolumeSettings(loadSettings());
    if (fresh.changed) {
      saveSettings(fresh.settings);
    }
    return fresh.settings;
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

/**
 * 既存の設定に部分的な変更を重ねて保存する。undefinedのキーは変更しない。
 */
export function updateSettings(patch: Omit<UserSettings, 'elevenlabs'> & { elevenlabs?: ElevenLabsSettings }): UserSettings {
  const current = loadSettings();
  const next: UserSettings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'elevenlabs' || value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  if (patch.elevenlabs) {
    const elevenlabs: ElevenLabsSettings = { ...current.elevenlabs };
    for (const [key, value] of Object.entries(patch.elevenlabs)) {
      if (value !== undefined) (elevenlabs as Record<string, unknown>)[key] = value;
    }
    next.elevenlabs = elevenlabs;
  }
  saveSettings(next);
  return next;
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

    saveSettings(settings);
    console.log('');
    console.log(`設定を保存しました: ${configFile()}`);
  } finally {
    rl.close();
  }
}

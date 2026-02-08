import fs from 'fs';
import path from 'path';
import os from 'os';
import * as readline from 'node:readline';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'aivis-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface UserSettings {
  apiKey?: string;
  apiUrl?: string;
  modelUuid?: string;
  redisUrl?: string;
}

export function loadSettings(): UserSettings {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(data) as UserSettings;
  } catch {
    return {};
  }
}

export function saveSettings(settings: UserSettings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

export function getConfigPath(): string {
  return CONFIG_FILE;
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

    const settings: UserSettings = {};
    if (apiKey) settings.apiKey = apiKey;
    if (modelUuid) settings.modelUuid = modelUuid;

    saveSettings(settings);
    console.log('');
    console.log(`設定を保存しました: ${CONFIG_FILE}`);
  } finally {
    rl.close();
  }
}

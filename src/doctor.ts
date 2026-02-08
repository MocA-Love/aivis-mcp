import { spawn, execSync, spawnSync } from 'child_process';
import * as readline from 'node:readline';
import { platform } from 'os';
import type { AppConfig } from './config.js';
import { getConfigPath } from './settings.js';

const system = platform();

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${message} [Y/n] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}

async function commandExists(cmd: string): Promise<boolean> {
  const checkCmd = system === 'win32' ? 'where' : 'which';
  const result = spawnSync(checkCmd, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

function getCommandVersion(cmd: string, versionFlag = '--version'): string | null {
  try {
    const result = spawnSync(cmd, [versionFlag], { stdio: 'pipe', encoding: 'utf-8' });
    if (result.status === 0) {
      return result.stdout.trim().split('\n')[0];
    }
    if (result.stderr) {
      return result.stderr.trim().split('\n')[0];
    }
    return null;
  } catch {
    return null;
  }
}

interface InstallInfo {
  darwin: string[];
  linux: string[];
  win32: string | null;
}

const INSTALL_COMMANDS: Record<string, InstallInfo> = {
  redis: {
    darwin: ['brew', 'install', 'redis'],
    linux: ['sudo', 'apt', 'install', '-y', 'redis-server'],
    win32: null,
  },
  ffmpeg: {
    darwin: ['brew', 'install', 'ffmpeg'],
    linux: ['sudo', 'apt', 'install', '-y', 'ffmpeg'],
    win32: null,
  },
};

async function tryInstall(name: string): Promise<boolean> {
  const info = INSTALL_COMMANDS[name];
  if (!info) return false;

  const key = system as keyof InstallInfo;
  const cmd = info[key];

  if (!cmd || typeof cmd === 'string') {
    if (typeof cmd === 'string') {
      console.log(`      手動でインストールしてください: ${cmd}`);
    } else {
      console.log('      このOSでは自動インストールに対応していません');
      if (name === 'redis') {
        console.log('      https://redis.io/download からインストールしてください');
      } else if (name === 'ffmpeg') {
        console.log('      https://ffmpeg.org/download.html からインストールしてください');
      }
    }
    return false;
  }

  const cmdStr = (cmd as string[]).join(' ');
  const shouldInstall = await confirm(`      インストールしますか？ (${cmdStr})`);
  if (!shouldInstall) {
    console.log('      スキップしました');
    return false;
  }

  console.log(`      ${cmdStr} を実行中...`);
  try {
    const proc = spawn(cmd[0], cmd.slice(1), {
      stdio: 'inherit',
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on('close', resolve);
      proc.on('error', () => resolve(null));
    });
    if (exitCode === 0) {
      console.log('      インストール完了');
      return true;
    } else {
      console.log(`      インストール失敗 (exit code: ${exitCode})`);
      return false;
    }
  } catch (error) {
    console.log('      インストール失敗:', error);
    return false;
  }
}

/**
 * 非対話型の依存チェック（MCPサーバー起動時に使用）
 * 不足している依存ツールの名前リストを返す
 */
export function checkDependencies(): string[] {
  const missing: string[] = [];

  const redisExists = spawnSync(system === 'win32' ? 'where' : 'which', ['redis-server'], { stdio: 'pipe' });
  if (redisExists.status !== 0) {
    missing.push('redis-server');
  }

  const ffplayExists = spawnSync(system === 'win32' ? 'where' : 'which', ['ffplay'], { stdio: 'pipe' });
  if (ffplayExists.status !== 0) {
    missing.push('ffplay (ffmpeg)');
  }

  return missing;
}

/**
 * 対話型の--doctorコマンド
 */
export async function runDoctor(config: AppConfig): Promise<void> {
  console.log('');
  console.log('=== aivis-mcp doctor ===');
  console.log('');

  let okCount = 0;
  const totalChecks = 4;

  // [1/4] Node.js
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (nodeMajor >= 18) {
    console.log(`[1/${totalChecks}] Node.js`);
    console.log(`  OK  ${nodeVersion} (>= 18.x)`);
    okCount++;
  } else {
    console.log(`[1/${totalChecks}] Node.js`);
    console.log(`  NG  ${nodeVersion} -- Node.js 18以上が必要です`);
  }
  console.log('');

  // [2/4] AIVIS_API_KEY
  console.log(`[2/${totalChecks}] AIVIS_API_KEY`);
  if (config.apiKey) {
    console.log(`  OK  設定済み`);
    okCount++;
  } else {
    console.log('  NG  未設定');
    console.log('      npx aivis-mcp --init で設定するか、');
    console.log('      環境変数 AIVIS_API_KEY または --api-key で指定してください');
    console.log('      APIキーの取得: https://hub.aivis-project.com/cloud-api/api-keys');
    console.log(`      設定ファイル: ${getConfigPath()}`);
  }
  console.log('');

  // [3/4] Redis
  console.log(`[3/${totalChecks}] Redis`);
  const hasRedis = await commandExists('redis-server');
  if (hasRedis) {
    const ver = getCommandVersion('redis-server');
    console.log(`  OK  redis-server が見つかりました${ver ? ` (${ver})` : ''}`);
    okCount++;
  } else {
    console.log('  NG  redis-server が見つかりません');
    await tryInstall('redis');
  }
  console.log('');

  // [4/4] FFmpeg (ffplay)
  console.log(`[4/${totalChecks}] FFmpeg (ffplay)`);
  const hasFfplay = await commandExists('ffplay');
  if (hasFfplay) {
    const ver = getCommandVersion('ffplay', '-version');
    console.log(`  OK  ffplay が見つかりました${ver ? ` (${ver})` : ''}`);
    okCount++;
  } else {
    const hasMpv = await commandExists('mpv');
    if (hasMpv) {
      console.log('  OK  ffplay は見つかりませんが、mpv が利用可能です');
      okCount++;
    } else {
      console.log('  NG  ffplay が見つかりません');
      if (system === 'darwin') {
        const hasAfplay = await commandExists('afplay');
        if (hasAfplay) {
          console.log('      代替: afplay が利用可能（macOS標準、ストリーミング非対応）');
        }
      }
      await tryInstall('ffmpeg');
    }
  }
  console.log('');

  // 結果
  console.log(`=== 結果: ${okCount}/${totalChecks} OK ===`);
  if (okCount === totalChecks) {
    console.log('すべての依存関係が整っています。');
  } else {
    console.log('上記の問題を解決してから再度 --doctor を実行してください。');
  }
}

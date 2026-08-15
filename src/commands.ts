import { spawn, execSync } from 'child_process';
import { platform } from 'os';
import { createClient, type RedisClientType } from 'redis';
import type { AppConfig } from './config.js';
import { connectRedis, spawnWorker } from './services/redis-service.js';
import { parseMuteDuration, setMute, clearMute, getMuteStatus } from './services/mute-service.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface AivisProcess {
  pid: string;
  cmd: string;
  isWorker: boolean;
}

function getAivisProcesses(): AivisProcess[] {
  const myPid = process.pid.toString();
  try {
    const output = execSync('ps aux', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = output.split('\n');
    const results: AivisProcess[] = [];
    for (const line of lines) {
      if (!line.includes('aivis-mcp') || !line.includes('dist/index.js')) continue;
      if (line.includes('ps aux')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = parts[1];
      if (pid === myPid) continue;
      const cmd = parts.slice(10).join(' ');
      const isWorker = line.includes('--worker');
      results.push({ pid, cmd, isWorker });
    }
    return results;
  } catch {
    return [];
  }
}

export async function runHealth(config: AppConfig): Promise<void> {
  console.log('=== aivis-mcp health check ===');
  console.log('');

  // API Key
  console.log(`API Key:       ${config.apiKey ? 'OK' : 'NG (未設定)'}`);

  // Redis
  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    await client.ping();
    console.log(`Redis:         OK (${config.redisUrl})`);

    const workerLock = await client.get(config.workerLockKey);
    console.log(`Worker:        ${workerLock ? 'OK' : 'NG (停止中)'}`);

    const queueLen = await client.lLen(config.queueKey);
    console.log(`Queue:         ${queueLen} 件`);

    const playLock = await client.get('aivis-mcp:play-lock');
    console.log(`Play Lock:     ${playLock ? '使用中' : '空き'}`);

    await client.disconnect();
  } catch {
    console.log(`Redis:         NG (接続失敗: ${config.redisUrl})`);
    if (client) await client.disconnect().catch(() => {});
  }

  // Processes
  const procs = getAivisProcesses();
  const workers = procs.filter(p => p.isWorker);
  const mcpServers = procs.filter(p => !p.isWorker);
  console.log(`Processes:     ${procs.length} 件`);
  if (workers.length > 1) {
    console.log(`  Workers:     ${workers.length} (多重起動)`);
  } else {
    console.log(`  Workers:     ${workers.length}`);
  }
  console.log(`  MCP Servers: ${mcpServers.length}`);
  for (const p of procs) {
    console.log(`  PID ${p.pid}: ${p.isWorker ? '[worker]' : '[mcp]'} ${p.cmd}`);
  }

  // Audio player
  const system = platform();
  let players: string[] = [];
  if (system === 'darwin') {
    players = ['ffplay', 'mpv', 'afplay'];
  } else if (system === 'linux') {
    players = ['ffplay', 'mpv', 'mplayer', 'play'];
  } else if (system === 'win32') {
    players = ['ffplay.exe', 'mpv.exe'];
  }

  const available: string[] = [];
  for (const player of players) {
    try {
      const checkCmd = system === 'win32' ? 'where' : 'which';
      const result = spawn(checkCmd, [player], { stdio: 'pipe' });
      await new Promise<void>((resolve) => {
        result.on('exit', (code) => {
          if (code === 0) available.push(player);
          resolve();
        });
      });
    } catch {}
  }
  console.log(`Audio Player:  ${available.length > 0 ? `OK (${available.join(', ')})` : 'NG (未検出)'}`);

  // Model
  console.log(`Model UUID:    ${config.modelUuid}`);
}

export async function runReboot(config: AppConfig): Promise<void> {
  console.log('aivis-mcp reboot...');

  const procs = getAivisProcesses();
  const workers = procs.filter(p => p.isWorker);
  const mcpServers = procs.filter(p => !p.isWorker);

  if (workers.length > 0) {
    console.log(`Workers: ${workers.length} 件を停止`);
    for (const p of workers) {
      try { process.kill(parseInt(p.pid, 10), 'SIGTERM'); } catch {}
    }
  }
  if (mcpServers.length > 0) {
    console.log(`MCP Servers: ${mcpServers.length} 件を停止（クライアントが自動再起動します）`);
    for (const p of mcpServers) {
      try { process.kill(parseInt(p.pid, 10), 'SIGTERM'); } catch {}
    }
  }
  if (procs.length > 0) {
    await sleep(500);
  }

  try {
    const client = await connectRedis(config.redisUrl);
    const keys = await client.keys('aivis-mcp:*');
    if (keys.length > 0) {
      await client.del(keys);
      console.log(`Redis: ${keys.length} 件のキーを削除`);
    } else {
      console.log('Redis: クリア済み');
    }
    await client.disconnect();
  } catch {
    console.log('Redis: 接続失敗（スキップ）');
  }

  spawnWorker(config);
  await sleep(500);
  console.log('新しいワーカーを起動しました');
  console.log('reboot 完了');
}

/** 残り時間を「1時間30分」「45秒」のような日本語表記にする */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
  if (minutes > 0) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
  return `${seconds}秒`;
}

export async function runMute(config: AppConfig, durationArg: string | undefined): Promise<void> {
  let durationMs: number | undefined;
  if (durationArg !== undefined && durationArg !== '') {
    durationMs = parseMuteDuration(durationArg);
    if (durationMs === undefined) {
      console.error(`Error: 時間の指定を解釈できません: ${durationArg}（例: 30m, 1h, 90s, 5000ms）`);
      process.exitCode = 1;
      return;
    }
  }

  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    await setMute(client, durationMs);
    if (durationMs === undefined) {
      console.log('ミュートしました（自分で解除するまで）');
    } else {
      console.log(`ミュートしました（${formatDuration(durationMs)}後に自動解除）`);
    }
    await client.disconnect();
  } catch {
    console.error(`Error: Redisに接続できません (${config.redisUrl})`);
    process.exitCode = 1;
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function runUnmute(config: AppConfig): Promise<void> {
  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    await clearMute(client);
    console.log('ミュートを解除しました');
    await client.disconnect();
  } catch {
    console.error(`Error: Redisに接続できません (${config.redisUrl})`);
    process.exitCode = 1;
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function runMuteStatus(config: AppConfig): Promise<void> {
  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    const status = await getMuteStatus(client);
    if (!status.muted) {
      console.log('ミュートされていません');
    } else if (status.until === undefined) {
      console.log('ミュート中（自分で解除するまで）');
    } else {
      console.log(`ミュート中（あと${formatDuration(status.until - Date.now())}で自動解除）`);
    }
    await client.disconnect();
  } catch {
    console.error(`Error: Redisに接続できません (${config.redisUrl})`);
    process.exitCode = 1;
    if (client) await client.disconnect().catch(() => {});
  }
}

#!/usr/bin/env node

import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createRequire } from 'module';
import dotenv from 'dotenv';
import { createClient, type RedisClientType } from 'redis';
import { spawn, execSync } from 'child_process';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const envPath = path.join(__dirname, '../.env');
dotenv.config({ path: envPath });

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEnvNumber(key: string): number | undefined {
  const value = process.env[key];
  return value ? parseFloat(value) : undefined;
}

async function tryStartRedis(): Promise<void> {
  const lockDir = path.join(__dirname, '../temp');
  const lockPath = path.join(lockDir, 'redis-start.lock');
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    const fd = fs.openSync(lockPath, 'wx');
    fs.closeSync(fd);
  } catch {
    return;
  }
  try {
    const child = spawn('redis-server', ['--save', '', '--appendonly', 'no'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    console.error('Failed to start redis-server:', error);
  } finally {
    setTimeout(() => {
      try { fs.unlinkSync(lockPath); } catch {}
    }, 3000);
  }
}

async function connectRedis(redisUrl: string): Promise<RedisClientType> {
  let client = createClient({ url: redisUrl }) as RedisClientType;
  try {
    await client.connect();
    return client;
  } catch {
    await client.disconnect().catch(() => {});
  }

  await tryStartRedis();

  for (let i = 0; i < 10; i++) {
    try {
      client = createClient({ url: redisUrl }) as RedisClientType;
      await client.connect();
      return client;
    } catch {
      await client.disconnect().catch(() => {});
      await sleep(200);
    }
  }

  console.error('Error: Redisに接続できません');
  process.exit(1);
}

const WORKER_LOCK_KEY = process.env.AIVIS_WORKER_LOCK_KEY || 'aivis-mcp:worker-lock';
const QUEUE_KEY = process.env.AIVIS_QUEUE_KEY || 'aivis-mcp:queue';

function spawnWorker(): void {
  const indexPath = path.join(__dirname, 'index.js');
  const child = spawn(process.execPath, [indexPath, '--worker'], {
    env: { ...process.env, AIVIS_WORKER_MODE: '1' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

async function ensureWorkerRunning(client: RedisClientType): Promise<void> {
  const workerLock = await client.get(WORKER_LOCK_KEY);
  if (workerLock) return;
  spawnWorker();
  await sleep(300);
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
      if (!line.includes('aivis-mcp/dist/index.js')) continue;
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

async function healthCheck(): Promise<void> {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  console.log('=== aivis health check ===');
  console.log('');

  // API Key
  const apiKey = process.env.AIVIS_API_KEY;
  console.log(`API Key:       ${apiKey ? 'OK' : 'NG (未設定)'}`);

  // Redis
  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: redisUrl }) as RedisClientType;
    await client.connect();
    await client.ping();
    console.log(`Redis:         OK (${redisUrl})`);

    // Worker
    const workerLock = await client.get(WORKER_LOCK_KEY);
    console.log(`Worker:        ${workerLock ? 'OK' : 'NG (停止中)'}`);

    // Queue
    const queueLen = await client.lLen(QUEUE_KEY);
    console.log(`Queue:         ${queueLen} 件`);

    // Play lock
    const playLock = await client.get('aivis-mcp:play-lock');
    console.log(`Play Lock:     ${playLock ? '使用中' : '空き'}`);

    await client.disconnect();
  } catch {
    console.log(`Redis:         NG (接続失敗: ${redisUrl})`);
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
  const modelUuid = process.env.AIVIS_MODEL_UUID;
  console.log(`Model UUID:    ${modelUuid || 'デフォルト'}`);
}

async function reboot(): Promise<void> {
  console.log('aivis reboot...');

  // 1. 既存プロセスを停止
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

  // 2. Redisのaivis関連キーをクリア
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  try {
    const client = await connectRedis(redisUrl);
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

  // 3. 新しいワーカーを起動
  spawnWorker();
  await sleep(500);
  console.log('新しいワーカーを起動しました');
  console.log('reboot 完了');
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`aivis-mcp v${version}`);
    process.exit(0);
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: aivis <text> [--model <model_uuid>] [--wait <ms>]');
    console.log('       aivis --health');
    console.log('       aivis --reboot');
    console.log('       aivis --version');
    process.exit(0);
  }

  if (args[0] === '--health') {
    await healthCheck();
    process.exit(0);
  }

  if (args[0] === '--reboot') {
    await reboot();
    process.exit(0);
  }

  let text = '';
  let modelUuid: string | undefined;
  let waitMs: number | undefined;

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--model' && i + 1 < args.length) {
      modelUuid = args[i + 1];
      i += 2;
    } else if (args[i] === '--wait' && i + 1 < args.length) {
      waitMs = parseInt(args[i + 1], 10);
      i += 2;
    } else if (!args[i].startsWith('--')) {
      text = args[i];
      i++;
    } else {
      i++;
    }
  }

  if (!text) {
    console.error('Error: テキストを指定してください');
    process.exit(1);
  }

  const params: Record<string, unknown> = {
    text,
    model_uuid: modelUuid ?? process.env.AIVIS_MODEL_UUID,
    style_id: getEnvNumber('AIVIS_STYLE_ID'),
    style_name: process.env.AIVIS_STYLE_NAME,
    speaking_rate: getEnvNumber('AIVIS_SPEAKING_RATE'),
    emotional_intensity: getEnvNumber('AIVIS_EMOTIONAL_INTENSITY'),
    tempo_dynamics: getEnvNumber('AIVIS_TEMPO_DYNAMICS'),
    pitch: getEnvNumber('AIVIS_PITCH'),
    volume: getEnvNumber('AIVIS_VOLUME'),
    leading_silence_seconds: getEnvNumber('AIVIS_LEADING_SILENCE_SECONDS'),
    trailing_silence_seconds: getEnvNumber('AIVIS_TRAILING_SILENCE_SECONDS'),
    line_break_silence_seconds: getEnvNumber('AIVIS_LINE_BREAK_SILENCE_SECONDS'),
  };

  if (waitMs !== undefined) {
    params.wait_ms = waitMs;
  }

  // undefined値を削除
  for (const key of Object.keys(params)) {
    if (params[key] === undefined) {
      delete params[key];
    }
  }

  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const client = await connectRedis(redisUrl);

  // ワーカーが動いていなければ起動
  await ensureWorkerRunning(client);

  // キューにエンキュー（即座に返す）
  await client.rPush(QUEUE_KEY, JSON.stringify(params));

  await client.disconnect();
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

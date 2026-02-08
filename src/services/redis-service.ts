import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { createClient, type RedisClientType } from 'redis';
import type { AppConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function tryStartRedis(): Promise<void> {
  const lockDir = path.join(process.cwd(), 'temp');
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

export async function connectRedis(redisUrl: string): Promise<RedisClientType> {
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

export function spawnWorker(_config?: AppConfig): void {
  const indexPath = path.join(__dirname, '../index.js');
  const child = spawn(process.execPath, [indexPath, '--worker'], {
    env: { ...process.env, AIVIS_WORKER_MODE: '1' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

export async function ensureWorkerRunning(client: RedisClientType, config: AppConfig): Promise<void> {
  const workerLock = await client.get(config.workerLockKey);
  if (workerLock) return;
  spawnWorker(config);
  await sleep(300);
}

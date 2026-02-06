#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createClient, type RedisClientType } from 'redis';
import { spawn } from 'child_process';

const envPath = path.join(__dirname, '../.env');
dotenv.config({ path: envPath });

import { AivisSpeechService } from './services/aivis-speech-service';

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

const PLAY_LOCK_KEY = 'aivis-mcp:play-lock';

async function acquirePlayLock(client: RedisClientType): Promise<void> {
  while (true) {
    const acquired = await client.set(PLAY_LOCK_KEY, '1', { NX: true, PX: 120000 });
    if (acquired) return;
    await sleep(100);
  }
}

async function releasePlayLock(client: RedisClientType): Promise<void> {
  await client.del(PLAY_LOCK_KEY);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: aivis <text> [--model <model_uuid>] [--wait <ms>]');
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

  // ロック取得（他のCLIプロセスの再生完了を待つ）
  await acquirePlayLock(client);

  try {
    const service = new AivisSpeechService();
    await service.synthesizeAndPlay(params);
  } finally {
    await releasePlayLock(client);
    await client.disconnect();
  }

  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

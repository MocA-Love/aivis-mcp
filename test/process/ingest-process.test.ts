/**
 * ビルドした `dist/` を実際のプロセスとして動かす（`npm test` の前に `npm run build` が走る）。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RedisClientType } from 'redis';
import { encodeAudio, encodeControl, FrameDecoder } from '../../src/streaming/frame-protocol.js';
import { WORKER_LOCK_KEY, WORKER_VERSION_KEY } from '../../src/queue/keys.js';
import { connect, describeWithRedis, startTestRedis, type TestRedis } from '../helpers/redis.js';
import { mp3Frames } from '../helpers/fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexJs = path.join(root, 'dist', 'index.js');

interface RunResult {
  readonly stdout: Buffer;
  readonly code: number | null;
}

function runIngest(env: NodeJS.ProcessEnv, cwd: string, input: Buffer[], keepOpenMs: number): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [indexJs, '--ingest'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stdin.on('error', () => undefined);
    for (const chunk of input) {
      child.stdin.write(chunk);
    }
    const timer = setTimeout(() => child.stdin.end(), keepOpenMs);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), code });
    });
  });
}

function decodeAll(stdout: Buffer): Record<string, unknown>[] {
  const decoder = new FrameDecoder();
  const frames = decoder.push(stdout);
  // 枠以外が 1 バイトでも混ざると、続きが枠として読めないか余りが残る
  expect(decoder.hasPartialFrame).toBe(false);
  return frames.map(frame => {
    expect(frame.kind).toBe('control');
    return frame.kind === 'control' ? frame.message : {};
  });
}

/** node だけを置いた PATH（redis-server などほかのコマンドを見つけさせない）。 */
function nodeOnlyPath(base: string): string {
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, path.basename(process.execPath)));
  return bin;
}

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('実プロセスの --ingest（Redis 無し）', () => {
  test('Redis も redis-server も無ければ hello と redis-unavailable を出して終わる。cwd に temp/ を作らない', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-proc-'));
    try {
      const port = await freePort();
      const result = await runIngest({
        ...process.env,
        HOME: cwd,
        PATH: nodeOnlyPath(cwd),
        REDIS_URL: `redis://127.0.0.1:${port}`,
      }, cwd, [], 30_000);
      expect(result.code).toBe(1);
      const messages = decodeAll(result.stdout);
      expect(messages).toEqual([
        { type: 'hello', protocol: 1, version: expect.any(String) },
        { type: 'error', reason: 'redis-unavailable' },
      ]);
      expect(fs.existsSync(path.join(cwd, 'temp'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describeWithRedis('実プロセスの --ingest（別ポートの redis-server）', () => {
  let redis: TestRedis;
  let client: RedisClientType;

  beforeAll(async () => {
    redis = await startTestRedis();
    client = await connect(redis.url);
  });

  afterAll(async () => {
    await client.disconnect().catch(() => undefined);
    await redis.stop();
  });

  test('標準出力には枠しか出さない', async () => {
    // 本物の worker を起こさない（新しい版の worker が動いていることにする）
    await client.set(WORKER_LOCK_KEY, 'test-worker', { PX: 60_000 });
    await client.set(WORKER_VERSION_KEY, '99.0.0', { PX: 60_000 });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-proc-'));
    try {
      const result = await runIngest({ ...process.env, HOME: cwd, PATH: nodeOnlyPath(cwd), REDIS_URL: redis.url, AIVIS_DEBUG: '1' }, cwd, [
        encodeControl({ type: 'open', id: 'p1', priority: 'high' }),
        encodeAudio('p1', mp3Frames(20)),
        encodeControl({ type: 'end', id: 'p1' }),
        encodeControl({ type: 'gain?', requestId: 'g' }),
        encodeControl({ type: 'ping', requestId: 1 }),
        encodeControl({ type: 'nope' }),
      ], 1500);
      expect(result.code).toBe(0);
      const messages = decodeAll(result.stdout);
      expect(messages[0]).toEqual({ type: 'hello', protocol: 1, version: expect.any(String) });
      expect(messages.map(message => message.type)).toEqual(expect.arrayContaining(['accepted', 'status', 'gain', 'pong', 'error']));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('音量の読み替えを同時に走らせても 1 回だけ', () => {
  test('8 プロセスが同時に読んでも、上乗せは 1 回分で、ほかの項目も壊れない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-migrate-'));
    const file = path.join(dir, 'config.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ provider: 'elevenlabs', apiKey: 'keep-me', elevenlabs: { volumeDb: -16, voiceId: 'v' } }));
      const settingsJs = path.join(root, 'dist', 'settings.js');
      await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(settingsJs)}); m.loadSettingsWithMigration();`], {
          env: { ...process.env, AIVIS_CONFIG_FILE: file },
          stdio: 'ignore',
        });
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      })));
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
        provider: 'elevenlabs',
        apiKey: 'keep-me',
        elevenlabs: { volumeDb: -16, voiceId: 'v', volumeOffsetDb: -3, volumeMigrated: true },
      });
      expect(fs.readdirSync(dir)).toEqual(['config.json']);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

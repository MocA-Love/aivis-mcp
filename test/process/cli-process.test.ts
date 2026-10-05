/**
 * ビルドした `dist/` の CLI を実際のプロセスとして動かす（`npm test` の前に `npm run build` が走る）。
 * worker の lock を先に置いておき、本物の worker（音を出す）を起こさせない。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RedisClientType } from 'redis';
import { NORMAL_QUEUE_KEY, WORKER_LOCK_KEY, WORKER_VERSION_KEY } from '../../src/queue/keys.js';
import { connect, describeWithRedis, startTestRedis, type TestRedis } from '../helpers/redis.js';
import { mp3Frames } from '../helpers/fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexJs = path.join(root, 'dist', 'index.js');

function run(args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Promise<{ stdout: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [indexJs, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    child.on('exit', code => resolve({ stdout, code }));
  });
}

/** Para Code の環境変数を外した環境（このテストを Para Code の中で走らせても混ざらない）。 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PARA_CODE_TERMINAL_PANE_ID;
  delete env.PARA_CODE_VOICE_TOKEN;
  delete env.PARA_CODE_MCP_PORT_FILE;
  delete env.REDIS_URL;
  return env;
}

describeWithRedis('実プロセスの CLI（別ポートの redis-server）', () => {
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

  beforeEach(async () => {
    await client.flushAll();
    // 新しい版の worker が動いていることにする（起こさない）
    await client.set(WORKER_LOCK_KEY, 'test-worker', { PX: 60_000 });
    await client.set(WORKER_VERSION_KEY, '9.9.9', { PX: 60_000 });
  });

  test('[MEDIUM 22] --play-audio は 2.5 の worker なら q2:normal に積み、--gain-key を添える', async () => {
    const audio = mp3Frames(3);
    const good = await run(['--play-audio', '--gain-key', 'aivis:model-a:default', '--redis-url', redis.url], cleanEnv(), audio);
    expect(good.stdout).toBe('queued\n');
    const bad = await run(['--play-audio', '--gain-key', 'bad key', '--redis-url', redis.url], cleanEnv(), audio);
    expect(bad.stdout).toBe('queued\n');
    const items = (await client.lRange(NORMAL_QUEUE_KEY, 0, -1)).reverse().map(raw => JSON.parse(raw));
    expect(items.map(item => item.gainKey)).toEqual(['aivis:model-a:default', undefined]);
    expect(Buffer.from(items[0]._audioBase64, 'base64').equals(audio)).toBe(true);
    expect(await client.lLen('aivis-mcp:queue')).toBe(0);
  });

  test('[MEDIUM 24] aivis-mcp "<文>" も、要求元の Para Code の転送先を添えて積む', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-cli-'));
    const server = http.createServer((request, response) => {
      if (request.url === '/paradis-mcp/health') {
        response.end(JSON.stringify({ instanceId: 'instance' }));
        return;
      }
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ticket: 'tk-1', expiresAt: Date.now() + 600_000, instanceId: 'instance', localPlayback: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const portFile = path.join(dir, 'port.json');
      fs.writeFileSync(portFile, JSON.stringify({ port: (server.address() as AddressInfo).port }));
      const env = { ...cleanEnv(), PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: portFile };
      const result = await run(['テスト', '--redis-url', redis.url], env);
      expect(result.code).toBe(0);
      const [raw] = await client.lRange(NORMAL_QUEUE_KEY, 0, -1);
      const job = JSON.parse(raw);
      expect(job.params.text).toBe('テスト');
      expect(job.params._paraCodeVoiceTarget).toMatchObject({ ticket: 'tk-1', localPlayback: true });
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

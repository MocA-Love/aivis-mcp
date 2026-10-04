import { spawn, spawnSync, type ChildProcess } from 'child_process';
import net from 'net';
import { createClient, type RedisClientType } from 'redis';

/** redis-server があるか（無ければ結合テストを飛ばす）。 */
export const hasRedisServer = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['redis-server'], { stdio: 'ignore' }).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface TestRedis {
  readonly url: string;
  stop(): Promise<void>;
}

/** 手元の 6379 には触らず、空いているポートで使い捨ての redis-server を起こす。 */
export async function startTestRedis(): Promise<TestRedis> {
  const port = await freePort();
  const child: ChildProcess = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  const url = `redis://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    const client = createClient({ url });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
      await client.disconnect();
      break;
    } catch {
      await client.disconnect().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return {
    url,
    stop: () => new Promise<void>(resolve => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    }),
  };
}

export async function connect(url: string): Promise<RedisClientType> {
  const client = createClient({ url }) as RedisClientType;
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

export async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false as unknown) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

/**
 * redis-server を使う結合テストの describe。手元に無ければ飛ばすが、CI（`CI` がある）で無いときは
 * 黙って飛ばさず失敗させる。
 */
export function describeWithRedis(name: string, body: () => void): void {
  if (hasRedisServer) {
    describe(name, body);
  } else if (process.env.CI) {
    describe(name, () => {
      test('CI では redis-server が必要', () => {
        throw new Error('redis-server が見つかりません（CI では結合テストを飛ばしません）');
      });
    });
  } else {
    describe.skip(name, body);
  }
}

import net from 'net';

/**
 * redis-server との間に挟む TCP の中継。Redis の障害を真似る。
 *
 * - `holdResponses()`: 要求は届けるが、応答を止める（Redis は実行するが、返事が返らない）
 * - `stall()`: 両方向を止める（Redis が応答しない）
 * - `release()`: 止めた分をまとめて流して再開する
 * - `cut()`: いまの接続を全部切る
 */
export interface RedisProxy {
  readonly url: string;
  holdResponses(): void;
  stall(): void;
  release(): void;
  cut(): void;
  close(): Promise<void>;
}

interface Pair {
  readonly client: net.Socket;
  readonly upstream: net.Socket;
  readonly toUpstream: Buffer[];
  readonly toClient: Buffer[];
}

export async function startRedisProxy(targetUrl: string): Promise<RedisProxy> {
  const target = new URL(targetUrl);
  const pairs = new Set<Pair>();
  let holdingResponses = false;
  let stalled = false;
  const server = net.createServer(client => {
    const upstream = net.connect(Number(target.port), target.hostname);
    const pair: Pair = { client, upstream, toUpstream: [], toClient: [] };
    pairs.add(pair);
    client.on('data', (chunk: Buffer) => {
      if (stalled) {
        pair.toUpstream.push(chunk);
      } else {
        upstream.write(chunk);
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      if (stalled || holdingResponses) {
        pair.toClient.push(chunk);
      } else {
        client.write(chunk);
      }
    });
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const proxy: RedisProxy = {
    url: `redis://127.0.0.1:${port}`,
    holdResponses() {
      holdingResponses = true;
    },
    stall() {
      stalled = true;
    },
    release() {
      holdingResponses = false;
      stalled = false;
      for (const pair of pairs) {
        for (const chunk of pair.toUpstream.splice(0)) {
          pair.upstream.write(chunk);
        }
        for (const chunk of pair.toClient.splice(0)) {
          pair.client.write(chunk);
        }
      }
    },
    cut() {
      for (const { client, upstream } of [...pairs]) {
        client.destroy();
        upstream.destroy();
      }
      pairs.clear();
    },
    close() {
      proxy.cut();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  return proxy;
}

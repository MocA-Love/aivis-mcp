import http from 'http';
import type { AddressInfo } from 'net';
import { startParaCodeForward } from '../../src/worker/para-code-forward.js';
import type { ParaCodeVoiceTarget } from '../../src/services/para-code-voice.js';

interface Received {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

async function withServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, received: Received[]) => void,
  run: (port: number, received: Received[]) => Promise<void>,
): Promise<void> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => handler(request, response, received));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port, received);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function target(port: number, extra: Partial<ParaCodeVoiceTarget>): ParaCodeVoiceTarget {
  return { ticket: 'ticket', port, instanceId: 'instance', expiresAt: Date.now() + 60_000, ...extra };
}

function collect(request: http.IncomingMessage, received: Received[], done?: () => void): void {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    received.push({ headers: request.headers, body: Buffer.concat(chunks) });
    done?.();
  });
}

const current = async () => true;

describe('Para Code への送り出し', () => {
  test('stream-v1: chunked で送り、accepted のヘッダーを見たら自分では鳴らさない', async () => {
    await withServer((request, response, received) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      collect(request, received, () => response.end());
    }, async (port, received) => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current });
      forward.push(Buffer.from([1, 2]));
      // ヘッダーは本文の終わりを待たずに来る
      expect(await forward.decision).toBe('remote');
      forward.push(Buffer.from([3]));
      forward.end();
      await forward.settled;
      expect(received[0].headers['transfer-encoding']).toBe('chunked');
      expect(received[0].headers['content-length']).toBeUndefined();
      expect(received[0].headers.authorization).toBe('Bearer ticket');
      expect([...received[0].body]).toEqual([1, 2, 3]);
    });
  });

  test('stream-v1: ヘッダーが 1 つも来ないまま接続に失敗したら自分で鳴らす', async () => {
    await withServer(request => {
      request.socket.destroy();
    }, async port => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current });
      forward.push(Buffer.from([1]));
      expect(await forward.decision).toBe('local');
      await forward.settled;
    });
  });

  test('stream-v1: accepted が無い応答なら自分で鳴らす', async () => {
    await withServer((request, response, received) => {
      collect(request, received, () => response.end('{}'));
    }, async port => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current });
      forward.push(Buffer.from([1]));
      forward.end();
      expect(await forward.decision).toBe('local');
    });
  });

  test('stream-v1: ヘッダーの後に止まったら諦める（鳴らし直さない）', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      // 本文を読まず、応答も閉じない
    }, async port => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current, idleTimeoutMs: 200 });
      forward.push(Buffer.from([1]));
      forward.end();
      expect(await forward.decision).toBe('remote');
      await forward.settled;
    });
  });

  test('手元の Para Code（localPlayback 無し）は待たずにこの機械で鳴らす', async () => {
    await withServer((request, response, received) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      collect(request, received, () => response.end());
    }, async (port, received) => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1' }), { isCurrentInstance: current });
      expect(await forward.decision).toBe('local');
      forward.push(Buffer.from([9]));
      forward.end();
      await forward.settled;
      expect([...received[0].body]).toEqual([9]);
    });
  });

  test('stream-v1 が無ければ今どおり、全部受け取ってから Content-Length 付きで送る', async () => {
    await withServer((request, response, received) => {
      collect(request, received, () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ localPlayback: true }));
      });
    }, async (port, received) => {
      const forward = startParaCodeForward(target(port, { localPlayback: true }), { isCurrentInstance: current });
      forward.push(Buffer.from([1, 2]));
      forward.push(Buffer.from([3]));
      forward.end();
      expect(await forward.decision).toBe('remote');
      expect(received[0].headers['content-length']).toBe('3');
      expect(received[0].headers['transfer-encoding']).toBeUndefined();
    });
  });

  test('Para Code が今の instance でなければ送らずに自分で鳴らす', async () => {
    await withServer((request, response, received) => {
      collect(request, received, () => response.end());
    }, async (port, received) => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: async () => false });
      forward.push(Buffer.from([1]));
      forward.end();
      expect(await forward.decision).toBe('local');
      await forward.settled;
      expect(received).toHaveLength(0);
    });
  });

  test('8MiB を超えたら送るのをやめる', async () => {
    await withServer((request, response, received) => {
      collect(request, received, () => response.end());
    }, async port => {
      const forward = startParaCodeForward(target(port, { localPlayback: true }), { isCurrentInstance: current, maxBytes: 4 });
      forward.push(Buffer.alloc(5));
      forward.end();
      expect(await forward.decision).toBe('local');
    });
  });
});

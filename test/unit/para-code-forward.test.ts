import http from 'http';
import type { AddressInfo } from 'net';
import { startParaCodeForward } from '../../src/worker/para-code-forward.js';
import { isParaCodeVoiceTarget, type ParaCodeVoiceTarget } from '../../src/services/para-code-voice.js';

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

  test('stream-v1: 引き受け・明示の拒否・不明を分ける（不明は本文の localPlayback で決め、無ければ鳴らさない）', async () => {
    const cases: { readonly respond: (response: http.ServerResponse) => void; readonly expected: string }[] = [
      // ヘッダーは来たが accepted も rejected も無く、本文にも答えが無い（不明）。二重に鳴らさない
      { respond: response => response.end('{}'), expected: 'remote' },
      { respond: response => response.end(JSON.stringify({ localPlayback: false })), expected: 'local' },
      // ticket が通らない（期限切れ・使用済み）は拒否ではなく、送れなかった
      { respond: response => { response.writeHead(401); response.end(); }, expected: 'unavailable' },
      { respond: response => { response.writeHead(503); response.end(); }, expected: 'local' },
      { respond: response => { response.writeHead(200, { 'X-Para-Local-Playback': 'rejected' }); response.end(); }, expected: 'local' },
    ];
    for (const { respond, expected } of cases) {
      await withServer((request, response, received) => {
        collect(request, received, () => respond(response));
      }, async port => {
        const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current });
        forward.push(Buffer.from([1]));
        forward.end();
        expect(await forward.outcome).toBe(expected);
      });
    }
  });

  test('[最終レビュー MEDIUM] localPlayback の ticket では 404 も ticket が通らなかったとみなし、接続先で鳴らさない', async () => {
    const cases: { readonly extra: Partial<ParaCodeVoiceTarget>; readonly expected: string }[] = [
      { extra: { ingress: 'stream-v1', localPlayback: true }, expected: 'unavailable' },
      { extra: { localPlayback: true }, expected: 'unavailable' },
      // localPlayback の無い ticket（手元の Para Code）は今どおり
      { extra: { ingress: 'stream-v1' }, expected: 'local' },
      { extra: {}, expected: 'local' },
    ];
    const results: string[] = [];
    for (const { extra } of cases) {
      await withServer((request, response, received) => {
        collect(request, received, () => { response.writeHead(404); response.end(); });
      }, async port => {
        const forward = startParaCodeForward(target(port, extra), { isCurrentInstance: current });
        forward.push(Buffer.from([1]));
        forward.end();
        results.push(await forward.outcome);
      });
    }
    expect(results).toEqual(cases.map(({ expected }) => expected));
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

  test('音量の表の鍵を X-Para-Gain-Key で送る（安全な文字だけ）', async () => {
    await withServer((request, response, received) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      collect(request, received, () => response.end());
    }, async (port, received) => {
      for (const [gainKey, ingress] of [['aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default', 'stream-v1'], ['elevenlabs:voice:eleven_v3', undefined], ['bad key\r\nX: y', 'stream-v1']] as const) {
        const forward = startParaCodeForward(target(port, { ingress, localPlayback: true }), { isCurrentInstance: current, gainKey });
        forward.push(Buffer.from([1]));
        forward.end();
        await forward.settled;
      }
      expect(received.map(entry => entry.headers['x-para-gain-key'])).toEqual(['aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default', 'elevenlabs:voice:eleven_v3', undefined]);
    });
  });

  test('[MEDIUM 21] 引き受けた後に本文で localPlayback:false が返ったら、最終の判定は自分で鳴らす', async () => {
    await withServer((request, response, received) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      collect(request, received, () => response.end(JSON.stringify({ localPlayback: false })));
    }, async port => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current });
      forward.push(Buffer.from([1]));
      expect(await forward.decision).toBe('remote');
      forward.end();
      expect(await forward.outcome).toBe('local');
    });
  });

  test('[MEDIUM 23] 感情タグ入りの発話には X-Para-Tagged: 1 を付ける（どちらの送り方でも）', async () => {
    await withServer((request, response, received) => {
      collect(request, received, () => response.end(JSON.stringify({ localPlayback: false })));
    }, async (port, received) => {
      for (const [ingress, tagged] of [['stream-v1', true], [undefined, true], ['stream-v1', false]] as const) {
        const forward = startParaCodeForward(target(port, { ingress, localPlayback: true }), { isCurrentInstance: current, tagged });
        forward.push(Buffer.from([1]));
        forward.end();
        await forward.settled;
      }
      expect(received.map(entry => entry.headers['x-para-tagged'])).toEqual(['1', '1', undefined]);
    });
  });

  test('[HIGH 4] 引き受けの後に応答が途中で切れても、判定と終わりは必ず決まる', async () => {
    await withServer((request, response) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.write('{"localPl');
      // 本文の途中で切る
      setTimeout(() => request.socket.destroy(), 50);
    }, async port => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current });
      forward.push(Buffer.from([1]));
      forward.end();
      expect(await forward.decision).toBe('remote');
      // 引き受け済みなので、切れても Para Code に任せる
      expect(await forward.outcome).toBe('remote');
      await forward.settled;
    });
  });

  test('[HIGH 4] ヘッダーの後に止まったままでも、全体の締切で終える', async () => {
    await withServer((request, response) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      // 本文を少しずつ送り続ける（無通信にならない）が、終えない
      const timer = setInterval(() => response.write(' '), 50);
      request.socket.once('close', () => clearInterval(timer));
    }, async port => {
      const forward = startParaCodeForward(target(port, { ingress: 'stream-v1', localPlayback: true }), { isCurrentInstance: current, totalTimeoutMs: 500 });
      forward.push(Buffer.from([1]));
      forward.end();
      const started = Date.now();
      await forward.settled;
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await forward.outcome).toBe('remote');
    });
  });

  test('[LOW 27] ヘッダーに書けない ticket でも例外で落ちず、自分で鳴らす', async () => {
    await withServer((request, response, received) => {
      collect(request, received, () => response.end());
    }, async (port, received) => {
      const bad = target(port, { ingress: 'stream-v1', localPlayback: true, ticket: 'bad\r\nX-Injected: 1' });
      expect(isParaCodeVoiceTarget(bad)).toBe(false);
      const forward = startParaCodeForward(bad, { isCurrentInstance: current });
      forward.push(Buffer.from([1]));
      forward.end();
      expect(await forward.decision).toBe('local');
      await forward.settled;
      expect(received).toHaveLength(0);
    });
  });

  test('[MEDIUM 20] ticket を後から受け取る送り出し: 受け取るまで溜めて送る。取れなければ unavailable', async () => {
    await withServer((request, response, received) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      collect(request, received, () => response.end());
    }, async (port, received) => {
      let provide!: (value: ReturnType<typeof target> | undefined) => void;
      const later = new Promise<ReturnType<typeof target> | undefined>(resolve => { provide = resolve; });
      const forward = startParaCodeForward(later, { isCurrentInstance: current });
      forward.push(Buffer.from([1, 2]));
      forward.push(Buffer.from([3]));
      forward.end();
      provide(target(port, { ingress: 'stream-v1', localPlayback: true }));
      expect(await forward.decision).toBe('remote');
      await forward.settled;
      expect([...received[0].body]).toEqual([1, 2, 3]);

      const none = startParaCodeForward(Promise.resolve(undefined), { isCurrentInstance: current });
      none.push(Buffer.from([1]));
      none.end();
      expect(await none.decision).toBe('unavailable');
    });
  });
});


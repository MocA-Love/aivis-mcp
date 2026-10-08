import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import {
  captureParaCodeVoiceTarget, captureParaCodeVoiceTargetDetailed, isParaCodeVoiceTarget, isRemoteParaCodePane, LOCAL_TIMEOUT_MS, mobileListening,
  releaseParaCodeVoiceTicket, requestParaCodeInstanceId,
} from '../../src/services/para-code-voice.js';

async function withServer(handler: http.RequestListener, run: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('Para Code の ticket と health', () => {
  test('[HIGH 4] health の応答が途中で切れても、待ち続けずに終わる', async () => {
    await withServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"instanceId":"ins');
      setTimeout(() => request.socket.destroy(), 30);
    }, async port => {
      const started = Date.now();
      expect(await requestParaCodeInstanceId(port, 5000)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  test('[HIGH 4] ヘッダーの後に少しずつ送り続けられても、全体の締切で終わる', async () => {
    await withServer((request, response) => {
      response.writeHead(200);
      const timer = setInterval(() => response.write(' '), 20);
      request.socket.once('close', () => clearInterval(timer));
    }, async port => {
      const started = Date.now();
      expect(await requestParaCodeInstanceId(port, 300)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(1500);
    });
  });

  test('[LOW 27] ヘッダーに書けない ticket が返っても受け取らない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-pc-'));
    try {
      await withServer((request, response) => {
        if (request.url === '/paradis-mcp/health') {
          response.end(JSON.stringify({ instanceId: 'instance' }));
          return;
        }
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ticket: 'a\r\nb', expiresAt: Date.now() + 60_000, instanceId: 'instance', localPlayback: true }));
      }, async port => {
        const portFile = path.join(dir, 'port.json');
        fs.writeFileSync(portFile, JSON.stringify({ port }));
        const env = { PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: portFile };
        expect(isRemoteParaCodePane(env)).toBe(true);
        expect(await captureParaCodeVoiceTarget(env)).toBeUndefined();
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('[再々レビュー LOW 3] 覚えた instanceId で取れなければ、その依頼は諦めて捨て、次の依頼で health から取り直す', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-pc-'));
    let instance = 'i1';
    let health = 0;
    try {
      await withServer((request, response) => {
        if (request.url === '/paradis-mcp/health') {
          health++;
          response.end(JSON.stringify({ instanceId: instance }));
          return;
        }
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ticket: 't', expiresAt: Date.now() + 600_000, instanceId: instance }));
      }, async port => {
        const portFile = path.join(dir, 'port.json');
        fs.writeFileSync(portFile, JSON.stringify({ port }));
        const env = { PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: portFile };
        const cache = {};
        expect(await captureParaCodeVoiceTarget(env, cache)).toMatchObject({ instanceId: 'i1' });
        expect(await captureParaCodeVoiceTarget(env, cache)).toMatchObject({ instanceId: 'i1' });
        expect(health).toBe(1);
        // Para Code が起動し直した
        instance = 'i2';
        expect(await captureParaCodeVoiceTarget(env, cache)).toBeUndefined();
        expect(health).toBe(1);
        expect(await captureParaCodeVoiceTarget(env, cache)).toMatchObject({ instanceId: 'i2' });
        expect(health).toBe(2);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('[Q309] モバイルの宛先の数と ticket を返せるかを読み、壊れた値は受け取らない', () => {
    const base = { ticket: 't', port: 1, instanceId: 'i', expiresAt: Date.now() + 60_000 };
    expect(isParaCodeVoiceTarget({ ...base, mobileListeners: 2, release: true })).toBe(true);
    expect(isParaCodeVoiceTarget({ ...base, mobileListeners: -1 })).toBe(false);
    expect(isParaCodeVoiceTarget({ ...base, mobileListeners: 1.5 })).toBe(false);
    expect(isParaCodeVoiceTarget({ ...base, release: 'yes' })).toBe(false);
    expect([mobileListening({ ...base, mobileListeners: 1 }), mobileListening({ ...base, mobileListeners: 0 }), mobileListening(base)]).toEqual([true, false, undefined]);
  });

  test('[Q309 案 4] 手元の ticket は 1 秒まで待ち、取れなかった理由を返す', async () => {
    expect(LOCAL_TIMEOUT_MS).toBe(1_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-pc-'));
    try {
      await withServer((request, response) => {
        if (request.url === '/paradis-mcp/health') {
          response.end(JSON.stringify({ instanceId: 'instance' }));
          return;
        }
        response.writeHead(429);
        response.end();
      }, async port => {
        const portFile = path.join(dir, 'port.json');
        fs.writeFileSync(portFile, JSON.stringify({ port }));
        const env = { PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: portFile };
        expect(await captureParaCodeVoiceTargetDetailed(env)).toEqual({ reason: 'status-429' });
        expect(await captureParaCodeVoiceTargetDetailed({})).toEqual({ reason: 'no-env' });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('[Q309 案 4] 使わなかった ticket は、Para Code が release を名乗ったときだけ返す', async () => {
    const released: string[] = [];
    await withServer((request, response) => {
      released.push(`${request.url} ${request.headers.authorization}`);
      response.writeHead(204);
      response.end();
    }, async port => {
      const target = { ticket: 'unused', port, instanceId: 'i', expiresAt: Date.now() + 60_000 };
      expect(await releaseParaCodeVoiceTicket(target)).toBe(false);
      expect(await releaseParaCodeVoiceTicket({ ...target, release: true, expiresAt: Date.now() - 1 })).toBe(false);
      expect(await releaseParaCodeVoiceTicket({ ...target, release: true })).toBe(true);
    });
    expect(released).toEqual(['/paradis-mcp/mobile-voice-ticket/release Bearer unused']);
  });
});

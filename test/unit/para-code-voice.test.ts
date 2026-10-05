import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { captureParaCodeVoiceTarget, isRemoteParaCodePane, requestParaCodeInstanceId } from '../../src/services/para-code-voice.js';

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
});


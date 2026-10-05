import http from 'http';
import type { AddressInfo } from 'net';
import { synthesizeStream } from '../../src/audio/synthesize.js';
import { testConfig } from '../helpers/fixtures.js';

describe('合成の要求', () => {
  test('[MEDIUM 19] Aivis へ送る本文に先頭の無音（break）を足さない', async () => {
    const bodies: string[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        response.end('');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const config = { ...testConfig('redis://127.0.0.1:9'), apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const stream = await synthesizeStream(config, { text: 'こんにちは' });
      stream.resume();
      expect(JSON.parse(bodies[0]).text).toBe('こんにちは');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('[MEDIUM 8] 中断の印で、応答を待っている要求を取り消す', async () => {
    const server = http.createServer(() => {
      // 応答しない
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const config = { ...testConfig('redis://127.0.0.1:9'), apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const controller = new AbortController();
      const pending = synthesizeStream(config, { text: 'x' }, controller.signal);
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toBeDefined();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

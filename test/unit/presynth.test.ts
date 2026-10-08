import fs from 'fs';
import os from 'os';
import path from 'path';
import { jobsInDequeueOrder, prevVoiceBefore, SynthesisGate } from '../../src/worker/presynth.js';
import { routeLog, routeLogFile, ROUTE_LOG_MAX_BYTES } from '../../src/services/route-log.js';
import type { Job } from '../../src/queue/jobs.js';

function raw(id: string, type: 'synth' | 'stream' | 'sound' = 'synth'): string {
  const base = { v: 2, id, priority: 'normal', source: type === 'synth' ? 'agent' : 'ingest', enqueuedAt: 1 };
  if (type === 'sound') {
    return JSON.stringify({ ...base, type, prelude: { path: '/tmp/a.wav', volume: 1 } });
  }
  return JSON.stringify(type === 'synth' ? { ...base, type, params: { text: id } } : { ...base, type });
}

describe('モバイルへの先送り（Q309 A）の部品', () => {
  test('合成の番は 1 本ずつで、PC の番を先送りより先に通す', async () => {
    const gate = new SynthesisGate();
    const order: string[] = [];
    const first = await gate.acquire('presynth');
    const waiting = [
      gate.acquire('presynth').then(release => { order.push('presynth-1'); release(); }),
      gate.acquire('presynth').then(release => { order.push('presynth-2'); release(); }),
      gate.acquire('main').then(release => { order.push('main'); release(); }),
    ];
    first();
    first();
    await Promise.all(waiting);
    expect(order).toEqual(['main', 'presynth-1', 'presynth-2']);
  });

  test('先送りの件に PC の順番が来たら、その待ちを PC の番に上げる', async () => {
    const gate = new SynthesisGate();
    const order: string[] = [];
    const first = await gate.acquire('main');
    const waiting = ['a', 'b', 'c'].map(key => gate.acquire('presynth', key).then(release => { order.push(key); release(); }));
    gate.promote('c');
    gate.promote('missing');
    first();
    await Promise.all(waiting);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  test('列は worker が取り出す順（high の古い順 → normal の古い順）に並べ、聞こえる順で直前の声を選ぶ', () => {
    // LPUSH で積むので、LRANGE は新しい順
    const jobs: Job[] = jobsInDequeueOrder([raw('h2'), raw('h1')], [raw('n3'), raw('sound', 'sound'), raw('n2', 'stream'), raw('n1'), '{broken']);
    expect(jobs.map(job => job.id)).toEqual(['h1', 'h2', 'n1', 'n2', 'sound', 'n3']);
    expect(prevVoiceBefore(jobs, 0, 'current')).toBe('current');
    expect(prevVoiceBefore(jobs, 2, 'current')).toBe('h2');
    // 着信音だけの件は飛ばす
    expect(prevVoiceBefore(jobs, 5, 'current')).toBe('n2');
  });

  test('[Q309 案 5] 判断の跡は 1 行ずつ、ID・数・理由だけを書き、大きくなったら 1 つ前へ回す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-route-'));
    const file = path.join(dir, 'logs', 'route.log');
    try {
      routeLog('presynth.start', { job: '1a2b3c4d', listeners: 1, reason: 'a b\nc', skipped: undefined }, file);
      const line = fs.readFileSync(file, 'utf8');
      expect(line).toMatch(/^\S+ \d+ presynth\.start job=1a2b3c4d listeners=1 reason=a_b_c\n$/);
      fs.writeFileSync(file, 'x'.repeat(ROUTE_LOG_MAX_BYTES));
      routeLog('ticket.none', { reason: 'timeout' }, file);
      expect(fs.readFileSync(`${file}.1`, 'utf8').length).toBe(ROUTE_LOG_MAX_BYTES);
      expect(fs.readFileSync(file, 'utf8')).toContain('ticket.none reason=timeout');
      expect(routeLogFile({ AIVIS_ROUTE_LOG_FILE: 'off' })).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

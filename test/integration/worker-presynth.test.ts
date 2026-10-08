import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import type { RedisClientType } from 'redis';
import { PlaybackWorker, type WorkerTimings } from '../../src/worker/playback-worker.js';
import { AudioStreamWriter } from '../../src/queue/audio-stream.js';
import { enqueueJob, enqueueSynthesis } from '../../src/queue/enqueue.js';
import { clearHold, setHold } from '../../src/queue/hold.js';
import { audioStreamKey, presynthKey } from '../../src/queue/keys.js';
import { readStatuses } from '../../src/queue/status.js';
import { setMute } from '../../src/services/mute-service.js';
import type { ParaCodeVoiceTarget } from '../../src/services/para-code-voice.js';
import { connect, describeWithRedis, startTestRedis, waitFor, type TestRedis } from '../helpers/redis.js';
import { FakeBackend } from '../helpers/fake-backend.js';
import { mp3Frames, testConfig } from '../helpers/fixtures.js';

type Synthesize = ((config: unknown, params: Record<string, unknown>, signal?: AbortSignal) => Promise<NodeJS.ReadableStream>) & { forgetContext?: () => void };

describeWithRedis('モバイルへの先送り（Q309 A、別ポートの redis-server）', () => {
  let redis: TestRedis;
  let client: RedisClientType;
  let tempDir: string;
  const workers: PlaybackWorker[] = [];
  const runs: Promise<unknown>[] = [];
  const cleanups: (() => Promise<void>)[] = [];

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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-presynth-')));
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      worker.stop();
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    await Promise.allSettled(runs.splice(0));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** 合成の呼び出しと文脈の消去を順に記録する偽の合成（文ごとに違う中身）。 */
  function recordingSynthesizer(events: string[]): Synthesize {
    const synthesize: Synthesize = async (_config, params) => {
      events.push(`synth:${String(params.text)}`);
      return Readable.from([mp3Frames(20, String(params.text).length)]);
    };
    synthesize.forgetContext = () => { events.push('forget'); };
    return synthesize;
  }

  function startWorker(backend: FakeBackend, synthesize: Synthesize, timings: Partial<WorkerTimings> = {}): PlaybackWorker {
    const worker = new PlaybackWorker({
      redisUrl: redis.url,
      version: '2.6.0',
      loadConfig: () => testConfig(redis.url),
      backend,
      synthesize: synthesize as never,
      gainFile: path.join(tempDir, 'gain.json'),
      timings: { presynthScanMs: 30, ...timings },
    });
    workers.push(worker);
    runs.push(worker.run());
    return worker;
  }

  async function lastStatus(id: string): Promise<string | undefined> {
    const { entries } = await readStatuses(client, id, 0);
    return entries[entries.length - 1]?.status;
  }

  async function finalStatus(id: string, timeoutMs = 10_000): Promise<{ status: string; reason?: string }> {
    return waitFor(async () => {
      const { entries } = await readStatuses(client, id, 0);
      const last = entries[entries.length - 1];
      return last && !['queued', 'dequeued', 'requeued', 'playing'].includes(last.status) ? { status: last.status, reason: last.reason } : undefined;
    }, timeoutMs);
  }

  /** 偽の Para Code。音声を受け取った時刻と、返された ticket を記録する。 */
  async function fakeParaCode(): Promise<{ port: number; bodies: { at: number; bytes: Buffer }[]; released: string[]; opened: number[] }> {
    const bodies: { at: number; bytes: Buffer }[] = [];
    const released: string[] = [];
    const opened: number[] = [];
    const server = http.createServer((request, response) => {
      if (request.url === '/paradis-mcp/health') {
        response.end(JSON.stringify({ instanceId: 'instance' }));
        return;
      }
      if (request.url === '/paradis-mcp/mobile-voice-ticket/release') {
        released.push(String(request.headers.authorization ?? '').replace(/^Bearer /, ''));
        response.writeHead(204);
        response.end();
        return;
      }
      opened.push(Date.now());
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        bodies.push({ at: Date.now(), bytes: Buffer.concat(chunks) });
        response.end(JSON.stringify({ localPlayback: false }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    return { port: (server.address() as AddressInfo).port, bodies, released, opened };
  }

  /** モバイルへ送るだけの ticket（手元のペイン）。 */
  function mobileTarget(port: number, extra: Partial<ParaCodeVoiceTarget> = {}): ParaCodeVoiceTarget {
    return { ticket: `ticket-${uuidv4()}`, port, instanceId: 'instance', expiresAt: Date.now() + 300_000, ingress: 'stream-v1', muteAware: true, ...extra };
  }

  test('PC で鳴らしている間に、モバイルが聞いている声を先に合成して送り、順番が来たら同じ音声を PC で鳴らす（合成は 1 回）', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend({ voiceMs: 1500 });
    startWorker(backend, recordingSynthesizer(events));
    const busy = await enqueueSynthesis(client, { text: '長い発話', provider: 'aivis' });
    await waitFor(async () => (await lastStatus(busy.id)) === 'playing' || undefined);
    const queued = await enqueueSynthesis(client, { text: 'モバイルへ先に', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1, release: true }) });
    await waitFor(() => paraCode.bodies.length === 1 || undefined);
    // PC は前の発話をまだ鳴らしている
    expect(await lastStatus(busy.id)).toBe('playing');
    expect(await client.exists(presynthKey(queued.id))).toBe(1);
    expect(await finalStatus(queued.id)).toEqual({ status: 'done' });
    expect(events.filter(event => event.startsWith('synth:'))).toEqual(['synth:長い発話', 'synth:モバイルへ先に']);
    expect(backend.voices.map(voice => voice.bytes.length)).toEqual([417 * 20, 417 * 20]);
    expect(backend.voices[1].bytes.equals(paraCode.bodies[0].bytes)).toBe(true);
    expect(backend.maxActive).toBe(1);
    // 使った ticket は返さない。鳴らし終えたら Stream と印を消す
    expect(paraCode.released).toEqual([]);
    await waitFor(async () => (await client.exists([audioStreamKey(queued.id), presynthKey(queued.id)])) === 0 || undefined);
  });

  test('Para Code がモバイルの宛先を名乗らない（古い）・0 と答えた声は先送りせず、今どおり順番が来てから合成して送る', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend({ voiceMs: 800 });
    startWorker(backend, recordingSynthesizer(events));
    const busy = await enqueueSynthesis(client, { text: '長い発話', provider: 'aivis' });
    await waitFor(async () => (await lastStatus(busy.id)) === 'playing' || undefined);
    const legacy = await enqueueSynthesis(client, { text: '古い', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port) });
    const silent = await enqueueSynthesis(client, { text: '聞いていない', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 0 }) });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(paraCode.bodies).toHaveLength(0);
    expect(await finalStatus(legacy.id)).toEqual({ status: 'done' });
    expect(await finalStatus(silent.id)).toEqual({ status: 'done' });
    expect(paraCode.bodies).toHaveLength(2);
    expect(events.filter(event => event.startsWith('synth:'))).toEqual(['synth:長い発話', 'synth:古い', 'synth:聞いていない']);
  });

  test('期限切れの声は PC で鳴らさないが、モバイルが聞いていれば合成して送る。聞いていなければ合成せず ticket を返す', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend();
    const old = Date.now() - 200_000;
    const listening = mobileTarget(paraCode.port, { mobileListeners: 2, release: true });
    const notListening = mobileTarget(paraCode.port, { mobileListeners: 0, release: true });
    const unknown = mobileTarget(paraCode.port);
    const ids = [uuidv4(), uuidv4(), uuidv4()];
    for (const [index, target] of [listening, notListening, unknown].entries()) {
      await enqueueJob(client, { v: 2, type: 'synth', id: ids[index], priority: 'normal', source: 'agent', enqueuedAt: old, params: { text: `期限切れ${index}`, provider: 'aivis', _paraCodeVoiceTarget: target } });
    }
    startWorker(backend, recordingSynthesizer(events));
    for (const id of ids) {
      expect(await finalStatus(id)).toEqual({ status: 'skipped', reason: 'expired' });
    }
    await waitFor(() => paraCode.bodies.length === 1 || undefined);
    await waitFor(() => paraCode.released.length === 1 || undefined);
    expect(paraCode.released).toEqual([notListening.ticket]);
    expect(events.filter(event => event.startsWith('synth:'))).toEqual(['synth:期限切れ0']);
    expect(backend.voices).toHaveLength(0);
  });

  test('[Q209 B] hold の間に先送りした声は、ミュートで PC では鳴らさず、合成し直さない', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend();
    await setHold(client, 'mic');
    startWorker(backend, recordingSynthesizer(events));
    const job = await enqueueSynthesis(client, { text: '席を外している間', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) });
    await waitFor(() => paraCode.bodies.length === 1 || undefined);
    await setMute(client, undefined);
    await clearHold(client, 'mic');
    expect(await finalStatus(job.id)).toEqual({ status: 'muted', reason: 'forwarded' });
    expect(events.filter(event => event.startsWith('synth:'))).toEqual(['synth:席を外している間']);
    expect(backend.voices).toHaveLength(0);
  });

  test('ElevenLabs の文脈は聞こえる順でつなぐ。先送りの間に取込の声が入る発話はつながない', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend({ voiceMs: 1200 });
    startWorker(backend, recordingSynthesizer(events));
    const busy = await enqueueSynthesis(client, { text: 'A', provider: 'aivis' });
    await waitFor(async () => (await lastStatus(busy.id)) === 'playing' || undefined);
    const first = await enqueueSynthesis(client, { text: 'B', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) });
    // 取込の声（Para Code の通知）が B と C の間に入る
    const ingestId = uuidv4();
    const writer = new AudioStreamWriter(client, ingestId);
    await writer.open();
    writer.write(mp3Frames(5));
    await writer.end();
    await writer.settled();
    await enqueueJob(client, { v: 2, type: 'stream', id: ingestId, priority: 'normal', source: 'ingest', enqueuedAt: Date.now() });
    const second = await enqueueSynthesis(client, { text: 'C', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) });
    for (const id of [busy.id, first.id, ingestId, second.id]) {
      expect((await finalStatus(id)).status).toBe('done');
    }
    // A の後の B はつなぐ（forget が無い）。取込の声を挟む C の前では消す
    const synthOrder = events;
    const indexB = synthOrder.indexOf('synth:B');
    const indexC = synthOrder.indexOf('synth:C');
    expect(synthOrder[indexB - 1]).toBe('synth:A');
    expect(synthOrder[indexC - 1]).toBe('forget');
    expect(paraCode.bodies).toHaveLength(2);
  });

  test('入れ替わる前の worker が先送りした件は、合成し直さず Stream から鳴らす（モバイルへ二重に送らない）', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend();
    const id = uuidv4();
    const writer = new AudioStreamWriter(client, id);
    await writer.open();
    writer.write(mp3Frames(12));
    await writer.end();
    await writer.settled();
    await client.set(presynthKey(id), '1', { EX: 600 });
    await enqueueJob(client, { v: 2, type: 'synth', id, priority: 'normal', source: 'agent', enqueuedAt: Date.now(), params: { text: '引き継ぎ', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) } });
    startWorker(backend, recordingSynthesizer(events));
    expect(await finalStatus(id)).toEqual({ status: 'done' });
    expect(events.filter(event => event.startsWith('synth:'))).toEqual([]);
    expect(backend.voices.map(voice => voice.bytes.length)).toEqual([417 * 12]);
    expect(paraCode.bodies).toHaveLength(0);
    expect(await client.exists([audioStreamKey(id), presynthKey(id)])).toBe(0);
  });

  test('先送りの送り出しは合成の番が来てからつなぐ（PC の番の合成が長くても Para Code の最初の音の待ちを使い切らない）', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    let slowEnded = 0;
    const synthesize: Synthesize = async (_config, params) => {
      events.push(`synth:${String(params.text)}`);
      if (params.text !== '遅い合成') {
        return Readable.from([mp3Frames(20)]);
      }
      // 最初の音はすぐ、終わりは 1.2 秒後（PC は鳴らし始めている）
      const stream = new PassThrough();
      stream.write(mp3Frames(20));
      setTimeout(() => {
        slowEnded = Date.now();
        stream.end(mp3Frames(5));
      }, 1200);
      return stream;
    };
    synthesize.forgetContext = () => undefined;
    const backend = new FakeBackend({ voiceMs: 800 });
    startWorker(backend, synthesize);
    const busy = await enqueueSynthesis(client, { text: '遅い合成', provider: 'aivis' });
    await waitFor(async () => (await lastStatus(busy.id)) === 'playing' || undefined);
    const queued = await enqueueSynthesis(client, { text: '次', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) });
    expect(await finalStatus(queued.id)).toEqual({ status: 'done' });
    await waitFor(() => paraCode.bodies.length === 1 || undefined);
    expect(slowEnded).toBeGreaterThan(0);
    expect(paraCode.opened[0]).toBeGreaterThanOrEqual(slowEnded);
    expect(events).toEqual(['synth:遅い合成', 'synth:次']);
  });

  test('ほかの worker が先送りの印を持つ件は、先送りも合成もせず Stream から鳴らす', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend({ voiceMs: 800 });
    startWorker(backend, recordingSynthesizer(events));
    const busy = await enqueueSynthesis(client, { text: '鳴っている', provider: 'aivis' });
    await waitFor(async () => (await lastStatus(busy.id)) === 'playing' || undefined);
    const id = uuidv4();
    const writer = new AudioStreamWriter(client, id);
    await writer.open();
    writer.write(mp3Frames(9));
    await writer.end();
    await writer.settled();
    await client.set(presynthKey(id), 'other-worker', { EX: 600 });
    await enqueueJob(client, { v: 2, type: 'synth', id, priority: 'normal', source: 'agent', enqueuedAt: Date.now(), params: { text: '別の worker', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) } });
    expect(await finalStatus(id)).toEqual({ status: 'done' });
    expect(events.filter(event => event.startsWith('synth:'))).toEqual(['synth:鳴っている']);
    expect(backend.voices.map(voice => voice.bytes.length)).toEqual([417 * 20, 417 * 9]);
    expect(paraCode.bodies).toHaveLength(0);
  });

  test('前の worker が途中で止めた先送りの Stream（中断の印）は、送らずに合成し直して PC で鳴らす', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const backend = new FakeBackend();
    const id = uuidv4();
    const writer = new AudioStreamWriter(client, id);
    await writer.open();
    writer.write(mp3Frames(3));
    await writer.abort('worker-stopped');
    await writer.settled();
    await client.set(presynthKey(id), 'old-worker', { EX: 600 });
    await enqueueJob(client, { v: 2, type: 'synth', id, priority: 'normal', source: 'agent', enqueuedAt: Date.now(), params: { text: '途中で止まった', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) } });
    startWorker(backend, recordingSynthesizer(events));
    expect(await finalStatus(id)).toEqual({ status: 'done' });
    expect(events.filter(event => event.startsWith('synth:'))).toEqual(['synth:途中で止まった']);
    expect(backend.voices).toHaveLength(1);
    expect(paraCode.bodies).toHaveLength(0);
  });

  test('先送りの合成が番を握っている間に、先送りしない声（wait_ms 付き）が来ても、番を待って鳴らす', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const synthesize: Synthesize = async (_config, params) => {
      events.push(`synth:${String(params.text)}`);
      if (params.text !== '遅い先送り') {
        return Readable.from([mp3Frames(20)]);
      }
      const stream = new PassThrough();
      stream.write(mp3Frames(10));
      setTimeout(() => stream.end(mp3Frames(10)), 2500);
      return stream;
    };
    synthesize.forgetContext = () => undefined;
    const backend = new FakeBackend({ voiceMs: 300 });
    startWorker(backend, synthesize);
    const busy = await enqueueSynthesis(client, { text: '鳴っている', provider: 'aivis' });
    await waitFor(async () => (await lastStatus(busy.id)) === 'playing' || undefined);
    const waiting = await enqueueSynthesis(client, { text: '少し待つ', provider: 'aivis', wait_ms: 50 });
    const presynth = await enqueueSynthesis(client, { text: '遅い先送り', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) });
    expect(await finalStatus(waiting.id, 15_000)).toEqual({ status: 'done' });
    expect(await finalStatus(presynth.id, 15_000)).toEqual({ status: 'done' });
    expect(events).toEqual(['synth:鳴っている', 'synth:遅い先送り', 'synth:少し待つ']);
    expect(backend.voices).toHaveLength(3);
    await waitFor(() => paraCode.bodies.length === 1 || undefined);
  });

  test('先送りの合成が音を書かずに失敗したら（429 など）、PC の番で合成し直して鳴らす', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    let failures = 0;
    const synthesize: Synthesize = async (_config, params) => {
      events.push(`synth:${String(params.text)}`);
      if (params.text === '失敗する' && failures++ === 0) {
        throw new Error('429');
      }
      return Readable.from([mp3Frames(20)]);
    };
    synthesize.forgetContext = () => undefined;
    const backend = new FakeBackend({ voiceMs: 800 });
    startWorker(backend, synthesize);
    const busy = await enqueueSynthesis(client, { text: '鳴っている', provider: 'aivis' });
    await waitFor(async () => (await lastStatus(busy.id)) === 'playing' || undefined);
    const job = await enqueueSynthesis(client, { text: '失敗する', provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1 }) });
    expect(await finalStatus(job.id)).toEqual({ status: 'done' });
    expect(events).toEqual(['synth:鳴っている', 'synth:失敗する', 'synth:失敗する']);
    expect(backend.voices).toHaveLength(2);
    // 合成し直した音は、同じ ticket でモバイルへも届く（失敗した 1 回目は Para Code へ届いていない）
    await waitFor(() => paraCode.bodies.length === 1 || undefined);
    expect(paraCode.bodies[0].bytes.length).toBe(417 * 20);
    expect(paraCode.released).toEqual([]);
  });

  test('期限切れの声を裏で送るのは 4 件まで。超えた分は合成しない', async () => {
    const paraCode = await fakeParaCode();
    const events: string[] = [];
    const synthesize: Synthesize = async (_config, params) => {
      events.push(`synth:${String(params.text)}`);
      const stream = new PassThrough();
      stream.write(mp3Frames(5));
      // 6 件を取り出し終えるまで、最初の送り出しが終わらないようにする
      setTimeout(() => stream.end(mp3Frames(5)), 2_000);
      return stream;
    };
    synthesize.forgetContext = () => undefined;
    const ids = Array.from({ length: 6 }, () => uuidv4());
    for (const [index, id] of ids.entries()) {
      await enqueueJob(client, { v: 2, type: 'synth', id, priority: 'normal', source: 'agent', enqueuedAt: Date.now() - 200_000, params: { text: `期限切れ${index}`, provider: 'aivis', _paraCodeVoiceTarget: mobileTarget(paraCode.port, { mobileListeners: 1, release: true }) } });
    }
    startWorker(new FakeBackend(), synthesize);
    for (const id of ids) {
      expect(await finalStatus(id)).toEqual({ status: 'skipped', reason: 'expired' });
    }
    await waitFor(() => paraCode.bodies.length === 4 || undefined, 20_000);
    await waitFor(() => paraCode.released.length === 2 || undefined);
    expect(events).toEqual(['synth:期限切れ0', 'synth:期限切れ1', 'synth:期限切れ2', 'synth:期限切れ3']);
  });
});

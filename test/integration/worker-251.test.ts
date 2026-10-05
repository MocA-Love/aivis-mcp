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
import { enqueueJob, enqueueLegacy, enqueueSynthesis } from '../../src/queue/enqueue.js';
import { clearHold, setHold } from '../../src/queue/hold.js';
import {
  audioStreamKey, HOLD_SINCE_KEY, LEGACY_QUEUE_KEY, MIGRATED_LEGACY_QUEUE_KEY, PLAY_LOCK_KEY, preludeDirsKey, WORKER_LOCK_KEY, WORKER_VERSION_KEY,
} from '../../src/queue/keys.js';
import { readStatuses } from '../../src/queue/status.js';
import type { Job, StreamJob } from '../../src/queue/jobs.js';
import { setMute } from '../../src/services/mute-service.js';
import { requestVoiceTicket, VoiceTicketResponder } from '../../src/services/voice-ticket.js';
import type { ParaCodeVoiceTarget } from '../../src/services/para-code-voice.js';
import { connect, describeWithRedis, startTestRedis, waitFor, type TestRedis } from '../helpers/redis.js';
import { startRedisProxy } from '../helpers/redis-proxy.js';
import { FakeBackend } from '../helpers/fake-backend.js';
import { mp3Frames, testConfig } from '../helpers/fixtures.js';

type Synthesize = (config: unknown, params: Record<string, unknown>, signal?: AbortSignal) => Promise<NodeJS.ReadableStream>;

describeWithRedis('worker の 2.5.1 の直し（別ポートの redis-server）', () => {
  let redis: TestRedis;
  let client: RedisClientType;
  let tempDir: string;
  let preludeFile: string;
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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-worker251-')));
    preludeFile = path.join(tempDir, 'chime.wav');
    fs.writeFileSync(preludeFile, 'RIFF');
    await client.sAdd(preludeDirsKey('test-ingest'), tempDir);
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

  function startWorker(backend: FakeBackend, options: {
    url?: string;
    synthesize?: Synthesize;
    measure?: () => Promise<{ integratedLufs: number; durationSeconds: number }>;
    timings?: Partial<WorkerTimings>;
  } = {}): PlaybackWorker {
    const worker = new PlaybackWorker({
      redisUrl: options.url ?? redis.url,
      version: '2.5.1',
      loadConfig: () => testConfig(redis.url),
      backend,
      synthesize: (options.synthesize ?? (async () => Readable.from([mp3Frames(20)]))) as never,
      measure: options.measure,
      gainFile: path.join(tempDir, 'gain.json'),
      timings: options.timings,
    });
    workers.push(worker);
    runs.push(worker.run());
    return worker;
  }

  async function streamJob(id: string, extra: Partial<StreamJob> = {}, audio: Buffer | null = mp3Frames(20), end = true): Promise<AudioStreamWriter> {
    const writer = new AudioStreamWriter(client, id);
    await writer.open();
    if (audio !== null) {
      writer.write(audio);
    }
    if (end) {
      await writer.end();
    }
    await writer.settled();
    await enqueueJob(client, { v: 2, type: 'stream', id, priority: 'normal', source: 'ingest', enqueuedAt: Date.now(), ...extra });
    return writer;
  }

  async function statuses(id: string): Promise<string[]> {
    const { entries } = await readStatuses(client, id, 0);
    return entries.map(entry => entry.status);
  }

  async function finalStatus(id: string, timeoutMs = 10_000): Promise<{ status: string; reason?: string }> {
    return waitFor(async () => {
      const { entries } = await readStatuses(client, id, 0);
      const last = entries[entries.length - 1];
      return last && !['queued', 'dequeued', 'requeued', 'playing'].includes(last.status) ? { status: last.status, reason: last.reason } : undefined;
    }, timeoutMs);
  }

  /** 偽の Para Code。health に答え、mobile-voice は handler に任せる。 */
  async function fakeParaCode(handler: (request: http.IncomingMessage, response: http.ServerResponse, bodies: Buffer[]) => void): Promise<{ port: number; bodies: Buffer[]; requests: http.IncomingMessage[] }> {
    const bodies: Buffer[] = [];
    const requests: http.IncomingMessage[] = [];
    const server = http.createServer((request, response) => {
      if (request.url === '/paradis-mcp/health') {
        response.end(JSON.stringify({ instanceId: 'instance' }));
        return;
      }
      requests.push(request);
      handler(request, response, bodies);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    return { port: (server.address() as AddressInfo).port, bodies, requests };
  }

  function collectBody(request: http.IncomingMessage, bodies: Buffer[], done?: () => void): void {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      done?.();
    });
  }

  function sshTarget(port: number, extra: Partial<ParaCodeVoiceTarget> = {}): ParaCodeVoiceTarget {
    return { ticket: 'ticket', port, instanceId: 'instance', expiresAt: Date.now() + 60_000, localPlayback: true, ingress: 'stream-v1', ...extra };
  }

  test('[HIGH 1] Redis の読み取りが失敗したら、プレイヤーを止めて終わったのを確かめてから再生 lock を手放す', async () => {
    const backend = new FakeBackend({ voiceMs: 30_000 });
    startWorker(backend);
    // 終わりの印を書かず、鳴らし始めるだけの量を流す
    await streamJob('rx', {}, mp3Frames(12), false);
    await waitFor(() => backend.events.some(event => event.kind === 'voice-start') ? true : undefined);
    // 次の XREAD を失敗させる（キーの型を変える）
    await client.del(audioStreamKey('rx'));
    await client.set(audioStreamKey('rx'), 'broken');
    const releasedAt = await waitFor(async () => (await client.exists(PLAY_LOCK_KEY)) === 0 ? Date.now() : undefined, 10_000, 2);
    expect(await finalStatus('rx')).toEqual({ status: 'failed', reason: 'redis-error' });
    expect(backend.voices[0].killed).toBe(true);
    const voiceEnd = backend.events.find(event => event.kind === 'voice-end')!;
    expect(voiceEnd.at).toBeLessThanOrEqual(releasedAt);
    expect(backend.maxActive).toBe(1);
  });

  test('[HIGH 2] Redis が応答しなくなったら、再生 lock の期限が切れる前に鳴らすのを止める', async () => {
    const proxy = await startRedisProxy(redis.url);
    cleanups.push(async () => {
      proxy.release();
      await proxy.close();
    });
    const backend = new FakeBackend({ voiceMs: 30_000 });
    startWorker(backend, { url: proxy.url, timings: { playLockTtlMs: 2000, playLockExtendMs: 400, playLockSafetyMs: 600, opTimeoutMs: 800 } });
    await streamJob('stall');
    await waitFor(() => backend.events.some(event => event.kind === 'voice-start') ? true : undefined);
    proxy.stall();
    // Redis 側で lock の期限が切れた瞬間には、もう止まっている（ほかの worker が取っても重ならない）
    await waitFor(async () => (await client.exists(PLAY_LOCK_KEY)) === 0 ? true : undefined, 10_000, 5);
    expect(backend.voices).toHaveLength(1);
    expect(backend.voices[0].killed).toBe(true);
  });

  test('[HIGH 3] プレイヤーが 0 以外で終わった・プレイヤーが無いときは failed にし、覚え直さない', async () => {
    let measured = 0;
    const measure = async () => { measured++; return { integratedLufs: -20, durationSeconds: 2 }; };
    const exited = new FakeBackend({ voiceResult: { ok: false, reason: 'player-exited' }, canMeasure: true });
    const worker = startWorker(exited, { measure });
    await streamJob('px', { gainKey: 'aivis:model-x:default' }, mp3Frames(100));
    expect(await finalStatus('px')).toEqual({ status: 'failed', reason: 'player-exited' });
    await worker.flushMeasurements();
    expect(measured).toBe(0);
    worker.stop();
    await runs[0];

    startWorker(new FakeBackend({ kind: 'none' }));
    await streamJob('np');
    expect(await finalStatus('np')).toEqual({ status: 'failed', reason: 'no-player' });
  });

  test('[MEDIUM 7] SSH の転送で返事を待つ間も hold で止まり、この機械では鳴らさない', async () => {
    // 本文は読むが、ヘッダーを返さない Para Code
    const paraCode = await fakeParaCode(request => { request.resume(); });
    const source = new PassThrough();
    const backend = new FakeBackend();
    startWorker(backend, { synthesize: async () => { source.write(mp3Frames(10)); return source; } });
    const job = await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(paraCode.port) });
    await waitFor(() => paraCode.requests.length === 1 ? true : undefined);
    await setHold(client, 'mic');
    expect(await finalStatus(job.id)).toEqual({ status: 'held' });
    expect(backend.voices).toHaveLength(0);
    expect(source.destroyed).toBe(true);
    await clearHold(client, 'mic');
  });

  test('[MEDIUM 7] 引き受けた後に hold で止めても、この機械の再生へは切り替えない', async () => {
    const paraCode = await fakeParaCode((request, response) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      request.resume();
    });
    const source = new PassThrough();
    const backend = new FakeBackend();
    startWorker(backend, { synthesize: async () => { source.write(mp3Frames(10)); return source; } });
    const job = await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(paraCode.port) });
    await waitFor(() => paraCode.requests.length === 1 ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 200));
    await setHold(client, 'mic');
    expect(await finalStatus(job.id)).toEqual({ status: 'held' });
    expect(backend.voices).toHaveLength(0);
    await clearHold(client, 'mic');
  });

  test('[MEDIUM 8] 合成の応答を待つ間に止めたら、HTTP を取り消し、届いた流れも読まずに捨てる', async () => {
    let captured: AbortSignal | undefined;
    const late = new PassThrough();
    const backend = new FakeBackend();
    startWorker(backend, {
      synthesize: async (_config, _params, signal) => {
        captured = signal;
        await new Promise(resolve => setTimeout(resolve, 800));
        late.write(mp3Frames(20));
        return late;
      },
    });
    const job = await enqueueSynthesis(client, { text: '遅い', provider: 'aivis' });
    await waitFor(async () => (await statuses(job.id)).includes('playing') ? true : undefined);
    await setHold(client, 'mic');
    expect(await finalStatus(job.id)).toEqual({ status: 'held' });
    expect(captured?.aborted).toBe(true);
    await waitFor(() => late.destroyed ? true : undefined, 3000);
    const entries = await client.xRange(audioStreamKey(job.id), '-', '+');
    expect(entries.some(entry => entry.message.d !== undefined)).toBe(false);
    await clearHold(client, 'mic');
  });

  test('[MEDIUM 10] end の後でも、鳴らし始める前の「やめる」印で捨てる', async () => {
    const backend = new FakeBackend({ preludeMs: 3000 });
    startWorker(backend);
    const writer = await streamJob('c1', { prelude: { path: preludeFile, volume: 1 } });
    await waitFor(() => backend.preludes.length === 1 ? true : undefined);
    await writer.cancel('ssh-closed');
    expect(await finalStatus('c1')).toEqual({ status: 'skipped', reason: 'ssh-closed' });
    expect(backend.voices).toHaveLength(0);
    expect(backend.preludeKills).toBe(1);
  });

  test('[MEDIUM 11] 再生 lock を待つ間にミュートしたら鳴らさない（2.4 の形の音声も）', async () => {
    await client.set(PLAY_LOCK_KEY, 'someone', { PX: 60_000 });
    await streamJob('m1');
    await enqueueLegacy(client, { _audioBase64: mp3Frames(5).toString('base64') });
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(async () => (await statuses('m1')).includes('dequeued') ? true : undefined);
    await setMute(client, undefined);
    await client.del(PLAY_LOCK_KEY);
    expect(await finalStatus('m1')).toEqual({ status: 'muted' });
    await waitFor(async () => (await client.lLen(LEGACY_QUEUE_KEY)) === 0 ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(backend.voices).toHaveLength(0);
  });

  test('[Q209 B] ミュート中も Para Code へは送り（モバイル）、この機械では鳴らさない。送れなければ合成もしない', async () => {
    await setMute(client, undefined);
    const paraCode = await fakeParaCode((request, response, bodies) => collectBody(request, bodies, () => response.end()));
    let synthesized = 0;
    const synthesize = async () => { synthesized++; return Readable.from([mp3Frames(20)]); };
    const backend = new FakeBackend();
    startWorker(backend, { synthesize });
    const mobile = { ticket: 'ticket', port: paraCode.port, instanceId: 'instance', expiresAt: Date.now() + 60_000, ingress: 'stream-v1' };
    const forwarded = await enqueueSynthesis(client, { text: 'モバイルへ', provider: 'aivis', _paraCodeVoiceTarget: mobile });
    expect(await finalStatus(forwarded.id)).toEqual({ status: 'muted', reason: 'forwarded' });
    expect(paraCode.bodies[0].length).toBe(417 * 20);
    const plain = await enqueueSynthesis(client, { text: '手元だけ', provider: 'aivis' });
    expect(await finalStatus(plain.id)).toEqual({ status: 'muted' });
    expect(synthesized).toBe(1);
    expect(backend.voices).toHaveLength(0);
  });

  test('[MEDIUM 12] hold の途中で worker が入れ替わっても、hold の時間を待ちに数えない', async () => {
    await setHold(client, 'mic');
    // 前の worker の間から 200 秒続いている hold
    const since = Date.now() - 200_000;
    await client.set(HOLD_SINCE_KEY, String(since));
    await streamJob('hs', { enqueuedAt: since });
    const backend = new FakeBackend();
    const worker = startWorker(backend);
    await waitFor(() => worker.isHeld ? true : undefined);
    await clearHold(client, 'mic');
    expect(await finalStatus('hs')).toEqual({ status: 'done' });
  });

  test('[MEDIUM 14] 2.4 の worker から引き取ったら、古い列を 2.4 が読めない所へ移し、止まるまで古い列を読まない', async () => {
    await client.set(WORKER_LOCK_KEY, 'old-worker', { PX: 20_000 });
    await client.set(WORKER_VERSION_KEY, '2.4.0', { PX: 20_000 });
    // 2.4 の worker が鳴らしている
    await client.set(PLAY_LOCK_KEY, 'old-worker', { PX: 1500 });
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2, 1).toString('base64') });
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2, 2).toString('base64') });
    const backend = new FakeBackend();
    const worker = startWorker(backend, { timings: { legacyGraceMs: 300 } });
    await waitFor(() => worker.isMigratingLegacy ? true : undefined);
    expect(await client.lLen(LEGACY_QUEUE_KEY)).toBe(0);
    // 2.4 の CLI が引き取り後に積んだ分も移す
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2, 3).toString('base64') });
    await waitFor(async () => (await client.lLen(LEGACY_QUEUE_KEY)) === 0 ? true : undefined, 5000);
    await waitFor(() => backend.voices.length === 3 ? true : undefined, 10_000);
    expect(backend.voices.map(voice => voice.bytes[10])).toEqual([1, 2, 3]);
    expect(await client.lLen(MIGRATED_LEGACY_QUEUE_KEY)).toBe(0);
    await waitFor(() => !worker.isMigratingLegacy ? true : undefined);
  });

  test('[MEDIUM 16] 着信音だけの通知と 2.4 の形の音声にも全体の上限を掛ける', async () => {
    const backend = new FakeBackend({ preludeMs: 30_000, voiceMs: 30_000 });
    startWorker(backend, { timings: { jobHardLimitMs: 500 } });
    const sound: Job = { v: 2, type: 'sound', id: 'long-sound', priority: 'normal', source: 'ingest', enqueuedAt: Date.now(), prelude: { path: preludeFile, volume: 1 } };
    await enqueueJob(client, sound);
    expect(await finalStatus('long-sound')).toEqual({ status: 'failed', reason: 'max-duration' });
    expect(backend.preludeKills).toBeGreaterThanOrEqual(1);
    await enqueueLegacy(client, { _audioBase64: mp3Frames(5).toString('base64') });
    await waitFor(() => backend.voices.length === 1 ? true : undefined, 5000);
    expect(backend.voices[0].killed).toBe(true);
  });

  test('[MEDIUM 18] 再生 lock を待つ間に high が来たら、まだ鳴らしていない normal は後に回す', async () => {
    await client.set(PLAY_LOCK_KEY, 'someone', { PX: 60_000 });
    await streamJob('n1', { volumeDb: -1 });
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(async () => (await statuses('n1')).includes('dequeued') ? true : undefined);
    await streamJob('h1', { volumeDb: -3, priority: 'high' });
    await client.del(PLAY_LOCK_KEY);
    expect(await finalStatus('h1')).toEqual({ status: 'done' });
    expect(await finalStatus('n1')).toEqual({ status: 'done' });
    expect(backend.voices.map(voice => voice.gainDb)).toEqual([-3, -1]);
    expect(await statuses('n1')).toContain('requeued');
  });

  test('[MEDIUM 20] MCP サーバーから積んだ声は、鳴らし始めるときに ticket を頼んで送る', async () => {
    const paraCode = await fakeParaCode((request, response, bodies) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      collectBody(request, bodies, () => response.end());
    });
    const subscriber = await connect(redis.url);
    let captured = 0;
    const capture = async () => { captured++; return sshTarget(paraCode.port); };
    const responder = new VoiceTicketResponder(subscriber, client, uuidv4(), capture, () => true);
    await responder.start();
    cleanups.push(() => responder.stop());
    const jobId = uuidv4();
    const requester = responder.register(jobId);
    expect(requester.localPlayback).toBe(true);
    // 積んだ時点では ticket を取らない
    await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _voiceRequester: requester }, 'normal', jobId);
    expect(captured).toBe(0);
    // ticket は Redis の列・キーに置かない
    expect(JSON.stringify(await client.lRange('aivis-mcp:q2:normal', 0, -1))).not.toContain('ticket');
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus(jobId)).toEqual({ status: 'done', reason: 'played-by-para-code' });
    expect(captured).toBe(1);
    expect(paraCode.bodies[0].length).toBe(417 * 20);
    expect(backend.voices).toHaveLength(0);
    // 積んでいない ID・答えた ID には答えない
    const probe = await connect(redis.url);
    try {
      expect(await requestVoiceTicket(client, probe, requester, 'not-mine', 300)).toBeUndefined();
      expect(await requestVoiceTicket(client, probe, requester, jobId, 300)).toBeUndefined();
    } finally {
      await probe.disconnect();
    }
    expect(captured).toBe(1);
  });

  test('[MEDIUM 20] ticket が取れないとき、SSH 先のペインの声は接続先で鳴らさない。手元のペインの声は鳴らす', async () => {
    const backend = new FakeBackend();
    startWorker(backend, { timings: { voiceTicketWaitMs: 300 } });
    const remote = uuidv4();
    await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _voiceRequester: { id: uuidv4(), localPlayback: true } }, 'normal', remote);
    expect(await finalStatus(remote)).toEqual({ status: 'failed', reason: 'ticket-unavailable' });
    expect(backend.voices).toHaveLength(0);
    const local = uuidv4();
    await enqueueSynthesis(client, { text: '手元', provider: 'aivis', _voiceRequester: { id: uuidv4(), localPlayback: false } }, 'normal', local);
    expect(await finalStatus(local)).toEqual({ status: 'done' });
    expect(backend.voices).toHaveLength(1);
  });

  test('[MEDIUM 21] 引き受けた後に本文で localPlayback:false と返ったら、この機械で鳴らす', async () => {
    const paraCode = await fakeParaCode((request, response, bodies) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted', 'Content-Type': 'application/json' });
      response.flushHeaders();
      collectBody(request, bodies, () => response.end(JSON.stringify({ localPlayback: false })));
    });
    const backend = new FakeBackend();
    startWorker(backend, { synthesize: async () => Readable.from([mp3Frames(10), mp3Frames(10)]) });
    const job = await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(paraCode.port) });
    expect(await finalStatus(job.id)).toEqual({ status: 'done' });
    expect(paraCode.bodies).toHaveLength(1);
    expect(backend.voices[0].bytes.length).toBe(417 * 20);
  });

  test('[LOW 27] ヘッダーに書けない ticket は使わず、worker は落ちずにこの機械で鳴らす', async () => {
    const backend = new FakeBackend();
    startWorker(backend);
    const job = await enqueueSynthesis(client, { text: 'x', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(1, { ticket: 'bad\r\nX-Injected: 1' }) });
    expect(await finalStatus(job.id)).toEqual({ status: 'done' });
    expect(backend.voices).toHaveLength(1);
  });

  test('[LOW 28] Redis から来た大きすぎる項目は鳴らさない。プレイヤーへの書き込みは空くのを待つ', async () => {
    const key = audioStreamKey('huge');
    await client.xAdd(key, '*', { o: '1' });
    await client.xAdd(key, '*', { d: Buffer.alloc(1200 * 1024) as unknown as string });
    await client.xAdd(key, '*', { e: '1' });
    await client.expire(key, 180);
    await enqueueJob(client, { v: 2, type: 'stream', id: 'huge', priority: 'normal', source: 'ingest', enqueuedAt: Date.now() });
    const backend = new FakeBackend({ drainMs: 30 });
    startWorker(backend);
    expect(await finalStatus('huge')).toEqual({ status: 'failed', reason: 'too-large' });
    expect(backend.voices).toHaveLength(0);
    // 小さく分けて流した声は、1 つずつ空くのを待って書く
    const writer = new AudioStreamWriter(client, 'drain');
    await writer.open();
    await writer.settled();
    await enqueueJob(client, { v: 2, type: 'stream', id: 'drain', priority: 'normal', source: 'ingest', enqueuedAt: Date.now() });
    for (let i = 0; i < 6; i++) {
      writer.write(mp3Frames(20));
      await writer.settled();
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    await writer.end();
    expect(await finalStatus('drain')).toEqual({ status: 'done' });
    expect(backend.voices[0].bytes.length).toBe(417 * 120);
    expect(backend.maxPendingWrites).toBe(1);
  });

  test('[再レビュー HIGH] ミュート中、手元で鳴らす ticket は muteAware のある Para Code にだけ X-Para-Muted を付けて送る', async () => {
    await setMute(client, undefined);
    const paraCode = await fakeParaCode((request, response, bodies) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      collectBody(request, bodies, () => response.end());
    });
    const backend = new FakeBackend();
    startWorker(backend);
    const old = await enqueueSynthesis(client, { text: '古い Para Code', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(paraCode.port) });
    expect(await finalStatus(old.id)).toEqual({ status: 'muted' });
    expect(paraCode.requests).toHaveLength(0);
    const aware = await enqueueSynthesis(client, { text: '新しい Para Code', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(paraCode.port, { muteAware: true }) });
    expect(await finalStatus(aware.id)).toEqual({ status: 'muted', reason: 'forwarded' });
    expect(paraCode.requests).toHaveLength(1);
    expect(paraCode.requests[0].headers['x-para-muted']).toBe('1');
    expect(backend.voices).toHaveLength(0);
  });

  test('[再レビュー MEDIUM 1] SSH 先の MCP サーバーの返事は 1.5 秒を過ぎても待つ', async () => {
    const paraCode = await fakeParaCode((request, response, bodies) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      collectBody(request, bodies, () => response.end());
    });
    const subscriber = await connect(redis.url);
    const responder = new VoiceTicketResponder(subscriber, client, uuidv4(), async () => {
      await new Promise(resolve => setTimeout(resolve, 2200));
      return sshTarget(paraCode.port);
    }, () => true);
    await responder.start();
    cleanups.push(() => responder.stop());
    const jobId = uuidv4();
    const requester = responder.register(jobId);
    expect(requester.remote).toBe(true);
    await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _voiceRequester: requester }, 'normal', jobId);
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus(jobId)).toEqual({ status: 'done', reason: 'played-by-para-code' });
    expect(backend.voices).toHaveLength(0);
  });

  test('[再レビュー MEDIUM 2] MCP サーバーが終わっていても（receivers 0）、積む時の控えの ticket で送る', async () => {
    const paraCode = await fakeParaCode((request, response, bodies) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      collectBody(request, bodies, () => response.end());
    });
    const backend = new FakeBackend();
    startWorker(backend);
    const jobId = uuidv4();
    await enqueueSynthesis(client, {
      text: 'リモート', provider: 'aivis',
      _voiceRequester: { id: uuidv4(), localPlayback: true, remote: true },
      _paraCodeVoiceTarget: sshTarget(paraCode.port),
    }, 'normal', jobId);
    expect(await finalStatus(jobId)).toEqual({ status: 'done', reason: 'played-by-para-code' });
    expect(paraCode.bodies).toHaveLength(1);
    expect(paraCode.requests[0].headers.authorization).toBe('Bearer ticket');
  });

  test('[再レビュー MEDIUM 1・2] MCP サーバーは控えが使えれば新しく取らず、待ちきれなかった ticket は次に回し、終わるときは答えてから閉じる', async () => {
    const subscriber = await connect(redis.url);
    let captured = 0;
    let delayMs = 0;
    const responder = new VoiceTicketResponder(subscriber, client, uuidv4(), async () => {
      captured++;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return sshTarget(1, { ticket: `fresh-${captured}`, expiresAt: Date.now() + 600_000 });
    }, () => true);
    await responder.start();
    const probe = await connect(redis.url);
    try {
      // 控えがまだ使える: 控えを返し、新しく取らない
      const withFallback = uuidv4();
      const requester = responder.register(withFallback, sshTarget(1, { ticket: 'fallback', expiresAt: Date.now() + 600_000 }));
      expect((await requestVoiceTicket(client, probe, requester, withFallback, 1000))?.ticket).toBe('fallback');
      expect(captured).toBe(0);
      // worker が待ちきれなかった ticket は、次の依頼に回す
      delayMs = 600;
      const late = uuidv4();
      responder.register(late);
      expect(await requestVoiceTicket(client, probe, requester, late, 200)).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 800));
      const next = uuidv4();
      responder.register(next);
      expect((await requestVoiceTicket(client, probe, requester, next, 1000))?.ticket).toBe('fresh-1');
      expect(captured).toBe(1);
      // 終わるとき、答えている途中の依頼には答えてから閉じる
      const closing = uuidv4();
      responder.register(closing);
      const pending = requestVoiceTicket(client, probe, requester, closing, 2000);
      await new Promise(resolve => setTimeout(resolve, 100));
      await responder.stop(2000);
      expect((await pending)?.ticket).toBe('fresh-2');
    } finally {
      await probe.disconnect();
      await responder.stop();
    }
  });

  test('[再レビュー MEDIUM 4] 止められたら、プレイヤーが終わるのを待ってから再生 lock を手放す', async () => {
    const backend = new FakeBackend({ voiceMs: 30_000, killDelayMs: 500 });
    const worker = startWorker(backend);
    await streamJob('sd');
    await waitFor(() => backend.events.some(event => event.kind === 'voice-start') ? true : undefined);
    await worker.shutdown();
    const releasedAt = Date.now();
    expect(await client.exists(PLAY_LOCK_KEY)).toBe(0);
    const voiceEnd = backend.events.find(event => event.kind === 'voice-end');
    expect(voiceEnd).toBeDefined();
    expect(voiceEnd!.at).toBeLessThanOrEqual(releasedAt);
  });

  test('[再々レビュー LOW 1] 残り 15 秒を切った控えは使わず、401 は明示の拒否ではなく ticket-unavailable', async () => {
    const backend = new FakeBackend();
    startWorker(backend, { timings: { voiceTicketRemoteWaitMs: 200 } });
    const nearExpiry = uuidv4();
    await enqueueSynthesis(client, {
      text: 'リモート', provider: 'aivis',
      _voiceRequester: { id: uuidv4(), localPlayback: true, remote: true },
      _paraCodeVoiceTarget: sshTarget(1, { expiresAt: Date.now() + 10_000 }),
    }, 'normal', nearExpiry);
    expect(await finalStatus(nearExpiry)).toEqual({ status: 'failed', reason: 'ticket-unavailable' });
    const paraCode = await fakeParaCode((request, response) => {
      request.resume();
      response.writeHead(401);
      response.end();
    });
    const rejected = await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(paraCode.port) });
    expect(await finalStatus(rejected.id)).toEqual({ status: 'failed', reason: 'ticket-unavailable' });
    expect(backend.voices).toHaveLength(0);
  });

  test('[再々レビュー LOW 2] ミュート中に送らないと控えで分かる件は ticket を頼まない。時間切れの直後に届いた ticket は次に使う', async () => {
    const subscriber = await connect(redis.url);
    let captured = 0;
    let delayMs = 0;
    const paraCode = await fakeParaCode((request, response, bodies) => {
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      collectBody(request, bodies, () => response.end());
    });
    const responder = new VoiceTicketResponder(subscriber, client, uuidv4(), async () => {
      captured++;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return sshTarget(paraCode.port, { ticket: `late-${captured}`, expiresAt: Date.now() + 600_000 });
    }, () => true);
    await responder.start();
    cleanups.push(() => responder.stop());
    const backend = new FakeBackend();
    startWorker(backend, { timings: { voiceTicketRemoteWaitMs: 200 } });

    await setMute(client, undefined);
    const muted = uuidv4();
    const fallback = sshTarget(paraCode.port, { ticket: 'fallback', expiresAt: Date.now() + 600_000 });
    await enqueueSynthesis(client, { text: 'x', provider: 'aivis', _voiceRequester: responder.register(muted, fallback), _paraCodeVoiceTarget: fallback }, 'normal', muted);
    expect(await finalStatus(muted)).toEqual({ status: 'muted' });
    expect(captured).toBe(0);
    expect(paraCode.requests).toHaveLength(0);
    await client.del('aivis-mcp:muted');

    // 返事が 200ms の待ちに 100ms 遅れる。その ticket は捨てずに、次の発話で頼まずに使う
    delayMs = 300;
    const first = uuidv4();
    await enqueueSynthesis(client, { text: 'x', provider: 'aivis', _voiceRequester: responder.register(first) }, 'normal', first);
    expect(await finalStatus(first)).toEqual({ status: 'failed', reason: 'ticket-unavailable' });
    await new Promise(resolve => setTimeout(resolve, 400));
    const second = uuidv4();
    await enqueueSynthesis(client, { text: 'x', provider: 'aivis', _voiceRequester: responder.register(second) }, 'normal', second);
    expect(await finalStatus(second)).toEqual({ status: 'done', reason: 'played-by-para-code' });
    expect(captured).toBe(1);
    expect(paraCode.requests[0].headers.authorization).toBe('Bearer late-1');
  });
});


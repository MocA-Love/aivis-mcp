import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import type { RedisClientType } from 'redis';
import { PlaybackWorker } from '../../src/worker/playback-worker.js';
import { AudioStreamWriter } from '../../src/queue/audio-stream.js';
import { enqueueJob, enqueueLegacy, enqueueSynthesis } from '../../src/queue/enqueue.js';
import { clearHold, setHold } from '../../src/queue/hold.js';
import { LEGACY_QUEUE_KEY, NORMAL_QUEUE_KEY, PLAY_LOCK_KEY, preludeDirsKey, WORKER_LOCK_KEY, WORKER_VERSION_KEY } from '../../src/queue/keys.js';
import { readStatuses } from '../../src/queue/status.js';
import type { Job, StreamJob } from '../../src/queue/jobs.js';
import { setMute } from '../../src/services/mute-service.js';
import { loadLearnedGains } from '../../src/audio/gain-table.js';
import { connect, describeWithRedis, startTestRedis, waitFor, type TestRedis } from '../helpers/redis.js';
import { FakeBackend } from '../helpers/fake-backend.js';
import { mp3Frames, testConfig } from '../helpers/fixtures.js';

describeWithRedis('worker（別ポートの redis-server）', () => {
  let redis: TestRedis;
  let client: RedisClientType;
  let tempDir: string;
  let gainFile: string;
  let preludeFile: string;
  const workers: PlaybackWorker[] = [];
  const runs: Promise<unknown>[] = [];

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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-worker-')));
    gainFile = path.join(tempDir, 'gain.json');
    preludeFile = path.join(tempDir, 'chime.wav');
    fs.writeFileSync(preludeFile, 'RIFF');
    // --ingest が起動時に置く許可フォルダ
    await client.sAdd(preludeDirsKey('test-ingest'), tempDir);
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      worker.stop();
    }
    await Promise.allSettled(runs.splice(0));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function startWorker(backend: FakeBackend, options: { version?: string; synthesize?: () => Promise<NodeJS.ReadableStream>; measure?: () => Promise<{ integratedLufs: number; durationSeconds: number }> } = {}): PlaybackWorker {
    const worker = new PlaybackWorker({
      redisUrl: redis.url,
      version: options.version ?? '2.5.0',
      loadConfig: () => testConfig(redis.url),
      backend,
      synthesize: options.synthesize ?? (async () => Readable.from([mp3Frames(20)])),
      measure: options.measure,
      gainFile,
    });
    workers.push(worker);
    runs.push(worker.run());
    return worker;
  }

  async function streamJob(id: string, extra: Partial<StreamJob> = {}, audio: Buffer | null = mp3Frames(20)): Promise<StreamJob> {
    const job: StreamJob = { v: 2, type: 'stream', id, priority: 'normal', source: 'ingest', enqueuedAt: Date.now(), ...extra };
    if (audio !== null) {
      const writer = new AudioStreamWriter(client, id);
      await writer.open();
      writer.write(audio);
      await writer.end();
      await writer.settled();
    }
    await enqueueJob(client, job);
    return job;
  }

  async function finalStatus(id: string): Promise<{ status: string; reason?: string }> {
    return waitFor(async () => {
      const { entries } = await readStatuses(client, id, 0);
      const last = entries[entries.length - 1];
      return last && !['queued', 'dequeued', 'playing'].includes(last.status) ? { status: last.status, reason: last.reason } : undefined;
    });
  }

  test('high を先に、同じ列の中は積んだ順に鳴らす', async () => {
    await streamJob('a', { volumeDb: -1 });
    await streamJob('b', { volumeDb: -2 });
    await streamJob('c', { volumeDb: -3, priority: 'high' });
    const backend = new FakeBackend();
    startWorker(backend);
    await finalStatus('b');
    expect(backend.voices.map(voice => voice.gainDb)).toEqual([-3, -1, -2]);
    expect(backend.voices[0].bytes.equals(mp3Frames(20))).toBe(true);
  });

  test('古い列も LPUSH で積み、積んだ順に鳴らす', async () => {
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2, 1).toString('base64') });
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2, 2).toString('base64') });
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(() => backend.voices.length === 2 ? true : undefined);
    expect(backend.voices.map(voice => voice.bytes[10])).toEqual([1, 2]);
    expect(await client.lLen(LEGACY_QUEUE_KEY)).toBe(0);
  });

  test('Stream が無いジョブは待たずに捨てる', async () => {
    await streamJob('gone', {}, null);
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus('gone')).toEqual({ status: 'skipped', reason: 'stream-missing' });
    expect(backend.voices).toHaveLength(0);
  });

  test('期限を過ぎたジョブは鳴らさない', async () => {
    await streamJob('old', { enqueuedAt: Date.now() - 121_000 });
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus('old')).toEqual({ status: 'skipped', reason: 'expired' });
    expect(backend.voices).toHaveLength(0);
  });

  test('着信音 → 声の順に鳴らし、着信音には音量の表を当てない', async () => {
    await streamJob('p', { prelude: { path: preludeFile, volume: 0.5 }, gainKey: 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default' });
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus('p')).toEqual({ status: 'done' });
    expect(backend.events.map(event => event.kind)).toEqual(['prelude', 'voice-start', 'voice-end']);
    expect(backend.voices[0].gainDb).toBe(4.1);
  });

  test('5 秒以上待った着信音は飛ばし、声は読む', async () => {
    await streamJob('late', { prelude: { path: preludeFile, volume: 1 }, enqueuedAt: Date.now() - 6000 });
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus('late')).toEqual({ status: 'done' });
    expect(backend.preludes).toHaveLength(0);
    expect(backend.voices).toHaveLength(1);
  });

  test('ミュート中は着信音（sound ジョブと prelude）も鳴らさない', async () => {
    await setMute(client, undefined);
    const sound: Job = { v: 2, type: 'sound', id: 'sound', priority: 'high', source: 'ingest', enqueuedAt: Date.now(), prelude: { path: preludeFile, volume: 1 } };
    await enqueueJob(client, sound);
    await streamJob('voice', { prelude: { path: preludeFile, volume: 1 } });
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus('sound')).toEqual({ status: 'muted' });
    expect(await finalStatus('voice')).toEqual({ status: 'muted' });
    expect(backend.events).toHaveLength(0);
  });

  test('hold の間は取り出さず、解いたら鳴らす', async () => {
    await setHold(client, 'para-code');
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(() => workers[0].isHeld ? true : undefined);
    await streamJob('wait');
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(backend.voices).toHaveLength(0);
    expect(await client.lLen(NORMAL_QUEUE_KEY)).toBe(1);
    await clearHold(client, 'para-code');
    expect(await finalStatus('wait')).toEqual({ status: 'done' });
  });

  test('鳴っている発話は hold で止め（読み直さない）、待っている発話は残す', async () => {
    const backend = new FakeBackend({ voiceMs: 5000 });
    startWorker(backend);
    await streamJob('first');
    await waitFor(() => backend.events.some(event => event.kind === 'voice-start') ? true : undefined);
    await streamJob('second');
    await setHold(client, 'mic');
    expect(await finalStatus('first')).toEqual({ status: 'held' });
    expect(backend.voices[0].killed).toBe(true);
    expect(await client.lLen(NORMAL_QUEUE_KEY)).toBe(1);
    await clearHold(client, 'mic');
    await waitFor(() => backend.voices.length === 2 ? true : undefined, 15_000);
    expect(backend.voices[1].killed).toBe(false);
    expect(await client.lLen(NORMAL_QUEUE_KEY)).toBe(0);
  });

  test('古い版の worker から lock を引き取る', async () => {
    await client.set(WORKER_LOCK_KEY, 'old-worker', { PX: 20000 });
    await client.set(WORKER_VERSION_KEY, '2.4.0', { PX: 20000 });
    const worker = startWorker(new FakeBackend());
    await waitFor(async () => (await client.get(WORKER_LOCK_KEY)) === worker.id ? true : undefined);
    expect(await client.get(WORKER_VERSION_KEY)).toBe('2.5.0');
  });

  test('同じ版・新しい版の worker が動いていれば引き取らない', async () => {
    await client.set(WORKER_LOCK_KEY, 'newer-worker', { PX: 20000 });
    await client.set(WORKER_VERSION_KEY, '2.6.0', { PX: 20000 });
    startWorker(new FakeBackend());
    await expect(runs[0]).resolves.toBe('busy');
    expect(await client.get(WORKER_LOCK_KEY)).toBe('newer-worker');
  });

  test('lock を失った 2.5 の worker は終わる', async () => {
    const worker = startWorker(new FakeBackend());
    await waitFor(async () => (await client.get(WORKER_LOCK_KEY)) === worker.id ? true : undefined);
    await client.set(WORKER_LOCK_KEY, 'someone-else', { PX: 20000 });
    await expect(runs[0]).resolves.toBe('stopped');
  });

  test('エージェントの声は合成しながら Stream に流して鳴らし、覚え直す', async () => {
    const backend = new FakeBackend({ canMeasure: true });
    const worker = startWorker(backend, {
      synthesize: async () => Readable.from([mp3Frames(30), mp3Frames(40)]),
      measure: async () => ({ integratedLufs: -25, durationSeconds: 1.9 }),
    });
    const job = await enqueueSynthesis(client, { text: 'こんにちは', provider: 'aivis', model_uuid: 'model-b' });
    expect(await finalStatus(job.id)).toEqual({ status: 'done' });
    expect(backend.voices[0].bytes.length).toBe(417 * 70);
    await worker.flushMeasurements();
    expect({ ...loadLearnedGains(gainFile) }).toEqual({ 'aivis:model-b:default': { db: 5, samples: [5], updatedAt: expect.any(Number) } });
    // 鳴らし終えた Stream は消す
    expect(await client.exists(`aivis-mcp:audio:${job.id}`)).toBe(0);
  });

  test('感情タグ入りの発話は覚え直しに使わない', async () => {
    const backend = new FakeBackend({ canMeasure: true });
    const worker = startWorker(backend, {
      synthesize: async () => Readable.from([mp3Frames(80)]),
      measure: async () => ({ integratedLufs: -25, durationSeconds: 2 }),
    });
    const job = await enqueueSynthesis(client, { text: '[whispers] こんにちは', provider: 'elevenlabs', voice_id: 'v', model_id: 'm' });
    // ElevenLabs のキーが無い設定なので失敗するが、覚え直しもしない
    expect((await finalStatus(job.id)).status).toBe('failed');
    await worker.flushMeasurements();
    expect({ ...loadLearnedGains(gainFile) }).toEqual({});
  });

  test('鳴り始める前の中断は捨てる', async () => {
    const writer = new AudioStreamWriter(client, 'cancel');
    await writer.open();
    writer.write(mp3Frames(2));
    await writer.abort('cancelled');
    await writer.settled();
    await enqueueJob(client, { v: 2, type: 'stream', id: 'cancel', priority: 'normal', source: 'ingest', enqueuedAt: Date.now() });
    const backend = new FakeBackend();
    startWorker(backend);
    expect(await finalStatus('cancel')).toEqual({ status: 'skipped', reason: 'cancelled' });
    expect(backend.voices).toHaveLength(0);
  });

  test('届きながら鳴らし始める（終わりの印を待たない）', async () => {
    const backend = new FakeBackend();
    startWorker(backend);
    const writer = new AudioStreamWriter(client, 'live');
    await writer.open();
    await writer.settled();
    await enqueueJob(client, { v: 2, type: 'stream', id: 'live', priority: 'normal', source: 'ingest', enqueuedAt: Date.now() });
    writer.write(mp3Frames(12)); // 約 300ms ぶん（250ms を超える）
    await waitFor(() => backend.events.some(event => event.kind === 'voice-start') ? true : undefined);
    writer.write(mp3Frames(5));
    await writer.end();
    expect(await finalStatus('live')).toEqual({ status: 'done' });
    expect(backend.voices[0].bytes.length).toBe(417 * 17);
  });

  async function withParaCode(mode: 'accept' | 'drop', run: (port: number, bodies: Buffer[]) => Promise<void>): Promise<void> {
    const bodies: Buffer[] = [];
    const server = http.createServer((request, response) => {
      if (request.url === '/paradis-mcp/health') {
        response.end(JSON.stringify({ instanceId: 'instance' }));
        return;
      }
      if (mode === 'drop') {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'X-Para-Local-Playback': 'accepted' });
      response.flushHeaders();
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await run((server.address() as AddressInfo).port, bodies);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  function sshTarget(port: number) {
    return { ticket: 'ticket', port, instanceId: 'instance', expiresAt: Date.now() + 60_000, localPlayback: true, ingress: 'stream-v1' };
  }

  test('SSH 先: Para Code が引き受けたら、この機械では鳴らさない', async () => {
    await withParaCode('accept', async (port, bodies) => {
      const backend = new FakeBackend();
      startWorker(backend, { synthesize: async () => Readable.from([mp3Frames(10), mp3Frames(10)]) });
      const job = await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(port) });
      expect(await finalStatus(job.id)).toEqual({ status: 'done', reason: 'played-by-para-code' });
      await waitFor(() => bodies.length === 1 ? true : undefined);
      expect(bodies[0].length).toBe(417 * 20);
      expect(backend.voices).toHaveLength(0);
    });
  });

  test('SSH 先: ヘッダーが来ないまま接続に失敗したら、この機械で鳴らす', async () => {
    await withParaCode('drop', async port => {
      const backend = new FakeBackend();
      startWorker(backend, { synthesize: async () => Readable.from([mp3Frames(20)]) });
      const job = await enqueueSynthesis(client, { text: 'リモート', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(port) });
      expect(await finalStatus(job.id)).toEqual({ status: 'done' });
      expect(backend.voices[0].bytes.length).toBe(417 * 20);
    });
  });

  test('取込の発話（source が ingest）は Para Code へ送り返さない', async () => {
    await withParaCode('accept', async (port, bodies) => {
      const backend = new FakeBackend();
      startWorker(backend, { synthesize: async () => Readable.from([mp3Frames(20)]) });
      const job: Job = { v: 2, type: 'synth', id: 'from-ingest', priority: 'normal', source: 'ingest', enqueuedAt: Date.now(), params: { text: 'x', provider: 'aivis', _paraCodeVoiceTarget: sshTarget(port) } };
      await enqueueJob(client, job);
      expect(await finalStatus('from-ingest')).toEqual({ status: 'done' });
      expect(bodies).toHaveLength(0);
      expect(backend.voices).toHaveLength(1);
    });
  });

  test('止められたら今の件に failed（worker-stopped）を積み、プレイヤーを止め、再生 lock を手放す', async () => {
    const backend = new FakeBackend({ voiceMs: 10_000 });
    const worker = startWorker(backend);
    await streamJob('long');
    await waitFor(() => backend.events.some(event => event.kind === 'voice-start') ? true : undefined);
    // 鳴らしている間の再生 lock は短い期限で延長し続ける
    const ttl = await client.pTTL(PLAY_LOCK_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
    await worker.shutdown();
    expect(await finalStatus('long')).toEqual({ status: 'failed', reason: 'worker-stopped' });
    expect(backend.voices[0].killed).toBe(true);
    expect(await client.exists(PLAY_LOCK_KEY)).toBe(0);
    expect(await client.exists(WORKER_LOCK_KEY)).toBe(0);
    await runs[0];
    // 終わりの知らせは 1 回だけ
    const { entries } = await readStatuses(client, 'long', 0);
    expect(entries.filter(entry => !['queued', 'dequeued', 'playing'].includes(entry.status))).toHaveLength(1);
  });

  test('鳴り始める前に中断されたら、鳴っている着信音も止めてから次へ進む', async () => {
    const backend = new FakeBackend({ preludeMs: 5000 });
    startWorker(backend);
    const writer = new AudioStreamWriter(client, 'abort-prelude');
    await writer.open();
    await writer.settled();
    await enqueueJob(client, { v: 2, type: 'stream', id: 'abort-prelude', priority: 'normal', source: 'ingest', enqueuedAt: Date.now(), prelude: { path: preludeFile, volume: 1 } });
    await waitFor(() => backend.preludes.length === 1 ? true : undefined);
    await streamJob('next');
    await writer.abort('cancelled');
    expect(await finalStatus('abort-prelude')).toEqual({ status: 'skipped', reason: 'cancelled' });
    expect(backend.preludeKills).toBe(1);
    expect(await finalStatus('next')).toEqual({ status: 'done' });
    // 次の声は、止めた着信音の後に始まる（重ならない）
    const kinds = backend.events.map(event => event.kind);
    expect(kinds).toEqual(['prelude', 'voice-start', 'voice-end']);
  });

  test('2.5 の列を先に読み、古い列（2.4 の RPUSH が混ざっても）も鳴らす', async () => {
    await client.rPush(LEGACY_QUEUE_KEY, JSON.stringify({ _audioBase64: mp3Frames(2, 1).toString('base64') }));
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2, 2).toString('base64') });
    await streamJob('q2', { volumeDb: -5 });
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(() => backend.voices.length === 3 ? true : undefined);
    expect(backend.voices[0].gainDb).toBe(-5);
    expect(backend.voices.slice(1).map(voice => voice.bytes[10]).sort()).toEqual([1, 2]);
  });

  test('古い --play-audio の音声にも音量の表と上乗せを当てる', async () => {
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2).toString('base64'), gainKey: 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default' });
    await enqueueLegacy(client, { _audioBase64: mp3Frames(2).toString('base64') });
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(() => backend.voices.length === 2 ? true : undefined);
    expect(backend.voices.map(voice => voice.gainDb)).toEqual([4.1, 0]);
  });

  test('sound の理由: 許可フォルダの外・プレイヤーが無い', async () => {
    const outside = path.join(os.tmpdir(), `aivis-outside-${process.pid}.wav`);
    fs.writeFileSync(outside, 'RIFF');
    try {
      await enqueueJob(client, { v: 2, type: 'sound', id: 'outside', priority: 'normal', source: 'ingest', enqueuedAt: Date.now(), prelude: { path: outside, volume: 1 } });
      startWorker(new FakeBackend());
      expect(await finalStatus('outside')).toEqual({ status: 'failed', reason: 'prelude-outside-allowed-dirs' });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('sound の理由: プレイヤーが無い', async () => {
    await enqueueJob(client, { v: 2, type: 'sound', id: 'noplayer', priority: 'normal', source: 'ingest', enqueuedAt: Date.now(), prelude: { path: preludeFile, volume: 1 } });
    startWorker(new FakeBackend({ kind: 'none' }));
    expect(await finalStatus('noplayer')).toEqual({ status: 'failed', reason: 'no-player' });
  });

  test('hold の待ち手はタイムアウトで外れ、溜まらない', async () => {
    await setHold(client, 'mic');
    const worker = startWorker(new FakeBackend());
    await waitFor(() => worker.isHeld ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(worker.holdWaiterCount).toBeLessThanOrEqual(1);
    await clearHold(client, 'mic');
  });

  test('再生 lock を失ったら、鳴らしている発話を止めて failed（play-lock-lost）で終える', async () => {
    const backend = new FakeBackend({ voiceMs: 10_000 });
    startWorker(backend);
    await streamJob('stolen');
    await waitFor(() => backend.events.some(event => event.kind === 'voice-start') ? true : undefined);
    await client.set(PLAY_LOCK_KEY, 'someone-else', { PX: 10_000 });
    expect(await finalStatus('stolen')).toEqual({ status: 'failed', reason: 'play-lock-lost' });
    expect(backend.voices[0].killed).toBe(true);
  });
});


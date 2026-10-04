import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import type { RedisClientType } from 'redis';
import { IngestSession } from '../../src/ingest/ingest.js';
import { PlaybackWorker } from '../../src/worker/playback-worker.js';
import { encodeAudio, encodeControl, FrameDecoder } from '../../src/streaming/frame-protocol.js';
import { HIGH_QUEUE_KEY, holdKey, NORMAL_QUEUE_KEY } from '../../src/queue/keys.js';
import { connect, hasRedisServer, startTestRedis, waitFor, type TestRedis } from '../helpers/redis.js';
import { FakeBackend } from '../helpers/fake-backend.js';
import { mp3Frames, testConfig } from '../helpers/fixtures.js';

const describeRedis = hasRedisServer ? describe : describe.skip;

describeRedis('--ingest（別ポートの redis-server）', () => {
  let redis: TestRedis;
  let client: RedisClientType;
  let sessionClient: RedisClientType;
  let tempDir: string;
  let input: PassThrough;
  let messages: Record<string, unknown>[];
  let session: IngestSession;
  let worker: PlaybackWorker | undefined;
  let workerRun: Promise<unknown> | undefined;

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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-ingest-')));
    fs.writeFileSync(path.join(tempDir, 'chime.wav'), 'RIFF');
    sessionClient = await connect(redis.url);
    input = new PassThrough();
    messages = [];
    const decoder = new FrameDecoder();
    session = new IngestSession(sessionClient, testConfig(redis.url), [tempDir], {
      input,
      write: frame => {
        for (const decoded of decoder.push(frame)) {
          if (decoded.kind === 'control') {
            messages.push(decoded.message);
          }
        }
      },
    }, { spawnWorker: false });
    session.start();
  });

  afterEach(async () => {
    input.end();
    await session.closedPromise;
    await sessionClient.disconnect().catch(() => undefined);
    worker?.stop();
    await workerRun;
    worker = undefined;
    workerRun = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function startWorker(backend: FakeBackend): void {
    worker = new PlaybackWorker({
      redisUrl: redis.url,
      version: '2.5.0',
      loadConfig: () => testConfig(redis.url),
      backend,
      synthesize: async () => Readable.from([]),
      gainFile: path.join(tempDir, 'gain.json'),
    });
    workerRun = worker.run();
  }

  function statusesOf(id: string): unknown[] {
    return messages.filter(message => message.id === id).map(message => message.type === 'status' ? message.status : message.type);
  }

  test('最初の枠で取り決めの版と aivis-mcp の版を名乗る', () => {
    expect(messages[0]).toEqual({ type: 'hello', protocol: 1, version: expect.any(String) });
  });

  test('open で即積み、流し込んだ声を worker が鳴らし、進み具合を返す', async () => {
    const backend = new FakeBackend();
    startWorker(backend);
    input.write(encodeControl({ type: 'open', id: 'n1', priority: 'high', gainKey: 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default', volumeDb: -2, prelude: { path: path.join(tempDir, 'chime.wav'), volume: 0.3 } }));
    await waitFor(() => statusesOf('n1').includes('queued') ? true : undefined);
    input.write(encodeAudio('n1', mp3Frames(10)));
    input.write(encodeAudio('n1', mp3Frames(10)));
    input.write(encodeControl({ type: 'end', id: 'n1' }));
    await waitFor(() => statusesOf('n1').includes('done') ? true : undefined);
    expect(statusesOf('n1')).toEqual(['accepted', 'queued', 'playing', 'done']);
    expect(backend.preludes).toEqual([path.join(tempDir, 'chime.wav')]);
    expect(backend.voices[0].gainDb).toBe(2.1);
    expect(backend.voices[0].bytes.length).toBe(417 * 20);
  });

  test('許可フォルダの外の着信音は付けずに積む', async () => {
    input.write(encodeControl({ type: 'open', id: 'x1', prelude: { path: '/etc/hosts.wav', volume: 1 } }));
    await waitFor(() => statusesOf('x1').includes('queued') ? true : undefined);
    expect(messages.find(message => message.type === 'accepted')).toEqual({ type: 'accepted', id: 'x1', preludeRejected: 'not-found' });
    const raw = await client.lRange(NORMAL_QUEUE_KEY, 0, -1);
    expect(JSON.parse(raw[0]).prelude).toBeUndefined();
  });

  test('sound（着信音だけ）を積める。着信音が無ければ断る', async () => {
    input.write(encodeControl({ type: 'open', id: 's1', kind: 'sound', priority: 'high', prelude: { path: path.join(tempDir, 'chime.wav'), volume: 1 } }));
    input.write(encodeControl({ type: 'open', id: 's2', kind: 'sound' }));
    await waitFor(() => statusesOf('s1').includes('queued') && statusesOf('s2').length > 0 ? true : undefined);
    expect(JSON.parse((await client.lRange(HIGH_QUEUE_KEY, 0, -1))[0]).type).toBe('sound');
    expect(messages.find(message => message.id === 's2')).toEqual({ type: 'status', id: 's2', status: 'failed', reason: 'prelude-required' });
  });

  test('鳴り始める前の abort は列から外す', async () => {
    input.write(encodeControl({ type: 'open', id: 'a1' }));
    await waitFor(() => statusesOf('a1').includes('queued') ? true : undefined);
    input.write(encodeControl({ type: 'abort', id: 'a1', reason: 'ssh-closed' }));
    await waitFor(() => statusesOf('a1').includes('skipped') ? true : undefined);
    expect(await client.lLen(NORMAL_QUEUE_KEY)).toBe(0);
  });

  test('流れ 1 本 8MiB を超えたら打ち切る', async () => {
    input.write(encodeControl({ type: 'open', id: 'big' }));
    await waitFor(() => statusesOf('big').includes('queued') ? true : undefined);
    const chunk = Buffer.alloc(1024 * 1024 - 64);
    for (let i = 0; i < 9; i++) {
      input.write(encodeAudio('big', chunk));
    }
    await waitFor(() => messages.some(message => message.id === 'big' && message.reason === 'too-large') ? true : undefined);
  });

  test('hold を置く・外す。閉じたら自分の hold を外す', async () => {
    input.write(encodeControl({ type: 'hold', owner: 'voice-input', active: true }));
    await waitFor(() => messages.some(message => message.type === 'hold') ? true : undefined);
    expect(await client.pTTL(holdKey('voice-input'))).toBeGreaterThan(50_000);
    input.write(encodeControl({ type: 'hold', owner: 'voice-input', active: false }));
    await waitFor(async () => (await client.exists(holdKey('voice-input'))) === 0 ? true : undefined);
    input.write(encodeControl({ type: 'hold', owner: 'other', active: true }));
    await waitFor(async () => (await client.exists(holdKey('other'))) === 1 ? true : undefined);
    input.end();
    await session.closedPromise;
    expect(await client.exists(holdKey('other'))).toBe(0);
  });

  test('gain? に音量の表を返す', async () => {
    input.write(encodeControl({ type: 'gain?', requestId: 'r1' }));
    const reply = await waitFor(() => messages.find(message => message.type === 'gain'));
    expect(reply).toMatchObject({ requestId: 'r1', target: -20, maxBoostDb: 8, defaultDb: 0 });
    expect((reply.entries as Record<string, number>)['aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default']).toBe(4.1);
  });

  test('worker の lock が 30 秒無ければ、取り出されていないジョブを取り下げて知らせる', async () => {
    input.write(encodeControl({ type: 'open', id: 'w1' }));
    await waitFor(() => statusesOf('w1').includes('queued') ? true : undefined);
    const now = Date.now();
    await session.checkWorker(now);
    expect(await client.lLen(NORMAL_QUEUE_KEY)).toBe(1);
    await session.checkWorker(now + 30_000);
    expect(messages.find(message => message.id === 'w1' && message.status === 'failed')).toEqual({ type: 'status', id: 'w1', status: 'failed', reason: 'worker-unavailable', withdrawn: true });
    expect(await client.lLen(NORMAL_QUEUE_KEY)).toBe(0);
  });

  test('壊れた枠を受けたら知らせて終わる', async () => {
    input.write(Buffer.from([0x07, 0, 0, 0, 1, 0]));
    await session.closedPromise;
    expect(messages.some(message => message.type === 'error' && message.reason === 'protocol')).toBe(true);
  });
});

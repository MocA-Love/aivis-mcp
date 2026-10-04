import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import type { RedisClientType } from 'redis';
import { IngestSession } from '../../src/ingest/ingest.js';
import { PlaybackWorker } from '../../src/worker/playback-worker.js';
import { encodeAudio, encodeControl, FrameDecoder } from '../../src/streaming/frame-protocol.js';
import { audioStreamKey, PLAY_LOCK_KEY, HIGH_QUEUE_KEY, holdKey, NORMAL_QUEUE_KEY, preludeDirsKey, statusKey, WORKER_LOCK_KEY } from '../../src/queue/keys.js';
import { createIngestClient } from '../../src/ingest/ingest.js';
import { setMute } from '../../src/services/mute-service.js';
import { setHold, clearHold } from '../../src/queue/hold.js';
import { connect, describeWithRedis, startTestRedis, waitFor, type TestRedis } from '../helpers/redis.js';
import { FakeBackend } from '../helpers/fake-backend.js';
import { mp3Frames, testConfig } from '../helpers/fixtures.js';

describeWithRedis('--ingest（別ポートの redis-server）', () => {
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
    session = new IngestSession(sessionClient, () => testConfig(redis.url), [tempDir], {
      input,
      write: frame => {
        for (const decoded of decoder.push(frame)) {
          if (decoded.kind === 'control') {
            messages.push(decoded.message);
          }
        }
      },
    }, { spawnWorker: false });
    await session.publishPreludeDirs();
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

  function terminalCount(id: string): number {
    return messages.filter(message => message.id === id && message.type === 'status' && ['done', 'skipped', 'held', 'muted', 'failed'].includes(message.status as string)).length;
  }

  test('終わった件の Stream キーは、後から来た枠で作り直されない（ミュート中）', async () => {
    await setMute(client, undefined);
    startWorker(new FakeBackend());
    input.write(encodeControl({ type: 'open', id: 'm1' }));
    input.write(encodeAudio('m1', mp3Frames(5)));
    await waitFor(() => statusesOf('m1').includes('muted') ? true : undefined);
    // 終わりを知らされた後にも親は少し送ってくる
    input.write(encodeAudio('m1', mp3Frames(5)));
    input.write(encodeControl({ type: 'end', id: 'm1' }));
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(await client.exists(audioStreamKey('m1'))).toBe(0);
    expect(messages.some(message => message.type === 'error')).toBe(false);
    expect(terminalCount('m1')).toBe(1);
  });

  test('Stream のキーには必ず期限が付く', async () => {
    input.write(encodeControl({ type: 'open', id: 'ttl1' }));
    input.write(encodeAudio('ttl1', mp3Frames(30)));
    await waitFor(async () => (await client.xLen(audioStreamKey('ttl1'))) >= 2 ? true : undefined);
    const ttl = await client.ttl(audioStreamKey('ttl1'));
    expect(ttl).toBeGreaterThan(0);
  });

  test('too-large の終わりは 1 回だけ', async () => {
    startWorker(new FakeBackend());
    input.write(encodeControl({ type: 'open', id: 'big2' }));
    await waitFor(() => statusesOf('big2').includes('queued') ? true : undefined);
    const chunk = Buffer.alloc(1024 * 1024 - 64);
    for (let i = 0; i < 9; i++) {
      input.write(encodeAudio('big2', chunk));
    }
    await waitFor(() => terminalCount('big2') > 0 ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(terminalCount('big2')).toBe(1);
    expect(messages.filter(message => message.id === 'big2' && message.type === 'error')).toHaveLength(0);
  });

  test('知らせのキーが期限切れで消えても、頭から読み直して終わりを返す', async () => {
    await setHold(client, 'mic');
    startWorker(new FakeBackend());
    await waitFor(() => worker!.isHeld ? true : undefined);
    input.write(encodeControl({ type: 'open', id: 'exp1', priority: 'high' }));
    input.write(encodeAudio('exp1', mp3Frames(5)));
    input.write(encodeControl({ type: 'end', id: 'exp1' }));
    await waitFor(() => statusesOf('exp1').includes('queued') ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 300));
    await client.del(statusKey('exp1'));
    await clearHold(client, 'mic');
    await waitFor(() => statusesOf('exp1').includes('done') ? true : undefined);
  });

  test('枠が溜まったら標準入力を止め、進んだら再開する', async () => {
    input.write(encodeControl({ type: 'open', id: 'bp' }));
    await waitFor(() => statusesOf('bp').includes('queued') ? true : undefined);
    const frames = Buffer.concat(Array.from({ length: 600 }, () => encodeAudio('bp', Buffer.alloc(100))));
    input.write(frames);
    await waitFor(() => session.isPaused ? true : undefined, 2000, 1);
    await waitFor(() => !session.isPaused ? true : undefined);
  });

  test('壊れた枠の知らせは 1 回だけ、以後の入力は捨てる', async () => {
    input.write(Buffer.from([0x07, 0, 0, 0, 1, 0]));
    input.write(Buffer.from([0x08, 0, 0, 0, 1, 0]));
    input.write(encodeControl({ type: 'ping', requestId: 1 }));
    await session.closedPromise;
    expect(messages.filter(message => message.type === 'error')).toHaveLength(1);
    expect(messages.some(message => message.type === 'pong')).toBe(false);
  });

  test('取り出されたのに playing が来ない件は failed（lost）を返す', async () => {
    await client.set(WORKER_LOCK_KEY, 'someone', { PX: 60_000 });
    input.write(encodeControl({ type: 'open', id: 'lost1' }));
    await waitFor(() => statusesOf('lost1').includes('queued') ? true : undefined);
    // worker が取り出して落ちた
    await client.rPop(NORMAL_QUEUE_KEY);
    const now = Date.now();
    await session.checkWorker(now);
    expect(terminalCount('lost1')).toBe(0);
    await session.checkWorker(now + 30_000);
    expect(messages.find(message => message.id === 'lost1' && message.status === 'failed')).toEqual({ type: 'status', id: 'lost1', status: 'failed', reason: 'lost' });
    expect(session.trackedCount).toBe(0);
  });

  test('playing の後に終わりが来ない件も failed（lost）を返す', async () => {
    await client.set(WORKER_LOCK_KEY, 'someone', { PX: 60_000 });
    input.write(encodeControl({ type: 'open', id: 'lost2' }));
    await waitFor(() => statusesOf('lost2').includes('queued') ? true : undefined);
    await client.rPop(NORMAL_QUEUE_KEY);
    await client.rPush(statusKey('lost2'), JSON.stringify({ s: 'playing', t: Date.now() }));
    await waitFor(() => statusesOf('lost2').includes('playing') ? true : undefined);
    await session.checkWorker(Date.now() + 181_000);
    expect(messages.find(message => message.id === 'lost2' && message.status === 'failed')).toMatchObject({ reason: 'lost' });
  });

  test('追跡の上限を越えた件は failed（untracked）を返す', async () => {
    let clock = Date.now();
    const own = new PassThrough();
    const ownMessages: Record<string, unknown>[] = [];
    const decoder = new FrameDecoder();
    const ownClient = await connect(redis.url);
    const own_session = new IngestSession(ownClient, () => testConfig(redis.url), [], {
      input: own,
      write: frame => { for (const f of decoder.push(frame)) { if (f.kind === 'control') ownMessages.push(f.message); } },
    }, { spawnWorker: false, now: () => clock });
    own_session.start();
    try {
      own.write(encodeControl({ type: 'open', id: 'old1' }));
      await waitFor(() => ownMessages.some(m => m.id === 'old1' && m.status === 'queued') ? true : undefined);
      clock += 16 * 60_000;
      await own_session.pollStatuses();
      expect(ownMessages.find(m => m.id === 'old1' && m.status === 'failed')).toEqual({ type: 'status', id: 'old1', status: 'failed', reason: 'untracked' });
    } finally {
      own.end();
      await own_session.closedPromise;
      await ownClient.disconnect();
    }
  });

  test('gain? の上乗せは毎回いまの設定から読む', async () => {
    let offset = 0;
    const own = new PassThrough();
    const ownMessages: Record<string, unknown>[] = [];
    const decoder = new FrameDecoder();
    const ownClient = await connect(redis.url);
    const own_session = new IngestSession(ownClient, () => ({ ...testConfig(redis.url), volumeOffsetDb: offset }), [], {
      input: own,
      write: frame => { for (const f of decoder.push(frame)) { if (f.kind === 'control') ownMessages.push(f.message); } },
    }, { spawnWorker: false });
    own_session.start();
    try {
      own.write(encodeControl({ type: 'gain?', requestId: 'a' }));
      await waitFor(() => ownMessages.some(m => m.requestId === 'a') ? true : undefined);
      offset = -4;
      own.write(encodeControl({ type: 'gain?', requestId: 'b' }));
      const reply = await waitFor(() => ownMessages.find(m => m.requestId === 'b'));
      expect(reply.volumeOffsetDb).toBe(-4);
    } finally {
      own.end();
      await own_session.closedPromise;
      await ownClient.disconnect();
    }
  });

  test('起動時に許可フォルダを worker 向けに置く', async () => {
    // --ingest ごとのキーで、起動時（名乗る前）に置く。期限は 90 秒
    const key = preludeDirsKey(session.ingestId);
    expect(await client.sIsMember(key, tempDir)).toBe(true);
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
  });

  test('Redis が止まっても固まらず、open に failed（redis-error）を返して閉じられる', async () => {
    const own = await startTestRedis();
    const ownClient = createIngestClient(own.url);
    await ownClient.connect();
    const ownInput = new PassThrough();
    const ownMessages: Record<string, unknown>[] = [];
    const decoder = new FrameDecoder();
    const own_session = new IngestSession(ownClient, () => testConfig(own.url), [], {
      input: ownInput,
      write: frame => { for (const f of decoder.push(frame)) { if (f.kind === 'control') ownMessages.push(f.message); } },
    }, { spawnWorker: false });
    own_session.start();
    try {
      await own.stop();
      ownInput.write(encodeControl({ type: 'open', id: 'r1' }));
      ownInput.write(encodeAudio('r1', mp3Frames(3)));
      const failed = await waitFor(() => ownMessages.find(m => m.id === 'r1' && m.status === 'failed'), 10_000);
      expect(failed.reason).toBe('redis-error');
      const started = Date.now();
      ownInput.end();
      await own_session.closedPromise;
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await ownClient.disconnect().catch(() => undefined);
    }
  });

  function ownSession(options: { url?: string; now?: () => number; backpressureBytes?: number; client?: RedisClientType }) {
    const ownInput = new PassThrough();
    const ownMessages: Record<string, unknown>[] = [];
    const decoder = new FrameDecoder();
    const ownClient = options.client ?? createIngestClient(options.url ?? redis.url);
    const ownSessionObject = new IngestSession(ownClient, () => testConfig(options.url ?? redis.url), [], {
      input: ownInput,
      write: frame => { for (const f of decoder.push(frame)) { if (f.kind === 'control') ownMessages.push(f.message); } },
    }, { spawnWorker: false, now: options.now, backpressureBytes: options.backpressureBytes });
    return { input: ownInput, messages: ownMessages, client: ownClient, session: ownSessionObject };
  }

  test('Redis への書き残しで止めた標準入力は、書き終わるにつれて再開する', async () => {
    const own = ownSession({ backpressureBytes: 1024 * 1024 });
    await own.client.connect();
    own.session.start();
    try {
      own.input.write(encodeControl({ type: 'open', id: 'wb' }));
      await waitFor(() => own.messages.some(m => m.id === 'wb' && m.status === 'queued') ? true : undefined);
      const chunk = Buffer.alloc(700 * 1024, 1);
      own.input.write(Buffer.concat([encodeAudio('wb', chunk), encodeAudio('wb', chunk), encodeAudio('wb', chunk)]));
      await waitFor(() => own.session.isPaused ? true : undefined, 5000, 1);
      await waitFor(() => !own.session.isPaused ? true : undefined);
      own.input.write(encodeControl({ type: 'end', id: 'wb' }));
      const total = await waitFor(async () => {
        const entries = await client.xRange(audioStreamKey('wb'), '-', '+');
        const ended = entries.some(entry => entry.message.e !== undefined);
        return ended ? entries.reduce((sum, entry) => sum + (entry.message.d?.length ?? 0), 0) : undefined;
      });
      // 文字列として読むので長さは目安。3 枠分すべて届いている
      expect(total).toBeGreaterThan(0);
      expect(await client.xLen(audioStreamKey('wb'))).toBeGreaterThanOrEqual(4);
    } finally {
      own.input.end();
      await own.session.closedPromise;
      await own.client.disconnect().catch(() => undefined);
    }
  });

  test('流れの途中で Redis が切れたら、その流れを failed（redis-error）で終える', async () => {
    const red = await startTestRedis();
    const own = ownSession({ url: red.url });
    await own.client.connect();
    own.session.start();
    try {
      own.input.write(encodeControl({ type: 'open', id: 'cut' }));
      await waitFor(() => own.messages.some(m => m.id === 'cut' && m.status === 'queued') ? true : undefined);
      await red.stop();
      own.input.write(encodeAudio('cut', mp3Frames(30)));
      own.input.write(encodeControl({ type: 'end', id: 'cut' }));
      const failed = await waitFor(() => own.messages.find(m => m.id === 'cut' && m.status === 'failed'), 10_000);
      expect(failed.reason).toBe('redis-error');
      expect(own.messages.filter(m => m.id === 'cut' && ['done', 'failed', 'skipped'].includes(m.status as string))).toHaveLength(1);
    } finally {
      own.input.end();
      await own.session.closedPromise;
      await own.client.disconnect().catch(() => undefined);
    }
  });

  test('worker が取り出した（dequeued）後は、再生 lock を待つ間も見失ったとみなさない', async () => {
    await client.set(WORKER_LOCK_KEY, 'worker-a', { PX: 120_000 });
    input.write(encodeControl({ type: 'open', id: 'dq' }));
    await waitFor(() => statusesOf('dq').includes('queued') ? true : undefined);
    await client.rPop(NORMAL_QUEUE_KEY);
    await client.rPush(statusKey('dq'), JSON.stringify({ s: 'dequeued', t: Date.now() }));
    await session.pollStatuses();
    const now = Date.now();
    await session.checkWorker(now);
    await session.checkWorker(now + 120_000);
    expect(terminalCount('dq')).toBe(0);
    // worker が落ちた（lock が 30 秒無い）ときだけ lost。Stream は消さず期限切れに任せる
    await client.del(WORKER_LOCK_KEY);
    await session.checkWorker(now + 130_000);
    await session.checkWorker(now + 160_000);
    expect(messages.find(m => m.id === 'dq' && m.status === 'failed')).toMatchObject({ reason: 'lost' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await client.exists(audioStreamKey('dq'))).toBe(1);
  });

  test('再生 lock をほかが持つ間は、列から消えた件の時間を数えない', async () => {
    await client.set(WORKER_LOCK_KEY, 'worker-a', { PX: 120_000 });
    await client.set(PLAY_LOCK_KEY, 'old-worker', { PX: 120_000 });
    input.write(encodeControl({ type: 'open', id: 'pl' }));
    await waitFor(() => statusesOf('pl').includes('queued') ? true : undefined);
    await client.rPop(NORMAL_QUEUE_KEY);
    const now = Date.now();
    await session.checkWorker(now);
    await session.checkWorker(now + 60_000);
    expect(terminalCount('pl')).toBe(0);
    await client.del(PLAY_LOCK_KEY);
    await session.checkWorker(now + 70_000);
    await session.checkWorker(now + 100_000);
    expect(messages.find(m => m.id === 'pl' && m.status === 'failed')).toMatchObject({ reason: 'lost' });
  });

  test('追跡の上限（15 分）は hold の時間を差し引く', async () => {
    let clock = Date.now();
    const own = ownSession({ now: () => clock });
    await own.client.connect();
    own.session.start();
    try {
      own.input.write(encodeControl({ type: 'open', id: 'hh' }));
      await waitFor(() => own.messages.some(m => m.id === 'hh' && m.status === 'queued') ? true : undefined);
      await client.set(WORKER_LOCK_KEY, 'worker-a', { PX: 120_000 });
      await setHold(client, 'mic');
      await own.session.checkWorker(clock);
      clock += 10 * 60_000;
      await own.session.checkWorker(clock);
      await clearHold(client, 'mic');
      clock += 6 * 60_000;
      await own.session.pollStatuses();
      expect(own.messages.some(m => m.id === 'hh' && m.status === 'failed')).toBe(false);
      clock += 10 * 60_000;
      await own.session.pollStatuses();
      expect(own.messages.find(m => m.id === 'hh' && m.status === 'failed')).toMatchObject({ reason: 'untracked' });
    } finally {
      own.input.end();
      await own.session.closedPromise;
      await own.client.disconnect().catch(() => undefined);
    }
  });

  test('別の --ingest（落ちた前の子）が積んだジョブも withdraw で外せる。取り出し済みなら外さない', async () => {
    const previous = ownSession({});
    await previous.client.connect();
    previous.session.start();
    previous.input.write(encodeControl({ type: 'open', id: 'prev1' }));
    previous.input.write(encodeAudio('prev1', mp3Frames(5)));
    previous.input.write(encodeControl({ type: 'open', id: 'prev2' }));
    previous.input.write(encodeControl({ type: 'open', id: 'other' }));
    await waitFor(() => ['prev1', 'prev2', 'other'].every(id => previous.messages.some(m => m.id === id && m.status === 'queued')) ? true : undefined);
    // 前の子が落ちた（流れは中断せずに消えたことにする）
    previous.input.pause();
    // prev2 は worker が取り出した後
    const raw = (await client.lRange(NORMAL_QUEUE_KEY, 0, -1)).find(item => JSON.parse(item).id === 'prev2')!;
    await client.lRem(NORMAL_QUEUE_KEY, 1, raw);
    await client.rPush(statusKey('prev2'), JSON.stringify({ s: 'dequeued', t: Date.now() }));

    input.write(encodeControl({ type: 'withdraw', id: 'prev1' }));
    input.write(encodeControl({ type: 'withdraw', id: 'prev2' }));
    input.write(encodeControl({ type: 'withdraw', id: 'prev1' }));
    await waitFor(() => messages.filter(m => m.type === 'withdrawn').length === 3 ? true : undefined);
    expect(messages.filter(m => m.type === 'withdrawn')).toEqual([
      { type: 'withdrawn', id: 'prev1', removed: true },
      { type: 'withdrawn', id: 'prev2', removed: false },
      { type: 'withdrawn', id: 'prev1', removed: false },
    ]);
    // ほかのジョブは巻き込まない。外した件の Stream と知らせは消える
    expect((await client.lRange(NORMAL_QUEUE_KEY, 0, -1)).map(item => JSON.parse(item).id)).toEqual(['other']);
    expect(await client.exists(audioStreamKey('prev1'))).toBe(0);
    expect(await client.exists(statusKey('prev1'))).toBe(0);
    previous.input.resume();
    previous.input.end();
    await previous.session.closedPromise;
    await previous.client.disconnect().catch(() => undefined);
  });
});


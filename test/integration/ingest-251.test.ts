import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import type { RedisClientType } from 'redis';
import { createIngestClient, IngestSession } from '../../src/ingest/ingest.js';
import { PlaybackWorker } from '../../src/worker/playback-worker.js';
import { encodeAudio, encodeControl, FrameDecoder } from '../../src/streaming/frame-protocol.js';
import { audioStreamKey, HIGH_QUEUE_KEY, NORMAL_QUEUE_KEY, PLAY_LOCK_KEY, statusKey, WORKER_LOCK_KEY } from '../../src/queue/keys.js';
import { connect, describeWithRedis, startTestRedis, waitFor, type TestRedis } from '../helpers/redis.js';
import { startRedisProxy, type RedisProxy } from '../helpers/redis-proxy.js';
import { FakeBackend } from '../helpers/fake-backend.js';
import { mp3Frames, testConfig } from '../helpers/fixtures.js';

describeWithRedis('--ingest の 2.5.1 の直し（別ポートの redis-server）', () => {
  let redis: TestRedis;
  let client: RedisClientType;
  let tempDir: string;
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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-ingest251-')));
    fs.writeFileSync(path.join(tempDir, 'chime.wav'), 'RIFF');
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** --ingest を 1 つ起こす。`url` を変えると中継（障害の真似）越しに Redis へつなぐ。 */
  async function session(options: { url?: string; now?: () => number; opTimeoutMs?: number } = {}) {
    const input = new PassThrough();
    const messages: (Record<string, unknown> & { at: number })[] = [];
    const decoder = new FrameDecoder();
    const sessionClient = createIngestClient(options.url ?? redis.url);
    await sessionClient.connect();
    const ingest = new IngestSession(sessionClient, () => testConfig(redis.url), [tempDir], {
      input,
      write: frame => {
        for (const decoded of decoder.push(frame)) {
          if (decoded.kind === 'control') {
            messages.push({ ...decoded.message, at: Date.now() });
          }
        }
      },
    }, { spawnWorker: false, now: options.now, opTimeoutMs: options.opTimeoutMs });
    await ingest.publishPreludeDirs();
    ingest.start();
    cleanups.push(async () => {
      input.end();
      await ingest.closedPromise;
      await sessionClient.disconnect().catch(() => undefined);
    });
    const statusesOf = (id: string) => messages.filter(message => message.id === id).map(message => message.type === 'status' ? message.status : message.type);
    return { input, messages, ingest, statusesOf };
  }

  async function proxied(): Promise<RedisProxy> {
    const proxy = await startRedisProxy(redis.url);
    cleanups.push(async () => {
      proxy.release();
      await proxy.close();
    });
    return proxy;
  }

  function startWorker(backend: FakeBackend): void {
    const worker = new PlaybackWorker({
      redisUrl: redis.url,
      version: '2.5.1',
      loadConfig: () => testConfig(redis.url),
      backend,
      synthesize: async () => Readable.from([]),
      gainFile: path.join(tempDir, 'gain.json'),
    });
    const run = worker.run();
    cleanups.push(async () => {
      worker.stop();
      await run;
    });
  }

  test('[HIGH 5] 積んだ応答が失われても failed を返さず、ID で確かめてから queued を返す', async () => {
    const proxy = await proxied();
    const own = await session({ url: proxy.url, opTimeoutMs: 400 });
    // Redis は積むが、返事が返らない
    proxy.holdResponses();
    own.input.write(encodeControl({ type: 'open', id: 'lost-reply', kind: 'sound', prelude: { path: path.join(tempDir, 'chime.wav'), volume: 1 } }));
    await waitFor(() => own.statusesOf('lost-reply').includes('accepted') ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    // 分からない間は、親が自分で鳴らしてよい知らせ（failed）を返さない
    expect(own.statusesOf('lost-reply')).toEqual(['accepted']);
    proxy.release();
    await waitFor(() => own.statusesOf('lost-reply').includes('queued') ? true : undefined);
    expect(own.statusesOf('lost-reply')).toEqual(['accepted', 'queued']);
    // 積んだのは 1 回だけ
    expect((await client.lRange(NORMAL_QUEUE_KEY, 0, -1)).filter(raw => JSON.parse(raw).id === 'lost-reply')).toHaveLength(1);
  });

  test('[HIGH 5] 積めていないと確かめた件だけ withdrawn を付けて返す', async () => {
    const own = await startTestRedis();
    const ownSession = await session({ url: own.url });
    await own.stop();
    ownSession.input.write(encodeControl({ type: 'open', id: 'down' }));
    const failed = await waitFor(() => ownSession.messages.find(message => message.id === 'down' && message.status === 'failed'), 10_000);
    expect(failed).toMatchObject({ reason: 'redis-error', withdrawn: true });
  });

  test('[HIGH 6] Redis への書き込みが詰まっても、hold と ping は後ろに並ばない', async () => {
    const proxy = await proxied();
    const own = await session({ url: proxy.url, opTimeoutMs: 2000 });
    own.input.write(encodeControl({ type: 'open', id: 'w1' }));
    await waitFor(() => own.statusesOf('w1').includes('queued') ? true : undefined);
    proxy.stall();
    // 流れの書き込み・次の open（どれも Redis を待つ）の後ろに、ping と hold を送る
    own.input.write(encodeAudio('w1', mp3Frames(30)));
    own.input.write(encodeControl({ type: 'end', id: 'w1' }));
    own.input.write(encodeControl({ type: 'open', id: 'w2' }));
    own.input.write(encodeControl({ type: 'abort', id: 'w1', reason: 'x' }));
    const sentAt = Date.now();
    own.input.write(encodeControl({ type: 'ping', requestId: 7 }));
    own.input.write(encodeControl({ type: 'hold', owner: 'mic', active: true }));
    const pong = await waitFor(() => own.messages.find(message => message.type === 'pong'), 5000);
    expect(pong.at - sentAt).toBeLessThan(500);
    // hold は Redis に書けないので失敗を返すが、1 回の操作の上限で返る（前の open の待ちに巻き込まれない）
    const holdReply = await waitFor(() => own.messages.find(message => (message.type === 'hold' || message.type === 'error') && message.owner === 'mic'), 10_000);
    expect(holdReply.at - sentAt).toBeLessThan(3000);
    proxy.release();
  });

  test('[MEDIUM 9] end を送った流れも、終わりの知らせを返すまで 32MiB の合計に数える', async () => {
    const own = await session();
    const chunk = Buffer.alloc(1024 * 1024 - 64);
    // 7MiB の流れを 4 本、end まで送る（worker がいないので鳴り終わらない）
    for (const id of ['a', 'b', 'c', 'd']) {
      own.input.write(encodeControl({ type: 'open', id }));
      for (let i = 0; i < 7; i++) {
        own.input.write(encodeAudio(id, chunk));
      }
      own.input.write(encodeControl({ type: 'end', id }));
    }
    await waitFor(() => ['a', 'b', 'c', 'd'].every(id => own.statusesOf(id).includes('queued')) ? true : undefined);
    own.input.write(encodeControl({ type: 'open', id: 'e' }));
    for (let i = 0; i < 6; i++) {
      own.input.write(encodeAudio('e', chunk));
    }
    const failed = await waitFor(() => own.messages.find(message => message.id === 'e' && message.status === 'failed'), 20_000);
    expect(failed).toMatchObject({ reason: 'too-large' });
    expect(own.messages.filter(message => ['a', 'b', 'c', 'd'].includes(message.id as string) && message.status === 'failed')).toHaveLength(0);
  });

  test('[MEDIUM 10] end の後の abort も、鳴り始める前なら効く', async () => {
    const own = await session();
    const backend = new FakeBackend({ preludeMs: 3000 });
    startWorker(backend);
    own.input.write(encodeControl({ type: 'open', id: 'ea', prelude: { path: path.join(tempDir, 'chime.wav'), volume: 1 } }));
    own.input.write(encodeAudio('ea', mp3Frames(20)));
    own.input.write(encodeControl({ type: 'end', id: 'ea' }));
    await waitFor(() => own.statusesOf('ea').includes('playing') ? true : undefined);
    own.input.write(encodeControl({ type: 'abort', id: 'ea', reason: 'ssh-closed' }));
    await waitFor(() => own.statusesOf('ea').includes('skipped') ? true : undefined);
    expect(own.messages.find(message => message.id === 'ea' && message.status === 'skipped')).toMatchObject({ reason: 'ssh-closed' });
    expect(backend.voices).toHaveLength(0);
  });

  test('[MEDIUM 13] worker が列へ戻した件は withdraw で外せ、見失ったとみなさない', async () => {
    const own = await session();
    await client.set(WORKER_LOCK_KEY, 'w1', { PX: 60_000 });
    own.input.write(encodeControl({ type: 'open', id: 'rq' }));
    await waitFor(() => own.statusesOf('rq').includes('queued') ? true : undefined);
    // worker w1 が取り出し、hold で列へ戻した
    const raw = (await client.rPop(NORMAL_QUEUE_KEY))!;
    await client.rPush(statusKey('rq'), JSON.stringify({ s: 'dequeued', t: Date.now(), w: 'w1' }));
    await own.ingest.pollStatuses();
    await client.rPush(NORMAL_QUEUE_KEY, raw);
    await client.rPush(statusKey('rq'), JSON.stringify({ s: 'requeued', t: Date.now(), w: 'w1' }));
    await own.ingest.pollStatuses();
    const now = Date.now();
    await own.ingest.checkWorker(now);
    await own.ingest.checkWorker(now + 60_000);
    expect(own.messages.some(message => message.id === 'rq' && message.status === 'failed')).toBe(false);
    own.input.write(encodeControl({ type: 'withdraw', id: 'rq' }));
    await waitFor(() => own.messages.find(message => message.type === 'withdrawn'));
    expect(own.messages.find(message => message.type === 'withdrawn')).toMatchObject({ id: 'rq', removed: true });
    expect(await client.lLen(NORMAL_QUEUE_KEY)).toBe(0);
  });

  test('[MEDIUM 13] 取り出した worker から lock が移り、その worker が鳴らしていなければ見失ったとみなす', async () => {
    const own = await session();
    await client.set(WORKER_LOCK_KEY, 'w2', { PX: 60_000 });
    for (const id of ['moved', 'still']) {
      own.input.write(encodeControl({ type: 'open', id }));
      await waitFor(() => own.statusesOf(id).includes('queued') ? true : undefined);
      await client.rPop(NORMAL_QUEUE_KEY);
      await client.rPush(statusKey(id), JSON.stringify({ s: 'dequeued', t: Date.now(), w: 'w1' }));
    }
    await own.ingest.pollStatuses();
    // w1 はまだ鳴らしている（再生 lock を持つ）
    await client.set(PLAY_LOCK_KEY, 'w1', { PX: 60_000 });
    const now = Date.now();
    await own.ingest.checkWorker(now);
    await own.ingest.checkWorker(now + 40_000);
    expect(own.messages.some(message => message.status === 'failed')).toBe(false);
    // w1 が鳴らすのをやめた（落ちた）まま 30 秒
    await client.del(PLAY_LOCK_KEY);
    await own.ingest.checkWorker(now + 50_000);
    await own.ingest.checkWorker(now + 81_000);
    expect(own.messages.filter(message => message.status === 'failed').map(message => [message.id, message.reason])).toEqual([['moved', 'lost'], ['still', 'lost']]);
    expect(await client.lLen(HIGH_QUEUE_KEY)).toBe(0);
  });

  test('[再レビュー MEDIUM 3] 積めたか分からない件の終わりは、列から外せたときだけ withdrawn を付ける', async () => {
    const proxy = await proxied();
    let clock = Date.now();
    const own = await session({ url: proxy.url, opTimeoutMs: 300, now: () => clock });
    const open = (id: string) => own.input.write(encodeControl({ type: 'open', id, kind: 'sound', prelude: { path: path.join(tempDir, 'chime.wav'), volume: 1 } }));
    proxy.holdResponses();
    open('u1');
    await waitFor(() => own.statusesOf('u1').includes('accepted') ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 800));
    // 確かめられないまま追跡の上限を越える。列から外せない（Redis が答えない）ので withdrawn は付けない
    clock += 16 * 60_000;
    await own.ingest.pollStatuses();
    const unknownEnd = await waitFor(() => own.messages.find(message => message.id === 'u1' && message.status === 'failed'), 5000);
    expect(unknownEnd).toMatchObject({ reason: 'untracked' });
    expect(unknownEnd.withdrawn).toBeUndefined();
    proxy.release();
    await new Promise(resolve => setTimeout(resolve, 300));
    // 同じ状況でも、列から外せたら withdrawn を付ける
    proxy.holdResponses();
    open('u2');
    await waitFor(() => own.statusesOf('u2').includes('accepted') ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 800));
    // 同じ tick で時計を進めてから返事を流す（確かめ直しより先に上限の判定が走る）
    clock += 16 * 60_000;
    proxy.release();
    await own.ingest.pollStatuses();
    const removedEnd = await waitFor(() => own.messages.find(message => message.id === 'u2' && message.status === 'failed'), 5000);
    expect(removedEnd).toMatchObject({ reason: 'untracked', withdrawn: true });
  });

  test('[追加 1] withdraw は「外せた」「積まれていない」「取り出し済み」を分ける', async () => {
    const own = await session();
    own.input.write(encodeControl({ type: 'open', id: 'in-queue' }));
    own.input.write(encodeControl({ type: 'open', id: 'taken' }));
    await waitFor(() => ['in-queue', 'taken'].every(id => own.statusesOf(id).includes('queued')) ? true : undefined);
    // taken は worker が取り出した
    const raw = (await client.lRange(NORMAL_QUEUE_KEY, 0, -1)).find(item => JSON.parse(item).id === 'taken')!;
    await client.lRem(NORMAL_QUEUE_KEY, 1, raw);
    await client.rPush(statusKey('taken'), JSON.stringify({ s: 'dequeued', t: Date.now(), w: 'w1' }));
    // never は前の子が Stream だけ作り、積む要求が届かなかった
    await client.xAdd(audioStreamKey('never'), '*', { o: '1' });
    for (const id of ['in-queue', 'taken', 'never']) {
      own.input.write(encodeControl({ type: 'withdraw', id }));
    }
    await waitFor(() => own.messages.filter(message => message.type === 'withdrawn').length === 3 ? true : undefined);
    expect(own.messages.filter(message => message.type === 'withdrawn').map(({ at: _at, ...rest }) => rest)).toEqual([
      { type: 'withdrawn', id: 'in-queue', removed: true },
      { type: 'withdrawn', id: 'taken', removed: false, taken: true },
      { type: 'withdrawn', id: 'never', removed: false, notQueued: true },
    ]);
    expect(await client.exists(audioStreamKey('never'))).toBe(0);
    expect(await client.exists(statusKey('taken'))).toBe(1);
  });

  test('[追加 2] adopt で前の --ingest が積んだ件を引き継ぎ、期限の延長と知らせの中継を行う', async () => {
    const previous = await session();
    previous.input.write(encodeControl({ type: 'open', id: 'orphan' }));
    previous.input.write(encodeAudio('orphan', mp3Frames(20)));
    previous.input.write(encodeControl({ type: 'end', id: 'orphan' }));
    await waitFor(() => previous.statusesOf('orphan').includes('queued') ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 300));
    // 前の子が落ちた（入力を止める。追跡はもう行われない）
    previous.input.pause();
    const next = await session();
    next.input.write(encodeControl({ type: 'adopt', id: 'orphan' }));
    next.input.write(encodeControl({ type: 'adopt', id: 'nobody' }));
    await waitFor(() => next.messages.filter(message => message.type === 'adopted').length === 2 ? true : undefined);
    expect(next.messages.filter(message => message.type === 'adopted').map(({ at: _at, ...rest }) => rest)).toEqual([
      { type: 'adopted', id: 'orphan', adopted: true },
      { type: 'adopted', id: 'nobody', adopted: false },
    ]);
    // 期限の延長を引き継ぐ（延長の間隔を待たずに、内部の延長を直接呼ぶ）
    await client.expire(audioStreamKey('orphan'), 5);
    await client.expire(statusKey('orphan'), 5);
    await (next.ingest as unknown as { touch(): Promise<void> }).touch();
    expect(await client.ttl(audioStreamKey('orphan'))).toBeGreaterThan(100);
    expect(await client.ttl(statusKey('orphan'))).toBeGreaterThan(100);
    // worker が鳴らすと、新しい子が playing と done を返す
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(() => next.statusesOf('orphan').includes('done') ? true : undefined);
    expect(next.statusesOf('orphan')).toEqual(['adopted', 'playing', 'done']);
    expect(backend.voices[0].bytes.length).toBe(417 * 20);
    previous.input.resume();
  });

  test('[最終レビュー LOW] 引き継いだ件の abort は、列にあれば外して Stream も消し、取り出した後でも鳴り始める前なら止める', async () => {
    const previous = await session();
    for (const id of ['in-queue', 'taken']) {
      previous.input.write(encodeControl({ type: 'open', id }));
      previous.input.write(encodeAudio(id, mp3Frames(20)));
      previous.input.write(encodeControl({ type: 'end', id }));
      await waitFor(() => previous.statusesOf(id).includes('queued') ? true : undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    previous.input.pause();
    const next = await session();
    for (const id of ['in-queue', 'taken']) {
      next.input.write(encodeControl({ type: 'adopt', id }));
    }
    await waitFor(() => next.messages.filter(message => message.type === 'adopted').length === 2 ? true : undefined);
    // まだ列にある件: 列から外し、Stream も消す
    next.input.write(encodeControl({ type: 'abort', id: 'in-queue' }));
    await waitFor(() => next.statusesOf('in-queue').includes('skipped') ? true : undefined);
    expect(await client.exists(audioStreamKey('in-queue'))).toBe(0);
    // 取り出した後・鳴り始める前の件: 再生 lock をほかが持つ間に worker が取り出す
    await client.set(PLAY_LOCK_KEY, 'someone-else', { PX: 60_000 });
    const backend = new FakeBackend();
    startWorker(backend);
    await waitFor(async () => (await client.lRange(statusKey('taken'), 0, -1)).some(raw => JSON.parse(raw).s === 'dequeued') ? true : undefined);
    next.input.write(encodeControl({ type: 'abort', id: 'taken' }));
    await waitFor(async () => (await client.xRange(audioStreamKey('taken'), '-', '+')).some(entry => 'c' in entry.message) ? true : undefined);
    await client.del(PLAY_LOCK_KEY);
    await waitFor(() => next.statusesOf('taken').includes('skipped') ? true : undefined, 15_000);
    // worker は再生 lock を取った時点で playing を知らせるが、Stream の c を見て鳴らさずに捨てる
    expect([next.statusesOf('taken'), backend.voices.length]).toEqual([['adopted', 'playing', 'skipped'], 0]);
    previous.input.resume();
  });
});

import type { RedisClientType } from 'redis';
import { enqueueJob, restoreLegacyQueue, withdrawJobById, withdrawJobByIdDetailed } from '../../src/queue/enqueue.js';
import { audioStreamKey, LEGACY_QUEUE_KEY, MIGRATED_LEGACY_QUEUE_KEY, NORMAL_QUEUE_KEY, statusKey, takenKey } from '../../src/queue/keys.js';
import { pushStatus } from '../../src/queue/status.js';
import { connect, describeWithRedis, startTestRedis, type TestRedis } from '../helpers/redis.js';

describeWithRedis('列の操作（別ポートの redis-server）', () => {
  let redis: TestRedis;
  let client: RedisClientType;

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
  });

  test('[再レビュー LOW] withdraw は大きな要素や ID を含むだけの要素を巻き込まず、その件のキーだけを消す', async () => {
    // 2.4 の形の大きな音声。中に同じ ID の文字列を含むが、2.5 のジョブではない
    const big = JSON.stringify({ _audioBase64: 'A'.repeat(1_500_000), note: '"id":"x1"' });
    await client.lPush(NORMAL_QUEUE_KEY, big);
    await enqueueJob(client, { v: 2, type: 'stream', id: 'x1', priority: 'normal', source: 'ingest', enqueuedAt: Date.now() });
    await client.xAdd(audioStreamKey('x1'), '*', { o: '1' });
    await client.set(statusKey('other'), 'keep');
    const started = Date.now();
    expect(await withdrawJobById(client, 'x1')).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await client.lRange(NORMAL_QUEUE_KEY, 0, -1)).toEqual([big]);
    expect(await client.exists([audioStreamKey('x1'), statusKey('x1')])).toBe(0);
    expect(await client.get(statusKey('other'))).toBe('keep');
    expect(await withdrawJobById(client, 'x1')).toBe(false);
  });

  test('[最終レビュー LOW] 知らせの期限が切れた後の withdraw も、取り出した印があれば taken と答える', async () => {
    await enqueueJob(client, { v: 2, type: 'stream', id: 'gone', priority: 'normal', source: 'ingest', enqueuedAt: Date.now() });
    // worker が取り出した（BRPOP と dequeued）
    await client.rPop(NORMAL_QUEUE_KEY);
    await pushStatus(client, 'gone', 'dequeued', undefined, 'w1');
    expect(await client.ttl(takenKey('gone'))).toBeGreaterThan(29 * 60);
    // 知らせ（5 分）が期限切れになった
    await client.del(statusKey('gone'));
    expect([await withdrawJobByIdDetailed(client, 'gone'), await withdrawJobByIdDetailed(client, 'never')]).toEqual(['taken', 'not-queued']);
  });

  test('[再レビュー LOW] --restore-legacy-queue は移した古い列を順を保って戻す', async () => {
    for (const item of ['a', 'b', 'c']) {
      await client.lPush(MIGRATED_LEGACY_QUEUE_KEY, item);
    }
    expect(await restoreLegacyQueue(client)).toBe(3);
    expect(await client.lLen(MIGRATED_LEGACY_QUEUE_KEY)).toBe(0);
    // 古い worker は右から取り出す: 積んだ順（a → b → c）に出る
    expect([await client.rPop(LEGACY_QUEUE_KEY), await client.rPop(LEGACY_QUEUE_KEY), await client.rPop(LEGACY_QUEUE_KEY)]).toEqual(['a', 'b', 'c']);
  });
});

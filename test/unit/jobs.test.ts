import {
  effectiveWaitMs, gainKeyFor, hasEmotionTags, heldOverlapMs, isJobExpired, isValidStreamId, parseJob, shouldPlayPrelude,
} from '../../src/queue/jobs.js';

describe('jobs', () => {
  test('期限は normal 120 秒・high 600 秒', () => {
    expect(isJobExpired({ enqueuedAt: 0, priority: 'normal' }, 120_000, 0)).toBe(false);
    expect(isJobExpired({ enqueuedAt: 0, priority: 'normal' }, 120_001, 0)).toBe(true);
    expect(isJobExpired({ enqueuedAt: 0, priority: 'high' }, 600_000, 0)).toBe(false);
    expect(isJobExpired({ enqueuedAt: 0, priority: 'high' }, 600_001, 0)).toBe(true);
  });

  test('hold の間は期限に数えない', () => {
    expect(isJobExpired({ enqueuedAt: 0, priority: 'normal' }, 170_000, 60_000)).toBe(false);
    expect(effectiveWaitMs({ enqueuedAt: 0 }, 170_000, 60_000)).toBe(110_000);
  });

  test('hold の区間の重なりを二重に数えない', () => {
    expect(heldOverlapMs([[10, 20], [15, 30], [50, 60]], 0, 100)).toBe(30);
    expect(heldOverlapMs([[10, 20]], 15, 100)).toBe(5);
    expect(heldOverlapMs([[10, 20]], 30, 100)).toBe(0);
    expect(heldOverlapMs([], 0, 100)).toBe(0);
    expect(heldOverlapMs([[0, 10]], 10, 5)).toBe(0);
  });

  test('5 秒以上待った着信音は飛ばす', () => {
    expect(shouldPlayPrelude({ enqueuedAt: 0 }, 5000, 0)).toBe(true);
    expect(shouldPlayPrelude({ enqueuedAt: 0 }, 5001, 0)).toBe(false);
    expect(shouldPlayPrelude({ enqueuedAt: 0 }, 9000, 4500)).toBe(true);
  });

  test('ジョブを読む', () => {
    const stream = { v: 2, type: 'stream', id: 'abc-1', priority: 'high', source: 'ingest', enqueuedAt: 1, gainKey: 'aivis:x:default', volumeDb: -3 };
    expect(parseJob(JSON.stringify(stream))).toEqual({ kind: 'v2', job: stream });
    const sound = { v: 2, type: 'sound', id: 's', priority: 'normal', source: 'ingest', enqueuedAt: 1, prelude: { path: '/a.wav', volume: 0.5 } };
    expect(parseJob(JSON.stringify(sound)).kind).toBe('v2');
    expect(parseJob(JSON.stringify({ text: 'こんにちは' }))).toEqual({ kind: 'legacy', payload: { text: 'こんにちは' } });
    expect(parseJob('nope').kind).toBe('invalid');
    expect(parseJob(JSON.stringify({ ...stream, id: '../x' })).kind).toBe('invalid');
    expect(parseJob(JSON.stringify({ ...stream, priority: 'urgent' })).kind).toBe('invalid');
    expect(parseJob(JSON.stringify({ ...sound, prelude: undefined })).kind).toBe('invalid');
    expect(parseJob(JSON.stringify({ ...sound, prelude: { path: '/a.wav', volume: 2 } })).kind).toBe('invalid');
    expect(parseJob(JSON.stringify({ ...stream, type: 'video' })).kind).toBe('invalid');
  });

  test('流れ ID は英数字・-・_ の 64 文字まで', () => {
    expect(isValidStreamId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isValidStreamId('a'.repeat(65))).toBe(false);
    expect(isValidStreamId('a:b')).toBe(false);
  });

  test('音量の表の鍵', () => {
    expect(gainKeyFor('elevenlabs', 'voice', 'eleven_v3')).toBe('elevenlabs:voice:eleven_v3');
    expect(gainKeyFor('elevenlabs', undefined, 'eleven_v3')).toBeUndefined();
    expect(gainKeyFor('aivis', 'uuid', undefined)).toBe('aivis:uuid:default');
    expect(gainKeyFor('other', 'v', 'm')).toBeUndefined();
  });

  test('感情タグ', () => {
    expect(hasEmotionTags('[whispers] こんにちは')).toBe(true);
    expect(hasEmotionTags('こんにちは')).toBe(false);
    expect(hasEmotionTags(undefined)).toBe(false);
  });
});

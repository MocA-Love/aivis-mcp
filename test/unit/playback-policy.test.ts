import { PlaybackMonitor, PREROLL_FALLBACK_BYTES, shouldStartPlayback } from '../../src/streaming/playback-policy.js';

describe('shouldStartPlayback', () => {
  test('250ms ぶん溜まったら鳴らす', () => {
    expect(shouldStartPlayback({ bufferedBytes: 3999, bitrateKbps: 128, ended: false })).toBe(false);
    expect(shouldStartPlayback({ bufferedBytes: 4000, bitrateKbps: 128, ended: false })).toBe(true);
  });

  test('流れが終わっていれば閾値に届かなくても鳴らす。空なら鳴らさない', () => {
    expect(shouldStartPlayback({ bufferedBytes: 10, bitrateKbps: 128, ended: true })).toBe(true);
    expect(shouldStartPlayback({ bufferedBytes: 0, bitrateKbps: 128, ended: true })).toBe(false);
  });

  test('ビットレートが読めないときは多めに溜めてから鳴らす', () => {
    expect(shouldStartPlayback({ bufferedBytes: PREROLL_FALLBACK_BYTES - 1, bitrateKbps: undefined, ended: false })).toBe(false);
    expect(shouldStartPlayback({ bufferedBytes: PREROLL_FALLBACK_BYTES, bitrateKbps: undefined, ended: false })).toBe(true);
  });
});

describe('PlaybackMonitor', () => {
  test('最初の音が 10 秒来なければ打ち切る', () => {
    const monitor = new PlaybackMonitor(1000);
    expect(monitor.check(10_999)).toBeUndefined();
    expect(monitor.check(11_000)).toBe('first-audio-timeout');
  });

  test('1 発話は 120 秒まで', () => {
    const monitor = new PlaybackMonitor(0);
    monitor.setBitrate(128);
    monitor.onAudio(100, 16000 * 200);
    expect(monitor.check(119_999)).toBeUndefined();
    expect(monitor.check(120_000)).toBe('max-duration');
  });

  test('届く速さが実時間の半分を 3 秒下回ったら打ち切る', () => {
    const monitor = new PlaybackMonitor(0);
    monitor.setBitrate(128);
    // 1 秒ぶんが届いた後、少しずつしか来ない
    monitor.onAudio(0, 16000);
    expect(monitor.check(1000)).toBeUndefined();
    expect(monitor.check(2000)).toBeUndefined(); // 比 0.5
    expect(monitor.check(2100)).toBeUndefined(); // 下回り始め
    expect(monitor.check(5000)).toBeUndefined();
    expect(monitor.check(5100)).toBe('slow-arrival');
  });

  test('速く届いた後に止まっただけなら打ち切らない。追いつけば数え直す', () => {
    const monitor = new PlaybackMonitor(0);
    monitor.setBitrate(128);
    monitor.onAudio(0, 16000 * 6);
    expect(monitor.check(10_000)).toBeUndefined();
    expect(monitor.check(12_500)).toBeUndefined(); // 比 0.48、ここから数える
    monitor.onAudio(13_000, 16000 * 2);
    expect(monitor.check(16_000)).toBeUndefined();
  });

  test('流れが終わった後は遅さで打ち切らない', () => {
    const monitor = new PlaybackMonitor(0);
    monitor.setBitrate(128);
    monitor.onAudio(0, 1600);
    monitor.onEnded();
    expect(monitor.check(9000)).toBeUndefined();
  });
});

import { parseEbur128Output } from '../../src/audio/loudness.js';
import { compareVersions, shouldSpawnWorker } from '../../src/queue/worker-lock.js';
import { decodeStatus, encodeStatus } from '../../src/queue/status.js';
import { decodeStreamEntry } from '../../src/queue/audio-stream.js';
import { isParaCodeVoiceTarget } from '../../src/services/para-code-voice.js';

describe('ebur128 の出力', () => {
  test('まとめの I と最後の t を読む', () => {
    const output = [
      '[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS    M:-30.1 S:-120.7     I: -30.1 LUFS       LRA:   0.0 LU',
      '[Parsed_ebur128_0 @ 0x1] t: 1.999977   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU',
      '[Parsed_ebur128_0 @ 0x1] Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -22.4 LUFS',
      '    Threshold: -32.2 LUFS',
    ].join('\n');
    expect(parseEbur128Output(output)).toEqual({ integratedLufs: -22.4, durationSeconds: 1.999977 });
    expect(parseEbur128Output('no summary')).toBeUndefined();
  });
});

describe('worker の版', () => {
  test('版を比べる', () => {
    expect(compareVersions('2.4.0', '2.5.0')).toBe(-1);
    expect(compareVersions('2.5.0', '2.5.0')).toBe(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.5.0-beta.1', '2.5.0')).toBe(0);
  });

  test('lock が無い・古い版・版が分からないときに新しい worker を起こす', () => {
    expect(shouldSpawnWorker(null, null, '2.5.0')).toBe(true);
    expect(shouldSpawnWorker('id', '2.4.0', '2.5.0')).toBe(true);
    expect(shouldSpawnWorker('id', null, '2.5.0')).toBe(true);
    expect(shouldSpawnWorker('id', '2.5.0', '2.5.0')).toBe(false);
    expect(shouldSpawnWorker('id', '2.6.0', '2.5.0')).toBe(false);
  });
});

describe('知らせと Stream の項目', () => {
  test('知らせの往復', () => {
    expect(decodeStatus(encodeStatus({ status: 'done', at: 5 }))).toEqual({ status: 'done', reason: undefined, at: 5 });
    expect(decodeStatus(encodeStatus({ status: 'skipped', reason: 'expired', at: 5 }))).toEqual({ status: 'skipped', reason: 'expired', at: 5 });
    expect(decodeStatus('{"s":"weird"}')).toBeUndefined();
    expect(decodeStatus('x')).toBeUndefined();
  });

  test('Stream の項目', () => {
    expect(decodeStreamEntry({ d: Buffer.from([1]) })).toEqual({ kind: 'data', data: Buffer.from([1]) });
    expect(decodeStreamEntry({ e: '1' })).toEqual({ kind: 'end' });
    expect(decodeStreamEntry({ a: 'too-large' })).toEqual({ kind: 'abort', reason: 'too-large' });
    expect(decodeStreamEntry({ o: '1' })).toBeUndefined();
  });
});

describe('Para Code の送り先', () => {
  const base = { ticket: 't', port: 1234, instanceId: 'i', expiresAt: Date.now() + 60_000 };
  test('ingress は 32 文字までの文字列なら受け取る', () => {
    expect(isParaCodeVoiceTarget({ ...base, ingress: 'stream-v1' })).toBe(true);
    expect(isParaCodeVoiceTarget({ ...base, ingress: 5 })).toBe(false);
    expect(isParaCodeVoiceTarget({ ...base, ingress: 'x'.repeat(33) })).toBe(false);
    expect(isParaCodeVoiceTarget(base)).toBe(true);
  });
});

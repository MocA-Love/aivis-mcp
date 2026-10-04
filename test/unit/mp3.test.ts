import { bytesForDuration, durationForBytes, findFirstFrame, id3v2Length, parseFrameHeader } from '../../src/streaming/mp3.js';

/** MPEG-1 Layer III 128kbps 44.1kHz（パディング無し）のフレームを n 個並べる。 */
function mpeg1Frames(count: number): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  return Buffer.concat(Array.from({ length: count }, () => frame));
}

describe('mp3', () => {
  test('MPEG-1 Layer III のヘッダーからビットレートとフレーム長を読む', () => {
    const header = parseFrameHeader(mpeg1Frames(1), 0);
    expect(header).toEqual({ offset: 0, bitrateKbps: 128, sampleRate: 44100, version: 1, layer: 3, frameLength: 417 });
  });

  test('MPEG-2 Layer III（24kHz 32kbps）も読む', () => {
    const bytes = Buffer.from([0xff, 0xf3, 0x44, 0xc4]);
    const header = parseFrameHeader(bytes, 0);
    expect(header?.version).toBe(2);
    expect(header?.bitrateKbps).toBe(32);
    expect(header?.sampleRate).toBe(24000);
    expect(header?.frameLength).toBe(96);
  });

  test('成り立たないヘッダーは読まない', () => {
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x00]), 0)).toBeUndefined(); // bitrate 15
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0x9c, 0x00]), 0)).toBeUndefined(); // sample rate 3
    expect(parseFrameHeader(Buffer.from([0x00, 0xfb, 0x90, 0x00]), 0)).toBeUndefined();
  });

  test('ID3v2 タグと先頭のごみを飛ばして最初のフレームを見つける', () => {
    const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const bytes = Buffer.concat([tag, Buffer.from([0x00, 0xff, 0xe0]), mpeg1Frames(2)]);
    expect(id3v2Length(bytes)).toBe(15);
    expect(findFirstFrame(bytes)?.offset).toBe(18);
  });

  test('ID3 の途中までしか届いていなければ、まだ分からない', () => {
    expect(id3v2Length(Buffer.from([0x49, 0x44]))).toBeUndefined();
    expect(findFirstFrame(Buffer.from([0x49, 0x44, 0x33, 4, 0]))).toBeUndefined();
    expect(id3v2Length(Buffer.from([0xff]))).toBe(0);
  });

  test('続くフレームが成り立たない偶然の同期ビットは飛ばす', () => {
    const fake = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Buffer.alloc(413), 0x12, 0x34, 0x56, 0x78]);
    expect(findFirstFrame(Buffer.concat([fake, mpeg1Frames(2)]))?.offset).toBe(fake.length);
  });

  test('時間とバイトの換算', () => {
    expect(bytesForDuration(128, 250)).toBe(4000);
    expect(bytesForDuration(32, 250)).toBe(1000);
    expect(durationForBytes(128, 16000)).toBe(1);
    expect(durationForBytes(0, 100)).toBe(0);
  });
});

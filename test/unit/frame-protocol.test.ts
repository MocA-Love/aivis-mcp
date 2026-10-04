import {
  decodePayload, encodeAudio, encodeControl, encodeFrame, FrameDecoder, FrameProtocolError, FrameType, MAX_FRAME_PAYLOAD,
} from '../../src/streaming/frame-protocol.js';

describe('frame protocol', () => {
  test('枠は 型 1 バイト ＋ 長さ 4 バイト（ビッグエンディアン）＋ 中身', () => {
    const frame = encodeControl({ type: 'ping' });
    expect(frame[0]).toBe(0x01);
    expect(frame.readUInt32BE(1)).toBe(frame.length - 5);
    expect(frame.subarray(5).toString('utf8')).toBe('{"type":"ping"}');
  });

  test('音声の枠は 流れ ID の長さ 1 バイト ＋ 流れ ID ＋ MP3', () => {
    const frame = encodeAudio('abc', Buffer.from([1, 2, 3]));
    expect([...frame]).toEqual([0x02, 0, 0, 0, 7, 3, 0x61, 0x62, 0x63, 1, 2, 3]);
  });

  test('どこで区切られて届いても同じ枠に戻る', () => {
    const stream = Buffer.concat([
      encodeControl({ type: 'open', id: 's1' }),
      encodeAudio('s1', Buffer.from([0xff, 0xfb, 0x90, 0x64])),
      encodeControl({ type: 'end', id: 's1' }),
    ]);
    for (let split = 1; split < stream.length; split++) {
      const decoder = new FrameDecoder();
      const frames = [...decoder.push(stream.subarray(0, split)), ...decoder.push(stream.subarray(split))];
      expect(frames).toEqual([
        { kind: 'control', message: { type: 'open', id: 's1' } },
        { kind: 'audio', id: 's1', data: Buffer.from([0xff, 0xfb, 0x90, 0x64]) },
        { kind: 'control', message: { type: 'end', id: 's1' } },
      ]);
      expect(decoder.hasPartialFrame).toBe(false);
    }
  });

  test('1 バイトずつ届いても読める', () => {
    const stream = Buffer.concat([encodeControl({ type: 'hold', owner: 'a', active: true }), encodeAudio('x', Buffer.alloc(10, 7))]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (const byte of stream) {
      frames.push(...decoder.push(Buffer.from([byte])));
    }
    expect(frames).toHaveLength(2);
  });

  test('壊れた枠は拒む', () => {
    const oversized = Buffer.alloc(5);
    oversized.writeUInt8(1, 0);
    oversized.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 1);
    expect(() => new FrameDecoder().push(oversized)).toThrow(FrameProtocolError);
    expect(() => decodePayload(9, Buffer.from('{}'))).toThrow(FrameProtocolError);
    expect(() => decodePayload(FrameType.Control, Buffer.from('[]'))).toThrow(FrameProtocolError);
    expect(() => decodePayload(FrameType.Control, Buffer.from('{"id":1}'))).toThrow(FrameProtocolError);
    expect(() => decodePayload(FrameType.Control, Buffer.from('nope'))).toThrow(FrameProtocolError);
    expect(() => decodePayload(FrameType.Audio, Buffer.from([5, 1]))).toThrow(FrameProtocolError);
    expect(() => encodeFrame(FrameType.Audio, Buffer.alloc(MAX_FRAME_PAYLOAD + 1))).toThrow(FrameProtocolError);
    expect(() => encodeAudio('', Buffer.alloc(1))).toThrow(FrameProtocolError);
  });
});

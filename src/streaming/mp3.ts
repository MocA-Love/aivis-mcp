/**
 * MP3 のフレームヘッダーを読む純関数。
 *
 * 鳴らし始める前に溜める量はバイトで持つ。最初のフレームのヘッダーからビットレートを読み、
 * 「何 ms ぶん」を「何バイト」に直すために使う（設計 2 章）。
 */

export interface Mp3FrameInfo {
  /** フレームヘッダーが始まる位置（ID3v2 タグを飛ばした後） */
  readonly offset: number;
  readonly bitrateKbps: number;
  readonly sampleRate: number;
  /** 1 = MPEG-1, 2 = MPEG-2, 2.5 = MPEG-2.5 */
  readonly version: 1 | 2 | 2.5;
  /** 1〜3 */
  readonly layer: 1 | 2 | 3;
  /** ヘッダーを含むフレームのバイト数 */
  readonly frameLength: number;
}

const BITRATES_V1: Record<number, readonly number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};

const BITRATES_V2: Record<number, readonly number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<string, readonly number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

/**
 * `offset` の位置の 4 バイトを MPEG オーディオのフレームヘッダーとして読む。
 * ヘッダーとして成り立たなければ undefined。
 */
export function parseFrameHeader(bytes: Uint8Array, offset: number): Mp3FrameInfo | undefined {
  if (offset < 0 || offset + 4 > bytes.length) {
    return undefined;
  }
  const b1 = bytes[offset];
  const b2 = bytes[offset + 1];
  const b3 = bytes[offset + 2];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) {
    return undefined;
  }
  const versionBits = (b2 >> 3) & 0x03;
  const layerBits = (b2 >> 1) & 0x03;
  const bitrateIndex = (b3 >> 4) & 0x0f;
  const sampleRateIndex = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return undefined;
  }
  const version: 1 | 2 | 2.5 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const table = version === 1 ? BITRATES_V1 : BITRATES_V2;
  const bitrateKbps = table[layer][bitrateIndex];
  const sampleRate = SAMPLE_RATES[String(version)][sampleRateIndex];
  let frameLength: number;
  if (layer === 1) {
    frameLength = (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4;
  } else if (layer === 3 && version !== 1) {
    frameLength = Math.floor((72 * bitrateKbps * 1000) / sampleRate) + padding;
  } else {
    frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding;
  }
  if (frameLength < 4) {
    return undefined;
  }
  return { offset, bitrateKbps, sampleRate, version, layer, frameLength };
}

/** 先頭の ID3v2 タグの長さ（無ければ 0、まだ読み切れていなければ undefined）。 */
export function id3v2Length(bytes: Uint8Array): number | undefined {
  const tag = [0x49, 0x44, 0x33];
  for (let i = 0; i < Math.min(3, bytes.length); i++) {
    if (bytes[i] !== tag[i]) {
      return 0;
    }
  }
  if (bytes.length < 3) {
    return undefined;
  }
  if (bytes.length < 10) {
    return undefined;
  }
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * 最初のフレームを探す。続くフレームのヘッダーまで読めるときは、それも成り立つかで
 * 偶然の同期ビットを除く。見つからなければ undefined（もっと溜めてから呼び直す）。
 */
export function findFirstFrame(bytes: Uint8Array, maxScan = 64 * 1024): Mp3FrameInfo | undefined {
  const start = id3v2Length(bytes);
  if (start === undefined) {
    return undefined;
  }
  const limit = Math.min(bytes.length - 4, start + maxScan);
  for (let offset = start; offset <= limit; offset++) {
    const header = parseFrameHeader(bytes, offset);
    if (header === undefined) {
      continue;
    }
    const next = offset + header.frameLength;
    if (next + 4 <= bytes.length) {
      const following = parseFrameHeader(bytes, next);
      if (following === undefined || following.version !== header.version || following.layer !== header.layer) {
        continue;
      }
    }
    return header;
  }
  return undefined;
}

/** `ms` ミリ秒ぶんの音声が何バイトか（切り上げ）。 */
export function bytesForDuration(bitrateKbps: number, ms: number): number {
  return Math.ceil((bitrateKbps * 1000 / 8) * (ms / 1000));
}

/** `bytes` バイトが何秒ぶんか。 */
export function durationForBytes(bitrateKbps: number, bytes: number): number {
  if (bitrateKbps <= 0) {
    return 0;
  }
  return (bytes * 8) / (bitrateKbps * 1000);
}

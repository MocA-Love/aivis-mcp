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
  /** 1 フレームのサンプル数 */
  readonly samplesPerFrame: number;
  /** 単声（チャンネルモード 3）か */
  readonly mono: boolean;
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
  const b4 = bytes[offset + 3];
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
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
  return { offset, bitrateKbps, sampleRate, version, layer, frameLength, samplesPerFrame, mono: ((b4 >> 6) & 0x03) === 3 };
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

function readUInt32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.length) {
    return undefined;
  }
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/** 最初のフレームの Xing / Info / VBRI ヘッダーにあるフレーム数（無ければ undefined）。 */
export function vbrFrameCount(bytes: Uint8Array, first: Mp3FrameInfo): number | undefined {
  const sideInfo = first.version === 1 ? (first.mono ? 17 : 32) : (first.mono ? 9 : 17);
  const xing = first.offset + 4 + sideInfo;
  if (asciiAt(bytes, xing, 'Xing') || asciiAt(bytes, xing, 'Info')) {
    const flags = readUInt32BE(bytes, xing + 4);
    if (flags !== undefined && (flags & 0x01) !== 0) {
      return readUInt32BE(bytes, xing + 8);
    }
    return undefined;
  }
  const vbri = first.offset + 4 + 32;
  if (asciiAt(bytes, vbri, 'VBRI')) {
    return readUInt32BE(bytes, vbri + 14);
  }
  return undefined;
}

/**
 * MP3 全体の長さ（秒）。Xing / VBRI ヘッダーがあればそのフレーム数から、無ければ届いた全フレームを
 * たどって合計する（可変ビットレートでも最初のフレームのビットレートで見積もらない）。
 */
export function estimateMp3Duration(bytes: Uint8Array): number | undefined {
  const first = findFirstFrame(bytes);
  if (first === undefined) {
    return undefined;
  }
  const frames = vbrFrameCount(bytes, first);
  if (frames !== undefined && frames > 0) {
    return (frames * first.samplesPerFrame) / first.sampleRate;
  }
  let seconds = 0;
  let offset = first.offset;
  let skipped = 0;
  while (offset + 4 <= bytes.length) {
    const header = parseFrameHeader(bytes, offset);
    if (header === undefined || offset + header.frameLength > bytes.length) {
      if (header !== undefined) {
        break; // 最後の途中までのフレーム
      }
      // 同期が外れたら 1 バイトずつ探し直す（壊れた入力で回り続けないよう上限を置く）
      offset++;
      if (++skipped > 64 * 1024) {
        break;
      }
      continue;
    }
    seconds += header.samplesPerFrame / header.sampleRate;
    offset += header.frameLength;
  }
  return seconds;
}

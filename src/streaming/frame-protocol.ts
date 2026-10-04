/**
 * `aivis-mcp --ingest` の標準入出力の枠（設計 3.6 N1）。
 *
 * 1 枠 = 型 1 バイト ＋ 長さ 4 バイト（符号なし・ビッグエンディアン）＋ 中身。
 * 制御は JSON、音声は 2 進の枠で運び、JSON の行と 2 進を混ぜない。
 * 形式の正は docs/ingest-protocol.md。
 */

/** 取り決めの版。互換を壊す変更をしたら上げる。 */
export const INGEST_PROTOCOL_VERSION = 1;

export const FRAME_HEADER_BYTES = 5;
/** 1 枠の中身の上限。これを超える長さを名乗る枠は壊れているとみなす。 */
export const MAX_FRAME_PAYLOAD = 1024 * 1024;

export const FrameType = {
  /** UTF-8 の JSON オブジェクト。必ず `type` を持つ。 */
  Control: 0x01,
  /** 音声の断片。中身 = 流れ ID の長さ 1 バイト ＋ 流れ ID（UTF-8）＋ MP3 のバイト列。 */
  Audio: 0x02,
} as const;

export type FrameType = typeof FrameType[keyof typeof FrameType];

export interface ControlFrame {
  readonly kind: 'control';
  readonly message: Record<string, unknown>;
}

export interface AudioFrame {
  readonly kind: 'audio';
  readonly id: string;
  readonly data: Buffer;
}

export type Frame = ControlFrame | AudioFrame;

export class FrameProtocolError extends Error { }

export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD) {
    throw new FrameProtocolError(`frame payload too large: ${payload.length}`);
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeControl(message: Record<string, unknown>): Buffer {
  return encodeFrame(FrameType.Control, Buffer.from(JSON.stringify(message), 'utf8'));
}

export function encodeAudio(id: string, data: Buffer): Buffer {
  const idBytes = Buffer.from(id, 'utf8');
  if (idBytes.length === 0 || idBytes.length > 255) {
    throw new FrameProtocolError('stream id must be 1..255 bytes');
  }
  return encodeFrame(FrameType.Audio, Buffer.concat([Buffer.from([idBytes.length]), idBytes, data]));
}

/** 中身を型に従って読む。 */
export function decodePayload(type: number, payload: Buffer): Frame {
  if (type === FrameType.Control) {
    let message: unknown;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new FrameProtocolError('control frame is not JSON');
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message) || typeof (message as { type?: unknown }).type !== 'string') {
      throw new FrameProtocolError('control frame must be an object with a string "type"');
    }
    return { kind: 'control', message: message as Record<string, unknown> };
  }
  if (type === FrameType.Audio) {
    if (payload.length < 1) {
      throw new FrameProtocolError('audio frame is empty');
    }
    const idLength = payload.readUInt8(0);
    if (idLength === 0 || payload.length < 1 + idLength) {
      throw new FrameProtocolError('audio frame has a broken stream id');
    }
    return {
      kind: 'audio',
      id: payload.subarray(1, 1 + idLength).toString('utf8'),
      data: Buffer.from(payload.subarray(1 + idLength)),
    };
  }
  throw new FrameProtocolError(`unknown frame type: ${type}`);
}

/**
 * 届いたバイト列から枠を切り出す。区切りはどこで来てもよい（標準入力の読み取り単位と枠は無関係）。
 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    while (this.pending.length >= FRAME_HEADER_BYTES) {
      const type = this.pending.readUInt8(0);
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_FRAME_PAYLOAD) {
        throw new FrameProtocolError(`frame payload too large: ${length}`);
      }
      if (this.pending.length < FRAME_HEADER_BYTES + length) {
        break;
      }
      const payload = this.pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
      this.pending = this.pending.subarray(FRAME_HEADER_BYTES + length);
      frames.push(decodePayload(type, payload));
    }
    if (this.pending.length === 0) {
      this.pending = Buffer.alloc(0);
    }
    return frames;
  }

  /** 枠の途中で入力が終わったか。 */
  get hasPartialFrame(): boolean {
    return this.pending.length > 0;
  }
}

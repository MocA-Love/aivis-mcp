/**
 * 1 発話を鳴らすときの「いつ鳴らし始めるか」「いつ打ち切るか」を決める純関数（設計 2 章）。
 * 時刻はすべて呼び出し側が渡す（テストで時計を差し替えられるように）。
 */

import { bytesForDuration, durationForBytes } from './mp3.js';

/** 手元で鳴らし始める前に溜める時間。 */
export const LOCAL_PREROLL_MS = 250;
/** ビットレートが読めないまま溜まったら、これだけ溜まった時点で鳴らし始める。 */
export const PREROLL_FALLBACK_BYTES = 64 * 1024;
/** 1 発話の上限（列で待つ時間は数えない）。 */
export const MAX_UTTERANCE_MS = 120_000;
/** 取り出してから最初の音が届くまでの上限。 */
export const FIRST_AUDIO_TIMEOUT_MS = 10_000;
/** 届く速さがこれを下回ったら遅すぎるとみなす（実時間に対する比）。 */
export const SLOW_ARRIVAL_RATIO = 0.5;
/** 遅すぎる状態がこれだけ続いたら打ち切る。 */
export const SLOW_ARRIVAL_GRACE_MS = 3_000;

/**
 * 溜まった量で鳴らし始めてよいか。流れが終わっていれば、閾値に届いていなくても鳴らす。
 */
export function shouldStartPlayback(input: {
  readonly bufferedBytes: number;
  readonly bitrateKbps: number | undefined;
  readonly ended: boolean;
  readonly prerollMs?: number;
}): boolean {
  if (input.bufferedBytes <= 0) {
    return false;
  }
  if (input.ended) {
    return true;
  }
  if (input.bitrateKbps === undefined) {
    return input.bufferedBytes >= PREROLL_FALLBACK_BYTES;
  }
  return input.bufferedBytes >= bytesForDuration(input.bitrateKbps, input.prerollMs ?? LOCAL_PREROLL_MS);
}

export type CutoffReason = 'first-audio-timeout' | 'max-duration' | 'slow-arrival';

/**
 * 打ち切りの判定を持つ。`handlingStartedAt` は列から取り出して扱い始めた時刻
 * （列で待った時間は数えない）。
 */
export class PlaybackMonitor {
  private firstAudioAt: number | undefined;
  private receivedBytes = 0;
  private bitrateKbps: number | undefined;
  private slowSince: number | undefined;
  private ended = false;

  constructor(private readonly handlingStartedAt: number) { }

  /** 音声の断片が届いた。 */
  onAudio(now: number, bytes: number): void {
    if (bytes <= 0) {
      return;
    }
    if (this.firstAudioAt === undefined) {
      this.firstAudioAt = now;
    }
    this.receivedBytes += bytes;
  }

  setBitrate(bitrateKbps: number): void {
    this.bitrateKbps = bitrateKbps;
  }

  /** 流れが終わった（end / abort の印が届いた）。以後は遅さで打ち切らない。 */
  onEnded(): void {
    this.ended = true;
  }

  get hasAudio(): boolean {
    return this.firstAudioAt !== undefined;
  }

  get bytes(): number {
    return this.receivedBytes;
  }

  /** 届いた音声が何秒ぶんか（ビットレートが分からなければ undefined）。 */
  receivedSeconds(): number | undefined {
    return this.bitrateKbps === undefined ? undefined : durationForBytes(this.bitrateKbps, this.receivedBytes);
  }

  /**
   * いま打ち切るべきかを返す（打ち切らないなら undefined）。
   * 届く速さは「最初の音から今までに届いた音声の長さ ÷ 経過時間」で測る。速く届いた後に
   * 少し止まっただけの正直な送り手は比が高いまま残り、少しずつ流し続ける送り手だけが落ちる。
   */
  check(now: number): CutoffReason | undefined {
    if (now - this.handlingStartedAt >= MAX_UTTERANCE_MS) {
      return 'max-duration';
    }
    if (this.firstAudioAt === undefined) {
      return now - this.handlingStartedAt >= FIRST_AUDIO_TIMEOUT_MS ? 'first-audio-timeout' : undefined;
    }
    if (this.ended || this.bitrateKbps === undefined) {
      this.slowSince = undefined;
      return undefined;
    }
    const elapsedSeconds = (now - this.firstAudioAt) / 1000;
    if (elapsedSeconds <= 0) {
      return undefined;
    }
    const ratio = durationForBytes(this.bitrateKbps, this.receivedBytes) / elapsedSeconds;
    if (ratio >= SLOW_ARRIVAL_RATIO) {
      this.slowSince = undefined;
      return undefined;
    }
    if (this.slowSince === undefined) {
      this.slowSince = now;
    }
    return now - this.slowSince >= SLOW_ARRIVAL_GRACE_MS ? 'slow-arrival' : undefined;
  }
}

/**
 * 2.5 の列に積むジョブの型と、期限の判定（設計 3.1・3.6 R1）。
 */

export type JobPriority = 'high' | 'normal';
/** agent = この機械の MCP・CLI、ingest = `--ingest`（Para Code）から来たもの。 */
export type JobSource = 'agent' | 'ingest';

export interface PreludeSpec {
  /** 着信音のファイル（許可フォルダの中を確かめた後の実パス） */
  readonly path: string;
  /** 着信音の音量（0〜1）。表の補正も alimiter も当てない */
  readonly volume: number;
}

interface JobBase {
  /** ジョブの形式の版。2.4 までのジョブには無い */
  readonly v: 2;
  readonly id: string;
  readonly priority: JobPriority;
  readonly source: JobSource;
  /** 列に積んだ時刻（epoch ms） */
  readonly enqueuedAt: number;
  readonly prelude?: PreludeSpec;
}

/** 音声は `aivis-mcp:audio:<id>` の Stream に流れてくる。 */
export interface StreamJob extends JobBase {
  readonly type: 'stream';
  /** 音量の表の鍵（provider:voice:model） */
  readonly gainKey?: string;
  /** 呼び出し側の音量（dB） */
  readonly volumeDb?: number;
  /** 感情タグ入りなど、音量の覚え直しに使わない発話 */
  readonly tagged?: boolean;
}

/** worker が合成しながら Stream に流して鳴らす（この機械のエージェントの声）。 */
export interface SynthJob extends JobBase {
  readonly type: 'synth';
  readonly params: Record<string, unknown>;
  readonly volumeDb?: number;
}

/** 着信音だけの通知（声を読まない設定のとき）。 */
export interface SoundJob extends JobBase {
  readonly type: 'sound';
  readonly prelude: PreludeSpec;
}

export type Job = StreamJob | SynthJob | SoundJob;

/** 列で待てる時間。hold の間は数えない。 */
export const JOB_TTL_MS: Record<JobPriority, number> = {
  normal: 120_000,
  high: 600_000,
};

/** 着信音は、列に入ってからこれ以上待ったら飛ばす（声は読む）。 */
export const PRELUDE_MAX_WAIT_MS = 5_000;

const STREAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidStreamId(value: unknown): value is string {
  return typeof value === 'string' && STREAM_ID_PATTERN.test(value);
}

/** [始まり, 終わり] の区間の並びのうち、[from, to] と重なる長さの合計。 */
export function heldOverlapMs(intervals: readonly (readonly [number, number])[], from: number, to: number): number {
  if (to <= from) {
    return 0;
  }
  // 重なった区間を二重に数えないよう、並べてからつなぐ
  const clipped = intervals
    .map(([start, end]) => [Math.max(start, from), Math.min(end, to)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let currentStart: number | undefined;
  let currentEnd = 0;
  for (const [start, end] of clipped) {
    if (currentStart === undefined || start > currentEnd) {
      if (currentStart !== undefined) {
        total += currentEnd - currentStart;
      }
      currentStart = start;
      currentEnd = end;
    } else {
      currentEnd = Math.max(currentEnd, end);
    }
  }
  if (currentStart !== undefined) {
    total += currentEnd - currentStart;
  }
  return total;
}

/** 列で待った時間（hold の間を除く）。 */
export function effectiveWaitMs(job: Pick<Job, 'enqueuedAt'>, now: number, heldMs: number): number {
  return Math.max(0, now - job.enqueuedAt - heldMs);
}

export function isJobExpired(job: Pick<Job, 'enqueuedAt' | 'priority'>, now: number, heldMs: number): boolean {
  return effectiveWaitMs(job, now, heldMs) > JOB_TTL_MS[job.priority];
}

/** 着信音を鳴らしてよいか（待ちすぎた着信音は飛ばす）。 */
export function shouldPlayPrelude(job: Pick<Job, 'enqueuedAt'>, now: number, heldMs: number): boolean {
  return effectiveWaitMs(job, now, heldMs) <= PRELUDE_MAX_WAIT_MS;
}

function isPreludeSpec(value: unknown): value is PreludeSpec {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const spec = value as Partial<PreludeSpec>;
  return typeof spec.path === 'string' && spec.path.length > 0 && spec.path.length <= 4096
    && typeof spec.volume === 'number' && Number.isFinite(spec.volume) && spec.volume >= 0 && spec.volume <= 1;
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

export type DequeuedJob =
  | { readonly kind: 'v2'; readonly job: Job }
  | { readonly kind: 'legacy'; readonly payload: Record<string, unknown> }
  | { readonly kind: 'invalid' };

/** 列から取り出した文字列を読む。2.4 までのジョブ（`v` が無い）はそのまま返す。 */
export function parseJob(raw: string): DequeuedJob {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid' };
  }
  const record = value as Record<string, unknown>;
  if (record.v === undefined) {
    return { kind: 'legacy', payload: record };
  }
  if (record.v !== 2 || !isValidStreamId(record.id)
    || (record.priority !== 'high' && record.priority !== 'normal')
    || (record.source !== 'agent' && record.source !== 'ingest')
    || typeof record.enqueuedAt !== 'number' || !Number.isFinite(record.enqueuedAt)
    || (record.prelude !== undefined && !isPreludeSpec(record.prelude))
    || !optionalFiniteNumber(record.volumeDb)) {
    return { kind: 'invalid' };
  }
  if (record.type === 'stream') {
    if (record.gainKey !== undefined && (typeof record.gainKey !== 'string' || record.gainKey.length > 300)) {
      return { kind: 'invalid' };
    }
    return { kind: 'v2', job: record as unknown as StreamJob };
  }
  if (record.type === 'synth') {
    if (typeof record.params !== 'object' || record.params === null) {
      return { kind: 'invalid' };
    }
    return { kind: 'v2', job: record as unknown as SynthJob };
  }
  if (record.type === 'sound') {
    if (!isPreludeSpec(record.prelude)) {
      return { kind: 'invalid' };
    }
    return { kind: 'v2', job: record as unknown as SoundJob };
  }
  return { kind: 'invalid' };
}

/** 合成の設定から音量の表の鍵を作る（provider:voice:model）。 */
export function gainKeyFor(provider: string, voice: string | undefined, model: string | undefined): string | undefined {
  if (provider === 'elevenlabs') {
    return voice && model ? `elevenlabs:${voice}:${model}` : undefined;
  }
  if (provider === 'aivis') {
    return voice ? `aivis:${voice}:default` : undefined;
  }
  return undefined;
}

/** ElevenLabs の感情タグ（[whispers] など）が入っているか。 */
export function hasEmotionTags(text: unknown): boolean {
  return typeof text === 'string' && /\[[^\[\]\n]{1,40}\]/.test(text);
}

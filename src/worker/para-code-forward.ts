/**
 * 合成した声を Para Code へ送る（モバイルへの転送と、SSH 先の声を手元で鳴らす経路。設計 3.4）。
 *
 * - ticket の応答に `ingress: "stream-v1"` があるときだけ、合成を受け取りながら chunked で送る。
 *   応答のヘッダー `X-Para-Local-Playback: accepted` が来たら、この機械では鳴らさない（引き受け）。
 *   401・403 は ticket が通らなかった（期限切れ・使用済み）ので unavailable。ほかの 4xx・5xx か
 *   `X-Para-Local-Playback: rejected` は明示の拒否で、この機械で鳴らす。
 *   ヘッダーはあるがどちらでもない（不明）ときは、本文の `localPlayback` で決め、無ければ鳴らさない。
 *   ヘッダーが 1 つも来ないまま接続に失敗したときだけ自分で鳴らす。
 *   引き受けの後でも、本文が `{"localPlayback":false}` なら、最終の判定（outcome）は自分で鳴らす。
 * - `stream-v1` が無ければ今どおり、全部受け取ってから Content-Length 付きで送り、応答の
 *   `localPlayback` で決める。
 * - ticket は、worker が送り始めるときに取ることがある（Promise で受ける）。取れなければ `unavailable`。
 */

import http from 'http';
import { MAX_UTTERANCE_MS } from '../streaming/playback-policy.js';
import { requestParaCodeInstanceId, requestSmall, type ParaCodeVoiceTarget } from '../services/para-code-voice.js';

/**
 * remote = Para Code が引き受けた（この機械では鳴らさない）、local = この機械で鳴らす、
 * unavailable = ticket が取れず送れなかった。
 */
export type PlaybackDecision = 'remote' | 'local' | 'unavailable';

export const STREAM_INGRESS = 'stream-v1';
export const LOCAL_PLAYBACK_HEADER = 'x-para-local-playback';
export const MAX_FORWARD_BYTES = 8 * 1024 * 1024;
/** ヘッダーの後に止まったら諦めるまで。ヘッダーの前の無通信も同じ長さで諦める（自分で鳴らす）。 */
export const FORWARD_IDLE_TIMEOUT_MS = 30_000;
/** 1 回の送り出しの全体の締切（1 発話の上限＋返事を待つ分）。 */
export const FORWARD_TOTAL_TIMEOUT_MS = MAX_UTTERANCE_MS + 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface ParaCodeForward {
  push(chunk: Buffer): void;
  end(): void;
  abort(): void;
  /** 鳴らし方の判定（引き受けのヘッダーを見た時点で決まる） */
  readonly decision: Promise<PlaybackDecision>;
  /** 本文の返事まで見た最終の判定。引き受けた後に本文で `localPlayback: false` と返ったら local */
  readonly outcome: Promise<PlaybackDecision>;
  /** 送り終わった（諦めた）ら解決する */
  readonly settled: Promise<void>;
}

/** 音量の表の鍵を Para Code へ知らせるヘッダー（英数・`:`・`_`・`-`・`.`、200 文字まで）。 */
export const GAIN_KEY_HEADER = 'X-Para-Gain-Key';
/** 感情タグ入りの発話（音量の覚え直しに使わない）であることを知らせるヘッダー。 */
export const TAGGED_HEADER = 'X-Para-Tagged';
/** 接続先がミュート中。Para Code は手元で鳴らさず、モバイルへだけ流す（ticket に muteAware があるときだけ付ける）。 */
export const MUTED_HEADER = 'X-Para-Muted';
const GAIN_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;

/** ヘッダーとして安全な鍵だけ返す（それ以外は付けない）。 */
export function safeGainKeyHeader(gainKey: string | undefined): string | undefined {
  return gainKey !== undefined && GAIN_KEY_PATTERN.test(gainKey) ? gainKey : undefined;
}

export interface ForwardOptions {
  /** 音量の表の鍵（provider:voice:model）。安全な文字だけなら `X-Para-Gain-Key` で送る */
  readonly gainKey?: string;
  /** 感情タグ入りなら `X-Para-Tagged: 1` を付ける */
  readonly tagged?: boolean;
  /** この機械がミュート中。手元で鳴らす ticket のときだけ `X-Para-Muted: 1` を付ける */
  readonly muted?: boolean;
  readonly maxBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly hostname?: string;
  /** テスト用。既定は health で instanceId を確かめる */
  readonly isCurrentInstance?: (target: ParaCodeVoiceTarget) => Promise<boolean>;
}

async function defaultIsCurrentInstance(target: ParaCodeVoiceTarget): Promise<boolean> {
  if (target.expiresAt < Date.now()) {
    return false;
  }
  const instanceId = await requestParaCodeInstanceId(target.port, 2000);
  return instanceId === target.instanceId;
}

function extraHeaders(options: ForwardOptions, target: ParaCodeVoiceTarget): Record<string, string> {
  const gainKey = safeGainKeyHeader(options.gainKey);
  return {
    ...(gainKey === undefined ? {} : { [GAIN_KEY_HEADER]: gainKey }),
    ...(options.tagged === true ? { [TAGGED_HEADER]: '1' } : {}),
    ...(options.muted === true && target.localPlayback === true && target.muteAware === true ? { [MUTED_HEADER]: '1' } : {}),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** 本文の `localPlayback`（真偽でなければ undefined）。 */
function bodyLocalPlayback(body: Buffer): boolean | undefined {
  try {
    const value = (JSON.parse(body.toString('utf8')) as { localPlayback?: unknown }).localPlayback;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function startParaCodeForward(
  target: ParaCodeVoiceTarget | Promise<ParaCodeVoiceTarget | undefined>,
  options: ForwardOptions = {},
): ParaCodeForward {
  if (target instanceof Promise) {
    return new DeferredForward(target, options);
  }
  return target.ingress === STREAM_INGRESS
    ? new ChunkedForward(target, options)
    : new BufferedForward(target, options);
}

/** 判定・最終の判定・終わりの 3 つを 1 回だけ解決する土台。 */
abstract class ForwardBase implements ParaCodeForward {
  readonly decision: Promise<PlaybackDecision>;
  readonly outcome: Promise<PlaybackDecision>;
  readonly settled: Promise<void>;
  private decided: PlaybackDecision | undefined;
  private readonly resolveDecisionRaw: (value: PlaybackDecision) => void;
  private readonly resolveOutcomeRaw: (value: PlaybackDecision) => void;
  private readonly resolveSettledRaw: () => void;
  private finished = false;

  constructor() {
    const decision = deferred<PlaybackDecision>();
    const outcome = deferred<PlaybackDecision>();
    const settled = deferred<void>();
    this.decision = decision.promise;
    this.outcome = outcome.promise;
    this.settled = settled.promise;
    this.resolveDecisionRaw = decision.resolve;
    this.resolveOutcomeRaw = outcome.resolve;
    this.resolveSettledRaw = settled.resolve;
  }

  abstract push(chunk: Buffer): void;
  abstract end(): void;
  abstract abort(): void;

  protected decide(value: PlaybackDecision): void {
    if (this.decided === undefined) {
      this.decided = value;
      this.resolveDecisionRaw(value);
    }
  }

  /** 最終の判定で終える（判定がまだなら同じ値にする）。 */
  protected finish(outcome: PlaybackDecision): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.decide(outcome);
    this.resolveOutcomeRaw(outcome);
    this.resolveSettledRaw();
  }
}

class ChunkedForward extends ForwardBase {
  private request: http.ClientRequest | undefined;
  private backlog: Buffer[] = [];
  private bytes = 0;
  private ended = false;
  private aborted = false;
  private headersReceived = false;
  /** 明示の拒否（4xx・5xx・rejected）を受けた */
  private rejected = false;
  /** ticket が通らなかった（401・403） */
  private ticketRejected = false;
  private readonly maxBytes: number;
  private totalTimer: NodeJS.Timeout | undefined;

  constructor(private readonly target: ParaCodeVoiceTarget, private readonly options: ForwardOptions) {
    super();
    this.maxBytes = options.maxBytes ?? MAX_FORWARD_BYTES;
    if (target.localPlayback !== true) {
      // 手元の Para Code（モバイルへの転送だけ）。待たずにこの機械で鳴らす
      this.decide('local');
    }
    this.totalTimer = setTimeout(() => this.giveUp(), options.totalTimeoutMs ?? FORWARD_TOTAL_TIMEOUT_MS);
    void this.connect().catch(() => this.giveUp());
  }

  push(chunk: Buffer): void {
    if (this.aborted || this.ended) {
      return;
    }
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.abort();
      return;
    }
    if (this.request === undefined) {
      this.backlog.push(chunk);
    } else if (!this.request.destroyed) {
      this.request.write(chunk);
    }
  }

  end(): void {
    if (this.aborted || this.ended) {
      return;
    }
    this.ended = true;
    this.request?.end();
  }

  abort(): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.backlog = [];
    if (this.request !== undefined) {
      this.request.destroy();
    }
    this.giveUp();
  }

  /** 途中で終わった。ヘッダーが来ていなければ自分で鳴らす。来ていれば Para Code に任せる。 */
  private giveUp(): void {
    if (this.totalTimer !== undefined) {
      clearTimeout(this.totalTimer);
      this.totalTimer = undefined;
    }
    this.request?.destroy();
    this.finish(this.resolveFinal(undefined));
  }

  /** 最終の判定。`bodyValue` は本文の localPlayback（読めなければ undefined）。 */
  private resolveFinal(bodyValue: boolean | undefined): PlaybackDecision {
    if (this.target.localPlayback !== true) {
      return 'local';
    }
    if (this.ticketRejected) {
      return 'unavailable';
    }
    if (!this.headersReceived || this.rejected) {
      return 'local';
    }
    if (bodyValue === false) {
      return 'local';
    }
    // 引き受けた・不明（ヘッダーは来た）。二重に鳴らさないよう Para Code に任せる
    return 'remote';
  }

  private async connect(): Promise<void> {
    const current = await (this.options.isCurrentInstance ?? defaultIsCurrentInstance)(this.target).catch(() => false);
    if (!current || this.aborted) {
      this.aborted = true;
      this.giveUp();
      return;
    }
    let request: http.ClientRequest;
    try {
      request = http.request({
        hostname: this.options.hostname ?? '127.0.0.1',
        port: this.target.port,
        path: '/paradis-mcp/mobile-voice',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.target.ticket}`,
          'Content-Type': 'audio/mpeg',
          ...extraHeaders(this.options, this.target),
          'Transfer-Encoding': 'chunked',
        },
      });
    } catch {
      // ヘッダーに書けない値など。送れなかったので自分で鳴らす
      this.giveUp();
      return;
    }
    this.request = request;
    request.setTimeout(this.options.idleTimeoutMs ?? FORWARD_IDLE_TIMEOUT_MS, () => request.destroy());
    request.once('response', response => {
      this.headersReceived = true;
      const status = response.statusCode ?? 0;
      const header = String(response.headers[LOCAL_PLAYBACK_HEADER] ?? '').toLowerCase();
      if (status === 401 || status === 403) {
        // ticket が通らなかった（期限切れ・使用済み）。Para Code が断ったのではなく、送れなかった
        this.ticketRejected = true;
        this.decide('unavailable');
      } else if (status >= 400 || header === 'rejected') {
        this.rejected = true;
        this.decide('local');
      } else if (header === 'accepted' && this.target.localPlayback === true) {
        this.decide('remote');
      }
      response.setTimeout(this.options.idleTimeoutMs ?? FORWARD_IDLE_TIMEOUT_MS, () => response.destroy());
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (value: Buffer) => {
        size += value.length;
        if (size <= MAX_RESPONSE_BYTES) {
          chunks.push(value);
        }
      });
      response.once('end', () => {
        if (this.totalTimer !== undefined) {
          clearTimeout(this.totalTimer);
          this.totalTimer = undefined;
        }
        this.finish(this.resolveFinal(size <= MAX_RESPONSE_BYTES ? bodyLocalPlayback(Buffer.concat(chunks)) : undefined));
      });
      // 応答の途中で切れた（end が来ない）
      response.once('aborted', () => this.giveUp());
      response.once('error', () => this.giveUp());
      response.once('close', () => this.giveUp());
    });
    request.once('error', () => {
      if (!this.headersReceived) {
        this.giveUp();
      }
    });
    request.once('close', () => {
      if (!this.headersReceived) {
        this.giveUp();
      }
    });
    for (const chunk of this.backlog) {
      request.write(chunk);
    }
    this.backlog = [];
    if (this.aborted) {
      request.destroy();
    } else if (this.ended) {
      request.end();
    }
  }
}

class BufferedForward extends ForwardBase {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private done = false;
  private readonly maxBytes: number;

  constructor(private readonly target: ParaCodeVoiceTarget, private readonly options: ForwardOptions) {
    super();
    this.maxBytes = options.maxBytes ?? MAX_FORWARD_BYTES;
    if (target.localPlayback !== true) {
      this.decide('local');
    }
  }

  push(chunk: Buffer): void {
    if (this.done) {
      return;
    }
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.abort();
      return;
    }
    this.chunks.push(chunk);
  }

  end(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    const audio = Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    if (audio.length === 0) {
      this.finish('local');
      return;
    }
    void this.post(audio).then(result => {
      if (this.target.localPlayback !== true) {
        this.finish('local');
      } else {
        this.finish(result === 'played' ? 'remote' : result === 'ticket-rejected' ? 'unavailable' : 'local');
      }
    });
  }

  abort(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.chunks = [];
    this.finish('local');
  }

  /** 送れたら Para Code が手元の PC で鳴らしたか（応答の `localPlayback`）を返す。ticket が通らなければ ticket-rejected。 */
  private async post(audio: Buffer): Promise<'played' | 'not-played' | 'ticket-rejected'> {
    const current = await (this.options.isCurrentInstance ?? defaultIsCurrentInstance)(this.target).catch(() => false);
    if (!current) {
      return 'not-played';
    }
    // 手元で鳴らすときは、Para Code が手元の列へ積み終えるまで応答を待つ。SSH を運ばれる時間も見込む
    const response = await requestSmall({
      hostname: this.options.hostname ?? '127.0.0.1',
      port: this.target.port,
      path: '/paradis-mcp/mobile-voice',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.target.ticket}`,
        'Content-Type': 'audio/mpeg',
        ...extraHeaders(this.options, this.target),
        'Content-Length': audio.byteLength,
      },
    }, this.target.localPlayback === true ? 30_000 : 3_000, audio);
    if (response !== undefined && (response.statusCode === 401 || response.statusCode === 403)) {
      return 'ticket-rejected';
    }
    if (response === undefined || response.statusCode < 200 || response.statusCode >= 300 || response.body.length === 0) {
      return 'not-played';
    }
    return bodyLocalPlayback(response.body) === true ? 'played' : 'not-played';
  }
}

/**
 * ticket を後から受け取る送り出し。受け取るまでの断片は溜めておき、受け取ったら送り始める。
 * 取れなければ `unavailable`。
 */
class DeferredForward extends ForwardBase {
  private backlog: Buffer[] = [];
  private bytes = 0;
  private ended = false;
  private aborted = false;
  private inner: ParaCodeForward | undefined;
  private readonly maxBytes: number;

  constructor(target: Promise<ParaCodeVoiceTarget | undefined>, private readonly options: ForwardOptions) {
    super();
    this.maxBytes = options.maxBytes ?? MAX_FORWARD_BYTES;
    void target.catch(() => undefined).then(resolved => this.attach(resolved));
  }

  push(chunk: Buffer): void {
    if (this.inner !== undefined) {
      this.inner.push(chunk);
      return;
    }
    if (this.aborted || this.ended) {
      return;
    }
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.abort();
      return;
    }
    this.backlog.push(chunk);
  }

  end(): void {
    if (this.inner !== undefined) {
      this.inner.end();
      return;
    }
    this.ended = true;
  }

  abort(): void {
    if (this.inner !== undefined) {
      this.inner.abort();
      return;
    }
    if (!this.aborted) {
      this.aborted = true;
      this.backlog = [];
    }
  }

  private attach(target: ParaCodeVoiceTarget | undefined): void {
    if (target === undefined) {
      this.backlog = [];
      this.finish('unavailable');
      return;
    }
    if (this.aborted) {
      this.finish('local');
      return;
    }
    const inner = startParaCodeForward(target, this.options);
    this.inner = inner;
    for (const chunk of this.backlog) {
      inner.push(chunk);
    }
    this.backlog = [];
    if (this.ended) {
      inner.end();
    }
    void inner.decision.then(value => this.decide(value));
    void inner.outcome.then(value => this.finish(value));
  }
}

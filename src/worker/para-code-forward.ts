/**
 * 合成した声を Para Code へ送る（モバイルへの転送と、SSH 先の声を手元で鳴らす経路。設計 3.4）。
 *
 * - ticket の応答に `ingress: "stream-v1"` があるときだけ、合成を受け取りながら chunked で送る。
 *   応答のヘッダー `X-Para-Local-Playback: accepted` が来たら、この機械では鳴らさない。
 *   ヘッダーが 1 つも来ないまま接続に失敗したときだけ自分で鳴らす。ヘッダーの後に止まったら 30 秒で諦める。
 * - `stream-v1` が無ければ今どおり、全部受け取ってから Content-Length 付きで送り、応答の
 *   `localPlayback` で決める。
 */

import http from 'http';
import { requestParaCodeInstanceId, type ParaCodeVoiceTarget } from '../services/para-code-voice.js';

/** remote = Para Code が引き受けた（この機械では鳴らさない）、local = この機械で鳴らす。 */
export type PlaybackDecision = 'remote' | 'local';

export const STREAM_INGRESS = 'stream-v1';
export const LOCAL_PLAYBACK_HEADER = 'x-para-local-playback';
export const MAX_FORWARD_BYTES = 8 * 1024 * 1024;
/** ヘッダーの後に止まったら諦めるまで。ヘッダーの前の無通信も同じ長さで諦める（自分で鳴らす）。 */
export const FORWARD_IDLE_TIMEOUT_MS = 30_000;

export interface ParaCodeForward {
  push(chunk: Buffer): void;
  end(): void;
  abort(): void;
  readonly decision: Promise<PlaybackDecision>;
  /** 送り終わった（諦めた）ら解決する */
  readonly settled: Promise<void>;
}

export interface ForwardOptions {
  readonly maxBytes?: number;
  readonly idleTimeoutMs?: number;
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

export function startParaCodeForward(target: ParaCodeVoiceTarget, options: ForwardOptions = {}): ParaCodeForward {
  return target.ingress === STREAM_INGRESS
    ? new ChunkedForward(target, options)
    : new BufferedForward(target, options);
}

class ChunkedForward implements ParaCodeForward {
  readonly decision: Promise<PlaybackDecision>;
  readonly settled: Promise<void>;
  private readonly resolveDecision: (value: PlaybackDecision) => void;
  private readonly resolveSettled: () => void;
  private request: http.ClientRequest | undefined;
  private backlog: Buffer[] = [];
  private bytes = 0;
  private ended = false;
  private aborted = false;
  private headersReceived = false;
  private readonly maxBytes: number;

  constructor(private readonly target: ParaCodeVoiceTarget, private readonly options: ForwardOptions) {
    const decision = deferred<PlaybackDecision>();
    const settled = deferred<void>();
    this.decision = decision.promise;
    this.resolveDecision = decision.resolve;
    this.settled = settled.promise;
    this.resolveSettled = settled.resolve;
    this.maxBytes = options.maxBytes ?? MAX_FORWARD_BYTES;
    if (target.localPlayback !== true) {
      // 手元の Para Code（モバイルへの転送だけ）。待たずにこの機械で鳴らす
      this.resolveDecision('local');
    }
    void this.connect();
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
    } else {
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
    } else {
      this.finish();
    }
  }

  private finish(): void {
    // ヘッダーが来ないまま終わった＝自分で鳴らす
    this.resolveDecision('local');
    this.resolveSettled();
  }

  private async connect(): Promise<void> {
    const current = await (this.options.isCurrentInstance ?? defaultIsCurrentInstance)(this.target).catch(() => false);
    if (!current || this.aborted) {
      this.aborted = true;
      this.finish();
      return;
    }
    const request = http.request({
      hostname: this.options.hostname ?? '127.0.0.1',
      port: this.target.port,
      path: '/paradis-mcp/mobile-voice',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.target.ticket}`,
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
      },
    });
    this.request = request;
    request.setTimeout(this.options.idleTimeoutMs ?? FORWARD_IDLE_TIMEOUT_MS, () => request.destroy());
    request.once('response', response => {
      this.headersReceived = true;
      const accepted = String(response.headers[LOCAL_PLAYBACK_HEADER] ?? '').toLowerCase() === 'accepted';
      this.resolveDecision(accepted && this.target.localPlayback === true ? 'remote' : 'local');
      response.setTimeout(this.options.idleTimeoutMs ?? FORWARD_IDLE_TIMEOUT_MS, () => response.destroy());
      response.resume();
      response.once('end', () => this.finish());
      response.once('close', () => this.finish());
      response.once('error', () => this.finish());
    });
    request.once('error', () => {
      if (!this.headersReceived) {
        this.resolveDecision('local');
      }
      this.finish();
    });
    request.once('close', () => {
      if (!this.headersReceived) {
        this.finish();
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

class BufferedForward implements ParaCodeForward {
  readonly decision: Promise<PlaybackDecision>;
  readonly settled: Promise<void>;
  private readonly resolveDecision: (value: PlaybackDecision) => void;
  private readonly resolveSettled: () => void;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private done = false;
  private readonly maxBytes: number;

  constructor(private readonly target: ParaCodeVoiceTarget, private readonly options: ForwardOptions) {
    const decision = deferred<PlaybackDecision>();
    const settled = deferred<void>();
    this.decision = decision.promise;
    this.resolveDecision = decision.resolve;
    this.settled = settled.promise;
    this.resolveSettled = settled.resolve;
    this.maxBytes = options.maxBytes ?? MAX_FORWARD_BYTES;
    if (target.localPlayback !== true) {
      this.resolveDecision('local');
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
      this.finish(false);
      return;
    }
    void this.post(audio).then(playedLocally => this.finish(playedLocally));
  }

  abort(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.chunks = [];
    this.finish(false);
  }

  private finish(playedLocally: boolean): void {
    this.resolveDecision(playedLocally && this.target.localPlayback === true ? 'remote' : 'local');
    this.resolveSettled();
  }

  /** 送れたら Para Code が手元の PC で鳴らしたか（応答の `localPlayback`）を返す。 */
  private async post(audio: Buffer): Promise<boolean> {
    const current = await (this.options.isCurrentInstance ?? defaultIsCurrentInstance)(this.target).catch(() => false);
    if (!current) {
      return false;
    }
    return new Promise<boolean>(resolve => {
      const request = http.request({
        hostname: this.options.hostname ?? '127.0.0.1',
        port: this.target.port,
        path: '/paradis-mcp/mobile-voice',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.target.ticket}`,
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.byteLength,
        },
        // 手元で鳴らすときは、Para Code が手元の列へ積み終えるまで応答を待つ。SSH を運ばれる時間も見込む
        timeout: this.target.localPlayback === true ? 30000 : 3000,
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (value: Buffer) => {
          size += value.byteLength;
          if (size <= 16 * 1024) {
            chunks.push(value);
          }
        });
        response.once('end', () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300 || size <= 0 || size > 16 * 1024) {
            resolve(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as { localPlayback?: unknown };
            resolve(body.localPlayback === true);
          } catch {
            resolve(false);
          }
        });
      });
      request.once('timeout', () => { request.destroy(); resolve(false); });
      request.once('error', () => resolve(false));
      request.end(audio);
    });
  }
}

import fs from 'fs';
import http from 'http';

/**
 * Para Code へ生成済み音声を渡すための、1回限りの認証済みlocalhost転送先。
 * MCP と CLI のどちらから発話しても同じ経路を通す必要があるため、ここに切り出している。
 */
export interface ParaCodeVoiceTarget {
  ticket: string;
  port: number;
  instanceId: string;
  expiresAt: number;
  /**
   * Para Code が手元のPCで鳴らすと答えたか（SSH先のペインから発話したとき）。
   * true のときはworkerがこの機械で鳴らさず、Para Code へ渡せなかった時だけ自分で鳴らす。
   */
  localPlayback?: boolean;
  /**
   * 新しい Para Code が名乗る取込の形式。`stream-v1` なら合成しながら chunked で送り、応答のヘッダー
   * `X-Para-Local-Playback: accepted` で鳴らし方を決める。無ければ全部受け取ってから送る。
   */
  ingress?: string;
  /**
   * Para Code が `X-Para-Muted: 1` を解する（接続先がミュート中の声を、手元では鳴らさずモバイルへだけ流す）か。
   * 無ければ、ミュート中の接続先は localPlayback の ticket で送らない。
   */
  muteAware?: boolean;
}

/** 手元のloopbackでの発行待ち。モバイル副経路でPC再生キューを待たせないよう短くする。 */
const LOCAL_TIMEOUT_MS = 300;
/** SSH先からの戻り経路（ssh -R）越しの待ち。 */
const REMOTE_TIMEOUT_MS = 1500;
/** 応答の本文の上限。 */
const MAX_RESPONSE_BYTES = 16 * 1024;

/**
 * ticket は Authorization ヘッダーにそのまま載せるので、ヘッダーに書ける文字（token68 の範囲）だけを通す。
 * 改行などが入った ticket で http.request が例外を投げて worker が落ちないようにする。
 */
const TICKET_PATTERN = /^[A-Za-z0-9._~+/=-]{1,200}$/;
/** ペインのトークン（ヘッダーに書ける表示文字だけ）。 */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,200}$/;

export function isParaCodeVoiceTarget(value: unknown): value is ParaCodeVoiceTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const target = value as Partial<ParaCodeVoiceTarget>;
  return typeof target.ticket === 'string'
    && TICKET_PATTERN.test(target.ticket)
    && typeof target.port === 'number'
    && Number.isInteger(target.port)
    && target.port >= 1
    && target.port <= 65535
    && typeof target.instanceId === 'string'
    && target.instanceId.length > 0
    && target.instanceId.length <= 200
    && typeof target.expiresAt === 'number'
    && Number.isSafeInteger(target.expiresAt)
    && target.expiresAt > Date.now()
    && (target.localPlayback === undefined || typeof target.localPlayback === 'boolean')
    && (target.ingress === undefined || (typeof target.ingress === 'string' && target.ingress.length <= 32))
    && (target.muteAware === undefined || typeof target.muteAware === 'boolean');
}

function paneToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.PARA_CODE_TERMINAL_PANE_ID || env.PARA_CODE_VOICE_TOKEN;
  return token !== undefined && TOKEN_PATTERN.test(token) ? token : undefined;
}

/** Para Code から起動されたプロセスか（ペインのトークンとポートファイルが渡っているか）。 */
export function hasParaCodeVoiceEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return paneToken(env) !== undefined && Boolean(env.PARA_CODE_MCP_PORT_FILE);
}

interface PortRecord {
  readonly port: number;
  /** SSH 先のポートファイル（pid と instanceId が無い）か */
  readonly remote: boolean;
  readonly pid?: number;
  readonly instanceId?: string;
}

function readPortFile(portFile: string): PortRecord | undefined {
  try {
    const stat = fs.statSync(portFile);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RESPONSE_BYTES) {
      return undefined;
    }
    const record = JSON.parse(fs.readFileSync(portFile, 'utf8')) as { port?: unknown; pid?: unknown; instanceId?: unknown };
    if (typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
      return undefined;
    }
    // SSH先のポートファイルは Para Code が戻り経路（ssh -R）のポートだけを書く。pid は手元の
    // プロセスなので書かれず、instanceId も無い
    if (record.pid === undefined && record.instanceId === undefined) {
      return { port: record.port, remote: true };
    }
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0
      || typeof record.instanceId !== 'string' || record.instanceId.length === 0 || record.instanceId.length > 200) {
      return undefined;
    }
    return { port: record.port, remote: false, pid: record.pid, instanceId: record.instanceId };
  } catch {
    return undefined;
  }
}

/**
 * このプロセスが SSH 先のペインで動いているか（ポートファイルが戻り経路のもの）。SSH 先の声は
 * Para Code が手元の PC で鳴らす前提なので、ticket が取れなかったときに接続先で鳴らすかの判断に使う。
 */
export function isRemoteParaCodePane(env: NodeJS.ProcessEnv = process.env): boolean {
  const portFile = env.PARA_CODE_MCP_PORT_FILE;
  return portFile !== undefined && readPortFile(portFile)?.remote === true;
}

/**
 * 発話を要求した側の認証済みlocalhost転送先を、workerの環境へ依存せず確定する。
 * 再生workerはRedis全体で1つだけなので、そのprocess.envは要求元と一致しない。
 * Para Code から起動されていない場合は undefined（PC再生だけが続く）。
 */
/** 戻り経路の先の instanceId を覚えておく入れ物（常駐する MCP サーバーが、毎回 health を取らないために持つ）。 */
export interface InstanceIdCache {
  port?: number;
  instanceId?: string;
}

export async function captureParaCodeVoiceTarget(env: NodeJS.ProcessEnv = process.env, cache?: InstanceIdCache): Promise<ParaCodeVoiceTarget | undefined> {
  // ターミナルのペインで動く場合はペイントークン、拡張機能ホスト経由（Codex等）で動く場合は
  // 音声取込専用トークンが渡ってくる。どちらも Para Code のloopbackだけが受理する。
  const token = paneToken(env);
  const portFile = env.PARA_CODE_MCP_PORT_FILE;
  if (token === undefined || !portFile) {
    return undefined;
  }
  try {
    const record = readPortFile(portFile);
    if (record === undefined) {
      return undefined;
    }
    let instanceId: string | undefined;
    // 戻り経路はSSHを往復するので、手元より長めに待つ
    let timeoutMs = LOCAL_TIMEOUT_MS;
    if (record.remote) {
      timeoutMs = REMOTE_TIMEOUT_MS;
      // 覚えている instanceId があれば health を飛ばす（ticket の応答の instanceId で確かめる）
      if (cache?.port === record.port && cache.instanceId !== undefined) {
        const target = await requestParaCodeVoiceTicket(record.port, cache.instanceId, token, timeoutMs);
        if (target === undefined) {
          // Para Code が起動し直したなどで古いかもしれない。捨てて、次の依頼で health から取り直す
          // （この依頼は諦める。呼び出し側は控えの ticket を使う。health まで続けると最大 4.5 秒かかる）
          cache.instanceId = undefined;
        }
        return target;
      }
      // 生存確認を経路の応答で代え、instanceId は health から取る
      instanceId = await requestParaCodeInstanceId(record.port, timeoutMs);
      if (cache !== undefined && instanceId !== undefined) {
        cache.port = record.port;
        cache.instanceId = instanceId;
      }
    } else {
      try {
        process.kill(record.pid!, 0);
      } catch {
        return undefined;
      }
      instanceId = record.instanceId;
    }
    if (instanceId === undefined) {
      return undefined;
    }
    return await requestParaCodeVoiceTicket(record.port, instanceId, token, timeoutMs);
  } catch {
    return undefined;
  }
}

/** 発話の引数に、その場で取った Para Code の転送先を添える（取れなければそのまま）。 */
export async function withParaCodeVoiceTarget(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const voiceTarget = await captureParaCodeVoiceTarget();
  return voiceTarget === undefined ? params : { ...params, _paraCodeVoiceTarget: voiceTarget };
}

export interface SmallResponse {
  readonly statusCode: number;
  readonly body: Buffer;
}

/**
 * loopback へ小さな要求を送り、応答の本文（16KiB まで）を読む。接続の失敗・応答の途中切断・
 * 全体の締切のどれでも undefined で必ず終わる（待ち続けない）。
 */
export function requestSmall(options: http.RequestOptions, timeoutMs: number, body?: Buffer): Promise<SmallResponse | undefined> {
  return new Promise(resolve => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const finish = (value: SmallResponse | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (value === undefined) {
        request?.destroy();
      }
      resolve(value);
    };
    // 応答のヘッダーが来た後に止まっても、全体の締切で諦める
    const deadline = setTimeout(() => finish(undefined), timeoutMs);
    try {
      request = http.request({ ...options, timeout: timeoutMs }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (value: Buffer | string) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          size += chunk.byteLength;
          if (size <= MAX_RESPONSE_BYTES) {
            chunks.push(chunk);
          }
        });
        response.once('end', () => {
          finish(size > MAX_RESPONSE_BYTES ? undefined : { statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
        // 途中で切れた（end が来ない）
        response.once('aborted', () => finish(undefined));
        response.once('error', () => finish(undefined));
        response.once('close', () => finish(undefined));
      });
      request.once('timeout', () => finish(undefined));
      request.once('error', () => finish(undefined));
      request.end(body);
    } catch {
      // ヘッダーに書けない値などで、要求を作る時点で例外になった
      finish(undefined);
    }
  });
}

async function requestParaCodeVoiceTicket(port: number, expectedInstanceId: string, authToken: string, timeoutMs: number): Promise<ParaCodeVoiceTarget | undefined> {
  // 任意のモバイル副経路でPC再生キューを待たせないよう、loopback発行は短時間で諦める。
  const response = await requestSmall({
    hostname: '127.0.0.1',
    port,
    path: '/paradis-mcp/mobile-voice-ticket',
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Length': 0 },
  }, timeoutMs);
  if (response === undefined || response.statusCode !== 201 || response.body.length === 0) {
    return undefined;
  }
  try {
    const body = JSON.parse(response.body.toString('utf8')) as Partial<ParaCodeVoiceTarget>;
    const target = { ...body, port };
    return target.instanceId === expectedInstanceId && isParaCodeVoiceTarget(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** 戻り経路の先にいる Para Code の instanceId を health から読む（読めなければ undefined）。 */
export async function requestParaCodeInstanceId(port: number, timeoutMs: number): Promise<string | undefined> {
  const response = await requestSmall({ hostname: '127.0.0.1', port, path: '/paradis-mcp/health', method: 'GET' }, timeoutMs);
  if (response === undefined || response.statusCode !== 200 || response.body.length === 0) {
    return undefined;
  }
  try {
    const body = JSON.parse(response.body.toString('utf8')) as { instanceId?: unknown };
    return typeof body.instanceId === 'string' && body.instanceId.length > 0 && body.instanceId.length <= 200 ? body.instanceId : undefined;
  } catch {
    return undefined;
  }
}

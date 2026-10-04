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
}

/** 手元のloopbackでの発行待ち。モバイル副経路でPC再生キューを待たせないよう短くする。 */
const LOCAL_TIMEOUT_MS = 300;
/** SSH先からの戻り経路（ssh -R）越しの待ち。 */
const REMOTE_TIMEOUT_MS = 1500;

export function isParaCodeVoiceTarget(value: unknown): value is ParaCodeVoiceTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const target = value as Partial<ParaCodeVoiceTarget>;
  return typeof target.ticket === 'string'
    && target.ticket.length > 0
    && target.ticket.length <= 200
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
    && (target.localPlayback === undefined || typeof target.localPlayback === 'boolean');
}

/**
 * 発話を要求した側の認証済みlocalhost転送先を、workerの環境へ依存せず確定する。
 * 再生workerはRedis全体で1つだけなので、そのprocess.envは要求元と一致しない。
 * Para Code から起動されていない場合は undefined（PC再生だけが続く）。
 */
export async function captureParaCodeVoiceTarget(): Promise<ParaCodeVoiceTarget | undefined> {
  // ターミナルのペインで動く場合はペイントークン、拡張機能ホスト経由（Codex等）で動く場合は
  // 音声取込専用トークンが渡ってくる。どちらも Para Code のloopbackだけが受理する。
  const token = process.env.PARA_CODE_TERMINAL_PANE_ID || process.env.PARA_CODE_VOICE_TOKEN;
  const portFile = process.env.PARA_CODE_MCP_PORT_FILE;
  if (!token || token.length > 200 || !portFile) {
    return undefined;
  }

  try {
    const stat = fs.statSync(portFile);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024) {
      return undefined;
    }
    const record = JSON.parse(fs.readFileSync(portFile, 'utf8')) as { port?: unknown; pid?: unknown; instanceId?: unknown };
    if (typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
      return undefined;
    }
    // SSH先のポートファイルは Para Code が戻り経路（ssh -R）のポートだけを書く。pid は手元の
    // プロセスなので書かれず、instanceId も無い。そのときは生存確認を経路の応答で代え、
    // instanceId は health から取る。
    let instanceId: string | undefined;
    // 戻り経路はSSHを往復するので、手元より長めに待つ
    let timeoutMs = LOCAL_TIMEOUT_MS;
    if (record.pid === undefined && record.instanceId === undefined) {
      timeoutMs = REMOTE_TIMEOUT_MS;
      instanceId = await requestParaCodeInstanceId(record.port, timeoutMs);
    } else {
      if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0
        || typeof record.instanceId !== 'string' || record.instanceId.length === 0 || record.instanceId.length > 200) {
        return undefined;
      }
      try {
        process.kill(record.pid, 0);
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

function requestParaCodeVoiceTicket(port: number, expectedInstanceId: string, authToken: string, timeoutMs: number): Promise<ParaCodeVoiceTarget | undefined> {
  return new Promise(resolve => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/paradis-mcp/mobile-voice-ticket',
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Length': 0 },
      // 任意のモバイル副経路でPC再生キューを待たせないよう、loopback発行は短時間で諦める。
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', value => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.byteLength;
        if (size <= 16 * 1024) {
          chunks.push(chunk);
        }
      });
      response.once('end', () => {
        if (response.statusCode !== 201 || size <= 0 || size > 16 * 1024) {
          resolve(undefined);
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as Partial<ParaCodeVoiceTarget>;
          const target = { ...body, port };
          if (target.instanceId !== expectedInstanceId || !isParaCodeVoiceTarget(target)) {
            resolve(undefined);
            return;
          }
          resolve(target);
        } catch {
          resolve(undefined);
        }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(undefined); });
    request.once('error', () => resolve(undefined));
    request.end();
  });
}

/** 戻り経路の先にいる Para Code の instanceId を health から読む（読めなければ undefined）。 */
export function requestParaCodeInstanceId(port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/paradis-mcp/health',
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', value => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.byteLength;
        if (size <= 16 * 1024) {
          chunks.push(chunk);
        }
      });
      response.once('end', () => {
        if (response.statusCode !== 200 || size <= 0 || size > 16 * 1024) {
          resolve(undefined);
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as { instanceId?: unknown };
          resolve(typeof body.instanceId === 'string' && body.instanceId.length > 0 && body.instanceId.length <= 200 ? body.instanceId : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(undefined); });
    request.once('error', () => resolve(undefined));
  });
}

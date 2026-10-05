import { spawn, execSync } from 'child_process';
import { platform } from 'os';
import { createClient, type RedisClientType } from 'redis';
import { version, type AppConfig, type ArgValue } from './config.js';
import { connectRedis, ensureWorkerRunning, spawnWorker, WORKER_VERSION_KEY } from './services/redis-service.js';
import { parseMuteDuration, setMute, clearMute, getMuteStatus } from './services/mute-service.js';
import { enqueueAudio, restoreLegacyQueue } from './queue/enqueue.js';
import { compareVersions } from './queue/worker-lock.js';
import { safeGainKeyHeader } from './worker/para-code-forward.js';
import { HIGH_QUEUE_KEY, HOLD_PREFIX, NORMAL_QUEUE_KEY } from './queue/keys.js';
import { detectPlayerKind, hasFfmpeg } from './audio/player.js';
import { gainFilePath, GainLockError, MAX_LEARNED_ENTRIES } from './audio/gain-table.js';
import { exportGains, GainImportError, importGains } from './audio/gain-transfer.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface AivisProcess {
  pid: string;
  cmd: string;
  isWorker: boolean;
}

function getAivisProcesses(): AivisProcess[] {
  const myPid = process.pid.toString();
  try {
    const output = execSync('ps aux', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = output.split('\n');
    const results: AivisProcess[] = [];
    for (const line of lines) {
      if (!line.includes('aivis-mcp') || !line.includes('dist/index.js')) continue;
      if (line.includes('ps aux')) continue;
      // --ingest は Para Code が持つ常駐の子。止めると Para Code の読み上げが止まるので対象にしない
      if (line.includes('--ingest')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = parts[1];
      if (pid === myPid) continue;
      const cmd = parts.slice(10).join(' ');
      const isWorker = line.includes('--worker');
      results.push({ pid, cmd, isWorker });
    }
    return results;
  } catch {
    return [];
  }
}

export async function runHealth(config: AppConfig): Promise<void> {
  console.log('=== aivis-mcp health check ===');
  console.log('');

  // API Key
  console.log(`API Key:       ${config.apiKey ? 'OK' : 'NG (未設定)'}`);

  // Redis
  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    await client.ping();
    console.log(`Redis:         OK (${config.redisUrl})`);

    const workerLock = await client.get(config.workerLockKey);
    const workerVersion = await client.get(WORKER_VERSION_KEY);
    console.log(`Worker:        ${workerLock ? `OK (v${workerVersion ?? '不明'})` : 'NG (停止中)'}`);
    if (workerLock && workerVersion !== version) {
      console.log(`               この aivis-mcp は v${version} です。aivis-mcp --reboot で起動し直してください`);
    }

    const [highLen, normalLen, legacyLen] = await Promise.all([
      client.lLen(HIGH_QUEUE_KEY), client.lLen(NORMAL_QUEUE_KEY), client.lLen(config.queueKey),
    ]);
    console.log(`Queue:         high ${highLen} 件 / normal ${normalLen} 件 / 旧 ${legacyLen} 件`);

    let holds = 0;
    for await (const key of client.scanIterator({ MATCH: `${HOLD_PREFIX}*`, COUNT: 100 })) {
      if (key) holds++;
    }
    console.log(`Hold:          ${holds > 0 ? `${holds} 件（音声入力中のため止めています）` : 'なし'}`);

    const playLock = await client.get('aivis-mcp:play-lock');
    console.log(`Play Lock:     ${playLock ? '使用中' : '空き'}`);

    await client.disconnect();
  } catch {
    console.log(`Redis:         NG (接続失敗: ${config.redisUrl})`);
    if (client) await client.disconnect().catch(() => {});
  }

  // Processes
  const procs = getAivisProcesses();
  const workers = procs.filter(p => p.isWorker);
  const mcpServers = procs.filter(p => !p.isWorker);
  console.log(`Processes:     ${procs.length} 件`);
  if (workers.length > 1) {
    console.log(`  Workers:     ${workers.length} (多重起動)`);
  } else {
    console.log(`  Workers:     ${workers.length}`);
  }
  console.log(`  MCP Servers: ${mcpServers.length}`);
  for (const p of procs) {
    console.log(`  PID ${p.pid}: ${p.isWorker ? '[worker]' : '[mcp]'} ${p.cmd}`);
  }

  // Audio player
  const system = platform();
  let players: string[] = [];
  if (system === 'darwin') {
    players = ['ffplay', 'mpv', 'afplay'];
  } else if (system === 'linux') {
    players = ['ffplay', 'mpv', 'mplayer', 'play'];
  } else if (system === 'win32') {
    players = ['ffplay.exe', 'mpv.exe'];
  }

  const available: string[] = [];
  for (const player of players) {
    try {
      const checkCmd = system === 'win32' ? 'where' : 'which';
      const result = spawn(checkCmd, [player], { stdio: 'pipe' });
      await new Promise<void>((resolve) => {
        result.on('exit', (code) => {
          if (code === 0) available.push(player);
          resolve();
        });
      });
    } catch {}
  }
  console.log(`Audio Player:  ${available.length > 0 ? `OK (${available.join(', ')})` : 'NG (未検出)'}`);
  const kind = detectPlayerKind();
  if (kind !== 'ffplay' && kind !== 'mpv') {
    console.log('               ffmpeg (ffplay) が無いため、全部受け取ってから鳴らします。音量の自動調整も一部しか効きません');
  }
  console.log(`Loudness:      ${hasFfmpeg() ? 'OK (ffmpeg)' : 'NG (ffmpeg が無いため音量を覚え直せません)'}`);
  console.log(`Gain Table:    ${gainFilePath()}`);

  // Model
  console.log(`Model UUID:    ${config.modelUuid}`);
}

export async function runReboot(config: AppConfig): Promise<void> {
  console.log('aivis-mcp reboot...');

  const procs = getAivisProcesses();
  const workers = procs.filter(p => p.isWorker);
  const mcpServers = procs.filter(p => !p.isWorker);

  if (workers.length > 0) {
    console.log(`Workers: ${workers.length} 件を停止`);
    for (const p of workers) {
      try { process.kill(parseInt(p.pid, 10), 'SIGTERM'); } catch {}
    }
  }
  if (mcpServers.length > 0) {
    console.log(`MCP Servers: ${mcpServers.length} 件を停止（クライアントが自動再起動します）`);
    for (const p of mcpServers) {
      try { process.kill(parseInt(p.pid, 10), 'SIGTERM'); } catch {}
    }
  }
  if (procs.length > 0) {
    await sleep(500);
  }

  try {
    const client = await connectRedis(config.redisUrl);
    const keys = await client.keys('aivis-mcp:*');
    if (keys.length > 0) {
      await client.del(keys);
      console.log(`Redis: ${keys.length} 件のキーを削除`);
    } else {
      console.log('Redis: クリア済み');
    }
    await client.disconnect();
  } catch {
    console.log('Redis: 接続失敗（スキップ）');
  }

  spawnWorker(config);
  await sleep(500);
  console.log('新しいワーカーを起動しました');
  console.log('reboot 完了');
}

/** 残り時間を「1時間30分」「45秒」のような日本語表記にする */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
  if (minutes > 0) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
  return `${seconds}秒`;
}

export async function runMute(config: AppConfig, durationArg: string | undefined): Promise<void> {
  let durationMs: number | undefined;
  if (durationArg !== undefined && durationArg !== '') {
    durationMs = parseMuteDuration(durationArg);
    if (durationMs === undefined) {
      console.error(`Error: 時間の指定を解釈できません: ${durationArg}（例: 30m, 1h, 90s, 5000ms）`);
      process.exitCode = 1;
      return;
    }
  }

  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    await setMute(client, durationMs);
    if (durationMs === undefined) {
      console.log('ミュートしました（自分で解除するまで）');
    } else {
      console.log(`ミュートしました（${formatDuration(durationMs)}後に自動解除）`);
    }
    await client.disconnect();
  } catch {
    console.error(`Error: Redisに接続できません (${config.redisUrl})`);
    process.exitCode = 1;
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function runUnmute(config: AppConfig): Promise<void> {
  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    await clearMute(client);
    console.log('ミュートを解除しました');
    await client.disconnect();
  } catch {
    console.error(`Error: Redisに接続できません (${config.redisUrl})`);
    process.exitCode = 1;
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function runMuteStatus(config: AppConfig): Promise<void> {
  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: config.redisUrl }) as RedisClientType;
    await client.connect();
    const status = await getMuteStatus(client);
    if (!status.muted) {
      console.log('ミュートされていません');
    } else if (status.until === undefined) {
      console.log('ミュート中（自分で解除するまで）');
    } else {
      console.log(`ミュート中（あと${formatDuration(status.until - Date.now())}で自動解除）`);
    }
    await client.disconnect();
  } catch {
    console.error(`Error: Redisに接続できません (${config.redisUrl})`);
    process.exitCode = 1;
    if (client) await client.disconnect().catch(() => {});
  }
}

/** 合成済みMP3のjob（`_audioBase64`）を読めるworkerの版か（2.4.0 以上）。 */
function supportsAudioJobs(workerVersion: string): boolean {
  const parts = workerVersion.split('.').map(part => parseInt(part, 10));
  if (parts.length < 3 || parts.some(part => Number.isNaN(part))) {
    return false;
  }
  const [major, minor] = parts;
  return major > 2 || (major === 2 && minor >= 4);
}

/** `--play-audio` で受け取るMP3の上限（Para Code の音声取込と同じ 8MB）。 */
const MAX_PLAY_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * 標準入力の合成済みMP3を、ほかの発話と同じキューに積んで鳴らす（Para Code が SSH 先の発話を手元で
 * 鳴らすための口）。積めたら終了コード 0、入力が空・大きすぎるときは 2。ミュートはworkerが見る。
 * 2.5 の worker なら `q2:normal` に積み（hold・優先の順・音量の表が効く）、`gainKey` があれば表の鍵として添える。
 */
export async function runPlayAudio(config: AppConfig, gainKey?: string): Promise<void> {
  const safeGainKey = safeGainKeyHeader(gainKey);
  if (gainKey !== undefined && safeGainKey === undefined) {
    console.error('Warning: --gain-key の形が正しくないので使いません（provider:voice:model）');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_PLAY_AUDIO_BYTES) {
      console.error('Error: 音声が大きすぎます');
      process.exitCode = 2;
      return;
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    console.error('Error: 標準入力に音声がありません');
    process.exitCode = 2;
    return;
  }
  const client = await connectRedis(config.redisUrl);
  try {
    await ensureWorkerRunning(client, config);
    // 起こしたばかりのworkerが版を書くまで少し待つ
    let workerVersion: string | null = null;
    for (let i = 0; i < 10 && workerVersion === null; i++) {
      workerVersion = await client.get(WORKER_VERSION_KEY);
      if (workerVersion === null) {
        await sleep(100);
      }
    }
    if (workerVersion === null || !supportsAudioJobs(workerVersion)) {
      // 古いworkerは合成済みMP3のjobを読めない。積まずに失敗を返す（Para Code は接続先で鳴らさせる）
      console.error(`Error: 動いているworkerが 2.4.0 より古いか、版が分かりません（${workerVersion ?? '不明'}）。aivis-mcp --reboot で起動し直してください`);
      process.exitCode = 3;
      return;
    }
    // 2.4 の worker は 2.5 の列を読まないので、古い列に積む
    const target = compareVersions(workerVersion, '2.5.0') >= 0 ? 'q2' : 'legacy';
    await enqueueAudio(client, {
      _audioBase64: Buffer.concat(chunks, total).toString('base64'),
      ...(safeGainKey === undefined ? {} : { gainKey: safeGainKey }),
    }, target);
    // 積めた印。呼び出し側は終了コードではなくこれで判断する（この後に止められても積んだ事実は変わらない）
    process.stdout.write('queued\n');
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/**
 * 2.5.1 が 2.4 の worker から lock を引き取ったときに `aivis-mcp:q2:legacy` へ移した発話を、古い列
 * `aivis-mcp:queue` へ戻す。2.5.0 以前へ戻したとき（古い worker はこの列を読まない）に使う。
 */
export async function runRestoreLegacyQueue(config: AppConfig): Promise<void> {
  const client = await connectRedis(config.redisUrl);
  try {
    const moved = await restoreLegacyQueue(client);
    console.log(moved > 0 ? `${moved} 件を古い列へ戻しました` : '戻す発話はありません');
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

const EXPORT_GAINS_USAGE = '--export-gains <file> [--voice <voice_id>…] [--model <model_id>]';
const IMPORT_GAINS_USAGE = '--import-gains <file> [--overwrite]';

/** `--export-gains` / `--import-gains` の値。無い・別のオプションに見える（`-` で始まる）ときは使い方を出す。 */
function gainFileArgument(value: ArgValue, flag: string, usage: string, json = false): string | undefined {
  if (typeof value === 'string' && value !== '' && !value.startsWith('-')) {
    return value;
  }
  if (json) {
    console.error(`error: ${flag} にはファイルのパスを渡してください（- で始まるパスは ./ を付けてください）。使い方: ${usage} --json`);
    return undefined;
  }
  console.error(`${flag} にはファイルのパスを渡してください（- で始まるパスは ./ を付けてください）`);
  console.error(`使い方: ${usage}`);
  return undefined;
}

/**
 * `--export-gains` / `--import-gains` が指定されていれば実行して true を返す（終了コードは `process.exitCode`）。
 * 値が無くても true を返す（MCP サーバーとして起動したまま止まらないように）。
 */
export async function runGainTransfer(values: Record<string, ArgValue>): Promise<boolean> {
  const json = values.json === true;
  if (values['export-gains'] !== undefined) {
    const output = gainFileArgument(values['export-gains'], '--export-gains', EXPORT_GAINS_USAGE, json);
    if (output === undefined) {
      process.exitCode = 1;
      return true;
    }
    const voices = Array.isArray(values.voice) ? values.voice : [];
    runExportGains(output, voices, typeof values.model === 'string' ? values.model : undefined, json);
    return true;
  }
  if (values['import-gains'] !== undefined) {
    warnStrayVoiceOption(values);
    const input = gainFileArgument(values['import-gains'], '--import-gains', IMPORT_GAINS_USAGE, json);
    if (input === undefined) {
      process.exitCode = 1;
      return true;
    }
    await runImportGains(input, values.overwrite === true, json);
    return true;
  }
  return false;
}

/** `--voice` は書き出しの絞り込みにしか使わない。ほかで（`--import-gains` を含む）来たら、値が読み上げる文から消えたことを知らせる。 */
export function warnStrayVoiceOption(values: Record<string, ArgValue>): void {
  if (values['export-gains'] !== undefined || !Array.isArray(values.voice) || values.voice.length === 0) {
    return;
  }
  console.error(`[aivis-mcp] --voice は --export-gains の絞り込み用で、ここでは使いません（値 ${values.voice.join(', ')} は読み上げる文にも入りません）。ElevenLabs の声は --voice-id で指定します`);
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ');
}

/**
 * `--export-gains <file> [--voice <id>…] [--model <id>] [--json]`: 音量の表を書き出す。
 * `--json` なら標準出力に `{"ok":true,"written":N}` だけを出し、失敗は標準エラーに `error: <理由>`（どちらも終了コードで成否が分かる）。
 */
export function runExportGains(outputPath: string, voices: readonly string[], model: string | undefined, json = false): void {
  try {
    const count = exportGains(outputPath, { voices, model });
    if (json) {
      console.log(JSON.stringify({ ok: true, written: count }));
      return;
    }
    console.log(`音量の表を ${count} 行書き出しました: ${outputPath}`);
    if (count === 0 && (voices.length > 0 || model !== undefined)) {
      console.log('一致する行がありません。Aivis の行は鍵が aivis:<model_uuid>:default なので、--voice にモデル UUID、--model に default を渡します');
    }
  } catch (error) {
    console.error(json ? `error: ${oneLine(error)}` : `書き出せませんでした: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * `--import-gains <file> [--overwrite] [--json]`: 音量の表を読み込んで足す。
 * `--json` なら標準出力に `{"ok":true,"added":N,"updated":N,"skipped":N,"evicted":N,"dropped":N}` だけを出す
 * （updated は上書きした行、skipped は自分の値を残した行、dropped は表の上限で入らなかった行）。
 */
export async function runImportGains(inputPath: string, overwrite: boolean, json = false): Promise<void> {
  try {
    const result = await importGains(inputPath, overwrite);
    if (json) {
      console.log(JSON.stringify({ ok: true, added: result.added, updated: result.overwritten, skipped: result.kept, evicted: result.evicted, dropped: result.dropped }));
      return;
    }
    console.log(`音量の表を読み込みました: 追加 ${result.added} 行、上書き ${result.overwritten} 行、自分の値を残した ${result.kept} 行（${gainFilePath()}）`);
    if (result.dropped > 0 || result.evicted > 0) {
      console.log(`表の上限（${MAX_LEARNED_ENTRIES} 行）を超えたため、取り込んだ ${result.dropped} 行が入らず、自分の表の古い ${result.evicted} 行が消えました`);
    }
    if (result.kept > 0) {
      console.log('受け取った値で上書きするには --overwrite を付けてください');
    }
  } catch (error) {
    if (json) {
      console.error(`error: ${oneLine(error)}`);
    } else {
      const prefix = error instanceof GainImportError || error instanceof GainLockError ? '読み込みを取りやめました' : '読み込めませんでした';
      console.error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

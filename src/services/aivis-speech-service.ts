import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { platform } from 'os';
import dotenv from 'dotenv';
import { createClient, type RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import chokidar from 'chokidar';

// .envファイルを絶対パスで読み込む
const envPath = path.join(__dirname, '../../.env');
dotenv.config({ path: envPath });

// .envファイルを監視して自動リロード
const watcher = chokidar.watch(envPath, {
  ignoreInitial: true
});

watcher.on('change', () => {
  dotenv.config({ path: envPath, override: true });
  console.error('[env] .env file reloaded');
});

/**
 * Aivis Cloud APIとの通信を行うサービスクラス
 */
export class AivisSpeechService {
  private redisClient: RedisClientType;
  private redisWorkerClient: RedisClientType;
  private workerId: string;
  private workerHeartbeat?: NodeJS.Timeout;
  private workerActive: boolean;

  // 環境変数から動的に取得するプロパティ
  private get baseUrl(): string {
    return process.env.AIVIS_API_URL || 'https://api.aivis-project.com/v1';
  }

  private get apiKey(): string {
    return process.env.AIVIS_API_KEY || '';
  }

  private get defaultModelUuid(): string {
    return process.env.AIVIS_MODEL_UUID || 'a59cb814-0083-4369-8542-f51a29e72af7';
  }

  private get defaultOutputFormat(): string {
    return 'mp3'; // mp3固定
  }

  private get redisUrl(): string {
    return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  }

  private get queueKey(): string {
    return process.env.AIVIS_QUEUE_KEY || 'aivis-mcp:queue';
  }

  private get workerLockKey(): string {
    return process.env.AIVIS_WORKER_LOCK_KEY || 'aivis-mcp:worker-lock';
  }

  private get debugEnabled(): boolean {
    return process.env.AIVIS_DEBUG === '1';
  }

  /**
   * コンストラクタ
   */
  constructor() {
    this.workerId = uuidv4();
    this.workerActive = false;
    this.redisClient = createClient({ url: this.redisUrl });
    this.redisWorkerClient = createClient({ url: this.redisUrl });

    this.redisClient.on('error', (error) => {
      console.error('Redis error:', error);
    });
    this.redisWorkerClient.on('error', (error) => {
      console.error('Redis worker error:', error);
    });
  }



  /**
   * バックグラウンドで音声合成を実行する
   * @param params 音声合成パラメータ
   */
  async synthesizeInBackground(params: any): Promise<void> {
    try {
      await this.ensureRedisReady();
      if (this.debugEnabled) {
        console.error('[queue] enqueue', {
          instance: this.workerId,
          wait_ms: params.wait_ms
        });
      }
      await this.redisClient.rPush(this.queueKey, JSON.stringify(params));
    } catch (error) {
      console.error('Queue enqueue error:', error);
    }
  }

  private async ensureRedisReady(): Promise<void> {
    if (this.redisClient.isOpen && this.redisWorkerClient.isOpen) {
      return;
    }

    await this.ensureRedisRunning();
    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }
    if (!this.redisWorkerClient.isOpen) {
      await this.redisWorkerClient.connect();
    }
  }

  private async ensureRedisRunning(): Promise<void> {
    const probe = createClient({ url: this.redisUrl });
    try {
      await probe.connect();
      await probe.ping();
      await probe.disconnect();
      if (this.debugEnabled) {
        console.error('[redis] ready');
      }
      return;
    } catch (error) {
      await probe.disconnect().catch(() => undefined);
      if (this.debugEnabled) {
        console.error('[redis] not running, try start');
      }
      await this.tryStartRedis();
      for (let i = 0; i < 10; i += 1) {
        try {
          const retry = createClient({ url: this.redisUrl });
          await retry.connect();
          await retry.ping();
          await retry.disconnect();
          if (this.debugEnabled) {
            console.error('[redis] started');
          }
          return;
        } catch {
          await this.sleep(200);
        }
      }
      throw error;
    }
  }

  private async tryStartRedis(): Promise<void> {
    const lockPath = path.join(process.cwd(), 'temp', 'redis-start.lock');
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const lockFd = fs.openSync(lockPath, 'wx');
      fs.closeSync(lockFd);
    } catch (error) {
      if (this.debugEnabled) {
        console.error('[redis] start skipped (lock exists)');
      }
      return;
    }

    try {
      const child = spawn('redis-server', ['--save', '', '--appendonly', 'no'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      if (this.debugEnabled) {
        console.error('[redis] start attempted');
      }
    } catch (error) {
      console.error('Failed to start redis-server:', error);
    } finally {
      setTimeout(() => {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }, 3000);
    }
  }

  async runWorkerLoop(): Promise<void> {
    await this.ensureRedisReady();

    if (!(await this.tryAcquireWorkerLock())) {
      if (this.debugEnabled) {
        console.error('[worker] lock not acquired, exiting', { instance: this.workerId });
      }
      return;
    }

    if (this.debugEnabled) {
      console.error('[worker] lock acquired', { instance: this.workerId });
    }

    const heartbeatMs = 5000;
    this.workerHeartbeat = setInterval(() => {
      this.refreshWorkerLock().catch((error) => {
        console.error('Worker lock refresh error:', error);
      });
    }, heartbeatMs);

    await this.startWorker();
  }

  private async tryAcquireWorkerLock(): Promise<boolean> {
    const acquired = await this.redisClient.set(
      this.workerLockKey,
      this.workerId,
      { NX: true, PX: 20000 }
    );
    return Boolean(acquired);
  }

  private async refreshWorkerLock(): Promise<void> {
    if (!this.redisClient.isOpen) {
      return;
    }
    const updated = await this.redisClient.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end',
      {
        keys: [this.workerLockKey],
        arguments: [this.workerId, '20000']
      }
    );
    if (!updated) {
      if (this.debugEnabled) {
        console.error('[worker] lock lost', { instance: this.workerId });
      }
      this.stopWorker();
    }
  }

  private stopWorker(): void {
    if (this.workerHeartbeat) {
      clearInterval(this.workerHeartbeat);
      this.workerHeartbeat = undefined;
    }
    this.workerActive = false;
  }

  private async startWorker(): Promise<void> {
    if (this.workerActive) {
      return;
    }
    this.workerActive = true;

    while (this.workerActive) {
      try {
        const result = await this.redisWorkerClient.brPop(this.queueKey, 1);
        if (!result) {
          continue;
        }
        if (this.debugEnabled) {
          console.error('[queue] dequeue', { instance: this.workerId });
        }
        const payload = JSON.parse(result.element);
        if (this.debugEnabled) {
          console.error('[synthesize] start', { instance: this.workerId });
        }
        await this.synthesizeAndPlay(payload);
        if (this.debugEnabled) {
          console.error('[synthesize] done', { instance: this.workerId });
        }
      } catch (error) {
        console.error('Queue worker error:', error);
      }
    }

    this.stopWorker();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 音声合成とストリーミング再生を実行する
   * @param params 音声合成パラメータ
   * @returns void
   */
  private async synthesizeAndPlay(params: any): Promise<void> {
    try {
      if (!this.apiKey) {
        console.error('APIキーが設定されていません');
        return;
      }

      if (typeof params.wait_ms === 'number' && params.wait_ms > 0) {
        const waitMs = Math.min(params.wait_ms, 60000);
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }

      // リクエストパラメータを構築
      const requestParams = {
        model_uuid: params.model_uuid || this.defaultModelUuid,
        text: '<break time="500ms"/>' + params.text,
        output_format: this.defaultOutputFormat, // mp3固定
        speaker_uuid: params.speaker_uuid,
        style_id: params.style_id,
        style_name: params.style_name,
        speaking_rate: params.speaking_rate || params.speed_scale,
        emotional_intensity: params.emotional_intensity,
        tempo_dynamics: params.tempo_dynamics,
        pitch: params.pitch || params.pitch_scale,
        volume: params.volume || params.volume_scale,
        leading_silence_seconds: params.leading_silence_seconds || params.pre_phoneme_length,
        trailing_silence_seconds: params.trailing_silence_seconds || params.post_phoneme_length,
        line_break_silence_seconds: params.line_break_silence_seconds
      };

      // undefined値を削除
      Object.keys(requestParams).forEach(key => {
        if (requestParams[key as keyof typeof requestParams] === undefined) {
          delete requestParams[key as keyof typeof requestParams];
        }
      });

      // Aivis Cloud APIを呼び出し
      const response = await axios.post(
        `${this.baseUrl}/tts/synthesize`,
        requestParams,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: 60000
        }
      );

      // ストリーミング再生
      await this.streamPlay(response.data);
    } catch (error) {
      console.error('Error in synthesizeAndPlay:', error);
      this.logDetailedError(error);
    }
  }

  /**
   * ストリーミング再生を実行する
   * @param stream 音声データストリーム
   */
  private async streamPlay(stream: any): Promise<void> {
    const system = platform();

    // プレイヤーコマンドを選択
    let players: string[] = [];
    if (system === 'darwin') {
      // macOS
      players = ['ffplay', 'mpv', 'afplay'];
    } else if (system === 'linux') {
      players = ['ffplay', 'mpv', 'mplayer', 'play'];
    } else if (system === 'win32') {
      players = ['ffplay.exe', 'mpv.exe'];
    }

    // 利用可能なプレイヤーを探す
    let playerCmd: string | null = null;
    
    for (const player of players) {
      try {
        // プレイヤーの存在確認
        const checkCmd = system === 'win32' ? 'where' : 'which';
        const result = spawn(checkCmd, [player], { stdio: 'pipe' });
        await new Promise<void>((resolve) => {
          result.on('exit', (code) => {
            if (code === 0) {
              playerCmd = player;
            }
            resolve();
          });
        });
        if (playerCmd) break;
      } catch {
        continue;
      }
    }

    if (!playerCmd) {
      // プレイヤーが見つからない場合は一時ファイルに保存
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const audioFilePath = path.join(tempDir, `speech_${Date.now()}.mp3`);

      // ストリームから一時ファイルに書き込み
      const writeStream = fs.createWriteStream(audioFilePath);
      stream.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      // ファイルから再生（OS標準のプレイヤーを使用）
      if (system === 'darwin') {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('afplay', [audioFilePath], { stdio: 'ignore' });
          proc.on('error', reject);
          proc.on('close', () => resolve());
        });
      } else if (system === 'win32') {
        spawn('cmd', ['/c', 'start', '', audioFilePath], { stdio: 'ignore' });
      } else {
        console.error('No audio player found for playback');
      }

      // 一時ファイルの削除
      try {
        fs.unlinkSync(audioFilePath);
      } catch {}

      return;
    }

    // ストリーミング再生コマンドを構築
    let cmd: string[];
    if (playerCmd === 'ffplay' || playerCmd === 'ffplay.exe') {
      // ffplayでバランスモード（低遅延設定）
      cmd = [
        '-f', 'mp3',  // mp3形式を明示的に指定
        '-nodisp', '-autoexit', '-loglevel', 'quiet',
        '-volume', '100',  // 音量を明示的に設定
        '-i', '-'
      ];
    } else if (playerCmd === 'mpv' || playerCmd === 'mpv.exe') {
      // mpvでバランスモード
      cmd = [
        '--no-video', '--really-quiet',
        '--demuxer-lavf-o=fflags=+nobuffer',
        '--audio-buffer=1', '--cache=yes', '--cache-secs=1',
        '--demuxer-readahead-secs=1', '-'
      ];
    } else {
      // その他のプレイヤー
      cmd = ['-'];
    }

    // プレイヤープロセスを起動
    const playerProcess = spawn(playerCmd, cmd, {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    
    // ストリーミングデータを送信
    stream.pipe(playerProcess.stdin);

    // エラーハンドリング
    playerProcess.on('error', (error) => {
      console.error('Player process error:', error);
    });

    stream.on('error', (error: any) => {
      console.error('Stream error:', error);
      playerProcess.kill();
    });

    await new Promise<void>((resolve, reject) => {
      playerProcess.on('close', () => resolve());
      playerProcess.on('error', reject);
    });
  }

  /**
   * 詳細なエラー情報をログに出力する
   * @param error エラーオブジェクト
   */
  private logDetailedError(error: any): void {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        // サーバーからのレスポンスがある場合
        console.error('Response error data:', error.response.data);
        console.error('Response error status:', error.response.status);
      } else if (error.request) {
        // リクエストは送信されたがレスポンスがない場合
        console.error('No response received. Request:', error.request);
      } else {
        // リクエスト設定中にエラーが発生した場合
        console.error('Error message:', error.message);
      }
    } else {
      // Axiosエラーでない場合
      console.error('Non-Axios error:', error);
    }
  }

}

// シングルトンインスタンスをエクスポート
export default new AivisSpeechService();

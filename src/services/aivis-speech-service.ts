import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import http from 'http';
import { platform } from 'os';
import { PassThrough } from 'stream';
import { createClient, type RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig } from '../config.js';
import { tryStartRedis } from './redis-service.js';
import { isMuted } from './mute-service.js';
import { captureParaCodeVoiceTarget, isParaCodeVoiceTarget, type ParaCodeVoiceTarget } from './para-code-voice.js';

/**
 * Aivis Cloud APIとの通信を行うサービスクラス
 */
export class AivisSpeechService {
  private config: AppConfig;
  private redisClient: RedisClientType;
  private redisWorkerClient: RedisClientType;
  private workerId: string;
  private workerHeartbeat?: NodeJS.Timeout;
  private workerActive: boolean;

  constructor(config: AppConfig) {
    this.config = config;
    this.workerId = uuidv4();
    this.workerActive = false;
    this.redisClient = createClient({ url: config.redisUrl });
    this.redisWorkerClient = createClient({ url: config.redisUrl });

    this.redisClient.on('error', (error) => {
      console.error('Redis error:', error);
    });
    this.redisWorkerClient.on('error', (error) => {
      console.error('Redis worker error:', error);
    });
  }

  async synthesizeInBackground(params: any): Promise<void> {
    try {
      await this.ensureRedisReady();
      if (this.config.debug) {
        console.error('[queue] enqueue', {
          instance: this.workerId,
          wait_ms: params.wait_ms
        });
      }
      // 再生workerはRedis全体で1つだけなので、そのprocess.envは要求元MCPと一致しない。
      // 現在の要求元をenqueue時に確定し、短命なjob payloadとしてworkerへ引き渡す。
      const voiceTarget = await captureParaCodeVoiceTarget();
      const queuedParams = voiceTarget === undefined ? params : { ...params, _paraCodeVoiceTarget: voiceTarget };
      await this.redisClient.rPush(this.config.queueKey, JSON.stringify(queuedParams));
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
    const probe = createClient({ url: this.config.redisUrl });
    try {
      await probe.connect();
      await probe.ping();
      await probe.disconnect();
      if (this.config.debug) {
        console.error('[redis] ready');
      }
      return;
    } catch (error) {
      await probe.disconnect().catch(() => undefined);
      if (this.config.debug) {
        console.error('[redis] not running, try start');
      }
      await tryStartRedis();
      for (let i = 0; i < 10; i += 1) {
        try {
          const retry = createClient({ url: this.config.redisUrl });
          await retry.connect();
          await retry.ping();
          await retry.disconnect();
          if (this.config.debug) {
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

  async runWorkerLoop(): Promise<void> {
    await this.ensureRedisReady();

    if (!(await this.tryAcquireWorkerLock())) {
      if (this.config.debug) {
        console.error('[worker] lock not acquired, exiting', { instance: this.workerId });
      }
      await this.cleanup();
      process.exit(0);
      return;
    }

    if (this.config.debug) {
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
      this.config.workerLockKey,
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
        keys: [this.config.workerLockKey],
        arguments: [this.workerId, '20000']
      }
    );
    if (!updated) {
      if (this.config.debug) {
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

  private async acquirePlayLock(): Promise<void> {
    const playLockKey = 'aivis-mcp:play-lock';
    while (true) {
      const acquired = await this.redisClient.set(playLockKey, this.workerId, { NX: true, PX: 120000 });
      if (acquired) return;
      await this.sleep(100);
    }
  }

  private async releasePlayLock(): Promise<void> {
    const playLockKey = 'aivis-mcp:play-lock';
    try {
      await this.redisClient.eval(
        'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
        { keys: [playLockKey], arguments: [this.workerId] }
      );
    } catch {}
  }

  async waitForCompletion(requestId: string, timeoutSeconds: number): Promise<void> {
    await this.ensureRedisReady();
    const key = `aivis-mcp:done:${requestId}`;
    try {
      await this.redisClient.brPop(key, timeoutSeconds);
    } catch (error) {
      console.error('waitForCompletion error:', error);
    }
  }

  private async notifyCompletion(requestId: string): Promise<void> {
    try {
      const key = `aivis-mcp:done:${requestId}`;
      await this.redisClient.rPush(key, 'done');
      await this.redisClient.expire(key, 10);
    } catch (error) {
      console.error('notifyCompletion error:', error);
    }
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.redisClient.isOpen) await this.redisClient.disconnect();
    } catch {}
    try {
      if (this.redisWorkerClient.isOpen) await this.redisWorkerClient.disconnect();
    } catch {}
  }

  private async startWorker(): Promise<void> {
    if (this.workerActive) {
      return;
    }
    this.workerActive = true;

    while (this.workerActive) {
      try {
        const result = await this.redisWorkerClient.brPop(this.config.queueKey, 1);
        if (!result) {
          continue;
        }
        if (this.config.debug) {
          console.error('[queue] dequeue', { instance: this.workerId });
        }
        const payload = JSON.parse(result.element);
        // ミュート中は合成も再生もせず捨てる。ただし --wait で待っている呼び出し元は
        // ブロックしたままにしないよう完了通知だけは返す。
        if (await isMuted(this.redisWorkerClient)) {
          if (this.config.debug) {
            console.error('[mute] skipped synthesis', { instance: this.workerId });
          }
          if (payload._requestId) {
            await this.notifyCompletion(payload._requestId);
          }
          continue;
        }
        await this.acquirePlayLock();
        try {
          if (this.config.debug) {
            console.error('[synthesize] start', { instance: this.workerId });
          }
          await this.synthesizeAndPlay(payload);
          if (this.config.debug) {
            console.error('[synthesize] done', { instance: this.workerId });
          }
          if (payload._requestId) {
            await this.notifyCompletion(payload._requestId);
          }
        } finally {
          await this.releasePlayLock();
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

  async synthesizeAndPlay(params: any): Promise<void> {
    try {
      if (!this.config.apiKey) {
        console.error('APIキーが設定されていません');
        return;
      }

      if (typeof params.wait_ms === 'number' && params.wait_ms > 0) {
        const waitMs = Math.min(params.wait_ms, 60000);
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }

      const requestParams = {
        model_uuid: params.model_uuid || this.config.modelUuid,
        text: '<break time="500ms"/>' + params.text,
        output_format: 'mp3',
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

      Object.keys(requestParams).forEach(key => {
        if (requestParams[key as keyof typeof requestParams] === undefined) {
          delete requestParams[key as keyof typeof requestParams];
        }
      });

      const response = await axios.post(
        `${this.config.apiUrl}/tts/synthesize`,
        requestParams,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: 60000
        }
      );

      // モバイル転送の data listener が元streamを flowing modeへ移しても、PCプレイヤーの
      // 探索中に先頭チャンクを取りこぼさないよう、先に再生用PassThroughを接続する。
      // PassThroughが未消費の間はbackpressureでAxios streamを止め、streamPlay接続後に再開する。
      const playbackStream = new PassThrough();
      response.data.pipe(playbackStream);
      response.data.once('error', (error: unknown) => {
        console.error('Stream error:', error);
        playbackStream.end();
      });
      this.forwardStreamToParaCode(response.data, params._paraCodeVoiceTarget);
      await this.streamPlay(playbackStream);
    } catch (error) {
      console.error('Error in synthesizeAndPlay:', error);
      this.logDetailedError(error);
    }
  }

  /**
   * AivisレスポンスをPCプレイヤーと同時に観測し、Para Codeから起動された時だけ
   * 同じMP3をlocalhostへ送る。転送は完全な副経路で、失敗してもPC再生へ伝播しない。
   */
  private forwardStreamToParaCode(stream: NodeJS.ReadableStream, target: unknown): void {
    if (!isParaCodeVoiceTarget(target)) {
      return;
    }

    const maximumBytes = 8 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    let accepted = true;
    stream.on('data', (value: Buffer | string) => {
      if (!accepted) {
        return;
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        accepted = false;
        chunks.length = 0;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once('error', () => {
      accepted = false;
      chunks.length = 0;
    });
    stream.once('end', () => {
      if (!accepted || total === 0) {
        return;
      }
      const audio = Buffer.concat(chunks, total);
      void this.postAudioToParaCode(target, audio);
    });
  }

  private async postAudioToParaCode(target: ParaCodeVoiceTarget, audio: Buffer): Promise<void> {
    if (!(await this.isCurrentParaCodeInstance(target))) {
      return;
    }
    await new Promise<void>(resolve => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: target.port,
        path: '/paradis-mcp/mobile-voice',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.ticket}`,
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.byteLength,
        },
        timeout: 3000,
      }, response => { response.resume(); response.once('end', resolve); });
      request.once('timeout', () => { request.destroy(); resolve(); });
      request.once('error', () => resolve());
      request.end(audio);
    });
  }

  private isCurrentParaCodeInstance(target: ParaCodeVoiceTarget): Promise<boolean> {
    if (target.expiresAt < Date.now()) {
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const request = http.get({
        hostname: '127.0.0.1',
        port: target.port,
        path: '/paradis-mcp/health',
        timeout: 2000,
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
            resolve(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as { instanceId?: unknown };
            resolve(body.instanceId === target.instanceId);
          } catch {
            resolve(false);
          }
        });
      });
      request.once('timeout', () => { request.destroy(); resolve(false); });
      request.once('error', () => resolve(false));
    });
  }

  private async streamPlay(stream: any): Promise<void> {
    const system = platform();

    let players: string[] = [];
    if (system === 'darwin') {
      players = ['ffplay', 'mpv', 'afplay'];
    } else if (system === 'linux') {
      players = ['ffplay', 'mpv', 'mplayer', 'play'];
    } else if (system === 'win32') {
      players = ['ffplay.exe', 'mpv.exe'];
    }

    let playerCmd: string | null = null;

    for (const player of players) {
      try {
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
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const audioFilePath = path.join(tempDir, `speech_${Date.now()}.mp3`);

      const writeStream = fs.createWriteStream(audioFilePath);
      stream.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

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

      try {
        fs.unlinkSync(audioFilePath);
      } catch {}

      return;
    }

    let cmd: string[];
    if (playerCmd === 'ffplay' || playerCmd === 'ffplay.exe') {
      cmd = [
        '-f', 'mp3',
        '-nodisp', '-autoexit', '-loglevel', 'quiet',
        '-volume', '100',
        '-i', '-'
      ];
    } else if (playerCmd === 'mpv' || playerCmd === 'mpv.exe') {
      cmd = [
        '--no-video', '--really-quiet',
        '--demuxer-lavf-o=fflags=+nobuffer',
        '--audio-buffer=1', '--cache=yes', '--cache-secs=1',
        '--demuxer-readahead-secs=1', '-'
      ];
    } else {
      cmd = ['-'];
    }

    const playerProcess = spawn(playerCmd, cmd, {
      stdio: ['pipe', 'ignore', 'ignore']
    });

    stream.pipe(playerProcess.stdin);

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

  private logDetailedError(error: any): void {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('Response error data:', error.response.data);
        console.error('Response error status:', error.response.status);
      } else if (error.request) {
        console.error('No response received. Request:', error.request);
      } else {
        console.error('Error message:', error.message);
      }
    } else {
      console.error('Non-Axios error:', error);
    }
  }
}

import { createClient, type RedisClientType } from 'redis';
import { version, type AppConfig } from '../config.js';
import { ensureWorkerRunning, tryStartRedis } from './redis-service.js';
import { captureParaCodeVoiceTarget } from './para-code-voice.js';
import { enqueueSynthesis } from '../queue/enqueue.js';
import { PlaybackWorker } from '../worker/playback-worker.js';
import { createAudioBackend } from '../audio/player.js';
import { measureLoudness } from '../audio/loudness.js';
import { synthesizeStream } from '../audio/synthesize.js';

/**
 * MCP・CLI から発話を列に積む側と、worker を動かす入口。
 * 鳴らすのは Redis 全体で 1 つだけの worker（`PlaybackWorker`）。
 */
export class AivisSpeechService {
  private config: AppConfig;
  private loadConfig: () => AppConfig;
  private redisClient: RedisClientType;

  /**
   * @param loadConfig 発話ごとに最新の設定を返す関数。MCPツールで config.json が書き換わっても
   *   常駐workerを再起動せずにAPIキー等を反映するために使う。
   */
  constructor(config: AppConfig, loadConfig?: () => AppConfig) {
    this.config = config;
    this.loadConfig = loadConfig ?? (() => this.config);
    this.redisClient = createClient({ url: config.redisUrl });
    this.redisClient.on('error', (error) => {
      console.error('Redis error:', error instanceof Error ? error.message : error);
    });
  }

  async synthesizeInBackground(params: Record<string, unknown>): Promise<void> {
    try {
      await this.ensureRedisReady();
      // 動いている worker が古ければ新しい worker を起こす（起きた worker が lock を引き取る）
      await ensureWorkerRunning(this.redisClient, this.config);
      // 再生workerはRedis全体で1つだけなので、そのprocess.envは要求元MCPと一致しない。
      // 現在の要求元をenqueue時に確定し、短命なjob payloadとしてworkerへ引き渡す。
      const voiceTarget = await captureParaCodeVoiceTarget();
      const queuedParams = voiceTarget === undefined ? params : { ...params, _paraCodeVoiceTarget: voiceTarget };
      const job = await enqueueSynthesis(this.redisClient, queuedParams);
      if (this.config.debug) {
        console.error('[queue] enqueue', { id: job.id, wait_ms: params.wait_ms });
      }
    } catch (error) {
      console.error('Queue enqueue error:', error instanceof Error ? error.message : error);
    }
  }

  private async ensureRedisReady(): Promise<void> {
    if (this.redisClient.isOpen) {
      return;
    }
    await this.ensureRedisRunning();
    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }
  }

  private async ensureRedisRunning(): Promise<void> {
    const probe = createClient({ url: this.config.redisUrl });
    try {
      await probe.connect();
      await probe.ping();
      await probe.disconnect();
      return;
    } catch (error) {
      await probe.disconnect().catch(() => undefined);
      await tryStartRedis();
      for (let i = 0; i < 10; i += 1) {
        try {
          const retry = createClient({ url: this.config.redisUrl });
          await retry.connect();
          await retry.ping();
          await retry.disconnect();
          return;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      throw error;
    }
  }

  /** worker として列を読み続ける。lock が取れない・失ったら終わる。 */
  async runWorkerLoop(): Promise<void> {
    await this.ensureRedisRunning();
    const worker = new PlaybackWorker({
      redisUrl: this.config.redisUrl,
      version,
      loadConfig: this.loadConfig,
      backend: createAudioBackend(),
      synthesize: synthesizeStream,
      measure: audio => measureLoudness(audio),
      debug: this.config.debug,
    });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void worker.releaseLockNow().finally(() => process.exit(0));
      });
    }
    const result = await worker.run();
    if (this.config.debug) {
      console.error(`[worker] ${result}`, { instance: worker.id });
    }
    process.exit(0);
  }

  async waitForCompletion(requestId: string, timeoutSeconds: number): Promise<void> {
    await this.ensureRedisReady();
    const key = `aivis-mcp:done:${requestId}`;
    // 待つ接続を分けないと、同じ接続のほかの呼び出しが止まる
    const waiter = this.redisClient.duplicate();
    try {
      await waiter.connect();
      await waiter.brPop(key, timeoutSeconds);
    } catch (error) {
      console.error('waitForCompletion error:', error instanceof Error ? error.message : error);
    } finally {
      await waiter.disconnect().catch(() => undefined);
    }
  }
}

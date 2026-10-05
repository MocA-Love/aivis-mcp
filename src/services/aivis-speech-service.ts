import { createClient, type RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { version, type AppConfig } from '../config.js';
import { ensureWorkerRunning, tryStartRedis } from './redis-service.js';
import { hasParaCodeVoiceEnv, withParaCodeVoiceTarget, type ParaCodeVoiceTarget } from './para-code-voice.js';
import { RESPONDER_CLOSE_GRACE_MS, VoiceTicketResponder, type VoiceRequester } from './voice-ticket.js';
import { enqueueSynthesis } from '../queue/enqueue.js';
import { PlaybackWorker } from '../worker/playback-worker.js';
import { readWorkerGainSettings, type WorkerGainSettings } from '../queue/worker-gain-settings.js';
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
  /** worker から ticket を頼まれたら答える口（Para Code から起動されたときだけ） */
  private ticketResponder: VoiceTicketResponder | undefined;
  private ticketResponderFailed = false;

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
      // Para Code の ticket は、worker が鳴らし始めるときにこの MCP サーバーへ頼んで取る（Q208 A）。
      // 頼まれる口を開けなかったときだけ、従来どおり積む時に取って job payload に載せる
      // 控えとして積む時にも 1 枚取って載せる（MCP サーバーが先に終わっても鳴らせるように）
      const jobId = uuidv4();
      const route = await this.voiceRouteFor(jobId);
      const queuedParams = route !== undefined
        ? { ...params, _voiceRequester: route.requester, ...(route.fallback === undefined ? {} : { _paraCodeVoiceTarget: route.fallback }) }
        : (hasParaCodeVoiceEnv() ? await withParaCodeVoiceTarget(params) : params);
      const job = await enqueueSynthesis(this.redisClient, queuedParams, 'normal', jobId);
      if (this.config.debug) {
        console.error('[queue] enqueue', { id: job.id, wait_ms: params.wait_ms });
      }
    } catch (error) {
      console.error('Queue enqueue error:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * 動いている worker が覚え直しに使っている窓と最短秒数。Redis に届かない・worker がいないときは undefined
   * （Redis を起こしたり待ち続けたりしない。設定を見せるだけなので 1 秒で諦める）。
   */
  async workerGainSettings(timeoutMs = 1000): Promise<WorkerGainSettings | undefined> {
    const client = this.redisClient.isOpen
      ? undefined
      : createClient({ url: this.config.redisUrl, socket: { connectTimeout: 1000, reconnectStrategy: false } });
    client?.on('error', () => undefined);
    let timer: NodeJS.Timeout | undefined;
    const work = (async () => {
      if (client !== undefined) {
        await client.connect();
      }
      return readWorkerGainSettings((client ?? this.redisClient) as RedisClientType);
    })();
    // 打ち切った後に connect が成功しても、決着したら必ず閉じる（接続を残さない）
    const closed = work.catch(() => undefined).finally(async () => {
      if (client?.isOpen) {
        await client.disconnect().catch(() => undefined);
      }
    });
    try {
      return await Promise.race([
        work,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      void closed;
    }
  }

  /** MCP サーバーが終わるとき。答えている途中の ticket の依頼に最大 2 秒答えてから閉じる。 */
  async close(): Promise<void> {
    await this.ticketResponder?.stop(RESPONDER_CLOSE_GRACE_MS);
    this.ticketResponder = undefined;
  }

  /** Para Code から起動されていれば、ticket を頼まれる口を開けて、このジョブを覚える（控えの ticket も取る）。 */
  private async voiceRouteFor(jobId: string): Promise<{ requester: VoiceRequester; fallback: ParaCodeVoiceTarget | undefined } | undefined> {
    if (!hasParaCodeVoiceEnv()) {
      return undefined;
    }
    if (this.ticketResponder === undefined && !this.ticketResponderFailed) {
      const subscriber = this.redisClient.duplicate();
      subscriber.on('error', error => {
        console.error('Redis error:', error instanceof Error ? error.message : error);
      });
      const responder = new VoiceTicketResponder(subscriber as RedisClientType, this.redisClient, uuidv4());
      try {
        await responder.start();
        this.ticketResponder = responder;
      } catch (error) {
        console.error('ticket の受け口を開けませんでした:', error instanceof Error ? error.message : error);
        this.ticketResponderFailed = true;
        await responder.stop();
      }
    }
    const responder = this.ticketResponder;
    if (!responder?.isStarted) {
      return undefined;
    }
    const fallback = await responder.captureFallback();
    return { requester: responder.register(jobId, fallback), fallback };
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
        void worker.shutdown().finally(() => process.exit(0));
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

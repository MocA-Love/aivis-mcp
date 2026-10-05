import type { AppConfig } from '../../src/config.js';

/** MPEG-1 Layer III 128kbps 44.1kHz のフレームを n 個（1 フレーム約 26ms）。 */
export function mp3Frames(count: number, fill = 0): Buffer {
  const frame = Buffer.alloc(417, fill);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  return Buffer.concat(Array.from({ length: count }, () => frame));
}

/** 手元の設定ファイルを読まない、テスト用の設定。 */
export function testConfig(redisUrl: string): AppConfig {
  return {
    provider: 'aivis',
    apiKey: 'test-key',
    apiUrl: 'http://127.0.0.1:9',
    modelUuid: 'model-a',
    elevenLabsApiKey: '',
    elevenLabsApiUrl: 'http://127.0.0.1:9',
    elevenLabsModelId: 'eleven_v4_turbo',
    elevenLabsVolumeOffsetDb: 0,
    gainLearnWindow: 9,
    gainMinLearnSeconds: 2.5,
    volumeOffsetDb: 0,
    redisUrl,
    debug: false,
    queueKey: 'aivis-mcp:queue',
    workerLockKey: 'aivis-mcp:worker-lock',
  };
}

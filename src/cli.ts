#!/usr/bin/env node

import { parseCliArgs, resolveConfig, buildSynthesisParams, version } from './config.js';
import { connectRedis, ensureWorkerRunning } from './services/redis-service.js';
import { captureParaCodeVoiceTarget } from './services/para-code-voice.js';
import { runHealth, runReboot, runMute, runUnmute, runMuteStatus } from './commands.js';
import { runDoctor } from './doctor.js';
import { runInit } from './settings.js';

export async function runCli(config: ReturnType<typeof resolveConfig>, text: string, waitMs?: number): Promise<void> {
  if (!text) {
    console.error('Error: テキストを指定してください');
    process.exit(1);
  }

  const params = buildSynthesisParams(config, text, waitMs);
  const client = await connectRedis(config.redisUrl);

  await ensureWorkerRunning(client, config);
  // 再生workerはRedis全体で1つだけなので、そのprocess.envは要求元と一致しない。
  // MCP経由の発話と同じく、要求元のPara Codeをここで確定してjob payloadへ載せる
  // （これが無いと `aivis` コマンド経由の発話だけモバイルへ届かない）。
  const voiceTarget = await captureParaCodeVoiceTarget();
  const queuedParams = voiceTarget === undefined ? params : { ...params, _paraCodeVoiceTarget: voiceTarget };
  await client.rPush(config.queueKey, JSON.stringify(queuedParams));
  await client.disconnect();
}

function printHelp(): void {
  console.log(`aivis-mcp v${version}`);
  console.log('');
  console.log('Usage:');
  console.log('  aivis <text> [options]            テキストを音声合成');
  console.log('  aivis --health                    ヘルスチェック');
  console.log('  aivis --reboot                    全プロセス再起動');
  console.log('  aivis --mute                      ミュート（自分で解除するまで）');
  console.log('  aivis --mute --mute-for 30m       30分間ミュート');
  console.log('  aivis --unmute                    ミュート解除');
  console.log('  aivis --mute-status               ミュート状態を確認');
  console.log('  aivis --init                      初期設定（APIキー等を保存）');
  console.log('  aivis --doctor                    依存ツール診断');
  console.log('  aivis --version                   バージョン表示');
  console.log('');
  console.log('Options:');
  console.log('  -m, --model <uuid>                モデルUUID');
  console.log('  -r, --rate <value>                話速');
  console.log('  -p, --pitch <value>               ピッチ');
  console.log('  --volume <value>                  音量');
  console.log('  -w, --wait <ms>                   待機時間（ミリ秒）');
  console.log('  -k, --api-key <key>               APIキー');
  console.log('  --api-url <url>                   APIエンドポイント');
  console.log('  --redis-url <url>                 Redis接続先');
  console.log('  -d, --debug                       デバッグモード');
}

/**
 * CLIバイナリ（aivis コマンド）のエントリーポイント
 */
async function main() {
  const { values, positionals } = parseCliArgs();
  const config = resolveConfig(values);

  if (values.version) {
    console.log(`aivis-mcp v${version}`);
    process.exit(0);
  }

  if (values.init) {
    await runInit();
    process.exit(0);
  }

  if (values.help || (positionals.length === 0 && !values.health && !values.reboot && !values.doctor
    && !values.mute && !values.unmute && !values['mute-status'])) {
    printHelp();
    process.exit(0);
  }

  if (values.doctor) {
    await runDoctor(config);
    process.exit(0);
  }

  if (values.health) {
    await runHealth(config);
    process.exit(0);
  }

  if (values.reboot) {
    await runReboot(config);
    process.exit(0);
  }

  if (values.mute) {
    await runMute(config, typeof values['mute-for'] === 'string' ? values['mute-for'] : undefined);
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }

  if (values.unmute) {
    await runUnmute(config);
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }

  if (values['mute-status']) {
    await runMuteStatus(config);
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }

  const text = positionals.join(' ');
  const waitMs = typeof values.wait === 'string' ? parseInt(values.wait, 10) : undefined;
  await runCli(config, text, waitMs);
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node

import { parseCliArgs, resolveConfig, buildSynthesisParams, version } from './config.js';
import { MCPService } from './services/mcp-service.js';
import { AivisSpeechService } from './services/aivis-speech-service.js';
import { connectRedis, ensureWorkerRunning } from './services/redis-service.js';
import { runHealth, runReboot } from './commands.js';
import { runDoctor, checkDependencies } from './doctor.js';
import { runInit } from './settings.js';

function printHelp(): void {
  console.log(`aivis-mcp v${version}`);
  console.log('');
  console.log('Usage:');
  console.log('  aivis-mcp                         MCPサーバーとして起動（デフォルト）');
  console.log('  aivis-mcp <text> [options]         テキストを音声合成');
  console.log('  aivis-mcp --health                 ヘルスチェック');
  console.log('  aivis-mcp --reboot                 全プロセス再起動');
  console.log('  aivis-mcp --init                   初期設定（APIキー等を保存）');
  console.log('  aivis-mcp --doctor                 依存ツール診断');
  console.log('  aivis-mcp --version                バージョン表示');
  console.log('');
  console.log('Options:');
  console.log('  -m, --model <uuid>                 モデルUUID');
  console.log('  -r, --rate <value>                 話速');
  console.log('  -p, --pitch <value>                ピッチ');
  console.log('  --volume <value>                   音量');
  console.log('  -w, --wait <ms>                    待機時間（ミリ秒）');
  console.log('  -k, --api-key <key>                APIキー');
  console.log('  --api-url <url>                    APIエンドポイント');
  console.log('  --redis-url <url>                  Redis接続先');
  console.log('  --style-name <name>                スタイル名');
  console.log('  --style-id <id>                    スタイルID');
  console.log('  --emotional-intensity <value>      感情の強さ');
  console.log('  --tempo-dynamics <value>           テンポダイナミクス');
  console.log('  --leading-silence <sec>            先頭無音（秒）');
  console.log('  --trailing-silence <sec>           末尾無音（秒）');
  console.log('  --line-break-silence <sec>         改行無音（秒）');
  console.log('  -d, --debug                        デバッグモード');
  console.log('');
  console.log('MCP設定例 (claude_desktop_config.json):');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "aivis": {');
  console.log('        "command": "npx",');
  console.log('        "args": ["-y", "aivis-mcp"],');
  console.log('        "env": { "AIVIS_API_KEY": "your_key" }');
  console.log('      }');
  console.log('    }');
  console.log('  }');
}

async function main() {
  const { values, positionals } = parseCliArgs();
  const config = resolveConfig(values);

  // --version
  if (values.version) {
    console.log(`aivis-mcp v${version}`);
    process.exit(0);
  }

  // --help
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  // --init
  if (values.init) {
    await runInit();
    process.exit(0);
  }

  // --doctor
  if (values.doctor) {
    await runDoctor(config);
    process.exit(0);
  }

  // --health
  if (values.health) {
    await runHealth(config);
    process.exit(0);
  }

  // --reboot
  if (values.reboot) {
    await runReboot(config);
    process.exit(0);
  }

  // --worker（内部用）
  if (values.worker || process.env.AIVIS_WORKER_MODE === '1') {
    const speechService = new AivisSpeechService(config);
    await speechService.runWorkerLoop();
    return;
  }

  // positional引数がある場合はCLIモード
  if (positionals.length > 0) {
    const text = positionals.join(' ');
    const waitMs = typeof values.wait === 'string' ? parseInt(values.wait, 10) : undefined;
    const params = buildSynthesisParams(config, text, waitMs);
    const client = await connectRedis(config.redisUrl);
    await ensureWorkerRunning(client, config);
    await client.rPush(config.queueKey, JSON.stringify(params));
    await client.disconnect();
    process.exit(0);
  }

  // デフォルト: MCPサーバーとして起動
  try {
    // 依存チェック（stderrに警告）
    const missingDeps = checkDependencies();
    if (missingDeps.length > 0) {
      console.error(`[aivis-mcp] Warning: ${missingDeps.join(', ')} が見つかりません`);
      console.error('[aivis-mcp] npx aivis-mcp --doctor を実行して環境を確認してください');
    }

    const mcpService = new MCPService(config);
    await mcpService.start();

    process.on('SIGINT', () => {
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

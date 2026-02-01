#!/usr/bin/env node

import mcpService from './services/mcp-service';

/**
 * アプリケーションのメイン関数
 */
async function main() {
  try {
    if (process.env.AIVIS_WORKER_MODE === '1') {
      await mcpService.runWorker();
      return;
    }

    // MCPサーバーを起動
    await mcpService.start();

    // 終了時の処理
    process.on('SIGINT', () => {
      console.log('Shutting down MCP server...');
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

// アプリケーションを起動
main();

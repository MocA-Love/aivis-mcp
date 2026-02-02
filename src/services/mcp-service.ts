import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import chokidar from 'chokidar';
import aivisSpeechService from './aivis-speech-service';

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

// MCPモデル設定
const MCP_MODEL_ID = 'aivis-speech';
const MCP_MODEL_NAME = 'Aivis Speech';

/**
 * MCPサービスクラス
 */
export class MCPService {
  private mcpServer: McpServer;
  private workerProcessStarted: boolean;

  /**
   * コンストラクタ
   */
  constructor() {
    // MCPサーバーの初期化
    this.mcpServer = new McpServer({
      name: MCP_MODEL_NAME,
      version: '1.0.0',
      description: 'Aivis 音声合成/再生ツール',
      capabilities: {
        tools: {}
      }
    });

    this.workerProcessStarted = false;

    // 音声合成ツールの登録
    this.mcpServer.tool(
      MCP_MODEL_ID,
      {
        text: z.string().describe('音声合成するテキスト'),
        model_uuid: z.string().optional().describe('音声合成モデルのUUID（未指定時は環境変数）'),
        wait_ms: z.number().int().min(0).max(60000).optional().describe('API呼び出し前の待機時間（ミリ秒、最大60000）')
      },
      async (params) => {
        try {
          // 環境変数からデフォルト値を取得
          const getEnvNumber = (key: string, defaultValue?: number) => {
            const value = process.env[key];
            return value ? parseFloat(value) : defaultValue;
          };

          // Aivis Cloud APIリクエストの作成（環境変数から設定を取得）
          const synthesisRequest = {
            text: params.text,
            wait_ms: params.wait_ms,
            model_uuid: params.model_uuid ?? process.env.AIVIS_MODEL_UUID,
            style_id: getEnvNumber('AIVIS_STYLE_ID'),
            style_name: process.env.AIVIS_STYLE_NAME,
            speaking_rate: getEnvNumber('AIVIS_SPEAKING_RATE'),
            emotional_intensity: getEnvNumber('AIVIS_EMOTIONAL_INTENSITY'),
            tempo_dynamics: getEnvNumber('AIVIS_TEMPO_DYNAMICS'),
            pitch: getEnvNumber('AIVIS_PITCH'),
            volume: getEnvNumber('AIVIS_VOLUME'),
            leading_silence_seconds: getEnvNumber('AIVIS_LEADING_SILENCE_SECONDS'),
            trailing_silence_seconds: getEnvNumber('AIVIS_TRAILING_SILENCE_SECONDS'),
            line_break_silence_seconds: getEnvNumber('AIVIS_LINE_BREAK_SILENCE_SECONDS')
          };

          // バックグラウンドで音声合成を実行（awaitしない）
          aivisSpeechService.synthesizeInBackground(synthesisRequest)
            .catch((error: unknown) => {
              // バックグラウンドエラーは標準エラー出力にログを出すのみ
              console.error('Background synthesis error:', error);
            });

          // 即座にOKレスポンスを返す
          return {
            content: [
              {
                type: "text",
                text: "OK"
              }
            ]
          };
        } catch (error) {
          console.error('Request handling error:', error);
          const errorMessage = error instanceof Error ? error.message : '音声合成リクエストの処理中にエラーが発生しました';
          return {
            content: [{ type: "text", text: `音声合成に失敗しました: ${errorMessage}` }],
            isError: true
          };
        }
      }
    );
  }

  /**
   * MCPサーバーを起動する
   */
  async start(): Promise<void> {
    try {
      this.startWorkerProcess();
      // 標準入出力トランスポートを作成して接続
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);
    } catch (error) {
      console.error('Error starting MCP server:', error);
      throw error;
    }
  }

  async runWorker(): Promise<void> {
    await aivisSpeechService.runWorkerLoop();
  }

  private startWorkerProcess(): void {
    if (this.workerProcessStarted) {
      return;
    }
    this.workerProcessStarted = true;

    const env = {
      ...process.env,
      AIVIS_WORKER_MODE: '1'
    };

    const child = require('child_process').spawn(
      process.execPath,
      [process.argv[1]],
      { env, stdio: 'ignore', detached: true }
    );
    child.unref();
  }
}

// シングルトンインスタンスをエクスポート
export default new MCPService();

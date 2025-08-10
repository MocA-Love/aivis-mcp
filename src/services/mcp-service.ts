import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import aivisSpeechService from './aivis-speech-service';

// .envファイルを絶対パスで読み込む
const envPath = path.join(__dirname, '../../.env');
dotenv.config({ path: envPath });

// MCPモデル設定
const MCP_MODEL_ID = 'aivis-speech';
const MCP_MODEL_NAME = 'Aivis Speech';

/**
 * MCPサービスクラス
 */
export class MCPService {
  private mcpServer: McpServer;

  /**
   * コンストラクタ
   */
  constructor() {
    // MCPサーバーの初期化
    this.mcpServer = new McpServer({
      name: MCP_MODEL_NAME,
      version: '1.0.0',
      description: 'Aivis Cloud音声合成のMCPサーバー',
      capabilities: {
        tools: true
      }
    });

    // 音声合成ツールの登録
    this.mcpServer.tool(
      MCP_MODEL_ID,
      {
        text: z.string().describe('音声合成するテキスト'),
        model_uuid: z.string().optional().describe('モデルUUID'),
        speaker_uuid: z.string().optional().describe('話者UUID'),
        style_id: z.number().optional().describe('スタイルID (0-31)'),
        style_name: z.string().optional().describe('スタイル名'),
        speaking_rate: z.number().min(0.5).max(2.0).optional().describe('話速 (0.5-2.0)'),
        emotional_intensity: z.number().min(0.0).max(2.0).optional().describe('感情表現の強さ (0.0-2.0)'),
        tempo_dynamics: z.number().min(0.0).max(2.0).optional().describe('テンポの緩急 (0.0-2.0)'),
        pitch: z.number().min(-1.0).max(1.0).optional().describe('ピッチ (-1.0-1.0)'),
        volume: z.number().min(0.0).max(2.0).optional().describe('音量 (0.0-2.0)'),
        leading_silence_seconds: z.number().min(0.0).optional().describe('音声先頭の無音時間 (秒)'),
        trailing_silence_seconds: z.number().min(0.0).optional().describe('音声末尾の無音時間 (秒)'),
        line_break_silence_seconds: z.number().min(0.0).optional().describe('改行時の無音時間 (秒)')
      },
      async (params) => {
        try {
          // Aivis Cloud APIリクエストの作成
          const synthesisRequest = {
            text: params.text,
            model_uuid: params.model_uuid,
            speaker_uuid: params.speaker_uuid,
            style_id: params.style_id,
            style_name: params.style_name,
            speaking_rate: params.speaking_rate,
            emotional_intensity: params.emotional_intensity,
            tempo_dynamics: params.tempo_dynamics,
            pitch: params.pitch,
            volume: params.volume,
            leading_silence_seconds: params.leading_silence_seconds,
            trailing_silence_seconds: params.trailing_silence_seconds,
            line_break_silence_seconds: params.line_break_silence_seconds
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
    console.log('Starting MCP Server with stdio transport...');

    try {
      // 標準入出力トランスポートを作成して接続
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);

      console.log('MCP Server started successfully');
      console.log(`Tool registered: ${MCP_MODEL_ID}`);
      console.log('Waiting for requests...');
    } catch (error) {
      console.error('Error starting MCP server:', error);
      throw error;
    }
  }
}

// シングルトンインスタンスをエクスポート
export default new MCPService();

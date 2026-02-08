import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import type { AppConfig } from '../config.js';
import { AivisSpeechService } from './aivis-speech-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_MODEL_ID = 'aivis-speech';
const MCP_MODEL_NAME = 'Aivis Speech';

export class MCPService {
  private mcpServer: McpServer;
  private speechService: AivisSpeechService;
  private config: AppConfig;
  private workerProcessStarted: boolean;

  constructor(config: AppConfig) {
    this.config = config;
    this.speechService = new AivisSpeechService(config);

    this.mcpServer = new McpServer({
      name: MCP_MODEL_NAME,
      version: '1.0.0',
      description: 'Aivis 音声合成/再生ツール',
      capabilities: {
        tools: {}
      }
    });

    this.workerProcessStarted = false;

    this.mcpServer.tool(
      MCP_MODEL_ID,
      {
        text: z.string().describe('音声合成するテキスト'),
        model_uuid: z.string().optional().describe('音声合成モデルのUUID（未指定時はデフォルト）'),
        wait_ms: z.number().int().min(0).max(60000).optional().describe('API呼び出し前の待機時間（ミリ秒、最大60000）')
      },
      async (params) => {
        try {
          const synthesisRequest = {
            text: params.text,
            wait_ms: params.wait_ms,
            model_uuid: params.model_uuid ?? this.config.modelUuid,
            style_id: this.config.styleId,
            style_name: this.config.styleName,
            speaking_rate: this.config.speakingRate,
            emotional_intensity: this.config.emotionalIntensity,
            tempo_dynamics: this.config.tempoDynamics,
            pitch: this.config.pitch,
            volume: this.config.volume,
            leading_silence_seconds: this.config.leadingSilenceSeconds,
            trailing_silence_seconds: this.config.trailingSilenceSeconds,
            line_break_silence_seconds: this.config.lineBreakSilenceSeconds
          };

          this.speechService.synthesizeInBackground(synthesisRequest)
            .catch((error: unknown) => {
              console.error('Background synthesis error:', error);
            });

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

  async start(): Promise<void> {
    try {
      this.startWorkerProcess();
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);
    } catch (error) {
      console.error('Error starting MCP server:', error);
      throw error;
    }
  }

  async runWorker(): Promise<void> {
    await this.speechService.runWorkerLoop();
  }

  private startWorkerProcess(): void {
    if (this.workerProcessStarted) {
      return;
    }
    this.workerProcessStarted = true;

    const indexPath = path.join(__dirname, '../index.js');

    const child = spawn(
      process.execPath,
      [indexPath, '--worker'],
      {
        env: { ...process.env, AIVIS_WORKER_MODE: '1' },
        stdio: 'ignore',
        detached: true
      }
    );
    child.unref();
  }
}

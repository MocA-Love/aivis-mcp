import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { buildSynthesisParams, type AppConfig } from '../config.js';
import { getConfigPath, updateSettings, TTS_PROVIDERS, type TtsProvider } from '../settings.js';
import { AivisSpeechService } from './aivis-speech-service.js';
import { spawnWorker } from './redis-service.js';
import {
  describeElevenLabsError,
  elevenLabsErrorCode,
  getElevenLabsVoice,
  listElevenLabsModels,
  listElevenLabsVoices,
} from './elevenlabs-client.js';

const MCP_MODEL_ID = 'aivis-speech';
const MCP_MODEL_NAME = 'Aivis Speech';

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function maskSecret(secret: string): string | null {
  if (!secret) return null;
  return secret.length <= 8 ? '****' : `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

async function searchAivisModels(config: AppConfig, keyword: string | undefined, limit: number) {
  const response = await axios.get(`${config.apiUrl}/aivm-models/search`, {
    params: { keyword: keyword || undefined, limit },
    timeout: 15000,
  });
  const models: any[] = response.data?.aivm_models ?? [];
  return models.map((model) => ({
    model_uuid: model.aivm_model_uuid,
    name: model.name,
    description: typeof model.description === 'string' ? model.description.slice(0, 120) : undefined,
    voice_timbre: model.voice_timbre,
    speakers: (model.speakers ?? []).map((speaker: any) => ({
      name: speaker.name,
      styles: (speaker.styles ?? []).map((style: any) => style.name),
    })),
  }));
}

export class MCPService {
  private mcpServer: McpServer;
  private speechService: AivisSpeechService;
  private config: AppConfig;
  private loadConfig: () => AppConfig;
  private workerProcessStarted: boolean;

  /**
   * @param loadConfig 最新の設定を返す関数。tts-configure で保存した値を再起動なしで使うため、ツール呼び出しごとに呼ぶ。
   */
  constructor(config: AppConfig, loadConfig?: () => AppConfig) {
    this.config = config;
    this.loadConfig = loadConfig ?? (() => this.config);
    this.speechService = new AivisSpeechService(config);

    this.mcpServer = new McpServer({
      name: MCP_MODEL_NAME,
      version: '1.0.0',
      description: 'Aivis / ElevenLabs 音声合成/再生ツール',
      capabilities: {
        tools: {}
      }
    });

    this.workerProcessStarted = false;

    this.mcpServer.tool(
      MCP_MODEL_ID,
      [
        '音声を合成して再生する。',
        'provider が elevenlabs のときは SSML タグを使わないこと（自動で取り除かれる）。',
        '現在の設定は tts-get-settings で確認できる。'
      ].join(''),
      {
        text: z.string().describe('音声合成するテキスト'),
        model_uuid: z.string().optional().describe('Aivis の音声合成モデルUUID（未指定時は設定値）'),
        provider: z.enum(TTS_PROVIDERS as [TtsProvider, ...TtsProvider[]]).optional().describe('今回だけ使う音声合成サービス（未指定時は設定値）'),
        voice_id: z.string().optional().describe('ElevenLabs の voice_id（未指定時は設定値）'),
        model_id: z.string().optional().describe('ElevenLabs の model_id（未指定時は設定値）'),
        wait_ms: z.number().int().min(0).max(60000).optional().describe('API呼び出し前の待機時間（ミリ秒、最大60000）'),
        sync: z.boolean().optional().describe('trueの場合、音声再生完了まで待機してからレスポンスを返す（同期モード）')
      },
      async (params) => {
        try {
          const config = this.loadConfig();
          const synthesisRequest: Record<string, unknown> = buildSynthesisParams(config, params.text, params.wait_ms);
          const provider = params.provider ?? config.provider;
          synthesisRequest.provider = provider;
          if (params.model_uuid) synthesisRequest.model_uuid = params.model_uuid;
          if (params.voice_id) synthesisRequest.voice_id = params.voice_id;
          if (params.model_id) synthesisRequest.model_id = params.model_id;

          const setupError = this.checkProviderReady(config, provider, synthesisRequest.voice_id);
          if (setupError) {
            return errorResult(setupError);
          }

          const isSync = params.sync === true;
          let requestId: string | undefined;

          if (isSync) {
            requestId = uuidv4();
            synthesisRequest._requestId = requestId;
          }

          await this.speechService.synthesizeInBackground(synthesisRequest);

          if (isSync && requestId) {
            await this.speechService.waitForCompletion(requestId, 120);
          }

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
          return errorResult(`音声合成に失敗しました: ${errorMessage}`);
        }
      }
    );

    this.mcpServer.tool(
      'tts-get-settings',
      '現在の音声合成設定（使用中のサービス、声、モデル）を返す。APIキーは伏せ字で返す。',
      {},
      async () => jsonResult(this.describeSettings(this.loadConfig()))
    );

    this.mcpServer.tool(
      'tts-configure',
      [
        '音声合成の設定を変更して保存する。指定した項目だけを更新する。',
        'ユーザーが「ElevenLabs を使いたい」「声を変えたい」などと言ったときに使う。',
        'ElevenLabs のAPIキーや voice_id は保存前に疎通確認し、無効なら保存しない。',
        '声の候補は tts-list-voices、ElevenLabs のモデル候補は elevenlabs-list-models で調べられる。'
      ].join(''),
      {
        provider: z.enum(TTS_PROVIDERS as [TtsProvider, ...TtsProvider[]]).optional().describe('使用する音声合成サービス'),
        aivis_api_key: z.string().min(1).optional().describe('Aivis Cloud API のAPIキー'),
        aivis_model_uuid: z.string().min(1).optional().describe('Aivis の音声合成モデルUUID'),
        elevenlabs_api_key: z.string().min(1).optional().describe('ElevenLabs のAPIキー'),
        elevenlabs_voice_id: z.string().min(1).optional().describe('ElevenLabs の voice_id'),
        elevenlabs_model_id: z.string().min(1).optional().describe('ElevenLabs の model_id（例: eleven_v4_turbo）'),
        volume_offset_db: z.number().min(-30).max(8).optional().describe('すべての声に足す音量の上乗せ（dB、デフォルト0）。声は自動で同じ大きさに揃えるので、全体がうるさい・小さいと言われたときだけ使う'),
        elevenlabs_volume_db: z.number().min(-30).max(8).optional().describe('ElevenLabs の声だけに足す音量の上乗せ（dB、デフォルト0）。2.4 までの -13 基準の値は自動で読み替え済み')
      },
      async (params) => {
        try {
          return await this.configure(params);
        } catch (error) {
          console.error('Configure error:', error);
          return errorResult(`設定の保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    this.mcpServer.tool(
      'tts-list-voices',
      '声の候補を検索する。ElevenLabs はアカウントのボイスライブラリ、Aivis は公開されている音声合成モデルが対象。',
      {
        provider: z.enum(TTS_PROVIDERS as [TtsProvider, ...TtsProvider[]]).optional().describe('検索するサービス（未指定時は現在の設定）'),
        search: z.string().optional().describe('名前・説明などで絞り込むキーワード'),
        limit: z.number().int().min(1).max(100).optional().describe('最大件数（デフォルト20）')
      },
      async (params) => {
        const config = this.loadConfig();
        const provider = params.provider ?? config.provider;
        try {
          if (provider === 'elevenlabs') {
            if (!config.elevenLabsApiKey) {
              return errorResult('ElevenLabs のAPIキーが未設定です。先に tts-configure で elevenlabs_api_key を設定してください。');
            }
            return jsonResult(await listElevenLabsVoices(config, { search: params.search, limit: params.limit }));
          }
          return jsonResult(await searchAivisModels(config, params.search, params.limit ?? 20));
        } catch (error) {
          if (elevenLabsErrorCode(error) === 'missing_permissions') {
            return errorResult(`声の検索に失敗しました: ${describeElevenLabsError(error)}。APIキーに Voices の読み取り権限を付けるか、ElevenLabs の画面で voice_id を調べて tts-configure に直接指定してください。`);
          }
          return errorResult(`声の検索に失敗しました: ${describeElevenLabsError(error)}`);
        }
      }
    );

    this.mcpServer.tool(
      'elevenlabs-list-models',
      'ElevenLabs の音声合成モデル一覧を返す。',
      {
        japanese_only: z.boolean().optional().describe('日本語対応モデルだけに絞る（デフォルトtrue）')
      },
      async (params) => {
        const config = this.loadConfig();
        if (!config.elevenLabsApiKey) {
          return errorResult('ElevenLabs のAPIキーが未設定です。先に tts-configure で elevenlabs_api_key を設定してください。');
        }
        try {
          const models = await listElevenLabsModels(config);
          return jsonResult(params.japanese_only === false ? models : models.filter((model) => model.supports_japanese));
        } catch (error) {
          return errorResult(`モデル一覧の取得に失敗しました: ${describeElevenLabsError(error)}`);
        }
      }
    );
  }

  private checkProviderReady(config: AppConfig, provider: TtsProvider, voiceId: unknown): string | undefined {
    if (provider === 'elevenlabs') {
      if (!config.elevenLabsApiKey) {
        return 'ElevenLabs のAPIキーが未設定です。tts-configure で elevenlabs_api_key を設定してください。';
      }
      if (typeof voiceId !== 'string' || voiceId === '') {
        return 'ElevenLabs の voice_id が未設定です。tts-list-voices で候補を探し、tts-configure で elevenlabs_voice_id を設定してください。';
      }
      return undefined;
    }
    if (!config.apiKey) {
      return 'Aivis のAPIキーが未設定です。tts-configure で aivis_api_key を設定してください。';
    }
    return undefined;
  }

  private describeSettings(config: AppConfig): Record<string, unknown> {
    return {
      provider: config.provider,
      aivis: {
        api_key: maskSecret(config.apiKey),
        model_uuid: config.modelUuid,
      },
      elevenlabs: {
        api_key: maskSecret(config.elevenLabsApiKey),
        voice_id: config.elevenLabsVoiceId ?? null,
        model_id: config.elevenLabsModelId,
        volume_offset_db: config.elevenLabsVolumeOffsetDb,
      },
      volume_offset_db: config.volumeOffsetDb,
      config_path: getConfigPath(),
    };
  }

  private async configure(params: {
    provider?: TtsProvider;
    aivis_api_key?: string;
    aivis_model_uuid?: string;
    elevenlabs_api_key?: string;
    elevenlabs_voice_id?: string;
    elevenlabs_model_id?: string;
    elevenlabs_volume_db?: number;
    volume_offset_db?: number;
  }) {
    const current = this.loadConfig();
    const candidate: AppConfig = {
      ...current,
      provider: params.provider ?? current.provider,
      apiKey: params.aivis_api_key ?? current.apiKey,
      modelUuid: params.aivis_model_uuid ?? current.modelUuid,
      elevenLabsApiKey: params.elevenlabs_api_key ?? current.elevenLabsApiKey,
      elevenLabsVoiceId: params.elevenlabs_voice_id ?? current.elevenLabsVoiceId,
      elevenLabsModelId: params.elevenlabs_model_id ?? current.elevenLabsModelId,
      elevenLabsVolumeOffsetDb: params.elevenlabs_volume_db ?? current.elevenLabsVolumeOffsetDb,
      volumeOffsetDb: params.volume_offset_db ?? current.volumeOffsetDb,
    };
    const warnings: string[] = [];

    const touchesElevenLabs = candidate.provider === 'elevenlabs'
      || params.elevenlabs_api_key !== undefined
      || params.elevenlabs_voice_id !== undefined
      || params.elevenlabs_model_id !== undefined;

    if (touchesElevenLabs) {
      if (!candidate.elevenLabsApiKey) {
        return errorResult('ElevenLabs のAPIキーが未設定です。elevenlabs_api_key も指定してください。');
      }
      // APIキーの有効性は /v1/models で確かめる（権限設定に関係なく読める）。
      // TTSだけを許可した制限付きキーもあるので、権限不足は保存を止めず警告にとどめる。
      try {
        const models = await listElevenLabsModels(candidate);
        if (params.elevenlabs_model_id !== undefined && !models.some((model) => model.model_id === params.elevenlabs_model_id)) {
          return errorResult(`保存しませんでした。model_id "${params.elevenlabs_model_id}" は音声合成に使えるモデル一覧にありません。elevenlabs-list-models で確認してください。`);
        }
      } catch (error) {
        if (elevenLabsErrorCode(error) === 'invalid_api_key') {
          return errorResult(`保存しませんでした。${describeElevenLabsError(error)}`);
        }
        warnings.push(`APIキーと model_id の確認ができませんでした: ${describeElevenLabsError(error)}`);
      }

      if (candidate.elevenLabsVoiceId) {
        try {
          await getElevenLabsVoice(candidate, candidate.elevenLabsVoiceId);
        } catch (error) {
          const code = elevenLabsErrorCode(error);
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          if (code === 'invalid_api_key') {
            return errorResult(`保存しませんでした。${describeElevenLabsError(error)}`);
          }
          if (code !== 'missing_permissions' && (status === 400 || status === 404)) {
            return errorResult(`保存しませんでした。voice_id "${candidate.elevenLabsVoiceId}" が見つかりません: ${describeElevenLabsError(error)}`);
          }
          warnings.push(`voice_id の存在確認をスキップしました（${describeElevenLabsError(error)}）。実際に読み上げて確認してください。`);
        }
      } else if (candidate.provider === 'elevenlabs') {
        warnings.push('voice_id が未設定のため、このままでは読み上げできません。tts-list-voices で候補を探してください。');
      }
    }

    if (candidate.provider === 'aivis' && !candidate.apiKey) {
      warnings.push('Aivis のAPIキーが未設定のため、このままでは読み上げできません。');
    }

    updateSettings({
      provider: params.provider,
      apiKey: params.aivis_api_key,
      modelUuid: params.aivis_model_uuid,
      volumeOffsetDb: params.volume_offset_db,
      elevenlabs: {
        apiKey: params.elevenlabs_api_key,
        voiceId: params.elevenlabs_voice_id,
        modelId: params.elevenlabs_model_id,
        volumeOffsetDb: params.elevenlabs_volume_db,
        // 2.5 の値として保存したので、2.4 の値からの読み替えはもうしない
        volumeMigrated: params.elevenlabs_volume_db !== undefined ? true : undefined,
      },
    });

    // 環境変数やCLI引数は config.json より優先されるので、保存しても反映されない項目を知らせる
    const effective = this.loadConfig();
    const overridden: string[] = [];
    if (effective.provider !== candidate.provider) overridden.push('provider (TTS_PROVIDER / --provider)');
    if (effective.apiKey !== candidate.apiKey) overridden.push('aivis_api_key (AIVIS_API_KEY / --api-key)');
    if (effective.modelUuid !== candidate.modelUuid) overridden.push('aivis_model_uuid (AIVIS_MODEL_UUID / --model)');
    if (effective.elevenLabsApiKey !== candidate.elevenLabsApiKey) overridden.push('elevenlabs_api_key (ELEVENLABS_API_KEY)');
    if (effective.elevenLabsVoiceId !== candidate.elevenLabsVoiceId) overridden.push('elevenlabs_voice_id (ELEVENLABS_VOICE_ID / --voice-id)');
    if (effective.elevenLabsModelId !== candidate.elevenLabsModelId) overridden.push('elevenlabs_model_id (ELEVENLABS_MODEL_ID / --eleven-model)');
    if (effective.elevenLabsVolumeOffsetDb !== candidate.elevenLabsVolumeOffsetDb) overridden.push('elevenlabs_volume_db (ELEVENLABS_VOLUME_DB)');
    if (effective.volumeOffsetDb !== candidate.volumeOffsetDb) overridden.push('volume_offset_db (AIVIS_VOLUME_OFFSET_DB)');
    if (overridden.length > 0) {
      warnings.push(`環境変数またはCLI引数が優先されるため、次の項目は保存した値が使われません: ${overridden.join(', ')}`);
    }

    return jsonResult({ saved: true, settings: this.describeSettings(effective), warnings });
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

    // 起きた worker は、古い版の worker が動いていれば lock を引き取り、同じ版が動いていれば終わる
    spawnWorker(this.config);
  }
}

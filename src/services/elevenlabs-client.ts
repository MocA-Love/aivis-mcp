import axios from 'axios';
import type { AppConfig } from '../config.js';

export interface ElevenLabsVoiceSummary {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  description?: string;
  preview_url?: string;
}

export interface ElevenLabsModelSummary {
  model_id: string;
  name: string;
  description?: string;
  supports_japanese: boolean;
  max_characters?: number;
  character_cost_multiplier?: number;
}

function headers(apiKey: string): Record<string, string> {
  return { 'xi-api-key': apiKey };
}

/**
 * Aivis の speaking_rate（0.5〜2.0程度）を ElevenLabs の voice_settings.speed（0.7〜1.2）へ寄せる。
 */
export function toElevenLabsSpeed(speakingRate: unknown): number | undefined {
  if (typeof speakingRate !== 'number' || !Number.isFinite(speakingRate)) return undefined;
  return Math.min(1.2, Math.max(0.7, speakingRate));
}

/**
 * ElevenLabs は SSML をほとんど解釈せず、タグを読み上げてしまうことがあるため取り除く。
 * v3/v4 の audio tags は [whispers] のような角括弧なので影響しない。
 */
export function stripSsmlTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^<>]*>/g, '').trim();
}

export async function synthesizeElevenLabsStream(
  config: AppConfig,
  params: { text: string; voice_id?: string; model_id?: string; speaking_rate?: unknown },
  signal?: AbortSignal,
): Promise<NodeJS.ReadableStream> {
  const voiceId = params.voice_id || config.elevenLabsVoiceId;
  if (!voiceId) {
    throw new Error('ElevenLabs の voice_id が設定されていません');
  }

  const speed = toElevenLabsSpeed(params.speaking_rate);
  const body: Record<string, unknown> = {
    text: stripSsmlTags(params.text),
    model_id: params.model_id || config.elevenLabsModelId,
  };
  if (speed !== undefined) {
    body.voice_settings = { speed };
  }

  const response = await axios.post(
    `${config.elevenLabsApiUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
    body,
    {
      params: { output_format: 'mp3_44100_128' },
      headers: { ...headers(config.elevenLabsApiKey), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      responseType: 'stream',
      timeout: 60000,
      signal,
    }
  );
  return response.data;
}

export async function listElevenLabsVoices(
  config: AppConfig,
  options: { search?: string; limit?: number }
): Promise<ElevenLabsVoiceSummary[]> {
  const response = await axios.get(`${config.elevenLabsApiUrl}/v2/voices`, {
    params: { search: options.search || undefined, page_size: options.limit ?? 20 },
    headers: headers(config.elevenLabsApiKey),
    timeout: 15000,
  });
  const voices: any[] = response.data?.voices ?? [];
  return voices.map((voice) => ({
    voice_id: voice.voice_id,
    name: voice.name,
    category: voice.category,
    labels: voice.labels,
    description: voice.description || undefined,
    preview_url: voice.preview_url || undefined,
  }));
}

export async function getElevenLabsVoice(config: AppConfig, voiceId: string): Promise<ElevenLabsVoiceSummary> {
  const response = await axios.get(`${config.elevenLabsApiUrl}/v1/voices/${encodeURIComponent(voiceId)}`, {
    headers: headers(config.elevenLabsApiKey),
    timeout: 15000,
  });
  const voice = response.data;
  return { voice_id: voice.voice_id, name: voice.name, category: voice.category, labels: voice.labels };
}

export async function listElevenLabsModels(config: AppConfig): Promise<ElevenLabsModelSummary[]> {
  const response = await axios.get(`${config.elevenLabsApiUrl}/v1/models`, {
    headers: headers(config.elevenLabsApiKey),
    timeout: 15000,
  });
  const models: any[] = Array.isArray(response.data) ? response.data : [];
  return models
    .filter((model) => model.can_do_text_to_speech)
    .map((model) => ({
      model_id: model.model_id,
      name: model.name,
      description: model.description || undefined,
      supports_japanese: Array.isArray(model.languages)
        && model.languages.some((language: any) => language.language_id === 'ja'),
      max_characters: model.maximum_text_length_per_request,
      character_cost_multiplier: model.model_rates?.character_cost_multiplier,
    }));
}

/**
 * ElevenLabs のエラー本文の detail.status（invalid_api_key / missing_permissions など）を返す。
 * stream応答のエラーは本文を読めないので undefined になる。
 */
export function elevenLabsErrorCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const status = (error.response?.data as any)?.detail?.status;
  return typeof status === 'string' ? status : undefined;
}

/**
 * axiosエラーをLLMに返せる短い日本語にする。
 */
export function describeElevenLabsError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const code = elevenLabsErrorCode(error);
    if (code === 'invalid_api_key') return 'APIキーが無効です (401)';
    if (code === 'missing_permissions') {
      const permission = String((error.response?.data as any)?.detail?.message ?? '').match(/permission (\w+)/)?.[1];
      return `APIキーに必要な権限${permission ? ` (${permission})` : ''}がありません (401)`;
    }
    if (status === 401) return 'APIキーが無効か、必要な権限がありません (401)';
    if (status === 404) return '指定したIDが見つかりません (404)';
    if (status === 422) return 'リクエスト内容が不正です (422)';
    if (status === 429) return 'レート制限またはクレジット不足です (429)';
    if (status !== undefined) return `ElevenLabs API エラー (${status})`;
    return `ElevenLabs API に接続できません: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

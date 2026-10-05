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

/** 合成の要求に足す項目（前の発話の文脈・発音辞書）。 */
export interface ElevenLabsRequestExtras {
  readonly previous_request_ids?: readonly string[];
  readonly previous_text?: string;
  readonly pronunciation_dictionary_locators?: readonly { pronunciation_dictionary_id: string; version_id: string }[];
}

export interface ElevenLabsStreamResponse {
  readonly stream: NodeJS.ReadableStream;
  /** 応答ヘッダーの `request-id`（無ければ undefined） */
  readonly requestId: string | undefined;
  /** 実際に送った文（SSML 風のタグを除いたもの） */
  readonly sentText: string;
}

/** 合成の要求の本文（送る前に組み立てる。テストでも使う）。 */
export function buildElevenLabsBody(
  config: AppConfig,
  params: { text: string; model_id?: string; speaking_rate?: unknown },
  extras: ElevenLabsRequestExtras = {},
): Record<string, unknown> {
  const speed = toElevenLabsSpeed(params.speaking_rate);
  const body: Record<string, unknown> = {
    text: stripSsmlTags(params.text),
    model_id: params.model_id || config.elevenLabsModelId,
  };
  if (speed !== undefined) {
    body.voice_settings = { speed };
  }
  if (extras.previous_request_ids !== undefined && extras.previous_request_ids.length > 0) {
    body.previous_request_ids = [...extras.previous_request_ids];
  } else if (extras.previous_text !== undefined && extras.previous_text !== '') {
    body.previous_text = extras.previous_text;
  }
  if (extras.pronunciation_dictionary_locators !== undefined && extras.pronunciation_dictionary_locators.length > 0) {
    body.pronunciation_dictionary_locators = extras.pronunciation_dictionary_locators.map(locator => ({ ...locator }));
  }
  return body;
}

export async function requestElevenLabsStream(
  config: AppConfig,
  params: { text: string; voice_id?: string; model_id?: string; speaking_rate?: unknown },
  extras: ElevenLabsRequestExtras = {},
  signal?: AbortSignal,
): Promise<ElevenLabsStreamResponse> {
  const voiceId = params.voice_id || config.elevenLabsVoiceId;
  if (!voiceId) {
    throw new Error('ElevenLabs の voice_id が設定されていません');
  }
  const body = buildElevenLabsBody(config, params, extras);

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
  const requestId = response.headers?.['request-id'];
  return {
    stream: response.data,
    requestId: typeof requestId === 'string' && requestId !== '' ? requestId : undefined,
    sentText: String(body.text),
  };
}

export async function synthesizeElevenLabsStream(
  config: AppConfig,
  params: { text: string; voice_id?: string; model_id?: string; speaking_rate?: unknown },
  signal?: AbortSignal,
): Promise<NodeJS.ReadableStream> {
  return (await requestElevenLabsStream(config, params, {}, signal)).stream;
}

/** ElevenLabs の発音辞書（一覧・解決用）。 */
export interface ElevenLabsPronunciationDictionary {
  readonly id: string;
  readonly name: string;
  readonly latest_version_id: string;
  readonly rules_count?: number;
  readonly description?: string;
  /** アーカイブした時刻（Unix 秒）。アーカイブしていなければ undefined */
  readonly archived_time_unix?: number;
}

function toPronunciationDictionary(raw: any): ElevenLabsPronunciationDictionary | undefined {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.latest_version_id !== 'string') {
    return undefined;
  }
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    latest_version_id: raw.latest_version_id,
    rules_count: typeof raw.latest_version_rules_num === 'number' ? raw.latest_version_rules_num : undefined,
    description: typeof raw.description === 'string' && raw.description !== '' ? raw.description : undefined,
    archived_time_unix: typeof raw.archived_time_unix === 'number' ? raw.archived_time_unix : undefined,
  };
}

/** 発音辞書を 1 つ取る（最新の版とアーカイブの有無を見る）。 */
export async function getElevenLabsPronunciationDictionary(
  config: AppConfig,
  dictionaryId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ElevenLabsPronunciationDictionary> {
  const response = await axios.get(`${config.elevenLabsApiUrl}/v1/pronunciation-dictionaries/${encodeURIComponent(dictionaryId)}`, {
    headers: headers(config.elevenLabsApiKey),
    timeout: options.timeoutMs ?? 15000,
    signal: options.signal,
  });
  const dictionary = toPronunciationDictionary(response.data);
  if (dictionary === undefined) {
    throw new Error('発音辞書の応答の形が想定と違います');
  }
  return dictionary;
}

/** アーカイブしていない発音辞書の一覧（最大 maxPages ページ）。 */
export async function listElevenLabsPronunciationDictionaries(config: AppConfig, maxPages = 5): Promise<ElevenLabsPronunciationDictionary[]> {
  const result: ElevenLabsPronunciationDictionary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const response = await axios.get(`${config.elevenLabsApiUrl}/v1/pronunciation-dictionaries`, {
      params: { page_size: 100, include_archived: false, cursor },
      headers: headers(config.elevenLabsApiKey),
      timeout: 15000,
    });
    const items: unknown[] = Array.isArray(response.data?.pronunciation_dictionaries) ? response.data.pronunciation_dictionaries : [];
    for (const item of items) {
      const dictionary = toPronunciationDictionary(item);
      // include_archived=false を解さない相手でも、アーカイブ済みは出さない
      if (dictionary !== undefined && dictionary.archived_time_unix === undefined) {
        result.push(dictionary);
      }
    }
    cursor = response.data?.has_more === true && typeof response.data?.next_cursor === 'string' ? response.data.next_cursor : undefined;
    if (cursor === undefined) {
      break;
    }
  }
  return result;
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

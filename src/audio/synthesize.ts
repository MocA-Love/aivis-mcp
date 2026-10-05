/**
 * 合成 API を呼び、MP3 の流れを返す（Aivis / ElevenLabs）。
 */

import axios from 'axios';
import type { AppConfig } from '../config.js';
import { requestElevenLabsStream, type ElevenLabsRequestExtras } from '../services/elevenlabs-client.js';
import { ElevenLabsContextMemory, type ElevenLabsContext } from '../services/elevenlabs-context.js';
import { PronunciationDictionaryResolver } from '../services/dictionaries.js';

/** `signal` が中断されたら、要求を取り消す（応答を待っている間・受け取っている間とも）。 */
export type SynthesizeFunction = (config: AppConfig, params: Record<string, unknown>, signal?: AbortSignal) => Promise<NodeJS.ReadableStream>;

/** provider 未指定のジョブは、ElevenLabs 対応より前の版が積んだものなので Aivis として扱う。 */
export function providerOf(params: Record<string, unknown>): 'aivis' | 'elevenlabs' {
  return params.provider === 'elevenlabs' ? 'elevenlabs' : 'aivis';
}

/** 合成の前に分かる設定の不足（無ければ undefined）。 */
export function synthesisSetupError(config: AppConfig, params: Record<string, unknown>): string | undefined {
  const provider = providerOf(params);
  if (provider === 'aivis' && !config.apiKey) {
    return 'APIキーが設定されていません';
  }
  if (provider === 'elevenlabs' && !config.elevenLabsApiKey) {
    return 'ElevenLabs のAPIキーが設定されていません';
  }
  return undefined;
}

async function synthesizeAivisStream(config: AppConfig, params: Record<string, unknown>, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
  const requestParams: Record<string, unknown> = {
    model_uuid: params.model_uuid || config.modelUuid,
    // 先頭に無音は足さない（鳴り始めの頭欠けは、鳴らし始める前の 250ms の溜めで防ぐ）
    text: String(params.text ?? ''),
    output_format: 'mp3',
    speaker_uuid: params.speaker_uuid,
    style_id: params.style_id,
    style_name: params.style_name,
    speaking_rate: params.speaking_rate || params.speed_scale,
    emotional_intensity: params.emotional_intensity,
    tempo_dynamics: params.tempo_dynamics,
    pitch: params.pitch || params.pitch_scale,
    volume: params.volume || params.volume_scale,
    leading_silence_seconds: params.leading_silence_seconds || params.pre_phoneme_length,
    trailing_silence_seconds: params.trailing_silence_seconds || params.post_phoneme_length,
    line_break_silence_seconds: params.line_break_silence_seconds,
    // worker の config.json のユーザー辞書（発話ごとに読み直す）
    user_dictionary_uuid: config.aivisUserDictionaryUuid,
  };
  for (const key of Object.keys(requestParams)) {
    if (requestParams[key] === undefined) {
      delete requestParams[key];
    }
  }
  const response = await axios.post(`${config.apiUrl}/tts/synthesize`, requestParams, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    responseType: 'stream',
    timeout: 60000,
    signal,
  });
  return response.data;
}

/** 文脈を付けた要求が失敗したとき、文脈なしで合成し直す状態か（認証・権限・回数の上限は直らないので除く）。 */
export function shouldRetryWithoutContext(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted || !axios.isAxiosError(error)) {
    return false;
  }
  const status = error.response?.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

export interface SynthesizerOptions {
  /** 前の発話の文脈（worker のメモリ）。既定は新しく作る */
  readonly contextMemory?: ElevenLabsContextMemory;
  /** 発音辞書の版の解決。既定は新しく作る */
  readonly dictionaryResolver?: PronunciationDictionaryResolver;
  /** テスト用。ElevenLabs への要求 */
  readonly requestElevenLabs?: typeof requestElevenLabsStream;
}

/**
 * 合成する関数を作る。ElevenLabs では、直前の声の発話が同じ声・同じモデルならその文脈を、設定の発音辞書も付ける。
 * 文脈は本文を最後まで読み終えた要求だけを覚える（止めた・失敗した発話は記録を消す）。
 */
export function createSynthesizer(options: SynthesizerOptions = {}): SynthesizeFunction {
  const memory = options.contextMemory ?? new ElevenLabsContextMemory();
  const dictionaries = options.dictionaryResolver ?? new PronunciationDictionaryResolver();
  const request = options.requestElevenLabs ?? requestElevenLabsStream;

  return async (config, params, signal) => {
    if (providerOf(params) !== 'elevenlabs') {
      // 間に Aivis の声が挟まったら、前の ElevenLabs の発話とはつなげない
      memory.begin(undefined);
      return synthesizeAivisStream(config, params, signal);
    }
    const voiceId = (typeof params.voice_id === 'string' && params.voice_id !== '' ? params.voice_id : undefined) ?? config.elevenLabsVoiceId;
    const modelId = (typeof params.model_id === 'string' && params.model_id !== '' ? params.model_id : undefined) ?? config.elevenLabsModelId;
    const elevenParams = {
      text: String(params.text ?? ''),
      voice_id: voiceId,
      model_id: modelId,
      speaking_rate: params.speaking_rate,
    };
    // 直前の発話の記録はここで消える（読み終えたらこの発話で置き換わる。失敗・中断なら次はつなげない）
    const context: ElevenLabsContext | undefined = memory.begin(voiceId === undefined
      ? undefined
      : { voiceId, modelId, windowMinutes: config.elevenLabsContextWindowMinutes });
    const locator = await dictionaries.resolve(config, signal);
    const dictionaryExtras: ElevenLabsRequestExtras = locator === undefined ? {} : { pronunciation_dictionary_locators: [locator] };

    let response;
    try {
      response = await request(config, elevenParams, { ...dictionaryExtras, ...context }, signal);
    } catch (error) {
      if (context === undefined || !shouldRetryWithoutContext(error, signal)) {
        throw error;
      }
      // 文脈のせいで鳴らないことを防ぐ。文脈なしでもう一度だけ合成する
      console.error(`[aivis-mcp] 前の発話の文脈を付けた合成が失敗したので、文脈なしで合成し直します (${axios.isAxiosError(error) ? error.response?.status : '?'})`);
      response = await request(config, elevenParams, dictionaryExtras, signal);
    }
    const { stream, requestId, sentText } = response;
    if (voiceId !== undefined) {
      // 最後まで読み終えた（end が来た）ときだけ覚える。途中で切れた・止めた要求の ID は使えない
      stream.once('end', () => {
        if ((stream as { complete?: boolean }).complete === false) {
          return;
        }
        memory.remember(voiceId, modelId, requestId, sentText);
      });
    }
    return stream;
  };
}

/** worker が使う合成。文脈は worker のプロセスが生きている間だけ覚える */
export const synthesizeStream: SynthesizeFunction = createSynthesizer();

/**
 * AxiosError をそのまま出すと config.headers や stream 応答の req._header に
 * APIキー（Authorization / xi-api-key）が平文で含まれるため、要約だけを返す。
 */
export function summarizeError(error: unknown): unknown {
  if (axios.isAxiosError(error)) {
    return { status: error.response?.status, code: error.code, message: error.message };
  }
  return error instanceof Error ? error.message : error;
}

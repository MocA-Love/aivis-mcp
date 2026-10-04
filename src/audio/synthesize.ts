/**
 * 合成 API を呼び、MP3 の流れを返す（Aivis / ElevenLabs）。
 */

import axios from 'axios';
import type { AppConfig } from '../config.js';
import { synthesizeElevenLabsStream } from '../services/elevenlabs-client.js';

export type SynthesizeFunction = (config: AppConfig, params: Record<string, unknown>) => Promise<NodeJS.ReadableStream>;

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

async function synthesizeAivisStream(config: AppConfig, params: Record<string, unknown>): Promise<NodeJS.ReadableStream> {
  const requestParams: Record<string, unknown> = {
    model_uuid: params.model_uuid || config.modelUuid,
    text: '<break time="500ms"/>' + String(params.text ?? ''),
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
  });
  return response.data;
}

export const synthesizeStream: SynthesizeFunction = async (config, params) => {
  if (providerOf(params) === 'elevenlabs') {
    return synthesizeElevenLabsStream(config, {
      text: String(params.text ?? ''),
      voice_id: typeof params.voice_id === 'string' ? params.voice_id : undefined,
      model_id: typeof params.model_id === 'string' ? params.model_id : undefined,
      speaking_rate: params.speaking_rate,
    });
  }
  return synthesizeAivisStream(config, params);
};

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

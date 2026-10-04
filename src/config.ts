import { parseArgs } from 'node:util';
import { createRequire } from 'module';
import { loadSettings, isTtsProvider, type TtsProvider } from './settings.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

export { version };

export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_v4_turbo';
// 実測で ElevenLabs(eleven_v4_turbo) は -11.5 LUFS 前後、Aivis は -24 LUFS 前後だったので、その差を再生時に詰める
export const DEFAULT_ELEVENLABS_VOLUME_DB = -13;

export interface AppConfig {
  provider: TtsProvider;
  apiKey: string;
  apiUrl: string;
  modelUuid: string;
  styleName?: string;
  styleId?: number;
  speakingRate?: number;
  emotionalIntensity?: number;
  tempoDynamics?: number;
  pitch?: number;
  volume?: number;
  leadingSilenceSeconds?: number;
  trailingSilenceSeconds?: number;
  lineBreakSilenceSeconds?: number;
  elevenLabsApiKey: string;
  elevenLabsApiUrl: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId: string;
  elevenLabsVolumeDb: number;
  redisUrl: string;
  debug: boolean;
  queueKey: string;
  workerLockKey: string;
}

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export const cliOptions = {
  help:                  { type: 'boolean' as const, short: 'h', default: false },
  version:               { type: 'boolean' as const, short: 'v', default: false },
  init:                  { type: 'boolean' as const, default: false },
  doctor:                { type: 'boolean' as const, default: false },
  health:                { type: 'boolean' as const, default: false },
  reboot:                { type: 'boolean' as const, default: false },
  mute:                  { type: 'boolean' as const, default: false },
  'mute-for':            { type: 'string' as const },
  unmute:                { type: 'boolean' as const, default: false },
  'mute-status':         { type: 'boolean' as const, default: false },
  worker:                { type: 'boolean' as const, default: false },
  'play-audio':          { type: 'boolean' as const, default: false },
  provider:              { type: 'string' as const },
  'voice-id':            { type: 'string' as const },
  'eleven-model':        { type: 'string' as const },
  'elevenlabs-api-key':  { type: 'string' as const },
  'api-key':             { type: 'string' as const, short: 'k' },
  'api-url':             { type: 'string' as const },
  model:                 { type: 'string' as const, short: 'm' },
  'style-name':          { type: 'string' as const },
  'style-id':            { type: 'string' as const },
  rate:                  { type: 'string' as const, short: 'r' },
  'emotional-intensity': { type: 'string' as const },
  'tempo-dynamics':      { type: 'string' as const },
  pitch:                 { type: 'string' as const, short: 'p' },
  volume:                { type: 'string' as const },
  'leading-silence':     { type: 'string' as const },
  'trailing-silence':    { type: 'string' as const },
  'line-break-silence':  { type: 'string' as const },
  'redis-url':           { type: 'string' as const },
  wait:                  { type: 'string' as const, short: 'w' },
  debug:                 { type: 'boolean' as const, short: 'd', default: false },
};

export function parseCliArgs(argv?: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    options: cliOptions,
    allowPositionals: true,
    strict: false,
    args: argv,
  });
  return { values: values as Record<string, string | boolean | undefined>, positionals };
}

function optNumber(cliVal: string | boolean | undefined, envKey: string): number | undefined {
  if (typeof cliVal === 'string' && cliVal !== '') return parseFloat(cliVal);
  const env = process.env[envKey];
  if (env !== undefined && env !== '') return parseFloat(env);
  return undefined;
}

function optString(cliVal: string | boolean | undefined, envKey: string): string | undefined {
  if (typeof cliVal === 'string' && cliVal !== '') return cliVal;
  const env = process.env[envKey];
  if (env !== undefined && env !== '') return env;
  return undefined;
}

function resolveProvider(cliVal: string | boolean | undefined, settingsVal: TtsProvider | undefined): TtsProvider {
  const candidate = optString(cliVal, 'TTS_PROVIDER');
  if (candidate !== undefined) {
    if (isTtsProvider(candidate)) return candidate;
    console.error(`[aivis-mcp] 不明なプロバイダ "${candidate}" を無視します（aivis / elevenlabs）`);
  }
  return settingsVal ?? 'aivis';
}

/**
 * 設定の解決順は CLI引数 > 環境変数 > ~/.config/aivis-mcp/config.json > デフォルト。
 * config.json はMCPツールから書き換わるので、発話ごとに呼び直して最新値を使う。
 */
export function resolveConfig(values: Record<string, string | boolean | undefined>): AppConfig {
  const settings = loadSettings();
  return {
    provider: resolveProvider(values.provider, settings.provider),
    apiKey:
      (typeof values['api-key'] === 'string' ? values['api-key'] : undefined)
      ?? process.env.AIVIS_API_KEY
      ?? settings.apiKey
      ?? '',
    apiUrl:
      (typeof values['api-url'] === 'string' ? values['api-url'] : undefined)
      ?? process.env.AIVIS_API_URL
      ?? settings.apiUrl
      ?? 'https://api.aivis-project.com/v1',
    modelUuid:
      (typeof values.model === 'string' ? values.model : undefined)
      ?? process.env.AIVIS_MODEL_UUID
      ?? settings.modelUuid
      ?? 'a670e6b8-0852-45b2-8704-1bc9862f2fe6',
    styleName: optString(values['style-name'], 'AIVIS_STYLE_NAME'),
    styleId: optNumber(values['style-id'], 'AIVIS_STYLE_ID'),
    speakingRate: optNumber(values.rate, 'AIVIS_SPEAKING_RATE'),
    emotionalIntensity: optNumber(values['emotional-intensity'], 'AIVIS_EMOTIONAL_INTENSITY'),
    tempoDynamics: optNumber(values['tempo-dynamics'], 'AIVIS_TEMPO_DYNAMICS'),
    pitch: optNumber(values.pitch, 'AIVIS_PITCH'),
    volume: optNumber(values.volume, 'AIVIS_VOLUME'),
    leadingSilenceSeconds: optNumber(values['leading-silence'], 'AIVIS_LEADING_SILENCE_SECONDS'),
    trailingSilenceSeconds: optNumber(values['trailing-silence'], 'AIVIS_TRAILING_SILENCE_SECONDS'),
    lineBreakSilenceSeconds: optNumber(values['line-break-silence'], 'AIVIS_LINE_BREAK_SILENCE_SECONDS'),
    elevenLabsApiKey:
      optString(values['elevenlabs-api-key'], 'ELEVENLABS_API_KEY')
      ?? settings.elevenlabs?.apiKey
      ?? '',
    elevenLabsApiUrl: process.env.ELEVENLABS_API_URL ?? 'https://api.elevenlabs.io',
    elevenLabsVoiceId:
      optString(values['voice-id'], 'ELEVENLABS_VOICE_ID')
      ?? settings.elevenlabs?.voiceId,
    elevenLabsModelId:
      optString(values['eleven-model'], 'ELEVENLABS_MODEL_ID')
      ?? settings.elevenlabs?.modelId
      ?? DEFAULT_ELEVENLABS_MODEL_ID,
    elevenLabsVolumeDb:
      optNumber(undefined, 'ELEVENLABS_VOLUME_DB')
      ?? settings.elevenlabs?.volumeDb
      ?? DEFAULT_ELEVENLABS_VOLUME_DB,
    redisUrl:
      (typeof values['redis-url'] === 'string' ? values['redis-url'] : undefined)
      ?? process.env.REDIS_URL
      ?? settings.redisUrl
      ?? 'redis://127.0.0.1:6379',
    debug: values.debug === true || process.env.AIVIS_DEBUG === '1',
    queueKey: 'aivis-mcp:queue',
    workerLockKey: 'aivis-mcp:worker-lock',
  };
}

export function buildSynthesisParams(config: AppConfig, text: string, waitMs?: number): Record<string, unknown> {
  // workerはRedis全体で1つだけで、要求元とは設定が異なりうる。
  // プロバイダと声は要求元で確定させてjob payloadに載せる（APIキーはworker側の設定から読む）。
  const params: Record<string, unknown> = {
    text,
    provider: config.provider,
    voice_id: config.elevenLabsVoiceId,
    model_id: config.elevenLabsModelId,
    model_uuid: config.modelUuid,
    style_id: config.styleId,
    style_name: config.styleName,
    speaking_rate: config.speakingRate,
    emotional_intensity: config.emotionalIntensity,
    tempo_dynamics: config.tempoDynamics,
    pitch: config.pitch,
    volume: config.volume,
    leading_silence_seconds: config.leadingSilenceSeconds,
    trailing_silence_seconds: config.trailingSilenceSeconds,
    line_break_silence_seconds: config.lineBreakSilenceSeconds,
  };

  if (waitMs !== undefined) {
    params.wait_ms = waitMs;
  }

  for (const key of Object.keys(params)) {
    if (params[key] === undefined) {
      delete params[key];
    }
  }

  return params;
}

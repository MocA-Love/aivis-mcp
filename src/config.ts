import { parseArgs } from 'node:util';
import { createRequire } from 'module';
import { loadSettingsWithMigration, isTtsProvider, type TtsProvider } from './settings.js';
import { legacyElevenLabsVolumeToOffset, resolveGainLearningSettings } from './audio/gain-table.js';
import { sanitizeVoiceSettings, type ElevenLabsVoiceSettingsMap } from './services/voice-settings.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

export { version };

export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_v4_turbo';

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
  /** ElevenLabs の声だけに足す上乗せ（dB）。2.4 の volume_db からの読み替えを含む */
  elevenLabsVolumeOffsetDb: number;
  /** 前の発話の文脈（request ID か文）を付ける時間（分）。0 で付けない */
  elevenLabsContextWindowMinutes: number;
  /** ElevenLabs の発音辞書の ID */
  elevenLabsPronunciationDictionaryId?: string;
  /** ElevenLabs の発音辞書の版（無ければ合成のたびに最新の版を取る） */
  elevenLabsPronunciationDictionaryVersionId?: string;
  /** ElevenLabs の声（voice_id）ごとの調整（stability / similarityBoost）。無ければ ElevenLabs に保存した値 */
  elevenLabsVoiceSettings?: ElevenLabsVoiceSettingsMap;
  /** Aivis のユーザー辞書の UUID */
  aivisUserDictionaryUuid?: string;
  /** すべての声に足す上乗せ（dB） */
  volumeOffsetDb: number;
  /** 音量の覚え直しに使う直近の回数 */
  gainLearnWindow: number;
  /** これより短い発話は音量の覚え直しに使わない（秒） */
  gainMinLearnSeconds: number;
  redisUrl: string;
  debug: boolean;
  queueKey: string;
  workerLockKey: string;
}

export type ArgValue = string | boolean | string[] | undefined;

export interface ParsedArgs {
  values: Record<string, ArgValue>;
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
  'gain-key':            { type: 'string' as const },
  'restore-legacy-queue': { type: 'boolean' as const, default: false },
  'export-gains':        { type: 'string' as const },
  'import-gains':        { type: 'string' as const },
  voice:                 { type: 'string' as const, multiple: true as const },
  overwrite:             { type: 'boolean' as const, default: false },
  ingest:                { type: 'boolean' as const, default: false },
  'prelude-dir':         { type: 'string' as const, multiple: true as const },
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
  'set-dictionary':      { type: 'boolean' as const, default: false },
  'clear-dictionary':    { type: 'boolean' as const, default: false },
  id:                    { type: 'string' as const },
  'version-id':          { type: 'string' as const },
  'set-voice-settings':  { type: 'boolean' as const, default: false },
  'clear-voice-settings': { type: 'boolean' as const, default: false },
  stability:             { type: 'string' as const },
  similarity:            { type: 'string' as const },
  'list-gains':          { type: 'boolean' as const, default: false },
  'reset-gain':          { type: 'boolean' as const, default: false },
  key:                   { type: 'string' as const },
  'set-gain-learning':   { type: 'boolean' as const, default: false },
  window:                { type: 'string' as const },
  'min-seconds':         { type: 'string' as const },
  json:                  { type: 'boolean' as const, default: false },
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
  return { values: values as Record<string, ArgValue>, positionals };
}

function optNumber(cliVal: ArgValue, envKey: string): number | undefined {
  if (typeof cliVal === 'string' && cliVal !== '') return parseFloat(cliVal);
  const env = process.env[envKey];
  if (env !== undefined && env !== '') return parseFloat(env);
  return undefined;
}

function optString(cliVal: ArgValue, envKey: string): string | undefined {
  if (typeof cliVal === 'string' && cliVal !== '') return cliVal;
  const env = process.env[envKey];
  if (env !== undefined && env !== '') return env;
  return undefined;
}

function resolveProvider(cliVal: ArgValue, settingsVal: TtsProvider | undefined): TtsProvider {
  const candidate = optString(cliVal, 'TTS_PROVIDER');
  if (candidate !== undefined) {
    if (isTtsProvider(candidate)) return candidate;
    console.error(`[aivis-mcp] 不明なプロバイダ "${candidate}" を無視します（aivis / elevenlabs）`);
  }
  return settingsVal ?? 'aivis';
}

/** 同じ警告を発話ごとに繰り返さない（worker は発話ごとに設定を読み直すため）。 */
const warnedGainSettings = new Set<string>();

function warnGainSettingOnce(message: string): void {
  if (warnedGainSettings.has(message)) {
    return;
  }
  warnedGainSettings.add(message);
  console.error(`[aivis-mcp] ${message}`);
}

export const DEFAULT_ELEVENLABS_CONTEXT_MINUTES = 5;
/** 文脈を付ける時間の上限（分）。request ID は 2 時間しか使えないので、それより古い前の発話は文で付ける */
export const MAX_ELEVENLABS_CONTEXT_MINUTES = 1440;

/** 文脈を付ける時間（分）。環境変数 > config.json > 既定。範囲外・数でない値は既定に戻して 1 回だけ警告する */
export function resolveContextWindowMinutes(envValue: string | undefined, settingsValue: unknown): number {
  const candidates: { source: string; value: unknown }[] = [
    { source: 'AIVIS_ELEVENLABS_CONTEXT_MINUTES', value: envValue === '' ? undefined : envValue },
    { source: 'config.json の elevenlabs.contextWindowMinutes', value: settingsValue },
  ];
  for (const { source, value } of candidates) {
    if (value === undefined || value === null) {
      continue;
    }
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_ELEVENLABS_CONTEXT_MINUTES) {
      return parsed;
    }
    warnGainSettingOnce(`${source} の値 ${JSON.stringify(value)} は 0〜${MAX_ELEVENLABS_CONTEXT_MINUTES} の数ではないので、既定の ${DEFAULT_ELEVENLABS_CONTEXT_MINUTES} 分を使います`);
    return DEFAULT_ELEVENLABS_CONTEXT_MINUTES;
  }
  return DEFAULT_ELEVENLABS_CONTEXT_MINUTES;
}

/** 空文字・文字列でない値は未設定として扱う */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 設定の解決順は CLI引数 > 環境変数 > ~/.config/aivis-mcp/config.json > デフォルト。
 * config.json はMCPツールから書き換わるので、発話ごとに呼び直して最新値を使う。
 */
export function resolveConfig(values: Record<string, ArgValue>): AppConfig {
  const settings = loadSettingsWithMigration();
  const legacyEnvVolume = optNumber(undefined, 'ELEVENLABS_VOLUME_DB');
  // 覚え直しは共有の worker（引数無しで起こす）が行うので、CLI 引数は設けず 環境変数 > config.json > 既定
  const gainLearning = resolveGainLearningSettings({
    learnWindow: [
      { source: 'AIVIS_GAIN_LEARN_WINDOW', value: process.env.AIVIS_GAIN_LEARN_WINDOW },
      { source: 'config.json', value: settings.gain?.learnWindow },
    ],
    minLearnSeconds: [
      { source: 'AIVIS_GAIN_MIN_LEARN_SECONDS', value: process.env.AIVIS_GAIN_MIN_LEARN_SECONDS },
      { source: 'config.json', value: settings.gain?.minLearnSeconds },
    ],
  }, warnGainSettingOnce);
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
    // 古い ELEVENLABS_VOLUME_DB は 2.4 の意味（-13 が既定の絶対値）なので、毎回上乗せへ読み替える
    elevenLabsVolumeOffsetDb:
      (legacyEnvVolume !== undefined && Number.isFinite(legacyEnvVolume) ? legacyElevenLabsVolumeToOffset(legacyEnvVolume) : undefined)
      ?? settings.elevenlabs?.volumeOffsetDb
      ?? 0,
    elevenLabsContextWindowMinutes: resolveContextWindowMinutes(process.env.AIVIS_ELEVENLABS_CONTEXT_MINUTES, settings.elevenlabs?.contextWindowMinutes),
    elevenLabsPronunciationDictionaryId: nonEmptyString(settings.elevenlabs?.pronunciationDictionaryId),
    // 版は辞書の ID があるときだけ使う
    elevenLabsPronunciationDictionaryVersionId: nonEmptyString(settings.elevenlabs?.pronunciationDictionaryId) === undefined
      ? undefined
      : nonEmptyString(settings.elevenlabs?.pronunciationDictionaryVersionId),
    elevenLabsVoiceSettings: sanitizeVoiceSettings(settings.elevenlabs?.voiceSettings, warnGainSettingOnce),
    aivisUserDictionaryUuid: nonEmptyString(settings.aivis?.userDictionaryUuid),
    volumeOffsetDb:
      optNumber(undefined, 'AIVIS_VOLUME_OFFSET_DB')
      ?? settings.volumeOffsetDb
      ?? 0,
    gainLearnWindow: gainLearning.learnWindow,
    gainMinLearnSeconds: gainLearning.minLearnSeconds,
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

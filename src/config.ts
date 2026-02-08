import { parseArgs } from 'node:util';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

export { version };

export interface AppConfig {
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
  doctor:                { type: 'boolean' as const, default: false },
  health:                { type: 'boolean' as const, default: false },
  reboot:                { type: 'boolean' as const, default: false },
  worker:                { type: 'boolean' as const, default: false },
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

export function resolveConfig(values: Record<string, string | boolean | undefined>): AppConfig {
  return {
    apiKey:
      (typeof values['api-key'] === 'string' ? values['api-key'] : undefined)
      ?? process.env.AIVIS_API_KEY
      ?? '',
    apiUrl:
      (typeof values['api-url'] === 'string' ? values['api-url'] : undefined)
      ?? process.env.AIVIS_API_URL
      ?? 'https://api.aivis-project.com/v1',
    modelUuid:
      (typeof values.model === 'string' ? values.model : undefined)
      ?? process.env.AIVIS_MODEL_UUID
      ?? 'a59cb814-0083-4369-8542-f51a29e72af7',
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
    redisUrl:
      (typeof values['redis-url'] === 'string' ? values['redis-url'] : undefined)
      ?? process.env.REDIS_URL
      ?? 'redis://127.0.0.1:6379',
    debug: values.debug === true || process.env.AIVIS_DEBUG === '1',
    queueKey: 'aivis-mcp:queue',
    workerLockKey: 'aivis-mcp:worker-lock',
  };
}

export function buildSynthesisParams(config: AppConfig, text: string, waitMs?: number): Record<string, unknown> {
  const params: Record<string, unknown> = {
    text,
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

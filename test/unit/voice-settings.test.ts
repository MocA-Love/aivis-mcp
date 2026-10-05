import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildElevenLabsBody } from '../../src/services/elevenlabs-client.js';
import {
  applyVoiceSettingsPatch, roundV3Stability, sanitizeVoiceSettings, voiceSettingsForRequest,
} from '../../src/services/voice-settings.js';
import { applyVoiceSettingsCommand, parseVoiceSettingsCommand, VoiceSettingsCommandError } from '../../src/voice-settings-command.js';
import { resolveConfig } from '../../src/config.js';
import { testConfig } from '../helpers/fixtures.js';

describe('ElevenLabs の声ごとの調整', () => {
  test('voice_settings には値のあるキーだけ入れ、speed はそのまま', () => {
    const config = {
      ...testConfig('redis://127.0.0.1:9'),
      elevenLabsVoiceId: 'voiceA',
      elevenLabsVoiceSettings: { voiceA: { stability: 0.3 }, voiceB: { stability: 0.8, similarityBoost: 0.9 } },
    };
    expect([
      buildElevenLabsBody(config, { text: 'a' }).voice_settings,
      buildElevenLabsBody(config, { text: 'a', speaking_rate: 1.1 }).voice_settings,
      buildElevenLabsBody(config, { text: 'a', voice_id: 'voiceB', model_id: 'eleven_v4_turbo' }).voice_settings,
      buildElevenLabsBody(config, { text: 'a', voice_id: 'voiceC' }).voice_settings,
      buildElevenLabsBody(config, { text: 'a', voice_id: 'voiceC', speaking_rate: 0.9 }).voice_settings,
    ]).toEqual([
      { stability: 0.3 },
      { stability: 0.3, speed: 1.1 },
      { stability: 0.8, similarity_boost: 0.9 },
      undefined,
      { speed: 0.9 },
    ]);
  });

  test('v3 系では stability を 0 / 0.5 / 1 の最寄りに丸める（similarity_boost は丸めない）', () => {
    expect([0, 0.2, 0.25, 0.26, 0.5, 0.74, 0.75, 1].map(roundV3Stability)).toEqual([0, 0, 0.5, 0.5, 0.5, 0.5, 1, 1]);
    const settings = { v: { stability: 0.3, similarityBoost: 0.33 } };
    expect([
      voiceSettingsForRequest(settings, 'v', 'eleven_v3'),
      voiceSettingsForRequest(settings, 'v', 'eleven_v3_preview'),
      voiceSettingsForRequest(settings, 'v', 'eleven_v4_turbo'),
      voiceSettingsForRequest(settings, undefined, 'eleven_v3'),
      voiceSettingsForRequest(undefined, 'v', 'eleven_v3'),
    ]).toEqual([
      { stability: 0.5, similarity_boost: 0.33 },
      { stability: 0.5, similarity_boost: 0.33 },
      { stability: 0.3, similarity_boost: 0.33 },
      {},
      {},
    ]);
  });

  test('config.json のおかしな声・値は使わずに知らせる', () => {
    const warnings: string[] = [];
    const result = sanitizeVoiceSettings({
      good: { stability: 0.4, similarityBoost: 2 },
      'bad id': { stability: 0.1 },
      __proto__x: 'nope',
      empty: {},
      onlySimilarity: { similarityBoost: 0 },
    }, message => warnings.push(message));
    expect({ ...result }).toEqual({ good: { stability: 0.4 }, onlySimilarity: { similarityBoost: 0 } });
    expect(warnings).toHaveLength(3);
    expect({ ...sanitizeVoiceSettings([1], () => undefined) }).toEqual({});
  });

  test('指定したキーだけ置き換え、null で消し、空になった声と表は消す', () => {
    const one = applyVoiceSettingsPatch(undefined, 'a', { stability: 0.5 });
    const two = applyVoiceSettingsPatch(one, 'a', { similarityBoost: 0.7 });
    const three = applyVoiceSettingsPatch(two, 'b', { stability: 1 });
    const four = applyVoiceSettingsPatch(three, 'a', { stability: null });
    expect([one, two, three, four, applyVoiceSettingsPatch(four, 'a', null), applyVoiceSettingsPatch({ a: { stability: 1 } }, 'a', null)]).toEqual([
      { a: { stability: 0.5 } },
      { a: { stability: 0.5, similarityBoost: 0.7 } },
      { a: { stability: 0.5, similarityBoost: 0.7 }, b: { stability: 1 } },
      { a: { similarityBoost: 0.7 }, b: { stability: 1 } },
      { b: { stability: 1 } },
      undefined,
    ]);
  });

  test('CLI の引数を確かめる', () => {
    expect(parseVoiceSettingsCommand({ 'set-voice-settings': true, voice: ['abc'], stability: '0.25' }))
      .toEqual({ voiceId: 'abc', patch: { stability: 0.25 } });
    expect(parseVoiceSettingsCommand({ 'clear-voice-settings': true, voice: ['abc'] })).toEqual({ voiceId: 'abc', patch: null });
    const bad: Record<string, string | boolean | string[]>[] = [
      { 'set-voice-settings': true, voice: ['abc'] },
      { 'set-voice-settings': true, stability: '0.5' },
      { 'set-voice-settings': true, voice: ['a', 'b'], stability: '0.5' },
      { 'set-voice-settings': true, voice: ['__proto__'], stability: '0.5' },
      { 'set-voice-settings': true, voice: ['a b'], stability: '0.5' },
      { 'set-voice-settings': true, voice: ['abc'], stability: '1.5' },
      { 'set-voice-settings': true, voice: ['abc'], similarity: 'x' },
      { 'set-voice-settings': true, voice: ['abc'], stability: true },
      { 'clear-voice-settings': true, voice: ['abc'], stability: '0.5' },
      { 'set-voice-settings': true, 'clear-voice-settings': true, voice: ['abc'] },
    ];
    for (const values of bad) {
      expect(() => parseVoiceSettingsCommand(values)).toThrow(VoiceSettingsCommandError);
    }
  });

  test('ほかの ElevenLabs の設定は残し、表が空になったら voiceSettings を消す', () => {
    const current = { provider: 'elevenlabs' as const, elevenlabs: { apiKey: 'k', voiceSettings: { a: { stability: 0.1 } } } };
    expect(applyVoiceSettingsCommand(current, { voiceId: 'a', patch: null })).toEqual({ provider: 'elevenlabs', elevenlabs: { apiKey: 'k' } });
    expect(applyVoiceSettingsCommand({}, { voiceId: 'a', patch: null })).toEqual({});
  });

  test('resolveConfig は config.json の声ごとの調整を読む', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-voice-settings-'));
    const previous = process.env.AIVIS_CONFIG_FILE;
    process.env.AIVIS_CONFIG_FILE = path.join(dir, 'config.json');
    try {
      fs.writeFileSync(process.env.AIVIS_CONFIG_FILE, JSON.stringify({ elevenlabs: { voiceSettings: { a: { stability: 0.2, similarityBoost: 0.9 } } } }));
      expect({ ...resolveConfig({}).elevenLabsVoiceSettings }).toEqual({ a: { stability: 0.2, similarityBoost: 0.9 } });
    } finally {
      process.env.AIVIS_CONFIG_FILE = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

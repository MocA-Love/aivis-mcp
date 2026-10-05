/**
 * ElevenLabs の声（voice_id）ごとの調整（`elevenlabs.voiceSettings`）。
 *
 * config.json には `{ "<voice_id>": { "stability"?: number, "similarityBoost"?: number } }` で置く（どちらも 0〜1）。
 * 値がある声の合成では `voice_settings` に `stability` / `similarity_boost` を入れ、無いキーは送らない
 * （送らなければ ElevenLabs に保存した値が使われる）。
 */

import type { ElevenLabsVoiceSetting } from '../settings.js';
import { isElevenLabsId } from './dictionaries.js';

export type { ElevenLabsVoiceSetting };

/** 声ごとの調整の表（声 → 調整）。原型の無いオブジェクトで持つ */
export type ElevenLabsVoiceSettingsMap = Readonly<Record<string, Readonly<ElevenLabsVoiceSetting>>>;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 声の調整の鍵にしてよい voice_id か（発音辞書の ID と同じ形。Object の性質の名前は拒む） */
export function isVoiceSettingsVoiceId(value: string): boolean {
  return isElevenLabsId(value) && !RESERVED_KEYS.has(value);
}

/** 0〜1 の有限の数か */
export function isVoiceSettingValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** eleven_v3 系のモデルか（stability を 0 / 0.5 / 1 しか受け付けない） */
export function isElevenLabsV3Model(modelId: string): boolean {
  return /^eleven_v3/.test(modelId);
}

/** v3 系の stability を 0 / 0.5 / 1 の最寄りに丸める（ちょうど中間は大きい方） */
export function roundV3Stability(value: number): number {
  return Math.round(value * 2) / 2;
}

/**
 * config.json の値を読み、形の正しい声・値だけを残す。おかしな声・値は `warn` で知らせて使わない
 * （その声のほかの値は使う）。
 */
export function sanitizeVoiceSettings(raw: unknown, warn: (message: string) => void): ElevenLabsVoiceSettingsMap {
  const result: Record<string, ElevenLabsVoiceSetting> = Object.create(null);
  if (raw === undefined || raw === null) {
    return result;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('config.json の elevenlabs.voiceSettings がオブジェクトではないので使いません');
    return result;
  }
  for (const [voiceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isVoiceSettingsVoiceId(voiceId)) {
      warn(`config.json の elevenlabs.voiceSettings の鍵 ${JSON.stringify(voiceId.slice(0, 80))} は voice_id の形ではないので使いません`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      warn(`config.json の elevenlabs.voiceSettings.${voiceId} がオブジェクトではないので使いません`);
      continue;
    }
    const entry: ElevenLabsVoiceSetting = {};
    for (const name of ['stability', 'similarityBoost'] as const) {
      const candidate = (value as Record<string, unknown>)[name];
      if (candidate === undefined || candidate === null) {
        continue;
      }
      if (isVoiceSettingValue(candidate)) {
        entry[name] = candidate;
      } else {
        warn(`config.json の elevenlabs.voiceSettings.${voiceId}.${name}=${JSON.stringify(candidate)} は 0〜1 の数ではないので使いません`);
      }
    }
    if (entry.stability !== undefined || entry.similarityBoost !== undefined) {
      result[voiceId] = entry;
    }
  }
  return result;
}

/**
 * 声の調整を合成の要求の `voice_settings` に入れる項目にする。値が無ければ空。
 * v3 系のモデルでは stability を 0 / 0.5 / 1 の最寄りに丸める。
 */
export function voiceSettingsForRequest(
  settings: ElevenLabsVoiceSettingsMap | undefined,
  voiceId: string | undefined,
  modelId: string,
): { stability?: number; similarity_boost?: number } {
  if (settings === undefined || voiceId === undefined || !Object.prototype.hasOwnProperty.call(settings, voiceId)) {
    return {};
  }
  const entry = settings[voiceId];
  const result: { stability?: number; similarity_boost?: number } = {};
  if (isVoiceSettingValue(entry.stability)) {
    result.stability = isElevenLabsV3Model(modelId) ? roundV3Stability(entry.stability) : entry.stability;
  }
  if (isVoiceSettingValue(entry.similarityBoost)) {
    result.similarity_boost = entry.similarityBoost;
  }
  return result;
}

/** 声の調整の変更。undefined のキーは変えない、null のキーは消す */
export interface ElevenLabsVoiceSettingPatch {
  stability?: number | null;
  similarityBoost?: number | null;
}

/**
 * 表の 1 つの声を変える（書かない）。`patch` が null なら声ごと消す。`patch` の undefined のキーは変えず、null のキーは消す。
 * 声の値が空になったら声ごと消し、表が空になったら undefined を返す。
 */
export function applyVoiceSettingsPatch(
  current: unknown,
  voiceId: string,
  patch: ElevenLabsVoiceSettingPatch | null,
): Record<string, ElevenLabsVoiceSetting> | undefined {
  const next: Record<string, ElevenLabsVoiceSetting> = Object.create(null);
  if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(current as Record<string, ElevenLabsVoiceSetting>)) {
      if (!RESERVED_KEYS.has(key)) {
        next[key] = value;
      }
    }
  }
  if (patch === null) {
    delete next[voiceId];
  } else {
    const previous = next[voiceId];
    const merged: ElevenLabsVoiceSetting = previous !== null && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
    for (const name of ['stability', 'similarityBoost'] as const) {
      const value = patch[name];
      if (value === null) {
        delete merged[name];
      } else if (value !== undefined) {
        merged[name] = value;
      }
    }
    if (Object.keys(merged).length > 0) {
      next[voiceId] = merged;
    } else {
      delete next[voiceId];
    }
  }
  // 書くのは普通のオブジェクト（JSON にする）
  return Object.keys(next).length > 0 ? { ...next } : undefined;
}

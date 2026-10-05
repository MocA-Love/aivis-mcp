/**
 * `--set-voice-settings` / `--clear-voice-settings`: Para Code などから ElevenLabs の声ごとの調整を設定・解除する口。
 *
 * 出力は `--set-dictionary` と同じ。成功は標準出力に `ok`、失敗は標準エラーに `error: <理由>` と終了コード 1（設定は変えない）。
 * API は叩かない。worker は発話ごとに設定を読み直すので再起動は要らない。
 */

import type { ArgValue } from './config.js';
import { modifySettings, type UserSettings } from './settings.js';
import { applyVoiceSettingsPatch, isVoiceSettingsVoiceId, type ElevenLabsVoiceSettingPatch } from './services/voice-settings.js';

export class VoiceSettingsCommandError extends Error {}

/** 声の調整の変更（`patch` が null なら声ごと消す） */
export interface VoiceSettingsCommand {
  readonly voiceId: string;
  readonly patch: ElevenLabsVoiceSettingPatch | null;
}

/** `0..1` の数の引数。無ければ undefined。 */
function unitArgument(value: ArgValue, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = typeof value === 'string' ? value.trim() : '';
  const parsed = text === '' ? NaN : Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new VoiceSettingsCommandError(`${flag} には 0〜1 の数を指定してください`);
  }
  return parsed;
}

/** 引数を確かめて変更にする（書かない）。 */
export function parseVoiceSettingsCommand(values: Record<string, ArgValue>): VoiceSettingsCommand {
  const set = values['set-voice-settings'] === true;
  const clear = values['clear-voice-settings'] === true;
  if (set && clear) {
    throw new VoiceSettingsCommandError('--set-voice-settings と --clear-voice-settings は同時に使えません');
  }
  const voices = Array.isArray(values.voice) ? values.voice : [];
  if (voices.length !== 1) {
    throw new VoiceSettingsCommandError('--voice に ElevenLabs の voice_id を 1 つ指定してください');
  }
  const voiceId = voices[0].trim();
  if (!isVoiceSettingsVoiceId(voiceId)) {
    throw new VoiceSettingsCommandError(`ElevenLabs の voice_id の形ではありません: ${voiceId.slice(0, 80)}`);
  }
  if (clear) {
    if (values.stability !== undefined || values.similarity !== undefined) {
      throw new VoiceSettingsCommandError('--clear-voice-settings には --stability / --similarity を付けません');
    }
    return { voiceId, patch: null };
  }
  const stability = unitArgument(values.stability, '--stability');
  const similarityBoost = unitArgument(values.similarity, '--similarity');
  if (stability === undefined && similarityBoost === undefined) {
    throw new VoiceSettingsCommandError('--stability か --similarity の少なくとも一方を指定してください');
  }
  return {
    voiceId,
    patch: { ...(stability !== undefined ? { stability } : {}), ...(similarityBoost !== undefined ? { similarityBoost } : {}) },
  };
}

/** 読んだ設定に変更を重ねたもの（書かない）。表が空になったら voiceSettings を、elevenlabs が空になったら elevenlabs を消す。 */
export function applyVoiceSettingsCommand(current: UserSettings, command: VoiceSettingsCommand): UserSettings {
  const voiceSettings = applyVoiceSettingsPatch(current.elevenlabs?.voiceSettings, command.voiceId, command.patch);
  const elevenlabs = { ...current.elevenlabs };
  if (voiceSettings === undefined) {
    delete elevenlabs.voiceSettings;
  } else {
    elevenlabs.voiceSettings = voiceSettings;
  }
  const next: UserSettings = { ...current };
  if (Object.keys(elevenlabs).length > 0) {
    next.elevenlabs = elevenlabs;
  } else {
    delete next.elevenlabs;
  }
  return next;
}

/**
 * `--set-voice-settings` / `--clear-voice-settings` が指定されていれば実行して true を返す（終了コードは `process.exitCode`）。
 */
export async function runVoiceSettingsCommand(values: Record<string, ArgValue>): Promise<boolean> {
  if (values['set-voice-settings'] !== true && values['clear-voice-settings'] !== true) {
    return false;
  }
  try {
    const command = parseVoiceSettingsCommand(values);
    await modifySettings(current => applyVoiceSettingsCommand(current, command));
    console.log('ok');
  } catch (error) {
    console.error(`error: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')}`);
    process.exitCode = 1;
  }
  return true;
}

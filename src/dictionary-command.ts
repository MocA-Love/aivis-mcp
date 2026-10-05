/**
 * `--set-dictionary` / `--clear-dictionary`: Para Code などから辞書を設定・解除する口。
 *
 * 出力は機械が読める 1 行。成功は標準出力に `ok`、失敗は標準エラーに `error: <理由>` と終了コード 1。
 * API は叩かない（形だけ確かめて config.json に書く）。worker は発話ごとに設定を読み直すので再起動は要らない。
 */

import type { ArgValue } from './config.js';
import { isTtsProvider, updateSettings, type SettingsPatch, type TtsProvider } from './settings.js';
import { isElevenLabsId, isUuid } from './services/dictionaries.js';

/** 辞書の設定（id が undefined なら解除）を config.json の変更にする。辞書を替えたら前の版は消す。 */
export function dictionaryPatch(provider: TtsProvider, id: string | undefined, versionId?: string): SettingsPatch {
  if (provider === 'elevenlabs') {
    return {
      elevenlabs: {
        pronunciationDictionaryId: id ?? null,
        pronunciationDictionaryVersionId: id === undefined ? null : versionId ?? null,
      },
    };
  }
  return { aivis: { userDictionaryUuid: id ?? null } };
}

export class DictionaryCommandError extends Error {}

/** 引数を確かめて config.json の変更にする（書かない）。 */
export function parseDictionaryCommand(values: Record<string, ArgValue>): SettingsPatch {
  const set = values['set-dictionary'] === true;
  const clear = values['clear-dictionary'] === true;
  if (set && clear) {
    throw new DictionaryCommandError('--set-dictionary と --clear-dictionary は同時に使えません');
  }
  const provider = values.provider;
  if (!isTtsProvider(provider)) {
    throw new DictionaryCommandError('--provider に elevenlabs か aivis を指定してください');
  }
  if (clear) {
    if (values.id !== undefined || values['version-id'] !== undefined) {
      throw new DictionaryCommandError('--clear-dictionary には --id / --version-id を付けません');
    }
    return dictionaryPatch(provider, undefined);
  }
  const id = typeof values.id === 'string' ? values.id.trim() : '';
  if (id === '') {
    throw new DictionaryCommandError('--id に辞書の ID を指定してください');
  }
  const versionValue = values['version-id'];
  if (versionValue !== undefined && (typeof versionValue !== 'string' || versionValue.trim() === '')) {
    throw new DictionaryCommandError('--version-id に版の ID を指定してください');
  }
  const versionId = typeof versionValue === 'string' ? versionValue.trim() : undefined;
  if (provider === 'aivis') {
    if (versionId !== undefined) {
      throw new DictionaryCommandError('--version-id は --provider elevenlabs のときだけ使えます');
    }
    if (!isUuid(id)) {
      throw new DictionaryCommandError(`Aivis のユーザー辞書の UUID の形ではありません: ${id}`);
    }
    return dictionaryPatch('aivis', id);
  }
  if (!isElevenLabsId(id)) {
    throw new DictionaryCommandError(`ElevenLabs の発音辞書の ID の形ではありません: ${id}`);
  }
  if (versionId !== undefined && !isElevenLabsId(versionId)) {
    throw new DictionaryCommandError(`ElevenLabs の発音辞書の版の ID の形ではありません: ${versionId}`);
  }
  return dictionaryPatch('elevenlabs', id, versionId);
}

/**
 * `--set-dictionary` / `--clear-dictionary` が指定されていれば実行して true を返す（終了コードは `process.exitCode`）。
 */
export async function runDictionaryCommand(values: Record<string, ArgValue>): Promise<boolean> {
  if (values['set-dictionary'] !== true && values['clear-dictionary'] !== true) {
    return false;
  }
  try {
    await updateSettings(parseDictionaryCommand(values));
    console.log('ok');
  } catch (error) {
    console.error(`error: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')}`);
    process.exitCode = 1;
  }
  return true;
}

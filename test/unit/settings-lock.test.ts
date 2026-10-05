import fs from 'fs';
import os from 'os';
import path from 'path';
import { gainLockPath } from '../../src/audio/gain-table.js';
import { loadSettings, loadSettingsWithMigration, SettingsLockError, updateSettings } from '../../src/settings.js';
import { resolveConfig } from '../../src/config.js';

describe('設定ファイルの書き込み', () => {
  let dir: string;
  let previous: string | undefined;
  let configFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-settings-lock-'));
    configFile = path.join(dir, 'config.json');
    previous = process.env.AIVIS_CONFIG_FILE;
    process.env.AIVIS_CONFIG_FILE = configFile;
  });

  afterEach(() => {
    process.env.AIVIS_CONFIG_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('入れ子の項目は null で消し、undefined は残す。同時に書いても互いの変更を消さない', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ elevenlabs: { apiKey: 'k', pronunciationDictionaryId: 'd', pronunciationDictionaryVersionId: 'v' } }));
    await Promise.all([
      updateSettings({ elevenlabs: { pronunciationDictionaryVersionId: null } }),
      updateSettings({ aivis: { userDictionaryUuid: 'u' } }),
      updateSettings({ elevenlabs: { contextWindowMinutes: 3 } }),
    ]);
    expect(loadSettings()).toEqual({ elevenlabs: { apiKey: 'k', pronunciationDictionaryId: 'd', contextWindowMinutes: 3 }, aivis: { userDictionaryUuid: 'u' } });
    expect(fs.existsSync(gainLockPath(configFile))).toBe(false);
  });

  test('ロックが空かなければ書かずにエラーにする。読み替えは書かずに今回の値を使う', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ elevenlabs: { volumeDb: -10 } }));
    fs.writeFileSync(gainLockPath(configFile), 'someone');
    const before = fs.readFileSync(configFile, 'utf8');
    // 読み替えは書けなくても今回の値を返す
    expect(loadSettingsWithMigration().elevenlabs?.volumeOffsetDb).toBe(3);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    const { withFileLock } = await import('../../src/audio/gain-table.js');
    await expect(withFileLock(configFile, () => undefined, { waitMs: 50, lockError: lockPath => new SettingsLockError(lockPath) })).rejects.toBeInstanceOf(SettingsLockError);
    fs.rmSync(gainLockPath(configFile));
    loadSettingsWithMigration();
    expect(loadSettings().elevenlabs?.volumeMigrated).toBe(true);
  });

  test('config.json が壊れていたら書かずにエラーにする（既存の設定を変更分だけで上書きしない）', async () => {
    for (const broken of ['{ "apiKey": "k", }', '[]', 'null']) {
      fs.writeFileSync(configFile, broken);
      await expect(updateSettings({ aivis: { userDictionaryUuid: 'u' } })).rejects.toThrow('書きません');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(broken);
    }
    fs.rmSync(configFile);
    await updateSettings({ aivis: { userDictionaryUuid: 'u' } });
    expect(loadSettings()).toEqual({ aivis: { userDictionaryUuid: 'u' } });
    expect(fs.existsSync(gainLockPath(configFile))).toBe(false);
  });

  test('config.json の辞書と文脈の時間を読む（版は辞書があるときだけ）', () => {
    fs.writeFileSync(configFile, JSON.stringify({
      elevenlabs: { contextWindowMinutes: 2, pronunciationDictionaryId: ' d ', pronunciationDictionaryVersionId: 'v' },
      aivis: { userDictionaryUuid: 'u' },
    }));
    const config = resolveConfig({});
    expect([config.elevenLabsContextWindowMinutes, config.elevenLabsPronunciationDictionaryId, config.elevenLabsPronunciationDictionaryVersionId, config.aivisUserDictionaryUuid])
      .toEqual([2, 'd', 'v', 'u']);
    fs.writeFileSync(configFile, JSON.stringify({ elevenlabs: { pronunciationDictionaryVersionId: 'v' } }));
    expect(resolveConfig({}).elevenLabsPronunciationDictionaryVersionId).toBeUndefined();
    expect(resolveConfig({}).elevenLabsContextWindowMinutes).toBe(5);
  });
});

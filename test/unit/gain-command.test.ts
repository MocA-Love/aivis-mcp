import fs from 'fs';
import os from 'os';
import path from 'path';
import { gainLockPath, INITIAL_GAIN_DB } from '../../src/audio/gain-table.js';
import { applyGainLearningPatch, GainCommandError, listGains, parseGainLearningCommand, resetGain } from '../../src/gain-command.js';

describe('音量の表の一覧・行の消去・覚え直し方', () => {
  let dir: string;
  let gainFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-gain-command-'));
    gainFile = path.join(dir, 'gain.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('一覧は学習済みの行と最初の値の行を合わせ、測定の数と時刻を出す', () => {
    const initialKey = 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default';
    const list = listGains({
      [initialKey]: { db: 2, samples: [1, 2, 3], updatedAt: 10 },
      'elevenlabs:voiceZ:eleven_v3': { db: -1, samples: [-1] },
    }, { learnWindow: 9, minLearnSeconds: 2.5 });
    expect({ ...list, entries: undefined }).toEqual({ version: 1, target: -20, learnWindow: 9, minLearnSeconds: 2.5, entries: undefined });
    expect(list.entries).toHaveLength(Object.keys(INITIAL_GAIN_DB).length + 1);
    expect(list.entries.map(entry => entry.key)).toEqual([...list.entries.map(entry => entry.key)].sort());
    expect([
      list.entries.find(entry => entry.key === initialKey),
      list.entries.find(entry => entry.key === 'elevenlabs:voiceZ:eleven_v3'),
      list.entries.find(entry => entry.key === 'aivis:f13c2ec8-1069-403f-a23e-503b3a270c57:default'),
    ]).toEqual([
      { key: initialKey, provider: 'aivis', voice: 'a670e6b8-0852-45b2-8704-1bc9862f2fe6', model: 'default', gainDb: 2, sampleCount: 3, updatedAt: 10 },
      { key: 'elevenlabs:voiceZ:eleven_v3', provider: 'elevenlabs', voice: 'voiceZ', model: 'eleven_v3', gainDb: -1, sampleCount: 1, updatedAt: null },
      { key: 'aivis:f13c2ec8-1069-403f-a23e-503b3a270c57:default', provider: 'aivis', voice: 'f13c2ec8-1069-403f-a23e-503b3a270c57', model: 'default', gainDb: 4.9, sampleCount: 0, updatedAt: null },
    ]);
  });

  test('行を消すとほかの行は残り、ロックも残さない。無い行・無い表は書かずに false', async () => {
    fs.writeFileSync(gainFile, JSON.stringify({ version: 1, target: -20, entries: { 'elevenlabs:a:m': { db: 1, samples: [1], updatedAt: 1 }, 'elevenlabs:b:m': { db: 2, samples: [2], updatedAt: 2 } } }));
    expect(await resetGain('elevenlabs:a:m', gainFile)).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(gainFile, 'utf8')).entries)).toEqual(['elevenlabs:b:m']);
    const before = fs.readFileSync(gainFile, 'utf8');
    expect(await resetGain('elevenlabs:a:m', gainFile)).toBe(false);
    expect(fs.readFileSync(gainFile, 'utf8')).toBe(before);
    expect(await resetGain('elevenlabs:a:m', path.join(dir, 'none.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'none.json'))).toBe(false);
    expect(fs.existsSync(gainLockPath(gainFile))).toBe(false);
  });

  test('壊れた表・形の違う鍵は書かずに拒む', async () => {
    fs.writeFileSync(gainFile, '{broken');
    await expect(resetGain('elevenlabs:a:m', gainFile)).rejects.toBeInstanceOf(GainCommandError);
    expect(fs.readFileSync(gainFile, 'utf8')).toBe('{broken');
    for (const key of ['nocolon', 'a:b', 'a:b:', 'a b:c:d', `a:${'x'.repeat(300)}:m`]) {
      await expect(resetGain(key, gainFile)).rejects.toBeInstanceOf(GainCommandError);
    }
  });

  test('覚え直し方の範囲を確かめ、gain のほかの項目は残す', () => {
    expect(parseGainLearningCommand({ window: '15' })).toEqual({ learnWindow: 15 });
    expect(parseGainLearningCommand({ 'min-seconds': '0.5', window: '1' })).toEqual({ learnWindow: 1, minLearnSeconds: 0.5 });
    for (const values of [{}, { window: '0' }, { window: '51' }, { window: '2.5' }, { 'min-seconds': '0.4' }, { 'min-seconds': '31' }, { window: true }]) {
      expect(() => parseGainLearningCommand(values)).toThrow(GainCommandError);
    }
    expect(applyGainLearningPatch({ apiKey: 'k', gain: { learnWindow: 9, minLearnSeconds: 3 } }, { learnWindow: 5 }))
      .toEqual({ apiKey: 'k', gain: { learnWindow: 5, minLearnSeconds: 3 } });
  });
});

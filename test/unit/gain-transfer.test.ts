import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadLearnedGains, saveLearnedGains, type LearnedGain } from '../../src/audio/gain-table.js';
import { exportGains, GainImportError, importGains, parseGainFile, selectGainEntries } from '../../src/audio/gain-transfer.js';

const table: Record<string, LearnedGain> = {
  'elevenlabs:voiceA:eleven_v3': { db: -3, samples: [-3, -2, -4], updatedAt: 10 },
  'elevenlabs:voiceA:eleven_v4_turbo': { db: 1, samples: [1], updatedAt: 11 },
  'elevenlabs:voiceB:eleven_v3': { db: -5, samples: [-5], updatedAt: 12 },
  'aivis:model-1:default': { db: 4, samples: [4, 4], updatedAt: 13 },
};

describe('音量の表の書き出し・読み込み', () => {
  let dir: string;
  let gainFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-gain-transfer-'));
    gainFile = path.join(dir, 'gain.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('書き出しは声・モデルで絞り込める', () => {
    expect(Object.keys(selectGainEntries(table).entries)).toEqual(Object.keys(table).sort());
    expect(Object.keys(selectGainEntries(table, { voices: ['voiceA'] }).entries)).toEqual(['elevenlabs:voiceA:eleven_v3', 'elevenlabs:voiceA:eleven_v4_turbo']);
    expect(Object.keys(selectGainEntries(table, { model: 'eleven_v3' }).entries)).toEqual(['elevenlabs:voiceA:eleven_v3', 'elevenlabs:voiceB:eleven_v3']);
    expect(Object.keys(selectGainEntries(table, { voices: ['voiceA', 'model-1'], model: 'default' }).entries)).toEqual(['aivis:model-1:default']);

    saveLearnedGains(table, gainFile);
    const out = path.join(dir, 'out', 'export.json');
    expect(exportGains(out, { voices: ['voiceB'] }, gainFile)).toBe(1);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({ version: 1, target: -20, entries: { 'elevenlabs:voiceB:eleven_v3': table['elevenlabs:voiceB:eleven_v3'] } });
  });

  test('読み込みは足し込み。既定は自分の値を残し、--overwrite で上書きする', () => {
    saveLearnedGains({ 'elevenlabs:voiceA:eleven_v3': { db: 0, samples: [0], updatedAt: 20 } }, gainFile);
    const input = path.join(dir, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ version: 1, target: -20, entries: table }));

    expect(importGains(input, false, gainFile)).toEqual({ added: 3, overwritten: 0, kept: 1 });
    const kept = loadLearnedGains(gainFile);
    expect(kept['elevenlabs:voiceA:eleven_v3']).toEqual({ db: 0, samples: [0], updatedAt: 20 });
    // samples ごと入る
    expect(kept['aivis:model-1:default']).toEqual(table['aivis:model-1:default']);

    expect(importGains(input, true, gainFile)).toEqual({ added: 0, overwritten: 4, kept: 0 });
    expect({ ...loadLearnedGains(gainFile) }).toEqual(table);
  });

  test('読み込みはシンボリックリンクを壊さず、一時ファイルを残さない', () => {
    const real = path.join(dir, 'real.json');
    saveLearnedGains({}, real);
    fs.symlinkSync(real, gainFile);
    const input = path.join(dir, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ version: 1, target: -20, entries: { 'aivis:m:default': { db: 2, samples: [2] } } }));
    importGains(input, false, gainFile);
    expect(fs.lstatSync(gainFile).isSymbolicLink()).toBe(true);
    expect(Object.keys(loadLearnedGains(real))).toEqual(['aivis:m:default']);
    expect(fs.readdirSync(dir).sort()).toEqual(['gain.json', 'in.json', 'real.json']);
  });

  test('target が違うファイルは拒み、表を書き換えない', () => {
    saveLearnedGains({ 'aivis:m:default': { db: 1, samples: [1], updatedAt: 1 } }, gainFile);
    const before = fs.readFileSync(gainFile, 'utf8');
    const input = path.join(dir, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ version: 1, target: -23, entries: table }));
    expect(() => importGains(input, true, gainFile)).toThrow(GainImportError);
    expect(() => importGains(input, true, gainFile)).toThrow(/target/);
    expect(fs.readFileSync(gainFile, 'utf8')).toBe(before);
  });

  test('壊れたファイル・形の違うファイルは丸ごと拒む', () => {
    const cases: string[] = [
      '{broken',
      '[]',
      JSON.stringify({ version: 2, target: -20, entries: {} }),
      JSON.stringify({ version: 1, entries: {} }),
      JSON.stringify({ version: 1, target: -20 }),
      JSON.stringify({ version: 1, target: -20, entries: { 'aivis:ok:default': { db: 1, samples: [1] }, 'no-colon': { db: 1, samples: [1] } } }),
      JSON.stringify({ version: 1, target: -20, entries: { 'aivis:ok:default': { db: 'x', samples: [1] } } }),
      JSON.stringify({ version: 1, target: -20, entries: { 'aivis:ok:default': { db: 1, samples: [1, null] } } }),
      JSON.stringify({ version: 1, target: -20, entries: { 'aivis:ok:default': { db: 1, samples: [1], updatedAt: 'x' } } }),
      '{"version":1,"target":-20,"entries":{"__proto__":{"db":1,"samples":[1]}}}',
    ];
    for (const text of cases) {
      expect(() => parseGainFile(text)).toThrow(GainImportError);
    }
    expect(() => importGains(path.join(dir, 'missing.json'), false, gainFile)).toThrow(GainImportError);
    expect(fs.existsSync(gainFile)).toBe(false);
  });

  test('値は表の範囲に収める', () => {
    const parsed = parseGainFile(JSON.stringify({ version: 1, target: -20, entries: { 'aivis:m:default': { db: 50, samples: [50, -99] } } }));
    expect(parsed['aivis:m:default']).toEqual({ db: 8, samples: [8, -30] });
  });
});

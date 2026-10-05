import fs from 'fs';
import os from 'os';
import path from 'path';
import { gainLockPath, GainLockError, writeFileAtomic, loadLearnedGains, MAX_LEARNED_ENTRIES, recordMeasurement, saveLearnedGains, withGainFileLock, type LearnedGain } from '../../src/audio/gain-table.js';
import { exportGains, GainImportError, importGains, mergeGainEntries, parseGainFile, selectGainEntries } from '../../src/audio/gain-transfer.js';

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

  test('書き出し先が自分の表そのもの（シンボリックリンク経由を含む）なら拒む', () => {
    saveLearnedGains(table, gainFile);
    const before = fs.readFileSync(gainFile, 'utf8');
    expect(() => exportGains(gainFile, { voices: ['voiceA'] }, gainFile)).toThrow(/音量の表そのもの/);
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(gainFile, link);
    expect(() => exportGains(link, {}, gainFile)).toThrow(GainImportError);
    expect(() => exportGains(path.join(dir, '.', 'gain.json'), {}, gainFile)).toThrow(GainImportError);
    expect(fs.readFileSync(gainFile, 'utf8')).toBe(before);
  });

  test('読み込みは足し込み。既定は自分の値を残し、--overwrite で上書きする', async () => {
    saveLearnedGains({ 'elevenlabs:voiceA:eleven_v3': { db: 0, samples: [0], updatedAt: 20 } }, gainFile);
    const input = path.join(dir, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ version: 1, target: -20, entries: table }));

    const startedAt = Date.now();
    expect(await importGains(input, false, gainFile)).toEqual({ added: 3, overwritten: 0, kept: 1, dropped: 0, evicted: 0 });
    const kept = loadLearnedGains(gainFile);
    expect(kept['elevenlabs:voiceA:eleven_v3']).toEqual({ db: 0, samples: [0], updatedAt: 20 });
    // samples ごと入り、更新時刻は取り込んだ時刻にする
    expect(kept['aivis:model-1:default']).toEqual({ db: 4, samples: [4, 4], updatedAt: expect.any(Number) });
    expect(kept['aivis:model-1:default'].updatedAt).toBeGreaterThanOrEqual(startedAt);

    expect(await importGains(input, true, gainFile)).toEqual({ added: 0, overwritten: 4, kept: 0, dropped: 0, evicted: 0 });
    const replaced = loadLearnedGains(gainFile);
    expect(Object.fromEntries(Object.entries(replaced).map(([key, entry]) => [key, { db: entry.db, samples: entry.samples }])))
      .toEqual(Object.fromEntries(Object.entries(table).map(([key, entry]) => [key, { db: entry.db, samples: entry.samples }])));
  });

  test('上限で刈り込んでも取り込んだ行は残し、落ちた行と押し出した行を数える', () => {
    const current: Record<string, LearnedGain> = {};
    for (let i = 0; i < MAX_LEARNED_ENTRIES; i++) {
      current[`aivis:old${i}:default`] = { db: 1, samples: [1], updatedAt: 1000 + i };
    }
    const incoming: Record<string, LearnedGain> = {
      'aivis:new1:default': { db: 2, samples: [2], updatedAt: 1 },
      'aivis:new2:default': { db: 2, samples: [2] },
      'aivis:old5:default': { db: 3, samples: [3], updatedAt: 1 },
    };
    const kept = mergeGainEntries(current, incoming, false, 9_999_999);
    expect(kept.result).toEqual({ added: 2, overwritten: 0, kept: 1, dropped: 0, evicted: 2 });
    expect(kept.entries['aivis:new1:default']).toEqual({ db: 2, samples: [2], updatedAt: 9_999_999 });
    // 更新の古い自分の行（old0, old1）から押し出される
    expect(kept.entries['aivis:old0:default']).toBeUndefined();
    expect(kept.entries['aivis:old1:default']).toBeUndefined();

    // 取り込む行だけで上限を超えるときは、入らなかった分を数える
    const many: Record<string, LearnedGain> = {};
    for (let i = 0; i < MAX_LEARNED_ENTRIES + 3; i++) {
      many[`aivis:many${i}:default`] = { db: 0, samples: [0] };
    }
    const overflow = mergeGainEntries({}, many, false);
    expect(overflow.result).toEqual({ added: MAX_LEARNED_ENTRIES, overwritten: 0, kept: 0, dropped: 3, evicted: 0 });
    expect(Object.keys(overflow.entries)).toHaveLength(MAX_LEARNED_ENTRIES);
  });

  test('読み込みはシンボリックリンクを壊さず、一時ファイルを残さない', async () => {
    const real = path.join(dir, 'real.json');
    saveLearnedGains({}, real);
    fs.symlinkSync(real, gainFile);
    const input = path.join(dir, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ version: 1, target: -20, entries: { 'aivis:m:default': { db: 2, samples: [2] } } }));
    await importGains(input, false, gainFile);
    expect(fs.lstatSync(gainFile).isSymbolicLink()).toBe(true);
    expect(Object.keys(loadLearnedGains(real))).toEqual(['aivis:m:default']);
    expect(fs.readdirSync(dir).sort()).toEqual(['gain.json', 'in.json', 'real.json']);
  });

  test('target が違うファイルは拒み、表を書き換えない', async () => {
    saveLearnedGains({ 'aivis:m:default': { db: 1, samples: [1], updatedAt: 1 } }, gainFile);
    const before = fs.readFileSync(gainFile, 'utf8');
    const input = path.join(dir, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ version: 1, target: -23, entries: table }));
    await expect(importGains(input, true, gainFile)).rejects.toThrow(GainImportError);
    await expect(importGains(input, true, gainFile)).rejects.toThrow(/target/);
    expect(fs.readFileSync(gainFile, 'utf8')).toBe(before);
  });

  test('壊れたファイル・形の違うファイルは丸ごと拒む', async () => {
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
    await expect(importGains(path.join(dir, 'missing.json'), false, gainFile)).rejects.toThrow(GainImportError);
    expect(fs.existsSync(gainFile)).toBe(false);
  });

  test('値は表の範囲に収める', () => {
    const parsed = parseGainFile(JSON.stringify({ version: 1, target: -20, entries: { 'aivis:m:default': { db: 50, samples: [50, -99] } } }));
    expect(parsed['aivis:m:default']).toEqual({ db: 8, samples: [8, -30] });
  });

  describe('表のロック', () => {
    test('worker の覚え直しと読み込みが同時に走っても、どちらの書き込みも消えない', async () => {
      saveLearnedGains({}, gainFile);
      const input = path.join(dir, 'in.json');
      fs.writeFileSync(input, JSON.stringify({ version: 1, target: -20, entries: table }));
      const learns = Array.from({ length: 10 }, (_, i) => recordMeasurement(`aivis:learn${i}:default`, -22, gainFile));
      await Promise.all([...learns, importGains(input, false, gainFile)]);
      expect(Object.keys(loadLearnedGains(gainFile)).sort()).toEqual([
        ...Object.keys(table),
        ...Array.from({ length: 10 }, (_, i) => `aivis:learn${i}:default`),
      ].sort());
      expect(fs.existsSync(gainLockPath(gainFile))).toBe(false);
    });

    test('持ち主のいる新しいロックは待ち、空かなければ諦める', async () => {
      fs.writeFileSync(gainLockPath(gainFile), 'someone');
      await expect(withGainFileLock(gainFile, () => 1, { waitMs: 150 })).rejects.toThrow(GainLockError);
      // 他人のロックは消さない
      expect(fs.readFileSync(gainLockPath(gainFile), 'utf8')).toBe('someone');
      setTimeout(() => fs.rmSync(gainLockPath(gainFile), { force: true }), 100);
      await expect(withGainFileLock(gainFile, () => 2, { waitMs: 2000 })).resolves.toBe(2);
      expect(fs.existsSync(gainLockPath(gainFile))).toBe(false);
    });

    test('古いロック（持ち主が落ちた）は消して取り直す', async () => {
      const lock = gainLockPath(gainFile);
      fs.writeFileSync(lock, 'crashed');
      const old = new Date(Date.now() - 11_000);
      fs.utimesSync(lock, old, old);
      await expect(withGainFileLock(gainFile, () => 'ok', { waitMs: 100 })).resolves.toBe('ok');
      expect(fs.existsSync(lock)).toBe(false);
    });

    test('指し先がまだ無いリンクでも、ロックの置き場は書く前後で変わらず、リンクも残る', async () => {
      const real = path.join(dir, 'sub', 'real.json');
      fs.mkdirSync(path.dirname(real));
      fs.symlinkSync(path.join('sub', 'real.json'), gainFile);
      const before = gainLockPath(gainFile);
      expect(before).toBe(`${fs.realpathSync(path.dirname(real))}/real.json.lock`);
      await recordMeasurement('aivis:x:default', -22, gainFile);
      expect(fs.lstatSync(gainFile).isSymbolicLink()).toBe(true);
      expect(Object.keys(loadLearnedGains(real))).toEqual(['aivis:x:default']);
      expect(gainLockPath(gainFile)).toBe(before);
      // writeFileAtomic も、指し先の無いリンクを普通のファイルで置き換えない
      const link = path.join(dir, 'dangling.json');
      fs.symlinkSync('missing.json', link);
      writeFileAtomic(link, 'x', 0o644);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'missing.json'), 'utf8')).toBe('x');
    });

    test('ロックはシンボリックリンクの実体の隣に置く', () => {
      const real = path.join(dir, 'real.json');
      fs.writeFileSync(real, '{}');
      fs.symlinkSync(real, gainFile);
      expect(gainLockPath(gainFile)).toBe(`${fs.realpathSync(real)}.lock`);
    });
  });
});

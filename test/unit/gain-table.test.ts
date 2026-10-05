import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afplayVolume, buildGainTable, writeFileAtomic, finalGainDb, INITIAL_GAIN_DB, isLearnable, learnSample, legacyElevenLabsVolumeToOffset,
  loadLearnedGains, MAX_LEARNED_ENTRIES, median, pruneLearnedGains, saveLearnedGains, migrateVolumeSettings, recordMeasurement, resolveGainDb, voiceFilter, type VolumeMigrationInput,
} from '../../src/audio/gain-table.js';

describe('gain table', () => {
  test('最初の値は 目標 -20 − 実測', () => {
    expect(INITIAL_GAIN_DB['aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default']).toBe(4.1);
    expect(INITIAL_GAIN_DB['elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_v4_turbo']).toBe(-7.4);
    expect(INITIAL_GAIN_DB['elevenlabs:wdu0pCCtM4iELsmsPURL:eleven_v4_turbo']).toBe(1.4);
    expect(Object.keys(INITIAL_GAIN_DB)).toHaveLength(18);
  });

  test('知らない組は同じモデルの平均、それも無ければ 0dB', () => {
    expect(resolveGainDb('aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default', {})).toBe(4.1);
    // Aivis 3 声の平均 (4.1 + 4.9 + 4.5) / 3
    expect(resolveGainDb('aivis:unknown-model:default', {})).toBe(4.5);
    // v3 の 5 声の平均 (-10.4 - 5.1 - 3.1 - 2.1 - 2.5) / 5 = -4.64
    expect(resolveGainDb('elevenlabs:unknown:eleven_v3', {})).toBe(-4.6);
    expect(resolveGainDb('elevenlabs:unknown:eleven_multilingual_v2', {})).toBe(0);
    expect(resolveGainDb(undefined, {})).toBe(0);
    expect(resolveGainDb('broken', {})).toBe(0);
  });

  test('覚えた値は最初の値より優先し、平均にも入る', () => {
    const learned = { 'elevenlabs:newvoice:eleven_v3': { db: -1, samples: [-1] } };
    expect(resolveGainDb('elevenlabs:newvoice:eleven_v3', learned)).toBe(-1);
    expect(buildGainTable(learned)['elevenlabs:newvoice:eleven_v3']).toBe(-1);
    expect(resolveGainDb('elevenlabs:other:eleven_v3', learned)).toBe(-4.0);
  });

  test('覚え直しは直近 5 回の中央値', () => {
    let entry = learnSample(undefined, -24);
    expect(entry).toEqual({ db: 4, samples: [4], updatedAt: expect.any(Number) });
    for (const lufs of [-30, -22, -21, -19, -10]) {
      entry = learnSample(entry, lufs);
    }
    // 直近 5 回 = [10→clamp 8, 2, 1, -1, -10]
    expect(entry.samples).toEqual([8, 2, 1, -1, -10]);
    expect(entry.db).toBe(1);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test('感情タグ入り・1.5 秒未満・途中で止まったものは覚え直しに使わない', () => {
    expect(isLearnable({ tagged: false, durationSeconds: 2, completed: true })).toBe(true);
    expect(isLearnable({ tagged: true, durationSeconds: 2, completed: true })).toBe(false);
    expect(isLearnable({ tagged: false, durationSeconds: 1.4, completed: true })).toBe(false);
    expect(isLearnable({ tagged: false, durationSeconds: 2, completed: false })).toBe(false);
    expect(isLearnable({ tagged: false, durationSeconds: undefined, completed: true })).toBe(false);
    expect(isLearnable({ tagged: false, durationSeconds: 2, completed: true, measuredLufs: -70.5 })).toBe(false);
  });

  test('最後の合計にも +8dB の上限を掛ける', () => {
    expect(finalGainDb(4.1, 0, 0)).toBe(4.1);
    expect(finalGainDb(4.9, 3, 2)).toBe(8);
    expect(finalGainDb(-7.4, -6)).toBe(-13.4);
    expect(finalGainDb(undefined, Number.NaN)).toBe(0);
  });

  test('当て方と afplay の音量', () => {
    expect(voiceFilter(4.1)).toBe('volume=4.1dB,alimiter=limit=0.89:level=false');
    expect(voiceFilter(-7.4)).toBe('volume=-7.4dB,alimiter=limit=0.89:level=false');
    expect(afplayVolume(6)).toBe(1);
    expect(afplayVolume(-20)).toBeCloseTo(0.1, 5);
  });

  test('表はファイルに書いて読み直せる。壊れていれば空', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-gain-'));
    const file = path.join(dir, 'nested', 'gain.json');
    try {
      expect({ ...loadLearnedGains(file) }).toEqual({});
      recordMeasurement('aivis:x:default', -25, file);
      recordMeasurement('aivis:x:default', -23, file);
      expect({ ...loadLearnedGains(file) }).toEqual({ 'aivis:x:default': { db: 4, samples: [5, 3], updatedAt: expect.any(Number) } });
      fs.writeFileSync(file, '{broken');
      expect({ ...loadLearnedGains(file) }).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('volume_db の読み替え', () => {
  test('今の値 − 旧既定の -13 を上乗せにする', () => {
    expect(legacyElevenLabsVolumeToOffset(-13)).toBe(0);
    expect(legacyElevenLabsVolumeToOffset(-16)).toBe(-3);
    expect(legacyElevenLabsVolumeToOffset(-10)).toBe(3);
  });

  test('1 回だけ読み替えて印を残す', () => {
    const input: VolumeMigrationInput & { provider: string } = { provider: 'elevenlabs', elevenlabs: { volumeDb: -16 } };
    const first = migrateVolumeSettings(input);
    expect(first.changed).toBe(true);
    expect(first.settings.elevenlabs).toEqual({ volumeDb: -16, volumeOffsetDb: -3, volumeMigrated: true });
    const second = migrateVolumeSettings({ ...first.settings, elevenlabs: { ...first.settings.elevenlabs, volumeDb: -20 } });
    expect(second.changed).toBe(false);
    expect(second.settings.elevenlabs?.volumeOffsetDb).toBe(-3);
  });

  test('volume_db が無ければ何もしない', () => {
    expect(migrateVolumeSettings({}).changed).toBe(false);
    expect(migrateVolumeSettings({ elevenlabs: { apiKey: 'k' } as { volumeDb?: number } }).changed).toBe(false);
  });
});

describe('表の大きさと鍵', () => {
  test('上限を超えたら更新の古いものから消す', () => {
    const entries: Record<string, { db: number; samples: number[]; updatedAt: number }> = {};
    for (let i = 0; i < MAX_LEARNED_ENTRIES + 5; i++) {
      entries[`aivis:v${i}:default`] = { db: 1, samples: [1], updatedAt: i };
    }
    const pruned = pruneLearnedGains(entries);
    expect(Object.keys(pruned)).toHaveLength(MAX_LEARNED_ENTRIES);
    expect(pruned['aivis:v0:default']).toBeUndefined();
    expect(pruned[`aivis:v${MAX_LEARNED_ENTRIES + 4}:default`]).toBeDefined();
  });

  test('__proto__ のような鍵で Object の性質を書き換えない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-gain-'));
    const file = path.join(dir, 'gain.json');
    try {
      fs.writeFileSync(file, '{"version":1,"target":-20,"entries":{"__proto__":{"db":5,"samples":[5]},"constructor":{"db":2,"samples":[2]}}}');
      const learned = loadLearnedGains(file);
      expect(Object.keys(learned)).toEqual(['constructor']);
      expect(({} as Record<string, unknown>).db).toBeUndefined();
      expect(resolveGainDb('toString', learned)).toBe(0);
      saveLearnedGains(learned, file);
      expect(fs.readdirSync(dir)).toEqual(['gain.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeFileAtomic', () => {
  test('シンボリックリンクは壊さず、実体を書き換える', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-atomic-'));
    try {
      const real = path.join(dir, 'real.json');
      const link = path.join(dir, 'link.json');
      fs.writeFileSync(real, 'old');
      fs.symlinkSync(real, link);
      writeFileAtomic(link, 'new', 0o600);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(real, 'utf8')).toBe('new');
      expect(fs.readdirSync(dir).sort()).toEqual(['link.json', 'real.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


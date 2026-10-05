import fs from 'fs';
import os from 'os';
import path from 'path';
import { LEARN_WINDOW, MIN_LEARN_SECONDS, resolveGainLearningSettings } from '../../src/audio/gain-table.js';
import { resolveConfig } from '../../src/config.js';

describe('覚え直しの窓と最短秒数', () => {
  test('既定は窓 9・2.5 秒', () => {
    expect([LEARN_WINDOW, MIN_LEARN_SECONDS]).toEqual([9, 2.5]);
    expect(resolveGainLearningSettings({ learnWindow: [], minLearnSeconds: [] })).toEqual({ learnWindow: 9, minLearnSeconds: 2.5 });
  });

  test('先に値がある候補を使い、範囲外は既定に戻して警告する', () => {
    const warnings: string[] = [];
    const result = resolveGainLearningSettings({
      learnWindow: [{ source: 'env', value: undefined }, { source: 'config', value: 15 }],
      minLearnSeconds: [{ source: 'env', value: '3' }, { source: 'config', value: 1 }],
    }, message => warnings.push(message));
    expect(result).toEqual({ learnWindow: 15, minLearnSeconds: 3 });
    expect(warnings).toEqual([]);

    const bad = resolveGainLearningSettings({
      learnWindow: [{ source: 'env', value: '51' }, { source: 'config', value: 3 }],
      minLearnSeconds: [{ source: 'config', value: 0.4 }],
    }, message => warnings.push(message));
    expect(bad).toEqual({ learnWindow: 9, minLearnSeconds: 2.5 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('env の learnWindow=51');

    for (const value of [0, 2.5, 'abc', Number.NaN, '7x']) {
      expect(resolveGainLearningSettings({ learnWindow: [{ source: 's', value }], minLearnSeconds: [] }, () => undefined).learnWindow).toBe(9);
    }
    for (const value of [1, 50, '1', ' 50 ']) {
      expect(resolveGainLearningSettings({ learnWindow: [{ source: 's', value }], minLearnSeconds: [] }, () => undefined).learnWindow).toBe(Number(String(value).trim()));
    }
    expect(resolveGainLearningSettings({ learnWindow: [], minLearnSeconds: [{ source: 's', value: 30.5 }] }, () => undefined).minLearnSeconds).toBe(2.5);
    expect(resolveGainLearningSettings({ learnWindow: [], minLearnSeconds: [{ source: 's', value: 0.5 }] }, () => undefined).minLearnSeconds).toBe(0.5);
  });

  describe('resolveConfig の優先順（環境変数 > config.json > 既定）', () => {
    const saved = { ...process.env };
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-gain-settings-'));
      process.env.AIVIS_CONFIG_FILE = path.join(dir, 'config.json');
      delete process.env.AIVIS_GAIN_LEARN_WINDOW;
      delete process.env.AIVIS_GAIN_MIN_LEARN_SECONDS;
    });

    afterEach(() => {
      process.env = { ...saved };
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function resolved(): [number, number] {
      const config = resolveConfig({});
      return [config.gainLearnWindow, config.gainMinLearnSeconds];
    }

    test('config.json の値を発話ごとに読み直し、環境変数が勝つ', () => {
      expect(resolved()).toEqual([9, 2.5]);
      fs.writeFileSync(process.env.AIVIS_CONFIG_FILE!, JSON.stringify({ gain: { learnWindow: 5, minLearnSeconds: 1.5 } }));
      expect(resolved()).toEqual([5, 1.5]);
      process.env.AIVIS_GAIN_LEARN_WINDOW = '12';
      expect(resolved()).toEqual([12, 1.5]);
      process.env.AIVIS_GAIN_MIN_LEARN_SECONDS = '4';
      expect(resolved()).toEqual([12, 4]);
    });

    test('範囲外の config.json は既定に戻す', () => {
      const original = console.error;
      const messages: string[] = [];
      console.error = (message: string) => { messages.push(message); };
      try {
        fs.writeFileSync(process.env.AIVIS_CONFIG_FILE!, JSON.stringify({ gain: { learnWindow: 100, minLearnSeconds: 'x' } }));
        expect(resolved()).toEqual([9, 2.5]);
        // 発話ごとに読み直しても、同じ警告は 1 回だけ
        expect(resolved()).toEqual([9, 2.5]);
        expect(messages).toHaveLength(2);
      } finally {
        console.error = original;
      }
    });
  });
});

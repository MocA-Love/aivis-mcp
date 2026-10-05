/**
 * ビルドした `dist/` の 2.5.4 の口（Para Code が呼ぶ）。使い捨ての config.json / gain.json だけを読み書きする
 * （API・Redis は使わない）。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { gainLockPath } from '../../src/audio/gain-table.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(bin: 'index.js' | 'cli.js', args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    // 標準入力は開いたままにする（MCP サーバーとして起動してしまったら止まらないことを確かめるため）
    const child = spawn(process.execPath, [path.join(root, 'dist', bin), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

describe('実プロセスの声ごとの調整と音量の表の口', () => {
  let dir: string;
  let configFile: string;
  let gainFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-voice-gain-process-'));
    configFile = path.join(dir, 'config.json');
    gainFile = path.join(dir, 'gain.json');
    env = { ...process.env, AIVIS_CONFIG_FILE: configFile, AIVIS_GAIN_FILE: gainFile, REDIS_URL: 'redis://127.0.0.1:9' };
    delete env.AIVIS_GAIN_LEARN_WINDOW;
    delete env.AIVIS_GAIN_MIN_LEARN_SECONDS;
    fs.writeFileSync(configFile, JSON.stringify({ provider: 'elevenlabs', elevenlabs: { apiKey: 'k', voiceId: 'v', volumeMigrated: true } }));
    fs.writeFileSync(gainFile, JSON.stringify({
      version: 1,
      target: -20,
      entries: {
        'elevenlabs:voiceA:eleven_v3': { db: -3, samples: [-4, -3, -2], updatedAt: 100 },
        'elevenlabs:voiceB:eleven_v3': { db: -5, samples: [-5], updatedAt: 200 },
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

  test('声ごとの調整を設定し、指定したキーだけ置き換え、解除する', async () => {
    expect(await run('index.js', ['--set-voice-settings', '--voice', 'voiceA', '--stability', '0.3', '--similarity', '0.8'], env))
      .toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(await run('cli.js', ['--set-voice-settings', '--voice', 'voiceA', '--stability', '0.6'], env))
      .toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(await run('index.js', ['--set-voice-settings', '--voice', 'voiceB', '--similarity', '1'], env)).toMatchObject({ code: 0 });
    expect(readConfig().elevenlabs).toEqual({
      apiKey: 'k', voiceId: 'v', volumeMigrated: true,
      voiceSettings: { voiceA: { stability: 0.6, similarityBoost: 0.8 }, voiceB: { similarityBoost: 1 } },
    });
    expect((fs.statSync(configFile).mode & 0o777).toString(8)).toBe('600');

    expect(await run('index.js', ['--clear-voice-settings', '--voice', 'voiceA'], env)).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(await run('cli.js', ['--clear-voice-settings', '--voice', 'voiceB'], env)).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(readConfig().elevenlabs).toEqual({ apiKey: 'k', voiceId: 'v', volumeMigrated: true });
    expect(fs.existsSync(gainLockPath(configFile))).toBe(false);
  });

  test('間違った指定・ロック中・壊れた config は 1 行のエラーと終了コード 1 で、設定を書き換えない', async () => {
    const before = fs.readFileSync(configFile, 'utf8');
    const cases: string[][] = [
      ['--set-voice-settings', '--voice', 'voiceA'],
      ['--set-voice-settings', '--stability', '0.5'],
      ['--set-voice-settings', '--voice', 'bad id', '--stability', '0.5'],
      ['--set-voice-settings', '--voice', 'voiceA', '--stability', '2'],
      ['--set-voice-settings', '--voice', 'voiceA', '--stability'],
      ['--clear-voice-settings', '--voice', 'voiceA', '--similarity', '0.5'],
      ['--set-gain-learning'],
      ['--set-gain-learning', '--window', '0'],
      ['--set-gain-learning', '--min-seconds', '99'],
      ['--reset-gain'],
      ['--reset-gain', '--key', 'nocolon'],
      ['--list-gains', '--reset-gain', '--key', 'a:b:c'],
    ];
    for (const args of cases) {
      const result = await run('index.js', args, env);
      expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 1, stdout: '' });
      expect(result.stderr).toMatch(/^error: [^\n]+\n$/);
    }
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);

    fs.writeFileSync(gainLockPath(configFile), 'someone');
    const locked = await run('cli.js', ['--set-voice-settings', '--voice', 'voiceA', '--stability', '0.5'], env);
    expect(locked.code).toBe(1);
    expect(locked.stderr).toMatch(/^error: .*ロック/);
    fs.rmSync(gainLockPath(configFile));

    fs.writeFileSync(configFile, '{broken');
    for (const args of [['--set-voice-settings', '--voice', 'voiceA', '--stability', '0.5'], ['--set-gain-learning', '--window', '5']]) {
      const broken = await run('index.js', args, env);
      expect(broken.code).toBe(1);
      expect(broken.stderr).toMatch(/^error: 設定ファイルが JSON として読めない/);
    }
    expect(fs.readFileSync(configFile, 'utf8')).toBe('{broken');
  });

  test('--list-gains --json は JSON を 1 つだけ出し、--set-gain-learning の値を返す', async () => {
    expect(await run('index.js', ['--set-gain-learning', '--window', '5', '--min-seconds', '3'], env)).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(readConfig().gain).toEqual({ learnWindow: 5, minLearnSeconds: 3 });
    expect(await run('cli.js', ['--set-gain-learning', '--window', '7'], env)).toMatchObject({ code: 0 });
    expect(readConfig().gain).toEqual({ learnWindow: 7, minLearnSeconds: 3 });
    expect(readConfig().elevenlabs.apiKey).toBe('k');

    const listed = await run('index.js', ['--list-gains', '--json'], env);
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe('');
    const body = JSON.parse(listed.stdout);
    expect({ ...body, entries: undefined }).toEqual({ version: 1, target: -20, learnWindow: 7, minLearnSeconds: 3, entries: undefined });
    expect(body.entries.find((entry: { key: string }) => entry.key === 'elevenlabs:voiceA:eleven_v3'))
      .toEqual({ key: 'elevenlabs:voiceA:eleven_v3', provider: 'elevenlabs', voice: 'voiceA', model: 'eleven_v3', gainDb: -3, sampleCount: 3, updatedAt: 100 });

    const human = await run('cli.js', ['--list-gains'], env);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('elevenlabs:voiceA:eleven_v3  -3.0 dB  （測定 3/7）');
  });

  test('--reset-gain はその行だけ消し、無い行でも ok。壊れた表は書かない', async () => {
    expect(await run('index.js', ['--reset-gain', '--key', 'elevenlabs:voiceA:eleven_v3'], env)).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(Object.keys(JSON.parse(fs.readFileSync(gainFile, 'utf8')).entries)).toEqual(['elevenlabs:voiceB:eleven_v3']);
    expect(await run('cli.js', ['--reset-gain', '--key', 'elevenlabs:voiceA:eleven_v3'], env)).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(fs.existsSync(gainLockPath(gainFile))).toBe(false);

    fs.writeFileSync(gainLockPath(gainFile), 'someone');
    const locked = await run('index.js', ['--reset-gain', '--key', 'elevenlabs:voiceB:eleven_v3'], env);
    expect(locked.code).toBe(1);
    expect(locked.stderr).toMatch(/^error: 音量の表のロック/);
    fs.rmSync(gainLockPath(gainFile));

    fs.writeFileSync(gainFile, '{broken');
    const broken = await run('index.js', ['--reset-gain', '--key', 'elevenlabs:voiceB:eleven_v3'], env);
    expect(broken.code).toBe(1);
    expect(fs.readFileSync(gainFile, 'utf8')).toBe('{broken');
  });

  test('--export-gains / --import-gains に --json を付けると件数を JSON で出す', async () => {
    const out = path.join(dir, 'export.json');
    expect(await run('index.js', ['--export-gains', out, '--voice', 'voiceA', '--json'], env))
      .toEqual({ stdout: '{"ok":true,"written":1}\n', stderr: '', code: 0 });
    expect(await run('index.js', ['--export-gains', path.join(dir, 'none.json'), '--voice', 'unknown', '--json'], env))
      .toEqual({ stdout: '{"ok":true,"written":0}\n', stderr: '', code: 0 });

    const other = { ...env, AIVIS_GAIN_FILE: path.join(dir, 'other.json') };
    fs.writeFileSync(other.AIVIS_GAIN_FILE, JSON.stringify({ version: 1, target: -20, entries: { 'elevenlabs:voiceA:eleven_v3': { db: 0, samples: [0], updatedAt: 9 } } }));
    const full = path.join(dir, 'full.json');
    expect((await run('cli.js', ['--export-gains', full, '--json'], env)).stdout).toBe('{"ok":true,"written":2}\n');
    expect(await run('cli.js', ['--import-gains', full, '--json'], other))
      .toEqual({ stdout: '{"ok":true,"added":1,"updated":0,"skipped":1,"evicted":0,"dropped":0}\n', stderr: '', code: 0 });
    expect((await run('index.js', ['--import-gains', full, '--overwrite', '--json'], other)).stdout)
      .toBe('{"ok":true,"added":0,"updated":2,"skipped":0,"evicted":0,"dropped":0}\n');

    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{broken');
    const failed = await run('index.js', ['--import-gains', bad, '--json'], env);
    expect({ code: failed.code, stdout: failed.stdout }).toEqual({ code: 1, stdout: '' });
    expect(failed.stderr).toMatch(/^error: [^\n]+\n$/);
    const self = await run('cli.js', ['--export-gains', gainFile, '--json'], env);
    expect({ code: self.code, stdout: self.stdout }).toEqual({ code: 1, stdout: '' });
    // 値の無い --export-gains は次の --json を値として読むので、使い方を出して 1 で終わる
    const missing = await run('cli.js', ['--export-gains', '--json'], env);
    expect({ code: missing.code, stdout: missing.stdout }).toEqual({ code: 1, stdout: '' });
  });

  test('help に載っている', async () => {
    for (const bin of ['index.js', 'cli.js'] as const) {
      const result = await run(bin, ['--help'], env);
      for (const text of ['--set-voice-settings --voice <voice_id>', '--clear-voice-settings --voice <voice_id>', '--list-gains [--json]', '--reset-gain --key', '--set-gain-learning']) {
        expect(result.stdout).toContain(text);
      }
    }
  });
});

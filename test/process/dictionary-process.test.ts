/**
 * ビルドした `dist/` の `aivis-mcp --set-dictionary` / `--clear-dictionary`（Para Code が呼ぶ口）。
 * 使い捨ての config.json だけを読み書きする（API・Redis は使わない）。
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

const UUID = '11111111-2222-3333-4444-555555555555';

describe('実プロセスの --set-dictionary / --clear-dictionary', () => {
  let dir: string;
  let configFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-dictionary-process-'));
    configFile = path.join(dir, 'config.json');
    env = { ...process.env, AIVIS_CONFIG_FILE: configFile, AIVIS_GAIN_FILE: path.join(dir, 'gain.json'), REDIS_URL: 'redis://127.0.0.1:9' };
    fs.writeFileSync(configFile, JSON.stringify({ provider: 'elevenlabs', elevenlabs: { apiKey: 'k', voiceId: 'v', volumeMigrated: true } }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

  test('ElevenLabs の辞書を設定・版を替え・解除する（ほかの項目は残す）', async () => {
    const set = await run('index.js', ['--set-dictionary', '--provider', 'elevenlabs', '--id', 'dictA', '--version-id', 'ver1'], env);
    expect(set).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(read().elevenlabs).toEqual({ apiKey: 'k', voiceId: 'v', volumeMigrated: true, pronunciationDictionaryId: 'dictA', pronunciationDictionaryVersionId: 'ver1' });
    expect((fs.statSync(configFile).mode & 0o777).toString(8)).toBe('600');

    // 別の辞書にしたら、前の辞書の版は消す（最新の版を使う）
    const other = await run('cli.js', ['--set-dictionary', '--provider', 'elevenlabs', '--id', 'dictB'], env);
    expect(other.stdout).toBe('ok\n');
    expect(read().elevenlabs.pronunciationDictionaryId).toBe('dictB');
    expect('pronunciationDictionaryVersionId' in read().elevenlabs).toBe(false);

    const clear = await run('index.js', ['--clear-dictionary', '--provider', 'elevenlabs'], env);
    expect(clear).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(read().elevenlabs).toEqual({ apiKey: 'k', voiceId: 'v', volumeMigrated: true });
    expect(fs.existsSync(gainLockPath(configFile))).toBe(false);
  });

  test('Aivis のユーザー辞書を設定・解除する', async () => {
    expect((await run('index.js', ['--set-dictionary', '--provider', 'aivis', '--id', UUID], env)).stdout).toBe('ok\n');
    expect(read().aivis).toEqual({ userDictionaryUuid: UUID });
    expect((await run('index.js', ['--clear-dictionary', '--provider', 'aivis'], env)).stdout).toBe('ok\n');
    expect('aivis' in read()).toBe(false);
    expect(read().elevenlabs.apiKey).toBe('k');
  });

  test('間違った指定は 1 行のエラーと終了コード 1 で、設定を書き換えない', async () => {
    const before = fs.readFileSync(configFile, 'utf8');
    const cases: string[][] = [
      ['--set-dictionary', '--provider', 'aivis', '--id', 'not-a-uuid'],
      ['--set-dictionary', '--provider', 'elevenlabs'],
      ['--set-dictionary', '--id', 'dictA'],
      ['--set-dictionary', '--provider', 'other', '--id', 'dictA'],
      ['--set-dictionary', '--provider', 'elevenlabs', '--id', 'bad id!'],
      ['--set-dictionary', '--provider', 'aivis', '--id', UUID, '--version-id', 'v'],
      ['--set-dictionary', '--clear-dictionary', '--provider', 'aivis'],
      ['--clear-dictionary', '--provider', 'aivis', '--id', UUID],
    ];
    for (const args of cases) {
      const result = await run('index.js', args, env);
      expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 1, stdout: '' });
      expect(result.stderr).toMatch(/^error: [^\n]+\n$/);
    }
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  test('設定ファイルが無くても作る', async () => {
    fs.rmSync(configFile);
    expect((await run('cli.js', ['--set-dictionary', '--provider', 'aivis', '--id', UUID], env)).stdout).toBe('ok\n');
    expect(read()).toEqual({ aivis: { userDictionaryUuid: UUID } });
  });

  test('help に載っている', async () => {
    for (const bin of ['index.js', 'cli.js'] as const) {
      const result = await run(bin, ['--help'], env);
      expect(result.stdout).toContain('--set-dictionary --provider elevenlabs --id <id>');
      expect(result.stdout).toContain('--clear-dictionary --provider <elevenlabs|aivis>');
    }
  });
});

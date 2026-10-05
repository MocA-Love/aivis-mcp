/**
 * ビルドした `dist/` の `aivis-mcp` / `aivis` で、音量の表を書き出し・読み込む（Redis は使わない）。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(bin: 'index.js' | 'cli.js', args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'dist', bin), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('exit', code => resolve({ stdout, stderr, code }));
  });
}

describe('実プロセスの --export-gains / --import-gains', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-gains-process-'));
    env = { ...process.env, AIVIS_GAIN_FILE: path.join(dir, 'gain.json'), AIVIS_CONFIG_FILE: path.join(dir, 'config.json'), REDIS_URL: 'redis://127.0.0.1:9' };
    fs.writeFileSync(path.join(dir, 'gain.json'), JSON.stringify({
      version: 1,
      target: -20,
      entries: {
        'elevenlabs:voiceA:eleven_v3': { db: -3, samples: [-3], updatedAt: 1 },
        'elevenlabs:voiceB:eleven_v3': { db: -5, samples: [-5], updatedAt: 2 },
        'elevenlabs:voiceB:eleven_v4_turbo': { db: 1, samples: [1], updatedAt: 3 },
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('aivis-mcp で絞り込んで書き出し、aivis で別の表へ読み込む', async () => {
    const out = path.join(dir, 'export.json');
    const exported = await run('index.js', ['--export-gains', out, '--voice', 'voiceA', '--voice', 'voiceB', '--model', 'eleven_v3'], env);
    expect(exported.code).toBe(0);
    expect(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).entries)).toEqual(['elevenlabs:voiceA:eleven_v3', 'elevenlabs:voiceB:eleven_v3']);

    const other = { ...env, AIVIS_GAIN_FILE: path.join(dir, 'other.json') };
    fs.writeFileSync(other.AIVIS_GAIN_FILE, JSON.stringify({ version: 1, target: -20, entries: { 'elevenlabs:voiceA:eleven_v3': { db: 0, samples: [0], updatedAt: 9 } } }));
    const imported = await run('cli.js', ['--import-gains', out], other);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain('追加 1 行、上書き 0 行、自分の値を残した 1 行');
    const overwritten = await run('cli.js', ['--import-gains', out, '--overwrite'], other);
    expect(overwritten.stdout).toContain('追加 0 行、上書き 2 行');
    expect(JSON.parse(fs.readFileSync(other.AIVIS_GAIN_FILE!, 'utf8')).entries['elevenlabs:voiceA:eleven_v3'].db).toBe(-3);
  });

  test('壊れたファイルは終了コード 1 で拒む', async () => {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{broken');
    const result = await run('index.js', ['--import-gains', bad], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('読み込みを取りやめました');
  });

  test('help に載っている', async () => {
    for (const bin of ['index.js', 'cli.js'] as const) {
      const result = await run(bin, ['--help'], env);
      expect(result.stdout).toContain('--export-gains <file>');
      expect(result.stdout).toContain('--import-gains <file> [--overwrite]');
    }
  });
});

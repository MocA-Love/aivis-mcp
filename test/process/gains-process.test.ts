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
    // 標準入力は開いたままにする（MCP サーバーとして起動してしまったら止まらないことを確かめるため）
    const child = spawn(process.execPath, [path.join(root, 'dist', bin), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('exit', () => clearTimeout(timer));
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

  test('値が無い・別のオプションが続くときは使い方を出して 1 で終わる（MCP サーバーとして起動しない）', async () => {
    const cases: string[][] = [
      ['--export-gains'],
      ['--export-gains', '--voice', 'voiceA'],
      ['--export-gains=-x'],
      ['--import-gains'],
      ['--import-gains', '--overwrite'],
    ];
    for (const bin of ['index.js', 'cli.js'] as const) {
      for (const args of cases) {
        const result = await run(bin, args, env);
        expect({ bin, args, code: result.code }).toEqual({ bin, args, code: 1 });
        expect(result.stderr).toContain('使い方:');
      }
    }
  });

  test('一致する行が無い書き出しは、Aivis の指定のしかたを案内する', async () => {
    const result = await run('cli.js', ['--export-gains', path.join(dir, 'none.json'), '--voice', 'unknown'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 行書き出しました');
    expect(result.stdout).toContain('--voice にモデル UUID');
  });

  test('書き出し先が自分の表なら拒む', async () => {
    const result = await run('index.js', ['--export-gains', path.join(dir, 'gain.json'), '--voice', 'voiceA'], env);
    expect(result.code).toBe(1);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'gain.json'), 'utf8')).entries)).toHaveLength(3);
  });

  test('--import-gains に付けた --voice も警告する', async () => {
    const input = path.join(dir, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ version: 1, target: -20, entries: {} }));
    const result = await run('cli.js', ['--import-gains', input, '--voice', 'voiceA'], env);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('--voice は --export-gains の絞り込み用');
  });

  test('古いロックを 2 つのプロセスが同時に見つけても、ロックを持つのは同時に 1 つだけ', async () => {
    const gainFile = path.join(dir, 'gain.json');
    const lock = `${fs.realpathSync(gainFile)}.lock`;
    const log = path.join(dir, 'log.txt');
    const script = `
      import fs from 'fs';
      import { withGainFileLock } from ${JSON.stringify(path.join(root, 'dist', 'audio', 'gain-table.js'))};
      await withGainFileLock(${JSON.stringify(gainFile)}, async () => {
        fs.appendFileSync(${JSON.stringify(log)}, 'start\\n');
        await new Promise(resolve => setTimeout(resolve, 300));
        fs.appendFileSync(${JSON.stringify(log)}, 'end\\n');
      });
    `;
    for (let round = 0; round < 3; round++) {
      fs.writeFileSync(lock, 'crashed');
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);
      fs.rmSync(log, { force: true });
      const codes = await Promise.all([0, 1, 2].map(() => new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
        child.on('exit', code => resolve(code));
      })));
      expect(codes).toEqual([0, 0, 0]);
      expect(fs.readFileSync(log, 'utf8')).toBe('start\nend\n'.repeat(3));
      expect(fs.existsSync(lock)).toBe(false);
    }
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAudioBackend, mplayerVoiceArgs, soxPlayVoiceArgs, type PlayerKind } from '../../src/audio/player.js';

/**
 * 本物のプレイヤーの代わりに、PATH の先頭に置いた小さなシェルスクリプトを起こす。
 * 音は出さない。
 */
describe('プレイヤーの結果と止め方', () => {
  let binDir: string;
  /** 本物のプレイヤーは起こさない（音を出さない）。名前を一時フォルダの中のスクリプトに置き換える */
  const local = (name: string) => path.join(binDir, name);

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-player-'));
  });

  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function fakePlayer(name: string, script: string): string {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path.join(binDir, `${name}.args`);
  }

  test('[HIGH 3] 0 で終われば成功、0 以外で終われば player-exited', async () => {
    fakePlayer('ffplay', 'cat > /dev/null; exit 0');
    const ok = createAudioBackend('ffplay', false, local).startVoice(0);
    await ok.write(Buffer.from([1, 2, 3]));
    ok.end();
    expect(await ok.done).toEqual({ ok: true });

    fakePlayer('ffplay', 'cat > /dev/null; exit 3');
    const failed = createAudioBackend('ffplay', false, local).startVoice(0);
    failed.end();
    expect(await failed.done).toEqual({ ok: false, reason: 'player-exited' });
  });

  test('[HIGH 3] プレイヤーを起動できなければ player-spawn-failed、プレイヤーが無ければ no-player', async () => {
    const missing = createAudioBackend('ffplay', false, local).startVoice(0);
    await missing.write(Buffer.from([1]));
    missing.end();
    expect(await missing.done).toEqual({ ok: false, reason: 'player-spawn-failed' });

    const none = createAudioBackend('none', false, local).startVoice(0);
    await none.write(Buffer.from([1]));
    none.end();
    expect(await none.done).toEqual({ ok: false, reason: 'no-player' });

    const prelude = createAudioBackend('none', false, local).playPrelude('/x.wav', 'wav', 1);
    expect(await prelude.done).toEqual({ ok: false, reason: 'no-player' });
  });

  test('[MEDIUM 16] 止めても終わらないプレイヤーは強制終了する', async () => {
    fakePlayer('ffplay', 'trap "" TERM; while true; do sleep 0.1; done');
    const stubborn = createAudioBackend('ffplay', false, local).startVoice(0);
    // 起動して trap を掛けるのを待つ
    await new Promise(resolve => setTimeout(resolve, 300));
    const started = Date.now();
    stubborn.kill();
    expect(await stubborn.done).toEqual({ ok: false, reason: 'killed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('[LOW 28] プレイヤーの入力が詰まったら、空くまで書き込みを待つ', async () => {
    // 読まずに眠る（パイプが詰まる）。止めたら終わる
    fakePlayer('ffplay', 'exec sleep 30');
    const blocked = createAudioBackend('ffplay', false, local).startVoice(0);
    let resolved = false;
    const writing = blocked.write(Buffer.alloc(4 * 1024 * 1024)).then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(resolved).toBe(false);
    blocked.kill();
    await writing;
    expect(await blocked.done).toEqual({ ok: false, reason: 'killed' });
  });

  test.each<[PlayerKind]>([['mplayer'], ['play']])('[MEDIUM 15] Linux の %s でも、全部受け取ってから鳴らす', async kind => {
    const argsFile = fakePlayer(kind, `echo "$@" > "${path.join(binDir, `${kind}.args`)}"; exit 0`);
    const playback = createAudioBackend(kind, false, local).startVoice(-3);
    await playback.write(Buffer.from([1, 2, 3]));
    playback.end();
    expect(await playback.done).toEqual({ ok: true });
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).toContain(kind === 'mplayer' ? 'volume=-3.0:1' : 'gain -l -3.0');
  });

  test('[MEDIUM 15] mplayer と sox の引数', () => {
    expect(mplayerVoiceArgs('/t/a.mp3', 2)).toEqual(['-really-quiet', '-nolirc', '-vo', 'null', '-af', 'volume=2.0:1', '/t/a.mp3']);
    expect(soxPlayVoiceArgs('/t/a.mp3', -4.5)).toEqual(['-q', '/t/a.mp3', 'gain', '-l', '-4.5']);
  });
});

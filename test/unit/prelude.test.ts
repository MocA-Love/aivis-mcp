import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkPreludeFile, preludeFormat, validatePreludePath } from '../../src/audio/prelude.js';
import { ffplayPreludeArgs, ffplayVoiceArgs, mpvVoiceArgs } from '../../src/audio/player.js';

describe('prelude', () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-prelude-')));
    allowed = path.join(root, 'sounds');
    outside = path.join(root, 'other');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(allowed, 'chime.wav'), 'RIFF');
    fs.writeFileSync(path.join(allowed, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.wav'), 'RIFF');
    fs.writeFileSync(path.join(allowed, 'empty.mp3'), '');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('許可フォルダの中の音声ファイルだけ通す', () => {
    expect(validatePreludePath(path.join(allowed, 'chime.wav'), [allowed])).toEqual({ ok: true, path: path.join(allowed, 'chime.wav'), format: 'wav' });
    expect(validatePreludePath(path.join(outside, 'secret.wav'), [allowed])).toEqual({ ok: false, reason: 'outside-allowed-dirs' });
    expect(validatePreludePath(path.join(allowed, '..', 'other', 'secret.wav'), [allowed])).toEqual({ ok: false, reason: 'outside-allowed-dirs' });
    expect(validatePreludePath(path.join(allowed, 'notes.txt'), [allowed])).toEqual({ ok: false, reason: 'unsupported-extension' });
    expect(validatePreludePath('sounds/chime.wav', [allowed])).toEqual({ ok: false, reason: 'not-absolute' });
    expect(validatePreludePath(path.join(allowed, 'missing.wav'), [allowed])).toEqual({ ok: false, reason: 'not-found' });
    expect(validatePreludePath(path.join(allowed, 'empty.mp3'), [allowed])).toEqual({ ok: false, reason: 'bad-size' });
    expect(validatePreludePath(path.join(allowed, 'chime.wav'), [])).toEqual({ ok: false, reason: 'outside-allowed-dirs' });
  });

  test('シンボリックリンクで外へ出るものは通さない', () => {
    const link = path.join(allowed, 'link.wav');
    fs.symlinkSync(path.join(outside, 'secret.wav'), link);
    expect(validatePreludePath(link, [allowed])).toEqual({ ok: false, reason: 'outside-allowed-dirs' });
    expect(checkPreludeFile(link).ok).toBe(true);
  });

  test('フォルダ自体は通さない', () => {
    fs.mkdirSync(path.join(allowed, 'dir.wav'));
    expect(validatePreludePath(path.join(allowed, 'dir.wav'), [allowed])).toEqual({ ok: false, reason: 'not-a-file' });
  });

  test('拡張子から形式を決める', () => {
    expect(preludeFormat('/a/b.WAV')).toBe('wav');
    expect(preludeFormat('/a/b.m4a')).toBe('mov');
    expect(preludeFormat('/a/b.aif')).toBe('aiff');
    expect(preludeFormat('/a/b.exe')).toBeUndefined();
  });

  test('ffplay は file だけ許し、形式を指定して起こす。音量の表も alimiter も当てない', () => {
    const args = ffplayPreludeArgs('/s/chime.wav', 'wav', 0.4);
    expect(args).toEqual(['-nodisp', '-autoexit', '-loglevel', 'quiet', '-protocol_whitelist', 'file', '-f', 'wav', '-volume', '40', '-i', '/s/chime.wav']);
    expect(args.join(' ')).not.toContain('alimiter');
  });

  test('声のデコーダは低遅延の指定で起こし、音量と頭打ちを当てる', () => {
    const args = ffplayVoiceArgs(4.1);
    expect(args).toEqual(expect.arrayContaining(['-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer', '-f', 'mp3']));
    expect(args[args.indexOf('-af') + 1]).toBe('volume=4.1dB,alimiter=limit=0.89');
    expect(args.slice(-2)).toEqual(['-i', '-']);
    const mpv = mpvVoiceArgs(-3);
    expect(mpv).toEqual(expect.arrayContaining(['--demuxer-lavf-probesize=32', '--demuxer-lavf-analyzeduration=0', '--demuxer-lavf-o=fflags=+nobuffer', '--af=lavfi=[volume=-3.0dB,alimiter=limit=0.89]']));
  });
});

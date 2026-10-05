/**
 * 鳴らす側（ffplay / mpv / afplay）。1 発話を 1 つのデコーダで最初から最後まで鳴らす（設計 2 章）。
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afplayVolume, voiceFilter } from './gain-table.js';

/**
 * ffplay・mpv は届きながら鳴らす。afplay（macOS）・mplayer・play（sox、Linux）・start（Windows の既定のアプリ）は
 * 全部溜めてから鳴らす。none は鳴らせない。
 */
export type PlayerKind = 'ffplay' | 'mpv' | 'afplay' | 'mplayer' | 'play' | 'start' | 'none';

/** 鳴らせなかった理由。killed は止めた（hold・中断・打ち切り）。 */
export type PlayFailure = 'killed' | 'player-exited' | 'player-spawn-failed' | 'no-player';

export type PlayResult = { readonly ok: true } | { readonly ok: false; readonly reason: PlayFailure };

/** 1 発話の鳴らし先。`write` で MP3 を流し、`end` で入力を閉じる。 */
export interface VoicePlayback {
  /** 断片を流す。プレイヤーの入力が詰まっていれば、空くまで（止まったらすぐ）待つ */
  write(chunk: Buffer): Promise<void>;
  end(): void;
  /** 鳴っている途中で止める（止まらなければ少し待って強制終了する） */
  kill(): void;
  /** 鳴り終わった（止められた・起動に失敗した）ら、その結果で解決する */
  readonly done: Promise<PlayResult>;
}

export interface PreludePlayback {
  kill(): void;
  readonly done: Promise<PlayResult>;
}

export interface AudioBackend {
  readonly kind: PlayerKind;
  /** 届きながら鳴らせるか（afplay などは全部溜めてから鳴らす） */
  readonly streaming: boolean;
  /** 鳴らした後に大きさを測れるか（ffmpeg があるか） */
  readonly canMeasure: boolean;
  startVoice(gainDb: number): VoicePlayback;
  playPrelude(filePath: string, format: string, volume: number): PreludePlayback;
}

/** 止めた（SIGTERM）後、これだけ待っても終わらないプレイヤーは SIGKILL で止める。 */
export const PLAYER_KILL_GRACE_MS = 2_000;

/** デコーダが形式を調べるために先に溜め込まないようにする指定（1.2 の実測で 572ms → 32ms）。 */
export const FFPLAY_LOW_LATENCY_ARGS = ['-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer'] as const;

export function ffplayVoiceArgs(gainDb: number): string[] {
  return [
    '-nodisp', '-autoexit', '-loglevel', 'quiet',
    ...FFPLAY_LOW_LATENCY_ARGS,
    '-f', 'mp3',
    '-volume', '100',
    '-af', voiceFilter(gainDb),
    '-i', '-',
  ];
}

export function mpvVoiceArgs(gainDb: number): string[] {
  return [
    '--no-video', '--really-quiet', '--no-terminal',
    '--demuxer-lavf-probesize=32',
    '--demuxer-lavf-analyzeduration=0',
    '--demuxer-lavf-o=fflags=+nobuffer',
    '--demuxer-lavf-format=mp3',
    '--audio-buffer=0.2', '--cache=yes', '--cache-secs=1',
    '--demuxer-readahead-secs=1',
    `--af=lavfi=[${voiceFilter(gainDb)}]`,
    '-',
  ];
}

/** 着信音は表の補正も頭打ちも当てず、呼び出し側の音量（0〜1）だけで鳴らす。 */
export function ffplayPreludeArgs(filePath: string, format: string, volume: number): string[] {
  return [
    '-nodisp', '-autoexit', '-loglevel', 'quiet',
    '-protocol_whitelist', 'file',
    '-f', format,
    '-volume', String(Math.round(Math.min(1, Math.max(0, volume)) * 100)),
    '-i', filePath,
  ];
}

/** mpv も形式を指定し、プレイリストとして読まない。 */
export function mpvPreludeArgs(filePath: string, format: string, volume: number): string[] {
  return [
    '--no-video', '--really-quiet', '--no-terminal',
    '--load-unsafe-playlists=no', '--ytdl=no', '--playlist-start=0', '--no-resume-playback',
    `--demuxer-lavf-format=${format}`,
    `--volume=${Math.round(Math.min(1, Math.max(0, volume)) * 100)}`,
    '--', filePath,
  ];
}

function commandExists(command: string): boolean {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function detectPlayerKind(): PlayerKind {
  if (commandExists('ffplay')) {
    return 'ffplay';
  }
  if (commandExists('mpv')) {
    return 'mpv';
  }
  if (process.platform === 'darwin' && commandExists('afplay')) {
    return 'afplay';
  }
  if (process.platform === 'win32') {
    return 'start';
  }
  // 2.4 まで使えた Linux のプレイヤー（全部溜めてから鳴らす）
  if (commandExists('mplayer')) {
    return 'mplayer';
  }
  if (commandExists('play')) {
    return 'play';
  }
  return 'none';
}

export function hasFfmpeg(): boolean {
  return commandExists('ffmpeg');
}

/** mplayer の af volume（dB）。上げすぎた分は soft clipping で抑える。 */
export function mplayerVoiceArgs(filePath: string, gainDb: number): string[] {
  return ['-really-quiet', '-nolirc', '-vo', 'null', '-af', `volume=${gainDb.toFixed(1)}:1`, filePath];
}

/** sox の play。`gain -l` で上げた分は頭打ちを掛ける。 */
export function soxPlayVoiceArgs(filePath: string, gainDb: number): string[] {
  return ['-q', filePath, 'gain', '-l', gainDb.toFixed(1)];
}

function linearToDb(volume: number): number {
  const clamped = Math.min(1, Math.max(0, volume));
  return clamped <= 0 ? -200 : 20 * Math.log10(clamped);
}

/**
 * 子プロセスの終わりを見張る。止めたら SIGTERM、`PLAYER_KILL_GRACE_MS` 経っても終わらなければ SIGKILL。
 * 起動に失敗した・0 以外で終わった・止めたを結果で返す。
 */
class ChildWatch {
  readonly done: Promise<PlayResult>;
  private killed = false;
  private exited = false;
  private forceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly child: ChildProcess) {
    this.done = new Promise<PlayResult>(resolve => {
      let spawnFailed = false;
      let settled = false;
      const finish = (result: PlayResult) => {
        if (settled) {
          return;
        }
        settled = true;
        this.exited = true;
        if (this.forceTimer !== undefined) {
          clearTimeout(this.forceTimer);
        }
        resolve(result);
      };
      child.once('error', error => {
        spawnFailed = true;
        console.error('Player process error:', error instanceof Error ? error.message : error);
        // 起動できなかったときは close が来ないことがある
        finish({ ok: false, reason: 'player-spawn-failed' });
      });
      child.once('close', (code: number | null) => {
        if (spawnFailed) {
          finish({ ok: false, reason: 'player-spawn-failed' });
        } else if (this.killed) {
          finish({ ok: false, reason: 'killed' });
        } else if (code !== 0) {
          finish({ ok: false, reason: 'player-exited' });
        } else {
          finish({ ok: true });
        }
      });
    });
  }

  get hasExited(): boolean {
    return this.exited;
  }

  kill(): void {
    if (this.exited) {
      return;
    }
    this.killed = true;
    try {
      this.child.kill('SIGTERM');
    } catch {}
    if (this.forceTimer === undefined) {
      this.forceTimer = setTimeout(() => {
        if (!this.exited) {
          try {
            this.child.kill('SIGKILL');
          } catch {}
        }
      }, PLAYER_KILL_GRACE_MS);
      this.forceTimer.unref?.();
    }
  }
}

class ProcessVoicePlayback implements VoicePlayback {
  readonly done: Promise<PlayResult>;
  private readonly watch: ChildWatch;

  constructor(private readonly child: ChildProcess) {
    // 止めた後の書き込みで EPIPE が投げられても worker を落とさない
    child.stdin?.on('error', () => undefined);
    this.watch = new ChildWatch(child);
    this.done = this.watch.done;
  }

  write(chunk: Buffer): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable || this.watch.hasExited) {
      return Promise.resolve();
    }
    if (stdin.write(chunk)) {
      return Promise.resolve();
    }
    // プレイヤーが読みきれていない。空くか、止まる・終わるまで待つ（溜め込まない）
    return new Promise<void>(resolve => {
      const finish = () => {
        stdin.off('drain', finish);
        stdin.off('close', finish);
        stdin.off('error', finish);
        resolve();
      };
      stdin.once('drain', finish);
      stdin.once('close', finish);
      stdin.once('error', finish);
      void this.done.then(finish);
    });
  }

  end(): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed) {
      stdin.end();
    }
  }

  kill(): void {
    this.child.stdin?.destroy();
    this.watch.kill();
  }
}

/** 全部溜めてから一時ファイルにして鳴らす（afplay・mplayer・play・Windows の既定のアプリ）。 */
class BufferedVoicePlayback implements VoicePlayback {
  readonly done: Promise<PlayResult>;
  private readonly chunks: Buffer[] = [];
  private watch: ChildWatch | undefined;
  private killed = false;
  private resolveEnded!: () => void;

  constructor(private readonly kind: PlayerKind, private readonly gainDb: number, private readonly command: (name: string) => string) {
    const ended = new Promise<void>(resolve => { this.resolveEnded = resolve; });
    this.done = ended.then(() => this.playAll());
  }

  write(chunk: Buffer): Promise<void> {
    if (!this.killed) {
      this.chunks.push(chunk);
    }
    return Promise.resolve();
  }

  end(): void {
    this.resolveEnded();
  }

  kill(): void {
    this.killed = true;
    this.resolveEnded();
    this.watch?.kill();
  }

  private spawnPlayer(filePath: string): ChildProcess | undefined {
    switch (this.kind) {
      case 'afplay':
        return spawn(this.command('afplay'), ['-v', afplayVolume(this.gainDb).toFixed(3), filePath], { stdio: 'ignore' });
      case 'mplayer':
        return spawn(this.command('mplayer'), mplayerVoiceArgs(filePath, this.gainDb), { stdio: 'ignore' });
      case 'play':
        return spawn(this.command('play'), soxPlayVoiceArgs(filePath, this.gainDb), { stdio: 'ignore' });
      default:
        return undefined;
    }
  }

  private async playAll(): Promise<PlayResult> {
    if (this.killed) {
      return { ok: false, reason: 'killed' };
    }
    if (this.kind === 'none') {
      console.error('No audio player found for playback');
      return { ok: false, reason: 'no-player' };
    }
    if (this.chunks.length === 0) {
      return { ok: true };
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-mcp-'));
    const filePath = path.join(directory, 'speech.mp3');
    try {
      fs.writeFileSync(filePath, Buffer.concat(this.chunks));
      if (this.kind === 'start') {
        // 鳴り終わりを待てない（既定のアプリに渡すだけ）。消す前に少し待つ
        spawn('cmd', ['/c', 'start', '', filePath], { stdio: 'ignore' }).on('error', () => undefined);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { ok: true };
      }
      const child = this.spawnPlayer(filePath);
      if (child === undefined) {
        return { ok: false, reason: 'no-player' };
      }
      this.watch = new ChildWatch(child);
      if (this.killed) {
        this.watch.kill();
      }
      return await this.watch.done;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

function preludeChild(kind: PlayerKind, filePath: string, format: string, volume: number, command: (name: string) => string): ChildProcess | undefined {
  const clamped = Math.min(1, Math.max(0, volume));
  switch (kind) {
    case 'ffplay':
      return spawn(command('ffplay'), ffplayPreludeArgs(filePath, format, volume), { stdio: 'ignore' });
    case 'mpv':
      return spawn(command('mpv'), mpvPreludeArgs(filePath, format, volume), { stdio: 'ignore' });
    case 'afplay':
      return spawn(command('afplay'), ['-v', clamped.toFixed(3), filePath], { stdio: 'ignore' });
    case 'mplayer':
      return spawn(command('mplayer'), ['-really-quiet', '-nolirc', '-vo', 'null', '-af', `volume=${linearToDb(clamped).toFixed(1)}:0`, filePath], { stdio: 'ignore' });
    case 'play':
      return spawn(command('play'), ['-q', filePath, 'vol', clamped.toFixed(3)], { stdio: 'ignore' });
    default:
      return undefined;
  }
}

/**
 * @param command テスト用。プレイヤーの名前から起こすコマンドを決める（既定は名前のまま PATH から探す）
 */
export function createAudioBackend(kind = detectPlayerKind(), canMeasure = hasFfmpeg(), command: (name: string) => string = name => name): AudioBackend {
  const streaming = kind === 'ffplay' || kind === 'mpv';
  return {
    kind,
    streaming,
    canMeasure: canMeasure && streaming,
    startVoice(gainDb: number): VoicePlayback {
      if (kind === 'ffplay') {
        return new ProcessVoicePlayback(spawn(command('ffplay'), ffplayVoiceArgs(gainDb), { stdio: ['pipe', 'ignore', 'ignore'] }));
      }
      if (kind === 'mpv') {
        return new ProcessVoicePlayback(spawn(command('mpv'), mpvVoiceArgs(gainDb), { stdio: ['pipe', 'ignore', 'ignore'] }));
      }
      return new BufferedVoicePlayback(kind, gainDb, command);
    },
    playPrelude(filePath: string, format: string, volume: number): PreludePlayback {
      const child = preludeChild(kind, filePath, format, volume, command);
      if (child === undefined) {
        return { kill: () => undefined, done: Promise.resolve({ ok: false, reason: 'no-player' }) };
      }
      const watch = new ChildWatch(child);
      return { kill: () => watch.kill(), done: watch.done };
    },
  };
}

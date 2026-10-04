/**
 * 鳴らす側（ffplay / mpv / afplay）。1 発話を 1 つのデコーダで最初から最後まで鳴らす（設計 2 章）。
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afplayVolume, voiceFilter } from './gain-table.js';

export type PlayerKind = 'ffplay' | 'mpv' | 'afplay' | 'none';

/** 1 発話の鳴らし先。`write` で MP3 を流し、`end` で入力を閉じる。 */
export interface VoicePlayback {
  write(chunk: Buffer): void;
  end(): void;
  /** 鳴っている途中で止める */
  kill(): void;
  /** 鳴り終わった（止められた）ら解決する */
  readonly done: Promise<void>;
}

export interface PreludePlayback {
  kill(): void;
  readonly done: Promise<void>;
}

export interface AudioBackend {
  readonly kind: PlayerKind;
  /** 届きながら鳴らせるか（afplay は全部溜めてから鳴らす） */
  readonly streaming: boolean;
  /** 鳴らした後に大きさを測れるか（ffmpeg があるか） */
  readonly canMeasure: boolean;
  startVoice(gainDb: number): VoicePlayback;
  playPrelude(filePath: string, format: string, volume: number): PreludePlayback;
}

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
  return 'none';
}

export function hasFfmpeg(): boolean {
  return commandExists('ffmpeg');
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once('close', finish);
    child.once('error', error => {
      console.error('Player process error:', error);
      finish();
    });
  });
}

class ProcessVoicePlayback implements VoicePlayback {
  readonly done: Promise<void>;

  constructor(private readonly child: ChildProcess) {
    // 止めた後の書き込みで EPIPE が投げられても worker を落とさない
    child.stdin?.on('error', () => undefined);
    this.done = waitForExit(child);
  }

  write(chunk: Buffer): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) {
      stdin.write(chunk);
    }
  }

  end(): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed) {
      stdin.end();
    }
  }

  kill(): void {
    try {
      this.child.kill('SIGTERM');
    } catch {}
  }
}

/** 全部溜めてから一時ファイルにして鳴らす（afplay・プレイヤーが無いとき）。 */
class BufferedVoicePlayback implements VoicePlayback {
  readonly done: Promise<void>;
  private readonly chunks: Buffer[] = [];
  private child: ChildProcess | undefined;
  private killed = false;
  private resolveEnded!: () => void;

  constructor(private readonly kind: PlayerKind, private readonly gainDb: number) {
    const ended = new Promise<void>(resolve => { this.resolveEnded = resolve; });
    this.done = ended.then(() => this.playAll());
  }

  write(chunk: Buffer): void {
    if (!this.killed) {
      this.chunks.push(chunk);
    }
  }

  end(): void {
    this.resolveEnded();
  }

  kill(): void {
    this.killed = true;
    this.resolveEnded();
    try {
      this.child?.kill('SIGTERM');
    } catch {}
  }

  private async playAll(): Promise<void> {
    if (this.killed || this.chunks.length === 0) {
      return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aivis-mcp-'));
    const filePath = path.join(directory, 'speech.mp3');
    try {
      fs.writeFileSync(filePath, Buffer.concat(this.chunks));
      if (this.kind === 'afplay') {
        this.child = spawn('afplay', ['-v', afplayVolume(this.gainDb).toFixed(3), filePath], { stdio: 'ignore' });
        await waitForExit(this.child);
      } else if (process.platform === 'win32') {
        // 鳴り終わりを待てない（既定のアプリに渡すだけ）。消す前に少し待つ
        spawn('cmd', ['/c', 'start', '', filePath], { stdio: 'ignore' });
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        console.error('No audio player found for playback');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

export function createAudioBackend(kind = detectPlayerKind(), canMeasure = hasFfmpeg()): AudioBackend {
  const streaming = kind === 'ffplay' || kind === 'mpv';
  return {
    kind,
    streaming,
    canMeasure: canMeasure && streaming,
    startVoice(gainDb: number): VoicePlayback {
      if (kind === 'ffplay') {
        return new ProcessVoicePlayback(spawn('ffplay', ffplayVoiceArgs(gainDb), { stdio: ['pipe', 'ignore', 'ignore'] }));
      }
      if (kind === 'mpv') {
        return new ProcessVoicePlayback(spawn('mpv', mpvVoiceArgs(gainDb), { stdio: ['pipe', 'ignore', 'ignore'] }));
      }
      return new BufferedVoicePlayback(kind, gainDb);
    },
    playPrelude(filePath: string, format: string, volume: number): PreludePlayback {
      let child: ChildProcess | undefined;
      if (kind === 'ffplay') {
        child = spawn('ffplay', ffplayPreludeArgs(filePath, format, volume), { stdio: 'ignore' });
      } else if (kind === 'mpv') {
        child = spawn('mpv', ['--no-video', '--really-quiet', '--no-terminal', `--volume=${Math.round(volume * 100)}`, '--', filePath], { stdio: 'ignore' });
      } else if (kind === 'afplay') {
        child = spawn('afplay', ['-v', Math.min(1, Math.max(0, volume)).toFixed(3), filePath], { stdio: 'ignore' });
      }
      if (child === undefined) {
        return { kill: () => undefined, done: Promise.resolve() };
      }
      const player = child;
      return {
        kill: () => {
          try {
            player.kill('SIGTERM');
          } catch {}
        },
        done: waitForExit(player),
      };
    },
  };
}

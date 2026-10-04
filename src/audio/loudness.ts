/**
 * 鳴らし切った発話の大きさ（LUFS）を ffmpeg の ebur128 で測る（設計 3.2 の覚え直し）。
 * 補正前の音声を測る。鳴らした後に裏で走らせるので、鳴り始めは遅れない。
 */

import { spawn } from 'child_process';

export interface LoudnessResult {
  readonly integratedLufs: number;
  /** ebur128 が最後に数えた時刻（秒） */
  readonly durationSeconds: number | undefined;
}

/** ffmpeg の標準エラーから、まとめの「I: -23.4 LUFS」と最後の「t: 」を読む。 */
export function parseEbur128Output(stderr: string): LoudnessResult | undefined {
  const summaryIndex = stderr.lastIndexOf('Summary:');
  if (summaryIndex < 0) {
    return undefined;
  }
  const integrated = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(stderr.slice(summaryIndex));
  if (!integrated) {
    return undefined;
  }
  const integratedLufs = parseFloat(integrated[1]);
  if (!Number.isFinite(integratedLufs)) {
    return undefined;
  }
  let durationSeconds: number | undefined;
  const timePattern = /\bt:\s*(\d+(?:\.\d+)?)/g;
  const head = stderr.slice(0, summaryIndex);
  let match: RegExpExecArray | null;
  while ((match = timePattern.exec(head)) !== null) {
    durationSeconds = parseFloat(match[1]);
  }
  return { integratedLufs, durationSeconds };
}

/** MP3 のバイト列を測る。ffmpeg が無い・読めないときは undefined。 */
export function measureLoudness(audio: Buffer, ffmpegCommand = 'ffmpeg', timeoutMs = 20_000): Promise<LoudnessResult | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: LoudnessResult | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(ffmpegCommand, ['-hide_banner', '-nostats', '-f', 'mp3', '-i', 'pipe:0', '-af', 'ebur128', '-f', 'null', '-'], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch {
      finish(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      // 長い発話でも 1 秒に 10 行ほど。念のため上限を置き、まとめが入る末尾を残す
      chunks.push(chunk);
      size += chunk.length;
      while (size > 4 * 1024 * 1024 && chunks.length > 1) {
        size -= chunks.shift()!.length;
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.once('close', () => {
      clearTimeout(timer);
      finish(parseEbur128Output(Buffer.concat(chunks).toString('utf8')));
    });
    child.stdin.once('error', () => undefined);
    child.stdin.end(audio);
  });
}

/**
 * 着信音（prelude）のファイルの検査（設計 3.6 N4）。
 * 呼び出し側（Para Code）が渡した許可フォルダの中にある、音声の拡張子の普通のファイルだけを鳴らす。
 */

import fs from 'fs';
import path from 'path';

/** 着信音の大きさの上限。 */
export const MAX_PRELUDE_BYTES = 10 * 1024 * 1024;

/** 拡張子 → ffmpeg の形式名（ffplay は形式を指定して起こす）。 */
const PRELUDE_FORMATS: Readonly<Record<string, string>> = {
  '.wav': 'wav',
  '.mp3': 'mp3',
  '.aiff': 'aiff',
  '.aif': 'aiff',
  '.m4a': 'mov',
  '.caf': 'caf',
  '.ogg': 'ogg',
  '.flac': 'flac',
};

export function preludeFormat(filePath: string): string | undefined {
  return PRELUDE_FORMATS[path.extname(filePath).toLowerCase()];
}

export type PreludeCheck =
  | { readonly ok: true; readonly path: string; readonly format: string }
  | { readonly ok: false; readonly reason: string };

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 拡張子・普通のファイル・大きさだけを確かめる（worker 側の再確認）。 */
export function checkPreludeFile(candidate: string): PreludeCheck {
  if (typeof candidate !== 'string' || candidate.length === 0 || !path.isAbsolute(candidate)) {
    return { ok: false, reason: 'not-absolute' };
  }
  const format = preludeFormat(candidate);
  if (format === undefined) {
    return { ok: false, reason: 'unsupported-extension' };
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (preludeFormat(real) === undefined) {
    return { ok: false, reason: 'unsupported-extension' };
  }
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      return { ok: false, reason: 'not-a-file' };
    }
    if (stat.size <= 0 || stat.size > MAX_PRELUDE_BYTES) {
      return { ok: false, reason: 'bad-size' };
    }
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  return { ok: true, path: real, format };
}

/**
 * 着信音のパスを確かめる。シンボリックリンクを解いた実パスが、許可フォルダ（これも実パスに直す）の
 * どれかの中にあるときだけ通す。
 */
export function validatePreludePath(candidate: string, allowedDirs: readonly string[]): PreludeCheck {
  const file = checkPreludeFile(candidate);
  if (!file.ok) {
    return file;
  }
  for (const dir of allowedDirs) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
      continue;
    }
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (isInside(file.path, realDir)) {
      return file;
    }
  }
  return { ok: false, reason: 'outside-allowed-dirs' };
}

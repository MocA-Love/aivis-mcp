import type { AudioBackend, PlayerKind, PlayResult, PreludePlayback, VoicePlayback } from '../../src/audio/player.js';

export interface PlayedVoice {
  readonly gainDb: number;
  readonly bytes: Buffer;
  readonly killed: boolean;
}

export interface BackendEvent {
  readonly kind: 'voice-start' | 'voice-end' | 'prelude';
  readonly detail?: string | number;
  readonly at: number;
}

export interface FakeBackendOptions {
  voiceMs?: number;
  preludeMs?: number;
  canMeasure?: boolean;
  kind?: PlayerKind;
  /** 鳴り終わりの結果（既定は成功）。プレイヤーが 0 以外で終わった・起動に失敗したを真似る */
  voiceResult?: PlayResult;
  /** 書き込みが空くまでの時間（プレイヤーの入力が詰まっているのを真似る） */
  drainMs?: number;
}

/**
 * 音を出さない鳴らし先。届いたバイトを記録し、入力が閉じてから `voiceMs` 後に鳴り終わる。
 * kind が none のときは、本物と同じく鳴らせない（no-player）。
 */
export class FakeBackend implements AudioBackend {
  readonly kind: PlayerKind;
  readonly streaming = true;
  readonly canMeasure: boolean;
  readonly voices: PlayedVoice[] = [];
  readonly events: BackendEvent[] = [];
  readonly preludes: string[] = [];
  preludeKills = 0;
  /** 鳴らしている途中のプレイヤーの数（重なりを確かめる） */
  active = 0;
  maxActive = 0;
  /** 空くのを待っている書き込みの数の最大（worker が drain を待つかを確かめる） */
  maxPendingWrites = 0;
  private pendingWrites = 0;

  constructor(private readonly options: FakeBackendOptions = {}) {
    this.canMeasure = options.canMeasure ?? false;
    this.kind = options.kind ?? 'ffplay';
  }

  startVoice(gainDb: number): VoicePlayback {
    const chunks: Buffer[] = [];
    let resolve!: (result: PlayResult) => void;
    const done = new Promise<PlayResult>(r => { resolve = r; });
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    this.events.push({ kind: 'voice-start', detail: gainDb, at: Date.now() });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const finish = (killed: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      this.active--;
      if (timer) {
        clearTimeout(timer);
      }
      this.voices.push({ gainDb, bytes: Buffer.concat(chunks), killed });
      this.events.push({ kind: 'voice-end', detail: killed ? 'killed' : 'ended', at: Date.now() });
      if (killed) {
        resolve({ ok: false, reason: 'killed' });
      } else if (this.kind === 'none') {
        resolve({ ok: false, reason: 'no-player' });
      } else {
        resolve(this.options.voiceResult ?? { ok: true });
      }
    };
    return {
      write: async chunk => {
        chunks.push(chunk);
        if (this.options.drainMs !== undefined) {
          this.pendingWrites++;
          this.maxPendingWrites = Math.max(this.maxPendingWrites, this.pendingWrites);
          await new Promise(resolve => setTimeout(resolve, this.options.drainMs));
          this.pendingWrites--;
        }
      },
      end: () => { timer = setTimeout(() => finish(false), this.options.voiceMs ?? 20); },
      kill: () => finish(true),
      done,
    };
  }

  playPrelude(filePath: string): PreludePlayback {
    if (this.kind === 'none') {
      return { kill: () => undefined, done: Promise.resolve({ ok: false, reason: 'no-player' }) };
    }
    this.preludes.push(filePath);
    this.events.push({ kind: 'prelude', detail: filePath, at: Date.now() });
    let resolve!: (result: PlayResult) => void;
    const done = new Promise<PlayResult>(r => { resolve = r; });
    const timer = setTimeout(() => resolve({ ok: true }), this.options.preludeMs ?? 10);
    return { kill: () => { this.preludeKills++; clearTimeout(timer); resolve({ ok: false, reason: 'killed' }); }, done };
  }
}

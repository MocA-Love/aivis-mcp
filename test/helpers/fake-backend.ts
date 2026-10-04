import type { AudioBackend, PlayerKind, PreludePlayback, VoicePlayback } from '../../src/audio/player.js';

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

/**
 * 音を出さない鳴らし先。届いたバイトを記録し、入力が閉じてから `voiceMs` 後に鳴り終わる。
 */
export class FakeBackend implements AudioBackend {
  readonly kind: PlayerKind;
  readonly streaming = true;
  readonly canMeasure: boolean;
  readonly voices: PlayedVoice[] = [];
  readonly events: BackendEvent[] = [];
  readonly preludes: string[] = [];
  preludeKills = 0;

  constructor(private readonly options: { voiceMs?: number; preludeMs?: number; canMeasure?: boolean; kind?: PlayerKind } = {}) {
    this.canMeasure = options.canMeasure ?? false;
    this.kind = options.kind ?? 'ffplay';
  }

  startVoice(gainDb: number): VoicePlayback {
    const chunks: Buffer[] = [];
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    this.events.push({ kind: 'voice-start', detail: gainDb, at: Date.now() });
    const finish = (killed: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      this.voices.push({ gainDb, bytes: Buffer.concat(chunks), killed });
      this.events.push({ kind: 'voice-end', detail: killed ? 'killed' : 'ended', at: Date.now() });
      resolve();
    };
    return {
      write: chunk => { chunks.push(chunk); },
      end: () => { timer = setTimeout(() => finish(false), this.options.voiceMs ?? 20); },
      kill: () => finish(true),
      done,
    };
  }

  playPrelude(filePath: string): PreludePlayback {
    this.preludes.push(filePath);
    this.events.push({ kind: 'prelude', detail: filePath, at: Date.now() });
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const timer = setTimeout(resolve, this.options.preludeMs ?? 10);
    return { kill: () => { this.preludeKills++; clearTimeout(timer); resolve(); }, done };
  }
}

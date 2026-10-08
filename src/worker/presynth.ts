/**
 * モバイルへの先送り（Q309 A）。PC の再生待ちとモバイルへの転送を切り離す。
 *
 * 以前は、worker が再生の lock を取ってから合成し、その合成を Para Code（モバイル）へも流していた。PC の再生待ちが
 * 混むとモバイルへの到着も遅れ、待ちで期限切れ（normal 120 秒）になった声はモバイルにも届かなかった。
 *
 * いまは、worker が PC で何かを鳴らしている（または hold で止まっている）間、列で待っているエージェントの声のうち、
 * Para Code が「モバイルが聞いている」と答えた（ticket の `mobileListeners` が 1 以上）ものを、列の順に 1 本ずつ
 * 先に合成する。合成は Stream（`aivis-mcp:audio:<id>`）に書きながら Para Code へ送り、PC では順番が来たときに
 * その Stream から鳴らす（合成は 1 回だけ）。
 *
 * - 合成は worker 全体で 1 本ずつ（ElevenLabs は同時接続の上限で 429 を返す）。PC の番の合成を先に通す
 * - ElevenLabs の文脈（前の発話の ID）は、聞こえる順で直前の声の発話を合成したときだけつなぐ
 *   （{@link prevVoiceBefore}。取込の声・先送りしない声が間にあればつながない）
 * - 先送りした件は `aivis-mcp:presynth:<id>` に印を置く。worker が入れ替わっても、新しい worker は合成し直さず
 *   Stream から鳴らす（モバイルへ二重に送らない）
 */

import { parseJob, type Job } from '../queue/jobs.js';

/** 先に合成して持っておける件数と、Stream に溜める量の上限。超えた分は今どおり順番が来てから合成する。 */
export const PRESYNTH_MAX_ENTRIES = 16;
export const PRESYNTH_MAX_BYTES = 32 * 1024 * 1024;
/** 列を見直す間隔（PC で鳴らしている間・hold の間だけ）。 */
export const PRESYNTH_SCAN_MS = 250;
/** 持っている Stream の期限を延ばす間隔（Stream の期限は 180 秒）。 */
export const PRESYNTH_TOUCH_MS = 30_000;
/** 先送りの印の期限（hold で長く待っても残るように長め。鳴らしたら消す）。 */
export const PRESYNTH_MARKER_TTL_SECONDS = 30 * 60;

/** 合成を 1 本ずつに絞る。PC の番（main）を先送り（presynth）より先に通す。 */
export class SynthesisGate {
  private busy = false;
  private readonly waiters: { main: boolean; readonly key: string | undefined; readonly resolve: () => void }[] = [];

  /** 番が来たら、手放す関数を返す。`key` を付けた待ちは後から {@link promote} で PC の番に上げられる。 */
  acquire(priority: 'main' | 'presynth', key?: string): Promise<() => void> {
    return new Promise(resolve => {
      const grant = () => {
        let released = false;
        resolve(() => {
          if (released) {
            return;
          }
          released = true;
          this.next();
        });
      };
      if (!this.busy) {
        this.busy = true;
        grant();
        return;
      }
      const waiter = { main: priority === 'main', key, resolve: grant };
      if (waiter.main) {
        this.insertMain(waiter);
      } else {
        this.waiters.push(waiter);
      }
    });
  }

  /** `key` の待ちを PC の番に上げる（PC の順番が先送りの件に来たのに、まだ合成の番を待っているとき）。 */
  promote(key: string): void {
    const index = this.waiters.findIndex(waiter => waiter.key === key && !waiter.main);
    if (index < 0) {
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    waiter.main = true;
    this.insertMain(waiter);
  }

  /** 先送りの待ちより前、PC の番の待ちの後ろに入れる。 */
  private insertMain(waiter: { main: boolean; readonly key: string | undefined; readonly resolve: () => void }): void {
    const index = this.waiters.findIndex(entry => !entry.main);
    if (index < 0) {
      this.waiters.push(waiter);
    } else {
      this.waiters.splice(index, 0, waiter);
    }
  }

  private next(): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.busy = false;
      return;
    }
    waiter.resolve();
  }
}

/** 列の中身（LRANGE の結果）を、worker が取り出す順（high の古い順 → normal の古い順）に並べて読む。 */
export function jobsInDequeueOrder(high: readonly string[], normal: readonly string[]): Job[] {
  const jobs: Job[] = [];
  // LPUSH で積み BRPOP で取り出すので、右端（LRANGE の最後）が一番古い
  for (const list of [high, normal]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const parsed = parseJob(list[i]);
      if (parsed.kind === 'v2') {
        jobs.push(parsed.job);
      }
    }
  }
  return jobs;
}

/**
 * 聞こえる順で `index` の件の直前に来る声の発話の ID。列の中に無ければ `fallback`（いま鳴らしている件、無ければ
 * 最後に扱った件）。着信音だけの件（sound）は声ではないので飛ばす。
 */
export function prevVoiceBefore(jobs: readonly Job[], index: number, fallback: string | undefined): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (jobs[i].type !== 'sound') {
      return jobs[i].id;
    }
  }
  return fallback;
}

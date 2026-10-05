/**
 * ElevenLabs の「前の発話の文脈」を worker のメモリで覚える。
 *
 * worker 全体で、直前に合成した声の発話 1 件だけを覚える。次の発話がそれと同じ voice_id・model_id なら、
 * 前の発話の request ID（取れていなければ前の文）を要求に付けて声の調子をつなげる。どのペインからの発話かは問わない。
 * 間に別の声・別のモデル・Aivis の発話が挟まったら、その発話で置き換わるのでつなげない。
 * 取込の stream ジョブ（Para Code の通知や SSH 先から届いた合成済みの声）も聞き手には声なので、鳴らしたら記録を消す
 * （worker が {@link ElevenLabsContextMemory.forget} を呼ぶ）。着信音（sound ジョブ・prelude）は声でないので、挟まっても切れない。
 * 合成に失敗した・途中で止めた発話は記録を消す（次はつなげない）。
 * worker が入れ替わったら消える（ファイルにも Redis にも置かない）。
 */

/** ElevenLabs が request ID を受け付ける期間（公式の制約: 2 時間以内に作った要求だけ） */
export const REQUEST_ID_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** eleven_v3 系は previous_text / request stitching を使えない（公式の制約） */
export function supportsElevenLabsContext(modelId: string): boolean {
  return !/^eleven_v3/.test(modelId);
}

interface Remembered {
  readonly voiceId: string;
  readonly modelId: string;
  readonly requestId: string | undefined;
  readonly text: string;
  /** 読み終えた時刻 */
  readonly at: number;
}

/** 次の要求に付ける文脈。 */
export type ElevenLabsContext =
  | { readonly previous_request_ids: readonly string[] }
  | { readonly previous_text: string };

/** これから合成する声。Aivis の発話は undefined */
export interface ElevenLabsVoice {
  readonly voiceId: string;
  readonly modelId: string;
  /** 文脈を付ける時間（分）。0 で付けない */
  readonly windowMinutes: number;
}

export class ElevenLabsContextMemory {
  private last: Remembered | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 声の発話の合成を始める。直前の発話が同じ声・同じモデルで、窓の中なら、その文脈を返す
   * （request ID が 2 時間以内に取れていればそれを、無ければ前の文）。
   * 直前の記録はここで消す（この発話を読み終えたら {@link remember} で置き換わる。失敗・中断なら消えたまま）。
   */
  begin(voice: ElevenLabsVoice | undefined): ElevenLabsContext | undefined {
    const previous = this.last;
    this.last = undefined;
    if (voice === undefined || previous === undefined || !(voice.windowMinutes > 0) || !supportsElevenLabsContext(voice.modelId)) {
      return undefined;
    }
    if (previous.voiceId !== voice.voiceId || previous.modelId !== voice.modelId) {
      return undefined;
    }
    const age = this.now() - previous.at;
    if (age < 0 || age > voice.windowMinutes * 60_000) {
      return undefined;
    }
    if (previous.requestId !== undefined && age <= REQUEST_ID_MAX_AGE_MS) {
      return { previous_request_ids: [previous.requestId] };
    }
    return previous.text === '' ? undefined : { previous_text: previous.text };
  }

  /** 本文を最後まで読み終えた ElevenLabs の発話を、直前の発話として覚える。 */
  remember(voiceId: string, modelId: string, requestId: string | undefined, text: string): void {
    this.last = { voiceId, modelId, requestId, text, at: this.now() };
  }

  /** 直前の発話の記録を消す（合成を通らない声を鳴らしたとき。次の発話はつなげない）。 */
  forget(): void {
    this.last = undefined;
  }

  /** テスト用: 直前の発話を覚えているか */
  get hasLast(): boolean {
    return this.last !== undefined;
  }
}

/**
 * Redis への操作に上限を付ける。Redis が応答しなくなっても、待つ側を止めない。
 */

/** Redis が応答しないときに 1 つの操作を待つ上限。 */
export const REDIS_OP_TIMEOUT_MS = 5_000;

export class OperationTimeoutError extends Error {
  constructor(ms: number) {
    super(`redis timeout (${ms}ms)`);
    this.name = 'OperationTimeoutError';
  }
}

/** 上限つきで待つ。上限を過ぎたら OperationTimeoutError で失敗する（元の操作は取り消せない）。 */
export async function withTimeout<T>(promise: Promise<T>, ms = REDIS_OP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OperationTimeoutError(ms)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 上限つきで待つ。上限を過ぎたら false（失敗も終わりとして true）。 */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

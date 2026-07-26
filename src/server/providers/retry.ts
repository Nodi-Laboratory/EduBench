import { ProviderError } from './types';

export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?: (
    input: { attempt: number; delayMs: number; error: ProviderError },
  ) => Promise<void> | void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForRetryDelay(
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!signal) {
    await sleep(delayMs);
    return;
  }
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once:true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    await Promise.race([sleep(delayMs), aborted]);
  } finally {
    removeAbortListener();
  }
}

export async function withProviderRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 30_000;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || attempt >= options.maxAttempts) throw error;
      const exponential = Math.min(maxDelay, baseDelay * (2 ** (attempt - 1)));
      const delayMs = error.retryAfterMs ?? Math.round(exponential * (0.5 + random()));
      await options.onRetry?.({ attempt, delayMs, error });
      await waitForRetryDelay(delayMs, sleep, options.signal);
    }
  }
  throw new Error('unreachable');
}


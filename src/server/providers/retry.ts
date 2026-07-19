import { ProviderError } from './types';

type RetryOptions = {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (input: { attempt: number; delayMs: number; error: ProviderError }) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withProviderRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 30_000;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || attempt >= options.maxAttempts) throw error;
      const exponential = Math.min(maxDelay, baseDelay * (2 ** (attempt - 1)));
      const delayMs = error.retryAfterMs ?? Math.round(exponential * (0.5 + random()));
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw new Error('unreachable');
}


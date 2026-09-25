import { expect, test } from 'vitest';
import { ProviderError } from '@/server/providers/types';
import { withProviderRetry } from '@/server/providers/retry';

test('honors retry-after for rate limits and then returns the result', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await withProviderRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new ProviderError({ kind: 'RATE_LIMIT', message: 'limited', retryable: true, status: 429, retryAfterMs: 250 });
    return 'ok';
  }, { maxAttempts: 3, sleep: async (ms) => { delays.push(ms); }, random: () => 0.5 });

  expect(result).toBe('ok');
  expect(attempts).toBe(3);
  expect(delays).toEqual([250, 250]);
});

test('never retries authentication and invalid request errors', async () => {
  let attempts = 0;
  await expect(withProviderRetry(async () => {
    attempts += 1;
    throw new ProviderError({ kind: 'AUTH', message: 'unauthorized', retryable: false, status: 401 });
  }, { maxAttempts: 4, sleep: async () => undefined })).rejects.toMatchObject({ kind: 'AUTH' });
  expect(attempts).toBe(1);
});

test('can delegate rate-limit retry to an outer coordinator without sleeping', async () => {
  const rateLimit = new ProviderError({
    kind: 'RATE_LIMIT',
    message: 'limited',
    retryable: true,
    status: 429,
  });
  const delays: number[] = [];
  let attempts = 0;

  await expect(withProviderRetry(async () => {
    attempts += 1;
    throw rateLimit;
  }, {
    maxAttempts: 4,
    shouldRetry: (error) => error.kind !== 'RATE_LIMIT',
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  })).rejects.toBe(rateLimit);

  expect(attempts).toBe(1);
  expect(delays).toEqual([]);
});

test('interrupts a provider backoff immediately when the owning job is cancelled', async () => {
  const controller = new AbortController();
  const reason = new Error('job cancelled');
  let signalSleepStarted!: () => void;
  const sleepStarted = new Promise<void>((resolve) => {
    signalSleepStarted = resolve;
  });
  let releaseSleep!: () => void;
  const sleeping = new Promise<void>((resolve) => {
    releaseSleep = resolve;
  });

  const retried = withProviderRetry(async () => {
    throw new ProviderError({
      kind:'RATE_LIMIT',
      message:'limited',
      retryable:true,
      status:429,
    });
  }, {
    maxAttempts:3,
    signal:controller.signal,
    sleep:async () => {
      signalSleepStarted();
      await sleeping;
    },
  });

  await sleepStarted;
  controller.abort(reason);
  await expect(retried).rejects.toBe(reason);
  releaseSleep();
});

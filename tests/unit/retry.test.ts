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

import { expect, test } from 'vitest';
import { mapConcurrentOrdered } from '@/domain/parallel';

test('limits concurrent work while preserving input order', async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const resultPromise = mapConcurrentOrdered([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return value * 10;
  });

  await viWaitUntil(() => releases.length === 2);
  releases.shift()!();
  await viWaitUntil(() => releases.length === 2);
  releases.shift()!();
  await viWaitUntil(() => releases.length === 2);
  releases.shift()!();
  releases.shift()!();

  await expect(resultPromise).resolves.toEqual([10, 20, 30, 40]);
  expect(peak).toBe(2);
});

test('rejects invalid concurrency', async () => {
  await expect(mapConcurrentOrdered([1], 0, async (value) => value)).rejects.toThrow('concurrency');
});

async function viWaitUntil(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

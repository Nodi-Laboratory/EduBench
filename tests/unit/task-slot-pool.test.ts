import { expect, test, vi } from 'vitest';
import {
  fillTaskSlots,
  TaskSlotPool,
} from '@/server/jobs/task-slot-pool';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('reopens a completed document slot while an unrelated long task is still running', async () => {
  const failures: unknown[] = [];
  const pool = new TaskSlotPool(
    { 'document.parse':2, 'question.generate':4 },
    (error) => failures.push(error),
  );
  const document = deferred();
  const generation = deferred();

  expect(pool.start('document.parse', 'document-1', async () => {
    await document.promise;
  })).toBe(true);
  expect(pool.start('question.generate', 'generation-1', async () => {
    await generation.promise;
  })).toBe(true);
  expect(pool.available('document.parse')).toBe(1);

  document.resolve();
  await vi.waitFor(() => expect(pool.available('document.parse')).toBe(2));
  expect(pool.available('question.generate')).toBe(3);
  expect(pool.start('document.parse', 'document-2', async () => undefined))
    .toBe(true);
  await vi.waitFor(() => expect(pool.available('document.parse')).toBe(2));

  generation.resolve();
  await pool.drain();
  expect(failures).toEqual([]);
});

test('does not start the same leased job twice', async () => {
  const release = deferred();
  const pool = new TaskSlotPool({ 'document.parse':1 });
  expect(pool.start('document.parse', 'same-job', async () => {
    await release.promise;
  })).toBe(true);
  expect(pool.start('document.parse', 'same-job', async () => undefined))
    .toBe(false);
  expect(pool.available('document.parse')).toBe(0);
  release.resolve();
  await pool.drain();
});

test('starts jobs from a successful claim even when another kind claim fails', async () => {
  const claimErrors: unknown[] = [];
  const started: string[] = [];
  const pool = new TaskSlotPool({
    'document.parse':1,
    'question.generate':1,
  });

  const [documents, generations] = await Promise.all([
    fillTaskSlots({
      pool,
      kind:'document.parse',
      claim:async () => [{ id:'document-1' }],
      run:async (job) => {
        started.push(job.id);
      },
      onClaimError:(error) => claimErrors.push(error),
    }),
    fillTaskSlots({
      pool,
      kind:'question.generate',
      claim:async () => {
        throw new Error('generation claim unavailable');
      },
      run:async () => undefined,
      onClaimError:(error) => claimErrors.push(error),
    }),
  ]);

  expect([documents, generations]).toEqual([1, 0]);
  await pool.drain();
  expect(started).toEqual(['document-1']);
  expect(claimErrors).toHaveLength(1);
});

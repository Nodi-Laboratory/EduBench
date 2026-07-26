import { expect, test, vi } from 'vitest';
import { db } from '@/server/db/pool';
import { PostgresAdvisoryConcurrencyGate } from '@/server/providers/postgres-concurrency-gate';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('coordinates and releases a real advisory slot across PostgreSQL sessions', async () => {
  const firstGate = new PostgresAdvisoryConcurrencyGate(db, {
    namespace:45_398,
    limit:1,
    pollIntervalMs:5,
  });
  const secondGate = new PostgresAdvisoryConcurrencyGate(db, {
    namespace:45_398,
    limit:1,
    pollIntervalMs:5,
  });
  const firstRelease = deferred();
  const started: string[] = [];

  const first = firstGate.run(async () => {
    started.push('first');
    await firstRelease.promise;
  });
  await vi.waitFor(() => expect(started).toEqual(['first']));
  const second = secondGate.run(async () => {
    started.push('second');
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(started).toEqual(['first']);

  firstRelease.resolve();
  await Promise.all([first, second]);
  expect(started).toEqual(['first', 'second']);
});

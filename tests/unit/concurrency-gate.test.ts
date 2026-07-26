import { expect, test, vi } from 'vitest';
import { ConcurrencyGate } from '@/server/providers/concurrency-gate';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('shares a fixed provider concurrency budget across independent callers', async () => {
  const gate = new ConcurrencyGate(2);
  const releases = [deferred(), deferred(), deferred()];
  const started: number[] = [];

  const tasks = releases.map((release, index) => gate.run(async () => {
    started.push(index + 1);
    await release.promise;
    return index + 1;
  }));

  await vi.waitFor(() => expect(started).toEqual([1, 2]));
  releases[0]!.resolve();
  await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
  releases[1]!.resolve();
  releases[2]!.resolve();

  await expect(Promise.all(tasks)).resolves.toEqual([1, 2, 3]);
});

test('removes an aborted caller from the provider queue without consuming a slot', async () => {
  const gate = new ConcurrencyGate(1);
  const firstRelease = deferred();
  let queuedOperationStarted = false;
  const first = gate.run(async () => {
    await firstRelease.promise;
  });
  const controller = new AbortController();
  const reason = new Error('request cancelled');
  const queued = gate.run(async () => {
    queuedOperationStarted = true;
  }, controller.signal);

  controller.abort(reason);
  await expect(queued).rejects.toBe(reason);
  expect(queuedOperationStarted).toBe(false);
  firstRelease.resolve();
  await first;
  await expect(gate.run(async () => 'next')).resolves.toBe('next');
});

import { expect, test, vi } from 'vitest';
import {
  PostgresAdvisoryConcurrencyGate,
  type AdvisoryLockPool,
} from '@/server/providers/postgres-concurrency-gate';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sharedAdvisoryPool(): AdvisoryLockPool {
  const held = new Set<number>();
  return {
    connect:async () => ({
      query:async <T>(sql: string, values?: unknown[]) => {
        const slot = Number(values?.[1]);
        if (sql.includes('pg_try_advisory_lock')) {
          const locked = !held.has(slot);
          if (locked) held.add(slot);
          return { rows:[{ locked } as T] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          held.delete(slot);
          return { rows:[{ unlocked:true } as T] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      release:() => undefined,
    }),
  };
}

test('coordinates one Upstage slot budget across separate process-level gate instances', async () => {
  const pool = sharedAdvisoryPool();
  const workerGate = new PostgresAdvisoryConcurrencyGate(pool, {
    namespace:45_321,
    limit:2,
    pollIntervalMs:1,
    sleep:async () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const webGate = new PostgresAdvisoryConcurrencyGate(pool, {
    namespace:45_321,
    limit:2,
    pollIntervalMs:1,
    sleep:async () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const releases = [deferred(), deferred(), deferred()];
  const started: number[] = [];

  const tasks = [
    workerGate.run(async () => {
      started.push(1);
      await releases[0]!.promise;
    }),
    workerGate.run(async () => {
      started.push(2);
      await releases[1]!.promise;
    }),
    webGate.run(async () => {
      started.push(3);
      await releases[2]!.promise;
    }),
  ];

  await vi.waitFor(() => expect(started).toHaveLength(2));
  releases[started[0]! - 1]!.resolve();
  await vi.waitFor(() => expect(started).toHaveLength(3));
  releases.forEach((release) => release.resolve());
  await Promise.all(tasks);
});

test('cancels while waiting for a pool connection and releases a late connection', async () => {
  let resolveConnection!: (client: Awaited<ReturnType<AdvisoryLockPool['connect']>>) => void;
  const connection = new Promise<Awaited<ReturnType<AdvisoryLockPool['connect']>>>((resolve) => {
    resolveConnection = resolve;
  });
  const release = vi.fn();
  const pool: AdvisoryLockPool = {
    connect:() => connection,
  };
  const gate = new PostgresAdvisoryConcurrencyGate(pool, {
    namespace:45_321,
    limit:1,
  });
  const controller = new AbortController();
  const reason = new Error('worker stopping');
  let settled = false;
  const pending = gate.run(async () => undefined, controller.signal);
  void pending.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  controller.abort(reason);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const settledBeforeConnection = settled;
  resolveConnection({
    query:async <T>() => ({ rows:[] as T[] }),
    release,
  });

  await expect(pending).rejects.toBe(reason);
  expect(settledBeforeConnection).toBe(true);
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
});

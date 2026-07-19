import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  recoverExpiredLeases,
} from '@/server/jobs/queue';

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await db.query('delete from job_events');
  await db.query('delete from jobs');
});

afterAll(async () => {
  await db.end();
});

test('returns the existing job for a duplicate idempotency key', async () => {
  const first = await enqueueJob({ kind: 'document.parse', payload: { sourceId: 'one' }, idempotencyKey: 'parse:one' });
  const second = await enqueueJob({ kind: 'document.parse', payload: { sourceId: 'one' }, idempotencyKey: 'parse:one' });

  expect(second.id).toBe(first.id);
  expect(first.existing).toBe(false);
  expect(second.existing).toBe(true);
});

test('two concurrent workers never claim the same job', async () => {
  await enqueueJob({ kind: 'benchmark.execute', payload: { item: 1 }, idempotencyKey: 'run:1' });
  await enqueueJob({ kind: 'benchmark.execute', payload: { item: 2 }, idempotencyKey: 'run:2' });

  const [a, b] = await Promise.all([
    claimJobs('worker-a', 1, 60_000),
    claimJobs('worker-b', 1, 60_000),
  ]);

  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0]?.id).not.toBe(b[0]?.id);
});

test('recovers an expired lease and makes the job claimable', async () => {
  const job = await enqueueJob({ kind: 'document.embed', payload: { sourceId: 'two' }, idempotencyKey: 'embed:two' });
  await claimJobs('dead-worker', 1, 60_000);
  await db.query(`update jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [job.id]);

  expect(await recoverExpiredLeases()).toBe(1);
  const claimed = await claimJobs('replacement-worker', 1, 60_000);
  expect(claimed[0]?.id).toBe(job.id);
  expect(claimed[0]?.attempts).toBe(2);
});

test('completes only a job leased by the same worker and records an event', async () => {
  await enqueueJob({ kind: 'document.chunk', payload: { sourceId: 'three' }, idempotencyKey: 'chunk:three' });
  const [job] = await claimJobs('worker-a', 1, 60_000);
  await completeJob(job!.id, 'worker-a', { chunks: 12 });

  const stored = await db.query<{ state: string; result: { chunks: number } }>(
    'select state, result from jobs where id = $1', [job!.id],
  );
  const events = await db.query<{ event_type: string }>(
    'select event_type from job_events where job_id = $1 order by id', [job!.id],
  );
  expect(stored.rows[0]).toMatchObject({ state: 'SUCCEEDED', result: { chunks: 12 } });
  expect(events.rows.map((event) => event.event_type)).toEqual(['JOB_ENQUEUED', 'JOB_CLAIMED', 'JOB_SUCCEEDED']);
});

test('marks an exhausted job as terminal instead of retrying forever', async () => {
  await enqueueJob({
    kind: 'benchmark.execute', payload: { item: 9 }, idempotencyKey: 'run:9', maxAttempts: 1,
  });
  const [job] = await claimJobs('worker-a', 1, 60_000);
  const state = await failJob(job!.id, 'worker-a', {
    code: 'PROVIDER_5XX', message: 'upstream unavailable', retryDelayMs: 5,
  });

  expect(state).toBe('TERMINAL_FAILED');
  const stored = await db.query<{ state: string }>('select state from jobs where id = $1', [job!.id]);
  expect(stored.rows[0]?.state).toBe('TERMINAL_FAILED');
});

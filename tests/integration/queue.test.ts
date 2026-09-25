import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  claimJobs,
  completeJob,
  deferJobForProviderCooldown,
  enqueueJob,
  failJob,
  releaseJobForShutdown,
  recoverExpiredLeases,
  renewJobLease,
  withJobLeaseHeartbeat,
} from '@/server/jobs/queue';

test('defers a rate-limited job until the provider cooldown expires without consuming its attempt', async () => {
  const job = await enqueueJob({
    kind:'question.generate',
    payload:{ batchId:'00000000-0000-4000-8000-000000000042' },
    idempotencyKey:'generation:provider-cooldown',
    maxAttempts:1,
  });
  const [claimed] = await claimJobs('worker-cooldown', 1, 60_000, ['question.generate']);
  const blockedUntil = new Date(Date.now() + 60_000);

  await deferJobForProviderCooldown({
    jobId:claimed!.id,
    workerId:'worker-cooldown',
    attempt:claimed!.attempts,
  }, {
    providerKey:'gemini',
    blockedUntil,
    rateLimitDimension:'RPM',
    rateLimitScope:null,
    retryAfterMs:60_000,
    sourceRunId:null,
    sourceRunItemId:null,
    sourcePhase:'QUESTION_GENERATION',
    sourceModelId:null,
    requestId:null,
    lastErrorMessage:'rate limited',
    hitCount:1,
    activatedAt:new Date(),
    resumedAt:null,
    updatedAt:new Date(),
  });

  const deferred = await db.query<{ state:string; attempts:number; available_at:Date }>(
    'select state,attempts,available_at from jobs where id=$1',
    [job.id],
  );
  expect(deferred.rows[0]).toMatchObject({ state:'RETRY_WAIT', attempts:0 });
  expect(deferred.rows[0]!.available_at.getTime()).toBeGreaterThanOrEqual(blockedUntil.getTime() - 1_000);
  await expect(claimJobs('replacement-worker', 1, 60_000, ['question.generate'])).resolves.toEqual([]);
});

test('releases generation-item ownership without rewinding its audit attempt when deferring its leased job', async () => {
  const batchId = '00000000-0000-4000-8000-000000000043';
  await db.query('delete from generation_items where generation_batch_id=$1', [batchId]);
  await db.query('delete from generation_batches where id=$1', [batchId]);
  await db.query(
    `insert into generation_batches(
       id,state,requested_count,conditions,source_scope,generation_model,prompt_version
     ) values($1,'RUNNING',1,'{}'::jsonb,'{}'::jsonb,'test','test')`,
    [batchId],
  );
  const job = await enqueueJob({
    kind:'question.generate', payload:{ batchId }, idempotencyKey:'generation:provider-cooldown-item',
  });
  const [claimed] = await claimJobs('worker-cooldown-item', 1, 60_000, ['question.generate']);
  await db.query(
    `insert into generation_items(
       generation_batch_id,ordinal,state,attempts,claimed_job_id,claimed_job_attempt,started_at
     ) values($1,1,'RUNNING',3,$2,$3,now())`,
    [batchId, job.id, claimed!.attempts],
  );

  await deferJobForProviderCooldown({
    jobId:job.id, workerId:'worker-cooldown-item', attempt:claimed!.attempts,
  }, {
    providerKey:'gemini', blockedUntil:new Date(Date.now() + 60_000),
    rateLimitDimension:'RPM', rateLimitScope:null, retryAfterMs:60_000,
    sourceRunId:null, sourceRunItemId:null, sourcePhase:'QUESTION_GENERATION',
    sourceModelId:null, requestId:null, lastErrorMessage:'rate limited', hitCount:1,
    activatedAt:new Date(), resumedAt:null, updatedAt:new Date(),
  });

  const item = await db.query<{
    state:string; attempts:number; claimed_job_id:string | null; claimed_job_attempt:number | null;
  }>('select state,attempts,claimed_job_id,claimed_job_attempt from generation_items where generation_batch_id=$1', [batchId]);
  expect(item.rows[0]).toEqual({
    state:'PENDING', attempts:3, claimed_job_id:null, claimed_job_attempt:null,
  });
  await db.query('delete from generation_items where generation_batch_id=$1', [batchId]);
  await db.query('delete from generation_batches where id=$1', [batchId]);
});

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

test('terminates a non-retryable failure immediately without consuming remaining attempts', async () => {
  await enqueueJob({
    kind: 'question.generate',
    payload: { batchId: '00000000-0000-4000-8000-000000000001' },
    idempotencyKey: 'generation:non-retryable',
    maxAttempts: 5,
  });
  const [job] = await claimJobs('worker-a', 1, 60_000);
  const state = await failJob({
    jobId: job!.id,
    workerId: 'worker-a',
    attempt: job!.attempts,
  }, {
    code: 'GENERATION_FORMAT_MISMATCH',
    message: '구조화 출력이 스키마와 일치하지 않습니다.',
    retryDelayMs: 0,
    retryable: false,
  });

  expect(state).toBe('TERMINAL_FAILED');
  const stored = await db.query<{ state: string; attempts: number; max_attempts: number }>(
    'select state,attempts,max_attempts from jobs where id=$1',
    [job!.id],
  );
  expect(stored.rows[0]).toEqual({ state: 'TERMINAL_FAILED', attempts: 1, max_attempts: 5 });
});

test('renews a slow job through its claim attempt until all sequential work finishes', async () => {
  await enqueueJob({ kind: 'document.parse', payload: { sourceId: 'slow' }, idempotencyKey: 'parse:slow' });
  const [job] = await claimJobs('worker-heartbeat', 1, 120);
  const lease = { jobId: job!.id, workerId: 'worker-heartbeat', attempt: job!.attempts };
  const pages: number[] = [];

  await withJobLeaseHeartbeat(lease, { leaseMs: 120, heartbeatMs: 20 }, async (signal) => {
    for (const page of [1, 2, 3]) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      signal.throwIfAborted();
      pages.push(page);
    }
    expect(await recoverExpiredLeases()).toBe(0);
    expect(await claimJobs('replacement-worker', 1, 120)).toEqual([]);
  });

  expect(pages).toEqual([1, 2, 3]);
  await completeJob(lease, { pages: pages.length });
});

test('propagates a worker shutdown signal into an active leased operation', async () => {
  await enqueueJob({ kind: 'document.parse', payload: { sourceId: 'shutdown' }, idempotencyKey: 'parse:shutdown' });
  const [job] = await claimJobs('worker-shutdown', 1, 60_000);
  const lease = { jobId: job!.id, workerId: 'worker-shutdown', attempt: job!.attempts };
  const controller = new AbortController();
  const reason = new Error('worker stopping');

  const active = withJobLeaseHeartbeat(
    lease,
    { leaseMs: 60_000, heartbeatMs: 20, signal:controller.signal },
    async (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once:true });
    }),
  );
  controller.abort(reason);

  await expect(active).rejects.toBe(reason);
});

test('releases a shutdown job without consuming its final attempt', async () => {
  await enqueueJob({
    kind:'document.parse',
    payload:{ sourceId:'shutdown-final-attempt' },
    idempotencyKey:'parse:shutdown-final-attempt',
    maxAttempts:1,
  });
  const [job] = await claimJobs('worker-shutdown-final', 1, 60_000);
  const lease = {
    jobId:job!.id,
    workerId:'worker-shutdown-final',
    attempt:job!.attempts,
  };

  await releaseJobForShutdown(lease);
  const released = await db.query<{
    state:string;
    attempts:number;
    max_attempts:number;
    last_error_code:string;
  }>('select state,attempts,max_attempts,last_error_code from jobs where id=$1', [job!.id]);
  expect(released.rows[0]).toEqual({
    state:'RETRY_WAIT',
    attempts:1,
    max_attempts:2,
    last_error_code:'WORKER_SHUTDOWN',
  });

  const [resumed] = await claimJobs('replacement-worker', 1, 60_000);
  expect(resumed).toMatchObject({ id:job!.id, attempts:2 });
});

test('rejects renewal, completion, and failure from a reclaimed attempt even with the same worker id', async () => {
  await enqueueJob({ kind: 'document.parse', payload: { sourceId: 'stale' }, idempotencyKey: 'parse:stale' });
  const [first] = await claimJobs('worker-reused', 1, 60_000);
  const staleLease = { jobId: first!.id, workerId: 'worker-reused', attempt: first!.attempts };
  await db.query(`update jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [first!.id]);
  expect(await recoverExpiredLeases()).toBe(1);
  const [second] = await claimJobs('worker-reused', 1, 60_000);
  const currentLease = { jobId: second!.id, workerId: 'worker-reused', attempt: second!.attempts };

  await expect(renewJobLease(staleLease, 60_000)).resolves.toBe(false);
  await expect(completeJob(staleLease, { stale: true })).rejects.toMatchObject({ code: 'JOB_LEASE_MISMATCH' });
  await expect(failJob(staleLease, { code: 'STALE', message: 'stale failure', retryDelayMs: 0 })).rejects.toMatchObject({ code: 'JOB_LEASE_MISMATCH' });

  const stillCurrent = await db.query<{ state: string; attempts: number; result: unknown; last_error_code: string | null }>(
    'select state, attempts, result, last_error_code from jobs where id = $1', [second!.id],
  );
  expect(stillCurrent.rows[0]).toMatchObject({ state: 'LEASED', attempts: 2, result: null, last_error_code: 'LEASE_EXPIRED' });
  await completeJob(currentLease, { current: true });
});

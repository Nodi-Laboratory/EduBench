import type { PoolClient } from 'pg';
import { withTransaction } from '@/server/db/transaction';
import { DomainError } from '@/domain/errors';

export type JobState = 'PENDING' | 'LEASED' | 'RETRY_WAIT' | 'SUCCEEDED' | 'TERMINAL_FAILED' | 'CANCELLED';

export type JobRecord = {
  id: string;
  kind: string;
  state: JobState;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
};

export type JobLease = {
  jobId: string;
  workerId: string;
  attempt: number;
};

export type EnqueueInput = {
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
};

async function appendEvent(
  client: PoolClient,
  jobId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await client.query(
    `insert into job_events(job_id, aggregate_type, aggregate_id, event_type, payload)
     values ($1, 'job', $1, $2, $3::jsonb)`,
    [jobId, eventType, JSON.stringify(payload)],
  );
}

export async function cancelJobWithClient(client: PoolClient, jobId: string): Promise<boolean> {
  const cancelled = await client.query(
    `update jobs set state = 'CANCELLED', lease_owner = null, lease_expires_at = null,
       completed_at = now(), updated_at = now()
     where id = $1 and state in ('PENDING', 'RETRY_WAIT', 'LEASED') returning id`,
    [jobId],
  );
  if (!cancelled.rowCount) return false;
  await appendEvent(client, jobId, 'JOB_CANCELLED', { requestedBy: 'user' });
  return true;
}

export async function enqueueJobWithClient(client: PoolClient, input: EnqueueInput): Promise<{ id: string; existing: boolean }> {
  const inserted = await client.query<{ id: string }>(
      `insert into jobs(kind, payload, idempotency_key, priority, max_attempts, available_at)
       values ($1, $2::jsonb, $3, $4, $5, coalesce($6::timestamptz, now()))
       on conflict(idempotency_key) do nothing
       returning id`,
      [
        input.kind,
        JSON.stringify(input.payload),
        input.idempotencyKey,
        input.priority ?? 100,
        input.maxAttempts ?? 4,
        input.availableAt ?? null,
      ],
  );
  if (inserted.rows[0]) {
    await appendEvent(client, inserted.rows[0].id, 'JOB_ENQUEUED', { kind: input.kind });
    return { id: inserted.rows[0].id, existing: false };
  }
  const existing = await client.query<{ id: string }>(
    'select id from jobs where idempotency_key = $1', [input.idempotencyKey],
  );
  const id = existing.rows[0]?.id;
  if (!id) throw new DomainError('JOB_ENQUEUE_RACE', '중복 작업을 조회하지 못했습니다.');
  return { id, existing: true };
}

export async function enqueueJob(input: EnqueueInput): Promise<{ id: string; existing: boolean }> {
  return withTransaction((client) => enqueueJobWithClient(client, input));
}

export async function claimJobs(
  workerId: string,
  limit: number,
  leaseMs: number,
  kinds?: string[],
): Promise<JobRecord[]> {
  if (limit < 1 || leaseMs < 1) throw new DomainError('INVALID_CLAIM_OPTIONS', 'limit와 leaseMs는 1 이상이어야 합니다.');
  return withTransaction(async (client) => {
    const result = await client.query<JobRecord>(
      `with candidates as (
         select id from jobs
         where state in ('PENDING', 'RETRY_WAIT')
           and available_at <= now()
           and attempts < max_attempts
           and ($4::text[] is null or kind = any($4::text[]))
         order by priority asc, created_at asc
         for update skip locked
         limit $2
       )
       update jobs j set
         state = 'LEASED',
         lease_owner = $1,
         lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
         attempts = j.attempts + 1,
         updated_at = now()
       from candidates c
       where j.id = c.id
       returning j.id, j.kind, j.state, j.payload, j.idempotency_key,
         j.attempts, j.max_attempts, j.lease_owner, j.lease_expires_at`,
      [workerId, limit, leaseMs, kinds ?? null],
    );
    for (const job of result.rows) {
      await appendEvent(client, job.id, 'JOB_CLAIMED', { workerId, attempt: job.attempts });
    }
    return result.rows;
  });
}

export async function renewJobLease(lease: JobLease, leaseMs: number): Promise<boolean> {
  if (leaseMs < 1) throw new DomainError('INVALID_LEASE_DURATION', 'leaseMs는 1 이상이어야 합니다.');
  const renewed = await withTransaction((client) => client.query(
    `update jobs set lease_expires_at = now() + ($4::bigint * interval '1 millisecond'), updated_at = now()
     where id = $1 and state = 'LEASED' and lease_owner = $2 and attempts = $3
       and lease_expires_at > now()
     returning id`,
    [lease.jobId, lease.workerId, lease.attempt, leaseMs],
  ));
  return Boolean(renewed.rowCount);
}

export async function withJobLeaseHeartbeat<T>(
  lease: JobLease,
  options: { leaseMs: number; heartbeatMs?: number },
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const heartbeatMs = options.heartbeatMs ?? Math.min(60_000, Math.max(1, Math.floor(options.leaseMs / 3)));
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (!await renewJobLease(lease, options.leaseMs)) {
        controller.abort(new DomainError('JOB_LEASE_MISMATCH', '작업 lease가 만료되었거나 다른 시도에 선점되었습니다.', lease));
      }
    }).catch((error) => controller.abort(error));
  }, heartbeatMs);

  try {
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

export async function completeJob(lease: JobLease, result: Record<string, unknown>): Promise<void>;
export async function completeJob(jobId: string, workerId: string, result: Record<string, unknown>): Promise<void>;
export async function completeJob(
  leaseOrJobId: JobLease | string,
  resultOrWorkerId: Record<string, unknown> | string,
  maybeResult?: Record<string, unknown>,
): Promise<void> {
  const lease = typeof leaseOrJobId === 'string'
    ? { jobId: leaseOrJobId, workerId: resultOrWorkerId as string, attempt: null }
    : leaseOrJobId;
  const result = (typeof leaseOrJobId === 'string' ? maybeResult : resultOrWorkerId) as Record<string, unknown>;
  await withTransaction(async (client) => {
    const updated = await client.query(
      `update jobs set state = 'SUCCEEDED', result = $4::jsonb,
         lease_owner = null, lease_expires_at = null, completed_at = now(), updated_at = now()
       where id = $1 and state = 'LEASED' and lease_owner = $2
         and ($3::int is null or attempts = $3) and lease_expires_at > now()
       returning id`,
      [lease.jobId, lease.workerId, lease.attempt, JSON.stringify(result)],
    );
    if (!updated.rowCount) throw new DomainError('JOB_LEASE_MISMATCH', '작업 lease 소유자가 일치하지 않습니다.', lease);
    await appendEvent(client, lease.jobId, 'JOB_SUCCEEDED', { workerId: lease.workerId, attempt: lease.attempt });
  });
}

type JobFailure = { code: string; message: string; retryDelayMs: number };

export async function failJob(lease: JobLease, error: JobFailure): Promise<'RETRY_WAIT' | 'TERMINAL_FAILED'>;
export async function failJob(jobId: string, workerId: string, error: JobFailure): Promise<'RETRY_WAIT' | 'TERMINAL_FAILED'>;
export async function failJob(
  leaseOrJobId: JobLease | string,
  errorOrWorkerId: JobFailure | string,
  maybeError?: JobFailure,
): Promise<'RETRY_WAIT' | 'TERMINAL_FAILED'> {
  const lease = typeof leaseOrJobId === 'string'
    ? { jobId: leaseOrJobId, workerId: errorOrWorkerId as string, attempt: null }
    : leaseOrJobId;
  const error = (typeof leaseOrJobId === 'string' ? maybeError : errorOrWorkerId) as JobFailure;
  return withTransaction(async (client) => {
    const current = await client.query<{ attempts: number; max_attempts: number }>(
      `select attempts, max_attempts from jobs
       where id = $1 and state = 'LEASED' and lease_owner = $2
         and ($3::int is null or attempts = $3) and lease_expires_at > now() for update`,
      [lease.jobId, lease.workerId, lease.attempt],
    );
    const job = current.rows[0];
    if (!job) throw new DomainError('JOB_LEASE_MISMATCH', '작업 lease 소유자가 일치하지 않습니다.', lease);
    const state = job.attempts >= job.max_attempts ? 'TERMINAL_FAILED' : 'RETRY_WAIT';
    await client.query(
      `update jobs set state = $3, last_error_code = $4, last_error_message = $5,
         available_at = case when $3 = 'RETRY_WAIT'
           then now() + ($6::bigint * interval '1 millisecond') else available_at end,
         lease_owner = null, lease_expires_at = null,
         completed_at = case when $3 = 'TERMINAL_FAILED' then now() else null end,
         updated_at = now()
       where id = $1 and lease_owner = $2 and ($7::int is null or attempts = $7)`,
      [lease.jobId, lease.workerId, state, error.code, error.message, error.retryDelayMs, lease.attempt],
    );
    await appendEvent(client, lease.jobId, state === 'RETRY_WAIT' ? 'JOB_RETRY_SCHEDULED' : 'JOB_TERMINAL_FAILED', {
      workerId: lease.workerId, attempt: lease.attempt, code: error.code, retryDelayMs: error.retryDelayMs,
    });
    return state;
  });
}

export async function recoverExpiredLeases(): Promise<number> {
  return withTransaction(async (client) => {
    const expired = await client.query<{ id: string; lease_owner: string | null }>(
      `update jobs set state = 'RETRY_WAIT', available_at = now(),
         lease_owner = null, lease_expires_at = null, updated_at = now(),
         last_error_code = 'LEASE_EXPIRED', last_error_message = '작업자 lease가 만료되어 재선점 대기 중입니다.'
       where state = 'LEASED' and lease_expires_at < now()
       returning id, lease_owner`,
    );
    for (const job of expired.rows) {
      await appendEvent(client, job.id, 'JOB_LEASE_RECOVERED', { previousWorkerId: job.lease_owner });
    }
    return expired.rowCount ?? 0;
  });
}

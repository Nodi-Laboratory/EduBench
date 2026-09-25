import type { PoolClient } from 'pg';
import { withTransaction } from '@/server/db/transaction';
import { DomainError } from '@/domain/errors';
import type { BenchmarkProviderCooldown } from '@/server/runs/provider-cooldown';

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

export async function assertJobLeaseWithClient(
  client: PoolClient,
  lease: JobLease,
): Promise<void> {
  const current = await client.query(
    `select id
       from jobs
      where id=$1
        and state='LEASED'
        and lease_owner=$2
        and attempts=$3
        and lease_expires_at>now()
      for update`,
    [lease.jobId, lease.workerId, lease.attempt],
  );
  if (!current.rowCount) {
    throw new DomainError(
      'JOB_LEASE_MISMATCH',
      '작업 lease가 만료되었거나 다른 실행 시도에 선점되었습니다.',
      lease,
    );
  }
}

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

async function reconcileTerminalGenerationLease(
  client: PoolClient,
  job: {
    id: string;
    attempts: number;
    payload: Record<string, unknown>;
  },
) {
  const batchId = job.payload.batchId;
  if (typeof batchId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
    return;
  }
  const batch = await client.query<{ state: string }>(
    `select state
       from generation_batches
      where id=$1
      for update`,
    [batchId],
  );
  if (!batch.rows[0]) return;

  const message = 'LEASE_EXPIRED: 최종 실행 시도의 작업자 lease가 만료되었습니다.';
  if (batch.rows[0].state !== 'COMPLETED') {
    await client.query(
      `update generation_items
          set state='FAILED',
              retryable=true,
              error_code='LEASE_EXPIRED',
              error_message=$4,
              completed_at=null,
              updated_at=now()
        where generation_batch_id=$1
          and state='RUNNING'
          and claimed_job_id=$2
          and claimed_job_attempt=$3`,
      [batchId, job.id, job.attempts, message],
    );
    const summary = await client.query<{
      completed: number;
      failed: number;
      running: number;
      pending: number;
      item_errors: Array<{
        ordinal: number;
        code: string;
        message: string;
        retryable: boolean;
      }>;
    }>(
      `select count(*) filter(where state='COMPLETED')::int as completed,
              count(*) filter(where state='FAILED')::int as failed,
              count(*) filter(where state='RUNNING')::int as running,
              count(*) filter(where state='PENDING')::int as pending,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'ordinal',ordinal,
                    'code',coalesce(error_code,'GENERATION_ITEM_FAILED'),
                    'message',coalesce(error_message,'문항 생성에 실패했습니다.'),
                    'retryable',retryable
                  )
                  order by ordinal
                ) filter(where state='FAILED'),
                '[]'::jsonb
              ) as item_errors
         from generation_items
        where generation_batch_id=$1`,
      [batchId],
    );
    const counts = summary.rows[0]!;
    await client.query(
      `update generation_batches
          set state='FAILED',
              progress=(progress-'error'-'itemErrors')
                || jsonb_build_object(
                  'currentStage',7,
                  'completedQuestions',$2::int,
                  'failedQuestions',$3::int,
                  'runningQuestions',$4::int,
                  'pendingQuestions',$5::int,
                  'itemErrors',$6::jsonb,
                  'error',$7::text
                ),
              updated_at=now()
        where id=$1 and state<>'COMPLETED'`,
      [
        batchId,
        counts.completed,
        counts.failed,
        counts.running,
        counts.pending,
        JSON.stringify(counts.item_errors),
        message,
      ],
    );
    await client.query(
      `insert into job_events(job_id,aggregate_type,aggregate_id,event_type,payload)
       values($1,'generation',$2,'GENERATION_FAILED',$3::jsonb)`,
      [
        job.id,
        batchId,
        JSON.stringify({
          code: 'LEASE_EXPIRED',
          message,
          retryable: true,
          attempt: job.attempts,
          completedQuestions: counts.completed,
          failedQuestions: counts.failed,
        }),
      ],
    );
  }
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
  options: { leaseMs: number; heartbeatMs?: number; signal?:AbortSignal },
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener('abort', abortFromParent, { once:true });
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
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', abortFromParent);
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

export async function releaseJobForShutdown(lease: JobLease): Promise<void> {
  await withTransaction(async (client) => {
    const released = await client.query<{
      attempts:number;
      max_attempts:number;
    }>(
      `update jobs
          set state='RETRY_WAIT',
              max_attempts=max_attempts+1,
              available_at=now(),
              lease_owner=null,
              lease_expires_at=null,
              completed_at=null,
              last_error_code='WORKER_SHUTDOWN',
              last_error_message='작업자 종료 신호로 실행을 중단했으며 다음 작업자가 이어서 처리합니다.',
              updated_at=now()
        where id=$1
          and state='LEASED'
          and lease_owner=$2
          and attempts=$3
          and lease_expires_at>now()
        returning attempts,max_attempts`,
      [lease.jobId, lease.workerId, lease.attempt],
    );
    if (!released.rows[0]) {
      throw new DomainError(
        'JOB_LEASE_MISMATCH',
        '종료 작업의 lease 소유자가 일치하지 않습니다.',
        lease,
      );
    }
    await appendEvent(client, lease.jobId, 'JOB_RELEASED_ON_SHUTDOWN', {
      workerId:lease.workerId,
      interruptedAttempt:lease.attempt,
      preservedAttempts:released.rows[0].attempts,
      extendedMaxAttempts:released.rows[0].max_attempts,
    });
  });
}

export async function deferJobForProviderCooldown(
  lease:JobLease,
  cooldown:BenchmarkProviderCooldown,
):Promise<void> {
  await withTransaction(async (client) => {
    const deferred = await client.query<{ attempts:number }>(
      `update jobs
          set state='RETRY_WAIT',
              attempts=greatest(attempts-1,0),
              available_at=greatest($4::timestamptz,now()),
              lease_owner=null,
              lease_expires_at=null,
              completed_at=null,
              last_error_code='PROVIDER_COOLDOWN',
              last_error_message=$5,
              updated_at=now()
        where id=$1
          and state='LEASED'
          and lease_owner=$2
          and attempts=$3
          and lease_expires_at>now()
        returning attempts`,
      [
        lease.jobId,
        lease.workerId,
        lease.attempt,
        cooldown.blockedUntil,
        `${cooldown.providerKey} provider cooldown until ${cooldown.blockedUntil.toISOString()}`,
      ],
    );
    if (!deferred.rows[0]) {
      throw new DomainError('JOB_LEASE_MISMATCH', '작업 lease 소유자가 일치하지 않습니다.', lease);
    }
    const restoredItems = await client.query<{ ordinal:number; attempts:number }>(
      `update generation_items
          set state='PENDING',
              retryable=true,
              claimed_job_id=null,
              claimed_job_attempt=null,
              error_code=null,
              error_message=null,
              started_at=null,
              completed_at=null,
              updated_at=now()
        where state='RUNNING'
          and claimed_job_id=$1
          and claimed_job_attempt=$2
        returning ordinal,attempts`,
      [lease.jobId, lease.attempt],
    );
    await appendEvent(client, lease.jobId, 'JOB_PROVIDER_COOLDOWN_DEFERRED', {
      workerId:lease.workerId,
      interruptedAttempt:lease.attempt,
      preservedAttempts:deferred.rows[0].attempts,
      providerKey:cooldown.providerKey,
      blockedUntil:cooldown.blockedUntil.toISOString(),
      deferredGenerationItems:restoredItems.rows.map((item) => ({
        ordinal:item.ordinal,
        auditAttempt:item.attempts,
      })),
    });
  });
}

type JobFailure = {
  code: string;
  message: string;
  retryDelayMs: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

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
    const state = error.retryable === false || job.attempts >= job.max_attempts
      ? 'TERMINAL_FAILED'
      : 'RETRY_WAIT';
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
      workerId: lease.workerId,
      attempt: lease.attempt,
      code: error.code,
      retryable: error.retryable ?? true,
      retryDelayMs: error.retryDelayMs,
      details:error.details ?? null,
    });
    return state;
  });
}

export async function recoverExpiredLeases(): Promise<number> {
  return withTransaction(async (client) => {
    const expired = await client.query<{
      id: string;
      previous_lease_owner: string | null;
      state: 'RETRY_WAIT' | 'TERMINAL_FAILED';
      attempts: number;
      kind: string;
      payload: Record<string, unknown>;
    }>(
      `with expired_jobs as (
         select id,lease_owner,attempts,max_attempts,kind,payload
           from jobs
          where state='LEASED' and lease_expires_at<now()
          order by id
          for update
       )
       update jobs job
          set state=case
                when expired_jobs.attempts>=expired_jobs.max_attempts
                  then 'TERMINAL_FAILED'
                else 'RETRY_WAIT'
              end,
              available_at=case
                when expired_jobs.attempts<expired_jobs.max_attempts then now()
                else job.available_at
              end,
              lease_owner=null,
              lease_expires_at=null,
              completed_at=case
                when expired_jobs.attempts>=expired_jobs.max_attempts then now()
                else null
              end,
              updated_at=now(),
              last_error_code='LEASE_EXPIRED',
              last_error_message=case
                when expired_jobs.attempts>=expired_jobs.max_attempts
                  then '최종 실행 시도의 작업자 lease가 만료되어 작업을 종료했습니다.'
                else '작업자 lease가 만료되어 재선점 대기 중입니다.'
              end
         from expired_jobs
        where job.id=expired_jobs.id
        returning job.id,
                  expired_jobs.lease_owner as previous_lease_owner,
                  job.state,
                  job.attempts,
                  expired_jobs.kind,
                  expired_jobs.payload`,
    );
    for (const job of expired.rows) {
      await appendEvent(
        client,
        job.id,
        job.state === 'TERMINAL_FAILED' ? 'JOB_TERMINAL_FAILED' : 'JOB_LEASE_RECOVERED',
        {
          previousWorkerId: job.previous_lease_owner,
          attempt: job.attempts,
          code: 'LEASE_EXPIRED',
          retryable: job.state === 'RETRY_WAIT',
        },
      );
      if (job.state === 'TERMINAL_FAILED' && job.kind === 'question.generate') {
        await reconcileTerminalGenerationLease(client, job);
      }
    }
    return expired.rowCount ?? 0;
  });
}

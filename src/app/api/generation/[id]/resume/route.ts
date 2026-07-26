import { NextResponse } from 'next/server';
import { withTransaction } from '@/server/db/transaction';
import { enqueueJobWithClient } from '@/server/jobs/queue';

type ResumeResult =
  | { kind: 'not-found' }
  | { kind: 'active' }
  | { kind: 'complete' }
  | { kind: 'no-retryable'; terminalFailures: number }
  | {
    kind: 'queued';
    jobId: string;
    resumeSequence: number;
    completedQuestions: number;
    terminalFailures: number;
  };

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const result = await withTransaction<ResumeResult>(async (client) => {
    const lockedJobs = await client.query<{
      id: string;
      state: string;
      attempts: number;
      lease_owner: string | null;
      lease_expires_at: Date | null;
    }>(
      `select id,state,attempts,lease_owner,lease_expires_at
         from jobs
        where kind='question.generate'
          and payload->>'batchId'=$1
        order by id
        for update`,
      [id],
    );
    const batch = await client.query<{ requested_count: number }>(
      `select requested_count
         from generation_batches
        where id=$1
        for update`,
      [id],
    );
    if (!batch.rows[0]) return { kind: 'not-found' };

    const activeAfterBatchLock = await client.query<{ active: boolean }>(
      `select exists(
         select 1
           from jobs
          where kind='question.generate'
            and payload->>'batchId'=$1
            and (
              state in ('PENDING','RETRY_WAIT')
              or (state='LEASED' and lease_expires_at>now())
            )
       ) as active`,
      [id],
    );
    if (activeAfterBatchLock.rows[0]?.active) return { kind: 'active' };

    const lockedJobById = new Map(lockedJobs.rows.map((job) => [job.id, job]));
    const transitioned = lockedJobs.rows.length
      ? await client.query<{ id: string; attempts: number }>(
      `update jobs
          set state='TERMINAL_FAILED',
              lease_owner=null,
              lease_expires_at=null,
              last_error_code='LEASE_EXPIRED_BEFORE_RESUME',
              last_error_message='만료된 생성 작업을 수동 재개 작업으로 대체했습니다.',
              completed_at=now(),
              updated_at=now()
        where id=any($1::uuid[])
          and state='LEASED'
          and (lease_expires_at is null or lease_expires_at<=now())
        returning id,attempts`,
      [lockedJobs.rows.map((job) => job.id)],
    ) : { rows: [], rowCount: 0 };
    for (const job of transitioned.rows) {
      await client.query(
        `insert into job_events(job_id,aggregate_type,aggregate_id,event_type,payload)
         values($1,'job',$1,'JOB_TERMINAL_FAILED',$2::jsonb)`,
        [
          job.id,
          JSON.stringify({
            previousWorkerId: lockedJobById.get(job.id)?.lease_owner ?? null,
            attempt: job.attempts,
            code: 'LEASE_EXPIRED_BEFORE_RESUME',
            retryable: false,
          }),
        ],
      );
    }
    await client.query(
      `insert into generation_items(generation_batch_id,ordinal)
       select $1,ordinal
         from generate_series(1,$2::int) ordinal
       on conflict(generation_batch_id,ordinal) do nothing`,
      [id, batch.rows[0].requested_count],
    );
    await client.query(
      `update generation_items item
          set state='FAILED',
              retryable=true,
              error_code='GENERATION_ITEM_LEASE_ORPHANED',
              error_message='이전 생성 작업 lease가 비활성화되어 안전하게 재개할 수 있습니다.',
              completed_at=null,
              updated_at=now()
        where item.generation_batch_id=$1
          and item.state='RUNNING'
          and not exists(
            select 1
              from jobs prior_job
             where prior_job.id=item.claimed_job_id
               and prior_job.state='LEASED'
               and prior_job.attempts=item.claimed_job_attempt
               and prior_job.lease_expires_at>now()
          )`,
      [id],
    );

    const counts = await client.query<{
      total: number;
      completed: number;
      pending: number;
      retryable_failed: number;
      terminal_failed: number;
    }>(
      `select count(*)::int as total,
              count(*) filter(where state='COMPLETED')::int as completed,
              count(*) filter(where state='PENDING')::int as pending,
              count(*) filter(where state='FAILED' and retryable)::int as retryable_failed,
              count(*) filter(where state='FAILED' and not retryable)::int as terminal_failed
         from generation_items
        where generation_batch_id=$1`,
      [id],
    );
    const itemCounts = counts.rows[0]!;
    if (itemCounts.total > 0 && itemCounts.completed === itemCounts.total) {
      return { kind: 'complete' };
    }
    if (itemCounts.pending + itemCounts.retryable_failed === 0) {
      return { kind: 'no-retryable', terminalFailures: itemCounts.terminal_failed };
    }

    await client.query(
      `update generation_items
          set state='PENDING',
              claimed_job_id=null,
              claimed_job_attempt=null,
              error_code=null,
              error_message=null,
              started_at=null,
              completed_at=null,
              updated_at=now()
        where generation_batch_id=$1
          and state='FAILED'
          and retryable`,
      [id],
    );
    const terminalErrors = await client.query<{
      ordinal: number;
      code: string | null;
      message: string | null;
      retryable: boolean;
    }>(
      `select ordinal,error_code as code,error_message as message,retryable
         from generation_items
        where generation_batch_id=$1 and state='FAILED'
        order by ordinal`,
      [id],
    );
    const jobCount = await client.query<{ count: number }>(
      `select count(*)::int as count
         from jobs
        where kind='question.generate'
          and payload->>'batchId'=$1`,
      [id],
    );
    const resumeSequence = (jobCount.rows[0]?.count ?? 0) + 1;
    await client.query(
      `update generation_batches
          set state='QUEUED',
              progress=(progress-'error'-'itemErrors')
                || jsonb_build_object(
                  'currentStage',0,
                  'completedQuestions',$2::int,
                  'failedQuestions',$3::int,
                  'runningQuestions',0,
                  'pendingQuestions',$4::int,
                  'itemErrors',$5::jsonb
                ),
              updated_at=now()
        where id=$1`,
      [
        id,
        itemCounts.completed,
        itemCounts.terminal_failed,
        itemCounts.pending + itemCounts.retryable_failed,
        JSON.stringify(terminalErrors.rows),
      ],
    );
    const job = await enqueueJobWithClient(client, {
      kind: 'question.generate',
      payload: { batchId: id, resumeSequence },
      idempotencyKey: `question.generate:${id}:resume:${resumeSequence}`,
      maxAttempts: 3,
    });
    await client.query(
      `insert into job_events(job_id,aggregate_type,aggregate_id,event_type,payload)
       values($1,'generation',$2,'GENERATION_RESUMED',$3::jsonb)`,
      [
        job.id,
        id,
        JSON.stringify({
          resumeSequence,
          completedQuestions: itemCounts.completed,
          terminalFailures: itemCounts.terminal_failed,
        }),
      ],
    );
    return {
      kind: 'queued',
      jobId: job.id,
      resumeSequence,
      completedQuestions: itemCounts.completed,
      terminalFailures: itemCounts.terminal_failed,
    };
  });

  if (result.kind === 'not-found') {
    return NextResponse.json({ code: 'GENERATION_BATCH_NOT_FOUND' }, { status: 404 });
  }
  if (result.kind === 'active') {
    return NextResponse.json({
      code: 'GENERATION_JOB_ACTIVE',
      message: '현재 실행 또는 재시도 대기 중인 생성 작업이 있습니다.',
    }, { status: 409 });
  }
  if (result.kind === 'complete') {
    return NextResponse.json({
      code: 'GENERATION_ALREADY_COMPLETED',
      message: '모든 문항이 이미 생성되었습니다.',
    }, { status: 409 });
  }
  if (result.kind === 'no-retryable') {
    return NextResponse.json({
      code: 'GENERATION_NO_RETRYABLE_ITEMS',
      message: '재시도할 수 있는 문항이 없습니다. 비재시도 실패의 입력·범위·스키마를 수정해 주세요.',
      terminalFailures: result.terminalFailures,
    }, { status: 409 });
  }
  return NextResponse.json({
    state: 'QUEUED',
    jobId: result.jobId,
    resumeSequence: result.resumeSequence,
    completedQuestions: result.completedQuestions,
    terminalFailures: result.terminalFailures,
  }, { status: 202 });
}

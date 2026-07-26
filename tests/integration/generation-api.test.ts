import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { POST } from '@/app/api/generation/route';
import { POST as resumeGeneration } from '@/app/api/generation/[id]/resume/route';
import { GET as getGenerationActivity } from '@/app/api/generation/[id]/activity/route';
import { claimJobs, recoverExpiredLeases } from '@/server/jobs/queue';

const sourceIds: string[] = [];
const batchIds: string[] = [];

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  for (const batchId of batchIds) {
    await db.query(`delete from job_events where job_id in (select id from jobs where payload->>'batchId'=$1)`, [batchId]);
    await db.query(`delete from job_events where aggregate_type='generation' and aggregate_id=$1`, [batchId]);
    await db.query(`delete from jobs where payload->>'batchId'=$1`, [batchId]);
    await db.query(`delete from generation_batches where id=$1`, [batchId]);
  }
  for (const sourceId of sourceIds) {
    await db.query(`delete from source_chunks where source_file_id=$1`, [sourceId]);
    await db.query(`delete from source_revisions where source_file_id=$1`, [sourceId]);
    await db.query(`delete from source_files where id=$1`, [sourceId]);
  }
  await db.end();
});

test('creates a persistent nine-stage generation batch limited to selected files', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  sourceIds.push(sourceId);
  await db.query(
    `insert into source_files(
       id, sha256, original_name, storage_path, mime_type, byte_size, subject, grade, status
     ) values ($1, $2, 'generation.pdf', 'fixture', 'application/pdf', 10, '과학', '중학교 2학년', 'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  const response = await POST(new Request('http://localhost/api/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: '과학',
      grade: '중학교 2학년',
      sourceFileIds: [sourceId],
      units: ['물질의 구성'],
      purpose: '핵심 개념 이해',
      questionType: '구조화 서술형',
      difficulty: '중',
      direction: '교과서 근거로 개념 관계를 설명',
      chunkCount: 8,
      crossUnit: false,
      requestedCount: 12,
      executionMode: 'parallel',
    }),
  }));
  const body = await response.json();

  expect(response.status).toBe(201);
  batchIds.push(body.id);
  expect(body.progress.stages).toHaveLength(9);
  const batch = await db.query<{
    source_scope: { sourceFileIds: string[]; sourceRevisionIds: string[] };
    conditions: { executionMode: string };
  }>(
    'select source_scope, conditions from generation_batches where id = $1', [body.id],
  );
  expect(batch.rows[0]?.source_scope.sourceFileIds).toEqual([sourceId]);
  expect(batch.rows[0]?.source_scope.sourceRevisionIds).toEqual([revisionId]);
  expect(batch.rows[0]?.conditions.executionMode).toBe('parallel');
  const job = await db.query<{ count: string }>(
    `select count(*) from jobs where kind = 'question.generate' and payload->>'batchId' = $1`, [body.id],
  );
  expect(Number(job.rows[0]?.count)).toBe(1);
  const items = await db.query<{ ordinal: number; state: string; attempts: number }>(
    `select ordinal,state,attempts
       from generation_items
      where generation_batch_id=$1
      order by ordinal`,
    [body.id],
  );
  expect(items.rows).toHaveLength(12);
  expect(items.rows).toEqual(Array.from({ length: 12 }, (_, index) => ({
    ordinal: index + 1,
    state: 'PENDING',
    attempts: 0,
  })));
});

test('rejects resume while a generation job is active and enqueues a monotonic resume after it stops', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  sourceIds.push(sourceId);
  await db.query(
    `insert into source_files(
       id, sha256, original_name, storage_path, mime_type, byte_size, subject, grade, status
     ) values ($1, $2, 'resume.pdf', 'fixture', 'application/pdf', 10, '과학', '중학교 2학년', 'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  const created = await POST(new Request('http://localhost/api/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: '과학',
      grade: '중학교 2학년',
      sourceFileIds: [sourceId],
      purpose: '핵심 개념 이해',
      questionType: '구조화 서술형',
      difficulty: '중',
      direction: '교과서 근거로 개념 관계를 설명',
      chunkCount: 8,
      crossUnit: false,
      requestedCount: 3,
      executionMode: 'parallel',
    }),
  }));
  const createdBody = await created.json();
  batchIds.push(createdBody.id);

  const activeResponse = await resumeGeneration(
    new Request(`http://localhost/api/generation/${createdBody.id}/resume`, { method: 'POST' }),
    { params: Promise.resolve({ id: createdBody.id }) },
  );
  expect(activeResponse.status).toBe(409);
  await expect(activeResponse.json()).resolves.toMatchObject({ code: 'GENERATION_JOB_ACTIVE' });

  await db.query(
    `update generation_items
        set state=case when ordinal=1 then 'COMPLETED' else 'FAILED' end,
            attempts=1,
            error_code=case when ordinal=1 then null else 'TEST_FAILURE' end,
            error_message=case when ordinal=1 then null else '다시 처리할 문항' end,
            retryable=case when ordinal=2 then false else true end,
            completed_at=case when ordinal=1 then now() else null end
      where generation_batch_id=$1`,
    [createdBody.id],
  );
  await db.query(
    `update generation_batches set state='FAILED' where id=$1`,
    [createdBody.id],
  );
  await db.query(
    `update jobs
        set state='TERMINAL_FAILED', completed_at=now()
      where kind='question.generate' and payload->>'batchId'=$1`,
    [createdBody.id],
  );

  const resumed = await resumeGeneration(
    new Request(`http://localhost/api/generation/${createdBody.id}/resume`, { method: 'POST' }),
    { params: Promise.resolve({ id: createdBody.id }) },
  );
  const resumedBody = await resumed.json();
  expect(resumed.status).toBe(202);
  expect(resumedBody).toMatchObject({ state: 'QUEUED', resumeSequence: 2 });

  const items = await db.query<{ ordinal: number; state: string; attempts: number; retryable: boolean }>(
    `select ordinal,state,attempts,retryable
       from generation_items
      where generation_batch_id=$1
      order by ordinal`,
    [createdBody.id],
  );
  expect(items.rows).toEqual([
    { ordinal: 1, state: 'COMPLETED', attempts: 1, retryable: true },
    { ordinal: 2, state: 'FAILED', attempts: 1, retryable: false },
    { ordinal: 3, state: 'PENDING', attempts: 1, retryable: true },
  ]);
  const jobs = await db.query<{ idempotency_key: string; state: string }>(
    `select idempotency_key,state
       from jobs
      where kind='question.generate' and payload->>'batchId'=$1
      order by created_at`,
    [createdBody.id],
  );
  expect(jobs.rows).toHaveLength(2);
  expect(jobs.rows[1]).toMatchObject({
    idempotency_key: `question.generate:${createdBody.id}:resume:2`,
    state: 'PENDING',
  });

  await db.query(
    `update jobs set state='TERMINAL_FAILED',completed_at=now()
      where id=$1`,
    [resumedBody.jobId],
  );
  await db.query(
    `update generation_items
        set state='COMPLETED',completed_at=now()
      where generation_batch_id=$1 and ordinal=3`,
    [createdBody.id],
  );
  await db.query(`update generation_batches set state='FAILED' where id=$1`, [createdBody.id]);
  const terminalOnly = await resumeGeneration(
    new Request(`http://localhost/api/generation/${createdBody.id}/resume`, { method: 'POST' }),
    { params: Promise.resolve({ id: createdBody.id }) },
  );
  expect(terminalOnly.status).toBe(409);
  await expect(terminalOnly.json()).resolves.toMatchObject({
    code: 'GENERATION_NO_RETRYABLE_ITEMS',
  });
});

test('rejects a selected TOC entry that has no chunk mapping in the latest revision', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const tocEntryId = randomUUID();
  sourceIds.push(sourceId);
  await db.query(
    `insert into source_files(
       id, sha256, original_name, storage_path, mime_type, byte_size, subject, grade, status
     ) values ($1, $2, 'unmapped.pdf', 'fixture', 'application/pdf', 10, '과학', '중학교 2학년', 'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  await db.query(
    `insert into source_toc_entries(
       id,source_file_id,source_revision_id,ordinal,title,level,mapping_status
     ) values($1,$2,$3,1,'매핑되지 않은 단원',1,'UNMAPPED')`,
    [tocEntryId, sourceId, revisionId],
  );

  const response = await POST(new Request('http://localhost/api/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: '과학',
      grade: '중학교 2학년',
      sourceFileIds: [sourceId],
      tocEntryIds: [tocEntryId],
      purpose: '핵심 개념 이해',
      questionType: '구조화 서술형',
      difficulty: '중',
      direction: '교과서 근거로 개념 관계를 설명',
      chunkCount: 8,
      crossUnit: false,
      requestedCount: 1,
      executionMode: 'sequential',
    }),
  }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ code: 'GENERATION_TOC_SCOPE_EMPTY' });
});

test('terminates a final-attempt expired lease and lets resume recover its orphan item', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  sourceIds.push(sourceId);
  await db.query(
    `insert into source_files(
       id,sha256,original_name,storage_path,mime_type,byte_size,subject,grade,status
     ) values($1,$2,'expired-final.pdf','fixture','application/pdf',10,'과학','중학교 2학년','READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  const created = await POST(new Request('http://localhost/api/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: '과학',
      grade: '중학교 2학년',
      sourceFileIds: [sourceId],
      purpose: '핵심 개념 이해',
      questionType: '구조화 서술형',
      difficulty: '중',
      direction: '교과서 근거로 개념 관계를 설명',
      chunkCount: 8,
      crossUnit: false,
      requestedCount: 1,
      executionMode: 'sequential',
    }),
  }));
  const body = await created.json();
  batchIds.push(body.id);
  await db.query('update jobs set max_attempts=1,priority=1 where id=$1', [body.jobId]);
  const claimedJobs = await claimJobs('expired-final-worker', 100, 60_000, ['question.generate']);
  const claimed = claimedJobs.find((job) => job.id === body.jobId);
  expect(claimed).toBeTruthy();
  await db.query(
    `update generation_items
        set state='RUNNING',
            attempts=1,
            claimed_job_id=$2,
            claimed_job_attempt=$3,
            started_at=now()
      where generation_batch_id=$1`,
    [body.id, body.jobId, claimed!.attempts],
  );
  await db.query(
    `update jobs set lease_expires_at=now()-interval '1 second' where id=$1`,
    [body.jobId],
  );

  expect(await recoverExpiredLeases()).toBe(1);
  const expiredJob = await db.query<{
    state: string;
    lease_owner: string | null;
    lease_expires_at: string | null;
    completed_at: string | null;
    last_error_code: string | null;
  }>(
    `select state,lease_owner,lease_expires_at,completed_at,last_error_code
       from jobs where id=$1`,
    [body.jobId],
  );
  expect(expiredJob.rows[0]).toMatchObject({
    state: 'TERMINAL_FAILED',
    lease_owner: null,
    lease_expires_at: null,
    last_error_code: 'LEASE_EXPIRED',
  });
  expect(expiredJob.rows[0]?.completed_at).toBeTruthy();
  const terminalEvent = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
    `select event_type,payload from job_events
      where job_id=$1 and event_type='JOB_TERMINAL_FAILED'
      order by id desc limit 1`,
    [body.jobId],
  );
  expect(terminalEvent.rows[0]).toMatchObject({
    event_type: 'JOB_TERMINAL_FAILED',
    payload: { code: 'LEASE_EXPIRED', attempt: 1 },
  });
  const recoveredItem = await db.query<{
    state: string;
    retryable: boolean;
    error_code: string | null;
  }>(
    `select state,retryable,error_code
       from generation_items
      where generation_batch_id=$1`,
    [body.id],
  );
  expect(recoveredItem.rows[0]).toEqual({
    state: 'FAILED',
    retryable: true,
    error_code: 'LEASE_EXPIRED',
  });
  const recoveredBatch = await db.query<{
    state: string;
    progress: {
      completedQuestions: number;
      failedQuestions: number;
      runningQuestions: number;
      pendingQuestions: number;
      error: string;
      itemErrors: Array<{ ordinal: number; code: string; retryable: boolean }>;
    };
  }>(
    `select state,progress from generation_batches where id=$1`,
    [body.id],
  );
  expect(recoveredBatch.rows[0]).toMatchObject({
    state: 'FAILED',
    progress: {
      completedQuestions: 0,
      failedQuestions: 1,
      runningQuestions: 0,
      pendingQuestions: 0,
      error: expect.stringContaining('LEASE_EXPIRED'),
      itemErrors: [{ ordinal: 1, code: 'LEASE_EXPIRED', retryable: true }],
    },
  });

  const activityResponse = await getGenerationActivity(
    new Request(`http://localhost/api/generation/${body.id}/activity`),
    { params: Promise.resolve({ id: body.id }) },
  );
  const activity = await activityResponse.json();
  expect(activity.job.state).toBe('TERMINAL_FAILED');
  expect(activity.canResume).toBe(true);
  expect(activity.items[0]).toMatchObject({
    state: 'FAILED',
    retryable: true,
    error: { code: 'LEASE_EXPIRED', retryable: true },
  });
  expect(activity.events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      event_type: 'GENERATION_FAILED',
      payload: expect.objectContaining({ code: 'LEASE_EXPIRED', retryable: true }),
    }),
  ]));
  expect(activity.eventCursor).toBe(activity.events.at(-1).id);
  const refreshActivityResponse = await getGenerationActivity(
    new Request(`http://localhost/api/generation/${body.id}/activity?history=0`),
    { params: Promise.resolve({ id: body.id }) },
  );
  const refreshActivity = await refreshActivityResponse.json();
  expect(refreshActivity).not.toHaveProperty('events');
  expect(refreshActivity.eventCursor).toBe(activity.eventCursor);

  const resumed = await resumeGeneration(
    new Request(`http://localhost/api/generation/${body.id}/resume`, { method: 'POST' }),
    { params: Promise.resolve({ id: body.id }) },
  );
  expect(resumed.status).toBe(202);
  await expect(resumed.json()).resolves.toMatchObject({ state: 'QUEUED', resumeSequence: 2 });
  const item = await db.query<{ state: string; retryable: boolean; error_code: string | null }>(
    `select state,retryable,error_code
       from generation_items
      where generation_batch_id=$1`,
    [body.id],
  );
  expect(item.rows[0]).toEqual({ state: 'PENDING', retryable: true, error_code: null });
});

test('resume locks jobs before the batch, avoids cross-transaction deadlock, and records direct expiry once', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  sourceIds.push(sourceId);
  await db.query(
    `insert into source_files(
       id,sha256,original_name,storage_path,mime_type,byte_size,subject,grade,status
     ) values($1,$2,'resume-lock-order.pdf','fixture','application/pdf',10,'과학','중학교 2학년','READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  const created = await POST(new Request('http://localhost/api/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: '과학',
      grade: '중학교 2학년',
      sourceFileIds: [sourceId],
      purpose: '핵심 개념 이해',
      questionType: '구조화 서술형',
      difficulty: '중',
      direction: '교과서 근거로 개념 관계를 설명',
      chunkCount: 8,
      crossUnit: false,
      requestedCount: 1,
      executionMode: 'sequential',
    }),
  }));
  const body = await created.json();
  batchIds.push(body.id);
  await db.query('update jobs set priority=1 where id=$1', [body.jobId]);
  const claimedJobs = await claimJobs('resume-lock-worker', 100, 60_000, ['question.generate']);
  const claimed = claimedJobs.find((job) => job.id === body.jobId);
  expect(claimed).toBeTruthy();
  await db.query(
    `update jobs set lease_expires_at=now()-interval '1 second' where id=$1`,
    [body.jobId],
  );
  await db.query(
    `update generation_items
        set state='RUNNING',
            attempts=1,
            claimed_job_id=$2,
            claimed_job_attempt=$3,
            started_at=now()
      where generation_batch_id=$1`,
    [body.id, body.jobId, claimed!.attempts],
  );

  const clientA = await db.connect();
  let resumePromise: Promise<Response> | null = null;
  try {
    await clientA.query('begin');
    await clientA.query(`set local lock_timeout='750ms'`);
    await clientA.query('select id from jobs where id=$1 for update', [body.jobId]);
    resumePromise = resumeGeneration(
      new Request(`http://localhost/api/generation/${body.id}/resume`, { method: 'POST' }),
      { params: Promise.resolve({ id: body.id }) },
    );
    const resolvedBeforeRelease = await Promise.race([
      resumePromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
    ]);
    expect(resolvedBeforeRelease).toBe(false);

    await expect(clientA.query(
      'select id from generation_batches where id=$1 for update',
      [body.id],
    )).resolves.toMatchObject({ rowCount: 1 });
    await clientA.query('commit');
  } finally {
    await clientA.query('rollback').catch(() => undefined);
    clientA.release();
  }

  expect(resumePromise).not.toBeNull();
  const resumed = await resumePromise!;
  expect(resumed.status).toBe(202);
  await expect(resumed.json()).resolves.toMatchObject({ state: 'QUEUED', resumeSequence: 2 });
  const duplicateResume = await resumeGeneration(
    new Request(`http://localhost/api/generation/${body.id}/resume`, { method: 'POST' }),
    { params: Promise.resolve({ id: body.id }) },
  );
  expect(duplicateResume.status).toBe(409);
  await expect(duplicateResume.json()).resolves.toMatchObject({ code: 'GENERATION_JOB_ACTIVE' });

  const jobs = await db.query<{ count: number }>(
    `select count(*)::int as count
       from jobs
      where kind='question.generate' and payload->>'batchId'=$1`,
    [body.id],
  );
  expect(jobs.rows[0]?.count).toBe(2);
  const audit = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
    `select event_type,payload
       from job_events
      where job_id=$1 and event_type='JOB_TERMINAL_FAILED'
      order by id`,
    [body.jobId],
  );
  expect(audit.rows).toEqual([expect.objectContaining({
    event_type: 'JOB_TERMINAL_FAILED',
    payload: expect.objectContaining({
      code: 'LEASE_EXPIRED_BEFORE_RESUME',
      attempt: claimed!.attempts,
    }),
  })]);
  const resumedEvents = await db.query<{ count: number }>(
    `select count(*)::int as count
       from job_events
      where aggregate_type='generation'
        and aggregate_id=$1
        and event_type='GENERATION_RESUMED'`,
    [body.id],
  );
  expect(resumedEvents.rows[0]?.count).toBe(1);
});

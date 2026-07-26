import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { withTransaction } from '@/server/db/transaction';
import { generateQuestions } from '@/server/questions/generator';
import { backfillMissingSourceTocEntries, replaceSourceTocEntries } from '@/server/sources/toc';
import { GET as getGenerationActivity } from '@/app/api/generation/[id]/activity/route';
import { GET as getGenerationItemAudit } from '@/app/api/generation/[id]/items/[itemId]/audit/route';
import { beginGenerationProviderInvocation } from '@/server/questions/provider-invocations';
import {
  claimJobs,
  enqueueJob,
  failJob,
  recoverExpiredLeases,
  type JobLease,
} from '@/server/jobs/queue';

const testSourceIds: string[] = [];
const testBatchIds: string[] = [];

async function claimGenerationLease(
  batchId: string,
  workerId: string,
  leaseMs = 60_000,
): Promise<JobLease> {
  const job = await enqueueJob({
    kind: 'question.generate',
    payload: { batchId },
    idempotencyKey: `test-question.generate:${batchId}`,
    maxAttempts: 4,
    priority: 1,
  });
  const claimed = await claimJobs(workerId, 20, leaseMs, ['question.generate']);
  const record = claimed.find((candidate) => candidate.id === job.id);
  if (!record) throw new Error(`테스트 생성 작업 ${job.id}을 claim하지 못했습니다.`);
  return { jobId: record.id, workerId, attempt: record.attempts };
}

async function createBasicGenerationBatch(input: {
  requestedCount: number;
  executionMode?: 'sequential' | 'parallel';
}) {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const batchId = randomUUID();
  testSourceIds.push(sourceId);
  testBatchIds.push(batchId);
  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'lease-integrity.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  await db.query(
    `insert into source_chunks(source_file_id,source_revision_id,ordinal,content,page_start,unit)
     values
       ($1,$2,1,'속도는 위치의 시간에 따른 변화이다.',1,'역학'),
       ($1,$2,2,'가속도는 속도의 시간에 따른 변화이다.',2,'역학')`,
    [sourceId, revisionId],
  );
  await db.query(
    `insert into generation_batches(
       id,state,requested_count,conditions,source_scope,generation_model,prompt_version
     ) values($1,'QUEUED',$2,$3::jsonb,$4::jsonb,'mock-gemini','test')`,
    [
      batchId,
      input.requestedCount,
      JSON.stringify({
        subject: '과학',
        grade: '고등학교 1학년',
        units: ['역학'],
        purpose: '선수관계 측정',
        questionType: '구조화 서술형',
        difficulty: '상',
        direction: '선수관계를 측정',
        chunkCount: 2,
        executionMode: input.executionMode ?? 'sequential',
      }),
      JSON.stringify({
        sourceFileIds: [sourceId],
        sourceRevisionIds: [revisionId],
        tocEntryIds: [],
      }),
    ],
  );
  return { sourceId, revisionId, batchId };
}

beforeAll(async () => {
  vi.stubEnv('MOCK_PROVIDERS', 'true');
  await migrate();
});

afterAll(async () => {
  for (const batchId of testBatchIds) {
    await db.query(`delete from question_evidence where question_id in (select id from questions where generation_batch_id=$1)`, [batchId]);
    await db.query(`delete from question_revisions where question_id in (select id from questions where generation_batch_id=$1)`, [batchId]);
    await db.query(`delete from questions where generation_batch_id=$1`, [batchId]);
    await db.query(`delete from generation_retrievals where generation_batch_id=$1`, [batchId]);
    await db.query(`delete from generation_items where generation_batch_id=$1`, [batchId]);
    await db.query(`delete from job_events where job_id in (select id from jobs where kind='question.generate' and payload->>'batchId'=$1)`, [batchId]);
    await db.query(`delete from job_events where aggregate_type='generation' and aggregate_id=$1`, [batchId]);
    await db.query(`delete from jobs where kind='question.generate' and payload->>'batchId'=$1`, [batchId]);
    await db.query(`delete from generation_batches where id=$1`, [batchId]);
  }
  for (const sourceId of testSourceIds) {
    await db.query(`delete from source_chunks where source_file_id=$1`, [sourceId]);
    await db.query(`delete from source_revisions where source_file_id=$1`, [sourceId]);
    await db.query(`delete from source_files where id=$1`, [sourceId]);
  }
  vi.unstubAllEnvs();
  await db.end();
});

test('runs direction, retrieval, and generation independently for every question', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const batchId = randomUUID();
  testSourceIds.push(sourceId);
  testBatchIds.push(batchId);
  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'per-question.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model) values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  for (const [index, content] of ['속도는 위치의 시간에 따른 변화이다.', '가속도는 속도의 시간에 따른 변화이다.', '힘은 물체의 운동 상태를 변화시킨다.'].entries()) {
    await db.query(
      `insert into source_chunks(source_file_id,source_revision_id,ordinal,content,page_start,unit)
       values($1,$2,$3,$4,$3,'역학')`,
      [sourceId, revisionId, index + 1, content],
    );
  }
  await db.query(
    `insert into generation_batches(id,requested_count,conditions,source_scope,generation_model,prompt_version)
     values($1,2,$2::jsonb,$3::jsonb,'mock-gemini','test')`,
    [batchId, JSON.stringify({ subject: '과학', grade: '고등학교 1학년', units: ['역학'], purpose: '개념 적용·문제풀이', questionType: '구조화 서술형', difficulty: '상', direction: '선수관계를 측정', chunkCount: 2, executionMode: 'parallel' }), JSON.stringify({ sourceFileIds: [sourceId] })],
  );

  const lease = await claimGenerationLease(batchId, `worker-${batchId}`);
  await expect(generateQuestions(batchId, { lease })).resolves.toEqual({ questions: 2 });

  const retrievals = await db.query<{ query_text: string; candidate_scope: { ordinal: number; questionDirection: { searchQuery: string } } }>(
    `select query_text,candidate_scope from generation_retrievals where generation_batch_id=$1 order by candidate_scope->>'ordinal'`,
    [batchId],
  );
  expect(retrievals.rows).toHaveLength(2);
  expect(retrievals.rows.map((row) => row.candidate_scope.ordinal)).toEqual([1, 2]);
  expect(new Set(retrievals.rows.map((row) => row.query_text)).size).toBe(2);
  expect(retrievals.rows.every((row) => row.query_text === row.candidate_scope.questionDirection.searchQuery)).toBe(true);

  const events = await db.query<{
    event_type: string;
    ordinal: string;
    payload: Record<string, unknown>;
  }>(
    `select event_type,payload->>'ordinal' ordinal,payload from job_events
     where aggregate_type='generation' and aggregate_id=$1 and payload ? 'ordinal'`,
    [batchId],
  );
  for (const ordinal of ['1', '2']) {
    expect(events.rows.filter((event) => event.ordinal === ordinal).map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'QUESTION_DIRECTION_COMPLETED', 'QUESTION_RETRIEVAL_COMPLETED', 'QUESTION_GENERATION_COMPLETED',
    ]));
  }
  const retrievalEvents = events.rows.filter(
    (event) => event.event_type === 'QUESTION_RETRIEVAL_COMPLETED',
  );
  expect(retrievalEvents).toHaveLength(2);
  for (const event of retrievalEvents) {
    expect(event.payload).toMatchObject({
      chunkCount: 2,
      selectedChunkIds: expect.any(Array),
      chunks: expect.any(Array),
    });
    expect(JSON.stringify(event.payload)).not.toContain('"content"');
    expect(event.payload).not.toHaveProperty('selectedChunks');
  }
});

test('persists successful ordinals, retries only failed items, and keeps replay idempotent', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const batchId = randomUUID();
  testSourceIds.push(sourceId);
  testBatchIds.push(batchId);
  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'durable-items.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  for (const [index, content] of [
    '관성은 물체가 운동 상태를 유지하려는 성질이다.',
    '힘은 물체의 속도 또는 운동 방향을 변화시킨다.',
    '가속도는 속도의 시간에 따른 변화율이다.',
  ].entries()) {
    await db.query(
      `insert into source_chunks(source_file_id,source_revision_id,ordinal,content,page_start,unit)
       values($1,$2,$3,$4,$3,'역학')`,
      [sourceId, revisionId, index + 1, content],
    );
  }
  await db.query(
    `insert into generation_batches(id,state,requested_count,conditions,source_scope,generation_model,prompt_version)
     values($1,'QUEUED',3,$2::jsonb,$3::jsonb,'mock-gemini','test')`,
    [
      batchId,
      JSON.stringify({
        subject: '과학', grade: '고등학교 1학년', units: ['역학'], purpose: '선수관계 측정',
        questionType: '구조화 서술형', difficulty: '상', direction: '선수관계를 측정',
        chunkCount: 2, executionMode: 'parallel',
      }),
      JSON.stringify({
        sourceFileIds: [sourceId],
        sourceRevisionIds: [revisionId],
        tocEntryIds: [],
      }),
    ],
  );

  const firstLease = await claimGenerationLease(batchId, `worker-first-${batchId}`);
  await expect(generateQuestions(batchId, {
    lease: firstLease,
    testHooks: {
      afterRetrievalPersisted: ({ ordinal, attempt }) => {
        if (ordinal === 2 && attempt === 1) throw new Error('TEST_ORDINAL_FAILURE: 두 번째 문항만 실패');
      },
    },
  })).rejects.toThrow('GENERATION_ITEMS_INCOMPLETE');

  const firstItems = await db.query<{
    ordinal: number;
    state: string;
    attempts: number;
    error_code: string | null;
  }>(
    `select ordinal,state,attempts,error_code
       from generation_items
      where generation_batch_id=$1
      order by ordinal`,
    [batchId],
  );
  expect(firstItems.rows).toEqual([
    { ordinal: 1, state: 'COMPLETED', attempts: 1, error_code: null },
    { ordinal: 2, state: 'FAILED', attempts: 1, error_code: 'TEST_ORDINAL_FAILURE' },
    { ordinal: 3, state: 'COMPLETED', attempts: 1, error_code: null },
  ]);
  const firstQuestions = await db.query<{ ordinal: number }>(
    `select item.ordinal
       from questions question
       join generation_items item on item.id=question.generation_item_id
      where question.generation_batch_id=$1
      order by item.ordinal`,
    [batchId],
  );
  expect(firstQuestions.rows.map((row) => row.ordinal)).toEqual([1, 3]);

  const activityResponse = await getGenerationActivity(
    new Request(`http://localhost/api/generation/${batchId}/activity`),
    { params: Promise.resolve({ id: batchId }) },
  );
  expect(activityResponse.status).toBe(200);
  const activity = await activityResponse.json();
  expect(activity.items[1]).toMatchObject({
    ordinal: 2,
    state: 'FAILED',
    attempts: 1,
    error: { code: 'TEST_ORDINAL_FAILURE', message: 'TEST_ORDINAL_FAILURE: 두 번째 문항만 실패' },
    latestRetrieval: { attempt: 1, selectedChunkCount: expect.any(Number) },
  });
  expect(activity.items[1].latestRetrieval).not.toHaveProperty('selectedChunks');
  const failedItemAuditResponse = await getGenerationItemAudit(
    new Request(`http://localhost/api/generation/${batchId}/items/${activity.items[1].id}/audit`),
    { params: Promise.resolve({ id: batchId, itemId: activity.items[1].id }) },
  );
  expect(failedItemAuditResponse.status).toBe(200);
  const failedItemAudit = await failedItemAuditResponse.json();
  expect(failedItemAudit.latestRetrieval.selectedChunks[0]).toMatchObject({
    rank: 1,
    content: expect.stringContaining('관성'),
    source: expect.stringMatching(/semantic|scope_order/),
    selectionReason: expect.any(String),
  });

  await failJob(firstLease, {
    code: 'GENERATION_ITEMS_INCOMPLETE',
    message: '두 번째 문항 재시도',
    retryDelayMs: 0,
  });
  const retryLease = await claimGenerationLease(batchId, `worker-retry-${batchId}`);
  const retriedOrdinals: number[] = [];
  await expect(generateQuestions(batchId, {
    lease: retryLease,
    testHooks: {
      beforeItemAttempt: ({ ordinal }) => { retriedOrdinals.push(ordinal); },
    },
  })).resolves.toEqual({ questions: 3 });
  expect(retriedOrdinals).toEqual([2]);

  const finalItems = await db.query<{ ordinal: number; state: string; attempts: number }>(
    `select ordinal,state,attempts
       from generation_items
      where generation_batch_id=$1
      order by ordinal`,
    [batchId],
  );
  expect(finalItems.rows).toEqual([
    { ordinal: 1, state: 'COMPLETED', attempts: 1 },
    { ordinal: 2, state: 'COMPLETED', attempts: 2 },
    { ordinal: 3, state: 'COMPLETED', attempts: 1 },
  ]);
  const finalQuestions = await db.query<{ ordinal: number; question_count: number }>(
    `select item.ordinal,count(question.id)::int as question_count
       from generation_items item
       left join questions question on question.generation_item_id=item.id
      where item.generation_batch_id=$1
      group by item.ordinal
      order by item.ordinal`,
    [batchId],
  );
  expect(finalQuestions.rows).toEqual([
    { ordinal: 1, question_count: 1 },
    { ordinal: 2, question_count: 1 },
    { ordinal: 3, question_count: 1 },
  ]);
  const retrievalAttempts = await db.query<{ ordinal: number; attempts: number[]; retrieval_count: number }>(
    `select item.ordinal,
            array_agg(retrieval.attempt order by retrieval.attempt)::int[] as attempts,
            count(*)::int as retrieval_count
       from generation_retrievals retrieval
       join generation_items item on item.id=retrieval.generation_item_id
      where retrieval.generation_batch_id=$1
      group by item.ordinal
      order by item.ordinal`,
    [batchId],
  );
  expect(retrievalAttempts.rows).toEqual([
    { ordinal: 1, attempts: [1], retrieval_count: 1 },
    { ordinal: 2, attempts: [1, 2], retrieval_count: 2 },
    { ordinal: 3, attempts: [1], retrieval_count: 1 },
  ]);

  const replayedOrdinals: number[] = [];
  await expect(generateQuestions(batchId, {
    lease: retryLease,
    testHooks: {
      beforeItemAttempt: ({ ordinal }) => { replayedOrdinals.push(ordinal); },
    },
  })).resolves.toEqual({ questions: 3 });
  expect(replayedOrdinals).toEqual([]);
  const replayCounts = await db.query<{ questions: number; retrievals: number }>(
    `select
       (select count(*)::int from questions where generation_batch_id=$1) as questions,
       (select count(*)::int from generation_retrievals where generation_batch_id=$1) as retrievals`,
    [batchId],
  );
  expect(replayCounts.rows[0]).toEqual({ questions: 3, retrievals: 4 });
  const completionProgress = await db.query<{ completed_questions: number }>(
    `select (payload->>'completedQuestions')::int as completed_questions
       from job_events
      where aggregate_type='generation'
        and aggregate_id=$1
        and event_type='QUESTION_GENERATION_COMPLETED'
      order by id`,
    [batchId],
  );
  expect(completionProgress.rows.map((row) => row.completed_questions)).toEqual([1, 2, 3]);
});

test('runs provider preflight before claim and leaves durable items pending when configuration is missing', async () => {
  const { batchId } = await createBasicGenerationBatch({ requestedCount: 2 });
  await db.query(
    `update generation_batches
        set generation_model=question_generation_profile_snapshot
          #>> '{settings,model}'
      where id=$1`,
    [batchId],
  );
  await db.query(
    `insert into generation_items(generation_batch_id,ordinal)
     values($1,1),($1,2)`,
    [batchId],
  );
  const lease = await claimGenerationLease(batchId, `worker-${batchId}`);
  vi.stubEnv('MOCK_PROVIDERS', 'false');
  vi.stubEnv('GOOGLE_API_KEY', '');
  try {
    await expect(generateQuestions(batchId, { lease }))
      .rejects.toThrow('GENERATION_EMBEDDING_NOT_CONFIGURED');
  } finally {
    vi.stubEnv('MOCK_PROVIDERS', 'true');
  }

  const items = await db.query<{ state: string; attempts: number }>(
    `select state,attempts
       from generation_items
      where generation_batch_id=$1
      order by ordinal`,
    [batchId],
  );
  expect(items.rows).toEqual([
    { state: 'PENDING', attempts: 0 },
    { state: 'PENDING', attempts: 0 },
  ]);
});

test('does not auto-claim a non-retryable item failure', async () => {
  const { batchId } = await createBasicGenerationBatch({ requestedCount: 2 });
  await db.query(
    `insert into generation_items(
       generation_batch_id,ordinal,state,retryable,error_code,error_message
     ) values
       ($1,1,'FAILED',false,'GENERATION_FORMAT_MISMATCH','구조화 스키마 불일치'),
       ($1,2,'PENDING',true,null,null)`,
    [batchId],
  );
  const lease = await claimGenerationLease(batchId, `worker-${batchId}`);
  const attempted: number[] = [];
  await expect(generateQuestions(batchId, {
    lease,
    testHooks: {
      beforeItemAttempt: ({ ordinal }) => { attempted.push(ordinal); },
    },
  })).rejects.toMatchObject({ retryable: false });
  expect(attempted).toEqual([2]);

  const items = await db.query<{
    ordinal: number;
    state: string;
    attempts: number;
    retryable: boolean;
  }>(
    `select ordinal,state,attempts,retryable
       from generation_items
      where generation_batch_id=$1
      order by ordinal`,
    [batchId],
  );
  expect(items.rows).toEqual([
    { ordinal: 1, state: 'FAILED', attempts: 0, retryable: false },
    { ordinal: 2, state: 'COMPLETED', attempts: 1, retryable: true },
  ]);
});

test('keeps a committed question idempotent when the process crashes immediately after commit', async () => {
  const { batchId } = await createBasicGenerationBatch({ requestedCount: 1 });
  const lease = await claimGenerationLease(batchId, `worker-${batchId}`);
  await expect(generateQuestions(batchId, {
    lease,
    testHooks: {
      afterItemCommitted: () => {
        throw new Error('TEST_AFTER_COMMIT_CRASH: commit 이후 프로세스 중단');
      },
    },
  })).rejects.toThrow('TEST_AFTER_COMMIT_CRASH');

  const committed = await db.query<{
    state: string;
    questions: number;
    retrievals: number;
    failed_events: number;
  }>(
    `select item.state,
            (select count(*)::int from questions where generation_item_id=item.id) as questions,
            (select count(*)::int from generation_retrievals where generation_item_id=item.id) as retrievals,
            (select count(*)::int
               from job_events
              where aggregate_type='generation'
                and aggregate_id=$1
                and event_type='QUESTION_GENERATION_FAILED') as failed_events
       from generation_items item
      where item.generation_batch_id=$1`,
    [batchId],
  );
  expect(committed.rows[0]).toEqual({
    state: 'COMPLETED',
    questions: 1,
    retrievals: 1,
    failed_events: 0,
  });

  await expect(generateQuestions(batchId, { lease })).resolves.toEqual({ questions: 1 });
  const replay = await db.query<{ questions: number; retrievals: number }>(
    `select
       (select count(*)::int from questions where generation_batch_id=$1) as questions,
       (select count(*)::int from generation_retrievals where generation_batch_id=$1) as retrievals`,
    [batchId],
  );
  expect(replay.rows[0]).toEqual({ questions: 1, retrievals: 1 });
});

test('rejects a stale worker after lease recovery and lets only the reclaimed attempt persist', async () => {
  const { batchId } = await createBasicGenerationBatch({ requestedCount: 1 });
  const staleLease = await claimGenerationLease(batchId, `worker-stale-${batchId}`);
  let staleItem!: { itemId: string; attempt: number };
  let releaseStale!: () => void;
  let markHookReached!: () => void;
  const hookReached = new Promise<void>((resolve) => { markHookReached = resolve; });
  const holdStale = new Promise<void>((resolve) => { releaseStale = resolve; });
  const staleRun = generateQuestions(batchId, {
    lease: staleLease,
    testHooks: {
      beforeItemAttempt: async (context) => {
        staleItem = context;
        markHookReached();
        await holdStale;
      },
    },
  });
  await hookReached;
  const abandonedInvocationId = await beginGenerationProviderInvocation({
    batchId,
    itemId: staleItem.itemId,
    itemAttempt: staleItem.attempt,
    stage: 'DIRECTION',
    provider: 'gemini',
    modelId: 'crashed-worker-model',
    request: {
      system: 'CRASHED_REQUEST_SYSTEM',
      prompt: 'CRASHED_REQUEST_PROMPT',
      maxOutputTokens: 128,
    },
  });

  await db.query(
    `update jobs set lease_expires_at=now()-interval '1 second' where id=$1`,
    [staleLease.jobId],
  );
  await recoverExpiredLeases();
  const recoveredLease = await db.query<{
    state: string;
    attempts: number;
    lease_owner: string | null;
    lease_expires_at: string | null;
    last_error_code: string | null;
  }>(
    `select state,attempts,lease_owner,lease_expires_at,last_error_code
       from jobs
      where id=$1`,
    [staleLease.jobId],
  );
  expect(recoveredLease.rows[0]).toEqual({
    state: 'RETRY_WAIT',
    attempts: staleLease.attempt,
    lease_owner: null,
    lease_expires_at: null,
    last_error_code: 'LEASE_EXPIRED',
  });
  const preservedForAutomaticRetry = await db.query<{
    state: string;
    claimed_job_attempt: number;
    error_code: string | null;
  }>(
    `select state,claimed_job_attempt,error_code
       from generation_items
      where generation_batch_id=$1`,
    [batchId],
  );
  expect(preservedForAutomaticRetry.rows[0]).toEqual({
    state: 'RUNNING',
    claimed_job_attempt: staleLease.attempt,
    error_code: null,
  });
  const currentLease = await claimGenerationLease(batchId, `worker-current-${batchId}`);
  expect(currentLease.attempt).toBe(staleLease.attempt + 1);
  await expect(generateQuestions(batchId, { lease: currentLease })).resolves.toEqual({ questions: 1 });
  const abandoned = await db.query<{
    state: string;
    error_snapshot: Record<string, unknown> | null;
    completed_at: Date | null;
  }>(
    `select state,error_snapshot,completed_at
       from generation_provider_invocations
      where id=$1`,
    [abandonedInvocationId],
  );
  expect(abandoned.rows[0]).toMatchObject({
    state: 'ABANDONED',
    error_snapshot: {
      code: 'GENERATION_INVOCATION_ABANDONED_ON_ITEM_RETRY',
      retryable: true,
    },
    completed_at: expect.any(Date),
  });
  releaseStale();
  await expect(staleRun).rejects.toMatchObject({ code: 'JOB_LEASE_MISMATCH' });

  const persisted = await db.query<{
    batch_state: string;
    item_state: string;
    attempts: number;
    claimed_job_attempt: number;
    questions: number;
    retrievals: number;
  }>(
    `select batch.state as batch_state,item.state as item_state,item.attempts,item.claimed_job_attempt,
            (select count(*)::int from questions where generation_item_id=item.id) as questions,
            (select count(*)::int from generation_retrievals where generation_item_id=item.id) as retrievals
       from generation_items item
       join generation_batches batch on batch.id=item.generation_batch_id
      where item.generation_batch_id=$1`,
    [batchId],
  );
  expect(persisted.rows[0]).toEqual({
    batch_state: 'COMPLETED',
    item_state: 'COMPLETED',
    attempts: 2,
    claimed_job_attempt: currentLease.attempt,
    questions: 1,
    retrievals: 1,
  });
});

test('keeps semantic and preceding evidence inside the pinned revision and selected TOC branch', async () => {
  const sourceId = randomUUID();
  const historicalRevisionId = randomUUID();
  const pinnedRevisionId = randomUUID();
  const batchId = randomUUID();
  const selectedTocId = randomUUID();
  const otherTocId = randomUUID();
  testSourceIds.push(sourceId);
  testBatchIds.push(batchId);

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'strict-scope.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$3,1,'test'),($2,$3,2,'test')`,
    [historicalRevisionId, pinnedRevisionId, sourceId],
  );
  const historicalChunk = randomUUID();
  const otherBranchChunk = randomUUID();
  const selectedBranchChunk1 = randomUUID();
  const selectedBranchChunk2 = randomUUID();
  await db.query(
    `insert into source_chunks(id,source_file_id,source_revision_id,ordinal,content,page_start,unit)
     values
       ($1,$5,$6,1,'이전 리비전의 폐기된 내용',1,'과거 단원'),
       ($2,$5,$7,1,'선택하지 않은 전기 단원의 내용',10,'전기'),
       ($3,$5,$7,2,'선택한 역학 단원의 속도 내용',20,'역학'),
       ($4,$5,$7,3,'선택한 역학 단원의 힘 내용',21,'역학')`,
    [historicalChunk, otherBranchChunk, selectedBranchChunk1, selectedBranchChunk2, sourceId, historicalRevisionId, pinnedRevisionId],
  );
  await db.query(
    `insert into source_toc_entries(
       id,source_file_id,source_revision_id,ordinal,title,level,mapping_status,mapping_confidence
     ) values
       ($1,$3,$4,1,'전기',1,'MAPPED',1),
       ($2,$3,$4,2,'역학',1,'MAPPED',1)`,
    [otherTocId, selectedTocId, sourceId, pinnedRevisionId],
  );
  await expect(db.query(
    `insert into source_chunk_toc_entries(
       source_chunk_id,source_toc_entry_id,source_revision_id,relation,confidence
     ) values($1,$2,$3,'DIRECT',1)`,
    [historicalChunk, selectedTocId, historicalRevisionId],
  )).rejects.toMatchObject({ code: '23503' });
  await db.query(
    `insert into source_chunk_toc_entries(
       source_chunk_id,source_toc_entry_id,source_revision_id,relation,confidence
     ) values
       ($1,$3,$6,'DIRECT',1),
       ($2,$4,$6,'DIRECT',1),
       ($5,$4,$6,'DIRECT',1)`,
    [otherBranchChunk, selectedBranchChunk1, otherTocId, selectedTocId, selectedBranchChunk2, pinnedRevisionId],
  );
  await db.query(
    `insert into generation_batches(id,requested_count,conditions,source_scope,generation_model,prompt_version)
     values($1,1,$2::jsonb,$3::jsonb,'mock-gemini','test')`,
    [
      batchId,
      JSON.stringify({
        subject: '과학', grade: '고등학교 1학년', units: ['역학'], purpose: '개념 적용·문제풀이',
        questionType: '구조화 서술형', difficulty: '상', direction: '선수관계를 측정',
        chunkCount: 2, executionMode: 'sequential',
      }),
      JSON.stringify({
        sourceFileIds: [sourceId],
        sourceRevisionIds: [pinnedRevisionId],
        tocEntryIds: [selectedTocId],
      }),
    ],
  );

  const lease = await claimGenerationLease(batchId, `worker-${batchId}`);
  await expect(generateQuestions(batchId, { lease })).resolves.toEqual({ questions: 1 });

  const retrieval = await db.query<{
    candidate_scope: { sourceRevisionIds: string[]; tocEntryIds: string[] };
    selected_chunks: Array<{ chunkId: string }>;
  }>(
    `select candidate_scope, selected_chunks
       from generation_retrievals
      where generation_batch_id=$1`,
    [batchId],
  );
  expect(retrieval.rows[0]?.candidate_scope).toMatchObject({
    sourceRevisionIds: [pinnedRevisionId],
    tocEntryIds: [selectedTocId],
  });
  expect(retrieval.rows[0]?.selected_chunks.map((chunk) => chunk.chunkId)).toEqual([
    selectedBranchChunk1,
    selectedBranchChunk2,
  ]);

  const evidence = await db.query<{ source_chunk_id: string }>(
    `select evidence.source_chunk_id
       from question_evidence evidence
       join questions question on question.id = evidence.question_id
      where question.generation_batch_id = $1`,
    [batchId],
  );
  expect(evidence.rows.map((row) => row.source_chunk_id)).toEqual([selectedBranchChunk1]);
  expect(evidence.rows.map((row) => row.source_chunk_id)).not.toContain(otherBranchChunk);
  expect(evidence.rows.map((row) => row.source_chunk_id)).not.toContain(historicalChunk);
});

test('atomically pins a legacy empty-TOC batch and keeps retries on that revision', async () => {
  const sourceId = randomUUID();
  const pinnedRevisionId = randomUUID();
  const newerRevisionId = randomUUID();
  const pinnedChunkId = randomUUID();
  const newerChunkId = randomUUID();
  const batchId = randomUUID();
  testSourceIds.push(sourceId);
  testBatchIds.push(batchId);

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'legacy-scope.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [pinnedRevisionId, sourceId],
  );
  await db.query(
    `insert into source_chunks(id,source_file_id,source_revision_id,ordinal,content,page_start,unit)
     values($1,$2,$3,1,'처음 고정된 리비전의 내용',1,'고정 단원')`,
    [pinnedChunkId, sourceId, pinnedRevisionId],
  );
  await db.query(
    `insert into generation_batches(id,requested_count,conditions,source_scope,generation_model,prompt_version)
     values($1,1,$2::jsonb,$3::jsonb,'mock-gemini','test')`,
    [
      batchId,
      JSON.stringify({
        subject: '과학', grade: '중학교 1학년', units: [], purpose: '선수관계 측정',
        questionType: '구조화 서술형', difficulty: '중', direction: '리비전 고정 검증',
        chunkCount: 3, executionMode: 'sequential',
      }),
      JSON.stringify({ sourceFileIds: [sourceId], tocEntryIds: [] }),
    ],
  );

  const lease = await claimGenerationLease(batchId, `worker-${batchId}`);
  await expect(generateQuestions(batchId, { lease })).resolves.toEqual({ questions: 1 });
  const firstScope = await db.query<{ source_scope: { sourceRevisionIds: string[] } }>(
    `select source_scope from generation_batches where id=$1`,
    [batchId],
  );
  expect(firstScope.rows[0]?.source_scope.sourceRevisionIds).toEqual([pinnedRevisionId]);

  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,2,'test')`,
    [newerRevisionId, sourceId],
  );
  await db.query(
    `insert into source_chunks(id,source_file_id,source_revision_id,ordinal,content,page_start,unit)
     values($1,$2,$3,1,'나중에 추가된 리비전의 내용',1,'신규 단원')`,
    [newerChunkId, sourceId, newerRevisionId],
  );

  await expect(generateQuestions(batchId, { lease })).resolves.toEqual({ questions: 1 });

  const stored = await db.query<{
    source_scope: { sourceRevisionIds: string[]; tocEntryIds: string[] };
  }>(`select source_scope from generation_batches where id=$1`, [batchId]);
  expect(stored.rows[0]?.source_scope).toMatchObject({
    sourceRevisionIds: [pinnedRevisionId],
    tocEntryIds: [],
  });
  const retrievals = await db.query<{
    candidate_scope: { sourceRevisionIds: string[]; tocEntryIds: string[] };
    selected_chunks: Array<{ chunkId: string }>;
  }>(
    `select candidate_scope, selected_chunks
       from generation_retrievals
      where generation_batch_id=$1
      order by created_at`,
    [batchId],
  );
  expect(retrievals.rows).toHaveLength(1);
  expect(retrievals.rows.every((retrieval) =>
    retrieval.candidate_scope.sourceRevisionIds[0] === pinnedRevisionId
    && retrieval.candidate_scope.tocEntryIds.length === 0
    && retrieval.selected_chunks.every((chunk) => chunk.chunkId === pinnedChunkId))).toBe(true);
  expect(retrievals.rows.flatMap((retrieval) => retrieval.selected_chunks.map((chunk) => chunk.chunkId)))
    .not.toContain(newerChunkId);
});

test('rebuilds TOC mappings without changing an existing revision entry ID', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const chunkId = randomUUID();
  const tocEntryId = randomUUID();
  testSourceIds.push(sourceId);

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'toc-upsert.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  await db.query(
    `insert into source_chunks(id,source_file_id,source_revision_id,ordinal,content,page_start,unit)
     values($1,$2,$3,1,'속도 단원의 내용',5,'속도')`,
    [chunkId, sourceId, revisionId],
  );
  await db.query(
    `insert into source_toc_entries(
       id,source_file_id,source_revision_id,ordinal,title,level,mapping_status,mapping_confidence
     ) values($1,$2,$3,1,'속도',1,'MAPPED',1)`,
    [tocEntryId, sourceId, revisionId],
  );
  await db.query(
    `insert into source_chunk_toc_entries(
       source_chunk_id,source_toc_entry_id,source_revision_id,relation,confidence
     ) values($1,$2,$3,'DIRECT',1)`,
    [chunkId, tocEntryId, revisionId],
  );

  await withTransaction((client) => replaceSourceTocEntries(
    client,
    sourceId,
    revisionId,
    [{ ordinal: 1, title: '충돌하는 재추출 제목', level: 2, printedPage: 99 }],
    [{ id: chunkId, ordinal: 1, pageStart: 5, pageEnd: 5, chapter: null, unit: '속도' }],
  ));

  const entries = await db.query<{
    id: string;
    title: string;
    level: number;
    printed_page: number | null;
    parent_id: string | null;
  }>(
    `select id,title,level,printed_page,parent_id
       from source_toc_entries
      where source_revision_id=$1
      order by ordinal`,
    [revisionId],
  );
  expect(entries.rows).toEqual([{
    id: tocEntryId,
    title: '속도',
    level: 1,
    printed_page: null,
    parent_id: null,
  }]);
  const mappings = await db.query<{ source_toc_entry_id: string; source_revision_id: string }>(
    `select source_toc_entry_id,source_revision_id
       from source_chunk_toc_entries
      where source_chunk_id=$1`,
    [chunkId],
  );
  expect(mappings.rows).toEqual([{ source_toc_entry_id: tocEntryId, source_revision_id: revisionId }]);
});

test('rolls back a new revision, chunk, and TOC when mapping integrity fails', async () => {
  const sourceId = randomUUID();
  const baselineRevisionId = randomUUID();
  const failedRevisionId = randomUUID();
  const failedChunkId = randomUUID();
  const failedTocId = randomUUID();
  testSourceIds.push(sourceId);

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'rollback.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [baselineRevisionId, sourceId],
  );

  const client = await db.connect();
  let mappingFailure: unknown = null;
  try {
    await client.query('begin');
    await client.query(
      `insert into source_revisions(id,source_file_id,revision,parse_model)
       values($1,$2,2,'test')`,
      [failedRevisionId, sourceId],
    );
    await client.query(
      `insert into source_chunks(id,source_file_id,source_revision_id,ordinal,content,page_start,unit)
       values($1,$2,$3,1,'롤백되어야 할 청크',1,'롤백 단원')`,
      [failedChunkId, sourceId, failedRevisionId],
    );
    await client.query(
      `insert into source_toc_entries(
         id,source_file_id,source_revision_id,ordinal,title,level,mapping_status,mapping_confidence
       ) values($1,$2,$3,1,'롤백 단원',1,'MAPPED',1)`,
      [failedTocId, sourceId, failedRevisionId],
    );
    try {
      await client.query(
        `insert into source_chunk_toc_entries(
           source_chunk_id,source_toc_entry_id,source_revision_id,relation,confidence
         ) values($1,$2,$3,'DIRECT',1)`,
        [failedChunkId, failedTocId, baselineRevisionId],
      );
    } catch (error) {
      mappingFailure = error;
    }
    await client.query('rollback');
  } finally {
    client.release();
  }

  expect(mappingFailure).toMatchObject({ code: '23503' });
  const persisted = await db.query<{
    revisions: number;
    chunks: number;
    entries: number;
    mappings: number;
  }>(
    `select
       (select count(*)::int from source_revisions where id=$1) as revisions,
       (select count(*)::int from source_chunks where id=$2) as chunks,
       (select count(*)::int from source_toc_entries where id=$3) as entries,
       (select count(*)::int from source_chunk_toc_entries
         where source_chunk_id=$2 or source_toc_entry_id=$3) as mappings`,
    [failedRevisionId, failedChunkId, failedTocId],
  );
  expect(persisted.rows[0]).toEqual({ revisions: 0, chunks: 0, entries: 0, mappings: 0 });
});

test('populates missing migrated parent IDs from the persisted revision hierarchy', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const chunkId = randomUUID();
  const parentTocId = randomUUID();
  const childTocId = randomUUID();
  testSourceIds.push(sourceId);

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'migrated-parent.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  await db.query(
    `insert into source_chunks(id,source_file_id,source_revision_id,ordinal,content,page_start,chapter,unit)
     values($1,$2,$3,1,'속도 단원의 내용',5,'역학','속도')`,
    [chunkId, sourceId, revisionId],
  );
  await db.query(
    `insert into source_toc_entries(
       id,source_file_id,source_revision_id,parent_id,ordinal,title,level,mapping_status
     ) values
       ($1,$3,$4,null,1,'역학',1,'UNMAPPED'),
       ($2,$3,$4,null,2,'속도',2,'UNMAPPED')`,
    [parentTocId, childTocId, sourceId, revisionId],
  );

  await withTransaction((client) => replaceSourceTocEntries(
    client,
    sourceId,
    revisionId,
    [],
    [{ id: chunkId, ordinal: 1, pageStart: 5, pageEnd: 5, chapter: '역학', unit: '속도' }],
  ));

  const entries = await db.query<{ id: string; parent_id: string | null }>(
    `select id,parent_id
       from source_toc_entries
      where source_revision_id=$1
      order by ordinal`,
    [revisionId],
  );
  expect(entries.rows).toEqual([
    { id: parentTocId, parent_id: null },
    { id: childTocId, parent_id: parentTocId },
  ]);
});

test('records an empty TOC alignment once and does not retry it on later renders', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  testSourceIds.push(sourceId);

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'empty-toc.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(
       id,source_file_id,revision,parse_model,raw_html
     ) values($1,$2,1,'test','<section data-page="1"><p>목차가 없는 본문</p></section>')`,
    [revisionId, sourceId],
  );

  await backfillMissingSourceTocEntries([sourceId]);
  const firstAttempt = await db.query<{ attempted_at: string; entry_count: number }>(
    `select revision.toc_alignment_attempted_at::text as attempted_at,
            (select count(*)::int from source_toc_entries entry
              where entry.source_revision_id=revision.id) as entry_count
       from source_revisions revision
      where revision.id=$1`,
    [revisionId],
  );
  expect(firstAttempt.rows[0]?.attempted_at).toBeTruthy();
  expect(firstAttempt.rows[0]?.entry_count).toBe(0);

  await db.query(
    `update source_revisions
        set raw_html='<section data-page="1"><p data-category="index">나중에 생긴 단원 12</p></section>'
      where id=$1`,
    [revisionId],
  );
  await backfillMissingSourceTocEntries([sourceId]);

  const secondAttempt = await db.query<{ attempted_at: string; entry_count: number }>(
    `select revision.toc_alignment_attempted_at::text as attempted_at,
            (select count(*)::int from source_toc_entries entry
              where entry.source_revision_id=revision.id) as entry_count
       from source_revisions revision
      where revision.id=$1`,
    [revisionId],
  );
  expect(secondAttempt.rows[0]).toEqual(firstAttempt.rows[0]);
});

test('backfill keeps legacy null-heading continuations inside their unit and stops at the next positive heading', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const speedTocId = randomUUID();
  const forceTocId = randomUUID();
  const speedChunkId = randomUUID();
  const continuationChunkId = randomUUID();
  const forceChunkId = randomUUID();
  testSourceIds.push(sourceId);

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'legacy-continuation.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model,raw_html)
     values($1,$2,1,'test','<section data-page="1"><p>기존 리비전</p></section>')`,
    [revisionId, sourceId],
  );
  await db.query(
    `insert into source_chunks(
       id,source_file_id,source_revision_id,ordinal,content,page_start,chapter,unit
     ) values
       ($1,$4,$5,1,'속도 시작',1,'운동','속도'),
       ($2,$4,$5,2,'속도 설명의 연속 페이지',2,null,null),
       ($3,$4,$5,3,'힘 단원 시작',3,null,'힘')`,
    [speedChunkId, continuationChunkId, forceChunkId, sourceId, revisionId],
  );
  await db.query(
    `insert into source_toc_entries(
       id,source_file_id,source_revision_id,ordinal,title,level,mapping_status
     ) values
       ($1,$3,$4,1,'속도',1,'UNMAPPED'),
       ($2,$3,$4,2,'힘',1,'UNMAPPED')`,
    [speedTocId, forceTocId, sourceId, revisionId],
  );

  await backfillMissingSourceTocEntries([sourceId]);

  const mappings = await db.query<{ source_toc_entry_id: string; source_chunk_id: string }>(
    `select source_toc_entry_id,source_chunk_id
       from source_chunk_toc_entries
      where source_revision_id=$1
      order by source_toc_entry_id,source_chunk_id`,
    [revisionId],
  );
  const speedChunks = mappings.rows
    .filter((mapping) => mapping.source_toc_entry_id === speedTocId)
    .map((mapping) => mapping.source_chunk_id);
  const forceChunks = mappings.rows
    .filter((mapping) => mapping.source_toc_entry_id === forceTocId)
    .map((mapping) => mapping.source_chunk_id);
  expect(new Set(speedChunks)).toEqual(new Set([speedChunkId, continuationChunkId]));
  expect(new Set(forceChunks)).toEqual(new Set([forceChunkId]));
});

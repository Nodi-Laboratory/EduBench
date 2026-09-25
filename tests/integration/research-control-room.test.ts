import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { seedDatabase } from '../../scripts/seed';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  getControlRoomSnapshot,
  readControlRoomSnapshot,
} from '@/server/research/control-room-snapshot';
import {
  readControlRoomEvents,
} from '@/server/research/control-room-events';
import { createRun } from '@/server/runs/service';
import { createRealPublishedDataset } from './helpers/real-dataset';

beforeAll(async () => {
  await migrate();
  await seedDatabase();
});

afterAll(async () => {
  await db.end();
});

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('reads live leases, operations, failures, profiles, events, and partial scores from the real database', async () => {
  const activeSourceId = randomUUID();
  const failedSourceId = randomUUID();
  const readySourceId = randomUUID();
  await db.query(
    `insert into source_files(
       id,sha256,original_name,storage_path,mime_type,byte_size,status,
       failed_stage,failure_code,failure_message
     ) values
       ($1,$2,'관제실 처리 중.pdf','/tmp/control-room-active.pdf',
        'application/pdf',1024,'PARSING',null,null,null),
       ($3,$4,'관제실 실패.pdf','/tmp/control-room-failed.pdf',
        'application/pdf',2048,'FAILED','PARSING',
        'DOCUMENT_RASTERIZATION_TIMEOUT','페이지 묶음 변환 시간이 초과되었습니다.'),
       ($5,$6,'관제실 완료.pdf','/tmp/control-room-ready.pdf',
        'application/pdf',4096,'READY',null,null,null)`,
    [
      activeSourceId,
      sha(activeSourceId),
      failedSourceId,
      sha(failedSourceId),
      readySourceId,
      sha(readySourceId),
    ],
  );

  const activeJobId = randomUUID();
  const staleJobId = randomUUID();
  await db.query(
    `insert into jobs(
       id,kind,state,payload,idempotency_key,attempts,lease_owner,
       lease_expires_at,updated_at
     ) values
       ($1,'document.parse','LEASED',$2::jsonb,$3,1,'worker-live',
        now()+interval '10 minutes',now()),
       ($4,'maintenance.probe','LEASED','{}'::jsonb,$5,1,'worker-stale',
        now()-interval '10 minutes',now()),
       (gen_random_uuid(),'maintenance.pending','PENDING','{}'::jsonb,$6,0,null,null,now()),
       (gen_random_uuid(),'maintenance.retry','RETRY_WAIT','{}'::jsonb,$7,1,null,null,now())`,
    [
      activeJobId,
      JSON.stringify({ sourceId: activeSourceId }),
      `control-room-active-${randomUUID()}`,
      staleJobId,
      `control-room-stale-${randomUUID()}`,
      `control-room-pending-${randomUUID()}`,
      `control-room-retry-${randomUUID()}`,
    ],
  );
  const sourceEvent = await db.query<{ id: string }>(
    `insert into job_events(
       job_id,aggregate_type,aggregate_id,event_type,payload
     ) values(
       $1,'source',$2,'DOCUMENT_PARSE_STARTED',
       '{"completedPages":2,"totalPages":173}'::jsonb
     ) returning id::text`,
    [activeJobId, activeSourceId],
  );
  const lifecycleEvent = await db.query<{ id: string }>(
    `insert into job_events(
       job_id,aggregate_type,aggregate_id,event_type,payload
     ) values(
       $1,'job',$1,'JOB_CLAIMED',
       '{"attempt":1,"workerId":"worker-live"}'::jsonb
     ) returning id::text`,
    [activeJobId],
  );

  const datasetVersionId = await createRealPublishedDataset(1);
  const run = await createRun({
    title: `관제실 점수 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'control-room-test',
    systemPrompt: '교과서 근거로 답하라.',
    models: [{
      providerKey: 'gemini',
      displayName: 'Control Room Model',
      modelId: 'control-room-model',
      protocol: 'gemini',
      concurrency: 1,
    }],
  });
  const item = await db.query<{ id: string }>(
    'select id from run_items where benchmark_run_id=$1 limit 1',
    [run.id],
  );
  const response = await db.query<{ id: string }>(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text
     ) values($1,1,'control-room-model','응답','응답')
     returning id`,
    [item.rows[0]!.id],
  );
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,provenance
     ) values
     (
       $1,'20000000-0000-0000-0000-000000000001',
       'exact_match',0.75,'DETERMINISTIC_ENGINE_VERIFIED'
     ),
     (
       $1,'20000000-0000-0000-0000-000000000001',
       'response_present',1,'DETERMINISTIC_ENGINE_VERIFIED'
     )`,
    [response.rows[0]!.id],
  );
  await db.query(
    `update run_items set state='SUCCEEDED',completed_at=now()
     where id=$1`,
    [item.rows[0]!.id],
  );
  await db.query(
    `update benchmark_runs
        set state='RUNNING',completed_items=1,updated_at=now()
      where id=$1`,
    [run.id],
  );
  await db.query(
    `insert into questions(
       public_id,status,subject,grade,purpose,difficulty,question_type,
       evidence_mode,deleted_at
     ) values($1,'APPROVED','과학','중학교','삭제 집계 검증','중',
              'short_answer','closed_book',now())`,
    [`Q-DELETED-${randomUUID()}`],
  );
  const approved = await db.query<{ count: number }>(
    `select count(*)::int count
       from questions
      where status='APPROVED' and deleted_at is null`,
  );

  const snapshot = await getControlRoomSnapshot();

  expect(BigInt(snapshot.eventCursor)).toBeGreaterThanOrEqual(
    BigInt(sourceEvent.rows[0]!.id),
  );
  expect(Number.isNaN(Date.parse(snapshot.generatedAt))).toBe(false);
  expect(snapshot.system.database).toMatchObject({ state: 'HEALTHY' });
  expect(snapshot.system.database.latencyMs).toBeGreaterThanOrEqual(0);
  expect(snapshot.system.worker).toMatchObject({
    state: 'STALE',
    activeLeases: expect.any(Number),
    staleLeases: expect.any(Number),
  });
  expect(snapshot.system.worker.activeLeases).toBeGreaterThanOrEqual(1);
  expect(snapshot.system.worker.staleLeases).toBeGreaterThanOrEqual(1);
  expect(snapshot.system.queue.pending).toBeGreaterThanOrEqual(1);
  expect(snapshot.system.queue.retryWait).toBeGreaterThanOrEqual(1);
  expect(snapshot.system.queue.leased).toBeGreaterThanOrEqual(2);
  expect(snapshot.activeOperations).toEqual(expect.arrayContaining([
    expect.objectContaining({
      aggregateType: 'source',
      aggregateId: activeSourceId,
      label: '관제실 처리 중.pdf',
      stage: 'PARSING',
      state: 'LEASED',
      progress: expect.objectContaining({
        completedPages: 2,
        totalPages: 173,
      }),
    }),
    expect.objectContaining({
      aggregateType: 'benchmark_run',
      aggregateId: run.id,
      state: 'RUNNING',
    }),
  ]));
  expect(snapshot.activeOperations).toEqual(expect.arrayContaining([
    expect.objectContaining({
      aggregateType: 'job',
      aggregateId: staleJobId,
      state: 'STALE',
    }),
  ]));
  expect(snapshot.failures).toEqual(expect.arrayContaining([
    expect.objectContaining({
      aggregateType: 'source',
      aggregateId: failedSourceId,
      stage: 'PARSING',
      code: 'DOCUMENT_RASTERIZATION_TIMEOUT',
    }),
  ]));
  expect(snapshot.failures.length).toBeLessThanOrEqual(50);
  expect(snapshot.failureTotal).toBeGreaterThanOrEqual(snapshot.failures.length);
  expect(snapshot.recentEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: sourceEvent.rows[0]!.id,
      aggregateType: 'source',
      aggregateId: activeSourceId,
      eventType: 'DOCUMENT_PARSE_STARTED',
      payload: {
        completedPages: 2,
        totalPages: 173,
      },
    }),
    expect.objectContaining({
      id: lifecycleEvent.rows[0]!.id,
      aggregateType: 'source',
      aggregateId: activeSourceId,
      eventType: 'JOB_CLAIMED',
      payload: {
        attempt: 1,
        workerId: 'worker-live',
      },
    }),
  ]));
  expect(snapshot.profiles.length).toBeGreaterThanOrEqual(4);
  expect(snapshot.profiles).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'document_parse',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      activatedAt: expect.any(String),
    }),
  ]));
  expect(snapshot.scoreboard).toEqual(expect.arrayContaining([
    expect.objectContaining({
      runId: run.id,
      runLabel: expect.stringContaining('관제실 점수'),
      model: 'Control Room Model',
      metric: 'response_present',
      mean: 1,
      scored: 1,
      eligible: 1,
    }),
  ]));
  expect(snapshot.scoreboard.some((row) => row.metric === 'exact_match')).toBe(false);
  expect(snapshot.scoreboard.length).toBeLessThanOrEqual(50);
  expect(snapshot.scoreboardTotal).toBeGreaterThanOrEqual(snapshot.scoreboard.length);
  expect(snapshot.pipelineStages.map(({ key, label }) => ({ key, label }))).toEqual([
    { key: 'UPLOAD', label: 'Upload' },
    { key: 'PARSE', label: 'Parse' },
    { key: 'CHUNK', label: 'Chunk' },
    { key: 'EMBED', label: 'Embed' },
    { key: 'GENERATE', label: 'Generate' },
    { key: 'REVIEW', label: 'Review' },
    { key: 'FREEZE', label: 'Freeze' },
    { key: 'EXECUTE', label: 'Execute' },
    { key: 'SCORE', label: 'Score' },
  ]);
  expect(snapshot.pipelineStages.find((stage) => stage.key === 'PARSE')!.active)
    .toBeGreaterThanOrEqual(1);
  expect(snapshot.pipelineStages.find((stage) => stage.key === 'PARSE')!.failed)
    .toBeGreaterThanOrEqual(1);
  expect(snapshot.pipelineStages.find((stage) => stage.key === 'EMBED')!.ready)
    .toBeGreaterThanOrEqual(1);
  expect(snapshot.pipelineStages.find((stage) => stage.key === 'REVIEW')!.ready)
    .toBe(approved.rows[0]!.count);
});

test('preserves a non-UUID job aggregate reference without casting or replacing it', async () => {
  const cursor = await db.query<{ value: string }>(
    'select coalesce(max(id),0)::text value from job_events',
  );
  const jobId = randomUUID();
  await db.query(
    `insert into jobs(
       id,kind,state,payload,idempotency_key
     ) values(
       $1,'document.parse','PENDING',
       '{"sourceId":"stale"}'::jsonb,$2
     )`,
    [jobId, `control-room-non-uuid-${randomUUID()}`],
  );
  const event = await db.query<{ id: string }>(
    `insert into job_events(
       job_id,aggregate_type,aggregate_id,event_type,payload
     ) values(
       $1,'job',$1,'JOB_ENQUEUED',
       '{"kind":"document.parse","sourceRef":"stale"}'::jsonb
     ) returning id::text`,
    [jobId],
  );

  const events = await readControlRoomEvents(
    db,
    cursor.rows[0]!.value,
    10,
  );

  expect(events).toEqual([
    {
      id: event.rows[0]!.id,
      aggregateType: 'source',
      aggregateId: 'stale',
      eventType: 'JOB_ENQUEUED',
      stage: 'QUEUE',
      state: 'PENDING',
      summary: 'stale · Job Enqueued',
      payload: {
        kind: 'document.parse',
        sourceRef: 'stale',
      },
      createdAt: expect.any(String),
    },
  ]);
});

test('keeps the failure inbox bounded while counting every failure by pipeline stage', async () => {
  const client = await db.connect();
  await client.query('begin');
  try {
    const before = await readControlRoomSnapshot(client);
    const beforeParseFailures = before.pipelineStages
      .find((stage) => stage.key === 'PARSE')!.failed;
    const sourceIds = Array.from({ length: 51 }, () => randomUUID());

    await client.query(
      `insert into source_files(
         id,sha256,original_name,storage_path,mime_type,byte_size,status,
         failed_stage,failure_code,failure_message,updated_at
       )
       select source_id::uuid,
              encode(sha256(source_id::bytea),'hex'),
              'failure-limit-' || ordinal || '.pdf',
              '/tmp/failure-limit-' || ordinal || '.pdf',
              'application/pdf',1,'FAILED','PARSING',
              'PARSE_LIMIT_TEST','failure aggregate regression',
              clock_timestamp() + ordinal * interval '1 microsecond'
         from unnest($1::text[]) with ordinality as source(source_id,ordinal)`,
      [sourceIds],
    );

    const after = await readControlRoomSnapshot(client);

    expect(after.failures).toHaveLength(50);
    expect(after.failureTotal).toBe(before.failureTotal + 51);
    expect(after.pipelineStages.find((stage) => stage.key === 'PARSE')!.failed)
      .toBe(beforeParseFailures + 51);
  } finally {
    await client.query('rollback');
    client.release();
  }
});

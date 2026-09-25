import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import {
  claimRunItems,
  commandRun,
  createRun,
  failRunItem,
  retryFailedRunItems,
  finishCancellationWhenDrained,
  finishPauseWhenDrained,
  finishStopWhenDrained,
  interruptRunItem,
  retryScoringRun,
} from '@/server/runs/service';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;

beforeAll(async () => {
  await migrate();
  await seedDatabase();
  datasetVersionId = await createRealPublishedDataset(5);
});

test('cancellation closes pending work and reaches a terminal state', async () => {
  const run = await createRun({ title: `취소 테스트 ${randomUUID().slice(0, 8)}`, datasetVersionId, scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1', systemPrompt: '답하라.', questionLimit: 2, models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' }] });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  expect((await commandRun(run.id, 'CANCEL')).state).toBe('CANCELLING');
  expect(await finishCancellationWhenDrained(run.id)).toBe(true);
  const stored = await db.query<{ state: string; cancelled: string }>(`select br.state, count(ri.id) filter (where ri.state='CANCELLED')::text cancelled from benchmark_runs br join run_items ri on ri.benchmark_run_id=br.id where br.id=$1 group by br.id`, [run.id]);
  expect(stored.rows[0]).toEqual({ state: 'CANCELLED', cancelled: '2' });
});

afterAll(async () => {
  await db.end();
});

test('creates the complete question × model execution matrix', async () => {
  const run = await createRun({
    title: `통합 테스트 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '근거에 따라 답하라.',
    questionLimit: 5,
    models: [
      { providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini', concurrency: 3 },
      { providerKey: 'openai', displayName: 'OpenAI', modelId: 'openai-test', protocol: 'openai-responses' },
    ],
  });

  expect(run).toMatchObject({ state: 'DRAFT', totalItems: 10 });
  const matrix = await db.query<{ count: string }>(
    'select count(*) from run_items where benchmark_run_id = $1', [run.id],
  );
  expect(Number(matrix.rows[0]?.count)).toBe(10);
});

test('creates a comparable question × model × retrieval-mode matrix', async () => {
  const batchId = randomUUID();
  await db.query(
    `insert into generation_batches(
       id,requested_count,conditions,source_scope,
       generation_model,prompt_version
     ) values($1,2,'{}'::jsonb,'{}'::jsonb,'fixture','fixture')`,
    [batchId],
  );
  const selectedQuestions = await db.query<{ question_id:string }>(
    `select question_id
       from dataset_questions
      where dataset_version_id=$1
      order by ordinal
      limit 2`,
    [datasetVersionId],
  );
  for (const [index, question] of selectedQuestions.rows.entries()) {
    const itemId = randomUUID();
    const revisionId = randomUUID();
    const chunkId = randomUUID();
    await db.query(
      `insert into generation_items(
         id,generation_batch_id,ordinal,state
       ) values($1,$2,$3,'COMPLETED')`,
      [itemId, batchId, index + 1],
    );
    await db.query(
      `update questions set
         generation_batch_id=$2,generation_item_id=$3
       where id=$1`,
      [question.question_id, batchId, itemId],
    );
    await db.query(
      `insert into generation_retrievals(
         generation_batch_id,generation_item_id,attempt,query_text,
         embedding_model,candidate_scope,selected_chunks
       ) values($1,$2,1,'fixture query','fixture embedding',$3::jsonb,$4::jsonb)`,
      [
        batchId,
        itemId,
        JSON.stringify({ sourceRevisionIds:[revisionId] }),
        JSON.stringify([{
          chunkId,
          content:'검색 조건 행렬 생성용 감사 근거',
        }]),
      ],
    );
  }
  const run = await createRun({
    title: `검색 조건 비교 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '질문에 답하라.',
    questionLimit: 2,
    retrievalModes: ['NONE', 'VECTOR', 'PIKE'],
    models: [
      {
        providerKey: 'gemini',
        displayName: 'Gemini',
        modelId: 'gemini-test',
        protocol: 'gemini',
      },
    ],
  });

  expect(run).toMatchObject({ state: 'DRAFT', totalItems: 6 });
  const matrix = await db.query<{
    retrieval_mode:string;
    count:string;
  }>(
    `select retrieval_mode,count(*)::text
       from run_items
      where benchmark_run_id=$1
      group by retrieval_mode
      order by retrieval_mode`,
    [run.id],
  );
  expect(matrix.rows).toEqual([
    { retrieval_mode:'NONE', count:'2' },
    { retrieval_mode:'PIKE', count:'2' },
    { retrieval_mode:'VECTOR', count:'2' },
  ]);
});

test('pause prevents new claims, resume restores them, and failed items retry explicitly', async () => {
  const run = await createRun({
    title: `통제 테스트 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '근거에 따라 답하라.',
    questionLimit: 3,
    models: [
      { providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini', concurrency: 3 },
    ],
  });

  expect((await commandRun(run.id, 'QUEUE')).state).toBe('QUEUED');
  expect((await commandRun(run.id, 'START')).state).toBe('RUNNING');
  const [claimed] = await claimRunItems(run.id, 'worker-a', 1, 30_000);
  expect(claimed?.state).toBe('LEASED');

  expect((await commandRun(run.id, 'PAUSE')).state).toBe('PAUSING');
  expect(await claimRunItems(run.id, 'worker-b', 2, 30_000)).toEqual([]);
  await failRunItem(claimed!.id, 'worker-a', 'PROVIDER_5XX', 'upstream unavailable');
  expect(await finishPauseWhenDrained(run.id)).toBe(true);

  expect(await retryFailedRunItems(run.id)).toBe(1);
  expect((await commandRun(run.id, 'RESUME')).state).toBe('RUNNING');
  expect(await claimRunItems(run.id, 'worker-b', 3, 30_000)).toHaveLength(3);

  const events = await db.query<{ event_type: string }>(
    `select event_type from job_events
     where aggregate_type = 'benchmark_run' and aggregate_id = $1 order by id`,
    [run.id],
  );
  expect(events.rows.map((event) => event.event_type)).toEqual(expect.arrayContaining([
    'RUN_CREATED', 'RUN_QUEUED', 'RUN_STARTED', 'RUN_PAUSED', 'RUN_ITEM_FAILED', 'RUN_ITEMS_RETRIED', 'RUN_RESUMED',
  ]));
});

test('stop restores leased work without consuming an attempt and can resume', async () => {
  const run = await createRun({
    title: `중지 복구 ${randomUUID().slice(0, 8)}`, datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [claimed] = await claimRunItems(run.id, 'worker-stop', 1, 30_000);

  expect((await commandRun(run.id, 'STOP')).state).toBe('STOPPING');
  expect(await interruptRunItem(claimed!.id, 'worker-stop')).toBe(true);
  expect(await finishStopWhenDrained(run.id)).toBe(true);

  const stopped = await db.query<{ state: string; item_state: string; attempts: number }>(
    `select br.state,ri.state item_state,ri.attempts from benchmark_runs br join run_items ri on ri.benchmark_run_id=br.id where br.id=$1`, [run.id],
  );
  expect(stopped.rows[0]).toEqual({ state: 'STOPPED', item_state: 'PENDING', attempts: 0 });
  expect((await commandRun(run.id, 'RESUME')).state).toBe('RUNNING');
  expect(await claimRunItems(run.id, 'worker-resume', 1, 30_000)).toHaveLength(1);
});

test('a bounded scoring failure can be explicitly resumed', async () => {
  const run = await createRun({
    title: `채점 재개 ${randomUUID().slice(0, 8)}`, datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '답하라.', questionLimit: 1,
    models: [{ providerKey:'gemini', displayName:'Gemini', modelId:'gemini-test', protocol:'gemini' }],
  });
  await db.query("update benchmark_runs set state='FAILED',last_scoring_error='{\"attempts\":3,\"code\":\"JUDGE_PARSE_FAILED\"}'::jsonb where id=$1", [run.id]);
  expect(await retryScoringRun(run.id)).toEqual({ state:'SCORING' });
  const stored = await db.query<{ state: string; last_scoring_error: unknown }>('select state,last_scoring_error from benchmark_runs where id=$1', [run.id]);
  expect(stored.rows[0]).toEqual({ state:'SCORING', last_scoring_error:null });
});

test('a scoring pause preserves the scoring phase and resumes from its durable checkpoints', async () => {
  const run = await createRun({
    title: `채점 일시정지 ${randomUUID().slice(0, 8)}`, datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '답하라.', questionLimit: 1,
    models: [{ providerKey:'gemini', displayName:'Gemini', modelId:'gemini-test', protocol:'gemini' }],
  });
  await db.query("update benchmark_runs set state='SCORING' where id=$1", [run.id]);

  expect((await commandRun(run.id, 'PAUSE')).state).toBe('PAUSING');
  expect(await finishPauseWhenDrained(run.id)).toBe(true);
  expect((await commandRun(run.id, 'RESUME')).state).toBe('SCORING');

  const stored = await db.query<{ state:string; scoring_control_origin:string | null }>(
    `select state,parameters->>'scoringControlOrigin' scoring_control_origin
     from benchmark_runs where id=$1`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state:'SCORING',
    scoring_control_origin:'false',
  });
});

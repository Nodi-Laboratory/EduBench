import { afterAll, beforeAll, expect, test } from 'vitest';
import { GET } from '@/app/api/results/[id]/details/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { createRun } from '@/server/runs/service';
import { getResultDetails } from '@/server/results/details';
import { seedDatabase } from '../../scripts/seed';
import { createRealPublishedDataset } from './helpers/real-dataset';

let runId: string;

beforeAll(async () => {
  await migrate();
  await seedDatabase();
  const datasetVersionId = await createRealPublishedDataset(1);
  const run = await createRun({
    title: '실시간 결과 스냅샷',
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.',
    questionLimit: 1,
    models: [{
      providerKey: 'gemini',
      displayName: 'Gemini',
      modelId: 'gemini-test',
      protocol: 'gemini',
    }],
  });
  runId = run.id;
});

afterAll(async () => {
  await db.end();
});

test('returns the result snapshot and benchmark event cursor from one detail reader', async () => {
  const event = await db.query<{ id: string }>(
    `insert into job_events(aggregate_type,aggregate_id,event_type,payload)
     values('benchmark_run',$1,'RUN_SCORE_UPDATED','{"metricKey":"accuracy"}'::jsonb)
     returning id::text`,
    [runId],
  );

  const details = await getResultDetails(runId);

  expect(details).not.toBeNull();
  expect(details).toMatchObject({
    run: {
      id: runId,
      title: '실시간 결과 스냅샷',
      state: 'DRAFT',
      totalItems: 1,
      eligibleItems: 0,
    },
    scoringEngine: {
      id: expect.any(String),
      version: 'edubench-scoring-v2',
      title: 'EduBench 선수관계 평가 엔진 v2',
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      snapshotProvenance: 'AT_CREATION_VERIFIED',
      verified: true,
      currentVerified: true,
    },
    eventCursor: event.rows[0]!.id,
  });
  expect(details!.models).toHaveLength(1);
  expect(details!.models[0]).toMatchObject({
    totalItems: '1',
    succeededItems: '0',
    failedItems: '0',
    representativeFailure: null,
  });
  expect(details!.analytics.models[0]).toMatchObject({
    blindId: 'M01',
    responses: 0,
  });
});

test('reports per-model execution coverage and the dominant latest failure reason', async () => {
  const datasetVersionId = await createRealPublishedDataset(3);
  const run = await createRun({
    title: '모델 실패 가시성',
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.',
    questionLimit: 3,
    models: [{
      providerKey: 'openai',
      displayName: 'OpenAI',
      modelId: 'openai-test',
      protocol: 'openai-responses',
    }],
  });
  const items = await db.query<{ id: string }>(
    'select id from run_items where benchmark_run_id=$1 order by created_at,id',
    [run.id],
  );
  const dominantIds = items.rows.slice(0, 2).map((item) => item.id);
  const latestId = items.rows[2]!.id;
  await db.query(
    `update run_items
        set state='TERMINAL_FAILED',
            error_code='OPENAI_INCOMPLETE_RESPONSE',
            error_message='OpenAI 응답이 출력 한도 전에 완료되지 않았습니다.',
            completed_at=now()-interval '1 minute'
      where id=any($1::uuid[])`,
    [dominantIds],
  );
  await db.query(
    `update run_items
        set state='TERMINAL_FAILED',
            error_code='NETWORK',
            error_message='일시적인 네트워크 오류',
            completed_at=now()
      where id=$1`,
    [latestId],
  );

  const details = await getResultDetails(run.id);

  expect(details!.models[0]).toMatchObject({
    blindId: 'M01',
    responses: '0',
    totalItems: '3',
    succeededItems: '0',
    failedItems: '3',
    representativeFailure: {
      code: 'OPENAI_INCOMPLETE_RESPONSE',
      message: 'OpenAI 응답이 출력 한도 전에 완료되지 않았습니다.',
      count: '2',
      latestAt: expect.any(String),
    },
  });
});

test('serves the same detail contract and returns a stable not-found response', async () => {
  const response = await GET(
    new Request(`http://localhost/api/results/${runId}/details`),
    { params: Promise.resolve({ id: runId }) },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    run: { id: runId },
    eventCursor: expect.any(String),
  });

  const missing = await GET(
    new Request('http://localhost/api/results/11111111-1111-4111-8111-111111111111/details'),
    {
      params: Promise.resolve({
        id: '11111111-1111-4111-8111-111111111111',
      }),
    },
  );
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toEqual({ code: 'RESULT_NOT_FOUND' });
});

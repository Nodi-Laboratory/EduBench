import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { seedDatabase } from '../../scripts/seed';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { getDashboardRunOverview } from '@/server/dashboard/overview';
import { createRun } from '@/server/runs/service';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;

beforeAll(async () => {
  await migrate();
  await seedDatabase();
  datasetVersionId = await createRealPublishedDataset(2);
});

afterAll(async () => {
  await db.end();
});

test('dashboard result counts exclude ignored late responses while retaining labeled execution progress', async () => {
  const run = await createRun({
    title:`대시보드 eligible ${randomUUID()}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거로 답하라.',
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'candidate-model',
      protocol:'gemini',
      concurrency:2,
    }],
  });
  const items = await db.query<{ id:string }>(
    'select id from run_items where benchmark_run_id=$1 order by created_at,id',
    [run.id],
  );
  await db.query(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text,ignored_after_cancel
     ) values
       ($1,1,'candidate-model','평가 대상 응답','평가 대상 응답',false),
       ($2,1,'candidate-model','취소 후 늦은 응답','취소 후 늦은 응답',true)`,
    [items.rows[0]!.id, items.rows[1]!.id],
  );
  await db.query(
    `update run_items set state='SUCCEEDED',completed_at=now()
     where benchmark_run_id=$1`,
    [run.id],
  );
  await db.query(
    `update benchmark_runs
     set state='CANCELLED',completed_items=2,completed_at=now(),updated_at=now()
     where id=$1`,
    [run.id],
  );

  const overview = await getDashboardRunOverview(run.id);
  expect(overview.latest).toMatchObject({
    id:run.id,
    eligible_response_count:1,
    execution_completed_items:2,
  });
  expect(overview.models).toHaveLength(1);
  expect(overview.models[0]).toMatchObject({ total:'2', done:'1' });
  expect(overview.recent[0]).toMatchObject({
    id:run.id,
    eligible_response_count:1,
    execution_completed_items:2,
  });
});

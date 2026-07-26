import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import { createRealPublishedDataset } from './helpers/real-dataset';
import { beginScoringWhenExecutionFinished, claimRunItems, commandRun, createRun } from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import { MockProvider } from '@/server/providers/mock';
import { scoreRun } from '@/server/scoring/service';
import { getResultAnalytics } from '@/server/results/analytics';

let datasetVersionId: string;
beforeAll(async () => {
  await migrate();
  await seedDatabase();
  datasetVersionId = await createRealPublishedDataset(1);
});
afterAll(async () => { await db.end(); });

test('reads model, metric, purpose, prerequisite, and question analytics from a completed run', async () => {
  await db.query(
    `update question_revisions qr set quality_scores='{"benchmarkDesign":{"benchmarkType":"PREREQUISITE_RELATIONSHIP"}}'::jsonb
     from dataset_questions dq where dq.question_id=qr.question_id and dq.question_revision=qr.revision and dq.dataset_version_id=$1`,
    [datasetVersionId],
  );
  const run = await createRun({
    title:'분석 통합 테스트', datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001', priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.', questionLimit:1,
    models:[{ providerKey:'gemini', displayName:'Gemini', modelId:'gemini-test', protocol:'gemini' }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'analytics-worker', 1, 30_000);
  await executeRunItem(item!, 'analytics-worker', new MockProvider('gemini', 'gemini-test'));
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);
  await scoreRun(run.id);

  const analytics = await getResultAnalytics(run.id);
  expect(analytics.models[0]).toMatchObject({ displayName:'Gemini', responses:1, compositeScore:expect.any(Number) });
  expect(analytics.metricRows.some((row) => row.metricKey === 'accuracy')).toBe(true);
  expect(analytics.prerequisiteRows.length).toBeGreaterThan(0);
  expect(analytics.purposeRows).toHaveLength(1);
  expect(analytics.questionRows).toHaveLength(1);
});

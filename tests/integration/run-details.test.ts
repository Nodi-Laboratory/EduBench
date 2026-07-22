import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { GET } from '@/app/api/runs/[id]/details/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import { claimRunItems, commandRun, createRun } from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import { MockProvider } from '@/server/providers/mock';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;
beforeAll(async () => { await migrate(); await seedDatabase(); datasetVersionId = await createRealPublishedDataset(1); });
afterAll(async () => { await db.end(); });

test('returns the exact request, response, scores, failure fields, and score profile', async () => {
  const run = await createRun({
    title: `상세 조회 ${randomUUID().slice(0, 8)}`, datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-details', 1, 30_000);
  await executeRunItem(item!, 'worker-details', new MockProvider('gemini'));
  await db.query('update run_items set request_snapshot=null where id=$1', [item!.id]);

  const response = await GET(new Request(`http://localhost/api/runs/${run.id}/details`), { params: Promise.resolve({ id: run.id }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.profile).toMatchObject({ version: 'score-v1', metrics: expect.any(Array), rubricPrompt: expect.any(String) });
  expect(body.items[0]).toMatchObject({
    questionText: expect.any(String), request: { system: '교과서 근거에 따라 답하라.', prompt: expect.any(String), reconstructed: true },
    response: { text: expect.any(String), raw: expect.any(Object) }, scores: expect.any(Array),
    errorCode: null, errorMessage: null,
  });
});

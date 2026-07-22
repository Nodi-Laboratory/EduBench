import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import { beginScoringWhenExecutionFinished, claimRunItems, commandRun, createRun } from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import type { ModelProvider } from '@/server/providers/types';
import { MockProvider } from '@/server/providers/mock';
import { scoreRun } from '@/server/scoring/service';
import { GET as exportResult } from '@/app/api/results/[id]/export/route';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;
beforeAll(async () => { await migrate(); await seedDatabase(); datasetVersionId = await createRealPublishedDataset(1); });
afterAll(async () => { await db.end(); });

test('executes a leased item and preserves the normalized and raw provider response', async () => {
  const run = await createRun({
    title: `실행 저장 테스트 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'fake', displayName: '가상 모델', modelId: 'fake-v1', protocol: 'openai-compatible' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-test', 1, 30_000);
  const provider: ModelProvider = {
    key: 'fake', modelId: 'fake-v1',
    async generate() { return { text: '  정답입니다.  ', raw: { id: 'raw-1', choices: [1] }, inputTokens: 12, outputTokens: 4, finishReason: 'stop', requestId: 'req-1', modelId: 'fake-v1', modelSnapshot: 'fake-2026-07', latencyMs: 27 }; },
  };

  await executeRunItem(item!, 'worker-test', provider);
  const stored = await db.query<{ state: string; request_snapshot: { system: string; prompt: string; providerKey: string }; response_text: string; normalized_text: string; raw_response: { id: string }; input_tokens: number; latency_ms: number }>(
    `select ri.state,ri.request_snapshot, mr.response_text, mr.normalized_text, mr.raw_response, mr.input_tokens, mr.latency_ms
     from run_items ri join model_responses mr on mr.run_item_id = ri.id where ri.id = $1`, [item!.id],
  );
  expect(stored.rows[0]).toMatchObject({ state: 'SUCCEEDED', response_text: '  정답입니다.  ', normalized_text: '정답입니다.', raw_response: { id: 'raw-1' }, input_tokens: 12, latency_ms: 27 });
  expect(stored.rows[0]?.request_snapshot).toMatchObject({
    system: '교과서 근거에 따라 답하라.', providerKey: 'fake', prompt: expect.stringContaining('[질문]'),
  });
});

test('completes only after deterministic and blind judge metrics are persisted', async () => {
  const run = await createRun({
    title: `실제 채점 흐름 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-score-test', 1, 30_000);
  await executeRunItem(item!, 'worker-score-test', new MockProvider('gemini'));
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);
  await scoreRun(run.id);

  const stored = await db.query<{ state: string; score_count: string; judge_count: string }>(
    `select br.state, count(s.id)::text score_count,
       count(s.id) filter (where s.judge_provider is not null)::text judge_count
     from benchmark_runs br join run_items ri on ri.benchmark_run_id = br.id
     join model_responses mr on mr.run_item_id = ri.id join scores s on s.model_response_id = mr.id
     where br.id = $1 group by br.id`, [run.id],
  );
  expect(stored.rows[0]).toEqual({ state:'COMPLETED', score_count:'9', judge_count:'7' });
  const exported = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=json`),
    { params: Promise.resolve({ id: run.id }) },
  );
  expect(exported.status).toBe(200);
  const body = await exported.json();
  expect(body.run).toMatchObject({ state:'COMPLETED', dataset_content_hash: expect.any(String) });
  expect(body.items[0]).toMatchObject({ provider_request_id: expect.any(String), raw_response: expect.any(Object) });
  expect(Object.keys(body.items[0].scores)).toHaveLength(9);
  const pdf = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=pdf`),
    { params: Promise.resolve({ id: run.id }) },
  );
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 4))).toBe('%PDF');
});

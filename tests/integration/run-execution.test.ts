import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import { claimRunItems, commandRun, createRun } from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import type { ModelProvider } from '@/server/providers/types';

beforeAll(async () => { await migrate(); await seedDatabase(); });
afterAll(async () => { await db.end(); });

test('executes a leased item and preserves the normalized and raw provider response', async () => {
  const run = await createRun({
    title: `실행 저장 테스트 ${randomUUID().slice(0, 8)}`,
    datasetVersionId: '10000000-0000-0000-0000-000000000001',
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
  const stored = await db.query<{ state: string; response_text: string; normalized_text: string; raw_response: { id: string }; input_tokens: number; latency_ms: number }>(
    `select ri.state, mr.response_text, mr.normalized_text, mr.raw_response, mr.input_tokens, mr.latency_ms
     from run_items ri join model_responses mr on mr.run_item_id = ri.id where ri.id = $1`, [item!.id],
  );
  expect(stored.rows[0]).toMatchObject({ state: 'SUCCEEDED', response_text: '  정답입니다.  ', normalized_text: '정답입니다.', raw_response: { id: 'raw-1' }, input_tokens: 12, latency_ms: 27 });
});

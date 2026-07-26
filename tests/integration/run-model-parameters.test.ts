import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { executeRunItem } from '@/server/runs/executor';
import { claimRunItems, commandRun, createRun } from '@/server/runs/service';
import type { GenerationRequest, ModelProvider, NormalizedGeneration } from '@/server/providers/types';
import { seedDatabase } from '../../scripts/seed';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;

beforeAll(async () => {
  await migrate();
  await seedDatabase();
  datasetVersionId = await createRealPublishedDataset(1);
});

afterAll(async () => {
  await db.end();
});

function successfulGeneration(modelId: string): NormalizedGeneration {
  return {
    text: '정답',
    raw: { answer: '정답' },
    inputTokens: 10,
    outputTokens: 2,
    finishReason: 'stop',
    requestId: 'request-parameters',
    modelId,
    modelSnapshot: null,
    latencyMs: 5,
  };
}

async function leasedItem(parameters: Record<string, unknown>, providerKey = 'exaone') {
  const modelId = `${providerKey}-parameter-test`;
  const run = await createRun({
    title: `모델 파라미터 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.',
    questionLimit: 1,
    models: [{
      providerKey,
      displayName: providerKey,
      modelId,
      protocol: providerKey === 'gemini' ? 'gemini' : 'openai-compatible',
      parameters,
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, `worker-${run.id}`, 1, 30_000);
  return { run, item: item!, workerId: `worker-${run.id}`, modelId };
}

test('sends persisted run model parameters and stores the same effective provider request', async () => {
  const parameters = {
    maxOutputTokens: 16_384,
    temperature: 1,
    stopSequences: ['<END>'],
    thinkingLevel: 'HIGH',
    topP: 0.95,
    presencePenalty: 0.1,
    frequencyPenalty: -0.2,
    seed: 23,
    enableThinking: true,
  };
  const { item, workerId, modelId } = await leasedItem(parameters);
  let received: GenerationRequest | undefined;
  const provider: ModelProvider = {
    key: 'exaone',
    modelId,
    async generate(request) {
      received = request;
      return successfulGeneration(modelId);
    },
  };

  await executeRunItem(item, workerId, provider);

  const stored = await db.query<{ request_snapshot: Record<string, unknown> }>(
    'select request_snapshot from run_items where id=$1',
    [item.id],
  );
  expect(received).toMatchObject(parameters);
  expect(stored.rows[0]?.request_snapshot).toMatchObject({
    ...received,
    providerKey: 'exaone',
    modelId,
    persistedParameters: parameters,
  });
});

test('explicit omission flags remove deprecated Gemini temperature and topP from the effective request', async () => {
  const { item, workerId, modelId } = await leasedItem({
    maxOutputTokens: 8192,
    temperature: 0.8,
    topP: 0.9,
    omitTemperature: true,
    omitTopP: true,
  }, 'gemini');
  let received: GenerationRequest | undefined;
  const provider: ModelProvider = {
    key: 'gemini',
    modelId,
    async generate(request) {
      received = request;
      return successfulGeneration(modelId);
    },
  };

  await executeRunItem(item, workerId, provider);

  expect(received).toMatchObject({ maxOutputTokens: 8192 });
  expect(received).not.toHaveProperty('temperature');
  expect(received).not.toHaveProperty('topP');
  const stored = await db.query<{ request_snapshot: Record<string, unknown> }>(
    'select request_snapshot from run_items where id=$1',
    [item.id],
  );
  expect(stored.rows[0]?.request_snapshot).not.toHaveProperty('temperature');
  expect(stored.rows[0]?.request_snapshot).not.toHaveProperty('topP');
  expect(stored.rows[0]?.request_snapshot).toMatchObject({
    persistedParameters: {
      omitTemperature: true,
      omitTopP: true,
    },
  });
});

test('rejects forbidden persisted request overrides before calling the provider', async () => {
  const { item, workerId, modelId } = await leasedItem({
    system: '저장된 시스템 프롬프트를 탈취한다.',
  });
  let calls = 0;
  const provider: ModelProvider = {
    key: 'exaone',
    modelId,
    async generate() {
      calls += 1;
      return successfulGeneration(modelId);
    },
  };

  await expect(executeRunItem(item, workerId, provider))
    .rejects.toMatchObject({ code: 'RUN_MODEL_PARAMETERS_INVALID' });
  expect(calls).toBe(0);
});

test('keeps the persisted run-model execution specification immutable', async () => {
  const { run } = await leasedItem({
    maxOutputTokens:8192,
    temperature:0.7,
  });
  await expect(db.query(
    `update run_models
        set model_id='mutated-model',
            parameters='{"maxOutputTokens":1}'::jsonb
      where benchmark_run_id=$1`,
    [run.id],
  )).rejects.toMatchObject({ code:'55000' });
});

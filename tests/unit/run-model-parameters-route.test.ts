import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/server/runs/service', () => ({
  createRun: vi.fn(async () => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publicId: 'RUN-PARAMETERS',
    state: 'DRAFT',
    totalItems: 1,
  })),
}));

import { POST } from '@/app/api/runs/route';
import { createRun } from '@/server/runs/service';

const validRun = {
  title: '실행 파라미터 검증',
  datasetVersionId: '11111111-1111-4111-8111-111111111111',
  scoreProfileId: '22222222-2222-4222-8222-222222222222',
  priceProfileVersion: 'price-v1',
  systemPrompt: '교과서 근거만 사용한다.',
  questionLimit: 1,
  models: [{
    providerKey: 'gemini',
    displayName: 'Gemini',
    modelId: 'gemini-test',
    protocol: 'gemini',
  }],
};

beforeEach(() => {
  vi.mocked(createRun).mockClear();
});

test('accepts and forwards only bounded persisted generation parameters', async () => {
  const parameters = {
    maxOutputTokens: 16_384,
    temperature: 0.7,
    stopSequences: ['<END>'],
    thinkingLevel: 'HIGH',
    topP: 0.95,
    presencePenalty: 0.2,
    frequencyPenalty: -0.1,
    seed: 42,
    enableThinking: true,
    omitTemperature: false,
    omitTopP: false,
  };
  const response = await POST(new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validRun,
      models: [{ ...validRun.models[0], parameters }],
    }),
  }));

  expect(response.status).toBe(201);
  expect(vi.mocked(createRun).mock.calls[0]?.[0].models[0]?.parameters).toEqual(parameters);
});

test('accepts and forwards all three benchmark retrieval conditions', async () => {
  const response = await POST(new Request('http://localhost/api/runs', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      ...validRun,
      retrievalModes:['NONE', 'VECTOR', 'PIKE'],
    }),
  }));

  expect(response.status).toBe(201);
  expect(vi.mocked(createRun).mock.calls[0]?.[0].retrievalModes).toEqual([
    'NONE',
    'VECTOR',
    'PIKE',
  ]);
});

test.each([
  ['an empty retrieval condition list', []],
  ['a duplicate retrieval condition', ['NONE', 'NONE']],
  ['an unknown retrieval condition', ['NONE', 'GRAPH']],
])('rejects %s before creating a run', async (_label, retrievalModes) => {
  const response = await POST(new Request('http://localhost/api/runs', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...validRun, retrievalModes }),
  }));

  expect(response.status).toBe(400);
  expect(createRun).not.toHaveBeenCalled();
});

test.each([
  ['a forbidden prompt override', { prompt: '요청을 바꾼다.' }],
  ['an excessive output limit', { maxOutputTokens: 131_073 }],
  ['too many stop sequences', { stopSequences: Array.from({ length: 17 }, (_, index) => `stop-${index}`) }],
])('rejects %s in model parameters before creating a run', async (_label, parameters) => {
  const response = await POST(new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validRun,
      models: [{ ...validRun.models[0], parameters }],
    }),
  }));

  expect(response.status).toBe(400);
  expect(createRun).not.toHaveBeenCalled();
});

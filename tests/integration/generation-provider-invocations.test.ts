import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  beginGenerationProviderInvocation,
  completeGenerationProviderInvocation,
  failGenerationProviderInvocation,
} from '@/server/questions/provider-invocations';
import { ProviderError } from '@/server/providers/types';
import { GET as getGenerationActivity } from '@/app/api/generation/[id]/activity/route';
import { GET as getGenerationItemAudit } from '@/app/api/generation/[id]/items/[itemId]/audit/route';

const batchId = randomUUID();
const itemId = randomUUID();

beforeAll(async () => {
  await migrate();
  await db.query(
    `insert into generation_batches(
       id,state,requested_count,conditions,source_scope,generation_model,prompt_version
     ) values($1,'RUNNING',1,'{}'::jsonb,'{"sourceFileIds":[]}'::jsonb,'gemini-test','test')`,
    [batchId],
  );
  await db.query(
    `insert into generation_items(
       id,generation_batch_id,ordinal,state,attempts
     ) values($1,$2,1,'RUNNING',1)`,
    [itemId, batchId],
  );
});

afterAll(async () => {
  await db.query('delete from generation_retrievals where generation_batch_id=$1', [batchId]);
  await db.query('delete from generation_batches where id=$1', [batchId]);
  await db.end();
});

test('preserves the complete request and normalized/raw provider response for a generation stage', async () => {
  const invocationId = await beginGenerationProviderInvocation({
    batchId,
    itemId,
    itemAttempt: 1,
    stage: 'DIRECTION',
    provider: 'gemini',
    modelId: 'gemini-test',
    request: {
      system: 'REQUEST_SYSTEM_SECRET',
      prompt: 'REQUEST_PROMPT_SECRET',
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  });
  await completeGenerationProviderInvocation(invocationId, {
    text: '{"searchQuery":"NORMALIZED_RESPONSE_SECRET"}',
    raw: {
      candidates: [{ finishReason: 'STOP' }],
      providerPayload: 'RAW_PROVIDER_SECRET',
    },
    inputTokens: 120,
    outputTokens: 30,
    finishReason: 'STOP',
    requestId: 'request-direction-1',
    modelId: 'gemini-test',
    modelSnapshot: 'gemini-test-20260727',
    latencyMs: 456,
  });

  const stored = await db.query(
    `select state,request_snapshot,response_snapshot,raw_response,request_id,
            model_snapshot,finish_reason,input_tokens,output_tokens,latency_ms
       from generation_provider_invocations
      where id=$1`,
    [invocationId],
  );
  expect(stored.rows[0]).toMatchObject({
    state: 'COMPLETED',
    request_snapshot: {
      system: 'REQUEST_SYSTEM_SECRET',
      prompt: 'REQUEST_PROMPT_SECRET',
      maxOutputTokens: 2048,
    },
    response_snapshot: { text: '{"searchQuery":"NORMALIZED_RESPONSE_SECRET"}' },
    raw_response: {
      candidates: [{ finishReason: 'STOP' }],
      providerPayload: 'RAW_PROVIDER_SECRET',
    },
    request_id: 'request-direction-1',
    model_snapshot: 'gemini-test-20260727',
    finish_reason: 'STOP',
    input_tokens: 120,
    output_tokens: 30,
    latency_ms: 456,
  });
  await expect(db.query(
    `update generation_provider_invocations
        set response_snapshot='{}'::jsonb
      where id=$1`,
    [invocationId],
  )).rejects.toMatchObject({ code: '55000' });

  await db.query(
    `insert into generation_retrievals(
       generation_batch_id,generation_item_id,attempt,query_text,embedding_model,
       candidate_scope,selected_chunks
     ) values($1,$2,1,'검색 질의 요약','embedding-test',
       '{"scope":"CANDIDATE_SCOPE_SECRET"}'::jsonb,
       '[{"chunkId":"chunk-1","content":"SELECTED_CHUNK_SECRET"}]'::jsonb)`,
    [batchId, itemId],
  );

  const activityResponse = await getGenerationActivity(
    new Request(`http://localhost/api/generation/${batchId}/activity`),
    { params: Promise.resolve({ id: batchId }) },
  );
  expect(activityResponse.status).toBe(200);
  const activity = await activityResponse.json();
  expect(activity.items[0]).toMatchObject({
    latestRetrieval: {
      attempt: 1,
      queryText: '검색 질의 요약',
      selectedChunkCount: 1,
    },
    providerInvocationSummary: {
      total: 1,
      requested: 0,
      completed: 1,
      failed: 0,
      abandoned: 0,
    },
  });
  expect(activity.items[0]).not.toHaveProperty('providerInvocations');
  expect(activity.items[0].latestRetrieval).not.toHaveProperty('candidateScope');
  expect(activity.items[0].latestRetrieval).not.toHaveProperty('selectedChunks');
  const activityJson = JSON.stringify(activity);
  for (const secret of [
    'REQUEST_SYSTEM_SECRET',
    'REQUEST_PROMPT_SECRET',
    'NORMALIZED_RESPONSE_SECRET',
    'RAW_PROVIDER_SECRET',
    'CANDIDATE_SCOPE_SECRET',
    'SELECTED_CHUNK_SECRET',
  ]) {
    expect(activityJson).not.toContain(secret);
  }

  const auditResponse = await getGenerationItemAudit(
    new Request(`http://localhost/api/generation/${batchId}/items/${itemId}/audit?limit=1&offset=0`),
    { params: Promise.resolve({ id: batchId, itemId }) },
  );
  expect(auditResponse.status).toBe(200);
  const audit = await auditResponse.json();
  expect(audit).toMatchObject({
    batchId,
    itemId,
    latestRetrieval: {
      queryText: '검색 질의 요약',
      candidateScope: { scope: 'CANDIDATE_SCOPE_SECRET' },
      selectedChunks: [{ chunkId: 'chunk-1', content: 'SELECTED_CHUNK_SECRET' }],
    },
    providerInvocations: [{
      id: invocationId,
      stage: 'DIRECTION',
      state: 'COMPLETED',
      requestSnapshot: {
        system: 'REQUEST_SYSTEM_SECRET',
        prompt: 'REQUEST_PROMPT_SECRET',
      },
      responseSnapshot: { text: '{"searchQuery":"NORMALIZED_RESPONSE_SECRET"}' },
      rawResponse: {
        candidates: [{ finishReason: 'STOP' }],
        providerPayload: 'RAW_PROVIDER_SECRET',
      },
    }],
    pagination: {
      limit: 1,
      offset: 0,
      total: 1,
      nextOffset: null,
    },
  });
});

test('preserves provider failure classification even when no response is returned', async () => {
  const invocationId = await beginGenerationProviderInvocation({
    batchId,
    itemId,
    itemAttempt: 1,
    stage: 'QUESTION',
    provider: 'gemini',
    modelId: 'gemini-test',
    request: {
      system: '교과서 근거만 사용하라.',
      prompt: '질문을 생성하라.',
      maxOutputTokens: 8192,
    },
  });
  await failGenerationProviderInvocation(invocationId, new ProviderError({
    kind: 'TIMEOUT',
    message: 'provider timeout',
    retryable: true,
    status: 504,
    requestId: 'request-question-1',
    retryAfterMs: 1_500,
  }));

  const stored = await db.query(
    `select state,error_snapshot,completed_at
       from generation_provider_invocations
      where id=$1`,
    [invocationId],
  );
  expect(stored.rows[0]).toMatchObject({
    state: 'FAILED',
    error_snapshot: {
      name: 'ProviderError',
      message: 'provider timeout',
      kind: 'TIMEOUT',
      retryable: true,
      status: 504,
      requestId: 'request-question-1',
      retryAfterMs: 1_500,
    },
    completed_at: expect.any(Date),
  });

  const activityResponse = await getGenerationActivity(
    new Request(`http://localhost/api/generation/${batchId}/activity?history=0`),
    { params: Promise.resolve({ id: batchId }) },
  );
  const activity = await activityResponse.json();
  expect(activity.items[0].providerInvocationSummary).toEqual({
    total: 2,
    requested: 0,
    completed: 1,
    failed: 1,
    abandoned: 0,
  });

  const firstPageResponse = await getGenerationItemAudit(
    new Request(`http://localhost/api/generation/${batchId}/items/${itemId}/audit?limit=1&offset=0`),
    { params: Promise.resolve({ id: batchId, itemId }) },
  );
  expect(firstPageResponse.status).toBe(200);
  const firstPage = await firstPageResponse.json();
  expect(firstPage.providerInvocations).toHaveLength(1);
  expect(firstPage.providerInvocations[0]).toMatchObject({ stage: 'DIRECTION' });
  expect(firstPage.pagination).toEqual({
    limit: 1,
    offset: 0,
    total: 2,
    nextOffset: 1,
  });

  const secondPageResponse = await getGenerationItemAudit(
    new Request(`http://localhost/api/generation/${batchId}/items/${itemId}/audit?limit=1&offset=1`),
    { params: Promise.resolve({ id: batchId, itemId }) },
  );
  expect(secondPageResponse.status).toBe(200);
  const secondPage = await secondPageResponse.json();
  expect(secondPage.providerInvocations).toHaveLength(1);
  expect(secondPage.providerInvocations[0]).toMatchObject({
    id: invocationId,
    stage: 'QUESTION',
    state: 'FAILED',
    requestSnapshot: {
      system: '교과서 근거만 사용하라.',
      prompt: '질문을 생성하라.',
    },
    responseSnapshot: null,
    rawResponse: null,
    error: {
      kind: 'TIMEOUT',
      message: 'provider timeout',
      requestId: 'request-question-1',
    },
  });
  expect(secondPage.pagination).toEqual({
    limit: 1,
    offset: 1,
    total: 2,
    nextOffset: null,
  });

  const wrongBatchResponse = await getGenerationItemAudit(
    new Request(`http://localhost/api/generation/${randomUUID()}/items/${itemId}/audit`),
    { params: Promise.resolve({ id: randomUUID(), itemId }) },
  );
  expect(wrongBatchResponse.status).toBe(404);
});

test('stores the validation-aware question repair as a distinct auditable stage', async () => {
  const invocationId = await beginGenerationProviderInvocation({
    batchId,
    itemId,
    itemAttempt: 1,
    stage: 'QUESTION_REPAIR',
    provider: 'gemini',
    modelId: 'gemini-test',
    request: {
      system: 'STRUCTURE_REPAIR_SYSTEM',
      prompt: 'STRUCTURE_REPAIR_VALIDATION_AND_RESPONSE',
      maxOutputTokens: 8192,
      temperature: 0,
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    },
  });
  await completeGenerationProviderInvocation(invocationId, {
    text: '{"repaired":true}',
    raw: { repair: true },
    inputTokens: 300,
    outputTokens: 40,
    finishReason: 'STOP',
    requestId: 'request-repair-1',
    modelId: 'gemini-test',
    modelSnapshot: 'gemini-test-20260727',
    latencyMs: 200,
  });

  const auditResponse = await getGenerationItemAudit(
    new Request(`http://localhost/api/generation/${batchId}/items/${itemId}/audit?limit=100`),
    { params: Promise.resolve({ id: batchId, itemId }) },
  );
  expect(auditResponse.status).toBe(200);
  const audit = await auditResponse.json();
  expect(audit.providerInvocations).toContainEqual(expect.objectContaining({
    id: invocationId,
    stage: 'QUESTION_REPAIR',
    state: 'COMPLETED',
    requestSnapshot: expect.objectContaining({
      system: 'STRUCTURE_REPAIR_SYSTEM',
      prompt: 'STRUCTURE_REPAIR_VALIDATION_AND_RESPONSE',
      temperature: 0,
      responseMimeType: 'application/json',
    }),
    responseSnapshot: { text: '{"repaired":true}', modelId: 'gemini-test', modelSnapshot: 'gemini-test-20260727' },
  }));
});

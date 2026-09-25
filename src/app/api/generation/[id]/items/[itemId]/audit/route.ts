import { NextResponse } from 'next/server';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function isoTimestamp(value: Date | string | null) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const limit = boundedInteger(searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = boundedInteger(
    searchParams.get('offset'),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const snapshot = await withReadOnlyRepeatableReadTransaction(async (client) => {
    const item = await client.query<{ id: string }>(
      `select id
         from generation_items
        where generation_batch_id=$1
          and id=$2`,
      [id, itemId],
    );
    if (!item.rows[0]) return null;

    const retrieval = await client.query<{
      id: string;
      attempt: number;
      query_text: string;
      candidate_scope: Record<string, unknown>;
      selected_chunks: unknown[];
      created_at: Date | string;
    }>(
      `select id,attempt,query_text,candidate_scope,selected_chunks,created_at
         from generation_retrievals
        where generation_batch_id=$1
          and generation_item_id=$2
        order by attempt desc,created_at desc
        limit 1`,
      [id, itemId],
    );
    const total = await client.query<{ total: number }>(
      `select count(*)::int as total
         from generation_provider_invocations
        where generation_batch_id=$1
          and generation_item_id=$2`,
      [id, itemId],
    );
    const invocations = await client.query<{
      id: string;
      item_attempt: number;
      stage: 'DIRECTION' | 'QUESTION' | 'QUESTION_REPAIR';
      state: 'REQUESTED' | 'COMPLETED' | 'FAILED' | 'ABANDONED';
      provider: string;
      model_id: string;
      request_snapshot: Record<string, unknown>;
      response_snapshot: Record<string, unknown> | null;
      raw_response: unknown;
      request_id: string | null;
      model_snapshot: string | null;
      finish_reason: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      latency_ms: number | null;
      error_snapshot: Record<string, unknown> | null;
      started_at: Date | string;
      completed_at: Date | string | null;
    }>(
      `select id,item_attempt,stage,state,provider,model_id,
              request_snapshot,response_snapshot,raw_response,request_id,
              model_snapshot,finish_reason,input_tokens,output_tokens,latency_ms,
              error_snapshot,started_at,completed_at
         from generation_provider_invocations
        where generation_batch_id=$1
          and generation_item_id=$2
        order by item_attempt,started_at,stage,id
        limit $3
       offset $4`,
      [id, itemId, limit, offset],
    );

    const invocationTotal = total.rows[0]?.total ?? 0;
    const nextOffset = offset + invocations.rows.length < invocationTotal
      ? offset + invocations.rows.length
      : null;
    const latestRetrieval = retrieval.rows[0];
    return {
      batchId: id,
      itemId,
      latestRetrieval: latestRetrieval ? {
        id: latestRetrieval.id,
        attempt: latestRetrieval.attempt,
        queryText: latestRetrieval.query_text,
        candidateScope: latestRetrieval.candidate_scope,
        selectedChunks: latestRetrieval.selected_chunks,
        createdAt: isoTimestamp(latestRetrieval.created_at),
      } : null,
      providerInvocations: invocations.rows.map((invocation) => ({
        id: invocation.id,
        itemAttempt: invocation.item_attempt,
        stage: invocation.stage,
        state: invocation.state,
        provider: invocation.provider,
        modelId: invocation.model_id,
        requestSnapshot: invocation.request_snapshot,
        responseSnapshot: invocation.response_snapshot,
        rawResponse: invocation.raw_response,
        requestId: invocation.request_id,
        modelSnapshot: invocation.model_snapshot,
        finishReason: invocation.finish_reason,
        inputTokens: invocation.input_tokens,
        outputTokens: invocation.output_tokens,
        latencyMs: invocation.latency_ms,
        error: invocation.error_snapshot,
        startedAt: isoTimestamp(invocation.started_at),
        completedAt: isoTimestamp(invocation.completed_at),
      })),
      pagination: {
        limit,
        offset,
        total: invocationTotal,
        nextOffset,
      },
    };
  });

  return snapshot
    ? NextResponse.json(snapshot)
    : NextResponse.json({ code: 'GENERATION_ITEM_NOT_FOUND' }, { status: 404 });
}

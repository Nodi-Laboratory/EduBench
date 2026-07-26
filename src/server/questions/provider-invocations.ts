import type { PoolClient } from 'pg';
import { db } from '@/server/db/pool';
import {
  ProviderError,
  type GenerationRequest,
  type NormalizedGeneration,
} from '@/server/providers/types';

export type GenerationProviderStage = 'DIRECTION' | 'QUESTION';

export async function abandonSupersededGenerationProviderInvocations(
  client: PoolClient,
  input: {
    batchId: string;
    itemIds: string[];
  },
): Promise<number> {
  if (!input.itemIds.length) return 0;
  const result = await client.query(
    `update generation_provider_invocations invocation
        set state='ABANDONED',
            error_snapshot=jsonb_build_object(
              'name','GenerationInvocationAbandoned',
              'code','GENERATION_INVOCATION_ABANDONED_ON_ITEM_RETRY',
              'message','문항 재시작으로 이전 미완료 모델 호출을 종결했습니다.',
              'retryable',true
            ),
            completed_at=now()
       from generation_items item
      where item.id=invocation.generation_item_id
        and item.generation_batch_id=$1
        and item.id=any($2::uuid[])
        and invocation.generation_batch_id=$1
        and invocation.state='REQUESTED'
        and invocation.item_attempt<item.attempts`,
    [input.batchId, input.itemIds],
  );
  return result.rowCount ?? 0;
}

export async function beginGenerationProviderInvocation(input: {
  batchId: string;
  itemId: string;
  itemAttempt: number;
  stage: GenerationProviderStage;
  provider: string;
  modelId: string;
  request: GenerationRequest;
}): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into generation_provider_invocations(
       generation_batch_id,generation_item_id,item_attempt,stage,
       provider,model_id,request_snapshot
     ) values($1,$2,$3,$4,$5,$6,$7::jsonb)
     returning id`,
    [
      input.batchId,
      input.itemId,
      input.itemAttempt,
      input.stage,
      input.provider,
      input.modelId,
      JSON.stringify(input.request),
    ],
  );
  return result.rows[0]!.id;
}

export async function completeGenerationProviderInvocation(
  invocationId: string,
  response: NormalizedGeneration,
): Promise<void> {
  const result = await db.query(
    `update generation_provider_invocations
        set state='COMPLETED',
            response_snapshot=$2::jsonb,
            raw_response=$3::jsonb,
            request_id=$4,
            model_snapshot=$5,
            finish_reason=$6,
            input_tokens=$7,
            output_tokens=$8,
            latency_ms=$9,
            completed_at=now()
      where id=$1 and state='REQUESTED'`,
    [
      invocationId,
      JSON.stringify({
        text: response.text,
        modelId: response.modelId,
        modelSnapshot: response.modelSnapshot,
      }),
      JSON.stringify(response.raw),
      response.requestId,
      response.modelSnapshot,
      response.finishReason,
      response.inputTokens,
      response.outputTokens,
      response.latencyMs,
    ],
  );
  if (!result.rowCount) {
    throw new Error(
      'GENERATION_INVOCATION_NOT_OPEN: 생성 모델 호출 기록을 완료할 수 없습니다.',
    );
  }
}

function errorSnapshot(error: unknown) {
  const base = {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
  if (!(error instanceof ProviderError)) return base;
  return {
    ...base,
    kind: error.kind,
    retryable: error.retryable,
    status: error.status,
    requestId: error.requestId,
    retryAfterMs: error.retryAfterMs,
  };
}

export async function failGenerationProviderInvocation(
  invocationId: string,
  error: unknown,
): Promise<void> {
  const result = await db.query(
    `update generation_provider_invocations
        set state='FAILED',
            error_snapshot=$2::jsonb,
            completed_at=now()
      where id=$1 and state='REQUESTED'`,
    [invocationId, JSON.stringify(errorSnapshot(error))],
  );
  if (!result.rowCount) {
    throw new Error(
      'GENERATION_INVOCATION_NOT_OPEN: 생성 모델 호출 실패 기록을 저장할 수 없습니다.',
    );
  }
}

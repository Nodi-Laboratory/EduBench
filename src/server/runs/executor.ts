import { DomainError } from '@/domain/errors';
import {
  generationParametersSchema,
  type GenerationParameters,
  type GenerationRequest,
  type ModelProvider,
  type ProviderError,
} from '@/server/providers/types';
import { benchmarkGenerationParameters } from '@/domain/research-config';
import { resolveBenchmarkExecutionPin } from '@/server/settings/execution-pins';
import { withProviderRetry } from '@/server/providers/retry';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { interruptRunItem, renewRunItemLease, type RunItemRecord } from './service';

type ExecutionContext = {
  id: string; attempts: number; benchmark_run_id: string; state: string; lease_owner: string | null;
  system_prompt: string; run_state: string; provider_key: string; model_id: string;
  parameters: unknown;
  question_text: string; answer_options: unknown; evidence_mode: string;
};

function normalizeResponse(text: string): string {
  return text.normalize('NFC').replace(/\r\n/g, '\n').trim();
}

function parseRunModelParameters(parameters: unknown): GenerationParameters {
  const parsed = generationParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    throw new DomainError(
      'RUN_MODEL_PARAMETERS_INVALID',
      '저장된 실행 모델 파라미터가 허용 범위 또는 형식과 일치하지 않습니다.',
    );
  }
  return parsed.data;
}

function effectiveGenerationParameters(parameters: GenerationParameters): Omit<GenerationRequest, 'system' | 'prompt'> {
  return {
    maxOutputTokens: parameters.maxOutputTokens ?? 2048,
    ...(!parameters.omitTemperature ? { temperature: parameters.temperature ?? 0 } : {}),
    ...(parameters.stopSequences !== undefined ? { stopSequences: [...parameters.stopSequences] } : {}),
    ...(parameters.thinkingLevel !== undefined ? { thinkingLevel: parameters.thinkingLevel } : {}),
    ...(!parameters.omitTopP && parameters.topP !== undefined ? { topP: parameters.topP } : {}),
    ...(parameters.presencePenalty !== undefined ? { presencePenalty: parameters.presencePenalty } : {}),
    ...(parameters.frequencyPenalty !== undefined ? { frequencyPenalty: parameters.frequencyPenalty } : {}),
    ...(parameters.seed !== undefined ? { seed: parameters.seed } : {}),
    ...(parameters.enableThinking !== undefined ? { enableThinking: parameters.enableThinking } : {}),
  };
}

async function loadContext(itemId: string): Promise<{ context: ExecutionContext; evidence: string[] }> {
  const item = await db.query<ExecutionContext>(
    `select ri.id, ri.attempts, ri.benchmark_run_id, ri.state, ri.lease_owner,
       br.system_prompt, br.state as run_state, rm.provider_key, rm.model_id, rm.parameters,
       qr.question_text, qr.answer_options, q.evidence_mode
     from run_items ri join benchmark_runs br on br.id = ri.benchmark_run_id
     join run_models rm on rm.id = ri.run_model_id
     join questions q on q.id = ri.question_id
     join question_revisions qr on qr.question_id = ri.question_id and qr.revision = ri.question_revision
     where ri.id = $1`, [itemId],
  );
  if (!item.rows[0]) throw new DomainError('RUN_ITEM_NOT_FOUND', '실행 항목을 찾을 수 없습니다.');
  const evidence = await db.query<{ content: string; quote_text: string | null; page_start: number | null }>(
    `select sc.content, qe.quote_text, sc.page_start from question_evidence qe
     join source_chunks sc on sc.id = qe.source_chunk_id
     where qe.question_id = (select question_id from run_items where id = $1)
       and qe.question_revision = (select question_revision from run_items where id = $1)
     order by qe.ordinal`, [itemId],
  );
  return {
    context: item.rows[0],
    evidence: evidence.rows.map((row, index) => `[근거 ${index + 1}${row.page_start ? ` · p.${row.page_start}` : ''}]\n${row.quote_text ?? row.content}`),
  };
}

export async function executeRunItem(
  item: RunItemRecord,
  workerId: string,
  provider: ModelProvider,
): Promise<void> {
  const { context, evidence } = await loadContext(item.id);
  if (context.state !== 'LEASED' || context.lease_owner !== workerId) {
    throw new DomainError('RUN_ITEM_LEASE_MISMATCH', '해당 워커가 임대한 실행 항목이 아닙니다.');
  }
  if (provider.key !== context.provider_key || provider.modelId !== context.model_id) {
    throw new DomainError(
      'RUN_MODEL_MISMATCH',
      `실행 항목에 고정된 ${context.provider_key} / ${context.model_id} 모델과 전달된 공급자가 일치하지 않습니다.`,
    );
  }
  const options = Array.isArray(context.answer_options) && context.answer_options.length
    ? `\n\n선택지:\n${context.answer_options.map((option, index) => `${index + 1}. ${String(option)}`).join('\n')}` : '';
  const evidenceBlock = evidence.length
    ? `다음 근거만 사용하십시오.\n\n${evidence.join('\n\n')}`
    : context.evidence_mode === 'GROUNDED' ? '연결된 교과서 근거가 없습니다. 근거 부족을 명시하십시오.' : '외부 검색 없이 답하십시오.';
  const retryHistory: Array<Record<string, unknown>> = [];
  const persistedParameters = parseRunModelParameters(context.parameters);
  const benchmarkPin = await resolveBenchmarkExecutionPin(
    context.benchmark_run_id,
  );
  const configuredModel = benchmarkPin.definition.settings.models.find(
    (model) => model.providerKey === context.provider_key,
  );
  const mockProviders =
    process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  if (!mockProviders) {
    const expectedParameters = generationParametersSchema.parse(
      configuredModel
        ? benchmarkGenerationParameters(configuredModel)
        : {},
    );
    if (
      !configuredModel
      || !configuredModel.enabled
      || configuredModel.modelId !== context.model_id
      || JSON.stringify(persistedParameters)
           !== JSON.stringify(expectedParameters)
    ) {
      throw new DomainError(
        'RUN_MODEL_PROFILE_MISMATCH',
        '실행 모델 또는 생성 파라미터가 고정된 벤치마크 모델 프로필과 일치하지 않습니다.',
      );
    }
  }
  const requestTimeoutMs = configuredModel?.requestTimeoutMs
    ?? Number(process.env.PROVIDER_TIMEOUT_MS ?? 90_000);
  const request: GenerationRequest = {
    system: context.system_prompt,
    prompt: `${evidenceBlock}\n\n[질문]\n${context.question_text}${options}`,
    ...effectiveGenerationParameters(persistedParameters),
  };
  await db.query(
    `update run_items set request_snapshot=$3::jsonb
     where id=$1 and state='LEASED' and lease_owner=$2`,
    [item.id, workerId, JSON.stringify({
      ...request, providerKey: context.provider_key, modelId: context.model_id,
      persistedParameters,
      benchmarkModelsProfileId:benchmarkPin.profileId,
      benchmarkModelsProfileHash:benchmarkPin.contentHash,
      requestTimeoutMs,
      attempt: context.attempts, evidence, question: context.question_text, options: context.answer_options,
    })],
  );
  const leaseMs = 150_000; const leaseAbort = new AbortController();
  const controlAbort = new AbortController();
  const signal = AbortSignal.any([
    leaseAbort.signal,
    controlAbort.signal,
    AbortSignal.timeout(requestTimeoutMs),
  ]);
  const heartbeat = setInterval(() => { renewRunItemLease(item.id, workerId, leaseMs).then((renewed) => { if (!renewed) leaseAbort.abort(new Error('RUN_ITEM_LEASE_LOST')); }).catch(() => leaseAbort.abort(new Error('RUN_ITEM_LEASE_RENEWAL_FAILED'))); }, 30_000);
  const controlPoll = setInterval(() => {
    db.query<{ state: string }>('select state from benchmark_runs where id=$1', [context.benchmark_run_id])
      .then((result) => { if (result.rows[0]?.state === 'STOPPING') controlAbort.abort(new Error('RUN_STOP_REQUESTED')); })
      .catch(() => undefined);
  }, 500);
  let generated;
  try {
    generated = await withProviderRetry(() => provider.generate(request, signal), {
      maxAttempts: 3,
      baseDelayMs: provider.key === 'exaone'
        ? Number(process.env.EXAONE_RETRY_BASE_DELAY_MS ?? 15_000)
        : 500,
      onRetry: ({ attempt, delayMs, error }) => retryHistory.push({ attempt, delayMs, kind: error.kind, status: error.status, requestId: error.requestId }),
    });
  } catch (error) {
    const state = await db.query<{ state: string }>('select state from benchmark_runs where id=$1', [context.benchmark_run_id]);
    if (state.rows[0]?.state === 'STOPPING') {
      await interruptRunItem(item.id, workerId);
      return;
    }
    throw error;
  } finally { clearInterval(heartbeat); clearInterval(controlPoll); }

  await withTransaction(async (client) => {
    const locked = await client.query<{ benchmark_run_id: string; attempts: number; state: string; lease_owner: string | null; run_state: string }>(
      `select ri.benchmark_run_id, ri.attempts, ri.state, ri.lease_owner, br.state as run_state
       from run_items ri join benchmark_runs br on br.id = ri.benchmark_run_id
       where ri.id = $1 for update of ri`, [item.id],
    );
    const current = locked.rows[0];
    if (!current || current.state !== 'LEASED' || current.lease_owner !== workerId) {
      throw new DomainError('RUN_ITEM_LEASE_MISMATCH', '응답 저장 전에 실행 임대가 만료되었거나 변경되었습니다.');
    }
    if (current.run_state === 'STOPPING') {
      await client.query(
        `update run_items set state='PENDING',attempts=greatest(attempts-1,0),available_at=now(),
           lease_owner=null,lease_expires_at=null,error_code=null,error_message=null,completed_at=null where id=$1`,
        [item.id],
      );
      await client.query(
        `insert into job_events(aggregate_type,aggregate_id,event_type,payload)
         values('benchmark_run',$1,'RUN_ITEM_INTERRUPTED',$2::jsonb)`,
        [current.benchmark_run_id, JSON.stringify({ itemId: item.id, providerKey: context.provider_key })],
      );
      return;
    }
    await client.query(
      `insert into model_responses(
         run_item_id, attempt, provider_request_id, model_id, model_snapshot, raw_response,
         response_text, normalized_text, finish_reason, input_tokens, output_tokens,
         latency_ms, ignored_after_cancel, retry_history
       ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [item.id, current.attempts, generated.requestId, generated.modelId, generated.modelSnapshot,
        JSON.stringify(generated.raw), generated.text, normalizeResponse(generated.text), generated.finishReason,
        generated.inputTokens, generated.outputTokens, generated.latencyMs,
        ['CANCELLING','CANCELLED'].includes(current.run_state), JSON.stringify(retryHistory)],
    );
    await client.query(
      `update run_items set state = 'SUCCEEDED', lease_owner = null, lease_expires_at = null,
         completed_at = now() where id = $1`, [item.id],
    );
    const counters = await client.query<{ completed_items: number; failed_items: number; total_items: number }>(
      `update benchmark_runs set completed_items = completed_items + 1, updated_at = now()
       where id = $1 returning completed_items, failed_items, total_items`, [current.benchmark_run_id],
    );
    await client.query(
      `insert into job_events(aggregate_type, aggregate_id, event_type, payload)
       values ('benchmark_run', $1, 'RUN_ITEM_COMPLETED', $2::jsonb)`,
      [current.benchmark_run_id, JSON.stringify({
        itemId: item.id, providerKey: context.provider_key, latencyMs: generated.latencyMs,
        completedItems: counters.rows[0]?.completed_items,
        failedItems: counters.rows[0]?.failed_items,
        totalItems: counters.rows[0]?.total_items,
      })],
    );
  });
}

export function providerErrorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof DomainError) return { code:error.code, message:error.message };
  const typed = error as ProviderError;
  return { code: typed?.kind ?? 'EXECUTION_FAILED', message: error instanceof Error ? error.message : '알 수 없는 실행 오류' };
}

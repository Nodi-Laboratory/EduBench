import type { PoolClient } from 'pg';
import { prerequisiteScoreMetrics } from '@/domain/prerequisite-benchmark';
import { isVerifiedScoringEngineSnapshot } from '@/domain/scoring-engine';
import { requiredMetricsForQuestion } from '@/domain/scoring';
import {
  readActivityEventCursor,
  readActivityEventHistory,
} from '@/server/activity/event-stream';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

type JudgeInvocationDatabaseRow = {
  id:string;
  model_response_id:string;
  parent_invocation_id:string | null;
  invocation_kind:string;
  attempt:number;
  logical_key:string;
  idempotency_key:string;
  state:string;
  requested_metric_keys:string[];
  resolved_metric_keys:string[];
  missing_metric_keys:string[];
  request_snapshot:unknown;
  request_hash:string;
  provider_key:string;
  model_id:string;
  provider_request_id:string | null;
  response_model_id:string | null;
  response_model_snapshot:string | null;
  finish_reason:string | null;
  input_tokens:number | null;
  output_tokens:number | null;
  latency_ms:number | null;
  raw_response:unknown;
  response_text:string | null;
  parsed_response:unknown;
  error_code:string | null;
  error_message:string | null;
  error_stage:string | null;
  requested_at:Date;
  response_received_at:Date | null;
  parsed_at:Date | null;
  persisted_at:Date | null;
  failed_at:Date | null;
  updated_at:Date;
};

function isoTimestamp(value:Date | null):string | null {
  return value ? value.toISOString() : null;
}

function mapJudgeInvocationRow(invocation: JudgeInvocationDatabaseRow) {
  return {
    id:invocation.id,
    parentInvocationId:invocation.parent_invocation_id,
    invocationKind:invocation.invocation_kind,
    attempt:invocation.attempt,
    logicalKey:invocation.logical_key,
    idempotencyKey:invocation.idempotency_key,
    state:invocation.state,
    requestedMetricKeys:invocation.requested_metric_keys,
    resolvedMetricKeys:invocation.resolved_metric_keys,
    missingMetricKeys:invocation.missing_metric_keys,
    requestSnapshot:invocation.request_snapshot,
    requestHash:invocation.request_hash,
    providerKey:invocation.provider_key,
    modelId:invocation.model_id,
    providerRequestId:invocation.provider_request_id,
    responseModelId:invocation.response_model_id,
    responseModelSnapshot:invocation.response_model_snapshot,
    finishReason:invocation.finish_reason,
    inputTokens:invocation.input_tokens,
    outputTokens:invocation.output_tokens,
    latencyMs:invocation.latency_ms,
    rawResponse:invocation.raw_response,
    responseText:invocation.response_text,
    parsedResponse:invocation.parsed_response,
    errorCode:invocation.error_code,
    errorMessage:invocation.error_message,
    errorStage:invocation.error_stage,
    requestedAt:isoTimestamp(invocation.requested_at)!,
    responseReceivedAt:isoTimestamp(invocation.response_received_at),
    parsedAt:isoTimestamp(invocation.parsed_at),
    persistedAt:isoTimestamp(invocation.persisted_at),
    failedAt:isoTimestamp(invocation.failed_at),
    updatedAt:isoTimestamp(invocation.updated_at)!,
  };
}

async function readRunDetails(
  client: PoolClient,
  runId: string,
  includeHistory: boolean,
) {
  const runResult = await client.query(`select br.*,dv.version dataset_version,
      br.score_profile_snapshot->>'version' score_version,
      br.score_profile_snapshot->>'title' score_title,
      br.score_profile_snapshot->'metrics' score_metrics,
      br.score_profile_snapshot->'weights' score_weights,
      br.score_profile_snapshot->>'rubricPrompt' rubric_prompt,
      br.score_profile_snapshot->>'judgeProvider' judge_provider,
      br.score_profile_snapshot->>'judgeModel' judge_model,
      br.score_profile_snapshot->>'contentHash' score_content_hash,
      br.score_profile_snapshot_provenance
      from benchmark_runs br join dataset_versions dv on dv.id=br.dataset_version_id
      where br.id=$1`, [runId]);
  const row = runResult.rows[0];
  if (!row) return null;
  const modelResult = await client.query(`select id,provider_key,display_name,blind_id,model_id,protocol,concurrency
      from run_models where benchmark_run_id=$1 order by blind_id`, [runId]);
  const itemResult = await client.query(`select ri.id,ri.state,ri.attempts,ri.max_attempts,ri.error_code,ri.error_message,
      ri.request_snapshot,ri.started_at,ri.completed_at,br.system_prompt,q.public_id question_public_id,
      q.purpose,q.difficulty,q.evidence_mode,qr.question_text,qr.answer_options,
      qr.quality_scores,
      rm.provider_key,rm.display_name,rm.model_id,rm.blind_id,
      coalesce((select jsonb_agg(jsonb_build_object('content',sc.content,'quote',qe.quote_text,'pageStart',sc.page_start) order by qe.ordinal)
        from question_evidence qe join source_chunks sc on sc.id=qe.source_chunk_id
        where qe.question_id=ri.question_id and qe.question_revision=ri.question_revision),'[]'::jsonb) question_evidence,
      mr.id response_id,mr.response_text,mr.raw_response,mr.provider_request_id,
      mr.finish_reason,mr.input_tokens,mr.output_tokens,mr.latency_ms,mr.retry_history,
      coalesce((select jsonb_agg(jsonb_build_object(
        'metricKey',s.metric_key,'value',s.value,'label',s.label,'rationale',s.rationale,
        'evidence',s.evidence,'judgeProvider',s.judge_provider,'judgeModel',s.judge_model,
        'judgeRequestId',s.judge_request_id,'judgeInvocationId',s.judge_invocation_id,
        'provenance',s.provenance) order by s.metric_key)
        from scores s where s.model_response_id=mr.id
          and s.score_profile_id=br.score_profile_id),'[]'::jsonb) scores
      from run_items ri join benchmark_runs br on br.id=ri.benchmark_run_id join run_models rm on rm.id=ri.run_model_id
      join questions q on q.id=ri.question_id
      join question_revisions qr on qr.question_id=ri.question_id and qr.revision=ri.question_revision
      left join lateral (select * from eligible_model_responses where run_item_id=ri.id
        order by attempt desc,created_at desc limit 1) mr on true
      where ri.benchmark_run_id=$1 order by q.public_id,rm.blind_id`, [runId]);
  const invocationResult = await client.query<JudgeInvocationDatabaseRow>(
    `select id,model_response_id,parent_invocation_id,invocation_kind,
       attempt,logical_key,idempotency_key,state,requested_metric_keys,
       resolved_metric_keys,missing_metric_keys,request_snapshot,request_hash,
       provider_key,model_id,provider_request_id,response_model_id,
       response_model_snapshot,finish_reason,input_tokens,output_tokens,
       latency_ms,raw_response,response_text,parsed_response,error_code,
       error_message,error_stage,requested_at,response_received_at,parsed_at,
       persisted_at,failed_at,updated_at
     from judge_invocations
     where benchmark_run_id=$1
     order by requested_at,id`,
    [runId],
  );
  const judgeInvocationsByResponse = new Map<
    string,
    Array<ReturnType<typeof mapJudgeInvocationRow>>
  >();
  for (const invocation of invocationResult.rows) {
    const mapped = mapJudgeInvocationRow(invocation);
    const current = judgeInvocationsByResponse.get(invocation.model_response_id) ?? [];
    current.push(mapped);
    judgeInvocationsByResponse.set(invocation.model_response_id, current);
  }
  const events = includeHistory
    ? await readActivityEventHistory(client, 'benchmark_run', runId)
    : null;
  const eventCursor = await readActivityEventCursor(client, 'benchmark_run', runId);
  const engineSnapshot = (
    row.scoring_engine_snapshot
    && typeof row.scoring_engine_snapshot === 'object'
    && !Array.isArray(row.scoring_engine_snapshot)
  )
    ? row.scoring_engine_snapshot as Record<string, unknown>
    : null;
  const verifiedScoringEngine = isVerifiedScoringEngineSnapshot({
    scoringEngineVersionId:row.scoring_engine_version_id,
    scoringEngineSnapshot:row.scoring_engine_snapshot,
    provenance:row.scoring_engine_snapshot_provenance,
  });
  return {
    run: row,
    models: modelResult.rows,
    eventCursor,
    ...(events ? {
      events: events.map((event) => ({
        id: event.id,
        event_type: event.eventType,
        payload: event.payload,
        created_at: event.createdAt.toISOString(),
      })),
    } : {}),
    profile: {
      version: row.score_version, title: row.score_title,
      metrics: Array.isArray(row.score_metrics) ? row.score_metrics.map(String) : [],
      weights: row.score_weights && typeof row.score_weights === 'object' ? row.score_weights : {},
      rubricPrompt: row.rubric_prompt ?? '', judgeProvider: row.judge_provider,
      judgeModel: row.judge_model, contentHash: row.score_content_hash,
      snapshotProvenance:row.score_profile_snapshot_provenance,
      dynamicMetrics: [...prerequisiteScoreMetrics],
    },
    scoringEngine:{
      id:typeof engineSnapshot?.id === 'string'
        ? engineSnapshot.id
        : row.scoring_engine_version_id ?? null,
      version:typeof engineSnapshot?.version === 'string'
        ? engineSnapshot.version
        : null,
      title:typeof engineSnapshot?.title === 'string'
        ? engineSnapshot.title
        : null,
      definition:engineSnapshot?.definition ?? null,
      contentHash:typeof engineSnapshot?.contentHash === 'string'
        ? engineSnapshot.contentHash
        : null,
      snapshotProvenance:row.scoring_engine_snapshot_provenance,
      verified:verifiedScoringEngine,
    },
    items: itemResult.rows.map((item) => {
      const requiredMetricKeys = requiredMetricsForQuestion(
        Array.isArray(row.score_metrics) ? row.score_metrics.map(String) : [],
        item.quality_scores,
      );
      const evidenceRows = Array.isArray(item.question_evidence) ? item.question_evidence as Array<{ content?: string; quote?: string | null; pageStart?: number | null }> : [];
      const evidence = evidenceRows.map((entry, index) => `[근거 ${index + 1}${entry.pageStart ? ` · p.${entry.pageStart}` : ''}]\n${entry.quote ?? entry.content ?? ''}`);
      const options = Array.isArray(item.answer_options) && item.answer_options.length
        ? `\n\n선택지:\n${item.answer_options.map((option: unknown, index: number) => `${index + 1}. ${String(option)}`).join('\n')}` : '';
      const evidenceBlock = evidence.length
        ? `다음 근거만 사용하십시오.\n\n${evidence.join('\n\n')}`
        : item.evidence_mode === 'GROUNDED' ? '연결된 교과서 근거가 없습니다. 근거 부족을 명시하십시오.' : '외부 검색 없이 답하십시오.';
      const request = item.request_snapshot ?? {
        system: item.system_prompt,
        prompt: `${evidenceBlock}\n\n[질문]\n${item.question_text}${options}`,
        providerKey: item.provider_key, modelId: item.model_id, evidence,
        question: item.question_text, options: item.answer_options, reconstructed: true,
      };
      return ({
      id: item.id, state: item.state, attempts: item.attempts, maxAttempts: item.max_attempts,
      errorCode: item.error_code, errorMessage: item.error_message,
      questionPublicId: item.question_public_id, questionText: item.question_text,
      answerOptions: item.answer_options, purpose: item.purpose, difficulty: item.difficulty,
      evidenceMode: item.evidence_mode, providerKey: item.provider_key,
      displayName: item.display_name, modelId: item.model_id, blindId: item.blind_id,
      request,
      requiredMetricKeys,
      response: item.response_id ? {
        id: item.response_id, text: item.response_text, raw: item.raw_response,
        requestId: item.provider_request_id, finishReason: item.finish_reason,
        inputTokens: item.input_tokens, outputTokens: item.output_tokens,
        latencyMs: item.latency_ms, retryHistory: item.retry_history,
      } : null,
      scores: Array.isArray(item.scores) ? item.scores.map((score: Record<string, unknown>) => ({
        ...score, value: score.value == null ? null : Number(score.value),
      })) : [],
      judgeInvocations:item.response_id
        ? judgeInvocationsByResponse.get(item.response_id) ?? []
        : [],
      startedAt: item.started_at, completedAt: item.completed_at,
    }); }),
  };
}

export async function getRunDetails(
  runId: string,
  options: { includeHistory?: boolean } = {},
) {
  return withReadOnlyRepeatableReadTransaction((client) =>
    readRunDetails(client, runId, options.includeHistory !== false));
}

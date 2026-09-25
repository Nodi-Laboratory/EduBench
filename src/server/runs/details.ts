import type { PoolClient } from 'pg';
import {
  buildBenchmarkAnswerPrompt,
  type StoredBenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import { prerequisiteScoreMetrics } from '@/domain/prerequisite-benchmark';
import { isVerifiedScoringEngineSnapshot } from '@/domain/scoring-engine';
import { requiredMetricsForQuestion } from '@/domain/scoring';
import {
  readActivityEventCursor,
  readActivityEventHistory,
} from '@/server/activity/event-stream';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

const DEFAULT_ITEM_PAGE_SIZE = 50;
const MAX_ITEM_PAGE_SIZE = 100;
const DEFAULT_JUDGE_PAGE_SIZE = 20;
const MAX_JUDGE_PAGE_SIZE = 100;

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

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value!));
}

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
  options: {
    includeHistory:boolean;
    itemPage:number;
    itemPageSize:number;
    runModelId:string | null;
    itemState:string | null;
    retrievalMode:StoredBenchmarkRetrievalMode | null;
  },
) {
  const runResult = await client.query(`select
      br.id,br.public_id,br.title,br.state,br.dataset_version_id,
      br.score_profile_id,br.price_profile_version,br.parameters,
      br.total_items,br.completed_items,br.failed_items,
      br.pause_requested_at,br.cancel_requested_at,br.started_at,
      br.completed_at,br.created_at,br.updated_at,br.last_scoring_error,
      br.retrieval_modes,br.scoring_engine_version_id,
      br.scoring_engine_snapshot,br.scoring_engine_snapshot_provenance,
      br.score_profile_snapshot_provenance,
      dv.version dataset_version,
      br.score_profile_snapshot->>'version' score_version,
      br.score_profile_snapshot->>'title' score_title,
      br.score_profile_snapshot->'metrics' score_metrics,
      br.score_profile_snapshot->'weights' score_weights,
      br.score_profile_snapshot->>'rubricPrompt' rubric_prompt,
      br.score_profile_snapshot->>'judgeProvider' judge_provider,
      br.score_profile_snapshot->>'judgeModel' judge_model,
      br.score_profile_snapshot->>'contentHash' score_content_hash
      from benchmark_runs br join dataset_versions dv on dv.id=br.dataset_version_id
      where br.id=$1`, [runId]);
  const row = runResult.rows[0];
  if (!row) return null;
  const scoreMetrics = Array.isArray(row.score_metrics)
    ? row.score_metrics.map(String)
    : [];

  const modelResult = await client.query(`select
      id,provider_key,display_name,blind_id,model_id,model_snapshot,
      protocol,parameters,concurrency,request_interval_ms
      from run_models where benchmark_run_id=$1 order by blind_id,id`, [runId]);
  const providerCooldownResult = await client.query<{
    provider_key:string;
    rate_limit_dimension:'RPM' | 'RPD' | 'TPM' | 'UNKNOWN';
    rate_limit_scope:string | null;
    blocked_until:Date;
    source_phase:string;
    source_run_id:string | null;
    source_run_item_id:string | null;
    source_model_id:string | null;
    retry_after_ms:number | null;
    hit_count:number;
    last_error_message:string | null;
    request_id:string | null;
    activated_at:Date;
    resumed_at:Date | null;
    updated_at:Date;
    active:boolean;
  }>(
    `select cooldown.*,(cooldown.blocked_until > now()) active
       from benchmark_provider_cooldowns cooldown
      where cooldown.provider_key in (
        select provider_key from run_models where benchmark_run_id=$1
        union
        select score_profile_snapshot->>'judgeProvider'
          from benchmark_runs
         where id=$1
           and score_profile_snapshot->>'judgeProvider' is not null
        union
        select 'gemini'
         where exists(
           select 1 from run_items
            where benchmark_run_id=$1
              and retrieval_mode='VECTOR'
         )
      )
      order by active desc,cooldown.blocked_until desc,cooldown.provider_key`,
    [runId],
  );

  const progressResult = await client.query<{
    item_total:number;
    filtered_total:number;
    score_eligible_items:number;
    required_score_pairs:number;
    scored_pairs:number;
    states:string[];
    retrieval_modes:StoredBenchmarkRetrievalMode[];
  }>(
    `with item_progress as (
       select ri.id,ri.run_model_id,ri.state,ri.retrieval_mode,
              br.score_profile_id,qr.quality_scores,mr.id response_id
         from run_items ri
         join benchmark_runs br on br.id=ri.benchmark_run_id
         join question_revisions qr
           on qr.question_id=ri.question_id
          and qr.revision=ri.question_revision
         left join lateral (
           select response.id
             from eligible_model_responses response
            where response.run_item_id=ri.id
            order by response.attempt desc,response.created_at desc
            limit 1
         ) mr on true
        where ri.benchmark_run_id=$1
     )
     select count(*)::int item_total,
            count(*) filter (
              where ($2::text is null or progress.state=$2)
                and ($3::text is null or progress.retrieval_mode=$3)
                and ($4::text is null or progress.run_model_id::text=$4)
            )::int filtered_total,
            count(*) filter (
              where progress.response_id is not null
            )::int score_eligible_items,
            coalesce(sum(score_progress.required_count),0)::int
              required_score_pairs,
            coalesce(sum(score_progress.scored_count),0)::int scored_pairs,
            coalesce(
              array_agg(distinct progress.state order by progress.state),
              array[]::text[]
            ) states,
            coalesce(
              array_agg(
                distinct progress.retrieval_mode
                order by progress.retrieval_mode
              ),
              array[]::text[]
            ) retrieval_modes
       from item_progress progress
       left join lateral (
         select count(distinct required_metric.metric_key)::int required_count,
                count(distinct score.metric_key)::int scored_count
           from (
             select distinct metric_key
               from unnest(
                 array['response_present']::text[]
                 || coalesce((
                   select array_agg(profile_metric)
                     from unnest($5::text[]) profile_metric
                    where profile_metric <> 'exact_match'
                 ),array[]::text[])
                 || case
                   when jsonb_typeof(
                     progress.quality_scores->'benchmarkDesign'
                   )='object'
                    and progress.quality_scores
                          #>> '{benchmarkDesign,benchmarkType}'
                          = 'PREREQUISITE_RELATIONSHIP'
                     then $6::text[]
                   else array[]::text[]
                 end
               ) metric_key
           ) required_metric
           left join scores score
             on score.model_response_id=progress.response_id
            and score.score_profile_id=progress.score_profile_id
            and score.metric_key=required_metric.metric_key
       ) score_progress on progress.response_id is not null`,
    [
      runId,
      options.itemState,
      options.retrievalMode,
      options.runModelId,
      scoreMetrics,
      [...prerequisiteScoreMetrics],
    ],
  );
  const progress = progressResult.rows[0] ?? {
    item_total:0,
    filtered_total:0,
    score_eligible_items:0,
    required_score_pairs:0,
    scored_pairs:0,
    states:[],
    retrieval_modes:[],
  };
  const offset = (options.itemPage - 1) * options.itemPageSize;
  const itemResult = await client.query<{
    id:string;
    state:string;
    attempts:number;
    max_attempts:number;
    error_code:string | null;
    error_message:string | null;
    retrieval_mode:StoredBenchmarkRetrievalMode;
    generation_retrieval_id:string | null;
    started_at:Date | null;
    completed_at:Date | null;
    question_public_id:string;
    question_text:string;
    provider_key:string;
    display_name:string;
    model_id:string;
    blind_id:string;
    response_id:string | null;
    run_model_id:string;
  }>(
    `select ri.id,ri.state,ri.attempts,ri.max_attempts,
            ri.error_code,ri.error_message,ri.retrieval_mode,
            ri.run_model_id,ri.generation_retrieval_id,
            ri.started_at,ri.completed_at,
            q.public_id question_public_id,qr.question_text,
            rm.provider_key,rm.display_name,rm.model_id,rm.blind_id,
            mr.id response_id
       from run_items ri
       join run_models rm on rm.id=ri.run_model_id
       join questions q on q.id=ri.question_id
       join question_revisions qr
         on qr.question_id=ri.question_id
        and qr.revision=ri.question_revision
       left join lateral (
         select response.id
           from eligible_model_responses response
          where response.run_item_id=ri.id
          order by response.attempt desc,response.created_at desc
          limit 1
       ) mr on true
      where ri.benchmark_run_id=$1
        and ($2::text is null or ri.state=$2)
        and ($3::text is null or ri.retrieval_mode=$3)
        and ($4::text is null or ri.run_model_id::text=$4)
      order by q.public_id,rm.blind_id,ri.retrieval_mode,ri.id
      limit $5 offset $6`,
    [
      runId,
      options.itemState,
      options.retrievalMode,
      options.runModelId,
      options.itemPageSize,
      offset,
    ],
  );

  const events = options.includeHistory
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
    run: {
      id:row.id,
      public_id:row.public_id,
      title:row.title,
      state:row.state,
      dataset_version_id:row.dataset_version_id,
      score_profile_id:row.score_profile_id,
      price_profile_version:row.price_profile_version,
      parameters:row.parameters,
      total_items:row.total_items,
      completed_items:row.completed_items,
      failed_items:row.failed_items,
      pause_requested_at:row.pause_requested_at,
      cancel_requested_at:row.cancel_requested_at,
      started_at:row.started_at,
      completed_at:row.completed_at,
      created_at:row.created_at,
      updated_at:row.updated_at,
      last_scoring_error:row.last_scoring_error,
      retrieval_modes:row.retrieval_modes,
      dataset_version:row.dataset_version,
      score_version:row.score_version,
    },
    models: modelResult.rows,
    providerCooldowns:providerCooldownResult.rows.map((cooldown) => ({
      providerKey:cooldown.provider_key,
      active:cooldown.active,
      rateLimitDimension:cooldown.rate_limit_dimension,
      rateLimitScope:cooldown.rate_limit_scope,
      blockedUntil:cooldown.blocked_until.toISOString(),
      sourcePhase:cooldown.source_phase,
      sourceRunId:cooldown.source_run_id,
      sourceRunItemId:cooldown.source_run_item_id,
      sourceModelId:cooldown.source_model_id,
      retryAfterMs:cooldown.retry_after_ms,
      hitCount:cooldown.hit_count,
      lastErrorMessage:cooldown.last_error_message,
      requestId:cooldown.request_id,
      activatedAt:cooldown.activated_at.toISOString(),
      resumedAt:isoTimestamp(cooldown.resumed_at),
      updatedAt:cooldown.updated_at.toISOString(),
    })),
    counters: {
      itemTotal:progress.item_total,
      scoreEligibleItems:progress.score_eligible_items,
      requiredScorePairs:progress.required_score_pairs,
      scoredPairs:progress.scored_pairs,
    },
    itemFilters:{
      runModelId:options.runModelId,
      state:options.itemState,
      retrievalMode:options.retrievalMode,
    },
    itemFilterOptions:{
      models:modelResult.rows.map((model) => ({
        runModelId:model.id,
        providerKey:model.provider_key,
        displayName:model.display_name,
        blindId:model.blind_id,
        modelId:model.model_id,
      })),
      states:progress.states,
      retrievalModes:progress.retrieval_modes,
    },
    itemPagination: {
      page:options.itemPage,
      pageSize:options.itemPageSize,
      total:progress.filtered_total,
      totalPages:Math.ceil(
        progress.filtered_total / options.itemPageSize,
      ),
    },
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
      version: row.score_version,
      title: row.score_title,
      metrics: scoreMetrics.filter((metric: string) => metric !== 'exact_match'),
      weights: row.score_weights && typeof row.score_weights === 'object'
        ? row.score_weights
        : {},
      rubricPrompt: row.rubric_prompt ?? '',
      judgeProvider: row.judge_provider,
      judgeModel: row.judge_model,
      contentHash: row.score_content_hash,
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
    items:itemResult.rows.map((item) => ({
      id:item.id,
      runModelId:item.run_model_id,
      state:item.state,
      attempts:item.attempts,
      maxAttempts:item.max_attempts,
      errorCode:item.error_code,
      errorMessage:item.error_message,
      questionPublicId:item.question_public_id,
      questionText:item.question_text,
      providerKey:item.provider_key,
      displayName:item.display_name,
      modelId:item.model_id,
      blindId:item.blind_id,
      retrievalMode:item.retrieval_mode,
      generationRetrievalId:item.generation_retrieval_id,
      hasResponse:item.response_id != null,
      startedAt:item.started_at,
      completedAt:item.completed_at,
    })),
  };
}

async function readRunItemDetails(
  client:PoolClient,
  runId:string,
  itemId:string,
  options:{ judgeOffset:number; judgeLimit:number },
) {
  const itemResult = await client.query(`select
      ri.id,ri.run_model_id,ri.state,ri.attempts,ri.max_attempts,
      ri.error_code,ri.error_message,
      ri.retrieval_mode,ri.generation_retrieval_id,ri.request_snapshot,
      ri.started_at,ri.completed_at,br.system_prompt,br.score_profile_id,
      br.score_profile_snapshot->'metrics' score_metrics,
      q.public_id question_public_id,q.purpose,q.difficulty,q.evidence_mode,
      qr.question_text,qr.answer_options,qr.quality_scores,
      rm.provider_key,rm.display_name,rm.model_id,rm.blind_id,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'content',sc.content,'quote',qe.quote_text,'pageStart',sc.page_start
        ) order by qe.ordinal)
          from question_evidence qe
          join source_chunks sc on sc.id=qe.source_chunk_id
         where qe.question_id=ri.question_id
           and qe.question_revision=ri.question_revision
      ),'[]'::jsonb) question_evidence,
      mr.id response_id,mr.response_text,mr.raw_response,
      mr.provider_request_id,mr.finish_reason,mr.input_tokens,
      mr.output_tokens,mr.latency_ms,mr.retry_history,
      retrieval.id retrieval_audit_id,
      coalesce(retrieval.query_text,retrieval_root.query_text) retrieval_query,
      coalesce(retrieval.embedding_model,retrieval_root.embedding_model)
        retrieval_embedding_model,
      coalesce(
        retrieval.embedding_profile_hash,
        retrieval_root.embedding_profile_hash
      ) retrieval_embedding_profile_hash,
      coalesce(retrieval.vector_space_id,retrieval_root.vector_space_id)
        retrieval_vector_space_id,
      coalesce(retrieval.candidate_scope,retrieval_root.candidate_scope)
        retrieval_candidate_scope,
      coalesce(retrieval.selected_chunks,retrieval_root.selected_chunks)
        retrieval_selected_chunks,
      coalesce(retrieval.graph_trace,retrieval_root.graph_trace)
        retrieval_graph_trace,
      coalesce(retrieval.config_snapshot,retrieval_root.config_snapshot)
        retrieval_config_snapshot,
      coalesce(retrieval.config_hash,retrieval_root.config_hash)
        retrieval_config_hash,
      coalesce(retrieval.rendered_context,retrieval_root.rendered_context)
        retrieval_rendered_context,
      coalesce(retrieval.context_hash,retrieval_root.context_hash)
        retrieval_context_hash,
      coalesce(retrieval.shared_snapshot_key,retrieval_root.shared_snapshot_key)
        retrieval_shared_snapshot_key,
      retrieval.shared_from_retrieval_id retrieval_shared_from_retrieval_id,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'metricKey',score.metric_key,'value',score.value,
          'label',score.label,'rationale',score.rationale,
          'evidence',score.evidence,'judgeProvider',score.judge_provider,
          'judgeModel',score.judge_model,
          'judgeRequestId',score.judge_request_id,
          'judgeInvocationId',score.judge_invocation_id,
          'provenance',score.provenance
        ) order by score.metric_key)
          from scores score
         where score.model_response_id=mr.id
           and score.score_profile_id=br.score_profile_id
           and score.metric_key <> 'exact_match'
      ),'[]'::jsonb) scores
      from run_items ri
      join benchmark_runs br on br.id=ri.benchmark_run_id
      join run_models rm on rm.id=ri.run_model_id
      join questions q on q.id=ri.question_id
      join question_revisions qr
        on qr.question_id=ri.question_id
       and qr.revision=ri.question_revision
      left join run_item_retrievals retrieval on retrieval.run_item_id=ri.id
      left join run_item_retrievals retrieval_root
        on retrieval_root.id=retrieval.shared_from_retrieval_id
      left join lateral (
        select *
          from eligible_model_responses response
         where response.run_item_id=ri.id
         order by response.attempt desc,response.created_at desc
         limit 1
      ) mr on true
      where ri.benchmark_run_id=$1 and ri.id=$2`,
    [runId, itemId],
  );
  const item = itemResult.rows[0];
  if (!item) return null;

  const invocationTotalResult = item.response_id
    ? await client.query<{ total:number }>(
      `select count(*)::int total
         from judge_invocations
        where benchmark_run_id=$1 and model_response_id=$2`,
      [runId, item.response_id],
    )
    : { rows:[{ total:0 }] };
  const invocationResult = item.response_id
    ? await client.query<JudgeInvocationDatabaseRow>(
      `select id,model_response_id,parent_invocation_id,invocation_kind,
         attempt,logical_key,idempotency_key,state,requested_metric_keys,
         resolved_metric_keys,missing_metric_keys,request_snapshot,request_hash,
         provider_key,model_id,provider_request_id,response_model_id,
         response_model_snapshot,finish_reason,input_tokens,output_tokens,
         latency_ms,raw_response,response_text,parsed_response,error_code,
         error_message,error_stage,requested_at,response_received_at,parsed_at,
         persisted_at,failed_at,updated_at
       from judge_invocations
       where benchmark_run_id=$1 and model_response_id=$2
       order by requested_at,id
       limit $3 offset $4`,
      [runId, item.response_id, options.judgeLimit, options.judgeOffset],
    )
    : { rows:[] as JudgeInvocationDatabaseRow[] };
  const judgeTotal = invocationTotalResult.rows[0]?.total ?? 0;

  const evidenceRows = Array.isArray(item.question_evidence)
    ? item.question_evidence as Array<{
      content?:string;
      quote?:string | null;
      pageStart?:number | null;
    }>
    : [];
  const evidence = evidenceRows.map((entry, index) =>
    `[근거 ${index + 1}${entry.pageStart ? ` · p.${entry.pageStart}` : ''}]\n`
      + `${entry.quote ?? entry.content ?? ''}`);
  const reconstructedRequest = item.retrieval_mode === 'LEGACY_EVIDENCE'
    || item.retrieval_mode === 'NONE'
    ? {
      system:item.system_prompt,
      prompt:buildBenchmarkAnswerPrompt({
        retrievalMode:item.retrieval_mode,
        questionText:item.question_text,
        answerOptions:item.answer_options,
        evidence:item.retrieval_mode === 'NONE' ? [] : evidence,
      }),
      providerKey:item.provider_key,
      modelId:item.model_id,
      evidence,
      question:item.question_text,
      options:item.answer_options,
      reconstructed:true,
    }
    : null;
  const request = item.request_snapshot ?? reconstructedRequest;
  const requiredMetricKeys = requiredMetricsForQuestion(
    Array.isArray(item.score_metrics) ? item.score_metrics.map(String) : [],
    item.quality_scores,
  );

  return {
    runId,
    item:{
      id:item.id,
      runModelId:item.run_model_id,
      state:item.state,
      attempts:item.attempts,
      maxAttempts:item.max_attempts,
      errorCode:item.error_code,
      errorMessage:item.error_message,
      questionPublicId:item.question_public_id,
      questionText:item.question_text,
      answerOptions:item.answer_options,
      purpose:item.purpose,
      difficulty:item.difficulty,
      evidenceMode:item.evidence_mode,
      providerKey:item.provider_key,
      displayName:item.display_name,
      modelId:item.model_id,
      blindId:item.blind_id,
      retrievalMode:item.retrieval_mode,
      generationRetrievalId:item.generation_retrieval_id,
      retrieval:item.retrieval_audit_id ? {
        id:item.retrieval_audit_id,
        query:item.retrieval_query,
        embeddingModel:item.retrieval_embedding_model,
        embeddingProfileHash:item.retrieval_embedding_profile_hash,
        vectorSpaceId:item.retrieval_vector_space_id,
        candidateScope:item.retrieval_candidate_scope,
        selectedChunks:item.retrieval_selected_chunks,
        graphTrace:item.retrieval_graph_trace,
        configSnapshot:item.retrieval_config_snapshot,
        configHash:item.retrieval_config_hash,
        renderedContext:item.retrieval_rendered_context,
        contextHash:item.retrieval_context_hash,
        sharedSnapshotKey:item.retrieval_shared_snapshot_key,
        sharedFromRetrievalId:item.retrieval_shared_from_retrieval_id,
      } : null,
      request,
      requiredMetricKeys,
      response:item.response_id ? {
        id:item.response_id,
        text:item.response_text,
        raw:item.raw_response,
        requestId:item.provider_request_id,
        finishReason:item.finish_reason,
        inputTokens:item.input_tokens,
        outputTokens:item.output_tokens,
        latencyMs:item.latency_ms,
        retryHistory:item.retry_history,
      } : null,
      scores:Array.isArray(item.scores)
        ? item.scores.map((score:Record<string, unknown>) => ({
          ...score,
          value:score.value == null ? null : Number(score.value),
        }))
        : [],
      judgeInvocations:invocationResult.rows.map(mapJudgeInvocationRow),
      startedAt:item.started_at,
      completedAt:item.completed_at,
    },
    judgePagination:{
      limit:options.judgeLimit,
      offset:options.judgeOffset,
      total:judgeTotal,
      nextOffset:options.judgeOffset + invocationResult.rows.length < judgeTotal
        ? options.judgeOffset + invocationResult.rows.length
        : null,
    },
  };
}

export async function getRunDetails(
  runId: string,
  options: {
    includeHistory?:boolean;
    itemPage?:number;
    itemPageSize?:number;
    runModelId?:string | null;
    itemState?:string | null;
    retrievalMode?:StoredBenchmarkRetrievalMode | null;
  } = {},
) {
  const itemPage = boundedInteger(options.itemPage, 1, 1, Number.MAX_SAFE_INTEGER);
  const itemPageSize = boundedInteger(
    options.itemPageSize,
    DEFAULT_ITEM_PAGE_SIZE,
    1,
    MAX_ITEM_PAGE_SIZE,
  );
  return withReadOnlyRepeatableReadTransaction((client) =>
    readRunDetails(client, runId, {
      includeHistory:options.includeHistory !== false,
      itemPage,
      itemPageSize,
      runModelId:options.runModelId || null,
      itemState:options.itemState || null,
      retrievalMode:options.retrievalMode ?? null,
    }));
}

export async function getRunItemDetails(
  runId:string,
  itemId:string,
  options:{ judgeOffset?:number; judgeLimit?:number } = {},
) {
  const judgeOffset = boundedInteger(
    options.judgeOffset,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const judgeLimit = boundedInteger(
    options.judgeLimit,
    DEFAULT_JUDGE_PAGE_SIZE,
    1,
    MAX_JUDGE_PAGE_SIZE,
  );
  return withReadOnlyRepeatableReadTransaction((client) =>
    readRunItemDetails(client, runId, itemId, { judgeOffset, judgeLimit }));
}

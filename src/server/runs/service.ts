import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  parseBenchmarkRetrievalModes,
  hashBenchmarkRetrievalSnapshot,
  type BenchmarkRetrievalMode,
  type StoredBenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import { DomainError } from '@/domain/errors';
import {
  hasJudgeMetrics,
  isRetiredScoreMetric,
  isJudgeProvenanceResolved,
  isRunScoreProfileUsable,
  scoreProfileReplacementRequiredMessage,
  type ScoreProfileSnapshot,
} from '@/domain/score-profile';
import { requiredMetricsForQuestion } from '@/domain/scoring';
import {
  isCurrentScoringEngineSnapshot,
  scoringEngineReplacementRequiredMessage,
} from '@/domain/scoring-engine';
import {
  benchmarkGenerationParameters,
  hashResearchConfigDefinition,
  parseResearchConfigDefinition,
  type BenchmarkResearchModel,
} from '@/domain/research-config';
import { transitionRun, type RunCommand, type RunState } from '@/domain/status';
import { withTransaction } from '@/server/db/transaction';
import { createProviderForModel, isSupportedProviderKey } from '@/server/providers/registry';
import { isMockProviders, providerEnvFromKeys, type ProviderEnv } from '@/server/providers/credentials';
import { generationParametersSchema } from '@/server/providers/types';
import {
  type BenchmarkProviderCooldown,
  markExpiredProviderCooldownsResumedForRun,
} from './provider-cooldown';

export type RunModelInput = {
  providerKey: string;
  displayName: string;
  modelId: string;
  modelSnapshot?: string;
  protocol: 'gemini' | 'anthropic' | 'openai-responses' | 'openai-compatible';
  parameters?: Record<string, unknown>;
  concurrency?: number;
  requestIntervalMs?: number;
};

export type CreateRunInput = {
  title: string;
  datasetVersionId: string;
  scoreProfileId: string;
  priceProfileVersion: string;
  systemPrompt: string;
  parameters?: Record<string, unknown>;
  models: RunModelInput[];
  retrievalModes?: BenchmarkRetrievalMode[];
  questionLimit?: number;
  questionIds?: string[];
  /** Provider keys supplied with the request; only used to validate them. */
  providerEnv?: ProviderEnv;
};

export type RunSummary = {
  id:string;
  publicId:string;
  state:RunState;
  totalItems:number;
  retrievalModes:StoredBenchmarkRetrievalMode[];
};

export type RunItemRecord = {
  id: string;
  benchmark_run_id: string;
  run_model_id: string;
  question_id: string;
  question_revision: number;
  retrieval_mode: StoredBenchmarkRetrievalMode;
  state: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
};

async function appendRunEvent(
  client: PoolClient,
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await client.query(
    `insert into job_events(aggregate_type, aggregate_id, event_type, payload)
     values ('benchmark_run', $1, $2, $3::jsonb)`,
    [runId, eventType, JSON.stringify(payload)],
  );
}

export async function createRun(input: CreateRunInput): Promise<RunSummary> {
  if (!input.models.length) throw new DomainError('RUN_MODELS_REQUIRED', '실행할 모델을 하나 이상 선택해야 합니다.');
  if (new Set(input.models.map((model) => model.providerKey)).size !== input.models.length) {
    throw new DomainError('DUPLICATE_RUN_PROVIDER', '동일 제공자를 한 실행에 두 번 등록할 수 없습니다.');
  }
  let retrievalModes: StoredBenchmarkRetrievalMode[];
  try {
    retrievalModes = input.retrievalModes
      ? parseBenchmarkRetrievalModes(input.retrievalModes)
      : ['LEGACY_EVIDENCE'];
  } catch (error) {
    throw new DomainError(
      'RUN_RETRIEVAL_MODES_INVALID',
      error instanceof Error ? error.message : '검색 조건이 올바르지 않습니다.',
    );
  }
  const isVerifiedRetrievalRun = !retrievalModes.includes('LEGACY_EVIDENCE');
  const retrievalConfigSnapshot = isVerifiedRetrievalRun
    ? {
      schemaVersion:1,
      strategyVersion:'benchmark-retrieval-v1',
      modes:retrievalModes,
      none:{
        context:'none',
      },
      vector:{
        querySource:'public-question-and-options-only',
        scope:'generation-source-revisions',
        ranking:'cosine',
        neighborWindow:0,
        topK:'question-generation-embedding-profile',
      },
      pike:{
        treatment:'pike-inspired-authoring-graph-snapshot',
        source:'question-generation-retrieval-snapshot',
        ordering:'prerequisite-graph-evidence-first',
        graphRole:'post-retrieval-evidence-prioritization',
        promptDisclosure:'chunk-content-only',
      },
      scoringEvidencePolicy:'static-question-ground-truth',
    }
    : {
      schemaVersion:1,
      strategyVersion:'legacy-question-evidence',
      modes:retrievalModes,
    };
  const retrievalConfigHash = isVerifiedRetrievalRun
    ? hashBenchmarkRetrievalSnapshot(retrievalConfigSnapshot)
    : null;
  return withTransaction(async (client) => {
    const dataset = await client.query<{ status: string; distribution: { sample_data?: boolean } }>(
      'select status, distribution from dataset_versions where id = $1', [input.datasetVersionId],
    );
    if (dataset.rows[0]?.status !== 'PUBLISHED') {
      throw new DomainError('DATASET_NOT_PUBLISHED', '게시된 데이터셋 버전만 실행할 수 있습니다.');
    }
    const activeModelProfile = await client.query<{
      id:string;
      definition:unknown;
      content_hash:string;
    }>(
      `select profile.id,profile.definition,profile.content_hash
       from research_config_active_profiles active
       join research_config_profiles profile
         on profile.id=active.profile_id and profile.kind=active.kind
       where active.kind='benchmark_models'
       for share of active,profile`,
    );
    const modelProfile = activeModelProfile.rows[0];
    if (!modelProfile) {
      throw new DomainError(
        'RESEARCH_CONFIG_ACTIVE_PROFILE_MISSING',
        '활성 벤치마크 모델 연구 설정이 필요합니다.',
      );
    }
    const modelProfileDefinition = parseResearchConfigDefinition(
      modelProfile.definition,
    );
    if (
      modelProfileDefinition.kind !== 'benchmark_models'
      || hashResearchConfigDefinition(modelProfileDefinition)
           !== modelProfile.content_hash
    ) {
      throw new DomainError(
        'RESEARCH_CONFIG_PROFILE_INTEGRITY_ERROR',
        '활성 벤치마크 모델 설정 정의와 해시가 일치하지 않습니다.',
      );
    }
    const profileModelByProvider = new Map(
      modelProfileDefinition.settings.models.map((model) => [
        model.providerKey,
        model,
      ]),
    );
    const mockProviders = isMockProviders();
    // Without request keys, keep the non-secret settings (base URLs,
    // MOCK_PROVIDERS) and treat every key as missing.
    const providerEnv = input.providerEnv ?? providerEnvFromKeys({});
    const resolveExecutionModels = () => input.models.map((requested): RunModelInput => {
      const configured = profileModelByProvider.get(
        requested.providerKey as BenchmarkResearchModel['providerKey'],
      ) as BenchmarkResearchModel | undefined;
      if (mockProviders) return requested;
      if (!configured || !configured.enabled) {
        throw new DomainError(
          'RUN_MODEL_NOT_IN_ACTIVE_PROFILE',
          `${requested.providerKey} 모델은 활성 벤치마크 모델 설정에 없습니다.`,
        );
      }
      const requestedParameters = generationParametersSchema.safeParse(
        requested.parameters ?? {},
      );
      const configuredParameters = generationParametersSchema.parse(
        benchmarkGenerationParameters(configured),
      );
      if (
        !requestedParameters.success
        ||
        requested.modelId !== configured.modelId
        || requested.protocol !== configured.protocol
        || requested.concurrency !== configured.concurrency
        || requested.requestIntervalMs !== configured.requestIntervalMs
        || JSON.stringify(requestedParameters.data)
             !== JSON.stringify(configuredParameters)
      ) {
        throw new DomainError(
          'RUN_MODEL_PROFILE_MISMATCH',
          `${requested.providerKey} 실행값이 활성 벤치마크 모델 프로필과 일치하지 않습니다.`,
        );
      }
      if (
        !createProviderForModel(
          configured.providerKey,
          configured.modelId,
          providerEnv,
        )
      ) {
        throw new DomainError(
          'RUN_MODEL_NOT_CONFIGURED',
          `${configured.providerKey} / ${configured.modelId} 실행에 API 키가 필요합니다. 설정 화면에서 키를 입력하세요.`,
        );
      }
      return {
        providerKey:configured.providerKey,
        displayName:configured.displayName,
        modelId:configured.modelId,
        protocol:configured.protocol,
        parameters:benchmarkGenerationParameters(configured),
        concurrency:configured.concurrency,
        requestIntervalMs:configured.requestIntervalMs,
      };
    });

    const profileResult = await client.query<{
      id:string;
      version:string;
      title:string;
      metrics:unknown;
      weights:unknown;
      rubric_prompt:string | null;
      judge_provider:string | null;
      judge_model:string | null;
      content_hash:string;
    }>(
      `select id,version,title,metrics,weights,rubric_prompt,judge_provider,judge_model,content_hash
       from score_profiles where id=$1 for share`,
      [input.scoreProfileId],
    );
    const profile = profileResult.rows[0];
    if (!profile) throw new DomainError('SCORE_PROFILE_NOT_FOUND', '채점 프로필을 찾을 수 없습니다.');
    const profileMetrics = Array.isArray(profile.metrics) ? profile.metrics.map(String) : [];
    if (profileMetrics.some(isRetiredScoreMetric)) {
      throw new DomainError(
        'SCORE_PROFILE_REPLACEMENT_REQUIRED',
        'exact_match는 폐기된 지표입니다. 새 채점 프로필 버전을 만들어 실행하십시오.',
      );
    }
    const profileWeights = profile.weights && typeof profile.weights === 'object' && !Array.isArray(profile.weights)
      ? profile.weights as Record<string, number>
      : {};
    const scoreProfileSnapshot: ScoreProfileSnapshot = {
      id:profile.id,
      version:profile.version,
      title:profile.title,
      metrics:profileMetrics,
      weights:profileWeights,
      rubricPrompt:profile.rubric_prompt,
      judgeProvider:profile.judge_provider,
      judgeModel:profile.judge_model,
      contentHash:profile.content_hash,
    };
    if (!isJudgeProvenanceResolved(profile.judge_provider, profile.judge_model)) {
      throw new DomainError(
        'SCORE_PROFILE_REPLACEMENT_REQUIRED',
        scoreProfileReplacementRequiredMessage,
      );
    }
    if (profile.judge_provider && !isSupportedProviderKey(profile.judge_provider)) {
      throw new DomainError(
        'SCORING_JUDGE_PROVIDER_UNSUPPORTED',
        `${profile.judge_provider} Judge 제공자는 지원되지 않습니다. 새 채점 프로필 버전을 만드십시오.`,
      );
    }

    const questions = await client.query<{
      question_id:string;
      question_revision:number;
      quality_scores:unknown;
      generation_batch_id:string | null;
      generation_item_id:string | null;
      generation_retrieval_id:string | null;
      generation_pins_verified:boolean;
      retrieval_candidate_scope:unknown;
      retrieval_selected_chunks:unknown;
    }>(
      `select dq.question_id,dq.question_revision,qr.quality_scores,
         question.generation_batch_id,question.generation_item_id,
         generation_retrieval.id generation_retrieval_id,
         (
           batch.question_generation_profile_snapshot_provenance=
             'AT_CREATION_VERIFIED'
           and batch.question_generation_profile_id is not null
           and batch.question_generation_profile_snapshot is not null
           and batch.question_generation_profile_hash
             ~ '^[0-9a-f]{64}$'
           and batch.embedding_rag_profile_snapshot_provenance=
             'AT_CREATION_VERIFIED'
           and batch.embedding_rag_profile_id is not null
           and batch.embedding_rag_profile_snapshot is not null
           and batch.embedding_rag_profile_hash
             ~ '^[0-9a-f]{64}$'
         ) generation_pins_verified,
         generation_retrieval.candidate_scope retrieval_candidate_scope,
         generation_retrieval.selected_chunks retrieval_selected_chunks
       from dataset_questions dq
       join questions question on question.id=dq.question_id
       left join generation_batches batch
         on batch.id=question.generation_batch_id
       join question_revisions qr
         on qr.question_id=dq.question_id and qr.revision=dq.question_revision
       left join lateral(
         select retrieval.id,retrieval.candidate_scope,
           retrieval.selected_chunks
           from generation_retrievals retrieval
          where retrieval.generation_batch_id=question.generation_batch_id
            and retrieval.generation_item_id=question.generation_item_id
          order by retrieval.attempt desc,retrieval.created_at desc
          limit 1
       ) generation_retrieval on true
       where dq.dataset_version_id = $1
         and ($2::uuid[] is null or dq.question_id = any($2::uuid[]))
       order by dq.ordinal
       limit $3`,
      [input.datasetVersionId, input.questionIds?.length ? input.questionIds : null, input.questionLimit ?? 1000000],
    );
    if (!questions.rowCount) throw new DomainError('RUN_QUESTIONS_REQUIRED', '실행할 문항이 없습니다.');
    const needsVector = retrievalModes.includes('VECTOR');
    const needsPike = retrievalModes.includes('PIKE');
    if (
      needsVector
      && !isMockProviders()
      && !input.providerEnv?.GOOGLE_API_KEY
    ) {
      throw new DomainError(
        'BENCHMARK_EMBEDDING_PROVIDER_NOT_CONFIGURED',
        'RAG 조건의 질의 임베딩에 Gemini API 키가 필요합니다. 설정 화면에서 키를 입력하세요.',
      );
    }
    if (needsVector || needsPike) {
      const ineligible = questions.rows.filter((question) => {
        if (
          !question.generation_batch_id
          || !question.generation_item_id
          || !question.generation_retrieval_id
          || !question.generation_pins_verified
        ) {
          return true;
        }
        const candidateScope = question.retrieval_candidate_scope
          && typeof question.retrieval_candidate_scope === 'object'
          && !Array.isArray(question.retrieval_candidate_scope)
          ? question.retrieval_candidate_scope as Record<string, unknown>
          : {};
        const sourceRevisionIds = Array.isArray(
          candidateScope.sourceRevisionIds,
        )
          ? candidateScope.sourceRevisionIds.filter(
            (value):value is string => typeof value === 'string',
          )
          : [];
        const selectedChunks = Array.isArray(
          question.retrieval_selected_chunks,
        )
          ? question.retrieval_selected_chunks
          : [];
        return (
          (needsVector && sourceRevisionIds.length === 0)
          || (needsPike && selectedChunks.length === 0)
        );
      });
      if (ineligible.length) {
        throw new DomainError(
          'RUN_RETRIEVAL_PROVENANCE_REQUIRED',
          `선택한 문항 중 ${ineligible.length}개에 질문 생성 검색 계보가 없어 RAG/Pike 비교를 시작할 수 없습니다. 해당 문항을 현재 생성 파이프라인으로 다시 생성하거나 일반 조건만 선택하십시오.`,
          { ineligibleQuestionCount:ineligible.length },
        );
      }
    }
    const needsJudge = questions.rows.some((question) =>
      hasJudgeMetrics(requiredMetricsForQuestion(profileMetrics, question.quality_scores)),
    );
    if (needsJudge && (!profile.judge_provider || !profile.judge_model)) {
      throw new DomainError(
        'SCORING_JUDGE_NOT_CONFIGURED',
        'Judge 지표가 있는 실행에는 Judge 제공자와 정확한 모델이 모두 지정된 채점 프로필이 필요합니다.',
      );
    }
    if (
      profile.judge_provider
      && profile.judge_model
      && !createProviderForModel(profile.judge_provider, profile.judge_model, input.providerEnv ?? providerEnvFromKeys({}))
    ) {
      throw new DomainError(
        'SCORING_JUDGE_NOT_CONFIGURED',
        `${profile.judge_provider} / ${profile.judge_model} Judge를 호출할 API 키가 필요합니다. 새 실행을 만들기 전에 설정 화면에서 키를 입력하십시오.`,
      );
    }
    const executionModels = resolveExecutionModels();

    const runId = randomUUID();
    const publicId = `RUN-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${runId.slice(0, 6).toUpperCase()}`;
    const totalItems = questions.rows.length
      * executionModels.length
      * retrievalModes.length;
    await client.query(
      `insert into benchmark_runs(
         id, public_id, title, dataset_version_id, score_profile_id,
         score_profile_snapshot, price_profile_version, system_prompt, parameters, total_items,
         retrieval_modes,retrieval_config_snapshot,retrieval_config_hash,
         retrieval_snapshot_provenance
       ) values (
         $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,
         $11::text[],$12::jsonb,$13,$14
       )`,
      [runId, publicId, input.title, input.datasetVersionId, input.scoreProfileId,
        JSON.stringify(scoreProfileSnapshot), input.priceProfileVersion, input.systemPrompt, JSON.stringify({
          ...(input.parameters ?? {}),
          sample_data: Boolean(dataset.rows[0]?.distribution?.sample_data),
          mock_providers: process.env.MOCK_PROVIDERS?.toLowerCase() === 'true',
        }), totalItems, retrievalModes, JSON.stringify(retrievalConfigSnapshot),
        retrievalConfigHash,
        isVerifiedRetrievalRun
          ? 'AT_CREATION_VERIFIED'
          : 'LEGACY_BACKFILL_UNVERIFIED'],
    );

    for (const [modelIndex, model] of executionModels.entries()) {
      const modelId = randomUUID();
      await client.query(
        `insert into run_models(
           id, benchmark_run_id, provider_key, display_name, blind_id, model_id,
           model_snapshot, protocol, parameters, concurrency, request_interval_ms
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [modelId, runId, model.providerKey, model.displayName,
          `M${String(modelIndex + 1).padStart(2, '0')}`, model.modelId,
          model.modelSnapshot ?? null, model.protocol, JSON.stringify(model.parameters ?? {}),
          model.concurrency ?? 1, model.requestIntervalMs ?? 0],
      );
      for (const question of questions.rows) {
        for (const retrievalMode of retrievalModes) {
          await client.query(
            `insert into run_items(
               benchmark_run_id,run_model_id,question_id,question_revision,
               retrieval_mode,idempotency_key,generation_retrieval_id
             ) values ($1,$2,$3,$4,$5,$6,$7)`,
            [
              runId,
              modelId,
              question.question_id,
              question.question_revision,
              retrievalMode,
              `${runId}:${model.providerKey}:${question.question_id}:${question.question_revision}:${retrievalMode}`,
              question.generation_retrieval_id,
            ],
          );
        }
      }
    }
    await appendRunEvent(client, runId, 'RUN_CREATED', {
      totalItems,
      models:executionModels.length,
      retrievalModes,
      retrievalConditions:retrievalModes.length,
      benchmarkModelsProfileId:modelProfile.id,
      benchmarkModelsProfileHash:modelProfile.content_hash,
    });
    return {
      id:runId,
      publicId,
      state:'DRAFT',
      totalItems,
      retrievalModes,
    };
  });
}

const eventForCommand: Record<RunCommand, string> = {
  QUEUE: 'RUN_QUEUED', START: 'RUN_STARTED', PAUSE: 'RUN_PAUSE_REQUESTED', FINISH_PAUSE: 'RUN_PAUSED',
  STOP: 'RUN_STOP_REQUESTED', FINISH_STOP: 'RUN_STOPPED', RESUME: 'RUN_RESUMED',
  BEGIN_SCORING: 'RUN_SCORING_STARTED', CANCEL: 'RUN_CANCEL_REQUESTED',
  FINISH_CANCEL: 'RUN_CANCELLED', COMPLETE: 'RUN_COMPLETED', FAIL: 'RUN_FAILED',
};

export async function commandRun(runId: string, command: RunCommand): Promise<{ state: RunState }> {
  return withTransaction(async (client) => {
    const locked = await client.query<{
      state: RunState;
      parameters: Record<string, unknown>;
      scoring_engine_version_id: string | null;
      scoring_engine_snapshot: unknown;
      scoring_engine_snapshot_provenance: string;
    }>(
      `select state,parameters,scoring_engine_version_id,scoring_engine_snapshot,
         scoring_engine_snapshot_provenance
       from benchmark_runs where id=$1 for update`,
      [runId],
    );
    const storedRun = locked.rows[0];
    const current = storedRun?.state;
    if (!current) throw new DomainError('RUN_NOT_FOUND', '실행을 찾을 수 없습니다.');
    if (
      ['QUEUE', 'START', 'RESUME', 'BEGIN_SCORING'].includes(command)
      && !isCurrentScoringEngineSnapshot({
        scoringEngineVersionId: storedRun.scoring_engine_version_id,
        scoringEngineSnapshot: storedRun.scoring_engine_snapshot,
        provenance: storedRun.scoring_engine_snapshot_provenance,
      })
    ) {
      throw new DomainError(
        'SCORING_ENGINE_REPLACEMENT_REQUIRED',
        scoringEngineReplacementRequiredMessage,
      );
    }
    const transitionedState = transitionRun(current, command);
    const resumesScoring = command === 'RESUME'
      && ['PAUSED', 'STOPPED'].includes(current)
      && storedRun.parameters?.scoringControlOrigin === true;
    const state: RunState = resumesScoring ? 'SCORING' : transitionedState;
    const marksScoringControl = current === 'SCORING'
      && ['PAUSE', 'STOP'].includes(command);
    await client.query(
      `update benchmark_runs set state = $2,
         pause_requested_at = case when $3 = 'PAUSE' then now() when $3 = 'RESUME' then null else pause_requested_at end,
         control_requested_at = case when $3 in ('PAUSE','STOP') then now() when $3 = 'RESUME' then null else control_requested_at end,
         cancel_requested_at = case when $3 = 'CANCEL' then now() else cancel_requested_at end,
         started_at = case when $3 = 'START' then coalesce(started_at, now()) else started_at end,
         completed_at = case when $3 in ('COMPLETE','FINISH_CANCEL') then now() else completed_at end,
         parameters = case
           when $4::boolean then jsonb_set(parameters,'{scoringControlOrigin}','true'::jsonb,true)
           when $3 = 'RESUME' then jsonb_set(parameters,'{scoringControlOrigin}','false'::jsonb,true)
           else parameters
         end,
         updated_at = now()
       where id = $1`,
      [runId, state, command, marksScoringControl],
    );
    await appendRunEvent(client, runId, eventForCommand[command], {
      previousState: current,
      state,
      scoringPhase:marksScoringControl || resumesScoring,
    });
    return { state };
  });
}

export async function claimRunItems(
  runId: string,
  workerId: string,
  limit: number,
  leaseMs: number,
): Promise<RunItemRecord[]> {
  if (limit < 1 || leaseMs < 1) throw new DomainError('INVALID_CLAIM_OPTIONS', 'limit와 leaseMs는 1 이상이어야 합니다.');
  return withTransaction(async (client) => {
    // Serialize claims per run so multiple workers cannot exceed a model's persisted concurrency.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [runId]);
    await markExpiredProviderCooldownsResumedForRun(client, runId);
    const result = await client.query<RunItemRecord>(
      `with model_capacity as (
         select rm.id,
           greatest(rm.concurrency - count(ri.id) filter (
             where ri.state = 'LEASED' and ri.lease_expires_at > now()
           ), 0)::int as available_slots,
           rm.request_interval_ms,
           max(ri.last_attempt_started_at) as last_started_at
         from run_models rm
         left join run_items ri on ri.run_model_id = rm.id
         where rm.benchmark_run_id = $1
         group by rm.id, rm.concurrency, rm.request_interval_ms
       ), ranked as (
         select ri.id, ri.run_model_id, mc.available_slots, mc.request_interval_ms,
           row_number() over (partition by ri.run_model_id order by ri.created_at, ri.id) as position
         from run_items ri
         join benchmark_runs br on br.id = ri.benchmark_run_id
         join model_capacity mc on mc.id = ri.run_model_id
         where ri.benchmark_run_id = $1 and br.state = 'RUNNING'
           and ri.state in ('PENDING','RETRY_WAIT') and ri.available_at <= now()
           and ri.attempts < ri.max_attempts
           and not exists(
             select 1 from benchmark_provider_cooldowns cooldown
              join run_models dependency_model
                on dependency_model.id=ri.run_model_id
              where (
                cooldown.provider_key=dependency_model.provider_key
                or (
                  ri.retrieval_mode='VECTOR'
                  and cooldown.provider_key='gemini'
                )
              )
                and cooldown.blocked_until>now()
           )
           and (mc.last_started_at is null or mc.request_interval_ms = 0
             or mc.last_started_at <= now() - (mc.request_interval_ms::bigint * interval '1 millisecond'))
       ), candidates as (
         select ri.id from run_items ri join ranked r on r.id = ri.id
         where r.position <= case when r.request_interval_ms > 0 then least(r.available_slots, 1) else r.available_slots end
         order by ri.created_at, ri.id
         for update of ri skip locked limit $3
       )
       update run_items ri set state = 'LEASED', lease_owner = $2,
         lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
         attempts = ri.attempts + 1,
         started_at = coalesce(ri.started_at, now()),
         last_attempt_started_at = now(),
         error_code = null,
         error_message = null
       from candidates c where ri.id = c.id
       returning ri.*`,
      [runId, workerId, limit, leaseMs],
    );
    if (result.rowCount) await appendRunEvent(client, runId, 'RUN_ITEMS_CLAIMED', { workerId, count: result.rowCount });
    return result.rows;
  });
}

export async function renewRunItemLease(itemId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const { db } = await import('@/server/db/pool');
  const result = await db.query(
    `update run_items set lease_expires_at = now() + ($3::bigint * interval '1 millisecond')
     where id = $1 and state = 'LEASED' and lease_owner = $2`, [itemId, workerId, leaseMs],
  );
  return Boolean(result.rowCount);
}

export async function interruptRunItem(itemId: string, workerId: string): Promise<boolean> {
  const { db } = await import('@/server/db/pool');
  const result = await db.query(
    `update run_items set state='PENDING', attempts=greatest(attempts-1,0), available_at=now(),
       lease_owner=null, lease_expires_at=null, error_code=null, error_message=null, completed_at=null
     where id=$1 and state='LEASED' and lease_owner=$2`,
    [itemId, workerId],
  );
  return Boolean(result.rowCount);
}

export async function failRunItem(
  itemId: string,
  workerId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ benchmark_run_id: string }>(
      `update run_items set state = 'TERMINAL_FAILED', error_code = $3, error_message = $4,
         lease_owner = null, lease_expires_at = null, completed_at = now()
       where id = $1 and state = 'LEASED' and lease_owner = $2
       returning benchmark_run_id`,
      [itemId, workerId, errorCode, errorMessage],
    );
    const runId = result.rows[0]?.benchmark_run_id;
    if (!runId) throw new DomainError('RUN_ITEM_LEASE_MISMATCH', '해당 워커가 임대한 실행 항목이 아닙니다.');
    const counters = await client.query<{ completed_items: number; failed_items: number; total_items: number }>(
      'update benchmark_runs set failed_items = failed_items + 1, updated_at = now() where id = $1 returning completed_items, failed_items, total_items', [runId],
    );
    await appendRunEvent(client, runId, 'RUN_ITEM_FAILED', {
      itemId, errorCode,
      completedItems: counters.rows[0]?.completed_items,
      failedItems: counters.rows[0]?.failed_items,
      totalItems: counters.rows[0]?.total_items,
    });
  });
}

export async function retryFailedRunItems(runId: string): Promise<number> {
  return withTransaction(async (client) => {
    const run = await client.query<{ state: RunState }>('select state from benchmark_runs where id=$1 for update', [runId]);
    if (!run.rows[0]) throw new DomainError('RUN_NOT_FOUND', '실행을 찾을 수 없습니다.');
    const result = await client.query(
      `update run_items set state = 'PENDING', attempts = 0, available_at = now(),
         error_code = null, error_message = null, completed_at = null
       where benchmark_run_id = $1 and state = 'TERMINAL_FAILED'`,
      [runId],
    );
    const count = result.rowCount ?? 0;
    if (count) {
      const nextState = ['SCORING', 'FAILED'].includes(run.rows[0].state) ? 'RUNNING' : run.rows[0].state;
      await client.query(
        'update benchmark_runs set state=$3, failed_items=greatest(failed_items-$2,0), completed_at=null, last_scoring_error=null, updated_at=now() where id=$1',
        [runId, count, nextState],
      );
      await appendRunEvent(client, runId, 'RUN_ITEMS_RETRIED', { count, state: nextState });
    }
    return count;
  });
}

export async function retryScoringRun(runId: string): Promise<{ state: 'SCORING' }> {
  return withTransaction(async (client) => {
    const run = await client.query<{
      state:RunState;
      last_scoring_error:unknown;
      score_profile_snapshot:{ metrics?:unknown; judgeProvider?:string | null; judgeModel?:string | null };
      score_profile_snapshot_provenance:string;
      scoring_engine_version_id:string | null;
      scoring_engine_snapshot:unknown;
      scoring_engine_snapshot_provenance:string;
    }>(
      `select state,last_scoring_error,score_profile_snapshot,
         score_profile_snapshot_provenance,scoring_engine_version_id,
         scoring_engine_snapshot,scoring_engine_snapshot_provenance
       from benchmark_runs where id=$1 for update`,
      [runId],
    );
    if (!run.rows[0]) throw new DomainError('RUN_NOT_FOUND', '실행을 찾을 수 없습니다.');
    if (!isCurrentScoringEngineSnapshot({
      scoringEngineVersionId:run.rows[0].scoring_engine_version_id,
      scoringEngineSnapshot:run.rows[0].scoring_engine_snapshot,
      provenance:run.rows[0].scoring_engine_snapshot_provenance,
    })) {
      throw new DomainError(
        'SCORING_ENGINE_REPLACEMENT_REQUIRED',
        scoringEngineReplacementRequiredMessage,
      );
    }
    if (!isRunScoreProfileUsable({
      judgeProvider:run.rows[0].score_profile_snapshot?.judgeProvider,
      judgeModel:run.rows[0].score_profile_snapshot?.judgeModel,
      metrics:run.rows[0].score_profile_snapshot?.metrics,
      snapshotProvenance:run.rows[0].score_profile_snapshot_provenance,
    })) {
      throw new DomainError(
        'SCORE_PROFILE_REPLACEMENT_REQUIRED',
        scoreProfileReplacementRequiredMessage,
      );
    }
    if (run.rows[0].state !== 'FAILED' || !run.rows[0].last_scoring_error) {
      throw new DomainError('SCORING_RETRY_NOT_AVAILABLE', '채점 실패 상태에서만 채점을 재개할 수 있습니다.');
    }
    await client.query("update benchmark_runs set state='SCORING',last_scoring_error=null,updated_at=now() where id=$1", [runId]);
    await appendRunEvent(client, runId, 'RUN_SCORING_RETRIED', { state:'SCORING' });
    return { state:'SCORING' };
  });
}

async function finishControlWhenDrained(
  runId: string,
  waitingState: 'PAUSING' | 'STOPPING',
  finalState: 'PAUSED' | 'STOPPED',
  eventType: 'RUN_PAUSED' | 'RUN_STOPPED',
): Promise<boolean> {
  return withTransaction(async (client) => {
    const run = await client.query<{ state: RunState }>('select state from benchmark_runs where id=$1 for update', [runId]);
    if (run.rows[0]?.state !== waitingState) return false;
    const active = await client.query<{ count: string }>(
      "select count(*) from run_items where benchmark_run_id=$1 and state='LEASED'", [runId],
    );
    if (Number(active.rows[0]?.count) > 0) return false;
    await client.query('update benchmark_runs set state=$2,updated_at=now() where id=$1', [runId, finalState]);
    await appendRunEvent(client, runId, eventType, { state: finalState });
    return true;
  });
}

export function finishPauseWhenDrained(runId: string): Promise<boolean> {
  return finishControlWhenDrained(runId, 'PAUSING', 'PAUSED', 'RUN_PAUSED');
}

export function finishStopWhenDrained(runId: string): Promise<boolean> {
  return finishControlWhenDrained(runId, 'STOPPING', 'STOPPED', 'RUN_STOPPED');
}

export async function recoverExpiredRunItemLeases(): Promise<number> {
  return withTransaction(async (client) => {
    const recovered = await client.query<{ benchmark_run_id: string; terminal: boolean }>(
      `update run_items set
         state = case when attempts >= max_attempts then 'TERMINAL_FAILED' else 'RETRY_WAIT' end,
         available_at = now(), lease_owner = null, lease_expires_at = null,
         error_code = 'LEASE_EXPIRED', error_message = '워커 임대가 만료되었습니다.'
       where state = 'LEASED' and lease_expires_at < now()
       returning benchmark_run_id, attempts >= max_attempts as terminal`,
    );
    const byRun = new Map<string, { count: number; terminal: number }>();
    for (const row of recovered.rows) {
      const current = byRun.get(row.benchmark_run_id) ?? { count: 0, terminal: 0 };
      current.count += 1; if (row.terminal) current.terminal += 1; byRun.set(row.benchmark_run_id, current);
    }
    for (const [runId, summary] of byRun) {
      if (summary.terminal) await client.query('update benchmark_runs set failed_items = failed_items + $2 where id = $1', [runId, summary.terminal]);
      await appendRunEvent(client, runId, 'RUN_ITEM_LEASES_RECOVERED', summary);
    }
    return recovered.rowCount ?? 0;
  });
}

export async function beginScoringWhenExecutionFinished(runId: string): Promise<boolean> {
  const outcome = await withTransaction(async (client) => {
    const result = await client.query<{
      total_items:number;
      completed_items:number;
      failed_items:number;
      state:RunState;
      score_profile_snapshot:{ metrics?:unknown; judgeProvider?:string | null; judgeModel?:string | null };
      score_profile_snapshot_provenance:string;
      scoring_engine_version_id:string | null;
      scoring_engine_snapshot:unknown;
      scoring_engine_snapshot_provenance:string;
    }>(
      `select total_items,completed_items,failed_items,state,
         score_profile_snapshot,score_profile_snapshot_provenance,
         scoring_engine_version_id,scoring_engine_snapshot,
         scoring_engine_snapshot_provenance
       from benchmark_runs where id=$1 for update`,
      [runId],
    );
    const run = result.rows[0];
    if (!run || run.state !== 'RUNNING' || run.completed_items + run.failed_items < run.total_items) return false;
    if (!isCurrentScoringEngineSnapshot({
      scoringEngineVersionId:run.scoring_engine_version_id,
      scoringEngineSnapshot:run.scoring_engine_snapshot,
      provenance:run.scoring_engine_snapshot_provenance,
    })) {
      await client.query(
        `update benchmark_runs
            set state='FAILED',
                last_scoring_error=$2::jsonb,
                updated_at=now()
          where id=$1`,
        [runId, JSON.stringify({
          code:'SCORING_ENGINE_REPLACEMENT_REQUIRED',
          message:scoringEngineReplacementRequiredMessage,
          attempts:0,
          replacementRequired:true,
          snapshotProvenance:run.scoring_engine_snapshot_provenance,
          at:new Date().toISOString(),
        })],
      );
      await appendRunEvent(
        client,
        runId,
        'RUN_SCORING_ENGINE_REPLACEMENT_REQUIRED',
        {
          previousState:run.state,
          state:'FAILED',
          snapshotProvenance:run.scoring_engine_snapshot_provenance,
          replacementRequired:true,
        },
      );
      return 'ENGINE_BLOCKED' as const;
    }
    if (!isRunScoreProfileUsable({
      judgeProvider:run.score_profile_snapshot?.judgeProvider,
      judgeModel:run.score_profile_snapshot?.judgeModel,
      metrics:run.score_profile_snapshot?.metrics,
      snapshotProvenance:run.score_profile_snapshot_provenance,
    })) {
      await client.query(
        `update benchmark_runs
         set state='FAILED',
           last_scoring_error=$2::jsonb,
           updated_at=now()
         where id=$1`,
        [runId, JSON.stringify({
          code:'SCORE_PROFILE_REPLACEMENT_REQUIRED',
          message:scoreProfileReplacementRequiredMessage,
          attempts:0,
          replacementRequired:true,
          snapshotProvenance:run.score_profile_snapshot_provenance,
          at:new Date().toISOString(),
        })],
      );
      const event = await client.query(
        `select 1 from job_events
         where aggregate_type='benchmark_run' and aggregate_id=$1
           and event_type='RUN_SCORE_PROFILE_REPLACEMENT_REQUIRED'
         limit 1`,
        [runId],
      );
      if (!event.rowCount) {
        await appendRunEvent(client, runId, 'RUN_SCORE_PROFILE_REPLACEMENT_REQUIRED', {
          previousState:run.state,
          state:'FAILED',
          snapshotProvenance:run.score_profile_snapshot_provenance,
          replacementRequired:true,
        });
      }
      return 'BLOCKED' as const;
    }
    await client.query("update benchmark_runs set state = 'SCORING', updated_at = now() where id = $1", [runId]);
    await appendRunEvent(client, runId, 'RUN_SCORING_STARTED', { completedItems: run.completed_items, failedItems: run.failed_items });
    return true;
  });
  if (outcome === 'BLOCKED') {
    throw new DomainError(
      'SCORE_PROFILE_REPLACEMENT_REQUIRED',
      scoreProfileReplacementRequiredMessage,
    );
  }
  if (outcome === 'ENGINE_BLOCKED') {
    throw new DomainError(
      'SCORING_ENGINE_REPLACEMENT_REQUIRED',
      scoringEngineReplacementRequiredMessage,
    );
  }
  return outcome;
}

export async function deferRunItemForProviderCooldown(
  itemId:string,
  workerId:string,
  cooldown:BenchmarkProviderCooldown,
):Promise<boolean> {
  return withTransaction(async (client) => {
    const locked = await client.query<{
      benchmark_run_id:string;
      provider_key:string;
      retrieval_mode:StoredBenchmarkRetrievalMode;
      attempts:number;
    }>(
      `select item.benchmark_run_id,model.provider_key,
         item.retrieval_mode,item.attempts
         from run_items item
         join run_models model on model.id=item.run_model_id
        where item.id=$1 and item.state='LEASED' and item.lease_owner=$2
        for update of item`,
      [itemId, workerId],
    );
    const item = locked.rows[0];
    if (!item) return false;
    const cooldownAppliesToItem = item.provider_key === cooldown.providerKey
      || (
        item.retrieval_mode === 'VECTOR'
        && cooldown.providerKey === 'gemini'
      );
    if (!cooldownAppliesToItem) {
      throw new DomainError(
        'RUN_ITEM_PROVIDER_MISMATCH',
        '실행 항목의 모델·검색 공급자와 활성 호출 제한 공급자가 일치하지 않습니다.',
      );
    }
    await client.query(
      `update run_items set
         state='RETRY_WAIT',
         attempts=greatest(attempts-1,0),
         available_at=$3,
         lease_owner=null,
         lease_expires_at=null,
         error_code='RATE_LIMIT_PAUSED',
         error_message=$4,
         completed_at=null
       where id=$1 and state='LEASED' and lease_owner=$2`,
      [
        itemId,
        workerId,
        cooldown.blockedUntil,
        cooldown.lastErrorMessage
          ?? `Provider cooldown active until ${cooldown.blockedUntil.toISOString()}`,
      ],
    );
    await appendRunEvent(client, item.benchmark_run_id, 'RUN_ITEM_RETRY_SCHEDULED', {
      itemId,
      providerKey:cooldown.providerKey,
      affectedScope:'PROVIDER_GLOBAL',
      sourceRunId:cooldown.sourceRunId,
      sourceRunItemId:cooldown.sourceRunItemId,
      sourcePhase:cooldown.sourcePhase,
      sourceModelId:cooldown.sourceModelId,
      rateLimitDimension:cooldown.rateLimitDimension,
      rateLimitScope:cooldown.rateLimitScope,
      retryAfterMs:cooldown.retryAfterMs,
      blockedUntil:cooldown.blockedUntil.toISOString(),
      resumeAt:cooldown.blockedUntil.toISOString(),
      automaticResume:true,
      attemptRestoredTo:Math.max(item.attempts - 1, 0),
    });
    return true;
  });
}

export async function finishCancellationWhenDrained(runId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const run = await client.query<{ state: RunState }>('select state from benchmark_runs where id = $1 for update', [runId]);
    if (run.rows[0]?.state !== 'CANCELLING') return false;
    await client.query("update run_items set state = 'CANCELLED', completed_at = now() where benchmark_run_id = $1 and state in ('PENDING','RETRY_WAIT')", [runId]);
    const active = await client.query<{ count: string }>("select count(*) from run_items where benchmark_run_id = $1 and state = 'LEASED'", [runId]);
    if (Number(active.rows[0]?.count) > 0) return false;
    await client.query("update benchmark_runs set state = 'CANCELLED', completed_at = now(), updated_at = now() where id = $1", [runId]);
    await appendRunEvent(client, runId, 'RUN_CANCELLED');
    return true;
  });
}

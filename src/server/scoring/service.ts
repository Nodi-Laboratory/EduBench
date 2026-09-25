import { z } from "zod";
import { DomainError } from '@/domain/errors';
import {
  isRunScoreProfileUsable,
  scoreProfileReplacementRequiredMessage,
} from '@/domain/score-profile';
import {
  type ScoringEngineDefinition,
  type ScoringEngineSnapshot,
  isCurrentScoringEngineSnapshot,
  scoringEngineReplacementRequiredMessage,
} from '@/domain/scoring-engine';
import { judgeMetricBatches, normalizeJudgeEvidence, normalizeJudgeScoreValue, normalizeJudgeText, normalizeKoreanAnswer, requiredMetricsForQuestion, selectJudgeScore, tokenCost } from "@/domain/scoring";
import { db } from "@/server/db/pool";
import { withTransaction } from "@/server/db/transaction";
import { createProviderForModel } from "@/server/providers/registry";
import type {
  GenerationRequest,
  ModelProvider,
  NormalizedGeneration,
} from '@/server/providers/types';
import { ProviderError } from '@/server/providers/types';
import {
  ActiveBenchmarkProviderCooldownError,
  findActiveBenchmarkProviderCooldown,
  markExpiredProviderCooldownsResumedForRun,
  registerBenchmarkProviderRateLimitWithClient,
} from '@/server/runs/provider-cooldown';
import {
  commitJudgeParse,
  commitJudgeResponse,
  failJudgeInvocationAndRecordRun,
  persistJudgeScores,
  reserveOrResumeJudgeInvocation,
  type JudgeInvocationRecord,
  type ParsedJudgeScore,
} from '@/server/scoring/invocations';

const judgmentSchema = z.object({
  scores: z.array(
    z.object({
      metricKey: z.string(),
      value: z.preprocess(normalizeJudgeScoreValue, z.number().min(0).max(1)),
      label: z.preprocess((value) => normalizeJudgeText(value, 'SCORED'), z.string()),
      rationale: z.preprocess((value) => normalizeJudgeText(value, '채점 모델이 설명을 생략했습니다.'), z.string()),
      evidence: z.preprocess(
        normalizeJudgeEvidence,
        z.array(
          z.object({
            claim: z.string().optional(),
            quote: z.string().optional(),
            chunkId: z.string().optional(),
          }),
        )).default([]),
    }),
  ),
});
function extractObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("JUDGE_PARSE_FAILED: 채점 응답에 JSON 객체가 없습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

type ScoreRow = {
  response_id: string;
  response_text: string;
  input_tokens: number | null;
  output_tokens: number | null;
  score_profile_id: string;
  price_profile_version: string;
  provider_key: string;
  model_id: string;
  question_text: string;
  answer_text: string;
  accepted_answers: unknown;
  scoring_criteria: unknown;
  quality_scores: unknown;
  evidence_mode: string;
  evidence: unknown;
  metrics: unknown;
  rubric_prompt: string | null;
  judge_provider: string | null;
  judge_model: string | null;
  scoring_engine_version_id: string;
  scoring_engine_snapshot: ScoringEngineSnapshot & {
    definition:ScoringEngineDefinition;
  };
};

type ParsedJudgment = z.infer<typeof judgmentSchema>;

function judgeFailureDetails(
  error: unknown,
  fallbackCode: string,
): { code:string; message:string } {
  const message = error instanceof Error ? error.message : String(error);
  const domainCode = error instanceof DomainError ? error.code : null;
  const messageCode = message.match(/^([A-Z][A-Z0-9_]+)(?::|\b)/)?.[1];
  return {
    code:domainCode ?? messageCode ?? fallbackCode,
    message:message || fallbackCode,
  };
}

const defaultJudgeTimeoutMs = 180_000;
const scoringControlPollMs = 200;
const maxJudgeResponseAttempts = 3;

function judgeTimeoutMs(): number {
  const configured = Number(process.env.JUDGE_TIMEOUT_MS ?? defaultJudgeTimeoutMs);
  if (!Number.isFinite(configured)) return defaultJudgeTimeoutMs;
  return Math.min(Math.max(Math.trunc(configured), 1_000), 3_600_000);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DomainError(
      'RUN_SCORING_CONTROL_REQUESTED',
      '채점 실행 제어 요청으로 Judge 호출을 중단했습니다.',
    );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function startScoringControlMonitor(runId: string): {
  signal:AbortSignal;
  stop:() => void;
} {
  const controller = new AbortController();
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    try {
      const state = await db.query<{ state:string }>(
        'select state from benchmark_runs where id=$1',
        [runId],
      );
      if (state.rows[0]?.state !== 'SCORING') {
        controller.abort(new DomainError(
          'RUN_SCORING_CONTROL_REQUESTED',
          `채점 실행 상태가 ${state.rows[0]?.state ?? 'NOT_FOUND'}(으)로 변경되어 현재 Judge 호출을 중단했습니다.`,
          { runId, state:state.rows[0]?.state ?? null },
        ));
      }
    } catch {
      // A monitoring query failure must not itself cancel an otherwise healthy
      // Judge request. The run-level retry path will handle database failures.
    } finally {
      polling = false;
    }
  }, scoringControlPollMs);
  timer.unref?.();
  return {
    signal:controller.signal,
    stop:() => clearInterval(timer),
  };
}

async function generateJudgeWithTimeout(input: {
  judge:ModelProvider;
  request:GenerationRequest;
  parentSignal?:AbortSignal;
  timeoutMs:number;
}): Promise<NormalizedGeneration> {
  throwIfAborted(input.parentSignal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(input.parentSignal!));
  input.parentSignal?.addEventListener('abort', forwardAbort, { once:true });
  const timeout = setTimeout(() => {
    controller.abort(new DomainError(
      'JUDGE_PROVIDER_TIMEOUT',
      `Judge 호출이 제한 시간 ${input.timeoutMs}ms를 초과했습니다.`,
      { timeoutMs:input.timeoutMs },
    ));
  }, input.timeoutMs);
  timeout.unref?.();
  try {
    return await input.judge.generate(input.request, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    clearTimeout(timeout);
    input.parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

function checkpointErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?:unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isRetryableCheckpointError(error: unknown): boolean {
  const code = checkpointErrorCode(error);
  if (
    code
    && (
      code.startsWith('08')
      || ['40001', '40P01', '55P03', '57P01', '57P02', '57P03'].includes(code)
    )
  ) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /connection terminated|connection reset|server closed the connection/i.test(message);
}

async function persistCheckpoint<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableCheckpointError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function parseJudgeResponse(text: string): ParsedJudgment {
  const parsed = judgmentSchema.parse(extractObject(text));
  const duplicated = parsed.scores
    .map((score) => score.metricKey)
    .find((metric, index, metrics) => metrics.indexOf(metric) !== index);
  if (duplicated) {
    throw new DomainError(
      'JUDGE_DUPLICATE_METRIC',
      `Judge 응답에 동일한 metricKey가 두 번 이상 있습니다: ${duplicated}`,
    );
  }
  return parsed;
}

function createJudgeRequest(
  row: ScoreRow,
  acceptedAnswers: string[],
  metrics: string[],
): {
  generationRequest:GenerationRequest;
  requestSnapshot:Record<string, unknown>;
  requestTimeoutMs:number;
} {
  const definition = row.scoring_engine_snapshot.definition;
  const promptPayload = {
    requiredMetrics:metrics,
    instruction:`scores 배열에 다음 metricKey를 각각 정확히 한 번씩 반환한다: ${metrics.join(', ')}. 다른 지표는 반환하지 않는다.`,
    rubricPrompt:row.rubric_prompt,
    question:row.question_text,
    referenceAnswer:row.answer_text,
    acceptedAnswers,
    scoringCriteria:row.scoring_criteria,
    benchmarkDesign:row.quality_scores && typeof row.quality_scores === 'object'
      ? (row.quality_scores as Record<string, unknown>).benchmarkDesign ?? null
      : null,
    prerequisiteMetricRubrics:definition.prerequisiteMetricRubrics,
    evidenceMode:row.evidence_mode,
    textbookEvidence:row.evidence,
    candidateResponse:row.response_text,
    outputSchema:{
      scores:metrics.map((metricKey) => ({
        metricKey,
        value:'0..1',
        label:'short',
        rationale:'Korean explanation',
        evidence:[],
      })),
    },
  };
  const generationRequest: GenerationRequest = {
    system:definition.judge.systemPrompt,
    prompt:JSON.stringify(promptPayload),
    maxOutputTokens:definition.judge.sampling.maxOutputTokens,
    temperature:definition.judge.sampling.temperature,
  };
  const requestTimeoutMs = judgeTimeoutMs();
  return {
    generationRequest,
    requestTimeoutMs,
    requestSnapshot:{
      system:generationRequest.system,
      prompt:generationRequest.prompt,
      promptPayload,
      maxOutputTokens:generationRequest.maxOutputTokens,
      temperature:generationRequest.temperature,
      requestTimeoutMs,
    },
  };
}

function exactScoresForInvocation(
  parsedResponse: Record<string, unknown> | null,
  resolvedMetricKeys: string[],
): ParsedJudgeScore[] {
  const judgment = judgmentSchema.parse(parsedResponse);
  return resolvedMetricKeys.map((metric) => {
    const score = selectJudgeScore(metric, judgment.scores);
    if (!score) {
      throw new DomainError(
        'JUDGE_PARSED_SCORE_MISSING',
        `저장된 파싱 결과에서 확정 metricKey를 찾을 수 없습니다: ${metric}`,
      );
    }
    return score;
  });
}

async function executeJudgeInvocation(input: {
  runId:string;
  row:ScoreRow;
  judge:ModelProvider;
  acceptedAnswers:string[];
  metrics:string[];
  invocationKind:'PRIMARY' | 'FALLBACK';
  parentInvocationId?:string;
  signal?:AbortSignal;
}): Promise<JudgeInvocationRecord> {
  throwIfAborted(input.signal);
  const request = createJudgeRequest(
    input.row,
    input.acceptedAnswers,
    input.metrics,
  );
  let reservation = await reserveOrResumeJudgeInvocation({
    benchmarkRunId:input.runId,
    modelResponseId:input.row.response_id,
    scoreProfileId:input.row.score_profile_id,
    scoringEngineVersionId:input.row.scoring_engine_version_id,
    invocationKind:input.invocationKind,
    parentInvocationId:input.parentInvocationId,
    requestedMetricKeys:input.metrics,
    requestSnapshot:request.requestSnapshot,
    providerKey:input.row.judge_provider!,
    modelId:input.row.judge_model!,
    // scoreRun owns the run-level advisory lock. A REQUESTED checkpoint
    // observed after acquiring it has no live in-process owner.
    staleAfterMs:0,
  });
  let invocation = reservation.invocation;

  if (reservation.nextAction === 'WAIT_FOR_REQUEST') {
    throw new DomainError(
      'JUDGE_INVOCATION_BUSY',
      'Judge 요청이 아직 다른 실행자에게 소유되어 있습니다.',
      { invocationId:invocation.id },
    );
  }
  if (reservation.nextAction === 'CALL_PROVIDER') {
    const activeCooldown = await findActiveBenchmarkProviderCooldown(
      input.judge.key,
    );
    if (activeCooldown) {
      const cooldownError =
        new ActiveBenchmarkProviderCooldownError(activeCooldown);
      try {
        await failJudgeInvocationAndRecordRun({
          invocationId:invocation.id,
          errorCode:'RATE_LIMIT',
          errorMessage:cooldownError.message,
          errorStage:'REQUEST',
        });
      } catch {
        // Preserve the active provider cooldown as the actionable outcome.
      }
      throw cooldownError;
    }
    let response: NormalizedGeneration;
    try {
      response = await generateJudgeWithTimeout({
        judge:input.judge,
        request:request.generationRequest,
        parentSignal:input.signal,
        timeoutMs:request.requestTimeoutMs,
      });
    } catch (error) {
      const failure =
        error instanceof ProviderError && error.kind === 'RATE_LIMIT'
          ? { code:'RATE_LIMIT', message:error.message }
          : judgeFailureDetails(error, 'JUDGE_PROVIDER_FAILED');
      try {
        await failJudgeInvocationAndRecordRun({
          invocationId:invocation.id,
          errorCode:failure.code,
          errorMessage:failure.message,
          errorStage:failure.code === 'RUN_SCORING_CONTROL_REQUESTED'
            ? 'RECOVERY'
            : 'PROVIDER',
        });
      } catch {
        // The original provider error is the actionable failure.
      }
      throw error;
    }
    invocation = await persistCheckpoint(() => commitJudgeResponse({
        invocationId:invocation.id,
        response,
      }));
    reservation = {
      invocation,
      created:reservation.created,
      nextAction:'PARSE_STORED_RESPONSE',
    };
  }

  if (reservation.nextAction === 'PARSE_STORED_RESPONSE') {
    let judgment: ParsedJudgment;
    try {
      judgment = parseJudgeResponse(invocation.responseText ?? '');
    } catch (error) {
      const failure = judgeFailureDetails(error, 'JUDGE_PARSE_FAILED');
      try {
        await failJudgeInvocationAndRecordRun({
          invocationId:invocation.id,
          errorCode:failure.code,
          errorMessage:failure.message,
          errorStage:'PARSE',
        });
      } catch {
        // Preserve the original parse/validation failure.
      }
      throw error;
    }
    const resolvedMetricKeys = input.metrics.filter(
      (metric) => judgment.scores.some((score) => score.metricKey === metric),
    );
    const missingMetricKeys = input.metrics.filter(
      (metric) => !resolvedMetricKeys.includes(metric),
    );
    invocation = await persistCheckpoint(() => commitJudgeParse({
        invocationId:invocation.id,
        parsedResponse:judgment,
        resolvedMetricKeys,
        missingMetricKeys,
      }));
    if (
      input.invocationKind === 'FALLBACK'
      && invocation.missingMetricKeys.length > 0
    ) {
      const error = new DomainError(
        'JUDGE_METRIC_MISSING',
        `${invocation.missingMetricKeys[0]} 지표가 fallback 채점 응답에 없습니다.`,
      );
      const failure = judgeFailureDetails(error, 'JUDGE_PARSE_FAILED');
      try {
        await failJudgeInvocationAndRecordRun({
          invocationId:invocation.id,
          errorCode:failure.code,
          errorMessage:failure.message,
          errorStage:'PARSE',
        });
      } catch {
        // Preserve the original parse/validation failure.
      }
      throw error;
    }
    reservation = {
      invocation,
      created:reservation.created,
      nextAction:'PERSIST_PARSED_SCORES',
    };
  }

  if (reservation.nextAction === 'PERSIST_PARSED_SCORES') {
    let scores: ParsedJudgeScore[];
    try {
      if (
        input.invocationKind === 'FALLBACK'
        && invocation.missingMetricKeys.length > 0
      ) {
        throw new DomainError(
          'JUDGE_METRIC_MISSING',
          `${invocation.missingMetricKeys[0]} 지표가 fallback 채점 응답에 없습니다.`,
        );
      }
      scores = exactScoresForInvocation(
        invocation.parsedResponse,
        invocation.resolvedMetricKeys,
      );
    } catch (error) {
      const failure = judgeFailureDetails(error, 'JUDGE_SCORE_PERSIST_FAILED');
      try {
        await failJudgeInvocationAndRecordRun({
          invocationId:invocation.id,
          errorCode:failure.code,
          errorMessage:failure.message,
          errorStage:'SCORE_PERSIST',
        });
      } catch {
        // Preserve the original persistence failure.
      }
      throw error;
    }
    const persisted = await persistCheckpoint(() => persistJudgeScores({
      invocationId:invocation.id,
      scores,
    }));
    invocation = persisted.invocation;
  }
  return invocation;
}

async function persistedFallbackParents(input: {
  responseId:string;
  scoreProfileId:string;
  scoringEngineVersionId:string;
  metrics:string[];
}): Promise<Map<string, string>> {
  if (!input.metrics.length) return new Map();
  const parents = await db.query<{
    id:string;
    missing_metric_keys:string[];
  }>(
    `select id,missing_metric_keys
     from judge_invocations
     where model_response_id=$1
       and score_profile_id=$2
       and scoring_engine_version_id=$3
       and invocation_kind='PRIMARY'
       and state='PERSISTED'
       and missing_metric_keys && $4::text[]
     order by persisted_at desc,id desc`,
    [
      input.responseId,
      input.scoreProfileId,
      input.scoringEngineVersionId,
      input.metrics,
    ],
  );
  const result = new Map<string, string>();
  for (const parent of parents.rows) {
    for (const metric of parent.missing_metric_keys) {
      if (input.metrics.includes(metric) && !result.has(metric)) {
        result.set(metric, parent.id);
      }
    }
  }
  return result;
}

async function terminalJudgeMetricKeys(input: {
  runId:string;
  responseId:string;
  scoreProfileId:string;
  scoringEngineVersionId:string;
}): Promise<Set<string>> {
  const terminal = await db.query<{ metric_key:string }>(
    `with latest as (
       select distinct on (invocation.logical_key)
         invocation.logical_key,
         invocation.state,
         invocation.error_code,
         invocation.requested_metric_keys
       from judge_invocations invocation
       where invocation.benchmark_run_id=$1
         and invocation.model_response_id=$2
         and invocation.score_profile_id=$3
         and invocation.scoring_engine_version_id=$4
       order by invocation.logical_key,invocation.attempt desc
     ),
     chargeable_failures as (
       select invocation.logical_key,count(*)::int attempts
       from judge_invocations invocation
       where invocation.benchmark_run_id=$1
         and invocation.model_response_id=$2
         and invocation.score_profile_id=$3
         and invocation.scoring_engine_version_id=$4
         and invocation.state='FAILED'
         and invocation.error_code <> 'RATE_LIMIT'
       group by invocation.logical_key
     )
     select distinct unnest(latest.requested_metric_keys) metric_key
       from latest
       join chargeable_failures
         on chargeable_failures.logical_key=latest.logical_key
      where latest.state='FAILED'
        and latest.error_code <> 'RATE_LIMIT'
        and chargeable_failures.attempts >= $5`,
    [
      input.runId,
      input.responseId,
      input.scoreProfileId,
      input.scoringEngineVersionId,
      maxJudgeResponseAttempts,
    ],
  );
  return new Set(terminal.rows.map((row) => row.metric_key));
}

async function recordJudgeResponseFailure(input: {
  runId:string;
  responseId:string;
  scoreProfileId:string;
  scoringEngineVersionId:string;
}): Promise<{ terminalMetricKeys: Set<string> } | null> {
  const failed = await db.query<{
    id:string;
    attempt:number;
    failure_attempt:number;
    requested_metric_keys:string[];
    error_code:string | null;
  }>(
    `select invocation.id,invocation.attempt,
       invocation.requested_metric_keys,invocation.error_code,
       (
         select count(*)::int
         from judge_invocations failure
         where failure.benchmark_run_id=invocation.benchmark_run_id
           and failure.model_response_id=invocation.model_response_id
           and failure.score_profile_id=invocation.score_profile_id
           and failure.scoring_engine_version_id=invocation.scoring_engine_version_id
           and failure.logical_key=invocation.logical_key
           and failure.state='FAILED'
           and failure.error_code <> 'RATE_LIMIT'
       ) failure_attempt
       from judge_invocations invocation
      where invocation.benchmark_run_id=$1
        and invocation.model_response_id=$2
        and invocation.score_profile_id=$3
        and invocation.scoring_engine_version_id=$4
        and invocation.state='FAILED'
      order by invocation.failed_at desc,invocation.id desc
      limit 1`,
    [
      input.runId,
      input.responseId,
      input.scoreProfileId,
      input.scoringEngineVersionId,
    ],
  );
  const invocation = failed.rows[0];
  if (!invocation) return null;

  const terminal =
    invocation.failure_attempt >= maxJudgeResponseAttempts;
  const retryDelayMs = terminal
    ? null
    : Math.min(
      2_000 * (2 ** (Math.max(invocation.failure_attempt, 1) - 1)),
      30_000,
    );
  const retryAt = retryDelayMs === null
    ? null
    : new Date(Date.now() + retryDelayMs).toISOString();
  const eventType = terminal
    ? 'RUN_SCORE_RESPONSE_TERMINAL_FAILED'
    : 'RUN_SCORE_RESPONSE_RETRY_SCHEDULED';
  await withTransaction(async (client) => {
    const run = await client.query<{ state:string }>(
      'select state from benchmark_runs where id=$1 for update',
      [input.runId],
    );
    if (run.rows[0]?.state !== 'SCORING') return;
    if (!terminal) {
      await client.query(
        `update benchmark_runs
            set last_scoring_error=$2::jsonb,updated_at=now()
          where id=$1`,
        [input.runId, JSON.stringify({
          code:invocation.error_code ?? 'JUDGE_RESPONSE_FAILED',
          attempts:0,
          retryable:true,
          retryDelayMs,
          retryAt,
          modelResponseId:input.responseId,
          judgeInvocationId:invocation.id,
          at:new Date().toISOString(),
        })],
      );
    }
    await client.query(
      `insert into job_events(aggregate_type,aggregate_id,event_type,payload)
       select 'benchmark_run',$1,$2,$3::jsonb
       where not exists(
         select 1 from job_events
          where aggregate_type='benchmark_run'
            and aggregate_id=$1
            and event_type=$2
            and payload->>'judgeInvocationId'=$4
       )`,
      [input.runId, eventType, JSON.stringify({
        modelResponseId:input.responseId,
        judgeInvocationId:invocation.id,
        attempt:invocation.failure_attempt,
        invocationAttempt:invocation.attempt,
        metricKeys:invocation.requested_metric_keys,
        code:invocation.error_code ?? 'JUDGE_RESPONSE_FAILED',
        ...(terminal ? {} : { retryDelayMs, retryAt }),
      }), invocation.id],
    );
  });
  return {
    terminalMetricKeys:terminal
      ? new Set(invocation.requested_metric_keys)
      : new Set(),
  };
}

async function scoreClaimedRun(
  runId: string,
  signal?: AbortSignal,
): Promise<{ scoredResponses: number }> {
  throwIfAborted(signal);
  const rows = await db.query<ScoreRow>(
    `select mr.id response_id,mr.response_text,mr.input_tokens,mr.output_tokens,
    br.score_profile_id,br.price_profile_version,rm.provider_key,rm.model_id,q.evidence_mode,
    br.scoring_engine_version_id,br.scoring_engine_snapshot,
    qr.question_text,qr.answer_text,qr.accepted_answers,qr.scoring_criteria,qr.quality_scores,
    br.score_profile_snapshot->'metrics' metrics,
    br.score_profile_snapshot->>'rubricPrompt' rubric_prompt,
    br.score_profile_snapshot->>'judgeProvider' judge_provider,
    br.score_profile_snapshot->>'judgeModel' judge_model,
    coalesce((select jsonb_agg(jsonb_build_object('chunkId',qe.source_chunk_id,'quote',qe.quote_text) order by qe.ordinal) from question_evidence qe where qe.question_id=ri.question_id and qe.question_revision=ri.question_revision),'[]'::jsonb) evidence
    from benchmark_runs br join run_items ri on ri.benchmark_run_id=br.id
    join run_models rm on rm.id=ri.run_model_id join eligible_model_responses mr on mr.run_item_id=ri.id
    join questions q on q.id=ri.question_id join question_revisions qr on qr.question_id=ri.question_id and qr.revision=ri.question_revision where br.id=$1`,
    [runId],
  );
  let scoredResponses = 0;
  let retryScheduled = false;
  for (const row of rows.rows) {
    throwIfAborted(signal);
    const profileMetrics = Array.isArray(row.metrics)
      ? row.metrics.map(String)
      : [];
    const required = requiredMetricsForQuestion(profileMetrics, row.quality_scores);
    const existing = await db.query<{ metric_key: string }>(
      "select metric_key from scores where model_response_id=$1 and score_profile_id=$2",
      [row.response_id, row.score_profile_id],
    );
    const missing = new Set(
      required.filter(
        (metric) =>
          !existing.rows.some((stored) => stored.metric_key === metric),
      ),
    );
    const accepted = Array.isArray(row.accepted_answers)
      ? row.accepted_answers.map(String)
      : [];
    accepted.push(row.answer_text);
    await withTransaction(async (client) => {
      if (missing.has("response_present")) {
        const value =
          normalizeKoreanAnswer(row.response_text).length > 0 ? 1 : 0;
        await client.query(
          `insert into scores(
             model_response_id,score_profile_id,metric_key,value,label,
             rationale,provenance
           ) values(
             $1,$2,'response_present',$3,$4,'응답 텍스트 존재 여부',
             'DETERMINISTIC_ENGINE_VERIFIED'
           ) on conflict do nothing`,
          [
            row.response_id,
            row.score_profile_id,
            value,
            value ? "PRESENT" : "EMPTY",
          ],
        );
      }
    });
    let terminalMetrics = await terminalJudgeMetricKeys({
      runId,
      responseId:row.response_id,
      scoreProfileId:row.score_profile_id,
      scoringEngineVersionId:row.scoring_engine_version_id,
    });
    let responseRetryScheduled = false;
    const judgeMetrics = required.filter(
      (metric) =>
        missing.has(metric) &&
        metric !== "response_present" &&
        !terminalMetrics.has(metric),
    );
    if (judgeMetrics.length) {
      if (!row.judge_provider || !row.judge_model)
        throw new Error(
          `SCORING_JUDGE_NOT_CONFIGURED: ${judgeMetrics.join(",")} 지표에는 judge_provider와 judge_model이 모두 필요합니다.`,
        );
      const judge = createProviderForModel(row.judge_provider, row.judge_model);
      if (!judge)
        throw new Error(
          `SCORING_JUDGE_NOT_CONFIGURED: ${row.judge_provider} 환경변수가 필요합니다.`,
        );
      try {
        const priorParents = await persistedFallbackParents({
          responseId:row.response_id,
          scoreProfileId:row.score_profile_id,
          scoringEngineVersionId:row.scoring_engine_version_id,
          metrics:judgeMetrics,
        });
        for (const [metric, parentInvocationId] of priorParents) {
          await executeJudgeInvocation({
            runId,
            row,
            judge,
            acceptedAnswers:accepted,
            metrics:[metric],
            invocationKind:'FALLBACK',
            parentInvocationId,
            signal,
          });
        }
        const primaryMetrics = judgeMetrics.filter(
          (metric) => !priorParents.has(metric),
        );
        for (const metrics of judgeMetricBatches(primaryMetrics)) {
          const primary = await executeJudgeInvocation({
            runId,
            row,
            judge,
            acceptedAnswers:accepted,
            metrics,
            invocationKind:'PRIMARY',
            signal,
          });
          for (const metric of primary.missingMetricKeys) {
            await executeJudgeInvocation({
              runId,
              row,
              judge,
              acceptedAnswers:accepted,
              metrics:[metric],
              invocationKind:'FALLBACK',
              parentInvocationId:primary.id,
              signal,
            });
          }
        }
      } catch (error) {
        throwIfAborted(signal);
        if (
          error instanceof ActiveBenchmarkProviderCooldownError
          || (error instanceof ProviderError && error.kind === 'RATE_LIMIT')
        ) throw error;
        const recorded = await recordJudgeResponseFailure({
          runId,
          responseId:row.response_id,
          scoreProfileId:row.score_profile_id,
          scoringEngineVersionId:row.scoring_engine_version_id,
        });
        if (!recorded) throw error;
        terminalMetrics = new Set([
          ...terminalMetrics,
          ...recorded.terminalMetricKeys,
        ]);
        responseRetryScheduled = recorded.terminalMetricKeys.size === 0;
        retryScheduled ||= responseRetryScheduled;
      }
    }
    const price = await db.query<{
      input_per_million: string;
      output_per_million: string;
      currency: string;
      krw_exchange_rate: string | null;
    }>(
      `select input_per_million,output_per_million,currency,krw_exchange_rate from price_profiles where version=$1 and provider_key=$2 and $3 like model_pattern order by valid_from desc limit 1`,
      [row.price_profile_version, row.provider_key, row.model_id],
    );
    if (
      price.rows[0] &&
      row.input_tokens != null &&
      row.output_tokens != null
    ) {
      const native = tokenCost({
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        inputPerMillion: Number(price.rows[0].input_per_million),
        outputPerMillion: Number(price.rows[0].output_per_million),
      });
      await db.query(
        "update model_responses set cost_native=$2,cost_currency=$3,cost_krw=$4 where id=$1",
        [
          row.response_id,
          native,
          price.rows[0].currency,
          price.rows[0].krw_exchange_rate
            ? native * Number(price.rows[0].krw_exchange_rate)
            : null,
        ],
      );
    }
    if (responseRetryScheduled) continue;
    await withTransaction(async (client) => {
      const scoreSet = await client.query<{ metric_key:string }>(
        `select metric_key
         from scores
         where model_response_id=$1 and score_profile_id=$2`,
        [row.response_id, row.score_profile_id],
      );
      const stored = new Set(scoreSet.rows.map((score) => score.metric_key));
      const incompleteMetrics = required.filter(
        (metric) => !stored.has(metric) && !terminalMetrics.has(metric),
      );
      if (incompleteMetrics.length > 0) {
        throw new DomainError(
          'SCORING_INCOMPLETE',
          '응답의 필수 채점 지표가 모두 저장되지 않았습니다.',
          { modelResponseId:row.response_id },
        );
      }
      const responseComplete = required.every((metric) => stored.has(metric));
      if (responseComplete) {
        await client.query(
          `insert into job_events(
             aggregate_type,aggregate_id,event_type,payload
           )
           select 'benchmark_run',$1,'RUN_SCORE_UPDATED',$2::jsonb
           where not exists (
             select 1 from job_events
             where aggregate_type='benchmark_run'
               and aggregate_id=$1
               and event_type='RUN_SCORE_UPDATED'
               and payload->>'modelResponseId'=$3
               and payload->>'responseComplete'='true'
           )`,
          [
            runId,
            JSON.stringify({
              modelResponseId:row.response_id,
              responseComplete:true,
              metricKeys:required,
              scoreCount:scoreSet.rows.length,
            }),
            row.response_id,
          ],
        );
      }
    });
    if (required.every((metric) => !terminalMetrics.has(metric))) {
      scoredResponses += 1;
    }
  }
  throwIfAborted(signal);
  if (retryScheduled) return { scoredResponses };
  const terminalMetricsByResponse = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    terminalMetricsByResponse.set(row.response_id, await terminalJudgeMetricKeys({
      runId,
      responseId:row.response_id,
      scoreProfileId:row.score_profile_id,
      scoringEngineVersionId:row.scoring_engine_version_id,
    }));
  }
  const expectedScorePairs = rows.rows.reduce((total, row) => {
    const profileMetrics = Array.isArray(row.metrics) ? row.metrics.map(String) : [];
    const required = requiredMetricsForQuestion(profileMetrics, row.quality_scores);
    const terminalMetrics = terminalMetricsByResponse.get(row.response_id) ?? new Set();
    return total + required.filter((metric) => !terminalMetrics.has(metric)).length;
  }, 0);
  await withTransaction(async (client) => {
    const locked = await client.query<{
      state: string;
      responses: string;
      score_pairs: string;
    }>(
      `select br.state,
       (select count(*) from eligible_model_responses mr join run_items ri on ri.id=mr.run_item_id where ri.benchmark_run_id=br.id)::text responses,
       (select count(distinct s.model_response_id::text||':'||s.metric_key)
        from scores s
        join eligible_model_responses mr on mr.id=s.model_response_id
        join run_items ri on ri.id=mr.run_item_id
        where ri.benchmark_run_id=br.id
          and s.score_profile_id=br.score_profile_id
          and s.metric_key <> 'exact_match')::text score_pairs
       from benchmark_runs br where br.id=$1 for update of br`,
      [runId],
    );
    const run = locked.rows[0];
    if (run?.state === "SCORING") {
      if (Number(run.score_pairs) !== expectedScorePairs)
        throw new Error(
          "SCORING_INCOMPLETE: 모든 응답의 필수 지표가 저장되지 않았습니다.",
        );
      await client.query(
        "update benchmark_runs set state='COMPLETED',completed_at=now(),last_scoring_error=null,updated_at=now() where id=$1",
        [runId],
      );
      await client.query(
        `insert into job_events(aggregate_type,aggregate_id,event_type,payload) values('benchmark_run',$1,'RUN_COMPLETED',$2::jsonb)`,
        [
          runId,
          JSON.stringify({
            state: "COMPLETED",
            scoredResponses,
            requiredScorePairs: expectedScorePairs,
          }),
        ],
      );
    }
  });
  return { scoredResponses };
}

export async function scoreRun(
  runId: string,
  parentSignal?:AbortSignal,
): Promise<{ scoredResponses:number; claimed:boolean }> {
  const lockName = `edubench:score-run:${runId}`;
  throwIfAborted(parentSignal);
  const lockClient = await db.connect();
  let acquired = false;
  let releaseError: Error | undefined;
  try {
    throwIfAborted(parentSignal);
    const lock = await lockClient.query<{ acquired:boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) acquired',
      [lockName],
    );
    acquired = Boolean(lock.rows[0]?.acquired);
    if (!acquired) return { scoredResponses:0, claimed:false };

    const run = await lockClient.query<{
      state:string;
      score_profile_snapshot:{ metrics?:unknown; judgeProvider?:string | null; judgeModel?:string | null };
      score_profile_snapshot_provenance:string;
      scoring_engine_version_id:string | null;
      scoring_engine_snapshot:unknown;
      scoring_engine_snapshot_provenance:string;
    }>(
      `select state,score_profile_snapshot,score_profile_snapshot_provenance,
        scoring_engine_version_id,scoring_engine_snapshot,
        scoring_engine_snapshot_provenance
      from benchmark_runs where id=$1`,
      [runId],
    );
    if (!run.rows[0]) {
      throw new DomainError('RUN_NOT_FOUND', '실행을 찾을 수 없습니다.');
    }
    if (!isCurrentScoringEngineSnapshot({
      scoringEngineVersionId:run.rows[0].scoring_engine_version_id,
      scoringEngineSnapshot:run.rows[0].scoring_engine_snapshot,
      provenance:run.rows[0].scoring_engine_snapshot_provenance,
    })) {
      await recordScoringEngineReplacementRequired(runId);
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
    if (run.rows[0]?.state !== 'SCORING') {
      return { scoredResponses:0, claimed:false };
    }
    await withTransaction(async (client) => {
      await markExpiredProviderCooldownsResumedForRun(client, runId);
    });
    const judgeProvider =
      run.rows[0].score_profile_snapshot?.judgeProvider ?? null;
    if (
      judgeProvider
      && await findActiveBenchmarkProviderCooldown(
        judgeProvider,
        lockClient,
      )
    ) {
      return { scoredResponses:0, claimed:false };
    }
    const control = startScoringControlMonitor(runId);
    try {
      const signal = parentSignal
        ? AbortSignal.any([control.signal, parentSignal])
        : control.signal;
      const result = await scoreClaimedRun(runId, signal);
      return { ...result, claimed:true };
    } catch (error) {
      if (error instanceof ActiveBenchmarkProviderCooldownError) {
        return { scoredResponses:0, claimed:false };
      }
      const rateLimited =
        error instanceof ProviderError
        && error.kind === 'RATE_LIMIT';
      if (rateLimited) {
        await recordScoringFailure(runId, error);
      }
      if (parentSignal?.aborted) {
        return { scoredResponses:0, claimed:true };
      }
      if (
        !rateLimited
        && (
          !(error instanceof DomainError)
          || error.code !== 'RUN_SCORING_CONTROL_REQUESTED'
        )
      ) {
        await recordScoringFailure(runId, error);
      }
      throw error;
    } finally {
      control.stop();
    }
  } finally {
    if (acquired) {
      try {
        await lockClient.query(
          'select pg_advisory_unlock(hashtextextended($1, 0))',
          [lockName],
        );
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    lockClient.release(releaseError);
    if (releaseError) throw releaseError;
  }
}

async function recordScoringEngineReplacementRequired(runId: string): Promise<void> {
  await withTransaction(async (client) => {
    const locked = await client.query<{
      state:string;
      scoring_engine_snapshot_provenance:string;
    }>(
      `select state,scoring_engine_snapshot_provenance
         from benchmark_runs
        where id=$1
        for update`,
      [runId],
    );
    const run = locked.rows[0];
    if (!run || run.state !== 'SCORING') return;
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
    const existing = await client.query(
      `select 1
         from job_events
        where aggregate_type='benchmark_run'
          and aggregate_id=$1
          and event_type='RUN_SCORING_ENGINE_REPLACEMENT_REQUIRED'
        limit 1`,
      [runId],
    );
    if (!existing.rowCount) {
      await client.query(
        `insert into job_events(
           aggregate_type,aggregate_id,event_type,payload
         ) values(
           'benchmark_run',$1,
           'RUN_SCORING_ENGINE_REPLACEMENT_REQUIRED',$2::jsonb
         )`,
        [runId, JSON.stringify({
          previousState:'SCORING',
          state:'FAILED',
          snapshotProvenance:run.scoring_engine_snapshot_provenance,
          replacementRequired:true,
        })],
      );
    }
  });
}

export async function recordScoringFailure(runId: string, error: unknown): Promise<{ attempts: number; state: string }> {
  const message = (error instanceof Error ? error.message : '알 수 없는 채점 오류').slice(0, 1000);
  const code = judgeFailureDetails(error, 'SCORING_FAILED').code;
  return withTransaction(async (client) => {
    const locked = await client.query<{
      state:string;
      last_scoring_error:{ attempts?:number } | null;
      score_profile_snapshot:{
        judgeProvider?:string | null;
        judgeModel?:string | null;
      };
    }>(
      `select state,last_scoring_error,score_profile_snapshot
         from benchmark_runs where id=$1 for update`,
      [runId],
    );
    if (!locked.rows[0]) throw new DomainError('RUN_NOT_FOUND', '실행을 찾을 수 없습니다.');
    const previous = Number(locked.rows[0]?.last_scoring_error?.attempts ?? 0);
    const rateLimited =
      error instanceof ProviderError
      && error.kind === 'RATE_LIMIT';
    const judgeProvider =
      locked.rows[0].score_profile_snapshot?.judgeProvider ?? null;
    const judgeModel =
      locked.rows[0].score_profile_snapshot?.judgeModel ?? null;
    const cooldown = rateLimited && judgeProvider
      ? await registerBenchmarkProviderRateLimitWithClient(client, {
        providerKey:judgeProvider,
        error,
        sourceRunId:runId,
        sourcePhase:'SCORING_JUDGE',
        sourceModelId:judgeModel,
      })
      : null;
    if (locked.rows[0].state !== 'SCORING') {
      return { attempts:previous, state:locked.rows[0].state };
    }
    if (cooldown) {
      const failure = {
        code:'RATE_LIMIT',
        message,
        attempts:previous,
        retryable:true,
        retryDelayMs:cooldown.retryAfterMs,
        retryAt:cooldown.blockedUntil.toISOString(),
        rateLimitDimension:cooldown.rateLimitDimension,
        rateLimitScope:cooldown.rateLimitScope,
        affectedScope:'PROVIDER_GLOBAL',
        providerKey:cooldown.providerKey,
        requestId:cooldown.requestId,
        automaticResume:true,
        at:new Date().toISOString(),
      };
      await client.query(
        `update benchmark_runs set
           state='SCORING',
           last_scoring_error=$2::jsonb,
           updated_at=now()
         where id=$1`,
        [runId, JSON.stringify(failure)],
      );
      await client.query(
        `insert into job_events(
           aggregate_type,aggregate_id,event_type,payload
         ) values(
           'benchmark_run',$1,'RUN_SCORING_RATE_LIMITED',$2::jsonb
         )`,
        [runId, JSON.stringify({ ...failure, state:'SCORING' })],
      );
      return { attempts:previous, state:'SCORING' };
    }
    const attempts = previous + 1;
    const state = attempts >= 3 ? 'FAILED' : 'SCORING';
    const providerRetryAfterMs = error instanceof ProviderError
      ? error.retryAfterMs
      : null;
    const retryDelayMs = state === 'SCORING'
      ? Math.min(
        Math.max(providerRetryAfterMs ?? (2_000 * (2 ** (attempts - 1))), 500),
        30_000,
      )
      : null;
    const retryAt = retryDelayMs === null
      ? null
      : new Date(Date.now() + retryDelayMs).toISOString();
    const failure = {
      code,
      message,
      attempts,
      retryable:error instanceof ProviderError ? error.retryable : true,
      retryDelayMs,
      retryAt,
      at:new Date().toISOString(),
    };
    await client.query(
      `update benchmark_runs set state=$2,last_scoring_error=$3::jsonb,updated_at=now() where id=$1`,
      [runId, state, JSON.stringify(failure)],
    );
    await client.query(
      `insert into job_events(aggregate_type,aggregate_id,event_type,payload)
       values('benchmark_run',$1,'RUN_SCORING_FAILED',$2::jsonb)`,
      [runId, JSON.stringify({ ...failure, state })],
    );
    return { attempts, state };
  });
}

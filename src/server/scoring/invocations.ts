import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '@/domain/errors';
import type {
  JudgeInvocationKind,
  JudgeInvocationState,
} from '@/domain/scoring-engine';
import { withTransaction } from '@/server/db/transaction';
import type { NormalizedGeneration } from '@/server/providers/types';

export type JudgeInvocationNextAction =
  | 'CALL_PROVIDER'
  | 'WAIT_FOR_REQUEST'
  | 'PARSE_STORED_RESPONSE'
  | 'PERSIST_PARSED_SCORES'
  | 'COMPLETE';

export type JudgeInvocationRecord = {
  id: string;
  benchmarkRunId: string;
  modelResponseId: string;
  scoreProfileId: string;
  scoringEngineVersionId: string;
  parentInvocationId: string | null;
  invocationKind: JudgeInvocationKind;
  attempt: number;
  logicalKey: string;
  idempotencyKey: string;
  state: JudgeInvocationState;
  requestedMetricKeys: string[];
  resolvedMetricKeys: string[];
  missingMetricKeys: string[];
  requestSnapshot: Record<string, unknown>;
  requestHash: string;
  providerKey: string;
  modelId: string;
  providerRequestId: string | null;
  responseModelId: string | null;
  responseModelSnapshot: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  rawResponse: unknown;
  responseText: string | null;
  parsedResponse: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorStage: JudgeInvocationErrorStage | null;
  requestedAt: Date;
  responseReceivedAt: Date | null;
  parsedAt: Date | null;
  persistedAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
};

export type ReserveJudgeInvocationInput = {
  benchmarkRunId: string;
  modelResponseId: string;
  scoreProfileId: string;
  scoringEngineVersionId: string;
  parentInvocationId?: string | null;
  invocationKind: JudgeInvocationKind;
  requestedMetricKeys: string[];
  requestSnapshot: Record<string, unknown>;
  providerKey: string;
  modelId: string;
  staleAfterMs?: number;
};

export type ReserveJudgeInvocationResult = {
  invocation: JudgeInvocationRecord;
  created: boolean;
  nextAction: JudgeInvocationNextAction;
};

export type JudgeInvocationErrorStage =
  | 'REQUEST'
  | 'PROVIDER'
  | 'RESPONSE_PERSIST'
  | 'PARSE'
  | 'SCORE_PERSIST'
  | 'RECOVERY';

export type ParsedJudgeScore = {
  metricKey: string;
  value: number;
  label: string;
  rationale: string;
  evidence?: unknown;
};

type JudgeInvocationRow = {
  id: string;
  benchmark_run_id: string;
  model_response_id: string;
  score_profile_id: string;
  scoring_engine_version_id: string;
  parent_invocation_id: string | null;
  invocation_kind: JudgeInvocationKind;
  attempt: number;
  logical_key: string;
  idempotency_key: string;
  state: JudgeInvocationState;
  requested_metric_keys: string[];
  resolved_metric_keys: string[];
  missing_metric_keys: string[];
  request_snapshot: Record<string, unknown>;
  request_hash: string;
  provider_key: string;
  model_id: string;
  provider_request_id: string | null;
  response_model_id: string | null;
  response_model_snapshot: string | null;
  finish_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  raw_response: unknown;
  response_text: string | null;
  parsed_response: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  error_stage: JudgeInvocationErrorStage | null;
  requested_at: Date;
  response_received_at: Date | null;
  parsed_at: Date | null;
  persisted_at: Date | null;
  failed_at: Date | null;
  updated_at: Date;
  is_stale?: boolean;
};

const defaultRequestStaleAfterMs = 5 * 60_000;

function invocationFromRow(row: JudgeInvocationRow): JudgeInvocationRecord {
  return {
    id:row.id,
    benchmarkRunId:row.benchmark_run_id,
    modelResponseId:row.model_response_id,
    scoreProfileId:row.score_profile_id,
    scoringEngineVersionId:row.scoring_engine_version_id,
    parentInvocationId:row.parent_invocation_id,
    invocationKind:row.invocation_kind,
    attempt:row.attempt,
    logicalKey:row.logical_key,
    idempotencyKey:row.idempotency_key,
    state:row.state,
    requestedMetricKeys:row.requested_metric_keys,
    resolvedMetricKeys:row.resolved_metric_keys,
    missingMetricKeys:row.missing_metric_keys,
    requestSnapshot:row.request_snapshot,
    requestHash:row.request_hash,
    providerKey:row.provider_key,
    modelId:row.model_id,
    providerRequestId:row.provider_request_id,
    responseModelId:row.response_model_id,
    responseModelSnapshot:row.response_model_snapshot,
    finishReason:row.finish_reason,
    inputTokens:row.input_tokens,
    outputTokens:row.output_tokens,
    latencyMs:row.latency_ms,
    rawResponse:row.raw_response,
    responseText:row.response_text,
    parsedResponse:row.parsed_response,
    errorCode:row.error_code,
    errorMessage:row.error_message,
    errorStage:row.error_stage,
    requestedAt:row.requested_at,
    responseReceivedAt:row.response_received_at,
    parsedAt:row.parsed_at,
    persistedAt:row.persisted_at,
    failedAt:row.failed_at,
    updatedAt:row.updated_at,
  };
}

function validateMetricKeys(
  metricKeys: string[],
  options: { allowEmpty?:boolean } = {},
): void {
  if (!options.allowEmpty && metricKeys.length === 0) {
    throw new DomainError(
      'JUDGE_METRICS_REQUIRED',
      'Judge 호출에는 하나 이상의 metricKey가 필요합니다.',
    );
  }
  if (
    metricKeys.some(
      (metric) => typeof metric !== 'string'
        || metric.length === 0
        || metric.trim() !== metric,
    )
  ) {
    throw new DomainError(
      'JUDGE_METRIC_KEY_INVALID',
      'metricKey는 앞뒤 공백이 없는 비어 있지 않은 문자열이어야 합니다.',
    );
  }
  if (new Set(metricKeys).size !== metricKeys.length) {
    throw new DomainError(
      'JUDGE_METRIC_KEY_DUPLICATE',
      'Judge metricKey는 중복될 수 없습니다.',
    );
  }
}

function sortedMetricKeys(metricKeys: string[]): string[] {
  return [...metricKeys].sort();
}

function sameMetricSet(left: string[], right: string[]): boolean {
  const sortedLeft = sortedMetricKeys(left);
  const sortedRight = sortedMetricKeys(right);
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((metric, index) => metric === sortedRight[index]);
}

function logicalInvocationKey(input: {
  invocationKind:JudgeInvocationKind;
  parentInvocationId:string | null;
  metricKeys:string[];
}): string {
  return JSON.stringify({
    invocationKind:input.invocationKind,
    parentInvocationId:input.parentInvocationId,
    metricKeys:sortedMetricKeys(input.metricKeys),
  });
}

function invocationIdempotencyKey(input: {
  modelResponseId:string;
  scoreProfileId:string;
  scoringEngineVersionId:string;
  logicalKey:string;
  attempt:number;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return `judge:${digest}:${input.attempt}`;
}

function serializeJson(value: unknown, code: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new DomainError(code, 'JSON으로 기록할 수 없는 값입니다.');
  }
  return serialized;
}

function nextActionFor(
  state: JudgeInvocationState,
): Exclude<JudgeInvocationNextAction, 'CALL_PROVIDER'> {
  switch (state) {
    case 'REQUESTED':
      return 'WAIT_FOR_REQUEST';
    case 'RESPONSE_RECEIVED':
      return 'PARSE_STORED_RESPONSE';
    case 'PARSED':
      return 'PERSIST_PARSED_SCORES';
    case 'PERSISTED':
      return 'COMPLETE';
    case 'FAILED':
      throw new DomainError(
        'JUDGE_INVOCATION_FAILED',
        '실패한 Judge 호출은 새 시도로 예약해야 합니다.',
      );
  }
}

async function appendBenchmarkEvent(
  client: PoolClient,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into job_events(
       aggregate_type,aggregate_id,event_type,payload
     ) values('benchmark_run',$1,$2,$3::jsonb)`,
    [runId, eventType, JSON.stringify(payload)],
  );
}

async function selectInvocationForUpdate(
  client: PoolClient,
  invocationId: string,
): Promise<JudgeInvocationRow> {
  const selected = await client.query<JudgeInvocationRow>(
    'select * from judge_invocations where id=$1 for update',
    [invocationId],
  );
  if (!selected.rows[0]) {
    throw new DomainError(
      'JUDGE_INVOCATION_NOT_FOUND',
      'Judge 호출 기록을 찾을 수 없습니다.',
      { invocationId },
    );
  }
  return selected.rows[0];
}

function assertResumeContext(
  row: JudgeInvocationRow,
  input: ReserveJudgeInvocationInput,
): void {
  const parentInvocationId = input.parentInvocationId ?? null;
  if (
    row.benchmark_run_id !== input.benchmarkRunId
    || row.invocation_kind !== input.invocationKind
    || row.parent_invocation_id !== parentInvocationId
    || row.provider_key !== input.providerKey
    || row.model_id !== input.modelId
    || !sameMetricSet(
      row.requested_metric_keys,
      input.requestedMetricKeys,
    )
  ) {
    throw new DomainError(
      'JUDGE_INVOCATION_CONTEXT_MISMATCH',
      '기존 Judge 호출의 고정 컨텍스트가 재개 요청과 일치하지 않습니다.',
      { invocationId:row.id },
    );
  }
}

export async function reserveOrResumeJudgeInvocation(
  input: ReserveJudgeInvocationInput,
): Promise<ReserveJudgeInvocationResult> {
  validateMetricKeys(input.requestedMetricKeys);
  if (
    !input.requestSnapshot
    || typeof input.requestSnapshot !== 'object'
    || Array.isArray(input.requestSnapshot)
  ) {
    throw new DomainError(
      'JUDGE_REQUEST_SNAPSHOT_INVALID',
      'Judge 요청 스냅샷은 JSON 객체여야 합니다.',
    );
  }
  if (
    input.invocationKind === 'FALLBACK'
    && (
      !input.parentInvocationId
      || input.requestedMetricKeys.length !== 1
    )
  ) {
    throw new DomainError(
      'JUDGE_FALLBACK_CONTEXT_INVALID',
      'Fallback 호출은 완료된 primary 호출과 하나의 metricKey가 필요합니다.',
    );
  }
  if (
    input.invocationKind === 'PRIMARY'
    && input.parentInvocationId != null
  ) {
    throw new DomainError(
      'JUDGE_PRIMARY_CONTEXT_INVALID',
      'Primary 호출에는 parentInvocationId를 지정할 수 없습니다.',
    );
  }
  const staleAfterMs = input.staleAfterMs
    ?? defaultRequestStaleAfterMs;
  if (
    !Number.isSafeInteger(staleAfterMs)
    || staleAfterMs < 0
  ) {
    throw new DomainError(
      'JUDGE_STALE_WINDOW_INVALID',
      'staleAfterMs는 0 이상의 안전한 정수여야 합니다.',
    );
  }
  const logicalKey = logicalInvocationKey({
    invocationKind:input.invocationKind,
    parentInvocationId:input.parentInvocationId ?? null,
    metricKeys:input.requestedMetricKeys,
  });
  const requestSnapshot = serializeJson(
    input.requestSnapshot,
    'JUDGE_REQUEST_SNAPSHOT_INVALID',
  );

  return withTransaction(async (client) => {
    const reservationLock = [
      'edubench:judge-reservation',
      input.modelResponseId,
      input.scoreProfileId,
      input.scoringEngineVersionId,
      logicalKey,
    ].join(':');
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [reservationLock],
    );
    const response = await client.query<{ id:string }>(
      'select id from model_responses where id=$1',
      [input.modelResponseId],
    );
    if (!response.rows[0]) {
      throw new DomainError(
        'MODEL_RESPONSE_NOT_FOUND',
        'Judge 호출 대상 모델 응답을 찾을 수 없습니다.',
        { modelResponseId:input.modelResponseId },
      );
    }

    const existing = await client.query<JudgeInvocationRow>(
      `select invocation.*,
         invocation.updated_at
           <= now() - ($5::bigint * interval '1 millisecond')
           as is_stale
       from judge_invocations invocation
       where invocation.model_response_id=$1
         and invocation.score_profile_id=$2
         and invocation.scoring_engine_version_id=$3
         and invocation.logical_key=$4
       order by invocation.attempt desc
       limit 1
       for update`,
      [
        input.modelResponseId,
        input.scoreProfileId,
        input.scoringEngineVersionId,
        logicalKey,
        staleAfterMs,
      ],
    );
    const latest = existing.rows[0];
    if (latest && latest.state !== 'FAILED') {
      assertResumeContext(latest, input);
    }
    if (
      latest
      && latest.state !== 'FAILED'
      && !(latest.state === 'REQUESTED' && latest.is_stale)
    ) {
      return {
        invocation:invocationFromRow(latest),
        created:false,
        nextAction:nextActionFor(latest.state),
      };
    }

    if (
      latest?.state === 'REQUESTED'
      && latest.is_stale
    ) {
      const message = '이전 Judge 요청의 외부 API 처리 여부를 확인할 수 없어 새 시도로 전환합니다.';
      const failed = await client.query<JudgeInvocationRow>(
        `update judge_invocations
         set state='FAILED',
           error_code='REQUEST_OUTCOME_UNKNOWN',
           error_message=$2,
           error_stage='RECOVERY',
           failed_at=now()
         where id=$1 and state='REQUESTED'
         returning *`,
        [latest.id, message],
      );
      if (!failed.rows[0]) {
        throw new DomainError(
          'JUDGE_INVOCATION_RESERVATION_RACE',
          'Judge 호출 상태가 예약 처리 중 변경되었습니다.',
          { invocationId:latest.id },
        );
      }
      await appendBenchmarkEvent(
        client,
        latest.benchmark_run_id,
        'JUDGE_INVOCATION_FAILED',
        {
          invocationId:latest.id,
          modelResponseId:latest.model_response_id,
          invocationKind:latest.invocation_kind,
          attempt:latest.attempt,
          code:'REQUEST_OUTCOME_UNKNOWN',
          stage:'RECOVERY',
          message,
        },
      );
    }

    const attempt = (latest?.attempt ?? 0) + 1;
    const inserted = await client.query<JudgeInvocationRow>(
      `insert into judge_invocations(
         benchmark_run_id,model_response_id,score_profile_id,
         scoring_engine_version_id,parent_invocation_id,invocation_kind,
         attempt,logical_key,idempotency_key,requested_metric_keys,
         request_snapshot,provider_key,model_id
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::jsonb,$12,$13
       )
       returning *`,
      [
        input.benchmarkRunId,
        input.modelResponseId,
        input.scoreProfileId,
        input.scoringEngineVersionId,
        input.parentInvocationId ?? null,
        input.invocationKind,
        attempt,
        logicalKey,
        invocationIdempotencyKey({
          modelResponseId:input.modelResponseId,
          scoreProfileId:input.scoreProfileId,
          scoringEngineVersionId:input.scoringEngineVersionId,
          logicalKey,
          attempt,
        }),
        input.requestedMetricKeys,
        requestSnapshot,
        input.providerKey,
        input.modelId,
      ],
    );
    const invocation = inserted.rows[0]!;
    await appendBenchmarkEvent(
      client,
      invocation.benchmark_run_id,
      'JUDGE_INVOCATION_REQUESTED',
      {
        invocationId:invocation.id,
        modelResponseId:invocation.model_response_id,
        invocationKind:invocation.invocation_kind,
        attempt:invocation.attempt,
        metricKeys:invocation.requested_metric_keys,
      },
    );
    return {
      invocation:invocationFromRow(invocation),
      created:true,
      nextAction:'CALL_PROVIDER',
    };
  });
}

export async function commitJudgeResponse(input: {
  invocationId:string;
  response:NormalizedGeneration;
}): Promise<JudgeInvocationRecord> {
  if (!input.response.modelId.trim()) {
    throw new DomainError(
      'JUDGE_RESPONSE_MODEL_REQUIRED',
      'Judge 응답에는 실제 응답 모델 ID가 필요합니다.',
    );
  }
  if (
    !Number.isSafeInteger(input.response.latencyMs)
    || input.response.latencyMs < 0
  ) {
    throw new DomainError(
      'JUDGE_RESPONSE_LATENCY_INVALID',
      'Judge 응답 지연 시간은 0 이상의 안전한 정수여야 합니다.',
    );
  }
  const rawResponse = serializeJson(
    input.response.raw,
    'JUDGE_RAW_RESPONSE_INVALID',
  );

  return withTransaction(async (client) => {
    const current = await selectInvocationForUpdate(
      client,
      input.invocationId,
    );
    if (
      current.state === 'RESPONSE_RECEIVED'
      || current.state === 'PARSED'
      || current.state === 'PERSISTED'
    ) {
      return invocationFromRow(current);
    }
    if (current.state !== 'REQUESTED') {
      throw new DomainError(
        'JUDGE_RESPONSE_TRANSITION_INVALID',
        `Judge 응답을 ${current.state} 상태에 저장할 수 없습니다.`,
        { invocationId:current.id, state:current.state },
      );
    }

    const updated = await client.query<JudgeInvocationRow>(
      `update judge_invocations
       set state='RESPONSE_RECEIVED',
         provider_request_id=$2,
         response_model_id=$3,
         response_model_snapshot=$4,
         finish_reason=$5,
         input_tokens=$6,
         output_tokens=$7,
         latency_ms=$8,
         raw_response=$9::jsonb,
         response_text=$10,
         response_received_at=now()
       where id=$1 and state='REQUESTED'
       returning *`,
      [
        current.id,
        input.response.requestId,
        input.response.modelId,
        input.response.modelSnapshot,
        input.response.finishReason,
        input.response.inputTokens,
        input.response.outputTokens,
        input.response.latencyMs,
        rawResponse,
        input.response.text,
      ],
    );
    const invocation = updated.rows[0]!;
    await appendBenchmarkEvent(
      client,
      invocation.benchmark_run_id,
      'JUDGE_RESPONSE_RECEIVED',
      {
        invocationId:invocation.id,
        modelResponseId:invocation.model_response_id,
        invocationKind:invocation.invocation_kind,
        attempt:invocation.attempt,
        metricKeys:invocation.requested_metric_keys,
        providerRequestId:invocation.provider_request_id,
        responseModelId:invocation.response_model_id,
        finishReason:invocation.finish_reason,
        inputTokens:invocation.input_tokens,
        outputTokens:invocation.output_tokens,
        latencyMs:invocation.latency_ms,
      },
    );
    return invocationFromRow(invocation);
  });
}

export async function commitJudgeParse(input: {
  invocationId:string;
  parsedResponse:Record<string, unknown>;
  resolvedMetricKeys:string[];
  missingMetricKeys:string[];
}): Promise<JudgeInvocationRecord> {
  validateMetricKeys(input.resolvedMetricKeys, { allowEmpty:true });
  validateMetricKeys(input.missingMetricKeys, { allowEmpty:true });
  if (
    !input.parsedResponse
    || typeof input.parsedResponse !== 'object'
    || Array.isArray(input.parsedResponse)
  ) {
    throw new DomainError(
      'JUDGE_PARSED_RESPONSE_INVALID',
      'Judge 파싱 결과는 JSON 객체여야 합니다.',
    );
  }
  const serialized = serializeJson(
    input.parsedResponse,
    'JUDGE_PARSED_RESPONSE_INVALID',
  );

  return withTransaction(async (client) => {
    const current = await selectInvocationForUpdate(
      client,
      input.invocationId,
    );
    if (current.state === 'PARSED' || current.state === 'PERSISTED') {
      return invocationFromRow(current);
    }
    if (current.state !== 'RESPONSE_RECEIVED') {
      throw new DomainError(
        'JUDGE_PARSE_TRANSITION_INVALID',
        `Judge 파싱 결과를 ${current.state} 상태에 저장할 수 없습니다.`,
        { invocationId:current.id, state:current.state },
      );
    }
    const combined = [
      ...input.resolvedMetricKeys,
      ...input.missingMetricKeys,
    ];
    if (
      new Set(combined).size !== combined.length
      || !sameMetricSet(combined, current.requested_metric_keys)
    ) {
      throw new DomainError(
        'JUDGE_PARSED_METRIC_SET_MISMATCH',
        'resolved와 missing metricKey는 요청 metricKey의 정확한 분할이어야 합니다.',
        { invocationId:current.id },
      );
    }

    const parsedScores = Array.isArray(input.parsedResponse.scores)
      ? input.parsedResponse.scores
      : [];
    const parsedMetricKeys = parsedScores.flatMap((score) => {
      if (
        !score
        || typeof score !== 'object'
        || Array.isArray(score)
        || typeof (score as Record<string, unknown>).metricKey !== 'string'
      ) return [];
      return [(score as { metricKey:string }).metricKey];
    });
    const resolvedAreExact = input.resolvedMetricKeys.every(
      (metric) => parsedMetricKeys.filter((candidate) => candidate === metric).length === 1,
    );
    const missingAreAbsent = input.missingMetricKeys.every(
      (metric) => !parsedMetricKeys.includes(metric),
    );
    if (!resolvedAreExact || !missingAreAbsent) {
      throw new DomainError(
        'JUDGE_PARSED_METRIC_SET_MISMATCH',
        '파싱된 점수와 resolved/missing metricKey가 정확히 일치하지 않습니다.',
        { invocationId:current.id },
      );
    }

    const updated = await client.query<JudgeInvocationRow>(
      `update judge_invocations
       set state='PARSED',
         parsed_response=$2::jsonb,
         resolved_metric_keys=$3::text[],
         missing_metric_keys=$4::text[],
         parsed_at=now()
       where id=$1 and state='RESPONSE_RECEIVED'
       returning *`,
      [
        current.id,
        serialized,
        input.resolvedMetricKeys,
        input.missingMetricKeys,
      ],
    );
    const invocation = updated.rows[0]!;
    await appendBenchmarkEvent(
      client,
      invocation.benchmark_run_id,
      'JUDGE_RESPONSE_PARSED',
      {
        invocationId:invocation.id,
        modelResponseId:invocation.model_response_id,
        invocationKind:invocation.invocation_kind,
        attempt:invocation.attempt,
        resolvedMetricKeys:invocation.resolved_metric_keys,
        missingMetricKeys:invocation.missing_metric_keys,
      },
    );
    return invocationFromRow(invocation);
  });
}

function validateScores(scores: ParsedJudgeScore[]): void {
  const metricKeys = scores.map((score) => score.metricKey);
  validateMetricKeys(metricKeys, { allowEmpty:true });
  if (
    scores.some(
      (score) => !Number.isFinite(score.value)
        || score.value < 0
        || score.value > 1
        || typeof score.label !== 'string'
        || typeof score.rationale !== 'string',
    )
  ) {
    throw new DomainError(
      'JUDGE_SCORE_INVALID',
      'Judge 점수는 0..1의 유한한 값과 문자열 label/rationale이 필요합니다.',
    );
  }
}

export async function persistJudgeScores(input: {
  invocationId:string;
  scores:ParsedJudgeScore[];
}): Promise<{
  invocation:JudgeInvocationRecord;
  insertedScores:number;
}> {
  validateScores(input.scores);
  return withTransaction(async (client) => {
    const current = await selectInvocationForUpdate(
      client,
      input.invocationId,
    );
    if (current.state === 'PERSISTED') {
      const stored = await client.query<{ count:string }>(
        `select count(*)::text count
         from scores
         where judge_invocation_id=$1
           and provenance='JUDGE_INVOCATION_VERIFIED'`,
        [current.id],
      );
      return {
        invocation:invocationFromRow(current),
        insertedScores:Number(stored.rows[0]?.count ?? 0),
      };
    }
    if (current.state !== 'PARSED') {
      throw new DomainError(
        'JUDGE_SCORE_TRANSITION_INVALID',
        `Judge 점수를 ${current.state} 상태에 저장할 수 없습니다.`,
        { invocationId:current.id, state:current.state },
      );
    }
    const metricKeys = input.scores.map((score) => score.metricKey);
    if (!sameMetricSet(metricKeys, current.resolved_metric_keys)) {
      throw new DomainError(
        'JUDGE_SCORE_METRIC_SET_MISMATCH',
        '저장 점수의 metricKey는 파싱 단계에서 확정된 resolved metricKey와 정확히 일치해야 합니다.',
        { invocationId:current.id },
      );
    }

    let insertedScores = 0;
    for (const score of input.scores) {
      const inserted = await client.query<{ id:string }>(
        `insert into scores(
           model_response_id,score_profile_id,metric_key,value,label,
           rationale,evidence,judge_provider,judge_model,judge_request_id,
           judge_invocation_id,provenance
         ) values(
           $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,
           'JUDGE_INVOCATION_VERIFIED'
         )
         on conflict do nothing
         returning id`,
        [
          current.model_response_id,
          current.score_profile_id,
          score.metricKey,
          score.value,
          score.label,
          score.rationale,
          serializeJson(score.evidence ?? [], 'JUDGE_SCORE_EVIDENCE_INVALID'),
          current.provider_key,
          current.model_id,
          current.provider_request_id,
          current.id,
        ],
      );
      if (!inserted.rows[0]) {
        throw new DomainError(
          'JUDGE_SCORE_CONFLICT',
          `이미 다른 감사 컨텍스트로 저장된 metricKey입니다: ${score.metricKey}`,
          { invocationId:current.id, metricKey:score.metricKey },
        );
      }
      insertedScores += 1;
    }

    const updated = await client.query<JudgeInvocationRow>(
      `update judge_invocations
       set state='PERSISTED',persisted_at=now()
       where id=$1 and state='PARSED'
       returning *`,
      [current.id],
    );
    const invocation = updated.rows[0]!;
    await appendBenchmarkEvent(
      client,
      invocation.benchmark_run_id,
      'JUDGE_SCORES_PERSISTED',
      {
        invocationId:invocation.id,
        modelResponseId:invocation.model_response_id,
        invocationKind:invocation.invocation_kind,
        attempt:invocation.attempt,
        metricKeys:invocation.resolved_metric_keys,
        missingMetricKeys:invocation.missing_metric_keys,
        scoreCount:insertedScores,
      },
    );
    return {
      invocation:invocationFromRow(invocation),
      insertedScores,
    };
  });
}

export async function failJudgeInvocationAndRecordRun(input: {
  invocationId:string;
  errorCode:string;
  errorMessage:string;
  errorStage:JudgeInvocationErrorStage;
}): Promise<JudgeInvocationRecord> {
  const errorCode = input.errorCode.trim();
  const errorMessage = input.errorMessage.trim().slice(0, 2_000);
  if (!errorCode || !errorMessage) {
    throw new DomainError(
      'JUDGE_FAILURE_INVALID',
      'Judge 실패 기록에는 오류 코드와 메시지가 필요합니다.',
    );
  }

  return withTransaction(async (client) => {
    const current = await selectInvocationForUpdate(
      client,
      input.invocationId,
    );
    if (current.state === 'FAILED') return invocationFromRow(current);
    if (current.state === 'PERSISTED') {
      throw new DomainError(
        'JUDGE_FAILURE_TRANSITION_INVALID',
        '완료된 Judge 호출은 실패 상태로 변경할 수 없습니다.',
        { invocationId:current.id },
      );
    }

    const updated = await client.query<JudgeInvocationRow>(
      `update judge_invocations
       set state='FAILED',
         error_code=$2,
         error_message=$3,
         error_stage=$4,
         failed_at=now()
       where id=$1 and state in (
         'REQUESTED','RESPONSE_RECEIVED','PARSED'
       )
       returning *`,
      [
        current.id,
        errorCode,
        errorMessage,
        input.errorStage,
      ],
    );
    const invocation = updated.rows[0]!;
    await appendBenchmarkEvent(
      client,
      invocation.benchmark_run_id,
      'JUDGE_INVOCATION_FAILED',
      {
        invocationId:invocation.id,
        modelResponseId:invocation.model_response_id,
        invocationKind:invocation.invocation_kind,
        attempt:invocation.attempt,
        code:invocation.error_code,
        stage:invocation.error_stage,
        message:invocation.error_message,
        requestedMetricKeys:invocation.requested_metric_keys,
        resolvedMetricKeys:invocation.resolved_metric_keys,
        missingMetricKeys:invocation.missing_metric_keys,
      },
    );
    return invocationFromRow(invocation);
  });
}

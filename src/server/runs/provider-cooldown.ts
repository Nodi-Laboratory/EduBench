import type { PoolClient } from 'pg';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS } from '@/server/providers/http';
import {
  ProviderError,
  type ProviderRateLimitDimension,
} from '@/server/providers/types';

type Queryable = Pick<PoolClient, 'query'>;

export type BenchmarkProviderCooldown = {
  providerKey:string;
  blockedUntil:Date;
  rateLimitDimension:ProviderRateLimitDimension;
  rateLimitScope:string | null;
  retryAfterMs:number;
  sourceRunId:string | null;
  sourceRunItemId:string | null;
  sourcePhase:string;
  sourceModelId:string | null;
  requestId:string | null;
  lastErrorMessage:string | null;
  hitCount:number;
  activatedAt:Date;
  resumedAt:Date | null;
  updatedAt:Date;
};

export type RegisterBenchmarkProviderRateLimitInput = {
  providerKey:string;
  error:ProviderError;
  sourceRunId:string | null;
  sourceRunItemId?:string | null;
  sourcePhase:
    | 'ANSWER_RETRIEVAL_EMBEDDING'
    | 'MODEL_RESPONSE'
    | 'SCORING_JUDGE'
    | 'QUESTION_GENERATION';
  sourceModelId?:string | null;
};

type CooldownRow = {
  provider_key:string;
  blocked_until:Date;
  rate_limit_dimension:ProviderRateLimitDimension;
  rate_limit_scope:string | null;
  retry_after_ms:number;
  source_run_id:string | null;
  source_run_item_id:string | null;
  source_phase:string;
  source_model_id:string | null;
  request_id:string | null;
  last_error_message:string | null;
  hit_count:number;
  activated_at:Date;
  resumed_at:Date | null;
  updated_at:Date;
};

const activeRunStates = [
  'QUEUED',
  'RUNNING',
  'SCORING',
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'STOPPED',
  'CANCELLING',
] as const;

function positiveEnvMs(value:string | undefined, fallback:number):number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS)
    : fallback;
}

export function providerRateLimitCooldownMs(
  error:ProviderError,
  env:NodeJS.ProcessEnv = process.env,
):number {
  if (
    error.retryAfterMs !== null
    && Number.isFinite(error.retryAfterMs)
    && error.retryAfterMs > 0
  ) return Math.min(
    error.retryAfterMs,
    MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS,
  );
  return error.rateLimitDimension === 'RPD'
    ? positiveEnvMs(
      env.BENCHMARK_RATE_LIMIT_RPD_COOLDOWN_MS,
      900_000,
    )
    : positiveEnvMs(
      env.BENCHMARK_RATE_LIMIT_COOLDOWN_MS,
      120_000,
    );
}

export function providerCooldownDominatesObservation(
  active:BenchmarkProviderCooldown,
  error:ProviderError,
  observedAtMs:number = Date.now(),
):boolean {
  if (
    error.requestId
    && active.requestId
    && error.requestId === active.requestId
  ) return true;
  if (
    active.rateLimitDimension !== error.rateLimitDimension
    || active.rateLimitScope !== error.rateLimitScope
  ) return false;
  const observedBlockedUntil = observedAtMs
    + providerRateLimitCooldownMs(error);
  const clockToleranceMs = 1_000;
  return active.blockedUntil.getTime() + clockToleranceMs
    >= observedBlockedUntil;
}

function cooldownFromRow(row:CooldownRow):BenchmarkProviderCooldown {
  return {
    providerKey:row.provider_key,
    blockedUntil:row.blocked_until,
    rateLimitDimension:row.rate_limit_dimension,
    rateLimitScope:row.rate_limit_scope,
    retryAfterMs:row.retry_after_ms,
    sourceRunId:row.source_run_id,
    sourceRunItemId:row.source_run_item_id,
    sourcePhase:row.source_phase,
    sourceModelId:row.source_model_id,
    requestId:row.request_id,
    lastErrorMessage:row.last_error_message,
    hitCount:row.hit_count,
    activatedAt:row.activated_at,
    resumedAt:row.resumed_at,
    updatedAt:row.updated_at,
  };
}

async function fanOutProviderEvent(
  client:Queryable,
  providerKey:string,
  sourceRunId:string | null,
  eventType:'RUN_PROVIDER_RATE_LIMITED' | 'RUN_PROVIDER_RATE_LIMIT_RESUMED',
  payload:Record<string, unknown>,
) {
  await client.query(
    `insert into job_events(
       aggregate_type,aggregate_id,event_type,payload
     )
     select 'benchmark_run',affected.id,$3,$4::jsonb
       from benchmark_runs affected
      where (
        affected.state=any($2::text[])
        or affected.id=$5
      )
        and (
          exists(
            select 1 from run_models model
             where model.benchmark_run_id=affected.id
               and model.provider_key=$1
          )
          or affected.score_profile_snapshot->>'judgeProvider'=$1
          or (
            $1='gemini'
            and affected.retrieval_modes && array['VECTOR']::text[]
          )
        )`,
    [
      providerKey,
      [...activeRunStates],
      eventType,
      JSON.stringify(payload),
      sourceRunId,
    ],
  );
}

export async function registerBenchmarkProviderRateLimitWithClient(
  client:Queryable,
  input:RegisterBenchmarkProviderRateLimitInput,
):Promise<BenchmarkProviderCooldown> {
  if (input.error.kind !== 'RATE_LIMIT') {
    throw new TypeError(
      'Only RATE_LIMIT ProviderError values can activate a provider cooldown.',
    );
  }
  const retryAfterMs = providerRateLimitCooldownMs(input.error);
  const observedErrorMessage = input.error.message.slice(0, 1000);
  const result = await client.query<CooldownRow>(
    `insert into benchmark_provider_cooldowns(
       provider_key,blocked_until,rate_limit_dimension,rate_limit_scope,
       retry_after_ms,source_run_id,source_run_item_id,source_phase,
       source_model_id,request_id,last_error_message
     ) values(
       $1,now()+($2::double precision*interval '1 millisecond'),$3,$4,
       $2,$5,$6,$7,$8,$9,$10
     )
     on conflict(provider_key) do update set
       blocked_until=greatest(
         benchmark_provider_cooldowns.blocked_until,
         excluded.blocked_until
       ),
       rate_limit_dimension=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.rate_limit_dimension
         else benchmark_provider_cooldowns.rate_limit_dimension
       end,
       rate_limit_scope=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.rate_limit_scope
         else benchmark_provider_cooldowns.rate_limit_scope
       end,
       retry_after_ms=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.retry_after_ms
         else benchmark_provider_cooldowns.retry_after_ms
       end,
       source_run_id=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.source_run_id
         else benchmark_provider_cooldowns.source_run_id
       end,
       source_run_item_id=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.source_run_item_id
         else benchmark_provider_cooldowns.source_run_item_id
       end,
       source_phase=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.source_phase
         else benchmark_provider_cooldowns.source_phase
       end,
       source_model_id=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.source_model_id
         else benchmark_provider_cooldowns.source_model_id
       end,
       request_id=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.request_id
         else benchmark_provider_cooldowns.request_id
       end,
       last_error_message=case
         when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until
           then excluded.last_error_message
         else benchmark_provider_cooldowns.last_error_message
       end,
       hit_count=benchmark_provider_cooldowns.hit_count+1,
       activated_at=case
         when benchmark_provider_cooldowns.blocked_until<=now() then now()
         else benchmark_provider_cooldowns.activated_at
       end,
       resumed_at=null,
       updated_at=now()
     returning *`,
    [
      input.providerKey,
      retryAfterMs,
      input.error.rateLimitDimension,
      input.error.rateLimitScope,
      input.sourceRunId,
      input.sourceRunItemId ?? null,
      input.sourcePhase,
      input.sourceModelId ?? null,
      input.error.requestId,
      observedErrorMessage,
    ],
  );
  const cooldown = cooldownFromRow(result.rows[0]!);
  const payload = {
    providerKey:cooldown.providerKey,
    affectedScope:'PROVIDER_GLOBAL',
    sourceRunId:cooldown.sourceRunId,
    sourceRunItemId:cooldown.sourceRunItemId,
    sourcePhase:cooldown.sourcePhase,
    sourceModelId:cooldown.sourceModelId,
    observedRunId:input.sourceRunId,
    observedRunItemId:input.sourceRunItemId ?? null,
    rateLimitDimension:cooldown.rateLimitDimension,
    rateLimitScope:cooldown.rateLimitScope,
    retryAfterMs:cooldown.retryAfterMs,
    blockedUntil:cooldown.blockedUntil.toISOString(),
    resumeAt:cooldown.blockedUntil.toISOString(),
    automaticResume:true,
    requestId:cooldown.requestId,
    lastErrorMessage:cooldown.lastErrorMessage,
    hitCount:cooldown.hitCount,
    observedSourcePhase:input.sourcePhase,
    observedSourceModelId:input.sourceModelId ?? null,
    observedRateLimitDimension:input.error.rateLimitDimension,
    observedRateLimitScope:input.error.rateLimitScope,
    observedRetryAfterMs:retryAfterMs,
    observedRequestId:input.error.requestId,
    observedErrorMessage,
  };
  await fanOutProviderEvent(
    client,
    input.providerKey,
    input.sourceRunId,
    'RUN_PROVIDER_RATE_LIMITED',
    payload,
  );
  if (input.sourceRunId) {
    await client.query(
      `insert into job_events(
         aggregate_type,aggregate_id,event_type,payload
       ) values('benchmark_run',$1,'PROVIDER_COOLDOWN_ACTIVATED',$2::jsonb)`,
      [input.sourceRunId, JSON.stringify(payload)],
    );
  }
  return cooldown;
}

export function registerBenchmarkProviderRateLimit(
  input:RegisterBenchmarkProviderRateLimitInput,
):Promise<BenchmarkProviderCooldown> {
  return withTransaction((client) =>
    registerBenchmarkProviderRateLimitWithClient(client, input));
}

export async function findActiveBenchmarkProviderCooldown(
  providerKey:string,
  client:Queryable = db,
):Promise<BenchmarkProviderCooldown | null> {
  const result = await client.query<CooldownRow>(
    `select * from benchmark_provider_cooldowns
      where provider_key=$1 and blocked_until>now()`,
    [providerKey],
  );
  return result.rows[0] ? cooldownFromRow(result.rows[0]) : null;
}

export async function markExpiredProviderCooldownsResumedForRun(
  client:Queryable,
  runId:string,
):Promise<BenchmarkProviderCooldown[]> {
  const result = await client.query<CooldownRow>(
    `update benchmark_provider_cooldowns cooldown set
       resumed_at=now(),
       updated_at=now()
     where cooldown.blocked_until<=now()
       and cooldown.resumed_at is null
       and cooldown.provider_key in (
         select model.provider_key from run_models model
          where model.benchmark_run_id=$1
         union
         select run.score_profile_snapshot->>'judgeProvider'
           from benchmark_runs run
          where run.id=$1
            and run.score_profile_snapshot->>'judgeProvider' is not null
         union
         select 'gemini'
          where exists(
            select 1 from run_items item
             where item.benchmark_run_id=$1
               and item.retrieval_mode='VECTOR'
          )
       )
     returning cooldown.*`,
    [runId],
  );
  const resumed = result.rows.map(cooldownFromRow);
  for (const cooldown of resumed) {
    const payload = {
      providerKey:cooldown.providerKey,
      affectedScope:'PROVIDER_GLOBAL',
      sourceRunId:cooldown.sourceRunId,
      rateLimitDimension:cooldown.rateLimitDimension,
      rateLimitScope:cooldown.rateLimitScope,
      retryAfterMs:cooldown.retryAfterMs,
      blockedUntil:cooldown.blockedUntil.toISOString(),
      resumedAt:cooldown.resumedAt?.toISOString() ?? new Date().toISOString(),
      automaticResume:true,
    };
    await fanOutProviderEvent(
      client,
      cooldown.providerKey,
      cooldown.sourceRunId,
      'RUN_PROVIDER_RATE_LIMIT_RESUMED',
      payload,
    );
    if (cooldown.sourceRunId) {
      await client.query(
        `insert into job_events(
           aggregate_type,aggregate_id,event_type,payload
         ) values(
           'benchmark_run',$1,'PROVIDER_COOLDOWN_RESUMED',$2::jsonb
         )`,
        [cooldown.sourceRunId, JSON.stringify(payload)],
      );
    }
  }
  return resumed;
}

export class ActiveBenchmarkProviderCooldownError extends Error {
  constructor(readonly cooldown:BenchmarkProviderCooldown) {
    super(
      `${cooldown.providerKey} provider is blocked until `
      + cooldown.blockedUntil.toISOString(),
    );
    this.name = 'ActiveBenchmarkProviderCooldownError';
  }
}

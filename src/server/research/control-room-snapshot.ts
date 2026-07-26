import type { PoolClient } from 'pg';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';
import {
  controlRoomEventStage,
  readControlRoomEvents,
  type ControlRoomEventEnvelope,
} from '@/server/research/control-room-events';

type Queryable = Pick<PoolClient, 'query'>;

export type ControlRoomOperation = {
  aggregateType: string;
  aggregateId: string;
  label: string;
  stage: string;
  state: string;
  progress: Record<string, unknown> | null;
  updatedAt: string;
  error: {
    code: string | null;
    message: string;
  } | null;
};

export type ControlRoomFailure = {
  aggregateType: string;
  aggregateId: string;
  label: string;
  stage: string;
  code: string;
  message: string;
  updatedAt: string;
};

export type ControlRoomSnapshot = {
  eventCursor: string;
  generatedAt: string;
  system: {
    database: {
      state: 'HEALTHY' | 'DOWN';
      latencyMs: number | null;
    };
    worker: {
      state: 'HEALTHY' | 'IDLE' | 'STALE';
      activeLeases: number;
      staleLeases: number;
    };
    queue: {
      pending: number;
      retryWait: number;
      leased: number;
    };
  };
  pipelineStages: Array<{
    key: string;
    label: string;
    active: number;
    failed: number;
    ready: number;
  }>;
  activeOperations: ControlRoomOperation[];
  failures: ControlRoomFailure[];
  failureTotal: number;
  recentEvents: ControlRoomEventEnvelope[];
  profiles: Array<{
    kind: string;
    id: string;
    version: string;
    title: string;
    hash: string;
    activatedAt: string;
  }>;
  scoreboard: Array<{
    runId: string;
    runLabel: string;
    model: string;
    metric: string;
    mean: number | null;
    scored: number;
    eligible: number;
  }>;
  scoreboardTotal: number;
};

type SystemRow = {
  generated_at: Date;
  event_cursor: string;
  pending: number;
  retry_wait: number;
  leased: number;
  active_leases: number;
  stale_leases: number;
};

type ActiveJobRow = {
  id: string;
  kind: string;
  state: string;
  payload: Record<string, unknown>;
  updated_at: Date;
  last_error_code: string | null;
  last_error_message: string | null;
  source_name: string | null;
  source_status: string | null;
  generation_progress: Record<string, unknown> | null;
  generation_state: string | null;
  generation_conditions: Record<string, unknown> | null;
  generation_requested_count: number | null;
  run_title: string | null;
  run_state: string | null;
  run_total: number | null;
  run_completed: number | null;
  run_failed: number | null;
  latest_event_type: string | null;
  latest_event_payload: Record<string, unknown> | null;
  lease_stale: boolean;
};

type ActiveRunRow = {
  id: string;
  title: string;
  state: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  updated_at: Date;
  last_scoring_error: Record<string, unknown> | null;
};

type FailureRow = {
  aggregate_type: string;
  aggregate_id: string;
  label: string;
  stage: string | null;
  code: string | null;
  message: string | null;
  updated_at: Date;
  total_count: number;
  failure_stage_counts: Record<string, number>;
};

const CONTROL_ROOM_COLLECTION_LIMIT = 50;

const stageLabels = [
  ['UPLOAD', 'Upload'],
  ['PARSE', 'Parse'],
  ['CHUNK', 'Chunk'],
  ['EMBED', 'Embed'],
  ['GENERATE', 'Generate'],
  ['REVIEW', 'Review'],
  ['FREEZE', 'Freeze'],
  ['EXECUTE', 'Execute'],
  ['SCORE', 'Score'],
] as const;

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeStage(value: string | null | undefined): string {
  if (!value) return 'SYSTEM';
  const normalized = value.toUpperCase();
  if (normalized === 'UPLOADED') return 'UPLOAD';
  if (['PARSED', 'PARSING', 'DOCUMENT_PARSE'].includes(normalized)) return 'PARSING';
  if (['CHUNKING', 'TABLE_OF_CONTENTS'].includes(normalized)) return 'CHUNKING';
  if (['EMBEDDING', 'READY'].includes(normalized)) return 'EMBEDDING';
  if (['GENERATION', 'QUESTION_GENERATION'].includes(normalized)) {
    return 'QUESTION_GENERATION';
  }
  if (['RUNNING', 'BENCHMARK_RUN'].includes(normalized)) return 'BENCHMARK';
  return normalized;
}

function aggregateFromJob(row: ActiveJobRow): {
  aggregateType: string;
  aggregateId: string;
} {
  if (typeof row.payload.sourceId === 'string') {
    return { aggregateType: 'source', aggregateId: row.payload.sourceId };
  }
  if (typeof row.payload.batchId === 'string') {
    return { aggregateType: 'generation', aggregateId: row.payload.batchId };
  }
  if (typeof row.payload.runId === 'string') {
    return { aggregateType: 'benchmark_run', aggregateId: row.payload.runId };
  }
  return { aggregateType: 'job', aggregateId: row.id };
}

function jobStage(row: ActiveJobRow): string {
  if (row.latest_event_type) {
    const eventStage = controlRoomEventStage(row.latest_event_type);
    if (eventStage !== 'QUEUE' && eventStage !== 'SYSTEM') return eventStage;
  }
  if (row.source_status) return normalizeStage(row.source_status);
  if (row.generation_state) return 'QUESTION_GENERATION';
  if (row.run_state === 'SCORING') return 'SCORING';
  if (row.run_state) return 'BENCHMARK';
  if (row.kind === 'document.parse') return 'PARSING';
  if (row.kind === 'question.generate') return 'QUESTION_GENERATION';
  if (row.kind.startsWith('benchmark.')) return 'BENCHMARK';
  return 'QUEUE';
}

function jobProgress(row: ActiveJobRow): Record<string, unknown> | null {
  if (row.generation_progress) return row.generation_progress;
  if (row.run_total != null) {
    return {
      total: row.run_total,
      completed: row.run_completed ?? 0,
      failed: row.run_failed ?? 0,
    };
  }
  return row.latest_event_payload;
}

function generationLabel(row: ActiveJobRow): string {
  const conditions = row.generation_conditions;
  const values = [
    conditions?.subject,
    conditions?.grade,
    conditions?.chapter,
    conditions?.unit,
    Array.isArray(conditions?.units) ? conditions.units.join(', ') : null,
    conditions?.purpose,
    conditions?.difficulty,
    row.generation_requested_count == null
      ? null
      : `${row.generation_requested_count}문항`,
  ];
  const parts = values.filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0);
  return parts.length > 0 ? parts.join(' · ') : '질문 생성';
}

async function readActiveOperations(
  queryable: Queryable,
): Promise<ControlRoomOperation[]> {
  const jobs = await queryable.query<ActiveJobRow>(
    `select job.id::text,job.kind,job.state,job.payload,job.updated_at,
            job.last_error_code,job.last_error_message,
            source.original_name source_name,source.status source_status,
            batch.progress generation_progress,batch.state generation_state,
            batch.conditions generation_conditions,
            batch.requested_count::int generation_requested_count,
            run.title run_title,run.state run_state,
            run.total_items::int run_total,
            run.completed_items::int run_completed,
            run.failed_items::int run_failed,
            latest.event_type latest_event_type,
            latest.payload latest_event_payload,
            (
              job.state='LEASED'
              and (
                job.lease_expires_at is null
                or job.lease_expires_at<=clock_timestamp()
              )
            ) lease_stale
       from jobs job
       left join source_files source
         on source.id::text=job.payload->>'sourceId'
       left join generation_batches batch
         on batch.id::text=job.payload->>'batchId'
       left join benchmark_runs run
         on run.id::text=job.payload->>'runId'
       left join lateral (
         select event.event_type,event.payload
           from job_events event
          where event.job_id=job.id
            and event.event_type not like 'JOB\_%' escape '\'
          order by event.id desc
          limit 1
       ) latest on true
      where job.state in ('PENDING','RETRY_WAIT','LEASED')
      order by job.updated_at desc,job.id`,
  );
  const runs = await queryable.query<ActiveRunRow>(
    `select id::text,title,state,total_items::int,completed_items::int,
            failed_items::int,updated_at,last_scoring_error
       from benchmark_runs
      where state in (
        'QUEUED','RUNNING','PAUSING','PAUSED','STOPPING',
        'SCORING','CANCELLING'
      )
      order by updated_at desc,id`,
  );

  const operations = new Map<string, ControlRoomOperation>();
  for (const row of jobs.rows) {
    const aggregate = aggregateFromJob(row);
    operations.set(`${aggregate.aggregateType}:${aggregate.aggregateId}`, {
      ...aggregate,
      label: row.source_name
        ?? row.run_title
        ?? (aggregate.aggregateType === 'generation' ? generationLabel(row) : null)
        ?? (aggregate.aggregateType === 'job' ? row.kind : aggregate.aggregateId),
      stage: jobStage(row),
      state: row.lease_stale ? 'STALE' : row.state,
      progress: jobProgress(row),
      updatedAt: row.updated_at.toISOString(),
      error: row.last_error_message
        ? { code: row.last_error_code, message: row.last_error_message }
        : null,
    });
  }
  for (const row of runs.rows) {
    const key = `benchmark_run:${row.id}`;
    if (operations.has(key)) continue;
    const scoringError = safeRecord(row.last_scoring_error);
    operations.set(key, {
      aggregateType: 'benchmark_run',
      aggregateId: row.id,
      label: row.title,
      stage: row.state === 'SCORING' ? 'SCORING' : 'BENCHMARK',
      state: row.state,
      progress: {
        total: row.total_items,
        completed: row.completed_items,
        failed: row.failed_items,
      },
      updatedAt: row.updated_at.toISOString(),
      error: typeof scoringError?.message === 'string'
        ? {
          code: typeof scoringError.code === 'string' ? scoringError.code : null,
          message: scoringError.message,
        }
        : null,
    });
  }
  return [...operations.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt));
}

async function readFailures(
  queryable: Queryable,
): Promise<{
  items: ControlRoomFailure[];
  total: number;
  stageCounts: Map<string, number>;
}> {
  const result = await queryable.query<FailureRow>(
    `with failure_candidates as (
     select 'source' aggregate_type,source.id::text aggregate_id,
            source.original_name label,source.failed_stage stage,
            source.failure_code code,source.failure_message message,
            source.updated_at
       from source_files source
      where source.deleted_at is null and source.status='FAILED'
     union all
     select 'generation',batch.id::text,
            coalesce(
              nullif(concat_ws(' · ',
                batch.conditions->>'subject',
                batch.conditions->>'grade',
                batch.conditions->>'purpose',
                batch.conditions->>'difficulty',
                batch.requested_count::text || '문항'
              ),''),
              '질문 생성'
            ),
            'QUESTION_GENERATION',
            coalesce(latest.payload->>'code','GENERATION_FAILED'),
            coalesce(
              latest.payload->>'message',
              batch.progress->>'error',
              '문항 생성 작업이 실패했습니다.'
            ),
            batch.updated_at
       from generation_batches batch
       left join lateral (
         select event.payload
           from job_events event
          where event.aggregate_type='generation'
            and event.aggregate_id=batch.id
            and event.event_type like '%FAILED%'
          order by event.id desc
          limit 1
       ) latest on true
      where batch.state='FAILED'
     union all
     select 'benchmark_run',run.id::text,run.title,
            case
              when run.last_scoring_error is null then 'BENCHMARK'
              else 'SCORING'
            end,
            coalesce(
              run.last_scoring_error->>'code',
              latest.payload->>'code',
              'RUN_FAILED'
            ),
            coalesce(
              run.last_scoring_error->>'message',
              latest.payload->>'message',
              '벤치마크 실행이 실패했습니다.'
            ),
            run.updated_at
       from benchmark_runs run
       left join lateral (
         select event.payload
           from job_events event
          where event.aggregate_type='benchmark_run'
            and event.aggregate_id=run.id
            and event.event_type like '%FAILED%'
          order by event.id desc
          limit 1
       ) latest on true
      where run.state='FAILED'
     union all
     select
       case
         when job.payload->>'sourceId' is not null then 'source'
         when job.payload->>'batchId' is not null then 'generation'
         when job.payload->>'runId' is not null then 'benchmark_run'
         else 'job'
       end,
       coalesce(
         job.payload->>'sourceId',
         job.payload->>'batchId',
         job.payload->>'runId',
         job.id::text
       ),
       coalesce(source.original_name,run.title,job.kind),
       case
         when job.kind='document.parse' then 'PARSING'
         when job.kind='question.generate' then 'QUESTION_GENERATION'
         when job.kind like 'benchmark.%' then 'BENCHMARK'
         else 'QUEUE'
       end,
       coalesce(job.last_error_code,'JOB_TERMINAL_FAILED'),
       coalesce(job.last_error_message,'작업이 최종 실패했습니다.'),
       job.updated_at
       from jobs job
       left join source_files source
         on source.id::text=job.payload->>'sourceId'
       left join benchmark_runs run
         on run.id::text=job.payload->>'runId'
      where job.state='TERMINAL_FAILED'
    ), deduplicated as (
      select distinct on (aggregate_type,aggregate_id)
             aggregate_type,aggregate_id,label,stage,code,message,updated_at
        from failure_candidates
       order by aggregate_type,aggregate_id,updated_at desc
    ), canonical_failures as (
      select case
        when upper(coalesce(stage,'')) in ('UPLOAD','UPLOADED')
          then 'UPLOAD'
        when upper(coalesce(stage,'')) in (
          'PARSE','PARSED','PARSING','DOCUMENT_PARSE'
        ) then 'PARSE'
        when upper(coalesce(stage,'')) in (
          'CHUNK','CHUNKING','TABLE_OF_CONTENTS'
        ) then 'CHUNK'
        when upper(coalesce(stage,'')) in ('EMBED','EMBEDDING','READY')
          then 'EMBED'
        when upper(coalesce(stage,'')) in (
          'GENERATE','GENERATION','DIRECTION','RETRIEVAL',
          'QUESTION_GENERATION'
        ) then 'GENERATE'
        when upper(coalesce(stage,''))='REVIEW' then 'REVIEW'
        when upper(coalesce(stage,''))='FREEZE' then 'FREEZE'
        when upper(coalesce(stage,'')) in (
          'EXECUTE','BENCHMARK','RUNNING','BENCHMARK_RUN'
        ) then 'EXECUTE'
        when upper(coalesce(stage,'')) in ('SCORE','SCORING') then 'SCORE'
        else null
      end stage_key
      from deduplicated
    ), failure_stage_counts as (
      select stage_key,count(*)::int count
        from canonical_failures
       where stage_key is not null
       group by stage_key
    ), paged_failures as (
      select *,count(*) over()::int total_count
        from deduplicated
       order by updated_at desc
       limit $1
    )
    select paged_failures.*,
           coalesce((
             select jsonb_object_agg(stage_key,count)
               from failure_stage_counts
           ),'{}'::jsonb) failure_stage_counts
      from paged_failures
     order by updated_at desc`,
    [CONTROL_ROOM_COLLECTION_LIMIT],
  );
  const failures = new Map<string, ControlRoomFailure>();
  for (const row of result.rows) {
    const key = `${row.aggregate_type}:${row.aggregate_id}`;
    if (failures.has(key)) continue;
    failures.set(key, {
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      label: row.label,
      stage: normalizeStage(row.stage),
      code: row.code ?? 'UNKNOWN_FAILURE',
      message: row.message ?? '실패 원인이 기록되지 않았습니다.',
      updatedAt: row.updated_at.toISOString(),
    });
  }
  return {
    items: [...failures.values()],
    total: Number(result.rows[0]?.total_count ?? 0),
    stageCounts: new Map(
      Object.entries(result.rows[0]?.failure_stage_counts ?? {})
        .map(([stage, count]) => [stage, Number(count)]),
    ),
  };
}

async function readProfiles(queryable: Queryable) {
  const result = await queryable.query<{
    kind: string;
    id: string;
    version: string;
    title: string;
    content_hash: string;
    activated_at: Date;
  }>(
    `select profile.kind,profile.id::text,profile.version,profile.title,
            profile.content_hash,active.activated_at
       from research_config_active_profiles active
       join research_config_profiles profile
         on profile.kind=active.kind and profile.id=active.profile_id
      order by profile.kind`,
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    version: row.version,
    title: row.title,
    hash: row.content_hash,
    activatedAt: row.activated_at.toISOString(),
  }));
}

async function readScoreboard(queryable: Queryable) {
  const result = await queryable.query<{
    run_id: string;
    run_label: string;
    model: string;
    metric: string;
    mean: number | string | null;
    scored: number;
    eligible: number;
    total_count: number;
  }>(
    `with scoreboard_rows as (
     select run.id::text run_id,run.title run_label,
            model.display_name model,score.metric_key metric,
            avg(score.value)::double precision mean,
            count(score.id)::int scored,
            (
              select count(*)::int
                from run_items eligible_item
                join eligible_model_responses eligible_response
                  on eligible_response.run_item_id=eligible_item.id
               where eligible_item.run_model_id=model.id
            ) eligible,
            run.updated_at
       from benchmark_runs run
       join run_models model on model.benchmark_run_id=run.id
       join run_items item on item.run_model_id=model.id
       join eligible_model_responses response on response.run_item_id=item.id
       join scores score
         on score.model_response_id=response.id
        and score.score_profile_id=run.score_profile_id
      group by run.id,run.title,run.updated_at,model.id,model.display_name,
               score.metric_key
    )
    select run_id,run_label,model,metric,mean,scored,eligible,
           count(*) over()::int total_count
      from scoreboard_rows
     order by updated_at desc,model,metric
     limit $1`,
    [CONTROL_ROOM_COLLECTION_LIMIT],
  );
  return {
    items: result.rows.map((row) => ({
      runId: row.run_id,
      runLabel: row.run_label,
      model: row.model,
      metric: row.metric,
      mean: row.mean == null ? null : Number(row.mean),
      scored: Number(row.scored),
      eligible: Number(row.eligible),
    })),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

async function readReadyStageCounts(queryable: Queryable): Promise<Map<string, number>> {
  const result = await queryable.query<{ key: string; count: number }>(
    `select 'UPLOAD' key,count(*)::int count
       from source_files
      where deleted_at is null
     union all
     select 'PARSE',count(*)::int
       from source_files
      where deleted_at is null
        and status in ('PARSED','CHUNKING','EMBEDDING','READY')
     union all
     select 'CHUNK',count(*)::int
       from source_files
      where deleted_at is null
        and status in ('EMBEDDING','READY')
     union all
     select 'EMBED',count(*)::int
       from source_files
      where deleted_at is null and status='READY'
     union all
     select 'GENERATE',count(*)::int
       from generation_batches
      where state='COMPLETED'
     union all
     select 'REVIEW',count(*)::int
       from questions
      where status='APPROVED' and deleted_at is null
     union all
     select 'FREEZE',count(*)::int
       from dataset_versions
      where status='PUBLISHED'
     union all
     select 'EXECUTE',count(*)::int
       from benchmark_runs
      where state in ('SCORING','COMPLETED')
     union all
     select 'SCORE',count(*)::int
       from benchmark_runs
      where state='COMPLETED'`,
  );
  return new Map(result.rows.map((row) => [row.key, Number(row.count)]));
}

function topLevelPipelineStage(stage: string): string | null {
  if (stage === 'UPLOAD') return 'UPLOAD';
  if (stage === 'PARSING') return 'PARSE';
  if (stage === 'CHUNKING') return 'CHUNK';
  if (stage === 'EMBEDDING') return 'EMBED';
  if (['DIRECTION', 'RETRIEVAL', 'QUESTION_GENERATION'].includes(stage)) {
    return 'GENERATE';
  }
  if (stage === 'REVIEW') return 'REVIEW';
  if (stage === 'FREEZE') return 'FREEZE';
  if (stage === 'BENCHMARK') return 'EXECUTE';
  if (stage === 'SCORING') return 'SCORE';
  return null;
}

function pipelineStages(
  operations: ControlRoomOperation[],
  failedCounts: Map<string, number>,
  readyCounts: Map<string, number>,
) {
  const activeCounts = new Map<string, number>();
  for (const operation of operations) {
    if (operation.state === 'STALE') continue;
    const stage = topLevelPipelineStage(operation.stage);
    if (stage) activeCounts.set(stage, (activeCounts.get(stage) ?? 0) + 1);
  }
  return stageLabels.map(([key, label]) => ({
    key,
    label,
    active: activeCounts.get(key) ?? 0,
    failed: failedCounts.get(key) ?? 0,
    ready: readyCounts.get(key) ?? 0,
  }));
}

export async function readControlRoomSnapshot(
  queryable: Queryable,
): Promise<ControlRoomSnapshot> {
  const pingStarted = performance.now();
  const system = await queryable.query<SystemRow>(
    `select clock_timestamp() generated_at,
            (select coalesce(max(id),0)::text from job_events) event_cursor,
            (select count(*)::int from jobs where state='PENDING') pending,
            (select count(*)::int from jobs where state='RETRY_WAIT') retry_wait,
            (select count(*)::int from jobs where state='LEASED') leased,
            ((
              select count(*) from jobs
               where state='LEASED' and lease_expires_at>clock_timestamp()
            ) + (
              select count(*) from run_items
               where state='LEASED' and lease_expires_at>clock_timestamp()
            ))::int active_leases,
            ((
              select count(*) from jobs
               where state='LEASED'
                 and (
                   lease_expires_at is null
                   or lease_expires_at<=clock_timestamp()
                 )
            ) + (
              select count(*) from run_items
               where state='LEASED'
                 and (
                   lease_expires_at is null
                   or lease_expires_at<=clock_timestamp()
                 )
            ))::int stale_leases`,
  );
  const latencyMs = Math.max(
    0,
    Math.round((performance.now() - pingStarted) * 100) / 100,
  );
  const status = system.rows[0]!;
  const activeOperations = await readActiveOperations(queryable);
  const failures = await readFailures(queryable);
  const profiles = await readProfiles(queryable);
  const scoreboard = await readScoreboard(queryable);
  const readyCounts = await readReadyStageCounts(queryable);
  const boundary = await queryable.query<{ after: string }>(
    `select coalesce(min(id)-1,0)::text after
       from (
         select id from job_events order by id desc limit 100
       ) recent`,
  );
  const recentEvents = await readControlRoomEvents(
    queryable,
    boundary.rows[0]?.after ?? '0',
    100,
  );
  const workerState = status.stale_leases > 0
    ? 'STALE'
    : status.active_leases > 0
      ? 'HEALTHY'
      : 'IDLE';

  return {
    eventCursor: status.event_cursor,
    generatedAt: status.generated_at.toISOString(),
    system: {
      database: { state: 'HEALTHY', latencyMs },
      worker: {
        state: workerState,
        activeLeases: Number(status.active_leases),
        staleLeases: Number(status.stale_leases),
      },
      queue: {
        pending: Number(status.pending),
        retryWait: Number(status.retry_wait),
        leased: Number(status.leased),
      },
    },
    pipelineStages: pipelineStages(
      activeOperations,
      failures.stageCounts,
      readyCounts,
    ),
    activeOperations,
    failures: failures.items,
    failureTotal: failures.total,
    recentEvents,
    profiles,
    scoreboard: scoreboard.items,
    scoreboardTotal: scoreboard.total,
  };
}

export function getControlRoomSnapshot(): Promise<ControlRoomSnapshot> {
  return withReadOnlyRepeatableReadTransaction(readControlRoomSnapshot);
}

create or replace function scoring_engine_definition_hash(
  candidate jsonb
)
returns text
language sql
immutable
as $$
  select encode(digest(candidate::text, 'sha256'), 'hex');
$$;

create table scoring_engine_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique check (btrim(version) <> ''),
  title text not null check (btrim(title) <> ''),
  definition jsonb not null check (
    jsonb_typeof(definition) = 'object'
    and definition->>'version' = version
  ),
  content_hash text not null unique check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz not null default now()
);

create or replace function prepare_scoring_engine_version()
returns trigger
language plpgsql
as $$
begin
  new.content_hash := scoring_engine_definition_hash(new.definition);
  return new;
end;
$$;

create trigger scoring_engine_versions_prepare
before insert on scoring_engine_versions
for each row execute function prepare_scoring_engine_version();

create or replace function prevent_scoring_engine_version_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'scoring engine versions are append-only'
    using errcode = '55000';
end;
$$;

create trigger scoring_engine_versions_append_only
before update or delete on scoring_engine_versions
for each row execute function prevent_scoring_engine_version_change();

insert into scoring_engine_versions(
  version,
  title,
  definition,
  content_hash
)
values(
  'edubench-scoring-v1',
  'EduBench 선수관계 평가 엔진 v1',
  $definition$
  {
    "version": "edubench-scoring-v1",
    "title": "EduBench 선수관계 평가 엔진 v1",
    "deterministic": {
      "exactMatch": {
        "implementationVersion": "normalize-korean-answer-v1",
        "normalization": [
          "Unicode NFC normalization",
          "CRLF to LF",
          "collapse whitespace",
          "trim",
          "remove trailing . ! ? and ideographic full stop",
          "Korean-locale lowercase"
        ],
        "comparison": "normalized candidate equals any normalized accepted answer or reference answer",
        "range": [0, 1]
      },
      "responsePresent": {
        "implementationVersion": "normalized-response-present-v1",
        "rule": "normalized response length is greater than zero",
        "range": [0, 1]
      }
    },
    "metricResolution": {
      "implementationVersion": "required-metrics-v1",
      "baseMetrics": ["exact_match", "response_present"],
      "profileMetrics": "append score profile metrics in stored order and deduplicate by first occurrence",
      "prerequisiteBenchmarkType": "PREREQUISITE_RELATIONSHIP",
      "prerequisiteMetrics": [
        "target_concept_correctness",
        "prerequisite_identification",
        "prerequisite_relation_accuracy",
        "prerequisite_application",
        "reasoning_chain_completeness",
        "textbook_grounding"
      ]
    },
    "prerequisiteMetricRubrics": {
      "target_concept_correctness": "최종 결론과 목표 개념 설명의 정확성을 평가한다. 1은 모두 정확, 0.5는 결론은 맞지만 핵심 조건 일부 누락, 0은 결론 또는 개념이 틀린 경우다.",
      "prerequisite_identification": "benchmarkDesign.prerequisiteConcepts와 비교한다. 1은 필요한 선수 개념을 모두 명시하거나 의미상 분명히 사용, 0.5는 일부만 사용, 0은 식별하지 못한 경우다.",
      "prerequisite_relation_accuracy": "선수→목표 관계의 방향과 이유를 평가한다. 방향 반전이나 단순 연관성 진술은 0, 방향은 맞지만 이유가 불완전하면 0.5다.",
      "prerequisite_application": "선수 개념이 목표 판단의 입력이나 근거로 실제 작동하는지 평가한다. 용어 나열만 하면 0, 부분 적용은 0.5, 모든 관계를 올바르게 적용하면 1이다.",
      "reasoning_chain_completeness": "benchmarkDesign.requiredReasoningSteps와 비교한다. 모든 필수 단계를 논리적으로 연결하면 1, 핵심 중간 단계 하나 누락은 0.5, 결론만 제시하면 0이다.",
      "textbook_grounding": "제공된 textbookEvidence로 후보 응답의 핵심 주장과 관계를 뒷받침할 수 있는지 평가한다. 외부 사실이 정답 논리에 필수면 감점한다."
    },
    "judge": {
      "systemPrompt": "EDUBENCH_JUDGE_JSON. 지정된 metricKey만 빠짐없이 채점한다. 모델 이름을 보지 말고 제공된 루브릭과 교과서 근거만으로 절대평가한다.",
      "requestFields": [
        "requiredMetrics",
        "instruction",
        "rubricPrompt",
        "question",
        "referenceAnswer",
        "acceptedAnswers",
        "scoringCriteria",
        "benchmarkDesign",
        "prerequisiteMetricRubrics",
        "evidenceMode",
        "textbookEvidence",
        "candidateResponse",
        "outputSchema"
      ],
      "outputSchema": {
        "type": "object",
        "required": ["scores"],
        "properties": {
          "scores": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["metricKey", "value", "label", "rationale"],
              "properties": {
                "metricKey": {"type": "string"},
                "value": {"type": ["number", "numeric string"], "minimum": 0, "maximum": 1},
                "label": {"type": "string", "blankFallback": "SCORED"},
                "rationale": {"type": "string", "blankFallback": "채점 모델이 설명을 생략했습니다."},
                "evidence": {
                  "type": "array",
                  "default": [],
                  "items": {
                    "type": "object",
                    "properties": {
                      "claim": {"type": "string", "optional": true},
                      "quote": {"type": "string", "optional": true},
                      "chunkId": {"type": "string", "optional": true}
                    }
                  }
                }
              }
            }
          }
        }
      },
      "parser": {
        "implementationVersion": "first-last-json-object-zod-v1",
        "extraction": "parse the substring from the first opening brace through the last closing brace",
        "validation": "scores array; value coerced from a nonblank numeric string then constrained to 0..1; blank label and rationale receive fixed fallbacks; evidence is normalized",
        "metricSelection": "primary and fallback responses both require exact metricKey matches; mismatched keys are unresolved"
      },
      "batching": {
        "implementationVersion": "all-required-metrics-then-single-metric-fallback-v1",
        "primary": "request all unresolved Judge metrics in one call",
        "fallback": "request each metric omitted by the primary response in a separate one-metric call"
      },
      "sampling": {
        "temperature": 0,
        "maxOutputTokens": 8192
      }
    }
  }
  $definition$::jsonb,
  repeat('0', 64)
);

create table scoring_engine_registry (
  singleton boolean primary key default true check (singleton),
  current_engine_version_id uuid not null unique
    references scoring_engine_versions(id),
  updated_at timestamptz not null default now()
);

insert into scoring_engine_registry(singleton,current_engine_version_id)
select true,id
from scoring_engine_versions
where version='edubench-scoring-v1';

alter table benchmark_runs
  add column scoring_engine_version_id uuid
    references scoring_engine_versions(id),
  add column scoring_engine_snapshot jsonb,
  add column scoring_engine_snapshot_provenance text;

-- Rows already present when this migration starts predate engine pinning. Their
-- historical engine cannot be reconstructed safely from environment defaults.
update benchmark_runs
set
  scoring_engine_version_id = null,
  scoring_engine_snapshot = null,
  scoring_engine_snapshot_provenance = 'LEGACY_BACKFILL_UNVERIFIED';

alter table benchmark_runs
  alter column scoring_engine_snapshot_provenance
    set default 'AT_CREATION_VERIFIED',
  alter column scoring_engine_snapshot_provenance set not null,
  add constraint benchmark_runs_scoring_engine_snapshot_provenance
    check (
      (
        scoring_engine_snapshot_provenance =
          'LEGACY_BACKFILL_UNVERIFIED'
        and scoring_engine_version_id is null
        and scoring_engine_snapshot is null
      )
      or (
        scoring_engine_snapshot_provenance = 'AT_CREATION_VERIFIED'
        and scoring_engine_version_id is not null
        and jsonb_typeof(scoring_engine_snapshot) = 'object'
        and scoring_engine_snapshot->>'id' =
          scoring_engine_version_id::text
        and scoring_engine_snapshot->>'contentHash'
          ~ '^[0-9a-f]{64}$'
      )
    );

create or replace function pin_benchmark_run_scoring_engine()
returns trigger
language plpgsql
as $$
declare
  pinned_id uuid;
  pinned_snapshot jsonb;
begin
  select
    engine.id,
    jsonb_build_object(
      'id', engine.id,
      'version', engine.version,
      'title', engine.title,
      'definition', engine.definition,
      'contentHash', engine.content_hash
    )
  into pinned_id,pinned_snapshot
  from scoring_engine_registry registry
  join scoring_engine_versions engine
    on engine.id=registry.current_engine_version_id
  where registry.singleton=true
  for share of registry,engine;

  if pinned_id is null then
    raise exception 'current scoring engine is not configured'
      using errcode='55000';
  end if;

  new.scoring_engine_version_id := pinned_id;
  new.scoring_engine_snapshot := pinned_snapshot;
  new.scoring_engine_snapshot_provenance :=
    'AT_CREATION_VERIFIED';
  return new;
end;
$$;

create trigger benchmark_runs_pin_scoring_engine
before insert on benchmark_runs
for each row execute function pin_benchmark_run_scoring_engine();

create or replace function prevent_run_scoring_engine_change()
returns trigger
language plpgsql
as $$
begin
  if new.scoring_engine_version_id
       is distinct from old.scoring_engine_version_id
     or new.scoring_engine_snapshot
       is distinct from old.scoring_engine_snapshot
     or new.scoring_engine_snapshot_provenance
       is distinct from old.scoring_engine_snapshot_provenance then
    raise exception 'a benchmark run scoring engine reference, snapshot, and provenance are immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger benchmark_runs_scoring_engine_immutable
before update of
  scoring_engine_version_id,
  scoring_engine_snapshot,
  scoring_engine_snapshot_provenance
on benchmark_runs
for each row execute function prevent_run_scoring_engine_change();

create or replace function nonempty_unique_text_array(
  candidate text[]
)
returns boolean
language sql
immutable
as $$
  select coalesce(cardinality(candidate),0) > 0
    and not exists (
      select 1
      from unnest(candidate) item
      where item is null or btrim(item) = ''
    )
    and cardinality(candidate) = (
      select count(distinct item)
      from unnest(candidate) item
    );
$$;

create table judge_invocations (
  id uuid primary key default gen_random_uuid(),
  benchmark_run_id uuid not null references benchmark_runs(id),
  model_response_id uuid not null references model_responses(id),
  score_profile_id uuid not null references score_profiles(id),
  scoring_engine_version_id uuid not null
    references scoring_engine_versions(id),
  parent_invocation_id uuid references judge_invocations(id),
  invocation_kind text not null check (
    invocation_kind in ('PRIMARY','FALLBACK')
  ),
  attempt integer not null check (attempt > 0),
  logical_key text not null check (btrim(logical_key) <> ''),
  idempotency_key text not null unique check (
    btrim(idempotency_key) <> ''
  ),
  state text not null default 'REQUESTED' check (
    state in (
      'REQUESTED',
      'RESPONSE_RECEIVED',
      'PARSED',
      'PERSISTED',
      'FAILED'
    )
  ),
  requested_metric_keys text[] not null check (
    nonempty_unique_text_array(requested_metric_keys)
  ),
  resolved_metric_keys text[] not null default array[]::text[],
  missing_metric_keys text[] not null default array[]::text[],
  request_snapshot jsonb not null check (
    jsonb_typeof(request_snapshot) = 'object'
  ),
  request_hash text not null check (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  provider_key text not null check (btrim(provider_key) <> ''),
  model_id text not null check (btrim(model_id) <> ''),
  provider_request_id text,
  response_model_id text check (
    response_model_id is null or btrim(response_model_id) <> ''
  ),
  response_model_snapshot text,
  finish_reason text,
  input_tokens integer check (
    input_tokens is null or input_tokens >= 0
  ),
  output_tokens integer check (
    output_tokens is null or output_tokens >= 0
  ),
  latency_ms integer check (
    latency_ms is null or latency_ms >= 0
  ),
  raw_response jsonb,
  response_text text,
  parsed_response jsonb,
  error_code text,
  error_message text,
  error_stage text check (
    error_stage is null
    or error_stage in (
      'REQUEST',
      'PROVIDER',
      'RESPONSE_PERSIST',
      'PARSE',
      'SCORE_PERSIST',
      'RECOVERY'
    )
  ),
  requested_at timestamptz not null default now(),
  response_received_at timestamptz,
  parsed_at timestamptz,
  persisted_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(
    model_response_id,
    score_profile_id,
    scoring_engine_version_id,
    logical_key,
    attempt
  ),
  check (
    (invocation_kind='PRIMARY' and parent_invocation_id is null)
    or (
      invocation_kind='FALLBACK'
      and parent_invocation_id is not null
      and parent_invocation_id <> id
      and cardinality(requested_metric_keys)=1
    )
  ),
  check (
    resolved_metric_keys <@ requested_metric_keys
    and missing_metric_keys <@ requested_metric_keys
    and not (resolved_metric_keys && missing_metric_keys)
  ),
  check (
    response_received_at is null
    or response_received_at >= requested_at
  ),
  check (
    parsed_at is null
    or (
      response_received_at is not null
      and parsed_at >= response_received_at
    )
  ),
  check (
    persisted_at is null
    or (parsed_at is not null and persisted_at >= parsed_at)
  ),
  check (failed_at is null or failed_at >= requested_at),
  check (
    (
      state='REQUESTED'
      and provider_request_id is null
      and response_model_id is null
      and response_model_snapshot is null
      and finish_reason is null
      and input_tokens is null
      and output_tokens is null
      and latency_ms is null
      and raw_response is null
      and response_text is null
      and response_received_at is null
      and parsed_response is null
      and parsed_at is null
      and persisted_at is null
      and error_code is null
      and error_message is null
      and error_stage is null
      and failed_at is null
      and cardinality(resolved_metric_keys)=0
      and cardinality(missing_metric_keys)=0
    )
    or (
      state='RESPONSE_RECEIVED'
      and raw_response is not null
      and response_text is not null
      and response_model_id is not null
      and btrim(response_model_id) <> ''
      and latency_ms is not null
      and response_received_at is not null
      and parsed_response is null
      and parsed_at is null
      and persisted_at is null
      and error_code is null
      and error_message is null
      and error_stage is null
      and failed_at is null
      and cardinality(resolved_metric_keys)=0
      and cardinality(missing_metric_keys)=0
    )
    or (
      state='PARSED'
      and raw_response is not null
      and response_text is not null
      and response_model_id is not null
      and btrim(response_model_id) <> ''
      and latency_ms is not null
      and response_received_at is not null
      and parsed_response is not null
      and jsonb_typeof(parsed_response)='object'
      and parsed_at is not null
      and persisted_at is null
      and error_code is null
      and error_message is null
      and error_stage is null
      and failed_at is null
      and cardinality(resolved_metric_keys)
        + cardinality(missing_metric_keys)
        = cardinality(requested_metric_keys)
    )
    or (
      state='PERSISTED'
      and raw_response is not null
      and response_text is not null
      and response_model_id is not null
      and btrim(response_model_id) <> ''
      and latency_ms is not null
      and response_received_at is not null
      and parsed_response is not null
      and jsonb_typeof(parsed_response)='object'
      and parsed_at is not null
      and persisted_at is not null
      and error_code is null
      and error_message is null
      and error_stage is null
      and failed_at is null
      and cardinality(resolved_metric_keys)
        + cardinality(missing_metric_keys)
        = cardinality(requested_metric_keys)
    )
    or (
      state='FAILED'
      and btrim(coalesce(error_code,'')) <> ''
      and btrim(coalesce(error_message,'')) <> ''
      and error_stage is not null
      and failed_at is not null
      and persisted_at is null
    )
  )
);

create index judge_invocations_run_timeline_idx
  on judge_invocations(benchmark_run_id,requested_at,id);

create index judge_invocations_response_idx
  on judge_invocations(model_response_id,requested_at,id);

create index judge_invocations_recovery_idx
  on judge_invocations(state,updated_at)
  where state in ('REQUESTED','RESPONSE_RECEIVED','PARSED');

create or replace function prepare_judge_invocation()
returns trigger
language plpgsql
as $$
declare
  response_run_id uuid;
  run_profile_id uuid;
  run_engine_id uuid;
  run_engine_provenance text;
  run_judge_provider text;
  run_judge_model text;
  parent_record judge_invocations%rowtype;
begin
  select
    item.benchmark_run_id,
    run.score_profile_id,
    run.scoring_engine_version_id,
    run.scoring_engine_snapshot_provenance,
    run.score_profile_snapshot->>'judgeProvider',
    run.score_profile_snapshot->>'judgeModel'
  into
    response_run_id,
    run_profile_id,
    run_engine_id,
    run_engine_provenance,
    run_judge_provider,
    run_judge_model
  from model_responses response
  join run_items item on item.id=response.run_item_id
  join benchmark_runs run on run.id=item.benchmark_run_id
  where response.id=new.model_response_id
  for share of response,item,run;

  if response_run_id is null then
    raise exception 'Judge invocation model response does not exist'
      using errcode='23503';
  end if;
  if new.benchmark_run_id is distinct from response_run_id
     or new.score_profile_id is distinct from run_profile_id
     or new.scoring_engine_version_id is distinct from run_engine_id
     or run_engine_provenance <> 'AT_CREATION_VERIFIED'
     or run_judge_provider is null
     or run_judge_model is null
     or new.provider_key is distinct from run_judge_provider
     or new.model_id is distinct from run_judge_model then
    raise exception 'Judge invocation context does not match the verified benchmark run'
      using errcode='23514';
  end if;

  if new.invocation_kind='FALLBACK' then
    select *
    into parent_record
    from judge_invocations
    where id=new.parent_invocation_id
    for share;

    if parent_record.id is null
       or parent_record.invocation_kind <> 'PRIMARY'
       or parent_record.state <> 'PERSISTED'
       or parent_record.benchmark_run_id
          is distinct from new.benchmark_run_id
       or parent_record.model_response_id
          is distinct from new.model_response_id
       or parent_record.score_profile_id
          is distinct from new.score_profile_id
       or parent_record.scoring_engine_version_id
          is distinct from new.scoring_engine_version_id
       or not (
         new.requested_metric_keys[1] =
           any(parent_record.missing_metric_keys)
       ) then
      raise exception 'fallback Judge invocation requires a matching persisted primary invocation and one missing metric'
        using errcode='23514';
    end if;
  end if;

  new.request_hash :=
    scoring_engine_definition_hash(new.request_snapshot);
  return new;
end;
$$;

create trigger judge_invocations_10_prepare
before insert on judge_invocations
for each row execute function prepare_judge_invocation();

create or replace function guard_judge_invocation_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op='DELETE' then
    raise exception 'Judge invocations are immutable and cannot be deleted'
      using errcode='55000';
  end if;

  if old.state in ('PERSISTED','FAILED') then
    raise exception 'terminal Judge invocations are immutable'
      using errcode='55000';
  end if;

  if new.benchmark_run_id is distinct from old.benchmark_run_id
     or new.model_response_id is distinct from old.model_response_id
     or new.score_profile_id is distinct from old.score_profile_id
     or new.scoring_engine_version_id
        is distinct from old.scoring_engine_version_id
     or new.parent_invocation_id
        is distinct from old.parent_invocation_id
     or new.invocation_kind is distinct from old.invocation_kind
     or new.attempt is distinct from old.attempt
     or new.logical_key is distinct from old.logical_key
     or new.idempotency_key is distinct from old.idempotency_key
     or new.requested_metric_keys
        is distinct from old.requested_metric_keys
     or new.request_snapshot is distinct from old.request_snapshot
     or new.request_hash is distinct from old.request_hash
     or new.provider_key is distinct from old.provider_key
     or new.model_id is distinct from old.model_id
     or new.requested_at is distinct from old.requested_at then
    raise exception 'Judge invocation request context is immutable'
      using errcode='55000';
  end if;

  if not (
    (old.state='REQUESTED'
      and new.state in ('RESPONSE_RECEIVED','FAILED'))
    or (old.state='RESPONSE_RECEIVED'
      and new.state in ('PARSED','FAILED'))
    or (old.state='PARSED'
      and new.state in ('PERSISTED','FAILED'))
  ) then
    raise exception 'invalid Judge invocation state transition: % -> %',
      old.state,new.state
      using errcode='55000';
  end if;

  if old.state in ('RESPONSE_RECEIVED','PARSED')
     and (
       new.provider_request_id
         is distinct from old.provider_request_id
       or new.response_model_id
         is distinct from old.response_model_id
       or new.response_model_snapshot
         is distinct from old.response_model_snapshot
       or new.finish_reason is distinct from old.finish_reason
       or new.input_tokens is distinct from old.input_tokens
       or new.output_tokens is distinct from old.output_tokens
       or new.latency_ms is distinct from old.latency_ms
       or new.raw_response is distinct from old.raw_response
       or new.response_text is distinct from old.response_text
       or new.response_received_at
         is distinct from old.response_received_at
     ) then
    raise exception 'persisted Judge provider response is immutable'
      using errcode='55000';
  end if;

  if old.state='PARSED'
     and (
       new.parsed_response is distinct from old.parsed_response
       or new.resolved_metric_keys
          is distinct from old.resolved_metric_keys
       or new.missing_metric_keys
          is distinct from old.missing_metric_keys
       or new.parsed_at is distinct from old.parsed_at
     ) then
    raise exception 'parsed Judge response is immutable'
      using errcode='55000';
  end if;

  if old.state='PARSED' and new.state='PERSISTED'
     and (
       exists (
         (
           select metric
           from unnest(new.resolved_metric_keys) metric
         )
         except
         (
           select score.metric_key
           from scores score
           where score.judge_invocation_id=old.id
             and score.provenance='JUDGE_INVOCATION_VERIFIED'
         )
       )
       or exists (
         (
           select score.metric_key
           from scores score
           where score.judge_invocation_id=old.id
             and score.provenance='JUDGE_INVOCATION_VERIFIED'
         )
         except
         (
           select metric
           from unnest(new.resolved_metric_keys) metric
         )
       )
     ) then
    raise exception 'persisted Judge invocation scores must exactly match its resolved metrics'
      using errcode='23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger judge_invocations_guard_update
before update or delete on judge_invocations
for each row execute function guard_judge_invocation_update();

alter table scores
  add column judge_invocation_id uuid
    references judge_invocations(id),
  add column provenance text;

update scores
set
  judge_invocation_id=null,
  provenance='LEGACY_UNVERIFIED';

alter table scores
  alter column provenance set default 'LEGACY_UNVERIFIED',
  alter column provenance set not null,
  add constraint scores_provenance_check check (
    provenance in (
      'LEGACY_UNVERIFIED',
      'DETERMINISTIC_ENGINE_VERIFIED',
      'JUDGE_INVOCATION_VERIFIED'
    )
  ),
  add constraint scores_provenance_link_check check (
    (
      provenance='LEGACY_UNVERIFIED'
      and judge_invocation_id is null
    )
    or (
      provenance='DETERMINISTIC_ENGINE_VERIFIED'
      and judge_invocation_id is null
      and judge_provider is null
      and judge_model is null
      and judge_request_id is null
      and metric_key in ('exact_match','response_present')
    )
    or (
      provenance='JUDGE_INVOCATION_VERIFIED'
      and judge_invocation_id is not null
      and judge_provider is not null
      and judge_model is not null
    )
  );

create index scores_judge_invocation_idx
  on scores(judge_invocation_id)
  where judge_invocation_id is not null;

create or replace function validate_score_audit_context()
returns trigger
language plpgsql
as $$
declare
  invocation judge_invocations%rowtype;
  response_profile_id uuid;
  response_engine_id uuid;
  response_engine_provenance text;
begin
  if tg_op='UPDATE'
     and (
       new.model_response_id is distinct from old.model_response_id
       or new.score_profile_id is distinct from old.score_profile_id
       or new.metric_key is distinct from old.metric_key
       or new.judge_invocation_id
          is distinct from old.judge_invocation_id
       or new.provenance is distinct from old.provenance
       or new.judge_provider is distinct from old.judge_provider
       or new.judge_model is distinct from old.judge_model
       or new.judge_request_id is distinct from old.judge_request_id
     ) then
    raise exception 'score audit context is immutable'
      using errcode='55000';
  end if;

  select
    run.score_profile_id,
    run.scoring_engine_version_id,
    run.scoring_engine_snapshot_provenance
  into
    response_profile_id,
    response_engine_id,
    response_engine_provenance
  from model_responses response
  join run_items item on item.id=response.run_item_id
  join benchmark_runs run on run.id=item.benchmark_run_id
  where response.id=new.model_response_id
  for share of response,item,run;

  if new.provenance='LEGACY_UNVERIFIED' then
    if response_profile_id is null
       or response_profile_id is distinct from new.score_profile_id
       or response_engine_provenance
          is distinct from 'LEGACY_BACKFILL_UNVERIFIED' then
      raise exception 'legacy score provenance is allowed only for a legacy unverified benchmark run'
        using errcode='23514';
    end if;
    return new;
  end if;

  if response_profile_id is null
     or response_profile_id is distinct from new.score_profile_id
     or response_engine_id is null
     or response_engine_provenance <> 'AT_CREATION_VERIFIED' then
    raise exception 'verified score context does not match a verified benchmark run'
      using errcode='23514';
  end if;

  if new.provenance='JUDGE_INVOCATION_VERIFIED' then
    select *
    into invocation
    from judge_invocations
    where id=new.judge_invocation_id
    for share;

    if invocation.id is null
       or invocation.state not in ('PARSED','PERSISTED')
       or invocation.model_response_id
          is distinct from new.model_response_id
       or invocation.score_profile_id
          is distinct from new.score_profile_id
       or invocation.scoring_engine_version_id
          is distinct from response_engine_id
       or not (new.metric_key=any(invocation.resolved_metric_keys))
       or new.judge_provider is distinct from invocation.provider_key
       or new.judge_model is distinct from invocation.model_id
       or new.judge_request_id
          is distinct from invocation.provider_request_id then
      raise exception 'verified Judge score does not match its persisted invocation context'
        using errcode='23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger scores_validate_audit_context
before insert or update of
  model_response_id,
  score_profile_id,
  metric_key,
  judge_invocation_id,
  provenance,
  judge_provider,
  judge_model,
  judge_request_id
on scores
for each row execute function validate_score_audit_context();

create or replace function prevent_verified_score_change()
returns trigger
language plpgsql
as $$
begin
  if old.provenance in (
    'DETERMINISTIC_ENGINE_VERIFIED',
    'JUDGE_INVOCATION_VERIFIED'
  ) then
    raise exception 'verified scores are immutable; use a human score override'
      using errcode='55000';
  end if;
  if tg_op='DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger scores_verified_immutable
before update or delete on scores
for each row execute function prevent_verified_score_change();

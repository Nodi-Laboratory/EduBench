create or replace function score_profile_judge_provenance_resolved(
  profile_judge_provider text,
  profile_judge_model text
)
returns boolean
language sql
immutable
as $$
  select case
    when profile_judge_provider is null and profile_judge_model is null then true
    when profile_judge_provider is null or profile_judge_model is null then false
    when btrim(profile_judge_provider) = '' or btrim(profile_judge_model) = '' then false
    when profile_judge_provider in (
      'legacy-environment-default-unrecorded',
      'legacy-provider-unrecorded'
    ) then false
    when profile_judge_model in (
      'legacy-environment-default-unrecorded',
      'legacy-provider-unrecorded'
    ) then false
    else true
  end;
$$;

create or replace function score_profile_definition_usable(
  profile_metrics jsonb,
  profile_judge_provider text,
  profile_judge_model text
)
returns boolean
language sql
immutable
as $$
  select score_profile_judge_provenance_resolved(
      profile_judge_provider,
      profile_judge_model
    )
    and case
      when profile_metrics is null
        or jsonb_typeof(profile_metrics) <> 'array'
        then false
      when exists (
        select 1
        from jsonb_array_elements_text(profile_metrics) metric
        where metric not in ('exact_match', 'response_present')
      )
        then profile_judge_provider is not null
          and profile_judge_model is not null
          and btrim(profile_judge_provider) <> ''
          and btrim(profile_judge_model) <> ''
      else true
    end;
$$;

create or replace function infer_score_profile_snapshot_provenance(
  run_created_at timestamptz
)
returns text
language sql
stable
as $$
  select case
    when run_created_at < coalesce(
      (
        select applied_at
        from schema_migrations
        where version = '0015_score_profile_consistency.sql'
      ),
      'infinity'::timestamptz
    )
      then 'LEGACY_BACKFILL_UNVERIFIED'
    else 'AT_CREATION_VERIFIED'
  end;
$$;

alter table benchmark_runs
  add column if not exists score_profile_snapshot_provenance text;

update benchmark_runs
set score_profile_snapshot_provenance =
  infer_score_profile_snapshot_provenance(created_at)
where score_profile_snapshot_provenance is null;

alter table benchmark_runs
  alter column score_profile_snapshot_provenance
    set default 'AT_CREATION_VERIFIED',
  alter column score_profile_snapshot_provenance
    set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'benchmark_runs'::regclass
      and conname = 'benchmark_runs_score_profile_snapshot_provenance'
  ) then
    alter table benchmark_runs
      add constraint benchmark_runs_score_profile_snapshot_provenance
      check (
        score_profile_snapshot_provenance in (
          'LEGACY_BACKFILL_UNVERIFIED',
          'AT_CREATION_VERIFIED'
        )
      );
  end if;
end;
$$;

create or replace function benchmark_run_score_profile_usable(
  profile_snapshot jsonb,
  snapshot_provenance text
)
returns boolean
language sql
immutable
as $$
  select snapshot_provenance = 'AT_CREATION_VERIFIED'
    and score_profile_definition_usable(
      profile_snapshot->'metrics',
      profile_snapshot->>'judgeProvider',
      profile_snapshot->>'judgeModel'
    );
$$;

create or replace function snapshot_benchmark_run_score_profile()
returns trigger
language plpgsql
as $$
declare
  profile_snapshot jsonb;
  profile_judge_provider text;
  profile_judge_model text;
begin
  select
    jsonb_build_object(
      'id', sp.id,
      'version', sp.version,
      'title', sp.title,
      'metrics', sp.metrics,
      'weights', sp.weights,
      'rubricPrompt', sp.rubric_prompt,
      'judgeProvider', sp.judge_provider,
      'judgeModel', sp.judge_model,
      'contentHash', sp.content_hash
    ),
    sp.judge_provider,
    sp.judge_model
  into
    profile_snapshot,
    profile_judge_provider,
    profile_judge_model
  from score_profiles sp
  where sp.id = new.score_profile_id
  for share;

  if profile_snapshot is null then
    raise exception 'score profile does not exist'
      using errcode = '23503';
  end if;

  if not score_profile_definition_usable(
    profile_snapshot->'metrics',
    profile_judge_provider,
    profile_judge_model
  ) then
    raise exception 'score profile Judge configuration or provenance is unusable; create a new score profile version'
      using errcode = '55000';
  end if;

  new.score_profile_snapshot = profile_snapshot;
  new.score_profile_snapshot_provenance = 'AT_CREATION_VERIFIED';
  return new;
end;
$$;

create or replace function prevent_run_score_profile_change()
returns trigger
language plpgsql
as $$
begin
  if new.score_profile_id is distinct from old.score_profile_id
     or new.score_profile_snapshot is distinct from old.score_profile_snapshot
     or new.score_profile_snapshot_provenance
        is distinct from old.score_profile_snapshot_provenance then
    raise exception 'a benchmark run score profile reference, snapshot, and provenance are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists benchmark_run_score_profile_immutable
  on benchmark_runs;

create trigger benchmark_run_score_profile_immutable
before update of
  score_profile_id,
  score_profile_snapshot,
  score_profile_snapshot_provenance
on benchmark_runs
for each row execute function prevent_run_score_profile_change();

create or replace function mark_score_profile_replacement_required_runs()
returns integer
language plpgsql
as $$
declare
  affected_count integer;
begin
  with affected as (
    select
      br.id,
      br.state as previous_state,
      br.score_profile_snapshot_provenance,
      score_profile_judge_provenance_resolved(
        br.score_profile_snapshot->>'judgeProvider',
        br.score_profile_snapshot->>'judgeModel'
      ) as judge_provenance_resolved,
      score_profile_definition_usable(
        br.score_profile_snapshot->'metrics',
        br.score_profile_snapshot->>'judgeProvider',
        br.score_profile_snapshot->>'judgeModel'
      ) as profile_definition_usable
    from benchmark_runs br
    where not benchmark_run_score_profile_usable(
      br.score_profile_snapshot,
      br.score_profile_snapshot_provenance
    )
  ),
  updated as (
    update benchmark_runs br
    set
      state = case
        when br.state = 'SCORING' then 'FAILED'
        else br.state
      end,
      last_scoring_error = jsonb_build_object(
        'code', 'SCORE_PROFILE_REPLACEMENT_REQUIRED',
        'message', '채점 프로필 또는 생성 시점 스냅샷 출처가 검증되지 않았습니다. 새 채점 프로필 버전과 새 실행을 생성하십시오.',
        'attempts', 0,
        'at', now(),
        'replacementRequired', true,
        'snapshotProvenance', affected.score_profile_snapshot_provenance,
        'judgeProvenanceResolved', affected.judge_provenance_resolved,
        'profileDefinitionUsable', affected.profile_definition_usable
      ),
      updated_at = now()
    from affected
    where br.id = affected.id
    returning
      br.id,
      affected.previous_state,
      br.state,
      affected.score_profile_snapshot_provenance,
      affected.judge_provenance_resolved,
      affected.profile_definition_usable
  ),
  inserted_events as (
    insert into job_events(
      aggregate_type,
      aggregate_id,
      event_type,
      payload
    )
    select
      'benchmark_run',
      updated.id,
      'RUN_SCORE_PROFILE_REPLACEMENT_REQUIRED',
      jsonb_build_object(
        'previousState', updated.previous_state,
        'state', updated.state,
        'snapshotProvenance', updated.score_profile_snapshot_provenance,
        'judgeProvenanceResolved', updated.judge_provenance_resolved,
        'profileDefinitionUsable', updated.profile_definition_usable,
        'replacementRequired', true
      )
    from updated
    where not exists (
      select 1
      from job_events existing
      where existing.aggregate_type = 'benchmark_run'
        and existing.aggregate_id = updated.id
        and existing.event_type =
          'RUN_SCORE_PROFILE_REPLACEMENT_REQUIRED'
    )
    returning 1
  )
  select count(*)::integer
  into affected_count
  from updated;

  return affected_count;
end;
$$;

select mark_score_profile_replacement_required_runs();

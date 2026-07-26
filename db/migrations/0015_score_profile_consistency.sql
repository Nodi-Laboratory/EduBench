create or replace function valid_score_metric_weights(candidate jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(candidate) = 'object'
    and not exists (
      select 1
      from jsonb_each(candidate) entry
      where case
        when jsonb_typeof(entry.value) = 'number'
          then (entry.value #>> '{}')::numeric < 0
        else true
      end
    );
$$;

update score_profiles
set weights = '{}'::jsonb
where weights is null;

alter table score_profiles
  alter column weights set default '{}'::jsonb,
  alter column weights set not null;

alter table score_profiles
  add constraint score_profiles_weights_valid
  check (valid_score_metric_weights(weights));

-- Older installations could not prove which environment-default Judge model was
-- used. Keep that uncertainty explicit rather than silently substituting a model.
update score_profiles
set judge_model = 'legacy-environment-default-unrecorded'
where judge_provider is not null
  and judge_model is null;

update score_profiles
set judge_provider = 'legacy-provider-unrecorded'
where judge_provider is null
  and judge_model is not null;

alter table score_profiles
  add constraint score_profiles_judge_pair
  check (
    (judge_provider is null and judge_model is null)
    or (judge_provider is not null and judge_model is not null)
  );

create or replace function score_profile_definition_hash(
  profile_version text,
  profile_title text,
  profile_metrics jsonb,
  profile_weights jsonb,
  profile_rubric_prompt text,
  profile_judge_provider text,
  profile_judge_model text
)
returns text
language sql
immutable
as $$
  select encode(digest(
    jsonb_build_object(
      'version', profile_version,
      'title', profile_title,
      'metrics', profile_metrics,
      'weights', profile_weights,
      'rubricPrompt', profile_rubric_prompt,
      'judgeProvider', profile_judge_provider,
      'judgeModel', profile_judge_model
    )::text,
    'sha256'
  ), 'hex');
$$;

create or replace function refresh_score_profile_content_hash()
returns trigger
language plpgsql
as $$
begin
  new.content_hash = score_profile_definition_hash(
    new.version,
    new.title,
    new.metrics,
    new.weights,
    new.rubric_prompt,
    new.judge_provider,
    new.judge_model
  );
  return new;
end;
$$;

create trigger score_profiles_refresh_content_hash
before insert or update on score_profiles
for each row execute function refresh_score_profile_content_hash();

update score_profiles
set content_hash = score_profile_definition_hash(
  version,
  title,
  metrics,
  weights,
  rubric_prompt,
  judge_provider,
  judge_model
);

alter table benchmark_runs
  add column score_profile_snapshot jsonb;

update benchmark_runs br
set score_profile_snapshot = jsonb_build_object(
  'id', sp.id,
  'version', sp.version,
  'title', sp.title,
  'metrics', sp.metrics,
  'weights', sp.weights,
  'rubricPrompt', sp.rubric_prompt,
  'judgeProvider', sp.judge_provider,
  'judgeModel', sp.judge_model,
  'contentHash', sp.content_hash
)
from score_profiles sp
where sp.id = br.score_profile_id;

alter table benchmark_runs
  alter column score_profile_snapshot set not null;

create or replace function snapshot_benchmark_run_score_profile()
returns trigger
language plpgsql
as $$
begin
  select jsonb_build_object(
    'id', sp.id,
    'version', sp.version,
    'title', sp.title,
    'metrics', sp.metrics,
    'weights', sp.weights,
    'rubricPrompt', sp.rubric_prompt,
    'judgeProvider', sp.judge_provider,
    'judgeModel', sp.judge_model,
    'contentHash', sp.content_hash
  )
  into new.score_profile_snapshot
  from score_profiles sp
  where sp.id = new.score_profile_id
  for key share;

  if new.score_profile_snapshot is null then
    raise exception 'score profile does not exist'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger benchmark_runs_snapshot_score_profile
before insert on benchmark_runs
for each row execute function snapshot_benchmark_run_score_profile();

create or replace function prevent_used_score_profile_change()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from benchmark_runs where score_profile_id = old.id
  ) then
    raise exception 'a score profile used by a benchmark run is immutable'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger score_profiles_used_immutable
before update or delete on score_profiles
for each row execute function prevent_used_score_profile_change();

create or replace function prevent_run_score_profile_change()
returns trigger
language plpgsql
as $$
begin
  if new.score_profile_id is distinct from old.score_profile_id
     or new.score_profile_snapshot is distinct from old.score_profile_snapshot then
    raise exception 'a benchmark run score profile reference and snapshot are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger benchmark_run_score_profile_immutable
before update of score_profile_id, score_profile_snapshot on benchmark_runs
for each row execute function prevent_run_score_profile_change();

create view eligible_model_responses as
select *
from model_responses
where ignored_after_cancel = false;

-- Some databases recorded an earlier 0015 before the final Judge-pair guard and
-- the stronger snapshot row lock were added. Repair those databases safely.
do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'score_profiles'::regclass
      and tgname = 'score_profiles_used_immutable'
      and not tgisinternal
  ) then
    alter table score_profiles disable trigger score_profiles_used_immutable;
  end if;
end;
$$;

update score_profiles
set judge_model = 'legacy-environment-default-unrecorded'
where judge_provider is not null
  and judge_model is null;

update score_profiles
set judge_provider = 'legacy-provider-unrecorded'
where judge_provider is null
  and judge_model is not null;

do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'score_profiles'::regclass
      and tgname = 'score_profiles_used_immutable'
      and not tgisinternal
  ) then
    alter table score_profiles enable trigger score_profiles_used_immutable;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'score_profiles'::regclass
      and conname = 'score_profiles_judge_pair'
  ) then
    alter table score_profiles
      add constraint score_profiles_judge_pair
      check (
        (judge_provider is null and judge_model is null)
        or (judge_provider is not null and judge_model is not null)
      );
  end if;
end;
$$;

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
  for share;

  if new.score_profile_snapshot is null then
    raise exception 'score profile does not exist'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'benchmark_runs'::regclass
      and tgname = 'benchmark_runs_snapshot_score_profile'
      and not tgisinternal
  ) then
    create trigger benchmark_runs_snapshot_score_profile
    before insert on benchmark_runs
    for each row execute function snapshot_benchmark_run_score_profile();
  end if;
end;
$$;

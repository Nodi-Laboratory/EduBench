alter table benchmark_runs
  add column retrieval_modes text[] not null
    default array['LEGACY_EVIDENCE']::text[],
  add column retrieval_config_snapshot jsonb not null
    default '{"schemaVersion":1,"strategy":"legacy-question-evidence"}'::jsonb,
  add column retrieval_config_hash text,
  add column retrieval_snapshot_provenance text not null
    default 'LEGACY_BACKFILL_UNVERIFIED';

alter table benchmark_runs
  add constraint benchmark_runs_retrieval_modes_check check (
    cardinality(retrieval_modes) > 0
    and retrieval_modes <@ array[
      'LEGACY_EVIDENCE','NONE','VECTOR','PIKE'
    ]::text[]
  ),
  add constraint benchmark_runs_retrieval_snapshot_check check (
    (
      retrieval_snapshot_provenance='LEGACY_BACKFILL_UNVERIFIED'
      and retrieval_modes=array['LEGACY_EVIDENCE']::text[]
      and retrieval_config_hash is null
    )
    or (
      retrieval_snapshot_provenance='AT_CREATION_VERIFIED'
      and not (retrieval_modes && array['LEGACY_EVIDENCE']::text[])
      and retrieval_config_hash is not null
      and retrieval_config_hash ~ '^[0-9a-f]{64}$'
    )
  );

create or replace function prevent_benchmark_retrieval_config_change()
returns trigger
language plpgsql
as $$
begin
  if new.retrieval_modes is distinct from old.retrieval_modes
     or new.retrieval_config_snapshot
          is distinct from old.retrieval_config_snapshot
     or new.retrieval_config_hash
          is distinct from old.retrieval_config_hash
     or new.retrieval_snapshot_provenance
          is distinct from old.retrieval_snapshot_provenance then
    raise exception 'benchmark retrieval configuration is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger benchmark_runs_retrieval_config_immutable
before update of
  retrieval_modes,
  retrieval_config_snapshot,
  retrieval_config_hash,
  retrieval_snapshot_provenance
on benchmark_runs
for each row execute function prevent_benchmark_retrieval_config_change();

alter table run_items
  add column retrieval_mode text not null default 'LEGACY_EVIDENCE';

alter table run_items
  add constraint run_items_retrieval_mode_check check (
    retrieval_mode in ('LEGACY_EVIDENCE','NONE','VECTOR','PIKE')
  );

alter table run_items
  drop constraint run_items_benchmark_run_id_run_model_id_question_id_key;

alter table run_items
  add constraint run_items_run_model_question_retrieval_key unique(
    benchmark_run_id,
    run_model_id,
    question_id,
    retrieval_mode
  );

create table run_item_retrievals (
  id uuid primary key default gen_random_uuid(),
  run_item_id uuid not null unique
    references run_items(id) on delete cascade,
  retrieval_mode text not null,
  query_text text,
  embedding_model text,
  embedding_profile_hash text,
  vector_space_id text,
  candidate_scope jsonb not null default '{}'::jsonb,
  selected_chunks jsonb not null default '[]'::jsonb,
  graph_trace jsonb not null default '{}'::jsonb,
  config_snapshot jsonb not null,
  config_hash text not null
    check (config_hash ~ '^[0-9a-f]{64}$'),
  rendered_context text not null default '',
  context_hash text not null
    check (context_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (
    retrieval_mode in ('LEGACY_EVIDENCE','NONE','VECTOR','PIKE')
  ),
  check (jsonb_typeof(candidate_scope)='object'),
  check (jsonb_typeof(selected_chunks)='array'),
  check (jsonb_typeof(graph_trace)='object'),
  check (jsonb_typeof(config_snapshot)='object')
);

create index run_item_retrievals_mode_idx
  on run_item_retrievals(retrieval_mode,created_at);

create or replace function enforce_run_item_retrieval_mode()
returns trigger
language plpgsql
as $$
declare
  stored_mode text;
begin
  select retrieval_mode
    into stored_mode
    from run_items
   where id=new.run_item_id
   for share;
  if not found then
    raise exception 'run item does not exist'
      using errcode='23503';
  end if;
  if new.retrieval_mode is distinct from stored_mode then
    raise exception 'run item retrieval mode mismatch'
      using errcode='23514';
  end if;
  return new;
end;
$$;

create trigger run_item_retrievals_match_item_mode
before insert on run_item_retrievals
for each row execute function enforce_run_item_retrieval_mode();

create or replace function prevent_run_item_retrieval_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'run item retrieval audit is immutable'
    using errcode='55000';
end;
$$;

create trigger run_item_retrievals_immutable
before update or delete on run_item_retrievals
for each row execute function prevent_run_item_retrieval_change();

create or replace function prevent_run_item_retrieval_mode_change()
returns trigger
language plpgsql
as $$
begin
  if new.retrieval_mode is distinct from old.retrieval_mode then
    raise exception 'run item retrieval mode is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger run_items_retrieval_mode_immutable
before update of retrieval_mode on run_items
for each row execute function prevent_run_item_retrieval_mode_change();

-- Strengthen retrieval audit immutability for databases that applied the
-- initial retrieval-mode migration during development, and preserve
-- per-attempt request pacing without overwriting the first start timestamp.

alter table benchmark_runs
  add constraint benchmark_runs_verified_retrieval_hash_required check (
    retrieval_snapshot_provenance <> 'AT_CREATION_VERIFIED'
    or retrieval_config_hash is not null
  );

drop trigger if exists run_item_retrievals_immutable
  on run_item_retrievals;

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

drop trigger if exists run_items_retrieval_mode_immutable on run_items;

create trigger run_items_retrieval_mode_immutable
before update of retrieval_mode on run_items
for each row execute function prevent_run_item_retrieval_mode_change();

alter table run_items
  add column last_attempt_started_at timestamptz;

update run_items
set last_attempt_started_at=started_at
where started_at is not null;

create index run_items_model_last_attempt_idx
  on run_items(run_model_id,last_attempt_started_at desc);

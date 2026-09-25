-- Pin the exact question-generation retrieval artifact used by a benchmark
-- item. This prevents a later generation retry from silently changing the
-- VECTOR/PIKE treatment after the benchmark run has been created.

alter table run_items
  add column generation_retrieval_id uuid
    references generation_retrievals(id);

create index run_items_generation_retrieval_idx
  on run_items(generation_retrieval_id)
  where generation_retrieval_id is not null;

create or replace function prevent_run_item_generation_retrieval_change()
returns trigger
language plpgsql
as $$
begin
  if new.generation_retrieval_id
       is distinct from old.generation_retrieval_id then
    raise exception 'run item generation retrieval pin is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger run_items_generation_retrieval_immutable
before update of generation_retrieval_id on run_items
for each row
execute function prevent_run_item_generation_retrieval_change();

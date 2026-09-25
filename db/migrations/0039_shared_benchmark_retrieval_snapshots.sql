-- Every candidate model in one run must receive exactly the same retrieval
-- context for a question and condition. Keep a per-item audit row while
-- recording which row first materialized the shared snapshot.

alter table run_item_retrievals
  add column shared_snapshot_key text
    check (
      shared_snapshot_key is null
      or shared_snapshot_key ~ '^[0-9a-f]{64}$'
    ),
  add column shared_from_retrieval_id uuid
    references run_item_retrievals(id);

create index run_item_retrievals_shared_snapshot_idx
  on run_item_retrievals(shared_snapshot_key,created_at)
  where shared_snapshot_key is not null;

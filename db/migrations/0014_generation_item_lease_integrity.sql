alter table generation_items
  add column retryable boolean not null default true;

create index generation_items_retryable_claim_idx
  on generation_items(generation_batch_id,ordinal)
  where state='PENDING' or (state='FAILED' and retryable);

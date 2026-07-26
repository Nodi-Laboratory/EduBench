alter table generation_items
  add column claimed_job_id uuid references jobs(id) on delete set null,
  add column claimed_job_attempt integer,
  add constraint generation_items_state_check
    check (state in ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  add constraint generation_items_claimed_job_attempt_check
    check (claimed_job_attempt is null or claimed_job_attempt > 0);

create index generation_items_claimed_job_idx
  on generation_items(claimed_job_id, claimed_job_attempt)
  where state = 'RUNNING';

alter table generation_retrievals
  add column attempt integer not null default 1,
  add constraint generation_retrievals_attempt_check check (attempt > 0);

create unique index generation_retrievals_item_attempt_key
  on generation_retrievals(generation_item_id, attempt)
  where generation_item_id is not null;

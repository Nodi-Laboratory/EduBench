create table generation_retrievals (
  id uuid primary key default gen_random_uuid(),
  generation_batch_id uuid not null references generation_batches(id),
  query_text text not null,
  embedding_model text,
  candidate_scope jsonb not null,
  selected_chunks jsonb not null,
  created_at timestamptz not null default now()
);

create index generation_retrievals_batch_idx on generation_retrievals(generation_batch_id, created_at);

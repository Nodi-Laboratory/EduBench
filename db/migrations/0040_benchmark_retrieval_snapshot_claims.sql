-- Coordinate one retrieval computation per run/question/mode without holding
-- a database connection while an external embedding request is in flight.

create table benchmark_retrieval_snapshot_claims (
  snapshot_key text primary key
    check (snapshot_key ~ '^[0-9a-f]{64}$'),
  benchmark_run_id uuid not null references benchmark_runs(id),
  question_id uuid not null references questions(id),
  question_revision integer not null,
  retrieval_mode text not null
    check (retrieval_mode in ('LEGACY_EVIDENCE','NONE','VECTOR','PIKE')),
  state text not null
    check (state in ('COMPUTING','READY','FAILED')),
  owner_id uuid,
  lease_expires_at timestamptz,
  root_retrieval_id uuid references run_item_retrievals(id),
  error_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      state='COMPUTING'
      and owner_id is not null
      and lease_expires_at is not null
      and root_retrieval_id is null
    )
    or (
      state='READY'
      and owner_id is null
      and lease_expires_at is null
      and root_retrieval_id is not null
      and error_snapshot is null
    )
    or (
      state='FAILED'
      and owner_id is null
      and lease_expires_at is not null
      and root_retrieval_id is null
      and error_snapshot is not null
    )
  ),
  unique(
    benchmark_run_id,
    question_id,
    question_revision,
    retrieval_mode
  )
);

create index benchmark_retrieval_snapshot_claims_wait_idx
  on benchmark_retrieval_snapshot_claims(state,lease_expires_at);

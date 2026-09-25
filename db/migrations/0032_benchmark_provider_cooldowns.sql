create table benchmark_provider_cooldowns (
  provider_key text primary key,
  blocked_until timestamptz not null,
  rate_limit_dimension text not null default 'UNKNOWN'
    check (rate_limit_dimension in ('RPM', 'RPD', 'TPM', 'UNKNOWN')),
  rate_limit_scope text,
  retry_after_ms double precision,
  source_run_id uuid references benchmark_runs(id) on delete set null,
  source_run_item_id uuid references run_items(id) on delete set null,
  source_phase text not null,
  source_model_id text,
  request_id text,
  last_error_message text,
  hit_count integer not null default 1 check (hit_count > 0),
  activated_at timestamptz not null default now(),
  resumed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index benchmark_provider_cooldowns_blocked_idx
  on benchmark_provider_cooldowns(blocked_until);

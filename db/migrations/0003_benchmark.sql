create table dataset_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  status text not null default 'PUBLISHED',
  title text not null,
  description text,
  question_count integer not null,
  distribution jsonb not null,
  content_hash text not null unique,
  parent_version_id uuid references dataset_versions(id),
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now()
);

create table dataset_questions (
  dataset_version_id uuid not null references dataset_versions(id),
  question_id uuid not null references questions(id),
  question_revision integer not null,
  ordinal integer not null,
  primary key(dataset_version_id, question_id),
  unique(dataset_version_id, ordinal)
);

create table score_profiles (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  title text not null,
  metrics jsonb not null,
  rubric_prompt text,
  judge_provider text,
  judge_model text,
  weights jsonb,
  content_hash text not null,
  created_at timestamptz not null default now()
);

create table price_profiles (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  provider_key text not null,
  model_pattern text not null,
  currency text not null default 'USD',
  input_per_million numeric(18,6) not null default 0,
  output_per_million numeric(18,6) not null default 0,
  krw_exchange_rate numeric(18,6),
  valid_from timestamptz not null,
  valid_to timestamptz,
  source_url text,
  created_at timestamptz not null default now(),
  unique(version, provider_key, model_pattern)
);

create table benchmark_runs (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  title text not null,
  state text not null default 'DRAFT',
  dataset_version_id uuid not null references dataset_versions(id),
  score_profile_id uuid not null references score_profiles(id),
  price_profile_version text not null,
  system_prompt text not null,
  parameters jsonb not null default '{}'::jsonb,
  total_items integer not null default 0,
  completed_items integer not null default 0,
  failed_items integer not null default 0,
  pause_requested_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table run_models (
  id uuid primary key default gen_random_uuid(),
  benchmark_run_id uuid not null references benchmark_runs(id),
  provider_key text not null,
  display_name text not null,
  blind_id text not null,
  model_id text not null,
  model_snapshot text,
  protocol text not null,
  parameters jsonb not null default '{}'::jsonb,
  concurrency integer not null default 1,
  request_interval_ms integer not null default 0,
  unique(benchmark_run_id, provider_key),
  unique(benchmark_run_id, blind_id)
);

create table run_items (
  id uuid primary key default gen_random_uuid(),
  benchmark_run_id uuid not null references benchmark_runs(id),
  run_model_id uuid not null references run_models(id),
  question_id uuid not null references questions(id),
  question_revision integer not null,
  state text not null default 'PENDING',
  idempotency_key text not null unique,
  attempts integer not null default 0,
  max_attempts integer not null default 4,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(benchmark_run_id, run_model_id, question_id)
);

create index run_items_claim_idx on run_items(benchmark_run_id, state, available_at);

create table model_responses (
  id uuid primary key default gen_random_uuid(),
  run_item_id uuid not null references run_items(id),
  attempt integer not null,
  provider_request_id text,
  model_id text not null,
  model_snapshot text,
  raw_response jsonb,
  response_text text,
  normalized_text text,
  finish_reason text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  cost_native numeric(18,8),
  cost_currency text,
  cost_krw numeric(18,4),
  ignored_after_cancel boolean not null default false,
  retry_history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique(run_item_id, attempt)
);

create table scores (
  id uuid primary key default gen_random_uuid(),
  model_response_id uuid not null references model_responses(id),
  score_profile_id uuid not null references score_profiles(id),
  metric_key text not null,
  rubric_key text,
  claim_index integer,
  value numeric(10,6),
  label text,
  rationale text,
  evidence jsonb not null default '[]'::jsonb,
  judge_provider text,
  judge_model text,
  judge_request_id text,
  created_at timestamptz not null default now()
);

create index scores_response_metric_idx on scores(model_response_id, metric_key);

create table human_scores (
  id uuid primary key default gen_random_uuid(),
  model_response_id uuid not null references model_responses(id),
  blind_reviewer_id text not null,
  metric_key text not null,
  value numeric(10,6),
  label text,
  rationale text,
  overrides_score_id uuid references scores(id),
  created_at timestamptz not null default now()
);

create table report_artifacts (
  id uuid primary key default gen_random_uuid(),
  benchmark_run_id uuid not null references benchmark_runs(id),
  artifact_type text not null,
  storage_path text not null,
  sha256 text not null,
  parameters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

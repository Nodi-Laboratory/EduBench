create table provider_configs (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique,
  display_name text not null,
  protocol text not null,
  base_url text,
  model_id text,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table source_files (
  id uuid primary key default gen_random_uuid(),
  sha256 text not null unique,
  original_name text not null,
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  subject text,
  grade text,
  publisher text,
  status text not null default 'UPLOADED',
  failed_stage text,
  failure_code text,
  failure_message text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table source_revisions (
  id uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references source_files(id),
  revision integer not null,
  parse_model text,
  parse_request_id text,
  raw_response jsonb,
  raw_html text,
  reviewed_html text,
  review_summary text,
  created_at timestamptz not null default now(),
  unique(source_file_id, revision)
);

create table source_chunks (
  id uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references source_files(id),
  source_revision_id uuid not null references source_revisions(id),
  ordinal integer not null,
  subject text,
  grade text,
  chapter text,
  unit text,
  page_start integer,
  page_end integer,
  kind text not null default 'paragraph',
  html text,
  content text not null,
  token_count integer,
  embedding vector(3072),
  embedding_model text,
  embedding_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(source_revision_id, ordinal)
);

create index source_chunks_source_idx on source_chunks(source_file_id, page_start);
create index source_chunks_metadata_idx on source_chunks using gin(metadata);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  state text not null default 'PENDING',
  priority integer not null default 100,
  payload jsonb not null,
  idempotency_key text not null unique,
  attempts integer not null default 0,
  max_attempts integer not null default 4,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index jobs_claim_idx on jobs(state, available_at, priority, created_at);
create index jobs_lease_idx on jobs(lease_expires_at) where state = 'LEASED';

create table job_events (
  id bigint generated always as identity primary key,
  job_id uuid references jobs(id),
  aggregate_type text not null,
  aggregate_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index job_events_aggregate_idx on job_events(aggregate_type, aggregate_id, id);

create table generation_batches (
  id uuid primary key default gen_random_uuid(),
  state text not null default 'QUEUED',
  requested_count integer not null check (requested_count > 0),
  conditions jsonb not null,
  source_scope jsonb not null,
  generation_model text not null,
  prompt_version text not null,
  progress jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  generation_batch_id uuid references generation_batches(id),
  status text not null default 'DRAFT',
  subject text not null,
  grade text not null,
  chapter text,
  unit text,
  purpose text not null,
  difficulty text not null,
  question_type text not null,
  evidence_mode text not null,
  current_revision integer not null default 1,
  generator_provider text,
  generator_model text,
  embedding_model text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table question_revisions (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id),
  revision integer not null,
  question_text text not null,
  answer_text text not null,
  answer_options jsonb,
  scoring_criteria jsonb not null,
  accepted_answers jsonb not null default '[]'::jsonb,
  design_summary text,
  evidence_summary text,
  quality_scores jsonb not null default '{}'::jsonb,
  change_reason text,
  created_at timestamptz not null default now(),
  unique(question_id, revision)
);

create table question_evidence (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id),
  question_revision integer not null,
  source_chunk_id uuid not null references source_chunks(id),
  ordinal integer not null,
  role text not null default 'supporting',
  quote_text text,
  created_at timestamptz not null default now(),
  unique(question_id, question_revision, source_chunk_id)
);

create table review_actions (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id),
  action text not null,
  from_status text,
  to_status text,
  revision integer,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);


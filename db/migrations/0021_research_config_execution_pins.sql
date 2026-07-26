create or replace function valid_research_config_execution_pin(
  expected_kind text,
  profile_id uuid,
  profile_snapshot jsonb,
  profile_hash text,
  snapshot_provenance text
)
returns boolean
language sql
immutable
as $$
  select (
    snapshot_provenance = 'LEGACY_BACKFILL_UNVERIFIED'
    and profile_id is null
    and profile_snapshot is null
    and profile_hash is null
  ) or (
    snapshot_provenance = 'AT_CREATION_VERIFIED'
    and profile_id is not null
    and jsonb_typeof(profile_snapshot) = 'object'
    and profile_snapshot->>'kind' = expected_kind
    and profile_hash ~ '^[0-9a-f]{64}$'
    and research_config_definition_hash(profile_snapshot) = profile_hash
    and valid_research_config_definition(expected_kind,profile_snapshot)
  );
$$;

create or replace function resolve_active_research_config_pin(
  expected_kind text,
  out pinned_profile_id uuid,
  out pinned_definition jsonb,
  out pinned_content_hash text
)
returns record
language plpgsql
volatile
as $$
begin
  select profile.id,profile.definition,profile.content_hash
  into pinned_profile_id,pinned_definition,pinned_content_hash
  from research_config_active_profiles active
  join research_config_profiles profile
    on profile.id=active.profile_id
   and profile.kind=active.kind
  where active.kind=expected_kind
  for share of active,profile;

  if pinned_profile_id is null then
    raise exception 'active research configuration profile is missing for kind %',
      expected_kind
      using errcode='55000';
  end if;
end;
$$;

alter table source_files
  add column document_parse_profile_id uuid
    references research_config_profiles(id),
  add column document_parse_profile_snapshot jsonb,
  add column document_parse_profile_hash text,
  add column document_parse_profile_snapshot_provenance text
    not null default 'LEGACY_BACKFILL_UNVERIFIED',
  add column embedding_rag_profile_id uuid
    references research_config_profiles(id),
  add column embedding_rag_profile_snapshot jsonb,
  add column embedding_rag_profile_hash text,
  add column embedding_rag_profile_snapshot_provenance text
    not null default 'LEGACY_BACKFILL_UNVERIFIED';

alter table source_files
  add constraint source_files_document_parse_pin_check
    check (valid_research_config_execution_pin(
      'document_parse',
      document_parse_profile_id,
      document_parse_profile_snapshot,
      document_parse_profile_hash,
      document_parse_profile_snapshot_provenance
    )),
  add constraint source_files_embedding_rag_pin_check
    check (valid_research_config_execution_pin(
      'embedding_rag',
      embedding_rag_profile_id,
      embedding_rag_profile_snapshot,
      embedding_rag_profile_hash,
      embedding_rag_profile_snapshot_provenance
    ));

create or replace function pin_source_file_research_config()
returns trigger
language plpgsql
as $$
begin
  select
    pinned_profile_id,
    pinned_definition,
    pinned_content_hash
  into
    new.document_parse_profile_id,
    new.document_parse_profile_snapshot,
    new.document_parse_profile_hash
  from resolve_active_research_config_pin('document_parse');

  select
    pinned_profile_id,
    pinned_definition,
    pinned_content_hash
  into
    new.embedding_rag_profile_id,
    new.embedding_rag_profile_snapshot,
    new.embedding_rag_profile_hash
  from resolve_active_research_config_pin('embedding_rag');

  new.document_parse_profile_snapshot_provenance :=
    'AT_CREATION_VERIFIED';
  new.embedding_rag_profile_snapshot_provenance :=
    'AT_CREATION_VERIFIED';
  return new;
end;
$$;

create trigger source_files_pin_research_config
before insert on source_files
for each row execute function pin_source_file_research_config();

create or replace function prevent_source_file_research_pin_change()
returns trigger
language plpgsql
as $$
begin
  if new.document_parse_profile_id
       is distinct from old.document_parse_profile_id
     or new.document_parse_profile_snapshot
       is distinct from old.document_parse_profile_snapshot
     or new.document_parse_profile_hash
       is distinct from old.document_parse_profile_hash
     or new.document_parse_profile_snapshot_provenance
       is distinct from old.document_parse_profile_snapshot_provenance
     or new.embedding_rag_profile_id
       is distinct from old.embedding_rag_profile_id
     or new.embedding_rag_profile_snapshot
       is distinct from old.embedding_rag_profile_snapshot
     or new.embedding_rag_profile_hash
       is distinct from old.embedding_rag_profile_hash
     or new.embedding_rag_profile_snapshot_provenance
       is distinct from old.embedding_rag_profile_snapshot_provenance then
    raise exception 'source file research configuration pins are immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger source_files_research_config_immutable
before update of
  document_parse_profile_id,
  document_parse_profile_snapshot,
  document_parse_profile_hash,
  document_parse_profile_snapshot_provenance,
  embedding_rag_profile_id,
  embedding_rag_profile_snapshot,
  embedding_rag_profile_hash,
  embedding_rag_profile_snapshot_provenance
on source_files
for each row execute function prevent_source_file_research_pin_change();

alter table source_chunks
  add column embedding_rag_profile_id uuid
    references research_config_profiles(id),
  add column embedding_rag_profile_hash text,
  add column embedding_vector_space_id text,
  add column embedding_rag_profile_snapshot_provenance text
    not null default 'LEGACY_BACKFILL_UNVERIFIED';

alter table source_chunks
  add constraint source_chunks_embedding_pin_check check (
    (
      embedding_rag_profile_snapshot_provenance =
        'LEGACY_BACKFILL_UNVERIFIED'
      and embedding_rag_profile_id is null
      and embedding_rag_profile_hash is null
      and embedding_vector_space_id is null
    )
    or (
      embedding_rag_profile_snapshot_provenance =
        'AT_CREATION_VERIFIED'
      and embedding_rag_profile_id is not null
      and embedding_rag_profile_hash ~ '^[0-9a-f]{64}$'
      and btrim(embedding_vector_space_id) <> ''
    )
  );

create index source_chunks_embedding_space_idx
  on source_chunks(embedding_vector_space_id,source_file_id)
  where embedding_vector_space_id is not null;

create or replace function pin_source_chunk_embedding_space()
returns trigger
language plpgsql
as $$
declare
  source_pin record;
begin
  select
    source.embedding_rag_profile_id,
    source.embedding_rag_profile_hash,
    source.embedding_rag_profile_snapshot #>>
      '{settings,vectorSpaceId}' as vector_space_id,
    source.embedding_rag_profile_snapshot_provenance
  into source_pin
  from source_files source
  where source.id=new.source_file_id
  for share of source;

  if not found then
    raise exception 'source file does not exist'
      using errcode='23503';
  end if;

  new.embedding_rag_profile_id :=
    source_pin.embedding_rag_profile_id;
  new.embedding_rag_profile_hash :=
    source_pin.embedding_rag_profile_hash;
  new.embedding_vector_space_id :=
    source_pin.vector_space_id;
  new.embedding_rag_profile_snapshot_provenance :=
    source_pin.embedding_rag_profile_snapshot_provenance;
  return new;
end;
$$;

create trigger source_chunks_pin_embedding_space
before insert on source_chunks
for each row execute function pin_source_chunk_embedding_space();

create or replace function prevent_source_chunk_embedding_pin_change()
returns trigger
language plpgsql
as $$
begin
  if new.embedding_rag_profile_id
       is distinct from old.embedding_rag_profile_id
     or new.embedding_rag_profile_hash
       is distinct from old.embedding_rag_profile_hash
     or new.embedding_vector_space_id
       is distinct from old.embedding_vector_space_id
     or new.embedding_rag_profile_snapshot_provenance
       is distinct from old.embedding_rag_profile_snapshot_provenance then
    raise exception 'source chunk embedding configuration pin is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger source_chunks_embedding_pin_immutable
before update of
  embedding_rag_profile_id,
  embedding_rag_profile_hash,
  embedding_vector_space_id,
  embedding_rag_profile_snapshot_provenance
on source_chunks
for each row execute function prevent_source_chunk_embedding_pin_change();

alter table generation_batches
  add column question_generation_profile_id uuid
    references research_config_profiles(id),
  add column question_generation_profile_snapshot jsonb,
  add column question_generation_profile_hash text,
  add column question_generation_profile_snapshot_provenance text
    not null default 'LEGACY_BACKFILL_UNVERIFIED',
  add column embedding_rag_profile_id uuid
    references research_config_profiles(id),
  add column embedding_rag_profile_snapshot jsonb,
  add column embedding_rag_profile_hash text,
  add column embedding_rag_profile_snapshot_provenance text
    not null default 'LEGACY_BACKFILL_UNVERIFIED';

alter table generation_batches
  add constraint generation_batches_question_pin_check
    check (valid_research_config_execution_pin(
      'question_generation',
      question_generation_profile_id,
      question_generation_profile_snapshot,
      question_generation_profile_hash,
      question_generation_profile_snapshot_provenance
    )),
  add constraint generation_batches_embedding_pin_check
    check (valid_research_config_execution_pin(
      'embedding_rag',
      embedding_rag_profile_id,
      embedding_rag_profile_snapshot,
      embedding_rag_profile_hash,
      embedding_rag_profile_snapshot_provenance
    ));

create or replace function pin_generation_batch_research_config()
returns trigger
language plpgsql
as $$
begin
  select
    pinned_profile_id,
    pinned_definition,
    pinned_content_hash
  into
    new.question_generation_profile_id,
    new.question_generation_profile_snapshot,
    new.question_generation_profile_hash
  from resolve_active_research_config_pin('question_generation');

  select
    pinned_profile_id,
    pinned_definition,
    pinned_content_hash
  into
    new.embedding_rag_profile_id,
    new.embedding_rag_profile_snapshot,
    new.embedding_rag_profile_hash
  from resolve_active_research_config_pin('embedding_rag');

  new.question_generation_profile_snapshot_provenance :=
    'AT_CREATION_VERIFIED';
  new.embedding_rag_profile_snapshot_provenance :=
    'AT_CREATION_VERIFIED';
  return new;
end;
$$;

create trigger generation_batches_pin_research_config
before insert on generation_batches
for each row execute function pin_generation_batch_research_config();

create or replace function prevent_generation_batch_research_pin_change()
returns trigger
language plpgsql
as $$
begin
  if new.question_generation_profile_id
       is distinct from old.question_generation_profile_id
     or new.question_generation_profile_snapshot
       is distinct from old.question_generation_profile_snapshot
     or new.question_generation_profile_hash
       is distinct from old.question_generation_profile_hash
     or new.question_generation_profile_snapshot_provenance
       is distinct from old.question_generation_profile_snapshot_provenance
     or new.embedding_rag_profile_id
       is distinct from old.embedding_rag_profile_id
     or new.embedding_rag_profile_snapshot
       is distinct from old.embedding_rag_profile_snapshot
     or new.embedding_rag_profile_hash
       is distinct from old.embedding_rag_profile_hash
     or new.embedding_rag_profile_snapshot_provenance
       is distinct from old.embedding_rag_profile_snapshot_provenance then
    raise exception 'generation batch research configuration pins are immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger generation_batches_research_config_immutable
before update of
  question_generation_profile_id,
  question_generation_profile_snapshot,
  question_generation_profile_hash,
  question_generation_profile_snapshot_provenance,
  embedding_rag_profile_id,
  embedding_rag_profile_snapshot,
  embedding_rag_profile_hash,
  embedding_rag_profile_snapshot_provenance
on generation_batches
for each row execute function prevent_generation_batch_research_pin_change();

alter table benchmark_runs
  add column benchmark_models_profile_id uuid
    references research_config_profiles(id),
  add column benchmark_models_profile_snapshot jsonb,
  add column benchmark_models_profile_hash text,
  add column benchmark_models_profile_snapshot_provenance text
    not null default 'LEGACY_BACKFILL_UNVERIFIED';

alter table benchmark_runs
  add constraint benchmark_runs_models_pin_check
    check (valid_research_config_execution_pin(
      'benchmark_models',
      benchmark_models_profile_id,
      benchmark_models_profile_snapshot,
      benchmark_models_profile_hash,
      benchmark_models_profile_snapshot_provenance
    ));

create or replace function pin_benchmark_run_model_config()
returns trigger
language plpgsql
as $$
begin
  select
    pinned_profile_id,
    pinned_definition,
    pinned_content_hash
  into
    new.benchmark_models_profile_id,
    new.benchmark_models_profile_snapshot,
    new.benchmark_models_profile_hash
  from resolve_active_research_config_pin('benchmark_models');

  new.benchmark_models_profile_snapshot_provenance :=
    'AT_CREATION_VERIFIED';
  return new;
end;
$$;

create trigger benchmark_runs_pin_model_config
before insert on benchmark_runs
for each row execute function pin_benchmark_run_model_config();

create or replace function prevent_benchmark_run_model_pin_change()
returns trigger
language plpgsql
as $$
begin
  if new.benchmark_models_profile_id
       is distinct from old.benchmark_models_profile_id
     or new.benchmark_models_profile_snapshot
       is distinct from old.benchmark_models_profile_snapshot
     or new.benchmark_models_profile_hash
       is distinct from old.benchmark_models_profile_hash
     or new.benchmark_models_profile_snapshot_provenance
       is distinct from old.benchmark_models_profile_snapshot_provenance then
    raise exception 'benchmark run model configuration pin is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger benchmark_runs_model_pin_immutable
before update of
  benchmark_models_profile_id,
  benchmark_models_profile_snapshot,
  benchmark_models_profile_hash,
  benchmark_models_profile_snapshot_provenance
on benchmark_runs
for each row execute function prevent_benchmark_run_model_pin_change();

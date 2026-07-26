create table source_revision_page_artifacts (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null
    references source_revisions(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  filename text not null,
  mime_type text not null,
  raster_width integer check (raster_width is null or raster_width > 0),
  raster_height integer check (raster_height is null or raster_height > 0),
  parse_model text,
  parse_request_id text,
  request_config jsonb,
  raw_response jsonb not null,
  raw_html text not null,
  raw_markdown text,
  created_at timestamptz not null default now(),
  unique(source_revision_id,page_number)
);

create index source_revision_page_artifacts_revision_idx
  on source_revision_page_artifacts(source_revision_id,page_number);

create or replace function prevent_source_revision_page_artifact_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'source revision page artifacts are immutable'
    using errcode='55000';
end;
$$;

create trigger source_revision_page_artifacts_immutable
before update on source_revision_page_artifacts
for each row execute function prevent_source_revision_page_artifact_change();

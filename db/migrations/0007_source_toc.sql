create table source_toc_entries (
  id uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references source_files(id) on delete cascade,
  ordinal integer not null,
  title text not null,
  level integer not null default 1,
  printed_page integer,
  created_at timestamptz not null default now(),
  unique(source_file_id, ordinal)
);

create index source_toc_entries_source_idx on source_toc_entries(source_file_id, ordinal);

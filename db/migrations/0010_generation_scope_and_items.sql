alter table source_toc_entries
  add column source_revision_id uuid references source_revisions(id) on delete cascade,
  add column parent_id uuid references source_toc_entries(id) on delete cascade,
  add column mapping_status text not null default 'UNMAPPED',
  add column mapping_confidence real;

alter table source_toc_entries
  add constraint source_toc_entries_mapping_status_check
    check (mapping_status in ('MAPPED', 'UNMAPPED')),
  add constraint source_toc_entries_mapping_confidence_check
    check (mapping_confidence is null or (mapping_confidence >= 0 and mapping_confidence <= 1));

update source_toc_entries entry
   set source_revision_id = (
     select revision.id
       from source_revisions revision
      where revision.source_file_id = entry.source_file_id
      order by revision.revision desc
      limit 1
   )
 where entry.source_revision_id is null
   and exists (
     select 1 from source_revisions revision
      where revision.source_file_id = entry.source_file_id
   );

alter table source_toc_entries
  drop constraint source_toc_entries_source_file_id_ordinal_key;

alter table source_toc_entries
  add constraint source_toc_entries_revision_ordinal_key unique(source_revision_id, ordinal);

create index source_toc_entries_revision_idx
  on source_toc_entries(source_revision_id, ordinal);

create table source_chunk_toc_entries (
  source_chunk_id uuid not null references source_chunks(id) on delete cascade,
  source_toc_entry_id uuid not null references source_toc_entries(id) on delete cascade,
  relation text not null,
  confidence real not null,
  created_at timestamptz not null default now(),
  primary key(source_chunk_id, source_toc_entry_id),
  check (relation in ('DIRECT', 'ANCESTOR')),
  check (confidence >= 0 and confidence <= 1)
);

create index source_chunk_toc_entries_toc_idx
  on source_chunk_toc_entries(source_toc_entry_id, source_chunk_id);

create table generation_items (
  id uuid primary key default gen_random_uuid(),
  generation_batch_id uuid not null references generation_batches(id) on delete cascade,
  ordinal integer not null check (ordinal > 0),
  state text not null default 'PENDING',
  attempts integer not null default 0 check (attempts >= 0),
  direction jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(generation_batch_id, ordinal)
);

create index generation_items_batch_state_idx
  on generation_items(generation_batch_id, state, ordinal);

alter table generation_retrievals
  add column generation_item_id uuid references generation_items(id) on delete set null;

create index generation_retrievals_item_idx
  on generation_retrievals(generation_item_id, created_at);

alter table questions
  add column generation_item_id uuid unique references generation_items(id) on delete set null;

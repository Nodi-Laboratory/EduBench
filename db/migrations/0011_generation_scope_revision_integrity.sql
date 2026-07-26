alter table source_chunk_toc_entries
  add column source_revision_id uuid;

update source_chunk_toc_entries mapping
   set source_revision_id = chunk.source_revision_id
  from source_chunks chunk
 where chunk.id = mapping.source_chunk_id;

do $$
begin
  if exists (
    select 1
      from source_chunk_toc_entries mapping
      join source_toc_entries entry on entry.id = mapping.source_toc_entry_id
     where mapping.source_revision_id is null
        or entry.source_revision_id is distinct from mapping.source_revision_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'source_chunk_toc_entries contains cross-revision or unpinned legacy rows';
  end if;
end
$$;

alter table source_toc_entries
  add constraint source_toc_entries_id_revision_key unique(id, source_revision_id);

alter table source_chunks
  add constraint source_chunks_id_revision_key unique(id, source_revision_id);

alter table source_chunk_toc_entries
  alter column source_revision_id set not null,
  drop constraint if exists source_chunk_toc_entries_source_chunk_id_fkey,
  drop constraint if exists source_chunk_toc_entries_source_toc_entry_id_fkey,
  add constraint source_chunk_toc_entries_revision_fkey
    foreign key(source_revision_id) references source_revisions(id) on delete cascade,
  add constraint source_chunk_toc_entries_chunk_revision_fkey
    foreign key(source_chunk_id, source_revision_id)
    references source_chunks(id, source_revision_id) on delete cascade,
  add constraint source_chunk_toc_entries_toc_revision_fkey
    foreign key(source_toc_entry_id, source_revision_id)
    references source_toc_entries(id, source_revision_id) on delete cascade;

create index source_chunk_toc_entries_revision_idx
  on source_chunk_toc_entries(source_revision_id, source_toc_entry_id);

alter table source_revisions
  add column toc_alignment_attempted_at timestamptz;

do $$
begin
  if exists (
    select 1
      from source_toc_entries child
      join source_toc_entries parent on parent.id = child.parent_id
     where child.parent_id is not null
       and child.source_revision_id is distinct from parent.source_revision_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'source_toc_entries contains a cross-revision parent relationship';
  end if;
end
$$;

alter table source_toc_entries
  drop constraint if exists source_toc_entries_parent_id_fkey,
  add constraint source_toc_entries_parent_revision_fkey
    foreign key(parent_id, source_revision_id)
    references source_toc_entries(id, source_revision_id) on delete cascade;

create index source_revisions_toc_alignment_pending_idx
  on source_revisions(source_file_id, revision desc)
  where toc_alignment_attempted_at is null;

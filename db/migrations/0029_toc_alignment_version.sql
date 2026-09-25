alter table source_revisions
  add column toc_alignment_version integer not null default 1;

drop index if exists source_revisions_toc_alignment_pending_idx;

create index source_revisions_toc_alignment_v2_pending_idx
  on source_revisions(source_file_id, revision desc)
  where toc_alignment_attempted_at is null
     or toc_alignment_version < 2;

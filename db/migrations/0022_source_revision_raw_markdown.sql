alter table source_revisions
  add column raw_markdown text;

create or replace function prevent_source_revision_raw_markdown_change()
returns trigger
language plpgsql
as $$
begin
  if new.raw_markdown is distinct from old.raw_markdown then
    raise exception 'source revision raw Markdown is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger source_revisions_raw_markdown_immutable
before update of raw_markdown
on source_revisions
for each row execute function prevent_source_revision_raw_markdown_change();

create or replace function prevent_published_dataset_change()
returns trigger language plpgsql as $$
begin
  if old.status = 'PUBLISHED' then
    raise exception 'published dataset version is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger dataset_versions_immutable_update
before update or delete on dataset_versions
for each row execute function prevent_published_dataset_change();

create or replace function prevent_published_dataset_item_change()
returns trigger language plpgsql as $$
declare parent_status text;
begin
  select status into parent_status from dataset_versions
  where id = coalesce(new.dataset_version_id, old.dataset_version_id);
  if parent_status = 'PUBLISHED' then
    raise exception 'published dataset items are immutable' using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger dataset_questions_immutable
before insert or update or delete on dataset_questions
for each row execute function prevent_published_dataset_item_change();


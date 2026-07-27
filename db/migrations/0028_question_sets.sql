create table question_sets (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 2 and 200),
  description text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table question_set_questions (
  question_set_id uuid not null
    references question_sets(id) on delete cascade,
  question_id uuid not null,
  question_revision integer not null check (question_revision > 0),
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default now(),
  primary key(question_set_id, question_id),
  constraint question_set_questions_ordinal_key
    unique(question_set_id, ordinal) deferrable initially immediate,
  constraint question_set_questions_revision_fkey
    foreign key(question_id, question_revision)
    references question_revisions(question_id, revision)
);

create index question_set_questions_question_idx
  on question_set_questions(question_id, question_revision);

alter table dataset_versions
  add column source_question_set_id uuid references question_sets(id);

alter table dataset_questions
  add constraint dataset_questions_question_revision_fkey
  foreign key(question_id, question_revision)
  references question_revisions(question_id, revision);

create or replace function prevent_published_dataset_item_change()
returns trigger language plpgsql as $$
declare
  old_parent_status text;
  new_parent_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select status into old_parent_status
      from dataset_versions
     where id = old.dataset_version_id;
    if old_parent_status = 'PUBLISHED' then
      raise exception 'published dataset items are immutable'
        using errcode = '55000';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select status into new_parent_status
      from dataset_versions
     where id = new.dataset_version_id;
    if new_parent_status = 'PUBLISHED' then
      raise exception 'published dataset items are immutable'
        using errcode = '55000';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

do $$
declare
  legacy_set_id uuid;
begin
  if exists (
    select 1
      from questions
     where status = 'APPROVED'
       and deleted_at is null
       and coalesce(generator_provider, '') <> 'sample'
       and coalesce(generator_model, '') not like 'mock-%'
  ) then
    insert into question_sets(title, description)
    values (
      '기존 승인 문항',
      '질문 세트 도입 전에 승인된 문항을 보존하기 위한 초기 세트'
    )
    returning id into legacy_set_id;

    insert into question_set_questions(
      question_set_id,
      question_id,
      question_revision,
      ordinal
    )
    select
      legacy_set_id,
      question.id,
      question.current_revision,
      row_number() over (
        order by question.created_at, question.public_id
      )::integer
    from questions question
    where question.status = 'APPROVED'
      and question.deleted_at is null
      and coalesce(question.generator_provider, '') <> 'sample'
      and coalesce(question.generator_model, '') not like 'mock-%'
    order by question.created_at, question.public_id;
  end if;
end
$$;

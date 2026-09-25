-- Keep canonical research evidence once and let high-cardinality receipts
-- reference it. This migration is lossless: every cleared inline value is
-- first copied to an immutable canonical row and remains reconstructable.
--
-- This is intentionally one atomic migration. The supported Docker rollout
-- starts the web container with migrations and does not start the worker until
-- the web healthcheck succeeds, so there is no old/new application overlap to
-- justify a dual-write compatibility phase. Splitting cleanup from backfill
-- would instead make startup dependent on an out-of-band job and expose a
-- mixed representation to the single deployed image. The backfills below are
-- set-based and rollback together if any lossless-integrity check fails.

create table source_html_blobs (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null unique
    check (content_hash ~ '^[0-9a-f]{64}$'),
  html text not null,
  byte_size bigint not null check (byte_size >= 0),
  created_at timestamptz not null default now(),
  check (
    content_hash=encode(sha256(convert_to(html,'UTF8')),'hex')
    and byte_size=octet_length(html)
  )
);

alter table source_chunks
  add column html_blob_id uuid references source_html_blobs(id);

do $$
begin
  if exists (
    select 1
      from source_chunks
     where html is not null
     group by encode(sha256(convert_to(html,'UTF8')),'hex')
    having count(distinct (html,octet_length(html))) > 1
  ) then
    raise exception 'source chunk HTML hash collision maps to distinct content'
      using errcode='23514';
  end if;
end;
$$;

with candidates as (
  select distinct on (content_hash)
    content_hash,html,octet_length(html)::bigint byte_size
  from (
    select encode(sha256(convert_to(html,'UTF8')),'hex') content_hash,
           html,id
      from source_chunks
     where html is not null
  ) hashed
  order by content_hash,id
)
insert into source_html_blobs(content_hash,html,byte_size)
select content_hash,html,byte_size
  from candidates
on conflict (content_hash) do nothing;

update source_chunks chunk
   set html_blob_id=blob.id
  from source_html_blobs blob
 where chunk.html is not null
   and blob.content_hash=
       encode(sha256(convert_to(chunk.html,'UTF8')),'hex');

do $$
begin
  if exists (
    select 1
      from source_chunks
     where html is not null
       and html_blob_id is null
  ) then
    raise exception 'source chunk HTML canonicalization is incomplete';
  end if;
end;
$$;

update source_chunks
   set html=null
 where html_blob_id is not null;

create index source_chunks_html_blob_idx
  on source_chunks(html_blob_id)
  where html_blob_id is not null;

create or replace function prevent_source_html_blob_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'source HTML blob is immutable'
    using errcode='55000';
end;
$$;

create trigger source_html_blobs_immutable
before update or delete on source_html_blobs
for each row execute function prevent_source_html_blob_change();

-- A shared retrieval row is an immutable per-item receipt. The referenced
-- root keeps the canonical query, selected chunks, graph and rendered context.
drop trigger if exists run_item_retrievals_immutable
  on run_item_retrievals;

alter table run_item_retrievals
  alter column candidate_scope drop not null,
  alter column selected_chunks drop not null,
  alter column graph_trace drop not null,
  alter column config_snapshot drop not null,
  alter column config_hash drop not null,
  alter column rendered_context drop not null,
  alter column context_hash drop not null;

-- Development databases may contain a receipt that points at another
-- receipt. Resolve every such chain before discarding duplicated payloads.
-- Refuse to proceed if a chain is cyclic, dangling, or does not terminate
-- at a complete canonical row: migration must never turn recoverable audit
-- evidence into an unresolved lightweight receipt.
do $$
declare
  receipt record;
  current_id uuid;
  next_id uuid;
  visited uuid[];
  mismatched_receipt_id uuid;
  mismatched_claim_key text;
  root_candidate_scope jsonb;
  root_selected_chunks jsonb;
  root_graph_trace jsonb;
  root_config_snapshot jsonb;
  root_config_hash text;
  root_rendered_context text;
  root_context_hash text;
begin
  for receipt in
    select id,shared_from_retrieval_id
      from run_item_retrievals
     where shared_from_retrieval_id is not null
     order by created_at,id
  loop
    current_id:=receipt.shared_from_retrieval_id;
    visited:=array[receipt.id];
    loop
      if current_id=any(visited) then
        raise exception
          'shared retrieval chain contains a cycle (receipt %, target %)',
          receipt.id,current_id
          using errcode='23514';
      end if;
      visited:=array_append(visited,current_id);

      select shared_from_retrieval_id,candidate_scope,selected_chunks,
             graph_trace,config_snapshot,config_hash,rendered_context,
             context_hash
        into next_id,root_candidate_scope,root_selected_chunks,
             root_graph_trace,root_config_snapshot,root_config_hash,
             root_rendered_context,root_context_hash
        from run_item_retrievals
       where id=current_id;
      if not found then
        raise exception
          'shared retrieval chain references a missing row (receipt %, target %)',
          receipt.id,current_id
          using errcode='23503';
      end if;

      if next_id is null then
        if root_candidate_scope is null
           or root_selected_chunks is null
           or root_graph_trace is null
           or root_config_snapshot is null
           or root_config_hash is null
           or root_rendered_context is null
           or root_context_hash is null then
          raise exception
            'shared retrieval chain does not end at a payload-bearing root (receipt %, root %)',
            receipt.id,current_id
            using errcode='23514';
        end if;
        update run_item_retrievals
           set shared_from_retrieval_id=current_id
         where id=receipt.id;
        exit;
      end if;
      current_id:=next_id;
    end loop;
  end loop;

  if exists (
    select 1
      from run_item_retrievals stored_receipt
      left join run_item_retrievals stored_root
        on stored_root.id=stored_receipt.shared_from_retrieval_id
     where stored_receipt.shared_from_retrieval_id is not null
       and (
         stored_root.id is null
         or stored_root.shared_from_retrieval_id is not null
         or stored_root.candidate_scope is null
         or stored_root.selected_chunks is null
         or stored_root.graph_trace is null
         or stored_root.config_snapshot is null
         or stored_root.config_hash is null
         or stored_root.rendered_context is null
         or stored_root.context_hash is null
       )
  ) then
    raise exception
      'shared retrieval normalization did not produce direct payload-bearing roots'
      using errcode='23514';
  end if;

  select stored_receipt.id
    into mismatched_receipt_id
    from run_item_retrievals stored_receipt
    join run_item_retrievals stored_root
      on stored_root.id=stored_receipt.shared_from_retrieval_id
    left join run_items receipt_item
      on receipt_item.id=stored_receipt.run_item_id
    left join run_items root_item
      on root_item.id=stored_root.run_item_id
   where stored_receipt.shared_from_retrieval_id is not null
     and (
       stored_receipt.retrieval_mode
         is distinct from stored_root.retrieval_mode
       or stored_receipt.shared_snapshot_key
         is distinct from stored_root.shared_snapshot_key
       or stored_receipt.query_text
         is distinct from stored_root.query_text
       or stored_receipt.embedding_model
         is distinct from stored_root.embedding_model
       or stored_receipt.embedding_profile_hash
         is distinct from stored_root.embedding_profile_hash
       or stored_receipt.vector_space_id
         is distinct from stored_root.vector_space_id
       or stored_receipt.candidate_scope
         is distinct from stored_root.candidate_scope
       or stored_receipt.selected_chunks
         is distinct from stored_root.selected_chunks
       or stored_receipt.graph_trace
         is distinct from stored_root.graph_trace
       or stored_receipt.config_snapshot
         is distinct from stored_root.config_snapshot
       or stored_receipt.config_hash
         is distinct from stored_root.config_hash
       or stored_receipt.rendered_context
         is distinct from stored_root.rendered_context
       or stored_receipt.context_hash
         is distinct from stored_root.context_hash
       or receipt_item.id is null
       or root_item.id is null
       or receipt_item.benchmark_run_id
         is distinct from root_item.benchmark_run_id
       or receipt_item.question_id
         is distinct from root_item.question_id
       or receipt_item.question_revision
         is distinct from root_item.question_revision
     )
   order by stored_receipt.created_at,stored_receipt.id
   limit 1;
  if mismatched_receipt_id is not null then
    raise exception
      'shared retrieval receipt payload differs from its root (receipt %)',
      mismatched_receipt_id
      using errcode='23514';
  end if;

  select claim.snapshot_key
    into mismatched_claim_key
    from benchmark_retrieval_snapshot_claims claim
    left join run_item_retrievals stored_source
      on stored_source.id=claim.root_retrieval_id
    left join run_item_retrievals stored_root
      on stored_root.id=coalesce(
        stored_source.shared_from_retrieval_id,
        stored_source.id
      )
    left join run_items source_item
      on source_item.id=stored_source.run_item_id
    left join run_items root_item
      on root_item.id=stored_root.run_item_id
   where claim.root_retrieval_id is not null
     and (
       stored_source.id is null
       or stored_root.id is null
       or stored_root.shared_from_retrieval_id is not null
       or stored_root.candidate_scope is null
       or stored_root.selected_chunks is null
       or stored_root.graph_trace is null
       or stored_root.config_snapshot is null
       or stored_root.config_hash is null
       or stored_root.rendered_context is null
       or stored_root.context_hash is null
       or claim.retrieval_mode
         is distinct from stored_source.retrieval_mode
       or claim.retrieval_mode
         is distinct from stored_root.retrieval_mode
       or claim.snapshot_key
         is distinct from stored_source.shared_snapshot_key
       or claim.snapshot_key
         is distinct from stored_root.shared_snapshot_key
       or source_item.id is null
       or root_item.id is null
       or claim.benchmark_run_id
         is distinct from source_item.benchmark_run_id
       or claim.question_id
         is distinct from source_item.question_id
       or claim.question_revision
         is distinct from source_item.question_revision
       or claim.benchmark_run_id
         is distinct from root_item.benchmark_run_id
       or claim.question_id
         is distinct from root_item.question_id
       or claim.question_revision
         is distinct from root_item.question_revision
     )
   order by claim.created_at,claim.snapshot_key
   limit 1;
  if mismatched_claim_key is not null then
    raise exception
      'retrieval snapshot claim root identity is invalid (snapshot %)',
      mismatched_claim_key
      using errcode='23514';
  end if;

  update benchmark_retrieval_snapshot_claims claim
     set root_retrieval_id=coalesce(
           stored_source.shared_from_retrieval_id,
           stored_source.id
         ),
         updated_at=now()
    from run_item_retrievals stored_source
   where claim.root_retrieval_id=stored_source.id
     and claim.root_retrieval_id is distinct from coalesce(
       stored_source.shared_from_retrieval_id,
       stored_source.id
     );
end;
$$;

update run_item_retrievals
   set query_text=null,
       embedding_model=null,
       embedding_profile_hash=null,
       vector_space_id=null,
       candidate_scope=null,
       selected_chunks=null,
       graph_trace=null,
       config_snapshot=null,
       config_hash=null,
       rendered_context=null,
       context_hash=null
 where shared_from_retrieval_id is not null;

alter table run_item_retrievals
  add constraint run_item_retrievals_root_or_receipt_check check (
    (
      shared_from_retrieval_id is null
      and candidate_scope is not null
      and selected_chunks is not null
      and graph_trace is not null
      and config_snapshot is not null
      and config_hash is not null
      and rendered_context is not null
      and context_hash is not null
    )
    or
    (
      shared_from_retrieval_id is not null
      and query_text is null
      and embedding_model is null
      and embedding_profile_hash is null
      and vector_space_id is null
      and candidate_scope is null
      and selected_chunks is null
      and graph_trace is null
      and config_snapshot is null
      and config_hash is null
      and rendered_context is null
      and context_hash is null
    )
  );

create or replace function enforce_run_item_retrieval_direct_root()
returns trigger
language plpgsql
as $$
declare
  root_shared_from uuid;
  root_retrieval_mode text;
  root_shared_snapshot_key text;
  root_candidate_scope jsonb;
  root_selected_chunks jsonb;
  root_graph_trace jsonb;
  root_config_snapshot jsonb;
  root_config_hash text;
  root_rendered_context text;
  root_context_hash text;
  root_benchmark_run_id uuid;
  root_question_id uuid;
  root_question_revision integer;
  receipt_benchmark_run_id uuid;
  receipt_question_id uuid;
  receipt_question_revision integer;
begin
  if new.shared_from_retrieval_id is null then
    return new;
  end if;
  if new.shared_from_retrieval_id=new.id then
    raise exception
      'shared retrieval must reference a direct payload-bearing root'
      using errcode='23514';
  end if;

  select stored_root.shared_from_retrieval_id,
         stored_root.retrieval_mode,
         stored_root.shared_snapshot_key,
         stored_root.candidate_scope,
         stored_root.selected_chunks,
         stored_root.graph_trace,
         stored_root.config_snapshot,
         stored_root.config_hash,
         stored_root.rendered_context,
         stored_root.context_hash,
         root_item.benchmark_run_id,
         root_item.question_id,
         root_item.question_revision
    into root_shared_from,root_retrieval_mode,root_shared_snapshot_key,
         root_candidate_scope,root_selected_chunks,root_graph_trace,
         root_config_snapshot,root_config_hash,root_rendered_context,
         root_context_hash,root_benchmark_run_id,root_question_id,
         root_question_revision
    from run_item_retrievals stored_root
    join run_items root_item on root_item.id=stored_root.run_item_id
   where stored_root.id=new.shared_from_retrieval_id
   for share of stored_root,root_item;
  if not found then
    raise exception
      'shared retrieval root does not exist'
      using errcode='23503';
  end if;
  select benchmark_run_id,question_id,question_revision
    into receipt_benchmark_run_id,receipt_question_id,
         receipt_question_revision
    from run_items
   where id=new.run_item_id
   for share;
  if not found then
    raise exception
      'run item does not exist'
      using errcode='23503';
  end if;
  if root_shared_from is not null
     or root_candidate_scope is null
     or root_selected_chunks is null
     or root_graph_trace is null
     or root_config_snapshot is null
     or root_config_hash is null
     or root_rendered_context is null
     or root_context_hash is null then
    raise exception
      'shared retrieval must reference a direct payload-bearing root'
      using errcode='23514';
  end if;
  if new.retrieval_mode is distinct from root_retrieval_mode
     or new.shared_snapshot_key
       is distinct from root_shared_snapshot_key then
    raise exception
      'shared retrieval metadata must match its root'
      using errcode='23514';
  end if;
  if receipt_benchmark_run_id is distinct from root_benchmark_run_id
     or receipt_question_id is distinct from root_question_id
     or receipt_question_revision
       is distinct from root_question_revision then
    raise exception
      'shared retrieval item identity must match its root'
      using errcode='23514';
  end if;
  return new;
end;
$$;

create trigger run_item_retrievals_direct_root
before insert on run_item_retrievals
for each row execute function enforce_run_item_retrieval_direct_root();

create trigger run_item_retrievals_immutable
before update or delete on run_item_retrievals
for each row execute function prevent_run_item_retrieval_change();

create or replace function enforce_benchmark_retrieval_claim_root()
returns trigger
language plpgsql
as $$
declare
  root_shared_from uuid;
  root_mode text;
  root_snapshot_key text;
  root_benchmark_run_id uuid;
  root_question_id uuid;
  root_question_revision integer;
  root_payload_complete boolean;
begin
  if new.root_retrieval_id is null then
    return new;
  end if;

  select stored_root.shared_from_retrieval_id,
         stored_root.retrieval_mode,
         stored_root.shared_snapshot_key,
         root_item.benchmark_run_id,
         root_item.question_id,
         root_item.question_revision,
         (
           stored_root.candidate_scope is not null
           and stored_root.selected_chunks is not null
           and stored_root.graph_trace is not null
           and stored_root.config_snapshot is not null
           and stored_root.config_hash is not null
           and stored_root.rendered_context is not null
           and stored_root.context_hash is not null
         )
    into root_shared_from,root_mode,root_snapshot_key,
         root_benchmark_run_id,root_question_id,root_question_revision,
         root_payload_complete
    from run_item_retrievals stored_root
    join run_items root_item on root_item.id=stored_root.run_item_id
   where stored_root.id=new.root_retrieval_id
   for share of stored_root,root_item;

  if not found then
    raise exception 'retrieval snapshot claim root does not exist'
      using errcode='23503';
  end if;
  if root_shared_from is not null or not root_payload_complete then
    raise exception
      'retrieval snapshot claim must reference a direct payload-bearing root'
      using errcode='23514';
  end if;
  if new.retrieval_mode is distinct from root_mode
     or new.snapshot_key is distinct from root_snapshot_key
     or new.benchmark_run_id is distinct from root_benchmark_run_id
     or new.question_id is distinct from root_question_id
     or new.question_revision is distinct from root_question_revision then
    raise exception
      'retrieval snapshot claim root identity is invalid'
      using errcode='23514';
  end if;
  return new;
end;
$$;

create trigger benchmark_retrieval_snapshot_claims_validate_root
before insert or update of
  snapshot_key,
  benchmark_run_id,
  question_id,
  question_revision,
  retrieval_mode,
  root_retrieval_id
on benchmark_retrieval_snapshot_claims
for each row execute function enforce_benchmark_retrieval_claim_root();

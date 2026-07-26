create table generation_provider_invocations (
  id uuid primary key default gen_random_uuid(),
  generation_batch_id uuid not null
    references generation_batches(id) on delete cascade,
  generation_item_id uuid not null
    references generation_items(id) on delete cascade,
  item_attempt integer not null check (item_attempt > 0),
  stage text not null check (stage in ('DIRECTION','QUESTION')),
  state text not null default 'REQUESTED'
    check (state in ('REQUESTED','COMPLETED','FAILED')),
  provider text not null,
  model_id text not null,
  request_snapshot jsonb not null,
  response_snapshot jsonb,
  raw_response jsonb,
  request_id text,
  model_snapshot text,
  finish_reason text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  error_snapshot jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(generation_item_id,item_attempt,stage)
);

create index generation_provider_invocations_batch_idx
  on generation_provider_invocations(
    generation_batch_id,generation_item_id,item_attempt,stage
  );

create or replace function protect_generation_provider_invocation()
returns trigger
language plpgsql
as $$
begin
  if old.state <> 'REQUESTED' then
    raise exception 'terminal generation provider invocation is immutable'
      using errcode='55000';
  end if;
  if new.state = 'REQUESTED'
     or new.generation_batch_id is distinct from old.generation_batch_id
     or new.generation_item_id is distinct from old.generation_item_id
     or new.item_attempt is distinct from old.item_attempt
     or new.stage is distinct from old.stage
     or new.provider is distinct from old.provider
     or new.model_id is distinct from old.model_id
     or new.request_snapshot is distinct from old.request_snapshot
     or new.started_at is distinct from old.started_at then
    raise exception 'generation provider invocation identity is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger generation_provider_invocation_terminal_guard
before update on generation_provider_invocations
for each row execute function protect_generation_provider_invocation();

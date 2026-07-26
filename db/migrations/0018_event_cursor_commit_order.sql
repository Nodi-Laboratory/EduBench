create table job_event_cursor_allocator (
  singleton boolean primary key default true check (singleton),
  last_id bigint not null check (last_id >= 0)
);

insert into job_event_cursor_allocator(singleton,last_id)
select true,coalesce(max(id),0)
from job_events;

alter table job_events
  alter column id drop identity if exists;

create or replace function allocate_job_event_cursor()
returns trigger
language plpgsql
as $$
declare
  allocated_id bigint;
begin
  begin
    update job_event_cursor_allocator
       set last_id=last_id+1
     where singleton=true
     returning last_id into allocated_id;
  exception
    when numeric_value_out_of_range then
      raise exception 'job event cursor space is exhausted'
        using errcode='22003';
  end;

  if allocated_id is null then
    raise exception 'job event cursor allocator is unavailable'
      using errcode='55000';
  end if;

  new.id := allocated_id;
  return new;
end;
$$;

create trigger job_events_allocate_commit_order_cursor
before insert on job_events
for each row execute function allocate_job_event_cursor();

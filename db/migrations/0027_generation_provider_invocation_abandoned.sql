alter table generation_provider_invocations
  drop constraint if exists generation_provider_invocations_state_check;

alter table generation_provider_invocations
  add constraint generation_provider_invocations_state_check
  check (state in ('REQUESTED','COMPLETED','FAILED','ABANDONED'));

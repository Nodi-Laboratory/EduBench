alter table run_items
  add column if not exists request_snapshot jsonb;

alter table benchmark_runs
  add column if not exists control_requested_at timestamptz,
  add column if not exists last_scoring_error jsonb;

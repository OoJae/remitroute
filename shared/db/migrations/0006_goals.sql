-- 0006: named savings goals with optional lock. A goal wraps a savings_sweep
-- schedule: contributions accumulate toward target_usd, and while lock_until is
-- in the future the engine refuses Aave withdrawals that would cut into the
-- goal's locked value (skipped_locked). Idempotent.

create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) not null,
  schedule_id uuid references schedules(id),
  name text not null,
  asset text not null default 'cUSD',
  target_usd numeric not null,
  target_date timestamptz,
  lock_until timestamptz,
  status text not null default 'active',
  created_at timestamptz default now()
);

create index if not exists goals_user_status_idx on goals (user_id, status);

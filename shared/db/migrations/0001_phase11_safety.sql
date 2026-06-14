-- Phase 11 safety proofs: DB-level idempotency, a global circuit breaker, and a
-- per-cycle audit trail. Idempotent; safe to run repeatedly.
-- Apply with: pnpm db:migrate

-- Idempotency: tag each engine-driven execution with the heartbeat cycle that
-- produced it. The ledger cannot contain a duplicate action: (schedule, cycle,
-- token_in, token_out) is unique. The token columns are part of the key so a
-- multi-leg fx_rebalance (several swaps under one schedule+cycle) is allowed
-- while an exact repeat of the same action is rejected. The partial index
-- ignores legacy rows (null schedule_id or cycle_id) so it applies cleanly to
-- existing data.
alter table executions add column if not exists cycle_id uuid;

create unique index if not exists executions_schedule_cycle_uq
  on executions (schedule_id, cycle_id, coalesce(token_in, ''), coalesce(token_out, ''))
  where schedule_id is not null and cycle_id is not null;

-- Global circuit breaker. A single 'singleton' row holds the engine status; the
-- heartbeat reads it before moving any money and halts on it.
create table if not exists engine_state (
  id text primary key default 'singleton',
  status text not null default 'running',
  halt_reason text,
  halted_at timestamptz,
  cleared_at timestamptz,
  updated_at timestamptz default now()
);

insert into engine_state (id, status) values ('singleton', 'running')
  on conflict (id) do nothing;

-- Per-cycle audit history for the dashboard and anomaly evaluation.
create table if not exists engine_cycles (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid,
  gas_pass boolean,
  halted boolean default false,
  loaded int,
  attempted int,
  succeeded int,
  failed int,
  skipped int,
  volume numeric,
  aborted boolean,
  created_at timestamptz default now()
);

create index if not exists idx_engine_cycles_created on engine_cycles (created_at desc);

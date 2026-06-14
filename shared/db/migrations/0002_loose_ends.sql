-- Loose-ends pass: per-schedule retry counter (next-cycle retry of a transient
-- failure) and a kind-aware idempotency index so distinct actions on the same
-- schedule+cycle (e.g. an auto yield_withdraw followed by a remittance) do not
-- collide while exact duplicates of one action are still rejected. Idempotent.
-- Apply with: pnpm db:migrate

alter table schedules add column if not exists retry_count int default 0;

-- Recreate the executions idempotency index with kind in the key.
drop index if exists executions_schedule_cycle_uq;

create unique index if not exists executions_schedule_cycle_uq
  on executions (schedule_id, cycle_id, kind, coalesce(token_in, ''), coalesce(token_out, ''))
  where schedule_id is not null and cycle_id is not null;

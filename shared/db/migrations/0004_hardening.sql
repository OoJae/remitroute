-- 0004: hardening pass. New tables (auth nonces, x402 replay store, per-user
-- recipient allowlist, rate limits, migration ledger) and new columns (engine
-- reliability + USD-denominated cap value), with supporting indexes. Idempotent.

create table if not exists auth_nonces (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  nonce text not null unique,
  used boolean default false,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
create index if not exists auth_nonces_address_idx on auth_nonces (address);
create index if not exists auth_nonces_expires_idx on auth_nonces (expires_at);

-- An EIP-3009 (payer, nonce) may settle at most once.
create table if not exists x402_nonces (
  payer text not null,
  nonce text not null,
  tx_hash text,
  created_at timestamptz default now(),
  primary key (payer, nonce)
);

-- Per-user confirmed remittance recipients (defense in depth on top of auth).
create table if not exists recipients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) not null,
  address text not null,
  label text,
  created_at timestamptz default now()
);
create unique index if not exists recipients_user_address_uq on recipients (user_id, lower(address));

-- DB-backed rate limiting (works across serverless instances).
create table if not exists rate_limits (
  key text primary key,
  count integer default 0,
  window_start timestamptz default now()
);

-- Applied-migration ledger (also created by migrate.ts; kept here for fresh installs).
create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz default now()
);

-- Engine reliability columns.
alter table schedules add column if not exists consecutive_failures integer default 0;
alter table schedules add column if not exists claimed_at timestamptz;

-- Deterministic idempotency key + USD value for spend-cap accounting.
alter table executions add column if not exists intent_id text;
alter table executions add column if not exists usd_value numeric;
create unique index if not exists executions_user_intent_uq
  on executions (user_id, intent_id) where intent_id is not null;

-- Case-insensitive uniqueness for the minipay binding (future-proofing; all
-- inserts already checksum via getAddress, so no existing rows collide).
--
-- Pre-step: detach any case-variant duplicate binding FIRST so the index below
-- can never fail on legacy data. An earlier build of 0003 deduped case-sensitively
-- and would leave 0xAbc / 0xabc as distinct rows; without this the lower() index
-- create would throw and roll back this whole file (the tables/columns above
-- included). Same non-destructive rule as 0003: keep the row with activity, then
-- earliest, then lowest id; NULL the losers' binding only (the wallet + key row is
-- preserved for manual reconciliation). No-op on a DB whose 0003 already deduped
-- case-insensitively. With this guard the index create is safe, so bundling the
-- DDL above into one file/transaction no longer risks rolling those objects back.
with ranked as (
  select
    u.id,
    row_number() over (
      partition by lower(u.minipay_address)
      order by
        (case when exists (select 1 from schedules s where s.user_id = u.id)
                or exists (select 1 from executions e where e.user_id = u.id)
              then 0 else 1 end),
        u.created_at,
        u.id
    ) as rn
  from users u
  where u.minipay_address is not null
)
update users set minipay_address = null
where id in (select id from ranked where rn > 1);

create unique index if not exists users_minipay_lower_uq
  on users (lower(minipay_address)) where minipay_address is not null;

-- Supporting indexes: the caps trailing-window scan and the dashboard aggregation.
create index if not exists executions_user_created_idx on executions (user_id, created_at);
create index if not exists executions_status_created_idx on executions (status, created_at);

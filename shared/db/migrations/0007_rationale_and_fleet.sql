-- 0007: the decision audit trail plus fleet isolation.
--
-- rationale: every money action already computes WHY it fired (rebalance drift vs
-- target, "sweep 20% of idle above minLiquid", the cap reason on a skip), but the
-- reason was only ever logged and then thrown away. Persisting it on the row is
-- what turns the ledger into an explainable record of autonomous behavior: the
-- dashboard and the Telegram receipt can then show the reason next to the action.
-- treasury_actions.detail is already jsonb, so the agent-side loops carry their
-- rationale in there and need no column here.
--
-- is_fleet: marks the agent-operated wallets provisioned by provision-fleet.ts so
-- run-due can be restricted to them (FLEET_ONLY) while the engine runs live. That
-- quarantines any real human user from the fleet's activity, and is reversible by
-- unsetting the flag. Partial index because the flag is read as a filter and only
-- the true rows are ever selected on.
alter table executions add column if not exists rationale text;

alter table users add column if not exists is_fleet boolean default false;

create index if not exists idx_users_is_fleet on users (is_fleet) where is_fleet = true;

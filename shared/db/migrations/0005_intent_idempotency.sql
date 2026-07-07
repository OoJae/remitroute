-- 0005: activate the intent-idempotency index. 0004 created it as a PARTIAL
-- index (where intent_id is not null); recreate it NON-partial so ON CONFLICT
-- inference on (user_id, intent_id) is clean for the pre-broadcast reservation.
-- NULL intent_id rows remain distinct under a unique index (Postgres treats NULLs
-- as not-equal), so legacy rows never collide and no backfill is needed.
drop index if exists executions_user_intent_uq;
create unique index if not exists executions_user_intent_uq
  on executions (user_id, intent_id);

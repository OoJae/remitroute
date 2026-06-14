-- 0003: guarantee exactly one user (and therefore one automation wallet) per
-- MiniPay address. Idempotent and safe to re-run.
--
-- Defensive dedupe first: if a concurrent double-onboard ever created more than
-- one row for the same minipay_address, remove the later duplicates that carry
-- no schedules and no executions (foreign-key safe), keeping the earliest row.
-- In normal operation there are no duplicates and this deletes nothing.
DELETE FROM users u
WHERE u.minipay_address IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM users older
    WHERE older.minipay_address = u.minipay_address
      AND older.created_at < u.created_at
  )
  AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.user_id = u.id);

-- One automation wallet per MiniPay address. NULL minipay_address rows (e.g. a
-- Telegram-only user) are allowed to repeat, which Postgres permits for NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS users_minipay_address_uq ON users (minipay_address);

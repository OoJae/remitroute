-- 0003: guarantee exactly one user (and therefore one automation wallet) per
-- MiniPay address. Idempotent and safe to re-run.
--
-- Defensive dedupe first: if a concurrent double-onboard ever created more than
-- one row for the same minipay_address, keep the row that actually holds the
-- user's data and delete the empty orphan(s). Per address, rank rows so the one
-- with schedules or executions wins (then earliest, then lowest id), and delete
-- only the non-winning rows that have NO schedules and NO executions, so we
-- never destroy data and never drop the last row. If two rows both hold data,
-- the index creation below fails loudly for a manual merge. Deletes nothing in
-- normal operation.
WITH ranked AS (
  SELECT
    u.id,
    (EXISTS (SELECT 1 FROM schedules s WHERE s.user_id = u.id)
       OR EXISTS (SELECT 1 FROM executions e WHERE e.user_id = u.id)) AS has_activity,
    row_number() OVER (
      PARTITION BY u.minipay_address
      ORDER BY
        (CASE WHEN EXISTS (SELECT 1 FROM schedules s WHERE s.user_id = u.id)
                OR EXISTS (SELECT 1 FROM executions e WHERE e.user_id = u.id)
              THEN 0 ELSE 1 END),
        u.created_at,
        u.id
    ) AS rn
  FROM users u
  WHERE u.minipay_address IS NOT NULL
)
-- Non-destructive: NEVER delete a row (every row holds a wallet_key_ref, so a
-- delete would destroy the only copy of an automation wallet's key and orphan its
-- funds). Instead detach the losing duplicate's minipay binding; NULLs may repeat
-- under the unique index, and the winning row keeps the address. The losing
-- wallet + key are preserved for manual reconciliation.
UPDATE users SET minipay_address = NULL
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- One automation wallet per MiniPay address. NULL minipay_address rows (e.g. a
-- Telegram-only user) are allowed to repeat, which Postgres permits for NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS users_minipay_address_uq ON users (minipay_address);

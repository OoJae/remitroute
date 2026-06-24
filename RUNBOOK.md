# RemitRoute Operations Runbook

Operator reference for running RemitRoute in production. RemitRoute moves real money
on Celo mainnet, so every procedure here is fail-closed by default. Pair this with
`.env.example` (the source of truth for configuration) and `README.md` (architecture).

All script paths are relative to the repo root. Run scripts with `tsx`, for example
`tsx openclaw/skills/remitroute-core/scripts/engine-control.ts --status`.

## 1. Disaster recovery

### ENCRYPTION_KEY is the single most critical secret

`ENCRYPTION_KEY` (32-byte hex) encrypts every user's execution-wallet private key at
rest. If it is lost, every user wallet key becomes permanently undecryptable: funds in
those wallets are unrecoverable through the app. There is no backdoor.

- Keep an offline, encrypted backup of `ENCRYPTION_KEY` (for example in a hardware
  password manager or an offline encrypted volume), separate from the database backups.
- Never store `ENCRYPTION_KEY` in the same place as `DATABASE_URL`. An attacker needs
  both the ciphertext (DB) and the key to read wallet keys; keeping them apart preserves
  that separation.
- `SESSION_SECRET` must stay distinct from `ENCRYPTION_KEY`. Never reuse the
  wallet-encryption key for session signing.

### Database (Neon Postgres)

All scheduling state, executions, and the encrypted wallet keys live in Neon.

- Neon provides point-in-time restore (PITR). Confirm the retention window on your Neon
  plan and keep it long enough to cover an incident-detection window (days, not hours).
- To recover from data loss or corruption, use Neon's branch/PITR to restore to a
  timestamp before the incident, then repoint `DATABASE_URL` at the restored branch.
- A DB restore is useless without `ENCRYPTION_KEY`: restoring ciphertext does not help
  if the key is gone. Back up both, independently.

## 2. Encryption key rotation

Rotation re-encrypts every wallet key under a new `ENCRYPTION_KEY` with no downtime.
Decrypt falls back to `ENCRYPTION_KEY_PREVIOUS` so old ciphertext still reads mid-rotation.

1. Set the env vars on the running deployment:
   - `ENCRYPTION_KEY=<new 32-byte hex>`
   - `ENCRYPTION_KEY_PREVIOUS=<old key>`
   - bump `ENCRYPTION_KEY_VERSION` (for example 1 -> 2)
2. Preview (default, no writes):
   `tsx openclaw/skills/remitroute-core/scripts/rotate-encryption-key.ts`
3. Execute:
   `tsx openclaw/skills/remitroute-core/scripts/rotate-encryption-key.ts --execute`
   Each row is round-trip verified before it is updated, so a bad row is skipped without
   data loss. The script exits non-zero if any row failed.
4. Once it reports 0 failures, remove `ENCRYPTION_KEY_PREVIOUS` from the environment and
   redeploy. Keep the old key in your offline backup until you are confident the new key
   is durably backed up.

## 3. Restart / redeploy

### Web app (Vercel)

The Next.js app (Mini App, dashboard, API routes) is hosted on Vercel.

- Config lives in Vercel project environment variables, mirroring `.env.example`. After
  changing a secret (rotation, new var), redeploy so the new value is picked up.
- Redeploy via a push to the production branch or "Redeploy" in the Vercel dashboard.

### Heartbeat engine (VPS, systemd)

The money engine runs on the VPS as a systemd timer firing every 20 minutes.

```
systemctl status  remitroute-heartbeat.timer    # is the timer active
systemctl status  remitroute-heartbeat.service   # last cycle result
journalctl -u remitroute-heartbeat.service -n 100 # recent logs
systemctl restart remitroute-heartbeat.timer      # after a config change
systemctl enable --now remitroute-heartbeat.timer # (re)install the timer
```

Update `/etc/systemd/system/remitroute-heartbeat.*` from `openclaw/deploy/` if the unit
templates change, then `systemctl daemon-reload` before restarting.

## 4. Circuit breaker

The engine halts itself on a failure or volume anomaly and can be driven manually.

```
tsx openclaw/skills/remitroute-core/scripts/engine-control.ts --status
tsx openclaw/skills/remitroute-core/scripts/engine-control.ts --halt "reason for halting"
tsx openclaw/skills/remitroute-core/scripts/engine-control.ts --resume
```

- A tripped breaker auto-resumes (half-open) after `ANOMALY_HALT_COOLDOWN_MIN` minutes
  (default 30), so a one-off failure burst does not wedge the engine forever. Use
  `--resume` to recover sooner once you have confirmed root cause.
- A permanently failing rule auto-pauses after `MAX_CONSECUTIVE_FAILURES` (default 5)
  consecutive run failures, so it stops burning gas and stops tripping the breaker.
- A schedule stuck in "processing" longer than `RECLAIM_STALE_MIN` (default 10) is
  reclaimed back to active at the next cycle start.

## 5. Wallet gas top-up

Money movement stops when the stablecoin gas buffer falls below `GAS_FLOOR`. Keep the
operational wallets funded with a small working balance (gas paid in cUSD via fee
abstraction):

- Owner / engine wallet (`AGENT_WALLET_ADDRESS`): executes user schedules.
- Relayer wallet (`RELAYER_WALLET_ADDRESS`): submits x402 settlements, kept separate so
  forced settlements cannot drain the engine wallet.
- Monitoring wallet (`MONITORING_WALLET_ADDRESS`): posts metric tags; needs only enough
  for its own writes.

Check the buffer against the floor:
`tsx openclaw/skills/fee-abstraction/scripts/check-gas-buffer.ts`

Top up by sending cUSD (and a little CELO if needed) to the address that is low.

## 6. Alerts and the dead-man switch

- `ALERT_WEBHOOK_URL`: operator alert sink (Slack or generic webhook). The engine posts
  JSON here on halts, anomalies, and errors. Set it before going live so halts are not
  silent.
- `DEADMAN_PING_URL`: hit once per healthy heartbeat (for example a healthchecks.io
  endpoint). If the pings stop, the external monitor pages you, which catches a wedged or
  dead engine that an in-process alert could never report.

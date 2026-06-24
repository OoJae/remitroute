#!/usr/bin/env bash
# One-shot post-deadline revert. Restores the heartbeat cadence (2min -> 20min)
# and spend caps to their safe defaults, and pauses the activity remittance.
# Scheduled via systemd-run --on-calendar to fire after the hackathon window so
# the agent stops farming on its own. Idempotent and append-logs to revert.log.
set -uo pipefail
cd /root/remitroute
LOG=/root/remitroute/revert.log
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
echo "[$(ts)] revert starting" >> "$LOG"

# 1) Heartbeat cadence back to 20 min.
sed -i 's/^OnUnitActiveSec=.*/OnUnitActiveSec=20min/' /etc/systemd/system/remitroute-heartbeat.timer
sed -i 's/^RandomizedDelaySec=.*/RandomizedDelaySec=60/' /etc/systemd/system/remitroute-heartbeat.timer
systemctl daemon-reload
systemctl restart remitroute-heartbeat.timer
echo "[$(ts)] timer: $(grep -E 'OnUnitActiveSec|RandomizedDelaySec' /etc/systemd/system/remitroute-heartbeat.timer | tr '\n' ' ')" >> "$LOG"

# 2) Spend caps back to tiny.
sed -i 's/^PER_USER_DAILY_CAP=.*/PER_USER_DAILY_CAP=2/' .env
sed -i 's/^GLOBAL_DAILY_CAP=.*/GLOBAL_DAILY_CAP=5/' .env
echo "[$(ts)] caps: $(grep -E '^PER_USER_DAILY_CAP=|^GLOBAL_DAILY_CAP=' .env | tr '\n' ' ')" >> "$LOG"

# 3) Pause the activity remittance schedule(s).
export PATH=/root/.nvm/versions/node/v22.22.2/bin:$PATH
export DB_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
node -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DB_URL});p.query(\"update schedules set status='paused' where kind='remittance' and status='active' returning id\").then(r=>{console.log('paused '+r.rowCount+' remittance schedule(s)');return p.end();}).catch(e=>{console.error(e.message);process.exit(1)});" >> "$LOG" 2>&1
echo "[$(ts)] revert complete" >> "$LOG"

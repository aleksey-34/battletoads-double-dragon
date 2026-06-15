#!/usr/bin/env bash
# Keep full_historical_sweep worker alive; restart from DB checkpoint if process dies.
set -euo pipefail

RESEARCH_DB="${RESEARCH_DB_PATH:-/opt/battletoads-double-dragon/research.db}"
BACKEND_DIR="${BTDD_BACKEND:-/opt/battletoads-double-dragon/backend}"
LOG="${SWEEP_WATCHDOG_LOG:-/opt/battletoads-double-dragon/logs/sweep_watchdog.log}"
WORKER_LOG="${SWEEP_WORKER_LOG:-/opt/battletoads-double-dragon/logs/sweep_worker_resume.log}"
SLEEP_SEC="${SWEEP_WATCHDOG_INTERVAL_SEC:-300}"

mkdir -p "$(dirname "$LOG")"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }

while true; do
  job_id="$(python3 - <<'PY'
import sqlite3, os
db = os.environ.get("RESEARCH_DB_PATH", "/opt/battletoads-double-dragon/research.db")
c = sqlite3.connect(db)
row = c.execute(
    "SELECT id FROM research_backfill_jobs WHERE job_key='full_historical_sweep' AND status='running' ORDER BY id DESC LIMIT 1"
).fetchone()
print(row[0] if row else "")
PY
)"

  if [[ -z "$job_id" ]]; then
    log "no running sweep job"
    sleep "$SLEEP_SEC"
    continue
  fi

  if pgrep -f "node dist/research/sweepWorkerEntry.js ${job_id}" >/dev/null 2>&1; then
    sleep "$SLEEP_SEC"
    continue
  fi

  log "worker missing for job #${job_id}; respawning"
  cd "$BACKEND_DIR"
  sudo -u ubuntu env RESEARCH_DB_PATH="$RESEARCH_DB" \
    nohup node dist/research/sweepWorkerEntry.js "$job_id" >>"$WORKER_LOG" 2>&1 &
  sleep "$SLEEP_SEC"
done

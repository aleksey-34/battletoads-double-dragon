#!/usr/bin/env bash
# Safe VPS cleanup: old corrupt DB copies, stale logs, npm cache. Keeps latest backups.
set -euo pipefail

APP="${APP_DIR:-/opt/battletoads-double-dragon}"
BACKUP_DIR="$APP/backend"
KEEP_CORRUPT="${KEEP_CORRUPT_BAK:-1}"

log() { echo "[vps-cleanup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

freed=0
rm_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local sz
    sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
    rm -f "$f"
    freed=$((freed + sz))
    log "removed $(numfmt --to=iec "$sz" 2>/dev/null || echo "${sz}B") $f"
  fi
}

# Corrupt/broken DB copies in backend/ (keep N newest)
mapfile -t corrupt < <(ls -1t "$BACKUP_DIR"/database.db.corrupt.*.bak "$BACKUP_DIR"/database.db.broken.* "$BACKUP_DIR"/database.db.corrupt.* 2>/dev/null || true)
if [[ ${#corrupt[@]} -gt $KEEP_CORRUPT ]]; then
  for ((i=KEEP_CORRUPT; i<${#corrupt[@]}; i++)); do
    rm_file "${corrupt[$i]}"
  done
fi

# backups/db: keep 3 newest database_* snapshots
if [[ -d "$APP/backups/db" ]]; then
  mapfile -t dbs < <(ls -1t "$APP/backups/db"/database_*.db 2>/dev/null || true)
  for ((i=3; i<${#dbs[@]}; i++)); do
    rm_file "${dbs[$i]}"
  done
fi

# Old sweep checkpoints / merged touches (keep 30 days)
find "$APP/results" -maxdepth 1 -name 'btdd_d1_historical_sweep_*-000Z.json' -mtime +14 -delete 2>/dev/null || true

# Journal trim (requires root)
journalctl --vacuum-size=200M 2>/dev/null || true

# npm cache (ubuntu user)
if command -v npm >/dev/null; then
  sudo -u ubuntu npm cache clean --force 2>/dev/null || true
fi

log "done, freed ~$(numfmt --to=iec "$freed" 2>/dev/null || echo "${freed}B")"
df -h "$APP" | tail -1
free -h | head -2

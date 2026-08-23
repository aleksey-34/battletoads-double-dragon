#!/usr/bin/env bash
# Safe prod DB retention: backup → stop services → cleanup → VACUUM → start.
# Run on VPS as root during maintenance window.
#
#   bash scripts/vps_db_retention.sh --dry-run
#   bash scripts/vps_db_retention.sh --apply
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BACKEND="$APP_DIR/backend"
DB="$BACKEND/database.db"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$APP_DIR/backups/db"
DRY=1
VACUUM=1

log() { printf '[vps-db-retention] %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; VACUUM=0; shift ;;
    --apply) DRY=0; shift ;;
    --no-vacuum) VACUUM=0; shift ;;
    *) log "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -f "$DB" ]] || { log "Missing $DB"; exit 1; }
[[ -f "$APP_DIR/scripts/admin_tools/db_retention_cleanup.py" ]] || { log "Script missing — git pull first"; exit 1; }

mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/database_pre_retention_${STAMP}.db"
log "SQLite backup → $BACKUP"
sqlite3 "$DB" ".backup '$BACKUP'"
log "Backup size: $(du -h "$BACKUP" | awk '{print $1}')"

stop_services() {
  for svc in btdd-api btdd-runtime btdd-research; do
    systemctl stop "$svc" 2>/dev/null || true
  done
}

start_services() {
  for svc in btdd-api btdd-runtime btdd-research; do
    systemctl start "$svc" 2>/dev/null || true
  done
}

PY_ARGS=(python3 "$APP_DIR/scripts/admin_tools/db_retention_cleanup.py" --db "$DB")
if [[ "$DRY" -eq 1 ]]; then
  PY_ARGS+=(--dry-run)
else
  PY_ARGS+=(--apply)
  [[ "$VACUUM" -eq 1 ]] && PY_ARGS+=(--vacuum)
fi

if [[ "$DRY" -eq 1 ]]; then
  log "Dry-run (services stay up)..."
  "${PY_ARGS[@]}"
  exit 0
fi

log "Stopping btdd services..."
stop_services
sleep 2

log "Applying retention..."
"${PY_ARGS[@]}"

log "Starting services..."
start_services
sleep 3
systemctl is-active btdd-api btdd-runtime btdd-research || true
log "DB size now: $(du -h "$DB" | awk '{print $1}')"
log "Done."

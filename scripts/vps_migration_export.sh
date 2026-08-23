#!/usr/bin/env bash
# Export BTDD state for VPS migration (run on OLD VPS as root, or locally with APP_DIR).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BACKEND_DIR="${BACKEND_DIR:-$APP_DIR/backend}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-$APP_DIR/backups/migration}"
ARCHIVE="$OUT_DIR/btdd_migration_${STAMP}.tar.gz"
WORK="$OUT_DIR/.pack_${STAMP}"

log() { printf '[migration-export] %s\n' "$*"; }

mkdir -p "$OUT_DIR" "$WORK"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    log "  + $(basename "$src")"
  fi
}

log "Packing from APP_DIR=$APP_DIR"

if [[ "${PRE_RETENTION_CLEAN:-0}" == "1" ]]; then
  log "PRE_RETENTION_CLEAN=1 — safe retention (dry-run → apply, optional vacuum)"
  python3 "$APP_DIR/scripts/admin_tools/db_retention_cleanup.py" --db "$BACKEND_DIR/database.db" --dry-run || true
  if [[ "${PRE_RETENTION_VACUUM:-0}" == "1" ]]; then
    bash "$APP_DIR/scripts/vps_db_retention.sh" --apply
  else
    python3 "$APP_DIR/scripts/admin_tools/db_retention_cleanup.py" \
      --db "$BACKEND_DIR/database.db" --apply --purge-orphans || true
  fi
fi

# Secrets & config (NEVER commit these to git)
copy_if_exists "$APP_DIR/.env" "$WORK/config/.env"
copy_if_exists "$BACKEND_DIR/.auth-password.json" "$WORK/config/.auth-password.json"
copy_if_exists "$BACKEND_DIR/.env" "$WORK/config/backend.env"

# Databases
copy_if_exists "$BACKEND_DIR/database.db" "$WORK/db/database.db"
copy_if_exists "${DB_FILE:-$BACKEND_DIR/database.db}" "$WORK/db/database.db"
copy_if_exists "$BACKEND_DIR/monitoring.db" "$WORK/db/monitoring.db"
copy_if_exists "$BACKEND_DIR/research.db" "$WORK/db/research.db"
copy_if_exists "$APP_DIR/data/research.db" "$WORK/db/research.db"
copy_if_exists "$APP_DIR/research.db" "$WORK/db/research.db"

# Optional: latest auto-backups from deploy script
if [[ -d "$APP_DIR/backups/db" ]]; then
  mkdir -p "$WORK/db/backups"
  ls -1t "$APP_DIR/backups/db"/database_*.db 2>/dev/null | head -2 | while read -r f; do
    cp -a "$f" "$WORK/db/backups/"
    log "  + backup $(basename "$f")"
  done
fi

# Git commit for traceability
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" rev-parse HEAD > "$WORK/MANIFEST.git_head" 2>/dev/null || true
  git -C "$APP_DIR" log -1 --oneline > "$WORK/MANIFEST.last_commit" 2>/dev/null || true
fi

# Service versions
{
  echo "exported_at=$STAMP"
  echo "hostname=$(hostname -f 2>/dev/null || hostname)"
  node --version 2>/dev/null || true
  nginx -v 2>&1 || true
  systemctl is-active btdd-api btdd-runtime btdd-research 2>/dev/null || true
} > "$WORK/MANIFEST.txt"

# Nginx site config (no certs — copy separately if needed)
copy_if_exists /etc/nginx/sites-available/battletoads-double-dragon "$WORK/nginx/battletoads-double-dragon"

tar -czf "$ARCHIVE" -C "$WORK" .
rm -rf "$WORK"

log "Done: $ARCHIVE ($(du -h "$ARCHIVE" | awk '{print $1}'))"
log "Download: scp root@HOST:$ARCHIVE ./"

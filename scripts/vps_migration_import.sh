#!/usr/bin/env bash
# Import BTDD migration archive on NEW VPS (run as root).
# Usage: bash scripts/vps_migration_import.sh /path/to/btdd_migration_*.tar.gz
set -euo pipefail

ARCHIVE="${1:-}"
APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BACKEND_DIR="$APP_DIR/backend"
NGINX_ROOT="${NGINX_ROOT:-/var/www/battletoads-double-dragon}"

log() { printf '[migration-import] %s\n' "$*"; }
fail() { log "ERROR: $*"; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "Run as root"
[[ -f "$ARCHIVE" ]] || fail "Archive not found: $ARCHIVE"
[[ -d "$APP_DIR" ]] || fail "APP_DIR missing: $APP_DIR — clone repo first"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log "Extracting $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$WORK"

SERVICE_USER="${SERVICE_USER:-ubuntu}"
id "$SERVICE_USER" >/dev/null 2>&1 || fail "User not found: $SERVICE_USER"

restore_file() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    chown "$SERVICE_USER:$SERVICE_USER" "$dst" 2>/dev/null || true
    log "Restored $(basename "$dst")"
  fi
}

# Stop services before DB swap
for svc in btdd-api btdd-runtime btdd-research battletoads-backend; do
  systemctl stop "$svc" 2>/dev/null || true
done

restore_file "$WORK/config/.env" "$APP_DIR/.env"
restore_file "$WORK/config/backend.env" "$BACKEND_DIR/.env"
restore_file "$WORK/config/.auth-password.json" "$BACKEND_DIR/.auth-password.json"
restore_file "$WORK/db/database.db" "$BACKEND_DIR/database.db"
restore_file "$WORK/db/research.db" "$BACKEND_DIR/research.db"

mkdir -p "$APP_DIR/data" "$APP_DIR/backups/db"
if [[ -f "$WORK/db/research.db" ]]; then
  cp -a "$WORK/db/research.db" "$APP_DIR/data/research.db"
  chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/data/research.db"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.env" "$BACKEND_DIR/database.db" "$BACKEND_DIR/.auth-password.json" 2>/dev/null || true
chmod 600 "$APP_DIR/.env" "$BACKEND_DIR/.auth-password.json" 2>/dev/null || true

if [[ -f "$WORK/nginx/battletoads-double-dragon" ]]; then
  cp -a "$WORK/nginx/battletoads-double-dragon" /etc/nginx/sites-available/battletoads-double-dragon
  ln -sf /etc/nginx/sites-available/battletoads-double-dragon /etc/nginx/sites-enabled/battletoads-double-dragon
  nginx -t && systemctl reload nginx
fi

if [[ -f "$WORK/MANIFEST.txt" ]]; then
  log "Source manifest:"
  cat "$WORK/MANIFEST.txt"
fi

log "Import complete. Next: bash $APP_DIR/scripts/vps_fresh_restore.sh"

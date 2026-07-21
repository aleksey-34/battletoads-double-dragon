#!/usr/bin/env bash
# One-shot bootstrap on a FRESH Ubuntu VPS (run as root).
# Usage:
#   bash scripts/vps_bootstrap_new_server.sh --bundle /path/to/prod_YYYYMMDDTHHMMSSZ
#   bash scripts/vps_bootstrap_new_server.sh --archive /path/to/btdd_migration_*.tar.gz
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
NGINX_ROOT="${NGINX_ROOT:-/var/www/battletoads-double-dragon}"
BUNDLE=""
ARCHIVE=""
REPO_URL="${REPO_URL:-git@github.com:aleksey-34/battletoads-double-dragon.git}"

log() { printf '[bootstrap] %s\n' "$*"; }
fail() { log "ERROR: $*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    *) fail "Unknown arg: $1" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || fail "Run as root"
[[ -n "$BUNDLE" || -n "$ARCHIVE" ]] || fail "Pass --bundle DIR or --archive FILE"

log "Installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git nginx curl rsync sqlite3 ca-certificates

if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu
mkdir -p "$APP_DIR" "$NGINX_ROOT"
chown -R ubuntu:ubuntu "$APP_DIR"

if [[ ! -d "$APP_DIR/.git" ]]; then
  log "Cloning repository..."
  sudo -u ubuntu git clone "$REPO_URL" "$APP_DIR"
fi

if [[ -n "$ARCHIVE" ]]; then
  bash "$APP_DIR/scripts/vps_migration_import.sh" "$ARCHIVE"
fi

if [[ -n "$BUNDLE" ]]; then
  [[ -d "$BUNDLE" ]] || fail "Bundle dir not found: $BUNDLE"
  [[ -f "$BUNDLE/config/.env" ]] || fail "Missing $BUNDLE/config/.env"
  [[ -f "$BUNDLE/db/database.db.gz" ]] || fail "Missing $BUNDLE/db/database.db.gz"

  log "Restoring .env and auth..."
  cp -a "$BUNDLE/config/.env" "$APP_DIR/.env"
  cp -a "$BUNDLE/config/.auth-password.json" "$APP_DIR/backend/.auth-password.json" 2>/dev/null || true
  chmod 600 "$APP_DIR/.env" "$APP_DIR/backend/.auth-password.json" 2>/dev/null || true
  chown ubuntu:ubuntu "$APP_DIR/.env" "$APP_DIR/backend/.auth-password.json" 2>/dev/null || true

  if [[ -f "$BUNDLE/db/research.db" ]]; then
    cp -a "$BUNDLE/db/research.db" "$APP_DIR/backend/research.db"
    chown ubuntu:ubuntu "$APP_DIR/backend/research.db"
  fi

  log "Restoring database.db from gzip (may take a while)..."
  gunzip -c "$BUNDLE/db/database.db.gz" > "$APP_DIR/backend/database.db"
  chown ubuntu:ubuntu "$APP_DIR/backend/database.db"

  if [[ -f "$BUNDLE/nginx/battletoads-double-dragon" ]]; then
    cp -a "$BUNDLE/nginx/battletoads-double-dragon" /etc/nginx/sites-available/battletoads-double-dragon
    ln -sf /etc/nginx/sites-available/battletoads-double-dragon /etc/nginx/sites-enabled/battletoads-double-dragon
  fi
fi

log "Running fresh restore (nginx + systemd + build)..."
bash "$APP_DIR/scripts/vps_fresh_restore.sh"

log "Bootstrap complete. Verify:"
log "  systemctl is-active btdd-api btdd-runtime btdd-research nginx"
log "  curl -sS http://127.0.0.1:3001/api/health"
log "  certbot --nginx -d battletoads.top  # after DNS points here"

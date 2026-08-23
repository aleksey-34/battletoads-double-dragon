#!/usr/bin/env bash
# Pull production migration bundle from VPS to local machine.
# Usage: bash scripts/vps_migration_pull_to_local.sh [ssh_host_alias]
set -euo pipefail

SSH_HOST="${1:-btdd}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${DEST:-$REPO_ROOT/backups/migration/prod_${STAMP}}"
REMOTE_APP="${REMOTE_APP:-/opt/battletoads-double-dragon}"
REMOTE_BACKEND="$REMOTE_APP/backend"

log() { printf '[migration-pull] %s\n' "$*"; }
fail() { log "ERROR: $*"; exit 1; }

command -v ssh >/dev/null || fail "ssh required"
command -v scp >/dev/null || fail "scp required"

mkdir -p "$DEST/config" "$DEST/db" "$DEST/nginx" "$DEST/logs"

log "Destination: $DEST"
log "Source: $SSH_HOST:$REMOTE_APP"

# Small files first
log "Pulling .env and auth..."
scp -q "$SSH_HOST:$REMOTE_APP/.env" "$DEST/config/.env" 2>/dev/null || log "WARN: .env missing"
scp -q "$SSH_HOST:$REMOTE_BACKEND/.auth-password.json" "$DEST/config/.auth-password.json" 2>/dev/null || true
scp -q "$SSH_HOST:$REMOTE_BACKEND/research.db" "$DEST/db/research.db" 2>/dev/null || true
scp -q "$SSH_HOST:$REMOTE_BACKEND/monitoring.db" "$DEST/db/monitoring.db" 2>/dev/null || true

log "Pulling nginx site config..."
scp -q "$SSH_HOST:/etc/nginx/sites-available/battletoads-double-dragon" "$DEST/nginx/battletoads-double-dragon" 2>/dev/null || true

log "Recording remote manifest..."
ssh "$SSH_HOST" "bash -s" <<REMOTE > "$DEST/MANIFEST.remote.txt"
set -euo pipefail
echo "exported_at=$STAMP"
echo "hostname=\$(hostname -f 2>/dev/null || hostname)"
git -C "$REMOTE_APP" rev-parse HEAD 2>/dev/null || true
git -C "$REMOTE_APP" log -1 --oneline 2>/dev/null || true
node --version 2>/dev/null || true
nginx -v 2>&1 || true
systemctl is-active btdd-api btdd-runtime btdd-research nginx 2>/dev/null || true
du -h "$REMOTE_BACKEND/database.db" 2>/dev/null || true
du -h "$REMOTE_BACKEND/monitoring.db" 2>/dev/null || true
REMOTE

log "Creating consistent SQLite backup on VPS and streaming gzip (may take 30-90 min for ~20GB)..."
log "Log: $DEST/logs/db_pull.log"

# Prefer deploy auto-backup on VPS (avoids duplicating 20GB in /tmp)
REMOTE_BACKUP="$(ssh "$SSH_HOST" "ls -1t $REMOTE_APP/backups/db/database_*.db 2>/dev/null | head -1" || true)"
if [[ -n "$REMOTE_BACKUP" ]]; then
  log "Using existing VPS backup: $REMOTE_BACKUP"
  ssh "$SSH_HOST" "gzip -c '$REMOTE_BACKUP'" > "$DEST/db/database.db.gz"
else
  log "No deploy backup found — online sqlite .backup stream..."
  ssh "$SSH_HOST" "REMOTE_BACKEND='$REMOTE_BACKEND' BACKUP='$REMOTE_APP/backups/migration/.live_backup.db' bash -s" <<'REMOTE' 2> "$DEST/logs/db_pull.stderr" | gzip -1 > "$DEST/db/database.db.gz"
set -euo pipefail
mkdir -p "$(dirname "$BACKUP")"
rm -f "$BACKUP" "${BACKUP}-wal" "${BACKUP}-shm"
echo "[remote] sqlite3 backup start $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
sqlite3 "$REMOTE_BACKEND/database.db" ".backup '$BACKUP'"
echo "[remote] backup size: $(du -h "$BACKUP" | awk '{print $1}')" >&2
cat "$BACKUP"
rm -f "$BACKUP" "${BACKUP}-wal" "${BACKUP}-shm"
echo "[remote] done $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
REMOTE
fi

log "database.db.gz size: $(du -h "$DEST/db/database.db.gz" | awk '{print $1}')"

# Pack config bundle for import script compatibility
CONFIG_ARCHIVE="$REPO_ROOT/backups/migration/btdd_migration_config_${STAMP}.tar.gz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/config" "$WORK/db" "$WORK/nginx"
cp -a "$DEST/config/." "$WORK/config/" 2>/dev/null || true
cp -a "$DEST/db/research.db" "$WORK/db/research.db" 2>/dev/null || true
cp -a "$DEST/nginx/." "$WORK/nginx/" 2>/dev/null || true
cp "$DEST/MANIFEST.remote.txt" "$WORK/MANIFEST.txt"
tar -czf "$CONFIG_ARCHIVE" -C "$WORK" .

cat > "$DEST/README.txt" <<EOF
BTDD production migration bundle
Created: $STAMP
Source: $SSH_HOST ($REMOTE_APP)

Restore on NEW VPS:
  1. git clone + cd battletoads-double-dragon
  2. gunzip -c db/database.db.gz > /opt/battletoads-double-dragon/backend/database.db
  3. bash scripts/vps_migration_import.sh $CONFIG_ARCHIVE
     (then manually copy database.db.gz content if import used old snapshot)
  OR use: bash scripts/vps_bootstrap_new_server.sh --bundle $DEST

Files:
  config/.env              — production secrets (DO NOT commit)
  config/.auth-password.json
  db/database.db.gz        — consistent sqlite backup of prod database.db
  db/monitoring.db         — equity snapshots + fills (~MB scale)
  db/research.db
  nginx/                   — site config reference
EOF

log "Done."
log "  Bundle dir:  $DEST"
log "  Config tar:  $CONFIG_ARCHIVE"
log "  DB archive:  $DEST/db/database.db.gz"

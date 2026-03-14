#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SSH_HOST="${1:-}"
APP_DIR="${2:-/opt/battletoads-double-dragon}"

SSH_OPTS="${SSH_OPTS:-}"
RSYNC_RSH_VALUE="${RSYNC_RSH:-ssh ${SSH_OPTS}}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy_vps_current_tree.sh <ssh_host> [app_dir]

Examples:
  bash scripts/deploy_vps_current_tree.sh root@176.57.184.98
  SSH_OPTS='-i ~/.ssh/id_rsa -p 22' bash scripts/deploy_vps_current_tree.sh root@176.57.184.98 /opt/battletoads-double-dragon

What it does:
  1. Rsyncs the current local working tree to VPS (including uncommitted changes)
  2. Builds backend and frontend on VPS
  3. Publishes frontend build to /var/www/battletoads-double-dragon
  4. Restarts battletoads-backend.service and reloads nginx

Requirements on VPS:
  - repository already exists at APP_DIR
  - node/npm installed
  - battletoads-backend.service and nginx already configured
EOF
}

if [[ -z "${SSH_HOST}" ]]; then
  usage
  exit 1
fi

log() {
  echo "[deploy-current-tree] $*"
}

if [[ ! -d "${ROOT_DIR}/backend" || ! -d "${ROOT_DIR}/frontend" ]]; then
  echo "Repository root not detected: ${ROOT_DIR}"
  exit 1
fi

log "Syncing current working tree to ${SSH_HOST}:${APP_DIR}"
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'backend/node_modules/' \
  --exclude 'backend/database.db' \
  --exclude 'backend/logs/' \
  --exclude 'frontend/node_modules/' \
  --exclude 'frontend/build/' \
  --exclude 'backend/dist/' \
  --exclude 'logs/' \
  --exclude 'results/' \
  --exclude '.DS_Store' \
  -e "${RSYNC_RSH_VALUE}" \
  "${ROOT_DIR}/" "${SSH_HOST}:${APP_DIR}/"

REMOTE_CMD=$(cat <<EOF
set -euo pipefail
cd '${APP_DIR}/backend'
npm ci || npm install
npm run build
cd '${APP_DIR}/frontend'
npm ci || npm install
REACT_APP_API_BASE_URL='/api' npm run build
mkdir -p /var/www/battletoads-double-dragon
rsync -a --delete '${APP_DIR}/frontend/build/' /var/www/battletoads-double-dragon/
systemctl restart battletoads-backend.service
systemctl reload nginx
echo '[remote] deployment complete'
systemctl status battletoads-backend.service --no-pager | head -n 20
EOF
)

log "Building and restarting services on ${SSH_HOST}"
ssh ${SSH_OPTS} "${SSH_HOST}" "${REMOTE_CMD}"

log "Done"
echo "Next checks:"
echo "  ssh ${SSH_HOST} \"systemctl status battletoads-backend.service --no-pager\""
echo "  ssh ${SSH_HOST} \"journalctl -u battletoads-backend.service -n 120 --no-pager\""
echo "  ssh ${SSH_HOST} \"curl -I http://127.0.0.1\""

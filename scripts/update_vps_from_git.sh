#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BRANCH="${BRANCH:-main}"

log() {
  echo "[update-vps] $*"
}

git_no_prompt() {
  GIT_TERMINAL_PROMPT=0 git "$@"
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root (sudo)."
  exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "Repository not found in ${APP_DIR}"
  exit 1
fi

log "Pulling latest code (${BRANCH})"
if ! git_no_prompt -C "${APP_DIR}" fetch --all --prune; then
  echo "Git fetch failed in non-interactive mode."
  echo "If repository is private, configure credentials/token for this VPS."
  exit 1
fi

git_no_prompt -C "${APP_DIR}" checkout "${BRANCH}"
git_no_prompt -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"

log "Updating backend"
cd "${APP_DIR}/backend"
npm ci || npm install
npm run build

log "Updating frontend"
cd "${APP_DIR}/frontend"
npm ci || npm install
REACT_APP_API_BASE_URL="/api" npm run build

log "Publishing frontend build"
mkdir -p /var/www/battletoads-double-dragon
rsync -a --delete "${APP_DIR}/frontend/build/" /var/www/battletoads-double-dragon/

log "Restarting services"
systemctl restart battletoads-backend.service
systemctl reload nginx

log "Done"

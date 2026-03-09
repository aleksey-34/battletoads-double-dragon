#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-${REPO_URL:-}}"
APP_DIR="${2:-${APP_DIR:-/opt/battletoads-double-dragon}}"
BRANCH="${3:-${BRANCH:-main}}"
DOMAIN="${DOMAIN:-_}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
STRATEGY_AUTORUN_SEC="${STRATEGY_AUTORUN_SEC:-30}"
NODE_MAJOR="${NODE_MAJOR:-20}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ENABLE_GIT_UPDATE="${ENABLE_GIT_UPDATE:-1}"

log() {
  echo "[setup-vps] $*"
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run this script as root (sudo)."
    exit 1
  fi
}

ensure_node() {
  local install_node="0"

  if ! command -v node >/dev/null 2>&1; then
    install_node="1"
  else
    local current_major
    current_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "${current_major}" -lt "${NODE_MAJOR}" ]]; then
      install_node="1"
    fi
  fi

  if [[ "${install_node}" == "1" ]]; then
    log "Installing Node.js ${NODE_MAJOR}.x"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
}

sync_repo() {
  if [[ -d "${APP_DIR}/.git" ]]; then
    log "Updating existing repository in ${APP_DIR}"
    git -C "${APP_DIR}" fetch --all --prune
    git -C "${APP_DIR}" checkout "${BRANCH}"
    git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
  else
    log "Cloning repository ${REPO_URL} into ${APP_DIR}"
    git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}"
  fi
}

install_dependencies_and_build() {
  log "Installing backend dependencies"
  cd "${APP_DIR}/backend"
  npm ci || npm install
  npm run build

  log "Installing frontend dependencies"
  cd "${APP_DIR}/frontend"
  npm ci || npm install
  REACT_APP_API_BASE_URL="/api" npm run build
}

publish_frontend() {
  log "Publishing frontend build to /var/www/battletoads-double-dragon"
  mkdir -p /var/www/battletoads-double-dragon
  rsync -a --delete "${APP_DIR}/frontend/build/" /var/www/battletoads-double-dragon/
}

configure_backend_env() {
  if [[ -z "${ADMIN_PASSWORD}" ]]; then
    ADMIN_PASSWORD="$(openssl rand -hex 12)"
    log "Generated random admin password"
  fi

  local password_hash
  password_hash="$(cd "${APP_DIR}/backend" && node -e "const bcrypt=require('bcrypt'); console.log(bcrypt.hashSync(process.argv[1], 10));" "${ADMIN_PASSWORD}")"

  cat > /etc/battletoads-backend.env <<EOF
PORT=${BACKEND_PORT}
STRATEGY_AUTORUN_SEC=${STRATEGY_AUTORUN_SEC}
PASSWORD_HASH=${password_hash}
APP_DIR=${APP_DIR}
GIT_BRANCH=${BRANCH}
UPDATE_SCRIPT=${APP_DIR}/scripts/update_vps_from_git.sh
ENABLE_GIT_UPDATE=${ENABLE_GIT_UPDATE}
EOF
  chmod 600 /etc/battletoads-backend.env
}

configure_systemd() {
  log "Configuring systemd service battletoads-backend"
  cat > /etc/systemd/system/battletoads-backend.service <<EOF
[Unit]
Description=BattleToads Double Dragon Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/backend
EnvironmentFile=/etc/battletoads-backend.env
ExecStart=/usr/bin/node ${APP_DIR}/backend/dist/server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable battletoads-backend.service
  systemctl restart battletoads-backend.service
}

configure_nginx() {
  log "Configuring nginx reverse proxy"
  cat > /etc/nginx/sites-available/battletoads-double-dragon.conf <<EOF
server {
  listen 80;
  server_name ${DOMAIN};

  root /var/www/battletoads-double-dragon;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:${BACKEND_PORT}/api/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location / {
    try_files \$uri /index.html;
  }
}
EOF

  ln -sf /etc/nginx/sites-available/battletoads-double-dragon.conf /etc/nginx/sites-enabled/battletoads-double-dragon.conf
  rm -f /etc/nginx/sites-enabled/default

  nginx -t
  systemctl enable nginx
  systemctl restart nginx
}

main() {
  require_root

  if [[ -z "${REPO_URL}" ]]; then
    echo "Usage: sudo bash scripts/setup_vps_ubuntu20.sh <repo_url> [install_dir] [branch]"
    echo "Example: sudo bash scripts/setup_vps_ubuntu20.sh https://github.com/owner/repo.git /opt/battletoads-double-dragon main"
    exit 1
  fi

  log "Installing base packages"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git build-essential rsync nginx openssl

  ensure_node
  sync_repo
  install_dependencies_and_build
  publish_frontend
  configure_backend_env
  configure_systemd
  configure_nginx

  log "Deployment completed"
  echo ""
  echo "Backend service: battletoads-backend"
  echo "Nginx site: /etc/nginx/sites-available/battletoads-double-dragon.conf"
  echo "Install dir: ${APP_DIR}"
  echo "Admin password: ${ADMIN_PASSWORD}"
  echo ""
  echo "If you set DOMAIN, point DNS to this server and configure HTTPS with certbot next."
}

main "$@"

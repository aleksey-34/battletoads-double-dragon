#!/usr/bin/env bash
# One-shot restore on fresh VPS after rsync of /opt/battletoads-double-dragon
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
NGINX_ROOT="${NGINX_ROOT:-/var/www/battletoads-double-dragon}"
API_PORT="${API_PORT:-3001}"

log() { printf '[vps-restore] %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root"; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo "Missing $APP_DIR/.env"; exit 1; }

if grep -q '^PORT=' "$APP_DIR/.env" 2>/dev/null; then
  API_PORT="$(grep '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d ' \"')"
fi

log "API_PORT=$API_PORT"

mkdir -p "$NGINX_ROOT" "$APP_DIR/data" "$APP_DIR/backups/db"
chown -R ubuntu:ubuntu "$APP_DIR/data" "$APP_DIR/backups" 2>/dev/null || true

cat > /etc/nginx/sites-available/battletoads-double-dragon <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root $NGINX_ROOT;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/battletoads-double-dragon /etc/nginx/sites-enabled/battletoads-double-dragon
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

grep -q '^DEPLOY_MODE=' "$APP_DIR/.env" || echo 'DEPLOY_MODE=multi' >> "$APP_DIR/.env"
grep -q '^SYNC_FRONTEND_NGINX=' "$APP_DIR/.env" || echo 'SYNC_FRONTEND_NGINX=1' >> "$APP_DIR/.env"

cd "$APP_DIR"
SERVICE_USER=ubuntu bash scripts/btdd_setup_services.sh

log "Deploy latest build"
DEPLOY_MODE=multi BACKEND_BUILD=always FRONTEND_BUILD_MODE=always bash scripts/update_vps_from_git.sh || \
  bash scripts/vps_deploy_api_key_fix.sh

systemctl status btdd-api btdd-research btdd-runtime --no-pager || true
curl -sf "http://127.0.0.1:${API_PORT}/api/health" && log "API health OK" || log "WARN: API health check failed"

BUNDLE="$(ls -1 "$NGINX_ROOT"/static/js/main.*.js 2>/dev/null | head -1 || true)"
log "nginx bundle: ${BUNDLE:-missing}"

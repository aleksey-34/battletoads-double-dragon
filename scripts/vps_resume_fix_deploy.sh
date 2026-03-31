#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/battletoads-double-dragon"
FRONTEND_DIR="$APP_DIR/frontend"
NGINX_ROOT="/var/www/battletoads-double-dragon"

echo "[resume] start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[resume] api before: $(systemctl is-active btdd-api 2>/dev/null || echo unknown)"

cd "$FRONTEND_DIR"
if ! NPM_CONFIG_PRODUCTION=false NPM_CONFIG_INCLUDE=dev npm ci --include=dev --silent; then
  NPM_CONFIG_PRODUCTION=false NPM_CONFIG_INCLUDE=dev npm install --include=dev --no-audit --no-fund --silent
fi
CI=false npm run build

rsync -a --delete "$FRONTEND_DIR/build/" "$NGINX_ROOT/"
find "$NGINX_ROOT" -type d -exec chmod 755 {} +
find "$NGINX_ROOT" -type f -exec chmod 644 {} +
systemctl reload nginx

echo "[resume] api after: $(systemctl is-active btdd-api 2>/dev/null || echo unknown)"
echo "[resume] nginx: $(systemctl is-active nginx 2>/dev/null || echo unknown)"
echo "[resume] build index: $(test -f $FRONTEND_DIR/build/index.html && echo present || echo missing)"
echo "[resume] nginx bundle: $(ls -1 $NGINX_ROOT/static/js/main.*.js 2>/dev/null | head -n 1 || true)"
echo "[resume] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"

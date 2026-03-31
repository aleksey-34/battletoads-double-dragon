#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/battletoads-double-dragon"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_DIR="$APP_DIR/frontend"
NGINX_ROOT="/var/www/battletoads-double-dragon"

echo "[deploy-fix] build backend"
cd "$BACKEND_DIR"
if ! NPM_CONFIG_PRODUCTION=false NPM_CONFIG_INCLUDE=dev npm ci --include=dev --silent; then
  NPM_CONFIG_PRODUCTION=false NPM_CONFIG_INCLUDE=dev npm install --include=dev --no-audit --no-fund --silent
fi
npm run build

echo "[deploy-fix] restart btdd-api"
systemctl restart btdd-api
systemctl is-active btdd-api

echo "[deploy-fix] build frontend"
cd "$FRONTEND_DIR"
if ! NPM_CONFIG_PRODUCTION=false NPM_CONFIG_INCLUDE=dev npm ci --include=dev --silent; then
  NPM_CONFIG_PRODUCTION=false NPM_CONFIG_INCLUDE=dev npm install --include=dev --no-audit --no-fund --silent
fi
CI=false npm run build

echo "[deploy-fix] sync nginx root"
rsync -a --delete "$FRONTEND_DIR/build/" "$NGINX_ROOT/"
find "$NGINX_ROOT" -type d -exec chmod 755 {} +
find "$NGINX_ROOT" -type f -exec chmod 644 {} +
systemctl reload nginx

echo "[deploy-fix] bundle"
ls -1 "$NGINX_ROOT"/static/js/main.*.js | head -n 1

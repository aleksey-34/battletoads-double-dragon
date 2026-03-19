#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BRANCH="${BRANCH:-feature/research-sweep-spec-and-scheduler}"
FRONTEND_DIR="${FRONTEND_DIR:-$APP_DIR/frontend}"
BACKEND_DIR="${BACKEND_DIR:-$APP_DIR/backend}"
BUILD_BACKEND="${BUILD_BACKEND:-1}"
API_SERVICE="${API_SERVICE:-}"

pick_api_service() {
  local candidates=("btdd-api.service" "btdd-backend.service" "battletoads-backend.service")
  local service

  for service in "${candidates[@]}"; do
    if systemctl cat "$service" >/dev/null 2>&1 && systemctl is-active --quiet "$service"; then
      echo "$service"
      return
    fi
  done

  for service in "${candidates[@]}"; do
    if systemctl cat "$service" >/dev/null 2>&1; then
      echo "$service"
      return
    fi
  done

  echo ""
}

stop_conflicting_api_services() {
  local selected="$1"
  local known=("btdd-api.service" "btdd-backend.service" "battletoads-backend.service")
  local service

  for service in "${known[@]}"; do
    if [[ "$service" == "$selected" ]]; then
      continue
    fi
    if systemctl is-active --quiet "$service"; then
      echo "[vps-sync] Stopping conflicting API service: $service"
      systemctl stop "$service" || true
    fi
  done
}

# Detect nginx static root from config; fallback to known defaults.
detect_nginx_root() {
  local detected=""
  detected="$(nginx -T 2>/dev/null | awk '/\sroot\s+\// { gsub(";", "", $2); print $2; exit }' || true)"
  if [[ -n "$detected" ]]; then
    echo "$detected"
    return
  fi

  if [[ -d "/var/www/battletoads-double-dragon" ]]; then
    echo "/var/www/battletoads-double-dragon"
    return
  fi

  echo "/var/www/html"
}

NGINX_ROOT="${NGINX_ROOT:-$(detect_nginx_root)}"

echo "[vps-sync] APP_DIR=$APP_DIR"
echo "[vps-sync] BRANCH=$BRANCH"
echo "[vps-sync] FRONTEND_DIR=$FRONTEND_DIR"
echo "[vps-sync] BACKEND_DIR=$BACKEND_DIR"
echo "[vps-sync] BUILD_BACKEND=$BUILD_BACKEND"
echo "[vps-sync] API_SERVICE=${API_SERVICE:-<auto>}"
echo "[vps-sync] NGINX_ROOT=$NGINX_ROOT"

echo "[vps-sync] Fetching and resetting git branch..."
cd "$APP_DIR"
git fetch --prune origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

if [[ "$BUILD_BACKEND" == "1" ]]; then
  echo "[vps-sync] Building backend..."
  cd "$BACKEND_DIR"
  if ! npm ci; then
    echo "[vps-sync] backend npm ci failed, retrying with npm install --legacy-peer-deps"
    npm install --legacy-peer-deps
  fi
  npm run build

  echo "[vps-sync] Restarting backend API service..."
  if [[ -n "$API_SERVICE" ]]; then
    stop_conflicting_api_services "$API_SERVICE"
    systemctl restart "$API_SERVICE"
    systemctl is-active --quiet "$API_SERVICE"
    echo "[vps-sync] $API_SERVICE is active"
  else
    detected_service="$(pick_api_service)"

    if [[ -n "$detected_service" ]]; then
      stop_conflicting_api_services "$detected_service"
      systemctl restart "$detected_service"
      systemctl is-active --quiet "$detected_service"
      echo "[vps-sync] $detected_service is active"
    else
      echo "[vps-sync] WARN: no known backend API service found (btdd-api/battletoads-backend/btdd-backend)"
      echo "[vps-sync] TIP: set API_SERVICE=<your-service>.service when running this script"
    fi
  fi
fi

echo "[vps-sync] Building frontend..."
cd "$FRONTEND_DIR"
if ! npm ci --silent 2>/dev/null; then
  echo "[vps-sync] npm ci failed, retrying with npm install --legacy-peer-deps"
  npm install --legacy-peer-deps
fi
env CI=false npm run build

echo "[vps-sync] Syncing build to nginx root..."
mkdir -p "$NGINX_ROOT"
rm -rf "$NGINX_ROOT"/*
cp -r "$FRONTEND_DIR"/build/* "$NGINX_ROOT"/

echo "[vps-sync] Reloading nginx..."
systemctl restart nginx

echo "[vps-sync] Verifying served bundle hash..."
served_js="$(curl -s http://localhost/ | grep -o 'main\.[a-z0-9]*\.js' | head -1 || true)"
local_js="$(grep -o 'main\.[a-z0-9]*\.js' "$NGINX_ROOT/index.html" | head -1 || true)"

echo "[vps-sync] local index bundle: ${local_js:-<empty>}"
echo "[vps-sync] served bundle: ${served_js:-<empty>}"

if [[ -z "$served_js" || -z "$local_js" || "$served_js" != "$local_js" ]]; then
  echo "[vps-sync] ERROR: served bundle differs from local index bundle"
  exit 1
fi

echo "[vps-sync] OK: frontend is updated and served correctly"

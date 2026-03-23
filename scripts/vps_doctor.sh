#!/usr/bin/env bash
set -euo pipefail
# Disable history expansion so passwords with '!' do not break commands.
set +H

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
API_URL="${API_URL:-http://127.0.0.1}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SYNC_FRONTEND=0
RESET_PASSWORD=""

print_usage() {
  cat <<'USAGE'
Usage:
  bash scripts/vps_doctor.sh [options]

Options:
  --app-dir <path>         App directory (default: /opt/battletoads-double-dragon)
  --api-url <url>          API base URL (default: http://127.0.0.1)
  --admin-password <pass>  Dashboard admin password for Bearer auth checks
  --ask-password           Prompt for password (hidden input)
  --sync-frontend          If build/served bundle mismatch, rsync build to nginx root and reload nginx
  --reset-password <pass>  Reset backend/.auth-password.json and restart btdd-api
  -h, --help               Show help

Examples:
  bash scripts/vps_doctor.sh --ask-password
  bash scripts/vps_doctor.sh --admin-password 'StrongPass123' --sync-frontend
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --admin-password)
      ADMIN_PASSWORD="$2"
      shift 2
      ;;
    --ask-password)
      read -r -s -p "Admin password: " ADMIN_PASSWORD
      echo
      shift
      ;;
    --sync-frontend)
      SYNC_FRONTEND=1
      shift
      ;;
    --reset-password)
      RESET_PASSWORD="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "Missing command: curl" >&2; exit 1; }
command -v grep >/dev/null 2>&1 || { echo "Missing command: grep" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "Missing command: systemctl" >&2; exit 1; }
command -v nginx >/dev/null 2>&1 || { echo "Missing command: nginx" >&2; exit 1; }

if [[ ! -d "$APP_DIR" ]]; then
  echo "App directory not found: $APP_DIR" >&2
  exit 1
fi

TS="$(date +%F_%H%M%S)"
LOG="/tmp/btdd_diag_${TS}.log"
TMP_HDR="/tmp/btdd_hdr_${TS}.txt"
TMP_BODY="/tmp/btdd_body_${TS}.json"

exec > >(tee -a "$LOG") 2>&1

echo "=== BTDD Doctor ==="
echo "app_dir=$APP_DIR"
echo "api_url=$API_URL"
echo "time=$(date -Is)"

echo
echo "=== services ==="
systemctl is-active btdd-api btdd-runtime btdd-research || true

echo
echo "=== btdd-api status (last lines) ==="
systemctl status --no-pager --lines=20 btdd-api | sed -n '1,40p' || true

echo
echo "=== frontend bundle check ==="
BUILD_JS=""
if [[ -f "$APP_DIR/frontend/build/asset-manifest.json" ]]; then
  BUILD_JS="$(grep -oE 'main\.[^"]+\.js' "$APP_DIR/frontend/build/asset-manifest.json" | head -n1 || true)"
fi
SERVED_JS="$(curl -sS "$API_URL/" | grep -oE 'main\.[^"]+\.js' | head -n1 || true)"
echo "build_js=${BUILD_JS:-<missing>}"
echo "served_js=${SERVED_JS:-<missing>}"

echo
echo "=== nginx root/server_name ==="
nginx -T 2>&1 | grep -nE 'server_name|root ' | head -n 120 || true

if [[ -n "$RESET_PASSWORD" ]]; then
  echo
  echo "=== reset dashboard password ==="
  cd "$APP_DIR/backend"
  node -e "const fs=require('fs'); const bcrypt=require('bcrypt'); const pass=process.argv[1]; const p='.auth-password.json'; fs.writeFileSync(p, JSON.stringify({passwordHash:bcrypt.hashSync(pass,10),updatedAt:new Date().toISOString()}, null, 2)+'\\n'); console.log('updated',p);" "$RESET_PASSWORD"
  systemctl restart btdd-api
  sleep 1
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$RESET_PASSWORD"
  fi
fi

echo
echo "=== api summary auth check ==="
curl -sS -o /dev/null -w 'unauth_http=%{http_code}\n' "$API_URL/api/strategies/BTDD_D1/summary?limit=50&offset=0&runtimeOnly=1" || true
if [[ -n "$ADMIN_PASSWORD" ]]; then
  curl -sS -D "$TMP_HDR" -o "$TMP_BODY" -H "Authorization: Bearer $ADMIN_PASSWORD" "$API_URL/api/strategies/BTDD_D1/summary?limit=50&offset=0&runtimeOnly=1" || true
  grep -iE '^HTTP/|^x-total-count:|^www-authenticate:' "$TMP_HDR" || true
  head -c 300 "$TMP_BODY" || true
  echo
else
  echo "admin password not provided; skipping authorized summary check"
fi

echo
echo "=== db path detect ==="
resolve_db_path() {
  local p
  if [[ -f "$APP_DIR/.env" ]]; then
    p="$(sed -n 's/^DB_FILE=//p' "$APP_DIR/.env" | head -n1 || true)"
    if [[ -n "$p" ]]; then
      echo "$p"
      return 0
    fi
  fi

  if [[ -f "$APP_DIR/backend/.env" ]]; then
    p="$(sed -n 's/^DB_FILE=//p' "$APP_DIR/backend/.env" | head -n1 || true)"
    if [[ -n "$p" ]]; then
      echo "$p"
      return 0
    fi
  fi

  for p in \
    "$APP_DIR/backend/database.db" \
    "$APP_DIR/data/main.db" \
    "$APP_DIR/backend/data/main.db"
  do
    if [[ -f "$p" ]]; then
      echo "$p"
      return 0
    fi
  done

  echo "$APP_DIR/backend/database.db"
}

DB_FILE="$(resolve_db_path)"
echo "db_file=$DB_FILE"
if [[ -f "$DB_FILE" ]]; then
  sqlite3 "$DB_FILE" "
    SELECT 'total',COUNT(*) FROM strategies WHERE api_key_name='BTDD_D1';
    SELECT 'active',COUNT(*) FROM strategies WHERE api_key_name='BTDD_D1' AND is_active=1;
    SELECT 'runtime',COUNT(*) FROM strategies WHERE api_key_name='BTDD_D1' AND COALESCE(is_runtime,0)=1;
    SELECT 'archived',COUNT(*) FROM strategies WHERE api_key_name='BTDD_D1' AND COALESCE(is_archived,0)=1;
  " || true
else
  echo "db_file_missing=1"
fi

if [[ "$SYNC_FRONTEND" == "1" ]]; then
  echo
  echo "=== optional frontend sync ==="
  ROOT="$(nginx -T 2>&1 | awk '$1=="root"{gsub(";", "", $2); print $2; exit}')"
  echo "nginx_root=${ROOT:-<missing>}"
  if [[ -n "$ROOT" && -d "$ROOT" ]]; then
    rsync -a --delete "$APP_DIR/frontend/build/" "$ROOT/"
    systemctl reload nginx
    NEW_SERVED_JS="$(curl -sS "$API_URL/" | grep -oE 'main\.[^"]+\.js' | head -n1 || true)"
    echo "served_js_after_sync=${NEW_SERVED_JS:-<missing>}"
  else
    echo "skip_sync=invalid_nginx_root"
  fi
fi

echo
echo "=== git status ==="
cd "$APP_DIR"
git rev-parse --short HEAD || true
git status --porcelain --untracked-files=no | sed -n '1,40p' || true

echo
echo "diagnostics_log=$LOG"

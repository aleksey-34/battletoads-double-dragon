#!/usr/bin/env bash
set -euo pipefail

echo "[port-fix] before state: $(systemctl is-active btdd-api 2>/dev/null || true)"
echo "[port-fix] listeners on 3001 before"
ss -ltnp | grep ':3001' || true

PIDS="$(ss -ltnp | awk '/:3001/ { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4) } }' | sort -u)"
if [[ -n "$PIDS" ]]; then
  for pid in $PIDS; do
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      echo "[port-fix] killing pid=$pid bound to :3001"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
fi

echo "[port-fix] restart btdd-api"
systemctl restart btdd-api
sleep 2
echo "[port-fix] after state: $(systemctl is-active btdd-api 2>/dev/null || true)"
echo "[port-fix] listeners on 3001 after"
ss -ltnp | grep ':3001' || true

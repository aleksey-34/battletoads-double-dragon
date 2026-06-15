#!/usr/bin/env bash
set -euo pipefail
cd "${APP_DIR:-/opt/battletoads-double-dragon}"
TOKEN="${ADMIN_SWEEP_TOKEN:-btdd_admin_sweep_2026}"
API="${BTDD_API:-http://127.0.0.1:3001}"

while true; do
  st=$(curl -s -H "Authorization: Bearer ${TOKEN}" "${API}/api/research/sweeps/full-historical/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
  if [ "$st" != "running" ]; then
    break
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) waiting for sweep idle..."
  sleep 300
done
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting 1d DD/ZZ sweep"
python3 scripts/vps_start_synth_1d_dd_zz_sweep.py

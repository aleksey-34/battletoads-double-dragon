#!/usr/bin/env bash
# Decorr top-30 → 1d DD/ZZ → wait → stat_arb → wait → CT_Fractal (background on VPS).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
API="${BTDD_API:-http://127.0.0.1:3001}"
TOKEN="${ADMIN_SWEEP_TOKEN:-btdd_admin_sweep_2026}"
LOG="${LOG:-/tmp/synth_1d_pipeline.log}"

cd "$APP_DIR"
export BTDD_REPO="$APP_DIR"
export BTDD_DB_PATH="$APP_DIR/backend/database.db"
export DECORR_INTERVAL="${DECORR_INTERVAL:-1d}"
export DECORR_TOP="${DECORR_TOP:-30}"
export DECORR_LIMIT="${DECORR_LIMIT:-800}"
export SYNTH_SWEEP_MARKET_CAP="${SYNTH_SWEEP_MARKET_CAP:-30}"
export DECORR_MIN_BARS="${DECORR_MIN_BARS:-60}"
export SWEEP_CONCURRENCY="${SWEEP_CONCURRENCY:-5}"

exec >>"$LOG" 2>&1
echo "=== synth 1d pipeline $(date -Is) ==="

wait_for_sweep() {
  local label="$1"
  echo "waiting for ${label} sweep..."
  while true; do
    st="$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/research/sweeps/full-historical/status" || true)"
    status="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('status',''))" "$st" 2>/dev/null || echo running)"
    if [[ "$status" == "done" || "$status" == "failed" || "$status" == "aborted" || "$status" == "" ]]; then
      echo "${label} finished status=$status"
      break
    fi
    pct="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('progress_percent',0))" "$st" 2>/dev/null || echo 0)"
    echo "  ${label} progress ${pct}% status=$status"
    sleep 45
  done
}

echo "[1/4] score decorr pairs top-$DECORR_TOP interval=$DECORR_INTERVAL"
python3 scripts/admin_tools/storefront/score_synth_pair_decorrelation.py --top "$DECORR_TOP"

echo "[2/4] start 1d DD/ZZ sweep"
python3 scripts/vps_start_synth_1d_dd_zz_sweep.py
wait_for_sweep "DD/ZZ"

echo "[3/4] start 1d stat_arb sweep"
python3 scripts/vps_start_synth_1d_stat_arb_sweep.py
wait_for_sweep "stat_arb"

echo "[4/5] start 1d CT_Fractal sweep"
python3 scripts/vps_start_synth_1d_ct_fractal_sweep.py
wait_for_sweep "CT_Fractal"

echo "[5/5] start 1d ZZ_Fast/ZZ_Instance pivot sweep"
python3 scripts/vps_start_synth_1d_zz_pivot_sweep.py
echo "=== pipeline launched ZZ pivot $(date -Is) ==="

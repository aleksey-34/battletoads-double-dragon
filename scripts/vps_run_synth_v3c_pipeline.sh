#!/usr/bin/env bash
# v3c: expanded decorr universe → CT_Fractal sweep → ZZ pivot sweep (sequential).
set -euo pipefail
REPO="${BTDD_REPO:-/opt/battletoads-double-dragon}"
cd "$REPO"
export SYNTH_SWEEP_MARKET_CAP="${SYNTH_SWEEP_MARKET_CAP:-45}"
export DECORR_SCORES_JSON="$REPO/results/synth_pair_decorrelation_latest.json"

echo "=== [1/3] decorr score (optional refresh) ==="
python3 scripts/admin_tools/storefront/score_synth_pair_decorrelation.py || true

echo "=== [2/3] CT_Fractal 1d sweep (markets cap=$SYNTH_SWEEP_MARKET_CAP) ==="
python3 scripts/vps_start_synth_1d_ct_fractal_sweep.py

echo "=== waiting for CT sweep ==="
for i in $(seq 1 360); do
  st=$(curl -sS -H "Authorization: Bearer ${ADMIN_SWEEP_TOKEN:-btdd_admin_sweep_2026}" \
    "http://127.0.0.1:3001/api/research/sweeps/full-historical/status" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('running') or 'idle')" 2>/dev/null || echo idle)
  if [[ "$st" == "False" || "$st" == "idle" || "$st" == "None" ]]; then
    break
  fi
  sleep 60
done

echo "=== [3/3] ZZ pivot 1d sweep ==="
python3 scripts/vps_start_synth_1d_zz_pivot_sweep.py
echo "v3c pipeline sweeps started/completed — rebuild card: build_union_synth_heavy_jun2026.py --v3c --apply --publish"

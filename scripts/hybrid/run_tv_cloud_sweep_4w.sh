#!/usr/bin/env bash
# TV momentum cloud: VPS 15m export → download → local 4-worker sweep → rank → card
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$REPO_ROOT/results/tv_momentum_cloud"
VPS="${BTDD_VPS:-root@176.57.184.98}"
VPS_REPO="${BTDD_VPS_REPO:-/opt/battletoads-double-dragon}"
CONFIG="$REPO_ROOT/scripts/hybrid/configs/tv_momentum_cloud_15m_jul2026.json"
BUNDLE="$REPO_ROOT/results/hybrid_candle_bundle_15m"
WORKERS="${HYBRID_SWEEP_WORKERS:-4}"

need_export=0
if [[ ! -f "$BUNDLE/15m/SUIUSDT.json" ]] || [[ "$(ls "$BUNDLE/15m" 2>/dev/null | wc -l)" -lt 40 ]]; then
  need_export=1
fi

if [[ "$need_export" -eq 1 ]]; then
  echo "=== export 15m TV cloud on VPS ==="
  ssh "$VPS" "mkdir -p $VPS_REPO/scripts/hybrid/configs"
  scp -q "$CONFIG" "$VPS:$VPS_REPO/scripts/hybrid/configs/tv_momentum_cloud_15m_jul2026.json"
  ssh "$VPS" "cd $VPS_REPO/backend && test -f dist/research/hybridExportCandlesEntry.js || npm run build --silent"
  ssh "$VPS" "rm -rf $VPS_REPO/results/hybrid_candle_bundle_15m && mkdir -p $VPS_REPO/results"
  ssh "$VPS" "cd $VPS_REPO/backend && HYBRID_CANDLE_DIR=$VPS_REPO/results/hybrid_candle_bundle_15m \
    HYBRID_EXPORT_CONCURRENCY=6 node dist/research/hybridExportCandlesEntry.js \
    $VPS_REPO/scripts/hybrid/configs/tv_momentum_cloud_15m_jul2026.json 2>&1 | tail -25"

  echo "=== download bundle ==="
  ssh "$VPS" "tar -czf /tmp/hybrid_candle_bundle_15m.tgz -C $VPS_REPO/results hybrid_candle_bundle_15m"
  scp -q "$VPS:/tmp/hybrid_candle_bundle_15m.tgz" "$REPO_ROOT/results/"
  rm -rf "$BUNDLE"
  tar -xzf "$REPO_ROOT/results/hybrid_candle_bundle_15m.tgz" -C "$REPO_ROOT/results/"
fi

echo "15m symbols: $(ls "$BUNDLE/15m" 2>/dev/null | wc -l)"

cd "$REPO_ROOT/backend"
npm run build --silent 2>/dev/null || npm run build

export HYBRID_CANDLE_DIR="$BUNDLE"
export HYBRID_SWEEP_WORKERS="$WORKERS"
export HYBRID_WORKER_MEM_MB="${HYBRID_WORKER_MEM_MB:-768}"
export DATE_TO="${DATE_TO:-2026-07-04}"

echo "=== sweep ($WORKERS workers) ==="
node "$REPO_ROOT/scripts/hybrid/sweep_tv_momentum_cloud.mjs"

echo "=== rank + lot/OP grid ==="
python3 "$REPO_ROOT/scripts/hybrid/rank_tv_momentum_cloud_jul2026.py"

if [[ "${PUBLISH:-0}" == "1" ]]; then
  echo "=== publish card on VPS API ==="
  BTDD_API="${BTDD_API:-http://127.0.0.1:3001}" PUBLISH=1 \
    python3 "$REPO_ROOT/scripts/hybrid/build_tv_cloud_spread_card_jul2026.py"
fi

echo "=== done ==="

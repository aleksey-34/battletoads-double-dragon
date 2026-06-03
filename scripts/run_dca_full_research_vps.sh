#!/usr/bin/env bash
# Full-period DCA grid research on VPS (TS card depth: 2024-06-01 → 2026-06-03).
# Usage:
#   BTDD_DCA_KEY=artursk-xxx-api ./scripts/run_dca_full_research_vps.sh
#   tail -f /opt/battletoads-double-dragon/logs/dca_full_research_latest.log
set -euo pipefail

ROOT="${BTDD_ROOT:-/opt/battletoads-double-dragon}"
cd "$ROOT/backend"

API_KEY="${BTDD_DCA_KEY:-BTDD_D1}"
DCA_FROM="${DCA_FROM:-2024-06-01}"
DCA_TO="${DCA_TO:-2026-06-03}"
DCA_DEPOSIT="${DCA_DEPOSIT:-1000}"
DCA_MARKETS="${DCA_MARKETS:-SUIUSDT,TRXUSDT,DOGEUSDT,WIFUSDT,PEPEUSDT,BNBUSDT}"

mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/dca_full_research_latest.log"
STAMP_LOG="$ROOT/logs/dca_full_research_$(date +%Y%m%d_%H%M%S).log"

export BTDD_DCA_KEY="$API_KEY"
export DCA_FROM DCA_TO DCA_DEPOSIT DCA_MARKETS

echo "Starting DCA full research: $DCA_FROM → $DCA_TO key=$API_KEY markets=$DCA_MARKETS"
echo "Log: $LOG (also $STAMP_LOG)"

nohup env BTDD_DCA_KEY="$API_KEY" DCA_FROM="$DCA_FROM" DCA_TO="$DCA_TO" \
  DCA_DEPOSIT="$DCA_DEPOSIT" DCA_MARKETS="$DCA_MARKETS" \
  node --max-old-space-size=3072 ../scripts/research_dca_grid_density.mjs \
  > >(tee -a "$LOG" "$STAMP_LOG") 2>&1 &
echo $! > "$ROOT/logs/dca_full_research.pid"
echo "PID $(cat "$ROOT/logs/dca_full_research.pid") — monitor: tail -f $LOG"

#!/usr/bin/env bash
# EP4 burst research: Phase 0 wick + TV momentum + Phase 1 DB momentum
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export BTDD_API="${BTDD_API:-http://127.0.0.1:3001}"
export OUT_DIR="${OUT_DIR:-$ROOT/results/ep4_burst_research}"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/run.log"
echo "=== ep4 burst research $(date -Iseconds) ===" | tee "$LOG"
python3 "$ROOT/scripts/hybrid/research_ep4_burst_addon_jul2026.py" 2>&1 | tee -a "$LOG"
echo "Done. See $OUT_DIR/ep4_burst_addon_research_jul2026.json" | tee -a "$LOG"

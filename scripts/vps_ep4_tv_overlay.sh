#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BTDD_API="${BTDD_API:-http://127.0.0.1:3001}"
export OUT_DIR="${OUT_DIR:-$ROOT/results/ep4_burst_research}"
mkdir -p "$OUT_DIR"
python3 "$ROOT/scripts/hybrid/research_ep4_tv_overlay_jul2026.py" 2>&1 | tee "$OUT_DIR/tv_overlay_run.log"

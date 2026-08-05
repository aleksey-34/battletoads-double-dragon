#!/usr/bin/env bash
# Export hybrid candles for ALGOFUND portfolio books (B3 + MRS + stocks).
# Safe: read-only for trading; writes under HYBRID_CANDLE_DIR only.
#
# Usage (VPS):
#   cd /opt/battletoads-double-dragon/backend
#   export HYBRID_CANDLE_DIR=/opt/battletoads-double-dragon/results/hybrid_candle_bundle
#   bash ../scripts/hybrid/export_portfolio_books_candles.sh
#
# Optional:
#   DATE_FROM=2024-06-01 DATE_TO=2026-08-05 bash ../scripts/hybrid/export_portfolio_books_candles.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="${1:-$ROOT/scripts/hybrid/configs/portfolio_books_candles_export.json}"
BUNDLE="${HYBRID_CANDLE_DIR:-$ROOT/results/hybrid_candle_bundle}"
ENTRY="$ROOT/backend/dist/research/hybridExportCandlesEntry.js"

if [[ ! -f "$CFG" ]]; then
  echo "Missing config: $CFG" >&2
  exit 2
fi

mkdir -p "$BUNDLE"

# Rebuild entry if missing / stale relative to sources (best-effort).
if [[ ! -f "$ENTRY" ]]; then
  echo "[export] building backend dist…"
  (cd "$ROOT/backend" && npm run build)
fi

TMP_CFG="$(mktemp)"
python3 - "$CFG" "$TMP_CFG" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    cfg = json.load(f)
if os.environ.get("DATE_FROM"):
    cfg["dateFrom"] = os.environ["DATE_FROM"]
if os.environ.get("DATE_TO"):
    cfg["dateTo"] = os.environ["DATE_TO"] or None
with open(dst, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
print(f"intervals={cfg.get('intervals')} monos={len(cfg.get('monoMarkets') or [])} synths={len(cfg.get('synthMarkets') or [])} from={cfg.get('dateFrom')} to={cfg.get('dateTo')}")
PY

echo "[export] HYBRID_CANDLE_DIR=$BUNDLE"
echo "[export] config=$TMP_CFG"
cd "$ROOT/backend"
HYBRID_CANDLE_DIR="$BUNDLE" node "$ENTRY" "$TMP_CFG"
rm -f "$TMP_CFG"
echo "[export] done → $BUNDLE"
echo "[export] next: admin UI «Проверить свечи» or POST /api/saas/admin/portfolio-bt/coverage"

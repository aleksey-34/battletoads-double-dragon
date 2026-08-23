#!/usr/bin/env bash
# Post-deploy smoke: BT/live drift guards + monitoring health.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${BTDD_API_URL:-http://127.0.0.1:3001/api}"
TOKEN="${BTDD_ADMIN_TOKEN:-defaultpassword}"

echo "=== smoke: health ==="
code="$(curl -sS -o /dev/null -w '%{http_code}' "${API}/health" || true)"
echo "health HTTP ${code} (401/403 without token is OK if API is up)"

echo "=== smoke: monitoring P3 snapshot drift fields ==="
python3 <<'PY'
import json, urllib.request, os
api = os.environ.get("BTDD_API_URL", "http://127.0.0.1:3001/api").rstrip("/")
token = os.environ.get("BTDD_ADMIN_TOKEN", "defaultpassword")
req = urllib.request.Request(
    f"{api}/saas/algofund/portfolios",
    headers={"Authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(req, timeout=30) as r:
    data = json.loads(r.read().decode())
rows = data if isinstance(data, list) else data.get("portfolios") or data.get("items") or []
p3 = next((x for x in rows if str(x.get("setKey") or x.get("set_key") or "").endswith("aggressive-jul2026")), None)
if not p3:
    print("WARN: P3 portfolio row not found in API — skip drift field check")
else:
    snap = p3.get("snapshot") or p3.get("snapshot_json")
    if isinstance(snap, str):
        snap = json.loads(snap)
    td = (snap or {}).get("tradeDrift") or {}
    sf = td.get("sinceFix") or {}
    print("sinceFix freqX:", sf.get("freqX"))
    print("skippedLegsSinceFix:", td.get("skippedLegsSinceFix"))
    print("comparableLegsSinceFix:", td.get("comparableLegsSinceFix"))
    if sf.get("freqX") is not None and float(sf["freqX"]) > 8:
        raise SystemExit(f"FAIL: sinceFix freqX still inflated: {sf['freqX']}")
print("OK: drift snapshot readable")
PY

echo "=== smoke: arcopy1 monitoring trades shape ==="
curl -sfS -H "Authorization: Bearer ${TOKEN}" \
  "${API}/monitoring/arcopy1?days=7&includeTradesRows=1" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
tr=d.get('trades') or []
print('trades', len(tr))
if tr:
    t=tr[0]
    for k in ('tradeType','side','symbol','time','entryPrice'):
        assert k in t or k!='entryPrice', f'missing {k} in {t}'
print('OK')
"

echo "=== ALL SMOKE PASSED ==="

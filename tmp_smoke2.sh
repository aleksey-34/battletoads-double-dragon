#!/bin/bash
# Full smoke test: API + tunnel + frontend routes
AUTH="Authorization: Bearer SuperSecure2026Admin!"
BASE="http://localhost:3001/api"
echo "=== API ADMIN ENDPOINTS ==="
for ep in api-keys logs admin/docs system/update/status \
  "strategies/BTDD_M1" "strategies/BTDD_M1/summary" \
  "trading-systems/BTDD_M1" "trading-systems/BTDD_D1" \
  "positions/BTDD_M1" "positions/BTDD_D1" \
  "balances/BTDD_M1" "orders/BTDD_M1" \
  "monitoring/BTDD_M1" "key-status/BTDD_M1" \
  "risk-settings/BTDD_M1" "symbols/BTDD_M1" \
  "backtest/runs" \
  "strategies/HDB_14" "positions/HDB_14"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE/$ep")
  echo "  $ep: $CODE"
done

echo ""
echo "=== API CLIENT ENDPOINTS ==="
for ep in auth/recovery/status auth/client/me; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$ep")
  echo "  $ep: $CODE"
done

echo ""
echo "=== FRONTEND ROUTES (via nginx) ==="
for path in / /login /dashboard /settings /positions /logs /saas /research /admin-docs \
  /client/login /client/register /cabinet /landing /whitepaper; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost$path")
  echo "  $path: $CODE"
done

echo ""
echo "=== STATIC ASSETS ==="
for asset in /favicon.svg /manifest.json /whitepaper.html /whitepaper-ru.html /whitepaper-tr.html; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost$asset")
  echo "  $asset: $CODE"
done

TUNNEL_URL=$(journalctl -u cloudflared-tunnel --no-pager -n 50 2>/dev/null | grep -o 'https://[^ ]*trycloudflare.com' | tail -1)
echo ""
echo "=== TUNNEL: $TUNNEL_URL ==="
if [ -n "$TUNNEL_URL" ]; then
  for path in / /login /dashboard /api/api-keys; do
    if [ "$path" = "/api/api-keys" ]; then
      CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$TUNNEL_URL$path" --max-time 10)
    else
      CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL$path" --max-time 10)
    fi
    echo "  $path: $CODE"
  done
fi

echo ""
echo "=== DONE ==="

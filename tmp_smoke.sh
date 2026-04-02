#!/bin/bash
AUTH="Authorization: Bearer SuperSecure2026Admin!"
for ep in api-keys logs admin/docs system/update/status \
  "strategies/BTDD_M1" "trading-systems/BTDD_M1" "positions/BTDD_M1" \
  "balances/BTDD_M1" "orders/BTDD_M1" "monitoring/BTDD_M1" \
  "key-status/BTDD_M1" "risk-settings/BTDD_M1" "symbols/BTDD_M1" \
  "strategies/BTDD_D1" "trading-systems/BTDD_D1" "positions/BTDD_D1" \
  "strategies/HDB_14" "positions/HDB_14" \
  "auth/recovery/status"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "http://localhost:3001/api/$ep")
  echo "$ep: $CODE"
done

echo "---TUNNEL---"
TUNNEL_URL=$(journalctl -u cloudflared-tunnel --no-pager -n 50 2>/dev/null | grep -o 'https://[^ ]*trycloudflare.com' | tail -1)
echo "Tunnel: $TUNNEL_URL"
if [ -n "$TUNNEL_URL" ]; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/" --max-time 10)
  echo "Tunnel landing: $CODE"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$TUNNEL_URL/api/api-keys" --max-time 10)
  echo "Tunnel api-keys: $CODE"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/whitepaper.html" --max-time 10)
  echo "Tunnel whitepaper-en: $CODE"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/whitepaper-ru.html" --max-time 10)
  echo "Tunnel whitepaper-ru: $CODE"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/whitepaper-tr.html" --max-time 10)
  echo "Tunnel whitepaper-tr: $CODE"
fi

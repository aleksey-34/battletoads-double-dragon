#!/usr/bin/env bash
set -euo pipefail

API="http://127.0.0.1:3001/api"
AUTH="Authorization: Bearer SuperSecure2026Admin!"
CT="Content-Type: application/json"
API_KEY_NAME="BTDD_D1"
TS_ID=25
ORIGINAL_NAME="ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v"

echo "=== RESTORE TRADING SYSTEM ==="
curl -s -X PATCH "$API/admin/trading-systems/$TS_ID" \
  -H "$AUTH" \
  -H "$CT" \
  --data-raw "{
    \"apiKeyName\": \"$API_KEY_NAME\",
    \"name\": \"$ORIGINAL_NAME\",
    \"description\": \"Restored from archive\",
    \"auto_sync_members\": false,
    \"discovery_enabled\": false
  }"
echo

echo "=== ACTIVATE TRADING SYSTEM ==="
curl -s -X PATCH "$API/admin/trading-systems/$TS_ID/activation" \
  -H "$AUTH" \
  -H "$CT" \
  --data-raw "{
    \"apiKeyName\": \"$API_KEY_NAME\",
    \"isActive\": true,
    \"syncMembers\": true
  }"
echo

echo "=== RECONNECT CLIENTS TO RESTORED SYSTEM ==="
curl -s -X POST "$API/saas/admin/algofund-batch-actions" \
  -H "$AUTH" \
  -H "$CT" \
  --data-raw "{
    \"tenantIds\": [1288, 41003, 43430],
    \"requestType\": \"switch_system\",
    \"targetSystemId\": $TS_ID,
    \"targetSystemName\": \"$ORIGINAL_NAME\",
    \"note\": \"Restore from archive and reconnect\",
    \"directExecute\": true
  }"
echo

echo "Complete!"

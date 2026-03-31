#!/usr/bin/env bash
set -euo pipefail

API="http://127.0.0.1:3001/api/saas/admin/algofund-batch-actions"
AUTH="Authorization: Bearer SuperSecure2026Admin!"
CT="Content-Type: application/json"

echo "=== DIAG STOP 41003 ==="
curl -s -X POST "$API" \
  -H "$AUTH" \
  -H "$CT" \
  --data-raw '{"tenantIds":[41003],"requestType":"stop","note":"diag stop failure check","directExecute":true}'
echo

echo "=== RECONNECT 1288/41003/43430 TO h6e6sh ==="
curl -s -X POST "$API" \
  -H "$AUTH" \
  -H "$CT" \
  --data-raw '{"tenantIds":[1288,41003,43430],"requestType":"switch_system","targetSystemId":31,"targetSystemName":"ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh","note":"manual reconnect after storefront remove","directExecute":true}'
echo

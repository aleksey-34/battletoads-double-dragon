#!/usr/bin/env bash
set -euo pipefail

BASE="http://127.0.0.1:3001"
AUTH="Authorization: Bearer SuperSecure2026Admin!"

curl -sS -X POST "$BASE/api/saas/admin/algofund-batch-actions" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantIds": [41170, 41232],
    "requestType": "switch_system",
    "note": "Apply storefront TS to Ruslan/Ali after switch_system runtime fix",
    "targetSystemId": 31,
    "targetSystemName": "ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh",
    "directExecute": true
  }'

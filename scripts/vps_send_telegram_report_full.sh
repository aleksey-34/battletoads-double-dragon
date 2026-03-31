#!/usr/bin/env bash
set -euo pipefail
curl -s -X POST "http://127.0.0.1:3001/api/saas/admin/reports/send-telegram" \
  -H "Authorization: Bearer SuperSecure2026Admin!" \
  -H "Content-Type: application/json" \
  --data '{"format":"full"}'

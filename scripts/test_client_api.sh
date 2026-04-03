#!/bin/bash
set -e

# Generate magic link
RESP=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/41003/magic-link)
TOKEN=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
echo "TOKEN=$TOKEN"

# Login with magic token
SESS=$(curl -s -X POST http://localhost:3001/api/auth/client/magic-login \
  -H 'Content-Type: application/json' \
  -d '{"token":"'"$TOKEN"'"}')
echo "SESS=$SESS"

SESSION_TOKEN=$(echo "$SESS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
echo "SESSION_TOKEN=$SESSION_TOKEN"

# Now call algofund state
echo "=== ALGOFUND STATE ==="
curl -s "http://localhost:3001/api/client/algofund/state" \
  -H "Authorization: Bearer $SESSION_TOKEN" | python3 -m json.tool 2>&1 | head -60

echo ""
echo "=== WORKSPACE ==="
curl -s "http://localhost:3001/api/client/workspace" \
  -H "Authorization: Bearer $SESSION_TOKEN" | python3 -m json.tool 2>&1 | head -60

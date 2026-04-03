#!/bin/bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/41003/magic-link 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
echo "Token: $TOKEN"

echo ""
echo "=== Magic login response ==="
curl -s -v -c /tmp/client_cookies.txt -X POST "http://localhost:3001/api/auth/client/magic-login" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}" 2>&1 | grep -E 'Set-Cookie|HTTP|{|client_session'

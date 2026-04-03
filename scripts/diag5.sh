#!/bin/bash
# Full workspace diagnostic
TOKEN=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/41003/magic-link 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
echo "Token: ${TOKEN:0:20}..."

# Login and capture full cookie header
RESP=$(curl -s -v -X POST "http://localhost:3001/api/auth/client/magic-login" -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" 2>&1)
COOKIE=$(echo "$RESP" | grep -oP 'client_session=[^;]+' | head -1)
echo "Cookie: ${COOKIE:0:30}..."

echo ""
echo "=== Workspace raw (first 500 chars) ==="
curl -s "http://localhost:3001/api/client/workspace" -H "Cookie: $COOKIE" 2>/dev/null | head -c 500
echo ""

echo ""
echo "=== Algofund state raw (first 500 chars) ==="
curl -s "http://localhost:3001/api/client/algofund/state" -H "Cookie: $COOKIE" 2>/dev/null | head -c 500
echo ""

echo ""
echo "=== Algofund available systems count ==="
curl -s "http://localhost:3001/api/client/algofund/state" -H "Cookie: $COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    print("ERROR:", d["error"])
else:
    state = d.get("state", d)
    systems = state.get("availableSystems", [])
    print("Systems:", len(systems))
    for s in systems[:3]:
        print("  ", s.get("name"), s.get("isActive"), s.get("memberCount"))
    profile = state.get("profile", {})
    print("Profile:", profile)
'

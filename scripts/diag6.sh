#!/bin/bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/41003/magic-link 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

# Login and save cookie jar
curl -s -c /tmp/client_cookies.txt -X POST "http://localhost:3001/api/auth/client/magic-login" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\"}" > /dev/null

echo "=== Cookie jar ==="
cat /tmp/client_cookies.txt

echo ""
echo "=== Workspace ==="
curl -s -b /tmp/client_cookies.txt "http://localhost:3001/api/client/workspace" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    print("ERROR:", d["error"])
    sys.exit(0)
print("productMode:", d.get("productMode"))
af = d.get("algofundState") or {}
systems = af.get("availableSystems", [])
print("availableSystems:", len(systems))
for s in systems[:3]:
    print("  ", s.get("name"), "active="+str(s.get("isActive")), "members="+str(s.get("memberCount",0)))
    m = s.get("metrics")
    if m: print("    metrics:", m)
preview = af.get("preview", {})
print("preview equityCurve:", len(preview.get("equityCurve", [])))
print("profile:", af.get("profile", {}))

ss = d.get("strategyState") or {}
offers = ss.get("offers", [])
print("strategy offers:", len(offers))
'

echo ""
echo "=== Monitoring ==="
curl -s -b /tmp/client_cookies.txt "http://localhost:3001/api/client/monitoring" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    print("ERROR:", d["error"])
    sys.exit(0)
pts = d.get("points", [])
print("points:", len(pts))
print("latest:", d.get("latest"))
print("apiKeyName:", d.get("apiKeyName"))
'

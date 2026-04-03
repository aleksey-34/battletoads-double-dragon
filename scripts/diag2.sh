#!/bin/bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/41003/magic-link 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
COOKIE=$(curl -s -c - -X POST "http://localhost:3001/api/auth/client/magic-login" -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" 2>/dev/null | grep client_session | awk '{print $NF}')

echo "=== Algofund available systems ==="
curl -s "http://localhost:3001/api/client/algofund/state" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
state = d.get("state", d)
systems = state.get("availableSystems", [])
print("Total systems:", len(systems))
for s in systems:
    name = s["name"]
    active = s.get("isActive")
    mc = s.get("memberCount", 0)
    m = s.get("metrics")
    mstr = str(m) if m else "None"
    print("  ", name, "active="+str(active), "members="+str(mc), "metrics="+mstr)
preview = state.get("preview", {})
eq = preview.get("equityCurve", [])
print("Preview equityCurve points:", len(eq))
print("Preview summary:", preview.get("summary"))
profile = state.get("profile", {})
print("published_system_name:", profile.get("published_system_name"))
print("actual_enabled:", profile.get("actual_enabled"))
'

echo ""
echo "=== Strategy offers ==="
curl -s "http://localhost:3001/api/client/strategy/state" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
state = d.get("state", d)
offers = state.get("offers", [])
print("Total offers:", len(offers))
for o in offers[:5]:
    ep = o.get("equityPoints", [])
    print("  ", o.get("offerId"), o.get("titleRu"), "equity_pts="+str(len(ep)))
'

echo ""
echo "=== Monitoring ==="
curl -s "http://localhost:3001/api/client/monitoring" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
pts = d.get("points", [])
print("points:", len(pts))
print("latest:", d.get("latest"))
print("apiKeyName:", d.get("apiKeyName"))
print("streams:", d.get("streams"))
'

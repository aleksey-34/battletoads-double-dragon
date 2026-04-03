#!/bin/bash
# Check with active algofund client
TOKEN=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/1288/magic-link 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
COOKIE=$(curl -s -c - -X POST "http://localhost:3001/api/auth/client/magic-login" -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" 2>/dev/null | grep client_session | awk '{print $NF}')
echo "Tenant 1288 (Mehmet)"

echo "=== Algofund systems ==="
curl -s "http://localhost:3001/api/client/algofund/state" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
state = d.get("state", d)
systems = state.get("availableSystems", [])
print("Systems:", len(systems))
for s in systems:
    name = s["name"]
    print("  ", name, "active="+str(s.get("isActive")), "members="+str(s.get("memberCount",0)))
    m = s.get("metrics")
    if m:
        print("    equityUsd="+str(m.get("equityUsd")), "dd="+str(m.get("drawdownPercent")))
preview = state.get("preview", {})
print("Preview eq pts:", len(preview.get("equityCurve", [])))
print("Preview summary:", preview.get("summary"))
profile = state.get("profile", {})
print("published:", profile.get("published_system_name"))
print("enabled:", profile.get("actual_enabled"))
'

echo ""
echo "=== Monitoring ==="
curl -s "http://localhost:3001/api/client/monitoring" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
pts = d.get("points", [])
print("points:", len(pts))
if pts:
    print("first:", pts[0])
    print("last:", pts[-1])
print("latest:", d.get("latest"))
'

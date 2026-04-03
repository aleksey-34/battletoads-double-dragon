#!/bin/bash
# Diagnose client cabinet data issues

echo "=== 1. Get magic link for tenant 41003 ==="
TOKEN=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/41003/magic-link 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
echo "Token: ${TOKEN:0:16}..."

echo ""
echo "=== 2. Login ==="
COOKIE=$(curl -s -c - -X POST "http://localhost:3001/api/auth/client/magic-login" -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" 2>/dev/null | grep client_session | awk '{print $NF}')
echo "Cookie: ${COOKIE:0:16}..."

echo ""
echo "=== 3. Algofund state - availableSystems ==="
curl -s "http://localhost:3001/api/client/algofund/state" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
state = d.get("state", d)
systems = state.get("availableSystems", [])
print(f"Total systems: {len(systems)}")
for s in systems:
    print(f"  name={s[\"name\"]}")
    print(f"    active={s.get(\"isActive\")} members={s.get(\"memberCount\",0)}")
    m = s.get("metrics")
    if m:
        print(f"    metrics: equity={m.get(\"equityUsd\")} dd={m.get(\"drawdownPercent\")} margin={m.get(\"marginLoadPercent\")}")
    else:
        print(f"    metrics: None")
print()
preview = state.get("preview", {})
eq = preview.get("equityCurve", [])
print(f"Preview equityCurve points: {len(eq)}")
summary = preview.get("summary", {})
print(f"Preview summary: {summary}")
profile = state.get("profile", {})
print(f"Profile published_system_name: {profile.get(\"published_system_name\")}")
print(f"Profile actual_enabled: {profile.get(\"actual_enabled\")}")
'

echo ""
echo "=== 4. Strategy state - offers ==="
curl -s "http://localhost:3001/api/client/strategy/state" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
state = d.get("state", d)
offers = state.get("offers", [])
print(f"Total offers: {len(offers)}")
for o in offers[:5]:
    ep = o.get("equityPoints", [])
    print(f"  {o.get(\"offerId\")}: {o.get(\"titleRu\")} equity_pts={len(ep)}")
'

echo ""
echo "=== 5. Monitoring ==="
curl -s "http://localhost:3001/api/client/monitoring" -b "client_session=$COOKIE" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
pts = d.get("points", [])
print(f"Monitoring points: {len(pts)}")
if pts:
    print(f"  First: {pts[0]}")
    print(f"  Last: {pts[-1]}")
latest = d.get("latest")
print(f"Latest: {latest}")
'

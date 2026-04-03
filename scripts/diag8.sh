#!/bin/bash
# Get magic link token
MAGIC=$(curl -s -X POST http://localhost:3001/api/saas/admin/tenants/41003/magic-link 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

# Login - response contains bearer token
BEARER=$(curl -s -X POST "http://localhost:3001/api/auth/client/magic-login" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$MAGIC\"}" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
echo "Bearer: ${BEARER:0:20}..."

AUTH="Authorization: Bearer $BEARER"

echo ""
echo "=== Workspace ==="
curl -s "http://localhost:3001/api/client/workspace" -H "$AUTH" 2>/dev/null | python3 -c '
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
    name = s.get("name","?")
    active = s.get("isActive")
    mc = s.get("memberCount",0)
    m = s.get("metrics")
    print("  ", name, "active="+str(active), "members="+str(mc))
    if m: print("    metrics:", m)
preview = af.get("preview", {})
print("preview equityCurve:", len(preview.get("equityCurve", [])))
print("preview summary:", preview.get("summary"))
prof = af.get("profile")
print("profile:", prof)

ss = d.get("strategyState") or {}
offers = ss.get("offers", [])
print("strategy offers:", len(offers))
for o in offers[:3]:
    ep = o.get("equityPoints", [])
    print("  ", o.get("offerId"), o.get("titleRu"), "eq_pts="+str(len(ep)))
'

echo ""
echo "=== Monitoring ==="
curl -s "http://localhost:3001/api/client/monitoring" -H "$AUTH" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    print("ERROR:", d["error"])
    sys.exit(0)
pts = d.get("points", [])
print("points:", len(pts))
print("latest:", d.get("latest"))
print("apiKeyName:", d.get("apiKeyName"))
streams = d.get("streams", {})
for k,v in (streams or {}).items():
    print("stream", k, "apiKeyName="+str(v.get("apiKeyName")), "points="+str(len(v.get("points",[]))))
'

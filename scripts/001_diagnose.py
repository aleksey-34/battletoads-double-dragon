#!/usr/bin/env python3
import urllib.request, json, os

BASE = os.environ.get("API_BASE", "http://localhost:3001")
HEADERS = {"Content-Type": "application/json"}

def api(path):
    req = urllib.request.Request(f"{BASE}{path}", headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

def banner(s):
    print(f"\n{"="*60}\n  {s}\n{"="*60}")

banner("Health")
h = api("/api/healthz")
print("API:", "OK" if not h.get("error") else f"FAIL: {h}")

banner("All Tenants")
tenants = api("/api/saas/admin/tenants")
if not isinstance(tenants, list):
    print("FAILED:", tenants)
    exit(1)
print(f"Total: {len(tenants)}")
for t in tenants:
    print(f"  [{t["id"]}] {t.get("display_name","-")} slug={t.get("slug","-")} tg={t.get("telegram_id","-")} status={t.get("status","-")} key={t.get("assigned_api_key_name","-")}")

banner("Zombie Scan")
zc = 0
for t in tenants:
    tid = t["id"]
    slug = t.get("slug","-")
    name = t.get("display_name","-")
    pr = api(f"/api/saas/algofund/{tid}")
    if pr.get("error"): continue
    ek = pr.get("executionApiKeyName") or pr.get("assignedApiKeyName")
    if not ek: continue
    cn = f"ALGOFUND::{slug}"
    tss = api(f"/api/trading-systems/{ek}")
    if not isinstance(tss, list): continue
    fts = next((ts for ts in tss if ts.get("name") == cn), None)
    if not fts:
        print(f"  MISS [{tid}] {name}: TS {cn} NOT FOUND on {ek}")
        continue
    sts = api(f"/api/strategies/{ek}")
    if not isinstance(sts, list): continue
    active = [s for s in sts if s.get("is_active") and not s.get("is_archived")]
    tsids = {m.get("strategy_id") for m in fts.get("members", [])}
    zs = [s for s in active if s.get("id") not in tsids]
    if zs:
        zc += 1
        print(f"  ZOMBIE [{tid}] {name}: {len(zs)}")
        for z in zs:
            print(f"    id={z.get("id")} {z.get("name")}")
    else:
        print(f"  OK [{tid}] {name}")
print(f"\nTenants with zombies: {zc}/{len(tenants)}")

banner("Client 5374535192")
c = next((t for t in tenants if str(t.get("telegram_id")) == "5374535192"), None)
if c:
    tid = c["id"]
    print(f"Tenant: id={tid} slug={c.get("slug")} name={c.get("display_name")}")
    print(f"Status: {c.get("status")} Plan: {c.get("plan_name")}")
    pr = api(f"/api/saas/algofund/{tid}")
    if not pr.get("error"):
        ek = pr.get("executionApiKeyName") or pr.get("assignedApiKeyName")
        print(f"Profile: riskMul={pr.get("riskMultiplier")} reqEnabled={pr.get("requestedEnabled")} actualEnabled={pr.get("actualEnabled")}")
        print(f"Exec key: {ek}")
        if ek:
            cn = f"ALGOFUND::{c.get("slug")}"
            tss = api(f"/api/trading-systems/{ek}")
            if isinstance(tss, list):
                fts = next((ts for ts in tss if ts.get("name") == cn), None)
                if fts:
                    print(f"TS: id={fts.get("id")} maxOP={fts.get("max_open_positions")} members={len(fts.get("members",[]))} active={fts.get("is_active")}")
                    for m in fts.get("members",[]):
                        print(f"  member: sid={m.get("strategy_id")} w={m.get("weight")} enabled={m.get("is_enabled")}")
                else:
                    print(f"TS NOT FOUND on {ek}")
                sts = api(f"/api/strategies/{ek}")
                if isinstance(sts, list):
                    active = [s for s in sts if s.get("is_active") and not s.get("is_archived")]
                    tsids = {m.get("strategy_id") for m in fts.get("members", [])} if fts else set()
                    zs = [s for s in active if s.get("id") not in tsids]
                    print(f"Active: {len(active)}, zombies: {len(zs)}")
else:
    print("NOT FOUND")
print("\nDone.")

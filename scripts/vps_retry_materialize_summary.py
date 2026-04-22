#!/usr/bin/env python3
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3001/api/saas/algofund"
TENANTS = [41170, 41232, 69181]

summary = []
for tenant_id in TENANTS:
    req = urllib.request.Request(url=f"{BASE}/{tenant_id}/retry-materialize", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            profile = (data.get("state") or {}).get("profile") or {}
            runtime = (data.get("state") or {}).get("runtime") or {}
            systems = runtime.get("systems") if isinstance(runtime.get("systems"), list) else []
            summary.append({
                "tenantId": tenant_id,
                "status": resp.getcode(),
                "success": bool(data.get("success", False)),
                "publishedSystemName": profile.get("publishedSystemName"),
                "actualEnabled": profile.get("actualEnabled"),
                "runtimeSystemCount": len(systems),
            })
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        err = None
        try:
            err = json.loads(body).get("error") if body else str(e)
        except Exception:
            err = body or str(e)
        summary.append({"tenantId": tenant_id, "status": e.code, "success": False, "error": err})
    except Exception as e:
        summary.append({"tenantId": tenant_id, "success": False, "error": str(e)})

print(json.dumps(summary, ensure_ascii=False, indent=2))

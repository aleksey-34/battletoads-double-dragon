#!/usr/bin/env python3
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3001/api/saas/algofund"
TENANTS = [41170, 41232, 69181]

out = []
for tenant_id in TENANTS:
    url = f"{BASE}/{tenant_id}/retry-materialize"
    req = urllib.request.Request(url=url, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(body)
            except Exception:
                payload = {"raw": body}
            out.append({"tenantId": tenant_id, "status": resp.getcode(), "response": payload})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        try:
            payload = json.loads(body) if body else None
        except Exception:
            payload = {"raw": body}
        out.append({
            "tenantId": tenant_id,
            "status": e.code,
            "error": str(e),
            "response": payload,
        })
    except Exception as e:
        out.append({"tenantId": tenant_id, "error": str(e)})

print(json.dumps(out, ensure_ascii=False, indent=2))

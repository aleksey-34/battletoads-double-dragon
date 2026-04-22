#!/usr/bin/env python3
import json
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

out = {}

# 1) Service status
try:
    proc = subprocess.run(["systemctl", "is-active", "btdd-api"], capture_output=True, text=True, timeout=20)
    out["btddApiActive"] = proc.stdout.strip()
except Exception as e:
    out["btddApiActiveError"] = str(e)

# 2) Check compiled marker in dist JS
marker = "non-SAAS names"
dist_path = Path("/opt/battletoads-double-dragon/backend/dist/saas/service.js")
out["distServiceExists"] = dist_path.exists()
out["distMarkerFound"] = False
if dist_path.exists():
    try:
        text = dist_path.read_text(encoding="utf-8", errors="ignore")
        out["distMarkerFound"] = marker in text
    except Exception as e:
        out["distReadError"] = str(e)

# 3) Endpoint check
base = "http://127.0.0.1:3001/api/saas/algofund"
tenants = [41170, 41232, 69181]
checks = []
for tenant_id in tenants:
    req = urllib.request.Request(url=f"{base}/{tenant_id}/retry-materialize", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(body)
            except Exception:
                payload = {"raw": body}
            checks.append({"tenantId": tenant_id, "status": resp.getcode(), "response": payload})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        try:
            payload = json.loads(body) if body else None
        except Exception:
            payload = {"raw": body}
        checks.append({"tenantId": tenant_id, "status": e.code, "error": str(e), "response": payload})
    except Exception as e:
        checks.append({"tenantId": tenant_id, "error": str(e)})

out["retryMaterialize"] = checks
print(json.dumps(out, ensure_ascii=False, indent=2))

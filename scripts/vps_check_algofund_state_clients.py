#!/usr/bin/env python3
import json
import urllib.request

BASE = "http://127.0.0.1:3001/api/saas/algofund"
AUTH = {"Authorization": "Bearer SuperSecure2026Admin!"}
TENANTS = [41170, 41232]


def get(path):
    req = urllib.request.Request(path, headers=AUTH)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


for tenant_id in TENANTS:
    data = get(f"{BASE}/{tenant_id}")
    out = {
        "tenantId": tenant_id,
        "tenant": {
            "display_name": (data.get("tenant") or {}).get("display_name"),
            "assigned_api_key_name": (data.get("tenant") or {}).get("assigned_api_key_name"),
        },
        "profile": {
            "assigned_api_key_name": (data.get("profile") or {}).get("assigned_api_key_name"),
            "execution_api_key_name": (data.get("profile") or {}).get("execution_api_key_name"),
            "published_system_name": (data.get("profile") or {}).get("published_system_name"),
            "risk_multiplier": (data.get("profile") or {}).get("risk_multiplier"),
            "requested_enabled": (data.get("profile") or {}).get("requested_enabled"),
            "actual_enabled": (data.get("profile") or {}).get("actual_enabled"),
        },
        "engine": data.get("engine"),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))

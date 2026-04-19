#!/usr/bin/env python3
import json
from urllib import request

BASE = "http://127.0.0.1:3001/api/saas"
TOKEN = "btdd_admin_sweep_2026"
TENANT_IDS = [67549, 67610, 41003]


def api_get(path: str):
    req = request.Request(
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    out = []
    for tenant_id in TENANT_IDS:
        data = api_get(f"/strategy-clients/{tenant_id}")
        catalog = data.get("catalog") or {}
        client_catalog = catalog.get("clientCatalog") or {}
        out.append({
            "tenantId": tenant_id,
            "profileSelectedOfferIds": ((data.get("profile") or {}).get("selectedOfferIds") or []),
            "offersCount": len(data.get("offers") or []),
            "catalogMono": len(client_catalog.get("mono") or []),
            "catalogSynth": len(client_catalog.get("synth") or []),
            "firstOfferIds": [item.get("offerId") for item in (data.get("offers") or [])[:6]],
        })
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
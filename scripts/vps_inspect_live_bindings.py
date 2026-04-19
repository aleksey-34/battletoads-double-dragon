#!/usr/bin/env python3
import json
from urllib import request

BASE = "http://127.0.0.1:3001/api/saas/admin"
TOKEN = "btdd_admin_sweep_2026"


def api_get(path: str):
    req = request.Request(
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    summary = api_get("/summary?scope=full")
    tenants = summary.get("tenants") or []
    result = {
        "strategyClients": [
            {
                "tenantId": item.get("tenant", {}).get("id"),
                "name": item.get("tenant", {}).get("display_name"),
                "productMode": item.get("tenant", {}).get("product_mode"),
                "selectedOfferIds": ((item.get("strategyProfile") or {}).get("selectedOfferIds") or []),
                "selectedOffersCount": len(((item.get("strategyProfile") or {}).get("selectedOfferIds") or [])),
                "apiKey": (item.get("strategyProfile") or {}).get("execution_api_key_name"),
            }
            for item in tenants
            if item.get("tenant", {}).get("product_mode") in ("strategy_client", "dual")
        ],
        "algofundClients": [
            {
                "tenantId": item.get("tenant", {}).get("id"),
                "name": item.get("tenant", {}).get("display_name"),
                "productMode": item.get("tenant", {}).get("product_mode"),
                "publishedSystem": (item.get("algofundProfile") or {}).get("published_system_name"),
                "apiKey": (item.get("algofundProfile") or {}).get("execution_api_key_name"),
            }
            for item in tenants
            if item.get("tenant", {}).get("product_mode") in ("algofund_client", "dual")
        ],
        "storefrontSystems": ((summary.get("offerStore") or {}).get("algofundStorefrontSystemNames") or []),
        "tsSnapshots": sorted(list(((summary.get("offerStore") or {}).get("tsBacktestSnapshots") or {}).keys())),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
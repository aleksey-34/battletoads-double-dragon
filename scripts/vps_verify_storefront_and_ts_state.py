#!/usr/bin/env python3
import json
from urllib import request

API_BASE = "http://127.0.0.1:3001/api/saas/admin"
ADMIN_TOKEN = "btdd_admin_sweep_2026"


def api_get(path: str):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    offer_store = api_get("/offer-store")
    draft = api_get("/curated-draft-members")
    summary = api_get("/summary?scope=full")
    catalog = summary.get("catalog") or {}
    result = {
        "offerStore": offer_store,
        "curatedDraftMembers": draft,
        "summaryCatalog": {
            "timestamp": catalog.get("timestamp"),
            "monoCatalog": (catalog.get("counts") or {}).get("monoCatalog"),
            "synthCatalog": (catalog.get("counts") or {}).get("synthCatalog"),
            "adminTsMembers": ((catalog.get("adminTradingSystemDraft") or {}).get("members") or []),
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
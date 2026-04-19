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
    store = api_get("/offer-store")
    draft = api_get("/curated-draft-members")
    summary = api_get("/summary?scope=full")
    offer_store = store.get("offerStore") or store.get("data") or {}
    catalog = summary.get("catalog") or {}
    mono = (catalog.get("clientCatalog") or {}).get("mono") or []
    synth = (catalog.get("clientCatalog") or {}).get("synth") or []
    result = {
        "offerStore": {
            "publishedOfferIds": offer_store.get("publishedOfferIds"),
            "curatedOfferIds": offer_store.get("curatedOfferIds"),
            "labels": offer_store.get("labels"),
        },
        "draftMembersCount": len(draft.get("members") or []),
        "draftMembers": draft.get("members") or [],
        "summary": {
            "catalogTimestamp": catalog.get("timestamp"),
            "monoCatalog": len(mono),
            "synthCatalog": len(synth),
            "summaryDraftMembersCount": len((catalog.get("adminTradingSystemDraft") or {}).get("members") or []),
            "monoOfferIds": [row.get("offerId") for row in mono],
            "synthOfferIds": [row.get("offerId") for row in synth],
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
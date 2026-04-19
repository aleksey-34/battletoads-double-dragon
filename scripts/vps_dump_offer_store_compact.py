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
    data = api_get("/offer-store")
    print(json.dumps({
        "publishedOfferIds": data.get("publishedOfferIds"),
        "curatedOfferIds": data.get("curatedOfferIds"),
        "labels": data.get("labels"),
        "runtimeSnapshotOfferIds": [
            key for key, value in (data.get("labels") or {}).items()
            if str(value or "").strip() == "runtime_snapshot"
        ],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
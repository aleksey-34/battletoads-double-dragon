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
    summary = api_get("/summary?scope=full")
    catalog = (summary.get("catalog") or {}).get("clientCatalog") or {}
    rows = list(catalog.get("mono") or []) + list(catalog.get("synth") or [])
    result = []
    for row in rows:
        strategy = row.get("strategy") or {}
        metrics = row.get("metrics") or {}
        result.append({
            "offerId": row.get("offerId"),
            "titleRu": row.get("titleRu"),
            "strategyId": strategy.get("id"),
            "strategyName": strategy.get("name"),
            "strategyType": strategy.get("type"),
            "market": strategy.get("market"),
            "mode": strategy.get("mode"),
            "ret": metrics.get("ret"),
            "pf": metrics.get("pf"),
            "dd": metrics.get("dd"),
            "score": metrics.get("score"),
        })
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
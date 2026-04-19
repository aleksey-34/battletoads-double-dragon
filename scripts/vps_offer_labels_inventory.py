#!/usr/bin/env python3
import json
from urllib import request

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"


def api_get(path: str):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    payload = api_get("/api/saas/admin/summary?detail=full")
    offer_store = payload.get("offerStore") or {}
    offers = offer_store.get("offers") or []
    labels = offer_store.get("labels") or {}

    by_label = {
        "runtime_snapshot": [],
        "research_catalog": [],
        "fallback_preset": [],
        "unknown": [],
    }

    for row in offers:
        label = str(row.get("label") or labels.get(str(row.get("offerId") or "")) or "research_catalog")
        if label not in by_label:
            label = "unknown"
        period_days = float(row.get("periodDays") or 0)
        ret = float(row.get("ret") or 0)
        trades = int(row.get("trades") or 0)
        monthly_return = ret / max(1.0, period_days / 30.0) if period_days > 0 else ret
        trades_per_30d = trades / max(1.0, period_days / 30.0) if period_days > 0 else trades
        by_label[label].append({
            "offerId": row.get("offerId"),
            "titleRu": row.get("titleRu"),
            "market": row.get("market"),
            "mode": row.get("mode"),
            "tf": row.get("familyInterval") or row.get("interval") or ((row.get("strategyParams") or {}).get("interval")),
            "ret": ret,
            "pf": float(row.get("pf") or 0),
            "dd": float(row.get("dd") or 0),
            "trades": trades,
            "periodDays": period_days,
            "retPer30d": round(monthly_return, 3),
            "tradesPer30d": round(trades_per_30d, 3),
            "connectedClients": int(row.get("connectedClients") or 0),
        })

    for key in by_label:
        by_label[key].sort(key=lambda item: (-float(item.get("retPer30d") or 0), -float(item.get("pf") or 0), -int(item.get("trades") or 0), str(item.get("offerId") or "")))

    print(json.dumps({
        "labelsPresent": isinstance(labels, dict),
        "labelsCount": len(labels),
        "offersCount": len(offers),
        "offersWithLabel": sum(1 for row in offers if row.get("label")),
        "countsByLabel": {key: len(value) for key, value in by_label.items()},
        "inventory": by_label,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
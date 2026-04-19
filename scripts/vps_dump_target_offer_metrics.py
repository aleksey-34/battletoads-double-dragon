#!/usr/bin/env python3
import json
from urllib import request

BASE = "http://127.0.0.1:3001/api/saas/admin"
TOKEN = "btdd_admin_sweep_2026"
TARGET_IDS = {
    "offer_mono_stat_arb_zscore_172020",
    "offer_mono_stat_arb_zscore_172407",
    "offer_mono_stat_arb_zscore_172011",
    "offer_mono_stat_arb_zscore_172370",
    "offer_mono_stat_arb_zscore_172405",
    "offer_mono_dd_battletoads_171520",
}


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
    rows = data.get("offers") or []
    result = []
    for row in rows:
      offer_id = str(row.get("offerId") or "").strip()
      if offer_id in TARGET_IDS:
        result.append({
            "offerId": offer_id,
            "ret": row.get("ret"),
            "pf": row.get("pf"),
            "trades": row.get("trades"),
            "tradesPerDay": row.get("tradesPerDay"),
            "label": (data.get("labels") or {}).get(offer_id),
        })
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
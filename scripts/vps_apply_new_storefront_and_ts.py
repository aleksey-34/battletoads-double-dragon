#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib import request

API_BASE = "http://127.0.0.1:3001/api/saas/admin"
ADMIN_TOKEN = "btdd_admin_sweep_2026"
BACKUP_DIR = Path("/opt/battletoads-double-dragon/results")

TARGET_OFFER_IDS = [
    "offer_mono_stat_arb_zscore_172020",  # Bitget OPUSDT 4h vitrine
    "offer_mono_stat_arb_zscore_172011",  # Bitget OPUSDT 4h alt vitrine
    "offer_mono_stat_arb_zscore_172370",  # Bitget FETUSDT 4h growth
    "offer_mono_stat_arb_zscore_172407",  # Bitget FETUSDT 4h growth alt
    "offer_mono_stat_arb_zscore_172405",  # Bitget FETUSDT 4h growth alt
    "offer_mono_dd_battletoads_171520",   # Bitget OPUSDT 1h growth
]

TARGET_TS_WEIGHTS = {
    "offer_mono_stat_arb_zscore_172020": 1.15,
    "offer_mono_stat_arb_zscore_172011": 1.05,
    "offer_mono_stat_arb_zscore_172370": 0.95,
    "offer_mono_stat_arb_zscore_172407": 0.92,
    "offer_mono_stat_arb_zscore_172405": 0.88,
    "offer_mono_dd_battletoads_171520": 0.85,
}


def api_get(path: str):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path: str, payload: dict):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {ADMIN_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
    )
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_patch(path: str, payload: dict):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {ADMIN_TOKEN}",
            "Content-Type": "application/json",
        },
        method="PATCH",
        data=json.dumps(payload).encode("utf-8"),
    )
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def all_offers(summary: dict):
    catalog = (summary.get("catalog") or {}).get("clientCatalog") or {}
    return list(catalog.get("mono") or []) + list(catalog.get("synth") or [])


def main():
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    summary = api_get("/summary?scope=full")
    offer_store = api_get("/offer-store")
    draft = api_get("/curated-draft-members")

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = BACKUP_DIR / f"storefront_ts_backup_{timestamp}.json"
    backup_payload = {
        "timestamp": timestamp,
        "offerStore": offer_store,
        "curatedDraftMembers": draft,
        "catalogTimestamp": (summary.get("catalog") or {}).get("timestamp"),
    }
    backup_path.write_text(json.dumps(backup_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    offer_map = {}
    for offer in all_offers(summary):
        offer_id = str(offer.get("offerId") or "").strip()
        if offer_id:
            offer_map[offer_id] = offer

    missing = [offer_id for offer_id in TARGET_OFFER_IDS if offer_id not in offer_map]
    if missing:
        raise SystemExit(f"Missing target offers in live catalog: {missing}")

    labels = {offer_id: "runtime_snapshot" for offer_id in TARGET_OFFER_IDS}
    offer_result = api_patch(
        "/offer-store",
        {
            "publishedOfferIds": TARGET_OFFER_IDS,
            "curatedOfferIds": TARGET_OFFER_IDS,
            "labels": labels,
        },
    )

    members = []
    for offer_id in TARGET_OFFER_IDS:
        offer = offer_map[offer_id]
        strategy = offer.get("strategy") or {}
        metrics = offer.get("metrics") or {}
        members.append({
            "strategyId": int(strategy.get("id") or 0),
            "strategyName": str(strategy.get("name") or offer.get("titleRu") or offer_id),
            "strategyType": str(strategy.get("type") or "DD_BattleToads"),
            "marketMode": str(strategy.get("mode") or "mono"),
            "market": str(strategy.get("market") or offer.get("market") or ""),
            "score": float(metrics.get("score") or 0),
            "weight": TARGET_TS_WEIGHTS.get(offer_id, 0.9),
        })

    draft_result = api_post("/curated-draft-members", {"members": members})
    verify_summary = api_get("/summary?scope=full")
    verify_store = api_get("/offer-store")

    result = {
        "backupPath": str(backup_path),
        "appliedOfferIds": TARGET_OFFER_IDS,
        "offerStoreUpdate": {
            "publishedOfferIds": (offer_result.get("offerStore") or {}).get("publishedOfferIds"),
            "curatedOfferIds": (offer_result.get("offerStore") or {}).get("curatedOfferIds"),
            "labels": (offer_result.get("offerStore") or {}).get("labels"),
        },
        "curatedDraftMembers": draft_result.get("members") or [],
        "verify": {
            "storefrontOfferIds": (((verify_store.get("offerStore") or {}).get("publishedOfferIds")) or []),
            "draftMembersCount": len((((verify_summary.get("catalog") or {}).get("adminTradingSystemDraft") or {}).get("members") or [])),
            "catalogTimestamp": (verify_summary.get("catalog") or {}).get("timestamp"),
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
#!/usr/bin/env python3
import json
from urllib import request

BASE = "http://127.0.0.1:3001/api/saas/admin"
TOKEN = "btdd_admin_sweep_2026"

NEW_OFFER_IDS = [
    "offer_mono_stat_arb_zscore_172020",
    "offer_mono_stat_arb_zscore_172407",
    "offer_mono_stat_arb_zscore_172011",
    "offer_mono_stat_arb_zscore_172370",
    "offer_mono_stat_arb_zscore_172405",
    "offer_mono_dd_battletoads_171520",
]

OLD_SYSTEMS = [
    "ALGOFUND_MASTER::BTDD_D1::cloud-op2",
    "ALGOFUND_MASTER::BTDD_D1::gs3-alpha-tru",
    "ALGOFUND_MASTER::BTDD_D1::gs3-alpha-sui",
    "ALGOFUND_MASTER::BTDD_D1::gs3-alpha-arb-tia",
]

NEW_SET_KEY = "BTDD ANCHORG CURATED 2026-04-18"


def api_get(path: str):
    req = request.Request(
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path: str, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{BASE}{path}",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        data=body,
        method="POST",
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_patch(path: str, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{BASE}{path}",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        data=body,
        method="PATCH",
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def downsample(values, limit=160):
    if not isinstance(values, list) or len(values) <= limit:
        return values if isinstance(values, list) else []
    step = max(1, len(values) // limit)
    sampled = [values[index] for index in range(0, len(values), step)]
    if sampled[-1] != values[-1]:
        sampled.append(values[-1])
    return sampled[:limit]


def inspect_strategy_client_counts():
    out = {}
    for tenant_id in [67549, 67610, 41003]:
        req = request.Request(
            f"http://127.0.0.1:3001/api/saas/strategy-clients/{tenant_id}",
            headers={"Authorization": f"Bearer {TOKEN}"},
            method="GET",
        )
        with request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        out[str(tenant_id)] = {
            "offersCount": len(data.get("offers") or []),
            "selectedOfferIds": ((data.get("profile") or {}).get("selectedOfferIds") or []),
        }
    return out


def main():
    result = {}

    result["beforeStrategyClients"] = inspect_strategy_client_counts()

    labels = {offer_id: "runtime_snapshot" for offer_id in NEW_OFFER_IDS}
    storefront_update = api_patch(
        "/offer-store",
        {
            "publishedOfferIds": NEW_OFFER_IDS,
            "curatedOfferIds": NEW_OFFER_IDS,
            "labels": labels,
        },
    )
    result["storefrontUpdate"] = {
        "publishedOfferIds": storefront_update.get("publishedOfferIds"),
        "curatedOfferIds": storefront_update.get("curatedOfferIds"),
        "labelsCount": len(storefront_update.get("labels") or {}),
    }

    publish = api_post(
        "/publish",
        {
            "offerIds": NEW_OFFER_IDS,
            "setKey": NEW_SET_KEY,
        },
    )
    source_system = (publish.get("sourceSystem") or {})
    preview = (publish.get("preview") or {})
    preview_summary = preview.get("summary") or {}
    preview_equity = preview.get("equity") or []
    period = publish.get("preview", {}).get("period") or {}
    system_name = str(source_system.get("systemName") or "").strip()

    snapshot_patch = {
        system_name: {
            "setKey": NEW_SET_KEY,
            "systemName": system_name,
            "offerIds": NEW_OFFER_IDS,
            "apiKeyName": source_system.get("apiKeyName"),
            "ret": float(preview_summary.get("totalReturnPercent") or 0),
            "pf": float(preview_summary.get("profitFactor") or 0),
            "dd": float(preview_summary.get("maxDrawdownPercent") or 0),
            "trades": int(preview_summary.get("tradesCount") or 0),
            "tradesPerDay": float(preview_summary.get("tradesPerDay") or 0),
            "periodDays": int(period.get("days") or 90),
            "finalEquity": float(preview_summary.get("finalEquity") or 0),
            "equityPoints": downsample([
                float(point.get("equity") if isinstance(point, dict) else point)
                for point in preview_equity
                if (isinstance(point, dict) and point.get("equity") is not None) or isinstance(point, (int, float))
            ]),
            "backtestSettings": {
                "riskScore": 5,
                "tradeFrequencyScore": 5,
                "initialBalance": 10000,
                "riskScaleMaxPercent": 100,
            },
        }
    }
    for old_system in OLD_SYSTEMS:
        snapshot_patch[old_system] = None

    snapshot_update = api_patch(
        "/offer-store",
        {
            "tsBacktestSnapshotsPatch": snapshot_patch,
        },
    )
    result["publish"] = {
        "systemId": source_system.get("systemId"),
        "systemName": system_name,
        "apiKeyName": source_system.get("apiKeyName"),
    }
    result["snapshotKeysAfterPatch"] = sorted(list((snapshot_update.get("tsBacktestSnapshots") or {}).keys()))

    removed = []
    remove_errors = []
    for old_system in OLD_SYSTEMS:
        try:
            response = api_post(
                "/storefront-system/remove",
                {
                    "systemName": old_system,
                    "force": True,
                    "dryRun": False,
                    "closePositions": False,
                },
            )
            removed.append({
                "systemName": old_system,
                "removed": response.get("removed"),
                "clientsAffected": response.get("clientsAffected"),
            })
        except Exception as exc:
            remove_errors.append({"systemName": old_system, "error": str(exc)})
    result["removedOldSystems"] = removed
    result["removeErrors"] = remove_errors

    summary = api_get("/summary?scope=full")
    result["afterSummary"] = {
        "monoCatalog": len((((summary.get("catalog") or {}).get("clientCatalog") or {}).get("mono") or [])),
        "synthCatalog": len((((summary.get("catalog") or {}).get("clientCatalog") or {}).get("synth") or [])),
        "storefrontSystems": ((summary.get("offerStore") or {}).get("algofundStorefrontSystemNames") or []),
        "tsSnapshots": sorted(list(((summary.get("offerStore") or {}).get("tsBacktestSnapshots") or {}).keys())),
    }
    result["afterStrategyClients"] = inspect_strategy_client_counts()

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
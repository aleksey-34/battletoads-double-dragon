#!/usr/bin/env python3
import json
import time
from urllib import request, error

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"

QUEUE = [
    {
        "apiKeyName": "IVAN_WEEX_RESEARCH",
        "systemName": "LOWTF Promotion WEEX OPUSDT StatArb",
        "strategyPrefix": "LOWTF_PROMO_WEEX",
    },
    {
        "apiKeyName": "HDB_17",
        "systemName": "LOWTF Promotion Bitget OPUSDT StatArb",
        "strategyPrefix": "LOWTF_PROMO_BITGET",
    },
]


def api_get(path: str):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path: str, payload: dict):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {ADMIN_TOKEN}",
            "Content-Type": "application/json",
        },
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def stringify(value):
    return str(value or "").strip().lower()


def current_status():
    data = api_get("/api/research/sweeps/full-historical/status")
    if isinstance(data, dict):
        return data
    return {"raw": data}


def wait_until_free():
    while True:
        status = current_status()
        if stringify(status.get("status")) not in {"running", "pending"}:
            return status
        print(json.dumps({"waitingForJob": status.get("id"), "status": status.get("status")}, ensure_ascii=False), flush=True)
        time.sleep(60)


def build_payload(item: dict):
    checkpoint_slug = item["strategyPrefix"].lower()
    return {
        "mode": "heavy",
        "apiKeyName": item["apiKeyName"],
        "dateFrom": "2026-01-01T00:00:00Z",
        "intervals": ["5m"],
        "strategyTypes": ["stat_arb_zscore"],
        "monoMarkets": ["OPUSDT"],
        "synthMarkets": [],
        "statLengths": [72, 96],
        "statEntry": [1.75, 2.0, 2.25],
        "statExit": [0.75, 1.0],
        "statStop": [3.0, 3.5],
        "robust": {
            "minProfitFactor": 0.95,
            "maxDrawdownPercent": 12,
            "minTrades": 15,
        },
        "maxRuns": 32,
        "backtestBars": 6000,
        "warmupBars": 400,
        "checkpointEvery": 10,
        "resumeEnabled": False,
        "checkpointFile": f"/opt/battletoads-double-dragon/results/{checkpoint_slug}_promotion_checkpoint.json",
        "allowDuplicateMarkets": False,
        "maxMembers": 1,
        "strategyPrefix": item["strategyPrefix"],
        "systemName": item["systemName"],
    }


def main():
    print(json.dumps({"queue": QUEUE, "purpose": "promotion_resweep"}, ensure_ascii=False), flush=True)
    for item in QUEUE:
        wait_until_free()
        payload = build_payload(item)
        try:
            result = api_post("/api/research/sweeps/full-historical/start", payload)
            print(json.dumps({"queuedLaunch": item["apiKeyName"], "payload": payload, "result": result}, ensure_ascii=False), flush=True)
        except error.HTTPError as exc:
            print(
                json.dumps(
                    {
                        "queuedLaunch": item["apiKeyName"],
                        "payload": payload,
                        "httpError": exc.code,
                        "body": exc.read().decode("utf-8"),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            break


if __name__ == "__main__":
    main()
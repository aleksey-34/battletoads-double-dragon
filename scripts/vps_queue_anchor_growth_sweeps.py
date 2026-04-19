#!/usr/bin/env python3
import json
import time
from urllib import request, error

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"

QUEUE = [
    {
        "apiKeyName": "BTDD_MEX_RESEARCH",
        "systemName": "ANCHORG MEXC Broad Growth",
        "strategyPrefix": "ANCHORG_MEXC",
    },
    {
        "apiKeyName": "HDB_17",
        "systemName": "ANCHORG Bitget Broad Growth",
        "strategyPrefix": "ANCHORG_BITGET",
    },
]

MONO_MARKETS = [
    "OPUSDT",
    "FETUSDT",
    "SEIUSDT",
    "GRTUSDT",
    "INJUSDT",
    "TRUUSDT",
    "SUIUSDT",
    "WLDUSDT",
    "TIAUSDT",
    "ARBUSDT",
    "APTUSDT",
    "1000PEPEUSDT",
    "WIFUSDT",
    "BONKUSDT",
    "FLOKIUSDT",
    "JUPUSDT",
    "LINKUSDT",
    "AVAXUSDT",
]

SYNTH_MARKETS = [
    "OPUSDT/SEIUSDT",
    "FETUSDT/OPUSDT",
    "GRTUSDT/INJUSDT",
    "TRUUSDT/GRTUSDT",
    "SUIUSDT/OPUSDT",
    "WLDUSDT/TIAUSDT",
    "ARBUSDT/OPUSDT",
    "APTUSDT/SUIUSDT",
    "WIFUSDT/BONKUSDT",
    "FLOKIUSDT/1000PEPEUSDT",
    "JUPUSDT/WIFUSDT",
    "LINKUSDT/ARBUSDT",
    "AVAXUSDT/INJUSDT",
    "TIAUSDT/SEIUSDT",
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
    return data if isinstance(data, dict) else {"raw": data}


def wait_until_free():
    while True:
        status = current_status()
        if stringify(status.get("status")) not in {"running", "pending"}:
            return status
        print(json.dumps({"waitingForJob": status.get("id"), "status": status.get("status")}, ensure_ascii=False), flush=True)
        time.sleep(60)


def build_payload(item: dict):
    prefix = item["strategyPrefix"]
    return {
        "mode": "heavy",
        "apiKeyName": item["apiKeyName"],
        "dateFrom": "2026-01-01T00:00:00Z",
        "intervals": ["1h", "4h"],
        "strategyTypes": ["DD_BattleToads", "zz_breakout", "stat_arb_zscore"],
        "monoMarkets": MONO_MARKETS,
        "synthMarkets": SYNTH_MARKETS,
        "ddLengths": [8, 12, 16, 24, 36],
        "ddTakeProfits": [3, 5, 7.5, 10],
        "ddSources": ["close", "wick"],
        "statLengths": [24, 36, 48, 72, 96],
        "statEntry": [1.25, 1.5, 1.75, 2.0],
        "statExit": [0.5, 0.75, 1.0],
        "statStop": [2.5, 3.0, 3.5],
        "robust": {
            "minProfitFactor": 1.02,
            "maxDrawdownPercent": 35,
            "minTrades": 18,
        },
        "maxRuns": 900,
        "backtestBars": 6000,
        "warmupBars": 400,
        "checkpointEvery": 25,
        "resumeEnabled": False,
        "checkpointFile": f"/opt/battletoads-double-dragon/results/{prefix.lower()}_anchor_growth_checkpoint.json",
        "allowDuplicateMarkets": False,
        "maxMembers": 8,
        "strategyPrefix": prefix,
        "systemName": item["systemName"],
    }


def main():
    print(
        json.dumps(
            {
                "queue": QUEUE,
                "purpose": "anchor_growth_broad",
                "monoMarkets": MONO_MARKETS,
                "synthMarkets": SYNTH_MARKETS,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
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
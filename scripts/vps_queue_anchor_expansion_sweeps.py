#!/usr/bin/env python3
import json
import time
from urllib import request, error

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"

QUEUE = [
    {
        "apiKeyName": "BTDD_MEX_RESEARCH",
        "systemName": "ANCHOR MEXC Expansion",
        "strategyPrefix": "ANCHORX_MEXC",
    },
    {
        "apiKeyName": "HDB_17",
        "systemName": "ANCHOR Bitget Expansion",
        "strategyPrefix": "ANCHORX_BITGET",
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
        "strategyTypes": ["DD_BattleToads", "zz_breakout"],
        "monoMarkets": MONO_MARKETS,
        "synthMarkets": SYNTH_MARKETS,
        "ddLengths": [8, 12, 16, 24],
        "ddTakeProfits": [3, 5, 7.5],
        "ddSources": ["close", "wick"],
        "robust": {
            "minProfitFactor": 1.05,
            "maxDrawdownPercent": 18,
            "minTrades": 18,
        },
        "maxRuns": 320,
        "backtestBars": 5000,
        "warmupBars": 300,
        "checkpointEvery": 20,
        "resumeEnabled": False,
        "checkpointFile": f"/opt/battletoads-double-dragon/results/{prefix.lower()}_anchor_expansion_checkpoint.json",
        "allowDuplicateMarkets": False,
        "maxMembers": 4,
        "strategyPrefix": prefix,
        "systemName": item["systemName"],
    }


def main():
    print(
        json.dumps(
            {
                "queue": QUEUE,
                "purpose": "anchor_expansion",
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
#!/usr/bin/env python3
import json
import time
from urllib import request, error

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"

QUEUE = [
    {
        "apiKeyName": "HDB_15",
        "systemName": "LOWTF BingX HDB15 Candidate",
        "strategyPrefix": "LOWTF_BINGX15",
    },
    {
        "apiKeyName": "HDB_18",
        "systemName": "LOWTF BingX HDB18 Candidate",
        "strategyPrefix": "LOWTF_BINGX18",
    },
    {
        "apiKeyName": "IVAN_WEEX_RESEARCH",
        "systemName": "LOWTF WEEX Candidate",
        "strategyPrefix": "LOWTF_WEEX",
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


def current_status():
    data = api_get("/api/research/sweeps/full-historical/status")
    if isinstance(data, dict):
        return data
    return {"raw": data}


def wait_until_free():
    while True:
        status = current_status()
        if Stringify(status.get("status")) not in {"running", "pending"}:
            return status
        print(json.dumps({"waitingForJob": status.get("id"), "status": status.get("status")}, ensure_ascii=False), flush=True)
        time.sleep(60)


def Stringify(value):
    return str(value or "").strip().lower()


def build_payload(item: dict):
    return {
        "mode": "heavy",
        "apiKeyName": item["apiKeyName"],
        "dateFrom": "2026-01-01T00:00:00Z",
        "intervals": ["5m", "15m"],
        "strategyTypes": ["stat_arb_zscore", "DD_BattleToads", "zz_breakout"],
        "monoMarkets": ["OPUSDT", "FETUSDT", "SEIUSDT", "GRTUSDT", "INJUSDT", "TRUUSDT"],
        "synthMarkets": [
            "OPUSDT/SEIUSDT",
            "FETUSDT/OPUSDT",
            "GRTUSDT/INJUSDT",
            "TRUUSDT/GRTUSDT",
            "ONDOUSDT/TIAUSDT",
            "UNIUSDT/LINKUSDT",
        ],
        "robust": {
            "minProfitFactor": 1.15,
            "maxDrawdownPercent": 22,
            "minTrades": 40,
        },
        "maxRuns": 240,
        "backtestBars": 6000,
        "checkpointEvery": 20,
        "strategyPrefix": item["strategyPrefix"],
        "systemName": item["systemName"],
    }


def main():
    for item in QUEUE:
        wait_until_free()
        try:
            result = api_post("/api/research/sweeps/full-historical/start", build_payload(item))
            print(json.dumps({"queuedLaunch": item["apiKeyName"], "result": result}, ensure_ascii=False), flush=True)
        except error.HTTPError as exc:
            print(json.dumps({"queuedLaunch": item["apiKeyName"], "httpError": exc.code, "body": exc.read().decode("utf-8")}, ensure_ascii=False), flush=True)
            break


if __name__ == "__main__":
    main()
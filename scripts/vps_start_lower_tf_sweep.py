#!/usr/bin/env python3
import argparse
import json
from urllib import request, error

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--system-name", required=True)
    args = parser.parse_args()

    payload = {
        "mode": "heavy",
        "apiKeyName": args.api_key,
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
        "strategyPrefix": args.prefix,
        "systemName": args.system_name,
    }

    req = request.Request(
        f"{API_BASE}/api/research/sweeps/full-historical/start",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ADMIN_TOKEN}",
        },
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=120) as resp:
            print(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        print(json.dumps({"httpError": exc.code, "body": exc.read().decode("utf-8")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
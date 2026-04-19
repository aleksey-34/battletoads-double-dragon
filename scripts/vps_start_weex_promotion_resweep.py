#!/usr/bin/env python3
import json
from urllib import request

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"


def main():
    payload = {
        "mode": "heavy",
        "apiKeyName": "IVAN_WEEX_RESEARCH",
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
        "checkpointFile": "/opt/battletoads-double-dragon/results/lowtf_promo_weex_promotion_checkpoint.json",
        "allowDuplicateMarkets": False,
        "maxMembers": 1,
        "strategyPrefix": "LOWTF_PROMO_WEEX",
        "systemName": "LOWTF Promotion WEEX OPUSDT StatArb",
    }
    req = request.Request(
        f"{API_BASE}/api/research/sweeps/full-historical/start",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {ADMIN_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=120) as resp:
        print(resp.read().decode("utf-8"))


if __name__ == "__main__":
    main()
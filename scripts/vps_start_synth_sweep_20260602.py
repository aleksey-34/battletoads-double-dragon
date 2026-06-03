#!/usr/bin/env python3
"""
Synthetic-heavy full-historical sweep aligned with 732d TS card window (from 2024-06-01).
All 3 strategy types × 1h/2h/4h × ~16 synth cross pairs.

  python3 scripts/vps_start_synth_sweep_20260602.py
"""
import json
from urllib import error, request

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"

PAYLOAD = {
    "mode": "heavy",
    "apiKeyName": "BTDD_D1",
    "dateFrom": "2024-06-01T00:00:00Z",
    "dateTo": None,
    # Do not send legacy `interval` string — it overrides `intervals`.
    "intervals": ["1h", "2h", "4h"],

    # Small mono anchor set (for catalog completeness; card builder ignores mono)
    "monoMarkets": [
        "BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "INJUSDT", "NEARUSDT",
        "ORDIUSDT", "PYTHUSDT", "SEIUSDT", "ARBUSDT", "OPUSDT", "LINKUSDT",
    ],

    # Broad synth universe — cross-sector pairs for stat_arb + DD/zz on ratios
    "synthMarkets": [
        "ETHUSDT/BTCUSDT", "SOLUSDT/ETHUSDT", "BNBUSDT/BTCUSDT",
        "SUIUSDT/SEIUSDT", "ARBUSDT/OPUSDT", "TIAUSDT/SEIUSDT",
        "LINKUSDT/UNIUSDT", "INJUSDT/GRTUSDT", "FETUSDT/OPUSDT",
        "ORDIUSDT/PYTHUSDT", "TRUUSDT/GRTUSDT", "IPUSDT/ZECUSDT",
        "BERAUSDT/IPUSDT", "AUCTIONUSDT/MERLUSDT", "ONDOUSDT/TIAUSDT",
        "WLDUSDT/NEARUSDT",
    ],

    "strategyTypes": ["DD_BattleToads", "stat_arb_zscore", "zz_breakout"],

    "ddLengths": [5, 8, 12, 16, 24, 36],
    "ddTakeProfits": [2, 3, 5, 7.5, 10],
    "ddSources": ["close", "wick"],

    "statLengths": [24, 36, 48, 72, 96, 120],
    "statEntry": [1.5, 1.75, 2.0, 2.25],
    "statExit": [0.5, 0.75, 1.0],
    "statStop": [2.5, 3.0, 3.5],

    "backtestBars": 6000,
    "warmupBars": 200,
    "initialBalance": 10000,
    "commissionPercent": 0.1,
    "slippagePercent": 0.05,
    "fundingRatePercent": 0,
    "skipMissingSymbols": True,

    "robust": {
        "minProfitFactor": 1.15,
        "maxDrawdownPercent": 25,
        "minTrades": 30,
    },

    "exhaustiveMode": False,
    "turboMode": True,
    "resumeEnabled": True,
    "checkpointEvery": 25,
    "maxRuns": 2000,
    "maxVariantsPerMarketType": 80,
    "allowDuplicateMarkets": False,
    "updateExistingStrategies": False,
    "windowBacktestsEnabled": False,
    "maxMembers": 32,

    "strategyPrefix": "SYNTHSWEEP_20260602",
    "systemName": "SynthSweep 2026-06-02 (732d)",
}


def main() -> None:
    req = request.Request(
        f"{API_BASE}/api/research/sweeps/full-historical/start",
        data=json.dumps(PAYLOAD).encode("utf-8"),
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

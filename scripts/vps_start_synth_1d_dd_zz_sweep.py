#!/usr/bin/env python3
"""
1d-only synth sweep: DD_BattleToads + zz_breakout on ratio pairs (TradingView 1d hypothesis).

Turbo: fan keys across Bybit/Bitget/BingX/WEEX + high concurrency.

  python3 scripts/vps_start_synth_1d_dd_zz_sweep.py
"""
from __future__ import annotations

import json
import os
import sys
from urllib import error, request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "admin_tools", "storefront"))
from synth_sweep_common import (
    abort_running_sweep,
    load_decorr_synth_markets,
    mono_anchors_from_synth,
    sweep_turbo_extras,
)

API_BASE = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
ADMIN_TOKEN = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026")

PAYLOAD = {
    "mode": "heavy",
    "apiKeyName": "BTDD_D1",
    "dateFrom": "2024-06-01T00:00:00Z",
    "dateTo": None,
    "intervals": ["1d"],
    "strategyTypes": ["DD_BattleToads", "zz_breakout"],
    "ddLengths": [5, 8, 12, 16, 24, 36, 48],
    "ddTakeProfits": [3, 5, 7.5, 10, 15, 20],
    "ddSources": ["close", "wick"],
    "backtestBars": 900,
    "warmupBars": 60,
    "initialBalance": 10000,
    "commissionPercent": 0.1,
    "slippagePercent": 0.05,
    "fundingRatePercent": 0,
    "skipMissingSymbols": True,
    "robust": {
        "minProfitFactor": 1.05,
        "maxDrawdownPercent": 18,
        "minTrades": 8,
    },
    "exhaustiveMode": False,
    "turboMode": True,
    "resumeEnabled": True,
    "checkpointEvery": 15,
    "maxRuns": int(os.environ.get("SYNTH_1D_MAX_RUNS", "2400")),
    "maxVariantsPerMarketType": 72,
    "allowDuplicateMarkets": False,
    "updateExistingStrategies": False,
    "windowBacktestsEnabled": False,
    "maxMembers": 24,
    "strategyPrefix": "SYNTH1D_TV_20260602",
    "systemName": "Synth 1d DD/ZZ ratio (732d TV-style turbo)",
}


def main() -> None:
    synth = load_decorr_synth_markets(cap=int(os.environ.get("SYNTH_SWEEP_MARKET_CAP", "30")))
    payload = dict(PAYLOAD)
    payload.update(sweep_turbo_extras())
    payload["synthMarkets"] = synth
    payload["monoMarkets"] = mono_anchors_from_synth(synth)
    print(
        f"1d DD/ZZ sweep: {len(synth)} synth pairs, maxRuns={payload['maxRuns']}, "
        f"concurrency={payload.get('concurrency')}, fanKeys={payload.get('fanApiKeyNames')}"
    )
    abort_running_sweep(API_BASE, ADMIN_TOKEN, "replace with synth 1d DD/ZZ turbo sweep")

    req = request.Request(
        f"{API_BASE}/api/research/sweeps/full-historical/start",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=120) as resp:
            print(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        print(json.dumps({"httpError": exc.code, "body": exc.read().decode("utf-8")}, ensure_ascii=False))


if __name__ == "__main__":
    main()

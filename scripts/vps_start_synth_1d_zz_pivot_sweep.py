#!/usr/bin/env python3
"""
1d synth sweep: ZZ_Fast + ZZ_Instance (real pivot levels, not Donchian zz_breakout).

Run after CT_Fractal job completes (pipeline step 5).

  python3 scripts/vps_start_synth_1d_zz_pivot_sweep.py
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
    "strategyTypes": ["ZZ_Fast", "ZZ_Instance"],
    "zzPivotLengths": [2, 3, 5, 6, 8, 12],
    "backtestBars": 900,
    "warmupBars": 80,
    "initialBalance": 10000,
    "commissionPercent": 0.1,
    "slippagePercent": 0.05,
    "fundingRatePercent": 0,
    "skipMissingSymbols": True,
    "robust": {
        "minProfitFactor": 1.05,
        "maxDrawdownPercent": 30,
        "minTrades": 4,
    },
    "sweepLotPercent": 100,
    "sweepReinvestPercent": 100,
    "sweepMaxDeposit": 0,
    "exhaustiveMode": False,
    "turboMode": True,
    "resumeEnabled": True,
    "checkpointEvery": 15,
    "maxRuns": int(os.environ.get("SYNTH_1D_ZZ_MAX_RUNS", "1200")),
    "maxVariantsPerMarketType": 48,
    "allowDuplicateMarkets": False,
    "updateExistingStrategies": False,
    "windowBacktestsEnabled": False,
    "maxMembers": 24,
    "strategyPrefix": "SYNTH1D_ZZP_20260616",
    "systemName": "Synth 1d ZZ_Fast/ZZ_Instance pivot (732d turbo)",
}


def main() -> None:
    synth = load_decorr_synth_markets(cap=int(os.environ.get("SYNTH_SWEEP_MARKET_CAP", "30")))
    payload = dict(PAYLOAD)
    payload.update(sweep_turbo_extras())
    # Important: keep per-sweep checkpoints isolated (ZZ/CT share the same backfill job runner).
    checkpoint_suffix = payload.get("strategyPrefix", "zzp").lower()
    payload["checkpointFile"] = os.environ.get(
        "SWEEP_CHECKPOINT_FILE",
        f"/opt/battletoads-double-dragon/results/btdd_d1_historical_sweep_checkpoint_{checkpoint_suffix}.json",
    )
    payload["synthMarkets"] = synth
    payload["monoMarkets"] = mono_anchors_from_synth(synth)
    print(
        f"1d ZZ pivot sweep: {len(synth)} synth pairs, maxRuns={payload['maxRuns']}, "
        f"concurrency={payload.get('concurrency')}, fanKeys={payload.get('fanApiKeyNames')}"
    )
    abort_running_sweep(API_BASE, ADMIN_TOKEN, "replace with synth 1d ZZ pivot turbo sweep")

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

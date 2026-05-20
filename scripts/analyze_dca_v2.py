#!/usr/bin/env python3
import requests, json, os

API = "http://localhost:3001"
TOKEN = os.environ.get("BTDD_ADMIN_TOKEN", "BattleToads2026!Ax")
HEADERS = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
ENDPOINT = API + "/api/trading-systems/BTDD_D1/152/backtest"

def backtest(overrides, label):
    payload = {
        "dateFrom": "2025-01-01",
        "dateTo": "2026-05-18",
        "bars": 1200,
        "warmupBars": 250,
        "initialBalance": 10000,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "skipMissingSymbols": True,
    }
    payload.update(overrides)
    print("  " + label + " ... ", end="", flush=True)
    try:
        r = requests.post(ENDPOINT, json=payload, headers=HEADERS, timeout=300)
        if r.status_code == 200:
            data = r.json()
            s = data.get("result", {}).get("summary", {})
            ret = s.get("totalReturnPercent", "N/A")
            dd = s.get("maxDrawdownPercent", "N/A")
            pf = s.get("profitFactor", "N/A")
            trades = s.get("tradesCount", "N/A")
            print(f"Ret={ret}%, DD={dd}%, PF={pf}, Trades={trades}")
            return s
        else:
            print(f"HTTP {r.status_code}: {r.text[:150]}")
            return None
    except Exception as e:
        print(f"ERROR: {e}")
        return None

print("=== BASELINE (trend only) ===")
baseline = backtest({}, "baseline")

print()
print("=== DCA ENABLED + CANDLE FILTER ===")
dca = backtest({
    "dcaEnabled": True,
    "dcaEntriesMax": 10,
    "dcaLotPercent": 0.5,
    "dcaCandleCloseFilter": True,
}, "dca_candle_filter")

print()
import json
results = {"baseline": baseline, "dca": dca}
with open("/tmp/dca_results.json", "w") as f:
    json.dump(results, f, indent=2, default=str)
print("Saved to /tmp/dca_results.json")

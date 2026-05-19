#!/usr/bin/env python3
import requests, json, sys, os

API = "http://localhost:3001"
TOKEN = os.environ.get("BTDD_ADMIN_TOKEN", "BattleToads2026!Ax")
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}

def backtest(overrides, label):
    url = f"{API}/api/research/backtest"
    payload = {
        "systemName": "ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2",
        "start": "2025-01-01",
        "end": "2026-05-18",
        "overrides": overrides,
        "profile": {"start_capital": 10000}
    }
    try:
        r = requests.post(url, json=payload, headers=HEADERS, timeout=180)
        print(f"{label}: HTTP {r.status_code}")
        if r.status_code == 200:
            data = r.json()
            summary = data.get("summary", {})
            print(f"  Ret: {summary.get('totalReturnPercent', 'N/A')}%, DD: {summary.get('maxDrawdownPercent', 'N/A')}%, PF: {summary.get('profitFactor', 'N/A')}")
            return data
        else:
            print(f"  Error: {r.text[:200]}")
    except Exception as e:
        print(f"{label}: ERROR {e}")
    return None

print("=== BASELINE (trend only) ===")
baseline = backtest({}, "baseline")

print()
print("=== DCA ENABLED ===")
dca = backtest({
    "dca_enabled": True,
    "dca_entries_max": 10,
    "dca_lot_percent": 0.5
}, "dca_moderate")

print()
print("=== Save results ===")
with open("/tmp/dca_results.json", "w") as f:
    json.dump({"baseline": baseline, "dca": dca}, f, indent=2)
print("Saved to /tmp/dca_results.json")

"""DCA Analysis for Balanced Portfolio v2
Compares trend-only vs trend+DCA metrics via backtest API.
Uses the existing backtest engine.
"""
import requests, json

API = "http://localhost:4000"

def backtest(strategy_config_overrides: dict, label: str) -> dict:
    url = f"{API}/api/research/backtest"
    payload = {
        "systemName": "ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2",
        "start": "2025-01-01",
        "end": "2026-05-18",
        "overrides": strategy_config_overrides,
        "profile": {
            "start_capital": 10000,
            "max_deposit": 10000,
            "commission_pct": 0.1,
            "slippage_pct": 0.05,
            "funding_pct": 0
        }
    }
    try:
        r = requests.post(url, json=payload, timeout=120)
        return {"label": label, "status": r.status_code, "result": r.json() if r.status_code == 200 else r.text[:200]}
    except Exception as e:
        return {"label": label, "error": str(e)}

# 1. Baseline — trend only (current)
print("Running baseline (trend only)...")
baseline = backtest({}, "baseline")

# 2. DCA enabled
print("Running trend + DCA...")
dca = backtest({
    "dca_enabled": True,
    "dca_interval_candles": 6,
    "dca_entries_max": 10,
    "dca_lot_percent": 0.5,
    "dca_tp_percent": 3,
    "dca_sl_percent": 5,
    "dca_adx_threshold": 20
}, "dca_0.5pct_10max")

# 3. DCA aggressive
print("Running aggressive DCA...")
dca_agg = backtest({
    "dca_enabled": True,
    "dca_interval_candles": 4,
    "dca_entries_max": 15,
    "dca_lot_percent": 1.0,
    "dca_tp_percent": 2,
    "dca_sl_percent": 6,
    "dca_adx_threshold": 22
}, "dca_1pct_15max")

results = [baseline, dca, dca_agg]
print(json.dumps(results, indent=2))

# Save for commit
with open("/opt/battletoads-double-dragon/docs/dca_analysis_results.json", "w") as f:
    json.dump(results, f, indent=2)
print("Saved to docs/dca_analysis_results.json")
#!/usr/bin/env python3
"""
Resync v2: exactly replicate what the UI "Save curated offer" button does.
For each offer:
  1. Call sweep-backtest-preview with stored riskScore/tradeFrequencyScore
  2. Extract summary metrics + equity from response (exactly like frontend)
  3. PATCH /api/saas/admin/offer-store with reviewSnapshotPatch (exactly like frontend)
"""
import json, requests, time, sys

API = "http://localhost:3001"
AUTH = "Bearer btdd_admin_sweep_2026"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

# Step 1: Load current offer store from API
print("Loading offer store from API...")
resp = requests.get(f"{API}/api/saas/admin/offer-store", headers=HEADERS, timeout=30)
resp.raise_for_status()
store = resp.json()
offers = store.get("offers", [])
print(f"Loaded {len(offers)} offers from API")

# Filter to curated only
curated = [o for o in offers if o.get("curated")]
print(f"Curated offers: {len(curated)}")

total = len(curated)
updated = 0
failed = 0

def downsample(arr, target=160):
    if len(arr) <= target:
        return arr
    step = len(arr) / target
    return [arr[int(i * step)] for i in range(target)]

for idx, offer in enumerate(curated):
    offer_id = offer["offerId"]
    bs = offer.get("backtestSettings", {})
    risk_score = bs.get("riskScore", 5)
    freq_score = bs.get("tradeFrequencyScore", 5)
    initial_balance = bs.get("initialBalance", 10000)
    risk_max_pct = bs.get("riskScaleMaxPercent", 100)

    print(f"[{idx+1}/{total}] {offer_id[:55]} r={risk_score} f={freq_score} ... ", end="", flush=True)

    try:
        # Call sweep-backtest-preview (same as UI)
        bt_resp = requests.post(f"{API}/api/saas/admin/sweep-backtest-preview", headers=HEADERS, json={
            "kind": "offer",
            "offerId": offer_id,
            "riskScore": risk_score,
            "tradeFrequencyScore": freq_score,
            "initialBalance": initial_balance,
            "riskScaleMaxPercent": risk_max_pct,
        }, timeout=120)

        if bt_resp.status_code == 429:
            print("BUSY, wait 5s...", end="", flush=True)
            time.sleep(5)
            bt_resp = requests.post(f"{API}/api/saas/admin/sweep-backtest-preview", headers=HEADERS, json={
                "kind": "offer",
                "offerId": offer_id,
                "riskScore": risk_score,
                "tradeFrequencyScore": freq_score,
                "initialBalance": initial_balance,
                "riskScaleMaxPercent": risk_max_pct,
            }, timeout=120)

        if bt_resp.status_code != 200:
            print(f"HTTP {bt_resp.status_code}")
            failed += 1
            continue

        data = bt_resp.json()
        preview = data.get("preview") or {}
        summary = preview.get("summary") or {}
        selected = (data.get("selectedOffers") or [{}])[0] if data.get("selectedOffers") else {}
        sel_metrics = selected.get("metrics", {})

        # Extract exactly like the frontend save button does
        ret = float(summary.get("totalReturnPercent") or sel_metrics.get("ret") or 0)
        pf = float(summary.get("profitFactor") or sel_metrics.get("pf") or 0)
        dd = float(summary.get("maxDrawdownPercent") or sel_metrics.get("dd") or 0)
        trades = int(summary.get("tradesCount") or sel_metrics.get("trades") or 0)
        trades_per_day = float(selected.get("tradesPerDay", 0))
        period_days = int(selected.get("periodDays", 90))
        sweep_api_key = str(data.get("rerun", {}).get("apiKeyName") or data.get("sweepApiKeyName") or "")

        # Extract equity exactly like frontend: preview.equity[].equity or .value
        equity_raw = preview.get("equity", [])
        equity_points = []
        if isinstance(equity_raw, list):
            for pt in equity_raw:
                if isinstance(pt, dict):
                    val = pt.get("equity") if pt.get("equity") is not None else pt.get("value")
                    if val is not None:
                        equity_points.append(round(float(val), 2))
                elif isinstance(pt, (int, float)):
                    equity_points.append(round(float(pt), 2))

        # Downsample to 160 (same as frontend)
        equity_points = downsample(equity_points, 160)

        if ret == 0 and trades == 0:
            print(f"NO DATA")
            failed += 1
            continue

        # PATCH offer store with reviewSnapshotPatch (exactly like frontend button)
        patch_resp = requests.patch(f"{API}/api/saas/admin/offer-store", headers=HEADERS, json={
            "reviewSnapshotPatch": {
                offer_id: {
                    "offerId": offer_id,
                    "apiKeyName": sweep_api_key,
                    "ret": round(ret, 3),
                    "pf": round(pf, 3),
                    "dd": round(dd, 3),
                    "trades": trades,
                    "tradesPerDay": round(trades_per_day, 3),
                    "periodDays": period_days,
                    "equityPoints": equity_points,
                    "riskScore": risk_score,
                    "tradeFrequencyScore": freq_score,
                    "initialBalance": initial_balance,
                    "riskScaleMaxPercent": risk_max_pct,
                }
            }
        }, timeout=30)

        if patch_resp.status_code != 200:
            print(f"PATCH FAIL {patch_resp.status_code}")
            failed += 1
            continue

        updated += 1
        print(f"OK ret={round(ret,1)}% dd={round(dd,1)}% pf={round(pf,2)} trades={trades} eq={len(equity_points)}pts")

    except Exception as e:
        print(f"ERR: {e}")
        failed += 1

print(f"\n=== DONE: {updated} updated, {failed} failed out of {total} ===")

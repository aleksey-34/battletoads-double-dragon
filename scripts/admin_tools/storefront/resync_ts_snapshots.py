#!/usr/bin/env python3
"""
Resync TS card snapshots: run backtest for each of 10 TS cards,
then save via tsBacktestSnapshotsPatch (same as UI "Save TS" button).
"""
import json, requests, time

API = "http://localhost:3001"
AUTH = "Bearer btdd_admin_sweep_2026"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

# Load current TS snapshots from API
print("Loading offer store...")
resp = requests.get(f"{API}/api/saas/admin/offer-store", headers=HEADERS, timeout=30)
resp.raise_for_status()
store = resp.json()
ts_snaps = store.get("tsBacktestSnapshots", {})
print(f"Found {len(ts_snaps)} TS cards")

def downsample(arr, target=160):
    if len(arr) <= target:
        return arr
    step = len(arr) / target
    return [arr[int(i * step)] for i in range(target)]

updated = 0
failed = 0

for key, ts in ts_snaps.items():
    offer_ids = ts.get("offerIds", [])
    set_key = ts.get("setKey", key)
    system_name = ts.get("systemName", "")
    api_key_name = ts.get("apiKeyName", "")
    bs = ts.get("backtestSettings", {})
    risk = bs.get("riskScore", 5)
    freq = bs.get("tradeFrequencyScore", 5)
    balance = bs.get("initialBalance", 10000)
    risk_max = bs.get("riskScaleMaxPercent", 100)
    max_op = bs.get("maxOpenPositions", 0)

    print(f"\n=== {key} ({len(offer_ids)} offers, maxOP={max_op}) ===")
    print(f"  r={risk} f={freq} bal={balance} riskMax={risk_max}")

    try:
        bt_resp = requests.post(f"{API}/api/saas/admin/sweep-backtest-preview", headers=HEADERS, json={
            "kind": "algofund-ts",
            "setKey": set_key,
            "offerIds": offer_ids,
            "riskScore": risk,
            "tradeFrequencyScore": freq,
            "initialBalance": balance,
            "riskScaleMaxPercent": risk_max,
            "maxOpenPositions": max_op if max_op > 0 else None,
        }, timeout=120)

        if bt_resp.status_code == 429:
            print("  BUSY, waiting 5s...")
            time.sleep(5)
            bt_resp = requests.post(f"{API}/api/saas/admin/sweep-backtest-preview", headers=HEADERS, json={
                "kind": "algofund-ts",
                "setKey": set_key,
                "offerIds": offer_ids,
                "riskScore": risk,
                "tradeFrequencyScore": freq,
                "initialBalance": balance,
                "riskScaleMaxPercent": risk_max,
                "maxOpenPositions": max_op if max_op > 0 else None,
            }, timeout=120)

        if bt_resp.status_code != 200:
            print(f"  HTTP {bt_resp.status_code}: {bt_resp.text[:200]}")
            failed += 1
            continue

        data = bt_resp.json()
        preview = data.get("preview") or {}
        summary = preview.get("summary") or {}

        ret = float(summary.get("totalReturnPercent", 0))
        pf = float(summary.get("profitFactor", 0))
        dd = float(summary.get("maxDrawdownPercent", 0))
        trades = int(summary.get("tradesCount", 0))
        final_eq = float(summary.get("finalEquity", balance))

        # Extract equity
        equity_raw = preview.get("equity", [])
        equity_points = []
        for pt in equity_raw:
            if isinstance(pt, dict):
                val = pt.get("equity") if pt.get("equity") is not None else pt.get("value")
                if val is not None:
                    equity_points.append(round(float(val), 2))
            elif isinstance(pt, (int, float)):
                equity_points.append(round(float(pt), 2))
        equity_points = downsample(equity_points, 160)

        # Get period
        period = data.get("period", {})
        date_from = period.get("dateFrom", "")
        date_to = period.get("dateTo", "")
        # Calc period days
        try:
            from datetime import datetime
            d1 = datetime.strptime(date_from, "%Y-%m-%d")
            d2 = datetime.strptime(date_to, "%Y-%m-%d")
            period_days = max(1, (d2 - d1).days)
        except:
            period_days = 90

        result_offer_ids = [str(o.get("offerId", "")) for o in data.get("selectedOffers", [])]
        if result_offer_ids:
            offer_ids = list(set(result_offer_ids))

        print(f"  Backtest: ret={round(ret,1)}% dd={round(dd,1)}% pf={round(pf,2)} trades={trades} eq={len(equity_points)}pts")

        # Save via PATCH (same as UI)
        patch_resp = requests.patch(f"{API}/api/saas/admin/offer-store", headers=HEADERS, json={
            "tsBacktestSnapshotsPatch": {
                set_key: {
                    "apiKeyName": api_key_name,
                    "setKey": set_key,
                    "systemName": system_name or None,
                    "ret": round(ret, 3),
                    "pf": round(pf, 3),
                    "dd": round(dd, 3),
                    "trades": trades,
                    "tradesPerDay": round(trades / max(1, period_days), 3),
                    "periodDays": period_days,
                    "finalEquity": round(final_eq, 2),
                    "equityPoints": equity_points,
                    "offerIds": offer_ids,
                    "backtestSettings": {
                        "riskScore": risk,
                        "tradeFrequencyScore": freq,
                        "initialBalance": balance,
                        "riskScaleMaxPercent": risk_max,
                        "maxOpenPositions": max_op,
                    },
                }
            }
        }, timeout=30)

        if patch_resp.status_code != 200:
            print(f"  PATCH FAIL: {patch_resp.status_code}")
            failed += 1
            continue

        updated += 1
        print(f"  SAVED OK")

    except Exception as e:
        print(f"  ERROR: {e}")
        failed += 1

print(f"\n=== DONE: {updated} updated, {failed} failed out of {len(ts_snaps)} ===")

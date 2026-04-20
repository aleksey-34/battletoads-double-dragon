#!/usr/bin/env python3
"""
Re-backtest all 349 storefront offers with their stored slider settings
and update snapshots with actual backtest results (metrics + equity curves).
Runs sequentially to respect the single-backtest-at-a-time constraint.
"""
import json, sqlite3, requests, time, sys

API = "http://localhost:3001"
AUTH = "Bearer btdd_admin_sweep_2026"
DB = "/opt/battletoads-double-dragon/backend/database.db"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

# Load current snapshots
conn = sqlite3.connect(DB)
row = conn.execute("SELECT value FROM app_runtime_flags WHERE key=?", ["offer.store.review_snapshots"]).fetchone()
snapshots = json.loads(row[0])
conn.close()

print(f"Loaded {len(snapshots)} snapshots")
total = len(snapshots)
updated = 0
failed = 0
skipped = 0

for idx, (offer_key, snap) in enumerate(snapshots.items()):
    offer_id = snap.get("offerId", offer_key)
    risk_score = snap.get("riskScore", 5)
    freq_score = snap.get("tradeFrequencyScore", 5)
    initial_balance = snap.get("initialBalance", 10000)
    risk_max_pct = snap.get("riskScaleMaxPercent", 100)

    print(f"[{idx+1}/{total}] {offer_id[:50]} risk={risk_score} freq={freq_score} ... ", end="", flush=True)

    try:
        resp = requests.post(f"{API}/api/saas/admin/sweep-backtest-preview", headers=HEADERS, json={
            "kind": "offer",
            "offerId": offer_id,
            "riskScore": risk_score,
            "tradeFrequencyScore": freq_score,
            "initialBalance": initial_balance,
            "riskScaleMaxPercent": risk_max_pct,
        }, timeout=60)

        if resp.status_code == 429:
            print("BUSY, waiting 5s...")
            time.sleep(5)
            resp = requests.post(f"{API}/api/saas/admin/sweep-backtest-preview", headers=HEADERS, json={
                "kind": "offer",
                "offerId": offer_id,
                "riskScore": risk_score,
                "tradeFrequencyScore": freq_score,
                "initialBalance": initial_balance,
                "riskScaleMaxPercent": risk_max_pct,
            }, timeout=60)

        if resp.status_code != 200:
            print(f"HTTP {resp.status_code}")
            failed += 1
            continue

        data = resp.json()
        preview = data.get("preview") or {}
        summary = preview.get("summary") or {}
        equity = preview.get("equityCurve") or preview.get("equity") or []

        ret = summary.get("totalReturnPercent") or summary.get("ret")
        dd = summary.get("maxDrawdownPercent") or summary.get("dd")
        pf = summary.get("profitFactor") or summary.get("pf")
        trades = summary.get("tradesCount") or summary.get("trades")

        if ret is None:
            print(f"NO METRICS in response")
            failed += 1
            continue

        # Extract equity points as simple number array
        eq_points = []
        if isinstance(equity, list) and len(equity) > 0:
            for pt in equity:
                if isinstance(pt, dict):
                    eq_points.append(round(float(pt.get("equity") or pt.get("value") or pt.get("y") or 0), 2))
                elif isinstance(pt, (int, float)):
                    eq_points.append(round(float(pt), 2))

        # Downsample to 200 if too many
        if len(eq_points) > 200:
            step = len(eq_points) / 200
            eq_points = [eq_points[int(i * step)] for i in range(200)]

        # Update snapshot
        snap["ret"] = round(float(ret), 3)
        snap["dd"] = round(float(dd), 3)
        snap["pf"] = round(float(pf), 3)
        snap["trades"] = int(trades)
        if eq_points:
            snap["equityPoints"] = eq_points
        snap["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        updated += 1
        print(f"OK ret={snap['ret']}% dd={snap['dd']}% pf={snap['pf']} trades={snap['trades']} eq={len(eq_points)}pts")

    except Exception as e:
        print(f"ERROR: {e}")
        failed += 1
        continue

print(f"\n=== DONE: {updated} updated, {failed} failed, {skipped} skipped out of {total} ===")

if updated > 0:
    print("Saving to DB...")
    conn = sqlite3.connect(DB)
    conn.execute("UPDATE app_runtime_flags SET value=? WHERE key=?", [json.dumps(snapshots), "offer.store.review_snapshots"])
    conn.commit()
    conn.close()
    print(f"Saved {updated} updated snapshots to DB")
else:
    print("Nothing to save")

#!/usr/bin/env python3
"""Fix equity curves in storefront snapshots using real backtest data."""
import json, sqlite3, sys

DB = "/opt/battletoads-double-dragon/backend/database.db"
RESULTS = "/tmp/mass_backtest_results_v2.json"

data = json.load(open(RESULTS))
# Build lookup: strategy_id -> equityPoints array from all_results
eq_lookup = {}
for r in data.get("all_results", []):
    sid = str(r["id"])
    pts = r.get("equityPoints", 0)
    if isinstance(pts, list):
        eq_lookup[sid] = pts
    elif isinstance(pts, int) and pts > 0:
        # Points count only, no actual data — skip
        pass
# Also from winners
for w in data.get("winners", []):
    sid = str(w["id"])
    pts = w.get("equityPoints", 0)
    if isinstance(pts, list) and sid not in eq_lookup:
        eq_lookup[sid] = pts

print(f"Loaded {len(eq_lookup)} equity curves from results")

# Check if the equity data is actual arrays or just counts
sample = list(eq_lookup.values())[:3]
for s in sample:
    print(f"  Sample: type={type(s).__name__}, len={len(s) if isinstance(s, list) else 'N/A'}, first={s[:3] if isinstance(s, list) else s}")

if not eq_lookup:
    print("ERROR: No equity curve arrays found in results. equityPoints may be just counts (integers).")
    sys.exit(1)

# Read current snapshots from DB
conn = sqlite3.connect(DB)
row = conn.execute("SELECT value FROM app_runtime_flags WHERE key='offer.store.review_snapshots'").fetchone()
if not row:
    print("ERROR: No snapshots in DB")
    sys.exit(1)

snapshots = json.loads(row[0])
print(f"Found {len(snapshots)} offer snapshots in DB")

updated = 0
for snap in snapshots:
    oid = snap.get("offerId", "")
    # offerId format: DD_BattleToads_163784_BERASUSDT_1h or similar
    # strategy ID is the numeric part
    parts = oid.split("_")
    sid = None
    for p in parts:
        if p.isdigit() and len(p) >= 5:
            sid = p
            break
    if sid and sid in eq_lookup:
        real_eq = eq_lookup[sid]
        # Downsample to ~200 points max
        if len(real_eq) > 200:
            step = len(real_eq) / 200
            real_eq = [real_eq[int(i * step)] for i in range(200)]
        snap["equityPoints"] = real_eq
        updated += 1

print(f"Updated {updated}/{len(snapshots)} snapshots with real equity curves")

conn.execute("UPDATE app_runtime_flags SET value=? WHERE key='offer.store.review_snapshots'", [json.dumps(snapshots)])
conn.commit()
conn.close()
print("DONE — saved to DB")

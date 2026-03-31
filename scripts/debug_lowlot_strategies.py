#!/usr/bin/env python3
"""Debug why leverage fix is not stopping low-lot errors for IPUSDT/ZECUSDT."""
import sqlite3, json

DB = '/opt/battletoads-double-dragon/backend/database.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

ids = [80110, 80111, 80126, 80127]
for sid in ids:
    row = db.execute("SELECT * FROM strategies WHERE id=?", [sid]).fetchone()
    if not row:
        print(f"#{sid} NOT FOUND")
        continue
    r = dict(row)
    lot = max(r.get('lot_long_percent',0) or 0, r.get('lot_short_percent',0) or 0)
    lev = r.get('leverage', 1) or 1
    dep = r.get('max_deposit', 0) or 0
    fixed = r.get('fixed_lot', 0) or 0
    reinvest = r.get('reinvest_percent', 0) or 0
    notional = dep * (lot/100) * (1 + reinvest/100 if not fixed else 1) * lev
    print(f"#{sid} {r.get('name','?')[:50]}")
    print(f"  dep={dep} lot={lot}% lev={lev} fixed_lot={fixed} reinvest={reinvest}%")
    print(f"  => expected notional = {notional:.2f} USDT")
    print(f"  last_error: {str(r.get('last_error',''))[:100]}")
    print()

db.close()

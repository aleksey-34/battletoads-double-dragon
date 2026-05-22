#!/usr/bin/env python3
"""Diagnostic: Arthur, 5374535192, DCA, snapshots, mismatches."""
import sqlite3, json, os, sys

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", "database.db")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

def show(rows, cols=None):
    for r in rows:
        d = dict(r)
        if cols:
            parts = []
            for c in cols:
                parts.append("{}={}".format(c, d.get(c)))
            print("  " + " | ".join(parts))
        else:
            print("  " + json.dumps(d, default=str))

def banner(msg):
    print("\n" + "=" * 60)
    print("  " + msg)
    print("=" * 60)

banner("1. ARTHUR API KEYS")
q = "SELECT id, name, exchange, active FROM api_keys WHERE name LIKE '%artur%' OR name LIKE '%arthur%' ORDER BY id"
rows = cur.execute(q).fetchall()
show(rows, ["id", "name", "exchange", "active"])

for k in rows:
    ts = cur.execute(
        "SELECT id, name, is_active, max_open_positions, market_type FROM trading_systems WHERE api_key_id=?",
        (k["id"],),
    ).fetchall()
    for t in ts:
        print("  TS id={} name={} OP={} active={} mkt={}".format(
            t["id"], t["name"], t["max_open_positions"], t["is_active"], t["market_type"]
        ))
        ms = cur.execute(
            "SELECT tm.strategy_id, s.strategy_type, s.base_symbol, tm.weight, tm.is_enabled "
            "FROM trading_system_members tm JOIN strategies s ON s.id=tm.strategy_id "
            "WHERE tm.system_id=?",
            (t["id"],),
        ).fetchall()
        for m in ms:
            print("    sid={} {} {} w={} en={}".format(
                m["strategy_id"], m["strategy_type"], m["base_symbol"], m["weight"], m["is_enabled"]
            ))

banner("2. CLIENT 5374535192")
prows = cur.execute(
    "SELECT * FROM algofund_profiles WHERE telegram_id LIKE '%5374535192%' ORDER BY id DESC"
).fetchall()
show(prows)

banner("3. DCA STRATEGIES")
dca = cur.execute(
    "SELECT id, name, base_symbol, dca_base_amount_usdt, dca_step_percent, dca_max_orders, "
    "dca_order_multiplier, dca_tp_percent, dca_sl_percent, is_active "
    "FROM strategies WHERE strategy_type='dca' ORDER BY id"
).fetchall()
show(dca, ["id", "name", "base_symbol", "dca_base_amount_usdt", "dca_step_percent", "dca_max_orders", "is_active"])

mems = cur.execute(
    "SELECT tm.id, ts.name as ts_name, tm.strategy_id, s.base_symbol, s.dca_base_amount_usdt, tm.weight, tm.is_enabled "
    "FROM trading_system_members tm "
    "JOIN trading_systems ts ON ts.id=tm.system_id "
    "JOIN strategies s ON s.id=tm.strategy_id "
    "WHERE s.strategy_type='dca'"
).fetchall()
if mems:
    print("\n  TS members with DCA:")
    show(mems, ["id", "ts_name", "strategy_id", "base_symbol", "dca_base_amount_usdt", "weight", "is_enabled"])

banner("4. RECENT SNAPSHOTS")
snaps = cur.execute(
    "SELECT id, snapshot_key, created_at FROM ts_backtest_snapshots ORDER BY id DESC LIMIT 15"
).fetchall()
show(snaps, ["id", "snapshot_key", "created_at"])

banner("5. ENABLED MISMATCHES (artur keys)")
mm = cur.execute(
    "SELECT s.id, s.name, s.is_active, s.auto_update, s.strategy_type, s.base_symbol, a.name as key_name "
    "FROM strategies s JOIN api_keys a ON a.id=s.api_key_id "
    "WHERE s.is_active!=s.auto_update AND a.name LIKE '%artur%' LIMIT 10"
).fetchall()
show(mm, ["id", "name", "is_active", "auto_update", "strategy_type", "base_symbol", "key_name"])

conn.close()
print("\nDone.")
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
q = "SELECT id, name, exchange FROM api_keys WHERE name LIKE '%artur%' OR name LIKE '%arthur%' ORDER BY id"
rows = cur.execute(q).fetchall()
show(rows, ["id", "name", "exchange"])

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
# Ищем через api_key_name + JOIN с tenants
q2 = """
SELECT af.id, af.tenant_id, t.display_name, t.slug, t.status AS tenant_status,
       af.risk_multiplier, af.requested_enabled, af.actual_enabled,
       af.assigned_api_key_name, af.execution_api_key_name, af.published_system_name
FROM algofund_profiles af
JOIN tenants t ON t.id=af.tenant_id
WHERE af.assigned_api_key_name LIKE '%5374535192%'
   OR af.execution_api_key_name LIKE '%5374535192%'
   OR t.display_name LIKE '%5374535192%'
   OR t.slug LIKE '%5374535192%'
ORDER BY af.id DESC
"""
prows = cur.execute(q2).fetchall()
if prows:
    show(prows)
else:
    print("  NOT FOUND via api_key/tenant name — dumping all algofund_profiles...")
    all_af = cur.execute("SELECT af.*, t.display_name, t.slug FROM algofund_profiles af JOIN tenants t ON t.id=af.tenant_id ORDER BY af.id DESC LIMIT 30").fetchall()
    show(all_af)

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

banner("4. SNAPSHOTS (app_runtime_flags)")
# ts_backtest_snapshots — JSON-ключ в app_runtime_flags
snap_flag = cur.execute(
    "SELECT value FROM app_runtime_flags WHERE key='offer.store.ts_backtest_snapshots'"
).fetchone()
if snap_flag:
    try:
        snap_map = json.loads(snap_flag["value"])
    except Exception as e:
        print(f"  JSON parse error: {e}")
        snap_map = {}
    print(f"  Total snapshot keys: {len(snap_map)}")
    # Показать все ключи + основные метрики
    for i, (k, v) in enumerate(snap_map.items()):
        if isinstance(v, dict):
            ret = v.get("ret") or v.get("totalReturnPercent") or v.get("total_return_percent")
            dd = v.get("dd") or v.get("maxDrawdownPercent") or v.get("max_drawdown_percent")
            trades = v.get("trades") or v.get("tradesCount") or v.get("trades_count")
            pf = v.get("pf") or v.get("profitFactor") or v.get("profit_factor")
            print(f"  [{i}] key={k}")
            print(f"      ret={ret} dd={dd} trades={trades} pf={pf}")
        else:
            print(f"  [{i}] key={k} value={str(v)[:100]}")
        if i >= 20:
            print(f"  ... and {len(snap_map)-20} more keys")
            break
else:
    print("  NO snapshots flag found!")

# Также одиночный снепшот
snap_one = cur.execute(
    "SELECT value FROM app_runtime_flags WHERE key='offer.store.ts_backtest_snapshot'"
).fetchone()
if snap_one and snap_one["value"] and snap_one["value"] != "null":
    print("\n  SINGLE snapshot (offer.store.ts_backtest_snapshot):")
    try:
        print(f"    {snap_one['value'][:500]}")
    except:
        print("    (binary/unparseable)")

banner("5. ENABLED MISMATCHES (artur keys)")
mm = cur.execute(
    "SELECT s.id, s.name, s.is_active, s.auto_update, s.strategy_type, s.base_symbol, a.name as key_name "
    "FROM strategies s JOIN api_keys a ON a.id=s.api_key_id "
    "WHERE s.is_active!=s.auto_update AND a.name LIKE '%artur%' LIMIT 10"
).fetchall()
show(mm, ["id", "name", "is_active", "auto_update", "strategy_type", "base_symbol", "key_name"])

conn.close()
print("\nDone.")
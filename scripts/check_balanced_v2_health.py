#!/usr/bin/env python3
"""Health check for balanced-portfolio-v2 client materializations."""
import json
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "/opt/battletoads-double-dragon/backend/database.db"

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
c = db.cursor()

issues = []
ok = []

c.execute(
    """
SELECT t.id, t.slug, ap.actual_enabled, ap.requested_enabled,
       COALESCE(NULLIF(ap.execution_api_key_name,''), NULLIF(ap.assigned_api_key_name,''), t.assigned_api_key_name) as api_key
FROM algofund_profiles ap
JOIN tenants t ON t.id=ap.tenant_id
WHERE ap.published_system_name LIKE '%balanced-portfolio-v2%' AND ap.requested_enabled=1
ORDER BY t.slug
"""
)
clients = [dict(r) for r in c.fetchall()]
print(f"=== {len(clients)} CLIENTS on balanced-portfolio-v2 ===\n")

for cl in clients:
    slug = cl["slug"]
    ak = cl["api_key"]
    ts_name = f"ALGOFUND::{slug}"
    row_issues = []
    ts = None
    members = 0
    total_active = 0
    archived = 0

    c.execute("SELECT id FROM api_keys WHERE name=?", (ak,))
    ak_row = c.fetchone()
    if not ak_row:
        row_issues.append(f"api_key missing: {ak}")
        print(f"ISSUE {slug:30} | {'; '.join(row_issues)}")
        issues.append((slug, row_issues))
        continue
    ak_id = ak_row["id"]

    c.execute(
        "SELECT id, max_open_positions, is_active, updated_at FROM trading_systems WHERE name=? AND api_key_id=?",
        (ts_name, ak_id),
    )
    ts_row = c.fetchone()
    if not ts_row:
        row_issues.append(f"no TS {ts_name}")
    else:
        ts = dict(ts_row)
        if int(ts["max_open_positions"]) != 10:
            row_issues.append(f"OP={ts['max_open_positions']}")
        if int(ts["is_active"]) != 1:
            row_issues.append("TS inactive")

        c.execute("SELECT COUNT(*) n FROM trading_system_members WHERE system_id=?", (ts["id"],))
        members = c.fetchone()["n"]
        if members != 38:
            row_issues.append(f"members={members}")

        c.execute(
            """
          SELECT COUNT(*) n FROM trading_system_members tsm
          JOIN strategies s ON s.id=tsm.strategy_id
          WHERE tsm.system_id=? AND s.is_archived=0 AND s.is_active=1
        """,
            (ts["id"],),
        )
        active_in_ts = c.fetchone()["n"]
        if active_in_ts != members:
            row_issues.append(f"inactive_in_ts={members - active_in_ts}")

        c.execute(
            """
          SELECT COUNT(*) n FROM strategies s
          WHERE s.api_key_id=? AND s.is_archived=0 AND s.is_active=1
            AND s.id NOT IN (SELECT strategy_id FROM trading_system_members WHERE system_id=?)
        """,
            (ak_id, ts["id"]),
        )
        orphan_n = c.fetchone()["n"]
        if orphan_n:
            row_issues.append(f"orphan_active={orphan_n}")

        c.execute(
            """
          SELECT COUNT(*) n FROM (
            SELECT s.name FROM trading_system_members tsm
            JOIN strategies s ON s.id=tsm.strategy_id
            WHERE tsm.system_id=?
            GROUP BY s.name HAVING COUNT(*)>1
          )
        """,
            (ts["id"],),
        )
        dup_n = c.fetchone()["n"]
        if dup_n:
            row_issues.append(f"dup_members={dup_n}")

    c.execute("SELECT COUNT(*) n FROM strategies WHERE api_key_id=? AND is_archived=0 AND is_active=1", (ak_id,))
    total_active = c.fetchone()["n"]
    c.execute("SELECT COUNT(*) n FROM strategies WHERE api_key_id=? AND is_archived=1", (ak_id,))
    archived = c.fetchone()["n"]

    if int(cl["actual_enabled"]) != 1:
        row_issues.append(f"actual_enabled={cl['actual_enabled']}")

    status = "OK" if not row_issues else "ISSUE"
    if row_issues:
        issues.append((slug, row_issues))
        ts_info = ""
        if ts:
            ts_info = f" OP={ts['max_open_positions']} mem={members}"
        print(f"{status:5} {slug:30}{ts_info} | {'; '.join(row_issues)} (active={total_active} arch={archived})")
    else:
        ok.append(slug)
        print(
            f"{status:5} {slug:30} OP={ts['max_open_positions']} mem={members} "
            f"active={total_active} arch={archived} ts_upd={ts['updated_at']}"
        )

print(f"\n=== SUMMARY: OK={len(ok)} ISSUES={len(issues)} ===")

c.execute("SELECT metadata_json, updated_at FROM master_cards WHERE code LIKE '%BALANCED-PORTFOLIO-V2%'")
mc = c.fetchone()
if mc:
    meta = json.loads(mc["metadata_json"] or "{}")
    print(
        f"\nMASTER CARD: OP={meta.get('maxOpenPositions')} lot={meta.get('lotPercentOverride')} "
        f"reinvest={meta.get('reinvestPercent')} updated={mc['updated_at']}"
    )

c.execute(
    """
SELECT ts.id, ts.max_open_positions, COUNT(tsm.strategy_id) members
FROM trading_systems ts
JOIN api_keys ak ON ak.id=ts.api_key_id
LEFT JOIN trading_system_members tsm ON tsm.system_id=ts.id
WHERE ts.name='ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2'
GROUP BY ts.id
"""
)
for r in c.fetchall():
    print(f"MASTER TS: id={r['id']} OP={r['max_open_positions']} members={r['members']}")

c.execute(
    """
SELECT COUNT(*) n FROM trading_system_members tsm
JOIN strategies s ON s.id=tsm.strategy_id
JOIN trading_systems ts ON ts.id=tsm.system_id
WHERE ts.name='ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2' AND s.strategy_type='dca'
"""
)
print(f"Master DCA members: {c.fetchone()['n']}")

# Orphan detail for keys with extra active strategies
print("\n=== ORPHAN ACTIVE STRATEGIES (top keys) ===")
for cl in clients:
    slug = cl["slug"]
    ak = cl["api_key"]
    ts_name = f"ALGOFUND::{slug}"
    c.execute("SELECT id FROM api_keys WHERE name=?", (ak,))
    ak_row = c.fetchone()
    if not ak_row:
        continue
    ak_id = ak_row["id"]
    c.execute("SELECT id FROM trading_systems WHERE name=? AND api_key_id=?", (ts_name, ak_id))
    ts_row = c.fetchone()
    if not ts_row:
        continue
    ts_id = ts_row["id"]
    c.execute(
        """
      SELECT s.id, s.strategy_type, s.base_symbol, substr(s.name,1,80) as name
      FROM strategies s
      WHERE s.api_key_id=? AND s.is_archived=0 AND s.is_active=1
        AND s.id NOT IN (SELECT strategy_id FROM trading_system_members WHERE system_id=?)
      LIMIT 5
    """,
        (ak_id, ts_id),
    )
    orphans = c.fetchall()
    if orphans:
        print(f"\n{slug} ({len(orphans)}+ orphans):")
        for o in orphans:
            print(f"  id={o['id']} {o['strategy_type']} {o['base_symbol']} {o['name']}")

# Position snapshots without strategy link
c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%position%'")
pos_tables = [r[0] for r in c.fetchall()]
print(f"\n=== POSITION TABLES: {pos_tables} ===")

if "position_snapshots" in pos_tables:
    c.execute("PRAGMA table_info(position_snapshots)")
    cols = [r[1] for r in c.fetchall()]
    print(f"position_snapshots cols: {cols}")
    if "strategy_id" in cols:
        c.execute(
            """
          SELECT ps.api_key_name, COUNT(*) n
          FROM position_snapshots ps
          LEFT JOIN strategies s ON s.id=ps.strategy_id
          WHERE ps.size != 0 AND ps.size IS NOT NULL
            AND (ps.strategy_id IS NULL OR s.id IS NULL OR s.is_archived=1)
          GROUP BY ps.api_key_name
        """
        )
        unlinked = c.fetchall()
        if unlinked:
            print("Unlinked open positions in snapshots:")
            for r in unlinked:
                print(f"  {r['api_key_name']}: {r['n']}")
        else:
            print("No unlinked open positions in position_snapshots")

if "positions" in pos_tables:
    c.execute("PRAGMA table_info(positions)")
    cols = [r[1] for r in c.fetchall()]
    print(f"positions cols: {cols}")

# Deep dive: master vs client member diff
print("\n=== MASTER vs CLIENT MEMBER ANALYSIS ===")
c.execute(
    """
SELECT s.base_symbol, s.strategy_type, s.is_active, s.is_archived
FROM trading_system_members tsm
JOIN strategies s ON s.id=tsm.strategy_id
JOIN trading_systems ts ON ts.id=tsm.system_id
WHERE ts.name='ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2'
ORDER BY s.base_symbol
"""
)
master = [dict(r) for r in c.fetchall()]
master_markets = {m["base_symbol"] for m in master}
print(f"Master: {len(master)} members, {len(master_markets)} markets, active={sum(1 for m in master if m['is_active'] and not m['is_archived'])}")

sample_slugs = ["ruslan", "artursk-6659194994", "artursk-5497016674", "artursk-5374535192-n"]
for slug in sample_slugs:
    c.execute(
        """
      SELECT COALESCE(NULLIF(ap.execution_api_key_name,''), NULLIF(ap.assigned_api_key_name,''), t.assigned_api_key_name) ak
      FROM algofund_profiles ap JOIN tenants t ON t.id=ap.tenant_id
      WHERE t.slug=?
    """,
        (slug,),
    )
    row = c.fetchone()
    if not row:
        continue
    ak = row["ak"]
    c.execute("SELECT id FROM api_keys WHERE name=?", (ak,))
    ak_id = c.fetchone()["id"]
    c.execute("SELECT id FROM trading_systems WHERE name=? AND api_key_id=?", (f"ALGOFUND::{slug}", ak_id))
    ts_row = c.fetchone()
    if not ts_row:
        print(f"\n{slug}: NO TS")
        continue
    ts_id = ts_row["id"]
    c.execute(
        """
      SELECT s.base_symbol, s.strategy_type, s.is_active, s.is_archived
      FROM trading_system_members tsm JOIN strategies s ON s.id=tsm.strategy_id
      WHERE tsm.system_id=?
    """,
        (ts_id,),
    )
    client = [dict(r) for r in c.fetchall()]
    client_markets = {x["base_symbol"] for x in client}
    missing = sorted(master_markets - client_markets)
    inactive = [x for x in client if not x["is_active"] or x["is_archived"]]
    print(
        f"\n{slug}: mem={len(client)} active_in_ts={len(client)-len(inactive)} "
        f"missing_markets={len(missing)} inactive_in_ts={len(inactive)}"
    )
    if missing:
        print(f"  missing: {missing[:8]}{'...' if len(missing)>8 else ''}")
    if inactive:
        for x in inactive[:5]:
            print(f"  inactive: {x['base_symbol']} {x['strategy_type']} act={x['is_active']} arch={x['is_archived']}")

# Global: inactive-in-TS pattern across all clients
print("\n=== RUNNABLE STRATEGIES (active+not archived in TS) ===")
runnable_counts = []
for cl in clients:
    slug = cl["slug"]
    ak = cl["api_key"]
    c.execute("SELECT id FROM api_keys WHERE name=?", (ak,))
    ak_row = c.fetchone()
    if not ak_row:
        continue
    ak_id = ak_row["id"]
    c.execute("SELECT id FROM trading_systems WHERE name=? AND api_key_id=?", (f"ALGOFUND::{slug}", ak_id))
    ts_row = c.fetchone()
    if not ts_row:
        continue
    ts_id = ts_row["id"]
    c.execute(
        """
      SELECT COUNT(*) cnt FROM trading_system_members tsm JOIN strategies s ON s.id=tsm.strategy_id
      WHERE tsm.system_id=? AND s.is_active=1 AND s.is_archived=0
    """,
        (ts_id,),
    )
    n = c.fetchone()["cnt"]
    runnable_counts.append((slug, n))

for slug, n in runnable_counts:
    flag = " !" if n < 34 else ""
    print(f"  {slug:30} runnable={n}{flag}")
print(f"min={min(x[1] for x in runnable_counts)} max={max(x[1] for x in runnable_counts)} avg={sum(x[1] for x in runnable_counts)/len(runnable_counts):.1f}")

missing_tru = []
arch_bera = []
for cl in clients:
    slug = cl["slug"]
    ak = cl["api_key"]
    c.execute("SELECT id FROM api_keys WHERE name=?", (ak,))
    ak_id = c.fetchone()["id"]
    c.execute("SELECT id FROM trading_systems WHERE name=? AND api_key_id=?", (f"ALGOFUND::{slug}", ak_id))
    ts_id = c.fetchone()["id"]
    c.execute(
        """
      SELECT COUNT(*) cnt FROM trading_system_members tsm JOIN strategies s ON s.id=tsm.strategy_id
      WHERE tsm.system_id=? AND s.base_symbol='TRUUSDT'
    """,
        (ts_id,),
    )
    if c.fetchone()["cnt"] == 0:
        missing_tru.append(slug)
    c.execute(
        """
      SELECT COUNT(*) cnt FROM trading_system_members tsm JOIN strategies s ON s.id=tsm.strategy_id
      WHERE tsm.system_id=? AND s.base_symbol='BERAUSDT' AND s.is_archived=1
    """,
        (ts_id,),
    )
    if c.fetchone()["cnt"] > 0:
        arch_bera.append(slug)

print(f"\nMissing TRUUSDT in TS: {len(missing_tru)}/19")
print(f"BERAUSDT archived but still in TS members: {len(arch_bera)}/19")

print("\n=== INACTIVE-IN-TS BY MARKET (all clients) ===")
c.execute(
    """
SELECT s.base_symbol, s.strategy_type, COUNT(*) n
FROM trading_system_members tsm
JOIN strategies s ON s.id=tsm.strategy_id
JOIN trading_systems ts ON ts.id=tsm.system_id
JOIN algofund_profiles ap ON ap.published_system_name LIKE '%balanced-portfolio-v2%'
JOIN tenants t ON t.slug=replace(ts.name,'ALGOFUND::','')
WHERE ap.tenant_id=t.id AND ap.requested_enabled=1
  AND (s.is_active=0 OR s.is_archived=1)
GROUP BY s.base_symbol, s.strategy_type
ORDER BY n DESC
LIMIT 15
"""
)
for r in c.fetchall():
    print(f"  {r['base_symbol']:12} {r['strategy_type']:12} clients={r['n']}")

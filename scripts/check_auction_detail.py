import sqlite3, json
db = sqlite3.connect("/opt/battletoads-double-dragon/backend/database.db")
cur = db.cursor()

# Schema check
print("=== STRATEGIES SCHEMA ===")
cur.execute("PRAGMA table_info(strategies)")
cols = [r[1] for r in cur.fetchall()]
print("Columns:", cols)

# AUCTIONUSDT strategy details (BTDD_D1) — all columns as dict
print("\n=== AUCTIONUSDT STRATEGY CONFIG (BTDD_D1) ===")
cur.execute("""
    SELECT s.* FROM strategies s JOIN api_keys ak ON s.api_key_id=ak.id
    WHERE ak.name='BTDD_D1' AND s.base_symbol='AUCTIONUSDT' AND s.is_runtime=1
    ORDER BY s.id
""")
desc = [d[0] for d in cur.description]
for row in cur.fetchall():
    d = dict(zip(desc, row))
    print(f"\nSID{d['id']} | type={d.get('strategy_type')} | state={d.get('state')}")
    for k in ['entry_ratio', 'take_profit_percent', 'price_channel_length', 'last_action',
              'max_deposit', 'lot_long_percent', 'lot_short_percent', 'detection_source',
              'sl_type', 'sl_center_type', 'sl_atr_mult', 'entry_price', 'current_position_size']:
        if k in d:
            print(f"  {k} = {d[k]}")

# Trade event time range
print("\n=== LIVE TRADE TIME RANGE ===")
cur.execute("SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM live_trade_events")
row = cur.fetchone()
print(f"Total events: {row[0]}")
print(f"First: {row[1]}")
print(f"Last: {row[2]}")

# Recent error entries in strategies
print("\n=== STRATEGIES WITH ERRORS ===")
cur.execute("""
    SELECT s.id, ak.name, s.base_symbol, s.quote_symbol, s.last_error
    FROM strategies s JOIN api_keys ak ON s.api_key_id=ak.id
    WHERE s.is_runtime=1 AND s.is_archived=0 AND s.last_error IS NOT NULL AND s.last_error != ''
    ORDER BY s.id DESC LIMIT 20
""")
for r in cur.fetchall():
    print(f"  SID{r[0]} {r[1]} {r[2]}/{r[3]}: {str(r[4])[:150]}")

# Current Donchian levels for AUCTIONUSDT — check monitoring_snapshots
print("\n=== AUCTIONUSDT LATEST MONITORING ===")
cur.execute("""
    SELECT id, created_at, json_extract(snapshot_data, '$.positions') as positions
    FROM monitoring_snapshots 
    ORDER BY id DESC LIMIT 1
""")
row = cur.fetchone()
if row:
    print(f"Snapshot #{row[0]} at {row[1]}")
    if row[2]:
        positions = json.loads(row[2])
        for p in positions:
            sym = p.get('symbol','')
            if 'AUCTION' in sym:
                print(f"  {sym}: {json.dumps(p, indent=2)}")

# Also check if old strategies (< 80000) exist at all
print("\n=== ALL OLD STRATEGIES (SID < 80000, runtime, not archived) ===")
cur.execute("""
    SELECT s.id, ak.name, s.base_symbol, s.strategy_type, s.state
    FROM strategies s JOIN api_keys ak ON s.api_key_id=ak.id
    WHERE s.id < 80000 AND s.is_runtime=1 AND s.is_archived=0
    ORDER BY ak.name, s.id
""")
rows = cur.fetchall()
if rows:
    for r in rows:
        print(f"  SID{r[0]} | {r[1]} | {r[2]} | {r[3]} | state={r[4]}")
else:
    print("  NONE — all old strategies archived/deactivated")

db.close()

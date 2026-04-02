import sqlite3, json

db = sqlite3.connect("/opt/battletoads-double-dragon/backend/database.db")
cur = db.cursor()

# 1. Strategy states — BERA/ZEC synth strategies
print("=== BERA/ZEC SYNTH STRATEGIES (all accounts) ===")
cur.execute("""
    SELECT s.id, ak.name, s.base_symbol, s.quote_symbol, s.strategy_type, s.state, s.last_action, s.last_error, s.entry_ratio
    FROM strategies s JOIN api_keys ak ON s.api_key_id = ak.id
    WHERE s.is_runtime=1 AND s.is_archived=0
      AND s.base_symbol='BERAUSDT' AND s.quote_symbol='ZECUSDT'
    ORDER BY ak.name, s.id
""")
for r in cur.fetchall():
    print(f"SID{r[0]} | {r[1]} | {r[4]} | state={r[5]} | action={r[6]} | error={str(r[7])[:120]} | entry_ratio={r[8]}")

# 2. AUCTIONUSDT strategies — all
print("\n=== AUCTIONUSDT STRATEGIES (all accounts) ===")
cur.execute("""
    SELECT s.id, ak.name, s.base_symbol, s.strategy_type, s.state, s.last_action, s.last_error, s.entry_ratio,
           s.take_profit_percent, s.price_channel_length, s.detection_source
    FROM strategies s JOIN api_keys ak ON s.api_key_id = ak.id
    WHERE s.is_runtime=1 AND s.is_archived=0 AND s.base_symbol='AUCTIONUSDT'
    ORDER BY ak.name, s.id
""")
for r in cur.fetchall():
    print(f"SID{r[0]} | {r[1]} | {r[3]} | state={r[4]} | action={r[5]} | tp={r[8]}% | ch_len={r[9]} | detect={r[10]} | entry_ratio={r[7]}")

# 3. Get live_trade_events schema
print("\n=== LIVE_TRADE_EVENTS SCHEMA ===")
cur.execute("PRAGMA table_info(live_trade_events)")
cols = [r[1] for r in cur.fetchall()]
print("Columns:", cols)

# 4. Live trade events for AUCTIONUSDT — recent
print("\n=== AUCTIONUSDT LIVE TRADES (recent 30) ===")
cur.execute("""
    SELECT * FROM live_trade_events
    WHERE source_symbol='AUCTIONUSDT'
    ORDER BY rowid DESC LIMIT 30
""")
for r in cur.fetchall():
    print(r)

# 5. Backtest #62 trades summary
print("\n=== BACKTEST #62 TRADE FREQUENCY ===")
cur.execute("SELECT trades_json FROM backtest_runs WHERE id=62")
row = cur.fetchone()
if row and row[0]:
    trades = json.loads(row[0])
    from collections import Counter
    strat_counts = Counter()
    for t in trades:
        strat_counts[t.get('strategyName','')] += 1
    for name, cnt in strat_counts.most_common():
        short_name = name.split('::')[-1] if '::' in name else name
        print(f"  {short_name}: {cnt} trades")
    print(f"  TOTAL: {len(trades)} trades in ~200 days")
    print(f"  Avg: {len(trades)/200:.1f} trades/day")

# 6. Count live trades per strategy
print("\n=== LIVE TRADE FREQUENCY (all time) ===")
cur.execute("""
    SELECT strategy_id, source_symbol, trade_type, COUNT(*)
    FROM live_trade_events
    GROUP BY strategy_id, source_symbol, trade_type
    ORDER BY COUNT(*) DESC LIMIT 40
""")
for r in cur.fetchall():
    print(f"  SID{r[0]} {r[1]} {r[2]}: {r[3]}")

# 7. Old strategies still active on BTDD_D1
print("\n=== OLD STRATEGIES STILL ACTIVE ON BTDD_D1 ===")
cur.execute("""
    SELECT s.id, s.base_symbol, s.quote_symbol, s.strategy_type, s.state, s.last_action
    FROM strategies s JOIN api_keys ak ON s.api_key_id=ak.id
    WHERE ak.name='BTDD_D1' AND s.is_runtime=1 AND s.is_archived=0 AND s.id < 80000
    ORDER BY s.id
""")
for r in cur.fetchall():
    print(f"  SID{r[0]} {r[1]}/{r[2]} {r[3]} state={r[4]} action={r[5]}")

db.close()

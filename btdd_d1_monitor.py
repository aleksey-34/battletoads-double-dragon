#!/usr/bin/env python3
"""
BTDD_D1 Monitor — Bybit Demo account health check
Checks last N minutes of combined.log + DB state
Usage: python3 btdd_d1_monitor.py [minutes=30]
"""
import sqlite3, sys, re, json
from datetime import datetime, timezone
from collections import defaultdict

MINS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
LOG = '/opt/battletoads-double-dragon/backend/logs/combined.log'
DB = '/opt/battletoads-double-dragon/backend/database.db'

D1_STRATEGIES = {80204: 'ARB/TIA', 80207: 'SUI/AVAX'}
D1_KEY = 'BTDD_D1'

NOW = datetime.now(timezone.utc)

# ──────────────── DB state ────────────────
c = sqlite3.connect(DB)
print(f"{'='*60}")
print(f"  BTDD_D1 Monitor — {NOW.strftime('%Y-%m-%d %H:%M:%S UTC')}")
print(f"  Log window: last {MINS} minutes")
print(f"{'='*60}")

print("\n■ BTDD_D1 Strategy States (DB)")
ok = True
for sid, pair in D1_STRATEGIES.items():
    row = c.execute("SELECT name, is_active, state, last_action, last_error, updated_at FROM strategies WHERE id=?", (sid,)).fetchone()
    if not row:
        print(f"  ⚠️  id={sid} {pair} — NOT FOUND")
        ok = False
        continue
    name, active, state, last_action, last_error, upd = row
    icon = '✅' if active and state not in ('mixed',) else '⚠️'
    print(f"  {icon} id={sid} {pair} active={active} state={state}")
    if last_action:
        print(f"     last_action={last_action}")
    if last_error:
        print(f"     ⚠️  last_error={last_error[:100]}")

# BTDD_D1 info
ak_row = c.execute("SELECT exchange, demo, testnet FROM api_keys WHERE name='BTDD_D1'").fetchone()
if ak_row:
    print(f"\n■ BTDD_D1: exchange={ak_row[0]} demo={ak_row[1]} testnet={ak_row[2]}")

# ──────────────── Log analysis ────────────────
print(f"\n■ Log Analysis (last {MINS}m from combined.log)")

events = []
errors = []
trades = []
mixed_alerts = []
cycle_count = 0
last_cycle_ts = None
ZS_IDS = [str(s) for s in D1_STRATEGIES.keys()]

# Read last chunk of log (tail approach — read last 5MB)
try:
    with open(LOG, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        chunk = min(5 * 1024 * 1024, size)
        f.seek(-chunk, 2)
        raw = f.read().decode('utf-8', errors='replace')

    lines = raw.splitlines()
    cutoff_str = None

    for line in lines:
        # Parse JSON log lines: {"level":"info","message":"...","timestamp":"..."}
        ts_m = re.search(r'"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})', line)
        if not ts_m:
            continue
        try:
            ts = datetime.fromisoformat(ts_m.group(1)).replace(tzinfo=timezone.utc)
        except:
            continue
        age_min = (NOW - ts).total_seconds() / 60
        if age_min > MINS:
            continue

        ll = line.lower()

        # Cycle count
        if 'auto strategy cycle' in ll or 'runtimecycle' in ll:
            cycle_count += 1
            last_cycle_ts = ts

        # Mixed state alert
        if 'mixed' in ll and ('btdd-d1' in ll or any(s in ll for s in ZS_IDS)):
            mixed_alerts.append(line[:200])

        # Errors (D1 related)
        if ('"level":"error"' in ll or 'exception' in ll) and ('btdd-d1' in ll or 'arbusd' in ll or 'suiusd' in ll or any(s in ll for s in ZS_IDS)):
            errors.append(line[:200])

        # Trades / entries / exits
        if any(kw in ll for kw in ['openposition', 'closeposition', 'trade_event', 'live_trade', 'open position', 'close position']):
            if any(s in ll for s in ZS_IDS) or 'btdd-d1' in ll or 'arbusd' in ll or 'suiusd' in ll:
                trades.append((ts, line[:200]))

        # State changes
        if any(kw in ll for kw in ['state":"long', 'state":"short', 'state":"flat', '"long"', '"short"']) and any(s in line for s in [str(s) for s in D1_STRATEGIES.keys()]):
            events.append((ts, line[:180]))

    # Runtime cycle health
    print(f"\n  Runtime cycles in window: {cycle_count}")
    if last_cycle_ts:
        lag = (NOW - last_cycle_ts).total_seconds()
        icon = '✅' if lag < 90 else '⚠️'
        print(f"  {icon} Last cycle: {last_cycle_ts.strftime('%H:%M:%S')} ({lag:.0f}s ago)")
    else:
        print(f"  ⚠️  No runtime cycles detected in last {MINS}m!")

    # Mixed state alerts
    if mixed_alerts:
        print(f"\n  🔴 MIXED STATE ALERTS ({len(mixed_alerts)}):")
        for a in mixed_alerts[-5:]:
            print(f"    {a[:160]}")
    else:
        print(f"\n  ✅ No mixed-state alerts in window")

    # Errors
    if errors:
        print(f"\n  🔴 ERRORS ({len(errors)}):")
        for e in errors[-5:]:
            print(f"    {e[:160]}")
    else:
        print(f"  ✅ No D1 errors in window")

    # Trades
    if trades:
        print(f"\n  📊 Trade events ({len(trades)}):")
        for ts, t in trades[-10:]:
            print(f"    {ts.strftime('%H:%M:%S')} {t[:160]}")
    else:
        print(f"  ℹ️  No trade events in window (strategies may be waiting for signal)")

    # State changes
    if events:
        print(f"\n  📋 State changes ({len(events)}):")
        for ts, e in events[-10:]:
            print(f"    {ts.strftime('%H:%M:%S')} {e[:140]}")

except Exception as ex:
    print(f"  ⚠️  Log read error: {ex}")

# ──────────────── Summary ────────────────
print(f"\n{'='*60}")
d1_active = c.execute("SELECT COUNT(*) FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id WHERE ak.name='BTDD_D1' AND s.is_active=1").fetchone()[0]
d1_mixed = c.execute("SELECT COUNT(*) FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id WHERE ak.name='BTDD_D1' AND s.state='mixed'").fetchone()[0]

health = '✅ HEALTHY' if (d1_active == 2 and d1_mixed == 0 and not mixed_alerts and not errors) else '⚠️ NEEDS REVIEW'
print(f"  OVERALL: {health}")
print(f"  Active strategies: {d1_active}/2 | Mixed states: {d1_mixed} | Log errors: {len(errors)}")
print(f"{'='*60}")

c.close()

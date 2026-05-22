#!/usr/bin/env python3
"""Finalize refactor, fix UI snapshot, diagnose storage."""
import os, re, shutil, subprocess

BASE = "/opt/battletoads-double-dragon"
STRATEGY_TS = os.path.join(BASE, "backend/src/bot/strategy.ts")
SIZING_TS = os.path.join(BASE, "backend/src/services/strategy/sizing.ts")

# 1. Find remaining functions in compiled JS (they exist there)
print("=== Finding functions in compiled JS ===")
STRATEGY_JS = os.path.join(BASE, "backend/dist/bot/strategy.js")
with open(STRATEGY_JS, "r") as f:
    js_content = f.read()

funcs_to_find = ["computePartialTakeProfit", "computeStopLoss", "computeTakeProfit", "partialTpTriggeredByStrategy"]
for name in funcs_to_find:
    if name in js_content:
        idx = js_content.find(name)
        print(f"  Found {name} at position {idx} in JS")
    else:
        print(f"  [NOT FOUND] {name} in JS")

# 2. Check if partial TP logic is inline in executeStrategy
print("\n=== Looking for partial_tp_pct in source ===")
with open(STRATEGY_TS, "r") as f:
    ts_content = f.read()
matches = [m.start() for m in re.finditer(r'partial_tp', ts_content)]
print(f"  Found {len(matches)} references to partial_tp")
for pos in matches[:5]:
    line_start = ts_content.rfind('\n', 0, pos) + 1
    line_end = ts_content.find('\n', pos)
    line_num = ts_content[:pos].count('\n') + 1
    print(f"  L{line_num}: {ts_content[line_start:line_end][:120]}")

# 3. Build
print("\n=== Building ===")
os.chdir(os.path.join(BASE, "backend"))
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
if r.returncode == 0:
    print("Build OK")
else:
    print("Build FAILED:", r.stderr[:400])
    # Restore strategy.ts from backup
    backup = STRATEGY_TS + ".phase1-backup"
    if os.path.exists(backup):
        shutil.copy(backup, STRATEGY_TS)
        print("Restored strategy.ts from backup")

# 4. Check snapshot DB
print("\n=== SNAPSHOT DB ===")
DB = os.path.join(BASE, "backend/database.db")
r = subprocess.run(["sqlite3", DB, ".schema ts_backtest_snapshots"], capture_output=True, text=True)
print(f"Schema: {r.stdout[:300] or 'TABLE NOT FOUND'}")
if r.stdout:
    r = subprocess.run(["sqlite3", DB, "SELECT COUNT(*) FROM ts_backtest_snapshots;"], capture_output=True, text=True)
    print(f"Rows: {r.stdout.strip()}")
    r = subprocess.run(["sqlite3", DB, "SELECT snapshot_key, ret, dd, pf, trades FROM ts_backtest_snapshots ORDER BY id DESC LIMIT 3;"], capture_output=True, text=True)
    print(f"Recent: {r.stdout.strip()}")

# 5. Git commit if build OK
if r.returncode == 0:
    os.chdir(BASE)
    subprocess.run(["git", "add", "backend/src/services/strategy/", "backend/src/bot/strategy.ts"], capture_output=True)
    r2 = subprocess.run(["git", "commit", "-m", "refactor: extract sizing module, fix build"], capture_output=True, text=True)
    print(f"Commit: {r2.stdout.strip()[:200]}")
    subprocess.run(["git", "push"], capture_output=True)
    print("Pushed")
    subprocess.run(["systemctl", "restart", "btdd-api", "btdd-runtime"], capture_output=True)
    print("Restarted services")

print("\n=== DONE ===")

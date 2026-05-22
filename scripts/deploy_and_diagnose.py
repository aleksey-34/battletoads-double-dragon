#!/usr/bin/env python3
"""Deploy refactored modules, restart services, diagnose UI issues."""
import os, subprocess, json

BASE = "/opt/battletoads-double-dragon"

# 1. Status check
print("=== STATUS ===")
for path in [
    "backend/src/services/strategy/sizing.ts",
    "backend/src/services/strategy/mutex.ts",
    "backend/src/services/strategy/crud.ts",
    "backend/src/services/strategy/index.ts",
]:
    full = os.path.join(BASE, path)
    if os.path.exists(full):
        size = os.path.getsize(full)
        print(f"  [OK] {path} ({size} bytes)")
    else:
        print(f"  [MISSING] {path}")

# 2. Git status
os.chdir(BASE)
r = subprocess.run(["git", "status", "--short"], capture_output=True, text=True)
print(f"\nGit status:\n{r.stdout[:500]}")

# 3. Stop research-main (save memory)
print("\n=== STOPPING research-main (not needed 24/7) ===")
# Find PID
r = subprocess.run(["pgrep", "-f", "research-main"], capture_output=True, text=True)
if r.stdout.strip():
    subprocess.run(["systemctl", "stop", "btdd-research"], capture_output=True)
    print(f"  Stopped btdd-research (PID {r.stdout.strip()})")
else:
    print("  btdd-research not running")

# 4. Build and restart
print("\n=== BUILDING ===")
os.chdir(os.path.join(BASE, "backend"))
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
if r.returncode == 0:
    print("  Build OK")
else:
    print(f"  Build FAILED: {r.stderr[:300]}")
    exit(1)

# 5. Restart services
print("\n=== RESTARTING SERVICES ===")
for svc in ["btdd-api", "btdd-runtime"]:
    r = subprocess.run(["systemctl", "restart", svc], capture_output=True, text=True)
    if r.returncode == 0:
        print(f"  Restarted {svc}")
    else:
        print(f"  Failed to restart {svc}: {r.stderr}")

# 6. Check memory after restart
r = subprocess.run(["free", "-h"], capture_output=True, text=True)
print(f"\nMemory after restart:\n{r.stdout}")

# 7. Check services status
r = subprocess.run(["systemctl", "is-active", "btdd-api", "btdd-runtime"], capture_output=True, text=True)
print(f"Services active: {r.stdout.strip()}")

# 8. Diagnose UI snapshot mismatch
print("\n=== UI SNAPSHOT DIAGNOSIS ===")
# Check what snapshots exist in DB
r = subprocess.run(
    ["sqlite3", os.path.join(BASE, "backend", "database.db"),
     "SELECT snapshot_key, ret, dd, pf, trades FROM ts_backtest_snapshots WHERE snapshot_key LIKE '%balanced-portfolio%' ORDER BY id DESC LIMIT 5;"],
    capture_output=True, text=True
)
print(f"Recent snapshots in DB:\n{r.stdout}")

print("\n=== ALL DONE ===")

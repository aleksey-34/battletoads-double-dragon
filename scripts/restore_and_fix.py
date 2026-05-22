#!/usr/bin/env python3
"""Restore working state: revert bad edits, rebuild backend & frontend, restart services."""
import os, subprocess

BASE = "/opt/battletoads-double-dragon"

print("=" * 60)
print("1. RESTORING FILES FROM GIT")
print("=" * 60)

files_to_restore = [
    "backend/src/bot/strategy.ts",
    "frontend/src/pages/SaaS.tsx",
]

for f in files_to_restore:
    cmd = ["git", "-C", BASE, "checkout", "--", f]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        print(f"  [OK] Restored {f}")
    else:
        print(f"  [ERR] Failed to restore {f}: {r.stderr}")

# Remove backup files
for f in ["backend/src/bot/strategy.ts.backup",
          "backend/src/bot/strategy.ts.phase1-backup",
          "backend/src/bot/strategy.ts.backup-refactor"]:
    fp = os.path.join(BASE, f)
    if os.path.exists(fp):
        os.remove(fp)
        print(f"  [OK] Removed backup {f}")

print("\n" + "=" * 60)
print("2. BUILDING BACKEND")
print("=" * 60)

os.chdir(os.path.join(BASE, "backend"))
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
if r.returncode == 0:
    print("  [OK] Backend build successful")
else:
    print("  [ERR] Backend build failed:")
    print(r.stderr[-500:])

# Patch service.js for materialization
print("\n" + "=" * 60)
print("3. PATCHING SERVICE.JS FOR MATERIALIZATION")
print("=" * 60)

service_js = os.path.join(BASE, "backend/dist/saas/service.js")
if os.path.exists(service_js):
    with open(service_js, "r") as f:
        content = f.read()
    if "exports.propagatePublishToClients" not in content and "async function propagatePublishToClients" in content:
        content += "\nexports.propagatePublishToClients = propagatePublishToClients;\n"
        with open(service_js, "w") as f:
            f.write(content)
        print("  [OK] Patched service.js")
    else:
        print("  [SKIP] Already patched or function not found")

print("\n" + "=" * 60)
print("4. BUILDING FRONTEND")
print("=" * 60)

os.chdir(os.path.join(BASE, "frontend"))
r = subprocess.run(["npm", "run", "build"], capture_output=True, text=True, timeout=120)
if r.returncode == 0:
    print("  [OK] Frontend build successful")
else:
    print("  [ERR] Frontend build failed:")
    print(r.stderr[-500:])

print("\n" + "=" * 60)
print("5. RESTARTING SERVICES")
print("=" * 60)

for svc in ["btdd-api", "btdd-runtime"]:
    r = subprocess.run(["systemctl", "restart", svc], capture_output=True, text=True)
    print(f"  Restarted {svc}: {'OK' if r.returncode == 0 else r.stderr}")

import time
time.sleep(3)

print("\n" + "=" * 60)
print("6. TESTING API")
print("=" * 60)

r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "http://localhost:4000/api/saas/admin/summary?tenant=00000000-0000-0000-0000-000000000000"],
    capture_output=True, text=True)
print(f"  HTTP status: {r.stdout}")

print("\nDONE")

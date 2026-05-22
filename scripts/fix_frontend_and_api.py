#!/usr/bin/env python3
"""Diagnose and fix frontend build failure + API."""
import os, subprocess, time, sys

BASE = "/opt/battletoads-double-dragon"

print("=" * 60)
print("1. FRONTEND BUILD DIAGNOSIS")
print("=" * 60)

os.chdir(os.path.join(BASE, "frontend"))
r = subprocess.run(["npm", "run", "build"], capture_output=True, text=True, timeout=120)
print(f"Exit code: {r.returncode}")
print(f"STDOUT (last 1000 chars):")
if r.stdout:
    print(r.stdout[-1000:])
else:
    print("(empty)")
print(f"\nSTDERR (full):")
if r.stderr:
    print(r.stderr)
else:
    print("(empty — probably stderr redirected to stdout)")

# If build failed, try with npx react-scripts build to capture more
if r.returncode != 0:
    print("\n--- Trying with explicit react-scripts ---")
    r2 = subprocess.run(
        ["npx", "react-scripts", "build"],
        capture_output=True, text=True, timeout=120,
        env={**os.environ, "CI": "false", "GENERATE_SOURCEMAP": "false"}
    )
    print(f"Exit: {r2.returncode}")
    print(f"STDOUT: {r2.stdout[-1000:]}")
    print(f"STDERR: {r2.stderr[-1000:]}")

    # If SaaS.tsx is the problem, restore from git again
    if "SaaS.tsx" in (r2.stdout + r2.stderr):
        print("\n[SaaS.tsx error detected — restoring from git]")
        saas = os.path.join(BASE, "frontend/src/pages/SaaS.tsx")
        subprocess.run(["git", "-C", BASE, "checkout", "--", "frontend/src/pages/SaaS.tsx"], capture_output=True)
        # Try build again
        r3 = subprocess.run(["npm", "run", "build"], capture_output=True, text=True, timeout=120)
        print(f"Build after restore: exit={r3.returncode}")
        if r3.returncode != 0:
            print("STILL FAILED:", r3.stderr[-500:])
            
            # Check if there's a backup that's different from git
            # The git version should be clean - check hash
            r4 = subprocess.run(["md5sum", saas], capture_output=True, text=True)
            print(f"SaaS.tsx hash: {r4.stdout.strip()}")
            
            # Show first 5 lines for sanity
            with open(saas, "r") as f:
                lines = f.readlines()[:5]
            for line in lines:
                print(f"  L: {line.rstrip()[:120]}")

print("\n" + "=" * 60)
print("2. API DIAGNOSIS")
print("=" * 60)

# Check if processes are running
r = subprocess.run(["ps", "aux"], capture_output=True, text=True)
api_running = "btdd-api" in r.stdout or "server.js" in r.stdout
runtime_running = "btdd-runtime" in r.stdout or "runtime-main.js" in r.stdout
print(f"API process running: {api_running}")
print(f"Runtime process running: {runtime_running}")

# Check port
r = subprocess.run(["ss", "-tlnp", "|grep", "4000"], capture_output=True, text=True, shell=True)
print(f"Port 4000: {r.stdout.strip()}")

# Try curl with verbose
r = subprocess.run(["curl", "-v", "--max-time", "10",
    "http://localhost:4000/api/saas/admin/summary?tenant=00000000-0000-0000-0000-000000000000"],
    capture_output=True, text=True, timeout=15)
print(f"Curl exit: {r.returncode}")
print(f"STDOUT (first 500): {r.stdout[:500]}")
print(f"STDERR: {r.stderr[:500]}")

# Check systemctl status
r = subprocess.run(["systemctl", "status", "btdd-api", "--no-pager", "-l"], capture_output=True, text=True)
print(f"\nbtdd-api status:\n{r.stdout[-500:]}")

print("\nDONE")

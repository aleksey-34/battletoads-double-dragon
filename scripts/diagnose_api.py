#!/usr/bin/env python3
"""Quick diagnose: why API returns 000, check logs, fix artursk keys."""
import os, subprocess, time

BASE = "/opt/battletoads-double-dragon"

# 1. Check if frontend build exists
print("=== FRONTEND BUILD ===")
build_dir = os.path.join(BASE, "frontend/build")
if os.path.exists(build_dir):
    index_html = os.path.join(build_dir, "index.html")
    if os.path.exists(index_html):
        print(f"  Build exists: {os.path.getsize(index_html)} bytes")
    else:
        print("  Build dir exists but no index.html")
else:
    print("  Build dir MISSING!")

# 2. Check btdd-api logs
print("\n=== BTDD-API LOGS (last 30 lines) ===")
r = subprocess.run(["journalctl", "-u", "btdd-api", "--no-pager", "-n", "30"], capture_output=True, text=True)
print(r.stdout[-1500:])

# 3. Check port binding
print("\n=== PORT 4000 ===")
r = subprocess.run(["ss", "-tlnp"], capture_output=True, text=True)
for line in r.stdout.split('\n'):
    if ':4000' in line:
        print(f"  {line}")

# 4. Try with curl (explicit localhost)
time.sleep(2)
print("\n=== CURL TEST ===")
r = subprocess.run(["curl", "-sv", "--max-time", "5", "http://127.0.0.1:4000/api/health"], capture_output=True, text=True, timeout=10)
print(f"Exit: {r.returncode}")
print(f"STDOUT: {r.stdout[:500]}")
print(f"STDERR: {r.stderr[:300]}")

# 5. Check node processes
print("\n=== NODE PROCESSES ===")
r = subprocess.run(["ps", "aux"], capture_output=True, text=True)
for line in r.stdout.split('\n'):
    if 'node' in line and 'battletoads' in line:
        print(f"  {line[:180]}")

# 6. Check SQLite for artursk
print("\n=== ARTURSK KEYS ===")
DB = os.path.join(BASE, "backend/database.db")
queries = [
    "SELECT id, name, active FROM api_keys WHERE name LIKE '%artursk%' OR name LIKE '%5374535192%';",
    "SELECT id, name, active FROM api_keys WHERE active=1 LIMIT 5;",
    "SELECT COUNT(*) FROM api_keys;",
]
for q in queries:
    r = subprocess.run(["sqlite3", DB, q], capture_output=True, text=True)
    print(f"  {q[:60]}...")
    print(f"  -> {r.stdout.strip() or '(empty)'}")
    if r.stderr:
        print(f"  ERR: {r.stderr}")

print("\nDONE")
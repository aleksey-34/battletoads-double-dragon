#!/usr/bin/env python3
"""Restore strategy.ts to clean state (no conflicting imports), build, check memory."""
import os, shutil, subprocess

BASE = "/opt/battletoads-double-dragon"
SRC = os.path.join(BASE, "backend", "src", "bot", "strategy.ts")
BACKUP = SRC + ".phase1-backup"  # clean backup before any changes

if os.path.exists(BACKUP):
    shutil.copy(BACKUP, SRC)
    print("Restored strategy.ts from phase1-backup")
else:
    # try git checkout
    subprocess.run(["git", "-C", BASE, "checkout", "--", "backend/src/bot/strategy.ts"], capture_output=True)
    print("Checked out strategy.ts from git")

# Ensure imports are not added
with open(SRC, "r") as f:
    content = f.read()

# Remove any import lines added earlier
lines = content.split('\n')
filtered_lines = []
for line in lines:
    if 'from "../services/strategy/sizing"' in line or 'from "../services/strategy/mutex"' in line:
        continue
    filtered_lines.append(line)
content = '\n'.join(filtered_lines)

with open(SRC, "w") as f:
    f.write(content)

print("Removed any imports of new modules from strategy.ts")

# Build
os.chdir(os.path.join(BASE, "backend"))
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
print("Build STDOUT:", r.stdout[-200:] if r.stdout else "")
print("Build STDERR:", r.stderr[:300] if r.stderr else "")
print(f"Exit: {r.returncode}")

# Check memory
r2 = subprocess.run(["free", "-h"], capture_output=True, text=True)
print("\nMEMORY:\n", r2.stdout)

# Check top processes
r3 = subprocess.run(["ps", "aux", "--sort=-%mem"], capture_output=True, text=True)
print("TOP processes (by memory):\n", r3.stdout[:500])

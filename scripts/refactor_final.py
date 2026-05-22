#!/usr/bin/env python3
"""Final refactor: restore strategy.ts from backup, then remove only correctly extracted functions."""
import os, shutil, subprocess

BASE = "/opt/battletoads-double-dragon"
SRC = os.path.join(BASE, "backend", "src", "bot", "strategy.ts")
BACKUP = SRC + ".phase1-backup"

if not os.path.exists(BACKUP):
    print("Backup not found, skipping")
    exit(1)

# Restore clean state
shutil.copy(BACKUP, SRC)
print("Restored strategy.ts from backup")

with open(SRC, "r", encoding="utf-8") as f:
    content = f.read()

# Add imports at top
imports_sizing = 'import { computeSignalTotalNotional, decimalPlaces, partialTpTriggeredByStrategy, computePartialTakeProfit, computeStopLoss, computeTakeProfit } from "../services/strategy/sizing";\n'
imports_mutex = 'import { acquireStrategyLock, releaseStrategyLock, isStrategyLocked, withStrategyLock } from "../services/strategy/mutex";\n'
new_imports = imports_sizing + imports_mutex
content = new_imports + content

# Define exact function signatures to remove (based on grep output)
import re

def remove_function(content, name):
    """Remove first occurrence of function definition with given name."""
    # Match: export (async) function name (params) { ... } or const name = (async) (...) => { ... }
    pattern = re.compile(
        r"export\s+(async\s+)?function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*:\s*\w+\s*\{" +
        r"|export\s+(async\s+)?function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{" +
        r"|const\s+" + re.escape(name) + r"\s*=\s*(async\s+)?\([^)]*\)\s*:\s*\w+\s*=>\s*\{" +
        r"|const\s+" + re.escape(name) + r"\s*=\s*(async\s+)?\([^)]*\)\s*=>\s*\{"
    )
    match = pattern.search(content)
    if not match:
        print(f"  [SKIP] {name} not found")
        return content, False
    start = match.start()
    # Find the matching closing brace
    # Determine opening brace position
    # pattern already includes opening brace '{', so find it in matched string
    matched = match.group()
    brace_idx_in_match = matched.rfind('{')
    brace_pos = match.start() + brace_idx_in_match
    depth = 1
    i = brace_pos + 1
    while i < len(content) and depth > 0:
        if content[i] == '{':
            depth += 1
        elif content[i] == '}':
            depth -= 1
        i += 1
    func_end = i
    # Remove trailing whitespace
    while func_end < len(content) and content[func_end] in ('\n', '\r'):
        func_end += 1
    # Remove the whole block
    func_code = content[start:func_end]
    content = content[:start] + content[func_end:]
    print(f"  [OK] Removed {name} ({len(func_code)} chars)")
    return content, True

# Functions to extract: computeSignalTotalNotional, decimalPlaces, computePartialTakeProfit, computeStopLoss, computeTakeProfit
# Note: computePartialTakeProfit etc. may be defined differently, we'll try to remove them.
targets = [
    "computeSignalTotalNotional",
    "decimalPlaces",
    "computePartialTakeProfit",
    "computeStopLoss",
    "computeTakeProfit",
]

for name in targets:
    content, removed = remove_function(content, name)

# Also remove mutex-like functions? They are not duplicated in mutex.ts (strategy.ts uses its own locking).
# But we can remove acquireSystemEntryLock and similar if we import from mutex.
# We'll leave them for now.

with open(SRC, "w", encoding="utf-8") as f:
    f.write(content)

print("\nAll targeted functions removed. Now building...")
os.chdir(os.path.join(BASE, "backend"))
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
print("STDOUT:", r.stdout[-500:] if r.stdout else "")
print("STDERR:", r.stderr[-500:] if r.stderr else "")
print(f"Exit: {r.returncode}")

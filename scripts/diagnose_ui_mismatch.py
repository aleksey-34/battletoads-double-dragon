#!/usr/bin/env python3
"""Diagnose UI snapshot mismatch: why card metrics != modal metrics, and why sliders don't update result."""
import os, re, subprocess, json

BASE = "/opt/battletoads-double-dragon"

print("=" * 60)
print("1. Where does card get its metrics?")
print("=" * 60)

# In SaaS.tsx, around line 3500-3512: adminDraftPortfolioSummary uses adminSavedTsSnapshot
# adminSavedTsSnapshot looks up summary?.offerStore?.tsBacktestSnapshots?.[snapshotKeyForCurrentSet]
# or falls back to summary?.offerStore?.tsBacktestSnapshot

# WHERE does offerStore come from? It's in the summary response from backend.
# Let's search backend for offerStore / tsBacktestSnapshot

backend_src = os.path.join(BASE, "backend/src")
for root, dirs, files in os.walk(backend_src):
    for f in files:
        if f.endswith('.ts') and not f.endswith('.d.ts'):
            path = os.path.join(root, f)
            with open(path, 'r', errors='ignore') as fp:
                content = fp.read()
            if 'tsBacktestSnapshot' in content or 'offerStore' in content:
                for i, line in enumerate(content.split('\n'), 1):
                    if 'tsBacktestSnapshot' in line or 'offerStore' in line:
                        print(f"  {path}:{i}: {line.strip()[:150]}")
            if 'max_open_positions' in content and 'snapshot' in content.lower():
                for i, line in enumerate(content.split('\n'), 1):
                    if 'max_open_positions' in line:
                        print(f"  MOP: {path}:{i}: {line.strip()[:150]}")

print()
print("=" * 60)
print("2. How does modal fetch its metrics?")
print("=" * 60)

# Modal likely uses sweepSummary or live backtest result
# In SaaS.tsx, around line 9169: summary?.sweepSummary?.portfolioFull
# So modal shows live sweep result, while card shows snapshot from offerStore

# Check if modal has any connection to risk/frequency sliders
print("Searching for risk multiplier and frequency in SaaS.tsx...")
# We can't read SaaS.tsx directly (too large). Use grep on VPS.
r = subprocess.run(
    ["grep", "-n", "riskMultiplier\|risk_multiplier\|frequency\|max_open_positions", 
     os.path.join(BASE, "frontend/src/pages/SaaS.tsx")],
    capture_output=True, text=True, timeout=30
)
lines = r.stdout.strip().split('\n')[:30]
print(f"Found {len(lines)} lines:")
for line in lines:
    print(f"  {line[:200]}")

print()
print("=" * 60)
print("3. How are snapshots saved?")
print("=" * 60)

# Search backend for snapshot saving endpoint
for root, dirs, files in os.walk(backend_src):
    for f in files:
        if f.endswith('.ts') and 'saas' in root:
            path = os.path.join(root, f)
            with open(path, 'r', errors='ignore') as fp:
                content = fp.read()
            if 'snapshot' in content.lower() and 'max_open_positions' in content:
                for i, line in enumerate(content.split('\n'), 1):
                    if 'max_open_positions' in line:
                        print(f"  {path}:{i}: {line.strip()[:150]}")

print()
print("Done.")

#!/usr/bin/env python3
"""Phase 2: Remove duplicated functions from strategy.ts after extracting to modules."""
import os
import re
import shutil

BASE = "/opt/battletoads-double-dragon"
STRATEGY_TS = os.path.join(BASE, "backend", "src", "bot", "strategy.ts")

shutil.copy(STRATEGY_TS, STRATEGY_TS + ".phase1-backup")
with open(STRATEGY_TS, "r") as f:
    content = f.read()

# Add imports at the very beginning
new_imports = """import { computeSignalTotalNotional, decimalPlaces, partialTpTriggeredByStrategy, computePartialTakeProfit, computeStopLoss, computeTakeProfit } from "../services/strategy/sizing";
import { acquireStrategyLock, releaseStrategyLock, isStrategyLocked, withStrategyLock } from "../services/strategy/mutex";

"""
content = new_imports + content

# Functions to remove (by name patterns found in the TS source)
func_names_to_remove = [
    "computeSignalTotalNotional",
    "decimalPlaces",
    "computePartialTakeProfit",
    "computeStopLoss",
    "computeTakeProfit",
]

for func_name in func_names_to_remove:
    # Pattern: export function NAME(...) { or function NAME(...) { or const NAME = (...) => {
    pattern = re.compile(
        r"(?:export\s+)?(?:async\s+)?(?:function\s+" + re.escape(func_name) + r"\s*\([^)]*\)|const\s+" + re.escape(func_name) + r"\s*=\s*(?:async\s+)?\()",
        re.MULTILINE,
    )
    match = pattern.search(content)
    if not match:
        print(f"[SKIP] {func_name} not found")
        continue

    start = match.start()
    # Find the opening brace
    brace_start = content.find("{", match.end())
    if brace_start == -1:
        # arrow function: =>
        arrow = content.find("=>", match.end())
        if arrow != -1:
            brace_start = content.find("{", arrow)
    if brace_start == -1:
        print(f"[SKIP] {func_name} - no brace found")
        continue

    # Count braces to find function end
    depth = 1
    i = brace_start + 1
    while i < len(content) and depth > 0:
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
        i += 1

    # Remove the function including preceding blank lines
    func_end = i
    # Also remove trailing blank lines after the function
    while func_end < len(content) and content[func_end] in ("\n", "\r"):
        func_end += 1

    func_code = content[start:func_end]
    content = content[:start] + f"// [EXTRACTED to services/strategy] {func_name}\n" + content[func_end:]
    print(f"[OK] Removed {func_name} ({len(func_code)} chars) from strategy.ts")

# Also remove constants SIZING_EPSILON etc if present
for const_name in ["SIZING_EPSILON", "MAX_SHARE_ERROR", "MAX_LEG_DEVIATION", "MAX_OVERSIZE_DEVIATION", "MAX_TOTAL_DEVIATION"]:
    pattern = re.compile(r"const\s+" + re.escape(const_name) + r"\s*=")
    match = pattern.search(content)
    if match:
        line_start = content.rfind("\n", 0, match.start()) + 1
        line_end = content.find("\n", match.end())
        if line_end == -1:
            line_end = len(content)
        content = content[:line_start] + f"// [EXTRACTED] {const_name}\n" + content[line_end + 1:]
        print(f"[OK] Removed constant {const_name}")

with open(STRATEGY_TS, "w") as f:
    f.write(content)

# Also read and fix sizing.ts safeNumber path
sizing_path = os.path.join(BASE, "backend", "src", "services", "strategy", "sizing.ts")
with open(sizing_path, "r") as f:
    sizing = f.read()

# Check if utils/safeNumber exists
utils_dir = os.path.join(BASE, "backend", "src", "utils")
safe_number_exists = any("safeNumber" in f for f in os.listdir(utils_dir)) if os.path.isdir(utils_dir) else False

if not safe_number_exists:
    sizing = sizing.replace('import { safeNumber } from "../../utils/safeNumber";', "")
    sizing = sizing.replace("safeNumber(strategy.partial_tp_pct, 0)", "Number(strategy.partial_tp_pct ?? 0)")
    sizing = sizing.replace("safeNumber(strategy.sl_percent, 0)", "Number(strategy.sl_percent ?? 0)")
    sizing = sizing.replace("safeNumber(strategy.tp_percent, 0)", "Number(strategy.tp_percent ?? 0)")
    print("[OK] Removed safeNumber dependency from sizing.ts")

with open(sizing_path, "w") as f:
    f.write(sizing)

# Now build
import subprocess
os.chdir(os.path.join(BASE, "backend"))
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
print("STDOUT:", r.stdout[-500:] if r.stdout else "(empty)")
print("STDERR:", r.stderr[-500:] if r.stderr else "(empty)")
print(f"Exit: {r.returncode}")
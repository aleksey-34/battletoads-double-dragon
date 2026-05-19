#!/usr/bin/env python3
"""Write clean stub modules to avoid import errors, then build."""
import os, subprocess

BASE = "/opt/battletoads-double-dragon"
SERVICES = os.path.join(BASE, "backend/src/services/strategy")
os.makedirs(SERVICES, exist_ok=True)

modules = {
    "sizing.ts": """// Sizing & Risk Management stubs
export const partialTpTriggeredByStrategy = new Map<string, boolean>();
export function computeSignalTotalNotional(...args: any[]): number { return 0; }
export function computePartialTakeProfit(...args: any[]): null { return null; }
export function computeStopLoss(...args: any[]): null { return null; }
export function computeTakeProfit(...args: any[]): null { return null; }
""",

    "mutex.ts": """// Mutex stubs
export function isStrategyLocked(id: string): boolean { return false; }
export async function withStrategyLock<T>(id: string, fn: () => Promise<T>): Promise<T> { return fn(); }
""",

    "crud.ts": """// CRUD stubs
export interface StrategyRow { id: number; name: string; }
""",

    "index.ts": """// Unified exports
export { computeSignalTotalNotional, computePartialTakeProfit, computeStopLoss, computeTakeProfit, partialTpTriggeredByStrategy } from "./sizing";
export { isStrategyLocked, withStrategyLock } from "./mutex";
export type { StrategyRow } from "./crud";
""",
}

for fname, content in modules.items():
    fpath = os.path.join(SERVICES, fname)
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Written {fname} ({len(content)} chars)")

print("\nRebuilding backend...")
os.chdir(os.path.join(BASE, "backend"))
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
print(f"Exit: {r.returncode}")
if r.stderr:
    print("STDERR:", r.stderr[:500])
if r.stdout:
    print("STDOUT:", r.stdout[:500])
print("DONE")
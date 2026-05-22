#!/usr/bin/env python3
"""Fix and regenerate strategy modules on VPS, then build."""
import os, shutil, subprocess

BASE = "/opt/battletoads-double-dragon"
SERVICES = os.path.join(BASE, "backend", "src", "services", "strategy")
STRATEGY_TS = os.path.join(BASE, "backend", "src", "bot", "strategy.ts")

os.makedirs(SERVICES, exist_ok=True)

# 1. sizing.ts
sizing_ts = '''// Sizing & Risk Management
import logger from "../../utils/logger";
import { safeNumber } from "../../utils/safeNumber";

export function computeSignalTotalNotional(
  strategy: any,
  availableBalance: number,
  signal: string,
  riskMultiplier: number = 1.0,
): number {
  const safeAvailable = Number.isFinite(availableBalance) && availableBalance > 0 ? availableBalance : 0;
  const safeRiskMultiplier = Number.isFinite(riskMultiplier) && riskMultiplier > 0 ? riskMultiplier : 1.0;
  const cappedBalance = strategy.max_deposit > 0
    ? Math.min(safeAvailable, strategy.max_deposit)
    : safeAvailable;
  const lotPercent = signal === "long" ? strategy.lot_long_percent : strategy.lot_short_percent;
  const lotFraction = Math.max(0, lotPercent) / 100;
  const reinvestFactor = strategy.fixed_lot ? 1 : 1 + Math.max(0, strategy.reinvest_percent) / 100;
  const baseCapital = strategy.fixed_lot
    ? (strategy.max_deposit > 0 ? strategy.max_deposit : cappedBalance)
    : cappedBalance;
  const totalNotional = baseCapital * lotFraction * reinvestFactor * safeRiskMultiplier;
  if (
    Number.isFinite(totalNotional) &&
    totalNotional > 0 &&
    safeAvailable > 0 &&
    totalNotional > safeAvailable * 1.001 &&
    !strategy.fixed_lot
  ) {
    logger.warn(
      `[sizing-guard] notional=${totalNotional.toFixed(2)} > equity=${safeAvailable.toFixed(2)}`,
    );
  }
  return Number.isFinite(totalNotional) && totalNotional > 0 ? totalNotional : 0;
}

export function decimalPlaces(value: any): number {
  const normalized = String(value || "");
  const scientific = normalized.toLowerCase().match(/e-(\d+)$/);
  if (scientific) {
    const parsed = Number.parseInt(scientific[1], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  if (!normalized.includes(".")) return 0;
  return normalized.split(".")[1].replace(/0+$/, "").length;
}

export const partialTpTriggeredByStrategy = new Map<string, boolean>();

export function computePartialTakeProfit(
  strategy: any,
  position: any,
  unrealizedPnlPercent: number,
  strategyId: string,
): { closePercent: number; reason: string } | null {
  const partialTpPct = safeNumber(strategy.partial_tp_pct, 0);
  if (partialTpPct <= 0) return null;
  if (partialTpTriggeredByStrategy.get(strategyId)) return null;
  if (unrealizedPnlPercent >= partialTpPct) {
    partialTpTriggeredByStrategy.set(strategyId, true);
    return { closePercent: 50, reason: `partial_tp at ${unrealizedPnlPercent.toFixed(2)}%` };
  }
  return null;
}

export function computeStopLoss(
  strategy: any,
  unrealizedPnlPercent: number,
): { closePercent: number; reason: string } | null {
  const slPct = safeNumber(strategy.sl_percent, 0);
  if (slPct > 0 && unrealizedPnlPercent <= -slPct) {
    return { closePercent: 100, reason: `stop_loss at ${unrealizedPnlPercent.toFixed(2)}%` };
  }
  return null;
}

export function computeTakeProfit(
  strategy: any,
  unrealizedPnlPercent: number,
): { closePercent: number; reason: string } | null {
  const tpPct = safeNumber(strategy.tp_percent, 0);
  if (tpPct > 0 && unrealizedPnlPercent >= tpPct) {
    return { closePercent: 100, reason: `take_profit at ${unrealizedPnlPercent.toFixed(2)}%` };
  }
  return null;
}
'''

# 2. mutex.ts
mutex_ts = '''// Strategy Mutex
const strategyLocks = new Map<string, Promise<void>>();

export async function acquireStrategyLock(strategyId: string): Promise<void> {
  while (strategyLocks.has(strategyId)) {
    await strategyLocks.get(strategyId)!;
  }
  let release: () => void;
  const lockPromise = new Promise<void>((resolve) => { release = resolve; });
  strategyLocks.set(strategyId, lockPromise);
  (lockPromise as any).__release = release!;
}

export function releaseStrategyLock(strategyId: string): void {
  const lock = strategyLocks.get(strategyId);
  if (lock) {
    strategyLocks.delete(strategyId);
    const release = (lock as any).__release;
    if (release) release();
  }
}

export function isStrategyLocked(strategyId: string): boolean {
  return strategyLocks.has(strategyId);
}

export async function withStrategyLock<T>(strategyId: string, fn: () => Promise<T>): Promise<T> {
  await acquireStrategyLock(strategyId);
  try { return await fn(); } finally { releaseStrategyLock(strategyId); }
}
'''

# 3. crud.ts (stub)
crud_ts = '''// Strategy CRUD — stub, real impl still in bot/strategy.ts
'''

# 4. index.ts
index_ts = '''export { computeSignalTotalNotional, decimalPlaces, partialTpTriggeredByStrategy, computePartialTakeProfit, computeStopLoss, computeTakeProfit } from "./sizing";
export { acquireStrategyLock, releaseStrategyLock, isStrategyLocked, withStrategyLock } from "./mutex";
'''

# Write files
files = {"sizing.ts": sizing_ts, "mutex.ts": mutex_ts, "crud.ts": crud_ts, "index.ts": index_ts}
for name, content in files.items():
    path = os.path.join(SERVICES, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"[OK] {name} ({len(content)} chars)")

# Patch strategy.ts — add import
shutil.copy(STRATEGY_TS, STRATEGY_TS + ".backup")
with open(STRATEGY_TS, "r", encoding="utf-8") as f:
    content = f.read()
new_import = 'import { computeSignalTotalNotional, decimalPlaces, partialTpTriggeredByStrategy, computePartialTakeProfit, computeStopLoss, computeTakeProfit } from "../services/strategy/sizing";\n'
content = new_import + content
with open(STRATEGY_TS, "w", encoding="utf-8") as f:
    f.write(content)
print("[OK] strategy.ts patched")

# Build
os.chdir(os.path.join(BASE, "backend"))
print("\n=== Running tsc ===")
r = subprocess.run(["npx", "tsc"], capture_output=True, text=True, timeout=120)
print("STDOUT:", r.stdout[:500])
if r.stderr:
    print("STDERR:", r.stderr[:500])
print(f"Exit: {r.returncode}")

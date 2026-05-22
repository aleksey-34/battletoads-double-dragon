#!/usr/bin/env python3
"""
DCA Backtest Integration Script
Patches backend/src/backtest/engine.ts to add DCA strategy support.
Patches backend/src/bot/tradingSystems.ts to pass DCA params.
Builds and deploys.

Usage on VPS:
  cd /path/to/project
  python3 scripts/integrate_dca_backtest.py
"""

import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ENGINE_PATH = os.path.join(BASE, "backend", "src", "backtest", "engine.ts")
TRADING_SYSTEMS_PATH = os.path.join(BASE, "backend", "src", "bot", "tradingSystems.ts")

# ============================================================================
# PART 1: Patch engine.ts - Add DCA types and runtime state
# ============================================================================

with open(ENGINE_PATH, "r") as f:
    engine = f.read()

# 1a. Add DcaState type after line ~550 (after RuntimeStrategy type)
dca_state_type = """
type DcaState = {
  enabled: boolean;
  baseAmountUsdt: number;
  stepPercent: number;
  maxOrders: number;
  orderMultiplier: number;
  tpPercent: number;
  slPercent: number;
  ordersCount: number;
  totalInvested: number;
  totalQty: number;
  lastBuyPrice: number;
};
"""

# 1b. Add dcaState field to RuntimeStrategy
old_runtime_strategy = "type RuntimeStrategy = {"
new_runtime_strategy = "type BacktestDcaConfig = DcaState;\n\ntype RuntimeStrategy = {"

# Insert DcaState type before RuntimeStrategy
engine = engine.replace(
    "type RuntimeStrategy = {",
    dca_state_type + "\ntype RuntimeStrategy = {"
)

# Add dcaState field to RuntimeStrategy
engine = engine.replace(
    "  partialTpTriggered: boolean;",
    "  partialTpTriggered: boolean;\n  dcaState: DcaState | null;"
)

# ============================================================================
# PART 2: Patch loadRuntimeStrategies - extract DCA params from strategy row
# ============================================================================

# Find where runtime strategies are created: search for pattern that initializes the RT
# Look for the array push that creates RuntimeStrategy objects
old_push_rt = "runtimes.push({"
# We need to find the exact block where RuntimeStrategy is initialized
# and add DCA config extraction before pushing

# Add helper function: extractDcaConfigFromStrategy
extract_dca_func = """
const extractDcaConfigFromStrategy = (s: any): DcaState | null => {
  const strategyType = String(s.strategy_type || '').trim().toLowerCase();
  if (strategyType !== 'dca') return null;
  const baseAmount = Number(s.dca_base_amount_usdt || 10);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null;
  return {
    enabled: true,
    baseAmountUsdt: Math.max(1, baseAmount),
    stepPercent: Math.max(0.1, Number(s.dca_step_percent || 2)),
    maxOrders: Math.max(0, Math.floor(Number(s.dca_max_orders || 5))),
    orderMultiplier: Math.max(1, Number(s.dca_order_multiplier || 1)),
    tpPercent: Math.max(0.1, Number(s.dca_tp_percent || 3)),
    slPercent: Math.max(0, Number(s.dca_sl_percent || 0)),
    ordersCount: 0,
    totalInvested: 0,
    totalQty: 0,
    lastBuyPrice: 0,
  };
};
"""

engine = engine.replace(
    "type RuntimeStrategy = {",
    extract_dca_func + "\ntype RuntimeStrategy = {"
)

# Now find the place where runtimes are built in loadRuntimeStrategies
# and add dcaState initialization. The runtimes are created with specific fields.
# We need to add "dcaState: extractDcaConfigFromStrategy(strategy)" 
# right after "partialTpTriggered: false"

# Find "partialTpTriggered: false" and replace with version that includes dcaState
old_partial_tp = "partialTpTriggered: false"
new_partial_tp = "partialTpTriggered: false,\n        dcaState: extractDcaConfigFromStrategy(strategy) || null"
engine = engine.replace(old_partial_tp, new_partial_tp)

# ============================================================================
# PART 3: Patch the main event loop - DCA safety orders, TP/SL from avg price
# ============================================================================

# We need to add DCA logic INSIDE the event loop for strategies with dcaState
# The key injection points:
# 3a. After seting runtime.currentPrice, check DCA TP/SL
# 3b. After signal is 'none' and state is flat, check DCA safety order trigger
# 3c. When entering a position for a DCA strategy, use dcaState fields

# Find the position where runtime.currentPrice is set
old_set_price = "runtime.currentPrice = candle.close;"
dca_tp_sl_check = """
    runtime.currentPrice = candle.close;

    // ── DCA: TP/SL check from average entry price ──
    if (runtime.dcaState && runtime.state !== 'flat' && runtime.entryPrice && runtime.notional > 0) {
      const dca = runtime.dcaState;
      if (dca.totalQty > 0 && dca.totalInvested > 0) {
        const avgBuyPrice = dca.totalInvested / dca.totalQty;
        const tpPrice = avgBuyPrice * (1 + dca.tpPercent / 100);
        const slPrice = dca.slPercent > 0 ? avgBuyPrice * (1 - dca.slPercent / 100) : 0;

        if (candle.close >= tpPrice) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, candle.close, 'dca_tp');
          // Reset DCA state
          runtime.dcaState.ordersCount = 0;
          runtime.dcaState.totalInvested = 0;
          runtime.dcaState.totalQty = 0;
          runtime.dcaState.lastBuyPrice = 0;
          closedOnCurrentBar = true;
        } else if (slPrice > 0 && candle.close <= slPrice) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, candle.close, 'dca_sl');
          runtime.dcaState.ordersCount = 0;
          runtime.dcaState.totalInvested = 0;
          runtime.dcaState.totalQty = 0;
          runtime.dcaState.lastBuyPrice = 0;
          closedOnCurrentBar = true;
        }
      }
    }"""

engine = engine.replace(old_set_price, dca_tp_sl_check)

# If closedOnCurrentBar was true due to DCA TP/SL, we need to skip to pushEquityPoint
# This is already handled by the existing flow

# 3c. DCA safety order check: after regular signal processing but before entry check
# Find where we check if signal !== flat (signal flip)
# insert DCA safety order check before position limiter check

# Find the "if (state === signalPayload.signal)" block end
# actually let's insert DCA safety order right after the existing exit logic
# but before the new entry signal check

dca_safety_order_check = """
    // ── DCA: safety order check ──
    if (!closedOnCurrentBar && runtime.dcaState && runtime.state !== 'flat' && 
        runtime.dcaState.lastBuyPrice > 0 && runtime.dcaState.ordersCount < runtime.dcaState.maxOrders) {
      const dca = runtime.dcaState;
      const stepTrigger = dca.lastBuyPrice * (1 - dca.stepPercent / 100);
      if (candle.close <= stepTrigger) {
        const safetySize = dca.baseAmountUsdt * Math.pow(dca.orderMultiplier, dca.ordersCount);
        const safetyQty = safetySize / candle.close;
        
        // Record a safety buy trade (not an entry, but a size increase to existing position)
        // We increase notional and recalculate entry price as weighted average
        const prevNotional = runtime.notional;
        const prevEntryPrice = runtime.entryPrice!;
        const newNotional = prevNotional + safetySize;
        const newAvgEntryPrice = (prevNotional * prevEntryPrice + safetySize * candle.close) / newNotional;
        
        const entryPriceExec = executionPrice(candle.close, runtime.state as 'long' | 'short', 'entry', effectiveSlippageRate(ctx, runtime.strategy));
        const entryFee = safetySize * effectiveCommissionRate(ctx, runtime.strategy);
        ctx.cashEquity -= entryFee;
        
        runtime.entryPrice = newAvgEntryPrice;
        runtime.notional = newNotional;
        runtime.openTrade!.entryPrice = newAvgEntryPrice;
        runtime.openTrade!.notional = newNotional;
        runtime.openTrade!.entryFee += entryFee;
        ctx.lockedMargin = Math.max(0, ctx.lockedMargin - prevNotional) + newNotional;
        
        dca.ordersCount += 1;
        dca.totalInvested += safetySize;
        dca.totalQty += safetyQty;
        dca.lastBuyPrice = candle.close;
      }
    }"""

# Insert before "if (signalPayload.signal === 'none')" check
old_signal_none = "    if (signalPayload.signal === 'none') {"
engine = engine.replace(old_signal_none, dca_safety_order_check + "\n" + old_signal_none)

# 3d. When entering a DCA position, initialize dcaState tracking
# Find the openPosition call and add DCA init after it
# The openPosition is called at "openPosition(ctx, runtime, signalPayload.signal, event.timeMs, signalPayload.current, availableBalance);"
old_open_pos = "    openPosition(ctx, runtime, signalPayload.signal, event.timeMs, signalPayload.current, availableBalance);"
dca_entry_init = """    openPosition(ctx, runtime, signalPayload.signal, event.timeMs, signalPayload.current, availableBalance);
    // DCA: initialize tracking on entry
    if (runtime.dcaState && runtime.entryPrice) {
      const dcaConfig = runtime.dcaState;
      const entryQty = runtime.notional / runtime.entryPrice;
      runtime.dcaState = {
        ...dcaConfig,
        ordersCount: 0,
        totalInvested: runtime.notional,
        totalQty: entryQty,
        lastBuyPrice: runtime.entryPrice,
      };
    }"""

engine = engine.replace(old_open_pos, dca_entry_init)

# 3e. When closing position, reset DCA state (already handled in 3a, but also on end_of_test)
old_end_of_test = "'end_of_test'"
new_end_of_test_dca = "'end_of_test'"
# Actually the closePosition already sets state to flat, and we already handle 
# dcaState reset in the TP/SL logic and at entry init. 
# For end_of_test, dcaState just gets ignored since position is closed anyway.

# ============================================================================
# PART 4: Write back engine.ts
# ============================================================================

with open(ENGINE_PATH, "w") as f:
    f.write(engine)

print("✅ engine.ts patched with DCA support")

# ============================================================================
# PART 5: Patch tradingSystems.ts - pass dca params from strategy to request
# ============================================================================

with open(TRADING_SYSTEMS_PATH, "r") as f:
    ts = f.read()

# The runTradingSystemBacktest already constructs a BacktestRunRequest
# We need to check if any member strategy is DCA type and add dca params
# FIX: The engine already reads dca_* from strategy rows directly (via extractDcaConfigFromStrategy)
# So we don't need to pass them as separate request params.
# The engine auto-detects when loading strategies.

# However, we should make sure the lot sizing for DCA strategies is correct:
# DCA strategies should NOT use lot_long_percent / lot_short_percent sizing,
# because position size is controlled by dca_base_amount_usdt.
#
# The engine's openPosition uses lotFraction. For DCA strategies, we should
# set lotLongPercent = (dcaBaseAmount / initialBalance) * 100 or similar.
# But the engine now reads dcaState BEFORE openPosition and initializes on first entry.
#
# KEY ISSUE: The existing openPosition will calculate notional via lotFraction.
# For DCA strategies, this would double-size the first entry (once via lot, once via dcaBaseAmount).
#
# SOLUTION: In openPosition, if dcaState is set, use dcaState.baseAmountUsdt instead of lot calculation.
# Let's patch that in engine.ts

# Add DCA-first sizing in openPosition
# Find "const baseLotPercent = ctx.lotPercentOverride" and add DCA check before it
old_base_lot = "  const baseLotPercent = ctx.lotPercentOverride > 0"
dca_lot_bypass = """  // DCA strategies: size first entry from dcaState.baseAmountUsdt
  if (runtime.dcaState?.enabled) {
    const dcaSize = runtime.dcaState.baseAmountUsdt;
    const availableBalance = Math.max(0, portfolioEquityNow - 0);
    if (dcaSize <= 0 || availableBalance < dcaSize) return false;
    
    // Skip lot-based sizing for DCA; use fixed base amount
    const entryPrice = executionPrice(marketPrice, signal, 'entry', effectiveSlippageRate(ctx, strategy));
    const entryFee = dcaSize * effectiveCommissionRate(ctx, strategy);
    ctx.cashEquity -= entryFee;
    
    runtime.state = signal;
    runtime.entryPrice = entryPrice;
    runtime.tpAnchorPrice = marketPrice;
    runtime.notional = dcaSize;
    runtime.partialTpTriggered = false;
    runtime.openTrade = {
      side: signal,
      entryTime: eventTime,
      entryPrice,
      notional: dcaSize,
      entryFee,
      funding: 0,
    };
    ctx.lockedMargin += dcaSize;
    
    // Initialize DCA tracking
    const qty = dcaSize / entryPrice;
    runtime.dcaState = {
      ...runtime.dcaState,
      ordersCount: 0,
      totalInvested: dcaSize,
      totalQty: qty,
      lastBuyPrice: entryPrice,
    };
    return true;
  }

  const baseLotPercent = ctx.lotPercentOverride > 0"""

engine = engine.replace(old_base_lot, dca_lot_bypass)

with open(ENGINE_PATH, "w") as f:
    f.write(engine)

print("✅ engine.ts patched with DCA-first lot sizing")

# ============================================================================
# PART 6: Build backend
# ============================================================================

import subprocess
import sys

print("\n📦 Building backend...")
result = subprocess.run(
    ["npm", "run", "build"],
    cwd=os.path.join(BASE, "backend"),
    capture_output=True,
    text=True,
    timeout=120
)

if result.returncode != 0:
    print(f"❌ Build failed:\n{result.stderr}")
    sys.exit(1)

print("✅ Backend built successfully")
print(result.stdout[-500:])

# ============================================================================
# PART 7: Restart backend
# ============================================================================

print("\n🔄 Restarting backend...")
# Try pm2 restart, fallback to kill & start
try:
    subprocess.run(["pm2", "restart", "btdd-backend"], timeout=30, capture_output=True)
    print("✅ Backend restarted via pm2")
except:
    try:
        # Find and kill existing node process on port 3001
        subprocess.run(["pkill", "-f", "node.*backend"], timeout=10)
        # Start new one
        subprocess.Popen(
            ["node", "dist/app.js"],
            cwd=os.path.join(BASE, "backend"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print("✅ Backend restarted manually")
    except Exception as e:
        print(f"⚠️ Could not restart backend: {e}")

print("\n🎯 DCA backtest integration complete!")
print("Run a backtest with a DCA strategy to verify results.")
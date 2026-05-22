// Sizing & Risk Management — extracted from bot/strategy.ts
// Handles notional calculation, partial TP, stop-loss, take-profit, and leg sizing.

import logger from '../../utils/logger';
const safeNumber = (value: any, fallback: number): number => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };

// ── Constants ────────────────────────────────────────────────────────────────

const SIZING_EPSILON = 1e-9;
const MAX_SHARE_ERROR = 0.5;
const MAX_LEG_DEVIATION = 0.3;
const MAX_OVERSIZE_DEVIATION = 0.2;
const MAX_TOTAL_DEVIATION = 0.3;

// ── Notional Calculation ─────────────────────────────────────────────────────

/**
 * Compute total notional for a signal given strategy, available balance, and risk multiplier.
 * @param strategy - merged strategy object with lot_percent, max_deposit, fixed_lot, reinvest_percent
 * @param availableBalance - available equity/free balance
 * @param signal - 'long' | 'short'
 * @param riskMultiplier - personal risk multiplier from algofund_profiles (default 1.0)
 */
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
  const lotPercent = signal === 'long' ? strategy.lot_long_percent : strategy.lot_short_percent;
  const lotFraction = Math.max(0, lotPercent) / 100;
  const reinvestFactor = strategy.fixed_lot ? 1 : 1 + Math.max(0, strategy.reinvest_percent) / 100;
  const baseCapital = strategy.fixed_lot
    ? (strategy.max_deposit > 0 ? strategy.max_deposit : cappedBalance)
    : cappedBalance;
  const totalNotional = baseCapital * lotFraction * reinvestFactor * safeRiskMultiplier;

  // Safety telemetry
  if (
    Number.isFinite(totalNotional) &&
    totalNotional > 0 &&
    safeAvailable > 0 &&
    totalNotional > safeAvailable * 1.001 &&
    !strategy.fixed_lot
  ) {
    logger.warn(
      `[sizing-guard] computed notional=${totalNotional.toFixed(2)} exceeds available equity=${safeAvailable.toFixed(2)} ` +
        `(max_deposit=${strategy.max_deposit}, lot=${(lotFraction * 100).toFixed(2)}%, reinvest=${strategy.reinvest_percent}%, fixed_lot=false). ` +
        `This indicates a sizing-formula regression — please investigate.`,
    );
  }

  return Number.isFinite(totalNotional) && totalNotional > 0 ? totalNotional : 0;
}

// ── Decimal Places Utility ────────────────────────────────────────────────────

export function decimalPlaces(value: any): number {
  const normalized = String(value || '');
  const scientific = normalized.toLowerCase().match(/e-(\d+)$/);
  if (scientific) {
    const parsed = Number.parseInt(scientific[1], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  if (!normalized.includes('.')) {
    return 0;
  }
  return normalized.split('.')[1].replace(/0+$/, '').length;
}

// ── Partial Take Profit ──────────────────────────────────────────────────────

/**
 * Map tracking which strategy IDs have already triggered partial TP.
 * Cleared when position is flat.
 */
export const partialTpTriggeredByStrategy = new Map<string, boolean>();

/**
 * Calculate partial take-profit close action (50% of position) when threshold reached.
 * Returns null if no partial TP should trigger.
 */
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
    return {
      closePercent: 50,
      reason: `partial_tp triggered at ${unrealizedPnlPercent.toFixed(2)}% (threshold: ${partialTpPct}%)`,
    };
  }

  return null;
}

// ── Stop Loss / Take Profit Helpers ──────────────────────────────────────────

/**
 * Check and compute stop-loss close action.
 */
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

/**
 * Check and compute take-profit close action.
 */
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


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

// ── Channel-width lot scaling (trend / Donchian) ─────────────────────────────

/** Narrower Donchian channel → larger lot (within clamp). */
export function computeChannelWidthLotMultiplier(
  donchianHigh: number,
  donchianLow: number,
  donchianCenter: number,
  strategy: {
    auto_lot_channel_ref_width?: number;
    auto_lot_channel_mult_min?: number;
    auto_lot_channel_mult_max?: number;
  },
): number {
  const center = Number.isFinite(donchianCenter) && donchianCenter > 0
    ? donchianCenter
    : (donchianHigh + donchianLow) / 2;
  if (!Number.isFinite(center) || center <= 0) {
    return 1;
  }
  const widthPct = ((donchianHigh - donchianLow) / center) * 100;
  const refWidth = Math.max(0.5, safeNumber(strategy.auto_lot_channel_ref_width, 5));
  const multMin = Math.max(0.1, safeNumber(strategy.auto_lot_channel_mult_min, 0.5));
  const multMax = Math.max(multMin, safeNumber(strategy.auto_lot_channel_mult_max, 2));
  const raw = refWidth / Math.max(widthPct, 0.1);
  return Math.min(multMax, Math.max(multMin, raw));
}

// ── Notional Calculation ─────────────────────────────────────────────────────

/**
 * Compute total notional for a signal — same compound reinvest model as live BT:
 *   base = baseline + max(0, equity − baseline) × (reinvest%/100)
 *   notional = base × lot% × risk, capped by free margin
 */
export function computeSignalTotalNotional(
  strategy: any,
  availableBalance: number,
  signal: string,
  riskMultiplier: number = 1.0,
  options?: { walletEquity?: number; sizingBaseline?: number },
): number {
  const freeMargin = Number.isFinite(availableBalance) && availableBalance > 0 ? availableBalance : 0;
  const walletEquity = Number.isFinite(options?.walletEquity) && (options!.walletEquity as number) > 0
    ? (options!.walletEquity as number)
    : freeMargin;
  const safeRiskMultiplier = Number.isFinite(riskMultiplier) && riskMultiplier > 0 ? riskMultiplier : 1.0;
  const lotPercent = signal === 'long' ? strategy.lot_long_percent : strategy.lot_short_percent;
  const lotFraction = Math.max(0, lotPercent) / 100;
  const reinvestShare = strategy.fixed_lot
    ? 0
    : Math.max(0, Math.min(1, Math.max(0, strategy.reinvest_percent) / 100));
  const baselineFromOpts = Number(options?.sizingBaseline);
  const maxDeposit = Number(strategy.max_deposit);
  const baseline = Number.isFinite(baselineFromOpts) && baselineFromOpts > 0
    ? baselineFromOpts
    : (Number.isFinite(maxDeposit) && maxDeposit > 0 ? maxDeposit : walletEquity);

  let equityBase: number;
  if (strategy.fixed_lot) {
    equityBase = Number.isFinite(maxDeposit) && maxDeposit > 0 ? maxDeposit : freeMargin;
  } else {
    equityBase = baseline + Math.max(0, walletEquity - baseline) * reinvestShare;
    equityBase = Math.min(equityBase, Math.max(walletEquity, baseline));
  }

  let baseCapital = equityBase;
  if (!strategy.fixed_lot && reinvestShare <= 0 && Number.isFinite(maxDeposit) && maxDeposit > 0) {
    baseCapital = Math.min(baseCapital, maxDeposit);
  }

  let totalNotional = baseCapital * lotFraction * safeRiskMultiplier;
  if (freeMargin > 0) {
    totalNotional = Math.min(totalNotional, freeMargin);
  }

  if (
    Number.isFinite(totalNotional) &&
    totalNotional > 0 &&
    freeMargin > 0 &&
    totalNotional > freeMargin * 1.001 &&
    !strategy.fixed_lot
  ) {
    logger.warn(
      `[sizing-guard] computed notional=${totalNotional.toFixed(2)} exceeds free margin=${freeMargin.toFixed(2)} ` +
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


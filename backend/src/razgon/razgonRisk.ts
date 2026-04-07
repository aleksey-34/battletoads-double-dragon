// ─── Razgon Risk Manager ─────────────────────────────────────────────────────
import logger from '../utils/logger';
import type { RazgonConfig, RazgonPosition, RazgonTrade } from './razgonTypes';

interface DailyPnl {
  date: string;       // YYYY-MM-DD
  realized: number;
  trades: number;
}

export class RazgonRiskManager {
  private config: RazgonConfig;
  private dailyPnl: DailyPnl = { date: '', realized: 0, trades: 0 };
  private startBalance: number;
  private lastRescaleBalance: number;

  constructor(config: RazgonConfig, currentBalance: number) {
    this.config = config;
    this.startBalance = currentBalance;
    this.lastRescaleBalance = currentBalance;
  }

  updateConfig(config: RazgonConfig): void {
    this.config = config;
  }

  // ── Position Sizing ──────────────────────────────────────────────────────

  /**
   * Calculate margin to allocate for a trade.
   * Returns 0 if trade should be skipped (daily limit, etc.)
   */
  computeMargin(
    balance: number,
    allocation: number,
    leverage: number,
    stopLossPercent: number,
    openPositions: RazgonPosition[],
  ): number {
    // Check daily loss limit
    if (this.isDailyLimitHit(balance)) {
      logger.warn('[RazgonRisk] Daily loss limit reached, blocking new trades');
      return 0;
    }

    const maxRisk = balance * this.config.risk.maxRiskPerTrade;
    const stopFraction = stopLossPercent / 100;

    // Risk-based sizing: margin = maxRisk / (stopFraction * leverage)
    // Because loss = margin * leverage * stopFraction
    const riskBasedMargin = maxRisk / (stopFraction * leverage);

    // Allocation cap — divide by max concurrent positions for even distribution
    const maxPositions = this.config.momentum.maxConcurrentPositions || 3;
    const perPositionAllocation = allocation / maxPositions;
    const allocationMargin = balance * perPositionAllocation;

    // Already-locked margin
    const lockedMargin = openPositions.reduce((sum, p) => sum + p.margin, 0);
    const availableMargin = Math.max(0, balance * allocation - lockedMargin);

    const margin = Math.min(riskBasedMargin, allocationMargin, availableMargin);

    if (margin < 1) {
      logger.debug('[RazgonRisk] Computed margin < $1, skip trade');
      return 0;
    }

    return Math.floor(margin * 100) / 100; // round to 2 dp
  }

  // ── Daily Loss Tracking ────────────────────────────────────────────────

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  recordTrade(trade: RazgonTrade, balance: number): void {
    const today = this.todayKey();
    if (this.dailyPnl.date !== today) {
      this.dailyPnl = { date: today, realized: 0, trades: 0 };
    }
    this.dailyPnl.realized += trade.netPnl;
    this.dailyPnl.trades += 1;

    // Check rescale
    if (balance >= this.lastRescaleBalance * (1 + this.config.risk.rescaleThreshold)) {
      this.lastRescaleBalance = balance;
      logger.info(`[RazgonRisk] Rescale triggered at balance $${balance.toFixed(2)}`);
    }
  }

  isDailyLimitHit(balance: number): boolean {
    const today = this.todayKey();
    if (this.dailyPnl.date !== today) return false;
    const maxLoss = balance * this.config.risk.maxDailyLoss;
    return this.dailyPnl.realized <= -maxLoss;
  }

  getDailyPnl(): DailyPnl {
    const today = this.todayKey();
    if (this.dailyPnl.date !== today) {
      this.dailyPnl = { date: today, realized: 0, trades: 0 };
    }
    return { ...this.dailyPnl };
  }

  // ── SL / TP Prices ────────────────────────────────────────────────────

  computeStopLoss(entryPrice: number, side: 'long' | 'short', slPercent: number): number {
    const frac = slPercent / 100;
    return side === 'long'
      ? entryPrice * (1 - frac)
      : entryPrice * (1 + frac);
  }

  computeTrailingTp(anchor: number, side: 'long' | 'short', tpPercent: number): number {
    const frac = tpPercent / 100;
    return side === 'long'
      ? anchor * (1 - frac)
      : anchor * (1 + frac);
  }

  updateAnchor(currentAnchor: number, currentPrice: number, side: 'long' | 'short'): number {
    return side === 'long'
      ? Math.max(currentAnchor, currentPrice)
      : Math.min(currentAnchor, currentPrice);
  }

  isStopLossHit(price: number, slPrice: number, side: 'long' | 'short'): boolean {
    return side === 'long' ? price <= slPrice : price >= slPrice;
  }

  isTrailingTpHit(price: number, tpPrice: number, side: 'long' | 'short'): boolean {
    return side === 'long' ? price <= tpPrice : price >= tpPrice;
  }

  isTimedOut(openedAt: number, maxTimeSec: number): boolean {
    return Date.now() - openedAt >= maxTimeSec * 1000;
  }

  // ── PnL Calculation ───────────────────────────────────────────────────

  computeGrossPnl(entryPrice: number, exitPrice: number, notional: number, side: 'long' | 'short'): number {
    const priceDelta = side === 'long'
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;
    return notional * priceDelta;
  }

  computeFee(notional: number, feeRate: number = 0.0001): number {
    // MEXC: maker 0%, taker 0.01% → roundtrip ~0.01%
    return notional * feeRate * 2; // entry + exit
  }
}

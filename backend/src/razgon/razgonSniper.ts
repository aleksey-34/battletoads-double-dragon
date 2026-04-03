// ─── Razgon: FirstMover — Listing Sniper ─────────────────────────────────────
import logger from '../utils/logger';
import type { RazgonSniperConfig } from './razgonTypes';

export interface NewListing {
  symbol: string;
  detectedAt: number;     // epoch ms when we first saw it
  openPrice?: number;     // first trade price if available
}

/**
 * Detect newly listed symbols by comparing current symbol set to known set.
 * Returns array of new symbols not seen before.
 */
export function detectNewListings(
  currentSymbols: string[],
  knownSymbols: Set<string>,
): string[] {
  const newOnes: string[] = [];
  for (const sym of currentSymbols) {
    if (!knownSymbols.has(sym)) {
      newOnes.push(sym);
    }
  }
  return newOnes;
}

export type SniperAction = 'long_early' | 'long_bounce' | 'skip';

export interface SniperDecision {
  action: SniperAction;
  reason: string;
  suggestedTp?: number;    // price
  suggestedSl?: number;    // price
}

/**
 * Decide whether and how to enter a newly listed symbol.
 *
 * @param currentPrice - current market price
 * @param openPrice    - first candle open price of the listing
 * @param config       - sniper configuration
 */
export function decideSniperEntry(
  currentPrice: number,
  openPrice: number,
  config: RazgonSniperConfig,
): SniperDecision {
  if (openPrice <= 0 || currentPrice <= 0) {
    return { action: 'skip', reason: 'invalid_prices' };
  }

  const changeFromOpen = (currentPrice - openPrice) / openPrice;

  // Already pumped >5% — too late, risk of buying the top
  if (changeFromOpen > 0.05) {
    return { action: 'skip', reason: 'already_pumped' };
  }

  // Dumped >10% — bounce play
  if (changeFromOpen < -0.10) {
    const tpFrac = config.takeProfitPercent / 100;
    const slFrac = config.stopLossPercent / 100 * 1.4; // wider SL for bounce
    return {
      action: 'long_bounce',
      reason: 'bounce_after_dump',
      suggestedTp: currentPrice * (1 + tpFrac * 0.67), // more conservative TP
      suggestedSl: currentPrice * (1 - slFrac),
    };
  }

  // Within ±5% of open — fresh listing, enter long
  const tpFrac = config.takeProfitPercent / 100;
  const slFrac = config.stopLossPercent / 100;
  return {
    action: 'long_early',
    reason: 'fresh_listing',
    suggestedTp: currentPrice * (1 + tpFrac),
    suggestedSl: currentPrice * (1 - slFrac),
  };
}

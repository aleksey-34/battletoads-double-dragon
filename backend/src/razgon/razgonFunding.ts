// ─── Razgon: FundHarvest — Funding Rate Farming ──────────────────────────────
import logger from '../utils/logger';
import type { RazgonFundingConfig } from './razgonTypes';

export interface FundingCandidate {
  symbol: string;
  fundingRate: number;      // e.g. 0.001 = 0.1%
  nextFundingTime: number;  // epoch ms
  volume24h: number;
  recommendedSide: 'long' | 'short';  // side that RECEIVES funding
}

/**
 * Parse funding rates from exchange data and return top candidates.
 * Positive funding → shorts receive → recommend short.
 * Negative funding → longs receive → recommend long.
 */
export function selectFundingCandidates(
  rates: Array<{ symbol: string; fundingRate: number; nextFundingTime?: number; volume24h?: number }>,
  config: RazgonFundingConfig,
): FundingCandidate[] {
  const candidates: FundingCandidate[] = [];

  for (const r of rates) {
    const absFr = Math.abs(r.fundingRate);
    if (absFr < config.minFundingRate) continue;
    if ((r.volume24h ?? 0) < config.minVolume24h) continue;

    candidates.push({
      symbol: r.symbol,
      fundingRate: r.fundingRate,
      nextFundingTime: r.nextFundingTime ?? 0,
      volume24h: r.volume24h ?? 0,
      recommendedSide: r.fundingRate > 0 ? 'short' : 'long',
    });
  }

  // Sort by absolute funding rate descending
  candidates.sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));

  return candidates.slice(0, config.maxPositions);
}

/**
 * Estimate funding income per 8h cycle for given notional and rate.
 */
export function estimateFundingIncome(notional: number, fundingRate: number): number {
  return notional * Math.abs(fundingRate);
}

/**
 * Check if existing funding position should be closed:
 * - Funding rate flipped or became too small
 * - Unrealized loss exceeds threshold
 */
export function shouldCloseFundingPosition(
  currentFundingRate: number,
  originalSide: 'long' | 'short',
  unrealizedPnlPercent: number,
  stopLossPercent: number,
  minRate: number,
): { close: boolean; reason: string } {
  // Rate flipped — we now PAY funding
  const weReceive = (originalSide === 'short' && currentFundingRate > 0) ||
                    (originalSide === 'long' && currentFundingRate < 0);
  if (!weReceive) {
    return { close: true, reason: 'funding_rate_flipped' };
  }

  // Rate too small — edge gone
  if (Math.abs(currentFundingRate) < minRate * 0.4) {
    return { close: true, reason: 'funding_rate_too_low' };
  }

  // Unrealized loss too big
  if (unrealizedPnlPercent <= -(stopLossPercent)) {
    return { close: true, reason: 'stop_loss' };
  }

  return { close: false, reason: '' };
}

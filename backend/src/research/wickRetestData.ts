import { getMarketData, getTickersSnapshot, ensureExchangeClientInitialized } from '../bot/exchange';
import { calculateSyntheticOHLC } from '../bot/synthetic';
import type { WickCandle } from './wickRetestBacktest';

const parseRows = (rows: unknown): WickCandle[] => {
  if (!Array.isArray(rows)) return [];
  const out: WickCandle[] = [];
  for (const raw of rows) {
    if (Array.isArray(raw) && raw.length >= 5) {
      const timeMs = Number(raw[0]);
      const open = Number(raw[1]);
      const high = Number(raw[2]);
      const low = Number(raw[3]);
      const close = Number(raw[4]);
      if (![timeMs, open, high, low, close].every(Number.isFinite)) continue;
      out.push({ timeMs, open, high, low, close });
      continue;
    }
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      const timeMs = Number(o.timeMs ?? o.time ?? 0);
      const open = Number(o.open);
      const high = Number(o.high);
      const low = Number(o.low);
      const close = Number(o.close);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      const t = Number.isFinite(timeMs) && timeMs > 1e12 ? timeMs : Number(o.time) * (Number(o.time) < 1e12 ? 1000 : 1);
      if (!Number.isFinite(t)) continue;
      out.push({ timeMs: t, open, high, low, close });
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
};

export const fetchMonoCandles = async (
  apiKeyName: string,
  symbol: string,
  interval: string,
  options?: { startMs?: number; endMs?: number; limit?: number },
): Promise<WickCandle[]> => {
  const limit = options?.limit ?? 5000;
  const rows = await getMarketData(apiKeyName, symbol, interval, limit, {
    startMs: options?.startMs,
    endMs: options?.endMs,
  });
  return parseRows(rows);
};

export const fetchSyntheticCandles = async (
  apiKeyName: string,
  baseSymbol: string,
  quoteSymbol: string,
  interval: string,
  options?: { startMs?: number; endMs?: number; limit?: number },
): Promise<WickCandle[]> => {
  const limit = options?.limit ?? 5000;
  const rows = await calculateSyntheticOHLC(
    apiKeyName,
    baseSymbol,
    quoteSymbol,
    1,
    1,
    interval,
    limit,
    { startMs: options?.startMs, endMs: options?.endMs },
  );
  return parseRows(rows);
};

export type WickSimilarityRow = {
  symbol: string;
  bars: number;
  shadowRate: number;
  avgUpperWickPct: number;
  avgLowerWickPct: number;
  volatilityPct: number;
  turnover24h: number;
  change24h: number;
  score: number;
};

/** Scan tickers for wick-heavy / volatile behaviour (mono candidates). */
export const scanWickSimilarity = async (
  apiKeyName: string,
  interval: string,
  dateFromMs: number,
  dateToMs: number,
  options?: { minTurnover?: number; maxSymbols?: number; sampleBars?: number },
): Promise<WickSimilarityRow[]> => {
  const minTurnover = options?.minTurnover ?? 500_000;
  const maxSymbols = options?.maxSymbols ?? 80;
  const shadowThreshold = 4;

  await ensureExchangeClientInitialized(apiKeyName);
  const tickers = await getTickersSnapshot(apiKeyName);
  const usdt = tickers
    .filter((t: { symbol?: string }) => String(t.symbol || '').endsWith('USDT'))
    .filter((t: { turnover24h?: number }) => (t.turnover24h || 0) >= minTurnover)
    .sort((a: { turnover24h?: number }, b: { turnover24h?: number }) => (b.turnover24h || 0) - (a.turnover24h || 0))
    .slice(0, maxSymbols);

  const rows: WickSimilarityRow[] = [];

  for (const t of usdt) {
    const symbol = String(t.symbol).toUpperCase();
    try {
      const candles = await fetchMonoCandles(apiKeyName, symbol, interval, {
        startMs: dateFromMs,
        endMs: dateToMs,
        limit: options?.sampleBars ?? 2500,
      });
      if (candles.length < 100) continue;

      let shadowHits = 0;
      let sumUp = 0;
      let sumDn = 0;
      let sumVol = 0;
      for (const c of candles) {
        const bodyTop = Math.max(c.open, c.close);
        const bodyBottom = Math.min(c.open, c.close);
        const up = bodyTop > 0 ? ((c.high - bodyTop) / bodyTop) * 100 : 0;
        const dn = bodyBottom > 0 ? ((bodyBottom - c.low) / bodyBottom) * 100 : 0;
        if (up >= shadowThreshold || dn >= shadowThreshold) shadowHits += 1;
        sumUp += up;
        sumDn += dn;
        if (c.close > 0) sumVol += ((c.high - c.low) / c.close) * 100;
      }
      const n = candles.length;
      const shadowRate = shadowHits / n;
      const avgUpperWickPct = sumUp / n;
      const avgLowerWickPct = sumDn / n;
      const volatilityPct = sumVol / n;
      const turnover24h = t.turnover24h || 0;
      const change24h = Math.abs(t.change24hPercent || 0);
      const score =
        shadowRate * 40 +
        avgUpperWickPct * 2 +
        volatilityPct * 0.5 +
        Math.min(change24h, 30) * 0.3 +
        Math.log10(Math.max(turnover24h, 1)) * 0.5;

      rows.push({
        symbol,
        bars: n,
        shadowRate,
        avgUpperWickPct,
        avgLowerWickPct,
        volatilityPct,
        turnover24h,
        change24h,
        score,
      });
    } catch {
      // skip offline
    }
  }

  rows.sort((a, b) => b.score - a.score);
  return rows;
};

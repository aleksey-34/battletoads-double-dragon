/**
 * TV-style trend momentum scalp: EMA cross + ADX/DI filter, fixed TP/SL burst exits.
 * Maps common Pine "EMA crossover scalper" / "ADX trend filter" scripts.
 */

import type { WickCandle } from './wickRetestBacktest';

export type MomentumScalpSideMode = 'long' | 'short' | 'both';

export type MomentumScalpExitMode = 'wick' | 'close';

export type MomentumScalpConfig = {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  adxPeriod: number;
  adxMin: number;
  tpPercent: number;
  slPercent: number;
  /** Exit on opposite EMA cross */
  exitOnOppositeCross: boolean;
  /**
   * wick = intrabar high/low hits TP/SL (optimistic research).
   * close = closed-bar close only (matches live runtime).
   */
  exitMode: MomentumScalpExitMode;
  sideMode: MomentumScalpSideMode;
  barMinutes: number;
  commissionPercent: number;
  slippagePercent: number;
  initialBalance: number;
  positionFraction: number;
};

export type MomentumScalpTrade = {
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  netPnl: number;
  reason: string;
};

export type MomentumScalpSummary = {
  sideMode: MomentumScalpSideMode;
  bars: number;
  tradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  finalEquity: number;
};

export type MomentumScalpEquityPoint = { timeMs: number; equity: number };

export type MomentumScalpResult = {
  config: MomentumScalpConfig;
  summary: MomentumScalpSummary;
  trades: MomentumScalpTrade[];
  equityCurve: MomentumScalpEquityPoint[];
};

export type MomentumScalpMarketSpec = {
  key: string;
  candles: WickCandle[];
  config?: Partial<MomentumScalpConfig>;
};

export type MomentumScalpPortfolioResult = {
  summary: MomentumScalpSummary;
  trades: MomentumScalpTrade[];
  equityCurve: MomentumScalpEquityPoint[];
  perMarket: Array<{ key: string; trades: number; netPnl: number }>;
};

const defaults: MomentumScalpConfig = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  adxPeriod: 14,
  adxMin: 25,
  tpPercent: 1.5,
  slPercent: 1.0,
  exitOnOppositeCross: true,
  exitMode: 'close',
  sideMode: 'both',
  barMinutes: 60,
  commissionPercent: 0.1,
  slippagePercent: 0.05,
  initialBalance: 1000,
  positionFraction: 1,
};

/** Common TV trend-scalp preset (EMA 9/21, ADX>25, 1.5% TP / 1% SL). */
export const tvTrendScalpPreset = (): MomentumScalpConfig => ({ ...defaults });

/** EP4 research winner preset per symbol (15m EMA 8/21, ADX≥20). */
export const tvBurstEp4Preset = (): Partial<MomentumScalpConfig> => ({
  emaFastPeriod: 8,
  emaSlowPeriod: 21,
  adxPeriod: 14,
  adxMin: 20,
  tpPercent: 2.0,
  slPercent: 1.2,
  exitOnOppositeCross: true,
  sideMode: 'both',
  barMinutes: 15,
});

export const TV_BURST_MONO_MARKETS = ['SUIUSDT', 'DOGEUSDT', 'SOLUSDT'] as const;

type AdxRow = { adx: number; plusDi: number; minusDi: number };

const emaSeries = (values: number[], period: number): number[] => {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
};

/** Wilder RMA aligned to full-length series; first value at `firstIdx` = SMA of period samples ending there. */
const wilderSmoothFull = (raw: number[], period: number, firstIdx: number): number[] => {
  const out = new Array<number>(raw.length).fill(NaN);
  if (firstIdx < period || firstIdx >= raw.length) return out;
  let sum = 0;
  for (let i = firstIdx - period + 1; i <= firstIdx; i += 1) sum += raw[i];
  let prev = sum / period;
  out[firstIdx] = prev;
  for (let i = firstIdx + 1; i < raw.length; i += 1) {
    prev = (prev * (period - 1) + raw[i]) / period;
    out[i] = prev;
  }
  return out;
};

const computeAdxRows = (candles: WickCandle[], period: number): AdxRow[] => {
  const n = candles.length;
  const out: AdxRow[] = new Array(n).fill(null).map(() => ({ adx: NaN, plusDi: NaN, minusDi: NaN }));
  if (n <= period * 2) return out;

  const tr: number[] = new Array(n).fill(0);
  const plusDm: number[] = new Array(n).fill(0);
  const minusDm: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i += 1) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }

  const atr = wilderSmoothFull(tr, period, period);
  const plusSm = wilderSmoothFull(plusDm, period, period);
  const minusSm = wilderSmoothFull(minusDm, period, period);

  const dx: number[] = new Array(n).fill(NaN);
  for (let i = period; i < n; i += 1) {
    const trv = atr[i];
    if (!Number.isFinite(trv) || trv <= 0) continue;
    const pdi = (100 * plusSm[i]) / trv;
    const mdi = (100 * minusSm[i]) / trv;
    out[i] = { plusDi: pdi, minusDi: mdi, adx: NaN };
    const denom = pdi + mdi;
    dx[i] = denom > 0 ? (100 * Math.abs(pdi - mdi)) / denom : 0;
  }

  const adxFirst = period * 2;
  let dxSum = 0;
  let dxOk = true;
  for (let i = period; i <= adxFirst; i += 1) {
    if (!Number.isFinite(dx[i])) {
      dxOk = false;
      break;
    }
    dxSum += dx[i];
  }
  if (dxOk) {
    let prev = dxSum / period;
    out[adxFirst].adx = prev;
    for (let i = adxFirst + 1; i < n; i += 1) {
      if (!Number.isFinite(dx[i])) break;
      prev = (prev * (period - 1) + dx[i]) / period;
      out[i].adx = prev;
    }
  }
  return out;
};

const slip = (price: number, side: 'long' | 'short', isEntry: boolean, pct: number): number => {
  const m = pct / 100;
  if (side === 'long') return isEntry ? price * (1 + m) : price * (1 - m);
  return isEntry ? price * (1 - m) : price * (1 + m);
};

const fee = (notional: number, commissionPercent: number): number => notional * (commissionPercent / 100);

export const runMomentumScalpBacktest = (
  candles: WickCandle[],
  partial?: Partial<MomentumScalpConfig>,
): MomentumScalpResult => {
  const cfg: MomentumScalpConfig = { ...defaults, ...partial };
  const closes = candles.map((c) => c.close);
  const emaFast = emaSeries(closes, cfg.emaFastPeriod);
  const emaSlow = emaSeries(closes, cfg.emaSlowPeriod);
  const adxRows = computeAdxRows(candles, cfg.adxPeriod);

  const trades: MomentumScalpTrade[] = [];
  const equityCurve: MomentumScalpEquityPoint[] = [];
  let equity = cfg.initialBalance;
  let peak = equity;
  let maxDd = 0;

  type Pos = { side: 'long' | 'short'; entryTime: number; entryPrice: number; qty: number };
  let pos: Pos | null = null;

  const warmup = Math.max(cfg.emaSlowPeriod, cfg.adxPeriod * 2) + 2;

  const markEquity = (timeMs: number): void => {
    equityCurve.push({ timeMs, equity });
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  };

  const closePos = (c: WickCandle, exitRaw: number, reason: string): void => {
    if (!pos) return;
    const exitPx = slip(exitRaw, pos.side, false, cfg.slippagePercent);
    const gross =
      pos.side === 'long'
        ? (exitPx - pos.entryPrice) * pos.qty
        : (pos.entryPrice - exitPx) * pos.qty;
    const fees =
      fee(pos.entryPrice * pos.qty, cfg.commissionPercent) +
      fee(exitPx * pos.qty, cfg.commissionPercent);
    const net = gross - fees;
    trades.push({
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime: c.timeMs,
      entryPrice: pos.entryPrice,
      exitPrice: exitPx,
      qty: pos.qty,
      netPnl: net,
      reason,
    });
    equity += net;
    pos = null;
    markEquity(c.timeMs);
  };

  markEquity(candles[warmup]?.timeMs ?? 0);

  for (let i = warmup; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1];
    const ef = emaFast[i];
    const es = emaSlow[i];
    const efP = emaFast[i - 1];
    const esP = emaSlow[i - 1];
    const adx = adxRows[i];
    if (![ef, es, efP, esP].every(Number.isFinite) || !Number.isFinite(adx.adx)) continue;

    if (pos) {
      const tp =
        pos.side === 'long'
          ? pos.entryPrice * (1 + cfg.tpPercent / 100)
          : pos.entryPrice * (1 - cfg.tpPercent / 100);
      const sl =
        pos.side === 'long'
          ? pos.entryPrice * (1 - cfg.slPercent / 100)
          : pos.entryPrice * (1 + cfg.slPercent / 100);

      const useClose = cfg.exitMode === 'close';
      const hitSl = useClose
        ? (pos.side === 'long' ? c.close <= sl : c.close >= sl)
        : (pos.side === 'long' ? c.low <= sl : c.high >= sl);
      const hitTp = useClose
        ? (pos.side === 'long' ? c.close >= tp : c.close <= tp)
        : (pos.side === 'long' ? c.high >= tp : c.low <= tp);
      if (hitSl) {
        closePos(c, useClose ? c.close : sl, 'sl');
      } else if (hitTp) {
        closePos(c, useClose ? c.close : tp, 'tp');
      } else if (cfg.exitOnOppositeCross) {
        const oppLong = pos.side === 'short' && efP <= esP && ef > es;
        const oppShort = pos.side === 'long' && efP >= esP && ef < es;
        if (oppLong || oppShort) closePos(c, c.close, 'cross');
      }
      if (pos) continue;
    }

    const bullCross = efP <= esP && ef > es;
    const bearCross = efP >= esP && ef < es;
    const trending = adx.adx >= cfg.adxMin;

    const tryLong = (cfg.sideMode === 'long' || cfg.sideMode === 'both') && bullCross && trending && adx.plusDi > adx.minusDi;
    const tryShort = (cfg.sideMode === 'short' || cfg.sideMode === 'both') && bearCross && trending && adx.minusDi > adx.plusDi;

    const side = tryLong ? 'long' : tryShort ? 'short' : null;
    if (!side) continue;

    const entryPx = slip(c.close, side, true, cfg.slippagePercent);
    const notional = equity * cfg.positionFraction;
    const qty = entryPx > 0 ? notional / entryPx : 0;
    if (qty <= 0) continue;
    pos = { side, entryTime: c.timeMs, entryPrice: entryPx, qty };
    markEquity(c.timeMs);
  }

  if (pos && candles.length > 0) {
    const last = candles[candles.length - 1];
    closePos(last, last.close, 'eod');
  }

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  for (const t of trades) {
    if (t.netPnl >= 0) {
      wins += 1;
      grossProfit += t.netPnl;
    } else grossLoss += Math.abs(t.netPnl);
  }

  const summary: MomentumScalpSummary = {
    sideMode: cfg.sideMode,
    bars: candles.length,
    tradesCount: trades.length,
    winRatePercent: trades.length ? (wins / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    totalReturnPercent:
      cfg.initialBalance > 0 ? ((equity - cfg.initialBalance) / cfg.initialBalance) * 100 : 0,
    maxDrawdownPercent: maxDd,
    finalEquity: equity,
  };

  if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1].timeMs !== candles[candles.length - 1]?.timeMs) {
    markEquity(candles[candles.length - 1]?.timeMs ?? 0);
  }

  return { config: cfg, summary, trades, equityCurve };
};

type MarketIndicators = {
  emaFast: number[];
  emaSlow: number[];
  adxRows: AdxRow[];
  warmup: number;
};

const buildIndicators = (candles: WickCandle[], cfg: MomentumScalpConfig): MarketIndicators => {
  const closes = candles.map((c) => c.close);
  return {
    emaFast: emaSeries(closes, cfg.emaFastPeriod),
    emaSlow: emaSeries(closes, cfg.emaSlowPeriod),
    adxRows: computeAdxRows(candles, cfg.adxPeriod),
    warmup: Math.max(cfg.emaSlowPeriod, cfg.adxPeriod * 2) + 2,
  };
};

/** Shared-equity burst cloud (TV EMA+ADX), max concurrent positions across markets. */
export const runMomentumScalpPortfolio = (
  markets: MomentumScalpMarketSpec[],
  partial?: Partial<MomentumScalpConfig> & { maxOpenPositions?: number },
): MomentumScalpPortfolioResult => {
  const baseCfg: MomentumScalpConfig = { ...defaults, ...partial };
  const maxOp = Math.max(1, Math.floor(partial?.maxOpenPositions ?? markets.length));
  const trades: MomentumScalpTrade[] = [];
  const equityCurve: MomentumScalpEquityPoint[] = [];
  let equity = baseCfg.initialBalance;
  let peak = equity;
  let maxDd = 0;

  const perMarketPnl = new Map<string, number>();
  const perMarketTrades = new Map<string, number>();

  type Pos = { key: string; side: 'long' | 'short'; entryTime: number; entryPrice: number; qty: number };
  const positions = new Map<string, Pos>();

  const specs = markets.map((m) => {
    const cfg = { ...baseCfg, ...m.config };
    perMarketPnl.set(m.key, 0);
    perMarketTrades.set(m.key, 0);
    const map = new Map<number, number>();
    m.candles.forEach((c, idx) => map.set(c.timeMs, idx));
    return { ...m, cfg, ind: buildIndicators(m.candles, cfg), map };
  });

  const markEquity = (timeMs: number): void => {
    equityCurve.push({ timeMs, equity });
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  };

  const closePos = (key: string, c: WickCandle, exitRaw: number, reason: string, cfg: MomentumScalpConfig): void => {
    const pos = positions.get(key);
    if (!pos) return;
    const exitPx = slip(exitRaw, pos.side, false, cfg.slippagePercent);
    const gross =
      pos.side === 'long'
        ? (exitPx - pos.entryPrice) * pos.qty
        : (pos.entryPrice - exitPx) * pos.qty;
    const fees =
      fee(pos.entryPrice * pos.qty, cfg.commissionPercent) +
      fee(exitPx * pos.qty, cfg.commissionPercent);
    const net = gross - fees;
    trades.push({
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime: c.timeMs,
      entryPrice: pos.entryPrice,
      exitPrice: exitPx,
      qty: pos.qty,
      netPnl: net,
      reason,
    });
    equity += net;
    perMarketPnl.set(key, (perMarketPnl.get(key) || 0) + net);
    perMarketTrades.set(key, (perMarketTrades.get(key) || 0) + 1);
    positions.delete(key);
    markEquity(c.timeMs);
  };

  const allTimes = Array.from(
    new Set(markets.flatMap((m) => m.candles.map((c) => c.timeMs))),
  ).sort((a, b) => a - b);

  if (allTimes.length > 0) markEquity(allTimes[0]);

  for (const timeMs of allTimes) {
    for (const spec of specs) {
      const idx = spec.map.get(timeMs);
      if (idx === undefined || idx < spec.ind.warmup) continue;
      const c = spec.candles[idx];
      const cfg = spec.cfg;
      const { emaFast, emaSlow, adxRows } = spec.ind;
      const i = idx;
      const prev = spec.candles[i - 1];
      const ef = emaFast[i];
      const es = emaSlow[i];
      const efP = emaFast[i - 1];
      const esP = emaSlow[i - 1];
      const adx = adxRows[i];
      if (![ef, es, efP, esP].every(Number.isFinite) || !Number.isFinite(adx.adx)) continue;

      const pos = positions.get(spec.key);
      if (pos) {
        const tp =
          pos.side === 'long'
            ? pos.entryPrice * (1 + cfg.tpPercent / 100)
            : pos.entryPrice * (1 - cfg.tpPercent / 100);
        const sl =
          pos.side === 'long'
            ? pos.entryPrice * (1 - cfg.slPercent / 100)
            : pos.entryPrice * (1 + cfg.slPercent / 100);
        const hitSl = pos.side === 'long' ? c.low <= sl : c.high >= sl;
        const hitTp = pos.side === 'long' ? c.high >= tp : c.low <= tp;
        if (hitSl) closePos(spec.key, c, sl, 'sl', cfg);
        else if (hitTp) closePos(spec.key, c, tp, 'tp', cfg);
        else if (cfg.exitOnOppositeCross) {
          const oppLong = pos.side === 'short' && efP <= esP && ef > es;
          const oppShort = pos.side === 'long' && efP >= esP && ef < es;
          if (oppLong || oppShort) closePos(spec.key, c, c.close, 'cross', cfg);
        }
        if (positions.has(spec.key)) continue;
      }

      if (positions.size >= maxOp) continue;

      const bullCross = efP <= esP && ef > es;
      const bearCross = efP >= esP && ef < es;
      const trending = adx.adx >= cfg.adxMin;
      const tryLong =
        (cfg.sideMode === 'long' || cfg.sideMode === 'both') && bullCross && trending && adx.plusDi > adx.minusDi;
      const tryShort =
        (cfg.sideMode === 'short' || cfg.sideMode === 'both') && bearCross && trending && adx.minusDi > adx.plusDi;
      const side = tryLong ? 'long' : tryShort ? 'short' : null;
      if (!side) continue;

      const entryPx = slip(c.close, side, true, cfg.slippagePercent);
      const notional = (equity / maxOp) * cfg.positionFraction;
      const qty = entryPx > 0 ? notional / entryPx : 0;
      if (qty <= 0) continue;
      positions.set(spec.key, { key: spec.key, side, entryTime: c.timeMs, entryPrice: entryPx, qty });
      markEquity(c.timeMs);
    }
  }

  for (const spec of specs) {
    const pos = positions.get(spec.key);
    if (!pos) continue;
    const last = spec.candles[spec.candles.length - 1];
    closePos(spec.key, last, last.close, 'eod', spec.cfg);
  }

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  for (const t of trades) {
    if (t.netPnl >= 0) {
      wins += 1;
      grossProfit += t.netPnl;
    } else grossLoss += Math.abs(t.netPnl);
  }

  const summary: MomentumScalpSummary = {
    sideMode: baseCfg.sideMode,
    bars: Math.max(...markets.map((m) => m.candles.length), 0),
    tradesCount: trades.length,
    winRatePercent: trades.length ? (wins / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    totalReturnPercent:
      baseCfg.initialBalance > 0 ? ((equity - baseCfg.initialBalance) / baseCfg.initialBalance) * 100 : 0,
    maxDrawdownPercent: maxDd,
    finalEquity: equity,
  };

  return {
    summary,
    trades,
    equityCurve,
    perMarket: markets.map((m) => ({
      key: m.key,
      trades: perMarketTrades.get(m.key) || 0,
      netPnl: perMarketPnl.get(m.key) || 0,
    })),
  };
};

/** Slice trades/summary metrics for a time window (exit time). */
export const summarizeWindow = (
  trades: MomentumScalpTrade[],
  startMs: number,
  endMs: number,
  initialBalance: number,
): { ret: number; trades: number; netPnl: number } => {
  const slice = trades.filter((t) => t.exitTime >= startMs && t.exitTime <= endMs);
  const netPnl = slice.reduce((s, t) => s + t.netPnl, 0);
  return {
    ret: initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0,
    trades: slice.length,
    netPnl,
  };
};

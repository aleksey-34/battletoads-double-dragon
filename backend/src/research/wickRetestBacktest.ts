/**
 * Wick-shadow retest strategy (Pine "no name script from master TZ") — market execution.
 * Short: upper wick → topLine → retest (high >= topLine) → scale-out TPs + SL.
 * Long: lower wick mirror on bottomLine.
 */

export type WickRetestSideMode = 'short' | 'long' | 'both';

export type WickRetestConfig = {
  /** Upper/lower wick vs body, % */
  shadowPercent: number;
  /** Level inside wick (50 = halfway into shadow) */
  overlapPercent: number;
  earlyOverlapPercent: number;
  /** Min gap close vs line before entry, % */
  sizeCandlePercent: number;
  tp1DistPercent: number;
  tp1QtyPercent: number;
  tp2DistPercent: number;
  tp2QtyPercent: number;
  tp3DistPercent: number;
  slDistPercent: number;
  useNewFilter: boolean;
  daysToWait: number;
  sideMode: WickRetestSideMode;
  /** Bar interval in minutes (for daysToWait ms) */
  barMinutes: number;
  commissionPercent: number;
  slippagePercent: number;
  initialBalance: number;
  /** Fraction of equity per trade (0..1) */
  positionFraction: number;
};

export type WickCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type WickRetestTrade = {
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  netPnl: number;
  fees: number;
  reason: string;
};

export type WickRetestSummary = {
  sideMode: WickRetestSideMode;
  bars: number;
  tradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  finalEquity: number;
  grossProfit: number;
  grossLoss: number;
  shadowSignals: number;
  entriesAttempted: number;
};

export type WickRetestResult = {
  config: WickRetestConfig;
  summary: WickRetestSummary;
  trades: WickRetestTrade[];
  equityCurve: Array<{ timeMs: number; equity: number }>;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const defaults: WickRetestConfig = {
  shadowPercent: 4,
  overlapPercent: 50,
  earlyOverlapPercent: 50,
  sizeCandlePercent: 5,
  tp1DistPercent: 3,
  tp1QtyPercent: 60,
  tp2DistPercent: 5,
  tp2QtyPercent: 20,
  tp3DistPercent: 10,
  slDistPercent: 6,
  useNewFilter: true,
  daysToWait: 1,
  sideMode: 'short',
  barMinutes: 240,
  commissionPercent: 0.1,
  slippagePercent: 0.05,
  initialBalance: 1000,
  positionFraction: 1,
};

export const screenshotWickConfig = (): WickRetestConfig => ({ ...defaults });

type SideState = {
  line: number | null;
  line50: number | null;
  newFilter: boolean;
  lastChangeTime: number | null;
};

type OpenPos = {
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  qty: number;
  remainingQty: number;
  tp1Done: boolean;
  tp2Done: boolean;
};

type PendingEntry = {
  side: 'long' | 'short';
  line: number;
  placedAt: number;
};

const applySlippage = (price: number, side: 'long' | 'short', isEntry: boolean, slipPct: number): number => {
  const m = slipPct / 100;
  if (side === 'long') {
    return isEntry ? price * (1 + m) : price * (1 - m);
  }
  return isEntry ? price * (1 + m) : price * (1 - m);
};

const feeOnNotional = (notional: number, commissionPercent: number): number =>
  notional * (commissionPercent / 100);

const initSideState = (): SideState => ({
  line: null,
  line50: null,
  newFilter: true,
  lastChangeTime: null,
});

const updateShortState = (state: SideState, c: WickCandle, shadowPercent: number, overlapPercent: number, earlyOverlapPercent: number): void => {
  const bodyTop = Math.max(c.open, c.close);
  const wickPercent = bodyTop > 0 ? ((c.high - bodyTop) / bodyTop) * 100 : 0;
  const condition = wickPercent >= shadowPercent;

  if (condition) {
    const wickLevel = bodyTop + (c.high - bodyTop) * (overlapPercent / 100);
    const wickLevel50 = bodyTop + (c.high - bodyTop) * (earlyOverlapPercent / 100);
    state.line = wickLevel;
    state.line50 = wickLevel50;
    state.newFilter = true;
    state.lastChangeTime = c.timeMs;
  } else if (state.line50 !== null && c.high >= state.line50) {
    state.newFilter = false;
  }
};

const updateLongState = (state: SideState, c: WickCandle, shadowPercent: number, overlapPercent: number, earlyOverlapPercent: number): void => {
  const bodyBottom = Math.min(c.open, c.close);
  const wickPercent = bodyBottom > 0 ? ((bodyBottom - c.low) / bodyBottom) * 100 : 0;
  const condition = wickPercent >= shadowPercent;

  if (condition) {
    const wickLevel = bodyBottom - (bodyBottom - c.low) * (overlapPercent / 100);
    const wickLevel50 = bodyBottom - (bodyBottom - c.low) * (earlyOverlapPercent / 100);
    state.line = wickLevel;
    state.line50 = wickLevel50;
    state.newFilter = true;
    state.lastChangeTime = c.timeMs;
  } else if (state.line50 !== null && c.low <= state.line50) {
    state.newFilter = false;
  }
};

/** Pine: place limit when close on correct side with gap; market fill when price touches line. */
const shortPlacePending = (state: SideState, c: WickCandle, cfg: WickRetestConfig): number | null => {
  const line = state.line;
  if (line === null || state.lastChangeTime === null) return null;
  if (c.timeMs - state.lastChangeTime < cfg.daysToWait * MS_PER_DAY) return null;
  if (cfg.useNewFilter && !state.newFilter) return null;
  if (c.close >= line) return null;
  const percentDiff = ((line - c.close) / c.close) * 100;
  if (percentDiff <= cfg.sizeCandlePercent) return null;
  return line;
};

const longPlacePending = (state: SideState, c: WickCandle, cfg: WickRetestConfig): number | null => {
  const line = state.line;
  if (line === null || state.lastChangeTime === null) return null;
  if (c.timeMs - state.lastChangeTime < cfg.daysToWait * MS_PER_DAY) return null;
  if (cfg.useNewFilter && !state.newFilter) return null;
  if (c.close <= line) return null;
  const percentDiff = ((c.close - line) / c.close) * 100;
  if (percentDiff <= cfg.sizeCandlePercent) return null;
  return line;
};

const shortFillPending = (pending: PendingEntry, c: WickCandle): boolean =>
  c.high >= pending.line;

const longFillPending = (pending: PendingEntry, c: WickCandle): boolean =>
  c.low <= pending.line;

const processExitsOnBar = (
  pos: OpenPos,
  c: WickCandle,
  cfg: WickRetestConfig,
  trades: WickRetestTrade[],
): OpenPos | null => {
  const { side, entryPrice } = pos;
  let remaining = pos.remainingQty;
  if (remaining <= 1e-12) return null;

  const slip = cfg.slippagePercent;
  const comm = cfg.commissionPercent;

  const tpPrices =
    side === 'short'
      ? [
          entryPrice * (1 - cfg.tp1DistPercent / 100),
          entryPrice * (1 - cfg.tp2DistPercent / 100),
          entryPrice * (1 - cfg.tp3DistPercent / 100),
        ]
      : [
          entryPrice * (1 + cfg.tp1DistPercent / 100),
          entryPrice * (1 + cfg.tp2DistPercent / 100),
          entryPrice * (1 + cfg.tp3DistPercent / 100),
        ];

  const slPrice =
    side === 'short'
      ? entryPrice * (1 + cfg.slDistPercent / 100)
      : entryPrice * (1 - cfg.slDistPercent / 100);

  const hitSl = side === 'short' ? c.high >= slPrice : c.low <= slPrice;

  const closeQty = (qty: number, exitRaw: number, reason: string): void => {
    if (qty <= 1e-12 || remaining <= 1e-12) return;
    const actualQty = Math.min(qty, remaining);
    const exitPx = applySlippage(exitRaw, side, false, slip);
    const gross =
      side === 'short'
        ? (entryPrice - exitPx) * actualQty
        : (exitPx - entryPrice) * actualQty;
    const fees =
      feeOnNotional(entryPrice * actualQty, comm) + feeOnNotional(exitPx * actualQty, comm);
    trades.push({
      side,
      entryTime: pos.entryTime,
      exitTime: c.timeMs,
      entryPrice,
      exitPrice: exitPx,
      qty: actualQty,
      grossPnl: gross,
      netPnl: gross - fees,
      fees,
      reason,
    });
    remaining -= actualQty;
    pos.remainingQty = remaining;
  };

  if (hitSl) {
    closeQty(remaining, slPrice, 'sl');
    return null;
  }

  const legHits = [
    side === 'short' ? c.low <= tpPrices[0] : c.high >= tpPrices[0],
    side === 'short' ? c.low <= tpPrices[1] : c.high >= tpPrices[1],
    side === 'short' ? c.low <= tpPrices[2] : c.high >= tpPrices[2],
  ];

  if (!pos.tp1Done && legHits[0]) {
    closeQty(pos.qty * (cfg.tp1QtyPercent / 100), tpPrices[0], 'tp1');
    pos.tp1Done = true;
  }
  if (!pos.tp2Done && legHits[1] && remaining > 1e-12) {
    closeQty(pos.qty * (cfg.tp2QtyPercent / 100), tpPrices[1], 'tp2');
    pos.tp2Done = true;
  }
  if (legHits[2] && remaining > 1e-12) {
    closeQty(remaining, tpPrices[2], 'tp3');
    return null;
  }

  return remaining > 1e-12 ? pos : null;
};

export const runWickRetestBacktest = (
  candles: WickCandle[],
  partialConfig?: Partial<WickRetestConfig>,
): WickRetestResult => {
  const cfg: WickRetestConfig = { ...defaults, ...partialConfig };
  const trades: WickRetestTrade[] = [];
  let equity = cfg.initialBalance;
  let peak = equity;
  let maxDdPct = 0;
  let shadowSignals = 0;
  let entriesAttempted = 0;

  const shortState = initSideState();
  const longState = initSideState();
  let position: OpenPos | null = null;
  let pendingShort: PendingEntry | null = null;
  let pendingLong: PendingEntry | null = null;
  const equityCurve: Array<{ timeMs: number; equity: number }> = [];

  const modes: Array<'short' | 'long'> =
    cfg.sideMode === 'both' ? ['short', 'long'] : [cfg.sideMode === 'long' ? 'long' : 'short'];

  const openPosition = (mode: 'long' | 'short', line: number, timeMs: number): void => {
    entriesAttempted += 1;
    const entryPx = applySlippage(line, mode, true, cfg.slippagePercent);
    const notional = equity * cfg.positionFraction;
    const qty = entryPx > 0 ? notional / entryPx : 0;
    if (qty <= 0) return;
    equity -= feeOnNotional(notional, cfg.commissionPercent);
    position = {
      side: mode,
      entryTime: timeMs,
      entryPrice: entryPx,
      qty,
      remainingQty: qty,
      tp1Done: false,
      tp2Done: false,
    };
  };

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const prevShortLine = shortState.line;
    const prevLongLine = longState.line;

    if (cfg.sideMode === 'both') {
      updateShortState(shortState, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
      updateLongState(longState, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
    } else if (cfg.sideMode === 'short') {
      updateShortState(shortState, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
    } else {
      updateLongState(longState, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
    }

    if (shortState.line !== prevShortLine) pendingShort = null;
    if (longState.line !== prevLongLine) pendingLong = null;

    const bodyTop = Math.max(c.open, c.close);
    const wickUp = bodyTop > 0 ? ((c.high - bodyTop) / bodyTop) * 100 : 0;
    const bodyBottom = Math.min(c.open, c.close);
    const wickDn = bodyBottom > 0 ? ((bodyBottom - c.low) / bodyBottom) * 100 : 0;
    if (wickUp >= cfg.shadowPercent || wickDn >= cfg.shadowPercent) {
      shadowSignals += 1;
    }

    if (position) {
      const tradeCountBefore = trades.length;
      const next = processExitsOnBar(position, c, cfg, trades);
      for (let ti = tradeCountBefore; ti < trades.length; ti += 1) {
        equity += trades[ti].netPnl;
      }
      position = next;
    }

    if (!position) {
      if (modes.includes('short')) {
        if (pendingShort && shortFillPending(pendingShort, c)) {
          openPosition('short', pendingShort.line, c.timeMs);
          pendingShort = null;
        } else {
          const line = shortPlacePending(shortState, c, cfg);
          if (line !== null) pendingShort = { side: 'short', line, placedAt: c.timeMs };
        }
      }
      if (!position && modes.includes('long')) {
        if (pendingLong && longFillPending(pendingLong, c)) {
          openPosition('long', pendingLong.line, c.timeMs);
          pendingLong = null;
        } else {
          const line = longPlacePending(longState, c, cfg);
          if (line !== null) pendingLong = { side: 'long', line, placedAt: c.timeMs };
        }
      }
    }

    peak = Math.max(peak, equity);
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDdPct = Math.max(maxDdPct, dd);
    equityCurve.push({ timeMs: c.timeMs, equity });
  }

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      wins += 1;
      grossProfit += t.netPnl;
    } else {
      grossLoss += Math.abs(t.netPnl);
    }
  }

  const summary: WickRetestSummary = {
    sideMode: cfg.sideMode,
    bars: candles.length,
    tradesCount: trades.length,
    winRatePercent: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    totalReturnPercent: cfg.initialBalance > 0 ? ((equity - cfg.initialBalance) / cfg.initialBalance) * 100 : 0,
    maxDrawdownPercent: maxDdPct,
    finalEquity: equity,
    grossProfit,
    grossLoss,
    shadowSignals,
    entriesAttempted,
  };

  return { config: cfg, summary, trades, equityCurve };
};

/** Portfolio: many markets, shared equity, max concurrent positions (OP). */
export type WickPortfolioMarket = {
  key: string;
  candles: WickCandle[];
};

export type WickPortfolioResult = {
  op: number;
  sideMode: WickRetestSideMode;
  summary: WickRetestSummary;
  perMarket: Array<{ key: string; trades: number; netPnl: number }>;
};

export const runWickRetestPortfolio = (
  markets: WickPortfolioMarket[],
  partialConfig?: Partial<WickRetestConfig> & { maxOpenPositions?: number },
): WickPortfolioResult => {
  const cfg: WickRetestConfig = { ...defaults, ...partialConfig };
  const maxOp = Math.max(1, Math.floor(partialConfig?.maxOpenPositions ?? 2));
  const trades: WickRetestTrade[] = [];
  let equity = cfg.initialBalance;
  let peak = equity;
  let maxDdPct = 0;

  const states = new Map<string, { short: SideState; long: SideState }>();
  const positions = new Map<string, OpenPos>();
  const pendingByKey = new Map<string, { short: PendingEntry | null; long: PendingEntry | null }>();
  const perMarketPnl = new Map<string, number>();
  const perMarketTrades = new Map<string, number>();

  for (const m of markets) {
    states.set(m.key, { short: initSideState(), long: initSideState() });
    pendingByKey.set(m.key, { short: null, long: null });
    perMarketPnl.set(m.key, 0);
    perMarketTrades.set(m.key, 0);
  }

  const maxLen = Math.max(...markets.map((m) => m.candles.length), 0);
  const timeIndexMaps = markets.map((m) => {
    const map = new Map<number, number>();
    m.candles.forEach((c, idx) => map.set(c.timeMs, idx));
    return { key: m.key, candles: m.candles, map };
  });

  const allTimes = Array.from(
    new Set(markets.flatMap((m) => m.candles.map((c) => c.timeMs))),
  ).sort((a, b) => a - b);

  for (const timeMs of allTimes) {
    for (const { key, candles, map } of timeIndexMaps) {
      const idx = map.get(timeMs);
      if (idx === undefined) continue;
      const c = candles[idx];
      const st = states.get(key)!;
      const pend = pendingByKey.get(key)!;
      const prevShortLine = st.short.line;
      const prevLongLine = st.long.line;

      if (cfg.sideMode === 'both') {
        updateShortState(st.short, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
        updateLongState(st.long, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
      } else if (cfg.sideMode === 'short') {
        updateShortState(st.short, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
      } else {
        updateLongState(st.long, c, cfg.shadowPercent, cfg.overlapPercent, cfg.earlyOverlapPercent);
      }

      if (st.short.line !== prevShortLine) pend.short = null;
      if (st.long.line !== prevLongLine) pend.long = null;

      const pos = positions.get(key);
      if (pos) {
        const beforeLen = trades.length;
        const next = processExitsOnBar(pos, c, cfg, trades);
        if (!next) {
          positions.delete(key);
          for (let t = beforeLen; t < trades.length; t += 1) {
            perMarketPnl.set(key, (perMarketPnl.get(key) || 0) + trades[t].netPnl);
            perMarketTrades.set(key, (perMarketTrades.get(key) || 0) + 1);
            equity += trades[t].netPnl;
          }
        } else {
          positions.set(key, next);
        }
      }

      if (positions.has(key)) continue;
      if (positions.size >= maxOp) continue;

      const modes: Array<'short' | 'long'> =
        cfg.sideMode === 'both' ? ['short', 'long'] : [cfg.sideMode === 'long' ? 'long' : 'short'];

      const tryOpen = (mode: 'short' | 'long', line: number): void => {
        const entryPx = applySlippage(line, mode, true, cfg.slippagePercent);
        const notional = (equity / maxOp) * cfg.positionFraction;
        const qty = entryPx > 0 ? notional / entryPx : 0;
        if (qty <= 0) return;
        equity -= feeOnNotional(notional, cfg.commissionPercent);
        positions.set(key, {
          side: mode,
          entryTime: c.timeMs,
          entryPrice: entryPx,
          qty,
          remainingQty: qty,
          tp1Done: false,
          tp2Done: false,
        });
      };

      for (const mode of modes) {
        if (positions.has(key) || positions.size >= maxOp) break;
        if (mode === 'short') {
          if (pend.short && shortFillPending(pend.short, c)) {
            tryOpen('short', pend.short.line);
            pend.short = null;
          } else {
            const line = shortPlacePending(st.short, c, cfg);
            if (line !== null) pend.short = { side: 'short', line, placedAt: c.timeMs };
          }
        } else {
          if (pend.long && longFillPending(pend.long, c)) {
            tryOpen('long', pend.long.line);
            pend.long = null;
          } else {
            const line = longPlacePending(st.long, c, cfg);
            if (line !== null) pend.long = { side: 'long', line, placedAt: c.timeMs };
          }
        }
      }
    }

    peak = Math.max(peak, equity);
    maxDdPct = Math.max(maxDdPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      wins += 1;
      grossProfit += t.netPnl;
    } else grossLoss += Math.abs(t.netPnl);
  }

  const summary: WickRetestSummary = {
    sideMode: cfg.sideMode,
    bars: maxLen,
    tradesCount: trades.length,
    winRatePercent: trades.length ? (wins / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    totalReturnPercent: cfg.initialBalance > 0 ? ((equity - cfg.initialBalance) / cfg.initialBalance) * 100 : 0,
    maxDrawdownPercent: maxDdPct,
    finalEquity: equity,
    grossProfit,
    grossLoss,
    shadowSignals: 0,
    entriesAttempted: trades.length,
  };

  return {
    op: maxOp,
    sideMode: cfg.sideMode,
    summary,
    perMarket: markets.map((m) => ({
      key: m.key,
      trades: perMarketTrades.get(m.key) || 0,
      netPnl: perMarketPnl.get(m.key) || 0,
    })),
  };
};

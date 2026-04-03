// ─── Razgon Engine — Main Tick Loop ──────────────────────────────────────────
import { v4 as uuid } from 'uuid';
import logger from '../utils/logger';
import {
  getMarketData,
  placeOrder,
  getBalances,
  getPositions,
  closePosition,
  getAllSymbols,
  applySymbolRiskSettings,
  initExchangeClient,
} from '../bot/exchange';
import { RazgonRiskManager } from './razgonRisk';
import { computeMomentumSignal } from './razgonStrategy';
import { detectNewListings, decideSniperEntry } from './razgonSniper';
import { selectFundingCandidates, shouldCloseFundingPosition } from './razgonFunding';
import type {
  RazgonConfig,
  RazgonStatus,
  RazgonPosition,
  RazgonTrade,
  RazgonStats,
  Candle1m,
} from './razgonTypes';

// ── Engine State ─────────────────────────────────────────────────────────

let config: RazgonConfig | null = null;
let status: RazgonStatus = 'stopped';
let riskManager: RazgonRiskManager | null = null;

let openPositions: RazgonPosition[] = [];
let tradeHistory: RazgonTrade[] = [];
let balance = 0;
let startBalance = 0;
let peakBalance = 0;

// Timers
let momentumTimer: ReturnType<typeof setInterval> | null = null;
let sniperTimer: ReturnType<typeof setInterval> | null = null;
let fundingTimer: ReturnType<typeof setInterval> | null = null;

// Sniper known symbols cache
let knownSymbols: Set<string> = new Set();

// Candle cache per symbol: last N 1m candles
const candleCache: Map<string, Candle1m[]> = new Map();
const MAX_CANDLE_CACHE = 60; // keep 60 1m candles per symbol

// ── Public API ───────────────────────────────────────────────────────────

export function getRazgonStatus(): RazgonStats {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const todayTrades = tradeHistory.filter(t => t.closedAt >= todayMs);
  const totalWins = tradeHistory.filter(t => t.netPnl > 0).length;
  const winRate = tradeHistory.length > 0 ? totalWins / tradeHistory.length : 0;

  const avgWin = totalWins > 0
    ? tradeHistory.filter(t => t.netPnl > 0).reduce((s, t) => s + t.netPnl, 0) / totalWins
    : 0;
  const totalLosses = tradeHistory.filter(t => t.netPnl <= 0).length;
  const avgLoss = totalLosses > 0
    ? Math.abs(tradeHistory.filter(t => t.netPnl <= 0).reduce((s, t) => s + t.netPnl, 0) / totalLosses)
    : 0;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

  return {
    status,
    balance,
    startBalance,
    peakBalance,
    totalPnl: balance - startBalance,
    todayPnl: todayTrades.reduce((s, t) => s + t.netPnl, 0),
    totalTrades: tradeHistory.length,
    todayTrades: todayTrades.length,
    winRate,
    avgRR,
    openPositions: [...openPositions],
  };
}

export function getRazgonConfig(): RazgonConfig | null {
  return config ? { ...config } : null;
}

export function getTradeHistory(limit: number = 100): RazgonTrade[] {
  return tradeHistory.slice(-limit);
}

export async function startRazgon(cfg: RazgonConfig): Promise<{ ok: boolean; error?: string }> {
  if (status === 'running') {
    return { ok: false, error: 'Already running' };
  }

  try {
    config = cfg;

    // Fetch initial balance
    const balances = await getBalances(cfg.apiKeyName);
    const usdtBal = balances.find(b => b.coin === 'USDT');
    balance = usdtBal ? parseFloat(usdtBal.availableBalance) : 0;

    if (balance < 5) {
      return { ok: false, error: `Insufficient balance: $${balance.toFixed(2)}` };
    }

    startBalance = balance;
    peakBalance = balance;
    riskManager = new RazgonRiskManager(cfg, balance);
    openPositions = [];
    tradeHistory = [];
    candleCache.clear();

    // Seed known symbols for sniper
    if (cfg.sniper.enabled) {
      try {
        const symbols = await getAllSymbols(cfg.apiKeyName);
        knownSymbols = new Set(symbols.map((s: any) => typeof s === 'string' ? s : s.symbol || ''));
        logger.info(`[Razgon] Sniper seeded with ${knownSymbols.size} known symbols`);
      } catch (e) {
        logger.warn(`[Razgon] Failed to seed symbols: ${(e as Error).message}`);
        knownSymbols = new Set();
      }
    }

    // Start loops
    if (cfg.momentum.enabled) {
      momentumTimer = setInterval(
        () => momentumTick().catch(err => logger.error(`[Razgon:Momentum] ${err.message}`)),
        cfg.momentum.tickIntervalSec * 1000,
      );
      logger.info(`[Razgon] Momentum scalping started (${cfg.momentum.tickIntervalSec}s tick)`);
    }

    if (cfg.sniper.enabled) {
      sniperTimer = setInterval(
        () => sniperTick().catch(err => logger.error(`[Razgon:Sniper] ${err.message}`)),
        cfg.sniper.scanIntervalSec * 1000,
      );
      logger.info(`[Razgon] Listing sniper started (${cfg.sniper.scanIntervalSec}s scan)`);
    }

    if (cfg.funding.enabled) {
      fundingTimer = setInterval(
        () => fundingTick().catch(err => logger.error(`[Razgon:Funding] ${err.message}`)),
        cfg.funding.scanIntervalSec * 1000,
      );
      logger.info(`[Razgon] Funding farming started (${cfg.funding.scanIntervalSec}s scan)`);
    }

    status = 'running';
    logger.info(`[Razgon] Engine started. Balance: $${balance.toFixed(2)}, Exchange: ${cfg.exchange}`);
    return { ok: true };
  } catch (e) {
    status = 'error';
    return { ok: false, error: (e as Error).message };
  }
}

export async function stopRazgon(): Promise<void> {
  if (momentumTimer) { clearInterval(momentumTimer); momentumTimer = null; }
  if (sniperTimer) { clearInterval(sniperTimer); sniperTimer = null; }
  if (fundingTimer) { clearInterval(fundingTimer); fundingTimer = null; }

  // Close all open positions
  if (config) {
    for (const pos of openPositions) {
      try {
        await closePosition(config.apiKeyName, pos.symbol, pos.side === 'long' ? 'Buy' : 'Sell');
        recordClose(pos, pos.entryPrice, 'manual'); // approximate
      } catch (e) {
        logger.error(`[Razgon] Error closing ${pos.symbol}: ${(e as Error).message}`);
      }
    }
  }

  status = 'stopped';
  logger.info('[Razgon] Engine stopped');
}

export async function pauseRazgon(): Promise<void> {
  if (momentumTimer) { clearInterval(momentumTimer); momentumTimer = null; }
  if (sniperTimer) { clearInterval(sniperTimer); sniperTimer = null; }
  if (fundingTimer) { clearInterval(fundingTimer); fundingTimer = null; }
  status = 'paused';
  logger.info('[Razgon] Engine paused (positions kept open)');
}

export function updateRazgonConfig(patch: Partial<RazgonConfig>): void {
  if (!config) return;
  config = { ...config, ...patch };
  if (riskManager) riskManager.updateConfig(config);
}

// ── Momentum Tick ────────────────────────────────────────────────────────

async function momentumTick(): Promise<void> {
  if (!config || !riskManager || status !== 'running') return;
  const cfg = config.momentum;

  // Check & manage existing positions first
  await checkMomentumExits();

  // Skip new entries if daily limit hit
  if (riskManager.isDailyLimitHit(balance)) return;

  // Count currently open momentum positions
  const momPositions = openPositions.filter(p => p.subStrategy === 'momentum');
  if (momPositions.length >= cfg.maxConcurrentPositions) return;

  // Check each watchlist symbol for signal
  for (const symbol of cfg.watchlist) {
    if (momPositions.length >= cfg.maxConcurrentPositions) break;
    if (openPositions.some(p => p.symbol === symbol)) continue; // already in this symbol

    try {
      await checkMomentumEntry(symbol);
    } catch (e) {
      logger.debug(`[Razgon:Momentum] Signal check failed for ${symbol}: ${(e as Error).message}`);
    }
  }
}

async function checkMomentumEntry(symbol: string): Promise<void> {
  if (!config || !riskManager) return;
  const cfg = config.momentum;

  // Fetch 1m candles
  const candles = await fetchAndCache1mCandles(symbol, Math.max(cfg.donchianPeriod, 21) + 5);
  if (candles.length < cfg.donchianPeriod) return;

  const latestCandle = candles[candles.length - 1];
  const closedCandles = candles.slice(0, -1); // exclude current forming bar

  const result = computeMomentumSignal(
    closedCandles,
    latestCandle.close,
    latestCandle.volume,
    cfg.donchianPeriod,
    cfg.volumeMultiplier,
    cfg.atrFilterMin,
  );

  if (result.signal === 'none') return;

  const side = result.signal;
  const entryPrice = latestCandle.close;

  // Position sizing
  const margin = riskManager.computeMargin(
    balance,
    cfg.allocation,
    cfg.leverage,
    cfg.stopLossPercent,
    openPositions,
  );
  if (margin <= 0) return;

  const notional = margin * cfg.leverage;
  const slPrice = riskManager.computeStopLoss(entryPrice, side, cfg.stopLossPercent);

  logger.info(`[Razgon:Momentum] ${side.toUpperCase()} ${symbol} @ ${entryPrice} | notional=$${notional.toFixed(0)} SL=${slPrice.toFixed(6)}`);

  try {
    // Apply leverage & margin type
    await applySymbolRiskSettings(config.apiKeyName, symbol, cfg.marginType, cfg.leverage);

    // Place market order
    const orderSide = side === 'long' ? 'Buy' : 'Sell';
    const qty = notional / entryPrice;
    await placeOrder(config.apiKeyName, symbol, orderSide, String(qty), 'Market');

    // Record position
    const pos: RazgonPosition = {
      id: uuid(),
      subStrategy: 'momentum',
      symbol,
      side,
      entryPrice,
      notional,
      margin,
      leverage: cfg.leverage,
      openedAt: Date.now(),
      tpAnchor: entryPrice,
      slPrice,
      unrealizedPnl: 0,
    };
    openPositions.push(pos);
    balance -= margin; // lock margin
  } catch (e) {
    logger.error(`[Razgon:Momentum] Order failed ${symbol}: ${(e as Error).message}`);
  }
}

async function checkMomentumExits(): Promise<void> {
  if (!config || !riskManager) return;
  const cfg = config.momentum;

  const momPositions = openPositions.filter(p => p.subStrategy === 'momentum');

  for (const pos of momPositions) {
    try {
      const candles = await fetchAndCache1mCandles(pos.symbol, 5);
      if (candles.length === 0) continue;

      const currentPrice = candles[candles.length - 1].close;

      // Update trailing anchor
      pos.tpAnchor = riskManager.updateAnchor(pos.tpAnchor, currentPrice, pos.side);
      const tpTrailPrice = riskManager.computeTrailingTp(pos.tpAnchor, pos.side, cfg.trailingTpPercent);

      // Update unrealised PnL
      pos.unrealizedPnl = riskManager.computeGrossPnl(pos.entryPrice, currentPrice, pos.notional, pos.side);

      // Check exit conditions
      let exitReason: RazgonTrade['exitReason'] | null = null;

      if (riskManager.isStopLossHit(currentPrice, pos.slPrice, pos.side)) {
        exitReason = 'sl';
      } else if (riskManager.isTrailingTpHit(currentPrice, tpTrailPrice, pos.side)) {
        exitReason = 'tp';
      } else if (riskManager.isTimedOut(pos.openedAt, cfg.maxPositionTimeSec)) {
        exitReason = 'timeout';
      } else if (riskManager.isDailyLimitHit(balance)) {
        exitReason = 'daily_limit';
      }

      if (exitReason) {
        await executeClose(pos, currentPrice, exitReason);
      }
    } catch (e) {
      logger.debug(`[Razgon:Momentum] Exit check failed ${pos.symbol}: ${(e as Error).message}`);
    }
  }
}

// ── Sniper Tick ──────────────────────────────────────────────────────────

async function sniperTick(): Promise<void> {
  if (!config || !riskManager || status !== 'running') return;
  const cfg = config.sniper;

  // Check existing sniper positions for exit
  const sniperPositions = openPositions.filter(p => p.subStrategy === 'sniper');
  for (const pos of sniperPositions) {
    try {
      const candles = await fetchAndCache1mCandles(pos.symbol, 3);
      if (candles.length === 0) continue;
      const price = candles[candles.length - 1].close;

      pos.unrealizedPnl = riskManager.computeGrossPnl(pos.entryPrice, price, pos.notional, pos.side);

      let exitReason: RazgonTrade['exitReason'] | null = null;
      if (riskManager.isStopLossHit(price, pos.slPrice, pos.side)) exitReason = 'sl';
      else if (riskManager.isTimedOut(pos.openedAt, cfg.maxPositionTimeSec)) exitReason = 'timeout';
      // TP for sniper is fixed, not trailing
      const tpPrice = pos.side === 'long'
        ? pos.entryPrice * (1 + cfg.takeProfitPercent / 100)
        : pos.entryPrice * (1 - cfg.takeProfitPercent / 100);
      if ((pos.side === 'long' && price >= tpPrice) || (pos.side === 'short' && price <= tpPrice)) {
        exitReason = 'tp';
      }

      if (exitReason) await executeClose(pos, price, exitReason);
    } catch (_) { /* skip */ }
  }

  // Detect new listings
  if (sniperPositions.length > 0) return; // max 1 sniper position

  try {
    const symbols = await getAllSymbols(config.apiKeyName);
    const symList = symbols.map((s: any) => typeof s === 'string' ? s : s.symbol || '');
    const newListings = detectNewListings(symList, knownSymbols);

    // Update known set
    for (const s of symList) knownSymbols.add(s);

    if (newListings.length === 0) return;

    for (const sym of newListings.slice(0, 1)) { // process max 1 new listing per cycle
      logger.info(`[Razgon:Sniper] New listing detected: ${sym}`);

      // Wait entry delay
      await new Promise(res => setTimeout(res, Math.min(cfg.entryDelayMs, 10_000)));

      const candles = await fetchAndCache1mCandles(sym, 5);
      if (candles.length === 0) continue;

      const price = candles[candles.length - 1].close;
      const openPrice = candles[0].open;

      const decision = decideSniperEntry(price, openPrice, cfg);
      if (decision.action === 'skip') {
        logger.info(`[Razgon:Sniper] Skipping ${sym}: ${decision.reason}`);
        continue;
      }

      const margin = riskManager.computeMargin(balance, cfg.allocation, cfg.leverage, cfg.stopLossPercent, openPositions);
      if (margin <= 0) continue;

      const notional = margin * cfg.leverage;

      try {
        await applySymbolRiskSettings(config.apiKeyName, sym, cfg.marginType, cfg.leverage);
        const qty = notional / price;
        await placeOrder(config.apiKeyName, sym, 'Buy', String(qty), 'Market');

        const pos: RazgonPosition = {
          id: uuid(),
          subStrategy: 'sniper',
          symbol: sym,
          side: 'long',
          entryPrice: price,
          notional,
          margin,
          leverage: cfg.leverage,
          openedAt: Date.now(),
          tpAnchor: price,
          slPrice: decision.suggestedSl ?? price * 0.95,
          unrealizedPnl: 0,
        };
        openPositions.push(pos);
        balance -= margin;

        logger.info(`[Razgon:Sniper] Entered ${sym} LONG @ ${price} | notional=$${notional.toFixed(0)}`);
      } catch (e) {
        logger.error(`[Razgon:Sniper] Order failed ${sym}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.debug(`[Razgon:Sniper] Scan failed: ${(e as Error).message}`);
  }
}

// ── Funding Tick ─────────────────────────────────────────────────────────

async function fundingTick(): Promise<void> {
  if (!config || !riskManager || status !== 'running') return;
  const cfg = config.funding;

  // Check existing funding positions
  const fundPositions = openPositions.filter(p => p.subStrategy === 'funding');
  // For simplicity, just check timeout/SL (funding rate check requires exchange-specific API)
  for (const pos of fundPositions) {
    try {
      const candles = await fetchAndCache1mCandles(pos.symbol, 3);
      if (candles.length === 0) continue;
      const price = candles[candles.length - 1].close;
      pos.unrealizedPnl = riskManager.computeGrossPnl(pos.entryPrice, price, pos.notional, pos.side);

      const unrealizedPct = (pos.unrealizedPnl / pos.margin) * 100;
      if (unrealizedPct <= -cfg.stopLossPercent) {
        await executeClose(pos, price, 'sl');
      }
    } catch (_) { /* skip */ }
  }

  // Open new funding positions if slots available
  if (fundPositions.length >= cfg.maxPositions) return;

  // Note: MEXC ccxt doesn't expose funding rates directly.
  // This is a placeholder — in production, use exchange-specific endpoint.
  logger.debug('[Razgon:Funding] Funding scan tick (placeholder — needs exchange funding rate API)');
}

// ── Shared Helpers ───────────────────────────────────────────────────────

async function executeClose(
  pos: RazgonPosition,
  exitPrice: number,
  exitReason: RazgonTrade['exitReason'],
): Promise<void> {
  if (!config || !riskManager) return;

  try {
    const closeSide = pos.side === 'long' ? 'Sell' : 'Buy';
    await closePosition(config.apiKeyName, pos.symbol, closeSide);
  } catch (e) {
    logger.error(`[Razgon] Close order failed ${pos.symbol}: ${(e as Error).message}`);
  }

  recordClose(pos, exitPrice, exitReason);
}

function recordClose(pos: RazgonPosition, exitPrice: number, exitReason: RazgonTrade['exitReason']): void {
  if (!riskManager) return;

  const grossPnl = riskManager.computeGrossPnl(pos.entryPrice, exitPrice, pos.notional, pos.side);
  const fee = riskManager.computeFee(pos.notional);
  const netPnl = grossPnl - fee;

  const trade: RazgonTrade = {
    id: pos.id,
    subStrategy: pos.subStrategy,
    symbol: pos.symbol,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    notional: pos.notional,
    grossPnl,
    fee,
    netPnl,
    openedAt: pos.openedAt,
    closedAt: Date.now(),
    exitReason,
  };
  tradeHistory.push(trade);

  // Return margin + PnL to balance
  balance += pos.margin + netPnl;
  if (balance > peakBalance) peakBalance = balance;

  // Remove from open positions
  openPositions = openPositions.filter(p => p.id !== pos.id);

  riskManager.recordTrade(trade, balance);

  const emoji = netPnl >= 0 ? '✅' : '❌';
  logger.info(
    `[Razgon] ${emoji} ${exitReason.toUpperCase()} ${pos.side} ${pos.symbol} | ` +
    `Entry=${pos.entryPrice.toFixed(6)} Exit=${exitPrice.toFixed(6)} | ` +
    `PnL=${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} | Balance=$${balance.toFixed(2)}`,
  );
}

async function fetchAndCache1mCandles(symbol: string, minBars: number): Promise<Candle1m[]> {
  if (!config) return [];

  try {
    const raw = await getMarketData(config.apiKeyName, symbol, '1m', minBars + 5);
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const candles: Candle1m[] = raw.map((c: any) => ({
      timeMs: Number(c[0] ?? c.timeMs ?? c.timestamp ?? 0),
      open: Number(c[1] ?? c.open ?? 0),
      high: Number(c[2] ?? c.high ?? 0),
      low: Number(c[3] ?? c.low ?? 0),
      close: Number(c[4] ?? c.close ?? 0),
      volume: Number(c[5] ?? c.volume ?? 0),
    }));

    candleCache.set(symbol, candles.slice(-MAX_CANDLE_CACHE));
    return candles;
  } catch (e) {
    // Fallback to cache
    return candleCache.get(symbol) ?? [];
  }
}

// ─── Razgon Engine — Main Tick Loop ──────────────────────────────────────────
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
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
  batchGetMarketData,
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

// ── Config Persistence ───────────────────────────────────────────────────
// Save last-used config to disk so it survives API restarts.
const CONFIG_FILE = path.join(__dirname, '..', '..', 'razgon_config.json');

function saveConfigToDisk(): void {
  if (!config) return;
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    logger.debug(`[Razgon] Failed to save config: ${(e as Error).message}`);
  }
}

function loadConfigFromDisk(): RazgonConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.apiKeyName && parsed.exchange) return parsed as RazgonConfig;
  } catch (e) {
    logger.debug(`[Razgon] Failed to load config: ${(e as Error).message}`);
  }
  return null;
}

// Load saved config on module init (so GET /config returns it even before Start)
config = loadConfigFromDisk();

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
    saveConfigToDisk();

    // Fetch initial balance (use equity = walletBalance, not just available)
    const balances = await getBalances(cfg.apiKeyName);
    const usdtBal = balances.find(b => b.coin === 'USDT');
    const equity = usdtBal ? parseFloat(usdtBal.walletBalance || usdtBal.availableBalance) : 0;
    const available = usdtBal ? parseFloat(usdtBal.availableBalance) : 0;
    balance = equity;

    if (equity < 1) {
      return { ok: false, error: `Insufficient equity: $${equity.toFixed(2)} (available: $${available.toFixed(2)})` };
    }

    startBalance = equity;
    peakBalance = equity;
    riskManager = new RazgonRiskManager(cfg, equity);
    openPositions = [];
    tradeHistory = [];
    candleCache.clear();

    // Restore open positions from exchange
    try {
      const exchangePositions = await getPositions(cfg.apiKeyName);
      const watchSymbols = new Set(cfg.momentum.watchlist);
      for (const pos of exchangePositions) {
        const sz = Math.abs(Number(pos.size ?? 0));
        if (sz <= 0) continue;
        const sym = String(pos.symbol ?? '').replace(/[/:]/g, '');
        if (!watchSymbols.has(sym)) continue;
        const side: 'long' | 'short' = String(pos.side ?? '').toLowerCase() === 'long' ? 'long' : 'short';
        const entryPrice = Number(pos.entryPrice ?? 0);
        const notional = Number(pos.positionValue ?? 0) || sz * entryPrice;
        const margin = notional / cfg.momentum.leverage;
        const slPrice = riskManager.computeStopLoss(entryPrice, side, cfg.momentum.stopLossPercent);
        openPositions.push({
          id: uuid(),
          subStrategy: 'momentum',
          symbol: sym,
          side,
          entryPrice,
          notional,
          margin,
          leverage: cfg.momentum.leverage,
          openedAt: Date.now(),
          tpAnchor: entryPrice,
          slPrice,
          unrealizedPnl: Number(pos.unrealisedPnl ?? 0),
        });
      }
      if (openPositions.length > 0) {
        logger.info(`[Razgon] Restored ${openPositions.length} positions from exchange: ${openPositions.map(p => `${p.symbol} ${p.side}`).join(', ')}`);
      }
    } catch (e) {
      logger.warn(`[Razgon] Failed to restore positions: ${(e as Error).message}`);
    }

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
      let momentumBusy = false;
      momentumTimer = setInterval(() => {
        if (momentumBusy) { logger.debug('[Razgon:Momentum] skip tick — previous still running'); return; }
        momentumBusy = true;
        const deadline = setTimeout(() => {
          logger.warn('[Razgon:Momentum] tick timed out (30s), resetting busy flag');
          momentumBusy = false;
        }, 30_000);
        momentumTick()
          .catch(err => logger.error(`[Razgon:Momentum] ${err.message}`))
          .finally(() => { clearTimeout(deadline); momentumBusy = false; });
      }, cfg.momentum.tickIntervalSec * 1000);
      logger.info(`[Razgon] Momentum scalping started (${cfg.momentum.tickIntervalSec}s tick)`);
    }

    if (cfg.sniper.enabled) {
      let sniperBusy = false;
      sniperTimer = setInterval(() => {
        if (sniperBusy) return;
        sniperBusy = true;
        const deadline = setTimeout(() => { sniperBusy = false; }, 60_000);
        sniperTick()
          .catch(err => logger.error(`[Razgon:Sniper] ${err.message}`))
          .finally(() => { clearTimeout(deadline); sniperBusy = false; });
      }, cfg.sniper.scanIntervalSec * 1000);
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

  // Keep config in memory so UI can read it after stop
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
  saveConfigToDisk();
}

// ── Momentum Tick ────────────────────────────────────────────────────────

let momentumTickCount = 0;

async function momentumTick(): Promise<void> {
  if (!config || !riskManager || status !== 'running') return;
  const cfg = config.momentum;
  momentumTickCount++;

  // Log every tick for diagnosing (can reduce to % 12 later = every 1 min)
  logger.info(`[Razgon:Momentum] tick #${momentumTickCount} | bal=$${balance.toFixed(2)} | pos=${openPositions.length} | symbols=${cfg.watchlist.length}`);

  // Check & manage existing positions first
  await checkMomentumExits();

  // Skip new entries if daily limit hit
  if (riskManager.isDailyLimitHit(balance)) return;

  // Count currently open momentum positions
  const momPositions = openPositions.filter(p => p.subStrategy === 'momentum');
  if (momPositions.length >= cfg.maxConcurrentPositions) return;

  // Batch-fetch all watchlist candles in parallel via exchange batch utility
  const candidates = cfg.watchlist.filter(
    sym => !openPositions.some(p => p.symbol === sym),
  );
  const minBars = Math.max(cfg.donchianPeriod, 21) + 5;
  const batchResults = await batchGetMarketData(config.apiKeyName, candidates, '1m', minBars + 5, 8000);

  // Update candle cache from batch results
  for (const br of batchResults) {
    if (br.candles.length > 0) {
      const parsed: Candle1m[] = br.candles.map((c: any) => ({
        timeMs: Number(c[0] ?? 0), open: Number(c[1] ?? 0), high: Number(c[2] ?? 0),
        low: Number(c[3] ?? 0), close: Number(c[4] ?? 0), volume: Number(c[5] ?? 0),
      }));
      candleCache.set(br.symbol, parsed.slice(-MAX_CANDLE_CACHE));
    }
  }

  for (const br of batchResults) {
    if (openPositions.filter(p => p.subStrategy === 'momentum').length >= cfg.maxConcurrentPositions) break;
    const candles = candleCache.get(br.symbol);
    if (!candles || candles.length < cfg.donchianPeriod) continue;
    try {
      await checkMomentumEntryFromCandles(br.symbol, candles);
    } catch (e) {
      logger.debug(`[Razgon:Momentum] Signal check failed for ${br.symbol}: ${(e as Error).message}`);
    }
  }
}

async function checkMomentumEntryFromCandles(symbol: string, candles: Candle1m[]): Promise<void> {
  if (!config || !riskManager) return;
  const cfg = config.momentum;

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

  // Log signal check for diagnostics
  if (result.signal !== 'none' || momentumTickCount % 12 === 1) {
    const volRatio = result.avgVolume > 0 ? (result.volume / result.avgVolume).toFixed(2) : '0';
    const priceVsDH = result.donchianHigh > 0 ? ((latestCandle.close / result.donchianHigh - 1) * 100).toFixed(3) : '?';
    const priceVsDL = result.donchianLow > 0 ? ((latestCandle.close / result.donchianLow - 1) * 100).toFixed(3) : '?';
    logger.info(`[Razgon:Momentum] ${symbol} sig=${result.signal} p=${latestCandle.close} dH=${result.donchianHigh} dL=${result.donchianLow} p/dH=${priceVsDH}% p/dL=${priceVsDL}% vol=${volRatio}x atr=${(result.normAtr*100).toFixed(3)}% atrMin=${(cfg.atrFilterMin*100).toFixed(3)}% volMul=${cfg.volumeMultiplier}`);
  }

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
    // Timeout after 8s to prevent tick stalling in shared limiter queue
    const timeoutMs = 8000;
    const raw = await Promise.race([
      getMarketData(config.apiKeyName, symbol, '1m', minBars + 5),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetch timeout')), timeoutMs)),
    ]);
    if (!Array.isArray(raw) || raw.length === 0) return candleCache.get(symbol) ?? [];

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

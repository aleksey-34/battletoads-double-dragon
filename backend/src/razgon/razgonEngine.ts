// ─── Razgon Engine — Multi-Key Parallel ─────────────────────────────────────
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

// ── Per-Key Instance ─────────────────────────────────────────────────────

interface RazgonInstance {
  keyName: string;
  exchange: string;
  label: string;
  balance: number;
  startBalance: number;
  peakBalance: number;
  openPositions: RazgonPosition[];
  tradeHistory: RazgonTrade[];
  riskManager: RazgonRiskManager;
  candleCache: Map<string, Candle1m[]>;
  knownSymbols: Set<string>;
  failedSymbols: Map<string, number>; // symbol → timestamp of last failure (cooldown)
  momentumTimer: ReturnType<typeof setInterval> | null;
  sniperTimer: ReturnType<typeof setInterval> | null;
  fundingTimer: ReturnType<typeof setInterval> | null;
  tickCount: number;
}

// ── Global Engine State ───────────────────────────────────────────────────

let config: RazgonConfig | null = null;
let status: RazgonStatus = 'stopped';
const instanceMap = new Map<string, RazgonInstance>();

const MAX_CANDLE_CACHE = 60;

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

/** Live refresh: fetch equity + positions from exchange for all instances */
export async function refreshRazgonLive(): Promise<RazgonStats> {
  if (!config) return getRazgonStatus();
  const instances = instanceMap.size > 0 ? [...instanceMap.values()] : null;
  if (!instances) return getRazgonStatus();

  await Promise.all(instances.map(async inst => {
    try {
      const bals = await getBalances(inst.keyName);
      const usdtBal = bals.find(b => b.coin === 'USDT');
      const equity = usdtBal ? parseFloat(usdtBal.walletBalance || usdtBal.availableBalance) : 0;
      if (equity > 0) {
        inst.balance = equity;
        if (inst.startBalance === 0) inst.startBalance = equity;
        if (inst.balance > inst.peakBalance) inst.peakBalance = inst.balance;
      }
      const exchPositions = await getPositions(inst.keyName);
      const livePositions: RazgonPosition[] = [];
      for (const ep of exchPositions) {
        const sz = Math.abs(Number(ep.size ?? 0));
        if (sz <= 0) continue;
        const sym = String(ep.symbol ?? '').replace(/[/:]/g, '');
        const side: 'long' | 'short' = String(ep.side ?? '').toLowerCase() === 'long' ? 'long' : 'short';
        const entryPrice = Number(ep.entryPrice ?? 0);
        const notional = Number(ep.positionValue ?? 0) || sz * entryPrice;
        const upnl = Number(ep.unrealisedPnl ?? 0);
        const existing = inst.openPositions.find(p => p.symbol === sym && p.side === side);
        if (existing) {
          existing.unrealizedPnl = upnl;
          existing.notional = notional;
          livePositions.push(existing);
        } else {
          livePositions.push({
            id: uuid(), subStrategy: 'momentum', symbol: sym, side, entryPrice, notional,
            margin: notional / (config!.momentum?.leverage ?? 20),
            leverage: config!.momentum?.leverage ?? 20,
            openedAt: Date.now(), tpAnchor: entryPrice,
            slPrice: entryPrice * (side === 'long' ? (1 - 0.003) : (1 + 0.003)),
            unrealizedPnl: upnl,
          });
        }
      }
      inst.openPositions = livePositions;
    } catch (e) {
      logger.debug(`[Razgon:${inst.keyName}] Live refresh failed: ${(e as Error).message}`);
    }
  }));
  return getRazgonStatus();
}

export function getRazgonStatus(): RazgonStats {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  // Aggregate across all instances
  const allPositions: RazgonPosition[] = [];
  const allTrades: RazgonTrade[] = [];
  let totalBalance = 0;
  let totalStartBalance = 0;
  let totalPeakBalance = 0;

  for (const inst of instanceMap.values()) {
    allPositions.push(...inst.openPositions);
    allTrades.push(...inst.tradeHistory);
    totalBalance += inst.balance;
    totalStartBalance += inst.startBalance;
    totalPeakBalance += inst.peakBalance;
  }

  // If no instances running, use config-loaded values (stopped state)
  if (instanceMap.size === 0 && config) {
    // no trades/positions to show
  }

  const todayTrades = allTrades.filter(t => t.closedAt >= todayMs);
  const totalWins = allTrades.filter(t => t.netPnl > 0).length;
  const winRate = allTrades.length > 0 ? totalWins / allTrades.length : 0;
  const avgWin = totalWins > 0
    ? allTrades.filter(t => t.netPnl > 0).reduce((s, t) => s + t.netPnl, 0) / totalWins : 0;
  const totalLosses = allTrades.filter(t => t.netPnl <= 0).length;
  const avgLoss = totalLosses > 0
    ? Math.abs(allTrades.filter(t => t.netPnl <= 0).reduce((s, t) => s + t.netPnl, 0) / totalLosses) : 0;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

  return {
    status,
    balance: totalBalance,
    startBalance: totalStartBalance,
    peakBalance: totalPeakBalance,
    totalPnl: totalBalance - totalStartBalance,
    todayPnl: todayTrades.reduce((s, t) => s + t.netPnl, 0),
    totalTrades: allTrades.length,
    todayTrades: todayTrades.length,
    winRate,
    avgRR,
    openPositions: allPositions,
  };
}

export function getRazgonConfig(): RazgonConfig | null {
  return config ? { ...config } : null;
}

export function getTradeHistory(limit: number = 100): RazgonTrade[] {
  const all: RazgonTrade[] = [];
  for (const inst of instanceMap.values()) all.push(...inst.tradeHistory);
  return all.sort((a, b) => b.closedAt - a.closedAt).slice(0, limit);
}

/** Fetch live USDT balance for each configured api key */
export async function getRazgonKeyBalances(): Promise<Array<{ name: string; exchange: string; label?: string; enabled: boolean; balance: number; equity: number }>> {
  const cfg = config;
  const keys = cfg?.apiKeys ?? (cfg ? [{ name: cfg.apiKeyName, exchange: cfg.exchange, enabled: true, startBalancePct: 0.9 }] : []);
  const results = await Promise.all(keys.map(async k => {
    try {
      const bals = await getBalances(k.name);
      const usdtBal = bals.find(b => b.coin === 'USDT');
      const equity = usdtBal ? parseFloat(usdtBal.walletBalance || '0') : 0;
      const avail = usdtBal ? parseFloat(usdtBal.availableBalance || '0') : 0;
      return { name: k.name, exchange: k.exchange, label: k.label, enabled: k.enabled, balance: avail, equity };
    } catch {
      return { name: k.name, exchange: k.exchange, label: k.label, enabled: k.enabled, balance: 0, equity: 0 };
    }
  }));
  return results;
}

// ── Instance lifecycle ───────────────────────────────────────────────────

async function createInstance(
  keyEntry: { name: string; exchange: string; enabled: boolean; startBalancePct?: number; label?: string },
  cfg: RazgonConfig,
): Promise<RazgonInstance> {
  // Fetch balance (exchange client already initialised at boot from DB)
  const balances = await getBalances(keyEntry.name);
  const usdtBal = balances.find(b => b.coin === 'USDT');
  const totalEquity = usdtBal ? parseFloat(usdtBal.walletBalance || usdtBal.availableBalance) : 0;
  const available = usdtBal ? parseFloat(usdtBal.availableBalance) : 0;

  const keyPct = keyEntry.startBalancePct ?? 0;
  const globalPct = cfg.startBalancePct ?? 0;
  const effectivePct = keyPct > 0 ? keyPct : globalPct;
  const equity = effectivePct > 0 ? totalEquity * effectivePct : (cfg.startBalance || totalEquity);

  if (equity < 1) {
    throw new Error(`Insufficient equity for ${keyEntry.name}: $${equity.toFixed(2)} (available: $${available.toFixed(2)})`);
  }

  const riskManager = new RazgonRiskManager(cfg, equity);

  const inst: RazgonInstance = {
    keyName: keyEntry.name,
    exchange: keyEntry.exchange,
    label: keyEntry.label ?? keyEntry.name,
    balance: equity,
    startBalance: equity,
    peakBalance: equity,
    openPositions: [],
    tradeHistory: [],
    riskManager,
    candleCache: new Map(),
    knownSymbols: new Set(),
    failedSymbols: new Map(),
    momentumTimer: null,
    sniperTimer: null,
    fundingTimer: null,
    tickCount: 0,
  };

  // Restore open positions from exchange
  try {
    const exchangePositions = await getPositions(keyEntry.name);
    const watchSymbols = new Set(cfg.momentum.watchlist);
    for (const pos of exchangePositions) {
      const sz = Math.abs(Number(pos.size ?? pos.contracts ?? 0));
      if (sz <= 0) continue;
      const sym = String(pos.symbol ?? '').replace(/[/:]/g, '');
      if (!watchSymbols.has(sym)) continue;
      // Normalize side: ccxt uses 'long'/'short', some exchanges use 'Buy'/'Sell'
      const rawSide = String(pos.side ?? '').toLowerCase();
      const side: 'long' | 'short' = (rawSide === 'long' || rawSide === 'buy') ? 'long' : 'short';
      const entryPrice = Number(pos.entryPrice ?? pos.avgPrice ?? pos.markPrice ?? 0);
      if (entryPrice <= 0) {
        logger.warn(`[Razgon:${keyEntry.name}] Skipping restore of ${sym} ${side}: entryPrice=0`);
        continue;
      }
      const notional = Number(pos.positionValue ?? pos.notional ?? 0) || sz * entryPrice;
      if (notional <= 0) continue;
      const margin = notional / cfg.momentum.leverage;
      const slPrice = riskManager.computeStopLoss(entryPrice, side, cfg.momentum.stopLossPercent);
      inst.openPositions.push({
        id: uuid(), subStrategy: 'momentum', symbol: sym, side, entryPrice, notional, margin,
        leverage: cfg.momentum.leverage, openedAt: Date.now(), tpAnchor: entryPrice, slPrice,
        unrealizedPnl: Number(pos.unrealisedPnl ?? pos.unrealizedPnl ?? 0),
      });
      logger.info(`[Razgon:${keyEntry.name}] Restored ${sym} ${side} entry=${entryPrice} notional=$${notional.toFixed(2)} margin=$${margin.toFixed(2)}`);
    }
    if (inst.openPositions.length > 0) {
      logger.info(`[Razgon:${keyEntry.name}] Restored ${inst.openPositions.length} positions: ${inst.openPositions.map(p => `${p.symbol} ${p.side}`).join(', ')}`);
    }
  } catch (e) {
    logger.warn(`[Razgon:${keyEntry.name}] Failed to restore positions: ${(e as Error).message}`);
  }

  // Seed sniper symbols
  if (cfg.sniper.enabled) {
    try {
      const symbols = await getAllSymbols(keyEntry.name);
      inst.knownSymbols = new Set(symbols.map((s: any) => typeof s === 'string' ? s : s.symbol || ''));
    } catch { inst.knownSymbols = new Set(); }
  }

  return inst;
}

function startInstanceTimers(inst: RazgonInstance, cfg: RazgonConfig): void {
  if (cfg.momentum.enabled) {
    let busy = false;
    inst.momentumTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      const deadline = setTimeout(() => { busy = false; }, 30_000);
      momentumTick(inst)
        .catch(err => logger.error(`[Razgon:${inst.keyName}:Momentum] ${err.message}`))
        .finally(() => { clearTimeout(deadline); busy = false; });
    }, cfg.momentum.tickIntervalSec * 1000);
    logger.info(`[Razgon:${inst.keyName}] Momentum started (${cfg.momentum.tickIntervalSec}s tick)`);
  }

  if (cfg.sniper.enabled) {
    let busy = false;
    inst.sniperTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      const deadline = setTimeout(() => { busy = false; }, 60_000);
      sniperTick(inst)
        .catch(err => logger.error(`[Razgon:${inst.keyName}:Sniper] ${err.message}`))
        .finally(() => { clearTimeout(deadline); busy = false; });
    }, cfg.sniper.scanIntervalSec * 1000);
  }

  if (cfg.funding.enabled) {
    inst.fundingTimer = setInterval(
      () => fundingTick(inst).catch(err => logger.error(`[Razgon:${inst.keyName}:Funding] ${err.message}`)),
      cfg.funding.scanIntervalSec * 1000,
    );
  }
}

async function stopInstance(inst: RazgonInstance): Promise<void> {
  if (inst.momentumTimer) { clearInterval(inst.momentumTimer); inst.momentumTimer = null; }
  if (inst.sniperTimer) { clearInterval(inst.sniperTimer); inst.sniperTimer = null; }
  if (inst.fundingTimer) { clearInterval(inst.fundingTimer); inst.fundingTimer = null; }
  if (config) {
    for (const pos of inst.openPositions) {
      try {
        await closePosition(inst.keyName, pos.symbol, pos.side === 'long' ? 'Sell' : 'Buy');
        recordClose(inst, pos, pos.entryPrice, 'manual');
      } catch (e) {
        logger.error(`[Razgon:${inst.keyName}] Error closing ${pos.symbol}: ${(e as Error).message}`);
      }
    }
  }
  logger.info(`[Razgon:${inst.keyName}] Instance stopped`);
}

export async function startRazgon(cfg: RazgonConfig): Promise<{ ok: boolean; error?: string }> {
  if (status === 'running') return { ok: false, error: 'Already running' };

  config = cfg;
  if (!config.apiKeys || config.apiKeys.length === 0) {
    config.apiKeys = [{ name: cfg.apiKeyName, exchange: cfg.exchange, enabled: true, startBalancePct: 0.9, label: cfg.exchange.toUpperCase() }];
  }
  if (typeof config.startBalancePct !== 'number') config.startBalancePct = 0;
  if (!config.presetMode) config.presetMode = 'high';
  saveConfigToDisk();

  instanceMap.clear();
  const enabledKeys = config.apiKeys.filter(k => k.enabled);
  if (enabledKeys.length === 0) enabledKeys.push({ name: cfg.apiKeyName, exchange: cfg.exchange, enabled: true, startBalancePct: 0.9 });

  const errors: string[] = [];
  for (const keyEntry of enabledKeys) {
    try {
      const inst = await createInstance(keyEntry, cfg);
      instanceMap.set(keyEntry.name, inst);
      startInstanceTimers(inst, cfg);
      logger.info(`[Razgon] Instance started: ${keyEntry.name} ($${inst.balance.toFixed(2)})`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${keyEntry.name}: ${msg}`);
      logger.error(`[Razgon] Failed to start ${keyEntry.name}: ${msg}`);
    }
  }

  if (instanceMap.size === 0) {
    return { ok: false, error: errors.join('; ') || 'No instances started' };
  }

  status = 'running';
  const totalBal = [...instanceMap.values()].reduce((s, i) => s + i.balance, 0);
  const startMsg = `[Razgon] Started ${instanceMap.size} instance(s). Total balance: $${totalBal.toFixed(2)}`;
  logger.info(startMsg);
  console.log(startMsg);
  return { ok: true };
}

export async function stopRazgon(): Promise<void> {
  for (const inst of instanceMap.values()) await stopInstance(inst);
  instanceMap.clear();
  status = 'stopped';
  console.log('[Razgon] Engine stopped');
  logger.info('[Razgon] Engine stopped');
}

export async function pauseRazgon(): Promise<void> {
  for (const inst of instanceMap.values()) {
    if (inst.momentumTimer) { clearInterval(inst.momentumTimer); inst.momentumTimer = null; }
    if (inst.sniperTimer) { clearInterval(inst.sniperTimer); inst.sniperTimer = null; }
    if (inst.fundingTimer) { clearInterval(inst.fundingTimer); inst.fundingTimer = null; }
  }
  status = 'paused';
  logger.info('[Razgon] Engine paused (positions kept open)');
}

export function updateRazgonConfig(patch: Partial<RazgonConfig>): void {
  if (!config) return;
  config = { ...config, ...patch };
  for (const inst of instanceMap.values()) inst.riskManager.updateConfig(config!);
  saveConfigToDisk();
}

// ── Momentum Tick ────────────────────────────────────────────────────────

async function momentumTick(inst: RazgonInstance): Promise<void> {
  if (!config || status !== 'running') return;
  const cfg = config.momentum;
  inst.tickCount++;

  const tickMsg = `[Razgon:${inst.keyName}] tick #${inst.tickCount} | bal=$${inst.balance.toFixed(2)} | pos=${inst.openPositions.length}`;
  logger.info(tickMsg);
  if (inst.tickCount % 60 === 1) console.log(tickMsg); // log to journal every ~5min

  // Sync equity from exchange every ~1 min (12 ticks * 5s = 60s)
  if (inst.tickCount % 12 === 0) {
    try {
      const bals = await getBalances(inst.keyName);
      const usdtBal = bals.find(b => b.coin === 'USDT');
      const equity = usdtBal ? parseFloat(usdtBal.walletBalance || usdtBal.availableBalance) : 0;
      if (equity > 0) {
        inst.balance = equity;
        if (inst.balance > inst.peakBalance) inst.peakBalance = inst.balance;
      }
    } catch (e) {
      logger.debug(`[Razgon:${inst.keyName}] Equity sync failed: ${(e as Error).message}`);
    }
  }

  // Check & manage existing positions first
  await checkMomentumExits(inst);

  // Skip new entries if daily limit hit
  if (inst.riskManager.isDailyLimitHit(inst.balance)) return;

  // Count currently open momentum positions
  const momPositions = inst.openPositions.filter(p => p.subStrategy === 'momentum');
  if (momPositions.length >= cfg.maxConcurrentPositions) return;

  // Check REAL available balance from exchange before attempting entries
  let availableBalance = 0;
  try {
    const bals = await getBalances(inst.keyName);
    const usdtBal = bals.find(b => b.coin === 'USDT');
    availableBalance = usdtBal ? parseFloat(usdtBal.availableBalance) : 0;
    // Also sync wallet balance for accurate state
    const walletBal = usdtBal ? parseFloat(usdtBal.walletBalance || usdtBal.availableBalance) : 0;
    if (walletBal > 0) inst.balance = walletBal;
  } catch (e) {
    logger.debug(`[Razgon:${inst.keyName}] Available balance check failed: ${(e as Error).message}`);
    return; // fail-safe: don't trade if we can't check balance
  }
  // Need at least $2 free to open any position
  const MIN_AVAILABLE = 2;
  if (availableBalance < MIN_AVAILABLE) {
    if (inst.tickCount % 60 === 1) {
      const msg = `[Razgon:${inst.keyName}] Skipping entries: available=$${availableBalance.toFixed(2)} < min=$${MIN_AVAILABLE}`;
      logger.info(msg);
      console.log(msg);
    }
    return;
  }

  // Skip symbols where we already have ANY position (avoid opposite/duplicate)
  // Also skip symbols on cooldown from recent order failures (60s cooldown)
  const now = Date.now();
  const FAIL_COOLDOWN_MS = 60_000;
  const candidates = cfg.watchlist.filter(sym => {
    if (inst.openPositions.some(p => p.symbol === sym)) return false;
    const lastFail = inst.failedSymbols.get(sym);
    if (lastFail && (now - lastFail) < FAIL_COOLDOWN_MS) return false;
    return true;
  });
  const minBars = Math.max(cfg.donchianPeriod, 21) + 5;
  const batchResults = await batchGetMarketData(inst.keyName, candidates, '1m', minBars + 5, 8000);

  // Update candle cache from batch results
  for (const br of batchResults) {
    if (br.candles.length > 0) {
      const parsed: Candle1m[] = br.candles.map((c: any) => ({
        timeMs: Number(c[0] ?? 0), open: Number(c[1] ?? 0), high: Number(c[2] ?? 0),
        low: Number(c[3] ?? 0), close: Number(c[4] ?? 0), volume: Number(c[5] ?? 0),
      }));
      inst.candleCache.set(br.symbol, parsed.slice(-MAX_CANDLE_CACHE));
    }
  }

  for (const br of batchResults) {
    if (inst.openPositions.filter(p => p.subStrategy === 'momentum').length >= cfg.maxConcurrentPositions) break;
    const candles = inst.candleCache.get(br.symbol);
    if (!candles || candles.length < cfg.donchianPeriod) continue;
    try {
      await checkMomentumEntryFromCandles(inst, br.symbol, candles);
    } catch (e) {
      logger.debug(`[Razgon:${inst.keyName}] Signal check failed for ${br.symbol}: ${(e as Error).message}`);
    }
  }
}

async function checkMomentumEntryFromCandles(inst: RazgonInstance, symbol: string, candles: Candle1m[]): Promise<void> {
  if (!config) return;
  const cfg = config.momentum;

  if (candles.length < cfg.donchianPeriod) return;

  const latestCandle = candles[candles.length - 1];
  const closedCandles = candles.slice(0, -1);

  const result = computeMomentumSignal(
    closedCandles,
    latestCandle.close,
    latestCandle.volume,
    cfg.donchianPeriod,
    cfg.volumeMultiplier,
    cfg.atrFilterMin,
  );

  // Log signal check for diagnostics
  if (result.signal !== 'none' || inst.tickCount % 12 === 1) {
    const volRatio = result.avgVolume > 0 ? (result.volume / result.avgVolume).toFixed(2) : '0';
    const priceVsDH = result.donchianHigh > 0 ? ((latestCandle.close / result.donchianHigh - 1) * 100).toFixed(3) : '?';
    const priceVsDL = result.donchianLow > 0 ? ((latestCandle.close / result.donchianLow - 1) * 100).toFixed(3) : '?';
    logger.info(`[Razgon:${inst.keyName}] ${symbol} sig=${result.signal} p=${latestCandle.close} dH=${result.donchianHigh} dL=${result.donchianLow} p/dH=${priceVsDH}% p/dL=${priceVsDL}% vol=${volRatio}x atr=${(result.normAtr*100).toFixed(3)}%`);
  }

  if (result.signal === 'none') return;

  const side = result.signal;
  const entryPrice = latestCandle.close;

  // double-check no existing position on this symbol (any side) — in-memory
  if (inst.openPositions.some(p => p.symbol === symbol)) {
    logger.debug(`[Razgon:${inst.keyName}] Skip ${symbol}: already have in-memory position`);
    return;
  }

  // CRITICAL: also check exchange-level positions to prevent opposite positions after restarts
  try {
    const exchPos = await getPositions(inst.keyName);
    const hasExchangePos = exchPos.some((ep: any) => {
      const sz = Math.abs(Number(ep.size ?? 0));
      const sym = String(ep.symbol ?? '').replace(/[/:]/g, '');
      return sz > 0 && sym === symbol;
    });
    if (hasExchangePos) {
      // Add to cooldown so we don't spam this check every 5s
      inst.failedSymbols.set(symbol, Date.now());
      if (inst.tickCount % 60 === 1) { // only log once per ~5min
        console.log(`[Razgon:${inst.keyName}] BLOCKED opposite entry on ${symbol} — exchange position exists`);
      }
      return;
    }
  } catch (e) {
    logger.warn(`[Razgon:${inst.keyName}] Exchange position check failed for ${symbol}, skipping entry: ${(e as Error).message}`);
    return; // fail-safe: don't open if we can't verify
  }

  // Fetch REAL available balance to cap margin
  let availableForEntry = 0;
  try {
    const bals = await getBalances(inst.keyName);
    const usdtBal = bals.find(b => b.coin === 'USDT');
    availableForEntry = usdtBal ? parseFloat(usdtBal.availableBalance) : 0;
  } catch (e) {
    logger.warn(`[Razgon:${inst.keyName}] Cannot fetch available balance for ${symbol}, skipping`);
    return;
  }

  if (availableForEntry < 2) {
    logger.debug(`[Razgon:${inst.keyName}] Skip ${symbol}: available=$${availableForEntry.toFixed(2)} too low`);
    return;
  }

  // Position sizing — cap to real available balance
  let margin = inst.riskManager.computeMargin(
    inst.balance,
    cfg.allocation,
    cfg.leverage,
    cfg.stopLossPercent,
    inst.openPositions,
  );
  if (margin <= 0) return;

  // CRITICAL: never exceed what's actually available on exchange
  if (margin > availableForEntry * 0.95) {
    margin = availableForEntry * 0.90; // leave 10% buffer
    if (margin < 2) {
      logger.debug(`[Razgon:${inst.keyName}] Skip ${symbol}: capped margin=$${margin.toFixed(2)} too small`);
      return;
    }
  }

  const notional = margin * cfg.leverage;
  const slPrice = inst.riskManager.computeStopLoss(entryPrice, side, cfg.stopLossPercent);

  const entryMsg = `[Razgon:${inst.keyName}] ENTRY ${side.toUpperCase()} ${symbol} @ ${entryPrice} | notional=$${notional.toFixed(0)} margin=$${margin.toFixed(2)} avail=$${availableForEntry.toFixed(2)} SL=${slPrice.toFixed(6)}`;
  logger.info(entryMsg);
  console.log(entryMsg);

  try {
    await applySymbolRiskSettings(inst.keyName, symbol, cfg.marginType, cfg.leverage);
    const orderSide = side === 'long' ? 'Buy' : 'Sell';
    const qty = notional / entryPrice;
    await placeOrder(inst.keyName, symbol, orderSide, String(qty), 'Market');

    const pos: RazgonPosition = {
      id: uuid(), subStrategy: 'momentum', symbol, side, entryPrice, notional, margin,
      leverage: cfg.leverage, openedAt: Date.now(), tpAnchor: entryPrice, slPrice, unrealizedPnl: 0,
    };
    inst.openPositions.push(pos);
    inst.balance -= margin;
    // Clear cooldown on success
    inst.failedSymbols.delete(symbol);
    console.log(`[Razgon:${inst.keyName}] ORDER OK ${symbol} ${side} qty=${qty.toFixed(4)} margin=$${margin.toFixed(2)}`);
  } catch (e) {
    // Set 60s cooldown to prevent spam retries
    inst.failedSymbols.set(symbol, Date.now());
    const errMsg = `[Razgon:${inst.keyName}] Order FAILED ${symbol}: ${(e as Error).message}`;
    logger.error(errMsg);
    console.error(errMsg);
  }
}

async function checkMomentumExits(inst: RazgonInstance): Promise<void> {
  if (!config) return;
  const cfg = config.momentum;

  const momPositions = inst.openPositions.filter(p => p.subStrategy === 'momentum');

  for (const pos of momPositions) {
    try {
      const candles = await fetchAndCache1mCandles(inst, pos.symbol, 5);
      if (candles.length === 0) continue;

      const currentPrice = candles[candles.length - 1].close;

      pos.tpAnchor = inst.riskManager.updateAnchor(pos.tpAnchor, currentPrice, pos.side);
      const tpTrailPrice = inst.riskManager.computeTrailingTp(pos.tpAnchor, pos.side, cfg.trailingTpPercent);

      pos.unrealizedPnl = inst.riskManager.computeGrossPnl(pos.entryPrice, currentPrice, pos.notional, pos.side);

      // Check exit conditions
      let exitReason: RazgonTrade['exitReason'] | null = null;

      if (inst.riskManager.isStopLossHit(currentPrice, pos.slPrice, pos.side)) {
        exitReason = 'sl';
      } else if (inst.riskManager.isTrailingTpHit(currentPrice, tpTrailPrice, pos.side)) {
        exitReason = 'tp';
      } else if (inst.riskManager.isTimedOut(pos.openedAt, cfg.maxPositionTimeSec)) {
        exitReason = 'timeout';
      } else if (inst.riskManager.isDailyLimitHit(inst.balance)) {
        exitReason = 'daily_limit';
      }

      if (exitReason) {
        await executeClose(inst, pos, currentPrice, exitReason);
      }
    } catch (e) {
      logger.debug(`[Razgon:${inst.keyName}] Exit check failed ${pos.symbol}: ${(e as Error).message}`);
    }
  }
}

// ── Sniper Tick ──────────────────────────────────────────────────────────

async function sniperTick(inst: RazgonInstance): Promise<void> {
  if (!config || status !== 'running') return;
  const cfg = config.sniper;

  const sniperPositions = inst.openPositions.filter(p => p.subStrategy === 'sniper');
  for (const pos of sniperPositions) {
    try {
      const candles = await fetchAndCache1mCandles(inst, pos.symbol, 3);
      if (candles.length === 0) continue;
      const price = candles[candles.length - 1].close;

      pos.unrealizedPnl = inst.riskManager.computeGrossPnl(pos.entryPrice, price, pos.notional, pos.side);

      let exitReason: RazgonTrade['exitReason'] | null = null;
      if (inst.riskManager.isStopLossHit(price, pos.slPrice, pos.side)) exitReason = 'sl';
      else if (inst.riskManager.isTimedOut(pos.openedAt, cfg.maxPositionTimeSec)) exitReason = 'timeout';
      const tpPrice = pos.side === 'long'
        ? pos.entryPrice * (1 + cfg.takeProfitPercent / 100)
        : pos.entryPrice * (1 - cfg.takeProfitPercent / 100);
      if ((pos.side === 'long' && price >= tpPrice) || (pos.side === 'short' && price <= tpPrice)) {
        exitReason = 'tp';
      }

      if (exitReason) await executeClose(inst, pos, price, exitReason);
    } catch (_) { /* skip */ }
  }

  if (sniperPositions.length > 0) return;

  try {
    const symbols = await getAllSymbols(inst.keyName);
    const symList = symbols.map((s: any) => typeof s === 'string' ? s : s.symbol || '');
    const newListings = detectNewListings(symList, inst.knownSymbols);

    for (const s of symList) inst.knownSymbols.add(s);

    if (newListings.length === 0) return;

    for (const sym of newListings.slice(0, 1)) {
      logger.info(`[Razgon:${inst.keyName}:Sniper] New listing detected: ${sym}`);

      await new Promise(res => setTimeout(res, Math.min(cfg.entryDelayMs, 10_000)));

      const candles = await fetchAndCache1mCandles(inst, sym, 5);
      if (candles.length === 0) continue;

      const price = candles[candles.length - 1].close;
      const openPrice = candles[0].open;

      const decision = decideSniperEntry(price, openPrice, cfg);
      if (decision.action === 'skip') {
        logger.info(`[Razgon:${inst.keyName}:Sniper] Skipping ${sym}: ${decision.reason}`);
        continue;
      }

      const margin = inst.riskManager.computeMargin(inst.balance, cfg.allocation, cfg.leverage, cfg.stopLossPercent, inst.openPositions);
      if (margin <= 0) continue;

      const notional = margin * cfg.leverage;

      try {
        await applySymbolRiskSettings(inst.keyName, sym, cfg.marginType, cfg.leverage);
        const qty = notional / price;
        await placeOrder(inst.keyName, sym, 'Buy', String(qty), 'Market');

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
        inst.openPositions.push(pos);
        inst.balance -= margin;

        logger.info(`[Razgon:${inst.keyName}:Sniper] Entered ${sym} LONG @ ${price} | notional=$${notional.toFixed(0)}`);
      } catch (e) {
        logger.error(`[Razgon:${inst.keyName}:Sniper] Order failed ${sym}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.debug(`[Razgon:${inst.keyName}:Sniper] Scan failed: ${(e as Error).message}`);
  }
}

// ── Funding Tick ─────────────────────────────────────────────────────────

async function fundingTick(inst: RazgonInstance): Promise<void> {
  if (!config || status !== 'running') return;
  const cfg = config.funding;

  const fundPositions = inst.openPositions.filter(p => p.subStrategy === 'funding');
  for (const pos of fundPositions) {
    try {
      const candles = await fetchAndCache1mCandles(inst, pos.symbol, 3);
      if (candles.length === 0) continue;
      const price = candles[candles.length - 1].close;
      pos.unrealizedPnl = inst.riskManager.computeGrossPnl(pos.entryPrice, price, pos.notional, pos.side);

      const unrealizedPct = (pos.unrealizedPnl / pos.margin) * 100;
      if (unrealizedPct <= -cfg.stopLossPercent) {
        await executeClose(inst, pos, price, 'sl');
      }
    } catch (_) { /* skip */ }
  }

  // Open new funding positions if slots available
  if (fundPositions.length >= cfg.maxPositions) return;

  logger.debug(`[Razgon:${inst.keyName}:Funding] Funding scan tick (placeholder)`);
}

// ── Shared Helpers ───────────────────────────────────────────────────────

async function executeClose(
  inst: RazgonInstance,
  pos: RazgonPosition,
  exitPrice: number,
  exitReason: RazgonTrade['exitReason'],
): Promise<void> {
  try {
    const closeSide = pos.side === 'long' ? 'Sell' : 'Buy';
    await closePosition(inst.keyName, pos.symbol, closeSide);
  } catch (e) {
    logger.error(`[Razgon:${inst.keyName}] Close order failed ${pos.symbol}: ${(e as Error).message}`);
  }
  recordClose(inst, pos, exitPrice, exitReason);
}

function recordClose(inst: RazgonInstance, pos: RazgonPosition, exitPrice: number, exitReason: RazgonTrade['exitReason']): void {
  // Guard against bad data (entryPrice=0 from restore)
  if (!pos.entryPrice || pos.entryPrice <= 0 || !isFinite(pos.entryPrice)) {
    logger.warn(`[Razgon:${inst.keyName}] Skipping recordClose for ${pos.symbol}: invalid entryPrice=${pos.entryPrice}`);
    inst.openPositions = inst.openPositions.filter(p => p.id !== pos.id);
    return;
  }

  const grossPnl = inst.riskManager.computeGrossPnl(pos.entryPrice, exitPrice, pos.notional, pos.side);
  const fee = inst.riskManager.computeFee(pos.notional);
  const netPnl = isFinite(grossPnl) ? grossPnl - fee : 0;

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
  inst.tradeHistory.push(trade);

  inst.balance += pos.margin + netPnl;
  // Guard against NaN/Infinity balance corruption
  if (!isFinite(inst.balance) || inst.balance < 0) inst.balance = 0;
  if (isFinite(inst.balance) && inst.balance > inst.peakBalance) inst.peakBalance = inst.balance;

  inst.openPositions = inst.openPositions.filter(p => p.id !== pos.id);

  inst.riskManager.recordTrade(trade, inst.balance);

  const emoji = netPnl >= 0 ? '✅' : '❌';
  const closeMsg = `[Razgon:${inst.keyName}] ${emoji} EXIT ${exitReason.toUpperCase()} ${pos.side} ${pos.symbol} | Entry=${pos.entryPrice.toFixed(6)} Exit=${exitPrice.toFixed(6)} | PnL=${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} fee=${fee.toFixed(2)} | Balance=$${inst.balance.toFixed(2)}`;
  logger.info(closeMsg);
  console.log(closeMsg);
}

async function fetchAndCache1mCandles(inst: RazgonInstance, symbol: string, minBars: number): Promise<Candle1m[]> {
  try {
    const raw = await Promise.race([
      getMarketData(inst.keyName, symbol, '1m', minBars + 5),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetch timeout')), 8000)),
    ]);
    if (!Array.isArray(raw) || raw.length === 0) return inst.candleCache.get(symbol) ?? [];

    const candles: Candle1m[] = raw.map((c: any) => ({
      timeMs: Number(c[0] ?? c.timeMs ?? c.timestamp ?? 0),
      open: Number(c[1] ?? c.open ?? 0),
      high: Number(c[2] ?? c.high ?? 0),
      low: Number(c[3] ?? c.low ?? 0),
      close: Number(c[4] ?? c.close ?? 0),
      volume: Number(c[5] ?? c.volume ?? 0),
    }));

    inst.candleCache.set(symbol, candles.slice(-MAX_CANDLE_CACHE));
    return candles;
  } catch {
    return inst.candleCache.get(symbol) ?? [];
  }
}


import { MarketMode, Strategy, StrategyType } from '../config/settings';
import {
  applySymbolRiskSettings,
  cancelAllOrders,
  closePosition,
  getBalances,
  getAllSymbols,
  getExchangeForApiKey,
  getInstrumentInfo,
  getMarketData,
  getPositions,
  isRateLimitError,
  placeOrder,
} from './exchange';
import { calculateSyntheticOHLC } from './synthetic';
import { getCachedMarketData, warmMarketDataCache, type MarketDataWarmupJob } from './marketDataCache';
import {
  capBalancedLegQty,
  clampQtyString,
  effectiveMaxQty,
  resolveInstrumentMaxQty,
} from './orderQtyGuard';
import { recordLiveTradeEvent } from '../analytics/liveReconciliation';
import logger from '../utils/logger';
import { computeChannelWidthLotMultiplier } from '../services/strategy/sizing';
import { clearMacroShieldPartialState, evaluateMacroShieldExit, getMacroExitOverlayForApiKey, isMacroShieldEnabledForApiKey } from './macroExitShield';
import { getStatArbEntryGateForApiKey, passesStatArbEntryGateLive } from './statArbEntryGate';
import { getOrderBlockEntryGateForApiKey, passesOrderBlockEntryGateLive } from './orderBlockEntryGate';
import {
  buildZzPivotLevelSeries,
  computeZzPivotEntrySignal,
  isZzPivotStrategyType,
  normalizeZzPivotStrategyType,
  zzPivotVariantFromType,
} from './zzPivotLevels';
import { computeCtFractalSignalAtIndex, isCtFractalStrategyType } from './ctFractalSignal';
import {
  computeMomentumScalpSignalAtIndex,
  extractMomentumScalpParams,
  isMomentumScalpStrategyType,
  momentumScalpTpSlPrices,
} from './momentumScalpSignal';
import { acquireApiKeyPairEntryLock, acquireSystemEntryLock } from './strategy/mutex';

import type {
  StrategySignal,
  StrategyDraft,
  ParsedSyntheticCandle,
  ExecuteStrategyOptions,
  ExecutionCandleContext,
  ComputedSignal,
  StrategyExecutionSource,
} from './strategy/types';
import {
  normalizeStrategy,
  normalizeStrategyType,
  normalizeMarketMode,
  normalizeSymbol,
  normalizeSymbolKey,
  normalizeInterval,
  normalizeCoef,
  normalizeZscoreExit,
  normalizeZscoreStop,
  intervalToMs,
  validateStrategyBinding,
  DEFAULT_STRATEGY,
  getStrategySymbols,
  getStrategyPairKey,
  safeNumber,
  safeBoolean,
} from './strategy/normalize';
import { computeSignal } from './strategy/signals';
import {
  getStrategies,
  getStrategySummaries,
  getStrategyById,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  copyStrategyBlock,
  formatActionError,
  getStrategyRow,
  getApiKeyId,
  computeSignalTotalNotional,
  extractUsdtBalance,
} from './strategy/crud';
export type { StrategySummary } from './strategy/types';
export {
  getStrategies,
  getStrategySummaries,
  getStrategyById,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  copyStrategyBlock,
};


const OFFLINE_SYMBOL_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const offlineSymbolLogCooldown = new Map<string, number>();

// ── State-resync confirmation tracker ────────────────────────────────────────
// Bug fix (2026-05): single-cycle `state_resynced_flat` was triggering on
// transient empty getPositions() responses (rate-limit, propagation glitch),
// destroying open SAAS positions and leaving them as orphans on exchange.
// Now we require TWO consecutive flat detections separated by at least
// RESYNC_CONFIRM_MS, AND verify no sibling active strategy on the same
// (apiKey, base_symbol) is currently in a non-flat state (since the visible
// "flat" might be a momentary pre-aggregation race when siblings are open).
const RESYNC_CONFIRM_MS = 90_000; // 90 s window — covers 1 full auto-cycle (30 s) + slack
interface PendingFlatEntry { firstDetectedMs: number; lastRatio: number; }
const resyncPendingFlatByStrategy = new Map<number, PendingFlatEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [k, until] of offlineSymbolLogCooldown) {
    if (until <= now) {
      offlineSymbolLogCooldown.delete(k);
    }
  }
}, 60_000);

const isOfflineSymbolMarketDataError = (errorText: string): boolean => {
  const text = String(errorText || '').toLowerCase();
  // Matches: 'market symbol offline on <any exchange>: <symbol>'
  // Also handles BingX cached pattern and legacy BingX typo 'validted'
  return text.includes('market symbol offline on')
    || text.includes('symbol is offline on')
    || (text.includes('offline currently') && (text.includes('validated symbols') || text.includes('validted')));
};

const shouldLogOfflineSymbolSkip = (apiKeyName: string, strategyId: number): boolean => {
  const key = `${apiKeyName}:${strategyId}`;
  const now = Date.now();
  const until = Number(offlineSymbolLogCooldown.get(key) || 0);
  if (until > now) {
    return false;
  }
  offlineSymbolLogCooldown.set(key, now + OFFLINE_SYMBOL_LOG_COOLDOWN_MS);
  return true;
};




const parseSyntheticCandle = (item: any): ParsedSyntheticCandle | null => {
  const timeMs = Number(item?.time);
  const open = Number(item?.open);
  const high = Number(item?.high);
  const low = Number(item?.low);
  const close = Number(item?.close);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return { timeMs, open, high, low, close };
};

const parseMarketDataCandle = (item: any): ParsedSyntheticCandle | null => {
  if (!Array.isArray(item) || item.length < 5) {
    return null;
  }

  const timeMs = Number(item[0]);
  const open = Number(item[1]);
  const high = Number(item[2]);
  const low = Number(item[3]);
  const close = Number(item[4]);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return { timeMs, open, high, low, close };
};

const loadStrategyCandles = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol' | 'base_coef' | 'quote_coef' | 'interval'>,
  limit: number,
  options?: {
    startMs?: number;
    endMs?: number;
  }
): Promise<ParsedSyntheticCandle[]> => {
  const marketMode = normalizeMarketMode(strategy.market_mode);

  if (marketMode === 'mono') {
    const raw = await getCachedMarketData(
      apiKeyName,
      strategy.base_symbol,
      strategy.interval,
      limit,
      options
    );

    return (Array.isArray(raw) ? raw : [])
      .map((item) => parseMarketDataCandle(item))
      .filter((item): item is ParsedSyntheticCandle => !!item)
      .sort((a, b) => a.timeMs - b.timeMs);
  }

  const raw = await calculateSyntheticOHLC(
    apiKeyName,
    strategy.base_symbol,
    strategy.quote_symbol,
    strategy.base_coef,
    strategy.quote_coef,
    strategy.interval,
    limit,
    options
  );

  return (Array.isArray(raw) ? raw : [])
    .map((item) => parseSyntheticCandle(item))
    .filter((item): item is ParsedSyntheticCandle => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);
};

const getLatestMarketClose = async (apiKeyName: string, symbol: string): Promise<number> => {
  const payload = await getMarketData(apiKeyName, symbol, '1m', 5);
  const parsed = (Array.isArray(payload) ? payload : [])
    .map((item: any) => {
      if (!Array.isArray(item) || item.length < 5) {
        return null;
      }
      const timeMs = Number(item[0]);
      const close = Number(item[4]);
      if (!Number.isFinite(timeMs) || !Number.isFinite(close)) {
        return null;
      }
      return { timeMs, close };
    })
    .filter((item): item is { timeMs: number; close: number } => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);

  const latest = parsed[parsed.length - 1];
  if (!latest) {
    throw new Error(`No market data for ${symbol}`);
  }

  return latest.close;
};


const decimalPlaces = (value: string): number => {
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
};

type QtyRules = {
  symbol: string;
  qtyStep: number;
  minQty: number;
  maxQty: number;
  decimals: number;
};

type QtyCandidate = {
  qty: number;
  notional: number;
  text: string;
};

type BalancedQtyPlan = {
  baseQty: string;
  quoteQty: string;
  baseNotional: number;
  quoteNotional: number;
  totalNotional: number;
  shareError: number;
  totalDeviation: number;
  oversize: number;
  baseTargetNotional: number;
  quoteTargetNotional: number;
  baseLegDeviation?: number;
  quoteLegDeviation?: number;
  hasWarning?: boolean;
  warningReason?: string;
};

type SingleQtyPlan = {
  qty: string;
  notional: number;
  targetNotional: number;
  totalDeviation: number;
  oversize: number;
  hasWarning?: boolean;
  warningReason?: string;
};

type LiveLegBalanceSnapshot = {
  baseNotional: number;
  quoteNotional: number;
  expectedBaseShare: number;
  actualBaseShare: number;
  shareError: number;
};

const SIZING_EPSILON = 1e-9;
// Exchange lot-step quantization can make perfect synthetic leg ratio impossible
// on lower-notional entries. A 6% tolerance keeps balance checks meaningful
// while avoiding false low-lot blocks for executable orders.
const MAX_SHARE_ERROR = 0.5;
const MAX_LEG_DEVIATION = 0.3;
const MAX_OVERSIZE_DEVIATION = 0.2;
const MAX_TOTAL_DEVIATION = 0.3;
const MAX_POST_OPEN_SHARE_ERROR = 0.08;
const BAR_CLOSE_FRESHNESS_MS = 1500;
const TRAILING_RATIO_EPSILON = 1e-12;

const processedClosedBarByStrategy = new Map<string, number>();

// Tracks partial TP (50% close) per strategy to prevent double-fire.
const partialTpTriggeredByStrategy = new Map<number, boolean>();

// ── Shared signal cache ───────────────────────────────────────────────────────
// Within one runAutoStrategiesCycle, strategies with identical signal parameters
// (same exchange key, pair, interval, strategy type, channel length, detection
// source, zscore entry, long/short enabled flags) reuse the same computed signal.
// This eliminates redundant indicator calculations and, crucially, guarantees that
// ALL strategies sharing a signal group evaluate the SAME signal value in the same
// cycle — preventing desync from independent computations on slightly-different
// candle slices.
type CachedSignalEntry = ComputedSignal & { evaluatedBarTimeMs: number };
let _cycleSignalCache: Map<string, CachedSignalEntry> | null = null;
let _cycleSignalCacheExpiry = 0;
const CYCLE_SIGNAL_CACHE_TTL_MS = 60_000; // one full cycle window

const getCycleSignalCache = (): Map<string, CachedSignalEntry> => {
  const now = Date.now();
  if (!_cycleSignalCache || now > _cycleSignalCacheExpiry) {
    _cycleSignalCache = new Map();
    _cycleSignalCacheExpiry = now + CYCLE_SIGNAL_CACHE_TTL_MS;
  }
  return _cycleSignalCache;
};

const resetCycleSignalCache = (): void => {
  _cycleSignalCache = new Map();
  _cycleSignalCacheExpiry = Date.now() + CYCLE_SIGNAL_CACHE_TTL_MS;
};

const makeSignalGroupKey = (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol' | 'base_coef' | 'quote_coef' | 'interval' | 'strategy_type' | 'price_channel_length' | 'detection_source' | 'zscore_entry' | 'long_enabled' | 'short_enabled'>
): string => {
  const mode = normalizeMarketMode(strategy.market_mode);
  const base = String(strategy.base_symbol || '').toUpperCase();
  const quote = mode === 'mono' ? '' : String(strategy.quote_symbol || '').toUpperCase();
  const baseCoef = mode === 'mono' ? '' : String(Number(strategy.base_coef || 1).toFixed(6));
  const quoteCoef = mode === 'mono' ? '' : String(Number(strategy.quote_coef || 1).toFixed(6));
  const type = String(strategy.strategy_type || 'DD_BattleToads');
  const len = Math.max(2, Math.floor(Number(strategy.price_channel_length) || 50));
  const src = String(strategy.detection_source || 'close');
  const zEntry = (type === 'stat_arb_zscore' || type === 'CT_Fractal')
    ? Number(strategy.zscore_entry || 2.5).toFixed(4)
    : '';
  const longs = strategy.long_enabled ? '1' : '0';
  const shorts = strategy.short_enabled ? '1' : '0';
  return `${apiKeyName}|${mode}|${base}|${quote}|${baseCoef}|${quoteCoef}|${strategy.interval}|${type}|${len}|${src}|${zEntry}|${longs}|${shorts}`;
};

const extractSourceSid = (strategyName: string): string => {
  const m = String(strategyName || '').match(/::SID(\d+)$/);
  return m?.[1] ? m[1] : '';
};

// All algofund clients now follow the standard reconciliation/alignment
// pipeline. Previously two keys (artursk-9542210407, artursk-6659194994)
// were quarantined here while we debugged broken position state — see
// memory: cross-strategy-reconciliation. After publish edit-in-place was
// fixed, divergence root cause is gone, so the lists are intentionally
// empty. Re-add a key here only as a temporary surgical workaround
// and document the reason next to it.
const TS_SYNC_EXCLUDED_API_KEYS = new Set<string>([]);

const POSITION_ALIGNMENT_EXCLUDED_API_KEYS = new Set<string>([]);

const loadExpectedAlgofundSidMap = async (): Promise<Map<string, Set<string>>> => {
  const { db } = await import('../utils/database');
  const profiles: Array<{ execution_api_key_name: string; published_system_name: string }> = await db.all(
    `SELECT
       TRIM(COALESCE(execution_api_key_name, '')) AS execution_api_key_name,
       TRIM(COALESCE(published_system_name, '')) AS published_system_name
     FROM algofund_profiles
     WHERE COALESCE(requested_enabled, 0) = 1
       AND COALESCE(actual_enabled, 0) = 1
       AND TRIM(COALESCE(execution_api_key_name, '')) != ''
       AND TRIM(COALESCE(published_system_name, '')) != ''`
  ) || [];

  const out = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const apiKeyName = String(profile.execution_api_key_name || '').trim();
    const publishedSystemName = String(profile.published_system_name || '').trim();
    if (!apiKeyName || !publishedSystemName) continue;
    if (TS_SYNC_EXCLUDED_API_KEYS.has(apiKeyName)) continue;

    const systemRow: any = await db.get(
      `SELECT id
       FROM trading_systems
       WHERE name = ? OR name LIKE ?
       ORDER BY CASE WHEN name = ? THEN 1 ELSE 0 END DESC, id DESC
       LIMIT 1`,
      [publishedSystemName, `${publishedSystemName}::%`, publishedSystemName],
    );

    const systemId = Number(systemRow?.id || 0);
    if (!Number.isFinite(systemId) || systemId <= 0) {
      continue;
    }

    const members: Array<{ strategy_id: number }> = await db.all(
      `SELECT strategy_id
       FROM trading_system_members
       WHERE system_id = ?
         AND COALESCE(is_enabled, 1) = 1`,
      [systemId],
    ) || [];

    const expected = new Set<string>();
    for (const row of members) {
      const sid = String(Number(row?.strategy_id || 0));
      if (sid !== '0') expected.add(sid);
    }
    if (expected.size > 0) {
      out.set(apiKeyName, expected);
    }
  }

  return out;
};
// ─────────────────────────────────────────────────────────────────────────────

const normalizeQtyValue = (value: number, decimals: number): number => {
  const safeDecimals = Math.max(0, Math.min(12, decimals));
  return Number(value.toFixed(safeDecimals));
};

const formatQty = (qty: number, decimals: number): string => {
  return normalizeQtyValue(qty, decimals).toFixed(Math.max(0, decimals)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};

const loadQtyRules = async (apiKeyName: string, symbol: string): Promise<QtyRules> => {
  const info = await getInstrumentInfo(apiKeyName, symbol);

  const qtyStepRaw = String(info?.lotSizeFilter?.qtyStep || '0.001');
  const minQtyRaw = String(info?.lotSizeFilter?.minOrderQty || '0');
  const maxQtyRaw = String(resolveInstrumentMaxQty(info) || info?.lotSizeFilter?.maxOrderQty || '0');

  const qtyStep = Number.parseFloat(qtyStepRaw);
  const minQty = Number.parseFloat(minQtyRaw);
  const maxQty = Number.parseFloat(maxQtyRaw);

  const safeStep = Number.isFinite(qtyStep) && qtyStep > 0 ? qtyStep : 0.001;
  const safeMin = Number.isFinite(minQty) && minQty > 0 ? minQty : 0;
  const safeMax = Number.isFinite(maxQty) && maxQty > 0 ? maxQty : Number.POSITIVE_INFINITY;

  return {
    symbol,
    qtyStep: safeStep,
    minQty: safeMin,
    maxQty: safeMax,
    decimals: Math.max(0, decimalPlaces(qtyStepRaw)),
  };
};

const qtyFromUnits = (units: number, rules: QtyRules): number => {
  if (!Number.isFinite(units) || units <= 0) {
    return 0;
  }

  return normalizeQtyValue(units * rules.qtyStep, Math.max(rules.decimals, 8));
};

const buildQtyCandidates = (rawQty: number, price: number, rules: QtyRules): QtyCandidate[] => {
  if (!Number.isFinite(rawQty) || rawQty <= 0) {
    throw new Error(`Invalid raw qty for ${rules.symbol}`);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid market price for ${rules.symbol}`);
  }

  const step = rules.qtyStep;
  const maxCap = effectiveMaxQty(rules);
  const maxUnits = Number.isFinite(maxCap)
    ? Math.floor((maxCap + SIZING_EPSILON) / step)
    : Number.POSITIVE_INFINITY;
  const minUnitsByFilter = Math.max(1, Math.ceil((rules.minQty - SIZING_EPSILON) / step));
  const centerUnits = rawQty / step;
  const floorUnits = Math.floor(centerUnits + SIZING_EPSILON);
  const ceilUnits = Math.ceil(centerUnits - SIZING_EPSILON);

  const rawStart = Math.max(minUnitsByFilter, floorUnits - 3);
  const rawEnd = Math.max(rawStart, ceilUnits + 3);

  const unitSet = new Set<number>();
  for (let units = rawStart; units <= rawEnd; units += 1) {
    if (units >= minUnitsByFilter && units > 0 && units <= maxUnits) {
      unitSet.add(units);
    }
  }

  if (minUnitsByFilter <= maxUnits) {
    unitSet.add(minUnitsByFilter);
  }
  if (floorUnits >= minUnitsByFilter && floorUnits <= maxUnits) {
    unitSet.add(floorUnits);
  }
  if (ceilUnits >= minUnitsByFilter && ceilUnits <= maxUnits) {
    unitSet.add(ceilUnits);
  }

  const candidates = Array.from(unitSet)
    .map((units) => qtyFromUnits(units, rules))
    .filter((qty) => Number.isFinite(qty) && qty > 0)
    .filter((qty) => qty + SIZING_EPSILON >= rules.minQty)
    .filter((qty) => qty <= maxCap + SIZING_EPSILON)
    .map((qty) => ({
      qty,
      notional: qty * price,
      text: formatQty(qty, rules.decimals),
    }))
    .sort((left, right) => left.qty - right.qty);

  if (candidates.length === 0) {
    throw new Error(`Unable to build qty candidates for ${rules.symbol}`);
  }

  return candidates;
};

const buildBalancedQtyPlan = async (
  apiKeyName: string,
  baseSymbol: string,
  quoteSymbol: string,
  basePrice: number,
  quotePrice: number,
  totalNotional: number,
  baseWeight: number,
  quoteWeight: number
): Promise<BalancedQtyPlan> => {
  if (!Number.isFinite(totalNotional) || totalNotional <= 0) {
    throw new Error('Trade notional must be positive');
  }

  if (!Number.isFinite(baseWeight) || !Number.isFinite(quoteWeight) || baseWeight <= 0 || quoteWeight <= 0) {
    throw new Error('Both synthetic leg coefficients must be non-zero for balanced execution');
  }

  const totalWeight = baseWeight + quoteWeight;
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error('Synthetic coefficient weights are invalid');
  }

  const baseTargetNotional = totalNotional * (baseWeight / totalWeight);
  const quoteTargetNotional = totalNotional * (quoteWeight / totalWeight);
  const rawBaseQty = baseTargetNotional / basePrice;
  const rawQuoteQty = quoteTargetNotional / quotePrice;

  const [baseRules, quoteRules] = await Promise.all([
    loadQtyRules(apiKeyName, baseSymbol),
    loadQtyRules(apiKeyName, quoteSymbol),
  ]);

  const baseCandidates = buildQtyCandidates(rawBaseQty, basePrice, baseRules);
  const quoteCandidates = buildQtyCandidates(rawQuoteQty, quotePrice, quoteRules);

  const targetBaseShare = baseWeight / totalWeight;

  let best: {
    base: QtyCandidate;
    quote: QtyCandidate;
    totalActual: number;
    baseShare: number;
    shareError: number;
    totalDeviation: number;
    oversize: number;
    baseLegDeviation: number;
    quoteLegDeviation: number;
    score: number;
  } | null = null;

  for (const baseCandidate of baseCandidates) {
    for (const quoteCandidate of quoteCandidates) {
      const totalActual = baseCandidate.notional + quoteCandidate.notional;
      if (!Number.isFinite(totalActual) || totalActual <= 0) {
        continue;
      }

      const baseShare = baseCandidate.notional / totalActual;
      const shareError = Math.abs(baseShare - targetBaseShare);
      const totalDeviation = Math.abs(totalActual - totalNotional) / Math.max(totalNotional, SIZING_EPSILON);
      const oversize = Math.max(0, (totalActual - totalNotional) / Math.max(totalNotional, SIZING_EPSILON));
      const baseLegDeviation = Math.abs(baseCandidate.notional - baseTargetNotional) / Math.max(baseTargetNotional, SIZING_EPSILON);
      const quoteLegDeviation = Math.abs(quoteCandidate.notional - quoteTargetNotional) / Math.max(quoteTargetNotional, SIZING_EPSILON);

      const score = shareError * 1000 + oversize * 200 + totalDeviation * 10;

      if (!best || score < best.score) {
        best = {
          base: baseCandidate,
          quote: quoteCandidate,
          totalActual,
          baseShare,
          shareError,
          totalDeviation,
          oversize,
          baseLegDeviation,
          quoteLegDeviation,
          score,
        };
      }
    }
  }

  if (!best) {
    throw new Error('Unable to find a valid balanced quantity plan');
  }

  // ── Graceful fallback: warn instead of hard-block ────────────────────
  const hasWarnings = best.shareError > MAX_SHARE_ERROR
    || best.baseLegDeviation > MAX_LEG_DEVIATION
    || best.quoteLegDeviation > MAX_LEG_DEVIATION
    || best.totalDeviation > MAX_TOTAL_DEVIATION
    || best.oversize > MAX_OVERSIZE_DEVIATION;

  let warningReason: string | undefined;
  if (hasWarnings) {
    const issues: string[] = [];
    if (best.shareError > MAX_SHARE_ERROR) {
      issues.push(`shareError=${(best.shareError * 100).toFixed(2)}% (limit ${(MAX_SHARE_ERROR * 100).toFixed(0)}%)`);
    }
    if (best.baseLegDeviation > MAX_LEG_DEVIATION) {
      issues.push(`baseDev=${(best.baseLegDeviation * 100).toFixed(2)}%`);
    }
    if (best.quoteLegDeviation > MAX_LEG_DEVIATION) {
      issues.push(`quoteDev=${(best.quoteLegDeviation * 100).toFixed(2)}%`);
    }
    if (best.totalDeviation > MAX_TOTAL_DEVIATION) {
      issues.push(`totalDev=${(best.totalDeviation * 100).toFixed(2)}%`);
    }
    if (best.oversize > MAX_OVERSIZE_DEVIATION) {
      issues.push(`oversize=${(best.oversize * 100).toFixed(2)}%`);
    }
    warningReason = issues.join('; ');
  }

  return {
    baseQty: best.base.text,
    quoteQty: best.quote.text,
    baseNotional: best.base.notional,
    quoteNotional: best.quote.notional,
    totalNotional: best.totalActual,
    shareError: best.shareError,
    totalDeviation: best.totalDeviation,
    oversize: best.oversize,
    baseTargetNotional,
    quoteTargetNotional,
    baseLegDeviation: best.baseLegDeviation,
    quoteLegDeviation: best.quoteLegDeviation,
    hasWarning: hasWarnings,
    warningReason,
  };
};

const buildSingleQtyPlan = async (
  apiKeyName: string,
  symbol: string,
  price: number,
  targetNotional: number
): Promise<SingleQtyPlan> => {
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) {
    throw new Error('Trade notional must be positive');
  }

  const rules = await loadQtyRules(apiKeyName, symbol);
  const rawQty = targetNotional / price;
  const candidates = buildQtyCandidates(rawQty, price, rules);

  let best: {
    candidate: QtyCandidate;
    totalDeviation: number;
    oversize: number;
    score: number;
  } | null = null;

  for (const candidate of candidates) {
    const totalDeviation = Math.abs(candidate.notional - targetNotional) / Math.max(targetNotional, SIZING_EPSILON);
    const oversize = Math.max(0, (candidate.notional - targetNotional) / Math.max(targetNotional, SIZING_EPSILON));
    const score = oversize * 200 + totalDeviation * 10;

    if (!best || score < best.score) {
      best = {
        candidate,
        totalDeviation,
        oversize,
        score,
      };
    }
  }

  if (!best) {
    throw new Error(`Unable to find a valid quantity plan for ${symbol}`);
  }

  // Graceful fallback: use minQty instead of hard-blocking if lot is too small.
  // The trade executes at minimum exchange lot; admin receives a low_lot_warning.
  const hasWarning = best.totalDeviation > MAX_TOTAL_DEVIATION || best.oversize > MAX_OVERSIZE_DEVIATION;
  let warningReason: string | undefined;
  if (hasWarning) {
    warningReason = (
      `Order size too small for mono execution: targetNotional=${targetNotional.toFixed(2)} USDT, `
      + `actualNotional=${best.candidate.notional.toFixed(2)} USDT, `
      + `totalDeviation=${(best.totalDeviation * 100).toFixed(2)}%, `
      + `oversize=${(best.oversize * 100).toFixed(2)}%. Using min lot.`
    );
  }

  return {
    qty: best.candidate.text,
    notional: best.candidate.notional,
    targetNotional,
    totalDeviation: best.totalDeviation,
    oversize: best.oversize,
    hasWarning,
    warningReason,
  };
};

const sleepMs = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
};

const extractPositionNotional = (position: any): number => {
  const explicit = Number(position?.positionValue);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.abs(explicit);
  }

  const size = Number(position?.size);
  const markPrice = Number(position?.markPrice);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(markPrice) && markPrice > 0) {
    return Math.abs(size * markPrice);
  }

  const entryPrice = Number(position?.avgPrice ?? position?.entryPrice);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    return Math.abs(size * entryPrice);
  }

  return 0;
};

const validateLiveLegBalance = (
  basePosition: any,
  quotePosition: any,
  baseWeight: number,
  quoteWeight: number,
  maxShareError: number
): { ok: boolean; snapshot: LiveLegBalanceSnapshot } => {
  const safeBaseWeight = Math.abs(baseWeight);
  const safeQuoteWeight = Math.abs(quoteWeight);
  const totalWeight = safeBaseWeight + safeQuoteWeight;

  const baseNotional = extractPositionNotional(basePosition);
  const quoteNotional = extractPositionNotional(quotePosition);
  const totalNotional = baseNotional + quoteNotional;

  const expectedBaseShare = totalWeight > SIZING_EPSILON
    ? safeBaseWeight / totalWeight
    : 0.5;
  const actualBaseShare = totalNotional > SIZING_EPSILON
    ? baseNotional / totalNotional
    : 0;
  const shareError = Math.abs(actualBaseShare - expectedBaseShare);

  return {
    ok: totalNotional > SIZING_EPSILON && shareError <= Math.max(0, maxShareError),
    snapshot: {
      baseNotional,
      quoteNotional,
      expectedBaseShare,
      actualBaseShare,
      shareError,
    },
  };
};

const loadPairPositionsForValidation = async (
  apiKeyName: string,
  baseSymbol: string,
  quoteSymbol: string,
  attempts: number = 3,
  waitMs: number = 300
): Promise<{ basePosition: any | null; quotePosition: any | null }> => {
  const safeAttempts = Math.max(1, Math.floor(attempts));

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const positions = await getPositions(apiKeyName);

    const basePosition = positions.find((position: any) => {
      return (
        String(position?.symbol || '').toUpperCase() === baseSymbol.toUpperCase()
        && Number.parseFloat(String(position?.size || '0')) > 0
      );
    }) || null;

    const quotePosition = positions.find((position: any) => {
      return (
        String(position?.symbol || '').toUpperCase() === quoteSymbol.toUpperCase()
        && Number.parseFloat(String(position?.size || '0')) > 0
      );
    }) || null;

    if (basePosition && quotePosition) {
      return { basePosition, quotePosition };
    }

    if (attempt < safeAttempts - 1) {
      await sleepMs(waitMs);
    }
  }

  return {
    basePosition: null,
    quotePosition: null,
  };
};

const loadSinglePositionForValidation = async (
  apiKeyName: string,
  symbol: string,
  attempts: number = 3,
  waitMs: number = 300
): Promise<any | null> => {
  const safeAttempts = Math.max(1, Math.floor(attempts));

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const positions = await getPositions(apiKeyName);
    const position = positions.find((item: any) => {
      return (
        String(item?.symbol || '').toUpperCase() === symbol.toUpperCase()
        && Number.parseFloat(String(item?.size || '0')) > 0
      );
    }) || null;

    if (position) {
      return position;
    }

    if (attempt < safeAttempts - 1) {
      await sleepMs(waitMs);
    }
  }

  return null;
};

const resolveExecutionCandleContext = (
  candles: ParsedSyntheticCandle[],
  interval: string,
  closedBarOnly: boolean
): ExecutionCandleContext => {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error('No synthetic candles available for execution');
  }

  if (!closedBarOnly) {
    const latest = candles[candles.length - 1];
    return {
      candlesForSignal: candles,
      evaluatedBarTimeMs: latest.timeMs,
    };
  }

  const intervalMs = Math.max(60 * 1000, intervalToMs(interval));
  let closedIndex = candles.length - 1;
  const latest = candles[closedIndex];
  const latestClosesAt = latest.timeMs + intervalMs;

  if (latestClosesAt > Date.now() + BAR_CLOSE_FRESHNESS_MS) {
    closedIndex -= 1;
  }

  if (closedIndex < 0) {
    throw new Error('No closed candles available for execution');
  }

  return {
    candlesForSignal: candles.slice(0, closedIndex + 1),
    evaluatedBarTimeMs: candles[closedIndex].timeMs,
  };
};

const normalizeExchangeSymbolKey = (raw: string): string => {
  const token = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) {
    return '';
  }
  return token.endsWith('USDT') ? token : `${token}USDT`;
};

const countExchangeOpenPositions = (positions: any[]): number => {
  const symbols = new Set<string>();
  for (const row of positions || []) {
    const size = Math.abs(Number(row?.size || 0));
    if (!Number.isFinite(size) || size <= 0) {
      continue;
    }
    const key = normalizeExchangeSymbolKey(String(row?.symbol || ''));
    if (key) {
      symbols.add(key);
    }
  }
  return symbols.size;
};

const closeAllForSymbol = async (apiKeyName: string, symbol: string, options?: { marketType?: 'spot' | 'swap' }): Promise<void> => {
  const positions = await getPositions(apiKeyName, symbol);
  const relevant = positions.filter((position: any) => {
    return (
      String(position?.symbol || '').toUpperCase() === symbol.toUpperCase() &&
      Number.parseFloat(String(position?.size || '0')) > 0
    );
  });

  for (const position of relevant) {
    await closePosition(apiKeyName, symbol, String(position.size), position.side as 'Buy' | 'Sell', options);
  }
};

// Returns true if any OTHER active strategy on the same api_key + base_symbol
// is currently in long/short. When this is the case, the exchange position is
// shared and we must NOT call closeAllForSymbol — doing so would clobber every
// sibling strategy and trigger the cross-strategy churn loop that costs fees
// without delivering signal-driven trades.
const hasOpenSiblingsForSymbol = async (
  apiKeyName: string,
  symbol: string,
  strategyId: number,
): Promise<boolean> => {
  if (!apiKeyName || !symbol || !Number.isFinite(strategyId)) {
    return false;
  }
  try {
    const { db } = await import('../utils/database');
    const apiKeyRow: any = await db.get(`SELECT id FROM api_keys WHERE name = ?`, [apiKeyName]);
    if (!apiKeyRow?.id) {
      return false;
    }
    const row: any = await db.get(
      `SELECT COUNT(*) AS cnt FROM strategies
       WHERE api_key_id = ?
         AND is_active = 1
         AND state != 'flat'
         AND id != ?
         AND (UPPER(base_symbol) = UPPER(?) OR UPPER(quote_symbol) = UPPER(?))`,
      [apiKeyRow.id, strategyId, symbol, symbol],
    );
    return (row?.cnt || 0) > 0;
  } catch (err) {
    logger.warn(`hasOpenSiblingsForSymbol(${apiKeyName}, ${symbol}) failed: ${(err as Error).message}`);
    return false;
  }
};

export const closeStrategyExposure = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'id' | 'market_mode' | 'base_symbol' | 'quote_symbol' | 'market_type'>
): Promise<void> => {
  const symbols = getStrategySymbols(strategy);
  const exchangeMarketType: 'spot' | 'swap' | undefined = strategy.market_type === 'spot' ? 'spot' : undefined;
  for (const symbol of symbols) {
    // Cohabitation guard: if any sibling strategy on the same api_key still
    // owns a position on this symbol, the exchange position is shared and
    // closing it would nuke the sibling. Skip the exchange close in that case;
    // the caller will still mark THIS strategy as flat (DB-only release of
    // the symbol slot), and the actual exchange position is freed only when
    // the LAST owner exits.
    const strategyId = Number((strategy as any)?.id);
    if (Number.isFinite(strategyId) && strategyId > 0) {
      const siblings = await hasOpenSiblingsForSymbol(apiKeyName, symbol, strategyId);
      if (siblings) {
        logger.info(
          `closeStrategyExposure: skipping exchange close for ${apiKeyName}/${symbol} — `
          + `sibling strategies still hold the shared position (strategy=${strategyId})`
        );
        continue;
      }
    }
    await closeAllForSymbol(apiKeyName, symbol, exchangeMarketType ? { marketType: exchangeMarketType } : undefined);
  }
};

const cancelStrategyWorkingOrders = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>
): Promise<void> => {
  const symbols = getStrategySymbols(strategy);
  for (const symbol of symbols) {
    await cancelAllOrders(apiKeyName, symbol);
  }
};

export { cancelStrategyWorkingOrders };

const inferMonoStateFromPosition = (
  position: any | null
): 'flat' | 'long' | 'short' | 'mixed' => {
  if (!position) {
    return 'flat';
  }

  const side = String(position?.side || '').toLowerCase();
  if (side === 'buy') {
    return 'long';
  }
  if (side === 'sell') {
    return 'short';
  }
  return 'mixed';
};

const inferSyntheticStateFromPair = (
  basePosition: any | null,
  quotePosition: any | null
): 'flat' | 'long' | 'short' | 'mixed' => {
  if (!basePosition && !quotePosition) {
    return 'flat';
  }

  if (!basePosition || !quotePosition) {
    return 'mixed';
  }

  const baseSide = String(basePosition?.side || '').toLowerCase();
  const quoteSide = String(quotePosition?.side || '').toLowerCase();

  if (baseSide === 'buy' && quoteSide === 'sell') {
    return 'long';
  }

  if (baseSide === 'sell' && quoteSide === 'buy') {
    return 'short';
  }

  return 'mixed';
};



export const executeStrategy = async (
  apiKeyName: string,
  strategyId: number,
  options?: ExecuteStrategyOptions
) => {
  // Lock holder for the trading-system entry critical section.
  // Acquired during OP-limit check (only if system is found) and released at
  // function exit so all post-check ops (placeOrder, state UPDATE) are serialized
  // against other strategies of the same TS within this process.
  let releaseSystemLock: (() => void) | null = null;
  // Cross-TS pair lock: serializes entry on the same (api_key, pair_key) across
  // ALL trading systems of one api_key. Without this, two strategies belonging
  // to different TSs could pyramid the same exchange position.
  let releasePairLock: (() => void) | null = null;
  try {
  const existingRow = await getStrategyRow(apiKeyName, strategyId);
  const strategy = normalizeStrategy(existingRow);

  const executionSource: StrategyExecutionSource = options?.source || 'manual';
  const closedBarOnly = options?.closedBarOnly !== false;
  const dedupeClosedBar = options?.dedupeClosedBar === true;

  if (!strategy.is_active) {
    return {
      result: 'Strategy is paused',
      action: 'paused',
    };
  }

  const mergedStrategy: Strategy = {
    ...strategy,
  };
  const isPositionAlignmentExcluded = POSITION_ALIGNMENT_EXCLUDED_API_KEYS.has(apiKeyName);
  const marketMode = normalizeMarketMode(mergedStrategy.market_mode);
  const isMono = marketMode === 'mono';
  const positionLabel = isMono ? 'position' : 'synthetic position';

  // Execution must follow persisted strategy settings only.
  // This prevents stale UI/chart payloads from silently mutating strategy pairs.
  const executionBindingPatch: Partial<Strategy> = {};

  if (!mergedStrategy.base_symbol) {
    throw new Error('Strategy requires a base symbol');
  }

  if (!isMono && !mergedStrategy.quote_symbol) {
    throw new Error('Synthetic strategy requires a quote symbol');
  }

  if (!isMono && mergedStrategy.base_symbol === mergedStrategy.quote_symbol) {
    throw new Error('Base and quote symbols must be different');
  }

  const signalLength = Math.max(2, Math.floor(mergedStrategy.price_channel_length));
  const strategyTypeNorm = normalizeStrategyType(mergedStrategy.strategy_type);
  const lookback = (strategyTypeNorm === 'stat_arb_zscore' || strategyTypeNorm === 'CT_Fractal')
    ? Math.max(signalLength + 120, 220)
    : strategyTypeNorm === 'hideep'
      ? Math.max(signalLength + 110, 220)
      : isMomentumScalpStrategyType(strategyTypeNorm)
        ? Math.max(signalLength + 160, 200)
        : Math.max(signalLength + 30, 120);

  const candles = await loadStrategyCandles(apiKeyName, mergedStrategy, lookback);

  const candleContext = resolveExecutionCandleContext(
    candles,
    mergedStrategy.interval,
    closedBarOnly
  );

  // ── Shared signal cache lookup ──────────────────────────────────────────────
  // During auto-cycle, strategies with identical signal parameters share the same
  // pre-computed signal. This guarantees consistency across all accounts trading
  // the same pair with the same strategy settings in a single cycle.
  let computedSignalResult: ComputedSignal;
  const signalGroupKey = makeSignalGroupKey(apiKeyName, mergedStrategy);
  const signalCache = getCycleSignalCache();
  const cachedSignal = signalCache.get(signalGroupKey);

  if (cachedSignal && cachedSignal.evaluatedBarTimeMs === candleContext.evaluatedBarTimeMs) {
    // Re-use cached signal: same bar, same params → same result guaranteed
    computedSignalResult = {
      signal: cachedSignal.signal,
      currentRatio: cachedSignal.currentRatio,
      donchianHigh: cachedSignal.donchianHigh,
      donchianLow: cachedSignal.donchianLow,
      donchianCenter: cachedSignal.donchianCenter,
      zScore: cachedSignal.zScore,
      fastRsi: cachedSignal.fastRsi,
    };
  } else {
    if (isMomentumScalpStrategyType(strategyTypeNorm)) {
      const msParams = extractMomentumScalpParams(mergedStrategy);
      const idx = candleContext.candlesForSignal.length - 1;
      const posSide = (mergedStrategy.state || 'flat') as 'flat' | 'long' | 'short';
      const ms = computeMomentumScalpSignalAtIndex(
        candleContext.candlesForSignal,
        idx,
        msParams,
        undefined,
        posSide,
      );
      computedSignalResult = {
        signal: ms.signal,
        currentRatio: ms.current,
        donchianHigh: ms.current,
        donchianLow: ms.current,
        donchianCenter: ms.current,
        zScore: ms.adx,
        fastRsi: ms.plusDi,
      };
    } else {
      computedSignalResult = computeSignal(
        mergedStrategy.strategy_type || 'DD_BattleToads',
        candleContext.candlesForSignal,
        signalLength,
        mergedStrategy.detection_source,
        mergedStrategy.zscore_entry,
        mergedStrategy.long_enabled,
        mergedStrategy.short_enabled
      );
    }
    signalCache.set(signalGroupKey, { ...computedSignalResult, evaluatedBarTimeMs: candleContext.evaluatedBarTimeMs });
  }

  const { signal, currentRatio, donchianHigh, donchianLow, donchianCenter, zScore, fastRsi } = computedSignalResult;
  // ───────────────────────────────────────────────────────────────────────────

  const isCtFractal = isCtFractalStrategyType(String(mergedStrategy.strategy_type || ''));
  const isMomentumScalp = isMomentumScalpStrategyType(String(mergedStrategy.strategy_type || ''));
  const isStatArb = mergedStrategy.strategy_type === 'stat_arb_zscore' || isCtFractal;
  const isZzPivot = isZzPivotStrategyType(normalizeZzPivotStrategyType(String(mergedStrategy.strategy_type || '')));
  const zscoreExit = normalizeZscoreExit(mergedStrategy.zscore_exit, DEFAULT_STRATEGY.zscore_exit, mergedStrategy.zscore_entry);
  const zscoreStop = normalizeZscoreStop(mergedStrategy.zscore_stop, DEFAULT_STRATEGY.zscore_stop, mergedStrategy.zscore_entry);

  const takeProfitPercent = Math.max(0, mergedStrategy.take_profit_percent);
  let state: 'flat' | 'long' | 'short' = mergedStrategy.state || 'flat';
  let entryRatio: number | null = mergedStrategy.entry_ratio ?? null;
  type StrategyCloseAction =
    | 'take_profit_long'
    | 'take_profit_short'
    | 'stop_loss_long'
    | 'stop_loss_short'
    | 'mean_revert_exit_long'
    | 'mean_revert_exit_short'
    | 'zscore_stop_long'
    | 'zscore_stop_short'
    | 'macro_shield_exit_long'
    | 'macro_shield_exit_short'
    | 'macro_shield_partial';
  let closedAction: StrategyCloseAction | null = null;
  let closedResult: string | null = null;
  const evaluatedBarTimeMs = candleContext.evaluatedBarTimeMs;
  const evaluatedBarIso = new Date(evaluatedBarTimeMs).toISOString();
  const processedBarCacheKey = `${apiKeyName}:${strategyId}`;

  const markProcessedBar = (): void => {
    if (!dedupeClosedBar) {
      return;
    }

    processedClosedBarByStrategy.set(processedBarCacheKey, evaluatedBarTimeMs);
  };

  const returnWithProcessedBar = <T>(payload: T): T => {
    markProcessedBar();
    return payload;
  };

  const recordRuntimeTradeEvent = async (
    tradeType: 'entry' | 'exit',
    side: 'long' | 'short',
    price: number,
    positionSize = 0,
    sourceOrderId?: string,
    sourceSymbol?: string,
    entryPriceOverride?: number,
    actualFillPrice?: number
  ): Promise<void> => {
    const normalizedPrice = Number.isFinite(price) && price > 0 ? price : currentRatio;
    const normalizedSize = Number.isFinite(positionSize) ? Math.max(0, Number(positionSize)) : 0;
    // For exit, entry_price is the original entry (override) — slippage is meaningless here.
    // For entry, entry_price IS the signal/expected price (the bar close used by the strategy).
    const resolvedEntryPrice = tradeType === 'exit' && Number.isFinite(entryPriceOverride) && (entryPriceOverride as number) > 0
      ? entryPriceOverride as number
      : normalizedPrice;
    // Real fill price from the exchange (ccxt order.average / native avgPrice). Falls back to signal price.
    const resolvedActualPrice = Number.isFinite(actualFillPrice) && (actualFillPrice as number) > 0
      ? actualFillPrice as number
      : normalizedPrice;
    // Slippage% is computed only on entry against the signal/expected price (resolvedEntryPrice == signal price for entry).
    // Sign convention: positive = adverse fill (buy higher / sell lower than signal), negative = price improvement.
    let slippagePercent = 0;
    if (tradeType === 'entry' && Number.isFinite(actualFillPrice) && (actualFillPrice as number) > 0
        && Number.isFinite(normalizedPrice) && normalizedPrice > 0
        && Math.abs(resolvedActualPrice - normalizedPrice) / normalizedPrice < 0.05) {
      const direction = side === 'long' ? 1 : -1;
      slippagePercent = direction * ((resolvedActualPrice - normalizedPrice) / normalizedPrice) * 100;
    }
    if (tradeType === 'exit') {
      logger.info(`[pnl_debug_record] strategy=${strategyId} entryPriceOverride=${entryPriceOverride}, isFinite=${Number.isFinite(entryPriceOverride)}, >0=${(entryPriceOverride as number) > 0}, resolvedEntryPrice=${resolvedEntryPrice}, normalizedPrice=${normalizedPrice}, resolvedActualPrice=${resolvedActualPrice}`);
    }
    try {
      await recordLiveTradeEvent(strategyId, {
        trade_type: tradeType,
        side,
        event_origin: 'strategy_signal',
        entry_time: evaluatedBarTimeMs,
        entry_price: resolvedEntryPrice,
        position_size: normalizedSize,
        actual_price: resolvedActualPrice,
        actual_time: Date.now(),
        actual_fee: 0,
        slippage_percent: slippagePercent,
        source_order_id: sourceOrderId,
        source_symbol: sourceSymbol || mergedStrategy.base_symbol,
      });
    } catch (error) {
      logger.warn(`live_trade_events record failed for strategy ${strategyId}: ${formatActionError(error)}`);
    }
  };

  const persistTpAnchorRatio = async (nextAnchor: number | null): Promise<void> => {
    const currentAnchorRaw = mergedStrategy.tp_anchor_ratio;
    const currentAnchor = Number(currentAnchorRaw);

    if (nextAnchor === null) {
      if (currentAnchorRaw === null || currentAnchorRaw === undefined) {
        return;
      }

      await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        tp_anchor_ratio: null,
      });
      mergedStrategy.tp_anchor_ratio = null;
      return;
    }

    const normalizedAnchor = Number(nextAnchor);
    if (!Number.isFinite(normalizedAnchor) || normalizedAnchor <= 0) {
      return;
    }

    if (Number.isFinite(currentAnchor) && Math.abs(currentAnchor - normalizedAnchor) <= TRAILING_RATIO_EPSILON) {
      return;
    }

    await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      tp_anchor_ratio: normalizedAnchor,
    });
    mergedStrategy.tp_anchor_ratio = normalizedAnchor;
  };

  const persistFlatAfterExit = async (
    action: StrategyCloseAction,
    signalSnapshot: StrategySignal
  ): Promise<void> => {
    partialTpTriggeredByStrategy.delete(strategyId);
    clearMacroShieldPartialState(strategyId);
    const exitEntryRatio = entryRatio;
    await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: `${action}@${currentRatio}`,
      last_signal: signalSnapshot,
      last_error: null,
    });

    state = 'flat';
    entryRatio = null;
    mergedStrategy.state = 'flat';
    mergedStrategy.entry_ratio = null;
    mergedStrategy.tp_anchor_ratio = null;

    if (signalSnapshot === 'long' || signalSnapshot === 'short') {
      logger.info(`[pnl_debug] strategy=${strategyId} exit ${signalSnapshot}: exitEntryRatio=${exitEntryRatio}, currentRatio=${currentRatio}, mergedEntryRatio=${mergedStrategy.entry_ratio}, diff=${exitEntryRatio != null ? (currentRatio - exitEntryRatio).toFixed(8) : 'null'}`);
      await recordRuntimeTradeEvent('exit', signalSnapshot, currentRatio, 0, undefined, mergedStrategy.base_symbol, exitEntryRatio ?? undefined);
    }
  };

  /**
   * Atomic close+persist: guarantees persistFlatAfterExit runs even if
   * closeStrategyExposure throws (exchange timeout, network error).
   * The position may already be closed on exchange when the error fires,
   * so we must still record the exit and reset state.
   */
  const closeAndRecordExit = async (
    action: StrategyCloseAction,
    signalSnapshot: StrategySignal
  ): Promise<void> => {
    // Step 1: close on exchange — if this fails, do NOT touch DB state;
    // the position is still open and next cycle will retry.
    await closeStrategyExposure(apiKeyName, mergedStrategy);
    // Step 2: exchange confirmed close — now persist flat + exit event.
    // If THIS fails, resync will catch the discrepancy on the next cycle
    // (state=long/short in DB but flat on exchange → state_resynced_flat).
    await persistFlatAfterExit(action, signalSnapshot);
  };

  const livePositions: any[] = [];
  let positionsFetchReliable = true;
  try {
    const fetched = await getPositions(apiKeyName);
    livePositions.push(...(Array.isArray(fetched) ? fetched : []));
  } catch (positionError) {
    if (isRateLimitError(positionError)) {
      positionsFetchReliable = false;
      logger.warn(
        `Position poll unavailable for strategy ${strategyId} (${apiKeyName}): `
        + `${formatActionError(positionError)} — skipping state resync this cycle`
      );
    } else {
      throw positionError;
    }
  }
  const liveBase = livePositions.find((position: any) => {
    return normalizeSymbolKey(position?.symbol) === normalizeSymbolKey(mergedStrategy.base_symbol)
      && Number.parseFloat(String(position?.size || '0')) > 0;
  }) || null;
  const liveQuote = !isMono
    ? livePositions.find((position: any) => {
      return normalizeSymbolKey(position?.symbol) === normalizeSymbolKey(mergedStrategy.quote_symbol)
        && Number.parseFloat(String(position?.size || '0')) > 0;
    }) || null
    : null;

  const livePairState = isMono
    ? inferMonoStateFromPosition(liveBase)
    : inferSyntheticStateFromPair(liveBase, liveQuote);

  if (livePairState === 'mixed') {
    // Mixed pair state means only ONE leg is visible on the exchange.
    // When multiple strategies share symbols on the same API key, one leg may belong
    // to a different strategy. Force-closing destroys other strategies' positions and
    // causes an open→mixed→close→open loop that bleeds the account via fees.
    //
    // NEW: if this strategy is flat, the visible leg almost certainly belongs to another
    // strategy — skip entirely. If in-position, use a long grace period (5 min) to
    // avoid race conditions from propagation delay or rate-limit glitches.
    if (state === 'flat') {
      logger.info(
        `Mixed pair state for strategy ${strategyId} (state=flat) — skipping; visible leg likely belongs to another strategy`
      );
      return returnWithProcessedBar({
        result: 'Mixed pair state skipped — strategy is flat, leg belongs to another strategy',
        action: 'mixed_skip_flat',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const MIXED_GRACE_MS = 90_000; // 90s — OP pair conflict now active, shorter grace sufficient
    const lastUpdatedMs = mergedStrategy.updated_at
      ? new Date(String(mergedStrategy.updated_at).replace(' ', 'T') + 'Z').getTime()
      : 0;
    const msSinceUpdate = Date.now() - lastUpdatedMs;

    if (msSinceUpdate < MIXED_GRACE_MS) {
      logger.warn(
        `Mixed pair state for strategy ${strategyId} (state=${state}, ${Math.round(msSinceUpdate / 1000)}s since update) ` +
        `— skipping close within ${MIXED_GRACE_MS / 1000}s grace period`
      );
      return returnWithProcessedBar({
        result: 'Mixed pair state skipped — within post-open grace period',
        action: 'mixed_grace_skip',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    if (isPositionAlignmentExcluded) {
      logger.warn(
        `Mixed pair state for strategy ${strategyId} (${apiKeyName}) is excluded from auto-alignment close`
      );
      return returnWithProcessedBar({
        result: 'Mixed pair state skipped — api key excluded from position alignment',
        action: 'mixed_skip_alignment_excluded',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const previousState = state;
    const previousEntryRatio = entryRatio;
    await closeStrategyExposure(apiKeyName, mergedStrategy);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: `desync_closed_mixed@${currentRatio}`,
      last_error: null,
    });

    if (previousState === 'long' || previousState === 'short') {
      await recordRuntimeTradeEvent('exit', previousState, currentRatio, 0, undefined, mergedStrategy.base_symbol, previousEntryRatio ?? undefined);
    }

    logger.warn(`Detected mixed pair state for strategy ${strategyId}; positions were closed (was ${previousState})`);
    return returnWithProcessedBar({
      result: 'Mixed pair positions detected and closed',
      action: 'desync_closed_mixed',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state !== 'flat' && livePairState !== 'flat' && state !== livePairState) {
    if (isPositionAlignmentExcluded) {
      logger.warn(
        `State mismatch for strategy ${strategyId} (${apiKeyName}) is excluded from auto-alignment close`
      );
      return returnWithProcessedBar({
        result: 'Live/strategy mismatch skipped — api key excluded from position alignment',
        action: 'state_mismatch_skip_alignment_excluded',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const previousState = state;
    const previousEntryRatio = entryRatio;
    await closeStrategyExposure(apiKeyName, mergedStrategy);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: `desync_closed_state_mismatch@${currentRatio}`,
      last_error: null,
    });

    if (previousState === 'long' || previousState === 'short') {
      await recordRuntimeTradeEvent('exit', previousState, currentRatio, 0, undefined, mergedStrategy.base_symbol, previousEntryRatio ?? undefined);
    }

    logger.warn(`Detected wrong-side live state for strategy ${strategyId}; was ${previousState}, live=${livePairState}; positions were closed`);
    return returnWithProcessedBar({
      result: 'Live pair state mismatched strategy state and was closed',
      action: 'desync_closed_state_mismatch',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state === 'flat' && livePairState !== 'flat') {
    // When multiple strategies share symbols on the same API key, visible positions
    // likely belong to other strategies. Do NOT close or adopt them — this strategy
    // should remain flat and wait for its own entry signal.
    logger.info(
      `Strategy ${strategyId} is flat but live pair state is ${livePairState} — ` +
      `skipping; positions likely belong to another strategy on same API key`
    );
    return returnWithProcessedBar({
      result: `Strategy flat, live=${livePairState} — skipped to avoid cross-strategy interference`,
      action: 'flat_skip_shared_positions',
      strategy: mergedStrategy,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (positionsFetchReliable && state !== 'flat' && livePairState === 'flat') {
    // ── Two-stage confirmation guard ──
    // Bug context: a single transient empty getPositions() response (rate-limit
    // glitch, propagation race when a sibling SAAS strategy on the same apiKey
    // just opened/closed) used to immediately write `state_resynced_flat`,
    // destroying open trades and leaving orphan positions on exchange.
    //
    // Defense:
    //   (a) Sibling guard — if any other ACTIVE strategy on the same (apiKey,
    //       base_symbol) is currently in non-flat state, the visible "flat"
    //       may be a stale snapshot taken between sibling open/close calls.
    //       Skip resync entirely; sibling will keep position correct.
    //   (b) Two-cycle confirmation — first detection logs warning + remembers
    //       timestamp; only on a SECOND consecutive flat observation
    //       at least RESYNC_CONFIRM_MS later do we actually resync state.
    let siblingActiveCount = 0;
    try {
      const { db } = await import('../utils/database');
      const sibRow: any = await db.get(
        `SELECT COUNT(*) AS cnt FROM strategies s
         JOIN api_keys ak ON ak.id = s.api_key_id
         WHERE ak.name = ?
           AND s.base_symbol = ?
           AND s.id <> ?
           AND s.is_active = 1
           AND IFNULL(s.is_archived, 0) = 0
           AND s.state IN ('long','short')`,
        [apiKeyName, mergedStrategy.base_symbol, strategyId]
      );
      siblingActiveCount = Number(sibRow?.cnt || 0);
    } catch (sibErr) {
      logger.warn(`Sibling-check query failed for resync guard (strategy ${strategyId}): ${(sibErr as Error)?.message || sibErr}`);
    }

    if (siblingActiveCount > 0) {
      // Sibling holds a position — visible "flat" is almost certainly a
      // pre-aggregation race; skip and clear any pending confirmation.
      resyncPendingFlatByStrategy.delete(strategyId);
      logger.warn(
        `Skipping state_resynced_flat for strategy ${strategyId} (${apiKeyName}/${mergedStrategy.base_symbol}): ` +
        `${siblingActiveCount} sibling(s) still in non-flat state — visible 'flat' may be stale snapshot`
      );
    } else {
      if (isPositionAlignmentExcluded) {
        resyncPendingFlatByStrategy.delete(strategyId);
        logger.warn(
          `Skipping state_resynced_flat for strategy ${strategyId} (${apiKeyName}): api key excluded from position alignment`
        );
      } else {
      const nowMs = Date.now();
      const pending = resyncPendingFlatByStrategy.get(strategyId);
      if (!pending) {
        resyncPendingFlatByStrategy.set(strategyId, { firstDetectedMs: nowMs, lastRatio: currentRatio });
        logger.warn(
          `Resync candidate for strategy ${strategyId} (${apiKeyName}/${mergedStrategy.base_symbol}): ` +
          `state=${state} but exchange flat. Will require ${RESYNC_CONFIRM_MS / 1000}s confirmation before resyncing.`
        );
      } else if (nowMs - pending.firstDetectedMs < RESYNC_CONFIRM_MS) {
        // Still inside the confirmation window — keep waiting.
        logger.warn(
          `Resync still pending for strategy ${strategyId}: ` +
          `${Math.round((nowMs - pending.firstDetectedMs) / 1000)}s of ${RESYNC_CONFIRM_MS / 1000}s`
        );
      } else {
        // Confirmed: TWO consecutive flat detections separated by ≥ RESYNC_CONFIRM_MS, no siblings.
        resyncPendingFlatByStrategy.delete(strategyId);
        const previousState = state;
        const previousEntryRatio = entryRatio;

        await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_action: `state_resynced_flat@${currentRatio}`,
          last_error: null,
        });

        state = 'flat';
        entryRatio = null;
        mergedStrategy.state = 'flat';
        mergedStrategy.entry_ratio = null;
        mergedStrategy.tp_anchor_ratio = null;

        if (previousState === 'long' || previousState === 'short') {
          logger.warn(`State resynced to flat for strategy ${strategyId} (${apiKeyName}): was ${previousState}, entry_ratio=${previousEntryRatio}, current_ratio=${currentRatio} (CONFIRMED after ${RESYNC_CONFIRM_MS / 1000}s)`);
          await recordRuntimeTradeEvent('exit', previousState, currentRatio, 0, undefined, mergedStrategy.base_symbol, previousEntryRatio ?? undefined);
        }
      }
      }
    }
  } else {
    // Any non-flat live observation clears a pending resync.
    if (resyncPendingFlatByStrategy.has(strategyId)) {
      resyncPendingFlatByStrategy.delete(strategyId);
    }
  }

  if (dedupeClosedBar) {
    const lastProcessedBarTimeMs = processedClosedBarByStrategy.get(processedBarCacheKey);
    if (lastProcessedBarTimeMs === evaluatedBarTimeMs) {
      return {
        result: `Bar ${evaluatedBarIso} already processed`,
        action: 'bar_already_processed',
        executionSource,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      };
    }
  }

  const strategyType = String(mergedStrategy.strategy_type || '');
  if (!closedAction && (state === 'long' || state === 'short')
    && strategyType !== 'dca'
    && strategyType !== 'dca_futures') {
    try {
      if (await isMacroShieldEnabledForApiKey(apiKeyName)) {
        const overlay = await getMacroExitOverlayForApiKey(apiKeyName);
        if (overlay) {
          const macroSignal = await evaluateMacroShieldExit(
            apiKeyName,
            state,
            String(mergedStrategy.base_symbol || ''),
            overlay,
            strategyId,
          );
          if (macroSignal?.action === 'full') {
            const fullAction: StrategyCloseAction = state === 'long'
              ? 'macro_shield_exit_long'
              : 'macro_shield_exit_short';
            await closeAndRecordExit(fullAction, state);
            closedAction = fullAction;
            closedResult = `Macro shield full exit for ${state} ${positionLabel} (${macroSignal.detail})`;
          } else if (macroSignal?.action === 'partial') {
            try {
              for (const sym of getStrategySymbols(mergedStrategy)) {
                await closePositionPercent(apiKeyName, strategyId, sym, macroSignal.closePercent);
              }
              closedAction = 'macro_shield_partial';
              closedResult = `Macro shield partial ${macroSignal.closePercent}% for ${state} ${positionLabel} (${macroSignal.detail})`;
              logger.info(`Macro shield partial ${macroSignal.closePercent}% for strategy ${strategyId}: ${macroSignal.detail}`);
            } catch (partialErr) {
              logger.warn(`Macro shield partial failed for ${strategyId}: ${formatActionError(partialErr)}`);
            }
          }
        }
      }
    } catch (macroErr) {
      logger.warn(`Macro shield check failed for strategy ${strategyId} (${apiKeyName}): ${formatActionError(macroErr)}`);
    }
  }

  if (isStatArb) {
    const hasZScore = Number.isFinite(zScore);

    if (!closedAction && state === 'long' && hasZScore && Number(zScore) <= -zscoreStop) {
      await closeAndRecordExit('zscore_stop_long', 'long');
      closedAction = 'zscore_stop_long';
      closedResult = `Z-score stop hit for long ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'short' && hasZScore && Number(zScore) >= zscoreStop) {
      await closeAndRecordExit('zscore_stop_short', 'short');
      closedAction = 'zscore_stop_short';
      closedResult = `Z-score stop hit for short ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'long' && hasZScore && Number(zScore) >= -zscoreExit) {
      await closeAndRecordExit('mean_revert_exit_long', 'long');
      closedAction = 'mean_revert_exit_long';
      closedResult = `Mean-reversion exit for long ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'short' && hasZScore && Number(zScore) <= zscoreExit) {
      await closeAndRecordExit('mean_revert_exit_short', 'short');
      closedAction = 'mean_revert_exit_short';
      closedResult = `Mean-reversion exit for short ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }
  }

  if (!closedAction && (mergedStrategy.strategy_type === 'hideep' || isCtFractal)) {
    const rsiVal = isCtFractal ? fastRsi : zScore;
    if (Number.isFinite(rsiVal)) {
      if (state === 'long' && Number(rsiVal) > 90) {
        await closeAndRecordExit('mean_revert_exit_long', 'long');
        closedAction = 'mean_revert_exit_long';
        closedResult = `HiDeep RSI exit for long ${positionLabel} (rsi=${Number(rsiVal).toFixed(1)})`;
      } else if (state === 'short' && Number(rsiVal) < 10) {
        await closeAndRecordExit('mean_revert_exit_short', 'short');
        closedAction = 'mean_revert_exit_short';
        closedResult = `HiDeep RSI exit for short ${positionLabel} (rsi=${Number(rsiVal).toFixed(1)})`;
      }
    }
  }

  if (!closedAction && isMomentumScalp && entryRatio && (state === 'long' || state === 'short')) {
    const msParams = extractMomentumScalpParams(mergedStrategy);
    const { tp, sl } = momentumScalpTpSlPrices(state, entryRatio, msParams);
    if (state === 'long') {
      if (currentRatio <= sl) {
        await closeAndRecordExit('stop_loss_long', 'long');
        closedAction = 'stop_loss_long';
        closedResult = `Momentum scalp SL long ${positionLabel}`;
      } else if (currentRatio >= tp) {
        await closeAndRecordExit('take_profit_long', 'long');
        closedAction = 'take_profit_long';
        closedResult = `Momentum scalp TP long ${positionLabel}`;
      } else if (msParams.exitOnOppositeCross && signal === 'short') {
        await closeAndRecordExit('stop_loss_long', 'long');
        closedAction = 'stop_loss_long';
        closedResult = `Momentum scalp cross-exit long ${positionLabel}`;
      }
    } else if (!closedAction) {
      if (currentRatio >= sl) {
        await closeAndRecordExit('stop_loss_short', 'short');
        closedAction = 'stop_loss_short';
        closedResult = `Momentum scalp SL short ${positionLabel}`;
      } else if (currentRatio <= tp) {
        await closeAndRecordExit('take_profit_short', 'short');
        closedAction = 'take_profit_short';
        closedResult = `Momentum scalp TP short ${positionLabel}`;
      } else if (msParams.exitOnOppositeCross && signal === 'long') {
        await closeAndRecordExit('stop_loss_short', 'short');
        closedAction = 'stop_loss_short';
        closedResult = `Momentum scalp cross-exit short ${positionLabel}`;
      }
    }
  }

  if (!isStatArb && !isMomentumScalp) {
    const evalBar = candleContext.candlesForSignal[candleContext.candlesForSignal.length - 1];

    if (!closedAction && isZzPivot && state === 'long' && evalBar && evalBar.low <= donchianLow) {
      await closeAndRecordExit('stop_loss_long', 'long');
      closedAction = 'stop_loss_long';
      closedResult = `ZZ SAR long exit at level ${donchianLow.toFixed(6)}`;
    }

    if (!closedAction && isZzPivot && state === 'short' && evalBar && evalBar.high >= donchianHigh) {
      await closeAndRecordExit('stop_loss_short', 'short');
      closedAction = 'stop_loss_short';
      closedResult = `ZZ SAR short exit at level ${donchianHigh.toFixed(6)}`;
    }

    if (!closedAction && state === 'long' && takeProfitPercent > 0) {
      const anchorFromStorage = Number(mergedStrategy.tp_anchor_ratio);
      let trailingAnchor = Number.isFinite(anchorFromStorage) && anchorFromStorage > 0
        ? anchorFromStorage
        : (entryRatio && entryRatio > 0 ? entryRatio : currentRatio);

      const nextAnchor = Math.max(trailingAnchor, currentRatio);
      if (!Number.isFinite(anchorFromStorage) || Math.abs(nextAnchor - anchorFromStorage) > TRAILING_RATIO_EPSILON) {
        await persistTpAnchorRatio(nextAnchor);
      }

      trailingAnchor = Number.isFinite(Number(mergedStrategy.tp_anchor_ratio))
        ? Number(mergedStrategy.tp_anchor_ratio)
        : nextAnchor;

      const trailingStop = trailingAnchor * (1 - takeProfitPercent / 100);
      if (Number.isFinite(trailingStop) && currentRatio <= trailingStop) {
        await closeAndRecordExit('take_profit_long', 'long');
        closedAction = 'take_profit_long';
        closedResult = `Take-profit hit for long ${positionLabel}`;

        logger.info(`DD_BattleToads trailing TP long triggered for strategy ${strategyId} (${apiKeyName})`);
      }
    }

    if (!closedAction && state === 'short' && takeProfitPercent > 0) {
      const anchorFromStorage = Number(mergedStrategy.tp_anchor_ratio);
      let trailingAnchor = Number.isFinite(anchorFromStorage) && anchorFromStorage > 0
        ? anchorFromStorage
        : (entryRatio && entryRatio > 0 ? entryRatio : currentRatio);

      const nextAnchor = Math.min(trailingAnchor, currentRatio);
      if (!Number.isFinite(anchorFromStorage) || Math.abs(nextAnchor - anchorFromStorage) > TRAILING_RATIO_EPSILON) {
        await persistTpAnchorRatio(nextAnchor);
      }

      trailingAnchor = Number.isFinite(Number(mergedStrategy.tp_anchor_ratio))
        ? Number(mergedStrategy.tp_anchor_ratio)
        : nextAnchor;

      const trailingStop = trailingAnchor * (1 + takeProfitPercent / 100);
      if (Number.isFinite(trailingStop) && currentRatio >= trailingStop) {
        await closeAndRecordExit('take_profit_short', 'short');
        closedAction = 'take_profit_short';
        closedResult = `Take-profit hit for short ${positionLabel}`;

        logger.info(`DD_BattleToads trailing TP short triggered for strategy ${strategyId} (${apiKeyName})`);
      }
    }

    // Partial TP (50% close) when partial_tp_pct > 0 and not yet triggered
    const partialTpPct = mergedStrategy.partial_tp_pct ?? 0;
    if (!closedAction && partialTpPct > 0 && !partialTpTriggeredByStrategy.get(strategyId)) {
      const partialPnlPct = state === 'long'
        ? ((currentRatio / (entryRatio ?? currentRatio)) - 1) * 100
        : (((entryRatio ?? currentRatio) / currentRatio) - 1) * 100;
      if (Number.isFinite(partialPnlPct) && partialPnlPct >= partialTpPct) {
        try {
          for (const sym of getStrategySymbols(mergedStrategy)) {
            await closePositionPercent(apiKeyName, strategyId, sym, 50);
          }
          partialTpTriggeredByStrategy.set(strategyId, true);
          if (entryRatio && entryRatio > 0) await persistTpAnchorRatio(entryRatio);
          logger.info(`Partial TP (50%) for strategy ${strategyId}: PnL=${partialPnlPct.toFixed(2)}%`);
        } catch (err) {
          logger.warn(`Partial TP failed for ${strategyId}: ${(err as Error)?.message}`);
        }
      }
    }

    if (!closedAction && !isZzPivot && state === 'long' && entryRatio && currentRatio <= donchianCenter) {
      await closeAndRecordExit('stop_loss_long', 'long');
      closedAction = 'stop_loss_long';
      closedResult = `Stop-loss (center) hit for long ${positionLabel}`;

      logger.info(`DD_BattleToads SL long triggered for strategy ${strategyId} (${apiKeyName})`);
    }

    if (!closedAction && !isZzPivot && state === 'short' && entryRatio && currentRatio >= donchianCenter) {
      await closeAndRecordExit('stop_loss_short', 'short');
      closedAction = 'stop_loss_short';
      closedResult = `Stop-loss (center) hit for short ${positionLabel}`;

      logger.info(`DD_BattleToads SL short triggered for strategy ${strategyId} (${apiKeyName})`);
    }
  }

  if (signal === 'none') {
    const noSignalResult = isStatArb ? 'No z-score signal' : (isZzPivot ? 'No ZZ pivot signal' : 'No Donchian signal');
    const noSignalAction = closedAction
      ? `${closedAction}_then_no_signal@${currentRatio}`
      : `no_signal@${currentRatio}`;

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      ...(closedAction
        ? {
            state: 'flat' as const,
            entry_ratio: null,
            tp_anchor_ratio: null,
          }
        : {}),
      last_signal: 'none',
      last_action: noSignalAction,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: closedResult || noSignalResult,
      action: closedAction ? `${closedAction}_no_signal` : 'no_signal',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (isZzPivot && state !== 'flat') {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: signal,
      last_action: closedAction
        ? `${closedAction}_then_hold_${state}@${currentRatio}`
        : `hold_${state}@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: closedResult || `ZZ ${state}: waiting SAR exit`,
      action: `hold_${state}`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state === signal) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: signal,
      last_action: closedAction
        ? `${closedAction}_then_hold_${signal}@${currentRatio}`
        : `hold_${signal}@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: `Signal ${signal} already in position`,
      action: `hold_${signal}`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  const closedSameSide = closedAction !== null && (
    (signal === 'long' && closedAction.endsWith('_long')) ||
    (signal === 'short' && closedAction.endsWith('_short'))
  );

  if (closedSameSide) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_signal: signal,
      last_action: `${closedAction}_cooldown_skip@${currentRatio}`,
      last_error: null,
    });

    logger.info(`Cooldown: skipping same-side re-entry ${signal} after ${closedAction} for strategy ${strategyId} (${apiKeyName})`);

    return returnWithProcessedBar({
      result: closedResult || `Position closed; same-direction re-entry skipped (cooldown after ${closedAction})`,
      action: `${closedAction}_cooldown_skip`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  // ── Cold-start guard: skip entry on first N bars after strategy materialization ──
  // Prevents entering on a stale signal that was already in progress before this
  // account was activated. Wait for a fresh signal generated after materialization.
  // COLD_START_BARS env (default 1): number of closed bars to skip before first entry.
  if (state === 'flat' && !closedAction) {
    const coldStartBars = Math.max(0, Math.floor(Number(process.env.COLD_START_BARS ?? 1) || 1));
    if (coldStartBars > 0 && mergedStrategy.created_at) {
      const createdAtMs = new Date(String(mergedStrategy.created_at).replace(' ', 'T') + 'Z').getTime();
      if (Number.isFinite(createdAtMs) && createdAtMs > 0) {
        const barMs = intervalToMs(mergedStrategy.interval);
        const coldUntilMs = createdAtMs + coldStartBars * barMs;
        if (evaluatedBarTimeMs < coldUntilMs) {
          const remainingMs = coldUntilMs - evaluatedBarTimeMs;
          logger.info(
            `Cold-start: skipping entry signal ${signal} for strategy ${strategyId} (${apiKeyName}) — ` +
            `strategy created ${new Date(createdAtMs).toISOString()}, ` +
            `cold_start_bars=${coldStartBars}, bar_interval=${mergedStrategy.interval}, ` +
            `entry allowed after ${new Date(coldUntilMs).toISOString()} (${Math.ceil(remainingMs / barMs)} bars remaining)`
          );

          const updated = await updateStrategy(apiKeyName, strategyId, {
            ...executionBindingPatch,
            state: 'flat',
            entry_ratio: null,
            tp_anchor_ratio: null,
            last_signal: signal,
            last_action: `cold_start_skip@${currentRatio}`,
            last_error: null,
          });

          return returnWithProcessedBar({
            result: `Cold-start: entry skipped, waiting for first signal after materialization (${Math.ceil(remainingMs / barMs)} bars remaining)`,
            action: 'cold_start_skip',
            strategy: updated,
            currentRatio,
            donchianHigh,
            donchianLow,
            donchianCenter,
          });
        }
      }
    }
  }

  // ── Position Limiter (ОП): check if trading system allows more open positions ──
  {
    const { db } = await import('../utils/database');

    // Acquire cross-TS pair lock FIRST (before any OP checks). This serializes
    // ALL strategies on the same (api_key, pair) regardless of which TS they
    // belong to. Without this, two strategies in different TSs of one api_key
    // would race past their per-TS OP checks and end up pyramiding / thrashing
    // the shared exchange position.
    const myPairKey = getStrategyPairKey(mergedStrategy);
    if (myPairKey) {
      releasePairLock = await acquireApiKeyPairEntryLock(apiKeyName, myPairKey);
    }

    // Cross-TS pair conflict check: if ANY active strategy on the same api_key
    // and same pair (in any TS, including this one) is already in long/short,
    // skip entry. This is the primary defense against the multi-TS-per-api-key
    // churn pattern where each strategy in turn nukes the shared position via
    // closeAllForSymbol on its exit.
    if (myPairKey) {
      const apiKeyIdRow: any = await db.get(`SELECT id FROM api_keys WHERE name = ?`, [apiKeyName]);
      const apiKeyId = apiKeyIdRow?.id;
      if (apiKeyId) {
        const crossOpenRows: Array<{ id: number; name: string; base_symbol: string; quote_symbol: string; market_mode: string; state: string }> = await db.all(
          `SELECT s.id, COALESCE(s.name, '') AS name, s.base_symbol, s.quote_symbol, s.market_mode, s.state
           FROM strategies s
           WHERE s.api_key_id = ? AND s.is_active = 1 AND s.state != 'flat' AND s.id != ?`,
          [apiKeyId, strategyId]
        );
        const crossConflicting = crossOpenRows.find((row) => getStrategyPairKey(row as any) === myPairKey);
        if (crossConflicting) {
          logger.info(
            `ОП cross-TS pair lock: strategy ${strategyId} waits for pair ${myPairKey} on api_key=${apiKeyName}; `
            + `held by strategy ${crossConflicting.id} (${crossConflicting.name}, state=${crossConflicting.state})`
          );

          const updated = await updateStrategy(apiKeyName, strategyId, {
            ...executionBindingPatch,
            state: 'flat',
            entry_ratio: null,
            tp_anchor_ratio: null,
            last_signal: signal,
            last_action: closedAction
              ? `${closedAction}_op_xpair_lock@${currentRatio}`
              : `op_xpair_lock@${currentRatio}`,
            last_error: null,
          });

          return returnWithProcessedBar({
            result: `Cross-TS pair lock active for ${myPairKey} on api_key=${apiKeyName}, entry deferred`,
            action: closedAction ? `${closedAction}_op_xpair_lock` : 'op_xpair_lock',
            strategy: updated,
            currentRatio,
            donchianHigh,
            donchianLow,
            donchianCenter,
          });
        }
      }
    }

    const systemRow: any = await db.get(
      `SELECT ts.id AS system_id, ts.max_open_positions
       FROM trading_systems ts
       JOIN trading_system_members tsm ON tsm.system_id = ts.id
       WHERE tsm.strategy_id = ? AND tsm.is_enabled = 1
       AND ts.max_open_positions > 0
       LIMIT 1`,
      [strategyId]
    );

    if (systemRow && systemRow.max_open_positions > 0) {
      // Acquire per-system entry lock so OP-count check + placeOrder + state
      // UPDATE for THIS strategy run serially against any other strategy in the
      // same TS. Without this, parallel auto-cycle execution can briefly exceed
      // max_open_positions (overflow guard fixes it next cycle, but we lose
      // capital to fees on the closure).
      releaseSystemLock = await acquireSystemEntryLock(Number(systemRow.system_id));

      const maxOpen = systemRow.max_open_positions;
      const openCount: any = await db.get(
        `SELECT COUNT(*) AS cnt FROM strategies s
         JOIN trading_system_members tsm ON tsm.strategy_id = s.id
         WHERE tsm.system_id = ? AND tsm.is_enabled = 1
         AND s.is_active = 1 AND s.state != 'flat'
         AND COALESCE(s.strategy_type, '') NOT IN ('dca', 'dca_futures')`,
        [systemRow.system_id]
      );

      const currentOpen = openCount?.cnt || 0;
      let exchangeOpen = 0;
      try {
        const { ensureExchangeClientInitialized: ensureExchange } = await import('./exchange');
        await ensureExchange(apiKeyName);
        const exchangePositions = await getPositions(apiKeyName).catch(() => []);
        exchangeOpen = countExchangeOpenPositions(exchangePositions);
      } catch (exchangeCountErr) {
        logger.warn(`ОП exchange count failed for ${apiKeyName}: ${formatActionError(exchangeCountErr)}`);
      }

      if (exchangeOpen > maxOpen) {
        logger.info(
          `ОП exchange limit: ${exchangeOpen}/${maxOpen} live positions on ${apiKeyName}, `
          + `skipping entry for strategy ${strategyId} (db=${currentOpen})`,
        );
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_exchange_op_skip@${currentRatio}`
            : `exchange_op_skip@${currentRatio}`,
          last_error: null,
        });
        return returnWithProcessedBar({
          result: `ОП exchange limit reached (${exchangeOpen}/${maxOpen}), entry skipped`,
          action: closedAction ? `${closedAction}_exchange_op_skip` : 'exchange_op_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }

      if (currentOpen >= maxOpen) {
        logger.info(`ОП limit: ${currentOpen}/${maxOpen} positions open in system ${systemRow.system_id}, skipping entry for strategy ${strategyId}`);

        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_op_limit_skip@${currentRatio}`
            : `op_limit_skip@${currentRatio}`,
          last_error: null,
        });

        return returnWithProcessedBar({
          result: `ОП limit reached (${currentOpen}/${maxOpen}), entry skipped`,
          action: closedAction ? `${closedAction}_op_limit_skip` : 'op_limit_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }

      // Pair-level lifecycle guard (intra-TS, kept for completeness; cross-TS
      // case is already handled above):
      // strategies with identical pair key take turns (one open position per pair at a time),
      // while different pairs compete only via max_open_positions.
      if (myPairKey && currentOpen > 0) {
        const openRows: Array<{ market_mode: string; base_symbol: string; quote_symbol: string; id: number; name: string }> = await db.all(
          `SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.market_mode
           FROM strategies s
           JOIN trading_system_members tsm ON tsm.strategy_id = s.id
           WHERE tsm.system_id = ? AND tsm.is_enabled = 1
             AND s.is_active = 1 AND s.state != 'flat' AND s.id != ?`,
          [systemRow.system_id, strategyId]
        );

        const conflicting = openRows.find((row) => getStrategyPairKey(row as any) === myPairKey);
        if (conflicting) {
          logger.info(`ОП pair lock: strategy ${strategyId} waits for pair ${myPairKey}; open by strategy ${conflicting.id} (${conflicting.name}) in system ${systemRow.system_id}`);

          const updated = await updateStrategy(apiKeyName, strategyId, {
            ...executionBindingPatch,
            state: 'flat',
            entry_ratio: null,
            tp_anchor_ratio: null,
            last_signal: signal,
            last_action: closedAction
              ? `${closedAction}_op_pair_lock@${currentRatio}`
              : `op_pair_lock@${currentRatio}`,
            last_error: null,
          });

          return returnWithProcessedBar({
            result: `ОП pair lock active for ${myPairKey}, entry deferred`,
            action: closedAction ? `${closedAction}_op_pair_lock` : 'op_pair_lock',
            strategy: updated,
            currentRatio,
            donchianHigh,
            donchianLow,
            donchianCenter,
          });
        }
      }
    }
  }

  const balances = await getBalances(apiKeyName);
  const availableBalance = extractUsdtBalance(balances);

  if (availableBalance <= 0) {
    if (closedAction) {
      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: `${closedAction}_open_skipped_no_balance@${currentRatio}`,
        last_error: null,
      });

      return returnWithProcessedBar({
        result: closedResult || 'Position closed; reopen skipped because balance is unavailable',
        action: `${closedAction}_open_skipped_no_balance`,
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    throw new Error('No available balance for strategy execution');
  }

  let riskMultiplier = 1.0;
  try {
    const { db } = await import('../utils/database');
    const profile = await db.get(
      `SELECT ap.risk_multiplier FROM algofund_profiles ap
       JOIN api_keys ak ON ak.name = COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name)
       WHERE ak.name = ? LIMIT 1`,
      [apiKeyName]
    );
    if (profile?.risk_multiplier) {
      const val = Number(profile.risk_multiplier);
      if (Number.isFinite(val) && val > 0) riskMultiplier = val;
    }
  } catch { /* non-critical: fallback to 1.0 */ }

  let portfolioCbMult = 1.0;
  try {
    const { resolvePortfolioCircuitBreakerLotMultiplier } = await import('./portfolioCircuitBreakerRuntime');
    portfolioCbMult = await resolvePortfolioCircuitBreakerLotMultiplier(apiKeyName, availableBalance);
  } catch { /* non-critical */ }

  const channelLotMult = Number((mergedStrategy as any).auto_lot_by_channel_width || 0) === 1
    ? computeChannelWidthLotMultiplier(donchianHigh, donchianLow, donchianCenter, mergedStrategy as any)
    : 1;
  const totalNotional = computeSignalTotalNotional(
    mergedStrategy,
    availableBalance,
    signal,
    riskMultiplier * portfolioCbMult,
  ) * channelLotMult;

  if (!Number.isFinite(totalNotional) || totalNotional <= 0) {
    if (closedAction) {
      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: `${closedAction}_open_skipped_invalid_notional@${currentRatio}`,
        last_error: null,
      });

      return returnWithProcessedBar({
        result: closedResult || 'Position closed; reopen skipped because notional is invalid',
        action: `${closedAction}_open_skipped_invalid_notional`,
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    throw new Error('Calculated trade notional is invalid');
  }

  if (isStatArb && !isCtFractal && (signal === 'long' || signal === 'short')) {
    const entryGate = await getStatArbEntryGateForApiKey(apiKeyName);
    if (entryGate) {
      const gateOk = await passesStatArbEntryGateLive(
        apiKeyName,
        String(mergedStrategy.base_symbol || ''),
        signal,
        entryGate,
      );
      if (!gateOk) {
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          ...(closedAction
            ? { state: 'flat' as const, entry_ratio: null, tp_anchor_ratio: null }
            : {}),
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_stat_arb_entry_gate_skip@${currentRatio}`
            : `stat_arb_entry_gate_skip@${currentRatio}`,
          last_error: null,
        });
        logger.info(
          `Stat-arb entry gate blocked ${signal} for strategy ${strategyId} (${apiKeyName}) `
          + `[${entryGate.label || 'fractal_gate'}]`,
        );
        return returnWithProcessedBar({
          result: closedResult || `Stat-arb entry gate: ${signal} blocked (fractal/RSI confirmation missing)`,
          action: closedAction ? `${closedAction}_stat_arb_entry_gate_skip` : 'stat_arb_entry_gate_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }
    }
  }

  if (signal === 'long' || signal === 'short') {
    const obGate = await getOrderBlockEntryGateForApiKey(apiKeyName);
    if (obGate) {
      const obOk = await passesOrderBlockEntryGateLive(
        apiKeyName,
        signal,
        String(mergedStrategy.base_symbol || ''),
        obGate,
      );
      if (!obOk) {
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          ...(closedAction
            ? { state: 'flat' as const, entry_ratio: null, tp_anchor_ratio: null }
            : {}),
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_order_block_gate_skip@${currentRatio}`
            : `order_block_gate_skip@${currentRatio}`,
          last_error: null,
        });
        logger.info(
          `Order-block gate blocked ${signal} for strategy ${strategyId} (${apiKeyName}) `
          + `[${obGate.label || 'btc_liq_ob'}]`,
        );
        return returnWithProcessedBar({
          result: closedResult || `Order-block gate: ${signal} blocked at BTC liquidity zone`,
          action: closedAction ? `${closedAction}_order_block_gate_skip` : 'order_block_gate_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }
    }
  }

  const basePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.base_symbol);
  let quotePrice: number | null = null;
  let qtyPlan: BalancedQtyPlan | null = null;
  let singleQtyPlan: SingleQtyPlan | null = null;
  let baseQty = '';
  let quoteQty: string | null = null;

  if (isMono) {
    singleQtyPlan = await buildSingleQtyPlan(
      apiKeyName,
      mergedStrategy.base_symbol,
      basePrice,
      totalNotional
    );
    baseQty = singleQtyPlan.qty;
    const monoRules = await loadQtyRules(apiKeyName, mergedStrategy.base_symbol);
    const cappedMono = clampQtyString(baseQty, monoRules);
    if (cappedMono !== baseQty) {
      logger.warn(
        `[qty-cap] mono ${mergedStrategy.base_symbol} capped ${baseQty} → ${cappedMono} `
        + `(max=${effectiveMaxQty(monoRules)})`
      );
      baseQty = cappedMono;
    }
  } else {
    quotePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.quote_symbol);

    const baseWeight = Math.abs(mergedStrategy.base_coef);
    const quoteWeight = Math.abs(mergedStrategy.quote_coef);

    qtyPlan = await buildBalancedQtyPlan(
      apiKeyName,
      mergedStrategy.base_symbol,
      mergedStrategy.quote_symbol,
      basePrice,
      quotePrice,
      totalNotional,
      baseWeight,
      quoteWeight
    );

    baseQty = qtyPlan.baseQty;
    quoteQty = qtyPlan.quoteQty;

    const [baseRulesCap, quoteRulesCap] = await Promise.all([
      loadQtyRules(apiKeyName, mergedStrategy.base_symbol),
      loadQtyRules(apiKeyName, mergedStrategy.quote_symbol!),
    ]);
    const cappedPair = capBalancedLegQty(baseQty, quoteQty, baseRulesCap, quoteRulesCap);
    if (cappedPair.scaled || cappedPair.baseQty !== baseQty || cappedPair.quoteQty !== quoteQty) {
      logger.warn(
        `[qty-cap] synth ${mergedStrategy.base_symbol}/${mergedStrategy.quote_symbol} `
        + `base ${baseQty}→${cappedPair.baseQty} quote ${quoteQty}→${cappedPair.quoteQty} `
        + `(scaled=${cappedPair.scaled})`
      );
      baseQty = cappedPair.baseQty;
      quoteQty = cappedPair.quoteQty;
    }
  }

  const latestBeforeOpen = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  if (!latestBeforeOpen.is_active) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      ...(closedAction
        ? {
            state: 'flat' as const,
            entry_ratio: null,
            tp_anchor_ratio: null,
          }
        : {}),
      last_signal: signal,
      last_action: closedAction
        ? `paused_after_${closedAction}@${currentRatio}`
        : `paused_before_open@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: closedResult || 'Strategy paused before opening a new position',
      action: closedAction ? `paused_after_${closedAction}` : 'paused_before_open',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  try {
    for (const symbol of getStrategySymbols(mergedStrategy)) {
      await applySymbolRiskSettings(apiKeyName, symbol, mergedStrategy.margin_type, mergedStrategy.leverage);
    }
  } catch (error) {
    logger.warn(`Could not apply risk settings for strategy ${strategyId}: ${formatActionError(error)}`);
  }

  // ── Pre-entry exchange idempotency ──────────────────────────────────────
  // When several strategies share an api_key + base_symbol (very common in our
  // SAAS topology with one cloud key serving 11+ trading systems), the exchange
  // position is a SHARED resource. Naively placing a new order here would either
  // pyramid the position (if same side) or flip it (if opposite side, after the
  // legacy closeStrategyExposure call below), thrashing every other strategy
  // that thinks it owns the position. The cross-TS pair lock already prevents
  // concurrent entries; this defensive check handles late-arriving signals and
  // crash-recovery cases where DB state lags behind the exchange.
  const baseSide: 'Buy' | 'Sell' = signal === 'long' ? 'Buy' : 'Sell';
  const quoteSide: 'Buy' | 'Sell' | null = isMono ? null : (signal === 'long' ? 'Sell' : 'Buy');

  try {
    const liveBeforeEntry = await getPositions(apiKeyName, mergedStrategy.base_symbol);
    const livePos = (liveBeforeEntry || []).find((p: any) =>
      String(p?.symbol || '').toUpperCase() === String(mergedStrategy.base_symbol).toUpperCase()
      && Number.parseFloat(String(p?.size || '0')) > 0
    );
    if (livePos) {
      const liveSideRaw = String(livePos?.side || '').toLowerCase();
      const liveSide: 'Buy' | 'Sell' | null = liveSideRaw === 'buy' ? 'Buy' : (liveSideRaw === 'sell' ? 'Sell' : null);
      if (liveSide === baseSide) {
        // Already long/short on the exchange in the desired direction — adopt
        // it as our position without placing a new order.
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: signal,
          entry_ratio: currentRatio,
          tp_anchor_ratio: currentRatio,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_entry_idem_adopt@${currentRatio}`
            : `entry_idem_adopt@${currentRatio}`,
          last_error: null,
        });
        const livePosFillRaw = (livePos as any)?.avgPrice ?? (livePos as any)?.entryPrice ?? (livePos as any)?.openPrice;
        const livePosFill = Number(livePosFillRaw);
        const adoptActualPrice = Number.isFinite(livePosFill) && livePosFill > 0 ? livePosFill : undefined;
        await recordRuntimeTradeEvent('entry', signal, currentRatio, 0, undefined, mergedStrategy.base_symbol, undefined, adoptActualPrice);
        // Trigger DCA-Futures overlay on adopted entry
        if ((signal === 'long' || signal === 'short') && mergedStrategy.base_symbol) {
          try {
            const { triggerDcaFutures } = await import('./dca-futures');
            await triggerDcaFutures(apiKeyName, mergedStrategy.base_symbol, signal as 'long' | 'short');
          } catch (dcaErr) {
            logger.warn(`[dca-futures] trigger failed after adopt-entry for ${apiKeyName} ${mergedStrategy.base_symbol}: ${(dcaErr as Error).message}`);
          }
        }
        logger.info(
          `Pre-entry idempotency: strategy ${strategyId} (${apiKeyName}) adopted existing ${baseSide} `
          + `position on ${mergedStrategy.base_symbol} (size=${livePos.size}); no new order placed`
        );
        return returnWithProcessedBar({
          result: 'Adopted existing exchange position (cohabitation idempotency)',
          action: 'entry_idem_adopt',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      } else if (liveSide && liveSide !== baseSide) {
        // Opposite-side position is on the exchange — most likely owned by a
        // sibling strategy on the same api_key. Do NOT close it (that would
        // nuke the sibling). Skip this entry and wait for the sibling to exit.
        logger.warn(
          `Pre-entry idempotency: strategy ${strategyId} (${apiKeyName}) sees opposite-side `
          + `${liveSide} position on ${mergedStrategy.base_symbol} (size=${livePos.size}); deferring entry`
        );
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_entry_idem_opposite_skip@${currentRatio}`
            : `entry_idem_opposite_skip@${currentRatio}`,
          last_error: null,
        });
        return returnWithProcessedBar({
          result: 'Opposite-side live position present; entry deferred to avoid sibling clobber',
          action: 'entry_idem_opposite_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }
    }
  } catch (idemErr) {
    logger.warn(`Pre-entry idempotency check failed for strategy ${strategyId}: ${formatActionError(idemErr)} — proceeding with order`);
  }

  // NOTE: legacy closeStrategyExposure() removed from here. With cross-TS pair
  // lock + pre-entry idempotency, calling closeAllForSymbol on a SHARED symbol
  // would nuke positions held by sibling strategies on the same api_key. Any
  // legitimate "must close before reverse-entry" scenario is already handled
  // upstream by closeAndRecordExit (which sets state=flat and triggers cooldown
  // skip on same-side, or proceeds with reverse only after exchange close).

  const baseOrder = await placeOrder(
    apiKeyName,
    mergedStrategy.base_symbol,
    baseSide,
    baseQty,
    undefined,
    mergedStrategy.market_type === 'spot' ? { marketType: 'spot' } : undefined,
  );

  if (!isMono && quoteSide && quoteQty) {
    try {
      await placeOrder(
        apiKeyName,
        mergedStrategy.quote_symbol!,
        quoteSide,
        quoteQty,
        undefined,
        mergedStrategy.market_type === 'spot' ? { marketType: 'spot' } : undefined,
      );
    } catch (error) {
      try {
        await closePosition(apiKeyName, mergedStrategy.base_symbol, baseQty, baseSide);
      } catch (rollbackError) {
        logger.error(`Rollback failed for ${mergedStrategy.base_symbol}: ${formatActionError(rollbackError)}`);
      }
      throw error;
    }

    const livePairAfterOpen = await loadPairPositionsForValidation(
      apiKeyName,
      mergedStrategy.base_symbol,
      mergedStrategy.quote_symbol,
      3,
      350
    );

    if (!livePairAfterOpen.basePosition || !livePairAfterOpen.quotePosition || !qtyPlan) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_missing_leg',
        last_error: 'Opened pair validation failed: one or both legs are missing after entry',
      });

      logger.warn(
        `Post-open validation failed (missing leg): strategy=${strategyId}, apiKey=${apiKeyName}, `
        + `base=${mergedStrategy.base_symbol}, quote=${mergedStrategy.quote_symbol}`
      );

      return returnWithProcessedBar({
        result: 'Pair opened with missing leg and was closed',
        action: 'desync_closed_post_open_missing_leg',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const liveBalanceCheck = validateLiveLegBalance(
      livePairAfterOpen.basePosition,
      livePairAfterOpen.quotePosition,
      Math.abs(mergedStrategy.base_coef),
      Math.abs(mergedStrategy.quote_coef),
      MAX_POST_OPEN_SHARE_ERROR
    );

    if (!liveBalanceCheck.ok) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const liveSnapshot = liveBalanceCheck.snapshot;
      const mismatchReason =
        `Opened pair weight mismatch: base=${liveSnapshot.baseNotional.toFixed(4)} `
        + `quote=${liveSnapshot.quoteNotional.toFixed(4)} `
        + `expectedShare=${(liveSnapshot.expectedBaseShare * 100).toFixed(2)}% `
        + `actualShare=${(liveSnapshot.actualBaseShare * 100).toFixed(2)}% `
        + `shareError=${(liveSnapshot.shareError * 100).toFixed(2)}%`;

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_weight_mismatch',
        last_error: mismatchReason,
      });

      logger.warn(
        `Post-open validation failed (weight mismatch): strategy=${strategyId}, apiKey=${apiKeyName}, ${mismatchReason}`
      );

      return returnWithProcessedBar({
        result: 'Pair opened with weight mismatch and was closed',
        action: 'desync_closed_post_open_weight_mismatch',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }
  } else {
    const livePositionAfterOpen = await loadSinglePositionForValidation(
      apiKeyName,
      mergedStrategy.base_symbol,
      3,
      350
    );

    if (!livePositionAfterOpen) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_missing_leg',
        last_error: 'Opened mono validation failed: live position is missing after entry',
      });

      logger.warn(
        `Post-open validation failed (mono missing position): strategy=${strategyId}, apiKey=${apiKeyName}, `
        + `base=${mergedStrategy.base_symbol}`
      );

      return returnWithProcessedBar({
        result: 'Position opened but was not confirmed and was closed',
        action: 'desync_closed_post_open_missing_leg',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }
  }

  const updated = await updateStrategy(apiKeyName, strategyId, {
    ...executionBindingPatch,
    state: signal,
    entry_ratio: currentRatio,
    tp_anchor_ratio: currentRatio,
    last_signal: signal,
    last_action: closedAction
      ? `reopened_${signal}_after_${closedAction}@${currentRatio}`
      : `opened_${signal}@${currentRatio}`,
    last_error: null,
  });

  const openedPositionSize = Number.isFinite(currentRatio) && currentRatio > 0
    ? totalNotional / currentRatio
    : 0;
  const baseOrderId = String((baseOrder as any)?.orderId || (baseOrder as any)?.order_id || '').trim() || undefined;
  // Real fill price from exchange — ccxt: order.average / order.price; native Bybit: avgPrice.
  const baseOrderFillPriceRaw = (baseOrder as any)?.average
    ?? (baseOrder as any)?.avgPrice
    ?? (baseOrder as any)?.avg_price
    ?? (baseOrder as any)?.price;
  const baseOrderFillPrice = Number(baseOrderFillPriceRaw);
  const actualEntryPrice = Number.isFinite(baseOrderFillPrice) && baseOrderFillPrice > 0
    ? baseOrderFillPrice
    : undefined;
  await recordRuntimeTradeEvent('entry', signal, currentRatio, openedPositionSize, baseOrderId, mergedStrategy.base_symbol, undefined, actualEntryPrice);

  // Trigger DCA-Futures overlay on same symbol if any idle dca_futures strategy exists
  if ((signal === 'long' || signal === 'short') && mergedStrategy.base_symbol) {
    try {
      const { triggerDcaFutures } = await import('./dca-futures');
      await triggerDcaFutures(apiKeyName, mergedStrategy.base_symbol, signal as 'long' | 'short');
    } catch (dcaErr) {
      logger.warn(`[dca-futures] trigger failed after entry for ${apiKeyName} ${mergedStrategy.base_symbol}: ${(dcaErr as Error).message}`);
    }
  }

  if (singleQtyPlan) {
    logger.info(
      `Strategy ${strategyId} mono sizing: target=${singleQtyPlan.targetNotional.toFixed(2)} USDT, `
      + `actual=${singleQtyPlan.notional.toFixed(2)}, totalDeviation=${(singleQtyPlan.totalDeviation * 100).toFixed(2)}%`
    );

    // Emit low-lot warning event if mono sizing degraded to minQty
    if (singleQtyPlan.hasWarning) {
      const alertMessage = `Low-lot warning (mono): ${singleQtyPlan.warningReason || 'lot below min threshold'}`;
      logger.warn(
        `Strategy ${strategyId} (${apiKeyName}) mono executed with low-lot degradation: ${singleQtyPlan.warningReason}`
      );
      try {
        const { db } = await import('../utils/database');
        const strategyNameStr = mergedStrategy.name || mergedStrategy.base_symbol;
        await db.run(
          `INSERT INTO strategy_runtime_events
           (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
           VALUES (?, ?, ?, 'low_lot_warning', ?, ?, 0, ?)`,
          [
            apiKeyName,
            strategyId,
            strategyNameStr,
            alertMessage,
            JSON.stringify({
              totalDeviation: (singleQtyPlan.totalDeviation * 100).toFixed(2),
              oversize: (singleQtyPlan.oversize * 100).toFixed(2),
              targetNotional: singleQtyPlan.targetNotional.toFixed(2),
              actualNotional: singleQtyPlan.notional.toFixed(2),
              timestamp: new Date().toISOString(),
            }),
            Date.now(),
          ]
        );
      } catch (eventErr) {
        logger.warn(`Failed to record mono low-lot warning event: ${(eventErr as Error).message}`);
      }
    }
  }

  if (qtyPlan) {
    logger.info(
      `Strategy ${strategyId} leg balancing: target=${totalNotional.toFixed(2)} USDT, `
      + `base ${qtyPlan.baseTargetNotional.toFixed(2)} -> ${qtyPlan.baseNotional.toFixed(2)}, `
      + `quote ${qtyPlan.quoteTargetNotional.toFixed(2)} -> ${qtyPlan.quoteNotional.toFixed(2)}, `
      + `shareError=${(qtyPlan.shareError * 100).toFixed(2)}%, totalDeviation=${(qtyPlan.totalDeviation * 100).toFixed(2)}%`
    );

    // Emit low-lot warning event if qty plan degraded gracefully
    if (qtyPlan.hasWarning) {
      const alertMessage = `Low-lot warning during execution: ${qtyPlan.warningReason || 'unknown'}.`;
      logger.warn(
        `Strategy ${strategyId} (${apiKeyName}) executed with low-lot degradation: ${qtyPlan.warningReason}`
      );
      try {
        const { db } = await import('../utils/database');
        const strategyNameStr = mergedStrategy.name || `${mergedStrategy.base_symbol}/${mergedStrategy.quote_symbol}`;
        await db.run(
          `INSERT INTO strategy_runtime_events
           (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
           VALUES (?, ?, ?, 'low_lot_warning', ?, ?, 0, ?)`,
          [
            apiKeyName,
            strategyId,
            strategyNameStr,
            alertMessage,
            JSON.stringify({
              shareError: (qtyPlan.shareError * 100).toFixed(2),
              baseLegDeviation: qtyPlan.baseLegDeviation ? (qtyPlan.baseLegDeviation * 100).toFixed(2) : null,
              quoteLegDeviation: qtyPlan.quoteLegDeviation ? (qtyPlan.quoteLegDeviation * 100).toFixed(2) : null,
              totalDeviation: (qtyPlan.totalDeviation * 100).toFixed(2),
              oversize: (qtyPlan.oversize * 100).toFixed(2),
              notional: qtyPlan.totalNotional.toFixed(2),
              timestamp: new Date().toISOString(),
            }),
            Date.now(),
          ]
        );
      } catch (eventErr) {
        logger.warn(`Failed to record low-lot warning event: ${(eventErr as Error).message}`);
      }
    }
  }

  logger.info(`Executed ${mergedStrategy.strategy_type} strategy ${strategyId} for ${apiKeyName}: ${signal} (${marketMode})`);
  return returnWithProcessedBar({
    result: 'Strategy executed',
    action: closedAction ? `reopened_${signal}_after_${closedAction}` : `opened_${signal}`,
    signal,
    baseOrder,
    baseQty,
    quoteQty,
    currentRatio,
    donchianHigh,
    donchianLow,
    donchianCenter,
    strategy: updated,
  });
  } finally {
    if (releaseSystemLock) {
      try { releaseSystemLock(); } catch { /* noop */ }
      releaseSystemLock = null;
    }
    if (releasePairLock) {
      try { releasePairLock(); } catch { /* noop */ }
      releasePairLock = null;
    }
  }
};

export const pauseStrategy = async (apiKeyName: string, strategyId: number) => {
  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    last_action: 'paused',
  });
  logger.info(`Paused strategy ${strategyId}`);
  return updated;
};

export const stopStrategy = async (apiKeyName: string, strategyId: number) => {
  const row = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  await closeStrategyExposure(apiKeyName, row);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    state: 'flat',
    entry_ratio: null,
    tp_anchor_ratio: null,
    last_action: 'stopped',
    last_error: null,
  });

  logger.info(`Stopped strategy ${strategyId}`);
  return updated;
};

export const closePositionPercent = async (
  apiKeyName: string,
  strategyId: number,
  symbol: string,
  percent: number,
  side?: 'Buy' | 'Sell'
) => {
  const positions = await getPositions(apiKeyName, symbol);
  const target = positions.find((position: any) => {
    const sameSymbol = String(position?.symbol || '').toUpperCase() === symbol.toUpperCase();
    const hasSize = Number.parseFloat(String(position?.size || '0')) > 0;
    const sideMatches = side ? String(position?.side || '') === side : true;
    return sameSymbol && hasSize && sideMatches;
  });

  if (!target) {
    throw new Error(`Position not found for ${symbol}`);
  }

  const safePercent = Math.max(0.1, Math.min(100, Number.isFinite(percent) ? percent : 100));
  const qtyToClose = (Number.parseFloat(String(target.size || '0')) * safePercent) / 100;
  const qty = qtyToClose.toFixed(8).replace(/\.?0+$/, '');

  await closePosition(apiKeyName, symbol, qty, target.side as 'Buy' | 'Sell');
  logger.info(`Closed ${safePercent}% of position for ${symbol} (strategy ${strategyId})`);
};

export const placeManualOrder = async (
  apiKeyName: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  price?: string
) => {
  return await placeOrder(apiKeyName, symbol, side, qty, price);
};

export const cancelStrategyOrders = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await cancelStrategyWorkingOrders(apiKeyName, strategy);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    last_action: 'orders_cancelled',
    last_error: null,
  });

  logger.info(`Cancelled orders for strategy ${strategyId}`);
  return updated;
};

export const closeStrategyPositions = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await closeStrategyExposure(apiKeyName, strategy);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    state: 'flat',
    entry_ratio: null,
    tp_anchor_ratio: null,
    last_action: 'positions_closed',
    last_error: null,
  });

  logger.info(`Closed strategy exposure for strategy ${strategyId}`);
  return updated;
};

export const setAllStrategiesActive = async (apiKeyName: string, isActive: boolean) => {
  const { db } = await import('../utils/database');
  const apiKeyId = await getApiKeyId(apiKeyName);
  const result: any = await db.run(
    `UPDATE strategies
     SET is_active = ?,
         last_action = ?,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE api_key_id = ?`,
    [isActive ? 1 : 0, isActive ? 'resumed_all' : 'paused_all', apiKeyId]
  );

  const updated = Number(result?.changes || 0);

  return {
    updated,
  };
};


export const runAutoStrategiesCycle = async () => {
  const { db } = await import('../utils/database');
  const { ensureExchangeClientInitialized } = await import('./exchange');

  // Reset the shared signal cache at the start of each cycle so strategies
  // always compute a fresh signal from this cycle's candle snapshot.
  resetCycleSignalCache();

  // ── Overflow guard: close excess positions if more than ОП ──
  try {
    const systems: any[] = (await db.all(
      `SELECT ts.id, ts.max_open_positions, ak.name AS api_key_name
       FROM trading_systems ts
       JOIN api_keys ak ON ak.id = ts.api_key_id
       WHERE ts.max_open_positions > 0 AND ts.is_active = 1`
    )) || [];

    for (const sys of systems) {
      const maxOpen = Number(sys.max_open_positions || 0);
      const apiKeyName = String(sys.api_key_name || '').trim();
      if (!apiKeyName || maxOpen <= 0) {
        continue;
      }

      const openStrategies: any[] = (await db.all(
        `SELECT s.id AS strategy_id, s.base_symbol, a.name AS api_key_name, s.updated_at
         FROM strategies s
         JOIN trading_system_members tsm ON tsm.strategy_id = s.id
         JOIN api_keys a ON a.id = s.api_key_id
         WHERE tsm.system_id = ? AND tsm.is_enabled = 1
         AND s.is_active = 1 AND s.state != 'flat'
         AND COALESCE(s.strategy_type, '') NOT IN ('dca', 'dca_futures')
         ORDER BY s.updated_at ASC`,
        [sys.id]
      )) || [];

      if (openStrategies.length > maxOpen) {
        const excess = openStrategies.slice(maxOpen); // newest entries (oldest stay)
        logger.warn(`ОП overflow in system ${sys.id}: ${openStrategies.length}/${maxOpen}, closing ${excess.length} excess`);
        for (const ex of excess) {
          try {
            await ensureExchangeClientInitialized(ex.api_key_name);
            await closeStrategyPositions(ex.api_key_name, ex.strategy_id);
            logger.info(`ОП overflow: closed strategy ${ex.strategy_id} in system ${sys.id}`);
          } catch (closeErr) {
            logger.error(`ОП overflow: failed to close strategy ${ex.strategy_id}: ${formatActionError(closeErr)}`);
          }
        }
      }

      const ownedSymbols = new Set(
        openStrategies
          .map((row) => normalizeExchangeSymbolKey(String(row.base_symbol || '')))
          .filter(Boolean),
      );

      try {
        await ensureExchangeClientInitialized(apiKeyName);
        const exchangePositions = await getPositions(apiKeyName).catch(() => []);
        const exchangeOpen = countExchangeOpenPositions(exchangePositions);
        if (exchangeOpen > maxOpen) {
          logger.warn(
            `ОП exchange overflow on ${apiKeyName} system ${sys.id}: `
            + `exchange=${exchangeOpen} db=${openStrategies.length} limit=${maxOpen}`,
          );
        }
        for (const row of exchangePositions || []) {
          const size = Math.abs(Number(row?.size || 0));
          if (!Number.isFinite(size) || size <= 0) {
            continue;
          }
          const symbol = String(row?.symbol || '').trim();
          const symbolKey = normalizeExchangeSymbolKey(symbol);
          if (!symbolKey || ownedSymbols.has(symbolKey)) {
            continue;
          }
          logger.warn(
            `ОП orphan exchange position on ${apiKeyName}: ${symbol} (no non-flat TS owner in system ${sys.id}) — closing`,
          );
          await closeAllForSymbol(apiKeyName, symbol, { marketType: 'swap' });
        }
      } catch (orphanErr) {
        logger.warn(`ОП orphan cleanup failed for system ${sys.id}: ${formatActionError(orphanErr)}`);
      }
    }
  } catch (overflowErr) {
    logger.warn(`ОП overflow check failed: ${formatActionError(overflowErr)}`);
  }

  // ── Hygiene guard: non-active/archived strategies must never remain non-flat ──
  // This cleans up historical state drift where DB strategy state was left long/short
  // after archival/deactivation. Runtime uses this to avoid repeated mismatch loops.
  try {
    const fixRes: any = await db.run(
      `UPDATE strategies
       SET state = 'flat',
           updated_at = CURRENT_TIMESTAMP
       WHERE state != 'flat'
         AND (is_active = 0 OR COALESCE(is_archived, 0) = 1)`
    );
    const fixed = Number(fixRes?.changes || 0);
    if (fixed > 0) {
      logger.warn(`Auto-cycle hygiene: reset ${fixed} orphan strategy states to flat`);
    }
  } catch (e) {
    logger.warn(`Auto-cycle hygiene failed: ${(e as Error).message}`);
  }

  const rows = await db.all(
    `SELECT a.name AS api_key_name, s.id AS strategy_id, COALESCE(s.name, '') AS strategy_name,
            s.market_mode, s.base_symbol, s.quote_symbol, s.interval, s.strategy_type,
            s.price_channel_length, s.base_coef, s.quote_coef
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
      WHERE s.is_active = 1 AND s.auto_update = 1 AND COALESCE(s.is_archived, 0) = 0
     ORDER BY s.id ASC`
  );

  const jobs = Array.isArray(rows) ? rows : [];
  const expectedSidByApiKey = await loadExpectedAlgofundSidMap().catch(() => new Map<string, Set<string>>());
  const syncMismatchRows: any[] = [];

  const syncFilteredJobs = jobs.filter((row) => {
    const apiKeyName = String(row?.api_key_name || '');
    const expected = expectedSidByApiKey.get(apiKeyName);
    if (!expected || expected.size === 0) {
      return true;
    }
    const sid = extractSourceSid(String(row?.strategy_name || ''));
    const ok = !!sid && expected.has(sid);
    if (!ok) {
      syncMismatchRows.push(row);
    }
    return ok;
  });

  if (syncMismatchRows.length > 0) {
    for (const row of syncMismatchRows) {
      const strategyId = Number(row?.strategy_id || 0);
      const apiKeyName = String(row?.api_key_name || '');
      if (!Number.isFinite(strategyId) || strategyId <= 0 || !apiKeyName) continue;
      try {
        await db.run(
          `UPDATE strategies
           SET is_active = 0,
               is_archived = 1,
               auto_update = 0,
               last_action = 'ts_sync_mismatch_archived',
               last_error = 'strict TS-sync: strategy SID not present in published system members',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [strategyId],
        );
      } catch (e) {
        logger.warn(`TS-sync archive failed for strategy ${strategyId} (${apiKeyName}): ${(e as Error).message}`);
      }
    }
    logger.warn(`Auto-cycle TS-sync: archived ${syncMismatchRows.length} strategies not in published TS members`);
  }
  const sidDedupedJobs: any[] = [];
  const sidWinnerByApiKeySid = new Map<string, any>();
  for (const row of syncFilteredJobs) {
    const apiKeyName = String(row?.api_key_name || '');
    const strategyName = String(row?.strategy_name || '');
    const strategyId = Number(row?.strategy_id || 0);
    const sid = extractSourceSid(strategyName);
    if (!apiKeyName || !sid || !Number.isFinite(strategyId) || strategyId <= 0) {
      sidDedupedJobs.push(row);
      continue;
    }
    const key = `${apiKeyName}::SID${sid}`;
    const prev = sidWinnerByApiKeySid.get(key);
    if (!prev || Number(prev.strategy_id || 0) < strategyId) {
      sidWinnerByApiKeySid.set(key, row);
    }
  }
  const hasSid = (row: any): boolean => !!extractSourceSid(String(row?.strategy_name || ''));
  const sidWinners = new Set<string>();
  for (const key of sidWinnerByApiKeySid.keys()) sidWinners.add(key);
  const sidWinnerIds = new Set<number>();
  for (const winner of sidWinnerByApiKeySid.values()) {
    const id = Number(winner?.strategy_id || 0);
    if (id > 0) sidWinnerIds.add(id);
  }
  for (const row of syncFilteredJobs) {
    if (!hasSid(row)) continue;
    const id = Number(row?.strategy_id || 0);
    if (sidWinnerIds.has(id)) {
      sidDedupedJobs.push(row);
    }
  }

  const dedupedJobs = sidDedupedJobs.length > 0 ? sidDedupedJobs : syncFilteredJobs;
  const skippedDuplicateSid = Math.max(0, syncFilteredJobs.length - dedupedJobs.length);
  if (skippedDuplicateSid > 0) {
    logger.warn(`Auto-cycle SID dedupe: skipped ${skippedDuplicateSid} duplicate strategy jobs in this cycle`);
  }
  let processed = 0;
  let failed = 0;
  let skippedOffline = 0;

  // ── Phase 1: Initialize all exchange clients sequentially (safe, idempotent) ──
  const validJobs = dedupedJobs.filter((row) => {
    const apiKeyName = String(row?.api_key_name || '');
    const strategyId = Number(row?.strategy_id || 0);
    return apiKeyName && Number.isFinite(strategyId) && strategyId > 0;
  });

  for (const row of validJobs) {
    const apiKeyName = String(row.api_key_name);
    try {
      await ensureExchangeClientInitialized(apiKeyName);
    } catch (initErr) {
      logger.warn(`Auto-cycle: failed to init exchange client for ${apiKeyName}: ${formatActionError(initErr)}`);
    }
  }

  // ── Phase 1.5: Pre-warm candle cache (Shared Signal) ──
  // Fetch market data for all unique (apiKey, symbol, interval, lookback) combos BEFORE
  // parallel execution starts. This guarantees every strategy in this cycle evaluates the
  // SAME closed bar — eliminating timing desync caused by bar closes mid-cycle.
  // Strategies with identical signal parameters (same pair/interval/length) are guaranteed
  // to compute the same signal from the same candle snapshot.
  const warmupJobs: MarketDataWarmupJob[] = [];

  for (const row of validJobs) {
    const apiKeyName = String(row.api_key_name);
    const exchange = getExchangeForApiKey(apiKeyName) || `key:${apiKeyName}`;
    const strategyType = normalizeStrategyType(row.strategy_type);
    // periodic_buy doesn't need candle pre-warm — it fetches 1m candle on its own
    if ((row.strategy_type as string) === 'periodic_buy' || (row.strategy_type as string) === 'dca' || (row.strategy_type as string) === 'dca_futures') continue;
    const signalLength = Math.max(2, Math.floor(Number(row.price_channel_length) || 50));
    const lookback = (strategyType === 'stat_arb_zscore' || strategyType === 'CT_Fractal')
      ? Math.max(signalLength + 120, 220)
      : strategyType === 'hideep'
        ? Math.max(signalLength + 110, 220)
        : Math.max(signalLength + 30, 120);

    const marketMode = normalizeMarketMode(row.market_mode);
    const baseSymbol = String(row.base_symbol || '').trim().toUpperCase();
    const quoteSymbol = String(row.quote_symbol || '').trim().toUpperCase();
    const interval = String(row.interval || '').trim();

    if (!baseSymbol || !interval) {
      continue;
    }

    // Build warm-up candidates: base + quote (for synthetic)
    const symbolsToWarm: { symbol: string; limit: number }[] = [{ symbol: baseSymbol, limit: lookback }];
    if (marketMode !== 'mono' && quoteSymbol && quoteSymbol !== baseSymbol) {
      symbolsToWarm.push({ symbol: quoteSymbol, limit: lookback });
    }

    for (const { symbol, limit } of symbolsToWarm) {
      warmupJobs.push({
        exchange,
        apiKeyName,
        symbol,
        interval,
        limit,
      });
    }
  }

  if (warmupJobs.length > 0) {
    const warmed = await warmMarketDataCache(warmupJobs);
    logger.info(`Auto-cycle: warmed candle cache for ${warmed} exchange-scoped symbol combos (from ${warmupJobs.length} leg requests)`);
  }

  // ── Phase 2: Execute all strategies in parallel ──
  // Candle data is shared via marketDataCache (TTL 25s, exchange-scoped, relay-key rotation).
  // Exchange order calls (market orders) are independent per account and can
  // safely overlap. SQLite writes are serialized by the WAL layer automatically.
  const executeOne = async (row: any): Promise<void> => {
    const apiKeyName = String(row.api_key_name);
    const strategyId = Number(row.strategy_id);
    const strategyName = String(row?.strategy_name || '');
    const strategyType = String(row.strategy_type || '');

    try {
      if (strategyType === 'periodic_buy') {
        const { executePeriodicBuy } = await import('./periodicBuy');
        await executePeriodicBuy(apiKeyName, strategyId);
        processed += 1;
        return;
      }
      if (strategyType === 'dca') {
        const { executeDca } = await import('./dca');
        await executeDca(apiKeyName, strategyId);
        processed += 1;
        return;
      }
      if (strategyType === 'dca_futures') {
        const { executeDcaFutures } = await import('./dca-futures');
        await executeDcaFutures(apiKeyName, strategyId);
        processed += 1;
        return;
      }
      await executeStrategy(apiKeyName, strategyId, {
        source: 'auto',
        closedBarOnly: true,
        dedupeClosedBar: true,
      });
      processed += 1;
    } catch (error) {
      const errorText = formatActionError(error);
      const lower = errorText.toLowerCase();
      const isPairPermissionDenied = lower.includes('no permission for this trading pair');
      const pairMatch = errorText.match(/\b([A-Z]{2,}USDT)\b/);
      const deniedPair = String(pairMatch?.[1] || '').toUpperCase();

      if (isPairPermissionDenied) {
        failed += 1;
        logger.error(`Auto-cycle strategy ${strategyId} (${apiKeyName}) blocked by pair permission: ${deniedPair || '-'} (${errorText})`);
        try {
          await updateStrategy(apiKeyName, strategyId, {
            is_active: false,
            auto_update: false,
            state: 'flat',
            last_action: 'auto_disabled_pair_permission_denied',
            last_error: errorText,
          });
        } catch (persistError) {
          logger.warn(
            `Auto-cycle strategy ${strategyId} (${apiKeyName}) failed to persist pair-permission disable: ${formatActionError(persistError)}`
          );
        }

        try {
          await db.run(
            `INSERT INTO strategy_runtime_events
               (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
             VALUES (?, ?, ?, 'pair_permission_block', ?, ?, 0, ?)`,
            [
              apiKeyName,
              strategyId,
              strategyName,
              errorText,
              JSON.stringify({ pair: deniedPair || null, policy: 'auto_disable_strategy' }),
              Date.now(),
            ]
          );
        } catch {
          // Non-critical
        }
        return;
      }

      if (isOfflineSymbolMarketDataError(errorText)) {
        skippedOffline += 1;
        if (shouldLogOfflineSymbolSkip(apiKeyName, strategyId)) {
          logger.warn(`Auto-cycle strategy ${strategyId} (${apiKeyName}) skipped: offline symbol on exchange (${errorText})`);
        }

        try {
          await updateStrategy(apiKeyName, strategyId, {
            last_action: 'auto_cycle_skipped_offline_symbol',
            last_error: errorText,
          });
        } catch (persistError) {
          logger.warn(
            `Auto-cycle strategy ${strategyId} (${apiKeyName}) failed to persist offline-skip state: ${formatActionError(persistError)}`
          );
        }
        return;
      }

      failed += 1;
      logger.warn(`Auto-cycle strategy ${strategyId} (${apiKeyName}) failed: ${errorText}`);
      const isLowLot = errorText.toLowerCase().includes('order size too small');

      // Persist latest auto-cycle failure so SaaS monitoring and low-lot recommendations
      // can pick up errors even when execution aborted before strategy state update.
      try {
        await updateStrategy(apiKeyName, strategyId, {
          last_action: 'auto_cycle_failed',
          last_error: errorText,
        });
      } catch (persistError) {
        logger.warn(
          `Auto-cycle strategy ${strategyId} (${apiKeyName}) failed to persist error: ${formatActionError(persistError)}`
        );
      }

      // Emit low-lot runtime event for instant visibility in analytics (no extra cycle wait).
      if (isLowLot) {
        try {
          await db.run(
            `INSERT INTO strategy_runtime_events
               (api_key_name, strategy_id, strategy_name, event_type, message, resolved_at, created_at)
             VALUES (?, ?, ?, 'low_lot_error', ?, 0, ?)`,
            [apiKeyName, strategyId, strategyName, errorText, Date.now()]
          );
        } catch {
          // Non-critical; analytics event loss is acceptable.
        }
      }
    }
  };

  await Promise.allSettled(validJobs.map((row) => executeOne(row)));

  return {
    total: syncFilteredJobs.length,
    processed,
    failed,
    skippedOffline,
  };
};

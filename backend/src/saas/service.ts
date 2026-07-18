import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { runBacktest, type BacktestRunRequest, type MacroExitOverlay, type StatArbEntryGate, DEFAULT_STAT_ARB_ENTRY_GATE } from '../backtest/engine';
import { closeStrategyExposure, cancelStrategyWorkingOrders, copyStrategyBlock, createStrategy, getStrategies, updateStrategy } from '../bot/strategy';
import {
  createTradingSystem,
  getTradingSystem,
  listTradingSystems,
  replaceTradingSystemMembers,
  replaceTradingSystemMembersSafely,
  runTradingSystemBacktest,
  setTradingSystemActivation,
  updateTradingSystem,
  type TradingSystemMemberDraft,
} from '../bot/tradingSystems';
import { getMonitoringLatest } from '../bot/monitoring';
import {
  getPositions,
  closeAllPositions,
  cancelAllOrders,
  ensureExchangeClientInitialized,
  getMarketData,
  getAllSymbols,
  getExchangeForApiKey,
} from '../bot/exchange';
import { isWeexApiTradableSymbol } from '../bot/weexClient';
import { Strategy, saveApiKey } from '../config/settings';
import { db, initDB } from '../utils/database';
import logger from '../utils/logger';
import { initResearchDb } from '../research/db';
import { getPreset, listOfferIds } from '../research/presetBuilder';
import { enqueueClientPreview, getClientPreviewJobPayload } from '../research/clientPreviewQueue';
import { computeReconciliationMetrics } from '../analytics/liveReconciliation';
import {
  parsePortfolioCircuitBreaker,
  type PortfolioCircuitBreakerConfig,
} from '../services/portfolioCircuitBreaker';

// При нормализации карточек на initialBalance lotPercentOverride=100% даёт notional=baseCapital.
// Если ставить maxDepositOverride=initialBalance, то baseCapital всегда упирается в initialBalance
// и реинвест не работает (compound efect маскируется). Поэтому даём "практически бесконечный"
// потолок, чтобы reinvest_percent давал настоящий compound на equity > initialBalance.
const CARD_PREVIEW_MAX_DEPOSIT_GROWTH_X = 1000;

/** Admin portfolio rerun: cap compound base per leg (100% reinvest → 20× initial, not 1000×). */
const ADMIN_PORTFOLIO_MAX_DEPOSIT_GROWTH_X = 20;

/** Admin/card preview: reinvest 0 → honor strategy max_deposit; >0 → capped compound for portfolio realism. */
const resolveAdminPreviewMaxDepositOverride = (
  reinvestPercent: number,
  initialBalance: number,
): number => {
  const safeBalance = Math.max(100, asNumber(initialBalance, 10000));
  const reinvest = clampNumber(asNumber(reinvestPercent, 0), 0, 100);
  if (reinvest <= 0) {
    return 0;
  }
  const growthCap = Math.min(
    ADMIN_PORTFOLIO_MAX_DEPOSIT_GROWTH_X,
    1 + (reinvest / 100) * (ADMIN_PORTFOLIO_MAX_DEPOSIT_GROWTH_X - 1),
  );
  return safeBalance * growthCap;
};

const resolveAdminPreviewLotPercentOverride = (
  lotPercentEffective: number,
  rerunRiskMul: number,
): number => Number(Math.min(500, Math.max(0.1, lotPercentEffective * rerunRiskMul)).toFixed(4));

/** Real engine rerun must match publish-time /api/backtest/run — no risk slider lot scaling. */
const resolveRealEngineLotPercentOverride = (
  lotPercentEffective: number,
  preferRealBacktest: boolean,
  rerunRiskMul: number,
): number => (
  preferRealBacktest
    ? Number(Math.min(500, Math.max(0.1, lotPercentEffective)).toFixed(4))
    : resolveAdminPreviewLotPercentOverride(lotPercentEffective, rerunRiskMul)
);

const resolveSnapshotLotPercent = (
  snapshot: TsBacktestSnapshot | null | undefined,
): number => {
  if (!snapshot?.backtestSettings || typeof snapshot.backtestSettings !== 'object') {
    return 0;
  }
  const settings = snapshot.backtestSettings as Record<string, unknown>;
  const raw = settings.lotPercentOverride ?? settings.lotPercent;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Real rerun must use offer-store / offerId strategy ids — not freq-variant substitutions. */
const resolveOfferStoreStrategyIds = (
  offerIds: string[],
  offerStoreById: Map<string, Record<string, unknown>>,
): number[] => {
  const out: number[] = [];
  for (const offerId of offerIds) {
    const trimmed = asString(offerId, '').trim();
    if (!trimmed) {
      continue;
    }
    const row = offerStoreById.get(trimmed);
    const sid = Number(row?.strategyId || parseStrategyIdFromOfferId(trimmed) || 0);
    if (Number.isFinite(sid) && sid > 0) {
      out.push(Math.floor(sid));
    }
  }
  return Array.from(new Set(out));
};

const resolveAdminPreviewBacktestMode = (
  strategyIds: number[],
): 'single' | 'portfolio' => (strategyIds.length === 1 ? 'single' : 'portfolio');

/** Match full-historical sweep window: open-ended sweeps cap via backtestBars, not calendar dateTo. */
const resolveAdminPreviewRerunWindow = (
  sweep: { config?: Record<string, unknown> } | null | undefined,
  snapshot: TsBacktestSnapshot | null | undefined,
  requestedFrom: string,
  requestedTo: string,
  overrides?: { bars?: number; warmupBars?: number },
): {
  dateFrom: string;
  dateTo?: string;
  bars: number;
  warmupBars: number;
  usedCalendarRange: boolean;
} => {
  const sweepConfig = (sweep?.config || {}) as Record<string, unknown>;
  const sweepFrom = asString(sweepConfig.dateFrom, '').trim().slice(0, 10);
  const sweepToRaw = sweepConfig.dateTo;
  const sweepTo = sweepToRaw === null || sweepToRaw === undefined
    ? ''
    : asString(sweepToRaw, '').trim().slice(0, 10);
  const sweepHasEndDate = /^\d{4}-\d{2}-\d{2}$/.test(sweepTo);
  const settings = snapshot?.backtestSettings && typeof snapshot.backtestSettings === 'object'
    ? (snapshot.backtestSettings as Record<string, unknown>)
    : {};
  const pickPositiveInt = (value: unknown, fallback: number): number => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const bars = Math.max(
    100,
    pickPositiveInt(
      overrides?.bars ?? settings.backtestBars ?? sweepConfig.backtestBars,
      pickPositiveInt(sweepConfig.backtestBars, 900),
    ),
  );
  const warmupBars = Math.max(
    0,
    pickPositiveInt(
      overrides?.warmupBars ?? settings.warmupBars ?? sweepConfig.warmupBars,
      pickPositiveInt(sweepConfig.warmupBars, 120),
    ),
  );
  const dateFrom = asString(requestedFrom, '').trim().slice(0, 10)
    || asString(settings.dateFrom, '').trim().slice(0, 10)
    || sweepFrom;
  const settingsTo = asString(settings.dateTo, '').trim().slice(0, 10);
  const requestedToTrim = asString(requestedTo, '').trim().slice(0, 10);

  // Sweep jobs with dateTo=null intentionally rely on backtestBars — do not expand to calendar span.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && !sweepHasEndDate) {
    return { dateFrom, bars, warmupBars, usedCalendarRange: false };
  }

  const dateTo = requestedToTrim || settingsTo || sweepTo;
  return {
    dateFrom,
    ...( /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? { dateTo } : {} ),
    bars,
    warmupBars,
    usedCalendarRange: /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo),
  };
};

const buildEqualPortfolioLotMultipliers = (strategyIds: number[]): Record<number, number> => {
  const ids = Array.from(new Set(strategyIds.filter((sid) => Number.isFinite(sid) && sid > 0)));
  if (ids.length <= 1) {
    return {};
  }
  const w = Number((1 / ids.length).toFixed(6));
  const out: Record<number, number> = {};
  ids.forEach((sid) => {
    out[sid] = w;
  });
  return out;
};

/** Prefer per-leg multipliers saved in snapshot (publish-time /api/backtest/run parity). */
const resolveSnapshotPortfolioLotMultipliers = (
  snapshot: TsBacktestSnapshot | null | undefined,
  strategyIds: number[],
  preferRealBacktest: boolean,
  offers: Array<{ offerId?: string; strategyId?: number | string }>,
  weightsByOfferId: Record<string, number>,
  payloadMultipliers?: Record<string, number>,
): Record<number, number> => {
  const ids = Array.from(new Set(strategyIds.filter((sid) => Number.isFinite(sid) && sid > 0)));
  if (ids.length <= 1) {
    return {};
  }
  if (payloadMultipliers && typeof payloadMultipliers === 'object') {
    const src = payloadMultipliers;
    const out: Record<number, number> = {};
    for (const sid of ids) {
      const m = Number(src[String(sid)] ?? src[sid]);
      if (Number.isFinite(m) && m > 0) {
        out[sid] = m;
      }
    }
    if (Object.keys(out).length === ids.length) {
      return out;
    }
  }
  if (preferRealBacktest && snapshot?.backtestSettings && typeof snapshot.backtestSettings === 'object') {
    const raw = (snapshot.backtestSettings as Record<string, unknown>).lotPercentMultiplierByStrategyId;
    if (raw && typeof raw === 'object') {
      const src = raw as Record<string, unknown>;
      const out: Record<number, number> = {};
      for (const sid of ids) {
        const m = Number(
          src[String(sid)]
          ?? src[sid]
          ?? src[`tv-burst-turbo-${sid}`]
          ?? src[`offer-${sid}`],
        );
        if (Number.isFinite(m) && m > 0) {
          out[sid] = m;
        }
      }
      if (Object.keys(out).length === ids.length) {
        return out;
      }
    }
  }
  // Competition / Boost cards publish with per-leg mult=1.0 (full lotPercentOverride
  // per strategy, OP-capped). Falling back to 1/N silently crushes Ret ~N× on API rerun
  // when snapshot omitted multipliers — seen on B3 Boost L32 (10583% → ~57%).
  if (preferRealBacktest) {
    const out: Record<number, number> = {};
    for (const sid of ids) {
      out[sid] = 1;
    }
    return out;
  }
  return buildPortfolioLotMultiplierByStrategyId(offers, weightsByOfferId);
};

const buildPortfolioLotMultiplierByStrategyId = (
  offers: Array<{ offerId?: string; strategyId?: number | string }>,
  weightsByOfferId: Record<string, number>,
): Record<number, number> => {
  const out: Record<number, number> = {};
  const count = Math.max(1, offers.length);
  for (const offer of offers) {
    const strategyId = Number(offer.strategyId || 0);
    const offerId = asString(offer.offerId, '').trim();
    if (!Number.isFinite(strategyId) || strategyId <= 0) {
      continue;
    }
    const weight = offerId && Number.isFinite(Number(weightsByOfferId[offerId]))
      ? Math.max(0, asNumber(weightsByOfferId[offerId], 1 / count))
      : 1 / count;
    out[strategyId] = weight;
  }
  return out;
};

/** Merge tier applyTo list from snapshot/card when admin UI payload omits it. */
const mergePortfolioCircuitBreakerApplyTo = (
  primary: PortfolioCircuitBreakerConfig,
  fallback: PortfolioCircuitBreakerConfig | null | undefined,
): PortfolioCircuitBreakerConfig => {
  const primaryTypes = Array.isArray(primary.applyToStrategyTypes)
    ? primary.applyToStrategyTypes.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  if (primaryTypes.length > 0) {
    return { ...primary, applyToStrategyTypes: primaryTypes };
  }
  const fallbackTypes = Array.isArray(fallback?.applyToStrategyTypes)
    ? fallback.applyToStrategyTypes.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  if (fallbackTypes.length > 0) {
    return { ...primary, applyToStrategyTypes: fallbackTypes };
  }
  return primary;
};

/** Portfolio CB from admin payload or saved TS snapshot (rerun parity with publish). */
const resolveSnapshotPortfolioCircuitBreaker = (
  snapshot: TsBacktestSnapshot | null | undefined,
  payloadRaw?: unknown,
  cardFallback?: PortfolioCircuitBreakerConfig | null,
): PortfolioCircuitBreakerConfig | undefined => {
  if (payloadRaw === null) {
    return undefined;
  }
  if (payloadRaw && typeof payloadRaw === 'object' && (payloadRaw as PortfolioCircuitBreakerConfig).enabled === false) {
    return undefined;
  }
  const settings = snapshot?.backtestSettings && typeof snapshot.backtestSettings === 'object'
    ? (snapshot.backtestSettings as Record<string, unknown>)
    : {};
  const fromSnapshot = parsePortfolioCircuitBreaker(settings.portfolioCircuitBreaker);
  const fromPayload = parsePortfolioCircuitBreaker(payloadRaw);
  if (fromPayload && fromPayload.enabled !== false) {
    return mergePortfolioCircuitBreakerApplyTo(
      fromPayload,
      fromSnapshot && fromSnapshot.enabled !== false
        ? fromSnapshot
        : (cardFallback && cardFallback.enabled !== false ? cardFallback : null),
    );
  }
  if (fromSnapshot && fromSnapshot.enabled !== false) {
    return mergePortfolioCircuitBreakerApplyTo(
      fromSnapshot,
      cardFallback && cardFallback.enabled !== false ? cardFallback : null,
    );
  }
  return undefined;
};

/** Same lot/reinvest/deposit caps as admin sweep snapshot rerun — for TS+DCA combined preview parity. */
const resolveAdminPreviewEngineOverridesForTsPortfolio = async (params: {
  systemName: string;
  tsStrategyIds: number[];
  initialBalance: number;
  riskScore?: number;
  riskScaleMaxPercent?: number;
  reinvestPercent?: number;
  lotPercentOverride?: number;
  tradeFrequencyScore?: number;
  snapshot?: TsBacktestSnapshot | null;
  offerIds?: string[];
  offerWeightsById?: Record<string, number>;
  catalog?: CatalogData | null;
}) => {
  const riskScore = normalizePreferenceScore(params.riskScore, 'medium');
  const tradeFrequencyScore = normalizePreferenceScore(params.tradeFrequencyScore, 'medium');
  const riskScaleMaxPercent = clampNumber(asNumber(params.riskScaleMaxPercent, 100), 0, 400);
  const reinvestPercent = clampNumber(asNumber(params.reinvestPercent, 0), 0, 100);
  const rerunRiskMul = getPreviewRiskMultiplier(riskScore, riskScaleMaxPercent);
  const tradeMul = getPreviewTradeMultiplier(tradeFrequencyScore);
  const cardLotConfig = await getCardConfigBySystemName(asString(params.systemName, '').trim());
  const snapshotLotPercent = resolveSnapshotLotPercent(params.snapshot);
  const lotPercentRequested = Math.max(0, asNumber(params.lotPercentOverride, 0));
  const lotPercentEffective = lotPercentRequested > 0
    ? lotPercentRequested
    : (snapshotLotPercent > 0
      ? snapshotLotPercent
      : (cardLotConfig.lotPercent > 0 ? cardLotConfig.lotPercent : 100));
  const snapshotSettingsRaw = (params.snapshot?.backtestSettings && typeof params.snapshot.backtestSettings === 'object')
    ? (params.snapshot.backtestSettings as Record<string, unknown>)
    : {};
  const snapshotTradeFrequencyScore = clampNumber(asNumber(snapshotSettingsRaw.tradeFrequencyScore, 5), 0, 10);
  const snapshotTradeMul = getPreviewTradeMultiplier(snapshotTradeFrequencyScore);
  const relativeTradeMul = tradeMul / Math.max(0.01, snapshotTradeMul);
  const lotPercentOverride = resolveAdminPreviewLotPercentOverride(
    lotPercentEffective * relativeTradeMul,
    rerunRiskMul,
  );
  const maxDepositOverride = resolveAdminPreviewMaxDepositOverride(reinvestPercent, params.initialBalance);

  const offerIds = Array.from(new Set(
    (Array.isArray(params.offerIds) ? params.offerIds : [])
      .map((item) => asString(item, '').trim())
      .filter(Boolean),
  ));
  const weightsByOfferId = params.offerWeightsById && typeof params.offerWeightsById === 'object'
    ? params.offerWeightsById
    : {};
  const portfolioOffers: Array<{ offerId: string; strategyId: number }> = [];
  if (params.catalog && offerIds.length > 0) {
    for (const offerId of offerIds) {
      const offer = findOfferByIdOrNull(params.catalog, offerId);
      const strategyId = Number(
        offer?.strategy?.id
        || parseStrategyIdFromOfferId(offerId)
        || 0,
      );
      if (Number.isFinite(strategyId) && strategyId > 0 && params.tsStrategyIds.includes(strategyId)) {
        portfolioOffers.push({ offerId, strategyId });
      }
    }
  }
  const lotPercentMultiplierByStrategyId = portfolioOffers.length > 0
    ? buildPortfolioLotMultiplierByStrategyId(portfolioOffers, weightsByOfferId)
  : (() => {
    const fallback: Record<number, number> = {};
    const tsCount = Math.max(1, params.tsStrategyIds.length);
    for (const strategyId of params.tsStrategyIds) {
      if (Number.isFinite(strategyId) && strategyId > 0) {
        fallback[strategyId] = 1 / tsCount;
      }
    }
    return fallback;
  })();

  return {
    lotPercentOverride,
    maxDepositOverride,
    reinvestPercentOverride: reinvestPercent,
    lotPercentMultiplierByStrategyId,
  };
};

const maxNumericValues = (values: number[]): number => {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  let max = values[0];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > max) {
      max = values[index];
    }
  }
  return max;
};

const applyAdminPreviewSummaryFromEquity = (
  summary: Record<string, unknown>,
  equityCurve: Array<{ time: number; equity: number }>,
  initialBalance: number,
) => {
  const rerunMetrics = summarizeRealRerunEquityCurve(equityCurve, initialBalance);
  return {
    ...summary,
    finalEquity: rerunMetrics.finalEquity,
    totalReturnPercent: rerunMetrics.totalReturnPercent,
    maxDrawdownPercent: rerunMetrics.maxDrawdownPercent,
    ...(summary.netProfit != null
      ? { netProfit: Number((rerunMetrics.finalEquity - initialBalance).toFixed(4)) }
      : {}),
    marginLoadPercent: 0,
    unrealizedPnl: rerunMetrics.unrealizedPnl,
  };
};

const sanitizeEquityCurveForMetrics = (
  equityCurve: Array<{ time: number; equity: number }>,
  initialBalance: number,
): Array<{ time: number; equity: number }> => (
  equityCurve.map((point) => ({
    time: point.time,
    equity: Number(Math.max(0, asNumber(point.equity, initialBalance)).toFixed(4)),
  }))
);

/**
 * Lookup master_cards.metadata_json by system name and return per-card overrides.
 * Returns zeros if card not found / metadata empty — caller decides fallback.
 * Card code convention: `CARD::<UPPER(systemName)>`.
 */
export type CardRuntimeConfig = {
  maxOpenPositions: number;
  lotPercent: number;
  reinvestPercent: number;
  macroShield: boolean;
  portfolioCircuitBreaker: PortfolioCircuitBreakerConfig | null;
  dcaLayersRequired: boolean;
  expectedMemberCount: number;
};

export const getCardConfigBySystemName = async (
  systemName: string,
): Promise<CardRuntimeConfig> => {
  const name = String(systemName || '').trim();
  if (!name) {
    return {
      maxOpenPositions: 0,
      lotPercent: 0,
      reinvestPercent: 0,
      macroShield: false,
      portfolioCircuitBreaker: null,
      dcaLayersRequired: true,
      expectedMemberCount: 0,
    };
  }
  const code = `CARD::${name.toUpperCase()}`;
  let mop = 0;
  let lot = 0;
  let reinvest = 0;
  let macroShield = false;
  let portfolioCircuitBreaker: PortfolioCircuitBreakerConfig | null = null;
  let dcaLayersRequired = true;
  let expectedMemberCount = 0;
  try {
    const row = await db.get<{ metadata_json?: string }>(
      'SELECT metadata_json FROM master_cards WHERE code = ? AND is_active = 1',
      [code],
    );
    if (row?.metadata_json) {
      const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const mopRaw = Number((meta as { maxOpenPositions?: unknown })?.maxOpenPositions);
      if (Number.isFinite(mopRaw) && mopRaw >= 0) {
        mop = Math.floor(mopRaw);
      }
      const lotRaw = Number((meta as { lotPercentOverride?: unknown })?.lotPercentOverride);
      if (Number.isFinite(lotRaw) && lotRaw > 0) {
        lot = lotRaw;
      }
      const reinvestRaw = Number((meta as { reinvestPercentOverride?: unknown })?.reinvestPercentOverride);
      if (Number.isFinite(reinvestRaw) && reinvestRaw >= 0) {
        reinvest = Math.min(100, Math.max(0, reinvestRaw));
      }
      macroShield = (meta as { macroShield?: unknown }).macroShield === true;
      portfolioCircuitBreaker = parsePortfolioCircuitBreaker(meta.portfolioCircuitBreaker);
      if ((meta as { dcaLayersRequired?: unknown }).dcaLayersRequired === false) {
        dcaLayersRequired = false;
      }
      const category = String((meta as { category?: unknown }).category || '').trim();
      if (category === 'synth-stable-v42' || category === 'synth-stable-v4-2') {
        dcaLayersRequired = false;
      }
      const memberRaw = Number((meta as { expectedMemberCount?: unknown }).expectedMemberCount);
      if (Number.isFinite(memberRaw) && memberRaw > 0) {
        expectedMemberCount = Math.floor(memberRaw);
      }
    }
    if (expectedMemberCount <= 0) {
      const memberRow = await db.get<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM master_card_members mcm
         JOIN master_cards mc ON mc.id = mcm.card_id
         WHERE mc.code = ? AND COALESCE(mcm.is_enabled, 1) = 1`,
        [code],
      ).catch(() => null);
      expectedMemberCount = Math.max(0, Number(memberRow?.cnt || 0));
    }
  } catch {
    // Swallow: missing/invalid metadata simply means no override.
  }
  return {
    maxOpenPositions: mop,
    lotPercent: lot,
    reinvestPercent: reinvest,
    macroShield,
    portfolioCircuitBreaker,
    dcaLayersRequired,
    expectedMemberCount,
  };
};

/** Apply card lot/reinvest overrides to all runtime strategies on a client API key. */
export const applyClientCardStrategyOverrides = async (
  executionApiKeyName: string,
  systemName: string,
  options?: { strategyIds?: number[] },
): Promise<void> => {
  const cfg = await getCardConfigBySystemName(systemName);
  const scopedIds = (options?.strategyIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  // Multi-TS portfolios share one API key — only touch the book just materialized.
  if (scopedIds.length === 0) {
    logger.warn(
      `applyClientCardStrategyOverrides skipped for ${systemName} on ${executionApiKeyName}: no strategyIds (refusing key-wide lot paint)`,
    );
    return;
  }
  const idPlaceholders = scopedIds.map(() => '?').join(',');

  if (cfg.lotPercent > 0) {
    await db.run(
      `UPDATE strategies
       SET lot_long_percent = ?, lot_short_percent = ?, updated_at = CURRENT_TIMESTAMP
       WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
         AND COALESCE(origin, '') <> 'saas_overlay_legacy'
         AND COALESCE(strategy_type, '') NOT IN ('dca', 'dca_futures')
         AND id IN (${idPlaceholders})`,
      [cfg.lotPercent, cfg.lotPercent, executionApiKeyName, ...scopedIds],
    );
  }
  if (cfg.reinvestPercent > 0) {
    await db.run(
      `UPDATE strategies
       SET reinvest_percent = ?, updated_at = CURRENT_TIMESTAMP
       WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
         AND COALESCE(origin, '') <> 'saas_overlay_legacy'
         AND id IN (${idPlaceholders})`,
      [cfg.reinvestPercent, executionApiKeyName, ...scopedIds],
    );
  }
};

export type ProductMode = 'strategy_client' | 'algofund_client' | 'copytrading_client' | 'dual';
export type Level3 = 'low' | 'medium' | 'high';
export type RequestStatus = 'pending' | 'approved' | 'rejected';
export type AlgofundRequestType = 'start' | 'stop' | 'switch_system';

type AlgofundRequestPayload = {
  targetSystemId?: number;
  targetSystemName?: string;
  targetApiKeyName?: string;
  executionApiKeyName?: string;
};

type PeriodInfo = {
  dateFrom: string | null;
  dateTo: string | null;
  interval: string | null;
};

type PlanSeed = {
  code: string;
  title: string;
  productMode: ProductMode;
  priceUsdt: number;
  maxDepositTotal: number;
  riskCapMax: number;
  maxStrategiesTotal: number;
  allowTsStartStopRequests: boolean;
  features: Record<string, unknown>;
};

type PlanRow = {
  id: number;
  code: string;
  title: string;
  product_mode: ProductMode;
  price_usdt: number;
  original_price_usdt: number | null;
  max_deposit_total: number;
  risk_cap_max: number;
  max_strategies_total: number;
  allow_ts_start_stop_requests: number;
  features_json: string;
};

type TenantCapabilities = {
  settings: boolean;
  apiKeyUpdate: boolean;
  monitoring: boolean;
  backtest: boolean;
  startStopRequests: boolean;
};

export type StrategySelectionConstraints = {
  limits: {
    maxStrategies: number | null;
    minOffersPerSystem: number | null;
    maxOffersPerSystem: number | null;
    maxCustomSystems: number | null;
    mono: number | null;
    synth: number | null;
    depositCap: number | null;
    riskCap: number | null;
  };
  usage: {
    selected: number;
    mono: number;
    synth: number;
    uniqueMarkets: number;
    remainingSlots: number | null;
    currentCustomSystems: number;
    remainingCustomSystems: number | null;
    estimatedDepositPerStrategy: number | null;
  };
  violations: string[];
  warnings: string[];
};

export type AlgofundPortfolioPassport = {
  generatedAt: string;
  source: string;
  selectionPolicy: 'conservative' | 'balanced' | 'aggressive';
  period: PeriodInfo | null;
  candidates: Array<{
    strategyId: number;
    strategyName: string;
    strategyType: string;
    marketMode: string;
    market: string;
    weight: number;
    score: number;
    metrics: CatalogMetricSet;
  }>;
  portfolioSummary: {
    initialBalance?: number;
    finalEquity?: number;
    totalReturnPercent?: number;
    maxDrawdownPercent?: number;
    winRatePercent?: number;
    profitFactor?: number;
    tradesCount?: number;
  } | null;
  blockedReasons: string[];
};

export type OfferStoreDefaults = {
  periodDays: number;
  targetTradesPerDay: number;
  riskLevel: Level3;
};

export type OfferStoreLabel = 'research_catalog' | 'runtime_snapshot' | 'fallback_preset';

export type OfferStoreState = {
  defaults: OfferStoreDefaults;
  publishedOfferIds: string[];
  curatedOfferIds?: string[];
  labels?: Record<string, OfferStoreLabel>;
  algofundStorefrontSystemNames?: string[];
  algofundPublishedSystemNames?: string[];
  tsBacktestSnapshots?: Record<string, {
    systemName?: string;
    setKey?: string;
    ret: number;
    pf: number;
    dd: number;
    trades: number;
    tradesPerDay: number;
    periodDays: number;
    finalEquity: number;
    equityPoints: number[];
    offerIds: string[];
    backtestSettings: {
      riskScore: number;
      tradeFrequencyScore: number;
      initialBalance: number;
      riskScaleMaxPercent: number;
      maxOpenPositions?: number;
    };
    updatedAt: string;
  }>;
  tsBacktestSnapshot?: {
    systemName?: string;
    setKey?: string;
    ret: number;
    pf: number;
    dd: number;
    trades: number;
    tradesPerDay: number;
    periodDays: number;
    finalEquity: number;
    equityPoints: number[];
    offerIds: string[];
    backtestSettings: {
      riskScore: number;
      tradeFrequencyScore: number;
      initialBalance: number;
      riskScaleMaxPercent: number;
      maxOpenPositions?: number;
    };
    updatedAt: string;
  } | null;
  offers: Array<{
    offerId: string;
    titleRu: string;
    mode: 'mono' | 'synth';
    market: string;
    market_type: 'futures' | 'spot';
    strategyId: number;
    score: number;
    ret: number;
    pf: number;
    dd: number;
    trades: number;
    tradesPerDay: number;
    periodDays: number;
    label?: OfferStoreLabel;
    curated: boolean;
    publishedExplicitly: boolean;
    snapshotUpdatedAt?: string;
    appearedAt?: string;
    equityPoints: number[];
    backtestSettings?: {
      riskScore: number;
      tradeFrequencyScore: number;
      initialBalance: number;
      riskScaleMaxPercent: number;
    };
  }>;
};

export type HighTradeRecommendation = {
  strategyId: number;
  strategyName: string;
  strategyType: string;
  marketMode: string;
  market: string;
  interval: string;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  winRatePercent: number;
  profitFactor: number;
  tradesCount: number;
  score: number;
  robust: boolean;
};

export type HighTradeRecommendationResponse = {
  generatedAt: string;
  sourceSweepTimestamp: string | null;
  filters: {
    minProfitFactor: number;
    maxDrawdownPercent: number;
    minReturnPercent: number;
    limit: number;
  };
  offers: HighTradeRecommendation[];
  recommendedTradingSystem: {
    name: string;
    selectionPolicy: string;
    members: Array<HighTradeRecommendation & { weight: number; memberRole: string }>;
    aggregate: {
      tradesCount: number;
      avgProfitFactor: number;
      avgReturnPercent: number;
      avgDrawdownPercent: number;
    };
  } | null;
};

type OfferReviewSnapshot = {
  offerId: string;
  apiKeyName?: string;
  ret: number;
  pf: number;
  dd: number;
  trades: number;
  tradesPerDay: number;
  periodDays: number;
  equityPoints: number[];
  riskScore?: number;
  tradeFrequencyScore?: number;
  initialBalance?: number;
  riskScaleMaxPercent?: number;
  updatedAt: string;
};

export type TsDcaLayerSnapshot = {
  enabled?: boolean;
  markets?: string[];
  tuning?: Record<string, Partial<DcaStrategySettings>>;
  macroExitOverlay?: MacroExitOverlay;
  statArbEntryGate?: StatArbEntryGate;
  tunePreset?: string;
  dcaBaseAmountMode?: string;
  dcaBaseAmountPercent?: number;
  dcaStepPercent?: number;
  dcaTpPercent?: number;
  dcaInterval?: string;
  dcaMaxOrders?: number;
  dcaAutotune?: boolean;
  dcaEntryFilter?: string;
  dcaPerLegSl?: boolean;
  scanFingerprint?: string;
};

export type CardMetadataOverrides = {
  lotPercentOverride?: number;
  maxOpenPositions?: number;
  autoLotByChannelWidth?: boolean;
  dcaPerLegSl?: boolean;
  reinvestPercentOverride?: number;
  macroShield?: boolean;
  macroExitOverlay?: MacroExitOverlay | null;
  statArbEntryGate?: StatArbEntryGate | null;
  tunePreset?: string;
  enablePairLock?: boolean;
  dcaMarkets?: string[];
  dcaEnabled?: boolean;
  portfolioCircuitBreaker?: PortfolioCircuitBreakerConfig | null;
};

type TsBacktestSnapshot = {
  apiKeyName?: string;
  systemName?: string;
  setKey?: string;
  /**
   * Human-readable label for storefront/admin UI (e.g. "Mega Stable 365d").
   * Single source of truth for the card title — do NOT use systemName for display.
   * If absent, frontend falls back to a prettified setKey suffix.
   */
  displayLabel?: string;
  ret: number;
  pf: number;
  dd: number;
  winRate: number;
  trades: number;
  tradesPerDay: number;
  periodDays: number;
  finalEquity: number;
  equityPoints: number[];
  offerIds: string[];
  /** Sharpe ratio of the underlying portfolio backtest (optional, may be absent for legacy snapshots). */
  sharpe?: number;
  /** Number of strategies (members) in the underlying TS / master_card (optional). */
  membersCount?: number;
  /** Number of distinct markets covered by the portfolio (optional). */
  marketCount?: number;
  /** Maximum strategies allocated per single market (optional, diversification cap). */
  maxPerMarket?: number;
  backtestSettings: {
    riskScore: number;
    tradeFrequencyScore: number;
    initialBalance: number;
    riskScaleMaxPercent: number;
    maxOpenPositions?: number;
    lotPercentOverride?: number;
    lotPercentMultiplierByStrategyId?: Record<string | number, number>;
    dateFrom?: string;
    dateTo?: string;
    interval?: string;
    reinvestPercent?: number;
    backtestBars?: number;
    warmupBars?: number;
    autoLotByChannelWidth?: boolean;
    dcaPerLegSl?: boolean;
    macroShield?: boolean;
    macroExitOverlay?: MacroExitOverlay;
    statArbEntryGate?: StatArbEntryGate;
    enablePairLock?: boolean;
    dcaEnabled?: boolean;
    dcaMarkets?: string[];
    dcaInterval?: string;
    dcaStepPercent?: number;
    dcaTpPercent?: number;
    dcaMaxOrders?: number;
    dcaBaseAmountMode?: string;
    dcaBaseAmountPercent?: number;
    dcaAutotune?: boolean;
    preset?: string;
    portfolioCircuitBreaker?: PortfolioCircuitBreakerConfig;
  };
  /** Macro RSI shield enabled for this TS card. */
  macroShield?: boolean;
  /** DCA satellite markets (mono spot/futures grid, not sweep offers). */
  dcaMarkets?: string[];
  /** Full DCA + card mechanics block (v2-synth preset). */
  dcaLayer?: TsDcaLayerSnapshot;
  updatedAt: string;
};

const normalizeTsSnapshotMapKey = (raw: string): string => String(raw || '').trim();

export type AdminReportSettings = {
  enabled: boolean;
  tsDaily: boolean;
  tsWeekly: boolean;
  tsMonthly: boolean;
  offerDaily: boolean;
  offerWeekly: boolean;
  offerMonthly: boolean;
  sweepSnapshotAutoRefreshEnabled: boolean;
  sweepSnapshotRefreshHours: number;
  watchdogEnabled: boolean;
};

type OfferStoreSnapshotRefreshState = {
  lastRunAt: string;
  lastSweepPath: string;
  lastSweepTimestamp: string;
  lastResult: 'success' | 'failed' | 'skipped' | 'idle';
  lastReason: string;
  lastError: string;
  systemsUpdated: number;
  offersUpdated: number;
  durationMs: number;
};

type OfferStoreSnapshotRefreshResult = {
  ok: boolean;
  skipped: boolean;
  reason: string;
  settings: AdminReportSettings;
  state: OfferStoreSnapshotRefreshState;
  systemsUpdated: number;
  offersUpdated: number;
  errors: string[];
};

type TenantRow = {
  id: number;
  slug: string;
  display_name: string;
  product_mode: ProductMode;
  status: string;
  preferred_language: string;
  assigned_api_key_name: string;
  created_at?: string;
  updated_at?: string;
    deposit_cap_override: number | null;
  };

type SubscriptionRow = {
  id: number;
  tenant_id: number;
  plan_id: number;
  status: string;
  started_at: string;
  expires_at: string | null;
  notes: string;
};

type StrategyClientProfileRow = {
  id: number;
  tenant_id: number;
  selected_offer_ids_json: string;
  active_system_profile_id?: number | null;
  risk_level: Level3;
  trade_frequency_level: Level3;
  requested_enabled: number;
  actual_enabled: number;
  assigned_api_key_name: string;
  latest_preview_json: string;
};

type StrategyClientSystemProfileRow = {
  id: number;
  tenant_id: number;
  profile_name: string;
  selected_offer_ids_json: string;
  is_active: number;
  created_at?: string;
  updated_at?: string;
};

type StrategyClientCustomTsDraftRow = {
  id: number;
  tenant_id: number;
  selected_offer_ids_json: string;
  op_value: number;
  assigned_api_key_name: string;
  created_at?: string;
  updated_at?: string;
};

export type OfferUnpublishImpact = {
  offerId: string;
  affectedTenants: Array<{
    tenantId: number;
    slug: string;
    displayName: string;
    productMode: ProductMode;
    assignedApiKeyName: string;
  }>;
  openPositions: Array<{
    tenantId: number;
    apiKeyName: string;
    count: number;
    symbols: string[];
  }>;
  summary: {
    tenantCount: number;
    openPositionsCount: number;
  };
};

type AlgofundProfileRow = {
  id: number;
  tenant_id: number;
  risk_multiplier: number;
  requested_enabled: number;
  actual_enabled: number;
  assigned_api_key_name: string;
  execution_api_key_name: string;
  published_system_name: string;
  latest_preview_json: string;
};

type CopytradingProfileRow = {
  id: number;
  tenant_id: number;
  master_api_key_name: string;
  master_name: string;
  master_tags: string;
  tenants_json: string;
  copy_algorithm: string;
  copy_precision: string;
  copy_ratio: number;
  copy_enabled: number;
  last_master_positions_json?: string;
};

type AlgofundRequestRow = {
  id: number;
  tenant_id: number;
  request_type: AlgofundRequestType;
  status: RequestStatus;
  note: string;
  decision_note: string;
  request_payload_json: string;
  created_at: string;
  decided_at: string | null;
  tenant_display_name?: string;
  tenant_slug?: string;
};

export type CatalogMetricSet = {
  ret: number;
  pf: number;
  dd: number;
  wr: number;
  trades: number;
};

export type CatalogPreset = {
  strategyId: number;
  strategyName: string;
  score: number;
  metrics: CatalogMetricSet;
  equity_curve?: number[];
  params: {
    interval: string;
    length: number;
    takeProfitPercent: number;
    detectionSource: string;
    zscoreEntry: number;
    zscoreExit: number;
    zscoreStop: number;
  };
};

export type CatalogOffer = {
  offerId: string;
  titleRu: string;
  descriptionRu: string;
  strategy: {
    id: number;
    name: string;
    type: string;
    mode: 'mono' | 'synth';
    market: string;
    params: {
      interval: string;
      length: number;
      takeProfitPercent: number;
      detectionSource: string;
      zscoreEntry: number;
      zscoreExit: number;
      zscoreStop: number;
    };
  };
  metrics: CatalogMetricSet & {
    score: number;
    robust: boolean;
  };
  sliderPresets: {
    risk: Record<Level3, CatalogPreset | null>;
    tradeFrequency: Record<Level3, CatalogPreset | null>;
  };
  presetMatrix?: Record<Level3, Record<Level3, CatalogPreset | null>>;
  equity?: {
    source: string;
    generatedAt: string;
    points: Array<{ time: number; equity: number }>;
    pointsOriginal?: number;
    summary?: {
      finalEquity: number;
      totalReturnPercent: number;
      maxDrawdownPercent: number;
      winRatePercent: number;
      profitFactor: number;
      tradesCount: number;
    };
    error?: string;
  };
};

export type CatalogData = {
  timestamp: string;
  apiKeyName: string;
  source: {
    sweepFile: string;
    sweepTimestamp: string | null;
  };
  config?: Record<string, unknown>;
  counts: {
    evaluated: number;
    robust: number;
    monoCatalog: number;
    synthCatalog: number;
    adminTsMembers: number;
    durationSec: number;
  };
  clientCatalog: {
    mono: CatalogOffer[];
    synth: CatalogOffer[];
  };
  adminTradingSystemDraft: {
    name: string;
    members: Array<{
      strategyId: number;
      strategyName: string;
      strategyType: string;
      marketMode: string;
      market: string;
      interval?: string;
      score: number;
      weight: number;
    }>;
    sourcePortfolioSummary: Array<Record<string, unknown>>;
  };
};

export type SweepRecord = {
  strategyId: number;
  strategyName: string;
  strategyType: string;
  marketMode: string;
  market: string;
  interval: string;
  length: number;
  takeProfitPercent: number;
  detectionSource: string;
  zscoreEntry: number;
  zscoreExit: number;
  zscoreStop: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  winRatePercent: number;
  profitFactor: number;
  tradesCount: number;
  score: number;
  robust: boolean;
  /** Earliest candle timestamp actually used in the backtest (ms). */
  actualDataStartMs?: number | null;
  /** Latest candle timestamp actually used in the backtest (ms). */
  actualDataEndMs?: number | null;
};

export type SweepData = {
  timestamp: string;
  apiKeyName: string;
  counts: {
    potentialRuns: number;
    scheduledRuns: number;
    coveragePercent: number;
    evaluated: number;
    failures: number;
    robust: number;
    resumedFromCheckpoint: boolean;
    skippedFromCheckpoint: number;
    resumedFromLog: boolean;
    importedFromLog: number;
    logImportMissingStrategyIds: number;
    durationSec: number;
  };
  topAll: SweepRecord[];
  topByMode: {
    mono: SweepRecord[];
    synth: SweepRecord[];
  };
  selectedMembers: SweepRecord[];
  tradingSystem: {
    id: number;
    name: string;
    members: Array<{
      strategy_id: number;
      weight: number;
      member_role: string;
      is_enabled: boolean;
      notes: string;
    }>;
  };
  portfolioResults: Array<Record<string, unknown>>;
  evaluated: SweepRecord[];
  config: {
    dateFrom?: string | null;
    dateTo?: string | null;
    interval?: string;
    initialBalance?: number;
    commissionPercent?: number;
    slippagePercent?: number;
    fundingRatePercent?: number;
    backtestBars?: number;
    warmupBars?: number;
    skipMissingSymbols?: boolean;
    strategyPrefix?: string;
    systemName?: string;
    maxMembers?: number;
  };
};

type StrategyMaterializedRow = {
  id?: number;
  name: string;
  strategyId?: number;
  offerId: string;
  mode: string;
  market: string;
  type: string;
  metrics: CatalogMetricSet & { score: number };
};

const repoRoot = path.resolve(__dirname, '../../..');
const resultsDir = path.join(repoRoot, 'results');
const strategyClientPlans: PlanSeed[] = [
  {
    code: 'strategy_20',
    title: 'Dual Start · Strategy',
    productMode: 'strategy_client',
    priceUsdt: 0,
    maxDepositTotal: 5000,
    riskCapMax: 0,
    maxStrategiesTotal: 3,
    allowTsStartStopRequests: true,
    features: {
      dualTier: 'start',
      monoOrSynth: 3,
      customTsBuilder: true,
      customTsMinOffers: 2,
      customTsMaxOffers: 3,
      customTsMaxCount: 1,
      pricingModel: {
        betaPriceUsdt: 0,
        listPriceUsdt: 19,
        profitSharePercent: 40,
        highWatermark: true,
      },
    },
  },
  {
    code: 'strategy_50',
    title: 'Dual Pro · Strategy',
    productMode: 'strategy_client',
    priceUsdt: 0,
    maxDepositTotal: 50000,
    riskCapMax: 0,
    maxStrategiesTotal: 10,
    allowTsStartStopRequests: true,
    features: {
      dualTier: 'pro',
      mono: 10,
      synth: 10,
      complexTs: true,
      customTsBuilder: true,
      customTsMinOffers: 2,
      customTsMaxOffers: 10,
      customTsMaxCount: 3,
      pricingModel: {
        betaPriceUsdt: 0,
        listPriceUsdt: 69,
        profitSharePercent: 40,
        highWatermark: true,
      },
    },
  },
  {
    code: 'strategy_100',
    title: 'Dual Scale · Strategy',
    productMode: 'strategy_client',
    priceUsdt: 0,
    maxDepositTotal: 250000,
    riskCapMax: 0,
    maxStrategiesTotal: 30,
    allowTsStartStopRequests: true,
    features: {
      dualTier: 'scale',
      mono: 30,
      synth: 30,
      complexTs: true,
      extraExchangeRequest: true,
      customTsBuilder: true,
      customTsMinOffers: 2,
      customTsMaxOffers: 30,
      customTsMaxCount: 10,
      pricingModel: {
        betaPriceUsdt: 0,
        listPriceUsdt: 199,
        profitSharePercent: 40,
        highWatermark: true,
      },
    },
  },
];

const algofundPlans: PlanSeed[] = [
  {
    code: 'algofund_20',
    title: 'Dual Start · Algofund',
    productMode: 'algofund_client',
    priceUsdt: 0,
    maxDepositTotal: 5000,
    riskCapMax: 1.2,
    maxStrategiesTotal: 0,
    allowTsStartStopRequests: true,
    features: {
      managedTs: true,
      dualTier: 'start',
      pricingModel: {
        betaPriceUsdt: 0,
        listPriceUsdt: 20,
        profitSharePercent: 40,
        highWatermark: true,
      },
    },
  },
  {
    code: 'algofund_50',
    title: 'Dual Pro · Algofund',
    productMode: 'algofund_client',
    priceUsdt: 0,
    maxDepositTotal: 50000,
    riskCapMax: 2,
    maxStrategiesTotal: 0,
    allowTsStartStopRequests: true,
    features: {
      managedTs: true,
      dualTier: 'pro',
      pricingModel: {
        betaPriceUsdt: 0,
        listPriceUsdt: 60,
        profitSharePercent: 40,
        highWatermark: true,
      },
    },
  },
  {
    code: 'algofund_100',
    title: 'Dual Scale · Algofund',
    productMode: 'algofund_client',
    priceUsdt: 0,
    maxDepositTotal: 250000,
    riskCapMax: 3,
    maxStrategiesTotal: 0,
    allowTsStartStopRequests: true,
    features: {
      managedTs: true,
      dualTier: 'scale',
      pricingModel: {
        betaPriceUsdt: 0,
        listPriceUsdt: 200,
        profitSharePercent: 40,
        highWatermark: true,
      },
    },
  },
];

const copytradingPlans: PlanSeed[] = [
  {
    code: 'copytrading_100',
    title: 'Copytrading 100',
    productMode: 'copytrading_client',
    priceUsdt: 0,
    maxDepositTotal: 0,
    riskCapMax: 0,
    maxStrategiesTotal: 0,
    allowTsStartStopRequests: false,
    features: {
      copyMasterLimit: 1,
      copyTenantLimit: 5,
      copyAlgorithm: 'vwap_basic',
      copyPrecision: 'standard',
    },
  },
];

const combinedPlans: PlanSeed[] = [];

const LEGACY_DISABLED_PLAN_CODES = [
  'strategy_15',
  'strategy_25',
  'strategy_30',
  'algofund_70',
  'algofund_150',
  'algofund_200',
  'combined_70',
  'combined_120',
];

const PLAN_ORIGINAL_PRICE_BY_CODE: Record<string, number> = {
  strategy_20: 19,
  strategy_50: 69,
  strategy_100: 199,
  algofund_20: 20,
  algofund_50: 60,
  algofund_100: 200,
};

const SAAS_DUAL_MAX_MIGRATION_FLAG = 'saas.migrations.dual_max_default.v1';

const asNumber = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const SAAS_PREVIEW_BARS = Math.max(240, Math.floor(asNumber(process.env.SAAS_PREVIEW_BARS, 1200)));
const SAAS_PREVIEW_WARMUP_BARS = Math.max(0, Math.floor(asNumber(process.env.SAAS_PREVIEW_WARMUP_BARS, 0)));
const SAAS_PREVIEW_INITIAL_BALANCE = Math.max(1, asNumber(process.env.SAAS_PREVIEW_INITIAL_BALANCE, 10000));
const SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE = Math.max(1, asNumber(process.env.SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE, 1000));
const SAAS_OBSERVABILITY_HWM_STALE_HOURS = Math.max(1, Math.floor(asNumber(process.env.SAAS_OBSERVABILITY_HWM_STALE_HOURS, 24)));

const asString = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const CLIENT_STRICT_PRESET_MODE = String(process.env.CLIENT_STRICT_PRESET_MODE ?? '1').trim() !== '0';

const levelToPreferenceScore = (level: Level3): number => {
  if (level === 'low') return 0;
  if (level === 'high') return 10;
  return 5;
};

const preferenceScoreToLevel = (value: number): Level3 => {
  if (value <= 3.33) return 'low';
  if (value >= 6.67) return 'high';
  return 'medium';
};

const normalizePreferenceScore = (value: unknown, fallbackLevel: Level3): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return levelToPreferenceScore(fallbackLevel);
  }
  return clampNumber(numeric, 0, 10);
};

const buildPeriodInfo = (sweep: SweepData | null): PeriodInfo | null => {
  if (!sweep) {
    return null;
  }

  const dateFrom = asString(sweep.config?.dateFrom, '') || null;
  const dateTo = asString(sweep.config?.dateTo, '') || asString(sweep.timestamp, '') || null;
  const interval = asString(sweep.config?.interval, '') || null;

  return {
    dateFrom,
    dateTo,
    interval,
  };
};

const safeJsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch (_error) {
    return fallback;
  }
};

const normalizeEquityCurveOrientation = (
  points: unknown,
  retPercent: unknown,
  finalEquityInput?: unknown,
  initialBalanceInput: unknown = 10000
): number[] => {
  const numericPoints = Array.isArray(points)
    ? points.map((value) => Number(asNumber(value, NaN))).filter((value) => Number.isFinite(value))
    : [];

  if (numericPoints.length < 2) {
    return numericPoints;
  }

  const initialBalance = Math.max(1, asNumber(initialBalanceInput, 10000));
  const fallbackFinalEquity = initialBalance * (1 + asNumber(retPercent, 0) / 100);
  const targetFinalEquity = Number.isFinite(Number(finalEquityInput))
    ? asNumber(finalEquityInput, fallbackFinalEquity)
    : fallbackFinalEquity;

  // The curve should start near initialBalance. If first point is far from initial
  // and last point is closer, the curve is stored in reverse order → flip it.
  const firstDistFromInit = Math.abs(numericPoints[0] - initialBalance);
  const lastDistFromInit = Math.abs(numericPoints[numericPoints.length - 1] - initialBalance);

  if (lastDistFromInit + 1e-6 < firstDistFromInit) {
    return [...numericPoints].reverse();
  }

  return numericPoints;
};

const boolFromFeature = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const getPlanFeatures = (plan: PlanRow | null): Record<string, unknown> => {
  return safeJsonParse<Record<string, unknown>>(plan?.features_json, {});
};

const resolvePlanCapabilities = (plan: PlanRow | null): TenantCapabilities => {
  if (!plan) {
    return {
      settings: false,
      apiKeyUpdate: false,
      monitoring: false,
      backtest: false,
      startStopRequests: false,
    };
  }

  const features = getPlanFeatures(plan);
  const defaultMonitoring = asNumber(plan.price_usdt, 0) >= 20;
  const defaultBacktest = plan.product_mode === 'strategy_client'
    ? asNumber(plan.max_strategies_total, 0) >= 3
    : asNumber(plan.price_usdt, 0) >= 50;

  return {
    settings: boolFromFeature(features.settings, true),
    apiKeyUpdate: boolFromFeature(features.apiKeyUpdate, true),
    monitoring: boolFromFeature(features.monitoring, defaultMonitoring),
    backtest: boolFromFeature(features.backtest, defaultBacktest),
    startStopRequests: boolFromFeature(features.startStopRequests, Number(plan.allow_ts_start_stop_requests || 0) === 1),
  };
};

const findLatestFile = (matcher: RegExp): string => {
  if (!fs.existsSync(resultsDir)) {
    return '';
  }

  const extractIsoFromName = (fileName: string): number => {
    const match = fileName.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/i);
    if (!match?.[1]) {
      return Number.NaN;
    }
    const normalized = match[1].replace(/-/g, (token, index) => {
      // keep date part unchanged (YYYY-MM-DD), convert time separators only
      return index < 10 ? '-' : ':';
    }).replace('T', 'T').replace(/:(\d{3})Z$/i, '.$1Z');
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };

  const isBackupLike = (name: string): boolean => {
    const lower = name.toLowerCase();
    return lower.includes('checkpoint')
      || lower.includes('.bak')
      || lower.includes('backup')
      || lower.includes('pre-risk-freq-work');
  };

  const rows = fs.readdirSync(resultsDir)
    .filter((name) => matcher.test(name) && !isBackupLike(name))
    .map((name) => {
      const filePath = path.join(resultsDir, name);
      return {
        filePath,
        fileName: name,
        isoStampMs: extractIsoFromName(name),
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => {
      const leftStamp = Number.isFinite(left.isoStampMs) ? left.isoStampMs : -1;
      const rightStamp = Number.isFinite(right.isoStampMs) ? right.isoStampMs : -1;
      if (leftStamp !== rightStamp) {
        return rightStamp - leftStamp;
      }
      return right.mtimeMs - left.mtimeMs;
    });

  return rows[0]?.filePath || '';
};

const listArtifactFiles = (matcher: RegExp): Array<{ filePath: string; fileName: string; isoStampMs: number; mtimeMs: number }> => {
  if (!fs.existsSync(resultsDir)) {
    return [];
  }

  const extractIsoFromName = (fileName: string): number => {
    const match = fileName.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/i);
    if (!match?.[1]) {
      return Number.NaN;
    }
    const normalized = match[1].replace(/-/g, (token, index) => (index < 10 ? '-' : ':')).replace(/:(\d{3})Z$/i, '.$1Z');
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };

  const isBackupLike = (name: string): boolean => {
    const lower = name.toLowerCase();
    return lower.includes('checkpoint')
      || lower.includes('.bak')
      || lower.includes('backup')
      || lower.includes('pre-risk-freq-work');
  };

  return fs.readdirSync(resultsDir)
    .filter((name) => matcher.test(name) && !isBackupLike(name))
    .map((name) => {
      const filePath = path.join(resultsDir, name);
      return {
        filePath,
        fileName: name,
        isoStampMs: extractIsoFromName(name),
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => {
      const leftStamp = Number.isFinite(left.isoStampMs) ? left.isoStampMs : -1;
      const rightStamp = Number.isFinite(right.isoStampMs) ? right.isoStampMs : -1;
      if (leftStamp !== rightStamp) {
        return rightStamp - leftStamp;
      }
      return right.mtimeMs - left.mtimeMs;
    });
};

const getLatestClientCatalogPath = (): string => findLatestFile(/_client_catalog_\d{4}-\d{2}-\d{2}T.*Z\.json$/i);
const getLatestSweepPath = (): string => findLatestFile(/_historical_sweep_\d{4}-\d{2}-\d{2}T.*Z\.json$/i);
const SOURCE_ARTIFACT_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const toArtifactTimestampMs = (payloadTimestamp: unknown, filePath: string): number => {
  const parsed = Date.parse(String(payloadTimestamp || ''));
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
};

export const getLatestResearchArtifactsStatus = (): {
  catalogPath: string;
  sweepPath: string;
  catalogTimestamp: string | null;
  sweepTimestamp: string | null;
  catalogAgeMs: number | null;
  sweepAgeMs: number | null;
  catalogFresh: boolean;
  sweepFresh: boolean;
} => {
  const now = Date.now();
  const catalogPath = getLatestClientCatalogPath();
  const sweepPath = getLatestSweepPath();
  const catalog = catalogPath ? safeJsonParse<CatalogData>(fs.readFileSync(catalogPath, 'utf-8'), null as unknown as CatalogData) : null;
  const sweep = sweepPath ? safeJsonParse<SweepData>(fs.readFileSync(sweepPath, 'utf-8'), null as unknown as SweepData) : null;
  const catalogTimestamp = asString(catalog?.timestamp, '') || asString(catalog?.source?.sweepTimestamp, '') || null;
  const sweepTimestamp = asString(sweep?.timestamp, '') || null;
  const catalogTsMs = catalogPath ? toArtifactTimestampMs(catalogTimestamp, catalogPath) : 0;
  const sweepTsMs = sweepPath ? toArtifactTimestampMs(sweepTimestamp, sweepPath) : 0;
  const catalogAgeMs = catalogTsMs > 0 ? Math.max(0, now - catalogTsMs) : null;
  const sweepAgeMs = sweepTsMs > 0 ? Math.max(0, now - sweepTsMs) : null;

  return {
    catalogPath,
    sweepPath,
    catalogTimestamp,
    sweepTimestamp,
    catalogAgeMs,
    sweepAgeMs,
    catalogFresh: catalogAgeMs !== null && catalogAgeMs <= SOURCE_ARTIFACT_MAX_AGE_MS,
    sweepFresh: sweepAgeMs !== null && sweepAgeMs <= SOURCE_ARTIFACT_MAX_AGE_MS,
  };
};

export const loadLatestClientCatalog = (): CatalogData | null => {
  const filePath = getLatestClientCatalogPath();
  if (!filePath) {
    return null;
  }
  return safeJsonParse<CatalogData>(fs.readFileSync(filePath, 'utf-8'), null as unknown as CatalogData);
};

const loadCatalogFromFile = (filePath: string): CatalogData | null => {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return safeJsonParse<CatalogData>(fs.readFileSync(filePath, 'utf-8'), null as unknown as CatalogData);
};

const getCatalogIntervalKey = (catalog: CatalogData | null | undefined): string => {
  if (!catalog) {
    return '';
  }
  const config = (catalog.config || {}) as Record<string, unknown>;
  const explicitIntervals = Array.isArray(config.intervals)
    ? config.intervals.map((item) => asString(item, '').trim()).filter(Boolean)
    : [];
  if (explicitIntervals.length > 0) {
    return Array.from(new Set(explicitIntervals)).sort().join(',');
  }
  return asString(config.interval, '').trim();
};

const loadLatestClientCatalogsByApiAndInterval = (): CatalogData[] => {
  const now = Date.now();
  const rows = listArtifactFiles(/_client_catalog_\d{4}-\d{2}-\d{2}T.*Z\.json$/i);
  const selected = new Map<string, CatalogData>();

  for (const row of rows) {
    const catalog = loadCatalogFromFile(row.filePath);
    if (!catalog || !catalogHasOffers(catalog)) {
      continue;
    }
    const catalogTimestamp = asString(catalog?.timestamp, '') || asString(catalog?.source?.sweepTimestamp, '');
    const ageMs = Math.max(0, now - toArtifactTimestampMs(catalogTimestamp, row.filePath));
    if (ageMs > SOURCE_ARTIFACT_MAX_AGE_MS) {
      continue;
    }
    const apiKeyName = asString(catalog.apiKeyName, '').trim();
    const intervalKey = getCatalogIntervalKey(catalog);
    if (!apiKeyName || !intervalKey) {
      continue;
    }
    const dedupeKey = `${apiKeyName}::${intervalKey}`;
    if (!selected.has(dedupeKey)) {
      selected.set(dedupeKey, catalog);
    }
  }

  return Array.from(selected.values());
};

const mergeCatalogOffers = (catalogs: CatalogData[]): CatalogOffer[] => {
  const merged = new Map<string, CatalogOffer>();
  for (const catalog of catalogs) {
    for (const offer of getAllOffers(catalog)) {
      const offerId = asString(offer?.offerId, '').trim();
      if (!offerId || merged.has(offerId)) {
        continue;
      }
      merged.set(offerId, offer);
    }
  }
  return Array.from(merged.values());
};

const buildMergedStorefrontCatalog = (catalogs: CatalogData[]): CatalogData | null => {
  if (catalogs.length === 0) {
    return null;
  }

  const sortedCatalogs = [...catalogs].sort((left, right) => {
    const leftTs = Date.parse(asString(left.timestamp, '') || asString(left.source?.sweepTimestamp, '')) || 0;
    const rightTs = Date.parse(asString(right.timestamp, '') || asString(right.source?.sweepTimestamp, '')) || 0;
    return rightTs - leftTs;
  });
  const offers = mergeCatalogOffers(sortedCatalogs);
  const mono = offers.filter((offer) => offer.strategy?.mode === 'mono');
  const synth = offers.filter((offer) => offer.strategy?.mode !== 'mono');
  const draftMembersByStrategyId = new Map<number, CatalogData['adminTradingSystemDraft']['members'][number]>();
  for (const catalog of sortedCatalogs) {
    for (const member of catalog.adminTradingSystemDraft?.members || []) {
      const strategyId = Number(member.strategyId || 0);
      if (strategyId > 0 && !draftMembersByStrategyId.has(strategyId)) {
        draftMembersByStrategyId.set(strategyId, member);
      }
    }
  }
  const latest = sortedCatalogs[0];
  return {
    timestamp: latest.timestamp,
    apiKeyName: latest.apiKeyName,
    source: latest.source,
    config: {
      ...(latest.config || {}),
      intervals: Array.from(new Set(sortedCatalogs.map((catalog) => getCatalogIntervalKey(catalog)).filter(Boolean))).sort(),
      aggregatedCatalogs: sortedCatalogs.map((catalog) => ({
        apiKeyName: catalog.apiKeyName,
        interval: getCatalogIntervalKey(catalog),
        timestamp: catalog.timestamp,
        sweepTimestamp: catalog.source?.sweepTimestamp || null,
      })),
    },
    counts: {
      evaluated: sortedCatalogs.reduce((acc, catalog) => acc + Number(catalog.counts?.evaluated || 0), 0),
      robust: sortedCatalogs.reduce((acc, catalog) => acc + Number(catalog.counts?.robust || 0), 0),
      monoCatalog: mono.length,
      synthCatalog: synth.length,
      adminTsMembers: draftMembersByStrategyId.size,
      durationSec: sortedCatalogs.reduce((acc, catalog) => acc + Number(catalog.counts?.durationSec || 0), 0),
    },
    clientCatalog: { mono, synth },
    adminTradingSystemDraft: {
      name: 'SAAS Admin TS (multi-interval storefront source)',
      members: Array.from(draftMembersByStrategyId.values()),
      sourcePortfolioSummary: sortedCatalogs.map((catalog) => ({
        apiKeyName: catalog.apiKeyName,
        interval: getCatalogIntervalKey(catalog),
        timestamp: catalog.timestamp,
        counts: catalog.counts,
      })),
    },
  };
};

const loadStorefrontCatalogWithFallback = async (): Promise<CatalogData | null> => {
  const canonical = buildMergedStorefrontCatalog(loadLatestClientCatalogsByApiAndInterval());
  if (catalogHasOffers(canonical)) {
    return canonical;
  }
  const latest = loadLatestClientCatalog();
  if (catalogHasOffers(latest)) {
    return latest;
  }
  return null;
};

export const loadLatestSweep = (): SweepData | null => {
  const filePath = getLatestSweepPath();
  if (!filePath) {
    return null;
  }
  return safeJsonParse<SweepData>(fs.readFileSync(filePath, 'utf-8'), null as unknown as SweepData);
};

const getAllOffers = (catalog: CatalogData): CatalogOffer[] => [
  ...(catalog?.clientCatalog?.mono || []),
  ...(catalog?.clientCatalog?.synth || []),
];

const catalogHasOffers = (catalog: CatalogData | null | undefined): boolean => {
  if (!catalog) {
    return false;
  }
  return getAllOffers(catalog).length > 0;
};

const DEFAULT_OFFER_STORE_DEFAULTS: OfferStoreDefaults = {
  periodDays: 90,
  targetTradesPerDay: 6,
  riskLevel: 'medium',
};

const MIN_STOREFRONT_RETURN_PERCENT = 0.5;
const MIN_STOREFRONT_PROFIT_FACTOR = 1.02;
const MIN_STOREFRONT_TRADES = 1;

const OFFER_STORE_CURATED_IDS_KEY = 'offer.store.curated_ids';
const OFFER_STORE_LABELS_KEY = 'offer.store.labels';
const OFFER_STORE_ALGOFUND_PUBLISHED_SYSTEMS_KEY = 'offer.store.algofund_published_system_names';

const DEFAULT_ADMIN_REPORT_SETTINGS: AdminReportSettings = {
  enabled: true,
  tsDaily: true,
  tsWeekly: true,
  tsMonthly: true,
  offerDaily: true,
  offerWeekly: true,
  offerMonthly: true,
  sweepSnapshotAutoRefreshEnabled: true,
  sweepSnapshotRefreshHours: 24,
  watchdogEnabled: true,
};

const getSweepPeriodDays = (sweep: SweepData | null, fallbackDays: number): number => {
  const dateFromMs = Date.parse(String(sweep?.config?.dateFrom || ''));
  const dateToRaw = String(sweep?.config?.dateTo || '').trim();
  const dateToMs = dateToRaw ? Date.parse(dateToRaw) : Date.now();
  if (Number.isFinite(dateFromMs) && Number.isFinite(dateToMs) && dateToMs > dateFromMs) {
    return Math.max(1, Math.floor((dateToMs - dateFromMs) / 86_400_000));
  }
  return Math.max(1, Math.floor(fallbackDays));
};

const normalizeOfferStoreDefaults = (raw: unknown): OfferStoreDefaults => {
  const parsed = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const riskRaw = asString(parsed.riskLevel, DEFAULT_OFFER_STORE_DEFAULTS.riskLevel) as Level3;
  return {
    periodDays: Math.max(7, Math.min(365, Math.floor(asNumber(parsed.periodDays, DEFAULT_OFFER_STORE_DEFAULTS.periodDays)))),
    targetTradesPerDay: Math.max(1, Math.min(20, Number(asNumber(parsed.targetTradesPerDay, DEFAULT_OFFER_STORE_DEFAULTS.targetTradesPerDay).toFixed(2)))),
    riskLevel: riskRaw === 'low' || riskRaw === 'high' ? riskRaw : 'medium',
  };
};

const normalizeOfferReviewSnapshot = (offerId: string, raw: unknown): OfferReviewSnapshot | null => {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!parsed) {
    return null;
  }

  const safeOfferId = String(offerId || '').trim();
  if (!safeOfferId) {
    return null;
  }

  const fullEquity = Array.isArray(parsed.equityPoints)
    ? parsed.equityPoints
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
    : [];
  const step = fullEquity.length > 120 ? Math.ceil(fullEquity.length / 120) : 1;
  const sampledEquity = fullEquity.filter((_value, index) => index % step === 0);

  return {
    offerId: safeOfferId,
    apiKeyName: asString(parsed.apiKeyName, ''),
    ret: Number(asNumber(parsed.ret, 0).toFixed(3)),
    pf: Number(asNumber(parsed.pf, 0).toFixed(3)),
    dd: Number(asNumber(parsed.dd, 0).toFixed(3)),
    trades: Math.max(0, Math.floor(asNumber(parsed.trades, 0))),
    tradesPerDay: Number(asNumber(parsed.tradesPerDay, 0).toFixed(3)),
    periodDays: Math.max(1, Math.floor(asNumber(parsed.periodDays, 90))),
    equityPoints: sampledEquity,
    riskScore: Number(clampNumber(asNumber(parsed.riskScore, 5), 0, 10).toFixed(2)),
    tradeFrequencyScore: Number(clampNumber(asNumber(parsed.tradeFrequencyScore, 5), 0, 10).toFixed(2)),
    initialBalance: Math.max(100, Math.floor(asNumber(parsed.initialBalance, 10000))),
    riskScaleMaxPercent: Number(clampNumber(asNumber(parsed.riskScaleMaxPercent, 100), 0, 400).toFixed(2)),
    updatedAt: asString(parsed.updatedAt, new Date().toISOString()),
  };
};

const getOfferReviewSnapshots = async (): Promise<Record<string, OfferReviewSnapshot>> => {
  const raw = safeJsonParse<Record<string, unknown>>(
    await getRuntimeFlag('offer.store.review_snapshots', '{}'),
    {}
  );
  const result: Record<string, OfferReviewSnapshot> = {};
  for (const [offerId, value] of Object.entries(raw || {})) {
    const normalized = normalizeOfferReviewSnapshot(offerId, value);
    if (normalized) {
      result[offerId] = normalized;
    }
  }
  return result;
};

const parseMacroExitOverlayFromUnknown = (raw: unknown): MacroExitOverlay | undefined => (
  raw && typeof raw === 'object' ? (raw as MacroExitOverlay) : undefined
);

const parseStatArbEntryGateFromUnknown = (raw: unknown): StatArbEntryGate | undefined => (
  raw && typeof raw === 'object' ? (raw as StatArbEntryGate) : undefined
);

const parseTsDcaLayerSnapshot = (raw: unknown): TsDcaLayerSnapshot | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const parsed = raw as Record<string, unknown>;
  const layer: TsDcaLayerSnapshot = {};
  if (Array.isArray(parsed.markets)) {
    layer.markets = Array.from(new Set(
      parsed.markets.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean),
    ));
  }
  const overlay = parseMacroExitOverlayFromUnknown(parsed.macroExitOverlay);
  if (overlay) {
    layer.macroExitOverlay = overlay;
  }
  const gate = parseStatArbEntryGateFromUnknown(parsed.statArbEntryGate);
  if (gate) {
    layer.statArbEntryGate = gate;
  }
  if (parsed.tuning && typeof parsed.tuning === 'object') {
    layer.tuning = parsed.tuning as Record<string, Partial<DcaStrategySettings>>;
  }
  if (typeof parsed.tunePreset === 'string' && parsed.tunePreset.trim()) {
    layer.tunePreset = parsed.tunePreset.trim();
  }
  if (parsed.enabled === true) {
    layer.enabled = true;
  } else if (parsed.enabled === false) {
    layer.enabled = false;
  }
  if (typeof parsed.dcaInterval === 'string' && parsed.dcaInterval.trim()) {
    layer.dcaInterval = parsed.dcaInterval.trim();
  }
  if (Number.isFinite(Number(parsed.dcaStepPercent))) {
    layer.dcaStepPercent = Number(parsed.dcaStepPercent);
  }
  if (Number.isFinite(Number(parsed.dcaTpPercent))) {
    layer.dcaTpPercent = Number(parsed.dcaTpPercent);
  }
  if (Number.isFinite(Number(parsed.dcaMaxOrders))) {
    layer.dcaMaxOrders = Math.max(0, Math.floor(Number(parsed.dcaMaxOrders)));
  }
  if (typeof parsed.dcaBaseAmountMode === 'string' && parsed.dcaBaseAmountMode.trim()) {
    layer.dcaBaseAmountMode = parsed.dcaBaseAmountMode.trim();
  }
  if (Number.isFinite(Number(parsed.dcaBaseAmountPercent))) {
    layer.dcaBaseAmountPercent = Number(parsed.dcaBaseAmountPercent);
  }
  if (parsed.dcaAutotune === true) {
    layer.dcaAutotune = true;
  } else if (parsed.dcaAutotune === false) {
    layer.dcaAutotune = false;
  }
  if (typeof parsed.dcaEntryFilter === 'string' && parsed.dcaEntryFilter.trim()) {
    layer.dcaEntryFilter = parsed.dcaEntryFilter.trim();
  }
  if (parsed.dcaPerLegSl === true) {
    layer.dcaPerLegSl = true;
  }
  if (typeof parsed.scanFingerprint === 'string' && parsed.scanFingerprint.trim()) {
    layer.scanFingerprint = parsed.scanFingerprint.trim();
  }
  return Object.keys(layer).length > 0 ? layer : undefined;
};

export const getMasterCardMetadataBySystemName = async (
  systemName: string,
): Promise<Record<string, unknown> | null> => {
  const name = String(systemName || '').trim();
  if (!name) {
    return null;
  }
  const code = `CARD::${name.toUpperCase()}`;
  try {
    const row = await db.get<{ metadata_json?: string }>(
      'SELECT metadata_json FROM master_cards WHERE code = ? AND is_active = 1',
      [code],
    );
    if (!row?.metadata_json) {
      return null;
    }
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
};

const normalizeTsBacktestSnapshot = (raw: unknown): TsBacktestSnapshot | null => {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!parsed) {
    return null;
  }

  const fullEquity = Array.isArray(parsed.equityPoints)
    ? parsed.equityPoints
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
    : [];
  const step = fullEquity.length > 160 ? Math.ceil(fullEquity.length / 160) : 1;
  const sampledEquity = fullEquity.filter((_value, index) => index % step === 0);

  const rawOfferIds = Array.isArray(parsed.offerIds) ? parsed.offerIds : [];
  const offerIds = Array.from(new Set(rawOfferIds.map((item) => String(item || '').trim()).filter(Boolean)));

  const settingsRaw = parsed.backtestSettings && typeof parsed.backtestSettings === 'object'
    ? (parsed.backtestSettings as Record<string, unknown>)
    : {};
  const dcaLayerParsed = parseTsDcaLayerSnapshot(parsed.dcaLayer);

  return {
    apiKeyName: asString(parsed.apiKeyName, ''),
    systemName: asString(parsed.systemName, ''),
    setKey: asString(parsed.setKey, ''),
    ...(parsed.displayLabel !== undefined && asString(parsed.displayLabel, '').trim() !== ''
      ? { displayLabel: asString(parsed.displayLabel, '').trim() }
      : {}),
    ret: Number(asNumber(parsed.ret, 0).toFixed(3)),
    pf: Number(asNumber(parsed.pf, 0).toFixed(3)),
    dd: Number(asNumber(parsed.dd, 0).toFixed(3)),
    winRate: Number(clampNumber(asNumber(parsed.winRate, 0), 0, 100).toFixed(2)),
    trades: Math.max(0, Math.floor(asNumber(parsed.trades, 0))),
    tradesPerDay: Number(asNumber(parsed.tradesPerDay, 0).toFixed(3)),
    periodDays: Math.max(1, Math.floor(asNumber(parsed.periodDays, 90))),
    finalEquity: Number(asNumber(parsed.finalEquity, 0).toFixed(4)),
    equityPoints: sampledEquity,
    offerIds,
    ...(parsed.sharpe !== undefined && Number.isFinite(Number(parsed.sharpe))
      ? { sharpe: Number(asNumber(parsed.sharpe, 0).toFixed(3)) }
      : {}),
    ...(parsed.membersCount !== undefined && Number.isFinite(Number(parsed.membersCount))
      ? { membersCount: Math.max(0, Math.floor(asNumber(parsed.membersCount, 0))) }
      : {}),
    ...(parsed.marketCount !== undefined && Number.isFinite(Number(parsed.marketCount))
      ? { marketCount: Math.max(0, Math.floor(asNumber(parsed.marketCount, 0))) }
      : {}),
    ...(parsed.maxPerMarket !== undefined && Number.isFinite(Number(parsed.maxPerMarket))
      ? { maxPerMarket: Math.max(0, Math.floor(asNumber(parsed.maxPerMarket, 0))) }
      : {}),
    backtestSettings: {
      riskScore: Number(clampNumber(asNumber(settingsRaw.riskScore, 5), 0, 10).toFixed(2)),
      tradeFrequencyScore: Number(clampNumber(asNumber(settingsRaw.tradeFrequencyScore, 5), 0, 10).toFixed(2)),
      initialBalance: Math.max(100, Math.floor(asNumber(settingsRaw.initialBalance, 10000))),
      riskScaleMaxPercent: Number(clampNumber(asNumber(settingsRaw.riskScaleMaxPercent, 100), 0, 400).toFixed(2)),
      maxOpenPositions: Math.max(0, Math.floor(asNumber(settingsRaw.maxOpenPositions, 0))),
      lotPercentOverride: Math.max(0, asNumber(settingsRaw.lotPercentOverride ?? settingsRaw.lotPercent, 0)),
      reinvestPercent: Number(clampNumber(asNumber(settingsRaw.reinvestPercent, 0), 0, 100).toFixed(2)),
      backtestBars: Math.max(0, Math.floor(asNumber(settingsRaw.backtestBars, 0))),
      warmupBars: Math.max(0, Math.floor(asNumber(settingsRaw.warmupBars, 0))),
      ...(typeof settingsRaw.dateFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(settingsRaw.dateFrom)
        ? { dateFrom: settingsRaw.dateFrom }
        : {}),
      ...(typeof settingsRaw.dateTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(settingsRaw.dateTo)
        ? { dateTo: settingsRaw.dateTo }
        : {}),
      ...(settingsRaw.autoLotByChannelWidth === true ? { autoLotByChannelWidth: true } : {}),
      ...(settingsRaw.dcaPerLegSl === true ? { dcaPerLegSl: true } : {}),
      ...(settingsRaw.macroShield === true ? { macroShield: true } : {}),
      ...(parseMacroExitOverlayFromUnknown(settingsRaw.macroExitOverlay)
        ? { macroExitOverlay: parseMacroExitOverlayFromUnknown(settingsRaw.macroExitOverlay) }
        : {}),
      ...(parseStatArbEntryGateFromUnknown(settingsRaw.statArbEntryGate)
        ? { statArbEntryGate: parseStatArbEntryGateFromUnknown(settingsRaw.statArbEntryGate) }
        : {}),
      ...(settingsRaw.enablePairLock === true ? { enablePairLock: true } : {}),
      ...(settingsRaw.dcaEnabled === true ? { dcaEnabled: true } : {}),
      ...(Array.isArray(settingsRaw.dcaMarkets)
        ? {
          dcaMarkets: Array.from(new Set(
            settingsRaw.dcaMarkets.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean),
          )),
        }
        : {}),
      ...(typeof settingsRaw.dcaInterval === 'string' && settingsRaw.dcaInterval.trim()
        ? { dcaInterval: settingsRaw.dcaInterval.trim() }
        : {}),
      ...(Number.isFinite(Number(settingsRaw.dcaStepPercent))
        ? { dcaStepPercent: Number(settingsRaw.dcaStepPercent) }
        : {}),
      ...(Number.isFinite(Number(settingsRaw.dcaTpPercent))
        ? { dcaTpPercent: Number(settingsRaw.dcaTpPercent) }
        : {}),
      ...(Number.isFinite(Number(settingsRaw.dcaMaxOrders))
        ? { dcaMaxOrders: Math.max(0, Math.floor(Number(settingsRaw.dcaMaxOrders))) }
        : {}),
      ...(typeof settingsRaw.dcaBaseAmountMode === 'string' && settingsRaw.dcaBaseAmountMode.trim()
        ? { dcaBaseAmountMode: settingsRaw.dcaBaseAmountMode.trim() }
        : {}),
      ...(Number.isFinite(Number(settingsRaw.dcaBaseAmountPercent))
        ? { dcaBaseAmountPercent: Number(settingsRaw.dcaBaseAmountPercent) }
        : {}),
      ...(settingsRaw.dcaAutotune === true ? { dcaAutotune: true } : {}),
      ...(typeof settingsRaw.preset === 'string' && settingsRaw.preset.trim()
        ? { preset: settingsRaw.preset.trim() }
        : {}),
      ...(settingsRaw.lotPercentMultiplierByStrategyId
        && typeof settingsRaw.lotPercentMultiplierByStrategyId === 'object'
        ? {
          lotPercentMultiplierByStrategyId: Object.fromEntries(
            Object.entries(settingsRaw.lotPercentMultiplierByStrategyId as Record<string, unknown>)
              .map(([k, v]) => [String(k), Number(asNumber(v, 0))] as const)
              .filter(([, v]) => Number.isFinite(v) && v > 0),
          ),
        }
        : {}),
      ...(parsePortfolioCircuitBreaker(settingsRaw.portfolioCircuitBreaker)
        ? { portfolioCircuitBreaker: parsePortfolioCircuitBreaker(settingsRaw.portfolioCircuitBreaker) as PortfolioCircuitBreakerConfig }
        : {}),
    },
    ...(parsed.macroShield === true || settingsRaw.macroShield === true ? { macroShield: true } : {}),
    ...(Array.isArray(parsed.dcaMarkets)
      ? {
        dcaMarkets: Array.from(new Set(
          parsed.dcaMarkets.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean),
        )),
      }
      : {}),
    ...(dcaLayerParsed ? { dcaLayer: dcaLayerParsed } : {}),
    updatedAt: asString(parsed.updatedAt, new Date().toISOString()),
  };
};

const getTsBacktestSnapshots = async (): Promise<Record<string, TsBacktestSnapshot>> => {
  const raw = safeJsonParse<Record<string, unknown>>(
    await getRuntimeFlag('offer.store.ts_backtest_snapshots', '{}'),
    {}
  );
  const out: Record<string, TsBacktestSnapshot> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const normalizedKey = normalizeTsSnapshotMapKey(key);
    if (!normalizedKey) {
      continue;
    }
    const snapshot = normalizeTsBacktestSnapshot(value);
    if (snapshot) {
      out[normalizedKey] = snapshot;
    }
  }
  return out;
};

const getTsBacktestSnapshot = async (): Promise<TsBacktestSnapshot | null> => {
  const raw = safeJsonParse<Record<string, unknown> | null>(
    await getRuntimeFlag('offer.store.ts_backtest_snapshot', 'null'),
    null,
  );
  return normalizeTsBacktestSnapshot(raw);
};

const normalizeAdminReportSettings = (raw: unknown): AdminReportSettings => {
  const parsed = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  type AdminReportBooleanKey =
    | 'enabled'
    | 'tsDaily'
    | 'tsWeekly'
    | 'tsMonthly'
    | 'offerDaily'
    | 'offerWeekly'
    | 'offerMonthly'
    | 'sweepSnapshotAutoRefreshEnabled'
    | 'watchdogEnabled';
  const pick = (key: AdminReportBooleanKey): boolean => {
    const value = parsed[key];
    if (value === undefined || value === null || value === '') {
      return DEFAULT_ADMIN_REPORT_SETTINGS[key];
    }
    if (typeof value === 'boolean') {
      return value;
    }
    const text = String(value).trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
  };

  const refreshHoursRaw = asNumber(
    parsed.sweepSnapshotRefreshHours,
    DEFAULT_ADMIN_REPORT_SETTINGS.sweepSnapshotRefreshHours,
  );
  const refreshHours = Math.max(1, Math.min(168, Math.floor(refreshHoursRaw)));

  return {
    enabled: pick('enabled'),
    tsDaily: pick('tsDaily'),
    tsWeekly: pick('tsWeekly'),
    tsMonthly: pick('tsMonthly'),
    offerDaily: pick('offerDaily'),
    offerWeekly: pick('offerWeekly'),
    offerMonthly: pick('offerMonthly'),
    sweepSnapshotAutoRefreshEnabled: pick('sweepSnapshotAutoRefreshEnabled'),
    sweepSnapshotRefreshHours: refreshHours,
    watchdogEnabled: pick('watchdogEnabled'),
  };
};

const normalizeOfferStoreLabel = (value: unknown): OfferStoreLabel | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'research_catalog' || normalized === 'runtime_snapshot' || normalized === 'fallback_preset') {
    return normalized;
  }
  return null;
};

const deriveOfferStoreLabels = (args: {
  labels?: Record<string, unknown> | null;
  curatedOfferIds?: string[];
  publishedOfferIds?: string[];
  existingOfferIds?: Set<string>;
}): Record<string, OfferStoreLabel> => {
  const result: Record<string, OfferStoreLabel> = {};
  const existingIds = args.existingOfferIds || null;

  for (const [offerIdRaw, labelRaw] of Object.entries(args.labels || {})) {
    const offerId = String(offerIdRaw || '').trim();
    const label = normalizeOfferStoreLabel(labelRaw);
    if (!offerId || !label) {
      continue;
    }
    if (existingIds && !existingIds.has(offerId)) {
      continue;
    }
    result[offerId] = label;
  }

  for (const offerIdRaw of args.publishedOfferIds || []) {
    const offerId = String(offerIdRaw || '').trim();
    if (!offerId || (existingIds && !existingIds.has(offerId))) {
      continue;
    }
    if (!result[offerId]) {
      result[offerId] = 'runtime_snapshot';
    }
  }

  for (const offerIdRaw of args.curatedOfferIds || []) {
    const offerId = String(offerIdRaw || '').trim();
    if (!offerId || (existingIds && !existingIds.has(offerId))) {
      continue;
    }
    result[offerId] = 'runtime_snapshot';
  }

  return result;
};

const getStorefrontOfferIds = (offerStore: Pick<OfferStoreState, 'publishedOfferIds' | 'curatedOfferIds' | 'labels' | 'tsBacktestSnapshots'>): Set<string> => {
  const tsOfferIds = new Set<string>();
  Object.values(offerStore.tsBacktestSnapshots || {}).forEach((snap) => {
    (Array.isArray(snap?.offerIds) ? snap.offerIds : []).forEach((offerId) => {
      const safe = String(offerId || '').trim();
      if (safe) tsOfferIds.add(safe);
    });
  });
  const runtimeSnapshotIds = Object.entries(offerStore.labels || {})
    .filter(([, label]) => normalizeOfferStoreLabel(label) === 'runtime_snapshot')
    .map(([offerId]) => String(offerId || '').trim())
    .filter(Boolean);
  if (runtimeSnapshotIds.length > 0) {
    runtimeSnapshotIds.forEach((id) => tsOfferIds.add(id));
    return new Set(tsOfferIds);
  }
  const curatedIds = Array.isArray(offerStore.curatedOfferIds)
    ? offerStore.curatedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const publishedIds = Array.isArray(offerStore.publishedOfferIds)
    ? offerStore.publishedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const base = publishedIds.length > 0 ? publishedIds : curatedIds;
  base.forEach((id) => tsOfferIds.add(id));
  return tsOfferIds;
};

const isEligibleStorefrontOffer = (offer: {
  ret?: number;
  pf?: number;
  trades?: number;
} | null | undefined): boolean => {
  if (!offer) {
    return false;
  }
  const rawReturn = asNumber(offer.ret, 0);
  const normalizedReturnPercent = Math.abs(rawReturn) <= 1 ? rawReturn * 100 : rawReturn;
  return normalizedReturnPercent >= MIN_STOREFRONT_RETURN_PERCENT
    && asNumber(offer.pf, 0) >= MIN_STOREFRONT_PROFIT_FACTOR
    && Math.floor(asNumber(offer.trades, 0)) >= MIN_STOREFRONT_TRADES;
};

const preferSnapshotMetric = (
  snapshotValue: unknown,
  fallbackValue: unknown,
  options?: { allowZero?: boolean }
): number => {
  const resolvedFallback = asNumber(fallbackValue, 0);
  const resolvedSnapshot = Number(snapshotValue);
  if (!Number.isFinite(resolvedSnapshot)) {
    return resolvedFallback;
  }
  if (options?.allowZero) {
    return resolvedSnapshot;
  }
  return resolvedSnapshot > 0 ? resolvedSnapshot : resolvedFallback;
};

const filterCatalogByStorefrontOfferIds = (catalog: CatalogData | null, storefrontIds: Set<string>): CatalogData | null => {
  if (!catalog) {
    return null;
  }
  if (storefrontIds.size === 0) {
    return catalog;
  }
  const mono = (catalog.clientCatalog?.mono || []).filter((item) => storefrontIds.has(String(item.offerId)));
  const synth = (catalog.clientCatalog?.synth || []).filter((item) => storefrontIds.has(String(item.offerId)));
  return {
    ...catalog,
    counts: {
      ...catalog.counts,
      monoCatalog: mono.length,
      synthCatalog: synth.length,
    },
    clientCatalog: {
      mono,
      synth,
    },
  };
};

const resolveStrategyPlanLimits = (plan: PlanRow | null) => {
  const features = getPlanFeatures(plan);
  const maxStrategies = Math.max(0, asNumber(plan?.max_strategies_total, 0));
  const monoLimit = Math.max(0, asNumber(features.mono, 0));
  const synthLimit = Math.max(0, asNumber(features.synth, 0));
  const unifiedLimit = Math.max(0, asNumber(features.monoOrSynth, 0));
  const minOffersPerSystemRaw = Math.max(0, Math.floor(asNumber(features.customTsMinOffers, 0)));
  const maxOffersPerSystemRaw = Math.max(0, Math.floor(asNumber(features.customTsMaxOffers, 0)));
  const maxCustomSystemsRaw = Math.max(0, Math.floor(asNumber(features.customTsMaxCount, 0)));
  const fallbackMaxOffers = unifiedLimit > 0
    ? unifiedLimit
    : maxStrategies;
  const maxOffersPerSystem = maxOffersPerSystemRaw > 0 ? maxOffersPerSystemRaw : fallbackMaxOffers;
  const minOffersPerSystem = minOffersPerSystemRaw > 0
    ? Math.min(minOffersPerSystemRaw, maxOffersPerSystem > 0 ? maxOffersPerSystem : minOffersPerSystemRaw)
    : (maxOffersPerSystem >= 2 ? 2 : (maxOffersPerSystem > 0 ? 1 : 0));

  return {
    maxStrategies: maxStrategies > 0 ? maxStrategies : null,
    minOffersPerSystem: minOffersPerSystem > 0 ? minOffersPerSystem : null,
    maxOffersPerSystem: maxOffersPerSystem > 0 ? maxOffersPerSystem : null,
    maxCustomSystems: maxCustomSystemsRaw > 0 ? maxCustomSystemsRaw : 1,
    mono: monoLimit > 0 ? monoLimit : null,
    synth: synthLimit > 0 ? synthLimit : null,
    unified: unifiedLimit > 0 ? unifiedLimit : null,
    depositCap: asNumber(plan?.max_deposit_total, 0) > 0 ? asNumber(plan?.max_deposit_total, 0) : null,
    riskCap: asNumber(plan?.risk_cap_max, 0) > 0 ? asNumber(plan?.risk_cap_max, 0) : null,
  };
};

const buildStrategySelectionConstraints = (
  plan: PlanRow | null,
  offers: CatalogOffer[],
): StrategySelectionConstraints => {
  const limits = resolveStrategyPlanLimits(plan);
  const safeOffers = Array.isArray(offers) ? offers : [];
  const selected = safeOffers.length;
  const mono = safeOffers.filter((item) => asString(item.strategy?.mode, 'mono') === 'mono').length;
  const synth = safeOffers.filter((item) => asString(item.strategy?.mode, 'mono') !== 'mono').length;
  const uniqueMarkets = new Set(
    safeOffers.map((item) => asString(item.strategy?.market, '')).filter(Boolean)
  ).size;
  const estimatedDepositPerStrategy = limits.depositCap && selected > 0
    ? Number((limits.depositCap / selected).toFixed(2))
    : null;

  const violations: string[] = [];
  const warnings: string[] = [];

  const hardLimitBase = limits.unified ?? limits.maxStrategies;
  const hardLimit = hardLimitBase !== null && limits.maxOffersPerSystem !== null
    ? Math.min(hardLimitBase, limits.maxOffersPerSystem)
    : (hardLimitBase ?? limits.maxOffersPerSystem);

  if (limits.minOffersPerSystem !== null && selected > 0 && selected < limits.minOffersPerSystem) {
    violations.push(`At least ${limits.minOffersPerSystem} offers are required to build a custom TS.`);
  }
  if (hardLimit !== null && selected > hardLimit) {
    violations.push(`Too many offers selected (${selected}/${hardLimit}).`);
  }
  if (limits.mono !== null && mono > limits.mono) {
    violations.push(`Mono offers exceed plan limit (${mono}/${limits.mono}).`);
  }
  if (limits.synth !== null && synth > limits.synth) {
    violations.push(`Synthetic offers exceed plan limit (${synth}/${limits.synth}).`);
  }

  if (selected > 1 && uniqueMarkets < selected) {
    warnings.push('Selection contains repeated markets; diversification is lower than it looks.');
  }
  if (selected > 1 && (mono === 0 || synth === 0)) {
    warnings.push('Selection is concentrated in one mode only (mono or synth).');
  }
  if (estimatedDepositPerStrategy !== null && estimatedDepositPerStrategy < 250) {
    warnings.push(`Estimated deposit per strategy is thin (${estimatedDepositPerStrategy} USDT).`);
  }

  return {
    limits: {
      maxStrategies: hardLimit,
      minOffersPerSystem: limits.minOffersPerSystem,
      maxOffersPerSystem: limits.maxOffersPerSystem,
      maxCustomSystems: limits.maxCustomSystems,
      mono: limits.mono,
      synth: limits.synth,
      depositCap: limits.depositCap,
      riskCap: limits.riskCap,
    },
    usage: {
      selected,
      mono,
      synth,
      uniqueMarkets,
      remainingSlots: hardLimit !== null ? Math.max(0, hardLimit - selected) : null,
      currentCustomSystems: selected > 0 ? 1 : 0,
      remainingCustomSystems: limits.maxCustomSystems !== null
        ? Math.max(0, limits.maxCustomSystems - (selected > 0 ? 1 : 0))
        : null,
      estimatedDepositPerStrategy,
    },
    violations,
    warnings,
  };
};

const buildAlgofundPortfolioPassport = (
  catalog: CatalogData | null,
  sweep: SweepData | null,
  period: PeriodInfo | null,
  preview: {
    summary?: Record<string, unknown> | null;
    blockedReason?: string;
  } | null,
  riskMultiplier: number,
): AlgofundPortfolioPassport | null => {
  const members = Array.isArray(catalog?.adminTradingSystemDraft?.members)
    ? catalog?.adminTradingSystemDraft?.members || []
    : [];

  if (members.length === 0) {
    return null;
  }

  const candidates = members.map((member) => {
    const record = sweep ? findSweepRecordByStrategyId(sweep, Number(member.strategyId)) : null;
    return {
      strategyId: Number(member.strategyId),
      strategyName: asString(member.strategyName, `Strategy ${member.strategyId}`),
      strategyType: asString(member.strategyType, record?.strategyType || 'DD_BattleToads'),
      marketMode: asString(member.marketMode, record?.marketMode || 'mono'),
      market: asString(member.market, record?.market || ''),
      weight: Number(asNumber(member.weight, 1).toFixed(4)),
      score: Number(asNumber(member.score, record?.score || 0).toFixed(3)),
      metrics: {
        ret: Number(asNumber(record?.totalReturnPercent, 0).toFixed(3)),
        pf: Number(asNumber(record?.profitFactor, 0).toFixed(3)),
        dd: Number(asNumber(record?.maxDrawdownPercent, 0).toFixed(3)),
        wr: Number(asNumber(record?.winRatePercent, 0).toFixed(3)),
        trades: Math.max(0, Math.floor(asNumber(record?.tradesCount, 0))),
      },
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    source: 'admin_trading_system_draft',
    selectionPolicy: riskMultiplier <= 0.9 ? 'conservative' : riskMultiplier >= 1.5 ? 'aggressive' : 'balanced',
    period,
    candidates,
    portfolioSummary: preview?.summary
      ? {
          initialBalance: asNumber(preview.summary.initialBalance, undefined as unknown as number),
          finalEquity: asNumber(preview.summary.finalEquity, undefined as unknown as number),
          totalReturnPercent: asNumber(preview.summary.totalReturnPercent, undefined as unknown as number),
          maxDrawdownPercent: asNumber(preview.summary.maxDrawdownPercent, undefined as unknown as number),
          winRatePercent: asNumber(preview.summary.winRatePercent, undefined as unknown as number),
          profitFactor: asNumber(preview.summary.profitFactor, undefined as unknown as number),
          tradesCount: asNumber(preview.summary.tradesCount, undefined as unknown as number),
        }
      : null,
    blockedReasons: preview?.blockedReason ? [String(preview.blockedReason)] : [],
  };
};

const buildFallbackCatalogFromPresets = async (
  sourceCatalog: CatalogData | null,
  apiKeys: string[]
): Promise<CatalogData> => {
  void apiKeys;
  const offers = await buildPresetBackedOffers(sourceCatalog);
  const mono = offers.filter((item) => item.strategy.mode === 'mono');
  const synth = offers.filter((item) => item.strategy.mode !== 'mono');
  const topMembers = [...offers]
    .sort((left, right) => asNumber(right.metrics?.score, 0) - asNumber(left.metrics?.score, 0))
    .slice(0, 6)
    .map((offer, index) => ({
      strategyId: asNumber(offer.strategy?.id, index + 1),
      strategyName: asString(offer.strategy?.name, `Preset ${index + 1}`),
      strategyType: asString(offer.strategy?.type, 'DD_BattleToads'),
      marketMode: asString(offer.strategy?.mode, 'mono'),
      market: asString(offer.strategy?.market, '-'),
      score: asNumber(offer.metrics?.score, 0),
      weight: Number((1 / Math.max(1, Math.min(6, offers.length))).toFixed(4)),
    }));

  // Preserve original draft from sourceCatalog if available
  const originalDraft = sourceCatalog?.adminTradingSystemDraft;
  const shouldUseOriginalDraft = originalDraft && 
    Array.isArray(originalDraft.members) && 
    originalDraft.members.length > 0 &&
    originalDraft.name && 
    !originalDraft.name.includes('fallback');

  return {
    timestamp: new Date().toISOString(),
    apiKeyName: '',
    source: {
      sweepFile: sourceCatalog?.source?.sweepFile || 'fallback:sweep+preset-db',
      sweepTimestamp: sourceCatalog?.source?.sweepTimestamp || null,
    },
    counts: {
      evaluated: offers.length,
      robust: offers.length,
      monoCatalog: mono.length,
      synthCatalog: synth.length,
      adminTsMembers: topMembers.length,
      durationSec: 0,
    },
    clientCatalog: {
      mono,
      synth,
    },
    adminTradingSystemDraft: shouldUseOriginalDraft
      ? originalDraft
      : {
          name: 'SAAS Admin TS (fallback)',
          members: topMembers,
          sourcePortfolioSummary: [],
        },
  };
};

const buildFallbackSweepSummary = (catalog: CatalogData | null) => {
  const offers = catalog ? getAllOffers(catalog) : [];
  const nowIso = new Date().toISOString();

  return {
    timestamp: nowIso,
    period: null,
    counts: {
      potentialRuns: offers.length,
      scheduledRuns: offers.length,
      coveragePercent: 100,
      evaluated: offers.length,
      failures: 0,
      robust: offers.length,
      resumedFromCheckpoint: false,
      skippedFromCheckpoint: 0,
      resumedFromLog: false,
      importedFromLog: 0,
      logImportMissingStrategyIds: 0,
      durationSec: 0,
    },
    selectedMembers: [],
    topByMode: {
      mono: [],
      synth: [],
    },
    topAll: [],
    portfolioFull: null,
  };
};

const resolveSweepSelectedMembers = (sweep: SweepData | null, catalog: CatalogData | null): SweepRecord[] => {
  const explicitMembers = Array.isArray(sweep?.selectedMembers)
    ? sweep.selectedMembers.filter((item): item is SweepRecord => Boolean(item && Number(item.strategyId || 0) > 0))
    : [];
  if (explicitMembers.length > 0) {
    return explicitMembers;
  }

  const strategyIds = Array.from(new Set([
    ...((catalog?.adminTradingSystemDraft?.members || []).map((member) => Number(member.strategyId || 0))),
    ...((sweep?.tradingSystem?.members || []).map((member) => Number(member.strategy_id || 0))),
  ].filter((item) => Number.isFinite(item) && item > 0)));

  return strategyIds
    .map((strategyId) => findSweepRecordByStrategyId(sweep, strategyId))
    .filter((item): item is SweepRecord => Boolean(item));
};

const buildFallbackSweepRecordFromOffer = (offer: CatalogOffer): SweepRecord | null => {
  const strategyId = Number(offer?.strategy?.id || 0);
  if (!Number.isFinite(strategyId) || strategyId <= 0) {
    return null;
  }

  const strategyParams = offer.strategy?.params || {
    interval: '4h',
    length: 50,
    takeProfitPercent: 0,
    detectionSource: 'close',
    zscoreEntry: 2,
    zscoreExit: 0.5,
    zscoreStop: 3,
  };

  return {
    strategyId,
    strategyName: asString(offer.strategy?.name, `Strategy ${strategyId}`),
    strategyType: asString(offer.strategy?.type, 'DD_BattleToads'),
    marketMode: offer.strategy?.mode === 'mono' ? 'mono' : 'synthetic',
    market: asString(offer.strategy?.market, ''),
    interval: asString(strategyParams.interval, '4h'),
    length: asNumber(strategyParams.length, 50),
    takeProfitPercent: asNumber(strategyParams.takeProfitPercent, 0),
    detectionSource: asString(strategyParams.detectionSource, 'close'),
    zscoreEntry: asNumber(strategyParams.zscoreEntry, 2),
    zscoreExit: asNumber(strategyParams.zscoreExit, 0.5),
    zscoreStop: asNumber(strategyParams.zscoreStop, 3),
    totalReturnPercent: asNumber(offer.metrics?.ret, 0),
    maxDrawdownPercent: asNumber(offer.metrics?.dd, 0),
    winRatePercent: asNumber(offer.metrics?.wr, 0),
    profitFactor: asNumber(offer.metrics?.pf, 1),
    tradesCount: Math.max(0, Math.floor(asNumber(offer.metrics?.trades, 0))),
    score: asNumber(offer.metrics?.score, 0),
    robust: offer.metrics?.robust !== false,
  };
};

const buildFallbackSweepData = (catalog: CatalogData | null): SweepData | null => {
  const offers = catalog ? getAllOffers(catalog) : [];
  const evaluated = offers
    .map((offer) => buildFallbackSweepRecordFromOffer(offer))
    .filter((item): item is SweepRecord => !!item)
    .sort((left, right) => asNumber(right.score, 0) - asNumber(left.score, 0));

  if (evaluated.length === 0) {
    return null;
  }

  const topAll = evaluated.slice(0, 24);
  const mono = topAll.filter((item) => asString(item.marketMode) === 'mono');
  const synth = topAll.filter((item) => asString(item.marketMode) !== 'mono');
  const draftMembers = catalog?.adminTradingSystemDraft?.members || [];
  const draftWeights = new Map<number, number>();
  draftMembers.forEach((member) => {
    draftWeights.set(Number(member.strategyId), asNumber(member.weight, 0));
  });
  const selectedMembers = draftMembers
    .map((member) => evaluated.find((row) => Number(row.strategyId) === Number(member.strategyId)) || null)
    .filter((row): row is SweepRecord => !!row);

  return {
    timestamp: new Date().toISOString(),
    apiKeyName: asString(catalog?.apiKeyName, ''),
    counts: {
      potentialRuns: evaluated.length,
      scheduledRuns: evaluated.length,
      coveragePercent: 100,
      evaluated: evaluated.length,
      failures: 0,
      robust: evaluated.filter((item) => item.robust).length,
      resumedFromCheckpoint: false,
      skippedFromCheckpoint: 0,
      resumedFromLog: false,
      importedFromLog: 0,
      logImportMissingStrategyIds: 0,
      durationSec: 0,
    },
    topAll,
    topByMode: {
      mono,
      synth,
    },
    selectedMembers,
    tradingSystem: {
      id: 0,
      name: asString(catalog?.adminTradingSystemDraft?.name, 'SAAS Admin TS (fallback)'),
      members: selectedMembers.map((item, index) => ({
        strategy_id: Number(item.strategyId),
        weight: Number(asNumber(draftWeights.get(Number(item.strategyId)), index === 0 ? 1 : 0.8).toFixed(4)),
        member_role: index < 3 ? 'core' : 'satellite',
        is_enabled: true,
        notes: 'fallback sweep',
      })),
    },
    portfolioResults: [],
    evaluated,
    config: {
      initialBalance: 10000,
      backtestBars: 6000,
      warmupBars: 400,
      skipMissingSymbols: true,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      fundingRatePercent: 0,
      dateFrom: '2024-06-01',
    },
  };
};

let _catalogCache: { catalog: CatalogData | null; sweep: SweepData | null } | null = null;
let _catalogCacheAt = 0;

export const loadCatalogAndSweepWithFallback = async (): Promise<{ catalog: CatalogData | null; sweep: SweepData | null }> => {
  const now = Date.now();
  if (_catalogCache && (now - _catalogCacheAt) < 60_000) {
    return { catalog: _catalogCache.catalog, sweep: _catalogCache.sweep };
  }

  if (!db) {
    await initDB();
  }

  const sourceStatus = getLatestResearchArtifactsStatus();
  const sourceCatalog = sourceStatus.catalogFresh ? loadLatestClientCatalog() : null;
  const diskSweep = loadLatestSweep();
  const sourceSweep = sourceStatus.sweepFresh ? diskSweep : null;
  const fallbackCatalog = await buildFallbackCatalogFromPresets(sourceCatalog, []);
  const sourceCatalogHasOffers = catalogHasOffers(sourceCatalog);
  const catalog = sourceCatalogHasOffers
    ? sourceCatalog
    : (catalogHasOffers(fallbackCatalog) ? fallbackCatalog : sourceCatalog || fallbackCatalog);
  let sweep = sourceSweep || buildFallbackSweepData(catalog);
  // Even when evaluated sweep rows are stale, keep the historical window + bars from the latest on-disk sweep.
  if (diskSweep?.config && sweep) {
    const mergedConfig = {
      ...(sweep.config || {}),
      ...(diskSweep.config || {}),
      dateFrom: asString(diskSweep.config?.dateFrom, asString(sweep.config?.dateFrom, '')),
      dateTo: asString(diskSweep.config?.dateTo, asString(sweep.config?.dateTo, '')),
      backtestBars: asNumber(diskSweep.config?.backtestBars, asNumber(sweep.config?.backtestBars, 6000)),
      warmupBars: asNumber(diskSweep.config?.warmupBars, asNumber(sweep.config?.warmupBars, 400)),
    };
    sweep = { ...sweep, config: mergedConfig };
  }

  if (catalog) {
    const extraRaw = await getRuntimeFlag('admin.catalog.extra_draft_members', '[]');
    const extraMembers = safeJsonParse<CatalogData['adminTradingSystemDraft']['members']>(extraRaw, []);
    if (Array.isArray(extraMembers) && extraMembers.length > 0) {
      const existingIds = new Set((catalog.adminTradingSystemDraft?.members || []).map((m) => m.strategyId));
      const toInject = extraMembers.filter((m) => !existingIds.has(m.strategyId));
      if (toInject.length > 0) {
        catalog.adminTradingSystemDraft = {
          ...catalog.adminTradingSystemDraft,
          members: [...(catalog.adminTradingSystemDraft?.members || []), ...toInject],
        };
      }
    }
  }

  _catalogCache = { catalog, sweep };
  _catalogCacheAt = Date.now();
  return { catalog, sweep };
};

const getAvailableApiKeyNames = async (): Promise<string[]> => {
  const rows = await db.all('SELECT name FROM api_keys ORDER BY id ASC');
  return (Array.isArray(rows) ? rows : []).map((row) => asString((row as { name?: string }).name)).filter(Boolean);
};

const upsertPlan = async (plan: PlanSeed): Promise<void> => {
  await db.run(
    `INSERT INTO plans (
      code, title, product_mode, price_usdt, max_deposit_total, risk_cap_max,
      max_strategies_total, allow_ts_start_stop_requests, features_json, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET
      title = excluded.title,
      product_mode = excluded.product_mode,
      price_usdt = excluded.price_usdt,
      max_deposit_total = excluded.max_deposit_total,
      risk_cap_max = excluded.risk_cap_max,
      max_strategies_total = excluded.max_strategies_total,
      allow_ts_start_stop_requests = excluded.allow_ts_start_stop_requests,
      features_json = excluded.features_json,
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP`,
    [
      plan.code,
      plan.title,
      plan.productMode,
      plan.priceUsdt,
      plan.maxDepositTotal,
      plan.riskCapMax,
      plan.maxStrategiesTotal,
      plan.allowTsStartStopRequests ? 1 : 0,
      JSON.stringify(plan.features || {}),
    ]
  );
};

const getPlanByCode = async (code: string): Promise<PlanRow> => {
  const row = await db.get('SELECT * FROM plans WHERE code = ?', [code]);
  if (!row) {
    throw new Error(`Plan not found: ${code}`);
  }
  return row as PlanRow;
};

const listPlans = async (): Promise<PlanRow[]> => {
  const rows = await db.all(
    'SELECT * FROM plans WHERE is_active = 1 ORDER BY product_mode ASC, price_usdt ASC, id ASC'
  );
  return (Array.isArray(rows) ? rows : []) as PlanRow[];
};

const ensureTenant = async (slug: string, displayName: string, productMode: ProductMode, language: string, assignedApiKeyName: string): Promise<TenantRow> => {
  await db.run(
    `INSERT INTO tenants (slug, display_name, product_mode, status, preferred_language, assigned_api_key_name, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(slug) DO UPDATE SET
       preferred_language = CASE WHEN COALESCE(tenants.preferred_language, '') = '' THEN excluded.preferred_language ELSE tenants.preferred_language END,
       assigned_api_key_name = CASE WHEN COALESCE(tenants.assigned_api_key_name, '') = '' THEN excluded.assigned_api_key_name ELSE tenants.assigned_api_key_name END,
       updated_at = CURRENT_TIMESTAMP`,
    [slug, displayName, productMode, language, assignedApiKeyName]
  );

  const row = await db.get('SELECT * FROM tenants WHERE slug = ?', [slug]);
  if (!row) {
    throw new Error(`Failed to ensure tenant: ${slug}`);
  }
  return row as TenantRow;
};

const ensureSubscription = async (tenantId: number, planId: number, planMode?: string): Promise<void> => {
  if (planMode) {
    const existing = await db.get(
      `SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ? AND p.product_mode = ? ORDER BY s.id DESC LIMIT 1`,
      [tenantId, planMode]
    );
    if (!existing) {
      await db.run(
        `INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at)
         VALUES (?, ?, 'active', CURRENT_TIMESTAMP, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [tenantId, planId]
      );
    }
    return;
  }
  const row = await db.get('SELECT id FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [tenantId]);
  if (!row) {
    await db.run(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at)
       VALUES (?, ?, 'active', CURRENT_TIMESTAMP, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId, planId]
    );
  }
};

const setTenantSubscriptionPlan = async (tenantId: number, planId: number, planMode?: string): Promise<void> => {
  if (planMode) {
    const modeRow = await db.get(
      `SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ? AND p.product_mode = ? ORDER BY s.id DESC LIMIT 1`,
      [tenantId, planMode]
    );
    if (modeRow) {
      await db.run(
        `UPDATE subscriptions SET plan_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [planId, Number((modeRow as { id: number }).id)]
      );
      return;
    }
    await db.run(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at)
       VALUES (?, ?, 'active', CURRENT_TIMESTAMP, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId, planId]
    );
    return;
  }
  const row = await db.get('SELECT id FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [tenantId]);
  if (!row) {
    await db.run(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at)
       VALUES (?, ?, 'active', CURRENT_TIMESTAMP, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId, planId]
    );
    return;
  }
  await db.run(
    `UPDATE subscriptions SET plan_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [planId, Number((row as { id: number }).id)]
  );
};

const ensureStrategyClientProfile = async (tenantId: number, offerIds: string[], assignedApiKeyName: string): Promise<void> => {
  await db.run(
    `INSERT INTO strategy_client_profiles (
      tenant_id, selected_offer_ids_json, risk_level, trade_frequency_level,
      requested_enabled, actual_enabled, assigned_api_key_name, latest_preview_json, created_at, updated_at
    ) VALUES (?, ?, 'medium', 'medium', 0, 0, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      selected_offer_ids_json = CASE WHEN COALESCE(strategy_client_profiles.selected_offer_ids_json, '[]') = '[]' THEN excluded.selected_offer_ids_json ELSE strategy_client_profiles.selected_offer_ids_json END,
      assigned_api_key_name = CASE WHEN COALESCE(strategy_client_profiles.assigned_api_key_name, '') = '' THEN excluded.assigned_api_key_name ELSE strategy_client_profiles.assigned_api_key_name END,
      updated_at = CURRENT_TIMESTAMP`,
    [tenantId, JSON.stringify(offerIds), assignedApiKeyName]
  );
};

const ensureAlgofundProfile = async (tenantId: number, assignedApiKeyName: string): Promise<void> => {
  await db.run(
    `INSERT INTO algofund_profiles (
      tenant_id, risk_multiplier, requested_enabled, actual_enabled, assigned_api_key_name, execution_api_key_name,
      published_system_name, latest_preview_json, created_at, updated_at
    ) VALUES (?, 1, 0, 0, ?, ?, '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      assigned_api_key_name = CASE WHEN COALESCE(algofund_profiles.assigned_api_key_name, '') = '' THEN excluded.assigned_api_key_name ELSE algofund_profiles.assigned_api_key_name END,
      execution_api_key_name = CASE WHEN COALESCE(algofund_profiles.execution_api_key_name, '') = '' THEN excluded.execution_api_key_name ELSE algofund_profiles.execution_api_key_name END,
      updated_at = CURRENT_TIMESTAMP`,
    [tenantId, assignedApiKeyName, assignedApiKeyName]
  );
};

const ensureCopytradingProfile = async (tenantId: number, assignedApiKeyName: string): Promise<void> => {
  await db.run(
    `INSERT INTO copytrading_profiles (
      tenant_id, master_api_key_name, master_name, master_tags,
      tenants_json, copy_algorithm, copy_precision, copy_ratio, copy_enabled, created_at, updated_at
    ) VALUES (?, ?, '', 'copytrading-master', '[]', 'vwap_basic', 'standard', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      master_api_key_name = CASE WHEN COALESCE(copytrading_profiles.master_api_key_name, '') = '' THEN excluded.master_api_key_name ELSE copytrading_profiles.master_api_key_name END,
      updated_at = CURRENT_TIMESTAMP`,
    [tenantId, assignedApiKeyName]
  );
};

const scoreOffer = (offer: CatalogOffer): number => asNumber(offer?.metrics?.score, 0);

const buildRecommendedSets = (catalog: CatalogData | null) => {
  if (!catalog) {
    return {
      balancedBot: [] as CatalogOffer[],
      conservativeBot: [] as CatalogOffer[],
      monoStarter: [] as CatalogOffer[],
      synthStarter: [] as CatalogOffer[],
      premiumMix: [] as CatalogOffer[],
    };
  }

  const mono = [...(catalog.clientCatalog.mono || [])];
  const synth = [...(catalog.clientCatalog.synth || [])];
  const all = [...mono, ...synth].sort((left, right) => scoreOffer(right) - scoreOffer(left));
  const conservative = [...all].sort((left, right) => asNumber(left.metrics.dd, 0) - asNumber(right.metrics.dd, 0));
  const momentum = [...all].sort((left, right) => asNumber(right.metrics.ret, 0) - asNumber(left.metrics.ret, 0));
  const takeUniqueMarkets = (source: CatalogOffer[], limit: number): CatalogOffer[] => {
    const out: CatalogOffer[] = [];
    const seenMarkets = new Set<string>();
    for (const offer of source) {
      const market = asString(offer?.strategy?.market, '');
      if (market && seenMarkets.has(market)) {
        continue;
      }
      out.push(offer);
      if (market) {
        seenMarkets.add(market);
      }
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  };

  const balancedBot: CatalogOffer[] = [];
  if (mono[0]) balancedBot.push(mono[0]);
  if (synth[0]) balancedBot.push(synth[0]);
  for (const offer of all) {
    if (balancedBot.length >= 3) break;
    if (!balancedBot.find((item) => item.offerId === offer.offerId)) {
      balancedBot.push(offer);
    }
  }

  const premiumMix = takeUniqueMarkets(all, 6);

  return {
    balancedBot: takeUniqueMarkets(balancedBot, 3),
    conservativeBot: takeUniqueMarkets(conservative, 3),
    monoStarter: takeUniqueMarkets(mono, 3),
    synthStarter: takeUniqueMarkets(synth, 3),
    momentumBot: takeUniqueMarkets(momentum, 3),
    premiumMix,
  };
};

export const ensureSaasSeedData = async (): Promise<void> => {
  await db.run(`ALTER TABLE plans ADD COLUMN original_price_usdt REAL DEFAULT NULL`).catch(() => { /* already exists */ });
  for (const plan of [...strategyClientPlans, ...algofundPlans, ...copytradingPlans, ...combinedPlans]) {
    await upsertPlan(plan);
  }

  for (const code of LEGACY_DISABLED_PLAN_CODES) {
    await db.run('UPDATE plans SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE code = ?', [code]);
  }

  for (const [code, originalPrice] of Object.entries(PLAN_ORIGINAL_PRICE_BY_CODE)) {
    await db.run(
      `UPDATE plans
       SET original_price_usdt = ?, updated_at = CURRENT_TIMESTAMP
       WHERE code = ? AND (original_price_usdt IS NULL OR original_price_usdt <= 0)`,
      [originalPrice, code]
    );
  }

  const migrationStateRaw = await getRuntimeFlag(SAAS_DUAL_MAX_MIGRATION_FLAG, '');
  if (!migrationStateRaw) {
    const strategyMax = await getPlanByCode('strategy_100');
    const algofundMax = await getPlanByCode('algofund_100');
    const tenants = await db.all('SELECT id, product_mode FROM tenants') as Array<{ id: number; product_mode: ProductMode }>;

    let migratedTenants = 0;
    for (const tenant of tenants || []) {
      const tenantId = Number(tenant.id || 0);
      if (!tenantId) {
        continue;
      }

      const mode = String(tenant.product_mode || '').trim() as ProductMode;
      if (mode === 'strategy_client') {
        await setTenantSubscriptionPlan(tenantId, strategyMax.id);
        migratedTenants += 1;
        continue;
      }

      if (mode === 'algofund_client') {
        await setTenantSubscriptionPlan(tenantId, algofundMax.id);
        migratedTenants += 1;
        continue;
      }

      if (mode === 'dual') {
        await ensureSubscription(tenantId, strategyMax.id, 'strategy_client');
        await setTenantSubscriptionPlan(tenantId, strategyMax.id, 'strategy_client');
        await ensureSubscription(tenantId, algofundMax.id, 'algofund_client');
        await setTenantSubscriptionPlan(tenantId, algofundMax.id, 'algofund_client');
        migratedTenants += 1;
      }
    }

    await setRuntimeFlag(
      SAAS_DUAL_MAX_MIGRATION_FLAG,
      JSON.stringify({
        version: 1,
        migratedAt: new Date().toISOString(),
        migratedTenants,
      })
    );

    logger.info(`[SaaS] Applied one-time max dual migration: tenants=${migratedTenants}`);
  }

  // Beta: provision TV + copytrading profiles for all active dual/strategy tenants (optional LK flags).
  const betaModesFlag = 'saas.migrations.beta_modes_profiles.v1';
  const betaModesRaw = await getRuntimeFlag(betaModesFlag, '');
  if (!betaModesRaw) {
    const tenants = await db.all(
      `SELECT id FROM tenants WHERE status = 'active' AND product_mode IN ('dual', 'strategy_client')`
    ) as Array<{ id: number }>;
    let n = 0;
    for (const tenant of tenants || []) {
      const tenantId = Number(tenant.id || 0);
      if (!tenantId) continue;
      await db.run(
        `INSERT INTO tv_alerts_profiles (
           tenant_id, default_api_key_name, default_exchange, enabled,
           signal_conflict_mode, global_settings_json, created_at, updated_at
         ) VALUES (?, '', 'bybit', 1, 'wait_close', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(tenant_id) DO NOTHING`,
        [tenantId]
      );
      await db.run(
        `INSERT INTO copytrading_profiles (
           tenant_id, master_api_key_name, master_name, master_tags,
           tenants_json, copy_algorithm, copy_precision, copy_ratio, copy_enabled, created_at, updated_at
         ) VALUES (?, '', '', 'copytrading-master', '[]', 'vwap_basic', 'standard', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(tenant_id) DO NOTHING`,
        [tenantId]
      );
      n += 1;
    }
    await db.run(`UPDATE plans SET price_usdt = 0, updated_at = CURRENT_TIMESTAMP WHERE code = 'copytrading_100'`);
    await setRuntimeFlag(betaModesFlag, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), tenants: n }));
    logger.info(`[SaaS] Beta modes profiles provisioned: tenants=${n}`);
  }
};

const getPlanForTenant = async (tenantId: number, planMode?: 'strategy_client' | 'algofund_client'): Promise<PlanRow | null> => {
  if (planMode) {
    // Mode-specific: find subscription whose plan matches the requested mode
    const row = await db.get(
      `SELECT p.*
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = ? AND p.product_mode = ?
       ORDER BY s.id DESC
       LIMIT 1`,
      [tenantId, planMode]
    );
    if (row) return row as PlanRow;
  }
  // Fallback: latest subscription's plan (backward compat)
  const row = await db.get(
    `SELECT p.*
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.tenant_id = ?
     ORDER BY s.id DESC
     LIMIT 1`,
    [tenantId]
  );
  return (row || null) as PlanRow | null;
};

const getTenantById = async (tenantId: number): Promise<TenantRow> => {
  const row = await db.get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  if (!row) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }
  return row as TenantRow;
};

const getStrategyClientProfile = async (tenantId: number): Promise<StrategyClientProfileRow | null> => {
  const row = await db.get('SELECT * FROM strategy_client_profiles WHERE tenant_id = ?', [tenantId]);
  return (row || null) as StrategyClientProfileRow | null;
};

const getStrategyClientCustomTsDraftRow = async (tenantId: number): Promise<StrategyClientCustomTsDraftRow | null> => {
  const row = await db.get('SELECT * FROM strategy_client_custom_ts_drafts WHERE tenant_id = ?', [tenantId]);
  return (row || null) as StrategyClientCustomTsDraftRow | null;
};

const listStrategyClientSystemProfiles = async (tenantId: number): Promise<StrategyClientSystemProfileRow[]> => {
  const rows = await db.all(
    `SELECT *
     FROM strategy_client_system_profiles
     WHERE tenant_id = ?
     ORDER BY is_active DESC, updated_at DESC, id DESC`,
    [tenantId]
  );
  return (Array.isArray(rows) ? rows : []) as StrategyClientSystemProfileRow[];
};

const getStrategyClientSystemProfileById = async (tenantId: number, profileId: number): Promise<StrategyClientSystemProfileRow | null> => {
  const row = await db.get(
    'SELECT * FROM strategy_client_system_profiles WHERE id = ? AND tenant_id = ? LIMIT 1',
    [profileId, tenantId]
  );
  return (row || null) as StrategyClientSystemProfileRow | null;
};

const activateStrategyClientSystemProfile = async (tenantId: number, profileId: number): Promise<void> => {
  await db.run('UPDATE strategy_client_system_profiles SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [tenantId]);
  await db.run('UPDATE strategy_client_system_profiles SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?', [tenantId, profileId]);
  await db.run('UPDATE strategy_client_profiles SET active_system_profile_id = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [profileId, tenantId]);
};

const ensureDefaultStrategyClientSystemProfile = async (tenantId: number, selectedOfferIds: string[]): Promise<StrategyClientSystemProfileRow[]> => {
  const existing = await listStrategyClientSystemProfiles(tenantId);
  if (existing.length > 0) {
    return existing;
  }

  await db.run(
    `INSERT INTO strategy_client_system_profiles (tenant_id, profile_name, selected_offer_ids_json, is_active, created_at, updated_at)
     VALUES (?, 'Custom TS 1', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [tenantId, JSON.stringify(selectedOfferIds || [])]
  );

  const created = await listStrategyClientSystemProfiles(tenantId);
  const active = created.find((item) => Number(item.is_active || 0) === 1) || created[0] || null;
  if (active?.id) {
    await db.run('UPDATE strategy_client_profiles SET active_system_profile_id = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [active.id, tenantId]);
  }
  return created;
};

const syncLegacySelectedOffersFromActiveProfile = async (tenantId: number): Promise<string[]> => {
  const rows = await ensureDefaultStrategyClientSystemProfile(tenantId, []);
  const active = rows.find((item) => Number(item.is_active || 0) === 1) || rows[0] || null;
  const activeOfferIds = active ? safeJsonParse<string[]>(active.selected_offer_ids_json, []) : [];
  await db.run(
    `UPDATE strategy_client_profiles
     SET selected_offer_ids_json = ?, active_system_profile_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [JSON.stringify(activeOfferIds), active?.id || null, tenantId]
  );
  return activeOfferIds;
};

const getAlgofundProfile = async (tenantId: number): Promise<AlgofundProfileRow | null> => {
  const row = await db.get('SELECT * FROM algofund_profiles WHERE tenant_id = ?', [tenantId]);
  return (row || null) as AlgofundProfileRow | null;
};

const getCopytradingProfile = async (tenantId: number): Promise<CopytradingProfileRow | null> => {
  const row = await db.get('SELECT * FROM copytrading_profiles WHERE tenant_id = ?', [tenantId]);
  return (row || null) as CopytradingProfileRow | null;
};

const getAlgofundRequestsByTenant = async (tenantId: number): Promise<AlgofundRequestRow[]> => {
  const rows = await db.all(
    `SELECT
      r.*,
      t.display_name AS tenant_display_name,
      t.slug AS tenant_slug
     FROM algofund_start_stop_requests r
     JOIN tenants t ON t.id = r.tenant_id
     WHERE r.tenant_id = ?
     ORDER BY r.id DESC
     LIMIT 30`,
    [tenantId]
  );
  return (Array.isArray(rows) ? rows : []) as AlgofundRequestRow[];
};

const parseAlgofundRequestPayload = (raw: unknown): AlgofundRequestPayload => {
  if (!raw) {
    return {};
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const targetSystemId = Math.floor(asNumber((parsed as any)?.targetSystemId, 0));
    const targetSystemName = asString((parsed as any)?.targetSystemName, '');
    const targetApiKeyName = asString((parsed as any)?.targetApiKeyName, '');
    const executionApiKeyName = asString((parsed as any)?.executionApiKeyName, '');
    return {
      targetSystemId: targetSystemId > 0 ? targetSystemId : undefined,
      targetSystemName: targetSystemName || undefined,
      targetApiKeyName: targetApiKeyName || undefined,
      executionApiKeyName: executionApiKeyName || undefined,
    };
  } catch {
    return {};
  }
};

const getAlgofundRequestsAll = async (limit: number = 200): Promise<AlgofundRequestRow[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 200;
  const rows = await db.all(
    `SELECT
      r.*,
      t.display_name AS tenant_display_name,
      t.slug AS tenant_slug
     FROM algofund_start_stop_requests r
     JOIN tenants t ON t.id = r.tenant_id
     ORDER BY r.id DESC
     LIMIT ?`,
    [safeLimit]
  );
  return (Array.isArray(rows) ? rows : []) as AlgofundRequestRow[];
};

const findOfferById = (catalog: CatalogData, offerId: string): CatalogOffer => {
  const offer = getAllOffers(catalog).find((item) => item.offerId === offerId);
  if (!offer) {
    throw new Error(`Offer not found: ${offerId}`);
  }
  return offer;
};

const findOfferByIdOrNull = (catalog: CatalogData | null, offerId?: string | null): CatalogOffer | null => {
  if (!catalog || !offerId) {
    return null;
  }

  return getAllOffers(catalog).find((item) => item.offerId === offerId) || null;
};

const readMetric = (
  metrics: Record<string, unknown>,
  keys: string[],
  fallback: number
): number => {
  for (const key of keys) {
    const value = Number(metrics?.[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return fallback;
};

const normalizePresetMetrics = (
  metrics: Record<string, unknown>,
  fallback: CatalogMetricSet & { score?: number }
): CatalogMetricSet & { score: number } => {
  const ret = readMetric(metrics, ['ret', 'total_return_percent', 'totalReturnPercent'], fallback.ret);
  const pf = readMetric(metrics, ['pf', 'profit_factor', 'profitFactor'], fallback.pf);
  const dd = readMetric(metrics, ['dd', 'max_drawdown_percent', 'maxDrawdownPercent'], fallback.dd);
  const wr = readMetric(metrics, ['wr', 'win_rate', 'winRatePercent', 'win_rate_percent'], fallback.wr);
  const trades = readMetric(metrics, ['trades', 'trades_count', 'tradesCount'], fallback.trades);
  const score = readMetric(metrics, ['score'], asNumber(fallback.score, ret));

  return {
    ret,
    pf,
    dd,
    wr,
    trades,
    score,
  };
};

const toCatalogPreset = (
  preset: { config: Record<string, unknown>; metrics: Record<string, unknown> } | null,
  fallback: { strategyId: number; strategyName: string; params: CatalogPreset['params']; metrics: CatalogMetricSet & { score?: number } }
): CatalogPreset | null => {
  if (!preset) {
    return null;
  }

  const config = (preset.config || {}) as Record<string, unknown>;
  const metrics = (preset.metrics || {}) as Record<string, unknown>;
  const normalizedMetrics = normalizePresetMetrics(metrics, fallback.metrics);

  return {
    strategyId: asNumber(config.strategyId, fallback.strategyId),
    strategyName: asString(config.name, fallback.strategyName),
    score: normalizedMetrics.score,
    equity_curve: Array.isArray((preset as any).equity_curve)
      ? (preset as any).equity_curve.map((value: unknown) => asNumber(value, 0))
      : undefined,
    metrics: {
      ret: normalizedMetrics.ret,
      pf: normalizedMetrics.pf,
      dd: normalizedMetrics.dd,
      wr: normalizedMetrics.wr,
      trades: normalizedMetrics.trades,
    },
    params: {
      interval: asString(config.interval, fallback.params.interval),
      length: asNumber(config.price_channel_length, fallback.params.length),
      takeProfitPercent: asNumber(config.take_profit_percent, fallback.params.takeProfitPercent),
      detectionSource: asString(config.detection_source, fallback.params.detectionSource),
      zscoreEntry: asNumber(config.zscore_entry, fallback.params.zscoreEntry),
      zscoreExit: asNumber(config.zscore_exit, fallback.params.zscoreExit),
      zscoreStop: asNumber(config.zscore_stop, fallback.params.zscoreStop),
    },
  };
};

const buildSweepEquityPoints = (retPercent: number): Array<{ time: number; equity: number }> => {
  const start = 10000;
  const end = Number((start * (1 + (Number(retPercent) || 0) / 100)).toFixed(4));
  const now = Date.now();
  return [
    { time: now - 1000, equity: start },
    { time: now, equity: end },
  ];
};

const getSweepRiskMultiplier = (riskLevel: Level3): number => {
  if (riskLevel === 'low') {
    return 0.6;
  }
  if (riskLevel === 'high') {
    return 1.4;
  }
  return 1;
};

const buildSweepFamilyKey = (record: SweepRecord): string => {
  return [
    asString(record.strategyType, ''),
    asString(record.marketMode, ''),
    asString(record.market, ''),
    asString(record.interval, ''),
  ].join('|');
};

const pickFamilyTradePresetRows = (
  anchor: SweepRecord,
  familyRows: SweepRecord[]
): Record<Level3, SweepRecord> => {
  const pool = [...familyRows]
    .filter((row) => Number(row.strategyId || 0) > 0)
    .sort((left, right) => {
      const tradeDiff = asNumber(left.tradesCount, 0) - asNumber(right.tradesCount, 0);
      if (tradeDiff !== 0) {
        return tradeDiff;
      }
      return asNumber(right.score, 0) - asNumber(left.score, 0);
    });

  if (pool.length === 0) {
    return {
      low: anchor,
      medium: anchor,
      high: anchor,
    };
  }

  const anchorStrategyId = Number(anchor.strategyId || 0);
  const medium = pool.find((row) => Number(row.strategyId || 0) === anchorStrategyId) || anchor || pool[Math.floor(pool.length / 2)] || pool[0];

  return {
    low: pool[0],
    medium,
    high: pool[pool.length - 1],
  };
};

const buildSweepPresetFromRecord = (record: SweepRecord, riskLevel: Level3): CatalogPreset => {
  const riskMul = getSweepRiskMultiplier(riskLevel);

  const scoreBase = asNumber(record.score, 0);
  const ret = asNumber(record.totalReturnPercent, 0) * riskMul;
  const dd = asNumber(record.maxDrawdownPercent, 0) * riskMul;
  const trades = Math.max(1, Math.round(asNumber(record.tradesCount, 0)));

  return {
    strategyId: Number(record.strategyId),
    strategyName: asString(record.strategyName, `Strategy ${record.strategyId}`),
    score: Number((scoreBase * (0.8 + 0.2 * riskMul)).toFixed(3)),
    metrics: {
      ret: Number(ret.toFixed(3)),
      pf: Number(asNumber(record.profitFactor, 1).toFixed(3)),
      dd: Number(dd.toFixed(3)),
      wr: Number(asNumber(record.winRatePercent, 0).toFixed(3)),
      trades,
    },
    params: {
      interval: asString(record.interval, '4h'),
      length: Math.max(2, Math.round(asNumber(record.length, 50))),
      takeProfitPercent: asNumber(record.takeProfitPercent, 0),
      detectionSource: asString(record.detectionSource, 'close'),
      zscoreEntry: asNumber(record.zscoreEntry, 2),
      zscoreExit: asNumber(record.zscoreExit, 0.5),
      zscoreStop: asNumber(record.zscoreStop, 3),
    },
  };
};

/** Inject explicit offerIds from sweep rows when they are outside default catalog top-N. */
export const augmentCatalogWithForcedOfferIds = (
  catalog: CatalogData,
  sweepRows: SweepRecord[],
  offerIds: string[],
): CatalogData => {
  if (!catalog || !offerIds.length || !sweepRows.length) {
    return catalog;
  }

  const existing = new Set(getAllOffers(catalog).map((item) => item.offerId));
  const mono = [...(catalog.clientCatalog?.mono || [])];
  const synth = [...(catalog.clientCatalog?.synth || [])];
  const familyRowsByKey = new Map<string, SweepRecord[]>();
  sweepRows.forEach((row) => {
    const key = buildSweepFamilyKey(row);
    const next = familyRowsByKey.get(key) || [];
    next.push(row);
    familyRowsByKey.set(key, next);
  });

  let added = 0;
  for (const offerId of offerIds) {
    if (existing.has(offerId)) {
      continue;
    }
    const strategyId = parseStrategyIdFromOfferId(offerId);
    const record = sweepRows.find((row) => Number(row.strategyId || 0) === strategyId);
    if (!record) {
      continue;
    }
    const family = familyRowsByKey.get(buildSweepFamilyKey(record)) || [record];
    const built = buildOfferFromSweepRecord(record, family);
    if (built.strategy?.mode === 'synth') {
      synth.push(built);
    } else {
      mono.push(built);
    }
    existing.add(offerId);
    added += 1;
  }

  if (added === 0) {
    return catalog;
  }

  return {
    ...catalog,
    clientCatalog: {
      mono,
      synth,
    },
    counts: {
      ...(catalog.counts || {}),
      monoCatalog: mono.length,
      synthCatalog: synth.length,
    },
  };
};

let _offerStoreAdminCache: OfferStoreState | null = null;
let _offerStoreAdminCacheAt = 0;
const OFFER_STORE_ADMIN_CACHE_TTL_MS = 30_000;

export const clearOfferStoreAdminCache = (): void => {
  _offerStoreAdminCache = null;
  _offerStoreAdminCacheAt = 0;
};

export const clearCatalogAndSweepCache = (): void => {
  _catalogCache = null;
  _catalogCacheAt = 0;
  clearOfferStoreAdminCache();
};

export const buildOfferFromSweepRecord = (record: SweepRecord, familyRows: SweepRecord[] = [record]): CatalogOffer => {
  const rawMode = asString(record.marketMode, 'mono');
  const mode = rawMode === 'synthetic' || rawMode === 'synth' ? 'synth' : 'mono';
  const tradeRows = pickFamilyTradePresetRows(record, familyRows);
  const presetMatrix: Record<Level3, Record<Level3, CatalogPreset | null>> = {
    low: {
      low: buildSweepPresetFromRecord(tradeRows.low, 'low'),
      medium: buildSweepPresetFromRecord(tradeRows.medium, 'low'),
      high: buildSweepPresetFromRecord(tradeRows.high, 'low'),
    },
    medium: {
      low: buildSweepPresetFromRecord(tradeRows.low, 'medium'),
      medium: buildSweepPresetFromRecord(tradeRows.medium, 'medium'),
      high: buildSweepPresetFromRecord(tradeRows.high, 'medium'),
    },
    high: {
      low: buildSweepPresetFromRecord(tradeRows.low, 'high'),
      medium: buildSweepPresetFromRecord(tradeRows.medium, 'high'),
      high: buildSweepPresetFromRecord(tradeRows.high, 'high'),
    },
  };
  const mediumMedium = presetMatrix.medium.medium || buildSweepPresetFromRecord(record, 'medium');
  const metrics = {
    ret: asNumber(record.totalReturnPercent, 0),
    pf: asNumber(record.profitFactor, 1),
    dd: asNumber(record.maxDrawdownPercent, 0),
    wr: asNumber(record.winRatePercent, 0),
    trades: Math.max(0, Math.floor(asNumber(record.tradesCount, 0))),
    score: asNumber(record.score, 0),
    robust: Boolean(record.robust),
  };

  return {
    offerId: `offer_${mode}_${asString(record.strategyType, 'strategy').toLowerCase()}_${record.strategyId}`,
    titleRu: `${mode.toUpperCase()} • ${asString(record.strategyType, 'Стратегия')} • ${asString(record.market, '')}`,
    descriptionRu: 'Автоматически собрано из записи исторического sweep.',
    strategy: {
      id: Number(record.strategyId),
      name: asString(record.strategyName, `Strategy ${record.strategyId}`),
      type: asString(record.strategyType, 'DD_BattleToads'),
      mode,
      market: asString(record.market, ''),
      params: mediumMedium.params,
    },
    metrics,
    sliderPresets: {
      risk: {
        low: presetMatrix.low.medium,
        medium: mediumMedium,
        high: presetMatrix.high.medium,
      },
      tradeFrequency: {
        low: presetMatrix.medium.low,
        medium: mediumMedium,
        high: presetMatrix.medium.high,
      },
    },
    presetMatrix,
    equity: {
      source: 'sweep_fallback',
      generatedAt: new Date().toISOString(),
      points: buildSweepEquityPoints(metrics.ret),
      summary: {
        finalEquity: Number((10000 * (1 + metrics.ret / 100)).toFixed(4)),
        totalReturnPercent: metrics.ret,
        maxDrawdownPercent: metrics.dd,
        winRatePercent: metrics.wr,
        profitFactor: metrics.pf,
        tradesCount: metrics.trades,
      },
    },
  };
};

const pickTopOffersFromSweepRecords = (rows: SweepRecord[], limit: number): CatalogOffer[] => {
  const familyRowsByKey = new Map<string, SweepRecord[]>();
  rows.forEach((row) => {
    const key = buildSweepFamilyKey(row);
    const next = familyRowsByKey.get(key) || [];
    next.push(row);
    familyRowsByKey.set(key, next);
  });
  const sorted = [...rows].sort((left, right) => asNumber(right.score, 0) - asNumber(left.score, 0));
  const preferred = sorted.filter((item) => Boolean(item.robust));
  const pool = preferred.length > 0 ? preferred : sorted;
  const selected: CatalogOffer[] = [];
  const seenMarkets = new Set<string>();

  for (const row of pool) {
    const market = asString(row.market, '');
    if (market && seenMarkets.has(market)) {
      continue;
    }
    selected.push(buildOfferFromSweepRecord(row, familyRowsByKey.get(buildSweepFamilyKey(row)) || [row]));
    if (market) {
      seenMarkets.add(market);
    }
    if (selected.length >= limit) {
      break;
    }
  }

  if (selected.length < limit) {
    const seenOfferIds = new Set(selected.map((item) => item.offerId));
    for (const row of sorted) {
      const offer = buildOfferFromSweepRecord(row, familyRowsByKey.get(buildSweepFamilyKey(row)) || [row]);
      if (seenOfferIds.has(offer.offerId)) {
        continue;
      }
      selected.push(offer);
      seenOfferIds.add(offer.offerId);
      if (selected.length >= limit) {
        break;
      }
    }
  }

  return selected.sort((left, right) => asNumber(right.metrics?.score, 0) - asNumber(left.metrics?.score, 0));
};

const pickAdminDraftMembersFromSweep = (rows: SweepRecord[], limit: number): SweepRecord[] => {
  const sorted = [...rows].sort((left, right) => asNumber(right.score, 0) - asNumber(left.score, 0));
  const preferred = sorted.filter((item) => Boolean(item.robust));
  const pool = preferred.length > 0 ? preferred : sorted;
  const selected: SweepRecord[] = [];
  const seenMarkets = new Set<string>();

  for (const row of pool) {
    const market = asString(row.market, '');
    if (market && seenMarkets.has(market)) {
      continue;
    }
    selected.push(row);
    if (market) {
      seenMarkets.add(market);
    }
    if (selected.length >= limit) {
      break;
    }
  }

  if (selected.length < limit) {
    const seenIds = new Set(selected.map((item) => Number(item.strategyId)));
    const seenMarkets = new Set(selected.map((item) => asString(item.market, '')).filter(Boolean));
    for (const row of sorted) {
      const strategyId = Number(row.strategyId);
      const market = asString(row.market, '');
      if (seenIds.has(strategyId)) {
        continue;
      }
      if (market && seenMarkets.has(market)) {
        continue;
      }
      selected.push(row);
      seenIds.add(strategyId);
      if (market) {
        seenMarkets.add(market);
      }
      if (selected.length >= limit) {
        break;
      }
    }
  }

  return selected;
};

export const buildClientCatalogFromSweepData = (
  sweep: SweepData,
  options?: {
    sweepFilePath?: string;
    durationSec?: number;
    monoLimit?: number;
    synthLimit?: number;
    maxMembers?: number;
  }
): CatalogData => {
  const monoLimit = Math.max(1, Math.min(24, Number(options?.monoLimit || 6)));
  const synthLimit = Math.max(1, Math.min(24, Number(options?.synthLimit || 6)));
  const maxMembers = Math.max(1, Math.min(12, Number(options?.maxMembers || 6)));
  const rows = Array.isArray(sweep?.evaluated) ? sweep.evaluated : [];
  const monoRows = rows.filter((item) => asString(item.marketMode, 'mono') === 'mono');
  const synthRows = rows.filter((item) => asString(item.marketMode, 'mono') !== 'mono');
  const monoOffers = pickTopOffersFromSweepRecords(monoRows, monoLimit);
  const synthOffers = pickTopOffersFromSweepRecords(synthRows, synthLimit);
  const selectedMembers = pickAdminDraftMembersFromSweep(rows, maxMembers);

  return {
    timestamp: new Date().toISOString(),
    apiKeyName: asString(sweep?.apiKeyName, ''),
    source: {
      sweepFile: asString(options?.sweepFilePath, 'generated:full_historical_sweep'),
      sweepTimestamp: asString(sweep?.timestamp, '') || null,
    },
    config: {
      ...(sweep?.config || {}),
    } as any,
    counts: {
      evaluated: Math.max(0, rows.length),
      robust: rows.filter((item) => Boolean(item.robust)).length,
      monoCatalog: monoOffers.length,
      synthCatalog: synthOffers.length,
      adminTsMembers: selectedMembers.length,
      durationSec: Math.max(0, Number(options?.durationSec || sweep?.counts?.durationSec || 0)),
    },
    clientCatalog: {
      mono: monoOffers,
      synth: synthOffers,
    },
    adminTradingSystemDraft: {
      name: asString(sweep?.config?.systemName, `HISTSWEEP ${asString(sweep?.apiKeyName, 'API')} Candidate`),
      members: selectedMembers.map((item, index) => ({
        strategyId: Number(item.strategyId),
        strategyName: asString(item.strategyName, `Strategy ${item.strategyId}`),
        strategyType: asString(item.strategyType, 'DD_BattleToads'),
        marketMode: asString(item.marketMode, 'mono'),
        market: asString(item.market, ''),
        score: asNumber(item.score, 0),
        weight: Number((index === 0 ? 1.25 : index === 1 ? 1.1 : 1).toFixed(4)),
      })),
      sourcePortfolioSummary: Array.isArray(sweep?.portfolioResults) ? sweep.portfolioResults : [],
    },
  };
};

const buildPresetBackedOffers = async (catalog: CatalogData | null): Promise<CatalogOffer[]> => {
  try {
    await initResearchDb();
    const offerIds = await listOfferIds();
    const offers = await Promise.all(offerIds.map(async (offerId) => {
      const [
        lowLow,
        lowMedium,
        lowHigh,
        mediumLow,
        mediumMedium,
        mediumHigh,
        highLow,
        highMedium,
        highHigh,
      ] = await Promise.all([
        getPreset(offerId, 'low', 'low'),
        getPreset(offerId, 'low', 'medium'),
        getPreset(offerId, 'low', 'high'),
        getPreset(offerId, 'medium', 'low'),
        getPreset(offerId, 'medium', 'medium'),
        getPreset(offerId, 'medium', 'high'),
        getPreset(offerId, 'high', 'low'),
        getPreset(offerId, 'high', 'medium'),
        getPreset(offerId, 'high', 'high'),
      ]);

      const preset = mediumMedium || lowMedium || mediumLow || highMedium || mediumHigh || lowLow || lowHigh || highLow || highHigh;
      if (!preset) {
        return null;
      }

      const legacy = findOfferByIdOrNull(catalog, offerId);
      const config = (preset.config || {}) as Record<string, unknown>;
      const metrics = (preset.metrics || {}) as Record<string, unknown>;

      const fallbackPresetMeta = {
        strategyId: Number(config.strategyId || legacy?.strategy?.id || 0),
        strategyName: String(config.name || legacy?.strategy?.name || offerId),
        params: {
          interval: String(config.interval || legacy?.strategy?.params?.interval || '1h'),
          length: Number(config.price_channel_length || legacy?.strategy?.params?.length || 50),
          takeProfitPercent: Number(config.take_profit_percent || legacy?.strategy?.params?.takeProfitPercent || 0),
          detectionSource: String(config.detection_source || legacy?.strategy?.params?.detectionSource || 'close'),
          zscoreEntry: Number(config.zscore_entry || legacy?.strategy?.params?.zscoreEntry || 2),
          zscoreExit: Number(config.zscore_exit || legacy?.strategy?.params?.zscoreExit || 0.5),
          zscoreStop: Number(config.zscore_stop || legacy?.strategy?.params?.zscoreStop || 3),
        },
        metrics: {
          ret: asNumber(metrics.ret, legacy?.metrics?.ret || 0),
          pf: asNumber(metrics.pf, legacy?.metrics?.pf || 1),
          dd: asNumber(metrics.dd, legacy?.metrics?.dd || 0),
          wr: asNumber(metrics.wr, legacy?.metrics?.wr || 0),
          trades: asNumber(metrics.trades, legacy?.metrics?.trades || 0),
          score: asNumber(metrics.score, legacy?.metrics?.score || 0),
        },
      };

      const presetMatrix = {
        low: {
          low: toCatalogPreset(lowLow, fallbackPresetMeta),
          medium: toCatalogPreset(lowMedium, fallbackPresetMeta),
          high: toCatalogPreset(lowHigh, fallbackPresetMeta),
        },
        medium: {
          low: toCatalogPreset(mediumLow, fallbackPresetMeta),
          medium: toCatalogPreset(mediumMedium, fallbackPresetMeta),
          high: toCatalogPreset(mediumHigh, fallbackPresetMeta),
        },
        high: {
          low: toCatalogPreset(highLow, fallbackPresetMeta),
          medium: toCatalogPreset(highMedium, fallbackPresetMeta),
          high: toCatalogPreset(highHigh, fallbackPresetMeta),
        },
      } as Record<Level3, Record<Level3, CatalogPreset | null>>;

      const riskPresets = {
        low: presetMatrix.low.medium || legacy?.sliderPresets?.risk?.low || null,
        medium: presetMatrix.medium.medium || legacy?.sliderPresets?.risk?.medium || null,
        high: presetMatrix.high.medium || legacy?.sliderPresets?.risk?.high || null,
      } as Record<Level3, CatalogPreset | null>;

      const tradeFrequencyPresets = {
        low: presetMatrix.medium.low || legacy?.sliderPresets?.tradeFrequency?.low || null,
        medium: presetMatrix.medium.medium || legacy?.sliderPresets?.tradeFrequency?.medium || null,
        high: presetMatrix.medium.high || legacy?.sliderPresets?.tradeFrequency?.high || null,
      } as Record<Level3, CatalogPreset | null>;

      return {
        offerId,
        titleRu: legacy?.titleRu || String(config.name || offerId),
        descriptionRu: legacy?.descriptionRu || 'Оффер собран на базе пресетов.',
        strategy: {
          id: Number(config.strategyId || legacy?.strategy?.id || 0),
          name: String(config.name || legacy?.strategy?.name || offerId),
          type: String(config.strategy_type || legacy?.strategy?.type || 'DD_BattleToads'),
          mode: ((() => {
            const rawMode = String(config.market_mode || legacy?.strategy?.mode || 'mono');
            return rawMode === 'synthetic' || rawMode === 'synth' ? 'synth' : 'mono';
          })()) as 'mono' | 'synth',
          market: legacy?.strategy?.market || [config.base_symbol, config.quote_symbol].filter(Boolean).join('/'),
          params: {
            interval: String(config.interval || legacy?.strategy?.params?.interval || '1h'),
            length: Number(config.price_channel_length || legacy?.strategy?.params?.length || 50),
            takeProfitPercent: Number(config.take_profit_percent || legacy?.strategy?.params?.takeProfitPercent || 0),
            detectionSource: String(config.detection_source || legacy?.strategy?.params?.detectionSource || 'close'),
            zscoreEntry: Number(config.zscore_entry || legacy?.strategy?.params?.zscoreEntry || 2),
            zscoreExit: Number(config.zscore_exit || legacy?.strategy?.params?.zscoreExit || 0.5),
            zscoreStop: Number(config.zscore_stop || legacy?.strategy?.params?.zscoreStop || 3),
          },
        },
        metrics: {
          ret: asNumber(metrics.ret, legacy?.metrics?.ret || 0),
          pf: asNumber(metrics.pf, legacy?.metrics?.pf || 1),
          dd: asNumber(metrics.dd, legacy?.metrics?.dd || 0),
          wr: asNumber(metrics.wr, legacy?.metrics?.wr || 0),
          trades: asNumber(metrics.trades, legacy?.metrics?.trades || 0),
          score: asNumber(metrics.score, legacy?.metrics?.score || 0),
          robust: legacy?.metrics?.robust,
        },
        sliderPresets: {
          risk: riskPresets,
          tradeFrequency: tradeFrequencyPresets,
        },
        presetMatrix,
        equity: {
          source: 'preset_db',
          generatedAt: new Date().toISOString(),
          points: Array.isArray(preset.equity_curve)
            ? (() => {
              const now = Date.now();
              const spanMs = 365 * 24 * 3600 * 1000;
              const startMs = now - spanMs;
              return preset.equity_curve.map((value, index, arr) => ({
                time: arr.length <= 1 ? now : Math.round(startMs + (index / (arr.length - 1)) * spanMs),
                equity: asNumber(value, 0),
              }));
            })()
            : [],
          summary: legacy?.equity?.summary,
        },
      } as CatalogOffer;
    }));

    const presetOffers = offers.filter((item): item is CatalogOffer => !!item);
    const byStrategyId = new Map<number, CatalogOffer>();

    for (const offer of presetOffers) {
      const strategyId = Number(offer.strategy?.id || 0);
      if (strategyId > 0) {
        byStrategyId.set(strategyId, offer);
      }
    }

    const sweep = loadLatestSweep();
    const sweepRecords = (sweep?.evaluated || [])
      .filter((record) => Number(record.strategyId) > 0)
      .sort((left, right) => asNumber(right.score, 0) - asNumber(left.score, 0))
      .slice(0, 24);

    for (const record of sweepRecords) {
      const strategyId = Number(record.strategyId);
      const existing = byStrategyId.get(strategyId);
      const sweepOffer = buildOfferFromSweepRecord(record);

      if (!existing) {
        byStrategyId.set(strategyId, sweepOffer);
        continue;
      }

      const looksEmpty = asNumber(existing.metrics?.ret, 0) === 0
        && asNumber(existing.metrics?.score, 0) === 0
        && asNumber(existing.metrics?.pf, 0) <= 1;

      if (looksEmpty) {
        byStrategyId.set(strategyId, sweepOffer);
      }
    }

    return Array.from(byStrategyId.values()).sort((left, right) => asNumber(right.metrics?.score, 0) - asNumber(left.metrics?.score, 0));
  } catch (error) {
    logger.warn(`Preset-backed offers unavailable, using legacy catalog fallback: ${(error as Error).message}`);
    return catalog ? getAllOffers(catalog) : [];
  }
};

const hydrateStoredStrategyPreview = (catalog: CatalogData | null, payload: string | null | undefined): Record<string, unknown> => {
  const parsed = safeJsonParse<Record<string, unknown>>(payload, {});
  const offerId = asString(parsed.offerId);
  const embeddedOffer = parsed.offer as CatalogOffer | undefined;

  if (embeddedOffer?.offerId && embeddedOffer?.titleRu) {
    return {
      ...parsed,
      offerId: offerId || embeddedOffer.offerId,
      offer: embeddedOffer,
    };
  }

  const hydratedOffer = findOfferByIdOrNull(catalog, offerId);
  if (!hydratedOffer) {
    return parsed;
  }

  return {
    ...parsed,
    offerId: offerId || hydratedOffer.offerId,
    offer: hydratedOffer,
  };
};

const findSweepRecordByStrategyId = (sweep: SweepData | null, strategyId: number): SweepRecord | null => {
  const rows = sweep?.evaluated || [];
  return rows.find((item) => Number(item.strategyId) === Number(strategyId)) || null;
};

const buildSweepRecordFallbackByStrategyId = async (strategyId: number): Promise<SweepRecord | null> => {
  const id = Math.floor(asNumber(strategyId, 0));
  if (!id) {
    return null;
  }

  const row = await db.get(
    `SELECT
       s.id,
       s.name,
       s.strategy_type,
       s.market_mode,
       s.base_symbol,
       s.quote_symbol,
       s.interval,
       s.price_channel_length,
       s.take_profit_percent,
       s.detection_source,
       s.zscore_entry,
       s.zscore_exit,
       s.zscore_stop
     FROM strategies s
     WHERE s.id = ?`,
    [id]
  ) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  const modeRaw = asString(row.market_mode, 'synthetic').trim().toLowerCase();
  const marketMode = modeRaw === 'mono' ? 'mono' : 'synthetic';
  const baseSymbol = asString(row.base_symbol, '').trim().toUpperCase();
  const quoteSymbol = asString(row.quote_symbol, '').trim().toUpperCase();
  const market = marketMode === 'mono'
    ? (baseSymbol || 'BTCUSDT')
    : `${baseSymbol || 'BTCUSDT'}/${quoteSymbol || 'ETHUSDT'}`;

  return {
    strategyId: id,
    strategyName: asString(row.name, `strategy_${id}`),
    strategyType: asString(row.strategy_type, 'DD_BattleToads'),
    marketMode,
    market,
    interval: asString(row.interval, '4h'),
    length: Math.max(2, Math.floor(asNumber(row.price_channel_length, 24))),
    takeProfitPercent: asNumber(row.take_profit_percent, 0),
    detectionSource: asString(row.detection_source, 'close') === 'wick' ? 'wick' : 'close',
    zscoreEntry: asNumber(row.zscore_entry, 2),
    zscoreExit: asNumber(row.zscore_exit, 0.5),
    zscoreStop: asNumber(row.zscore_stop, 3),
    totalReturnPercent: 0,
    maxDrawdownPercent: 0,
    winRatePercent: 0,
    profitFactor: 0,
    tradesCount: 0,
    score: 0,
    robust: true,
  };
};

const normalizeModeForStrategy = (mode: string): 'mono' | 'synthetic' => (mode === 'mono' ? 'mono' : 'synthetic');

const getRiskLotPercent = (riskLevel: Level3): number => {
  if (riskLevel === 'low') return 6;
  if (riskLevel === 'high') return 14;
  return 10;
};

/**
 * Builds a realistic synthetic equity curve from summary metrics.
 * Uses a trend + drawdown-oscillation model so the chart is visually meaningful
 * and changes when risk/frequency sliders are adjusted.
 */
const buildSyntheticEquityPoints = (
  initialBalance: number,
  retPercent: number,
  maxDrawdownPercent: number,
  periodDays: number,
  oscillationFactor = 1
): Array<{ time: number; equity: number }> => {
  const start = Number.isFinite(initialBalance) && initialBalance > 0 ? initialBalance : 10000;
  const ret = Number.isFinite(retPercent) ? retPercent : 0;
  const dd = Math.max(0, Number.isFinite(maxDrawdownPercent) ? maxDrawdownPercent : Math.abs(ret) * 0.3);
  const days = Math.max(10, Number.isFinite(periodDays) && periodDays > 0 ? periodDays : 90);
  const finalEquity = start * (1 + ret / 100);
  // Number of points: ~1 per day, clamped to 40..200
  const n = Math.max(40, Math.min(200, Math.round(days)));
  const now = Date.now();
  const periodMs = Math.round(days * 24 * 3600 * 1000);

  // Deterministic PRNG: stable curve for same inputs, no random "jumps" between rerenders.
  let seed = Math.floor((ret + 1000) * 17 + dd * 113 + days * 7 + oscillationFactor * 97);
  if (!Number.isFinite(seed) || seed <= 0) {
    seed = 1234567;
  }
  const nextRand = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const nextGaussian = (): number => {
    const u1 = Math.max(1e-9, nextRand());
    const u2 = Math.max(1e-9, nextRand());
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const targetGrowth = Math.max(0.05, finalEquity) / start;
  const drift = Math.log(targetGrowth) / n;
  const vol = Math.max(0.0015, (dd / 100) / Math.sqrt(n) * (0.95 + oscillationFactor * 0.45));

  const rawPath: number[] = [start];
  let eq = start;
  for (let i = 1; i <= n; i++) {
    const shock = nextGaussian();
    const step = drift + shock * vol;
    eq = Math.max(start * 0.03, eq * Math.exp(step));
    rawPath.push(eq);
  }

  // Force final point to match requested return while preserving curve shape.
  const endRaw = Math.max(start * 0.03, rawPath[rawPath.length - 1]);
  const scale = Math.max(0.05, finalEquity) / endRaw;
  const scaledPath = rawPath.map((value) => value * scale);

  return scaledPath.map((equity, index) => {
    const t = index / n;
    return {
      time: Math.round(now - periodMs + t * periodMs),
      equity: Number(Math.max(start * 0.03, equity).toFixed(4)),
    };
  });
};

const toPresetOnlyEquity = (initialBalance: number, retPercent: number, periodDays = 90): Array<{ time: number; equity: number }> => {
  const ddApprox = Math.abs(retPercent) * 0.3;
  return buildSyntheticEquityPoints(initialBalance, retPercent, ddApprox, periodDays);
};

const getPreviewRiskMultiplier = (riskScore: number, riskScaleMaxPercent: number): number => {
  // Keep default score=5 neutral (1.0x) so preview matches card metrics at baseline.
  // Then scale exponentially around the midpoint for stronger low/high separation.
  const centered = (clampNumber(asNumber(riskScore, 5), 0, 10) - 5) / 5; // -1..1
  const maxMul = Math.max(1.4, 1 + riskScaleMaxPercent / 45);
  const logMax = Math.log(maxMul);
  return Math.exp(centered * logMax);
};

const getPreviewTradeMultiplier = (tradeFrequencyScore: number): number => {
  // Keep baseline behavior at mid slider:
  // freq=0 -> ~0.42x, freq=5 -> 1.0x, freq=10 -> 2.4x.
  // This avoids default (score=5) undercounting trades vs historical previews.
  const normalized = clampNumber(asNumber(tradeFrequencyScore, 5), 0, 10) / 10;
  const maxMul = 2.4;
  const minMul = 1 / maxMul;
  return Math.exp(Math.log(minMul) + normalized * (Math.log(maxMul) - Math.log(minMul)));
};

const scaleEquityByRiskWithReinvest = (
  pointEquity: number,
  startEquity: number,
  initialBalance: number,
  riskMul: number,
  reinvestShare: number,
): number => {
  const safeRiskMul = Math.max(0.01, asNumber(riskMul, 1));
  const safeReinvestShare = clampNumber(asNumber(reinvestShare, 1), 0, 1);
  const safeStart = Math.max(0.0001, asNumber(startEquity, initialBalance));
  const safePoint = Math.max(0.0001, asNumber(pointEquity, safeStart));

  const linearScaled = initialBalance + (safePoint - safeStart) * safeRiskMul;
  const returnRatio = safePoint / safeStart;
  const compoundedScaled = initialBalance * Math.pow(returnRatio, safeRiskMul);

  return Number((linearScaled * (1 - safeReinvestShare) + compoundedScaled * safeReinvestShare).toFixed(4));
};

const adjustPreviewMetrics = (
  metrics: { ret: number; pf: number; dd: number; wr: number; trades: number },
  riskMul: number,
  tradeMul: number
) => {
  // ret scales with both risk and trade frequency; high risk → high potential return AND high DD
  const retMul = riskMul * Math.sqrt(tradeMul); // sqrt makes trade effect softer on ret
  // dd scales even more aggressively with risk (risk is a lot about how much you can lose)
  const ddMul = Math.max(0.05, riskMul * (0.7 + tradeMul * 0.3));
  // pf degrades with very high risk and very high frequency
  const pfBase = asNumber(metrics.pf, 1);
  const pfMul = Math.max(0.3, 1 / Math.max(0.5, Math.sqrt(riskMul) * Math.sqrt(tradeMul)));
  // win rate: high risk = lower wr, high freq = higher wr (more trades → regression to mean)
  const wrShift = (tradeMul - 1) * 5 - Math.max(0, riskMul - 1) * 6;
  // Trades should be controlled by frequency only.
  // Risk affects P/L and DD profile, but not trade count density.
  const tradesMul = Math.max(0.1, tradeMul);

  return {
    ret: Number((asNumber(metrics.ret, 0) * retMul).toFixed(3)),
    pf: Number(Math.max(0.15, pfBase * pfMul).toFixed(3)),
    dd: Number(Math.max(0.02, asNumber(metrics.dd, 0) * ddMul).toFixed(3)),
    wr: Number(clampNumber(asNumber(metrics.wr, 0) + wrShift, 1, 99).toFixed(3)),
    trades: Math.max(1, Math.round(asNumber(metrics.trades, 0) * tradesMul)),
  };
};

const buildAdjustedPreviewEquity = (
  preset: CatalogPreset,
  initialBalance: number,
  targetRet: number,
  targetDd: number,
  periodDays: number,
  oscillationFactor: number // 0.1 (very smooth) to 2.5 (very volatile)
): Array<{ time: number; equity: number }> => {
  const curve = Array.isArray(preset.equity_curve)
    ? preset.equity_curve.map((value) => asNumber(value, Number.NaN)).filter((value) => Number.isFinite(value) && value > 0)
    : [];

  if (curve.length < 2) {
    return buildSyntheticEquityPoints(initialBalance, targetRet, targetDd, periodDays, oscillationFactor);
  }

  const first = asNumber(curve[0], 0);
  if (first <= 0) {
    return buildSyntheticEquityPoints(initialBalance, targetRet, targetDd, periodDays, oscillationFactor);
  }

  const normalized = curve.map((equity) => asNumber(equity, first) / first - 1);
  const baseFinal = normalized[normalized.length - 1];
  if (!Number.isFinite(baseFinal) || Math.abs(baseFinal) < 0.000001) {
    return buildSyntheticEquityPoints(initialBalance, targetRet, targetDd, periodDays, oscillationFactor);
  }

  const scale = (targetRet / 100) / baseFinal;
  const now = Date.now();
  const periodMs = Math.round(Math.max(10, periodDays) * 24 * 3600 * 1000);
  // Oscillation amplitude driven by both risk (via dd) and oscillationFactor
  const waveFreq = 1.2 + oscillationFactor * 1.2; // more risk = higher frequency oscillations
  const targetRetAbs = Math.abs(targetRet / 100);
  // Keep volatility visually plausible without breaking direction for low-return setups.
  const waveAmpCap = Math.max(0.004, targetRetAbs * 0.35);
  const waveAmpRaw = (targetDd / 100) * 0.12 * oscillationFactor;
  const waveAmp = Math.min(waveAmpRaw, waveAmpCap);

  return normalized.map((value, index) => {
    const t = normalized.length <= 1 ? 1 : index / (normalized.length - 1);
    // Multi-frequency noise makes it look more realistic
    const edgeEnvelope = Math.sin(Math.PI * t) ** 2;
    const primaryWave = Math.sin(t * Math.PI * waveFreq) * waveAmp * (1 - t * 0.08);
    const secondaryWave = Math.sin(t * Math.PI * waveFreq * 2.3 + 0.7) * waveAmp * 0.3;
    const adjustedReturn = value * scale + (primaryWave + secondaryWave) * edgeEnvelope;
    return {
      time: Math.round(now - periodMs + t * periodMs),
      equity: Number((initialBalance * (1 + adjustedReturn)).toFixed(4)),
    };
  });
};

const buildDerivedPreviewCurves = (
  equityCurve: Array<{ time: number; equity: number; unrealizedPnl?: number }>,
  initialBalance: number,
  riskScore: number
) => {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    return {
      pnl: [] as Array<{ time: number; value: number }>,
      drawdownPercent: [] as Array<{ time: number; value: number }>,
      marginLoadPercent: [] as Array<{ time: number; value: number }>,
      unrealizedPnl: [] as Array<{ time: number; value: number }>,
      finalUnrealizedPnl: 0,
      maxMarginLoadPercent: 0,
    };
  }

  let peak = asNumber(equityCurve[0]?.equity, initialBalance);

  const pnl = equityCurve.map((point) => {
    const equity = Math.max(0, asNumber(point.equity, initialBalance));
    return {
      time: asNumber(point.time, Date.now()),
      value: Number((equity - initialBalance).toFixed(4)),
    };
  });

  const drawdownPercent = equityCurve.map((point) => {
    const equity = Math.max(0, asNumber(point.equity, initialBalance));
    if (equity > peak) {
      peak = equity;
    }
    const dd = peak > 0 ? Math.min(100, ((peak - equity) / peak) * 100) : 0;
    return {
      time: asNumber(point.time, Date.now()),
      value: Number(dd.toFixed(4)),
    };
  });

  const unrealizedPnl = equityCurve.map((point) => ({
    time: asNumber(point.time, Date.now()),
    value: Number(asNumber((point as { unrealizedPnl?: unknown }).unrealizedPnl, 0).toFixed(4)),
  }));
  const hasRealUpnl = unrealizedPnl.some((p) => Math.abs(p.value) > 1e-9);
  const finalUnrealizedPnl = hasRealUpnl
    ? asNumber(unrealizedPnl[unrealizedPnl.length - 1]?.value, 0)
    : (pnl.length > 0 ? asNumber(pnl[pnl.length - 1].value, 0) : 0);

  const marginLoadPercent = equityCurve.map((point) => ({
    time: asNumber(point.time, Date.now()),
    value: 0,
  }));

  return {
    pnl,
    drawdownPercent,
    marginLoadPercent,
    unrealizedPnl: hasRealUpnl ? unrealizedPnl : [],
    finalUnrealizedPnl: Number(finalUnrealizedPnl.toFixed(4)),
    maxMarginLoadPercent: 0,
  };
};

/** Real rerun: risk/reinvest already in engine lot sizing — metrics from sanitized equity only. */
const summarizeRealRerunEquityCurve = (
  equityCurve: Array<{ time: number; equity: number }>,
  initialBalance: number,
) => {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    return {
      finalEquity: initialBalance,
      totalReturnPercent: 0,
      maxDrawdownPercent: 0,
      unrealizedPnl: 0,
      curves: buildDerivedPreviewCurves([], initialBalance, 5),
    };
  }
  const sanitized = sanitizeEquityCurveForMetrics(equityCurve, initialBalance);
  const curves = buildDerivedPreviewCurves(sanitized, initialBalance, 5);
  const safeInitial = Math.max(0.0001, asNumber(initialBalance, 10000));
  const finalEquity = asNumber(sanitized[sanitized.length - 1]?.equity, safeInitial);
  const totalReturnPercent = ((finalEquity - safeInitial) / safeInitial) * 100;
  const maxDrawdownPercent = curves.drawdownPercent.length > 0
    ? Math.min(100, maxNumericValues(curves.drawdownPercent.map((point) => asNumber(point.value, 0))))
    : 0;
  return {
    finalEquity: Number(finalEquity.toFixed(4)),
    totalReturnPercent: Number(totalReturnPercent.toFixed(3)),
    maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(3)),
    unrealizedPnl: curves.finalUnrealizedPnl,
    curves,
    equity: sanitized,
  };
};

const buildPresetOnlySingleSummary = (
  initialBalance: number,
  preset: CatalogPreset,
  market: string,
  strategyName: string,
  overrides?: Partial<{ ret: number; pf: number; dd: number; wr: number; trades: number }>
): Record<string, unknown> => {
  const ret = asNumber(overrides?.ret, asNumber(preset.metrics.ret, 0));
  const end = Number((initialBalance * (1 + ret / 100)).toFixed(4));
  return {
    mode: 'single',
    apiKeyName: 'preset_lookup',
    strategyIds: [Number(preset.strategyId)],
    strategyNames: [strategyName],
    interval: asString(preset.params.interval, '1h'),
    barsRequested: 0,
    barsProcessed: 0,
    dateFromMs: null,
    dateToMs: null,
    warmupBars: 0,
    skippedStrategies: 0,
    processedStrategies: 1,
    initialBalance,
    finalEquity: end,
    totalReturnPercent: ret,
    maxDrawdownPercent: asNumber(overrides?.dd, asNumber(preset.metrics.dd, 0)),
    maxDrawdownAbsolute: Number((initialBalance * asNumber(overrides?.dd, asNumber(preset.metrics.dd, 0)) / 100).toFixed(4)),
    tradesCount: Math.max(0, Math.floor(asNumber(overrides?.trades, asNumber(preset.metrics.trades, 0)))),
    winRatePercent: asNumber(overrides?.wr, asNumber(preset.metrics.wr, 0)),
    profitFactor: asNumber(overrides?.pf, asNumber(preset.metrics.pf, 1)),
    grossProfit: 0,
    grossLoss: 0,
    commissionPercent: 0,
    slippagePercent: 0,
    fundingRatePercent: 0,
    market,
    approx: true,
  };
};

const buildPresetOnlyPortfolioSummary = (
  initialBalance: number,
  selectedOffers: Array<{ offerId: string; offer: CatalogOffer; preset: CatalogPreset }>,
  overrides?: Partial<{ avgRet: number; avgPf: number; maxDd: number; avgWr: number; totalTrades: number }>
): Record<string, unknown> => {
  const count = selectedOffers.length || 1;
  const avgRet = asNumber(overrides?.avgRet, selectedOffers.reduce((acc, item) => acc + asNumber(item.preset.metrics.ret, 0), 0) / count);
  const avgPf = asNumber(overrides?.avgPf, selectedOffers.reduce((acc, item) => acc + asNumber(item.preset.metrics.pf, 1), 0) / count);
  const avgWr = asNumber(overrides?.avgWr, selectedOffers.reduce((acc, item) => acc + asNumber(item.preset.metrics.wr, 0), 0) / count);
  const maxDd = asNumber(overrides?.maxDd, selectedOffers.reduce((acc, item) => Math.max(acc, asNumber(item.preset.metrics.dd, 0)), 0));
  const totalTrades = Math.max(0, Math.floor(asNumber(overrides?.totalTrades, selectedOffers.reduce((acc, item) => acc + Math.max(0, Math.floor(asNumber(item.preset.metrics.trades, 0))), 0))));
  const end = Number((initialBalance * (1 + avgRet / 100)).toFixed(4));

  return {
    mode: 'portfolio',
    apiKeyName: 'preset_lookup',
    strategyIds: selectedOffers.map((item) => Number(item.preset.strategyId)),
    strategyNames: selectedOffers.map((item) => item.preset.strategyName),
    interval: 'preset',
    barsRequested: 0,
    barsProcessed: 0,
    dateFromMs: null,
    dateToMs: null,
    warmupBars: 0,
    skippedStrategies: 0,
    processedStrategies: count,
    initialBalance,
    finalEquity: end,
    totalReturnPercent: avgRet,
    maxDrawdownPercent: maxDd,
    maxDrawdownAbsolute: Number((initialBalance * maxDd / 100).toFixed(4)),
    tradesCount: totalTrades,
    winRatePercent: avgWr,
    profitFactor: avgPf,
    grossProfit: 0,
    grossLoss: 0,
    commissionPercent: 0,
    slippagePercent: 0,
    fundingRatePercent: 0,
    approx: true,
  };
};

const markMaterializedRuntimeOrigin = async (
  strategyId: number,
  origin: 'saas_materialize' | 'saas_archived',
  isRuntime: 0 | 1
): Promise<void> => {
  try {
    await db.run(
      `UPDATE strategies
       SET origin = ?,
           is_runtime = ?,
           is_archived = 0,
           is_active = 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [origin, isRuntime, strategyId]
    );
  } catch (error) {
    logger.warn(`Unable to mark strategy #${strategyId} origin/is_runtime: ${(error as Error).message}`);
  }
};

// Full SaaS archive: close exchange exposure (sibling-aware), cancel working
// orders, then mark the DB row as state=flat, is_archived=1, is_active=0,
// is_runtime=0, origin='saas_archived'. Prevents zombie strategies that keep
// state='long'/'short' after the storefront removes them — the bug behind
// the BERAUSDT/OPUSDT cross-account divergence on 2026-05-03.
const saasArchiveStrategy = async (
  apiKeyName: string,
  row: {
    id: number;
    base_symbol?: string | null;
    quote_symbol?: string | null;
    market_mode?: string | null;
    name?: string | null;
    state?: string | null;
  },
  options?: { softOnly?: boolean },
): Promise<void> => {
  const strategyId = Number(row.id);
  if (!Number.isFinite(strategyId) || strategyId <= 0) return;
  const symbolsHint = row.base_symbol || row.quote_symbol || 'unknown';
  const strategyShape = {
    id: strategyId,
    market_mode: (row.market_mode as any) || 'mono',
    base_symbol: String(row.base_symbol || ''),
    quote_symbol: String(row.quote_symbol || ''),
  };
  const state = asString(row.state, 'flat').trim().toLowerCase() || 'flat';
  // Flat / already-idle orphans: DB-only archive. Exchange cancel on hundreds of
  // historical SAAS legs (often WEEX -1058 unsupported pairs) made rematerialize hang for hours.
  const softOnly = options?.softOnly === true || state === 'flat' || state === '' || state === 'idle';
  if (!softOnly) {
    try {
      await cancelStrategyWorkingOrders(apiKeyName, strategyShape);
    } catch (err) {
      const msg = asString((err as Error).message, '');
      // -1058 / unsupported pair: do not block archive; exposure close may also no-op.
      if (!/-1058|not supported via the API|trade denied|Invalid symbol/i.test(msg)) {
        logger.warn(`saasArchiveStrategy: cancelStrategyWorkingOrders failed for #${strategyId} (${apiKeyName}/${symbolsHint}): ${msg}`);
      }
    }
    try {
      await closeStrategyExposure(apiKeyName, strategyShape);
    } catch (err) {
      logger.warn(`saasArchiveStrategy: closeStrategyExposure failed for #${strategyId} (${apiKeyName}/${symbolsHint}): ${(err as Error).message}`);
    }
  }
  try {
    await updateStrategy(apiKeyName, strategyId, { is_active: false }, { source: 'saas_archive' });
  } catch (err) {
    logger.warn(`saasArchiveStrategy: updateStrategy is_active=false failed for #${strategyId}: ${(err as Error).message}`);
  }
  try {
    await db.run(
      `UPDATE strategies
       SET state = 'flat',
           is_archived = 1,
           is_runtime = 0,
           origin = 'saas_archived',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [strategyId]
    );
  } catch (err) {
    logger.warn(`saasArchiveStrategy: final state/is_archived UPDATE failed for #${strategyId}: ${(err as Error).message}`);
  }
  try {
    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (NULL, 'system', 'saas_archive_strategy', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify({
        strategyId,
        apiKeyName,
        name: row.name || null,
        symbol: symbolsHint,
        softOnly,
        priorState: state,
      })]
    );
  } catch {
    // best-effort audit
  }
};

const collectPresetCandidates = (offer: CatalogOffer): CatalogPreset[] => {
  const values = [
    ...(offer.presetMatrix
      ? (['low', 'medium', 'high'] as Level3[]).flatMap((riskLevel) =>
        (['low', 'medium', 'high'] as Level3[]).map((freqLevel) => offer.presetMatrix?.[riskLevel]?.[freqLevel] || null)
      )
      : []),
    offer.sliderPresets?.risk?.low,
    offer.sliderPresets?.risk?.medium,
    offer.sliderPresets?.risk?.high,
    offer.sliderPresets?.tradeFrequency?.low,
    offer.sliderPresets?.tradeFrequency?.medium,
    offer.sliderPresets?.tradeFrequency?.high,
  ].filter((item): item is CatalogPreset => !!item);

  const out: CatalogPreset[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const signature = [
      item.strategyId,
      asNumber(item.metrics.ret, 0).toFixed(6),
      asNumber(item.metrics.dd, 0).toFixed(6),
      asNumber(item.metrics.trades, 0).toFixed(6),
      asNumber(item.params.length, 0),
      asNumber(item.params.takeProfitPercent, 0).toFixed(6),
      asString(item.params.detectionSource, ''),
      asNumber(item.params.zscoreEntry, 0).toFixed(6),
      asNumber(item.params.zscoreExit, 0).toFixed(6),
      asNumber(item.params.zscoreStop, 0).toFixed(6),
    ].join('|');
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    out.push(item);
  }
  return out;
};

const resolveOfferPreset = (offer: CatalogOffer, riskLevel: Level3, tradeFrequencyLevel: Level3): CatalogPreset => {
  const candidates = collectPresetCandidates(offer);
  if (candidates.length === 0) {
    return {
      strategyId: offer.strategy.id,
      strategyName: offer.strategy.name,
      score: offer.metrics.score,
      equity_curve: Array.isArray(offer.equity?.points)
        ? offer.equity.points.map((point) => asNumber(point?.equity, 0))
        : undefined,
      metrics: {
        ret: offer.metrics.ret,
        pf: offer.metrics.pf,
        dd: offer.metrics.dd,
        wr: offer.metrics.wr,
        trades: offer.metrics.trades,
      },
      params: offer.strategy.params,
    };
  }

  const sortedByDd = [...candidates].sort((left, right) => asNumber(left.metrics.dd, 0) - asNumber(right.metrics.dd, 0));
  const sortedByTrades = [...candidates].sort((left, right) => asNumber(left.metrics.trades, 0) - asNumber(right.metrics.trades, 0));
  const getCandidateKey = (item: CatalogPreset): string => [
    item.strategyId,
    asNumber(item.metrics.ret, 0).toFixed(6),
    asNumber(item.metrics.dd, 0).toFixed(6),
    asNumber(item.metrics.trades, 0).toFixed(6),
    asNumber(item.params.length, 0),
    asNumber(item.params.takeProfitPercent, 0).toFixed(6),
    asString(item.params.detectionSource, ''),
    asNumber(item.params.zscoreEntry, 0).toFixed(6),
    asNumber(item.params.zscoreExit, 0).toFixed(6),
    asNumber(item.params.zscoreStop, 0).toFixed(6),
  ].join('|');
  const ddRank = new Map<string, number>();
  const tradeRank = new Map<string, number>();

  sortedByDd.forEach((item, index) => ddRank.set(getCandidateKey(item), index));
  sortedByTrades.forEach((item, index) => tradeRank.set(getCandidateKey(item), index));

  const targetDd = (levelToPreferenceScore(riskLevel) / 10) * Math.max(sortedByDd.length - 1, 0);
  const targetTrades = (levelToPreferenceScore(tradeFrequencyLevel) / 10) * Math.max(sortedByTrades.length - 1, 0);

  return [...candidates].sort((left, right) => {
    const leftScore = Math.abs((ddRank.get(getCandidateKey(left)) || 0) - targetDd) + Math.abs((tradeRank.get(getCandidateKey(left)) || 0) - targetTrades);
    const rightScore = Math.abs((ddRank.get(getCandidateKey(right)) || 0) - targetDd) + Math.abs((tradeRank.get(getCandidateKey(right)) || 0) - targetTrades);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return asNumber(right.score, 0) - asNumber(left.score, 0);
  })[0];
};

const buildPreviewEquityFromPreset = (
  preset: CatalogPreset,
  initialBalance: number,
  fallbackRet: number,
  periodDays?: number
): Array<{ time: number; equity: number }> => {
  const curve = Array.isArray(preset.equity_curve)
    ? preset.equity_curve
      .map((value) => asNumber(value, Number.NaN))
      .filter((value) => Number.isFinite(value) && value > 0)
    : [];

  if (curve.length >= 2) {
    return curve.map((equity, index) => ({
      time: index + 1,
      equity: Number(equity.toFixed(4)),
    }));
  }

  const ret = Number.isFinite(fallbackRet) ? fallbackRet : asNumber(preset?.metrics?.ret, 0);
  const dd = asNumber(preset?.metrics?.dd, Math.abs(ret) * 0.3);
  return buildSyntheticEquityPoints(initialBalance, ret, dd, periodDays || 90);
};

const buildPortfolioPreviewEquityFromPresets = (
  selectedOffers: Array<{ metrics: CatalogMetricSet; preset: CatalogPreset }>,
  initialBalance: number,
  periodDays?: number
): Array<{ time: number; equity: number }> => {
  const resolvedPeriodDays = Math.max(10, Number.isFinite(periodDays ?? 0) ? (periodDays || 90) : 90);
  const normalizedCurves = selectedOffers
    .map((item) => {
      const points = buildPreviewEquityFromPreset(item.preset, initialBalance, asNumber(item.metrics.ret, 0), resolvedPeriodDays);
      if (!Array.isArray(points) || points.length < 2) {
        return null;
      }
      const first = asNumber(points[0]?.equity, 0);
      if (first <= 0) {
        return null;
      }
      return points.map((point) => asNumber(point.equity, first) / first - 1);
    })
    .filter((curve): curve is number[] => Array.isArray(curve) && curve.length >= 2);

  if (normalizedCurves.length === 0) {
    const avgRet = selectedOffers.reduce((acc, item) => acc + asNumber(item.metrics.ret, 0), 0) / Math.max(1, selectedOffers.length);
    const avgDd = selectedOffers.reduce((acc, item) => acc + asNumber(item.metrics.dd, 0), 0) / Math.max(1, selectedOffers.length);
    return buildSyntheticEquityPoints(initialBalance, avgRet, avgDd, resolvedPeriodDays);
  }

  const maxLength = normalizedCurves.reduce((acc, curve) => Math.max(acc, curve.length), 0);
  const out: Array<{ time: number; equity: number }> = [];
  for (let index = 0; index < maxLength; index += 1) {
    let sum = 0;
    let count = 0;
    for (const curve of normalizedCurves) {
      const value = curve[Math.min(index, curve.length - 1)];
      if (Number.isFinite(value)) {
        sum += value;
        count += 1;
      }
    }
    const avgReturn = count > 0 ? sum / count : 0;
    out.push({
      time: index + 1,
      equity: Number((initialBalance * (1 + avgReturn)).toFixed(4)),
    });
  }

  return out;
};

const resolveOfferPresetByPreference = (
  offer: CatalogOffer,
  riskLevel: Level3,
  tradeFrequencyLevel: Level3,
  riskScore?: number,
  tradeFrequencyScore?: number
): CatalogPreset => {
  const candidates = collectPresetCandidates(offer);
  if (candidates.length === 0) {
    return resolveOfferPreset(offer, riskLevel, tradeFrequencyLevel);
  }

  const sortedByDd = [...candidates].sort((left, right) => asNumber(left.metrics.dd, 0) - asNumber(right.metrics.dd, 0));
  const sortedByTrades = [...candidates].sort((left, right) => asNumber(left.metrics.trades, 0) - asNumber(right.metrics.trades, 0));
  const getCandidateKey = (item: CatalogPreset): string => [
    item.strategyId,
    asNumber(item.metrics.ret, 0).toFixed(6),
    asNumber(item.metrics.dd, 0).toFixed(6),
    asNumber(item.metrics.trades, 0).toFixed(6),
    asNumber(item.params.length, 0),
    asNumber(item.params.takeProfitPercent, 0).toFixed(6),
    asString(item.params.detectionSource, ''),
    asNumber(item.params.zscoreEntry, 0).toFixed(6),
    asNumber(item.params.zscoreExit, 0).toFixed(6),
    asNumber(item.params.zscoreStop, 0).toFixed(6),
  ].join('|');
  const ddRank = new Map<string, number>();
  const tradeRank = new Map<string, number>();

  sortedByDd.forEach((item, index) => ddRank.set(getCandidateKey(item), index));
  sortedByTrades.forEach((item, index) => tradeRank.set(getCandidateKey(item), index));

  const targetDd = (normalizePreferenceScore(riskScore, riskLevel) / 10) * Math.max(sortedByDd.length - 1, 0);
  const targetTrades = (normalizePreferenceScore(tradeFrequencyScore, tradeFrequencyLevel) / 10) * Math.max(sortedByTrades.length - 1, 0);

  const scored = [...candidates].map((item) => {
    const score = Math.abs((ddRank.get(getCandidateKey(item)) || 0) - targetDd) + Math.abs((tradeRank.get(getCandidateKey(item)) || 0) - targetTrades);
    return { item, score };
  }).sort((a, b) => a.score - b.score || asNumber(b.item.score, 0) - asNumber(a.item.score, 0));

  const best = scored[0].item;
  const second = scored.length > 1 ? scored[1].item : null;

  if (!second || scored[0].score === 0) {
    return best;
  }

  const totalDist = scored[0].score + scored[1].score;
  const t = totalDist > 0 ? scored[0].score / totalDist : 0;

  const lerpNum = (a: number, b: number, frac: number): number => a + (b - a) * frac;

  const interpolated: CatalogPreset = {
    ...best,
    metrics: {
      ret: Number(lerpNum(asNumber(best.metrics.ret, 0), asNumber(second.metrics.ret, 0), t).toFixed(4)),
      pf: Number(lerpNum(asNumber(best.metrics.pf, 0), asNumber(second.metrics.pf, 0), t).toFixed(4)),
      dd: Number(lerpNum(asNumber(best.metrics.dd, 0), asNumber(second.metrics.dd, 0), t).toFixed(4)),
      wr: Number(lerpNum(asNumber(best.metrics.wr, 0), asNumber(second.metrics.wr, 0), t).toFixed(4)),
      trades: Math.round(lerpNum(asNumber(best.metrics.trades, 0), asNumber(second.metrics.trades, 0), t)),
    },
    score: Number(lerpNum(asNumber(best.score, 0), asNumber(second.score, 0), t).toFixed(4)),
  };

  if (Array.isArray(best.equity_curve) && best.equity_curve.length >= 2 &&
      Array.isArray(second.equity_curve) && second.equity_curve.length >= 2) {
    const len = Math.min(best.equity_curve.length, second.equity_curve.length);
    interpolated.equity_curve = [];
    for (let i = 0; i < len; i++) {
      interpolated.equity_curve.push(Number(lerpNum(
        asNumber(best.equity_curve[i], 0),
        asNumber(second.equity_curve[i], 0),
        t
      ).toFixed(4)));
    }
  }

  return interpolated;
};

const buildStrategyDraftFromRecord = (
  record: SweepRecord,
  name: string,
  maxDeposit: number,
  riskLevel: Level3,
  isActive: boolean
): Partial<Strategy> => {
  const marketRaw = asString(record.market, '').trim().toUpperCase();
  const marketParts = marketRaw.split('/').map((part) => part.trim()).filter(Boolean);
  const baseSymbol = asString(marketParts[0] || marketRaw.replace(/\/+$/g, ''), 'BTCUSDT');
  const quoteSymbol = asString(marketParts[1] || '', '');
  const lotPercent = getRiskLotPercent(riskLevel);
  return {
    name,
    strategy_type: record.strategyType as Strategy['strategy_type'],
    market_mode: normalizeModeForStrategy(record.marketMode),
    is_active: isActive,
    display_on_chart: true,
    show_settings: true,
    show_chart: true,
    show_indicators: true,
    show_positions_on_chart: true,
    show_trades_on_chart: true,
    show_values_each_bar: false,
    auto_update: true,
    take_profit_percent: asNumber(record.takeProfitPercent, 0),
    price_channel_length: Math.max(2, Math.floor(asNumber(record.length, 24))),
    detection_source: asString(record.detectionSource, 'close') === 'wick' ? 'wick' : 'close',
    zscore_entry: asNumber(record.zscoreEntry, 2),
    zscore_exit: asNumber(record.zscoreExit, 0.5),
    zscore_stop: asNumber(record.zscoreStop, 3),
    base_symbol: baseSymbol,
    quote_symbol: record.marketMode === 'mono' ? '' : asString(quoteSymbol, 'ETHUSDT'),
    interval: asString(record.interval, '4h'),
    base_coef: 1,
    quote_coef: record.marketMode === 'mono' ? 0 : 1,
    long_enabled: true,
    short_enabled: true,
    lot_long_percent: lotPercent,
    lot_short_percent: lotPercent,
    max_deposit: maxDeposit,
    margin_type: 'cross',
    leverage: 20,
    fixed_lot: false,
    reinvest_percent: 0,
  };
};

const parseSweepMarketLegs = (params: {
  marketMode: string;
  market?: string;
  baseSymbol?: string;
  quoteSymbol?: string;
}): { marketMode: 'mono' | 'synthetic'; base: string; quote: string; label: string } => {
  const modeRaw = asString(params.marketMode, 'mono').trim().toLowerCase();
  const marketMode: 'mono' | 'synthetic' = modeRaw === 'mono' ? 'mono' : 'synthetic';
  const marketRaw = asString(params.market, '').trim().toUpperCase();
  const marketParts = marketRaw.split('/').map((part) => part.trim()).filter(Boolean);
  const base = asString(params.baseSymbol || marketParts[0] || marketRaw.replace(/\/+$/g, ''), '').trim().toUpperCase();
  const quote = asString(params.quoteSymbol || marketParts[1] || '', '').trim().toUpperCase();
  const label = marketMode === 'mono' || !quote ? base : `${base}/${quote}`;
  return { marketMode, base, quote, label };
};

const isMarketAvailableOnExchange = (
  availableSymbols: Set<string>,
  params: {
    marketMode: string;
    market?: string;
    baseSymbol?: string;
    quoteSymbol?: string;
  }
): boolean => {
  const parsed = parseSweepMarketLegs(params);
  if (!parsed.base) {
    return false;
  }
  if (parsed.marketMode === 'mono' || !parsed.quote) {
    return availableSymbols.has(parsed.base);
  }
  return availableSymbols.has(parsed.base) && availableSymbols.has(parsed.quote);
};

const normalizeSweepMarketLabel = (record: SweepRecord): string => {
  return parseSweepMarketLegs({
    marketMode: record.marketMode,
    market: record.market,
  }).label;
};

const prefixStrategyName = (tenant: TenantRow, record: SweepRecord): string => {
  const sourceStrategyId = Number(record.strategyId || 0);
  const strategySuffix = sourceStrategyId > 0 ? `::SID${sourceStrategyId}` : '';
  const marketLabel = normalizeSweepMarketLabel(record);
  return `SAAS::${tenant.slug}::${record.marketMode.toUpperCase()}::${record.strategyType}::${marketLabel}${strategySuffix}`;
};

const getExistingTenantStrategies = async (apiKeyName: string, tenantSlug: string) => {
  const rows = await getStrategies(apiKeyName);
  return rows.filter((item) => asString(item.name).startsWith(`SAAS::${tenantSlug}::`));
};

const upsertTenantStrategies = async (
  tenant: TenantRow,
  apiKeyName: string,
  records: Array<{ offerId: string; record: SweepRecord; metrics: CatalogMetricSet & { score: number } }>,
  maxDepositTotal: number,
  riskLevel: Level3,
  activate: boolean,
  options?: { keepStrategyIds?: number[] },
): Promise<StrategyMaterializedRow[]> => {
  let existing = await getExistingTenantStrategies(apiKeyName, tenant.slug);
  const keepIds = new Set(
    (options?.keepStrategyIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0),
  );

  // Hard guard at materialization stage: if legacy/zombie duplicates exist for the
  // same SID (or exact same strategy name), archive all but the newest row before
  // proceeding. This prevents double execution after switch_system retries.
  const sidGroups = new Map<string, Strategy[]>();
  const nameGroups = new Map<string, Strategy[]>();
  for (const row of existing) {
    const name = asString(row.name, '');
    if (!name) continue;
    const sidMatch = name.match(/::SID(\d+)$/);
    if (sidMatch?.[1]) {
      const sid = sidMatch[1];
      if (!sidGroups.has(sid)) sidGroups.set(sid, []);
      sidGroups.get(sid)!.push(row);
    }
    if (!nameGroups.has(name)) nameGroups.set(name, []);
    nameGroups.get(name)!.push(row);
  }

  const duplicateArchiveIds = new Set<number>();
  const collectArchiveCandidates = (group: Strategy[]) => {
    if (!Array.isArray(group) || group.length <= 1) return;
    const sorted = [...group].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    for (let i = 1; i < sorted.length; i += 1) {
      const id = Number(sorted[i]?.id || 0);
      if (id > 0) duplicateArchiveIds.add(id);
    }
  };

  for (const group of sidGroups.values()) collectArchiveCandidates(group);
  for (const group of nameGroups.values()) collectArchiveCandidates(group);

  if (duplicateArchiveIds.size > 0) {
    for (const id of duplicateArchiveIds) {
      const row = existing.find((item) => Number(item.id || 0) === id);
      if (!row) continue;
      await saasArchiveStrategy(apiKeyName, {
        id,
        base_symbol: (row as any).base_symbol ?? null,
        quote_symbol: (row as any).quote_symbol ?? null,
        market_mode: (row as any).market_mode ?? null,
        name: asString(row.name),
      });
    }
    logger.warn(`[upsertTenantStrategies] archived duplicate tenant strategies for ${tenant.slug}/${apiKeyName}: ${duplicateArchiveIds.size}`);
    existing = await getExistingTenantStrategies(apiKeyName, tenant.slug);
  }

  const existingByName = new Map(existing.map((item) => [asString(item.name), item]));
  const perStrategyDeposit = Math.max(50, maxDepositTotal);
  const desiredNames = new Set<string>();
  const out: StrategyMaterializedRow[] = [];

  // Pre-load available symbols for the client's exchange to skip invalid pairs
  let availableSymbols: Set<string> | null = null;
  try {
    const symbols = await getAllSymbols(apiKeyName);
    if (Array.isArray(symbols) && symbols.length > 0) {
      availableSymbols = new Set(symbols.map((s: string) => s.toUpperCase()));
    }
  } catch {
    logger.warn(`[upsertTenantStrategies] Could not load symbols for ${apiKeyName}, skipping pair-validity filter`);
  }

  for (const item of records) {
    // Skip pairs not available on the client's exchange (Cloud multi-exchange support)
    if (availableSymbols) {
      const parsed = parseSweepMarketLegs({
        marketMode: item.record.marketMode,
        market: item.record.market,
      });
      if (parsed.label && !isMarketAvailableOnExchange(availableSymbols, {
        marketMode: item.record.marketMode,
        market: item.record.market,
      })) {
        const missingLegs = parsed.marketMode === 'synthetic' && parsed.quote
          ? [parsed.base, parsed.quote].filter((leg) => !availableSymbols!.has(leg))
          : [parsed.base].filter((leg) => !availableSymbols!.has(leg));
        logger.info(
          `[upsertTenantStrategies] Skipping ${parsed.label} for ${apiKeyName}: `
          + `pair not available on client exchange (missing: ${missingLegs.join(', ') || parsed.label})`
        );
        await db.run(
          `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
           VALUES (?, 'system', 'saas_materialize_pair_unavailable', ?, CURRENT_TIMESTAMP)`,
          [
            tenant.id,
            JSON.stringify({
              apiKeyName,
              market: parsed.label,
              missingLegs,
              offerId: item.offerId,
              strategyType: item.record.strategyType,
              marketMode: item.record.marketMode,
            }),
          ]
        );
        continue;
      }
    }

    const desiredName = prefixStrategyName(tenant, item.record);
    desiredNames.add(desiredName);
    const draft = buildStrategyDraftFromRecord(item.record, desiredName, perStrategyDeposit, riskLevel, activate);
    const found = existingByName.get(desiredName);

    if (found?.id) {
      const updated = await updateStrategy(apiKeyName, Number(found.id), draft, {
        allowBindingUpdate: true,
        source: 'saas_materialize',
      });
      await markMaterializedRuntimeOrigin(Number(updated.id), 'saas_materialize', 1);
      await db.run(
        `UPDATE strategies
         SET is_archived = 0, is_active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [activate ? 1 : 0, Number(updated.id)],
      ).catch(() => null);
      out.push({
        id: updated.id,
        name: updated.name,
        strategyId: updated.id,
        offerId: item.offerId,
        mode: item.record.marketMode,
        market: item.record.market,
        type: item.record.strategyType,
        metrics: item.metrics,
      });
      continue;
    }

    try {
      const created = await createStrategy(apiKeyName, draft, { allowActivePairConflict: true });
      if (created?.id) {
        await markMaterializedRuntimeOrigin(Number(created.id), 'saas_materialize', 1);
      }
      out.push({
        id: created.id,
        name: created.name,
        strategyId: created.id,
        offerId: item.offerId,
        mode: item.record.marketMode,
        market: item.record.market,
        type: item.record.strategyType,
        metrics: item.metrics,
      });
    } catch (error) {
      // Per-strategy failure (balance, conflict, exchange validation) must NOT abort the
      // whole client's materialization — that was the root cause of cross-account desync
      // (one client got 21/28, another 27/28). Log + audit + continue with next record.
      const message = (error as Error)?.message || String(error);
      logger.warn(`[upsertTenantStrategies] createStrategy failed for ${apiKeyName} ${desiredName}: ${message}`);
      try {
        await db.run(
          `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
           VALUES (?, 'system', 'saas_materialize_create_failed', ?, CURRENT_TIMESTAMP)`,
          [
            tenant.id,
            JSON.stringify({
              apiKeyName,
              desiredName,
              offerId: item.offerId,
              market: item.record.market,
              strategyType: item.record.strategyType,
              marketMode: item.record.marketMode,
              error: message,
            }),
          ]
        );
      } catch {
        // best-effort audit
      }
    }
  }

  for (const row of existing) {
    if (!row.id || desiredNames.has(asString(row.name))) {
      continue;
    }
    // Multi-TS portfolio materialize: do not archive sibling-book SAAS strategies.
    if (keepIds.has(Number(row.id))) {
      continue;
    }
    await saasArchiveStrategy(apiKeyName, {
      id: Number(row.id),
      base_symbol: (row as any).base_symbol ?? null,
      quote_symbol: (row as any).quote_symbol ?? null,
      market_mode: (row as any).market_mode ?? null,
      name: asString(row.name),
    });
  }

  return out;
};

const getBestExistingSourceSystem = async (): Promise<{ apiKeyName: string; systemId: number; systemName: string } | null> => {
  const row = await db.get(
    `SELECT
       ts.id AS system_id,
       ts.name AS system_name,
       ak.name AS api_key_name,
       COALESCE(ts.is_active, 0) AS is_active,
       COALESCE(ts.discovery_enabled, 0) AS discovery_enabled,
       SUM(CASE WHEN COALESCE(tsm.is_enabled, 1) = 1 THEN 1 ELSE 0 END) AS enabled_members,
       SUM(CASE WHEN COALESCE(tsm.is_enabled, 1) = 1 AND s.id IS NOT NULL THEN 1 ELSE 0 END) AS valid_enabled_members
     FROM trading_systems ts
     JOIN api_keys ak ON ak.id = ts.api_key_id
     LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id
     LEFT JOIN strategies s ON s.id = tsm.strategy_id AND s.api_key_id = ts.api_key_id
     GROUP BY ts.id, ts.name, ak.name, ts.is_active, ts.discovery_enabled, ts.updated_at
     ORDER BY
       valid_enabled_members DESC,
       COALESCE(ts.is_active, 0) DESC,
       enabled_members DESC,
       CASE
         WHEN UPPER(COALESCE(ts.name, '')) LIKE 'ALGOFUND_MASTER::%' THEN 5
         WHEN UPPER(COALESCE(ts.name, '')) LIKE '%PORTFOLIO%' THEN 4
         WHEN UPPER(COALESCE(ts.name, '')) LIKE '%SWEEP%' AND UPPER(COALESCE(ts.name, '')) NOT LIKE '%CANDIDATE%' THEN 3
         WHEN UPPER(COALESCE(ts.name, '')) LIKE '%HISTSWEEP%' AND UPPER(COALESCE(ts.name, '')) NOT LIKE '%CANDIDATE%' THEN 2
         WHEN UPPER(COALESCE(ts.name, '')) LIKE '%CANDIDATE%' THEN 0
         ELSE 1
       END DESC,
       COALESCE(ts.discovery_enabled, 0) DESC,
       datetime(ts.updated_at) DESC,
       ts.id DESC
     LIMIT 1`
  );

  if (!row) {
    return null;
  }

  if (asNumber((row as Record<string, unknown>).valid_enabled_members, 0) <= 0) {
    return null;
  }

  return {
    apiKeyName: asString(row.api_key_name),
    systemId: asNumber(row.system_id, 0),
    systemName: asString(row.system_name),
  };
};

const resolveApiKeyNameForStrategyIds = async (
  strategyIdsRaw: number[],
  fallbackApiKeyName = '',
  options?: { strict?: boolean }
): Promise<string> => {
  const strict = options?.strict !== false;
  const strategyIds = Array.from(new Set(
    (Array.isArray(strategyIdsRaw) ? strategyIdsRaw : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));

  if (strategyIds.length === 0) {
    return asString(fallbackApiKeyName, '');
  }

  const placeholders = strategyIds.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT s.id AS strategy_id, ak.name AS api_key_name
     FROM strategies s
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE s.id IN (${placeholders})`,
    strategyIds
  );

  const rowByStrategyId = new Map<number, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const strategyId = asNumber((row as Record<string, unknown>).strategy_id, 0);
    const apiKeyName = asString((row as Record<string, unknown>).api_key_name, '');
    if (strategyId > 0 && apiKeyName) {
      rowByStrategyId.set(strategyId, apiKeyName);
    }
  }

  const missingIds = strategyIds.filter((id) => !rowByStrategyId.has(id));
  if (missingIds.length > 0) {
    if (strict) {
      throw new Error(`Cannot resolve api key for strategy ids: ${missingIds.join(', ')}`);
    }
    return asString(fallbackApiKeyName, '');
  }

  const uniqueApiKeys = Array.from(new Set(strategyIds
    .map((id) => asString(rowByStrategyId.get(id), ''))
    .filter(Boolean)));

  if (uniqueApiKeys.length === 1) {
    return uniqueApiKeys[0];
  }
  if (strict) {
    throw new Error(`Draft TS mixes multiple api keys: ${uniqueApiKeys.join(', ')}. Keep one api key per TS.`);
  }
  return asString(fallbackApiKeyName, uniqueApiKeys[0] || '');
};

const normalizePublishOfferIds = (offerIds?: string[]): string[] => Array.from(new Set(
  (Array.isArray(offerIds) ? offerIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
));

const parseStrategyIdFromOfferId = (offerId: string): number => {
  const parsed = Number((String(offerId || '').match(/(\d+)$/)?.[1]) || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const getStrategyNameMapByIds = async (strategyIdsRaw: number[]): Promise<Map<number, string>> => {
  const strategyIds = Array.from(new Set(
    (Array.isArray(strategyIdsRaw) ? strategyIdsRaw : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));

  if (strategyIds.length === 0) {
    return new Map<number, string>();
  }

  const placeholders = strategyIds.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT id, name FROM strategies WHERE id IN (${placeholders})`,
    strategyIds
  );

  const byId = new Map<number, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = asNumber((row as Record<string, unknown>).id, 0);
    const name = asString((row as Record<string, unknown>).name, '').trim();
    if (id > 0 && name) {
      byId.set(id, name);
    }
  }

  return byId;
};

const buildSetSlug = (raw: string): string => asString(raw, '')
  .trim()
  .toLowerCase()
  // Preserve intentional suffixes: "v2+" and "v2 plus" must not collapse to "v2".
  .replace(/\+/g, '-plus-')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

const simpleHash36 = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
};

const buildPublishSystemSuffix = (setKey: string, offerIds: string[]): string => {
  const slug = buildSetSlug(setKey);
  const seed = offerIds.join('|') || setKey || 'default';
  const hash = simpleHash36(seed).slice(0, 8);
  if (slug) {
    return `${slug}-${hash}`;
  }
  return `set-${hash}`;
};

const resolvePublishDraftMembers = async (
  catalog: CatalogData | null,
  offerIds: string[],
  setKey?: string
): Promise<CatalogData['adminTradingSystemDraft']['members']> => {
  const fallbackMembers = Array.isArray(catalog?.adminTradingSystemDraft?.members)
    ? (catalog?.adminTradingSystemDraft?.members || [])
    : [];

  if (!catalog || offerIds.length === 0) {
    // Continue to snapshot fallback below if setKey is provided.
    if (!setKey) {
      return fallbackMembers;
    }
  }

  const offersById = new Map<string, CatalogOffer>();
  if (catalog) {
    for (const offer of getAllOffers(catalog)) {
      const offerId = String(offer?.offerId || '').trim();
      if (offerId) {
        offersById.set(offerId, offer);
      }
    }
  }

  const mapped = offerIds
    .map((offerId) => offersById.get(offerId) || null)
    .filter((offer): offer is CatalogOffer => Boolean(offer))
    .map((offer, index, arr) => ({
      strategyId: Number(offer.strategy?.id || 0),
      strategyName: asString(offer.strategy?.name, `Strategy ${index + 1}`),
      strategyType: asString(offer.strategy?.type, 'DD_BattleToads'),
      marketMode: offer.strategy?.mode === 'synth' ? 'synthetic' : 'mono',
      market: asString(offer.strategy?.market, ''),
      score: Number(asNumber(offer.metrics?.score, 0).toFixed(3)),
      weight: Number((1 / Math.max(1, arr.length)).toFixed(4)),
    }))
    .filter((member) => Number.isFinite(member.strategyId) && member.strategyId > 0);

  if (mapped.length > 0) {
    return mapped;
  }

  // Snapshot-based fallback: allows publishing historical saved sets
  // even when they are absent from the current sweep catalog.
  const offerStore = await getOfferStoreAdminState();
  const snapshotMap = offerStore.tsBacktestSnapshots || {};
  const normalizedSetKey = normalizeTsSnapshotMapKey(asString(setKey, ''));
  const normalizedOfferIds = Array.from(new Set(
    (Array.isArray(offerIds) ? offerIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));

  let snapshot = normalizedSetKey ? (snapshotMap[normalizedSetKey] || null) : null;
  if (!snapshot && normalizedOfferIds.length > 0) {
    snapshot = Object.values(snapshotMap).find((item) => {
      const itemOfferIds = Array.from(new Set(
        (Array.isArray(item.offerIds) ? item.offerIds : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      ));
      if (itemOfferIds.length === 0) {
        return false;
      }
      return normalizedOfferIds.some((offerId) => itemOfferIds.includes(offerId));
    }) || null;
  }

  if (!snapshot) {
    return fallbackMembers;
  }

  const snapshotOfferIds = Array.from(new Set(
    (Array.isArray(snapshot.offerIds) ? snapshot.offerIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));
  if (snapshotOfferIds.length === 0) {
    return fallbackMembers;
  }

  const offerStoreById = new Map(
    (offerStore.offers || []).map((offer) => [String(offer.offerId || '').trim(), offer])
  );

  const snapshotMembers = snapshotOfferIds
    .map((offerId, index, arr) => {
      const offer = offerStoreById.get(offerId);
      const strategyIdFromOffer = Number(offer?.strategyId || 0);
      const parsedFromOfferId = parseStrategyIdFromOfferId(offerId);
      const strategyId = strategyIdFromOffer > 0 ? strategyIdFromOffer : parsedFromOfferId;
      if (!Number.isFinite(strategyId) || strategyId <= 0) {
        return null;
      }
      return {
        strategyId,
        strategyName: asString(offer?.titleRu, `Snapshot strategy ${index + 1}`),
        strategyType: 'DD_BattleToads',
        marketMode: offer?.mode === 'synth' ? 'synthetic' : 'mono',
        market: asString(offer?.market, ''),
        score: Number(asNumber(offer?.score, 0).toFixed(3)),
        weight: Number((1 / Math.max(1, arr.length)).toFixed(4)),
      };
    })
    .filter((member): member is CatalogData['adminTradingSystemDraft']['members'][number] => Boolean(member));

  if (snapshotMembers.length > 0) {
    return snapshotMembers;
  }

  return fallbackMembers;
};

const ensurePublishedSourceSystem = async (
  tenantId?: number,
  options?: {
    draftMembersOverride?: CatalogData['adminTradingSystemDraft']['members'];
    systemNameSuffix?: string;
  }
): Promise<{ apiKeyName: string; systemId: number; systemName: string }> => {
  let catalog = loadLatestClientCatalog();
  const draftMembers = Array.isArray(options?.draftMembersOverride) && (options?.draftMembersOverride?.length || 0)  > 0
    ? (options?.draftMembersOverride || [])
    : (catalog?.adminTradingSystemDraft?.members || []);
  const systemNameSuffix = asString(options?.systemNameSuffix, '').trim();
  const inferMaxOpenPositions = (name: string): number => {
    if (/cloud-op\d+$/i.test(name)) return 2;
    // All ALGOFUND client systems (algofund profiles) enforce OP=2
    // Matches ALGOFUND:: and ALGOFUND_MASTER:: and any ALGOFUND* prefix
    if (/^ALGOFUND/i.test(name)) return 2;
    return 0;
  };
  // Prefer per-card override stored in master_cards.metadata_json,
  // fall back to the legacy name-based heuristic above.
  const resolveMaxOpenPositions = async (name: string): Promise<number> => {
    const cfg = await getCardConfigBySystemName(name);
    if (cfg.maxOpenPositions > 0) return cfg.maxOpenPositions;
    return inferMaxOpenPositions(name);
  };

  if (tenantId) {
    const [tenant, profile] = await Promise.all([
      getTenantById(tenantId),
      getAlgofundProfile(tenantId).catch(() => null),
    ]);

    if (tenant) {
      const tenantApiKeyName = asString(profile?.assigned_api_key_name || tenant.assigned_api_key_name || catalog?.apiKeyName);
      const preferredSystemName = asString(profile?.published_system_name || getAlgofundClientSystemName(tenant));

      if (tenantApiKeyName) {
        try {
          const systems = await listTradingSystems(tenantApiKeyName);
          const tenantSystem = systems.find((item) => asString(item.name) === preferredSystemName)
            || systems.find((item) => asString(item.name) === getAlgofundClientSystemName(tenant));

          if (tenantSystem?.id && tenantSystem.id > 0) {
            return {
              apiKeyName: tenantApiKeyName,
              systemId: Number(tenantSystem.id),
              systemName: asString(tenantSystem.name, preferredSystemName),
            };
          }
        } catch (error) {
          logger.warn(`Failed to lookup tenant algofund system: ${(error as Error).message}`);
        }
      }
    }
  }

  const memberStrategyIdsOverrideEarly = draftMembers
    .map((item) => Number(item.strategyId || 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!catalog) {
    if (memberStrategyIdsOverrideEarly.length === 0) {
      const fallback = await getBestExistingSourceSystem();
      if (fallback && fallback.apiKeyName && fallback.systemId > 0) {
        return fallback;
      }
      throw new Error('Client catalog JSON not found in results/, and no trading systems available in DB.');
    }
    catalog = {
      timestamp: new Date().toISOString(),
      source: { sweepTimestamp: '', catalogPath: 'publish-draft-override' },
      counts: { mono: 0, synth: 0, total: 0 },
      apiKeyName: '',
      config: { interval: '4h' },
      adminTradingSystemDraft: { members: draftMembers },
      clientCatalog: { mono: [], synth: [] },
    } as unknown as CatalogData;
  }

  // Resolve api key by strategy ownership in DB (source of truth), not by latest sweep.
  // This avoids mismatches when the latest sweep/catalog and draft TS come from different keys.
  const sweep = loadLatestSweep();
  const sweepApiKey = asString((sweep as Record<string, unknown>)?.apiKeyName || ((sweep as Record<string, unknown>)?.config as Record<string, unknown>)?.apiKeyName, '');
  const memberStrategyIds = (catalog.adminTradingSystemDraft?.members || [])
    .map((item) => Number(item.strategyId || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const memberStrategyIdsOverride = draftMembers
    .map((item) => Number(item.strategyId || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const strategyIdsForPublish = memberStrategyIdsOverride.length > 0 ? memberStrategyIdsOverride : memberStrategyIds;
  let apiKeyName = '';
  try {
    apiKeyName = await resolveApiKeyNameForStrategyIds(strategyIdsForPublish, sweepApiKey || asString(catalog.apiKeyName), { strict: true });
  } catch (error) {
    logger.warn(`Failed to resolve draft TS api key by strategy ownership: ${(error as Error).message}`);
  }

  if (!apiKeyName) {
    apiKeyName = asString(catalog.apiKeyName || sweepApiKey, '');
  }

  if (!apiKeyName) {
    const fallback = await getBestExistingSourceSystem();
    if (fallback && fallback.apiKeyName && fallback.systemId > 0) {
      return fallback;
    }
    throw new Error('Cannot resolve api key for draft TS members and no fallback trading system found.');
  }
  const systemName = `ALGOFUND_MASTER::${apiKeyName}${systemNameSuffix ? `::${systemNameSuffix}` : ''}`;
  const systemMaxOpenPositions = await resolveMaxOpenPositions(systemName);
  const systems = await listTradingSystems(apiKeyName);
  const existing = systems.find((item) => asString(item.name) === systemName);
  const membersRaw = (draftMembers || []).map((item, index) => ({
    strategy_id: Number(item.strategyId),
    strategy_name: asString(item.strategyName, '').trim(),
    weight: asNumber(item.weight, index === 0 ? 1.25 : index === 1 ? 1.1 : 1),
    member_role: index < 3 ? 'core' : 'satellite',
    is_enabled: true,
    notes: `algofund_master ${item.strategyType} ${item.market}`,
  }));
  const existingStrategies = await getStrategies(apiKeyName, { includeLotPreview: false }).catch(() => []);
  const existingStrategyIds = new Set(
    (Array.isArray(existingStrategies) ? existingStrategies : [])
      .map((row) => Number((row as { id?: number })?.id || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  const existingStrategyIdByName = new Map<string, number>();
  for (const row of Array.isArray(existingStrategies) ? existingStrategies : []) {
    const id = Number((row as { id?: number })?.id || 0);
    const name = asString((row as { name?: string })?.name, '').trim().toLowerCase();
    if (id > 0 && name) {
      existingStrategyIdByName.set(name, id);
    }
  }

  const dedupeStrategyIds = new Set<number>();
  const trustDraftPublishIds = memberStrategyIdsOverrideEarly.length > 0;
  const members = membersRaw
    .map((item) => {
      const currentId = Number(item.strategy_id || 0);
      const resolvedId = trustDraftPublishIds
        ? currentId
        : (existingStrategyIds.has(currentId)
          ? currentId
          : Number(existingStrategyIdByName.get(asString(item.strategy_name, '').toLowerCase()) || 0));

      if (!resolvedId || dedupeStrategyIds.has(resolvedId)) {
        return null;
      }
      dedupeStrategyIds.add(resolvedId);

      return {
        strategy_id: resolvedId,
        weight: item.weight,
        member_role: item.member_role,
        is_enabled: item.is_enabled,
        notes: item.notes,
      };
    })
    .filter((item): item is { strategy_id: number; weight: number; member_role: string; is_enabled: boolean; notes: string } => Boolean(item));

  if (members.length === 0) {
    const runtimeApiKeys = Array.from(new Set([
      apiKeyName,
      ...(await getAvailableApiKeyNames()),
    ].map((value) => asString(value, '').trim()).filter(Boolean)));

    for (const runtimeApiKeyName of runtimeApiKeys) {
      const runtimeStrategies = await getStrategies(runtimeApiKeyName, { includeLotPreview: false }).catch(() => []);
      const runtimeMembers = (Array.isArray(runtimeStrategies) ? runtimeStrategies : [])
        .map((row, index) => {
          const strategyId = Number((row as { id?: number })?.id || 0);
          if (!strategyId || !Number.isFinite(strategyId)) {
            return null;
          }
          return {
            strategy_id: strategyId,
            weight: index === 0 ? 1.25 : index === 1 ? 1.1 : 1,
            member_role: index < 3 ? 'core' : 'satellite',
            is_enabled: true,
            notes: 'algofund_master runtime_fallback',
          };
        })
        .filter((item): item is { strategy_id: number; weight: number; member_role: string; is_enabled: boolean; notes: string } => Boolean(item))
        .slice(0, 6);

      if (runtimeMembers.length === 0) {
        continue;
      }

      const runtimeSystemName = `ALGOFUND_MASTER::${runtimeApiKeyName}${systemNameSuffix ? `::${systemNameSuffix}` : ''}`;
      const runtimeSystems = runtimeApiKeyName === apiKeyName
        ? systems
        : await listTradingSystems(runtimeApiKeyName).catch(() => []);
      const runtimeExisting = (Array.isArray(runtimeSystems) ? runtimeSystems : [])
        .find((item) => asString(item.name) === runtimeSystemName);

      if (runtimeExisting?.id) {
        const runtimeUpdateDraft = {
          name: runtimeSystemName,
          description: 'Published admin TS (runtime fallback from available strategies)',
          auto_sync_members: false,
          discovery_enabled: false,
          max_members: Math.max(6, runtimeMembers.length),
          max_open_positions: await resolveMaxOpenPositions(runtimeSystemName),
        } as any;
        await updateTradingSystem(runtimeApiKeyName, Number(runtimeExisting.id), runtimeUpdateDraft);
        await replaceTradingSystemMembers(runtimeApiKeyName, Number(runtimeExisting.id), runtimeMembers);
        logger.warn(`Draft TS members unavailable for ${apiKeyName}; used runtime fallback API key ${runtimeApiKeyName} with ${runtimeMembers.length} members.`);
        return { apiKeyName: runtimeApiKeyName, systemId: Number(runtimeExisting.id), systemName: runtimeSystemName };
      }

      const runtimeCreateDraft = {
        name: runtimeSystemName,
        description: 'Published admin TS (runtime fallback from available strategies)',
        auto_sync_members: false,
        discovery_enabled: false,
        max_members: Math.max(6, runtimeMembers.length),
        max_open_positions: await resolveMaxOpenPositions(runtimeSystemName),
        members: runtimeMembers,
      } as any;
      const runtimeCreated = await createTradingSystem(runtimeApiKeyName, runtimeCreateDraft);
      logger.warn(`Draft TS members unavailable for ${apiKeyName}; created runtime fallback system on ${runtimeApiKeyName} with ${runtimeMembers.length} members.`);
      return { apiKeyName: runtimeApiKeyName, systemId: Number(runtimeCreated.id), systemName: runtimeSystemName };
    }

    const materializeApiKeyName = asString(apiKeyName || catalog.apiKeyName || sweepApiKey, '').trim();
    const evaluatedRows = Array.isArray(sweep?.evaluated) ? sweep?.evaluated || [] : [];
    const evaluatedById = new Map<number, SweepRecord>();
    for (const row of evaluatedRows) {
      const strategyId = Number((row as SweepRecord)?.strategyId || 0);
      if (strategyId > 0 && !evaluatedById.has(strategyId)) {
        evaluatedById.set(strategyId, row as SweepRecord);
      }
    }

    if (materializeApiKeyName && evaluatedById.size > 0) {
      const draftRecords = (draftMembers || [])
        .map((member) => evaluatedById.get(Number(member.strategyId || 0)) || null)
        .filter((row): row is SweepRecord => Boolean(row));

      if (draftRecords.length > 0) {
        const currentRows = await getStrategies(materializeApiKeyName, { includeLotPreview: false }).catch(() => []);
        const currentByName = new Map<string, number>();
        for (const row of Array.isArray(currentRows) ? currentRows : []) {
          const id = Number((row as { id?: number })?.id || 0);
          const name = asString((row as { name?: string })?.name, '').trim();
          if (id > 0 && name) {
            currentByName.set(name, id);
          }
        }

        const materializedMembers: Array<{ strategy_id: number; weight: number; member_role: string; is_enabled: boolean; notes: string }> = [];
        for (let index = 0; index < draftRecords.length && materializedMembers.length < 6; index += 1) {
          const record = draftRecords[index];
          const name = `SAAS::ADMIN::${record.marketMode.toUpperCase()}::${record.strategyType}::${record.market}`;
          const existingId = Number(currentByName.get(name) || 0);

          let strategyId = existingId;
          if (strategyId <= 0) {
            const created = await createStrategy(
              materializeApiKeyName,
              buildStrategyDraftFromRecord(record, name, Math.max(250, SAAS_PREVIEW_INITIAL_BALANCE), 'medium', false)
            );
            strategyId = Number((created as { id?: number })?.id || 0);
          }

          if (strategyId > 0) {
            materializedMembers.push({
              strategy_id: strategyId,
              weight: index === 0 ? 1.25 : index === 1 ? 1.1 : 1,
              member_role: index < 3 ? 'core' : 'satellite',
              is_enabled: true,
              notes: 'algofund_master materialized_from_sweep',
            });
          }
        }

        if (materializedMembers.length > 0) {
          const materializedSystemName = `ALGOFUND_MASTER::${materializeApiKeyName}${systemNameSuffix ? `::${systemNameSuffix}` : ''}`;
          const materializedSystems = await listTradingSystems(materializeApiKeyName).catch(() => []);
          const materializedExisting = (Array.isArray(materializedSystems) ? materializedSystems : [])
            .find((item) => asString(item.name) === materializedSystemName);

          if (materializedExisting?.id) {
            const materializedUpdateDraft = {
              name: materializedSystemName,
              description: 'Published admin TS (auto materialized from sweep draft)',
              auto_sync_members: false,
              discovery_enabled: false,
              max_members: Math.max(6, materializedMembers.length),
              max_open_positions: await resolveMaxOpenPositions(materializedSystemName),
            } as any;
            await updateTradingSystem(materializeApiKeyName, Number(materializedExisting.id), materializedUpdateDraft);
            await replaceTradingSystemMembers(materializeApiKeyName, Number(materializedExisting.id), materializedMembers);
            logger.warn(`Auto-materialized ${materializedMembers.length} draft members for ${materializeApiKeyName} to recover publish flow.`);
            return {
              apiKeyName: materializeApiKeyName,
              systemId: Number(materializedExisting.id),
              systemName: materializedSystemName,
            };
          }

          const materializedCreateDraft = {
            name: materializedSystemName,
            description: 'Published admin TS (auto materialized from sweep draft)',
            auto_sync_members: false,
            discovery_enabled: false,
            max_members: Math.max(6, materializedMembers.length),
            max_open_positions: await resolveMaxOpenPositions(materializedSystemName),
            members: materializedMembers,
          } as any;
          const materializedCreated = await createTradingSystem(materializeApiKeyName, materializedCreateDraft);
          logger.warn(`Auto-created materialized source TS with ${materializedMembers.length} members for ${materializeApiKeyName}.`);
          return {
            apiKeyName: materializeApiKeyName,
            systemId: Number(materializedCreated.id),
            systemName: materializedSystemName,
          };
        }
      }
    }

    const fallback = await getBestExistingSourceSystem();
    if (fallback && fallback.apiKeyName && fallback.systemId > 0) {
      return fallback;
    }
    throw new Error('Draft TS has no strategies available in runtime API key; cannot publish.');
  }

  if (members.length < membersRaw.length) {
    logger.warn(`Draft TS members filtered by runtime availability: kept=${members.length}, total=${membersRaw.length}, apiKey=${apiKeyName}`);
  }

  if (existing?.id) {
    const updateDraft = {
      name: systemName,
      description: 'Published admin TS from latest client catalog',
      auto_sync_members: false,
      discovery_enabled: false,
      max_members: Math.max(6, members.length),
      max_open_positions: systemMaxOpenPositions,
    } as any;
    await updateTradingSystem(apiKeyName, Number(existing.id), updateDraft);
    await replaceTradingSystemMembers(apiKeyName, Number(existing.id), members);
    return { apiKeyName, systemId: Number(existing.id), systemName };
  }

  const createDraft = {
    name: systemName,
    description: 'Published admin TS from latest client catalog',
    auto_sync_members: false,
    discovery_enabled: false,
    max_members: Math.max(6, members.length),
    max_open_positions: systemMaxOpenPositions,
    members,
  } as any;

  const created = await createTradingSystem(apiKeyName, createDraft);

  return { apiKeyName, systemId: Number(created.id), systemName };
};

  export const createTenantByAdmin = async (payload: {
    displayName: string;
    productMode: ProductMode;
    planCode: string;
    algofundPlanCode?: string;
    assignedApiKeyName?: string;
    inlineApiKeyName?: string;
    inlineApiKey?: string;
    inlineApiSecret?: string;
    inlineApiExchange?: string;
    inlineApiPassphrase?: string;
    inlineApiSpeedLimit?: number;
    inlineApiTestnet?: boolean;
    inlineApiDemo?: boolean;
    language?: string;
    email?: string;
    fullName?: string;
  }) => {
    const displayName = asString(payload.displayName, '').trim();
    if (!displayName) throw new Error('displayName is required');
    if (payload.productMode !== 'strategy_client' && payload.productMode !== 'algofund_client' && payload.productMode !== 'copytrading_client' && payload.productMode !== 'dual') {
      throw new Error('productMode must be strategy_client, algofund_client, copytrading_client or dual');
    }

    await ensureSaasSeedData();

    const plan = await getPlanByCode(payload.planCode);
    if (plan.product_mode !== payload.productMode && payload.productMode !== 'dual') {
      throw new Error(`Plan ${payload.planCode} does not belong to mode ${payload.productMode}`);
    }

    // Generate unique slug from display name
    const baseSlug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tenant';

    let slug = baseSlug;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await db.get('SELECT id FROM tenants WHERE slug = ?', [slug]);
      if (!existing) break;
      attempt++;
      slug = `${baseSlug}-${attempt}`;
    }

    // Ensure deposit_cap_override column exists (idempotent migration)
    await db.run(`ALTER TABLE tenants ADD COLUMN deposit_cap_override INTEGER DEFAULT NULL`).catch(() => { /* already exists */ });
    await db.run(`ALTER TABLE plans ADD COLUMN original_price_usdt REAL DEFAULT NULL`).catch(() => { /* already exists */ });

    let apiKeyName = asString(payload.assignedApiKeyName, '');
    const inlineApiKeyNameRaw = asString(payload.inlineApiKeyName, '').trim();
    const inlineApiKey = asString(payload.inlineApiKey, '').trim();
    const inlineApiSecret = asString(payload.inlineApiSecret, '').trim();
    const inlineApiExchange = asString(payload.inlineApiExchange, 'bybit').trim() || 'bybit';
    const inlineApiPassphrase = asString(payload.inlineApiPassphrase, '').trim();
    const inlineApiSpeedLimit = Math.max(1, Math.min(200, Math.floor(asNumber(payload.inlineApiSpeedLimit, 10))));
    const inlineApiTestnet = Boolean(payload.inlineApiTestnet);
    const inlineApiDemo = Boolean(payload.inlineApiDemo);

    if (inlineApiKey || inlineApiSecret || inlineApiKeyNameRaw) {
      if (!inlineApiKey || !inlineApiSecret) {
        throw new Error('inlineApiKey and inlineApiSecret are required when creating an inline API key');
      }
      if (['bitget', 'weex'].includes(inlineApiExchange.toLowerCase()) && !inlineApiPassphrase) {
        throw new Error('inlineApiPassphrase is required for Bitget and WEEX');
      }

      const keyBase = (inlineApiKeyNameRaw || `${baseSlug}-api`)
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || `${baseSlug}-api`;

      let inlineName = keyBase;
      let keyAttempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const existingKey = await db.get('SELECT id FROM api_keys WHERE name = ?', [inlineName]);
        if (!existingKey) break;
        keyAttempt += 1;
        inlineName = `${keyBase}-${keyAttempt}`;
      }

      await saveApiKey({
        name: inlineName,
        exchange: inlineApiExchange,
        api_key: inlineApiKey,
        secret: inlineApiSecret,
        passphrase: inlineApiPassphrase,
        speed_limit: inlineApiSpeedLimit,
        testnet: inlineApiTestnet,
        demo: inlineApiDemo,
      });

      apiKeyName = inlineName;
      logger.info(`[SaaS] Created inline API key for tenant creation: ${inlineName}`);
    }

    const language = asString(payload.language, 'ru');

    await db.run(
      `INSERT INTO tenants (slug, display_name, product_mode, status, preferred_language, assigned_api_key_name, deposit_cap_override, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [slug, displayName, payload.productMode, language, apiKeyName]
    );

    const tenant = await db.get('SELECT * FROM tenants WHERE slug = ?', [slug]) as TenantRow;
    if (!tenant) throw new Error('Failed to create tenant');

    await ensureSubscription(tenant.id, plan.id, payload.productMode === 'dual' ? plan.product_mode : undefined);

    if (payload.productMode === 'dual') {
      let pairedAlgofundPlanCode = asString(payload.algofundPlanCode, '').trim();
      if (!pairedAlgofundPlanCode) {
        const planCode = asString(plan.code, '');
        const suffix = planCode.startsWith('strategy_') ? planCode.replace(/^strategy_/, '') : '';
        if (suffix) {
          pairedAlgofundPlanCode = `algofund_${suffix}`;
        }
      }

      if (pairedAlgofundPlanCode) {
        try {
          const algoPlan = await getPlanByCode(pairedAlgofundPlanCode);
          await ensureSubscription(tenant.id, algoPlan.id, algoPlan.product_mode);
        } catch (err: any) {
          logger.warn(`[SaaS] Could not auto-attach algofund plan ${pairedAlgofundPlanCode} for tenant ${tenant.id}: ${err?.message || err}`);
        }
      }
    }

    if (payload.productMode === 'strategy_client' || payload.productMode === 'dual') {
      await ensureStrategyClientProfile(tenant.id, [], apiKeyName);
    }
    if (payload.productMode === 'algofund_client' || payload.productMode === 'dual') {
      await ensureAlgofundProfile(tenant.id, apiKeyName);
    }
    if (payload.productMode === 'copytrading_client') {
      await ensureCopytradingProfile(tenant.id, apiKeyName);
    }
    // Optionally create a client user account if email is provided
    if (payload.email) {
      const email = String(payload.email).trim().toLowerCase();
      const fullName = asString(payload.fullName, displayName);
      const existingUser = await db.get('SELECT id FROM client_users WHERE email = ?', [email]).catch(() => null);
      if (!existingUser) {
        await db.run(
          `INSERT INTO client_users (tenant_id, email, full_name, password_hash, onboarding_completed_at, created_at, updated_at)
           VALUES (?, ?, ?, '', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [tenant.id, email, fullName]
        ).catch((err: Error) => logger.warn(`Could not create client user: ${err.message}`));
      }
    }

    logger.info(`[SaaS] Created tenant: slug=${slug}, mode=${payload.productMode}, plan=${payload.planCode}`);

    return listTenantSummaries();
  };

  export const deleteTenantById = async (tenantId: number): Promise<void> => {
    // Stop all active strategies on API keys belonging to this tenant
    const tenantApiKeyRows = (await db.all(
      `SELECT name FROM api_keys WHERE name LIKE ?`,
      [`tenant-${tenantId}-%`]
    )) as Array<{ name: string }>;
    for (const row of tenantApiKeyRows) {
      await db.run(
        `UPDATE strategies SET is_active = 0 WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)`,
        [row.name]
      );
    }

    // Delete profile rows (order matters for FK constraints)
    await db.run(`DELETE FROM algofund_active_systems WHERE profile_id IN (SELECT id FROM algofund_profiles WHERE tenant_id = ?)`, [tenantId]);
    await db.run(`DELETE FROM algofund_profiles WHERE tenant_id = ?`, [tenantId]);
    await db.run(`DELETE FROM strategy_client_profiles WHERE tenant_id = ?`, [tenantId]);
    await db.run(`DELETE FROM copytrading_profiles WHERE tenant_id = ?`, [tenantId]).catch(() => { /* table may not exist yet */ });
    await db.run(`DELETE FROM client_users WHERE tenant_id = ?`, [tenantId]);

    // Delete API keys that belong to this tenant
    for (const row of tenantApiKeyRows) {
      await db.run(`DELETE FROM api_keys WHERE name = ?`, [row.name]);
    }

    // Delete the tenant record last
    await db.run(`DELETE FROM tenants WHERE id = ?`, [tenantId]);

    logger.info(`[SaaS] Deleted tenant ${tenantId} along with ${tenantApiKeyRows.length} API key(s)`);
  };

type AdminTelegramControls = {
  adminEnabled: boolean;
  clientsEnabled: boolean;
  runtimeOnly: boolean;
  reconciliationCycleEnabled: boolean;
  tokenConfigured: boolean;
  chatConfigured: boolean;
  reportIntervalMinutes: number;
  sectionAccounts: boolean;
  sectionDrift: boolean;
  sectionLowlot: boolean;
};

export type LowLotRecommendation = {
  apiKeyName: string;
  strategyId: number;
  strategyName: string;
  pair: string;
  mode: string;
  maxDeposit: number;
  leverage: number;
  lotPercent: number;
  lastError: string;
  updatedAt: string;
  tenants: Array<{ id: number; slug: string; displayName: string; mode: ProductMode }>;
  suggestedDepositMin: number;
  suggestedLotPercent: number;
  replacementCandidates: Array<{ symbol: string; score: number; note: string }>;
  systemId: number | null;
  eventSource: 'last_error' | 'runtime_event' | 'liquidity_trigger';
};

const getRuntimeFlag = async (key: string, fallback: string): Promise<string> => {
  const row = await runWithSqliteBusyRetry(() => db.get('SELECT value FROM app_runtime_flags WHERE key = ?', [key]));
  const value = String(row?.value || '').trim();
  return value || fallback;
};

const setRuntimeFlag = async (key: string, value: string): Promise<void> => {
  await runWithSqliteBusyRetry(async () => {
    await db.run(
      `INSERT INTO app_runtime_flags (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, value]
    );
  });
};

// Atomically write multiple runtime flags in a single SQLite transaction
const setRuntimeFlags = async (entries: Record<string, string>): Promise<void> => {
  const pairs = Object.entries(entries);
  if (pairs.length === 0) return;
  await runWithSqliteBusyRetry(async () => {
    await db.run('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of pairs) {
        await db.run(
          `INSERT INTO app_runtime_flags (key, value, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
          [key, value]
        );
      }
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK').catch(() => {});
      throw err;
    }
  });
};

const SQLITE_BUSY_RETRY_DELAY_MS = 120;
const SQLITE_BUSY_RETRY_ATTEMPTS = 6;

const isSqliteBusyError = (error: unknown): boolean => {
  const text = String((error as any)?.message || error || '').toLowerCase();
  return text.includes('sqlite_busy') || text.includes('database is locked') || text.includes('database table is locked');
};

const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runWithSqliteBusyRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < SQLITE_BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      lastError = error;
      const delay = SQLITE_BUSY_RETRY_DELAY_MS * (attempt + 1);
      await waitMs(delay);
    }
  }

  throw lastError as Error;
};

export const getAdminTelegramControls = async (): Promise<AdminTelegramControls> => {
  const [adminEnabledRaw, clientsEnabledRaw, runtimeOnlyRaw, reconciliationCycleRaw, reportIntervalRaw] = await Promise.all([
    getRuntimeFlag('telegram.admin.enabled', '1'),
    getRuntimeFlag('telegram.clients.enabled', '0'),
    getRuntimeFlag('telegram.admin.runtimeonly', '0'),
    getRuntimeFlag('runtime.cycle.reconciliation.enabled', '0'),
    getRuntimeFlag('telegram.admin.report_interval_minutes', '1440'),
  ]);

  return {
    adminEnabled: adminEnabledRaw !== '0',
    clientsEnabled: clientsEnabledRaw !== '0',
    runtimeOnly: runtimeOnlyRaw === '1',
    reconciliationCycleEnabled: reconciliationCycleRaw !== '0',
    tokenConfigured: Boolean(String(process.env.TELEGRAM_ADMIN_BOT_TOKEN || '').trim()),
    chatConfigured: Boolean(String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim()),
    reportIntervalMinutes: Math.max(5, Math.min(1440, Math.floor(asNumber(reportIntervalRaw, 1440)) || 1440)),
    sectionAccounts: true,
    sectionDrift: true,
    sectionLowlot: true,
  };
};

export const updateAdminTelegramControls = async (payload: {
  adminEnabled?: boolean;
  clientsEnabled?: boolean;
  runtimeOnly?: boolean;
  reconciliationCycleEnabled?: boolean;
  reportIntervalMinutes?: number;
  sectionAccounts?: boolean;
  sectionDrift?: boolean;
  sectionLowlot?: boolean;
}): Promise<AdminTelegramControls> => {
  if (payload.adminEnabled !== undefined) {
    await setRuntimeFlag('telegram.admin.enabled', payload.adminEnabled ? '1' : '0');
  }
  if (payload.clientsEnabled !== undefined) {
    await setRuntimeFlag('telegram.clients.enabled', payload.clientsEnabled ? '1' : '0');
  }
  if (payload.runtimeOnly !== undefined) {
    await setRuntimeFlag('telegram.admin.runtimeonly', payload.runtimeOnly ? '1' : '0');
  }
  if (payload.reconciliationCycleEnabled !== undefined) {
    await setRuntimeFlag('runtime.cycle.reconciliation.enabled', payload.reconciliationCycleEnabled ? '1' : '0');
  }
  if (payload.reportIntervalMinutes !== undefined) {
    const clamped = Math.max(5, Math.min(1440, Math.floor(asNumber(payload.reportIntervalMinutes, 1440)) || 1440));
    await setRuntimeFlag('telegram.admin.report_interval_minutes', String(clamped));
  }
  // sectionAccounts/Drift/Lowlot больше не влияют на новый health-summary и игнорируются.

  return getAdminTelegramControls();
};

export const getOfferStoreAdminState = async (options?: {
  bypassCache?: boolean;
}): Promise<OfferStoreState> => {
  const now = Date.now();
  if (
    !options?.bypassCache
    && _offerStoreAdminCache
    && (now - _offerStoreAdminCacheAt) < OFFER_STORE_ADMIN_CACHE_TTL_MS
  ) {
    return _offerStoreAdminCache;
  }

  const storefrontCatalog = await loadStorefrontCatalogWithFallback();
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const apiKeys = await getAvailableApiKeyNames();
  const catalog = storefrontCatalog || sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  const allOffers = catalog ? getAllOffers(catalog) : [];
  const offerIds = allOffers.map((item) => String(item.offerId));
  const [defaultsRaw, publishedRaw, curatedRaw, labelsRaw, algofundPublishedRawRow, reviewSnapshots, tsBacktestSnapshot, tsBacktestSnapshots, storefrontRows, publishedTenantRows, cloudTsRows] = await Promise.all([
    getRuntimeFlag('offer.store.defaults', JSON.stringify(DEFAULT_OFFER_STORE_DEFAULTS)),
    getRuntimeFlag('offer.store.published_ids', ''),
    getRuntimeFlag(OFFER_STORE_CURATED_IDS_KEY, '[]'),
    getRuntimeFlag(OFFER_STORE_LABELS_KEY, '{}'),
    db.get(
      `SELECT value FROM app_runtime_flags WHERE key = ? LIMIT 1`,
      [OFFER_STORE_ALGOFUND_PUBLISHED_SYSTEMS_KEY],
    ) as Promise<{ value?: string } | undefined>,
    getOfferReviewSnapshots(),
    getTsBacktestSnapshot(),
    getTsBacktestSnapshots(),
    db.all(
      `SELECT DISTINCT COALESCE(system_name, '') AS system_name
       FROM algofund_active_systems
       WHERE COALESCE(is_enabled, 1) = 1
         AND TRIM(COALESCE(system_name, '')) != ''
       ORDER BY system_name ASC`
    ) as Promise<Array<{ system_name?: string }>>,
    db.all(
      `SELECT DISTINCT COALESCE(published_system_name, '') AS system_name
       FROM algofund_profiles
       WHERE TRIM(COALESCE(published_system_name, '')) != ''
       ORDER BY system_name ASC`
    ) as Promise<Array<{ system_name?: string }>>,
    db.all(
      `SELECT name AS system_name FROM trading_systems
       WHERE (UPPER(name) LIKE 'CLOUD%' OR LOWER(name) LIKE '%::cloud-%') AND is_active = 1
       ORDER BY name ASC`
    ) as Promise<Array<{ system_name?: string }>>,
  ]);
  const defaults = normalizeOfferStoreDefaults(safeJsonParse(
    defaultsRaw,
    DEFAULT_OFFER_STORE_DEFAULTS,
  ));
  const publishedFromFlag = safeJsonParse<string[]>(publishedRaw, []);
  const publishedFromFlagNormalized = Array.from(new Set(
    publishedFromFlag
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));
  const curatedFromFlagNormalized = Array.from(new Set(
    safeJsonParse<string[]>(curatedRaw, [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));
  const labelsFromFlagRaw = safeJsonParse<Record<string, unknown>>(labelsRaw, {});
  const publishedSet = new Set(publishedFromFlagNormalized);
  const periodDays = getSweepPeriodDays(sweep, defaults.periodDays);
  const derivedPublishedAlgofundSystemNames = Array.from(new Set([
    ...(Array.isArray(storefrontRows) ? storefrontRows : [])
      .map((row) => asString(row?.system_name, '').trim()),
    ...(Array.isArray(publishedTenantRows) ? publishedTenantRows : [])
      .map((row) => asString(row?.system_name, '').trim()),
    ...(Array.isArray(cloudTsRows) ? cloudTsRows : [])
      .map((row) => asString(row?.system_name, '').trim()),
  ]
    .filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::') || name.toUpperCase().startsWith('CLOUD'))
  ));

  const parsedPublishedAlgofundFromFlag = safeJsonParse<string[]>(
    asString(algofundPublishedRawRow?.value, '[]'),
    [],
  );
  const hasExplicitPublishedAlgofundFlag = Boolean(asString(algofundPublishedRawRow?.value, '').trim());
  const algofundPublishedSystemNames = Array.from(new Set(
    (hasExplicitPublishedAlgofundFlag ? parsedPublishedAlgofundFromFlag : derivedPublishedAlgofundSystemNames)
      .map((name) => asString(name, '').trim())
      .filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::') || name.toUpperCase().startsWith('CLOUD'))
  ));

  const algofundStorefrontSystemNames = Array.from(new Set([
    ...(Array.isArray(storefrontRows) ? storefrontRows : [])
      .map((row) => asString(row?.system_name, '').trim()),
    ...(Array.isArray(publishedTenantRows) ? publishedTenantRows : [])
      .map((row) => asString(row?.system_name, '').trim()),
      ...(Array.isArray(cloudTsRows) ? cloudTsRows : [])
        .map((row) => asString(row?.system_name, '').trim()),
    ...Object.entries(tsBacktestSnapshots || {})
      .filter(([key, snap]) => {
        const name = asString(key, '').trim();
        if (!name.toUpperCase().startsWith('ALGOFUND_MASTER::') && !name.toUpperCase().startsWith('CLOUD')) {
          return false;
        }
        const eqLen = Array.isArray((snap as any)?.equityPoints) ? (snap as any).equityPoints.length : 0;
        return eqLen > 1;
      })
      .map(([key]) => asString(key, '').trim()),
  ]
    .filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::') || name.toUpperCase().startsWith('CLOUD'))
  ));
  const sweepByStrategyId = new Map<number, SweepRecord>();
  (sweep?.evaluated || []).forEach((item) => {
    const strategyId = Number(item.strategyId || 0);
    if (strategyId > 0 && !sweepByStrategyId.has(strategyId)) {
      sweepByStrategyId.set(strategyId, item);
    }
  });

  const rawOffers = allOffers
    .map((offer) => {
      const strategyId = Number(offer.strategy?.id || 0);
      const sweepRecord = sweepByStrategyId.get(strategyId) || null;
      const snapshot = reviewSnapshots[String(offer.offerId || '')] || null;
      const trades = Math.max(0, Math.floor(preferSnapshotMetric(snapshot?.trades, sweepRecord?.tradesCount ?? offer.metrics?.trades ?? 0, { allowZero: false })));
      const periodDaysRow = Math.max(1, Math.floor(asNumber(snapshot?.periodDays, periodDays)));
      return {
        offerId: String(offer.offerId || ''),
        titleRu: asString(offer.titleRu, offer.offerId),
        mode: (offer.strategy?.mode === 'synth' ? 'synth' : 'mono') as 'mono' | 'synth',
        market: asString(offer.strategy?.market, ''),
        market_type: 'futures' as 'futures' | 'spot',  // catalog offers are always futures (spot added via dca/periodic_buy)
        strategyType: asString(offer.strategy?.type, ''),
        interval: asString(offer.strategy?.params?.interval, ''),
        strategyParams: offer.strategy?.params || null,
        strategyId,
        score: Number(asNumber(sweepRecord?.score, offer.metrics?.score || 0).toFixed(3)),
        ret: Number(preferSnapshotMetric(snapshot?.ret, sweepRecord?.totalReturnPercent ?? offer.metrics?.ret ?? 0, { allowZero: false }).toFixed(3)),
        pf: Number(preferSnapshotMetric(snapshot?.pf, sweepRecord?.profitFactor ?? offer.metrics?.pf ?? 0, { allowZero: false }).toFixed(3)),
        dd: Number(preferSnapshotMetric(snapshot?.dd, sweepRecord?.maxDrawdownPercent ?? offer.metrics?.dd ?? 0, { allowZero: true }).toFixed(3)),
        trades,
        tradesPerDay: Number(asNumber(snapshot?.tradesPerDay, trades / Math.max(1, periodDaysRow)).toFixed(3)),
        periodDays: periodDaysRow,
        curated: curatedFromFlagNormalized.includes(String(offer.offerId || '')),
        publishedExplicitly: publishedSet.has(String(offer.offerId || '')),
        snapshotUpdatedAt: asString(snapshot?.updatedAt, ''),
        appearedAt: asString(sweep?.timestamp, ''),
      };
    })
    .sort((left, right) => right.score - left.score);

  const strategyIdToExistingOfferId = new Map<number, string>();
  for (const row of rawOffers) {
    if (Number(row.strategyId || 0) > 0 && !strategyIdToExistingOfferId.has(Number(row.strategyId))) {
      strategyIdToExistingOfferId.set(Number(row.strategyId), String(row.offerId || ''));
    }
  }

  const strategyIdToPublishedOfferId = new Map<number, string>();
  for (const offerId of publishedFromFlagNormalized) {
    const strategyId = parseStrategyIdFromOfferId(offerId);
    if (strategyId > 0 && !strategyIdToPublishedOfferId.has(strategyId)) {
      strategyIdToPublishedOfferId.set(strategyId, offerId);
    }
  }

  const strategyIdToCuratedOfferId = new Map<number, string>();
  for (const offerId of curatedFromFlagNormalized) {
    const strategyId = parseStrategyIdFromOfferId(offerId);
    if (strategyId > 0 && !strategyIdToCuratedOfferId.has(strategyId)) {
      strategyIdToCuratedOfferId.set(strategyId, offerId);
    }
  }

  const runtimeMasterStrategyRows = await db.all(
    `SELECT DISTINCT s.id, s.name, s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol, s.interval
     FROM trading_systems ts
     JOIN trading_system_members tsm ON tsm.system_id = ts.id AND COALESCE(tsm.is_enabled, 1) = 1
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE ts.name LIKE 'ALGOFUND_MASTER::%'`
  ) as Array<{
    id?: number;
    name?: string;
    strategy_type?: string;
    market_mode?: string;
    base_symbol?: string;
    quote_symbol?: string;
    interval?: string;
  }>;

  const curatedStrategyIds = Array.from(strategyIdToCuratedOfferId.keys()).filter((strategyId) => strategyId > 0);
  const curatedStrategyRows = curatedStrategyIds.length > 0
    ? await db.all(
      `SELECT DISTINCT s.id, s.name, s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol, s.interval
       FROM strategies s
       WHERE s.id IN (${curatedStrategyIds.map(() => '?').join(',')})`,
      curatedStrategyIds,
    ) as Array<{
      id?: number;
      name?: string;
      strategy_type?: string;
      market_mode?: string;
      base_symbol?: string;
      quote_symbol?: string;
      interval?: string;
    }>
    : [];

  const runtimeStrategyRowsById = new Map<number, {
    id?: number;
    name?: string;
    strategy_type?: string;
    market_mode?: string;
    base_symbol?: string;
    quote_symbol?: string;
    interval?: string;
  }>();
  for (const row of [...runtimeMasterStrategyRows, ...curatedStrategyRows]) {
    const strategyId = Number(row.id || 0);
    if (strategyId > 0 && !runtimeStrategyRowsById.has(strategyId)) {
      runtimeStrategyRowsById.set(strategyId, row);
    }
  }

  const missingStrategyIds = new Set<number>();
  for (const strategyId of strategyIdToPublishedOfferId.keys()) {
    if (!strategyIdToExistingOfferId.has(strategyId)) {
      missingStrategyIds.add(strategyId);
    }
  }
  for (const strategyId of strategyIdToCuratedOfferId.keys()) {
    if (!strategyIdToExistingOfferId.has(strategyId)) {
      missingStrategyIds.add(strategyId);
    }
  }
  for (const row of runtimeMasterStrategyRows) {
    const strategyId = Number(row.id || 0);
    if (strategyId > 0 && !strategyIdToExistingOfferId.has(strategyId)) {
      missingStrategyIds.add(strategyId);
    }
  }

  const strategyIdToTsOfferId = new Map<number, string>();
  for (const snap of Object.values(tsBacktestSnapshots || {})) {
    for (const offerIdRaw of Array.isArray(snap?.offerIds) ? snap.offerIds : []) {
      const offerId = asString(offerIdRaw, '').trim();
      const strategyId = parseStrategyIdFromOfferId(offerId);
      if (strategyId <= 0) {
        continue;
      }
      if (!strategyIdToTsOfferId.has(strategyId)) {
        strategyIdToTsOfferId.set(strategyId, offerId);
      }
      if (!strategyIdToExistingOfferId.has(strategyId)) {
        missingStrategyIds.add(strategyId);
      }
    }
  }

  const unresolvedStrategyIds = Array.from(missingStrategyIds).filter((strategyId) => !runtimeStrategyRowsById.has(strategyId));
  if (unresolvedStrategyIds.length > 0) {
    const extraRows = await db.all(
      `SELECT DISTINCT s.id, s.name, s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol, s.interval,
              COALESCE(s.market_type, 'futures') AS market_type
       FROM strategies s
       WHERE s.id IN (${unresolvedStrategyIds.map(() => '?').join(',')})`,
      unresolvedStrategyIds,
    ) as Array<{
      id?: number;
      name?: string;
      strategy_type?: string;
      market_mode?: string;
      base_symbol?: string;
      quote_symbol?: string;
      interval?: string;
      market_type?: string;
    }>;
    for (const row of extraRows) {
      const strategyId = Number(row.id || 0);
      if (strategyId > 0 && !runtimeStrategyRowsById.has(strategyId)) {
        runtimeStrategyRowsById.set(strategyId, row);
      }
    }
  }

  const fallbackOffers = Array.from(missingStrategyIds)
    .map((strategyId) => {
      const row = runtimeStrategyRowsById.get(strategyId);
      if (!row) {
        return null;
      }
      const mode: 'mono' | 'synth' = String(row.market_mode || '').toLowerCase().includes('synth') ? 'synth' : 'mono';
      const strategyType = asString(row.strategy_type, 'DD_BattleToads');
      const market = [asString(row.base_symbol, ''), asString(row.quote_symbol, '')].filter(Boolean).join('/');
      const fallbackOfferId = strategyIdToCuratedOfferId.get(strategyId)
        || strategyIdToPublishedOfferId.get(strategyId)
        || strategyIdToTsOfferId.get(strategyId)
        || `offer_${mode}_${strategyType.toLowerCase()}_${strategyId}`;
      const snapshot = reviewSnapshots[fallbackOfferId] || null;
      const sweepRecord = sweepByStrategyId.get(strategyId) || null;
      const trades = Math.max(0, Math.floor(preferSnapshotMetric(snapshot?.trades, sweepRecord?.tradesCount ?? 0, { allowZero: false })));
      const periodDaysRow = Math.max(1, Math.floor(asNumber(snapshot?.periodDays, periodDays)));
      const rowMarketType = String((row as { market_type?: string }).market_type || 'futures') === 'spot' ? 'spot' : 'futures';
      return {
        offerId: fallbackOfferId,
        titleRu: `${mode.toUpperCase()} • ${strategyType} • ${market || asString(row.base_symbol, '')}`,
        mode,
        market,
        market_type: rowMarketType as 'futures' | 'spot',
        strategyId,
        score: Number(asNumber(sweepRecord?.score, 0).toFixed(3)),
        ret: Number(preferSnapshotMetric(snapshot?.ret, sweepRecord?.totalReturnPercent ?? 0, { allowZero: false }).toFixed(3)),
        pf: Number(preferSnapshotMetric(snapshot?.pf, sweepRecord?.profitFactor ?? 0, { allowZero: false }).toFixed(3)),
        dd: Number(preferSnapshotMetric(snapshot?.dd, sweepRecord?.maxDrawdownPercent ?? 0, { allowZero: true }).toFixed(3)),
        trades,
        tradesPerDay: Number(asNumber(snapshot?.tradesPerDay, trades / Math.max(1, periodDaysRow)).toFixed(3)),
        periodDays: periodDaysRow,
        curated: curatedFromFlagNormalized.includes(fallbackOfferId),
        publishedExplicitly: publishedSet.has(fallbackOfferId),
        snapshotUpdatedAt: asString(snapshot?.updatedAt, ''),
        appearedAt: asString(sweep?.timestamp, ''),
      };
    })
    .filter((item): item is {
      offerId: string;
      titleRu: string;
      mode: 'mono' | 'synth';
      market: string;
      market_type: 'futures' | 'spot';
      strategyId: number;
      score: number;
      ret: number;
      pf: number;
      dd: number;
      trades: number;
      tradesPerDay: number;
      periodDays: number;
      curated: boolean;
      publishedExplicitly: boolean;
      snapshotUpdatedAt: string;
      appearedAt: string;
    } => Boolean(item));

  const combinedRawOffers = [...rawOffers, ...fallbackOffers]
    .filter((row, index, rows) => rows.findIndex((item) => item.offerId === row.offerId) === index)
    .sort((left, right) => right.score - left.score);

  const combinedStrategyIds = Array.from(new Set(
    combinedRawOffers
      .map((row) => Number(row.strategyId || 0))
      .filter((strategyId) => strategyId > 0)
  ));
  const strategyIntervalById = new Map<number, string>();
  const strategyMarketTypeById = new Map<number, 'futures' | 'spot'>();
  if (combinedStrategyIds.length > 0) {
    const strategyRows = await db.all(
      `SELECT id, interval, COALESCE(market_type, 'futures') AS market_type FROM strategies WHERE id IN (${combinedStrategyIds.map(() => '?').join(',')})`,
      combinedStrategyIds,
    ) as Array<{ id?: number; interval?: string; market_type?: string }>;
    for (const strategyRow of strategyRows) {
      const strategyId = Number(strategyRow.id || 0);
      if (strategyId > 0) {
        strategyIntervalById.set(strategyId, asString(strategyRow.interval, ''));
        strategyMarketTypeById.set(strategyId, String(strategyRow.market_type || 'futures') === 'spot' ? 'spot' : 'futures');
      }
    }
  }

  // Presets only where review snapshot has no equity AND offer is storefront-facing
  // (published/curated). Research-catalog cards keep sweep/snapshot metrics without
  // fan-out getPreset — that was ~N research.db reads and ~15s admin hangs.
  await initResearchDb();
  const equityByOfferId = new Map<string, number[]>();
  const presetMetricsByOfferId = new Map<string, Record<string, unknown>>();
  const curatedSet = new Set(curatedFromFlagNormalized);
  const presetQueue = combinedRawOffers.filter((row) => {
    const offerId = String(row.offerId || '').trim();
    if (!offerId) return false;
    const reviewEq = reviewSnapshots[offerId]?.equityPoints;
    if (Array.isArray(reviewEq) && reviewEq.length > 1) {
      return false;
    }
    return publishedSet.has(offerId) || curatedSet.has(offerId);
  });
  const presetFetchTotal = presetQueue.length;
  const presetSkipped = Math.max(0, combinedRawOffers.length - presetFetchTotal);
  const PRESET_CONCURRENCY = 8;
  const runPresetWorker = async () => {
    while (presetQueue.length > 0) {
      const row = presetQueue.shift();
      if (!row) break;
      try {
        const preset = await getPreset(row.offerId, 'medium', 'medium');
        if (preset && Array.isArray(preset.equity_curve) && preset.equity_curve.length > 0) {
          const full = preset.equity_curve as number[];
          const step = full.length > 80 ? Math.ceil(full.length / 80) : 1;
          const sampled = full.filter((_, idx) => idx % step === 0);
          equityByOfferId.set(row.offerId, sampled);
        }
        if (preset?.metrics && typeof preset.metrics === 'object') {
          presetMetricsByOfferId.set(row.offerId, preset.metrics as Record<string, unknown>);
        }
      } catch {
        // No preset available — equity will be empty
      }
    }
  };
  if (presetFetchTotal > 0) {
    await Promise.all(Array.from({ length: Math.min(PRESET_CONCURRENCY, presetFetchTotal) }, runPresetWorker));
  }
  if (presetSkipped > 0 || presetFetchTotal > 0) {
    logger.info(
      `offer-store presets: fetch=${presetFetchTotal} skip=${presetSkipped} `
      + `(published/curated without review equity only)`,
    );
  }

  const existingOfferIds = new Set(combinedRawOffers.map((row) => String(row.offerId || '')));
  const labelsFromFlag = deriveOfferStoreLabels({
    labels: labelsFromFlagRaw,
    curatedOfferIds: curatedFromFlagNormalized,
    publishedOfferIds: publishedFromFlagNormalized,
    existingOfferIds,
  });
  const explicitRuntimeSnapshotOfferIds = new Set(
    Object.entries(labelsFromFlagRaw)
      .filter(([, label]) => normalizeOfferStoreLabel(label) === 'runtime_snapshot')
      .map(([offerId]) => String(offerId || '').trim())
      .filter(Boolean)
  );
  const storefrontEligibleOfferIds = new Set(
    combinedRawOffers
      .filter((row) => isEligibleStorefrontOffer(row))
      .map((row) => String(row.offerId || '').trim())
      .filter(Boolean)
  );
  const labels: Record<string, OfferStoreLabel> = {};
  for (const [offerId, label] of Object.entries(labelsFromFlag)) {
    labels[offerId] = label === 'runtime_snapshot'
      && !explicitRuntimeSnapshotOfferIds.has(offerId)
      && !storefrontEligibleOfferIds.has(offerId)
      ? 'research_catalog'
      : label;
  }
  const runtimeSnapshotOfferIds = Object.entries(labels)
    .filter(([, label]) => label === 'runtime_snapshot')
    .map(([offerId]) => offerId);
  const publishedOfferIds = Array.from(new Set([...runtimeSnapshotOfferIds, ...publishedFromFlagNormalized]));
  const curatedOfferIds = Array.from(new Set([...runtimeSnapshotOfferIds, ...curatedFromFlagNormalized]));

  // Count connected clients per offer
  const clientCountByOffer = new Map<string, number>();
  try {
    const profileRows = await db.all(
      `SELECT selected_offer_ids_json FROM strategy_client_profiles WHERE actual_enabled = 1`
    ) as Array<{ selected_offer_ids_json: string }>;
    for (const row of profileRows) {
      const ids = safeJsonParse<string[]>(row.selected_offer_ids_json, []);
      for (const oid of (Array.isArray(ids) ? ids : [])) {
        const key = String(oid || '').trim();
        if (key) {
          clientCountByOffer.set(key, (clientCountByOffer.get(key) || 0) + 1);
        }
      }
    }
  } catch { /* table may not exist yet */ }

  const result: OfferStoreState = {
    defaults,
    publishedOfferIds,
    curatedOfferIds,
    labels,
    algofundStorefrontSystemNames,
    algofundPublishedSystemNames,
    tsBacktestSnapshots,
    tsBacktestSnapshot,
    offers: combinedRawOffers.map((row) => {
      const resolvedInterval = asString(
        (row as Record<string, unknown>).interval,
        strategyIntervalById.get(Number(row.strategyId || 0)) || '',
      );
      const reviewEq = reviewSnapshots[row.offerId]?.equityPoints;
      const rawEq = (Array.isArray(reviewEq) && reviewEq.length > 0 ? reviewEq : null) || equityByOfferId.get(row.offerId) || [];
      const presetMetrics = presetMetricsByOfferId.get(row.offerId);
      const sweepRecord = sweepByStrategyId.get(Number(row.strategyId || 0)) || null;
      let ret = Number(asNumber(row.ret, 0).toFixed(3));
      let pf = Number(asNumber(row.pf, 0).toFixed(3));
      let dd = Number(asNumber(row.dd, 0).toFixed(3));
      let trades = Math.max(0, Math.floor(asNumber(row.trades, 0)));
      if (sweepRecord) {
        if (ret <= 0) ret = Number(asNumber(sweepRecord.totalReturnPercent, 0).toFixed(3));
        if (pf <= 0) pf = Number(asNumber(sweepRecord.profitFactor, 0).toFixed(3));
        if (dd <= 0) dd = Number(asNumber(sweepRecord.maxDrawdownPercent, 0).toFixed(3));
        if (trades <= 0) trades = Math.max(0, Math.floor(asNumber(sweepRecord.tradesCount, 0)));
      }
      if (presetMetrics && typeof presetMetrics === 'object') {
        if (ret <= 0) ret = Number(asNumber(presetMetrics.ret ?? presetMetrics.totalReturnPercent, 0).toFixed(3));
        if (pf <= 0) pf = Number(asNumber(presetMetrics.pf ?? presetMetrics.profitFactor, 0).toFixed(3));
        if (dd <= 0) dd = Number(asNumber(presetMetrics.dd ?? presetMetrics.maxDrawdownPercent, 0).toFixed(3));
        if (trades <= 0) trades = Math.max(0, Math.floor(asNumber(presetMetrics.trades ?? presetMetrics.tradesCount, 0)));
      }
      const periodDaysRow = Math.max(1, Math.floor(asNumber(row.periodDays, defaults.periodDays)));
      const tradesPerDay = Number(asNumber(row.tradesPerDay, trades / Math.max(1, periodDaysRow)).toFixed(3));
      let normalizedEq = normalizeEquityCurveOrientation(rawEq, ret, 10000 * (1 + asNumber(ret, 0) / 100), 10000);
      if (normalizedEq.length < 2 && Math.abs(ret) > 0.0001) {
        normalizedEq = toPresetOnlyEquity(10000, ret, periodDaysRow).map((point) => Number(asNumber(point.equity, 0).toFixed(4)));
      }

      return {
        ...row,
        interval: resolvedInterval || null,
        familyInterval: resolvedInterval || null,
        market_type: strategyMarketTypeById.get(Number(row.strategyId || 0)) || 'futures',
        ret,
        pf,
        dd,
        trades,
        tradesPerDay,
        periodDays: periodDaysRow,
        label: labels[row.offerId] || 'research_catalog',
        connectedClients: clientCountByOffer.get(row.offerId) || 0,
        equityPoints: normalizedEq,
        backtestSettings: {
          riskScore: Number(asNumber(reviewSnapshots[row.offerId]?.riskScore, 5).toFixed(2)),
          tradeFrequencyScore: Number(asNumber(reviewSnapshots[row.offerId]?.tradeFrequencyScore, 5).toFixed(2)),
          initialBalance: Math.max(100, Math.floor(asNumber(reviewSnapshots[row.offerId]?.initialBalance, 10000))),
          riskScaleMaxPercent: Number(asNumber(reviewSnapshots[row.offerId]?.riskScaleMaxPercent, 100).toFixed(2)),
        },
      };
    }),
  };

  _offerStoreAdminCache = result;
  _offerStoreAdminCacheAt = Date.now();
  return result;
};

export const updateOfferStoreAdminState = async (payload: {
  defaults?: Partial<OfferStoreDefaults>;
  publishedOfferIds?: string[];
  curatedOfferIds?: string[];
  labels?: Record<string, OfferStoreLabel>;
  algofundPublishedSystemNames?: string[];
  reviewSnapshotPatch?: Record<string, Partial<OfferReviewSnapshot> | null>;
  tsBacktestSnapshotPatch?: Partial<TsBacktestSnapshot> | null;
  tsBacktestSnapshotsPatch?: Record<string, Partial<TsBacktestSnapshot> | null>;
}) => {
  const current = await getOfferStoreAdminState({ bypassCache: true });
  const nextDefaults = normalizeOfferStoreDefaults({
    ...current.defaults,
    ...(payload.defaults || {}),
  });

  const offerIds = new Set(current.offers.map((item) => item.offerId));
  const nextPublished = Array.isArray(payload.publishedOfferIds)
    ? Array.from(new Set(payload.publishedOfferIds.map((item) => String(item || '').trim()).filter((item) => offerIds.has(item))))
    : current.publishedOfferIds;
  const nextCurated = Array.isArray(payload.curatedOfferIds)
    ? Array.from(new Set(payload.curatedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : (current.curatedOfferIds || []);
  const nextLabels = deriveOfferStoreLabels({
    labels: payload.labels || current.labels || {},
    curatedOfferIds: nextCurated,
    publishedOfferIds: nextPublished,
    existingOfferIds: offerIds,
  });
  const nextAlgofundPublishedSystemNames = Array.isArray(payload.algofundPublishedSystemNames)
    ? Array.from(new Set(
      payload.algofundPublishedSystemNames
        .map((name) => asString(name, '').trim())
        .filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::') || name.toUpperCase().startsWith('CLOUD'))
    ))
    : (current.algofundPublishedSystemNames || []);

  const nextReviewSnapshots = await getOfferReviewSnapshots();
  const snapshotPatch = payload.reviewSnapshotPatch || {};
  for (const [offerIdRaw, patch] of Object.entries(snapshotPatch)) {
    const offerId = String(offerIdRaw || '').trim();
    if (!offerId || !offerIds.has(offerId)) {
      continue;
    }

    if (patch === null) {
      delete nextReviewSnapshots[offerId];
      continue;
    }

    const merged: Record<string, unknown> = {
      ...(nextReviewSnapshots[offerId] || {}),
      ...(patch || {}),
      offerId,
      updatedAt: new Date().toISOString(),
    };
    const normalized = normalizeOfferReviewSnapshot(offerId, merged);
    if (normalized) {
      nextReviewSnapshots[offerId] = normalized;
    }
  }

  const currentTsBacktestSnapshot = await getTsBacktestSnapshot();
  const currentTsBacktestSnapshots = await getTsBacktestSnapshots();
  let nextTsBacktestSnapshot: TsBacktestSnapshot | null = currentTsBacktestSnapshot;
  if (payload.tsBacktestSnapshotPatch === null) {
    nextTsBacktestSnapshot = null;
  } else if (payload.tsBacktestSnapshotPatch && typeof payload.tsBacktestSnapshotPatch === 'object') {
    const mergedTsSnapshot: Record<string, unknown> = {
      ...(currentTsBacktestSnapshot || {}),
      ...(payload.tsBacktestSnapshotPatch || {}),
      updatedAt: new Date().toISOString(),
    };
    nextTsBacktestSnapshot = normalizeTsBacktestSnapshot(mergedTsSnapshot);
  }

  const nextTsBacktestSnapshots: Record<string, TsBacktestSnapshot> = {
    ...currentTsBacktestSnapshots,
  };
  for (const [rawKey, patch] of Object.entries(payload.tsBacktestSnapshotsPatch || {})) {
    const key = normalizeTsSnapshotMapKey(rawKey);
    if (!key) {
      continue;
    }
    if (patch === null) {
      delete nextTsBacktestSnapshots[key];
      continue;
    }
    const mergedSnapshot: Record<string, unknown> = {
      ...(nextTsBacktestSnapshots[key] || {}),
      ...(patch || {}),
      updatedAt: new Date().toISOString(),
    };
    const normalizedSnapshot = normalizeTsBacktestSnapshot(mergedSnapshot);
    if (normalizedSnapshot) {
      nextTsBacktestSnapshots[key] = normalizedSnapshot;
      const aliasKeys = new Set<string>();
      const systemName = asString(normalizedSnapshot.systemName, '').trim();
      const setKey = asString(normalizedSnapshot.setKey, '').trim();
      if (systemName && systemName !== key) {
        aliasKeys.add(systemName);
      }
      if (setKey && setKey !== key) {
        aliasKeys.add(setKey);
      }
      for (const aliasKey of aliasKeys) {
        // Avoid duplicate storefront cards: skip short alias when canonical master name already stored.
        if (aliasKey !== key && nextTsBacktestSnapshots[key] && aliasKey.length < key.length) {
          continue;
        }
        nextTsBacktestSnapshots[aliasKey] = normalizedSnapshot;
      }
      await syncMasterStrategyFlagsFromSnapshot(normalizedSnapshot).catch((error) => {
        logger.warn(`syncMasterStrategyFlagsFromSnapshot failed for ${key}: ${(error as Error).message}`);
      });
      await syncCardMechanicsFromSnapshot(normalizedSnapshot).catch((error) => {
        logger.warn(`syncCardMechanicsFromSnapshot failed for ${key}: ${(error as Error).message}`);
      });
    }
  }

  await setRuntimeFlags({
    'offer.store.defaults': JSON.stringify(nextDefaults),
    'offer.store.published_ids': JSON.stringify(nextPublished),
    [OFFER_STORE_CURATED_IDS_KEY]: JSON.stringify(nextCurated),
    [OFFER_STORE_LABELS_KEY]: JSON.stringify(nextLabels),
    [OFFER_STORE_ALGOFUND_PUBLISHED_SYSTEMS_KEY]: JSON.stringify(nextAlgofundPublishedSystemNames),
    'offer.store.review_snapshots': JSON.stringify(nextReviewSnapshots),
    'offer.store.ts_backtest_snapshot': JSON.stringify(nextTsBacktestSnapshot),
    'offer.store.ts_backtest_snapshots': JSON.stringify(nextTsBacktestSnapshots),
  });

  clearOfferStoreAdminCache();
  return getOfferStoreAdminState({ bypassCache: true });
};


const resolveAlgofundTsBacktestSnapshotForPreview = async (params: {
  setKey?: string;
  systemName?: string;
  offerIds?: string[];
}): Promise<TsBacktestSnapshot | null> => {
  const snapshotMap = await getTsBacktestSnapshots();
  const requestedSetKey = normalizeTsSnapshotMapKey(asString(params.setKey, ''));
  const normalizeOfferIds = (raw: unknown): string[] => Array.from(new Set(
    (Array.isArray(raw) ? raw : [])
      .map((item) => asString(item, '').trim())
      .filter(Boolean)
  ));
  const requestedOfferIds = normalizeOfferIds(params.offerIds || []);

  let snapshot = requestedSetKey ? (snapshotMap[requestedSetKey] || null) : null;
  if (!snapshot && !requestedSetKey && requestedOfferIds.length > 0) {
    const requestedSorted = Array.from(new Set(requestedOfferIds)).sort();
    snapshot = Object.values(snapshotMap).find((item) => {
      const snapshotOfferIds = normalizeOfferIds(item.offerIds).sort();
      if (snapshotOfferIds.length === 0 || snapshotOfferIds.length !== requestedSorted.length) {
        return false;
      }
      return requestedSorted.every((offerId, index) => snapshotOfferIds[index] === offerId);
    }) || null;
  }

  const requestedSystemName = asString(params.systemName, '').trim();
  if (!snapshot && requestedSystemName) {
    snapshot = Object.values(snapshotMap).find((item) => String(item?.systemName || '').trim() === requestedSystemName) || null;
    if (!snapshot) {
      snapshot = snapshotMap[requestedSystemName] || null;
    }
  }

  if (!snapshot) {
    const legacySnapshot = await getTsBacktestSnapshot();
    if (legacySnapshot) {
      const legacySetKey = normalizeTsSnapshotMapKey(asString(legacySnapshot.setKey, ''));
      const legacyOfferIds = normalizeOfferIds(legacySnapshot.offerIds).sort();
      const requestedSorted = Array.from(new Set(requestedOfferIds)).sort();
      if (
        (requestedSetKey && legacySetKey === requestedSetKey)
        || (requestedSystemName && String(legacySnapshot.systemName || '').trim() === requestedSystemName)
        || (
          !requestedSetKey
          && requestedSorted.length > 0
          && legacyOfferIds.length === requestedSorted.length
          && requestedSorted.every((offerId, index) => legacyOfferIds[index] === offerId)
        )
      ) {
        snapshot = legacySnapshot;
      }
    }
  }

  if (!snapshot) {
    return null;
  }
  return normalizeOfferIds(snapshot.offerIds).length > 0 ? snapshot : null;
};

const todayYmdUtc = (): string => new Date().toISOString().slice(0, 10);

const msToYmd = (value: number | null | undefined): string | null => {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return new Date(Number(value)).toISOString().slice(0, 10);
};

/** Clamp admin-requested dates to available history (never future / beyond sweep artifacts). */
const clampRequestedBacktestDates = (
  requestedFrom: string,
  requestedTo: string,
  sweep: { config?: Record<string, unknown> } | null | undefined,
): {
  dateFrom: string;
  dateTo: string;
  requestedDateFrom: string;
  requestedDateTo: string;
  clampNotes: string[];
} => {
  const notes: string[] = [];
  const today = todayYmdUtc();
  const sweepEnd = asString(sweep?.config?.dateTo, '').trim().slice(0, 10);
  let from = asString(requestedFrom, '').trim().slice(0, 10);
  let to = asString(requestedTo, '').trim().slice(0, 10);

  if (from && !to) {
    to = today;
    notes.push('dateTo не задан — взяли сегодня');
  }
  if (to && !from) {
    const sweepFromRaw = asString(sweep?.config?.dateFrom, '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(sweepFromRaw) && sweepFromRaw <= to) {
      from = sweepFromRaw;
      notes.push('dateFrom не задан — взяли начало sweep');
    } else {
      from = new Date(Date.parse(`${to}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
      notes.push('dateFrom не задан — 365d до dateTo');
    }
  }
  if (!from || !to) {
    return {
      dateFrom: from,
      dateTo: to,
      requestedDateFrom: from,
      requestedDateTo: to,
      clampNotes: notes,
    };
  }

  const caps = [today, sweepEnd].filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  const maxAllowedTo = caps.reduce((min, item) => (item < min ? item : min), caps[0] || today);
  if (to > maxAllowedTo) {
    notes.push(`dateTo ${to} → ${maxAllowedTo} (сегодня / конец sweep)`);
    to = maxAllowedTo;
  }
  if (from > to) {
    notes.push(`dateFrom ${from} позже dateTo — сдвинули dateFrom = dateTo`);
    from = to;
  }

  return {
    dateFrom: from,
    dateTo: to,
    requestedDateFrom: asString(requestedFrom, '').trim().slice(0, 10),
    requestedDateTo: asString(requestedTo, '').trim().slice(0, 10),
    clampNotes: notes,
  };
};

const buildPreviewDatesFromPeriodDays = (periodDaysRaw: unknown, requestedFrom: string, requestedTo: string): { dateFrom: string; dateTo: string } => {
  const periodDays = Math.max(1, Math.floor(asNumber(periodDaysRaw, 90)));
  const now = new Date();
  const dateTo = requestedTo || now.toISOString().slice(0, 10);
  const dateFrom = requestedFrom || new Date(now.getTime() - periodDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
};

const normalizePairMarketKey = (raw: unknown): string => String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

const resolveSnapshotPreviewDates = (
  snapshot: { periodDays?: number; backtestSettings?: Record<string, unknown>; updatedAt?: string } | null,
  sweep: { config?: Record<string, unknown> } | null | undefined,
  requestedFrom: string,
  requestedTo: string,
): { dateFrom: string; dateTo: string } => {
  if (requestedFrom && requestedTo) {
    return { dateFrom: requestedFrom, dateTo: requestedTo };
  }
  const settings = snapshot?.backtestSettings && typeof snapshot.backtestSettings === 'object'
    ? snapshot.backtestSettings
    : {};
  const settingsFrom = asString(settings.dateFrom, '').trim();
  const settingsTo = asString(settings.dateTo, '').trim();
  if (settingsFrom && settingsTo) {
    return { dateFrom: requestedFrom || settingsFrom, dateTo: requestedTo || settingsTo };
  }
  const sweepFrom = asString(sweep?.config?.dateFrom, '').trim();
  const sweepTo = asString(sweep?.config?.dateTo, '').trim();
  if (sweepFrom && sweepTo) {
    return { dateFrom: requestedFrom || sweepFrom, dateTo: requestedTo || sweepTo };
  }
  const periodDays = Math.max(1, Math.floor(asNumber(snapshot?.periodDays, 90)));
  const anchorMs = snapshot?.updatedAt ? Date.parse(snapshot.updatedAt) : Number.NaN;
  const anchorDate = Number.isFinite(anchorMs) ? new Date(anchorMs) : new Date();
  const dateTo = requestedTo || anchorDate.toISOString().slice(0, 10);
  const dateFrom = requestedFrom || new Date(anchorDate.getTime() - periodDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
};

/** Real rerun: full historical sweep window unless admin explicitly set dateFrom/dateTo. */
const resolveSnapshotRerunDates = (
  snapshot: { periodDays?: number; backtestSettings?: Record<string, unknown>; updatedAt?: string } | null,
  sweep: { config?: Record<string, unknown> } | null | undefined,
  requestedFrom: string,
  requestedTo: string,
): { dateFrom: string; dateTo: string; usedFullSweepDepth: boolean } => {
  if (requestedFrom || requestedTo) {
    const clamped = clampRequestedBacktestDates(requestedFrom, requestedTo, sweep);
    return { dateFrom: clamped.dateFrom, dateTo: clamped.dateTo, usedFullSweepDepth: false };
  }
  const settings = snapshot?.backtestSettings && typeof snapshot.backtestSettings === 'object'
    ? snapshot.backtestSettings
    : {};
  const settingsFrom = asString(settings.dateFrom, '').trim().slice(0, 10);
  const settingsTo = asString(settings.dateTo, '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(settingsFrom) && /^\d{4}-\d{2}-\d{2}$/.test(settingsTo)) {
    return { dateFrom: settingsFrom, dateTo: settingsTo, usedFullSweepDepth: false };
  }
  const sweepFromRaw = asString(sweep?.config?.dateFrom, '').trim();
  const sweepToRaw = asString(sweep?.config?.dateTo, '').trim();
  const sweepFrom = sweepFromRaw.length >= 10 ? sweepFromRaw.slice(0, 10) : sweepFromRaw;
  const sweepTo = sweepToRaw.length >= 10 ? sweepToRaw.slice(0, 10) : sweepToRaw;
  const nowYmd = new Date().toISOString().slice(0, 10);
  if (sweepFrom) {
    return {
      dateFrom: sweepFrom,
      dateTo: sweepTo || nowYmd,
      usedFullSweepDepth: true,
    };
  }
  return { dateFrom: nowYmd, dateTo: nowYmd, usedFullSweepDepth: false };
};

const buildPeriodInfoFromDates = (
  dateFrom: string,
  dateTo: string,
  interval: string,
): PeriodInfo => ({
  dateFrom,
  dateTo,
  interval,
});

const addTsMarketLegs = (occupied: Set<string>, rawMarket: string): void => {
  const text = String(rawMarket || '').trim();
  if (!text) {
    return;
  }
  const normalizedWhole = normalizePairMarketKey(text);
  if (normalizedWhole) {
    occupied.add(normalizedWhole);
  }
  for (const part of text.split(/[/|]/)) {
    const leg = normalizePairMarketKey(part);
    if (leg) {
      occupied.add(leg);
    }
  }
};

const collectTsOccupiedMarkets = (
  offerIds: string[],
  catalog: CatalogData | null,
  offerStoreById: Map<string, Record<string, unknown>>,
): Set<string> => {
  const occupied = new Set<string>();
  offerIds.forEach((offerId) => {
    const storeRow = offerStoreById.get(offerId);
    addTsMarketLegs(occupied, asString(storeRow?.market, ''));
    const catalogOffer = findOfferByIdOrNull(catalog, offerId);
    if (!catalogOffer) {
      return;
    }
    addTsMarketLegs(occupied, asString(catalogOffer.strategy?.market, ''));
    const params = catalogOffer.strategy?.params as Record<string, unknown> | undefined;
    const base = normalizePairMarketKey(asString(params?.base_symbol, ''));
    const quote = normalizePairMarketKey(asString(params?.quote_symbol, 'USDT'));
    if (base) {
      occupied.add(base + quote);
      if (quote) {
        addTsMarketLegs(occupied, `${base}/${quote}`);
      }
      occupied.add(base);
      if (quote) {
        occupied.add(quote);
      }
    }
  });
  return occupied;
};

/** Same freq-aware strategy IDs as admin sweep rerun (preset matrix + sweep family rows). */
const buildTsStrategyIdsForOfferIds = (
  offerIds: string[],
  catalog: CatalogData | null,
  sweep: SweepData | null,
  options: { riskScore?: number; tradeFrequencyScore?: number },
): number[] => {
  const riskScore = normalizePreferenceScore(options.riskScore, 'medium');
  const tradeFrequencyScore = normalizePreferenceScore(options.tradeFrequencyScore, 'medium');
  const riskLevel = preferenceScoreToLevel(riskScore);
  const tradeFrequencyLevel = preferenceScoreToLevel(tradeFrequencyScore);
  const sweepEvaluatedRows: SweepRecord[] = Array.isArray(sweep?.evaluated)
    ? sweep.evaluated.filter((item): item is SweepRecord => Boolean(item && Number(item.strategyId || 0) > 0))
    : [];

  const strategyIds = offerIds.map((offerId) => {
    const offer = findOfferByIdOrNull(catalog, offerId);
    if (!offer) {
      return Number(parseStrategyIdFromOfferId(offerId) || 0);
    }
    const matrixPreset = offer.presetMatrix?.[riskLevel]?.[tradeFrequencyLevel] || null;
    const preset = matrixPreset || resolveOfferPresetByPreference(
      offer,
      riskLevel,
      tradeFrequencyLevel,
      riskScore,
      tradeFrequencyScore,
    );

    let familyVariant: SweepRecord | null = null;
    if (sweepEvaluatedRows.length > 0) {
      const modeToken = offer.strategy?.mode === 'synth' ? 'synthetic' : 'mono';
      const intervalToken = asString(preset.params?.interval || offer.strategy?.params?.interval, '');
      const familyRows = sweepEvaluatedRows.filter((row) => {
        const rowMode = asString(row.marketMode, '');
        const modeMatched = modeToken === 'synthetic'
          ? (rowMode === 'synthetic' || rowMode === 'synth')
          : rowMode === 'mono';
        if (!modeMatched) {
          return false;
        }
        return asString(row.strategyType, '') === asString(offer.strategy?.type, '')
          && asString(row.market, '') === asString(offer.strategy?.market, '')
          && (!intervalToken || asString(row.interval, '') === intervalToken);
      });
      if (familyRows.length > 0) {
        const anchor = familyRows.find((row) => Number(row.strategyId || 0) === Number(preset.strategyId || 0))
          || familyRows[Math.floor(familyRows.length / 2)];
        const familyPresetRows = pickFamilyTradePresetRows(anchor, familyRows);
        familyVariant = familyPresetRows[tradeFrequencyLevel] || null;
      }
    }

    return Number(familyVariant?.strategyId || preset.strategyId || offer.strategy?.id || 0);
  }).filter((value) => Number.isFinite(value) && value > 0);

  return Array.from(new Set(strategyIds));
};

type DcaStrategySettings = {
  baseAmountUsdt?: number;
  baseAmountMode?: 'fixed' | 'percent';
  baseAmountPercent?: number;
  stepPercent?: number;
  maxOrders?: number;
  orderMultiplier?: number;
  tpPercent?: number;
  slPercent?: number;
  interval?: string;
  detectionSource?: string;
  entryFilter?: 'always' | 'rsi_dip' | 'cooldown';
  reentryBars?: number;
  rsiPeriod?: number;
  rsiMax?: number;
  perLegSl?: boolean;
};

type NormalizedDcaSettings = Required<Omit<DcaStrategySettings, 'baseAmountMode' | 'baseAmountPercent' | 'interval' | 'detectionSource' | 'entryFilter'>> & {
  baseAmountMode: 'fixed' | 'percent';
  baseAmountPercent: number;
  interval: string;
  detectionSource: string;
  entryFilter: 'always' | 'rsi_dip' | 'cooldown';
};

const DEFAULT_DCA_SETTINGS: Omit<NormalizedDcaSettings, 'baseAmountMode' | 'baseAmountPercent'> = {
  baseAmountUsdt: 10,
  stepPercent: 2,
  maxOrders: 5,
  orderMultiplier: 1,
  tpPercent: 3,
  slPercent: 0,
  interval: '4h',
  detectionSource: 'close',
  entryFilter: 'always',
  reentryBars: 0,
  rsiPeriod: 14,
  rsiMax: 45,
  perLegSl: false,
};

const DCA_AUTOTUNE_VERSION = 8;

const buildDcaAutotuneVariants = (): Array<Partial<DcaStrategySettings>> => {
  const variants: Array<Partial<DcaStrategySettings>> = [];
  const seen = new Set<string>();
  const push = (variant: Partial<DcaStrategySettings>) => {
    const key = JSON.stringify(variant);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    variants.push(variant);
  };

  const steps4h = [1, 1.5, 2, 2.5];
  const tps4h = [1.5, 2, 2.5, 3];
  for (const stepPercent of steps4h) {
    for (const tpPercent of tps4h) {
      if (tpPercent + 0.01 < stepPercent * 0.7) {
        continue;
      }
      push({
        interval: '4h',
        stepPercent,
        tpPercent,
        slPercent: 0,
        entryFilter: 'always',
        perLegSl: false,
        reentryBars: 0,
      });
    }
  }

  const steps1h = [0.8, 1, 1.5];
  const tps1h = [1.2, 1.5, 2];
  for (const stepPercent of steps1h) {
    for (const tpPercent of tps1h) {
      push({
        interval: '1h',
        stepPercent,
        tpPercent,
        slPercent: 0,
        entryFilter: 'always',
        perLegSl: false,
      });
    }
  }

  push({ interval: '4h', stepPercent: 1.5, tpPercent: 2, slPercent: 0, entryFilter: 'cooldown', reentryBars: 1, perLegSl: false });
  push({ interval: '4h', stepPercent: 2, tpPercent: 2.5, slPercent: 12, entryFilter: 'always', perLegSl: true });
  push({ interval: '4h', stepPercent: 1, tpPercent: 1.5, slPercent: 10, entryFilter: 'rsi_dip', rsiMax: 55, perLegSl: true });
  push({ interval: '4h', stepPercent: 1.5, tpPercent: 2, slPercent: 8, entryFilter: 'cooldown', reentryBars: 0, perLegSl: false });

  return variants.slice(0, 22);
};

const DCA_AUTOTUNE_VARIANTS: Array<Partial<DcaStrategySettings>> = buildDcaAutotuneVariants();

/** Autotune grid centered on user baseline — not a fixed step/tp table that ignores UI. */
const buildAutotuneVariantsForBaseline = (
  baseline: NormalizedDcaSettings,
): Array<Partial<DcaStrategySettings>> => {
  const seen = new Set<string>();
  const out: Array<Partial<DcaStrategySettings>> = [];
  const push = (variant: Partial<DcaStrategySettings>) => {
    const key = JSON.stringify(variant);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(variant);
  };

  const intervals = Array.from(new Set([
    baseline.interval,
    baseline.interval === '1h' ? '4h' : '1h',
  ]));
  const stepsAround = Array.from(new Set([
    Math.max(0.1, Number((baseline.stepPercent * 0.75).toFixed(2))),
    baseline.stepPercent,
    Math.max(0.1, Number((baseline.stepPercent * 1.15).toFixed(2))),
  ]));
  const tpsAround = Array.from(new Set([
    Math.max(0.1, Number((baseline.tpPercent * 0.85).toFixed(2))),
    baseline.tpPercent,
    Math.max(0.1, Number((baseline.tpPercent * 1.15).toFixed(2))),
  ]));

  for (const interval of intervals) {
    for (const stepPercent of stepsAround) {
      for (const tpPercent of tpsAround) {
        if (tpPercent + 0.01 < stepPercent * 0.5) {
          continue;
        }
        push({
          interval,
          stepPercent,
          tpPercent,
          slPercent: baseline.slPercent,
          entryFilter: baseline.entryFilter,
          reentryBars: baseline.reentryBars,
          perLegSl: baseline.perLegSl,
        });
      }
    }
  }

  for (const variant of DCA_AUTOTUNE_VARIANTS) {
    push(variant);
  }

  return out.slice(0, 24);
};

const computeDcaCandidateScore = (
  ret: number,
  dd: number,
  pf: number,
  trades: number,
  mode: 'scan' | 'autotune' = 'scan',
): number => {
  const tradeCap = mode === 'autotune' ? 45 : 22;
  const tradeDivisor = mode === 'autotune' ? 4 : 8;
  const tradeBonus = Math.min(Math.max(0, trades) / tradeDivisor, tradeCap);
  const ddWeight = mode === 'autotune' ? 0.22 : 0.28;
  const retAdj = ret < 0 ? ret * 1.15 : ret;
  return retAdj - dd * ddWeight + Math.min(2.5, Math.max(0, pf)) * 3.5 + tradeBonus;
};

const resolveEffectiveDcaBaseAmount = (
  settings: DcaStrategySettings | undefined,
  initialBalance: number,
): number => {
  const mode = settings?.baseAmountMode === 'percent' ? 'percent' : 'fixed';
  if (mode === 'percent') {
    const pct = Math.max(0.1, asNumber(settings?.baseAmountPercent, 1));
    return Math.max(1, (initialBalance * pct) / 100);
  }
  return Math.max(1, asNumber(settings?.baseAmountUsdt, DEFAULT_DCA_SETTINGS.baseAmountUsdt));
};

const normalizeDcaEntryFilter = (value: unknown): 'always' | 'rsi_dip' | 'cooldown' => {
  const raw = String(value || 'always').trim().toLowerCase();
  if (raw === 'rsi_dip' || raw === 'cooldown') return raw;
  return 'always';
};

const normalizeDcaSettings = (
  settings: DcaStrategySettings | undefined,
  initialBalance: number,
): NormalizedDcaSettings => ({
  ...DEFAULT_DCA_SETTINGS,
  ...(settings || {}),
  baseAmountMode: settings?.baseAmountMode === 'percent' ? 'percent' : 'fixed',
  baseAmountPercent: Math.max(0.1, asNumber(settings?.baseAmountPercent, 1)),
  baseAmountUsdt: resolveEffectiveDcaBaseAmount(settings, initialBalance),
  stepPercent: Math.max(0.1, asNumber(settings?.stepPercent, DEFAULT_DCA_SETTINGS.stepPercent)),
  maxOrders: Math.max(0, Math.floor(asNumber(settings?.maxOrders, DEFAULT_DCA_SETTINGS.maxOrders))),
  orderMultiplier: Math.max(1, asNumber(settings?.orderMultiplier, DEFAULT_DCA_SETTINGS.orderMultiplier)),
  tpPercent: Math.max(0.1, asNumber(settings?.tpPercent, DEFAULT_DCA_SETTINGS.tpPercent)),
  slPercent: Math.max(0, asNumber(settings?.slPercent, DEFAULT_DCA_SETTINGS.slPercent)),
  interval: asString(settings?.interval, DEFAULT_DCA_SETTINGS.interval) || '4h',
  detectionSource: asString(settings?.detectionSource, DEFAULT_DCA_SETTINGS.detectionSource) || 'close',
  entryFilter: normalizeDcaEntryFilter(settings?.entryFilter),
  reentryBars: Math.max(0, Math.floor(asNumber(settings?.reentryBars, DEFAULT_DCA_SETTINGS.reentryBars))),
  rsiPeriod: Math.max(2, Math.floor(asNumber(settings?.rsiPeriod, DEFAULT_DCA_SETTINGS.rsiPeriod))),
  rsiMax: Math.max(5, Math.min(95, asNumber(settings?.rsiMax, DEFAULT_DCA_SETTINGS.rsiMax))),
  perLegSl: settings?.perLegSl === true,
});

const normalizeFullUsdtSymbol = (raw: string): string => {
  const norm = normalizePairMarketKey(raw);
  if (!norm) {
    return '';
  }
  return norm.endsWith('USDT') ? norm : `${norm}USDT`;
};

const createDcaStrategyRecord = async (
  apiKeyName: string,
  fullSymbolRaw: string,
  settings: DcaStrategySettings = {},
  initialBalance = 10000,
) => {
  const fullSymbol = normalizeFullUsdtSymbol(fullSymbolRaw);
  if (!fullSymbol || fullSymbol.length < 6) {
    throw new Error('fullSymbol is required for DCA strategy');
  }
  const cfg = normalizeDcaSettings(settings, initialBalance);
  const name = `DCA ${fullSymbol}`;
  const draft = {
    name,
    strategy_type: 'dca',
    market_mode: 'mono',
    market_type: 'futures',
    base_symbol: fullSymbol,
    quote_symbol: 'USDT',
    interval: cfg.interval,
    detection_source: cfg.detectionSource,
    is_active: true,
    auto_update: true,
    long_enabled: true,
    short_enabled: false,
  };
  const created = await createStrategy(apiKeyName, draft as Strategy, { allowActivePairConflict: true });
  if (!created.id) {
    throw new Error('DCA strategy created but id missing');
  }
  const dcaBasePercentDb = cfg.baseAmountMode === 'percent' ? cfg.baseAmountPercent : 0;
  await db.run(
    `UPDATE strategies
     SET dca_base_amount_usdt = ?,
         dca_base_amount_percent = ?,
         dca_step_percent = ?,
         dca_max_orders = ?,
         dca_order_multiplier = ?,
         dca_tp_percent = ?,
         dca_sl_percent = ?,
         dca_entry_filter = ?,
         dca_reentry_bars = ?,
         dca_rsi_period = ?,
         dca_rsi_max = ?,
         dca_per_leg_sl = ?,
         dca_legs_json = '[]',
         dca_order_type = ?,
         dca_state = 'idle',
         market_type = 'futures',
         interval = ?,
         detection_source = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [cfg.baseAmountUsdt, dcaBasePercentDb, cfg.stepPercent, cfg.maxOrders, cfg.orderMultiplier, cfg.tpPercent, cfg.slPercent,
      cfg.entryFilter, cfg.reentryBars, cfg.rsiPeriod, cfg.rsiMax, cfg.perLegSl ? 1 : 0, 'market', cfg.interval, cfg.detectionSource, created.id],
  );
  return { ...created, strategyId: Number(created.id), market: fullSymbol };
};

const DCA_RESEARCH_SCRATCH_NAME = '__BTDD_DCA_RESEARCH_SCRATCH__';

const getOrCreateDcaResearchScratchId = async (
  apiKeyName: string,
  settings: DcaStrategySettings = {},
): Promise<number> => {
  const row = await db.get<{ id: number }>(
    `SELECT s.id FROM strategies s
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE ak.name = ? AND s.name = ? AND COALESCE(s.is_archived, 0) = 0
     LIMIT 1`,
    [apiKeyName, DCA_RESEARCH_SCRATCH_NAME],
  );
  if (row?.id) {
    return Number(row.id);
  }
  const created = await createDcaStrategyRecord(apiKeyName, 'BTCUSDT', settings);
  await db.run(
    `UPDATE strategies SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [DCA_RESEARCH_SCRATCH_NAME, created.strategyId],
  );
  return created.strategyId;
};

const configureDcaScratchForSymbol = async (
  strategyId: number,
  fullSymbolRaw: string,
  settings: DcaStrategySettings = {},
  initialBalance = 10000,
): Promise<void> => {
  const cfg = normalizeDcaSettings(settings, initialBalance);
  const fullSymbol = normalizeFullUsdtSymbol(fullSymbolRaw);
  const dcaBasePercentDb = cfg.baseAmountMode === 'percent' ? cfg.baseAmountPercent : 0;
  await db.run(
    `UPDATE strategies
     SET base_symbol = ?,
         quote_symbol = 'USDT',
         market_type = 'futures',
         market_mode = 'mono',
         strategy_type = 'dca',
         dca_base_amount_usdt = ?,
         dca_base_amount_percent = ?,
         dca_step_percent = ?,
         dca_max_orders = ?,
         dca_order_multiplier = ?,
         dca_tp_percent = ?,
         dca_sl_percent = ?,
         dca_entry_filter = ?,
         dca_reentry_bars = ?,
         dca_rsi_period = ?,
         dca_rsi_max = ?,
         dca_per_leg_sl = ?,
         interval = ?,
         detection_source = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [fullSymbol, cfg.baseAmountUsdt, dcaBasePercentDb, cfg.stepPercent, cfg.maxOrders, cfg.orderMultiplier, cfg.tpPercent, cfg.slPercent,
      cfg.entryFilter, cfg.reentryBars, cfg.rsiPeriod, cfg.rsiMax, cfg.perLegSl ? 1 : 0, cfg.interval, cfg.detectionSource, strategyId],
  );
};

/** Sum independent book equity curves on a union timeline (research dual-OP portfolio model). */
const combinePortfolioBookEquityCurves = (
  books: Array<{
    role: string;
    initial: number;
    series: Array<{ t: number; e: number; u: number | null }>;
  }>,
) => {
  const maps = books.map((b) => new Map(b.series.map((p) => [p.t, p])));
  const times = [...new Set(books.flatMap((b) => b.series.map((p) => p.t)))].sort((a, b) => a - b);
  const last = books.map((b) => b.initial);
  const lastU = books.map(() => 0);
  let peak = books.reduce((sum, b) => sum + b.initial, 0);
  let maxDd = 0;
  const curve: Array<{ time: number; equity: number; unrealizedPnl: number }> = [];
  for (const t of times) {
    let eq = 0;
    let up = 0;
    for (let i = 0; i < books.length; i += 1) {
      const p = maps[i].get(t);
      if (p) {
        last[i] = p.e;
        if (p.u != null) lastU[i] = p.u;
      }
      eq += last[i];
      up += lastU[i];
    }
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    curve.push({ time: t, equity: eq, unrealizedPnl: up });
  }
  const capital = books.reduce((sum, b) => sum + b.initial, 0);
  const final = curve.length ? curve[curve.length - 1].equity : capital;
  return {
    capital,
    final: Number(final.toFixed(4)),
    ret: Number((((final / Math.max(1e-9, capital)) - 1) * 100).toFixed(3)),
    dd: Number(maxDd.toFixed(3)),
    curve,
  };
};

/**
 * Real API rerun for algofund portfolios — same model as research stamp:
 * each book is an independent engine run (own OP / lot / capital sleeve / reinvest),
 * then equity curves are summed. Books do NOT share an OP pool and do not compete.
 */
const previewAdminPortfolioSharedMarginRerun = async (args: {
  payload?: {
    portfolioMembers?: Array<{ role?: string; systemName?: string; op?: number; lot?: number; weight?: number }>;
    rerunApiKeyName?: string;
    dateFrom?: string;
    dateTo?: string;
    backtestBars?: number;
    warmupBars?: number;
    commissionPercent?: number;
    slippagePercent?: number;
    fundingRatePercent?: number;
    reinvestPercent?: number;
    partialTpPct?: number;
    enablePairLock?: boolean;
    pairLockSeed?: number;
    autoLotByChannelWidth?: boolean;
    portfolioCircuitBreaker?: PortfolioCircuitBreakerConfig | null;
    lotPercentMultiplierByStrategyId?: Record<string, number>;
    /** Scale every book's recipe lot (1 = unchanged, 1.5 = +50% lot on all books). */
    portfolioLotMult?: number;
    lotPercentOverride?: number;
  };
  sweep: any;
  catalog: any;
  period: any;
  periodDays: number;
  initialBalance: number;
  riskScore: number;
  tradeFrequencyScore: number;
  riskLevel: Level3;
  tradeFrequencyLevel: Level3;
  setKey: string;
}) => {
  const {
    payload,
    sweep,
    catalog,
    period,
    periodDays,
    initialBalance,
    riskScore,
    tradeFrequencyScore,
    riskLevel,
    tradeFrequencyLevel,
    setKey,
  } = args;

  const portfolioRow = await db.get(
    `SELECT id, set_key, metadata_json, snapshot_json
     FROM algofund_portfolios
     WHERE set_key = ? AND COALESCE(is_enabled,1)=1
     LIMIT 1`,
    [setKey],
  ) as { id: number; set_key: string; metadata_json: string; snapshot_json: string } | undefined;
  if (!portfolioRow?.id) {
    throw new Error(`Portfolio not found for setKey=${setKey}`);
  }

  const metadata = (() => {
    try { return JSON.parse(String(portfolioRow.metadata_json || '{}')); } catch { return {}; }
  })() as { books?: Array<Record<string, unknown>> };
  const snapshot = (() => {
    try { return JSON.parse(String(portfolioRow.snapshot_json || '{}')); } catch { return {}; }
  })() as {
    capital?: number;
    books?: Array<Record<string, unknown>>;
    curve?: Array<{ t?: number; e?: number }>;
  };

  const dbMembers = await db.all(
    `SELECT role, system_name, capital_weight
     FROM algofund_portfolio_members
     WHERE portfolio_id = ? AND COALESCE(is_enabled,1)=1
     ORDER BY sort_order ASC, id ASC`,
    [portfolioRow.id],
  ) as Array<{ role: string; system_name: string; capital_weight: number }>;

  const payloadMembers = Array.isArray(payload?.portfolioMembers) ? payload!.portfolioMembers! : [];
  const booksMeta = Array.isArray(metadata?.books) ? metadata.books : [];
  const snapshotCapital = Math.max(100, asNumber(snapshot.capital, initialBalance));

  type BookPlan = {
    role: string;
    systemName: string;
    op: number;
    lot: number;
    weight: number;
    capital: number;
    reinvest: number;
    strategyIds: number[];
  };

  const bookPlans: BookPlan[] = [];
  const memberSource = dbMembers.length > 0
    ? dbMembers.map((m) => ({
      role: asString(m.role, ''),
      systemName: asString(m.system_name, ''),
      weight: asNumber(m.capital_weight, 1),
    }))
    : payloadMembers.map((m) => ({
      role: asString(m.role, ''),
      systemName: asString(m.systemName, ''),
      weight: asNumber(m.weight, 1),
    }));

  const weightSum = Math.max(
    0.01,
    memberSource.reduce((sum, m) => sum + Math.max(0.01, asNumber(m.weight, 1)), 0),
  );

  for (let i = 0; i < memberSource.length; i += 1) {
    const src = memberSource[i];
    const role = src.role || `book${i + 1}`;
    const systemName = src.systemName;
    if (!systemName) {
      throw new Error(`Portfolio ${setKey}: book ${role} has empty systemName`);
    }
    const meta = booksMeta.find((b) => asString(b?.key, '') === role) || booksMeta[i] || {};
    const fromPayload = payloadMembers.find((m) => asString(m.role, '') === role);
    const op = Math.max(
      0,
      Math.floor(asNumber(fromPayload?.op, asNumber(meta?.op, 0))),
    );
    const lot = Math.max(0, asNumber(fromPayload?.lot, asNumber(meta?.lot, 0)));
    const weight = Math.max(0.01, asNumber(src.weight, 1));
    const capitalFromMeta = asNumber(meta?.initial, 0);
    const capital = Math.max(
      100,
      capitalFromMeta > 0
        ? capitalFromMeta
        : Math.round(snapshotCapital * (weight / weightSum)),
    );
    // Book reinvest from recipe meta (e.g. MRS ri:100); payload overrides only when explicitly >0.
    const reinvest = Math.max(
      0,
      Math.min(
        100,
        asNumber(
          payload?.reinvestPercent != null && asNumber(payload.reinvestPercent, 0) > 0
            ? payload.reinvestPercent
            : asNumber(meta?.ri, asNumber(meta?.reinvest, 0)),
          0,
        ),
      ),
    );
    const targets = await resolveAlgofundSystemTargets({ systemName }).catch(() => []);
    const target = targets[0];
    if (!target?.systemId) {
      throw new Error(`Portfolio ${setKey}: trading system not found for book ${role}: ${systemName}`);
    }
    const memberRows = await db.all(
      `SELECT strategy_id
       FROM trading_system_members
       WHERE system_id = ? AND COALESCE(is_enabled, 1) = 1`,
      [target.systemId],
    ) as Array<{ strategy_id: number }>;
    const strategyIds = (memberRows || [])
      .map((r) => Number(r.strategy_id))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (strategyIds.length === 0) {
      throw new Error(`Portfolio ${setKey}: book ${role} (${systemName}) has no enabled members`);
    }
    bookPlans.push({
      role,
      systemName,
      op,
      lot,
      weight,
      capital,
      reinvest,
      strategyIds,
    });
  }

  if (bookPlans.length === 0) {
    throw new Error(`Portfolio ${setKey} has no books to backtest`);
  }

  const firstTarget = await resolveAlgofundSystemTargets({ systemName: bookPlans[0].systemName });
  const preferredApiKey = asString(payload?.rerunApiKeyName, '')
    || asString(firstTarget[0]?.apiKeyName, '')
    || asString(sweep?.apiKeyName, '')
    || asString((sweep?.config || {})?.apiKeyName, '')
    || asString(catalog?.apiKeyName, '')
    || asString((await getAvailableApiKeyNames())[0], '');
  if (!preferredApiKey) {
    throw new Error('No API key available for portfolio independent-book rerun');
  }

  const commissionPercent = Math.max(0, asNumber(payload?.commissionPercent, asNumber(sweep?.config?.commissionPercent, 0.1)));
  const slippagePercent = Math.max(0, asNumber(payload?.slippagePercent, asNumber(sweep?.config?.slippagePercent, 0.05)));
  const fundingRatePercent = asNumber(payload?.fundingRatePercent, asNumber(sweep?.config?.fundingRatePercent, 0));
  const partialTpPct = Math.max(0, asNumber(payload?.partialTpPct, 0));
  // Portfolio-wide lot scale: recipe lot × mult (keeps relative book lots).
  const portfolioLotMult = Math.max(
    0.05,
    Math.min(10, asNumber(payload?.portfolioLotMult, 1) || 1),
  );

  // Prefer explicit UI dates; else stamp curve window; else sweep defaults.
  // Stamp curve `t` is unix seconds (research combineBooks); engine uses ms.
  const snapCurveTsToMs = (raw: number): number => {
    const t = asNumber(raw, 0);
    if (!(t > 0)) return 0;
    return t < 1e12 ? t * 1000 : t;
  };
  const saneYmd = (raw: string): string => {
    const ymd = String(raw || '').trim().slice(0, 10);
    // Reject epoch-corruption leftovers (e.g. 1970-01-20 from seconds-as-ms).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || ymd < '2018-01-01') return '';
    return ymd;
  };
  const snapCurve = Array.isArray(snapshot.curve) ? snapshot.curve : [];
  const snapFromMs = snapCurve.length > 0 ? snapCurveTsToMs(asNumber(snapCurve[0]?.t, 0)) : 0;
  const snapToMs = snapCurve.length > 0
    ? snapCurveTsToMs(asNumber(snapCurve[snapCurve.length - 1]?.t, 0))
    : 0;
  const snapFromYmd = snapFromMs > 0 ? (msToYmd(snapFromMs) || '') : '';
  const snapToYmd = snapToMs > 0 ? (msToYmd(snapToMs) || '') : '';
  const rerunWindow = resolveAdminPreviewRerunWindow(
    sweep,
    null,
    saneYmd(asString(payload?.dateFrom, ''))
      || saneYmd(snapFromYmd)
      || saneYmd(asString(sweep?.config?.dateFrom, '').slice(0, 10)),
    saneYmd(asString(payload?.dateTo, '')) || saneYmd(snapToYmd),
    {
      bars: Math.max(0, Math.floor(asNumber(payload?.backtestBars, 0))) || undefined,
      warmupBars: Math.max(0, Math.floor(asNumber(payload?.warmupBars, 0))) || undefined,
    },
  );

  await ensureExchangeClientInitialized(preferredApiKey);

  type BookRunResult = {
    role: string;
    capital: number;
    op: number;
    lot: number;
    lotEffective: number;
    reinvest: number;
    strategyIds: number[];
    systemName: string;
    weight: number;
    summary: Record<string, unknown>;
    series: Array<{ t: number; e: number; u: number | null }>;
    trades: Array<Record<string, unknown>>;
  };

  const bookRuns: BookRunResult[] = [];
  for (const book of bookPlans) {
    const lotEffective = book.lot > 0
      ? Number(Math.min(500, Math.max(0.05, book.lot * portfolioLotMult)).toFixed(4))
      : 0;
    const result = await runBacktest({
      apiKeyName: preferredApiKey,
      mode: 'portfolio',
      strategyIds: book.strategyIds,
      bars: rerunWindow.bars,
      warmupBars: rerunWindow.warmupBars,
      skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
      initialBalance: book.capital,
      commissionPercent,
      slippagePercent,
      fundingRatePercent,
      dateFrom: rerunWindow.dateFrom,
      ...(rerunWindow.dateTo ? { dateTo: rerunWindow.dateTo } : {}),
      // Independent OP for this book only — never a shared portfolio OP pool.
      maxOpenPositions: book.op > 0 ? book.op : 0,
      ...(lotEffective > 0 ? { lotPercentOverride: lotEffective } : {}),
      ...(partialTpPct > 0 ? { partialTpPct } : {}),
      // Pair-lock only inside the book (separate run ⇒ no cross-book OP/pair competition).
      enablePairLock: payload?.enablePairLock !== false,
      ...(payload?.pairLockSeed !== undefined ? { pairLockSeed: payload.pairLockSeed } : {}),
      // Match research portfolio recipe: allow deposit growth under reinvest.
      maxDepositOverride: book.reinvest > 0 ? book.capital * 50 : 0,
      reinvestPercentOverride: book.reinvest,
      ...(payload?.autoLotByChannelWidth === true ? { autoLotByChannelWidth: true } : {}),
      ...(payload?.portfolioCircuitBreaker
        ? { portfolioCircuitBreaker: payload.portfolioCircuitBreaker }
        : {}),
    });

    const series = (result.equityCurve || []).map((pt) => {
      const t = asNumber(pt.time, 0);
      const e = asNumber(pt.equity, book.capital);
      const uRaw = Number((pt as { unrealizedPnl?: unknown }).unrealizedPnl);
      return {
        t,
        e,
        u: Number.isFinite(uRaw) ? uRaw : null,
      };
    }).filter((p) => p.t > 0 && Number.isFinite(p.e));

    bookRuns.push({
      role: book.role,
      capital: book.capital,
      op: book.op,
      lot: book.lot,
      lotEffective,
      reinvest: book.reinvest,
      strategyIds: book.strategyIds,
      systemName: book.systemName,
      weight: book.weight,
      summary: result.summary as unknown as Record<string, unknown>,
      series,
      trades: (result.trades || []).map((tr) => ({
        ...(tr as unknown as Record<string, unknown>),
        portfolioBook: book.role,
      })),
    });
  }

  const combined = combinePortfolioBookEquityCurves(
    bookRuns.map((b) => ({ role: b.role, initial: b.capital, series: b.series })),
  );
  const rerunMetrics = summarizeRealRerunEquityCurve(combined.curve, combined.capital);
  const allTrades = bookRuns
    .flatMap((b) => b.trades)
    .sort((a, b) => asNumber(a.exitTime ?? a.entryTime, 0) - asNumber(b.exitTime ?? b.entryTime, 0));
  const wins = allTrades.filter((t) => asNumber(t.netPnl, 0) > 0).length;
  const grossProfit = allTrades.reduce((s, t) => s + Math.max(0, asNumber(t.netPnl, 0)), 0);
  const grossLoss = allTrades.reduce((s, t) => s + Math.abs(Math.min(0, asNumber(t.netPnl, 0))), 0);
  const tradesCount = allTrades.length;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 0);
  const winRatePercent = tradesCount > 0 ? (wins / tradesCount) * 100 : 0;
  const actualStartMs = Math.min(
    ...bookRuns.map((b) => asNumber(b.summary.actualDataStartMs, Number.POSITIVE_INFINITY)),
  );
  const actualEndMs = Math.max(
    ...bookRuns.map((b) => asNumber(b.summary.actualDataEndMs, 0)),
  );
  const skippedByPositionLimit = bookRuns.reduce(
    (s, b) => s + asNumber(b.summary.skippedByPositionLimit, 0),
    0,
  );
  const allStrategyIds = Array.from(new Set(bookPlans.flatMap((b) => b.strategyIds)));

  const selectedOffers = bookRuns.map((book) => {
    const bookRet = asNumber(book.summary.totalReturnPercent, 0);
    const bookDd = asNumber(book.summary.maxDrawdownPercent, 0);
    const bookPf = asNumber(book.summary.profitFactor, 0);
    const bookTrades = Math.max(0, Math.floor(asNumber(book.summary.tradesCount, 0)));
    const bookEquity = book.series.map((p) => Number(p.e.toFixed(4)));
    return {
      offerId: `portfolio-book:${book.role}`,
      titleRu: `${book.role} · OP ${book.op || '—'} · lot ${book.lotEffective || book.lot || '—'}%`
        + (portfolioLotMult !== 1 && book.lot > 0 ? ` (×${portfolioLotMult})` : '')
        + ` · cap $${book.capital} · ri ${book.reinvest}`,
      weight: book.weight,
      mode: 'mono' as const,
      market: '',
      familyType: '',
      familyMode: 'mono' as const,
      familyInterval: asString(period?.interval, '4h'),
      strategyId: book.strategyIds[0] || 0,
      strategyName: book.systemName,
      score: 0,
      metrics: {
        ret: Number(bookRet.toFixed(3)),
        pf: Number(bookPf.toFixed(3)),
        dd: Number(bookDd.toFixed(3)),
        wr: Number(asNumber(book.summary.winRatePercent, 0).toFixed(3)),
        trades: bookTrades,
      },
      tradesPerDay: Number((bookTrades / Math.max(1, periodDays)).toFixed(3)),
      periodDays,
      equityPoints: bookEquity,
    };
  });

  return {
    kind: 'algofund-ts' as const,
    publishMeta: {
      setKey,
      systemName: setKey,
      membersCount: bookPlans.length,
      offerIds: selectedOffers.map((o) => o.offerId),
      method: 'per_book_OP_then_equity_sum',
      portfolioLotMult,
      books: bookRuns.map((b) => ({
        role: b.role,
        systemName: b.systemName,
        op: b.op,
        lot: b.lot,
        lotEffective: b.lotEffective,
        capital: b.capital,
        reinvest: b.reinvest,
        strategyCount: b.strategyIds.length,
        ret: asNumber(b.summary.totalReturnPercent, 0),
        dd: asNumber(b.summary.maxDrawdownPercent, 0),
        trades: asNumber(b.summary.tradesCount, 0),
      })),
    },
    controls: {
      riskScore,
      tradeFrequencyScore,
      riskLevel,
      tradeFrequencyLevel,
      initialBalance: combined.capital,
      riskScaleMaxPercent: 100,
      reinvestPercent: Math.max(...bookPlans.map((b) => b.reinvest), 0),
      portfolioLotMult,
    },
    period: {
      dateFrom: rerunWindow.dateFrom || null,
      dateTo: rerunWindow.dateTo || null,
      interval: asString(period?.interval, asString(sweep?.config?.interval, '4h')),
      actualDateFrom: Number.isFinite(actualStartMs) ? msToYmd(actualStartMs) : null,
      actualDateTo: actualEndMs > 0 ? msToYmd(actualEndMs) : null,
    },
    sweepApiKeyName: preferredApiKey,
    selectedOffers,
    preview: {
      source: 'admin_portfolio_independent_books_rerun',
      summary: {
        mode: 'portfolio',
        apiKeyName: preferredApiKey,
        strategyIds: allStrategyIds,
        initialBalance: combined.capital,
        finalEquity: rerunMetrics.finalEquity,
        totalReturnPercent: rerunMetrics.totalReturnPercent,
        maxDrawdownPercent: rerunMetrics.maxDrawdownPercent,
        unrealizedPnl: rerunMetrics.unrealizedPnl,
        netProfit: Number((rerunMetrics.finalEquity - combined.capital).toFixed(4)),
        marginLoadPercent: 0,
        tradesCount,
        winRatePercent: Number(winRatePercent.toFixed(3)),
        profitFactor: Number(profitFactor.toFixed(3)),
        grossProfit: Number(grossProfit.toFixed(4)),
        grossLoss: Number(grossLoss.toFixed(4)),
        skippedByPositionLimit,
      },
      equity: rerunMetrics.equity || sanitizeEquityCurveForMetrics(combined.curve, combined.capital),
      curves: {
        pnl: rerunMetrics.curves.pnl,
        drawdownPercent: rerunMetrics.curves.drawdownPercent,
        marginLoadPercent: rerunMetrics.curves.marginLoadPercent,
        unrealizedPnl: combined.curve
          .filter((point) => Number.isFinite(Number(point.unrealizedPnl)))
          .map((point) => ({
            time: asNumber(point.time, 0),
            value: Number(asNumber(point.unrealizedPnl, 0).toFixed(4)),
          })),
      },
      trades: allTrades,
      strictPresetMode: false,
      riskApproximated: false,
      reinvestAppliedInEngine: bookPlans.some((b) => b.reinvest > 0),
      portfolioSharedMargin: false,
      portfolioPerBookOp: true,
      portfolioIndependentBooks: true,
    },
    rerun: {
      requested: true,
      executed: true,
      apiKeyName: preferredApiKey,
      strategyIds: allStrategyIds,
      tsMembersCount: bookPlans.length,
      riskMul: 1,
      riskScaleMaxPercent: 100,
      freqLevel: tradeFrequencyLevel,
      method: 'per_book_OP_then_equity_sum',
      portfolioLotMult,
      skippedByPositionLimit,
      books: bookRuns.map((b) => ({
        role: b.role,
        capital: b.capital,
        op: b.op,
        lot: b.lot,
        lotEffective: b.lotEffective,
        reinvest: b.reinvest,
        ret: asNumber(b.summary.totalReturnPercent, 0),
        dd: asNumber(b.summary.maxDrawdownPercent, 0),
        trades: asNumber(b.summary.tradesCount, 0),
      })),
    },
  };
};

export const previewAdminSweepBacktest = async (payload?: {
  kind?: 'offer' | 'algofund-ts';
  setKey?: string;
  systemName?: string;
  offerId?: string;
  offerIds?: string[];
  offerWeightsById?: Record<string, number>;
  riskScore?: number;
  tradeFrequencyScore?: number;
  initialBalance?: number;
  reinvestPercent?: number;
  riskScaleMaxPercent?: number;
  maxOpenPositions?: number;
  lotPercentOverride?: number;
  partialTpPct?: number;
  commissionPercent?: number;
  slippagePercent?: number;
  fundingRatePercent?: number;
  dateFrom?: string;
  dateTo?: string;
  preferRealBacktest?: boolean;
  rerunApiKeyName?: string;
  backtestBars?: number;
  warmupBars?: number;
  /** When true, keep payload.offerIds instead of replacing from saved TS snapshot (synthetic research runs). */
  forceOfferIds?: boolean;
  /** Optional pair-lock toggle (Etap B comparison). Defaults to engine default (true). */
  enablePairLock?: boolean;
  /** Optional pair-lock RNG seed for tie-break. Defaults to engine default. */
  pairLockSeed?: number;
  /** Internal flag: set to true only for server-side background snapshot refresh. Never expose to clients. */
  isBatchRefresh?: boolean;
  /** Scale trend entries by inverse Donchian channel width. */
  autoLotByChannelWidth?: boolean;
  macroExitOverlay?: MacroExitOverlay;
  statArbEntryGate?: StatArbEntryGate;
  macroShield?: boolean;
  portfolioCircuitBreaker?: PortfolioCircuitBreakerConfig | null;
  lotPercentMultiplierByStrategyId?: Record<string, number>;
  /** Multi-book portfolio independent rerun (per-book OP → equity sum). */
  portfolioMode?: boolean;
  portfolioMembers?: Array<{
    role?: string;
    systemName?: string;
    op?: number;
    lot?: number;
    weight?: number;
  }>;
  /** Scale every portfolio book's recipe lot (default 1). */
  portfolioLotMult?: number;
}) => {
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const apiKeys = await getAvailableApiKeyNames();
  let catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  if (!catalog) {
    throw new Error('Catalog is unavailable for sweep backtest preview');
  }

  const kind: 'offer' | 'algofund-ts' = payload?.kind === 'algofund-ts' ? 'algofund-ts' : 'offer';
  let period = buildPeriodInfo(sweep);
  let periodDays = getSweepPeriodDays(sweep, 90);
  const initialBalance = Math.max(100, asNumber(payload?.initialBalance, asNumber(sweep?.config?.initialBalance, 10000)));
  const riskScore = normalizePreferenceScore(payload?.riskScore, 'medium');
  const tradeFrequencyScore = normalizePreferenceScore(payload?.tradeFrequencyScore, 'medium');
  const riskLevel = preferenceScoreToLevel(riskScore);
  const tradeFrequencyLevel = preferenceScoreToLevel(tradeFrequencyScore);
  const requestedSystemName = asString(payload?.systemName, '').trim();
  const requestedSetKey = asString(payload?.setKey, '').trim();
  const isCloudSystem = /::cloud-/i.test(requestedSystemName) || /^cloud/i.test(requestedSystemName);
  const sweepEvaluatedRows: SweepRecord[] = Array.isArray(sweep?.evaluated)
    ? sweep.evaluated.filter((item): item is SweepRecord => Boolean(item && Number(item.strategyId || 0) > 0))
    : [];

  // ── Portfolio shared-margin API rerun (all books, one trade stream, per-book OP) ──
  if (
    kind === 'algofund-ts'
    && payload?.preferRealBacktest === true
    && (payload?.portfolioMode === true || requestedSetKey.toLowerCase().startsWith('portfolio-'))
  ) {
    return previewAdminPortfolioSharedMarginRerun({
      payload,
      sweep,
      catalog,
      period,
      periodDays,
      initialBalance,
      riskScore,
      tradeFrequencyScore,
      riskLevel,
      tradeFrequencyLevel,
      setKey: requestedSetKey || requestedSystemName,
    });
  }

  let offerIds: string[] = [];
  if (kind === 'offer') {
    const offerId = asString(payload?.offerId, '');
    if (!offerId) {
      throw new Error('offerId is required for offer sweep backtest preview');
    }
    offerIds = [offerId];
  } else {
    const payloadOfferIds = Array.isArray(payload?.offerIds)
      ? payload?.offerIds?.map((item) => asString(item, '')).filter(Boolean)
      : [];
    const isCloudGrouped = /^cloud/i.test(requestedSystemName) && /\(.*\//.test(requestedSystemName);
    if (payloadOfferIds.length > 0) {
      offerIds = Array.from(new Set(payloadOfferIds));
    } else if (requestedSystemName) {
      // For Cloud grouped cards (e.g. "Cloud_OP2 (Bybit / MEXC / WEEX)"), resolve all Cloud TS members
      let runtimeStrategyIds: number[] = [];

      if (isCloudGrouped) {
        const cloudTsRows = await db.all(
          `SELECT ts.id, ts.name, ak.name as api_key_name
           FROM trading_systems ts
           JOIN api_keys ak ON ak.id = ts.api_key_id
           WHERE UPPER(ts.name) LIKE 'CLOUD%' AND ts.is_active = 1
           ORDER BY ts.id`
        ) as Array<{ id: number; name: string; api_key_name: string }>;
        for (const row of cloudTsRows) {
          const sys = await getTradingSystem(row.api_key_name, row.id).catch(() => null);
          if (sys?.members) {
            for (const m of sys.members) {
              if (m && m.is_enabled !== false) {
                const sid = Number(m?.strategy_id || m?.strategy?.id || 0);
                if (sid > 0) runtimeStrategyIds.push(sid);
              }
            }
          }
        }
        runtimeStrategyIds = Array.from(new Set(runtimeStrategyIds));
      } else {
        const resolvedTargets = await resolveAlgofundSystemTargets({ systemName: requestedSystemName }).catch(() => []);
        const resolvedTarget = resolvedTargets[0] || null;
        const runtimeSystem = resolvedTarget
          ? await getTradingSystem(resolvedTarget.apiKeyName, resolvedTarget.systemId).catch(() => null)
          : null;
        runtimeStrategyIds = Array.isArray(runtimeSystem?.members)
          ? Array.from(new Set(
            runtimeSystem.members
              .filter((member) => member && member.is_enabled !== false)
              .map((member) => Number(member?.strategy_id || member?.strategy?.id || 0))
              .filter((value) => Number.isFinite(value) && value > 0)
          ))
          : [];
      }

      if (runtimeStrategyIds.length > 0) {
        const offerStore = await getOfferStoreAdminState().catch(() => null);
        const byStrategyId = new Map(
          (offerStore?.offers || [])
            .map((row) => [Number(row?.strategyId || 0), String(row?.offerId || '')] as const)
            .filter(([strategyId, offerId]) => strategyId > 0 && Boolean(offerId))
        );
        offerIds = runtimeStrategyIds
          .map((strategyId) => byStrategyId.get(strategyId) || '')
          .filter(Boolean);
      }
    } else {
      const draftStrategyIds = new Set(
        (catalog.adminTradingSystemDraft?.members || [])
          .map((member) => Number(member.strategyId || 0))
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      offerIds = getAllOffers(catalog)
        .filter((offer) => draftStrategyIds.has(Number(offer.strategy?.id || 0)))
        .map((offer) => String(offer.offerId || ''))
        .filter(Boolean);
    }
    const requestedSetKey = normalizeTsSnapshotMapKey(asString(payload?.setKey, ''));
    // For Cloud grouped TS with no existing members, use all catalog offers so sweep can pick
    if (offerIds.length === 0 && isCloudGrouped) {
      offerIds = getAllOffers(catalog)
        .map((offer) => String(offer.offerId || ''))
        .filter(Boolean);
    }
  }

  let tsSavedSnapshotForPreview: TsBacktestSnapshot | null = null;
  if (kind === 'algofund-ts') {
    tsSavedSnapshotForPreview = await resolveAlgofundTsBacktestSnapshotForPreview({
      setKey: asString(payload?.setKey, ''),
      systemName: requestedSystemName,
      offerIds,
    });
    if (tsSavedSnapshotForPreview && payload?.forceOfferIds !== true) {
      const snapshotOfferIds = Array.from(new Set(
        (Array.isArray(tsSavedSnapshotForPreview.offerIds) ? tsSavedSnapshotForPreview.offerIds : [])
          .map((item) => asString(item, '').trim())
          .filter(Boolean),
      ));
      if (snapshotOfferIds.length > 0) {
        offerIds = snapshotOfferIds;
      }
    }
    if (offerIds.length === 0) {
      throw new Error('No offerIds resolved for TS sweep backtest preview');
    }
  }

  let tsPreviewMechanicsExtras: Pick<BacktestRunRequest, 'macroExitOverlay' | 'statArbEntryGate'> = {};
  if (kind === 'algofund-ts') {
    const mechanics = await resolvePreviewCardMechanics({
      systemName: requestedSystemName,
      setKey: asString(payload?.setKey, ''),
      snapshot: tsSavedSnapshotForPreview,
      payloadMacroExitOverlay: payload?.macroExitOverlay,
      payloadStatArbEntryGate: payload?.statArbEntryGate,
      payloadMacroShield: payload?.macroShield,
    });
    tsPreviewMechanicsExtras = {
      ...(mechanics.macroExitOverlay ? { macroExitOverlay: mechanics.macroExitOverlay } : {}),
      ...(mechanics.statArbEntryGate ? { statArbEntryGate: mechanics.statArbEntryGate } : {}),
    };
  }

  if (kind === 'algofund-ts' && payload?.forceOfferIds === true && offerIds.length > 0 && sweepEvaluatedRows.length > 0) {
    catalog = augmentCatalogWithForcedOfferIds(catalog, sweepEvaluatedRows, offerIds);
  }

  const offerStoreState = await getOfferStoreAdminState().catch(() => null);
  const offerStoreById = new Map(
    ((offerStoreState?.offers || []) as Array<Record<string, unknown>>)
      .map((row) => [asString(row?.offerId, '').trim(), row] as const)
      .filter(([offerId]) => Boolean(offerId))
  );
  let singleOfferStoreDateFrom = '';
  let singleOfferStoreDateTo = '';

  let selectedOffers = kind === 'offer' && offerIds.length > 0 && offerStoreById.has(offerIds[0])
    ? (() => {
      const row = offerStoreById.get(offerIds[0]) as Record<string, unknown>;
      const strategyId = Number(row?.strategyId || parseStrategyIdFromOfferId(offerIds[0]) || 0);
      const ret = asNumber(row?.ret, 0);
      const pf = asNumber(row?.pf, 1);
      const dd = asNumber(row?.dd, 0);
      const trades = Math.max(0, Math.floor(asNumber(row?.trades, 0)));
      const wr = 0;
      const periodDaysFromStore = Math.max(1, Math.floor(asNumber(row?.periodDays, periodDays)));
      const intervalFromStore = asString(
        row?.familyInterval,
        asString(row?.interval, asString((row?.strategyParams as Record<string, unknown> | undefined)?.interval, '4h')),
      );
      const now = new Date();
      const from = new Date(now.getTime() - periodDaysFromStore * 24 * 3600 * 1000);
      singleOfferStoreDateFrom = from.toISOString().slice(0, 10);
      singleOfferStoreDateTo = now.toISOString().slice(0, 10);
      period = { dateFrom: singleOfferStoreDateFrom, dateTo: singleOfferStoreDateTo, interval: intervalFromStore };
      periodDays = periodDaysFromStore;

      return [{
        offerId: asString(row?.offerId, offerIds[0]),
        titleRu: asString(row?.titleRu, offerIds[0]),
        mode: asString(row?.mode, 'mono') === 'synth' ? 'synth' : 'mono',
        market: asString(row?.market, ''),
        familyType: '',
        familyMode: asString(row?.mode, 'mono') === 'synth' ? 'synthetic' : 'mono',
        familyInterval: intervalFromStore,
        strategyId,
        strategyName: asString(row?.titleRu, `Strategy #${strategyId || 0}`),
        score: Number(asNumber(row?.score, 0).toFixed(3)),
        metricsSource: 'offer_store' as const,
        metrics: {
          ret: Number(ret.toFixed(3)),
          pf: Number(pf.toFixed(3)),
          dd: Number(dd.toFixed(3)),
          wr: Number(wr.toFixed(3)),
          trades,
        },
        tradesPerDay: Number(asNumber(row?.tradesPerDay, trades / Math.max(1, periodDaysFromStore)).toFixed(3)),
        periodDays: periodDaysFromStore,
        equityPoints: Array.isArray(row?.equityPoints)
          ? (row.equityPoints as unknown[]).map((value) => Number(asNumber(value, 0).toFixed(4))).filter((value) => Number.isFinite(value))
          : toPresetOnlyEquity(initialBalance, ret).map((point) => Number(asNumber(point.equity, 0).toFixed(4))),
        preset: {
          strategyId,
          strategyName: asString(row?.titleRu, `Strategy #${strategyId || 0}`),
          score: Number(asNumber(row?.score, 0).toFixed(3)),
          metrics: {
            ret: Number(ret.toFixed(3)),
            pf: Number(pf.toFixed(3)),
            dd: Number(dd.toFixed(3)),
            wr: Number(wr.toFixed(3)),
            trades,
          },
          params: {
            interval: intervalFromStore,
            length: 24,
            takeProfitPercent: 5,
            detectionSource: 'close',
            zscoreEntry: 2,
            zscoreExit: 0.5,
            zscoreStop: 3.5,
          },
        },
      }];
    })()
    : offerIds
      .map((offerId) => findOfferByIdOrNull(catalog, offerId))
      .filter((offer): offer is CatalogOffer => Boolean(offer))
      .map((offer) => {
      const matrixPreset = kind === 'algofund-ts'
        ? (offer.presetMatrix?.[riskLevel]?.[tradeFrequencyLevel] || null)
        : null;
      const preset = matrixPreset || resolveOfferPresetByPreference(
        offer,
        riskLevel,
        tradeFrequencyLevel,
        riskScore,
        tradeFrequencyScore
      );

      // TS fallback for older catalogs: derive low/medium/high frequency variant
      // directly from sweep family rows so freq changes strategy variant (not TS size).
      let familyVariant: SweepRecord | null = null;
      const useExactOfferStrategyIds = payload?.forceOfferIds === true || payload?.preferRealBacktest === true;
      if (kind === 'algofund-ts' && sweepEvaluatedRows.length > 0 && !useExactOfferStrategyIds) {
        const modeToken = offer.strategy?.mode === 'synth' ? 'synthetic' : 'mono';
        const intervalToken = asString(preset.params?.interval || offer.strategy?.params?.interval, '');
        const familyRows = sweepEvaluatedRows.filter((row) => {
          const rowMode = asString(row.marketMode, '');
          const modeMatched = modeToken === 'synthetic'
            ? (rowMode === 'synthetic' || rowMode === 'synth')
            : rowMode === 'mono';
          if (!modeMatched) {
            return false;
          }
          return asString(row.strategyType, '') === asString(offer.strategy?.type, '')
            && asString(row.market, '') === asString(offer.strategy?.market, '')
            && (!intervalToken || asString(row.interval, '') === intervalToken);
        });

        if (familyRows.length > 0) {
          const anchor = familyRows.find((row) => Number(row.strategyId || 0) === Number(preset.strategyId || 0)) || familyRows[Math.floor(familyRows.length / 2)];
          const familyPresetRows = pickFamilyTradePresetRows(anchor, familyRows);
          familyVariant = familyPresetRows[tradeFrequencyLevel] || null;
        }
      }

      const resolvedStrategyId = Number(familyVariant?.strategyId || preset.strategyId || offer.strategy?.id || 0);
      const trades = Math.max(0, Math.floor(asNumber(familyVariant?.tradesCount, asNumber(preset.metrics?.trades, offer.metrics?.trades || 0))));
      const ret = asNumber(familyVariant?.totalReturnPercent, asNumber(preset.metrics?.ret, offer.metrics?.ret || 0));
      const pf = asNumber(familyVariant?.profitFactor, asNumber(preset.metrics?.pf, offer.metrics?.pf || 0));
      const dd = asNumber(familyVariant?.maxDrawdownPercent, asNumber(preset.metrics?.dd, offer.metrics?.dd || 0));
      const tradesPerDay = Number((trades / Math.max(1, periodDays)).toFixed(3));
        return {
          offerId: String(offer.offerId || ''),
          titleRu: asString(offer.titleRu, offer.offerId),
          mode: offer.strategy?.mode === 'synth' ? 'synth' : 'mono',
          market: asString(offer.strategy?.market, ''),
          familyType: asString(offer.strategy?.type, ''),
          familyMode: offer.strategy?.mode === 'synth' ? 'synthetic' : 'mono',
          familyInterval: asString(preset.params?.interval || offer.strategy?.params?.interval, ''),
          strategyId: resolvedStrategyId,
          strategyName: asString(familyVariant?.strategyName, asString(preset.strategyName, offer.strategy?.name || '')),
          score: Number(asNumber(preset.score, offer.metrics?.score || 0).toFixed(3)),
          metrics: {
            ret: Number(ret.toFixed(3)),
            pf: Number(pf.toFixed(3)),
            dd: Number(dd.toFixed(3)),
            wr: Number(asNumber(familyVariant?.winRatePercent, asNumber(preset.metrics?.wr, offer.metrics?.wr || 0)).toFixed(3)),
            trades,
          },
          tradesPerDay,
          periodDays,
          equityPoints: toPresetOnlyEquity(initialBalance, ret).map((point) => Number(asNumber(point.equity, 0).toFixed(4))),
          preset,
        };
      });

  if (kind === 'algofund-ts' && selectedOffers.length < offerIds.length) {
    const existingOfferIds = new Set(selectedOffers.map((item) => String(item.offerId || '')));
    const missingOfferIds = offerIds.filter((offerId) => !existingOfferIds.has(offerId));
    if (missingOfferIds.length > 0) {
      const offerStoreById = new Map(
        ((offerStoreState?.offers || []) as Array<Record<string, unknown>>)
          .map((row) => [String(row?.offerId || ''), row] as const)
          .filter(([offerId]) => Boolean(offerId))
      );
      const fallbackRiskMul = Math.max(0.2, Math.min(2, 0.25 + (riskScore / 10) * 1.75));
      const fallbackFreqMul = Math.max(0.3, Math.min(2.5, 0.2 + (tradeFrequencyScore / 10) * 2.3));
      const fallbackInterval = isCloudSystem ? '5m' : asString(sweep?.config?.interval, '');

      const fallbackSelected = missingOfferIds
        .map((offerId) => {
          const row = offerStoreById.get(offerId);
          if (!row) {
            return null;
          }
          const baseTrades = Math.max(1, Math.floor(asNumber(row.trades, 0)));
          const trades = Math.max(1, Math.floor(baseTrades * fallbackFreqMul));
          const ret = asNumber(row.ret, 0) * fallbackRiskMul;
          const dd = asNumber(row.dd, 0) * Math.max(0.7, fallbackRiskMul);
          const pf = Math.max(0.2, asNumber(row.pf, 1) * (0.9 + fallbackRiskMul * 0.1));
          return {
            offerId: String(row.offerId || offerId),
            titleRu: asString(row.titleRu, String(row.offerId || offerId)),
            mode: row.mode === 'synth' ? 'synth' as const : 'mono' as const,
            market: asString(row.market, ''),
            familyType: '',
            familyMode: row.mode === 'synth' ? 'synthetic' as const : 'mono' as const,
            familyInterval: fallbackInterval,
            strategyId: Number(row.strategyId || parseStrategyIdFromOfferId(offerId) || 0),
            strategyName: asString(row.titleRu, String(row.offerId || offerId)),
            score: Number(asNumber(row.score, 0).toFixed(3)),
            metricsSource: 'offer_store' as const,
            metrics: {
              ret: Number(ret.toFixed(3)),
              pf: Number(pf.toFixed(3)),
              dd: Number(dd.toFixed(3)),
              wr: 0,
              trades,
            },
            tradesPerDay: Number((trades / Math.max(1, periodDays)).toFixed(3)),
            periodDays,
            equityPoints: toPresetOnlyEquity(initialBalance, ret).map((point) => Number(asNumber(point.equity, 0).toFixed(4))),
            preset: {
              strategyId: Number(row.strategyId || parseStrategyIdFromOfferId(offerId) || 0),
              strategyName: asString(row.titleRu, String(row.offerId || offerId)),
              score: Number(asNumber(row.score, 0).toFixed(3)),
              metrics: {
                ret: Number(ret.toFixed(3)),
                pf: Number(pf.toFixed(3)),
                dd: Number(dd.toFixed(3)),
                wr: 0,
                trades,
              },
              params: {
                interval: fallbackInterval || asString(sweep?.config?.interval, '4h'),
                length: 24,
                takeProfitPercent: 5,
                detectionSource: 'close',
                zscoreEntry: 2,
                zscoreExit: 0.5,
                zscoreStop: 3.5,
              },
            },
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      if (fallbackSelected.length > 0) {
        selectedOffers = [...selectedOffers, ...fallbackSelected];
      }
    }
  }

  if (kind === 'algofund-ts' && selectedOffers.length > 0 && sweepEvaluatedRows.length > 0) {
    const grouped = new Map<string, number[]>();
    selectedOffers.forEach((item, index) => {
      const key = [
        asString((item as Record<string, unknown>).familyType, ''),
        asString((item as Record<string, unknown>).familyMode, ''),
        asString(item.market, ''),
        asString((item as Record<string, unknown>).familyInterval, ''),
      ].join('|');
      const next = grouped.get(key) || [];
      next.push(index);
      grouped.set(key, next);
    });

    grouped.forEach((indexes, key) => {
      const [familyType, familyMode, familyMarket, familyInterval] = key.split('|');
      const familyRows = sweepEvaluatedRows
        .filter((row) => {
          const rowMode = asString(row.marketMode, '');
          const modeMatched = familyMode === 'synthetic'
            ? (rowMode === 'synthetic' || rowMode === 'synth')
            : rowMode === 'mono';
          if (!modeMatched) {
            return false;
          }
          if (asString(row.strategyType, '') !== familyType) {
            return false;
          }
          if (asString(row.market, '') !== familyMarket) {
            return false;
          }
          if (familyInterval && asString(row.interval, '') !== familyInterval) {
            return false;
          }
          return Number(row.strategyId || 0) > 0;
        })
        .sort((left, right) => {
          const tradeDiff = asNumber(left.tradesCount, 0) - asNumber(right.tradesCount, 0);
          if (tradeDiff !== 0) {
            return tradeDiff;
          }
          return asNumber(right.score, 0) - asNumber(left.score, 0);
        });

      if (familyRows.length === 0) {
        return;
      }

      const memberCount = indexes.length;
      const total = familyRows.length;
      let start = 0;
      if (tradeFrequencyLevel === 'high') {
        start = Math.max(0, total - memberCount);
      } else if (tradeFrequencyLevel === 'medium') {
        start = Math.max(0, Math.floor((total - memberCount) / 2));
      }

      indexes.forEach((offerIndex, localIndex) => {
        const row = familyRows[Math.min(start + localIndex, total - 1)] || null;
        if (!row) {
          return;
        }
        const current = selectedOffers[offerIndex];
        if (!current) {
          return;
        }
        current.strategyId = Number(row.strategyId || current.strategyId);
        current.strategyName = asString(row.strategyName, current.strategyName);
        current.metrics = {
          ...current.metrics,
          ret: Number(asNumber(row.totalReturnPercent, current.metrics.ret).toFixed(3)),
          pf: Number(asNumber(row.profitFactor, current.metrics.pf).toFixed(3)),
          dd: Number(asNumber(row.maxDrawdownPercent, current.metrics.dd).toFixed(3)),
          wr: Number(asNumber(row.winRatePercent, current.metrics.wr).toFixed(3)),
          trades: Math.max(0, Math.floor(asNumber(row.tradesCount, current.metrics.trades))),
        };
      });
    });
  }

  const normalizedOfferWeightsById: Record<string, number> = (() => {
    if (kind !== 'algofund-ts') {
      return {};
    }
    const ids = Array.from(new Set(
      selectedOffers
        .map((item) => asString(item.offerId, '').trim())
        .filter(Boolean)
    ));
    if (ids.length === 0) {
      return {};
    }
    const rawWeights = (payload?.offerWeightsById && typeof payload.offerWeightsById === 'object')
      ? payload.offerWeightsById
      : {};
    const next: Record<string, number> = {};
    let total = 0;
    ids.forEach((offerId) => {
      const raw = asNumber((rawWeights as Record<string, unknown>)[offerId], 1);
      const safe = Number.isFinite(raw) && raw > 0 ? raw : 1;
      next[offerId] = safe;
      total += safe;
    });
    const safeTotal = total > 0 ? total : ids.length;
    ids.forEach((offerId) => {
      next[offerId] = Number((next[offerId] / safeTotal).toFixed(6));
    });
    return next;
  })();

  // For mixed-TF algofund-ts systems, real backtest is needed to correctly cover all timeframes.
  // However, we only allow it in two cases:
  //   1. Explicit admin request (preferRealBacktest: true) — admin UI button
  //   2. Background snapshot refresh (isBatchRefresh: true) — server-side only
  // Regular admin/client previews use the pre-saved snapshot to avoid exchange API hammering.
  const uniqueSelectedIntervals = Array.from(new Set(
    selectedOffers
      .map((item) => asString((item as Record<string, unknown>).familyInterval, '') || asString((item as any)?.preset?.params?.interval, ''))
      .filter(Boolean)
  ));
  const hasMixedIntervals = kind === 'algofund-ts' && uniqueSelectedIntervals.length > 1;
  const canTryRealBacktest = payload?.preferRealBacktest === true || (hasMixedIntervals && payload?.isBatchRefresh === true);
  const requestedDateFromRaw = asString(payload?.dateFrom, '').trim();
  const requestedDateToRaw = asString(payload?.dateTo, '').trim();
  const clampedRequestDates = (requestedDateFromRaw || requestedDateToRaw)
    ? clampRequestedBacktestDates(requestedDateFromRaw, requestedDateToRaw, sweep)
    : null;
  const requestedDateFrom = clampedRequestDates?.dateFrom || requestedDateFromRaw;
  const requestedDateTo = clampedRequestDates?.dateTo || requestedDateToRaw;
  const strategyIds = Array.from(new Set(
    selectedOffers
      .map((item) => Number(item.strategyId || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));
  const rerunStrategyIdsFromOffers = resolveOfferStoreStrategyIds(offerIds, offerStoreById);
  const rerunStrategyIds = rerunStrategyIdsFromOffers.length > 0
    ? rerunStrategyIdsFromOffers
    : strategyIds;
  const rerunBacktestMode = resolveAdminPreviewBacktestMode(rerunStrategyIds);

  // Risk multiplier applied post-hoc to real backtest result.
  // Exponential: risk=0 → ~0.18x, risk=5 → 1.0x, risk=10 → ~5.5x.
  const riskScaleMaxPercent = clampNumber(asNumber(payload?.riskScaleMaxPercent, 100), 0, 400);
  const maxOpenPositions = Math.max(0, Math.floor(asNumber(payload?.maxOpenPositions, 0)));
  const lotPercentRequested = Math.max(0, asNumber(payload?.lotPercentOverride, 0));
  // Lot resolution priority: explicit payload → snapshot → master_cards.metadata_json → 100% (legacy default).
  const cardLotConfig = await getCardConfigBySystemName(asString(payload?.systemName, '').trim());
  const portfolioCircuitBreakerForEngine =
    resolveSnapshotPortfolioCircuitBreaker(
      tsSavedSnapshotForPreview,
      payload?.portfolioCircuitBreaker,
      cardLotConfig.portfolioCircuitBreaker,
    )
    ?? (cardLotConfig.portfolioCircuitBreaker && cardLotConfig.portfolioCircuitBreaker.enabled !== false
      ? cardLotConfig.portfolioCircuitBreaker
      : undefined);
  const portfolioCircuitBreakerExtras = portfolioCircuitBreakerForEngine
    ? { portfolioCircuitBreaker: portfolioCircuitBreakerForEngine }
    : {};
  const snapshotLotPercent = resolveSnapshotLotPercent(tsSavedSnapshotForPreview);
  const lotPercentEffective = lotPercentRequested > 0
    ? lotPercentRequested
    : (snapshotLotPercent > 0
      ? snapshotLotPercent
      : (cardLotConfig.lotPercent > 0 ? cardLotConfig.lotPercent : 100));
  const partialTpPct = Math.max(0, asNumber(payload?.partialTpPct, 0));
  // Admin overrides for execution-cost assumptions. Defaults align with WEEX
  // futures (taker 0.06% × 2 legs = ~0.1%, slippage 0.05%, funding 0).
  // When admin passes a finite >= 0 value it replaces the sweep config default.
  const toFiniteOrNull = (value: any): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const commissionPercentOverride = toFiniteOrNull(payload?.commissionPercent);
  const slippagePercentOverride = toFiniteOrNull(payload?.slippagePercent);
  const fundingRatePercentOverride = toFiniteOrNull(payload?.fundingRatePercent);
  const reinvestPercent = clampNumber(asNumber(payload?.reinvestPercent, 0), 0, 100);
  const reinvestShare = reinvestPercent / 100;
  const preferRealBacktest = payload?.preferRealBacktest === true;
  const rerunRiskMul = getPreviewRiskMultiplier(riskScore, riskScaleMaxPercent);
  const adminPreviewLotPercent = resolveRealEngineLotPercentOverride(
    lotPercentEffective,
    preferRealBacktest,
    rerunRiskMul,
  );
  const portfolioLotMultipliers = kind === 'algofund-ts' && rerunStrategyIds.length > 1
    ? resolveSnapshotPortfolioLotMultipliers(
      tsSavedSnapshotForPreview,
      rerunStrategyIds,
      preferRealBacktest,
      selectedOffers,
      normalizedOfferWeightsById,
      payload?.lotPercentMultiplierByStrategyId,
    )
    : undefined;
  const tradeMul = getPreviewTradeMultiplier(tradeFrequencyScore);
  // oscillationFactor: low risk + low freq → near 0 (straight smooth line);
  //                   high risk + high freq → ~2.5 (very jagged volatile curve)
  const oscillationFactor = clampNumber(
    Math.log(Math.max(0.1, rerunRiskMul)) * 0.8 + Math.log(Math.max(0.1, tradeMul)) * 0.6 + 1.0,
    0.05, 2.5
  );
  // Override period for Cloud TS: use actual cloud data window (7 days, 5m interval)
  if (isCloudSystem && kind === 'algofund-ts') {
    const cloudInterval = '5m';
    const cloudDays = 7;
    const now = new Date();
    const cloudFrom = new Date(now.getTime() - cloudDays * 24 * 3600 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    period = { dateFrom: fmt(cloudFrom), dateTo: fmt(now), interval: cloudInterval };
    periodDays = cloudDays;
    // Update periodDays on selected offers
    for (const offer of selectedOffers) {
      offer.periodDays = cloudDays;
      if (offer.preset?.params) {
        offer.preset.params.interval = cloudInterval;
      }
      (offer as Record<string, unknown>).familyInterval = cloudInterval;
    }
  }

  if (kind === 'offer' && offerIds.length === 1) {
    const reviewSnapshots = await getOfferReviewSnapshots().catch(() => ({} as Record<string, OfferReviewSnapshot>));
    const offerSnapshot = reviewSnapshots[offerIds[0]] || null;
    if (offerSnapshot) {
      const baselineMetrics = {
        ret: Number(asNumber(offerSnapshot.ret, 0).toFixed(3)),
        pf: Number(asNumber(offerSnapshot.pf, 0).toFixed(3)),
        dd: Number(asNumber(offerSnapshot.dd, 0).toFixed(3)),
        wr: 0,
        trades: Math.max(0, Math.floor(asNumber(offerSnapshot.trades, 0))),
      };
      // Compute relative risk/trade multipliers so that reopening with the same
      // slider settings that were used when the snapshot was saved yields mul=1.0
      // (no double-scaling).  This mirrors the TS snapshot logic.
      const snapshotRiskScore = clampNumber(asNumber(offerSnapshot.riskScore, 5), 0, 10);
      const snapshotTradeFrequencyScore = clampNumber(asNumber(offerSnapshot.tradeFrequencyScore, 5), 0, 10);
      const snapshotRiskScaleMaxPercent = clampNumber(asNumber(offerSnapshot.riskScaleMaxPercent, 100), 0, 400);
      const snapshotRiskMul = getPreviewRiskMultiplier(snapshotRiskScore, snapshotRiskScaleMaxPercent);
      const snapshotTradeMul = getPreviewTradeMultiplier(snapshotTradeFrequencyScore);
      const relativeRiskMul = rerunRiskMul / Math.max(0.01, snapshotRiskMul);
      const relativeTradeMul = tradeMul / Math.max(0.01, snapshotTradeMul);
      const offerSnapshotSpanMs = Math.max(1, asNumber(offerSnapshot.periodDays, 365)) * 24 * 3600 * 1000;
      const offerSnapshotStartMs = Date.now() - offerSnapshotSpanMs;
      const baseEquity = (Array.isArray(offerSnapshot.equityPoints) ? offerSnapshot.equityPoints : [])
        .map((value, index, arr) => ({
          time: arr.length <= 1 ? Date.now() : Math.round(offerSnapshotStartMs + (index / (arr.length - 1)) * offerSnapshotSpanMs),
          equity: Number(asNumber(value, 0).toFixed(4)),
        }))
        .filter((item) => Number.isFinite(item.equity));
      const resolvedBaseEquity = baseEquity.length > 1
        ? baseEquity
        : [
          { time: Math.round(Date.now() - offerSnapshotSpanMs), equity: initialBalance },
          { time: Date.now(), equity: Number((initialBalance * (1 + baselineMetrics.ret / 100)).toFixed(4)) },
        ];
      const resolvedInitialBalance = Math.max(100, Math.floor(asNumber(offerSnapshot.initialBalance, initialBalance)));
      const adjustedMetricsSnapshot = adjustPreviewMetrics(baselineMetrics, relativeRiskMul, relativeTradeMul);
      const baseStartEquity = asNumber(resolvedBaseEquity[0]?.equity, resolvedInitialBalance);
      const baseEndEquity = asNumber(resolvedBaseEquity[resolvedBaseEquity.length - 1]?.equity, resolvedInitialBalance);
      const scaledEndEquityByRisk = initialBalance + (baseEndEquity - baseStartEquity) * relativeRiskMul;
      const freqShapeFactor = clampNumber(1 + Math.log(Math.max(0.2, relativeTradeMul)) * 0.45, 0.45, 1.8);
      const waveAmplitude = Math.abs(scaledEndEquityByRisk - initialBalance)
        * 0.08
        * Math.abs(relativeTradeMul - 1)
        * clampNumber(relativeTradeMul, 0.6, 1.9);

      let normalizedSnapshotEquity = resolvedBaseEquity.map((point, index, arr) => {
        const progress = arr.length > 1 ? (index / Math.max(1, arr.length - 1)) : 1;
        const scaledRaw = scaleEquityByRiskWithReinvest(
          asNumber(point.equity, resolvedInitialBalance),
          resolvedInitialBalance,
          initialBalance,
          relativeRiskMul,
          reinvestShare,
        );
        const trendLine = initialBalance + (scaledEndEquityByRisk - initialBalance) * progress;
        const deviation = scaledRaw - trendLine;
        const wave = Math.sin(progress * Math.PI * 2 * (1 + relativeTradeMul * 0.8)) * waveAmplitude * (0.25 + 0.75 * progress);
        return {
          time: point.time,
          equity: Number((trendLine + deviation * freqShapeFactor + wave).toFixed(4)),
        };
      });

      // Align final equity with adjusted ret metric so chart/PnL/tags are consistent.
      const targetFinalEquity = Number((initialBalance * (1 + adjustedMetricsSnapshot.ret / 100)).toFixed(4));
      const currentFinalEquity = asNumber(normalizedSnapshotEquity[normalizedSnapshotEquity.length - 1]?.equity, initialBalance);
      const currentPnl = currentFinalEquity - initialBalance;
      const targetPnl = targetFinalEquity - initialBalance;
      if (Math.abs(currentPnl) > 1e-6) {
        const pnlScale = targetPnl / currentPnl;
        normalizedSnapshotEquity = normalizedSnapshotEquity.map((point) => ({
          time: point.time,
          equity: scaleEquityByRiskWithReinvest(
            asNumber(point.equity, initialBalance),
            initialBalance,
            initialBalance,
            pnlScale,
            reinvestShare,
          ),
        }));
      }

      const snapshotCurves = buildDerivedPreviewCurves(normalizedSnapshotEquity, initialBalance, riskScore);
      const firstOffer = selectedOffers[0];
      const snapshotSelectedOffer = {
        ...firstOffer,
        metricsSource: 'offer_snapshot' as const,
        metrics: adjustedMetricsSnapshot,
        tradesPerDay: Number((adjustedMetricsSnapshot.trades / Math.max(1, firstOffer.periodDays)).toFixed(3)),
        equityPoints: normalizedSnapshotEquity.map((point) => Number(asNumber(point.equity, 0).toFixed(4))),
      };
      return {
        kind,
        controls: {
          riskScore,
          tradeFrequencyScore,
          riskLevel,
          tradeFrequencyLevel,
          riskScaleMaxPercent,
          reinvestPercent,
          maxOpenPositions,
        },
        period,
        sweepApiKeyName: asString((sweep as Record<string, unknown>)?.apiKeyName || ((sweep as Record<string, unknown>)?.config as Record<string, unknown>)?.apiKeyName, ''),
        selectedOffers: [snapshotSelectedOffer],
        preview: {
          source: 'admin_saved_offer_snapshot_exact',
          summary: {
            finalEquity: Number(asNumber(normalizedSnapshotEquity[normalizedSnapshotEquity.length - 1]?.equity, initialBalance).toFixed(4)),
            totalReturnPercent: Number(adjustedMetricsSnapshot.ret.toFixed(3)),
            maxDrawdownPercent: Number(adjustedMetricsSnapshot.dd.toFixed(3)),
            profitFactor: Number(adjustedMetricsSnapshot.pf.toFixed(3)),
            winRatePercent: Number(adjustedMetricsSnapshot.wr.toFixed(3)),
            tradesCount: Math.max(0, Math.floor(adjustedMetricsSnapshot.trades)),
            unrealizedPnl: snapshotCurves.finalUnrealizedPnl,
            marginLoadPercent: snapshotCurves.maxMarginLoadPercent,
          },
          equity: normalizedSnapshotEquity,
          curves: {
            pnl: snapshotCurves.pnl,
            drawdownPercent: snapshotCurves.drawdownPercent,
            marginLoadPercent: snapshotCurves.marginLoadPercent,
          },
          trades: [],
          strictPresetMode: true,
          riskApproximated: rerunRiskMul !== 1,
        },
      };
    }
  }

  let rerunFailureReason = '';
  const rerunWindowOverrides = {
    bars: Math.max(0, Math.floor(asNumber(payload?.backtestBars, 0))) || undefined,
    warmupBars: Math.max(0, Math.floor(asNumber(payload?.warmupBars, 0))) || undefined,
  };
  if (canTryRealBacktest && rerunStrategyIds.length > 0 && !tsSavedSnapshotForPreview) {
    const sweepConfigAny = (sweep?.config || {}) as Record<string, unknown>;
    const resolvedByStrategiesApiKey = await resolveApiKeyNameForStrategyIds(rerunStrategyIds, '', { strict: false });
    const preferredApiKey = asString(payload?.rerunApiKeyName, '')
      || resolvedByStrategiesApiKey
      || asString(sweep?.apiKeyName, '')
      || asString(sweepConfigAny.apiKeyName, '')
      || asString(catalog?.apiKeyName, '')
      || asString((await getAvailableApiKeyNames())[0], '');

    if (preferredApiKey) {
      try {
        // Keep TS composition fixed. Frequency is applied via preset variant selection
        // for each member (resolveOfferPresetByPreference), not by dropping members.
        await ensureExchangeClientInitialized(preferredApiKey);

        const rerunWindow = resolveAdminPreviewRerunWindow(
          sweep,
          tsSavedSnapshotForPreview,
          requestedDateFrom
            || (kind === 'offer' ? singleOfferStoreDateFrom : '')
            || asString(sweep?.config?.dateFrom, '').slice(0, 10),
          requestedDateTo
            || (kind === 'offer' ? singleOfferStoreDateTo : '')
            || '',
          rerunWindowOverrides,
        );

        const result = await runBacktest({
          apiKeyName: preferredApiKey,
          mode: rerunBacktestMode,
          strategyId: rerunBacktestMode === 'single' ? rerunStrategyIds[0] : undefined,
          strategyIds: rerunBacktestMode === 'portfolio' ? rerunStrategyIds : undefined,
          bars: rerunWindow.bars,
          warmupBars: rerunWindow.warmupBars,
          skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
          initialBalance,
          commissionPercent: commissionPercentOverride !== null
            ? commissionPercentOverride
            : asNumber(sweep?.config?.commissionPercent, 0.1),
          slippagePercent: slippagePercentOverride !== null
            ? slippagePercentOverride
            : asNumber(sweep?.config?.slippagePercent, 0.05),
          fundingRatePercent: fundingRatePercentOverride !== null
            ? fundingRatePercentOverride
            : asNumber(sweep?.config?.fundingRatePercent, 0),
          dateFrom: rerunWindow.dateFrom,
          ...(rerunWindow.dateTo ? { dateTo: rerunWindow.dateTo } : {}),
          ...(maxOpenPositions > 0 ? { maxOpenPositions } : {}),
          ...(partialTpPct > 0 ? { partialTpPct } : {}),
          ...(payload?.enablePairLock !== undefined
            ? { enablePairLock: payload.enablePairLock }
            : { enablePairLock: true }),
          ...(payload?.pairLockSeed !== undefined ? { pairLockSeed: payload.pairLockSeed } : {}),
          maxDepositOverride: resolveAdminPreviewMaxDepositOverride(reinvestPercent, initialBalance),
          lotPercentOverride: adminPreviewLotPercent,
          reinvestPercentOverride: reinvestPercent,
          ...(portfolioLotMultipliers && Object.keys(portfolioLotMultipliers).length > 0
            ? { lotPercentMultiplierByStrategyId: portfolioLotMultipliers }
            : {}),
          ...tsPreviewMechanicsExtras,
          ...portfolioCircuitBreakerExtras,
        });

        const summaryAny = result.summary as Record<string, unknown>;
        const rerunMetrics = summarizeRealRerunEquityCurve(result.equityCurve, initialBalance);
        const scaledSummary = {
          ...result.summary,
          finalEquity: rerunMetrics.finalEquity,
          totalReturnPercent: rerunMetrics.totalReturnPercent,
          maxDrawdownPercent: rerunMetrics.maxDrawdownPercent,
          ...(summaryAny.netProfit != null
            ? { netProfit: Number((rerunMetrics.finalEquity - initialBalance).toFixed(4)) }
            : {}),
          marginLoadPercent: 0,
          unrealizedPnl: rerunMetrics.unrealizedPnl,
        };

        const rerunDateFrom = requestedDateFrom
          || (kind === 'offer' ? singleOfferStoreDateFrom : '')
          || (kind === 'algofund-ts' ? buildPreviewDatesFromPeriodDays(periodDays, requestedDateFrom, requestedDateTo).dateFrom : '')
          || asString(sweep?.config?.dateFrom, '');
        const rerunDateTo = requestedDateTo
          || (kind === 'offer' ? singleOfferStoreDateTo : '')
          || (kind === 'algofund-ts' ? buildPreviewDatesFromPeriodDays(periodDays, requestedDateFrom, requestedDateTo).dateTo : '')
          || asString(sweep?.config?.dateTo, '');
        const actualFromYmd = msToYmd(Number(summaryAny.actualDataStartMs));
        const actualToYmd = msToYmd(Number(summaryAny.actualDataEndMs));
        const rerunPeriodInfo: PeriodInfo & {
          requestedDateFrom?: string | null;
          requestedDateTo?: string | null;
          actualDateFrom?: string | null;
          actualDateTo?: string | null;
          clampNotes?: string[];
        } = {
          dateFrom: rerunDateFrom || null,
          dateTo: rerunDateTo || null,
          interval: asString(period?.interval, asString(sweep?.config?.interval, '4h')),
          requestedDateFrom: clampedRequestDates?.requestedDateFrom || requestedDateFromRaw || null,
          requestedDateTo: clampedRequestDates?.requestedDateTo || requestedDateToRaw || null,
          actualDateFrom: actualFromYmd,
          actualDateTo: actualToYmd,
          clampNotes: clampedRequestDates?.clampNotes || [],
        };

        return {
          kind,
          controls: {
            riskScore,
            tradeFrequencyScore,
            riskLevel,
            tradeFrequencyLevel,
            riskScaleMaxPercent,
            reinvestPercent,
          },
          period: rerunPeriodInfo,
          sweepApiKeyName: asString((sweep as Record<string, unknown>)?.apiKeyName || ((sweep as Record<string, unknown>)?.config as Record<string, unknown>)?.apiKeyName, ''),
          selectedOffers,
          preview: {
            source: 'admin_sweep_rerun',
            summary: scaledSummary,
            equity: rerunMetrics.equity || sanitizeEquityCurveForMetrics(result.equityCurve, initialBalance),
            curves: {
              pnl: rerunMetrics.curves.pnl,
              drawdownPercent: rerunMetrics.curves.drawdownPercent,
              marginLoadPercent: rerunMetrics.curves.marginLoadPercent,
              unrealizedPnl: (result.equityCurve || [])
                .filter((point) => Number.isFinite(Number(point.unrealizedPnl)))
                .map((point) => ({
                  time: asNumber(point.time, 0),
                  value: Number(asNumber(point.unrealizedPnl, 0).toFixed(4)),
                })),
            },
            trades: result.trades,
            strictPresetMode: false,
            riskApproximated: false,
            reinvestAppliedInEngine: reinvestPercent > 0,
            portfolioLotWeighted: Boolean(portfolioLotMultipliers && Object.keys(portfolioLotMultipliers).length > 0),
          },
          rerun: {
            requested: true,
            executed: true,
            apiKeyName: preferredApiKey,
            strategyIds: rerunStrategyIds,
            tsMembersCount: kind === 'algofund-ts' ? selectedOffers.length : 1,
            riskMul: rerunRiskMul,
            riskScaleMaxPercent,
            freqLevel: tradeFrequencyLevel,
          },
        };
      } catch (error) {
        rerunFailureReason = asString((error as Error).message, 'Unknown rerun error');
        logger.warn(`Admin sweep rerun fallback to preset mode: ${rerunFailureReason}`);
      }
    }
  }

  // For TS previews always prefer saved snapshot when available:
  // this keeps storefront card and first-open modal metrics aligned.
  if (kind === 'offer' && selectedOffers.length === 0) {
      const fallbackOfferId = asString(offerIds[0], '').trim();
      if (fallbackOfferId) {
        const offerStore = await getOfferStoreAdminState().catch(() => null);
        const fallbackRow = (offerStore?.offers || []).find((item) => asString(item?.offerId, '').trim() === fallbackOfferId) || null;
        if (fallbackRow) {
          const baseTrades = Math.max(1, Math.floor(asNumber(fallbackRow.trades, 0)));
          const trades = Math.max(1, Math.floor(baseTrades * tradeMul));
          const ret = asNumber(fallbackRow.ret, 0) * rerunRiskMul;
          const dd = asNumber(fallbackRow.dd, 0) * Math.max(0.7, rerunRiskMul);
          const pf = Math.max(0.2, asNumber(fallbackRow.pf, 1) * (0.9 + rerunRiskMul * 0.1));
          const fallbackStrategyId = Number(fallbackRow.strategyId || parseStrategyIdFromOfferId(fallbackOfferId) || 0);

          selectedOffers = [
            {
              offerId: fallbackOfferId,
              titleRu: asString(fallbackRow.titleRu, fallbackOfferId),
              mode: fallbackRow.mode === 'synth' ? 'synth' : 'mono',
              market: asString(fallbackRow.market, ''),
              familyType: '',
              familyMode: fallbackRow.mode === 'synth' ? 'synthetic' : 'mono',
              familyInterval: asString(sweep?.config?.interval, ''),
              strategyId: fallbackStrategyId,
              strategyName: asString(fallbackRow.titleRu, fallbackOfferId),
              score: Number(asNumber(fallbackRow.score, 0).toFixed(3)),
              metrics: {
                ret: Number(ret.toFixed(3)),
                pf: Number(pf.toFixed(3)),
                dd: Number(dd.toFixed(3)),
                wr: 0,
                trades,
              },
              tradesPerDay: Number((trades / Math.max(1, periodDays)).toFixed(3)),
              periodDays,
              equityPoints: toPresetOnlyEquity(initialBalance, ret).map((point) => Number(asNumber(point.equity, 0).toFixed(4))),
              preset: {
                strategyId: fallbackStrategyId,
                strategyName: asString(fallbackRow.titleRu, fallbackOfferId),
                score: Number(asNumber(fallbackRow.score, 0).toFixed(3)),
                metrics: {
                  ret: Number(ret.toFixed(3)),
                  pf: Number(pf.toFixed(3)),
                  dd: Number(dd.toFixed(3)),
                  wr: 0,
                  trades,
                },
                params: {
                  interval: asString(sweep?.config?.interval, '4h'),
                  length: 24,
                  takeProfitPercent: 5,
                  detectionSource: 'close',
                  zscoreEntry: 2,
                  zscoreExit: 0.5,
                  zscoreStop: 3.5,
                },
              },
            },
          ];
        }
      }
    }
  if (kind === 'algofund-ts') {
      const snapshotMap = await getTsBacktestSnapshots();
      const requestedSetKey = normalizeTsSnapshotMapKey(asString(payload?.setKey, ''));
      const normalizeOfferIds = (raw: unknown): string[] => Array.from(new Set(
        (Array.isArray(raw) ? raw : [])
          .map((item) => asString(item, '').trim())
          .filter(Boolean)
      ));
      const requestedOfferIds = normalizeOfferIds(offerIds);

      let snapshot = tsSavedSnapshotForPreview || (requestedSetKey ? (snapshotMap[requestedSetKey] || null) : null);
      if (!snapshot && !requestedSetKey && requestedOfferIds.length > 0) {
        const requestedSorted = Array.from(new Set(requestedOfferIds)).sort();
        snapshot = Object.values(snapshotMap).find((item) => {
          const snapshotOfferIds = normalizeOfferIds(item.offerIds).sort();
          if (snapshotOfferIds.length === 0) {
            return false;
          }
          if (snapshotOfferIds.length !== requestedSorted.length) {
            return false;
          }
          return requestedSorted.every((offerId, index) => snapshotOfferIds[index] === offerId);
        }) || null;
      }

      if (!snapshot) {
        const legacySnapshot = await getTsBacktestSnapshot();
        if (legacySnapshot) {
          const legacySetKey = normalizeTsSnapshotMapKey(asString(legacySnapshot.setKey, ''));
          const legacyOfferIds = normalizeOfferIds(legacySnapshot.offerIds).sort();
          const requestedSorted = Array.from(new Set(requestedOfferIds)).sort();
          if (
            (requestedSetKey && legacySetKey === requestedSetKey)
            || (
              !requestedSetKey
              && requestedSorted.length > 0
              && legacyOfferIds.length === requestedSorted.length
              && requestedSorted.every((offerId, index) => legacyOfferIds[index] === offerId)
            )
          ) {
            snapshot = legacySnapshot;
          }
        }
      }

      if (snapshot) {
        const snapshotOfferIds = normalizeOfferIds(snapshot.offerIds);
        if (snapshotOfferIds.length > 0) {
          const offerStore = await getOfferStoreAdminState();
          const offerStoreById = new Map(
            (offerStore.offers || []).map((item) => [asString(item.offerId, '').trim(), item])
          );
          const strategyIds = Array.from(new Set(snapshotOfferIds
            .map((offerId) => Number(offerStoreById.get(offerId)?.strategyId || parseStrategyIdFromOfferId(offerId)))
            .filter((value) => Number.isFinite(value) && value > 0)));
          const strategyNameById = await getStrategyNameMapByIds(strategyIds);

          const snapshotSelectedOffers = snapshotOfferIds.map((offerId, index) => {
            const known = offerStoreById.get(offerId);
            const strategyId = Number(known?.strategyId || parseStrategyIdFromOfferId(offerId));
            const strategyNameFromDb = strategyId > 0 ? asString(strategyNameById.get(strategyId), '') : '';
            const titleFallback = strategyNameFromDb || `Strategy #${strategyId || (index + 1)}`;
            const hasOfferMetrics = Boolean(known);
            return {
              offerId,
              titleRu: asString(known?.titleRu, titleFallback),
              mode: known?.mode === 'synth' ? 'synth' as const : 'mono' as const,
              market: asString(known?.market, ''),
              strategyId,
              strategyName: asString(strategyNameFromDb, asString(known?.titleRu, titleFallback)),
              score: Number(asNumber(known?.score, 0).toFixed(3)),
              metrics: {
                ret: Number(asNumber(known?.ret, 0).toFixed(3)),
                pf: Number(asNumber(known?.pf, 0).toFixed(3)),
                dd: Number(asNumber(known?.dd, 0).toFixed(3)),
                wr: 0,
                trades: Math.max(0, Math.floor(asNumber(known?.trades, 0))),
              },
              metricsSource: hasOfferMetrics ? 'offer_store' : 'snapshot_only',
              tradesPerDay: Number(asNumber(known?.tradesPerDay, 0).toFixed(3)),
              periodDays: Math.max(1, Math.floor(asNumber(known?.periodDays, snapshot.periodDays || periodDays))),
              equityPoints: Array.isArray(known?.equityPoints)
                ? known.equityPoints.map((value) => Number(asNumber(value, 0).toFixed(4)))
                : [],
            };
          });

          const snapshotSpanMs = Math.max(1, asNumber(snapshot.periodDays, 365)) * 24 * 3600 * 1000;
          const snapshotStartMs = Date.now() - snapshotSpanMs;
          const snapshotEquity = (Array.isArray(snapshot.equityPoints) ? snapshot.equityPoints : [])
            .map((value, index, arr) => ({
              time: arr.length <= 1 ? Date.now() : Math.round(snapshotStartMs + (index / (arr.length - 1)) * snapshotSpanMs),
              equity: Number(asNumber(value, 0).toFixed(4)),
            }))
            .filter((item) => Number.isFinite(item.equity));
          const snapshotPeriodDaysForDates = Math.max(1, Math.floor(asNumber(snapshot.periodDays, periodDays)));
          const snapshotRerunDates = resolveSnapshotRerunDates(snapshot, sweep, requestedDateFrom, requestedDateTo);
          const snapshotDateFromResolved = snapshotRerunDates.dateFrom;
          const snapshotDateToResolved = snapshotRerunDates.dateTo;
          const snapshotPeriodInfo: PeriodInfo = buildPeriodInfoFromDates(
            snapshotDateFromResolved,
            snapshotDateToResolved,
            asString(period?.interval, asString(sweep?.config?.interval, '4h')),
          );

          const selectedByOfferId = new Map(
            selectedOffers.map((item) => [String(item.offerId || '').trim(), item] as const),
          );
          const snapshotRerunOffers = snapshotOfferIds
            .map((offerId) => selectedByOfferId.get(offerId) || null)
            .filter((item): item is typeof selectedOffers[number] => Boolean(item));
          const snapshotStrategyIdsFromOffers = resolveOfferStoreStrategyIds(snapshotOfferIds, offerStoreById);
          const snapshotStrategyIds = snapshotStrategyIdsFromOffers.length > 0
            ? snapshotStrategyIdsFromOffers
            : Array.from(new Set(
              (snapshotRerunOffers.length > 0 ? snapshotRerunOffers : snapshotSelectedOffers)
                .map((item) => Number(item.strategyId || 0))
                .filter((value) => Number.isFinite(value) && value > 0),
            ));
          const snapshotBacktestMode = resolveAdminPreviewBacktestMode(snapshotStrategyIds);
          const snapshotOffersForResponse = snapshotRerunOffers.length > 0
            ? snapshotRerunOffers
            : snapshotSelectedOffers;

          let snapshotRerunFailureReason = '';
          if (canTryRealBacktest && snapshotStrategyIds.length === 0) {
            snapshotRerunFailureReason = 'Real rerun пропущен: для офферов снапшота не нашлись strategy_id (TS-снапшот без привязки к стратегиям). Откройте sweep заново и пересохраните карточку.';
            logger.warn(`Snapshot TS rerun skipped: ${snapshotRerunFailureReason}`);
          }
          if (canTryRealBacktest && snapshotStrategyIds.length > 0) {
            const sweepConfigAny = (sweep?.config || {}) as Record<string, unknown>;
            const resolvedByStrategiesApiKey = await resolveApiKeyNameForStrategyIds(snapshotStrategyIds, '', { strict: false });
            const preferredApiKey = asString(payload?.rerunApiKeyName, '')
              || resolvedByStrategiesApiKey
              || asString(snapshot.apiKeyName, '')
              || asString((sweep as Record<string, unknown>)?.apiKeyName, '')
              || asString(sweepConfigAny.apiKeyName, '')
              || asString(catalog?.apiKeyName, '')
              || asString((await getAvailableApiKeyNames())[0], '');

            if (!preferredApiKey) {
              snapshotRerunFailureReason = 'Real rerun пропущен: не нашёлся API key для запуска бэктеста. Выберите ключ в селекте "API key для real rerun".';
              logger.warn(`Snapshot TS rerun skipped: ${snapshotRerunFailureReason}`);
            }
            if (preferredApiKey) {
              try {
                // Ensure the exchange client is initialized so getMarketData can fetch candles from the exchange
                await ensureExchangeClientInitialized(preferredApiKey);

                const snapshotSettingsRaw = (snapshot.backtestSettings && typeof snapshot.backtestSettings === 'object')
                  ? (snapshot.backtestSettings as Record<string, unknown>)
                  : {};
                const snapshotTradeFrequencyScore = clampNumber(asNumber(snapshotSettingsRaw.tradeFrequencyScore, 5), 0, 10);
                const snapshotTradeMul = getPreviewTradeMultiplier(snapshotTradeFrequencyScore);
                const relativeTradeMul = tradeMul / Math.max(0.01, snapshotTradeMul);
                const snapshotStoredLot = resolveSnapshotLotPercent(snapshot);
                const snapshotLotEffective = lotPercentRequested > 0
                  ? lotPercentRequested
                  : (snapshotStoredLot > 0 ? snapshotStoredLot : lotPercentEffective);
                const snapshotMaxOp = Math.max(0, Math.floor(asNumber(snapshotSettingsRaw.maxOpenPositions, 0)));
                const engineMaxOpenPositions = maxOpenPositions > 0 ? maxOpenPositions : snapshotMaxOp;
                const storeStrategyKey = snapshotStrategyIds.join(',');
                const freqStrategyKey = snapshotRerunOffers
                  .map((item) => Number(item.strategyId || 0))
                  .join(',');
                const freqVariantsApplied = storeStrategyKey !== freqStrategyKey;
                const snapshotPortfolioLotMultipliers = snapshotStrategyIds.length > 1
                  ? resolveSnapshotPortfolioLotMultipliers(
                    snapshot,
                    snapshotStrategyIds,
                    preferRealBacktest,
                    snapshotRerunOffers,
                    normalizedOfferWeightsById,
                    payload?.lotPercentMultiplierByStrategyId,
                  )
                  : {};

                const snapshotRerunWindow = resolveAdminPreviewRerunWindow(
                  sweep,
                  snapshot,
                  snapshotDateFromResolved || asString(sweep?.config?.dateFrom, '').slice(0, 10),
                  snapshotDateToResolved || requestedDateTo || '',
                  rerunWindowOverrides,
                );

                const primaryRequest: Parameters<typeof runBacktest>[0] = {
                  apiKeyName: preferredApiKey,
                  mode: snapshotBacktestMode,
                  strategyId: snapshotBacktestMode === 'single' ? snapshotStrategyIds[0] : undefined,
                  strategyIds: snapshotBacktestMode === 'portfolio' ? snapshotStrategyIds : undefined,
                  bars: snapshotRerunWindow.bars,
                  warmupBars: snapshotRerunWindow.warmupBars,
                  skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
                  initialBalance,
                  // Admin overrides win over sweep config defaults so sliders
                  // for Комса/Слиппедж/Funding actually affect the snapshot rerun.
                  commissionPercent: commissionPercentOverride !== null
                    ? commissionPercentOverride
                    : asNumber(sweep?.config?.commissionPercent, 0.1),
                  slippagePercent: slippagePercentOverride !== null
                    ? slippagePercentOverride
                    : asNumber(sweep?.config?.slippagePercent, 0.05),
                  fundingRatePercent: fundingRatePercentOverride !== null
                    ? fundingRatePercentOverride
                    : asNumber(sweep?.config?.fundingRatePercent, 0),
                  dateFrom: snapshotRerunWindow.dateFrom,
                  ...(snapshotRerunWindow.dateTo ? { dateTo: snapshotRerunWindow.dateTo } : {}),
                  ...(engineMaxOpenPositions > 0 ? { maxOpenPositions: engineMaxOpenPositions } : {}),
                  ...(partialTpPct > 0 ? { partialTpPct } : {}),
                  ...(payload?.enablePairLock !== undefined
                    ? { enablePairLock: payload.enablePairLock }
                    : { enablePairLock: snapshotSettingsRaw.enablePairLock !== false }),
                  ...(payload?.pairLockSeed !== undefined ? { pairLockSeed: payload.pairLockSeed } : {}),
                  maxDepositOverride: resolveAdminPreviewMaxDepositOverride(reinvestPercent, initialBalance),
                  lotPercentOverride: resolveRealEngineLotPercentOverride(
                    preferRealBacktest
                      ? snapshotLotEffective
                      : snapshotLotEffective * relativeTradeMul,
                    preferRealBacktest,
                    rerunRiskMul,
                  ),
                  reinvestPercentOverride: reinvestPercent,
                  ...(Object.keys(snapshotPortfolioLotMultipliers).length > 0
                    ? { lotPercentMultiplierByStrategyId: snapshotPortfolioLotMultipliers }
                    : {}),
                  ...(payload?.autoLotByChannelWidth === true ? { autoLotByChannelWidth: true } : {}),
                  ...tsPreviewMechanicsExtras,
                  ...portfolioCircuitBreakerExtras,
                };

                let result;
                let rerunRelaxedDateRange = false;
                try {
                  result = await runBacktest(primaryRequest);
                } catch (primaryError) {
                  const primaryMessage = asString((primaryError as Error).message, '');
                  const canRelaxDateRange = /No executable candles after warmup|No runnable strategies in selected range/i.test(primaryMessage);
                  if (!canRelaxDateRange) {
                    throw primaryError;
                  }

                  result = await runBacktest({
                    ...primaryRequest,
                    // Keep snapshot card window; relax only warmup if candles are sparse.
                    dateFrom: primaryRequest.dateFrom,
                    dateTo: primaryRequest.dateTo,
                    warmupBars: Math.max(50, Math.min(180, asNumber(sweep?.config?.warmupBars, 400))),
                  });
                  rerunRelaxedDateRange = true;
                }

                const summaryAny = result.summary as Record<string, unknown>;
                const adjustedTradesCount = freqVariantsApplied
                  ? Number(result.summary.tradesCount || 0)
                  : Math.max(1, Math.round(Number(result.summary.tradesCount || 0) * relativeTradeMul));
                const rerunMetrics = summarizeRealRerunEquityCurve(result.equityCurve, initialBalance);
                const scaledSummary = {
                  ...result.summary,
                  finalEquity: rerunMetrics.finalEquity,
                  totalReturnPercent: rerunMetrics.totalReturnPercent,
                  maxDrawdownPercent: rerunMetrics.maxDrawdownPercent,
                  tradesCount: adjustedTradesCount,
                  ...(summaryAny.netProfit != null
                    ? { netProfit: Number((rerunMetrics.finalEquity - initialBalance).toFixed(4)) }
                    : {}),
                  marginLoadPercent: 0,
                  unrealizedPnl: rerunMetrics.unrealizedPnl,
                };

                const snapshotRunSummaryAny = result.summary as Record<string, unknown>;
                const enrichedSnapshotPeriod = {
                  ...snapshotPeriodInfo,
                  requestedDateFrom: clampedRequestDates?.requestedDateFrom || requestedDateFromRaw || null,
                  requestedDateTo: clampedRequestDates?.requestedDateTo || requestedDateToRaw || null,
                  actualDateFrom: msToYmd(Number(snapshotRunSummaryAny.actualDataStartMs)),
                  actualDateTo: msToYmd(Number(snapshotRunSummaryAny.actualDataEndMs)),
                  clampNotes: clampedRequestDates?.clampNotes || [],
                };

                return {
                  kind,
                  publishMeta: {
                    offerIds: snapshotOfferIds,
                    setKey: asString(snapshot.setKey, requestedSetKey),
                    membersCount: snapshotOfferIds.length,
                    systemName: asString(snapshot.systemName, ''),
                  },
                  controls: {
                    riskScore,
                    tradeFrequencyScore,
                    riskLevel,
                    tradeFrequencyLevel,
                    riskScaleMaxPercent,
                    reinvestPercent,
                    maxOpenPositions,
                  },
                  period: enrichedSnapshotPeriod,
                  sweepApiKeyName: asString(snapshot.apiKeyName, ''),
                  selectedOffers: snapshotOffersForResponse,
                  preview: {
                    source: 'admin_saved_ts_snapshot_rerun',
                    summary: scaledSummary,
                    equity: rerunMetrics.equity || sanitizeEquityCurveForMetrics(result.equityCurve, initialBalance),
                    curves: {
                      pnl: rerunMetrics.curves.pnl,
                      drawdownPercent: rerunMetrics.curves.drawdownPercent,
                      marginLoadPercent: rerunMetrics.curves.marginLoadPercent,
                    },
                    trades: result.trades,
                    strictPresetMode: false,
                    riskApproximated: false,
                    reinvestAppliedInEngine: reinvestPercent > 0,
                    portfolioLotWeighted: Object.keys(snapshotPortfolioLotMultipliers).length > 0,
                  },
                  rerun: {
                    requested: true,
                    executed: true,
                    apiKeyName: preferredApiKey,
                    strategyIds: snapshotStrategyIds,
                    tsMembersCount: snapshotOfferIds.length,
                    riskMul: rerunRiskMul,
                    tradeMul: relativeTradeMul,
                    freqVariantsApplied,
                    riskScaleMaxPercent,
                    freqLevel: tradeFrequencyLevel,
                    ...(snapshotRerunDates.usedFullSweepDepth ? { fullSweepDepth: true } : {}),
                    ...(rerunRelaxedDateRange ? { note: 'date_range_relaxed_for_snapshot_rerun' } : {}),
                  },
                };
              } catch (error) {
                const rawMessage = asString((error as Error).message, 'Unknown rerun error');
                const isNoCandles = /No executable candles|No runnable strategies|No candles in selected date range/i.test(rawMessage);
                snapshotRerunFailureReason = isNoCandles
                  ? `Исторические свечи не найдены для стратегий снапшота. Запустите новый historical sweep для API ключа "${preferredApiKey}" чтобы скачать данные. (${rawMessage})`
                  : rawMessage;
                logger.warn(`Snapshot TS rerun fallback to synthetic mode: ${snapshotRerunFailureReason}`);
              }
            }
          }

          const baselineMetrics = {
            ret: Number(asNumber(snapshot.ret, 0).toFixed(3)),
            pf: Number(asNumber(snapshot.pf, 0).toFixed(3)),
            dd: Number(asNumber(snapshot.dd, 0).toFixed(3)),
            wr: 0,
            trades: Math.max(0, Math.floor(asNumber(snapshot.trades, 0))),
          };
          const snapshotBacktestSettings = (snapshot.backtestSettings && typeof snapshot.backtestSettings === 'object')
            ? (snapshot.backtestSettings as Record<string, unknown>)
            : {};
          const snapshotSavedMaxOpenPositions = Math.max(0, Math.floor(asNumber(snapshotBacktestSettings.maxOpenPositions, 0)));
          const snapshotHasExplicitOpInSavedMetrics = snapshotSavedMaxOpenPositions > 0;
          const snapshotRiskScore = clampNumber(asNumber(snapshotBacktestSettings.riskScore, 5), 0, 10);
          const snapshotTradeFrequencyScore = clampNumber(asNumber(snapshotBacktestSettings.tradeFrequencyScore, 5), 0, 10);
          const snapshotRiskScaleMaxPercent = clampNumber(asNumber(snapshotBacktestSettings.riskScaleMaxPercent, 100), 0, 400);
          const snapshotRiskMul = getPreviewRiskMultiplier(snapshotRiskScore, snapshotRiskScaleMaxPercent);
          const snapshotTradeMul = getPreviewTradeMultiplier(snapshotTradeFrequencyScore);
          const relativeRiskMul = rerunRiskMul / Math.max(0.01, snapshotRiskMul);
          const relativeTradeMul = tradeMul / Math.max(0.01, snapshotTradeMul);

          const adjustedSnapshotMetrics = adjustPreviewMetrics(baselineMetrics, relativeRiskMul, relativeTradeMul);
          // Scale metrics by OP relative to the snapshot's baked-in OP setting.
          // Natural concurrent capacity is always based on full portfolio size (all members),
          // not the saved OP — this avoids the min(1, x/tiny) = 1 degenerate case.
          const snapshotSavedOpForScaling = snapshotHasExplicitOpInSavedMetrics
            ? snapshotSavedMaxOpenPositions
            : snapshotOfferIds.length; // legacy snapshot: assume unlimited baseline
          // Natural concurrent = full portfolio * ~22% utilization (4H trend strategy empirical)
          const snapshotNaturalConcurrent = Math.max(1, snapshotOfferIds.length * 0.22);
          // When user requests LESS OP than what was baked into the snapshot → reduce metrics.
          // When user requests MORE OP (or 0 = unlimited) → the snapshot is already the ceiling,
          // but scale UP proportionally if snapshotSavedOpForScaling < snapshotOfferIds.length.
          const effectiveUserOp = maxOpenPositions > 0 ? maxOpenPositions : snapshotOfferIds.length;
          const shouldApplyOpScaling = effectiveUserOp !== snapshotSavedOpForScaling;
          // opSlotRatio: ratio of requested concurrent slots vs natural capacity.
          // For reduction: <1 → penalise return/DD/trades.
          // For expansion above saved OP: >1 → boost up to natural ceiling (capped at 1).
          const opSlotRatio = shouldApplyOpScaling
            ? Math.min(1, effectiveUserOp / snapshotNaturalConcurrent)
            : Math.min(1, snapshotSavedOpForScaling / snapshotNaturalConcurrent);
          // Baseline slot ratio (what the snapshot was computed at)
          const snapshotOpSlotRatio = Math.min(1, snapshotSavedOpForScaling / snapshotNaturalConcurrent);
          // Relative factors: if opSlotRatio == snapshotOpSlotRatio → factor = 1 (no change).
          // If opSlotRatio < snapshotOpSlotRatio → reduce. If > → expand (bounded).
          const relativeOpSlotRatio = snapshotOpSlotRatio > 0
            ? clampNumber(opSlotRatio / snapshotOpSlotRatio, 0.1, 2.5)
            : 1;
          const snapshotRetFactor = shouldApplyOpScaling ? clampNumber(0.7 + 0.3 * relativeOpSlotRatio, 0.1, 2.5) : 1;
          const snapshotDdFactor = shouldApplyOpScaling ? clampNumber(0.5 + 0.5 * relativeOpSlotRatio, 0.1, 2.5) : 1;
          // Trade count barely reduces: slots rotate → only high-contention bars are skipped
          const snapshotTradeFactor = shouldApplyOpScaling ? clampNumber(0.85 + 0.15 * relativeOpSlotRatio, 0.1, 2.0) : 1;
          const adjustedSnapshotMetricsWithOp = {
            ...adjustedSnapshotMetrics,
            ret: Number((adjustedSnapshotMetrics.ret * snapshotRetFactor).toFixed(3)),
            dd: Number((adjustedSnapshotMetrics.dd * snapshotDdFactor).toFixed(3)),
            trades: Math.max(1, Math.floor(adjustedSnapshotMetrics.trades * snapshotTradeFactor)),
          };
          const baseEquity = snapshotEquity.length > 1
            ? snapshotEquity
            : [
              { time: Math.round(Date.now() - snapshotSpanMs), equity: initialBalance },
              { time: Date.now(), equity: Number(asNumber(snapshot.finalEquity, initialBalance).toFixed(4)) },
            ];
          const baseStartEquity = asNumber(baseEquity[0]?.equity, initialBalance);
          const baseEndEquity = asNumber(baseEquity[baseEquity.length - 1]?.equity, initialBalance);
          const scaledEndEquityByRisk = initialBalance + (baseEndEquity - baseStartEquity) * relativeRiskMul;
          const freqShapeFactor = clampNumber(1 + Math.log(Math.max(0.2, relativeTradeMul)) * 0.45, 0.45, 1.8);
          const waveAmplitude = Math.abs(scaledEndEquityByRisk - initialBalance)
            * 0.08
            * Math.abs(relativeTradeMul - 1)
            * clampNumber(relativeTradeMul, 0.6, 1.9);

          let adjustedSnapshotEquity = baseEquity.map((point, index, arr) => {
            const progress = arr.length > 1 ? (index / Math.max(1, arr.length - 1)) : 1;
            const scaledRaw = scaleEquityByRiskWithReinvest(
              asNumber(point.equity, baseStartEquity),
              baseStartEquity,
              initialBalance,
              relativeRiskMul,
              reinvestShare,
            );
            const trendLine = initialBalance + (scaledEndEquityByRisk - initialBalance) * progress;
            const deviation = scaledRaw - trendLine;
            // Taper wave to 0 at progress=1 to avoid visual spike at the end of the equity chart
            const waveTaper = 1 - progress;
            const wave = Math.sin(progress * Math.PI * 2 * (1 + relativeTradeMul * 0.8)) * waveAmplitude * (0.25 + 0.75 * progress) * waveTaper;
            return {
              time: point.time,
              equity: Number((trendLine + deviation * freqShapeFactor + wave).toFixed(4)),
            };
          });

          const targetFinalEquity = Number((initialBalance * (1 + adjustedSnapshotMetricsWithOp.ret / 100)).toFixed(4));
          const currentFinalEquity = asNumber(adjustedSnapshotEquity[adjustedSnapshotEquity.length - 1]?.equity, initialBalance);
          const currentPnl = currentFinalEquity - initialBalance;
          const targetPnl = targetFinalEquity - initialBalance;
          if (Math.abs(currentPnl) > 1e-6) {
            const pnlScale = targetPnl / currentPnl;
            // Use simple linear PnL rescale (not compound) to avoid exponential spike
            // at the end of the equity curve when pnlScale is applied with reinvest.
            adjustedSnapshotEquity = adjustedSnapshotEquity.map((point) => ({
              time: point.time,
              equity: Number((initialBalance + (asNumber(point.equity, initialBalance) - initialBalance) * pnlScale).toFixed(4)),
            }));
          }
          // Keep curve shape continuous: avoid hard-forcing only the final point,
          // which can create a visual vertical spike on the chart.

          const snapshotCurves = buildDerivedPreviewCurves(adjustedSnapshotEquity, initialBalance, riskScore);

          return {
            kind,
            publishMeta: {
              offerIds: snapshotOfferIds,
              setKey: asString(snapshot.setKey, requestedSetKey),
              membersCount: snapshotOfferIds.length,
              systemName: asString(snapshot.systemName, ''),
            },
            controls: {
              riskScore,
              tradeFrequencyScore,
              riskLevel,
              tradeFrequencyLevel,
              riskScaleMaxPercent,
              reinvestPercent,
              maxOpenPositions,
            },
            period: snapshotPeriodInfo,
            sweepApiKeyName: asString(snapshot.apiKeyName, ''),
            selectedOffers: snapshotSelectedOffers,
            snapshotMeta: {
              bakedMaxOpenPositions: snapshotSavedMaxOpenPositions,
              bakedRiskScore: snapshotRiskScore,
              bakedTradeFrequencyScore: snapshotTradeFrequencyScore,
              periodDays: asNumber(snapshot.periodDays, 0),
            },
            preview: {
              source: 'admin_saved_ts_snapshot_synthetic',
              summary: {
                finalEquity: Number(asNumber(adjustedSnapshotEquity[adjustedSnapshotEquity.length - 1]?.equity, initialBalance).toFixed(4)),
                totalReturnPercent: Number(adjustedSnapshotMetricsWithOp.ret.toFixed(3)),
                maxDrawdownPercent: Number(adjustedSnapshotMetricsWithOp.dd.toFixed(3)),
                profitFactor: Number(adjustedSnapshotMetricsWithOp.pf.toFixed(3)),
                winRatePercent: 0,
                tradesCount: Math.max(0, Math.floor(adjustedSnapshotMetricsWithOp.trades)),
                unrealizedPnl: snapshotCurves.finalUnrealizedPnl,
                marginLoadPercent: snapshotCurves.maxMarginLoadPercent,
              },
              equity: adjustedSnapshotEquity,
              curves: {
                pnl: snapshotCurves.pnl,
                drawdownPercent: snapshotCurves.drawdownPercent,
                marginLoadPercent: snapshotCurves.marginLoadPercent,
              },
              trades: [],
              strictPresetMode: true,
            },
            rerun: {
              requested: canTryRealBacktest,
              executed: false,
              ...(snapshotRerunFailureReason ? { error: snapshotRerunFailureReason } : {}),
              apiKeyName: asString(payload?.rerunApiKeyName, asString(snapshot.apiKeyName, '')),
              strategyIds: snapshotStrategyIds,
              tsMembersCount: snapshotOfferIds.length,
              riskMul: rerunRiskMul,
              riskScaleMaxPercent,
              freqLevel: tradeFrequencyLevel,
            },
          };
        }
      }
    if (selectedOffers.length === 0) {
      throw new Error('No offers resolved for sweep backtest preview');
    }
  }

  const adjustedSelectedOffers = selectedOffers.map((item) => {
    const weight = kind === 'algofund-ts'
      ? asNumber(normalizedOfferWeightsById[item.offerId], 1 / Math.max(1, selectedOffers.length))
      : 1;
    const adjustedMetrics = adjustPreviewMetrics(item.metrics, rerunRiskMul, tradeMul);
    return {
      ...item,
      weight: Number(weight.toFixed(6)),
      metrics: adjustedMetrics,
      tradesPerDay: Number((adjustedMetrics.trades / Math.max(1, item.periodDays)).toFixed(3)),
      equityPoints: buildAdjustedPreviewEquity(
        item.preset,
        initialBalance,
        adjustedMetrics.ret,
        adjustedMetrics.dd,
        item.periodDays,
        oscillationFactor
      ).map((point) => Number(asNumber(point.equity, 0).toFixed(4))),
    };
  });

  // Sweep-only OP approximation: OP limits *concurrent* open positions, not total trades.
  // Slots rotate — when one position closes another opens. Trade count is barely affected.
  // What changes: DD decreases (capped concurrent exposure) and return slightly decreases
  // (rare missed entries during high-contention bars).
  // Estimate natural concurrent via utilization (~22% for 4h trend strategies).
  const opSlots = kind === 'algofund-ts' ? maxOpenPositions : 0;
  const opMemberCount = kind === 'algofund-ts' ? Math.max(1, adjustedSelectedOffers.length) : 1;
  // naturalConcurrent = how many positions are open on average without any OP limit
  const estimatedUtilization = 0.22; // empirical: 4h strategies hold ~22% of bars
  const naturalConcurrent = Math.max(1, opMemberCount * estimatedUtilization);
  // opSlotRatio: how much concurrent demand is satisfied by available slots
  const opSlotRatio = opSlots > 0 ? Math.min(1, opSlots / naturalConcurrent) : 1;
  // Return/DD scale: capping concurrent exposure reduces both proportionally
  const opReturnFactor = opSlots > 0 ? (0.7 + 0.3 * opSlotRatio) : 1;
  const opDrawdownFactor = opSlots > 0 ? (0.5 + 0.5 * opSlotRatio) : 1;
  // Trade count: slots rotate → barely reduced (only high-contention bars are skipped)
  const opTradeFactor = opSlots > 0 ? Math.min(1, 0.85 + 0.15 * opSlotRatio) : 1;

  const opAdjustedSelectedOffers = adjustedSelectedOffers.map((item) => {
    if (kind !== 'algofund-ts' || opSlots <= 0 || opSlotRatio >= 1) {
      return item;
    }

    const metrics = item.metrics as Record<string, unknown>;
    const nextMetrics = {
      ...item.metrics,
      ret: Number((asNumber(metrics.ret, 0) * opReturnFactor).toFixed(3)),
      dd: Number((asNumber(metrics.dd, 0) * opDrawdownFactor).toFixed(3)),
      trades: Math.max(1, Math.floor(asNumber(metrics.trades, 0) * opTradeFactor)),
    };

    return {
      ...item,
      metrics: nextMetrics,
      tradesPerDay: Number((nextMetrics.trades / Math.max(1, item.periodDays)).toFixed(3)),
      equityPoints: buildAdjustedPreviewEquity(
        item.preset,
        initialBalance,
        nextMetrics.ret,
        nextMetrics.dd,
        item.periodDays,
        oscillationFactor
      ).map((point) => Number(asNumber(point.equity, 0).toFixed(4))),
    };
  });

  const sweepApiKeyName = asString((sweep as Record<string, unknown>)?.apiKeyName || ((sweep as Record<string, unknown>)?.config as Record<string, unknown>)?.apiKeyName, '');

  if (kind === 'offer') {
    const first = adjustedSelectedOffers[0];
    const equityCurve = buildAdjustedPreviewEquity(first.preset, initialBalance, first.metrics.ret, first.metrics.dd, periodDays, oscillationFactor);
    const derivedCurves = buildDerivedPreviewCurves(equityCurve, initialBalance, riskScore);
    const singleSummary = buildPresetOnlySingleSummary(initialBalance, first.preset, first.market, first.strategyName, first.metrics);
    return {
      kind,
      controls: {
        riskScore,
        tradeFrequencyScore,
        riskLevel,
        tradeFrequencyLevel,
        riskScaleMaxPercent,
        maxOpenPositions: opSlots,
      },
      period,
      sweepApiKeyName,
      selectedOffers: opAdjustedSelectedOffers,
      preview: {
        source: 'admin_sweep_preset',
        summary: {
          ...singleSummary,
          unrealizedPnl: derivedCurves.finalUnrealizedPnl,
          marginLoadPercent: derivedCurves.maxMarginLoadPercent,
        },
        equity: equityCurve,
        curves: {
          pnl: derivedCurves.pnl,
          drawdownPercent: derivedCurves.drawdownPercent,
          marginLoadPercent: derivedCurves.marginLoadPercent,
        },
        trades: [],
        strictPresetMode: true,
      },
      rerun: {
        requested: canTryRealBacktest,
        executed: false,
        ...(rerunFailureReason ? { error: rerunFailureReason } : {}),
      },
    };
  }

  const pseudoSelectedOffers = selectedOffers.map((item) => ({
    offer: {
      offerId: item.offerId,
      titleRu: item.titleRu,
      strategy: {
        market: item.market,
      },
    },
    preset: item.preset,
  }));

  // Build portfolio equity directly from already-oscillated per-offer equityPoints
  // (averaging across all offers preserves the per-risk oscillation pattern)
  const allOfferEquityArrays = opAdjustedSelectedOffers
    .map((item) => ({
      points: Array.isArray(item.equityPoints) ? item.equityPoints as number[] : [],
      weight: kind === 'algofund-ts' ? Math.max(0, asNumber((item as Record<string, unknown>).weight, 0)) : 1,
    }))
    .filter((entry) => entry.points.length >= 2 && entry.weight > 0);

  let portfolioEquity: Array<{ time: number; equity: number }>;
  if (allOfferEquityArrays.length > 0) {
    const maxLen = allOfferEquityArrays.reduce((acc, entry) => Math.max(acc, entry.points.length), 0);
    const now = Date.now();
    const resolvedPeriodDays = Math.max(10, periodDays || 90);
    const periodMs = Math.round(resolvedPeriodDays * 24 * 3600 * 1000);
    portfolioEquity = Array.from({ length: maxLen }, (_, index) => {
      let weightedSum = 0;
      let weightsSum = 0;
      for (const entry of allOfferEquityArrays) {
        const val = entry.points[Math.min(index, entry.points.length - 1)];
        if (Number.isFinite(val)) {
          weightedSum += val * entry.weight;
          weightsSum += entry.weight;
        }
      }
      const avgEq = weightsSum > 0 ? weightedSum / weightsSum : initialBalance;
      return {
        time: Math.round(now - periodMs + (index / Math.max(1, maxLen - 1)) * periodMs),
        equity: Number(avgEq.toFixed(4)),
      };
    });
  } else {
    portfolioEquity = buildPortfolioPreviewEquityFromPresets(opAdjustedSelectedOffers, initialBalance, periodDays);
  }
  const portfolioCurves = buildDerivedPreviewCurves(portfolioEquity, initialBalance, riskScore);
  const getMemberWeight = (item: Record<string, unknown>): number => {
    if (kind !== 'algofund-ts') {
      return 1;
    }
    const raw = asNumber(item.weight, 0);
    return raw > 0 ? raw : 0;
  };
  const weightedMetric = (pick: (item: Record<string, unknown>) => number): number => {
    let weighted = 0;
    let total = 0;
    for (const item of opAdjustedSelectedOffers as unknown as Array<Record<string, unknown>>) {
      const weight = getMemberWeight(item);
      if (weight <= 0) {
        continue;
      }
      weighted += pick(item) * weight;
      total += weight;
    }
    if (total <= 0) {
      return 0;
    }
    return weighted / total;
  };
  const portfolioSummary = buildPresetOnlyPortfolioSummary(initialBalance, pseudoSelectedOffers as any, {
    avgRet: weightedMetric((item) => asNumber((item.metrics as Record<string, unknown>)?.ret, 0)),
    avgPf: weightedMetric((item) => asNumber((item.metrics as Record<string, unknown>)?.pf, 0)),
    // Keep conservative DD semantics (worst member) to match historical TS preview behavior.
    maxDd: (opAdjustedSelectedOffers as Array<Record<string, unknown>>).reduce((acc, item) => {
      const value = asNumber((item.metrics as Record<string, unknown>)?.dd, 0);
      return value > acc ? value : acc;
    }, 0),
    avgWr: weightedMetric((item) => asNumber((item.metrics as Record<string, unknown>)?.wr, 0)),
    // Trades count is strategy activity, not capital allocation. Keep sum semantics.
    totalTrades: Math.max(0, Math.floor(
      (opAdjustedSelectedOffers as Array<Record<string, unknown>>).reduce((acc, item) => {
        const trades = Math.max(0, asNumber((item.metrics as Record<string, unknown>)?.trades, 0));
        return acc + trades;
      }, 0)
    )),
  });

  return {
    kind,
    controls: {
      riskScore,
      tradeFrequencyScore,
      riskLevel,
      tradeFrequencyLevel,
      riskScaleMaxPercent,
      maxOpenPositions: opSlots,
    },
    period,
    sweepApiKeyName,
    selectedOffers: opAdjustedSelectedOffers,
    preview: {
      source: 'admin_sweep_preset',
      summary: {
        ...portfolioSummary,
        unrealizedPnl: portfolioCurves.finalUnrealizedPnl,
        marginLoadPercent: portfolioCurves.maxMarginLoadPercent,
      },
      equity: portfolioEquity,
      curves: {
        pnl: portfolioCurves.pnl,
        drawdownPercent: portfolioCurves.drawdownPercent,
        marginLoadPercent: portfolioCurves.marginLoadPercent,
      },
      trades: [],
      strictPresetMode: true,
    },
    rerun: {
      requested: canTryRealBacktest,
      executed: false,
      ...(rerunFailureReason ? { error: rerunFailureReason } : {}),
    },
  };
};

/** Volatile / high-turnover pairs first — DCA scan pool order matters for maxCandidates cap. */
const DCA_CANDIDATE_SYMBOLS = [
  'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', 'DOGEUSDT', 'SHIBUSDT', 'FLOKIUSDT',
  'SUIUSDT', 'SEIUSDT', 'INJUSDT', 'TRXUSDT', 'NEARUSDT', 'WLDUSDT',
  'TIAUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT',
  'XRPUSDT', 'LTCUSDT', 'ADAUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT',
  'ATOMUSDT', 'FILUSDT', 'BNBUSDT', 'AVAXUSDT', 'BCHUSDT', 'ETCUSDT',
];

type DcaTsPickContext = {
  snapshot: TsBacktestSnapshot;
  offerIds: string[];
  occupiedMarkets: Set<string>;
  previewDates: { dateFrom: string; dateTo: string; usedFullSweepDepth?: boolean };
  initialBalance: number;
  preferredApiKey: string;
  tsStrategyIds: number[];
  sweep: Awaited<ReturnType<typeof loadCatalogAndSweepWithFallback>>['sweep'];
  dcaSettings: NormalizedDcaSettings;
};

const resolveDcaTsPickContext = async (payload?: {
  systemName?: string;
  setKey?: string;
  apiKeyName?: string;
  dateFrom?: string;
  dateTo?: string;
  initialBalance?: number;
  riskScore?: number;
  tradeFrequencyScore?: number;
  dcaSettings?: DcaStrategySettings;
}): Promise<DcaTsPickContext> => {
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const apiKeys = await getAvailableApiKeyNames();
  const catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  if (!catalog) {
    throw new Error('Catalog is unavailable for DCA pair pick');
  }

  const snapshot = await resolveAlgofundTsBacktestSnapshotForPreview({
    setKey: asString(payload?.setKey, ''),
    systemName: asString(payload?.systemName, ''),
  });
  if (!snapshot) {
    throw new Error('TS snapshot not found for DCA pair pick');
  }

  const offerIds = Array.from(new Set(
    (Array.isArray(snapshot.offerIds) ? snapshot.offerIds : [])
      .map((item) => asString(item, '').trim())
      .filter(Boolean),
  ));
  if (offerIds.length === 0) {
    throw new Error('TS snapshot has no offerIds');
  }

  const offerStore = await getOfferStoreAdminState().catch(() => null);
  const offerStoreById = new Map(
    ((offerStore?.offers || []) as Array<Record<string, unknown>>)
      .map((row) => [asString(row?.offerId, '').trim(), row] as const)
      .filter(([offerId]) => Boolean(offerId)),
  );
  const occupiedMarkets = collectTsOccupiedMarkets(offerIds, catalog, offerStoreById);
  const requestedDateFrom = asString(payload?.dateFrom, '').trim();
  const requestedDateTo = asString(payload?.dateTo, '').trim();
  const rerunDates = requestedDateFrom || requestedDateTo
    ? (() => {
      const clamped = clampRequestedBacktestDates(requestedDateFrom, requestedDateTo, sweep);
      return {
        dateFrom: clamped.dateFrom,
        dateTo: clamped.dateTo,
        usedFullSweepDepth: false,
      };
    })()
    : resolveSnapshotRerunDates(snapshot, sweep, '', '');
  const previewDates = {
    dateFrom: rerunDates.dateFrom,
    dateTo: rerunDates.dateTo,
    usedFullSweepDepth: rerunDates.usedFullSweepDepth,
  };
  const initialBalance = Math.max(100, asNumber(payload?.initialBalance, asNumber(snapshot.backtestSettings?.initialBalance, 10000)));
  const dcaSettings = normalizeDcaSettings(payload?.dcaSettings, initialBalance);

  const preferredApiKey = asString(payload?.apiKeyName, '')
    || asString(snapshot.apiKeyName, '')
    || asString(catalog?.apiKeyName, '')
    || asString(apiKeys[0], '');
  if (!preferredApiKey) {
    throw new Error('API key is required for DCA pair pick');
  }

  const tsStrategyIds = buildTsStrategyIdsForOfferIds(offerIds, catalog, sweep, {
    riskScore: payload?.riskScore,
    tradeFrequencyScore: payload?.tradeFrequencyScore,
  });
  if (tsStrategyIds.length === 0) {
    throw new Error('Could not resolve TS strategy ids for DCA pair pick');
  }

  return {
    snapshot,
    offerIds,
    occupiedMarkets,
    previewDates,
    initialBalance,
    preferredApiKey,
    tsStrategyIds,
    sweep,
    dcaSettings,
  };
};

const buildDcaCandidatePool = async (
  apiKeyName: string,
  occupiedMarkets: Set<string>,
  maxPool = 40,
): Promise<string[]> => {
  await ensureExchangeClientInitialized(apiKeyName);
  let exchangeSymbols: string[] = [];
  try {
    const raw = await getAllSymbols(apiKeyName);
    exchangeSymbols = (Array.isArray(raw) ? raw : [])
      .map((item) => normalizeFullUsdtSymbol(String(item || '')))
      .filter((item) => item.endsWith('USDT') && item.length >= 6);
  } catch (error) {
    logger.warn(`[buildDcaCandidatePool] getAllSymbols failed for ${apiKeyName}: ${asString((error as Error).message, 'unknown')}`);
  }

  const exchangeSet = new Set(exchangeSymbols);
  const prioritized = DCA_CANDIDATE_SYMBOLS
    .map((item) => normalizeFullUsdtSymbol(item))
    .filter((item) => item && !occupiedMarkets.has(item) && (exchangeSet.size === 0 || exchangeSet.has(item)));
  const extra = exchangeSymbols
    .filter((item) => !occupiedMarkets.has(item) && !prioritized.includes(item))
    .sort((a, b) => a.localeCompare(b));

  return Array.from(new Set([...prioritized, ...extra])).slice(0, Math.max(1, maxPool));
};

const dcaSettingsCachePayload = (settings: NormalizedDcaSettings) => ({
  baseAmountMode: settings.baseAmountMode,
  baseAmountUsdt: settings.baseAmountUsdt,
  baseAmountPercent: settings.baseAmountPercent,
  stepPercent: settings.stepPercent,
  maxOrders: settings.maxOrders,
  orderMultiplier: settings.orderMultiplier,
  tpPercent: settings.tpPercent,
  slPercent: settings.slPercent,
  interval: settings.interval,
  detectionSource: settings.detectionSource,
  entryFilter: settings.entryFilter,
  reentryBars: settings.reentryBars,
  rsiPeriod: settings.rsiPeriod,
  rsiMax: settings.rsiMax,
  perLegSl: settings.perLegSl,
});

const buildDcaScanEngineOverrides = (params: {
  reinvestPercent?: number;
  initialBalance: number;
}) => {
  const reinvestPercent = clampNumber(asNumber(params.reinvestPercent, 0), 0, 100);
  return {
    maxDepositOverride: resolveAdminPreviewMaxDepositOverride(reinvestPercent, params.initialBalance),
    reinvestPercentOverride: reinvestPercent,
  };
};

const buildDcaScanFingerprint = (params: {
  previewDates: { dateFrom: string; dateTo: string };
  initialBalance: number;
  dcaSettings: NormalizedDcaSettings;
  autotune: boolean;
  riskScore?: number;
  tradeFrequencyScore?: number;
  reinvestPercent?: number;
}): string => hashDcaCachePayload({
  kind: 'dca_scan_fingerprint',
  scoringVersion: DCA_AUTOTUNE_VERSION,
  dateFrom: params.previewDates.dateFrom,
  dateTo: params.previewDates.dateTo,
  initialBalance: params.initialBalance,
  dcaSettings: dcaSettingsCachePayload(params.dcaSettings),
  autotune: params.autotune,
  riskScore: params.riskScore ?? null,
  tradeFrequencyScore: params.tradeFrequencyScore ?? null,
  reinvestPercent: params.reinvestPercent ?? null,
});

const hashDcaCachePayload = (payload: unknown): string => (
  crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40)
);

const buildDcaPairScoreCacheKey = (params: {
  apiKeyName: string;
  market: string;
  previewDates: { dateFrom: string; dateTo: string };
  initialBalance: number;
  dcaSettings: NormalizedDcaSettings;
  sweep: DcaTsPickContext['sweep'];
  reinvestPercent?: number;
}): string => hashDcaCachePayload({
  kind: 'dca_pair_score',
  apiKeyName: params.apiKeyName,
  market: normalizeFullUsdtSymbol(params.market),
  dateFrom: params.previewDates.dateFrom,
  dateTo: params.previewDates.dateTo,
  initialBalance: params.initialBalance,
  dcaSettings: dcaSettingsCachePayload(params.dcaSettings),
  sweepBars: asNumber(params.sweep?.config?.backtestBars, 6000),
  commissionPercent: asNumber(params.sweep?.config?.commissionPercent, 0.1),
  slippagePercent: asNumber(params.sweep?.config?.slippagePercent, 0.05),
  scoringVersion: DCA_AUTOTUNE_VERSION,
  reinvestPercent: params.reinvestPercent ?? null,
});

const buildDcaResearchRunCacheKey = (params: {
  systemName: string;
  apiKeyName: string;
  previewDates: { dateFrom: string; dateTo: string };
  initialBalance: number;
  dcaSettings: NormalizedDcaSettings;
  autotune: boolean;
  candidatePool: string[];
}): string => hashDcaCachePayload({
  kind: 'dca_research_run',
  systemName: params.systemName,
  apiKeyName: params.apiKeyName,
  dateFrom: params.previewDates.dateFrom,
  dateTo: params.previewDates.dateTo,
  initialBalance: params.initialBalance,
  dcaSettings: dcaSettingsCachePayload(params.dcaSettings),
  autotune: params.autotune,
  candidatePool: [...params.candidatePool].sort(),
  autotuneVariants: DCA_AUTOTUNE_VARIANTS.length,
  scoringVersion: DCA_AUTOTUNE_VERSION,
});

const loadDcaPairScoreCache = async (cacheKey: string) => {
  const row = await db.get<{ result_json: string }>(
    `SELECT result_json FROM dca_pair_score_cache WHERE cache_key = ?`,
    [cacheKey],
  ).catch(() => null);
  if (!row?.result_json) {
    return null;
  }
  try {
    return JSON.parse(row.result_json) as {
      market: string;
      ret: number;
      dd: number;
      pf: number;
      trades: number;
      score: number;
      interval?: string;
      detectionSource?: string;
      stepPercent?: number;
      tpPercent?: number;
      slPercent?: number;
      entryFilter?: string;
      perLegSl?: boolean;
      error?: string;
    };
  } catch {
    return null;
  }
};

const saveDcaPairScoreCache = async (
  cacheKey: string,
  params: {
    apiKeyName: string;
    market: string;
    previewDates: { dateFrom: string; dateTo: string };
    dcaSettings: NormalizedDcaSettings;
  },
  result: Record<string, unknown>,
): Promise<void> => {
  await db.run(
    `INSERT INTO dca_pair_score_cache (
      cache_key, api_key_name, market, date_from, date_to, dca_settings_json,
      ret, dd, pf, trades, score, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      ret = excluded.ret,
      dd = excluded.dd,
      pf = excluded.pf,
      trades = excluded.trades,
      score = excluded.score,
      result_json = excluded.result_json,
      created_at = CURRENT_TIMESTAMP`,
    [
      cacheKey,
      params.apiKeyName,
      normalizeFullUsdtSymbol(params.market),
      params.previewDates.dateFrom,
      params.previewDates.dateTo,
      JSON.stringify(dcaSettingsCachePayload(params.dcaSettings)),
      asNumber(result.ret, 0),
      asNumber(result.dd, 0),
      asNumber(result.pf, 0),
      Math.floor(asNumber(result.trades, 0)),
      asNumber(result.score, 0),
      JSON.stringify(result),
    ],
  ).catch((error) => {
    logger.warn(`[dca_pair_score_cache] save failed: ${asString((error as Error).message, 'unknown')}`);
  });
};

type DcaResearchCandidateRow = {
  market: string;
  ret: number;
  dd: number;
  pf: number;
  trades: number;
  score: number;
  interval?: string;
  detectionSource?: string;
  stepPercent?: number;
  tpPercent?: number;
  slPercent?: number;
  entryFilter?: string;
  perLegSl?: boolean;
  error?: string;
  status: 'ok' | 'error' | 'skipped';
  autotuned?: boolean;
};

type DcaResearchResult = {
  tsMarkets: string[];
  period: { dateFrom: string; dateTo: string; interval: string; fullDepth?: boolean };
  initialBalance?: number;
  dcaSettings: NormalizedDcaSettings;
  scanFingerprint?: string;
  autotune?: boolean;
  candidatePoolSize: number;
  candidates: DcaResearchCandidateRow[];
  viableCount: number;
  top: DcaResearchCandidateRow[];
  fromCache?: boolean;
  note: string;
};

const loadDcaResearchRunCache = async (cacheKey: string): Promise<DcaResearchResult | null> => {
  const row = await db.get<{ result_json: string }>(
    `SELECT result_json FROM dca_research_run_cache WHERE cache_key = ?`,
    [cacheKey],
  ).catch(() => null);
  if (!row?.result_json) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.result_json) as DcaResearchResult;
    if (!Array.isArray(parsed?.candidates)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const saveDcaResearchRunCache = async (
  cacheKey: string,
  params: {
    systemName: string;
    apiKeyName: string;
    previewDates: { dateFrom: string; dateTo: string };
    initialBalance: number;
    dcaSettings: NormalizedDcaSettings;
    autotune: boolean;
    candidatePool: string[];
  },
  result: Record<string, unknown>,
): Promise<void> => {
  await db.run(
    `INSERT INTO dca_research_run_cache (
      cache_key, system_name, api_key_name, date_from, date_to, initial_balance,
      dca_settings_json, autotune, candidate_pool_json, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      result_json = excluded.result_json,
      created_at = CURRENT_TIMESTAMP`,
    [
      cacheKey,
      params.systemName,
      params.apiKeyName,
      params.previewDates.dateFrom,
      params.previewDates.dateTo,
      params.initialBalance,
      JSON.stringify(dcaSettingsCachePayload(params.dcaSettings)),
      params.autotune ? 1 : 0,
      JSON.stringify(params.candidatePool),
      JSON.stringify(result),
    ],
  ).catch((error) => {
    logger.warn(`[dca_research_run_cache] save failed: ${asString((error as Error).message, 'unknown')}`);
  });
};

const buildDcaBacktestRequestBase = (
  apiKeyName: string,
  ctx: Pick<DcaTsPickContext, 'previewDates' | 'initialBalance' | 'sweep'>,
  options?: { enablePairLock?: boolean },
) => ({
  apiKeyName,
  bars: asNumber(ctx.sweep?.config?.backtestBars, 6000),
  warmupBars: asNumber(ctx.sweep?.config?.warmupBars, 400),
  skipMissingSymbols: ctx.sweep?.config?.skipMissingSymbols !== false,
  initialBalance: ctx.initialBalance,
  commissionPercent: asNumber(ctx.sweep?.config?.commissionPercent, 0.1),
  slippagePercent: asNumber(ctx.sweep?.config?.slippagePercent, 0.05),
  fundingRatePercent: asNumber(ctx.sweep?.config?.fundingRatePercent, 0),
  dateFrom: ctx.previewDates.dateFrom,
  dateTo: ctx.previewDates.dateTo,
  ...(options?.enablePairLock === true ? { enablePairLock: true } : {}),
});

const scoreDcaCandidate = async (params: {
  apiKeyName: string;
  market: string;
  scratchStrategyId: number;
  dcaSettings: NormalizedDcaSettings;
  previewDates: { dateFrom: string; dateTo: string };
  initialBalance: number;
  sweep: DcaTsPickContext['sweep'];
  reinvestPercent?: number;
  scoringMode?: 'scan' | 'autotune';
  skipCache?: boolean;
}): Promise<{
  market: string;
  ret: number;
  dd: number;
  pf: number;
  trades: number;
  score: number;
  interval?: string;
  detectionSource?: string;
  stepPercent?: number;
  tpPercent?: number;
  slPercent?: number;
  entryFilter?: string;
  perLegSl?: boolean;
  error?: string;
}> => {
  const market = normalizeFullUsdtSymbol(params.market);
  const scanEngineOverrides = buildDcaScanEngineOverrides({
    reinvestPercent: params.reinvestPercent,
    initialBalance: params.initialBalance,
  });
  const cacheKey = buildDcaPairScoreCacheKey({
    apiKeyName: params.apiKeyName,
    market,
    previewDates: params.previewDates,
    initialBalance: params.initialBalance,
    dcaSettings: params.dcaSettings,
    sweep: params.sweep,
    reinvestPercent: scanEngineOverrides.reinvestPercentOverride,
  });
  if (!params.skipCache) {
    const cached = await loadDcaPairScoreCache(cacheKey);
    if (cached) {
      return { ...cached, market };
    }
  }
  try {
    await configureDcaScratchForSymbol(
      params.scratchStrategyId,
      market,
      params.dcaSettings,
      params.initialBalance,
    );
    const base = buildDcaBacktestRequestBase(params.apiKeyName, {
      previewDates: params.previewDates,
      initialBalance: params.initialBalance,
      sweep: params.sweep,
    });
    const result = await runBacktest({
      ...base,
      mode: 'single',
      strategyId: params.scratchStrategyId,
      maxDepositOverride: scanEngineOverrides.maxDepositOverride,
      reinvestPercentOverride: scanEngineOverrides.reinvestPercentOverride,
    });
    const ret = Number(result.summary.totalReturnPercent || 0);
    const dd = Number(result.summary.maxDrawdownPercent || 0);
    const pf = Number(result.summary.profitFactor || 0);
    const trades = Number(result.summary.tradesCount || 0);
    const scoringMode = params.scoringMode === 'autotune' ? 'autotune' : 'scan';
    const score = computeDcaCandidateScore(ret, dd, pf, trades, scoringMode);
    if (trades <= 0) {
      const noTradesResult = {
        market,
        ret,
        dd,
        pf,
        trades,
        score,
        interval: params.dcaSettings.interval,
        detectionSource: params.dcaSettings.detectionSource,
        stepPercent: params.dcaSettings.stepPercent,
        tpPercent: params.dcaSettings.tpPercent,
        slPercent: params.dcaSettings.slPercent,
        entryFilter: params.dcaSettings.entryFilter,
        perLegSl: params.dcaSettings.perLegSl,
        error: 'No trades in selected period',
      };
      await saveDcaPairScoreCache(cacheKey, params, noTradesResult);
      return noTradesResult;
    }
    const okResult = {
      market,
      ret,
      dd,
      pf,
      trades,
      score,
      interval: params.dcaSettings.interval,
      detectionSource: params.dcaSettings.detectionSource,
      stepPercent: params.dcaSettings.stepPercent,
      tpPercent: params.dcaSettings.tpPercent,
      slPercent: params.dcaSettings.slPercent,
      entryFilter: params.dcaSettings.entryFilter,
      perLegSl: params.dcaSettings.perLegSl,
    };
    await saveDcaPairScoreCache(cacheKey, params, okResult);
    return okResult;
  } catch (error) {
    return {
      market,
      ret: 0,
      dd: 0,
      pf: 0,
      trades: 0,
      score: -Infinity,
      error: asString((error as Error).message, 'backtest failed'),
    };
  }
};

let dcaResearchJob: {
  running: boolean;
  abortRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  phase: string;
  progressPercent: number;
  totalSteps: number;
  completedSteps: number;
  currentMarket: string;
  message: string;
  result: Record<string, unknown> | null;
  error: string | null;
} = {
  running: false,
  abortRequested: false,
  startedAt: 0,
  finishedAt: null,
  phase: 'idle',
  progressPercent: 0,
  totalSteps: 0,
  completedSteps: 0,
  currentMarket: '',
  message: '',
  result: null,
  error: null,
};

const DCA_RESEARCH_STALE_MS = 20 * 60 * 1000;

const setDcaResearchProgress = (
  completedSteps: number,
  totalSteps: number,
  phase: string,
  message: string,
  currentMarket = '',
) => {
  dcaResearchJob.completedSteps = completedSteps;
  dcaResearchJob.totalSteps = Math.max(1, totalSteps);
  dcaResearchJob.phase = phase;
  dcaResearchJob.message = message;
  dcaResearchJob.currentMarket = currentMarket;
  dcaResearchJob.progressPercent = Math.min(
    99,
    Math.round((completedSteps / Math.max(1, totalSteps)) * 100),
  );
};

const shouldAbortDcaResearch = (): boolean => dcaResearchJob.abortRequested;

const executeDcaResearchCore = async (payload?: {
  systemName?: string;
  setKey?: string;
  apiKeyName?: string;
  dateFrom?: string;
  dateTo?: string;
  initialBalance?: number;
  maxCandidates?: number;
  dcaSettings?: DcaStrategySettings;
  autotune?: boolean;
  forceRefresh?: boolean;
  riskScore?: number;
  tradeFrequencyScore?: number;
  reinvestPercent?: number;
}): Promise<DcaResearchResult> => {
  const ctx = await resolveDcaTsPickContext(payload);
  const scratchStrategyId = await getOrCreateDcaResearchScratchId(ctx.preferredApiKey, ctx.dcaSettings);
  const maxPool = Math.max(6, Math.min(20, Math.floor(asNumber(payload?.maxCandidates, 12))));
  const candidatePool = await buildDcaCandidatePool(
    ctx.preferredApiKey,
    ctx.occupiedMarkets,
    maxPool,
  );

  const autotuneTop = payload?.autotune !== false;
  const autotuneVariants = autotuneTop ? buildAutotuneVariantsForBaseline(ctx.dcaSettings) : [];
  const skipCache = payload?.forceRefresh === true;
  const scanReinvestPercent = clampNumber(asNumber(payload?.reinvestPercent, 0), 0, 100);
  const scanFingerprint = buildDcaScanFingerprint({
    previewDates: ctx.previewDates,
    initialBalance: ctx.initialBalance,
    dcaSettings: ctx.dcaSettings,
    autotune: autotuneTop,
    riskScore: payload?.riskScore,
    tradeFrequencyScore: payload?.tradeFrequencyScore,
    reinvestPercent: scanReinvestPercent,
  });
  const autotuneMarketsCap = 3;
  const autotuneVariantsCount = autotuneTop ? autotuneVariants.length : 0;
  const autotuneMarketsEstimate = autotuneTop ? Math.min(autotuneMarketsCap, candidatePool.length) : 0;
  const totalSteps = candidatePool.length + autotuneMarketsEstimate * autotuneVariantsCount;
  let completedSteps = 0;

  const systemName = asString(payload?.systemName, '')
    || asString(payload?.setKey, '')
    || asString(ctx.snapshot.systemName, '')
    || asString(ctx.snapshot.setKey, '');
  const runCacheKey = buildDcaResearchRunCacheKey({
    systemName,
    apiKeyName: ctx.preferredApiKey,
    previewDates: ctx.previewDates,
    initialBalance: ctx.initialBalance,
    dcaSettings: ctx.dcaSettings,
    autotune: autotuneTop,
    candidatePool,
  });
  if (!skipCache) {
    const cachedRun = await loadDcaResearchRunCache(runCacheKey);
    if (cachedRun) {
      setDcaResearchProgress(totalSteps, totalSteps, 'cache', 'Loaded from DCA sweep cache', '');
      return {
        ...cachedRun,
        scanFingerprint,
        fromCache: true,
        note: `${asString(cachedRun.note, 'Classic DCA backtest')} • loaded from DCA sweep cache`,
      };
    }
  }

  const candidates: DcaResearchCandidateRow[] = [];

  setDcaResearchProgress(0, totalSteps, 'scan', `Scan 0/${candidatePool.length} pairs`, '');

  for (const market of candidatePool) {
    if (shouldAbortDcaResearch()) {
      throw new Error('DCA scan aborted by user');
    }
    setDcaResearchProgress(
      completedSteps,
      totalSteps,
      'scan',
      `Scan ${completedSteps + 1}/${candidatePool.length}: ${market}`,
      market,
    );
    const scored = await scoreDcaCandidate({
      apiKeyName: ctx.preferredApiKey,
      market,
      scratchStrategyId,
      dcaSettings: ctx.dcaSettings,
      previewDates: ctx.previewDates,
      initialBalance: ctx.initialBalance,
      sweep: ctx.sweep,
      reinvestPercent: scanReinvestPercent,
      skipCache,
    });
    candidates.push({
      ...scored,
      status: scored.error ? 'error' : 'ok',
    });
    completedSteps += 1;
    setDcaResearchProgress(
      completedSteps,
      totalSteps,
      'scan',
      `Scan ${completedSteps}/${candidatePool.length}: ${market}`,
      market,
    );
  }

  candidates.sort((a, b) => b.score - a.score);
  if (autotuneTop) {
    const autotuneMarkets = candidates
      .filter((item) => item.status === 'ok' && item.trades > 0)
      .slice(0, autotuneMarketsCap)
      .map((item) => item.market);
    for (const market of autotuneMarkets) {
      if (shouldAbortDcaResearch()) {
        throw new Error('DCA scan aborted by user');
      }
      let best = candidates.find((item) => item.market === market);
      if (!best) continue;
      const baselineStep = best.stepPercent;
      const baselineTp = best.tpPercent;
      const baselineInterval = best.interval;
      for (const variant of autotuneVariants) {
        if (shouldAbortDcaResearch()) {
          throw new Error('DCA scan aborted by user');
        }
        setDcaResearchProgress(
          completedSteps,
          totalSteps,
          'autotune',
          `Autotune ${market} step×TP (${completedSteps - candidatePool.length + 1}/${autotuneMarkets.length})`,
          market,
        );
        const merged = normalizeDcaSettings({ ...ctx.dcaSettings, ...variant }, ctx.initialBalance);
        const scored = await scoreDcaCandidate({
          apiKeyName: ctx.preferredApiKey,
          market,
          scratchStrategyId,
          dcaSettings: merged,
          previewDates: ctx.previewDates,
          initialBalance: ctx.initialBalance,
          sweep: ctx.sweep,
          reinvestPercent: scanReinvestPercent,
          scoringMode: 'autotune',
          skipCache,
        });
        const bestScore = best
          ? computeDcaCandidateScore(best.ret, best.dd, best.pf, best.trades, 'autotune')
          : -Infinity;
        if (!scored.error && scored.trades > 0 && scored.score > bestScore) {
          best = { ...scored, status: 'ok' as const };
        }
        completedSteps += 1;
        setDcaResearchProgress(
          completedSteps,
          totalSteps,
          'autotune',
          `Autotune ${market}`,
          market,
        );
      }
      if (best) {
        const idx = candidates.findIndex((item) => item.market === market);
        if (idx >= 0) {
          const autotuned = best.stepPercent !== baselineStep
            || best.tpPercent !== baselineTp
            || best.interval !== baselineInterval;
          candidates[idx] = { ...best, autotuned };
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const viable = candidates.filter((item) => item.status === 'ok' && item.trades > 0);

  const result: DcaResearchResult = {
    tsMarkets: Array.from(ctx.occupiedMarkets).sort(),
    period: {
      dateFrom: ctx.previewDates.dateFrom,
      dateTo: ctx.previewDates.dateTo,
      interval: ctx.dcaSettings.interval || asString(ctx.sweep?.config?.interval, '4h'),
      fullDepth: ctx.previewDates.usedFullSweepDepth === true,
    },
    initialBalance: ctx.initialBalance,
    dcaSettings: ctx.dcaSettings,
    scanFingerprint,
    autotune: autotuneTop,
    candidatePoolSize: candidatePool.length,
    candidates,
    viableCount: viable.length,
    top: viable.slice(0, 5),
    fromCache: false,
    note: `Classic DCA backtest (not Donchian). Period ${ctx.previewDates.dateFrom} → ${ctx.previewDates.dateTo}${ctx.previewDates.usedFullSweepDepth ? ' (full card / sweep depth)' : ''}. Deposit ${ctx.initialBalance} USDT, reinvest ${scanReinvestPercent}%. Scan: TF ${ctx.dcaSettings.interval} step ${ctx.dcaSettings.stepPercent}% TP ${ctx.dcaSettings.tpPercent}% max ${ctx.dcaSettings.maxOrders} base ${ctx.dcaSettings.baseAmountMode === 'percent' ? `${ctx.dcaSettings.baseAmountPercent}% депозита + compound reinvest (t0≈${ctx.dcaSettings.baseAmountUsdt} USDT)` : `${ctx.dcaSettings.baseAmountUsdt} USDT fixed`}. Trades = завершённые сетки (TP), не volume-churn.${autotuneTop ? ' • autotune around baseline' : ''}.`,
  };
  await saveDcaResearchRunCache(runCacheKey, {
    systemName,
    apiKeyName: ctx.preferredApiKey,
    previewDates: ctx.previewDates,
    initialBalance: ctx.initialBalance,
    dcaSettings: ctx.dcaSettings,
    autotune: autotuneTop,
    candidatePool,
  }, result);
  return result;
};

export const getDcaResearchJobStatus = () => {
  if (
    dcaResearchJob.running
    && dcaResearchJob.startedAt > 0
    && Date.now() - dcaResearchJob.startedAt > DCA_RESEARCH_STALE_MS
  ) {
    dcaResearchJob.running = false;
    dcaResearchJob.finishedAt = Date.now();
    dcaResearchJob.phase = 'error';
    dcaResearchJob.error = 'DCA scan stale lock cleared — перезапустите скан';
    dcaResearchJob.message = dcaResearchJob.error;
  }
  return {
  running: dcaResearchJob.running,
  abortRequested: dcaResearchJob.abortRequested,
  startedAt: dcaResearchJob.startedAt > 0 ? new Date(dcaResearchJob.startedAt).toISOString() : null,
  finishedAt: dcaResearchJob.finishedAt ? new Date(dcaResearchJob.finishedAt).toISOString() : null,
  phase: dcaResearchJob.phase,
  progressPercent: dcaResearchJob.running ? dcaResearchJob.progressPercent : (dcaResearchJob.result ? 100 : dcaResearchJob.progressPercent),
  totalSteps: dcaResearchJob.totalSteps,
  completedSteps: dcaResearchJob.completedSteps,
  currentMarket: dcaResearchJob.currentMarket,
  message: dcaResearchJob.message,
  result: dcaResearchJob.result,
  error: dcaResearchJob.error,
};
};

export const clearDcaResearchJobStaleState = (): void => {
  if (dcaResearchJob.running) {
    return;
  }
  dcaResearchJob.error = null;
  dcaResearchJob.abortRequested = false;
  if (dcaResearchJob.phase === 'aborted' || dcaResearchJob.phase === 'error') {
    dcaResearchJob.phase = 'idle';
    dcaResearchJob.message = '';
    dcaResearchJob.progressPercent = 0;
  }
};

export const resetDcaResearchJobLock = (): { cleared: boolean; abortRequested: boolean } => {
  if (!dcaResearchJob.running) {
    dcaResearchJob.abortRequested = false;
    clearDcaResearchJobStaleState();
    return { cleared: true, abortRequested: false };
  }
  dcaResearchJob.abortRequested = true;
  dcaResearchJob.message = 'Abort requested — finish current pair then stop';
  return { cleared: true, abortRequested: true };
};

export const startDcaResearchJob = async (payload?: {
  systemName?: string;
  setKey?: string;
  apiKeyName?: string;
  dateFrom?: string;
  dateTo?: string;
  initialBalance?: number;
  maxCandidates?: number;
  dcaSettings?: DcaStrategySettings;
  autotune?: boolean;
  forceRefresh?: boolean;
  riskScore?: number;
  tradeFrequencyScore?: number;
  reinvestPercent?: number;
}) => {
  if (dcaResearchJob.running) {
    const stale = dcaResearchJob.startedAt > 0 && Date.now() - dcaResearchJob.startedAt > DCA_RESEARCH_STALE_MS;
    if (!stale) {
      throw new Error('DCA scan уже выполняется. Дождитесь завершения или сбросьте lock.');
    }
    dcaResearchJob.running = false;
  }

  dcaResearchJob = {
    running: true,
    abortRequested: false,
    startedAt: Date.now(),
    finishedAt: null,
    phase: 'starting',
    progressPercent: 0,
    totalSteps: 0,
    completedSteps: 0,
    currentMarket: '',
    message: 'Starting DCA scan…',
    result: null,
    error: null,
  };

  void (async () => {
    try {
      const result = await executeDcaResearchCore(payload);
      if (dcaResearchJob.abortRequested) {
        dcaResearchJob.phase = 'aborted';
        dcaResearchJob.message = 'Scan aborted';
        dcaResearchJob.error = 'Scan aborted by user';
      } else {
        dcaResearchJob.result = result;
        dcaResearchJob.phase = 'done';
        dcaResearchJob.progressPercent = 100;
        dcaResearchJob.message = `Done: ${result.viableCount} viable / ${result.candidatePoolSize} checked`;
      }
    } catch (error) {
      const msg = asString((error as Error).message, 'DCA scan failed');
      dcaResearchJob.error = msg;
      dcaResearchJob.phase = dcaResearchJob.abortRequested ? 'aborted' : 'error';
      dcaResearchJob.message = msg;
    } finally {
      dcaResearchJob.running = false;
      dcaResearchJob.finishedAt = Date.now();
      dcaResearchJob.abortRequested = false;
    }
  })();

  return getDcaResearchJobStatus();
};

/** @deprecated Use startDcaResearchJob + poll getDcaResearchJobStatus. Kept for internal sync callers. */
export const researchDcaForTsPortfolio = async (payload?: {
  systemName?: string;
  setKey?: string;
  apiKeyName?: string;
  dateFrom?: string;
  dateTo?: string;
  initialBalance?: number;
  maxCandidates?: number;
  dcaSettings?: DcaStrategySettings;
  autotune?: boolean;
}) => {
  if (dcaResearchJob.running) {
    throw new Error('DCA scan уже выполняется. Poll /admin/ts-dca-research-status for progress.');
  }
  return executeDcaResearchCore(payload);
};

export const applyDcaToTsPortfolio = async (payload?: {
  systemName?: string;
  setKey?: string;
  apiKeyName?: string;
  dateFrom?: string;
  dateTo?: string;
  initialBalance?: number;
  markets?: string[];
  maxApply?: number;
  dcaSettings?: DcaStrategySettings;
  marketTuning?: Record<string, Partial<DcaStrategySettings>>;
}) => {
  const ctx = await resolveDcaTsPickContext(payload);
  const requestedMarkets = Array.isArray(payload?.markets)
    ? payload.markets.map((item) => normalizeFullUsdtSymbol(String(item || ''))).filter(Boolean)
    : [];
  const maxApply = Math.max(1, Math.min(5, Math.floor(asNumber(payload?.maxApply, 2))));

  let marketsToApply = requestedMarkets.filter((market) => !ctx.occupiedMarkets.has(market));
  if (marketsToApply.length === 0) {
    const research = await researchDcaForTsPortfolio({
      ...payload,
      maxCandidates: 30,
    });
    marketsToApply = (research.top || [])
      .map((item) => item.market)
      .filter((market) => !ctx.occupiedMarkets.has(market))
      .slice(0, maxApply);
  } else {
    marketsToApply = marketsToApply.slice(0, maxApply);
  }

  if (marketsToApply.length === 0) {
    throw new Error('No suitable non-overlapping DCA pair found. Run research scan first.');
  }

  const candidateByMarket = new Map<string, Partial<DcaStrategySettings>>();
  const rawTuning = payload?.marketTuning;
  if (rawTuning && typeof rawTuning === 'object') {
    for (const [marketRaw, tuning] of Object.entries(rawTuning)) {
      const market = normalizeFullUsdtSymbol(marketRaw);
      if (market && tuning && typeof tuning === 'object') {
        candidateByMarket.set(market, tuning);
      }
    }
  }
  if (candidateByMarket.size === 0) {
    const research = await researchDcaForTsPortfolio({
      ...payload,
      maxCandidates: 40,
      autotune: true,
    });
    for (const item of research.candidates || []) {
      candidateByMarket.set(item.market, {
        interval: item.interval,
        detectionSource: item.detectionSource,
        stepPercent: item.stepPercent,
        tpPercent: item.tpPercent,
        slPercent: item.slPercent,
        entryFilter: item.entryFilter as DcaStrategySettings['entryFilter'],
      });
    }
  }

  const applied: Array<{
    market: string;
    strategyId: number;
    offerId: string;
    metrics?: { ret: number; dd: number; pf: number; trades: number };
  }> = [];
  const appliedStrategyIds: number[] = [...ctx.tsStrategyIds];
  const appliedMarkets = new Set(ctx.occupiedMarkets);

  for (const market of marketsToApply) {
    if (appliedMarkets.has(market)) {
      continue;
    }
    const cand = candidateByMarket.get(market);
    const marketSettings = normalizeDcaSettings({
      ...ctx.dcaSettings,
      ...(cand || {}),
    }, ctx.initialBalance);
    const created = await createDcaStrategyRecord(ctx.preferredApiKey, market, marketSettings, ctx.initialBalance);
    const scratchStrategyId = await getOrCreateDcaResearchScratchId(ctx.preferredApiKey, marketSettings);
    const scored = await scoreDcaCandidate({
      apiKeyName: ctx.preferredApiKey,
      market,
      scratchStrategyId,
      dcaSettings: marketSettings,
      previewDates: ctx.previewDates,
      initialBalance: ctx.initialBalance,
      sweep: ctx.sweep,
    });
    const offerId = `offer_mono_dca_${market.replace(/USDT$/, '').toLowerCase()}_${created.strategyId}`;
    applied.push({
      market,
      strategyId: created.strategyId,
      offerId,
      metrics: scored.error ? undefined : {
        ret: Number(scored.ret.toFixed(3)),
        dd: Number(scored.dd.toFixed(3)),
        pf: Number(scored.pf.toFixed(3)),
        trades: scored.trades,
      },
    });
    appliedStrategyIds.push(created.strategyId);
    appliedMarkets.add(market);

    const draftMembers = await getCuratedDraftMembers();
    const nextMembers = [
      ...draftMembers.filter((member) => Number(member.strategyId || 0) !== created.strategyId),
      {
        strategyId: created.strategyId,
        strategyName: `DCA ${market}`,
        strategyType: 'dca',
        marketMode: 'mono',
        market,
        score: Number(scored.score.toFixed(3)),
        weight: 0.85,
      },
    ];
    await setCuratedDraftMembers(nextMembers);
  }

  const masterSystemName = asString(payload?.systemName, asString(ctx.snapshot.systemName, '')).trim();
  if (masterSystemName && appliedStrategyIds.length > 0) {
    await syncMasterTradingSystemDcaMembers(masterSystemName, appliedStrategyIds).catch((error) => {
      logger.warn(`[applyDcaToTsPortfolio] master TS DCA member sync failed: ${(error as Error).message}`);
    });
  }

  const combinedResult = await runBacktest({
    ...buildDcaBacktestRequestBase(ctx.preferredApiKey, ctx, { enablePairLock: true }),
    mode: 'portfolio',
    strategyIds: appliedStrategyIds,
  } as BacktestRunRequest & { enablePairLock?: boolean });

  return {
    tsMarkets: Array.from(ctx.occupiedMarkets).sort(),
    period: {
      dateFrom: ctx.previewDates.dateFrom,
      dateTo: ctx.previewDates.dateTo,
      interval: ctx.dcaSettings.interval || asString(ctx.sweep?.config?.interval, '4h'),
    },
    dcaSettings: ctx.dcaSettings,
    applied,
    combinedPreview: {
      summary: combinedResult.summary,
      strategyIds: appliedStrategyIds,
      tradesCount: combinedResult.summary.tradesCount,
    },
  };
};

const findOrCreateDcaStrategyForMarket = async (
  apiKeyName: string,
  marketRaw: string,
  settings: NormalizedDcaSettings,
  initialBalance: number,
): Promise<number> => {
  const fullSymbol = normalizeFullUsdtSymbol(marketRaw);
  const row = await db.get<{ id: number }>(
    `SELECT s.id FROM strategies s
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE ak.name = ? AND s.name != ? AND lower(s.strategy_type) = 'dca'
       AND upper(s.base_symbol) = ? AND COALESCE(s.is_archived, 0) = 0
     ORDER BY s.id DESC LIMIT 1`,
    [apiKeyName, DCA_RESEARCH_SCRATCH_NAME, fullSymbol],
  );
  if (row?.id) {
    await configureDcaScratchForSymbol(Number(row.id), fullSymbol, settings, initialBalance);
    return Number(row.id);
  }
  const created = await createDcaStrategyRecord(apiKeyName, fullSymbol, settings, initialBalance);
  return created.strategyId;
};

/** Macro RSI shield: lock long profits when BTC/ETH overbought (research-backed on balanced-v2). */
export const DEFAULT_TS_MACRO_SHIELD_OVERLAY: MacroExitOverlay = {
  anchorInterval: '4h',
  rules: [
    {
      source: 'anchor',
      anchorSymbol: 'ETHUSDT',
      rsiPeriod: 14,
      longExitRsiAbove: 70,
      label: 'eth_tp',
    },
    {
      source: 'anchor',
      anchorSymbol: 'BTCUSDT',
      rsiPeriod: 14,
      longExitRsiAbove: 70,
      label: 'btc_tp',
    },
  ],
};

/** v2 card default: local pair RSI partial ~35% (Jun 2026 research). */
export const LOCAL_SELF_RSI_PARTIAL_MACRO_OVERLAY: MacroExitOverlay = {
  anchorInterval: '1h',
  rules: [],
  localSelf: {
    source: 'self',
    rsiPeriod: 14,
    fractalWings: 2,
    mode: 'partial',
    closeFraction: 0.35,
    combineWith: 'or',
    longExitRsiAbove: 70,
    shortExitRsiBelow: 20,
    shortExitRsiAbove: 70,
    label: 'local_rsi1h',
  },
};

/** Hybrid candidate: local partial + global 3/3 BTC+ETH+SOL (pending hybrid research). */
export const HYBRID_MACRO_EXIT_OVERLAY: MacroExitOverlay = {
  anchorInterval: '4h',
  rules: [],
  localSelf: LOCAL_SELF_RSI_PARTIAL_MACRO_OVERLAY.localSelf,
  globalVote: {
    minVotes: 3,
    anchors: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    rsiPeriod: 14,
    fractalWings: 2,
    mode: 'full',
    longExitRsiAbove: 70,
    longExitBearishFractal: true,
    shortExitRsiBelow: 20,
    shortExitRsiAbove: 70,
    shortExitBullishFractal: true,
    label: 'global_3of3',
  },
};

/** Default overlay for balanced-shield-dca-v2 card previews (swap to HYBRID after approval). */
export const SHIELD_V2_MACRO_EXIT_OVERLAY = LOCAL_SELF_RSI_PARTIAL_MACRO_OVERLAY;

export { DEFAULT_STAT_ARB_ENTRY_GATE };

const isV2SynthCardKey = (setKey: string, systemName: string): boolean => (
  /v2-synth/i.test(setKey) || /v2-synth/i.test(systemName)
);

export const resolvePreviewCardMechanics = async (params: {
  systemName?: string;
  setKey?: string;
  snapshot?: TsBacktestSnapshot | null;
  payloadMacroExitOverlay?: MacroExitOverlay;
  payloadStatArbEntryGate?: StatArbEntryGate;
  payloadMacroShield?: boolean;
}): Promise<{
  macroExitOverlay?: MacroExitOverlay;
  statArbEntryGate?: StatArbEntryGate;
}> => {
  const snapshot = params.snapshot || null;
  const dcaLayer = snapshot?.dcaLayer;
  const settingsRaw = (snapshot?.backtestSettings || {}) as Record<string, unknown>;
  const setKey = asString(params.setKey, asString(snapshot?.setKey, '')).trim();
  const systemName = asString(params.systemName, asString(snapshot?.systemName, '')).trim();

  let macroExitOverlay = params.payloadMacroExitOverlay
    || dcaLayer?.macroExitOverlay
    || parseMacroExitOverlayFromUnknown(settingsRaw.macroExitOverlay);
  let statArbEntryGate = params.payloadStatArbEntryGate
    || dcaLayer?.statArbEntryGate
    || parseStatArbEntryGateFromUnknown(settingsRaw.statArbEntryGate);

  if ((!macroExitOverlay || !statArbEntryGate) && systemName) {
    const cardMeta = await getMasterCardMetadataBySystemName(systemName);
    if (!macroExitOverlay) {
      macroExitOverlay = parseMacroExitOverlayFromUnknown(cardMeta?.macroExitOverlay);
    }
    if (!statArbEntryGate) {
      statArbEntryGate = parseStatArbEntryGateFromUnknown(cardMeta?.statArbEntryGate);
    }
  }

  const isV2Synth = isV2SynthCardKey(setKey, systemName);
  if (!macroExitOverlay && params.payloadMacroShield === true && !isV2Synth) {
    macroExitOverlay = DEFAULT_TS_MACRO_SHIELD_OVERLAY;
  }
  if (!macroExitOverlay && isV2Synth) {
    macroExitOverlay = SHIELD_V2_MACRO_EXIT_OVERLAY;
  }
  if (!statArbEntryGate && isV2Synth) {
    statArbEntryGate = DEFAULT_STAT_ARB_ENTRY_GATE;
  }

  return {
    ...(macroExitOverlay ? { macroExitOverlay } : {}),
    ...(statArbEntryGate ? { statArbEntryGate } : {}),
  };
};

export const parseCardMetadataOverridesBody = (
  raw: Record<string, unknown> | null | undefined,
): CardMetadataOverrides | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const out: CardMetadataOverrides = {};
  if (raw.lotPercentOverride !== undefined && Number.isFinite(Number(raw.lotPercentOverride))) {
    out.lotPercentOverride = Math.max(0, Number(raw.lotPercentOverride));
  }
  if (raw.maxOpenPositions !== undefined && Number.isFinite(Number(raw.maxOpenPositions))) {
    out.maxOpenPositions = Math.max(0, Math.floor(Number(raw.maxOpenPositions)));
  }
  if (raw.autoLotByChannelWidth !== undefined) {
    out.autoLotByChannelWidth = raw.autoLotByChannelWidth === true;
  }
  if (raw.dcaPerLegSl !== undefined) {
    out.dcaPerLegSl = raw.dcaPerLegSl === true;
  }
  if (raw.reinvestPercentOverride !== undefined && Number.isFinite(Number(raw.reinvestPercentOverride))) {
    out.reinvestPercentOverride = Math.min(100, Math.max(0, Number(raw.reinvestPercentOverride)));
  }
  if (raw.macroShield !== undefined) {
    out.macroShield = raw.macroShield === true;
  }
  if (raw.macroExitOverlay === null) {
    out.macroExitOverlay = null;
  } else if (raw.macroExitOverlay && typeof raw.macroExitOverlay === 'object') {
    out.macroExitOverlay = raw.macroExitOverlay as MacroExitOverlay;
  }
  if (raw.statArbEntryGate === null) {
    out.statArbEntryGate = null;
  } else if (raw.statArbEntryGate && typeof raw.statArbEntryGate === 'object') {
    out.statArbEntryGate = raw.statArbEntryGate as StatArbEntryGate;
  }
  if (typeof raw.tunePreset === 'string' && raw.tunePreset.trim()) {
    out.tunePreset = raw.tunePreset.trim();
  }
  if (raw.enablePairLock !== undefined) {
    out.enablePairLock = raw.enablePairLock === true;
  }
  if (Array.isArray(raw.dcaMarkets)) {
    out.dcaMarkets = Array.from(new Set(
      raw.dcaMarkets.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean),
    ));
  }
  if (raw.dcaEnabled !== undefined) {
    out.dcaEnabled = raw.dcaEnabled === true;
  }
  if (raw.portfolioCircuitBreaker === null) {
    out.portfolioCircuitBreaker = null;
  } else if (raw.portfolioCircuitBreaker && typeof raw.portfolioCircuitBreaker === 'object') {
    out.portfolioCircuitBreaker = raw.portfolioCircuitBreaker as PortfolioCircuitBreakerConfig;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

export const buildCardMechanicsOverridesFromSnapshot = (
  snapshot: TsBacktestSnapshot,
): CardMetadataOverrides => {
  const layer = snapshot.dcaLayer;
  const bs = snapshot.backtestSettings || {};
  const overrides: CardMetadataOverrides = {};
  if (Number.isFinite(Number(bs.reinvestPercent))) {
    overrides.reinvestPercentOverride = Math.min(100, Math.max(0, Number(bs.reinvestPercent)));
  }
  if (bs.autoLotByChannelWidth === true) {
    overrides.autoLotByChannelWidth = true;
  }
  if (bs.dcaPerLegSl === true || layer?.dcaPerLegSl === true) {
    overrides.dcaPerLegSl = true;
  }
  if (Number.isFinite(Number(bs.maxOpenPositions)) && Number(bs.maxOpenPositions) > 0) {
    overrides.maxOpenPositions = Math.floor(Number(bs.maxOpenPositions));
  }
  if (Number.isFinite(Number(bs.lotPercentOverride)) && Number(bs.lotPercentOverride) > 0) {
    overrides.lotPercentOverride = Number(bs.lotPercentOverride);
  }
  const overlay = layer?.macroExitOverlay || bs.macroExitOverlay;
  if (overlay) {
    overrides.macroExitOverlay = overlay;
    overrides.macroShield = true;
  } else if (snapshot.macroShield === true || bs.macroShield === true) {
    overrides.macroShield = true;
  }
  const gate = layer?.statArbEntryGate || bs.statArbEntryGate;
  if (gate) {
    overrides.statArbEntryGate = gate;
  }
  if (layer?.tunePreset) {
    overrides.tunePreset = layer.tunePreset;
  } else if (bs.preset) {
    overrides.tunePreset = bs.preset;
  }
  const markets = layer?.markets?.length ? layer.markets : snapshot.dcaMarkets;
  if (markets && markets.length > 0) {
    overrides.dcaMarkets = markets;
  }
  if (layer?.enabled === true || bs.dcaEnabled === true) {
    overrides.dcaEnabled = true;
  }
  if (bs.enablePairLock === true) {
    overrides.enablePairLock = true;
  }
  const pcb = parsePortfolioCircuitBreaker(bs.portfolioCircuitBreaker);
  if (pcb && pcb.enabled !== false) {
    overrides.portfolioCircuitBreaker = pcb;
  }
  return overrides;
};

export const previewDcaCombinedWithTs = async (payload?: {
  systemName?: string;
  setKey?: string;
  apiKeyName?: string;
  dateFrom?: string;
  dateTo?: string;
  initialBalance?: number;
  markets?: string[];
  maxOpenPositions?: number;
  enabled?: boolean;
  dcaSettings?: DcaStrategySettings;
  marketTuning?: Record<string, Partial<DcaStrategySettings>>;
  riskScore?: number;
  tradeFrequencyScore?: number;
  reinvestPercent?: number;
  riskScaleMaxPercent?: number;
  lotPercentOverride?: number;
  offerIds?: string[];
  offerWeightsById?: Record<string, number>;
  partialTpPct?: number;
  commissionPercent?: number;
  slippagePercent?: number;
  fundingRatePercent?: number;
  macroExitOverlay?: MacroExitOverlay;
  /** When true, applies DEFAULT_TS_MACRO_SHIELD_OVERLAY on TS + combined runs. */
  macroShield?: boolean;
  /** Fractal/RSI gate for stat_arb_zscore entries (v2 card). */
  statArbEntryGate?: StatArbEntryGate;
  /** BTC liquidity / order-block fade gate for all TS entries. */
  orderBlockEntryGate?: import('../bot/orderBlockLiquidity').OrderBlockEntryGate;
}) => {
  if (payload?.enabled === false) {
    return { enabled: false as const };
  }
  const ctx = await resolveDcaTsPickContext(payload);
  const markets = Array.from(new Set(
    (Array.isArray(payload?.markets) ? payload.markets : [])
      .map((item) => normalizeFullUsdtSymbol(String(item || '')))
      .filter((market) => market && !ctx.occupiedMarkets.has(market)),
  )).slice(0, 5);
  if (markets.length === 0) {
    throw new Error('Select at least one non-overlapping DCA market');
  }

  const tuningByMarket = new Map<string, Partial<DcaStrategySettings>>();
  const payloadMarketTuning = payload?.marketTuning && typeof payload.marketTuning === 'object'
    ? payload.marketTuning
    : undefined;
  const snapshotMarketTuning = ctx.snapshot.dcaLayer?.tuning;
  const effectiveMarketTuning = payloadMarketTuning || snapshotMarketTuning;
  if (effectiveMarketTuning && typeof effectiveMarketTuning === 'object') {
    for (const [marketRaw, tuning] of Object.entries(effectiveMarketTuning)) {
      const market = normalizeFullUsdtSymbol(marketRaw);
      if (market && tuning && typeof tuning === 'object') {
        tuningByMarket.set(market, tuning);
      }
    }
  }

  const dcaStrategyIds: number[] = [];
  for (const market of markets) {
    const perMarketSettings = normalizeDcaSettings(
      { ...ctx.dcaSettings, ...(tuningByMarket.get(market) || {}) },
      ctx.initialBalance,
    );
    dcaStrategyIds.push(await findOrCreateDcaStrategyForMarket(
      ctx.preferredApiKey,
      market,
      perMarketSettings,
      ctx.initialBalance,
    ));
  }

  const { catalog: sourceCatalog } = await loadCatalogAndSweepWithFallback();
  const apiKeys = await getAvailableApiKeyNames();
  const catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  const toFiniteOrNull = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const commissionPercentOverride = toFiniteOrNull(payload?.commissionPercent);
  const slippagePercentOverride = toFiniteOrNull(payload?.slippagePercent);
  const fundingRatePercentOverride = toFiniteOrNull(payload?.fundingRatePercent);
  const partialTpPct = Math.max(0, asNumber(payload?.partialTpPct, 0));
  const mechanics = await resolvePreviewCardMechanics({
    systemName: asString(payload?.systemName, asString(ctx.snapshot.systemName, '')),
    setKey: asString(payload?.setKey, asString(ctx.snapshot.setKey, '')),
    snapshot: ctx.snapshot,
    payloadMacroExitOverlay: payload?.macroExitOverlay,
    payloadStatArbEntryGate: payload?.statArbEntryGate,
    payloadMacroShield: payload?.macroShield,
  });
  const macroOverlay = mechanics.macroExitOverlay;
  const macroExtras = macroOverlay ? { macroExitOverlay: macroOverlay } : {};
  const statArbGate = mechanics.statArbEntryGate;
  const statArbGateExtras = statArbGate ? { statArbEntryGate: statArbGate } : {};
  const orderBlockGate = payload?.orderBlockEntryGate ?? undefined;
  const orderBlockGateExtras = orderBlockGate ? { orderBlockEntryGate: orderBlockGate } : {};
  const payloadOfferIds = Array.from(new Set(
    (Array.isArray(payload?.offerIds) ? payload.offerIds : ctx.offerIds)
      .map((item) => asString(item, '').trim())
      .filter(Boolean),
  ));
  const backtestBase = {
    ...buildDcaBacktestRequestBase(ctx.preferredApiKey, ctx, { enablePairLock: true }),
    commissionPercent: commissionPercentOverride !== null
      ? commissionPercentOverride
      : asNumber(ctx.sweep?.config?.commissionPercent, 0.1),
    slippagePercent: slippagePercentOverride !== null
      ? slippagePercentOverride
      : asNumber(ctx.sweep?.config?.slippagePercent, 0.05),
    fundingRatePercent: fundingRatePercentOverride !== null
      ? fundingRatePercentOverride
      : asNumber(ctx.sweep?.config?.fundingRatePercent, 0),
  };
  const maxOpenPositions = Math.max(0, Math.floor(asNumber(payload?.maxOpenPositions, 0)));
  const portfolioExtras = {
    ...(maxOpenPositions > 0 ? { maxOpenPositions } : {}),
    ...(partialTpPct > 0 ? { partialTpPct } : {}),
  };
  const adminEngineOverrides = await resolveAdminPreviewEngineOverridesForTsPortfolio({
    systemName: asString(payload?.systemName, asString(ctx.snapshot.systemName, '')),
    tsStrategyIds: ctx.tsStrategyIds,
    initialBalance: ctx.initialBalance,
    riskScore: payload?.riskScore,
    riskScaleMaxPercent: payload?.riskScaleMaxPercent,
    reinvestPercent: payload?.reinvestPercent,
    lotPercentOverride: payload?.lotPercentOverride,
    tradeFrequencyScore: payload?.tradeFrequencyScore,
    snapshot: ctx.snapshot,
    offerIds: payloadOfferIds,
    offerWeightsById: payload?.offerWeightsById,
    catalog,
  });
  const tsEngineExtras = {
    lotPercentOverride: adminEngineOverrides.lotPercentOverride,
    maxDepositOverride: adminEngineOverrides.maxDepositOverride,
    reinvestPercentOverride: adminEngineOverrides.reinvestPercentOverride,
    lotPercentMultiplierByStrategyId: adminEngineOverrides.lotPercentMultiplierByStrategyId,
  };
  const depositExtras = {
    maxDepositOverride: adminEngineOverrides.maxDepositOverride,
    reinvestPercentOverride: adminEngineOverrides.reinvestPercentOverride,
  };

  const tsOnlyRaw = await runBacktest({
    ...backtestBase,
    mode: 'portfolio',
    strategyIds: ctx.tsStrategyIds,
    ...portfolioExtras,
    ...tsEngineExtras,
    ...macroExtras,
    ...statArbGateExtras,
    ...orderBlockGateExtras,
  });
  const dcaOnlyRaw = await runBacktest({
    ...backtestBase,
    mode: 'portfolio',
    strategyIds: dcaStrategyIds,
    ...portfolioExtras,
    ...depositExtras,
  });
  const combinedRaw = await runBacktest({
    ...backtestBase,
    mode: 'portfolio',
    strategyIds: [...ctx.tsStrategyIds, ...dcaStrategyIds],
    ...portfolioExtras,
    ...tsEngineExtras,
    ...macroExtras,
    ...statArbGateExtras,
    ...orderBlockGateExtras,
  });

  const tsOnlySummary = applyAdminPreviewSummaryFromEquity(
    tsOnlyRaw.summary as Record<string, unknown>,
    tsOnlyRaw.equityCurve,
    ctx.initialBalance,
  );
  const dcaOnlySummary = applyAdminPreviewSummaryFromEquity(
    dcaOnlyRaw.summary as Record<string, unknown>,
    dcaOnlyRaw.equityCurve,
    ctx.initialBalance,
  );
  const combinedSummary = applyAdminPreviewSummaryFromEquity(
    combinedRaw.summary as Record<string, unknown>,
    combinedRaw.equityCurve,
    ctx.initialBalance,
  );

  return {
    enabled: true as const,
    period: {
      dateFrom: ctx.previewDates.dateFrom,
      dateTo: ctx.previewDates.dateTo,
      interval: ctx.dcaSettings.interval || asString(ctx.sweep?.config?.interval, '4h'),
      fullDepth: ctx.previewDates.usedFullSweepDepth === true,
    },
    markets,
    dcaStrategyIds,
    tsStrategyIds: ctx.tsStrategyIds,
    dcaSettings: ctx.dcaSettings,
    tsOnly: {
      summary: tsOnlySummary,
      equity: tsOnlyRaw.equityCurve,
    },
    dcaOnly: {
      summary: dcaOnlySummary,
      equity: dcaOnlyRaw.equityCurve,
    },
    combined: {
      summary: combinedSummary,
      equity: combinedRaw.equityCurve,
    },
    delta: {
      ret: Number((Number(combinedSummary.totalReturnPercent || 0) - Number(tsOnlySummary.totalReturnPercent || 0)).toFixed(3)),
      dd: Number((Number(combinedSummary.maxDrawdownPercent || 0) - Number(tsOnlySummary.maxDrawdownPercent || 0)).toFixed(3)),
      trades: Number(combinedRaw.summary.tradesCount || 0) - Number(tsOnlyRaw.summary.tradesCount || 0),
    },
    dcaLayer: {
      ret: Number(dcaOnlySummary.totalReturnPercent || 0),
      dd: Number(dcaOnlySummary.maxDrawdownPercent || 0),
      trades: Number(dcaOnlyRaw.summary.tradesCount || 0),
    },
    macroShield: Boolean(macroOverlay),
    statArbEntryGate: statArbGate || undefined,
    macroExitOverlay: macroOverlay || undefined,
  };
};

type DcaCombinedPreviewPayload = Parameters<typeof previewDcaCombinedWithTs>[0];

const DCA_COMBINED_PREVIEW_STALE_MS = 20 * 60 * 1000;

let dcaCombinedPreviewJob: {
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  requestKey: string;
  result: Awaited<ReturnType<typeof previewDcaCombinedWithTs>> | null;
  error: string | null;
} = {
  running: false,
  startedAt: 0,
  finishedAt: null,
  requestKey: '',
  result: null,
  error: null,
};

const buildDcaCombinedPreviewRequestKey = (payload: DcaCombinedPreviewPayload | undefined): string => (
  hashDcaCachePayload({ kind: 'dca_combined_preview', payload: payload || {} })
);

export const getDcaCombinedPreviewJobStatus = () => ({
  running: dcaCombinedPreviewJob.running,
  startedAt: dcaCombinedPreviewJob.startedAt > 0 ? new Date(dcaCombinedPreviewJob.startedAt).toISOString() : null,
  finishedAt: dcaCombinedPreviewJob.finishedAt ? new Date(dcaCombinedPreviewJob.finishedAt).toISOString() : null,
  requestKey: dcaCombinedPreviewJob.requestKey,
  result: dcaCombinedPreviewJob.result,
  error: dcaCombinedPreviewJob.error,
});

export const startDcaCombinedPreviewJob = async (payload?: DcaCombinedPreviewPayload) => {
  const requestKey = buildDcaCombinedPreviewRequestKey(payload);
  if (dcaCombinedPreviewJob.running) {
    const stale = dcaCombinedPreviewJob.startedAt > 0
      && Date.now() - dcaCombinedPreviewJob.startedAt > DCA_COMBINED_PREVIEW_STALE_MS;
    if (!stale && dcaCombinedPreviewJob.requestKey === requestKey) {
      return getDcaCombinedPreviewJobStatus();
    }
    if (stale) {
      logger.warn(`DCA combined preview stale lock cleared (was running ${Math.round((Date.now() - dcaCombinedPreviewJob.startedAt) / 1000)}s)`);
      dcaCombinedPreviewJob.running = false;
    }
  }

  dcaCombinedPreviewJob = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    requestKey,
    result: null,
    error: null,
  };

  void (async () => {
    try {
      dcaCombinedPreviewJob.result = await previewDcaCombinedWithTs(payload);
    } catch (error) {
      dcaCombinedPreviewJob.error = asString((error as Error).message, 'TS+DCA preview failed');
    } finally {
      dcaCombinedPreviewJob.running = false;
      dcaCombinedPreviewJob.finishedAt = Date.now();
    }
  })();

  return getDcaCombinedPreviewJobStatus();
};

export const pickDcaForTsPortfolio = async (payload?: {
  systemName?: string;
  setKey?: string;
  apiKeyName?: string;
  dateFrom?: string;
  dateTo?: string;
  maxCandidates?: number;
  initialBalance?: number;
  dcaSettings?: DcaStrategySettings;
}) => {
  const research = await researchDcaForTsPortfolio(payload);
  const best = (research.top || [])[0] || null;
  if (!best) {
    const errors = (research.candidates || [])
      .filter((item) => item.error)
      .slice(0, 3)
      .map((item) => `${item.market}: ${item.error}`)
      .join('; ');
    throw new Error(errors
      ? `No suitable non-overlapping DCA pair found. Sample errors: ${errors}`
      : 'No suitable non-overlapping DCA pair found');
  }

  const applied = await applyDcaToTsPortfolio({
    ...payload,
    markets: [best.market],
    maxApply: 1,
  });

  return {
    ...applied,
    picked: applied.applied.map((item) => ({
      baseSymbol: item.market.replace(/USDT$/, ''),
      market: item.market,
      strategyId: item.strategyId,
      offerId: item.offerId,
      metrics: item.metrics,
    })),
    candidatesTried: research.candidates.length,
    research,
  };
};

/**
 * Sync Cloud TS members from sweep backtest results.
 * For each Cloud TS with auto_sync_members=1, replace members with the strategy_ids
 * from the given selectedOffers. Each Cloud TS gets the same set of strategies
 * but keeps its own api_key association.
 */
export const syncCloudTsFromSweepResult = async (
  selectedOffers: Array<{ strategyId: number; offerId?: string; mode?: string; market?: string }>,
  options?: { dryRun?: boolean },
): Promise<{ updated: number; skipped: number; details: Array<{ systemId: number; systemName: string; memberCount: number; action: string }> }> => {
  const dryRun = options?.dryRun === true;
  const details: Array<{ systemId: number; systemName: string; memberCount: number; action: string }> = [];

  const strategyIds = selectedOffers
    .map((item) => Number(item.strategyId || 0))
    .filter((id) => id > 0);

  if (strategyIds.length === 0) {
    return { updated: 0, skipped: 0, details };
  }

  // Find all Cloud TS with auto_sync_members enabled (both legacy CLOUD% and unified ALGOFUND_MASTER::*::cloud-*)
  const cloudTs = await db.all(
    `SELECT ts.id, ts.name, ts.api_key_id, ak.name as api_key_name
     FROM trading_systems ts
     JOIN api_keys ak ON ak.id = ts.api_key_id
     WHERE (UPPER(ts.name) LIKE 'CLOUD%' OR LOWER(ts.name) LIKE '%::cloud-%')
       AND ts.is_active = 1
       AND ts.auto_sync_members = 1
     ORDER BY ts.id`
  ) as Array<{ id: number; name: string; api_key_id: number; api_key_name: string }>;

  if (cloudTs.length === 0) {
    return { updated: 0, skipped: 0, details };
  }

  let updated = 0;
  let skipped = 0;

  for (const ts of cloudTs) {
    const memberDrafts = strategyIds.map((strategyId, idx) => ({
      strategy_id: strategyId,
      weight: 1.0,
      member_role: 'member' as const,
      is_enabled: true,
      notes: `Cloud auto-sync from sweep at ${new Date().toISOString()}`,
    }));

    if (dryRun) {
      details.push({ systemId: ts.id, systemName: ts.name, memberCount: memberDrafts.length, action: 'dry-run' });
      skipped++;
      continue;
    }

    try {
      const result = await replaceTradingSystemMembersSafely(ts.api_key_name, ts.id, memberDrafts, {
        cancelRemovedOrders: true,
        closeRemovedPositions: true,
        syncMemberActivation: true,
      });
      const orch = result.orchestration as any;
      const closedCount = Number(orch?.closedPositions || 0);
      const removedCount = (orch?.removedStrategyIds || []).length;
      const actionMsg = `updated (removed=${removedCount}, closed_positions=${closedCount})`;
      details.push({ systemId: ts.id, systemName: ts.name, memberCount: memberDrafts.length, action: actionMsg });
      updated++;
      logger.info(`[Cloud TS Sync] Updated ${ts.name} (id=${ts.id}) with ${memberDrafts.length} members, closed ${closedCount} positions, removed ${removedCount} strategies`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      details.push({ systemId: ts.id, systemName: ts.name, memberCount: 0, action: `error: ${msg}` });
      skipped++;
      logger.error(`[Cloud TS Sync] Failed to update ${ts.name}: ${msg}`);
    }
  }

  return { updated, skipped, details };
};

export const getAdminReportSettings = async (): Promise<AdminReportSettings> => {
  const raw = await getRuntimeFlag('admin.reports.settings', JSON.stringify(DEFAULT_ADMIN_REPORT_SETTINGS));
  return normalizeAdminReportSettings(safeJsonParse<Record<string, unknown>>(raw, DEFAULT_ADMIN_REPORT_SETTINGS));
};

const OFFER_STORE_SNAPSHOT_REFRESH_STATE_KEY = 'offer.store.snapshot_refresh_state';

const DEFAULT_OFFER_STORE_SNAPSHOT_REFRESH_STATE: OfferStoreSnapshotRefreshState = {
  lastRunAt: '',
  lastSweepPath: '',
  lastSweepTimestamp: '',
  lastResult: 'idle',
  lastReason: '',
  lastError: '',
  systemsUpdated: 0,
  offersUpdated: 0,
  durationMs: 0,
};

const normalizeOfferStoreSnapshotRefreshState = (raw: unknown): OfferStoreSnapshotRefreshState => {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const resultRaw = String(parsed.lastResult || '').trim().toLowerCase();
  const lastResult: OfferStoreSnapshotRefreshState['lastResult'] = (
    resultRaw === 'success' || resultRaw === 'failed' || resultRaw === 'skipped' || resultRaw === 'idle'
      ? (resultRaw as OfferStoreSnapshotRefreshState['lastResult'])
      : 'idle'
  );

  return {
    lastRunAt: asString(parsed.lastRunAt, ''),
    lastSweepPath: asString(parsed.lastSweepPath, ''),
    lastSweepTimestamp: asString(parsed.lastSweepTimestamp, ''),
    lastResult,
    lastReason: asString(parsed.lastReason, ''),
    lastError: asString(parsed.lastError, ''),
    systemsUpdated: Math.max(0, Math.floor(asNumber(parsed.systemsUpdated, 0))),
    offersUpdated: Math.max(0, Math.floor(asNumber(parsed.offersUpdated, 0))),
    durationMs: Math.max(0, Math.floor(asNumber(parsed.durationMs, 0))),
  };
};

export const getOfferStoreSnapshotRefreshState = async (): Promise<OfferStoreSnapshotRefreshState> => {
  const raw = await getRuntimeFlag(
    OFFER_STORE_SNAPSHOT_REFRESH_STATE_KEY,
    JSON.stringify(DEFAULT_OFFER_STORE_SNAPSHOT_REFRESH_STATE),
  );
  return normalizeOfferStoreSnapshotRefreshState(
    safeJsonParse<Record<string, unknown>>(raw, DEFAULT_OFFER_STORE_SNAPSHOT_REFRESH_STATE),
  );
};

const setOfferStoreSnapshotRefreshState = async (state: OfferStoreSnapshotRefreshState): Promise<void> => {
  await setRuntimeFlag(OFFER_STORE_SNAPSHOT_REFRESH_STATE_KEY, JSON.stringify(state));
};

const resolveTsSnapshotKeyBySystemName = (
  map: Record<string, TsBacktestSnapshot>,
  systemName: string,
): string => {
  const normalizedSystemName = String(systemName || '').trim();
  if (!normalizedSystemName) {
    return '';
  }
  const exactEntry = Object.entries(map).find(([, snapshot]) => String(snapshot?.systemName || '').trim() === normalizedSystemName);
  if (exactEntry) {
    return String(exactEntry[0] || '').trim();
  }
  const exactKey = Object.keys(map).find((key) => String(key || '').trim() === normalizedSystemName);
  return String(exactKey || '').trim();
};

export const syncAllTenantStrategyMaxDeposit = async (): Promise<{ updated: number; checked: number; errors: string[] }> => {
  const errors: string[] = [];
  let updated = 0;
  let checked = 0;

  const tenants = (await db.all('SELECT * FROM tenants WHERE status = ?', ['active'])) as TenantRow[];

  for (const tenant of tenants) {
    try {
      const plan = await getPlanForTenant(tenant.id, 'algofund_client');
      if (!plan || !plan.max_deposit_total || plan.max_deposit_total <= 0) continue;

      const planMaxDeposit = Math.max(50, plan.max_deposit_total);

      // Determine API key name based on product mode
      let apiKeyName = '';
      if (tenant.product_mode === 'algofund_client' || tenant.product_mode === 'dual') {
        const profile = await getAlgofundProfile(tenant.id);
        if (profile) {
          apiKeyName = getAlgofundExecutionApiKeyName(tenant, profile);
        }
      }
      if (!apiKeyName && (tenant.product_mode === 'strategy_client' || tenant.product_mode === 'dual')) {
        apiKeyName = asString(tenant.assigned_api_key_name, '');
      }

      if (!apiKeyName) continue;

      const staleRows = await db.all(
        `SELECT s.id, s.max_deposit
         FROM strategies s
         JOIN api_keys ak ON ak.id = s.api_key_id
         WHERE ak.name = ? AND s.is_runtime = 1 AND s.is_archived = 0 AND s.max_deposit != ?`,
        [apiKeyName, planMaxDeposit]
      ) as Array<{ id: number; max_deposit: number }>;

      checked += 1;

      for (const row of staleRows) {
        await db.run('UPDATE strategies SET max_deposit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [planMaxDeposit, row.id]);
        updated += 1;
      }

      if (staleRows.length > 0) {
        logger.info(`[syncMaxDeposit] ${tenant.slug}: updated ${staleRows.length} strategies max_deposit ${staleRows[0].max_deposit} -> ${planMaxDeposit}`);
      }
    } catch (err) {
      errors.push(`${tenant.slug}: ${(err as Error).message}`);
    }
  }

  logger.info(`[syncMaxDeposit] done: checked=${checked} updated=${updated} errors=${errors.length}`);
  return { updated, checked, errors };
};

export const refreshOfferStoreSnapshotsFromSweep = async (options?: {
  force?: boolean;
  reason?: string;
  sweepTimestamp?: string;
}): Promise<OfferStoreSnapshotRefreshResult> => {
  const startedAtMs = Date.now();
  const reason = asString(options?.reason, 'manual').trim() || 'manual';
  const [settings, prevState] = await Promise.all([
    getAdminReportSettings(),
    getOfferStoreSnapshotRefreshState(),
  ]);

  const sweepPath = asString(getLatestSweepPath(), '');
  const sweepTimestamp = asString(options?.sweepTimestamp, '') || asString(loadLatestSweep()?.timestamp, '');

  if (!options?.force && !settings.sweepSnapshotAutoRefreshEnabled) {
    const state: OfferStoreSnapshotRefreshState = {
      ...prevState,
      lastRunAt: new Date().toISOString(),
      lastSweepPath: sweepPath,
      lastSweepTimestamp: sweepTimestamp,
      lastResult: 'skipped',
      lastReason: `${reason}:disabled`,
      lastError: '',
      systemsUpdated: 0,
      offersUpdated: 0,
      durationMs: Date.now() - startedAtMs,
    };
    await setOfferStoreSnapshotRefreshState(state);
    return {
      ok: true,
      skipped: true,
      reason: 'auto refresh disabled in settings',
      settings,
      state,
      systemsUpdated: 0,
      offersUpdated: 0,
      errors: [],
    };
  }

  const intervalMs = Math.max(1, settings.sweepSnapshotRefreshHours) * 3_600_000;
  const prevRunAtMs = Date.parse(prevState.lastRunAt || '');
  const sameSweep = Boolean(
    sweepTimestamp
    && prevState.lastSweepTimestamp
    && sweepTimestamp === prevState.lastSweepTimestamp,
  );
  const tooSoon = Number.isFinite(prevRunAtMs) && (Date.now() - prevRunAtMs) < intervalMs;
  if (!options?.force && sameSweep && tooSoon) {
    const state: OfferStoreSnapshotRefreshState = {
      ...prevState,
      lastRunAt: new Date().toISOString(),
      lastSweepPath: sweepPath,
      lastSweepTimestamp: sweepTimestamp,
      lastResult: 'skipped',
      lastReason: `${reason}:interval`,
      lastError: '',
      systemsUpdated: 0,
      offersUpdated: 0,
      durationMs: Date.now() - startedAtMs,
    };
    await setOfferStoreSnapshotRefreshState(state);
    return {
      ok: true,
      skipped: true,
      reason: 'interval window not reached for unchanged sweep',
      settings,
      state,
      systemsUpdated: 0,
      offersUpdated: 0,
      errors: [],
    };
  }

  const errors: string[] = [];
  let systemsUpdated = 0;
  let offersUpdated = 0;

  try {
    const [offerStore, reviewSnapshots, tsSnapshotMap, legacySnapshot] = await Promise.all([
      getOfferStoreAdminState(),
      getOfferReviewSnapshots(),
      getTsBacktestSnapshots(),
      getTsBacktestSnapshot(),
    ]);

    const nextReviewSnapshots: Record<string, OfferReviewSnapshot> = {
      ...reviewSnapshots,
    };
    const storefrontOffers = getStorefrontOfferIds(offerStore);
    for (const offer of (offerStore.offers || [])) {
      const offerId = String(offer.offerId || '').trim();
      if (!offerId || !storefrontOffers.has(offerId)) {
        continue;
      }
      const prev = nextReviewSnapshots[offerId] || null;
      const normalized = normalizeOfferReviewSnapshot(offerId, {
        ...(prev || {}),
        offerId,
        ret: Number(offer.ret || 0),
        pf: Number(offer.pf || 0),
        dd: Number(offer.dd || 0),
        trades: Number(offer.trades || 0),
        tradesPerDay: Number(offer.tradesPerDay || 0),
        periodDays: Number(offer.periodDays || prev?.periodDays || offerStore.defaults.periodDays || 90),
        equityPoints: Array.isArray(offer.equityPoints) ? offer.equityPoints : (prev?.equityPoints || []),
        updatedAt: new Date().toISOString(),
      });
      if (normalized) {
        nextReviewSnapshots[offerId] = normalized;
        offersUpdated += 1;
      }
    }

    const nextTsSnapshotMap: Record<string, TsBacktestSnapshot> = {
      ...tsSnapshotMap,
    };
    const candidateSystemNames = new Set<string>();
    Object.values(nextTsSnapshotMap).forEach((snapshot) => {
      const name = String(snapshot?.systemName || '').trim();
      if (name.toUpperCase().startsWith('ALGOFUND_MASTER::')) {
        candidateSystemNames.add(name);
      }
    });
    const legacySystemName = String(legacySnapshot?.systemName || '').trim();
    if (legacySystemName.toUpperCase().startsWith('ALGOFUND_MASTER::')) {
      candidateSystemNames.add(legacySystemName);
    }

    const tenantRows = await db.all(
      `SELECT DISTINCT COALESCE(published_system_name, '') AS system_name
       FROM algofund_profiles
       WHERE TRIM(COALESCE(published_system_name, '')) != ''`
    ) as Array<{ system_name?: string }>;
    tenantRows.forEach((row) => {
      const name = String(row?.system_name || '').trim();
      if (name.toUpperCase().startsWith('ALGOFUND_MASTER::')) {
        candidateSystemNames.add(name);
      }
    });

    for (const systemName of Array.from(candidateSystemNames)) {
      const existingKey = resolveTsSnapshotKeyBySystemName(nextTsSnapshotMap, systemName) || systemName;
      const existing = nextTsSnapshotMap[existingKey] || null;
      try {
        const existingSettingsRaw = existing?.backtestSettings || {};
        const existingSettings = existingSettingsRaw as Record<string, unknown>;
        const hasCustomAdminTuning = (
          Number(existingSettings.reinvestPercent ?? 0) > 0
          || Number(existingSettings.lotPercentOverride ?? 0) > 0
          || Number(existingSettings.maxOpenPositions ?? 0) > 0
          || Number(existingSettings.partialTpPct ?? 0) > 0
        );
        if (hasCustomAdminTuning) {
          // Admin «Сохранить» with reinvest/lot/OP — do not clobber with lightweight sweep preview.
          continue;
        }

        const preview = await previewAdminSweepBacktest({
          kind: 'algofund-ts',
          systemName,
          setKey: asString(existing?.setKey, existingKey),
          offerIds: Array.isArray(existing?.offerIds)
            ? existing.offerIds.map((item) => asString(item, '').trim()).filter(Boolean)
            : undefined,
          riskScore: Number(existingSettings.riskScore ?? 5),
          tradeFrequencyScore: Number(existingSettings.tradeFrequencyScore ?? 5),
          initialBalance: Number(existingSettings.initialBalance ?? 10000),
          riskScaleMaxPercent: Number(existingSettings.riskScaleMaxPercent ?? 100),
          reinvestPercent: Number(existingSettings.reinvestPercent ?? 0),
          maxOpenPositions: Number(existingSettings.maxOpenPositions ?? 0),
          lotPercentOverride: Number(existingSettings.lotPercentOverride ?? 0),
          partialTpPct: Number(existingSettings.partialTpPct ?? 0),
          isBatchRefresh: true,
        });

        const summary = preview.preview?.summary || {};
        const equityPoints = Array.isArray(preview.preview?.equity)
          ? (preview.preview?.equity || [])
            .map((point) => Number((point as any)?.equity ?? (point as any)?.value ?? NaN))
            .filter((value) => Number.isFinite(value))
          : [];
        const selectedOffers = Array.isArray(preview.selectedOffers) ? preview.selectedOffers : [];
        const offerIds = Array.from(new Set(selectedOffers.map((item) => String((item as any)?.offerId || '').trim()).filter(Boolean)));
        const previewPeriodFrom = asString((preview.period as Record<string, unknown> | undefined)?.dateFrom, '').slice(0, 10);
        const previewPeriodTo = asString((preview.period as Record<string, unknown> | undefined)?.dateTo, '').slice(0, 10);
        let periodDays = Math.max(1, Math.floor(getSweepPeriodDays(loadLatestSweep(), 365)));
        if (/^\d{4}-\d{2}-\d{2}$/.test(previewPeriodFrom) && /^\d{4}-\d{2}-\d{2}$/.test(previewPeriodTo)) {
          const fromMs = Date.parse(previewPeriodFrom);
          const toMs = Date.parse(previewPeriodTo);
          if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
            periodDays = Math.max(1, Math.floor((toMs - fromMs) / 86400000));
          }
        }

        const normalized = normalizeTsBacktestSnapshot({
          ...(existing || {}),
          apiKeyName: asString(preview.sweepApiKeyName, existing?.apiKeyName || ''),
          systemName,
          setKey: asString(existing?.setKey, systemName),
          // Preserve human display label across refreshes; never overwrite it
          // with the canonical autogenerated systemName.
          ...(asString(existing?.displayLabel, '').trim()
            ? { displayLabel: asString(existing?.displayLabel, '').trim() }
            : {}),
          ret: Number(summary.totalReturnPercent || 0),
          pf: Number(summary.profitFactor || 0),
          dd: Number(summary.maxDrawdownPercent || 0),
          winRate: Number(summary.winRatePercent || 0),
          trades: Number(summary.tradesCount || 0),
          tradesPerDay: Number(
            ((Number(summary.tradesCount || 0)) / periodDays).toFixed(3)
          ),
          periodDays,
          finalEquity: Number(summary.finalEquity || existing?.finalEquity || 0),
          equityPoints,
          offerIds,
          backtestSettings: {
            ...(existingSettings || {}),
            riskScore: Number(existingSettings.riskScore ?? 5),
            tradeFrequencyScore: Number(existingSettings.tradeFrequencyScore ?? 5),
            initialBalance: Number(existingSettings.initialBalance ?? 10000),
            riskScaleMaxPercent: Number(existingSettings.riskScaleMaxPercent ?? 100),
            dateFrom: asString((preview.period as Record<string, unknown> | undefined)?.dateFrom, previewPeriodFrom),
            dateTo: asString((preview.period as Record<string, unknown> | undefined)?.dateTo, previewPeriodTo),
            interval: asString((preview.period as Record<string, unknown> | undefined)?.interval, asString(existingSettings.interval, '4h')),
          },
          updatedAt: new Date().toISOString(),
        });
        if (normalized) {
          nextTsSnapshotMap[existingKey] = normalized;
          systemsUpdated += 1;
        }
      } catch (error) {
        const err = error as Error;
        const msg = `[${systemName}] ${err.message}`;
        errors.push(msg);
        logger.warn(`[snapshot-refresh] ${msg}`);
      }
    }

    await setRuntimeFlags({
      'offer.store.review_snapshots': JSON.stringify(nextReviewSnapshots),
      'offer.store.ts_backtest_snapshots': JSON.stringify(nextTsSnapshotMap),
    });

    const state: OfferStoreSnapshotRefreshState = {
      lastRunAt: new Date().toISOString(),
      lastSweepPath: sweepPath,
      lastSweepTimestamp: sweepTimestamp,
      lastResult: errors.length > 0 ? 'failed' : 'success',
      lastReason: reason,
      lastError: errors.length > 0 ? errors.join('; ').slice(0, 800) : '',
      systemsUpdated,
      offersUpdated,
      durationMs: Date.now() - startedAtMs,
    };
    await setOfferStoreSnapshotRefreshState(state);

    return {
      ok: errors.length === 0,
      skipped: false,
      reason,
      settings,
      state,
      systemsUpdated,
      offersUpdated,
      errors,
    };
  } catch (error) {
    const err = error as Error;
    const state: OfferStoreSnapshotRefreshState = {
      ...prevState,
      lastRunAt: new Date().toISOString(),
      lastSweepPath: sweepPath,
      lastSweepTimestamp: sweepTimestamp,
      lastResult: 'failed',
      lastReason: reason,
      lastError: err.message,
      systemsUpdated,
      offersUpdated,
      durationMs: Date.now() - startedAtMs,
    };
    await setOfferStoreSnapshotRefreshState(state);
    return {
      ok: false,
      skipped: false,
      reason,
      settings,
      state,
      systemsUpdated,
      offersUpdated,
      errors: [err.message],
    };
  }
};

export const getHighTradeRecommendations = async (options?: {
  minProfitFactor?: number;
  maxDrawdownPercent?: number;
  minReturnPercent?: number;
  limit?: number;
}): Promise<HighTradeRecommendationResponse> => {
  const minProfitFactor = Math.max(0, asNumber(options?.minProfitFactor, 1.02));
  const maxDrawdownPercent = Math.max(0, asNumber(options?.maxDrawdownPercent, 28));
  const minReturnPercent = asNumber(options?.minReturnPercent, 3);
  const limit = Math.max(1, Math.min(20, Math.floor(asNumber(options?.limit, 8))));

  const sweep = loadLatestSweep();
  const rows = Array.isArray(sweep?.evaluated) ? sweep?.evaluated || [] : [];
  const filtered = rows
    .filter((row) => asNumber(row.profitFactor, 0) >= minProfitFactor)
    .filter((row) => asNumber(row.maxDrawdownPercent, 999) <= maxDrawdownPercent)
    .filter((row) => asNumber(row.totalReturnPercent, -999) >= minReturnPercent)
    .sort((left, right) => {
      const tradeDiff = asNumber(right.tradesCount, 0) - asNumber(left.tradesCount, 0);
      if (tradeDiff !== 0) {
        return tradeDiff;
      }
      const pfDiff = asNumber(right.profitFactor, 0) - asNumber(left.profitFactor, 0);
      if (pfDiff !== 0) {
        return pfDiff;
      }
      return asNumber(right.score, 0) - asNumber(left.score, 0);
    });

  const deduped: SweepRecord[] = [];
  const seenMarkets = new Set<string>();
  for (const row of filtered) {
    const marketKey = `${asString(row.marketMode, '')}|${asString(row.market, '')}|${asString(row.strategyType, '')}`;
    if (seenMarkets.has(marketKey)) {
      continue;
    }
    seenMarkets.add(marketKey);
    deduped.push(row);
    if (deduped.length >= limit) {
      break;
    }
  }

  const offers: HighTradeRecommendation[] = deduped.map((row) => ({
    strategyId: Number(row.strategyId || 0),
    strategyName: asString(row.strategyName, `Strategy ${row.strategyId}`),
    strategyType: asString(row.strategyType, ''),
    marketMode: asString(row.marketMode, ''),
    market: asString(row.market, ''),
    interval: asString(row.interval, ''),
    totalReturnPercent: asNumber(row.totalReturnPercent, 0),
    maxDrawdownPercent: asNumber(row.maxDrawdownPercent, 0),
    winRatePercent: asNumber(row.winRatePercent, 0),
    profitFactor: asNumber(row.profitFactor, 0),
    tradesCount: Math.max(0, Math.floor(asNumber(row.tradesCount, 0))),
    score: asNumber(row.score, 0),
    robust: Boolean(row.robust),
  }));

  const tsMembers = offers.slice(0, Math.min(5, offers.length)).map((item, index) => ({
    ...item,
    weight: Number((index === 0 ? 1.15 : index === 1 ? 1.05 : 0.9).toFixed(2)),
    memberRole: index < 2 ? 'core' : 'satellite',
  }));

  const recommendedTradingSystem = tsMembers.length > 0 ? {
    name: 'HIGH-TRADE CURATED TS',
    selectionPolicy: 'max trades with acceptable pf/dd',
    members: tsMembers,
    aggregate: {
      tradesCount: tsMembers.reduce((sum, item) => sum + item.tradesCount, 0),
      avgProfitFactor: Number((tsMembers.reduce((sum, item) => sum + item.profitFactor, 0) / tsMembers.length).toFixed(3)),
      avgReturnPercent: Number((tsMembers.reduce((sum, item) => sum + item.totalReturnPercent, 0) / tsMembers.length).toFixed(3)),
      avgDrawdownPercent: Number((tsMembers.reduce((sum, item) => sum + item.maxDrawdownPercent, 0) / tsMembers.length).toFixed(3)),
    },
  } : null;

  return {
    generatedAt: new Date().toISOString(),
    sourceSweepTimestamp: sweep?.timestamp || null,
    filters: {
      minProfitFactor,
      maxDrawdownPercent,
      minReturnPercent,
      limit,
    },
    offers,
    recommendedTradingSystem,
  };
};

export const getCuratedDraftMembers = async (): Promise<CatalogData['adminTradingSystemDraft']['members']> => {
  const raw = await getRuntimeFlag('admin.catalog.extra_draft_members', '[]');
  return safeJsonParse<CatalogData['adminTradingSystemDraft']['members']>(raw, []);
};

export const setCuratedDraftMembers = async (
  members: CatalogData['adminTradingSystemDraft']['members'],
): Promise<CatalogData['adminTradingSystemDraft']['members']> => {
  const normalized = (Array.isArray(members) ? members : []).map((m, index) => ({
    strategyId: Math.max(0, Math.floor(Number(m.strategyId || 0))),
    strategyName: asString(m.strategyName, `Strategy ${m.strategyId}`),
    strategyType: asString(m.strategyType, 'DD_BattleToads'),
    marketMode: asString(m.marketMode, 'mono'),
    market: asString(m.market, ''),
    score: asNumber(m.score, 0),
    weight: asNumber(m.weight, index === 0 ? 1.15 : index === 1 ? 1.05 : 0.9),
  })).filter((m) => m.strategyId > 0);
  await setRuntimeFlag('admin.catalog.extra_draft_members', JSON.stringify(normalized));
  return normalized;
};

export const updateAdminReportSettings = async (payload: Partial<AdminReportSettings>): Promise<AdminReportSettings> => {
  const current = await getAdminReportSettings();
  const next = normalizeAdminReportSettings({
    ...current,
    ...(payload || {}),
  });
  await setRuntimeFlag('admin.reports.settings', JSON.stringify(next));
  return getAdminReportSettings();
};

export const getAdminPerformanceReport = async (period: 'daily' | 'weekly' | 'monthly' = 'daily') => {
  const periodHours = period === 'monthly' ? 24 * 30 : period === 'weekly' ? 24 * 7 : 24;
  const now = Date.now();
  const fromMs = now - periodHours * 3600_000;
  const [offerStore, reportSettings, apiKeys] = await Promise.all([
    getOfferStoreAdminState(),
    getAdminReportSettings(),
    getAvailableApiKeyNames(),
  ]);

  const tsRows: Array<Record<string, unknown>> = [];
  for (const apiKeyName of apiKeys) {
    const systems = await listTradingSystems(apiKeyName).catch(() => []);
    for (const item of (Array.isArray(systems) ? systems : [])) {
      tsRows.push({
        apiKeyName,
        id: Number(item?.id || 0),
        name: asString(item?.name, ''),
        isActive: Boolean(item?.is_active),
        equityUsd: asNumber(item?.metrics?.equity_usd, 0),
        unrealizedPnl: asNumber(item?.metrics?.unrealized_pnl, 0),
        drawdownPercent: asNumber(item?.metrics?.drawdown_percent, 0),
        marginLoadPercent: asNumber(item?.metrics?.margin_load_percent, 0),
        effectiveLeverage: asNumber(item?.metrics?.effective_leverage, 0),
        updatedAt: asString(item?.updated_at, ''),
      });
    }
  }

  const offerRows: Array<Record<string, unknown>> = [];
  for (const offer of offerStore.offers) {
    const strategyId = Number(offer.strategyId || 0);
    const metrics = strategyId > 0
      ? await computeReconciliationMetrics(strategyId, fromMs, now).catch(() => null)
      : null;
    const liveWinRatePercent = metrics ? Number((Number(metrics.win_rate_live || 0) * 100).toFixed(3)) : null;
    const expectedWinRatePercent = metrics ? Number((Number(metrics.win_rate_backtest || 0) * 100).toFixed(3)) : null;
    offerRows.push({
      offerId: offer.offerId,
      titleRu: offer.titleRu,
      strategyId,
      mode: offer.mode,
      market: offer.market,
      curated: offer.curated,
      publishedExplicitly: offer.publishedExplicitly,
      periodDays: offer.periodDays,
      expected: {
        ret: offer.ret,
        pf: offer.pf,
        dd: offer.dd,
        trades: offer.trades,
        tradesPerDay: offer.tradesPerDay,
      },
      live: metrics ? {
        samples: Number(metrics.samples_count || 0),
        entryPriceDeviationPercent: Number((Number(metrics.entry_price_deviation_percent || 0) * 100).toFixed(3)),
        entryLagSeconds: Number(Number(metrics.entry_time_lag_seconds || 0).toFixed(3)),
        realizedVsPredictedPnlPercent: Number((Number(metrics.realized_vs_predicted_pnl_percent || 0) * 100).toFixed(3)),
        winRatePercent: liveWinRatePercent,
      } : null,
      comparison: metrics ? {
        expectedWinRatePercent,
        liveWinRatePercent,
        winRateDeltaPercent: liveWinRatePercent !== null && expectedWinRatePercent !== null
          ? Number((liveWinRatePercent - expectedWinRatePercent).toFixed(3))
          : null,
      } : null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    period,
    periodHours,
    settings: reportSettings,
    tradingSystems: tsRows,
    offers: offerRows,
  };
};

export const getAdminLowLotRecommendations = async (options?: {
  hours?: number;
  limit?: number;
  perStrategyReplacementLimit?: number;
}): Promise<{ generatedAt: string; periodHours: number; items: LowLotRecommendation[] }> => {
  const periodHours = Math.max(1, Math.floor(Number(options?.hours || 72) || 72));
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options?.limit || 50) || 50)));
  const replLimit = Math.max(1, Math.min(5, Math.floor(Number(options?.perStrategyReplacementLimit || 3) || 3)));
  const lowLotActiveByStrategyId = new Map<number, boolean>();

  const isStrategyLowLotActive = async (strategyId: number): Promise<boolean> => {
    const sid = Math.max(0, Math.floor(Number(strategyId || 0)));
    if (!sid) {
      return false;
    }
    if (lowLotActiveByStrategyId.has(sid)) {
      return Boolean(lowLotActiveByStrategyId.get(sid));
    }

    const latest = await db.get(
      `SELECT event_type, resolved_at
       FROM strategy_runtime_events
       WHERE strategy_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [sid]
    ) as { event_type?: string; resolved_at?: number } | undefined;

    const active = String(latest?.event_type || '') === 'low_lot_error'
      && Number(latest?.resolved_at || 0) === 0;
    lowLotActiveByStrategyId.set(sid, active);
    return active;
  };

  // ── Helper: build one recommendation item from a strategy row ─────────────
  const buildItem = async (
    row: Record<string, unknown>,
    source: LowLotRecommendation['eventSource']
  ): Promise<LowLotRecommendation> => {
    const apiKeyId = Number(row.api_key_id || 0);
    const apiKeyName = String(row.api_key_name || '');
    const strategyId = Number(row.strategy_id || 0);
    const strategyName = String(row.strategy_name || '');
    const mode = String(row.market_mode || 'synthetic');
    const base = String(row.base_symbol || '').toUpperCase();
    const quote = String(row.quote_symbol || '').toUpperCase();
    const pair = quote ? `${base}/${quote}` : base;
    const maxDeposit = Math.max(0, Number(row.max_deposit || 0));
    const leverage = Math.max(0, Number(row.leverage || 0));
    const lotPercent = Math.max(0, Number(row.lot_long_percent || 0), Number(row.lot_short_percent || 0));
    const lastError = String(row.last_error || '').trim();
    const updatedAt = String(row.updated_at || '');
    const systemId = row.system_id != null ? Number(row.system_id) : null;

    const tenantRows = await db.all(
      'SELECT id, slug, display_name, product_mode FROM tenants WHERE assigned_api_key_name = ? ORDER BY id ASC',
      [apiKeyName]
    );
    const replacementRows: any[] = apiKeyId > 0
      ? await db.all(
          'SELECT symbol, score, details_json FROM liquidity_scan_suggestions WHERE api_key_id = ? AND status IN ('+("'"+'new'+"'"+', '+"'"+'approved'+"'")+') AND (symbol = ? OR symbol = ?) ORDER BY score DESC, created_at DESC LIMIT ?',
          [apiKeyId, base, quote, replLimit]
        )
      : [];

    return {
      apiKeyName,
      strategyId,
      strategyName,
      pair,
      mode,
      maxDeposit,
      leverage,
      lotPercent,
      lastError,
      updatedAt,
      systemId,
      eventSource: source,
      tenants: (Array.isArray(tenantRows) ? tenantRows : []).map((t: any) => ({
        id: Number(t.id),
        slug: String(t.slug || ''),
        displayName: String(t.display_name || ''),
        mode: String(t.product_mode || 'strategy_client') as ProductMode,
      })),
      suggestedDepositMin: Math.max(100, Number((maxDeposit * 1.25).toFixed(2))),
      suggestedLotPercent: lotPercent < 20 ? 20 : Math.min(60, lotPercent + 10),
      replacementCandidates: (Array.isArray(replacementRows) ? replacementRows : []).map((c: any) => {
        let note = '';
        try {
          const d = JSON.parse(String(c.details_json || '{}')) as Record<string, unknown>;
          note = String(d.reason || d.note || d.message || '').trim();
        } catch { note = ''; }
        return { symbol: String(c.symbol || ''), score: Number(c.score || 0), note };
      }),
    };
  };

  // ── Source 1: strategies with current last_error ───────────────────────────
  const seenStrategyIds = new Set<number>();
  const items: LowLotRecommendation[] = [];

  const lastErrorRows = await db.all(
    `SELECT
       a.id AS api_key_id, a.name AS api_key_name,
       s.id AS strategy_id, s.name AS strategy_name,
       COALESCE(s.market_mode, 'synthetic') AS market_mode,
       COALESCE(s.base_symbol, '') AS base_symbol,
       COALESCE(s.quote_symbol, '') AS quote_symbol,
       COALESCE(s.max_deposit, 0) AS max_deposit,
       COALESCE(s.leverage, 1) AS leverage,
       COALESCE(s.lot_long_percent, 0) AS lot_long_percent,
       COALESCE(s.lot_short_percent, 0) AS lot_short_percent,
       COALESCE(s.last_error, '') AS last_error,
       COALESCE(s.updated_at, '') AS updated_at,
       (SELECT tsm.system_id FROM trading_system_members tsm WHERE tsm.strategy_id = s.id ORDER BY tsm.id ASC LIMIT 1) AS system_id
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE COALESCE(s.last_error, '') <> ''
       AND COALESCE(s.is_active, 0) = 1
       AND datetime(s.updated_at) >= datetime('now', ?)
       AND lower(s.last_error) LIKE '%order size too small%'
     ORDER BY datetime(s.updated_at) DESC
     LIMIT ?`,
    [`-${periodHours} hours`, limit]
  );
  for (const row of Array.isArray(lastErrorRows) ? lastErrorRows : []) {
    const sid = Number((row as any).strategy_id || 0);
    if (!sid || seenStrategyIds.has(sid)) continue;
    if (!(await isStrategyLowLotActive(sid))) continue;
    seenStrategyIds.add(sid);
    items.push(await buildItem(row as Record<string, unknown>, 'last_error'));
  }

  // ── Source 2: recent runtime events (low_lot_error, unresolved) ───────────
  const eventRows = await db.all(
    `WITH ranked AS (
       SELECT
         e.strategy_id,
         e.api_key_name,
         e.message AS last_error,
         datetime(e.created_at / 1000, 'unixepoch') AS updated_at,
         e.created_at,
         e.event_type,
         e.resolved_at,
         a.id AS api_key_id,
         COALESCE(s.market_mode, 'synthetic') AS market_mode,
         COALESCE(s.base_symbol, '') AS base_symbol,
         COALESCE(s.quote_symbol, '') AS quote_symbol,
         COALESCE(s.max_deposit, 0) AS max_deposit,
         COALESCE(s.leverage, 1) AS leverage,
         COALESCE(s.lot_long_percent, 0) AS lot_long_percent,
         COALESCE(s.lot_short_percent, 0) AS lot_short_percent,
         COALESCE(s.name, e.strategy_name) AS strategy_name,
         (SELECT tsm.system_id FROM trading_system_members tsm WHERE tsm.strategy_id = e.strategy_id ORDER BY tsm.id ASC LIMIT 1) AS system_id,
         ROW_NUMBER() OVER (PARTITION BY e.strategy_id ORDER BY e.created_at DESC) AS rn
       FROM strategy_runtime_events e
       LEFT JOIN strategies s ON s.id = e.strategy_id
       LEFT JOIN api_keys a ON a.name = e.api_key_name
       WHERE COALESCE(s.is_active, 0) = 1
         AND lower(COALESCE(s.last_error, '')) LIKE '%order size too small%'
         AND e.created_at >= ?
     )
     SELECT
       strategy_id,
       api_key_name,
       last_error,
       updated_at,
       api_key_id,
       market_mode,
       base_symbol,
       quote_symbol,
       max_deposit,
       leverage,
       lot_long_percent,
       lot_short_percent,
       strategy_name,
       system_id
     FROM ranked
     WHERE rn = 1
       AND event_type = 'low_lot_error'
       AND resolved_at = 0
     ORDER BY created_at DESC
     LIMIT ?`,
    [Date.now() - periodHours * 3600_000, limit]
  );
  for (const row of Array.isArray(eventRows) ? eventRows : []) {
    const sid = Number((row as any).strategy_id || 0);
    if (!sid || seenStrategyIds.has(sid)) continue;
    seenStrategyIds.add(sid);
    items.push(await buildItem(row as Record<string, unknown>, 'runtime_event'));
  }

  // ── Source 3: liquidity triggers (system-level) ────────────────────────────
  const liquidityRows = await db.all(
    `SELECT e.api_key_name, e.message AS last_error, e.details_json,
            datetime(e.created_at / 1000, 'unixepoch') AS updated_at,
            a.id AS api_key_id
     FROM strategy_runtime_events e
     LEFT JOIN api_keys a ON a.name = e.api_key_name
     WHERE e.event_type = 'liquidity_trigger'
       AND e.resolved_at = 0
       AND e.created_at >= ?
     ORDER BY e.created_at DESC
     LIMIT 20`,
    [Date.now() - periodHours * 3600_000]
  );
  const seenLiquidityKeys = new Set<string>();
  for (const row of Array.isArray(liquidityRows) ? liquidityRows : []) {
    const apiKeyName = String((row as any).api_key_name || '');
    const lastError = String((row as any).last_error || '');
    let detailsJson: Record<string, unknown> = {};
    try { detailsJson = JSON.parse(String((row as any).details_json || '{}')) as Record<string, unknown>; } catch { /* */ }
    const symbol = String(detailsJson.symbol || '');
    const dedupeKey = `${apiKeyName}:${symbol}`;
    if (seenLiquidityKeys.has(dedupeKey)) continue;
    seenLiquidityKeys.add(dedupeKey);
    const tenantRows = await db.all(
      'SELECT id, slug, display_name, product_mode FROM tenants WHERE assigned_api_key_name = ? ORDER BY id ASC',
      [apiKeyName]
    );
    const apiKeyId = Number((row as any).api_key_id || 0);
    const replRows: any[] = symbol && apiKeyId > 0
      ? await db.all(
          'SELECT symbol, score, details_json FROM liquidity_scan_suggestions WHERE api_key_id = ? AND status IN ('+("'"+'new'+"'"+', '+"'"+'approved'+"'")+') AND symbol = ? ORDER BY score DESC, created_at DESC LIMIT ?',
          [apiKeyId, symbol, replLimit]
        )
      : [];
    const systemIdFromDetails = detailsJson.systemId != null ? Number(detailsJson.systemId) : null;
    items.push({
      apiKeyName,
      strategyId: 0,
      strategyName: symbol ? `Liquidity: ${symbol}` : 'Liquidity trigger',
      pair: symbol || '\u2014',
      mode: 'mono',
      maxDeposit: 0, leverage: 0, lotPercent: 0,
      lastError, updatedAt: String((row as any).updated_at || ''),
      systemId: systemIdFromDetails, eventSource: 'liquidity_trigger',
      tenants: (Array.isArray(tenantRows) ? tenantRows : []).map((t: any) => ({
        id: Number(t.id), slug: String(t.slug || ''),
        displayName: String(t.display_name || ''), mode: String(t.product_mode || 'strategy_client') as ProductMode,
      })),
      suggestedDepositMin: 0, suggestedLotPercent: 0,
      replacementCandidates: (Array.isArray(replRows) ? replRows : []).map((c: any) => {
        let note = '';
        try { const d = JSON.parse(String(c.details_json || '{}')) as Record<string, unknown>; note = String(d.reason || d.note || '').trim(); } catch { note = ''; }
        return { symbol: String(c.symbol || ''), score: Number(c.score || 0), note };
      }),
    });
  }

  return { generatedAt: new Date().toISOString(), periodHours, items };
};
export const applyLowLotRecommendation = async (options: {
  strategyId: number;
  applyDepositFix: boolean;
  applyLotFix: boolean;
  applyToSystem?: boolean;
  systemId?: number;
  replacementSymbol?: string;
}): Promise<{ success: boolean; changes: Record<string, unknown>; changeSummary: string[] }> => {
  const strategy = await db.get('SELECT * FROM strategies WHERE id = ?', [options.strategyId]);
  if (!strategy) {
    throw new Error(`Strategy ${options.strategyId} not found`);
  }

  const targetStrategyIds: number[] = [Number(options.strategyId)];
  let resolvedSystemId: number | null = null;

  if (options.applyToSystem) {
    const explicitSystemId = Math.max(0, Math.floor(Number(options.systemId || 0)));
    if (explicitSystemId > 0) {
      resolvedSystemId = explicitSystemId;
    } else {
      const systemRow = await db.get(
        'SELECT system_id FROM trading_system_members WHERE strategy_id = ? ORDER BY id ASC LIMIT 1',
        [options.strategyId]
      ) as { system_id?: number } | undefined;
      const inferredSystemId = Math.max(0, Number(systemRow?.system_id || 0));
      resolvedSystemId = inferredSystemId > 0 ? inferredSystemId : null;
    }

    if (resolvedSystemId) {
      const rows = await db.all(
        `SELECT DISTINCT s.id
         FROM trading_system_members tsm
         JOIN strategies s ON s.id = tsm.strategy_id
         WHERE tsm.system_id = ?
           AND COALESCE(tsm.is_enabled, 1) = 1
           AND COALESCE(s.is_active, 0) = 1`,
        [resolvedSystemId]
      ) as Array<{ id?: number }>;
      const ids = (Array.isArray(rows) ? rows : [])
        .map((row) => Math.floor(Number(row?.id || 0)))
        .filter((id) => id > 0);
      if (ids.length > 0) {
        targetStrategyIds.splice(0, targetStrategyIds.length, ...Array.from(new Set(ids)));
      }
    }
  }

  const changes: Record<string, unknown> = {
    strategyCount: targetStrategyIds.length,
    strategyIds: targetStrategyIds,
    ...(resolvedSystemId ? { systemId: resolvedSystemId } : {}),
  };
  const changeSummary: string[] = [];
  const details: Array<Record<string, unknown>> = [];

  for (const sid of targetStrategyIds) {
    const row = await db.get('SELECT * FROM strategies WHERE id = ?', [sid]);
    if (!row) {
      continue;
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    const rowChanges: Record<string, unknown> = { strategyId: sid, strategyName: String(row.name || '') };

    if (options.applyDepositFix) {
      const currentDeposit = Math.max(0, Number(row.max_deposit || 0));
      const newDeposit = Math.max(100, Number((currentDeposit * 1.25).toFixed(2)));
      setClauses.push('max_deposit = ?');
      values.push(newDeposit);
      rowChanges['max_deposit'] = { from: currentDeposit, to: newDeposit };
    }

    if (options.applyLotFix) {
      const currentLot = Math.max(
        0,
        Number(row.lot_long_percent || 0),
        Number(row.lot_short_percent || 0)
      );
      const newLot = currentLot < 20 ? 20 : Math.min(60, currentLot + 10);
      setClauses.push('lot_long_percent = ?');
      values.push(newLot);
      setClauses.push('lot_short_percent = ?');
      values.push(newLot);
      rowChanges['lot_percent'] = { from: currentLot, to: newLot };
    }

    // Symbol replacement is intentionally strategy-specific. Avoid rewriting the whole TS pair map.
    if (options.replacementSymbol && !options.applyToSystem) {
      const parts = String(options.replacementSymbol).split('/').map((s) => s.trim().toUpperCase());
      const [base, quote] = parts;
      if (base) {
        setClauses.push('base_symbol = ?');
        values.push(base);
        rowChanges['base_symbol'] = { from: String(row.base_symbol || ''), to: base };
      }
      if (quote) {
        setClauses.push('quote_symbol = ?');
        values.push(quote);
        rowChanges['quote_symbol'] = { from: String(row.quote_symbol || ''), to: quote };
      }
    }

    if (setClauses.length === 0) {
      continue;
    }

    setClauses.push('last_error = ?');
    values.push('');
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(sid);

    await db.run(
      `UPDATE strategies SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    );

    details.push(rowChanges);
  }

  if (details.length === 0) {
    return { success: true, changes: {}, changeSummary: [] };
  }

  changes['details'] = details;

  const primaryChanges = details[0] || {};
  if ((primaryChanges as any)['max_deposit']) {
    const d = (primaryChanges as any)['max_deposit'] as { from: number; to: number };
    changeSummary.push(`Deposit x1.25: $${d.from} -> $${d.to}`);
  }
  if ((primaryChanges as any)['lot_percent']) {
    const l = (primaryChanges as any)['lot_percent'] as { from: number; to: number };
    changeSummary.push(`Lot: ${l.from}% -> ${l.to}%`);
  }
  if ((primaryChanges as any)['base_symbol'] || (primaryChanges as any)['quote_symbol']) {
    const oldPair = `${String(((primaryChanges as any)['base_symbol'] as any)?.from || strategy.base_symbol || '')}/${String(((primaryChanges as any)['quote_symbol'] as any)?.from || strategy.quote_symbol || '')}`;
    const newPair = `${String(((primaryChanges as any)['base_symbol'] as any)?.to || strategy.base_symbol || '')}/${String(((primaryChanges as any)['quote_symbol'] as any)?.to || strategy.quote_symbol || '')}`;
    changeSummary.push(`Pair: ${oldPair} -> ${newPair}`);
  }
  if (targetStrategyIds.length > 1) {
    changeSummary.push(`Applied to ${targetStrategyIds.length} strategies`);
  }

  const apiKeyRow = await db.get('SELECT name FROM api_keys WHERE id = ?', [strategy.api_key_id]);
  const apiKeyName = String(apiKeyRow?.name || '');
  const payloadJson = JSON.stringify({
    strategy_id: options.strategyId,
    strategy_name: String(strategy.name || ''),
    applyToSystem: Boolean(options.applyToSystem),
    systemId: resolvedSystemId,
    changes,
  });

  if (apiKeyName) {
    const tenantRows = await db.all(
      'SELECT id FROM tenants WHERE assigned_api_key_name = ?',
      [apiKeyName]
    );
    if (Array.isArray(tenantRows) && tenantRows.length > 0) {
      for (const tenant of tenantRows) {
        await db.run(
          `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json) VALUES (?, 'admin', 'apply_low_lot_recommendation', ?)`,
          [Number(tenant.id), payloadJson]
        );
      }
    } else {
      await db.run(
        `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json) VALUES (NULL, 'admin', 'apply_low_lot_recommendation', ?)`,
        [payloadJson]
      );
    }
  } else {
    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json) VALUES (NULL, 'admin', 'apply_low_lot_recommendation', ?)`,
      [payloadJson]
    );
  }

  // Mark unresolved low-lot runtime events for affected strategies as resolved.
  const eventPlaceholders = targetStrategyIds.map(() => '?').join(', ');
  await db.run(
    `UPDATE strategy_runtime_events
     SET resolved_at = ?
     WHERE strategy_id IN (${eventPlaceholders})
       AND event_type = 'low_lot_error'
       AND resolved_at = 0`,
    [Date.now(), ...targetStrategyIds]
  );

  return { success: true, changes, changeSummary };
};

const getLightResearchArtifactsStatus = (): ReturnType<typeof getLatestResearchArtifactsStatus> => {
  // Filename/mtime only — do not parse multi-MB sweep/catalog JSON on light admin paths.
  const now = Date.now();
  const catalogPath = getLatestClientCatalogPath();
  const sweepPath = getLatestSweepPath();
  const catalogTsMs = catalogPath ? toArtifactTimestampMs(null, catalogPath) : 0;
  const sweepTsMs = sweepPath ? toArtifactTimestampMs(null, sweepPath) : 0;
  const catalogAgeMs = catalogTsMs > 0 ? Math.max(0, now - catalogTsMs) : null;
  const sweepAgeMs = sweepTsMs > 0 ? Math.max(0, now - sweepTsMs) : null;
  return {
    catalogPath,
    sweepPath,
    catalogTimestamp: catalogTsMs > 0 ? new Date(catalogTsMs).toISOString() : null,
    sweepTimestamp: sweepTsMs > 0 ? new Date(sweepTsMs).toISOString() : null,
    catalogAgeMs,
    sweepAgeMs,
    catalogFresh: catalogAgeMs !== null && catalogAgeMs <= SOURCE_ARTIFACT_MAX_AGE_MS,
    sweepFresh: sweepAgeMs !== null && sweepAgeMs <= SOURCE_ARTIFACT_MAX_AGE_MS,
  };
};

export const getSaasAdminSummary = async (options?: {
  includeOfferStore?: boolean;
}) => {
  await ensureSaasSeedData();
  const includeOfferStore = options?.includeOfferStore !== false;

  // scope=light (clients / auth): skip catalog+sweep JSON + offer-store presets.
  // Those are loaded on demand when opening offer-ts / storefront surfaces (scope=full).
  if (!includeOfferStore) {
    const apiKeys = await getAvailableApiKeyNames();
    const tenants = await listTenantSummaries({ includeLatestPreview: false });
    const plans = await listPlans();
    const algofundRequests = await getAlgofundRequestsAll(200);
    const [reportSettings, snapshotRefresh] = await Promise.all([
      getAdminReportSettings(),
      getOfferStoreSnapshotRefreshState(),
    ]);
    const backtestRequestCount = await db.get(
      `SELECT
         SUM(CASE WHEN status IN ('pending', 'approved', 'in_sweep') THEN 1 ELSE 0 END) AS pending,
         COUNT(*) AS total
       FROM strategy_backtest_pair_requests`
    ) as { pending?: number; total?: number } | undefined;

    return {
      sourceFiles: {
        latestCatalogPath: getLatestClientCatalogPath(),
        latestSweepPath: getLatestSweepPath(),
      },
      sourceArtifactsStatus: getLightResearchArtifactsStatus(),
      catalog: null,
      sweepSummary: null,
      recommendedSets: {
        balancedBot: [],
        conservativeBot: [],
        monoStarter: [],
        synthStarter: [],
        premiumMix: [],
      },
      tenants,
      plans,
      apiKeys,
      backtestPairRequests: {
        pending: Number(backtestRequestCount?.pending || 0),
        total: Number(backtestRequestCount?.total || 0),
      },
      algofundRequestQueue: {
        total: algofundRequests.length,
        pending: algofundRequests.filter((row) => row.status === 'pending').length,
        approved: algofundRequests.filter((row) => row.status === 'approved').length,
        rejected: algofundRequests.filter((row) => row.status === 'rejected').length,
        items: algofundRequests,
      },
      reportSettings,
      snapshotRefresh,
    };
  }

  const sourceCatalog = loadLatestClientCatalog();
  const sourceSweep = loadLatestSweep();
  const apiKeys = await getAvailableApiKeyNames();
  const fallbackCatalog = await buildFallbackCatalogFromPresets(sourceCatalog, []);
  const sourceCatalogHasOffers = catalogHasOffers(sourceCatalog);
  const catalog = sourceCatalogHasOffers
    ? sourceCatalog
    : (catalogHasOffers(fallbackCatalog) ? fallbackCatalog : sourceCatalog || fallbackCatalog);
  
  // Always use source draft if available, don't let fallback overwrite it
  if (catalog && sourceCatalog?.adminTradingSystemDraft && 
      sourceCatalog.adminTradingSystemDraft.name && 
      !sourceCatalog.adminTradingSystemDraft.name.includes('fallback')) {
    catalog.adminTradingSystemDraft = sourceCatalog.adminTradingSystemDraft;
  }
  if (catalog) {
    const extraRaw = await getRuntimeFlag('admin.catalog.extra_draft_members', '[]');
    const extraMembers = safeJsonParse<CatalogData['adminTradingSystemDraft']['members']>(extraRaw, []);
    if (Array.isArray(extraMembers) && extraMembers.length > 0) {
      const existingIds = new Set((catalog.adminTradingSystemDraft?.members || []).map((m) => Number(m.strategyId || 0)));
      const toInject = extraMembers.filter((m) => Number(m?.strategyId || 0) > 0 && !existingIds.has(Number(m.strategyId || 0)));
      if (toInject.length > 0) {
        catalog.adminTradingSystemDraft = {
          ...(catalog.adminTradingSystemDraft || { name: 'SAAS Admin TS (curated draft)' }),
          members: [...(catalog.adminTradingSystemDraft?.members || []), ...toInject],
        };
      }
    }
  }
  
  const sweepSelectedMembers = resolveSweepSelectedMembers(sourceSweep, catalog);
  const sweepSummary = sourceSweep
    ? {
      timestamp: sourceSweep.timestamp,
      period: buildPeriodInfo(sourceSweep),
      counts: sourceSweep.counts,
      selectedMembers: sweepSelectedMembers,
      topByMode: sourceSweep.topByMode,
      topAll: (Array.isArray(sourceSweep.topAll) ? sourceSweep.topAll : []).slice(0, 12),
      portfolioFull: sourceSweep.portfolioResults?.[0] || null,
    }
    : buildFallbackSweepSummary(catalog);
  const recommendedSets = buildRecommendedSets(catalog);
  const tenants = await listTenantSummaries({ includeLatestPreview: false });
  const plans = await listPlans();
  const algofundRequests = await getAlgofundRequestsAll(200);
  const [offerStore, reportSettings, snapshotRefresh] = await Promise.all([
    getOfferStoreAdminState(),
    getAdminReportSettings(),
    getOfferStoreSnapshotRefreshState(),
  ]);
  const backtestRequestCount = await db.get(
    `SELECT
       SUM(CASE WHEN status IN ('pending', 'approved', 'in_sweep') THEN 1 ELSE 0 END) AS pending,
       COUNT(*) AS total
     FROM strategy_backtest_pair_requests`
  ) as { pending?: number; total?: number } | undefined;

  const sourceArtifactsStatus = getLatestResearchArtifactsStatus();

  return {
    sourceFiles: {
      latestCatalogPath: getLatestClientCatalogPath(),
      latestSweepPath: getLatestSweepPath(),
    },
    sourceArtifactsStatus,
    catalog,
    sweepSummary,
    recommendedSets,
    tenants,
    plans,
    apiKeys,
    backtestPairRequests: {
      pending: Number(backtestRequestCount?.pending || 0),
      total: Number(backtestRequestCount?.total || 0),
    },
    algofundRequestQueue: {
      total: algofundRequests.length,
      pending: algofundRequests.filter((row) => row.status === 'pending').length,
      approved: algofundRequests.filter((row) => row.status === 'approved').length,
      rejected: algofundRequests.filter((row) => row.status === 'rejected').length,
      items: algofundRequests,
    },
    ...(offerStore ? { offerStore } : {}),
    reportSettings,
    snapshotRefresh,
  };
};

export const updateTenantAdminState = async (tenantId: number, payload: {
  displayName?: string;
  status?: string;
  assignedApiKeyName?: string;
  planCode?: string;
    depositCapOverride?: number | null;
  }) => {
  await ensureSaasSeedData();
  const tenant = await getTenantById(tenantId);

  const nextDisplayName = asString(payload.displayName, tenant.display_name);
  const nextStatus = asString(payload.status, tenant.status || 'active');
  const nextAssignedApiKeyName = asString(payload.assignedApiKeyName, tenant.assigned_api_key_name);

    // deposit_cap_override: null = use plan default, number = per-tenant override
    const nextDepositCapOverride = payload.depositCapOverride !== undefined
      ? (payload.depositCapOverride === null || !Number.isFinite(Number(payload.depositCapOverride)) ? null : Math.max(0, Number(payload.depositCapOverride)))
      : (tenant.deposit_cap_override ?? null);

    // Ensure column exists (idempotent migration)
    await db.run(`ALTER TABLE tenants ADD COLUMN deposit_cap_override INTEGER DEFAULT NULL`).catch(() => { /* already exists */ });

    await db.run(
      `UPDATE tenants
       SET display_name = ?, status = ?, assigned_api_key_name = ?, deposit_cap_override = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextDisplayName, nextStatus, nextAssignedApiKeyName, nextDepositCapOverride, tenantId]
    );

  if (tenant.product_mode === 'strategy_client' || tenant.product_mode === 'dual') {
    await db.run(
      `UPDATE strategy_client_profiles
       SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [nextAssignedApiKeyName, tenantId]
    );
  }
  if (tenant.product_mode === 'algofund_client' || tenant.product_mode === 'dual') {
    await db.run(
      `UPDATE algofund_profiles
       SET assigned_api_key_name = ?, execution_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [nextAssignedApiKeyName, nextAssignedApiKeyName, tenantId]
    );
  }
  if (tenant.product_mode === 'copytrading_client') {
    await db.run(
      `UPDATE copytrading_profiles
       SET master_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [nextAssignedApiKeyName, tenantId]
    );
  }

  if (payload.planCode) {
    const plan = await getPlanByCode(payload.planCode);
    if (plan.product_mode !== tenant.product_mode && tenant.product_mode !== 'dual') {
      throw new Error(`Plan ${payload.planCode} does not belong to tenant mode ${tenant.product_mode}`);
    }
    await setTenantSubscriptionPlan(tenantId, plan.id, tenant.product_mode === 'dual' ? plan.product_mode : undefined);
  }

  return listTenantSummaries();
};

export const updatePlanAdminState = async (planCode: string, payload: {
  title?: string;
  priceUsdt?: number;
  maxDepositTotal?: number;
  riskCapMax?: number;
  maxStrategiesTotal?: number;
  allowTsStartStopRequests?: boolean;
}) => {
  await ensureSaasSeedData();
  const existing = await getPlanByCode(planCode);

  const nextTitle = asString(payload.title, existing.title);
  const nextPriceUsdt = Math.max(0, asNumber(payload.priceUsdt, existing.price_usdt));
  const nextMaxDepositTotal = Math.max(0, asNumber(payload.maxDepositTotal, existing.max_deposit_total));
  const nextRiskCapMax = Math.max(0, asNumber(payload.riskCapMax, existing.risk_cap_max));
  const nextMaxStrategiesTotal = Math.max(0, Math.floor(asNumber(payload.maxStrategiesTotal, existing.max_strategies_total)));
  const nextAllowTsStartStopRequests = payload.allowTsStartStopRequests !== undefined
    ? (payload.allowTsStartStopRequests ? 1 : 0)
    : Number(existing.allow_ts_start_stop_requests || 0);

  await db.run(
    `UPDATE plans
     SET title = ?,
         price_usdt = ?,
         max_deposit_total = ?,
         risk_cap_max = ?,
         max_strategies_total = ?,
         allow_ts_start_stop_requests = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE code = ?`,
    [
      nextTitle,
      nextPriceUsdt,
      nextMaxDepositTotal,
      nextRiskCapMax,
      nextMaxStrategiesTotal,
      nextAllowTsStartStopRequests,
      planCode,
    ]
  );

  return listPlans();
};

const listTenantSummaries = async (options?: {
  includeLatestPreview?: boolean;
}) => {
  const includeLatestPreview = options?.includeLatestPreview !== false;
  const rows = await db.all('SELECT * FROM tenants ORDER BY id ASC');
  const out = [] as Array<Record<string, unknown>>;

  for (const tenant of (Array.isArray(rows) ? rows : []) as TenantRow[]) {
    const plan = await getPlanForTenant(tenant.id);
    const strategyPlan = tenant.product_mode === 'dual' ? await getPlanForTenant(tenant.id, 'strategy_client') : null;
    const algofundPlan = tenant.product_mode === 'dual' ? await getPlanForTenant(tenant.id, 'algofund_client') : null;
    const capabilities = resolvePlanCapabilities(plan);
    const strategyProfile = await getStrategyClientProfile(tenant.id);
    const algofundProfile = await getAlgofundProfile(tenant.id);
    const copytradingProfile = await getCopytradingProfile(tenant.id);
    const effectiveMonitoringApiKeyName = asString(
      tenant.product_mode === 'strategy_client' || tenant.product_mode === 'dual'
        ? (strategyProfile?.assigned_api_key_name || algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name)
        : tenant.product_mode === 'algofund_client'
          ? (algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name)
          : Number(copytradingProfile?.copy_enabled || 0) === 1
              ? copytradingProfile?.master_api_key_name
              : '',
      tenant.assigned_api_key_name
    ).trim();
    const monitoring = capabilities.monitoring && effectiveMonitoringApiKeyName
      ? await getMonitoringLatest(effectiveMonitoringApiKeyName).catch(() => null)
      : null;
    out.push({
      tenant,
      plan,
      strategyPlan,
      algofundPlan,
      capabilities,
      strategyProfile: strategyProfile ? {
        ...strategyProfile,
        ...(includeLatestPreview
          ? {
            latest_preview_json: strategyProfile.latest_preview_json,
            latestPreview: safeJsonParse<Record<string, unknown>>(strategyProfile.latest_preview_json, {}),
          }
          : {
            latest_preview_json: '',
          }),
        selectedOfferIds: safeJsonParse<string[]>(strategyProfile.selected_offer_ids_json, []),
      } : null,
      algofundProfile: algofundProfile ? {
        ...algofundProfile,
        ...(includeLatestPreview
          ? {
            latest_preview_json: algofundProfile.latest_preview_json,
            latestPreview: safeJsonParse<Record<string, unknown>>(algofundProfile.latest_preview_json, {}),
          }
          : {
            latest_preview_json: '',
          }),
      } : null,
      copytradingProfile: copytradingProfile ? {
        ...copytradingProfile,
        tenants: safeJsonParse<Array<Record<string, unknown>>>(copytradingProfile.tenants_json, []),
      } : null,
      monitoring,
    });
  }

  return out;
};

export const getStrategyClientState = async (tenantId: number) => {
  await ensureSaasSeedData();
  const tenant = await getTenantById(tenantId);
  const plan = await getPlanForTenant(tenantId, 'strategy_client');
  const capabilities = resolvePlanCapabilities(plan);
  const profile = await getStrategyClientProfile(tenantId);
  let systemProfiles = await listStrategyClientSystemProfiles(tenantId);
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const offerStore = await getOfferStoreAdminState();
  const storefrontSet = getStorefrontOfferIds(offerStore);
  const catalog = filterCatalogByStorefrontOfferIds(sourceCatalog, storefrontSet);
  const directOffers = catalog ? getAllOffers(catalog) : [];
  const presetBackedOffers = await buildPresetBackedOffers(catalog);
  const directById = new Map(
    directOffers.map((offer) => [String(offer.offerId || '').trim(), offer] as const).filter(([offerId]) => Boolean(offerId))
  );
  const presetBackedById = new Map(
    presetBackedOffers.map((offer) => [String(offer.offerId || '').trim(), offer] as const).filter(([offerId]) => Boolean(offerId))
  );
  const offerStoreBackedOffers = (offerStore.offers || []).map((row) => {
    const offerId = asString(row.offerId, '').trim();
    const mode = row.mode === 'synth' ? 'synth' as const : 'mono' as const;
    const market = asString(row.market, '');
    const familyType = asString((row as Record<string, unknown>).familyType, '') || 'DD_BattleToads';
    const directOffer = directById.get(offerId);
    const presetOffer = presetBackedById.get(offerId);
    const familyInterval = asString(
      (row as Record<string, unknown>).familyInterval,
      asString(
        directOffer?.strategy?.params?.interval,
        asString(presetOffer?.strategy?.params?.interval, '1h'),
      ),
    );
    const ret = Number(asNumber(row.ret, 0));
    const pf = Number(asNumber(row.pf, 0));
    const dd = Number(asNumber(row.dd, 0));
    const trades = Math.max(0, Math.floor(asNumber(row.trades, 0)));
    const score = Number(asNumber(row.score, 0));
    const equityPoints = Array.isArray((row as Record<string, unknown>).equityPoints)
      ? ((row as Record<string, unknown>).equityPoints as unknown[]).map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [];
    const periodDays = Math.max(1, Math.floor(asNumber((row as Record<string, unknown>).periodDays, offerStore.defaults.periodDays || 365)));
    return {
      offerId,
      titleRu: asString(row.titleRu, offerId),
      descriptionRu: 'Оффер из curated storefront.',
      strategy: {
        id: Number(row.strategyId || parseStrategyIdFromOfferId(offerId) || 0),
        name: asString(row.titleRu, offerId),
        type: familyType,
        mode,
        market,
        params: {
          interval: familyInterval,
          length: 50,
          takeProfitPercent: 0,
          detectionSource: 'close',
          zscoreEntry: 2,
          zscoreExit: 0.5,
          zscoreStop: 3,
        },
      },
      metrics: {
        ret,
        pf,
        dd,
        wr: 0,
        trades,
        score,
        robust: true,
      },
      sliderPresets: {
        risk: { low: null, medium: null, high: null },
        tradeFrequency: { low: null, medium: null, high: null },
      },
      presetMatrix: undefined,
      equity: equityPoints.length > 1 ? {
        source: 'offer_store',
        generatedAt: new Date().toISOString(),
        points: equityPoints.map((equity, index) => ({
          time: Math.floor(Date.now() / 1000) - periodDays * 86400 + index * Math.floor((periodDays * 86400) / Math.max(equityPoints.length - 1, 1)),
          equity,
        })),
        summary: {
          finalEquity: equityPoints[equityPoints.length - 1],
          totalReturnPercent: ret,
          maxDrawdownPercent: dd,
          winRatePercent: 0,
          profitFactor: pf,
          tradesCount: trades,
        },
      } : undefined,
    } as CatalogOffer;
  }).filter((offer) => Boolean(offer.offerId));
  const offerStoreBackedById = new Map(
    offerStoreBackedOffers.map((offer) => [String(offer.offerId || '').trim(), offer] as const).filter(([offerId]) => Boolean(offerId))
  );
  const scopedCatalogOfferIds = directOffers
    .map((offer) => String(offer.offerId || '').trim())
    .filter(Boolean);
  const preferredStorefrontOfferIds = storefrontSet.size > 0
    ? Array.from(storefrontSet)
    : scopedCatalogOfferIds;
  const presetOffers = preferredStorefrontOfferIds.length > 0
    ? preferredStorefrontOfferIds
      .map((offerId) => offerStoreBackedById.get(offerId) || directById.get(offerId) || presetBackedById.get(offerId) || null)
      .filter((offer): offer is CatalogOffer => Boolean(offer))
    : (offerStoreBackedOffers.length > 0 ? offerStoreBackedOffers : (directOffers.length > 0 ? directOffers : presetBackedOffers));

  // Enrich client offers with admin review snapshot data (equityPoints + accurate metrics) when available
  const reviewSnapshots = await getOfferReviewSnapshots().catch(() => ({} as Record<string, OfferReviewSnapshot>));

  // Build fuzzy index: mode_strategyType -> best snapshot (most equity points, then highest ret)
  // This allows matching catalog offers with different strategyIds to existing snapshots
  const normalizeStrategySignature = (mode: string, typeRaw: string): string => {
    // Normalize strategy type by extracting all lowercase alpha chars, sorting them → canonical form
    // e.g. "zscore_statarb" and "stat_arb_zscore" both → "aabcerorsssttz"
    const m = mode.toLowerCase().trim();
    const sortedChars = typeRaw.toLowerCase().replace(/[^a-z]/g, '').split('').sort().join('');
    return `${m}:${sortedChars}`;
  };

  const extractOfferIdParts = (offerId: string): { mode: string; typeRaw: string } => {
    const body = String(offerId || '').toLowerCase().replace(/^offer_/, '');
    const parts = body.split('_');
    const mode = parts[0] || '';
    const lastPart = parts[parts.length - 1];
    const typeParts = Number.isFinite(Number(lastPart)) && lastPart.length > 0 ? parts.slice(1, -1) : parts.slice(1);
    return { mode, typeRaw: typeParts.join('_') };
  };

  const snapshotsByTypeMode = new Map<string, OfferReviewSnapshot[]>();
  for (const snap of Object.values(reviewSnapshots)) {
    if (!Array.isArray(snap.equityPoints) || snap.equityPoints.length < 3) continue;
    const { mode, typeRaw } = extractOfferIdParts(snap.offerId);
    const key = normalizeStrategySignature(mode, typeRaw);
    if (!key || key === ':') continue;
    if (!snapshotsByTypeMode.has(key)) snapshotsByTypeMode.set(key, []);
    snapshotsByTypeMode.get(key)!.push(snap);
  }
  // Sort each group by equity points count desc, then ret desc
  for (const [, group] of snapshotsByTypeMode) {
    group.sort((a, b) => (b.equityPoints?.length || 0) - (a.equityPoints?.length || 0) || b.ret - a.ret);
  }

  // Track which fuzzy snapshots have been used to distribute different curves to different offers
  const usedFuzzySnapshots = new Set<string>();

  const enrichedOffers = presetOffers.map((offer) => {
    if (offer.equity?.source === 'offer_store' || offer.equity?.source === 'review_snapshot') {
      return offer;
    }

    let snap = reviewSnapshots[offer.offerId];

    // Fuzzy match: if no exact snapshot, find one matching mode + strategy type
    if (!snap) {
      // Try by offer.strategy fields
      const keyFromFields = normalizeStrategySignature(
        String(offer.strategy?.mode || ''),
        String(offer.strategy?.type || '')
      );
      // Try by offerId parsing
      const { mode: idMode, typeRaw: idType } = extractOfferIdParts(offer.offerId);
      const keyFromId = normalizeStrategySignature(idMode, idType);
      const candidates = snapshotsByTypeMode.get(keyFromFields)
        || snapshotsByTypeMode.get(keyFromId)
        || [];
      // Pick first unused candidate, or fall back to first candidate
      snap = candidates.find((c) => !usedFuzzySnapshots.has(c.offerId)) || candidates[0] || null as any;
      if (snap) usedFuzzySnapshots.add(snap.offerId);
    }

    if (!snap) return offer;
    const rawSnapshotEquity = Array.isArray(snap.equityPoints) ? snap.equityPoints : [];
    const snapshotFinalEquity = rawSnapshotEquity.length > 0 ? rawSnapshotEquity[rawSnapshotEquity.length - 1] : undefined;
    const normalizedSnapshotEquity = normalizeEquityCurveOrientation(rawSnapshotEquity, snap.ret, snapshotFinalEquity, 10000);
    const hasSnapshotEquity = normalizedSnapshotEquity.length > 1;
    return {
      ...offer,
      metrics: {
        ...offer.metrics,
        ret: asNumber(snap.ret, offer.metrics.ret),
        pf: asNumber(snap.pf, offer.metrics.pf),
        dd: asNumber(snap.dd, offer.metrics.dd),
        trades: snap.trades > 0 ? snap.trades : offer.metrics.trades,
      },
      equityPoints: hasSnapshotEquity ? normalizedSnapshotEquity : undefined,
      equity: hasSnapshotEquity ? {
        source: 'review_snapshot',
        generatedAt: snap.updatedAt || new Date().toISOString(),
        points: normalizedSnapshotEquity.map((eq, i) => ({
          time: Math.floor(Date.now() / 1000) - (snap.periodDays || 365) * 86400 + i * Math.floor((snap.periodDays || 365) * 86400 / Math.max(normalizedSnapshotEquity.length - 1, 1)),
          equity: eq,
        })),
        summary: {
          finalEquity: normalizedSnapshotEquity[normalizedSnapshotEquity.length - 1],
          totalReturnPercent: snap.ret,
          maxDrawdownPercent: snap.dd,
          winRatePercent: 0,
          profitFactor: snap.pf,
          tradesCount: snap.trades,
        },
      } : offer.equity,
    } as CatalogOffer;
  });

  const clientPrefs = safeJsonParse<{ showFutures?: boolean; showSpot?: boolean }>(
    (tenant as { client_preferences_json?: string }).client_preferences_json,
    { showFutures: true, showSpot: true },
  );
  const showFuturesOffers = clientPrefs.showFutures !== false;
  const showSpotOffers = clientPrefs.showSpot !== false;

  const normalizedClientOffers = enrichedOffers.map((offer) => {
    const familyInterval = asString(
      (offer as Record<string, unknown>).familyInterval,
      asString(
        (offer as Record<string, unknown>).interval,
        asString(offer.strategy?.params?.interval, ''),
      ),
    );
    const equityPoints = Array.isArray((offer as Record<string, unknown>).equityPoints)
      ? ((offer as Record<string, unknown>).equityPoints as unknown[])
        .map((value) => asNumber(value, Number.NaN))
        .filter((value) => Number.isFinite(value))
      : Array.isArray(offer.equity?.points)
        ? offer.equity.points
          .map((point) => asNumber(point?.equity, Number.NaN))
          .filter((value) => Number.isFinite(value))
        : [];
    const marketType = String((offer as Record<string, unknown>).market_type || 'futures') === 'spot' ? 'spot' : 'futures';

    return {
      ...offer,
      market_type: marketType,
      interval: familyInterval || null,
      familyInterval: familyInterval || null,
      strategyParams: offer.strategy?.params || null,
      equityPoints,
    } as CatalogOffer;
  }).filter((offer) => {
    const marketType = String((offer as Record<string, unknown>).market_type || 'futures');
    if (marketType === 'spot') {
      return showSpotOffers;
    }
    return showFuturesOffers;
  });

  const recommendedSets = buildRecommendedSets(catalog);
  const savedOfferIdsLegacy = profile ? safeJsonParse<string[]>(profile.selected_offer_ids_json, []) : [];
  systemProfiles = await ensureDefaultStrategyClientSystemProfile(tenantId, savedOfferIdsLegacy);
  const activeSystemProfile = systemProfiles.find((item) => Number(item.is_active || 0) === 1)
    || (profile?.active_system_profile_id ? systemProfiles.find((item) => Number(item.id) === Number(profile.active_system_profile_id)) : null)
    || systemProfiles[0]
    || null;
  const savedOfferIds = activeSystemProfile
    ? safeJsonParse<string[]>(activeSystemProfile.selected_offer_ids_json, [])
    : savedOfferIdsLegacy;
  const constraintsCatalog = catalog || await buildFallbackCatalogFromPresets(catalog, [tenant.assigned_api_key_name].filter(Boolean));
  const selectedOffersForConstraints = constraintsCatalog
    ? savedOfferIds
      .map((offerId) => findOfferByIdOrNull(constraintsCatalog, offerId))
      .filter((item): item is CatalogOffer => !!item)
    : [];
  const effectiveMonitoringApiKeyName = asString(profile?.assigned_api_key_name, tenant.assigned_api_key_name).trim();
  const monitoring = capabilities.monitoring && effectiveMonitoringApiKeyName
    ? await getMonitoringLatest(effectiveMonitoringApiKeyName).catch(() => null)
    : null;

  return {
    tenant,
    plan,
    capabilities,
    monitoring,
    clientPreferences: clientPrefs,
    profile: profile ? {
      ...profile,
      selectedOfferIds: savedOfferIds,
      activeSystemProfileId: activeSystemProfile?.id || null,
      latestPreview: hydrateStoredStrategyPreview(catalog, profile.latest_preview_json),
    } : null,
    systemProfiles: systemProfiles.map((item) => ({
      id: item.id,
      profileName: item.profile_name,
      selectedOfferIds: safeJsonParse<string[]>(item.selected_offer_ids_json, []),
      isActive: Number(item.is_active || 0) === 1,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
    constraints: buildStrategySelectionConstraints(plan, selectedOffersForConstraints),
    catalog,
    offers: normalizedClientOffers,
    recommendedSets,
    offerStoreDefaults: offerStore.defaults,
    sweepPeriod: buildPeriodInfo(sweep),
  };
};

const hasOwnPayloadField = (value: unknown, field: string): boolean => {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value as Record<string, unknown>, field);
};

const resolveAssignedApiKeyInput = (
  payload: Record<string, unknown>,
  field: string,
  fallback: string,
): string => {
  if (hasOwnPayloadField(payload, field)) {
    return asString(payload[field], '').trim();
  }
  return asString(fallback, '').trim();
};

const syncTenantAssignedApiKeyName = async (tenantId: number): Promise<string> => {
  const [strategyProfile, algofundProfile] = await Promise.all([
    getStrategyClientProfile(tenantId),
    getAlgofundProfile(tenantId),
  ]);

  const nextAssignedApiKeyName = asString(strategyProfile?.assigned_api_key_name, '').trim()
    || asString(algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name, '').trim()
    || '';

  await db.run(
    `UPDATE tenants
     SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextAssignedApiKeyName, tenantId]
  );

  return nextAssignedApiKeyName;
};

export const updateStrategyClientState = async (tenantId: number, payload: {
  selectedOfferIds?: string[];
  riskLevel?: Level3;
  tradeFrequencyLevel?: Level3;
  assignedApiKeyName?: string;
  requestedEnabled?: boolean;
}) => {
  const tenant = await getTenantById(tenantId);
  const existing = await getStrategyClientProfile(tenantId);
  const plan = await getPlanForTenant(tenantId, 'strategy_client');
  if (!existing) {
    throw new Error(`Strategy client profile not found for tenant ${tenant.slug}`);
  }

  const nextRiskLevel = payload.riskLevel || existing.risk_level || 'medium';
  const nextTradeFrequencyLevel = payload.tradeFrequencyLevel || existing.trade_frequency_level || 'medium';
  const systemProfiles = await ensureDefaultStrategyClientSystemProfile(
    tenantId,
    safeJsonParse<string[]>(existing.selected_offer_ids_json, [])
  );
  const activeSystemProfile = systemProfiles.find((item) => Number(item.is_active || 0) === 1)
    || (existing.active_system_profile_id ? systemProfiles.find((item) => Number(item.id) === Number(existing.active_system_profile_id)) : null)
    || systemProfiles[0]
    || null;
  const activeOfferIds = activeSystemProfile
    ? safeJsonParse<string[]>(activeSystemProfile.selected_offer_ids_json, [])
    : safeJsonParse<string[]>(existing.selected_offer_ids_json, []);
  const nextOfferIds = Array.isArray(payload.selectedOfferIds)
    ? Array.from(new Set(payload.selectedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : activeOfferIds;
  const currentAssignedApiKeyName = asString(existing.assigned_api_key_name || tenant.assigned_api_key_name, '').trim();
  const nextAssignedApiKeyName = resolveAssignedApiKeyInput(
    payload as Record<string, unknown>,
    'assignedApiKeyName',
    currentAssignedApiKeyName,
  );
  const nextRequestedEnabled = payload.requestedEnabled !== undefined ? payload.requestedEnabled : existing.requested_enabled === 1;

  // D0: нельзя сохранять выбор офферов без API-ключа
  if (Array.isArray(payload.selectedOfferIds) && payload.selectedOfferIds.length > 0 && !nextAssignedApiKeyName) {
    throw new Error('Сначала добавьте API-ключ биржи, прежде чем выбирать стратегии.');
  }

  // D0: нельзя включать поток стратегий без отдельного назначенного API-ключа.
  if (nextRequestedEnabled && !nextAssignedApiKeyName) {
    throw new Error('Нельзя включить поток стратегий без назначенного API-ключа. Сначала сохраните отдельный ключ для стратегий.');
  }

  // D1+D2: проверка что ключ не занят другим тенантом / другим режимом.
  // Проверяем не только при смене ключа, но и при фактическом включении потока,
  // чтобы не оставлять старые конфликтные назначения незамеченными.
  if (nextAssignedApiKeyName && (payload.assignedApiKeyName !== undefined || nextRequestedEnabled)) {
    await validateApiKeyNotAssigned(nextAssignedApiKeyName, tenantId, 'strategy-client');
  }

  const { catalog: sourceCatalog } = await loadCatalogAndSweepWithFallback();
  const offerStore = await getOfferStoreAdminState();
  const storefrontSet = getStorefrontOfferIds(offerStore);
  const catalog = filterCatalogByStorefrontOfferIds(sourceCatalog, storefrontSet);
  const selectedOffers = catalog
    ? nextOfferIds.map((offerId) => findOfferByIdOrNull(catalog, offerId)).filter((item): item is CatalogOffer => !!item)
    : [];
  const constraints = buildStrategySelectionConstraints(plan, selectedOffers);

  if (catalog && selectedOffers.length !== nextOfferIds.length) {
    const missing = nextOfferIds.filter((offerId) => !selectedOffers.find((item) => item.offerId === offerId));
    throw new Error(`Unknown offers in selection: ${missing.join(', ')}`);
  }
  if (constraints.violations.length > 0) {
    throw new Error(constraints.violations.join(' '));
  }

  // D3: Pair duplicate validation — removed, TS unification handles same-pair strategies via position limiter

  await db.run(
    `UPDATE strategy_client_profiles
     SET selected_offer_ids_json = ?,
         active_system_profile_id = ?,
         risk_level = ?,
         trade_frequency_level = ?,
         requested_enabled = ?,
         actual_enabled = ?,
         assigned_api_key_name = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [JSON.stringify(nextOfferIds), activeSystemProfile?.id || null, nextRiskLevel, nextTradeFrequencyLevel, nextRequestedEnabled ? 1 : 0, nextRequestedEnabled ? 1 : 0, nextAssignedApiKeyName, tenantId]
  );

  if (activeSystemProfile?.id) {
    await db.run(
      `UPDATE strategy_client_system_profiles
       SET selected_offer_ids_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [JSON.stringify(nextOfferIds), activeSystemProfile.id, tenantId]
    );
  }

  await syncTenantAssignedApiKeyName(tenantId);

  // When toggling OFF: cancel orders, close positions
  const wasEnabled = Number(existing.requested_enabled || 0) === 1;
  const shutdownApiKeyName = currentAssignedApiKeyName || nextAssignedApiKeyName;
  if (wasEnabled && !nextRequestedEnabled && shutdownApiKeyName) {
    logger.info(`[updateStrategyClientState] Tenant ${tenantId} toggled OFF — stopping orders/positions for ${shutdownApiKeyName}`);
    try { await cancelAllOrders(shutdownApiKeyName); } catch (e) { logger.warn(`cancelAllOrders on toggle-off for ${shutdownApiKeyName}: ${(e as Error).message}`); }
    try { await closeAllPositions(shutdownApiKeyName); } catch (e) { logger.warn(`closeAllPositions on toggle-off for ${shutdownApiKeyName}: ${(e as Error).message}`); }
  }

  // Per-offer cleanup: when offers are removed while still enabled, cancel orders for those markets
  if (nextRequestedEnabled && nextAssignedApiKeyName && catalog) {
    const removedOfferIds = activeOfferIds.filter((id) => !nextOfferIds.includes(id));
    if (removedOfferIds.length > 0) {
      const removedOffers = removedOfferIds
        .map((offerId) => findOfferByIdOrNull(catalog, offerId))
        .filter((item): item is CatalogOffer => !!item);
      for (const offer of removedOffers) {
        const market = String(offer.strategy?.market || '').toUpperCase().trim();
        if (!market) continue;
        logger.info(`[updateStrategyClientState] Tenant ${tenantId} removed offer ${offer.offerId} (${market}) — cancelling orders`);
        try { await cancelAllOrders(nextAssignedApiKeyName, market); } catch (e) { logger.warn(`cancelAllOrders per-market ${market} for ${nextAssignedApiKeyName}: ${(e as Error).message}`); }
      }
      // Dematerialize runtime strategies for removed offers — DELETE (не архивировать)
      const removedStrategyIds = removedOffers.map((o) => Number(o.strategy?.id || 0)).filter((v) => v > 0);
      if (removedStrategyIds.length > 0) {
        const dematPattern = `SAAS::${tenant.slug}::%`;
        for (const sid of removedStrategyIds) {
          await db.run(
            `DELETE FROM strategies WHERE is_runtime = 1 AND name LIKE ? AND name LIKE ?`,
            [dematPattern, `%::SID${sid}`]
          ).catch((e) => logger.warn(`demat delete strategy SID${sid} for ${tenant.slug}: ${(e as Error).message}`));
        }
        logger.info(`[updateStrategyClientState] Tenant ${tenantId} deleted ${removedStrategyIds.length} runtime strategies for removed offers`);
      }
    }
  }

  // When toggling OFF: DELETE all runtime strategies for this tenant (не оставлять мусор в дашборде)
  if (wasEnabled && !nextRequestedEnabled) {
    const dematPattern = `SAAS::${tenant.slug}::%`;
    const dematResult = await db.run(
      `DELETE FROM strategies WHERE is_runtime = 1 AND name LIKE ?`,
      [dematPattern]
    ).catch(() => ({ changes: 0 }));
    logger.info(`[updateStrategyClientState] Tenant ${tenantId} toggled OFF — deleted ${(dematResult as any)?.changes || 0} runtime strategies`);
  }

  return getStrategyClientState(tenantId);
};

export const batchConnectStrategyClientOffer = async (offerIds: string[], tenantIds: number[]): Promise<{ success: number; errors: string[] }> => {
  const errors: string[] = [];
  let success = 0;
  for (const tenantId of tenantIds) {
    try {
      const existing = await getStrategyClientProfile(tenantId);
      if (!existing) {
        errors.push(`Tenant ${tenantId}: нет профиля strategy-client`);
        continue;
      }
      const currentOfferIds = safeJsonParse<string[]>(existing.selected_offer_ids_json, []);
      const merged = Array.from(new Set([...currentOfferIds, ...offerIds]));
      await updateStrategyClientState(tenantId, { selectedOfferIds: merged, requestedEnabled: true });
      success++;
    } catch (e) {
      errors.push(`Tenant ${tenantId}: ${(e as Error).message}`);
    }
  }
  return { success, errors };
};

export const listStrategyClientSystemProfilesState = async (tenantId: number) => {
  await getTenantById(tenantId);
  const profile = await getStrategyClientProfile(tenantId);
  const fallback = profile ? safeJsonParse<string[]>(profile.selected_offer_ids_json, []) : [];
  const rows = await ensureDefaultStrategyClientSystemProfile(tenantId, fallback);
  return {
    tenantId,
    items: rows.map((item) => ({
      id: item.id,
      profileName: item.profile_name,
      selectedOfferIds: safeJsonParse<string[]>(item.selected_offer_ids_json, []),
      isActive: Number(item.is_active || 0) === 1,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
  };
};

export const createStrategyClientSystemProfile = async (
  tenantId: number,
  profileName: string,
  selectedOfferIds?: string[],
  activate: boolean = false
) => {
  const state = await getStrategyClientState(tenantId);
  const existingRows = await listStrategyClientSystemProfiles(tenantId);
  const maxCustomSystems = state.constraints?.limits?.maxCustomSystems || 1;
  if (existingRows.length >= maxCustomSystems) {
    throw new Error(`Custom TS cap reached (${existingRows.length}/${maxCustomSystems}).`);
  }

  const fallbackSelected = Array.isArray(state.profile?.selectedOfferIds) ? state.profile?.selectedOfferIds : [];
  const normalizedOfferIds = Array.isArray(selectedOfferIds)
    ? Array.from(new Set(selectedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : fallbackSelected;

  const name = asString(profileName, `Custom TS ${existingRows.length + 1}`);
  const insertResult = await db.run(
    `INSERT INTO strategy_client_system_profiles (tenant_id, profile_name, selected_offer_ids_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [tenantId, name, JSON.stringify(normalizedOfferIds), activate ? 1 : 0]
  );

  const createdId = Number((insertResult as any)?.lastID || 0);
  if (activate && createdId > 0) {
    await activateStrategyClientSystemProfile(tenantId, createdId);
    await syncLegacySelectedOffersFromActiveProfile(tenantId);
  }

  return listStrategyClientSystemProfilesState(tenantId);
};

export const updateStrategyClientSystemProfile = async (
  tenantId: number,
  profileId: number,
  payload: { profileName?: string; selectedOfferIds?: string[] }
) => {
  const current = await getStrategyClientSystemProfileById(tenantId, profileId);
  if (!current) {
    throw new Error(`Strategy system profile not found: ${profileId}`);
  }

  const nextName = payload.profileName !== undefined
    ? asString(payload.profileName, current.profile_name)
    : current.profile_name;
  const nextOfferIds = Array.isArray(payload.selectedOfferIds)
    ? Array.from(new Set(payload.selectedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : safeJsonParse<string[]>(current.selected_offer_ids_json, []);

  await db.run(
    `UPDATE strategy_client_system_profiles
     SET profile_name = ?, selected_offer_ids_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND tenant_id = ?`,
    [nextName, JSON.stringify(nextOfferIds), profileId, tenantId]
  );

  if (Number(current.is_active || 0) === 1) {
    await syncLegacySelectedOffersFromActiveProfile(tenantId);
  }

  return listStrategyClientSystemProfilesState(tenantId);
};

export const deleteStrategyClientSystemProfile = async (tenantId: number, profileId: number) => {
  const rows = await listStrategyClientSystemProfiles(tenantId);
  const target = rows.find((item) => Number(item.id) === profileId);
  if (!target) {
    throw new Error(`Strategy system profile not found: ${profileId}`);
  }
  if (rows.length <= 1) {
    throw new Error('At least one custom TS profile must remain.');
  }

  await db.run('DELETE FROM strategy_client_system_profiles WHERE id = ? AND tenant_id = ?', [profileId, tenantId]);

  if (Number(target.is_active || 0) === 1) {
    const afterDelete = await listStrategyClientSystemProfiles(tenantId);
    const fallback = afterDelete[0];
    if (fallback?.id) {
      await activateStrategyClientSystemProfile(tenantId, Number(fallback.id));
    }
    await syncLegacySelectedOffersFromActiveProfile(tenantId);
  }

  return listStrategyClientSystemProfilesState(tenantId);
};

export const activateStrategyClientSystemProfileById = async (tenantId: number, profileId: number) => {
  const target = await getStrategyClientSystemProfileById(tenantId, profileId);
  if (!target) {
    throw new Error(`Strategy system profile not found: ${profileId}`);
  }
  await activateStrategyClientSystemProfile(tenantId, profileId);
  await syncLegacySelectedOffersFromActiveProfile(tenantId);
  return getStrategyClientState(tenantId);
};

export const requestAlgofundBatchAction = async (
  tenantIds: number[],
  requestType: AlgofundRequestType,
  note: string,
  payload: AlgofundRequestPayload = {},
  options?: { directExecute?: boolean }
) => {
  const normalizedTenantIds = Array.from(new Set((tenantIds || []).map((item) => Math.floor(asNumber(item, 0))).filter((item) => item > 0)));
  const created: Array<Record<string, unknown>> = [];
  const failures: Array<{ tenantId: number; error: string }> = [];
  const directExecute = Boolean(options?.directExecute)
    && (requestType === 'start' || requestType === 'stop' || requestType === 'switch_system');

  for (const tenantId of normalizedTenantIds) {
    try {
      const tenant = await getTenantById(tenantId);
      if (tenant.product_mode !== 'algofund_client' && tenant.product_mode !== 'dual') {
        throw new Error('Tenant is not algofund client');
      }

      if (directExecute) {
        const plan = await getPlanForTenant(tenantId, 'algofund_client');
        const profile = await getAlgofundProfile(tenantId);
        if (!plan || !profile) {
          throw new Error('Algofund plan/profile not found');
        }

        const capabilities = resolvePlanCapabilities(plan);
        if (!capabilities.startStopRequests) {
          throw new Error('Start/stop requests are not available for the current plan');
        }

        let directPayload: AlgofundRequestPayload = { ...payload };
        if (requestType === 'switch_system') {
          const targetSystemId = Math.floor(asNumber(payload.targetSystemId, 0));
          const targetSystemNameRaw = asString(payload.targetSystemName, '').trim();
          if ((!targetSystemId || targetSystemId <= 0) && !targetSystemNameRaw) {
            throw new Error('targetSystemId or targetSystemName is required for switch_system request');
          }

          // Skip re-materialization if already connected to the same system and running
          const currentSystemName = asString(profile.published_system_name, '').trim();
          const targetNameNormForCheck = targetSystemNameRaw || '';
          if (
            profile.actual_enabled === 1
            && currentSystemName
            && targetNameNormForCheck
            && currentSystemName === targetNameNormForCheck
          ) {
            const runtimeKey = asString(getAlgofundExecutionApiKeyName(tenant, profile), '').trim();
            const activeCount = runtimeKey
              ? await db.get(
                `SELECT COUNT(*) AS cnt FROM strategies s
                 JOIN api_keys ak ON ak.id = s.api_key_id
                 WHERE ak.name = ? AND COALESCE(s.is_runtime,0)=1 AND COALESCE(s.is_active,0)=1`,
                [runtimeKey]
              ).then((r: any) => Number((r as any)?.cnt || 0)).catch(() => 0)
              : 0;
            if (activeCount > 0) {
              created.push({ tenantId, directAction: requestType, status: 'skipped_already_connected', systemName: currentSystemName });
              continue;
            }
          }

          const targetById = targetSystemId > 0
            ? await db.get(
              `SELECT ts.id AS system_id, ts.name AS system_name, ak.name AS api_key_name
               FROM trading_systems ts
               JOIN api_keys ak ON ak.id = ts.api_key_id
               WHERE ts.id = ?`,
              [targetSystemId]
            ) as { system_id?: number; system_name?: string; api_key_name?: string } | undefined
            : undefined;

          const targetByName = !targetById?.system_id && targetSystemNameRaw
            ? await db.get(
              `SELECT ts.id AS system_id, ts.name AS system_name, ak.name AS api_key_name
               FROM trading_systems ts
               JOIN api_keys ak ON ak.id = ts.api_key_id
               WHERE ts.name = ?
               ORDER BY COALESCE(ts.is_active, 0) DESC, ts.id DESC
               LIMIT 1`,
              [targetSystemNameRaw]
            ) as { system_id?: number; system_name?: string; api_key_name?: string } | undefined
            : undefined;

          const resolvedTarget = targetById?.system_id ? targetById : targetByName;
          let virtualTarget: { system_name: string; api_key_name: string } | null = null;
          if (!resolvedTarget?.system_id && targetSystemNameRaw) {
            const tsSnapshots = await getTsBacktestSnapshots().catch(() => ({} as Record<string, TsBacktestSnapshot>));
            const targetNameNormalized = targetSystemNameRaw.toUpperCase();
            for (const [setKey, snapshot] of Object.entries(tsSnapshots || {})) {
              const keyNormalized = asString(setKey, '').trim().toUpperCase();
              const snapshotNameNormalized = asString(snapshot?.systemName, '').trim().toUpperCase();
              if (keyNormalized === targetNameNormalized || snapshotNameNormalized === targetNameNormalized) {
                const resolvedName = asString(setKey, targetSystemNameRaw).trim() || targetSystemNameRaw;
                const resolvedApiKey = asString(snapshot?.apiKeyName, '').trim() || getAlgofundPublishedSourceApiKeyName(resolvedName);
                virtualTarget = {
                  system_name: resolvedName,
                  api_key_name: resolvedApiKey,
                };
                break;
              }
            }
          }

          if (!resolvedTarget?.system_id && !virtualTarget) {
            throw new Error(`Target trading system not found: ${targetSystemId || targetSystemNameRaw}`);
          }

          directPayload = {
            targetSystemId: Number(resolvedTarget?.system_id || targetSystemId || 0),
            targetSystemName: asString(resolvedTarget?.system_name || virtualTarget?.system_name, targetSystemNameRaw),
            targetApiKeyName: asString(resolvedTarget?.api_key_name || virtualTarget?.api_key_name, ''),
          };
        }

        await applyApprovedAlgofundAction({
          row: {
            tenant_id: tenantId,
            request_type: requestType,
          } as AlgofundRequestRow,
          requestPayload: directPayload,
          tenant,
          profile,
          plan,
          decisionNote: note,
        });

        await db.run(
          `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
           VALUES (?, 'admin', 'direct_algofund_action', ?, CURRENT_TIMESTAMP)`,
          [tenantId, JSON.stringify({ requestType, note, payload: directPayload })]
        );

        created.push({ tenantId, directAction: requestType, status: 'executed' });
      } else {
        const result = await requestAlgofundAction(tenantId, requestType, note, payload);
        created.push({ tenantId, request: result });
      }
    } catch (error) {
      failures.push({ tenantId, error: String((error as Error)?.message || error || 'failed') });
    }
  }

  return {
    total: normalizedTenantIds.length,
    createdCount: created.length,
    failedCount: failures.length,
    created,
    failures,
  };
};

export const analyzeOfferUnpublishImpact = async (offerIdRaw: string): Promise<OfferUnpublishImpact> => {
  const offerId = asString(offerIdRaw, '');
  if (!offerId) {
    throw new Error('offerId is required');
  }

  const tenants = (await listTenantSummaries()) as Array<{ tenant: TenantRow; plan: PlanRow | null }>;
  const strategyProfiles = (await db.all('SELECT tenant_id, selected_offer_ids_json FROM strategy_client_profiles')) as Array<{ tenant_id: number; selected_offer_ids_json: string }>;
  const systemProfiles = (await db.all('SELECT tenant_id, selected_offer_ids_json FROM strategy_client_system_profiles WHERE is_active = 1')) as Array<{ tenant_id: number; selected_offer_ids_json: string }>;

  const legacyByTenant = new Map<number, string[]>();
  for (const row of strategyProfiles) {
    legacyByTenant.set(Number(row.tenant_id), safeJsonParse<string[]>(row.selected_offer_ids_json, []));
  }
  const activeByTenant = new Map<number, string[]>();
  for (const row of systemProfiles) {
    activeByTenant.set(Number(row.tenant_id), safeJsonParse<string[]>(row.selected_offer_ids_json, []));
  }

  const affectedTenants = tenants
    .filter((row) => row.tenant.product_mode === 'strategy_client' || row.tenant.product_mode === 'dual')
    .filter((row) => {
      const tenantId = Number(row.tenant.id);
      const active = activeByTenant.get(tenantId);
      const fallback = legacyByTenant.get(tenantId) || [];
      const selected = Array.isArray(active) && active.length > 0 ? active : fallback;
      return selected.includes(offerId);
    })
    .map((row) => ({
      tenantId: Number(row.tenant.id),
      slug: asString(row.tenant.slug, ''),
      displayName: asString(row.tenant.display_name, ''),
      productMode: row.tenant.product_mode,
      assignedApiKeyName: asString(row.tenant.assigned_api_key_name, ''),
    }));

  const openPositions: OfferUnpublishImpact['openPositions'] = [];
  for (const tenant of affectedTenants) {
    if (!tenant.assignedApiKeyName) {
      continue;
    }
    try {
      const positionsRaw = await getPositions(tenant.assignedApiKeyName);
      const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
      const actionable = positions.filter((row: any) => Math.abs(Number(row?.size || 0)) > 0);
      if (actionable.length > 0) {
        openPositions.push({
          tenantId: tenant.tenantId,
          apiKeyName: tenant.assignedApiKeyName,
          count: actionable.length,
          symbols: actionable.slice(0, 8).map((row: any) => asString(row?.symbol || row?.pair || '', '')).filter(Boolean),
        });
      }
    } catch {
      // Keep impact analysis resilient even if exchange API call fails for one tenant.
    }
  }

  return {
    offerId,
    affectedTenants,
    openPositions,
    summary: {
      tenantCount: affectedTenants.length,
      openPositionsCount: openPositions.reduce((acc, row) => acc + Number(row.count || 0), 0),
    },
  };
};

export const previewStrategyClientOffer = async (
  tenantId: number,
  offerId: string,
  riskLevel?: Level3,
  tradeFrequencyLevel?: Level3,
  riskScore?: number,
  tradeFrequencyScore?: number
) => {
  const state = await getStrategyClientState(tenantId);
  const sweep = loadLatestSweep();
  const period = buildPeriodInfo(sweep);
  const initialBalance = asNumber(sweep?.config?.initialBalance, 10000);
  const resolvedRisk = riskLevel || (state.profile?.risk_level as Level3) || 'medium';
  const resolvedTradeFrequency = tradeFrequencyLevel || (state.profile?.trade_frequency_level as Level3) || 'medium';
  const normalizedRiskScore = normalizePreferenceScore(riskScore, resolvedRisk);
  const normalizedTradeFrequencyScore = normalizePreferenceScore(tradeFrequencyScore, resolvedTradeFrequency);
  const controls = {
    riskScore: normalizedRiskScore,
    tradeFrequencyScore: normalizedTradeFrequencyScore,
    riskLevel: preferenceScoreToLevel(normalizedRiskScore),
    tradeFrequencyLevel: preferenceScoreToLevel(normalizedTradeFrequencyScore),
  };

  if (!state.catalog) {
    const latestPreview = (state.profile?.latestPreview || {}) as Record<string, any>;
    const cachedPreview = (latestPreview.preview || latestPreview) as Record<string, any>;

    return {
      offer: null,
      preset: null,
      controls,
      period,
      preview: {
        source: 'cached_preview_fallback',
        summary: cachedPreview.summary || null,
        equity: cachedPreview.equity || [],
        trades: cachedPreview.trades || [],
        blockedByPlan: !state.capabilities?.backtest,
      },
    };
  }

  const offer = findOfferById(state.catalog, offerId);
  const preset = resolveOfferPresetByPreference(
    offer,
    resolvedRisk,
    resolvedTradeFrequency,
    normalizedRiskScore,
    normalizedTradeFrequencyScore
  );
  const candidates = collectPresetCandidates(offer);
  const hasMultiplePresets = candidates.length > 1;
  const baseEquity = offer.equity && offer.strategy.id === preset.strategyId ? offer.equity : null;

  if (baseEquity && Array.isArray(baseEquity.points) && baseEquity.points.length > 0) {
    // When presetMatrix has multiple options, use preset.metrics for summary so sliders affect the numbers.
    // The equity curve is rebuilt from the scaled return to match.
    const presetRet = asNumber(preset.metrics.ret, 0);
    const presetSummary = hasMultiplePresets ? {
      finalEquity: Number((initialBalance * (1 + presetRet / 100)).toFixed(4)),
      totalReturnPercent: presetRet,
      maxDrawdownPercent: asNumber(preset.metrics.dd, 0),
      winRatePercent: asNumber(preset.metrics.wr, 0),
      profitFactor: asNumber(preset.metrics.pf, 1),
      tradesCount: Math.max(0, Math.floor(asNumber(preset.metrics.trades, 0))),
    } : baseEquity.summary;
    const equityPoints = hasMultiplePresets
      ? toPresetOnlyEquity(initialBalance, presetRet)
      : baseEquity.points;
    const preview = {
      source: hasMultiplePresets ? 'preset_scaled' : 'catalog_cache',
      summary: presetSummary,
      equity: { ...baseEquity, points: equityPoints, summary: presetSummary },
    };

    const latestPreviewPayload = { offerId, offer, preset, controls, period, preview };

    await db.run(
      `UPDATE strategy_client_profiles
       SET latest_preview_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [JSON.stringify(latestPreviewPayload), tenantId]
    );

    return {
      offer,
      preset,
      controls,
      period,
      preview,
    };
  }

  const presetOnlyMode = CLIENT_STRICT_PRESET_MODE || !state.capabilities?.backtest;
  if (presetOnlyMode) {
    const preview = {
      source: 'preset_lookup_no_live',
      summary: buildPresetOnlySingleSummary(initialBalance, preset, offer.strategy.market, offer.strategy.name),
      equity: {
        source: 'preset_lookup_no_live',
        generatedAt: new Date().toISOString(),
        points: toPresetOnlyEquity(initialBalance, asNumber(preset.metrics.ret, 0)),
        summary: {
          finalEquity: Number((initialBalance * (1 + asNumber(preset.metrics.ret, 0) / 100)).toFixed(4)),
          totalReturnPercent: asNumber(preset.metrics.ret, 0),
          maxDrawdownPercent: asNumber(preset.metrics.dd, 0),
          winRatePercent: asNumber(preset.metrics.wr, 0),
          profitFactor: asNumber(preset.metrics.pf, 1),
          tradesCount: Math.max(0, Math.floor(asNumber(preset.metrics.trades, 0))),
        },
      },
      trades: [],
      strictPresetMode: true,
    };

    const latestPreviewPayload = { offerId, offer, preset, controls, period, preview };
    await db.run(
      `UPDATE strategy_client_profiles
       SET latest_preview_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [JSON.stringify(latestPreviewPayload), tenantId]
    );

    return { offer, preset, controls, period, preview };
  }

  const singleInitBal = asNumber(sweep?.config?.initialBalance, 10000);
  const record = findSweepRecordByStrategyId(sweep, preset.strategyId);
  const strategyId = record ? Number(record.strategyId) : preset.strategyId;

  const queued = await enqueueClientPreview({
    tenantId,
    apiKeyName: state.catalog.apiKeyName,
    kind: 'single',
    strategyId,
    bars: asNumber(sweep?.config?.backtestBars, 6000),
    warmupBars: asNumber(sweep?.config?.warmupBars, 400),
    skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
    initialBalance: singleInitBal,
    commissionPercent: asNumber(sweep?.config?.commissionPercent, 0.1),
    slippagePercent: asNumber(sweep?.config?.slippagePercent, 0.05),
    fundingRatePercent: asNumber(sweep?.config?.fundingRatePercent, 0),
    maxDepositOverride: singleInitBal * CARD_PREVIEW_MAX_DEPOSIT_GROWTH_X,
    lotPercentOverride: 100,
  });

  if (queued.status === 'done' || queued.cached) {
    const jobPayload = await getClientPreviewJobPayload(tenantId, queued.jobId);
    if (jobPayload?.preview) {
      const preview = {
        source: 'single_backtest',
        summary: jobPayload.preview.summary,
        equity: jobPayload.preview.equity,
        trades: [],
      };
      const latestPreviewPayload = { offerId, offer, preset, controls, period, preview };
      await db.run(
        `UPDATE strategy_client_profiles
         SET latest_preview_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`,
        [JSON.stringify(latestPreviewPayload), tenantId]
      );
      return { offer, preset, controls, period, preview };
    }
  }

  const preview = {
    source: 'queued_backtest',
    jobId: queued.jobId,
    status: queued.status,
    summary: null,
    equity: [],
    trades: [],
  };

  const latestPreviewPayload = { offerId, offer, preset, controls, period, preview };

  await db.run(
    `UPDATE strategy_client_profiles
     SET latest_preview_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [JSON.stringify(latestPreviewPayload), tenantId]
  );

  return { offer, preset, controls, period, preview };
};

export const previewStrategyClientSelection = async (
  tenantId: number,
  payload?: {
    selectedOfferIds?: string[];
    riskLevel?: Level3;
    tradeFrequencyLevel?: Level3;
    riskScore?: number;
    tradeFrequencyScore?: number;
  }
) => {
  const state = await getStrategyClientState(tenantId);
  const sweep = loadLatestSweep();
  const period = buildPeriodInfo(sweep);
  const initialBalance = asNumber(sweep?.config?.initialBalance, 10000);
  const resolvedRisk = payload?.riskLevel || (state.profile?.risk_level as Level3) || 'medium';
  const resolvedTradeFrequency = payload?.tradeFrequencyLevel || (state.profile?.trade_frequency_level as Level3) || 'medium';
  const normalizedRiskScore = normalizePreferenceScore(payload?.riskScore, resolvedRisk);
  const normalizedTradeFrequencyScore = normalizePreferenceScore(payload?.tradeFrequencyScore, resolvedTradeFrequency);
  const controls = {
    riskScore: normalizedRiskScore,
    tradeFrequencyScore: normalizedTradeFrequencyScore,
    riskLevel: preferenceScoreToLevel(normalizedRiskScore),
    tradeFrequencyLevel: preferenceScoreToLevel(normalizedTradeFrequencyScore),
  };

  if (!state.catalog) {
    const latestPreview = (state.profile?.latestPreview || {}) as Record<string, any>;
    const cachedPreview = (latestPreview.preview || latestPreview) as Record<string, any>;

    return {
      period,
      controls,
      selectedOffers: [],
      preview: {
        source: 'cached_preview_fallback',
        summary: cachedPreview.summary || null,
        equity: cachedPreview.equity || [],
        trades: cachedPreview.trades || [],
        blockedByPlan: !state.capabilities?.backtest,
      },
    };
  }

  const fallbackOfferIds = Array.isArray(state.profile?.selectedOfferIds)
    ? state.profile.selectedOfferIds
    : [];
  const selectedOfferIds = Array.isArray(payload?.selectedOfferIds)
    ? payload.selectedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)
    : fallbackOfferIds;

  if (selectedOfferIds.length === 0) {
    return {
      period,
      controls,
      selectedOffers: [],
      preview: {
        source: 'portfolio_backtest_empty',
        summary: null,
        equity: [],
        trades: [],
      },
    };
  }

  const selectedOffers = selectedOfferIds.map((offerId) => {
    const offer = findOfferById(state.catalog as CatalogData, offerId);
    const preset = resolveOfferPresetByPreference(
      offer,
      resolvedRisk,
      resolvedTradeFrequency,
      normalizedRiskScore,
      normalizedTradeFrequencyScore
    );

    return {
      offerId,
      offer,
      preset,
    };
  });
  const constraints = buildStrategySelectionConstraints(state.plan, selectedOffers.map((item) => item.offer));

  const uniqueStrategyIds = Array.from(new Set(selectedOffers.map((item) => Number(item.preset.strategyId)).filter((item) => Number.isFinite(item) && item > 0)));

  if (uniqueStrategyIds.length === 0) {
    throw new Error('Selected offers did not resolve to valid strategies');
  }

  const presetOnlyMode = CLIENT_STRICT_PRESET_MODE || !state.capabilities?.backtest;
  if (presetOnlyMode) {
    return {
      period,
      controls,
      constraints,
      selectedOffers: selectedOffers.map((item) => ({
        offerId: item.offerId,
        titleRu: item.offer.titleRu,
        market: item.offer.strategy.market,
        mode: item.offer.strategy.mode,
        strategyId: item.preset.strategyId,
        strategyName: item.preset.strategyName,
        score: item.preset.score,
        metrics: item.preset.metrics,
      })),
      preview: {
        source: 'portfolio_preset_lookup',
        summary: buildPresetOnlyPortfolioSummary(initialBalance, selectedOffers),
        equity: toPresetOnlyEquity(
          initialBalance,
          selectedOffers.reduce((acc, item) => acc + asNumber(item.preset.metrics.ret, 0), 0) / Math.max(1, selectedOffers.length)
        ),
        trades: [],
        strictPresetMode: true,
      },
    };
  }

  const previewInitialBalance = asNumber(sweep?.config?.initialBalance, 10000);

  const queued = await enqueueClientPreview({
    tenantId,
    apiKeyName: state.catalog.apiKeyName,
    kind: 'portfolio',
    strategyIds: uniqueStrategyIds,
    bars: asNumber(sweep?.config?.backtestBars, 6000),
    warmupBars: asNumber(sweep?.config?.warmupBars, 400),
    skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
    initialBalance: previewInitialBalance,
    commissionPercent: asNumber(sweep?.config?.commissionPercent, 0.1),
    slippagePercent: asNumber(sweep?.config?.slippagePercent, 0.05),
    fundingRatePercent: asNumber(sweep?.config?.fundingRatePercent, 0),
    maxDepositOverride: previewInitialBalance * CARD_PREVIEW_MAX_DEPOSIT_GROWTH_X,
    lotPercentOverride: 100,
  });

  if (queued.status === 'done' || queued.cached) {
    const jobPayload = await getClientPreviewJobPayload(tenantId, queued.jobId);
    if (jobPayload?.preview) {
      return {
        period,
        controls,
        constraints,
        selectedOffers: selectedOffers.map((item) => ({
          offerId: item.offerId,
          titleRu: item.offer.titleRu,
          market: item.offer.strategy.market,
          mode: item.offer.strategy.mode,
          strategyId: item.preset.strategyId,
          strategyName: item.preset.strategyName,
          score: item.preset.score,
          metrics: item.preset.metrics,
        })),
        preview: {
          source: 'portfolio_backtest',
          summary: jobPayload.preview.summary,
          equity: jobPayload.preview.equity,
          trades: [],
        },
      };
    }
  }

  return {
    period,
    controls,
    constraints,
    selectedOffers: selectedOffers.map((item) => ({
      offerId: item.offerId,
      titleRu: item.offer.titleRu,
      market: item.offer.strategy.market,
      mode: item.offer.strategy.mode,
      strategyId: item.preset.strategyId,
      strategyName: item.preset.strategyName,
      score: item.preset.score,
      metrics: item.preset.metrics,
    })),
    preview: {
      source: 'queued_backtest',
      jobId: queued.jobId,
      status: queued.status,
      summary: null,
      equity: [],
      trades: [],
    },
  };
};

export const getStrategyClientCustomTsDraft = async (tenantId: number) => {
  const state = await getStrategyClientState(tenantId);
  const row = await getStrategyClientCustomTsDraftRow(tenantId);
  const selectedOfferIds = Array.isArray(state.profile?.selectedOfferIds)
    ? state.profile.selectedOfferIds
    : [];
  return {
    tenantId,
    draft: {
      selectedOfferIds: row ? safeJsonParse<string[]>(row.selected_offer_ids_json, []) : selectedOfferIds,
      op: Math.max(1, Math.floor(asNumber(row?.op_value, 1))),
      assignedApiKeyName: asString(row?.assigned_api_key_name, ''),
      updatedAt: row?.updated_at || null,
    },
  };
};

export const updateStrategyClientCustomTsDraft = async (
  tenantId: number,
  payload: {
    selectedOfferIds?: string[];
    op?: number;
    assignedApiKeyName?: string;
  }
) => {
  const tenant = await getTenantById(tenantId);
  const state = await getStrategyClientState(tenantId);
  const existing = await getStrategyClientCustomTsDraftRow(tenantId);

  const selectedOfferIds = Array.from(new Set((Array.isArray(payload.selectedOfferIds) ? payload.selectedOfferIds : safeJsonParse<string[]>(existing?.selected_offer_ids_json || '[]', []))
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
  const op = Math.max(1, Math.floor(asNumber(payload.op, asNumber(existing?.op_value, 1))));
  const assignedApiKeyName = resolveAssignedApiKeyInput(
    payload as Record<string, unknown>,
    'assignedApiKeyName',
    asString(existing?.assigned_api_key_name, '').trim(),
  );

  if (assignedApiKeyName) {
    const strategyAssigned = asString(state.profile?.assigned_api_key_name, '').trim();
    const algofundAssigned = asString((await getAlgofundProfile(tenantId))?.assigned_api_key_name, '').trim();
    if (assignedApiKeyName === strategyAssigned || assignedApiKeyName === algofundAssigned) {
      throw new Error('API-ключ для собственной ТС должен быть отдельным от потоков Стратегий и Алгофонда.');
    }
    await validateApiKeyNotAssigned(assignedApiKeyName, tenantId, 'strategy-client-custom-ts');
  }

  const allowedIds = new Set((state.offers || []).map((item) => String(item.offerId || '').trim()).filter(Boolean));
  const filteredIds = selectedOfferIds.filter((id) => allowedIds.has(id));

  if (existing?.id) {
    await db.run(
      `UPDATE strategy_client_custom_ts_drafts
       SET selected_offer_ids_json = ?, op_value = ?, assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [JSON.stringify(filteredIds), op, assignedApiKeyName, tenantId]
    );
  } else {
    await db.run(
      `INSERT INTO strategy_client_custom_ts_drafts (
         tenant_id, selected_offer_ids_json, op_value, assigned_api_key_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify(filteredIds), op, assignedApiKeyName]
    );
  }

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'client', 'client_custom_ts_draft_saved', ?, CURRENT_TIMESTAMP)`,
    [
      tenantId,
      JSON.stringify({
        tenantSlug: tenant.slug,
        selectedOffersCount: filteredIds.length,
        prevOp: Math.max(1, Math.floor(asNumber(existing?.op_value, 1))),
        op,
        opChanged: Math.max(1, Math.floor(asNumber(existing?.op_value, 1))) !== op,
        assignedApiKeyName,
      }),
    ]
  );

  return getStrategyClientCustomTsDraft(tenantId);
};

export const previewStrategyClientCustomTsDraft = async (
  tenantId: number,
  payload?: {
    selectedOfferIds?: string[];
    op?: number;
    assignedApiKeyName?: string;
    riskLevel?: Level3;
    tradeFrequencyLevel?: Level3;
    riskScore?: number;
    tradeFrequencyScore?: number;
  }
) => {
  const state = await getStrategyClientState(tenantId);
  const tenant = await getTenantById(tenantId);
  const currentDraft = await getStrategyClientCustomTsDraft(tenantId);
  const selectedOfferIds = Array.isArray(payload?.selectedOfferIds)
    ? payload!.selectedOfferIds!.map((item) => String(item || '').trim()).filter(Boolean)
    : currentDraft.draft.selectedOfferIds;
  const op = Math.max(1, Math.floor(asNumber(payload?.op, currentDraft.draft.op)));
  const assignedApiKeyName = asString(payload?.assignedApiKeyName, currentDraft.draft.assignedApiKeyName).trim();

  const preview = await previewStrategyClientSelection(tenantId, {
    selectedOfferIds,
    riskLevel: payload?.riskLevel,
    tradeFrequencyLevel: payload?.tradeFrequencyLevel,
    riskScore: payload?.riskScore,
    tradeFrequencyScore: payload?.tradeFrequencyScore,
  });

  const { sweep } = await loadCatalogAndSweepWithFallback();
  const selectedRows = Array.isArray(preview.selectedOffers) ? preview.selectedOffers : [];
  const materializationPreview = selectedRows.map((item) => {
    const record = sweep ? findSweepRecordByStrategyId(sweep, Number(item.strategyId || 0)) : null;
    return {
      offerId: String(item.offerId || ''),
      strategyId: Number(item.strategyId || 0),
      strategyName: String(item.strategyName || ''),
      runtimeName: record ? prefixStrategyName(tenant, record) : '',
      market: String(item.market || ''),
      mode: String(item.mode || ''),
    };
  });

  return {
    tenantId,
    draft: {
      selectedOfferIds,
      op,
      assignedApiKeyName,
    },
    dryRun: preview,
    materializationPreview,
  };
};

export const listClientCustomTsSystemsState = async (tenantId: number) => {
  const [state, draftState] = await Promise.all([
    getStrategyClientState(tenantId),
    getStrategyClientCustomTsDraft(tenantId),
  ]);

  const runningNow = Boolean(state.profile?.requested_enabled) && Boolean(state.profile?.actual_enabled);

  return {
    tenantId,
    draft: draftState.draft,
    items: (state.systemProfiles || []).map((item) => {
      const isActive = Boolean(item?.isActive);
      const selectedOfferIds = Array.isArray(item?.selectedOfferIds) ? item.selectedOfferIds : [];
      return {
        id: Number(item?.id || 0),
        profileName: String(item?.profileName || ''),
        selectedOfferIds,
        selectedOffersCount: selectedOfferIds.length,
        isActive,
        status: isActive && runningNow ? 'running' : 'saved',
        canStart: selectedOfferIds.length > 0,
        canStop: isActive && runningNow,
        createdAt: item?.createdAt || null,
        updatedAt: item?.updatedAt || null,
      };
    }),
  };
};

export const saveClientCustomTsSystemFromDraft = async (
  tenantId: number,
  payload?: { profileName?: string }
) => {
  const [draftState, currentState] = await Promise.all([
    getStrategyClientCustomTsDraft(tenantId),
    getStrategyClientState(tenantId),
  ]);

  const selectedOfferIds = Array.isArray(draftState.draft.selectedOfferIds)
    ? Array.from(new Set(draftState.draft.selectedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : [];
  if (selectedOfferIds.length === 0) {
    throw new Error('Для сохранения кастом ТС выберите хотя бы один оффер.');
  }

  const defaultName = `Custom TS ${Math.max(1, Number((currentState.systemProfiles || []).length || 0))}`;
  const profileName = asString(payload?.profileName, defaultName);
  const maxCustomSystems = Math.max(1, Math.floor(asNumber(currentState.constraints?.limits?.maxCustomSystems, 1)));
  const existingItems = Array.isArray(currentState.systemProfiles) ? currentState.systemProfiles : [];

  if (existingItems.length >= maxCustomSystems) {
    const target = existingItems.find((item) => item.isActive) || existingItems[0];
    if (!target?.id) {
      throw new Error('Не удалось определить профиль кастом ТС для обновления.');
    }
    await updateStrategyClientSystemProfile(tenantId, Number(target.id), {
      profileName,
      selectedOfferIds,
    });
    await activateStrategyClientSystemProfileById(tenantId, Number(target.id));
  } else {
    await createStrategyClientSystemProfile(tenantId, profileName, selectedOfferIds, true);
  }

  const assignedApiKeyName = asString(draftState.draft.assignedApiKeyName, '').trim();
  if (assignedApiKeyName) {
    await updateStrategyClientState(tenantId, {
      assignedApiKeyName,
      requestedEnabled: false,
    });
  }

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'client', 'client_custom_ts_saved_from_draft', ?, CURRENT_TIMESTAMP)`,
    [
      tenantId,
      JSON.stringify({
        profileName,
        selectedOffersCount: selectedOfferIds.length,
        assignedApiKeyName,
      }),
    ]
  );

  return listClientCustomTsSystemsState(tenantId);
};

export const startClientCustomTsSystem = async (
  tenantId: number,
  profileId: number,
  payload?: { assignedApiKeyName?: string }
) => {
  const [state, draftState] = await Promise.all([
    getStrategyClientState(tenantId),
    getStrategyClientCustomTsDraft(tenantId),
  ]);
  const target = (state.systemProfiles || []).find((item) => Number(item.id || 0) === profileId);
  if (!target) {
    throw new Error(`Кастом ТС не найден: ${profileId}`);
  }

  const selectedOfferIds = Array.isArray(target.selectedOfferIds)
    ? target.selectedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (selectedOfferIds.length === 0) {
    throw new Error('Нельзя запустить кастом ТС без выбранных офферов.');
  }

  const assignedApiKeyName = asString(payload?.assignedApiKeyName, draftState.draft.assignedApiKeyName).trim();
  if (!assignedApiKeyName) {
    throw new Error('Для запуска кастом ТС назначьте отдельный API-ключ.');
  }

  await activateStrategyClientSystemProfileById(tenantId, profileId);
  await updateStrategyClientState(tenantId, {
    selectedOfferIds,
    assignedApiKeyName,
    requestedEnabled: true,
  });

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'client', 'client_custom_ts_started', ?, CURRENT_TIMESTAMP)`,
    [
      tenantId,
      JSON.stringify({
        profileId,
        profileName: target.profileName,
        selectedOffersCount: selectedOfferIds.length,
        assignedApiKeyName,
      }),
    ]
  );

  return listClientCustomTsSystemsState(tenantId);
};

export const stopClientCustomTsSystem = async (tenantId: number, profileId: number) => {
  const state = await getStrategyClientState(tenantId);
  const target = (state.systemProfiles || []).find((item) => Number(item.id || 0) === profileId);
  if (!target) {
    throw new Error(`Кастом ТС не найден: ${profileId}`);
  }

  await activateStrategyClientSystemProfileById(tenantId, profileId);
  await updateStrategyClientState(tenantId, {
    requestedEnabled: false,
  });

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'client', 'client_custom_ts_stopped', ?, CURRENT_TIMESTAMP)`,
    [
      tenantId,
      JSON.stringify({
        profileId,
        profileName: target.profileName,
      }),
    ]
  );

  return listClientCustomTsSystemsState(tenantId);
};

export const previewClientCustomTsSystemById = async (
  tenantId: number,
  profileId: number,
  payload?: {
    riskLevel?: Level3;
    tradeFrequencyLevel?: Level3;
    riskScore?: number;
    tradeFrequencyScore?: number;
  }
) => {
  const state = await getStrategyClientState(tenantId);
  const target = (state.systemProfiles || []).find((item) => Number(item.id || 0) === profileId);
  if (!target) {
    throw new Error(`Кастом ТС не найден: ${profileId}`);
  }

  const selectedOfferIds = Array.isArray(target.selectedOfferIds)
    ? target.selectedOfferIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (selectedOfferIds.length === 0) {
    throw new Error('У этой кастом ТС нет выбранных офферов для бэктеста.');
  }

  const preview = await previewStrategyClientSelection(tenantId, {
    selectedOfferIds,
    riskLevel: payload?.riskLevel,
    tradeFrequencyLevel: payload?.tradeFrequencyLevel,
    riskScore: payload?.riskScore,
    tradeFrequencyScore: payload?.tradeFrequencyScore,
  });

  return {
    tenantId,
    profileId,
    profileName: target.profileName,
    selectedOffersCount: selectedOfferIds.length,
    summary: preview?.preview?.summary || null,
    preview: preview?.preview || null,
    updatedAt: new Date().toISOString(),
  };
};

export const getSaasObservabilityAlerts = async () => {
  const [tenantsRows, strategyRows, algofundRows, customRows, switchRows, subscriptionRows] = await Promise.all([
    db.all('SELECT id, slug, display_name, product_mode FROM tenants ORDER BY id ASC'),
    db.all('SELECT tenant_id, requested_enabled, assigned_api_key_name FROM strategy_client_profiles'),
    db.all('SELECT tenant_id, requested_enabled, assigned_api_key_name FROM algofund_profiles'),
    db.all('SELECT tenant_id, selected_offer_ids_json, assigned_api_key_name, updated_at FROM strategy_client_custom_ts_drafts'),
    db.all(`SELECT tenant_id, payload_json, created_at
            FROM saas_audit_log
            WHERE action = 'client_billing_mode_switch_requested'
            ORDER BY id DESC`),
    db.all(`SELECT s.tenant_id, p.product_mode
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id`),
  ]);

  const strategyByTenant = new Map<number, any>((Array.isArray(strategyRows) ? strategyRows : []).map((row: any) => [Number(row.tenant_id), row]));
  const algofundByTenant = new Map<number, any>((Array.isArray(algofundRows) ? algofundRows : []).map((row: any) => [Number(row.tenant_id), row]));
  const customByTenant = new Map<number, any>((Array.isArray(customRows) ? customRows : []).map((row: any) => [Number(row.tenant_id), row]));
  const latestSwitchByTenant = new Map<number, any>();
  const subscriptionModesByTenant = new Map<number, Set<string>>();
  for (const row of (Array.isArray(switchRows) ? switchRows : []) as Array<Record<string, unknown>>) {
    const tenantId = Number(row.tenant_id || 0);
    if (tenantId > 0 && !latestSwitchByTenant.has(tenantId)) {
      latestSwitchByTenant.set(tenantId, row);
    }
  }
  for (const row of (Array.isArray(subscriptionRows) ? subscriptionRows : []) as Array<Record<string, unknown>>) {
    const tenantId = Number(row.tenant_id || 0);
    if (tenantId <= 0) continue;
    const mode = asString(row.product_mode, '').trim();
    if (!mode) continue;
    if (!subscriptionModesByTenant.has(tenantId)) {
      subscriptionModesByTenant.set(tenantId, new Set<string>());
    }
    subscriptionModesByTenant.get(tenantId)?.add(mode);
  }
  const alerts: Array<Record<string, unknown>> = [];

  for (const tenant of (Array.isArray(tenantsRows) ? tenantsRows : []) as Array<Record<string, unknown>>) {
    const tenantId = Number(tenant.id || 0);
    const strategy = strategyByTenant.get(tenantId);
    const algofund = algofundByTenant.get(tenantId);
    const custom = customByTenant.get(tenantId);
    const strategyEnabled = Number(strategy?.requested_enabled || 0) === 1;
    const algofundEnabled = Number(algofund?.requested_enabled || 0) === 1;
    const strategyKey = asString(strategy?.assigned_api_key_name, '').trim();
    const algofundKey = asString(algofund?.assigned_api_key_name, '').trim();
    const customKey = asString(custom?.assigned_api_key_name, '').trim();
    const customSelected = safeJsonParse<string[]>(asString(custom?.selected_offer_ids_json, '[]'), []);
    const switchRequest = latestSwitchByTenant.get(tenantId);
    const switchPayload = safeJsonParse<Record<string, unknown>>(asString(switchRequest?.payload_json, '{}'), {});
    const billingPolicy = safeJsonParse<Record<string, unknown>>(JSON.stringify(switchPayload.billingSwitchPolicy || {}), {});
    const hwmSnapshot = safeJsonParse<Record<string, unknown>>(JSON.stringify(switchPayload.hwmSnapshot || {}), {});
    const nextBillingCycleAt = asString(billingPolicy.nextBillingCycleAt, '');
    const nextBillingCycleMs = Date.parse(nextBillingCycleAt);
    const currentMode = asString(billingPolicy.currentMode, '').trim();
    const targetMode = asString(billingPolicy.targetMode, '').trim();
    const nowMs = Date.now();
    const pendingSwitch = Number.isFinite(nextBillingCycleMs) && nextBillingCycleMs > nowMs;

    if (strategyEnabled && !strategyKey) {
      alerts.push({ severity: 'high', type: 'missing_key_strategy', tenantId, tenantSlug: tenant.slug, tenantName: tenant.display_name });
    }
    if (algofundEnabled && !algofundKey) {
      alerts.push({ severity: 'high', type: 'missing_key_algofund', tenantId, tenantSlug: tenant.slug, tenantName: tenant.display_name });
    }
    const tenantMode = asString(tenant.product_mode, '').trim();
    const subscriptionModes = subscriptionModesByTenant.get(tenantId) || new Set<string>();
    const effectiveDualMode = tenantMode === 'dual' || (subscriptionModes.has('strategy_client') && subscriptionModes.has('algofund_client'));
    if (strategyKey && algofundKey && strategyKey === algofundKey && !effectiveDualMode && strategyEnabled && algofundEnabled) {
      alerts.push({ severity: 'high', type: 'key_conflict_strategy_algofund', tenantId, tenantSlug: tenant.slug, tenantName: tenant.display_name, apiKeyName: strategyKey });
    }
    if (customKey && (customKey === strategyKey || customKey === algofundKey)) {
      alerts.push({ severity: 'medium', type: 'key_conflict_custom_ts', tenantId, tenantSlug: tenant.slug, tenantName: tenant.display_name, apiKeyName: customKey });
    }
    if (customSelected.length > 0 && !customKey) {
      alerts.push({ severity: 'medium', type: 'custom_ts_missing_key', tenantId, tenantSlug: tenant.slug, tenantName: tenant.display_name, selectedOffersCount: customSelected.length });
    }

    if (pendingSwitch) {
      alerts.push({
        severity: 'medium',
        type: 'pending_switch',
        tenantId,
        tenantSlug: tenant.slug,
        tenantName: tenant.display_name,
        currentMode,
        targetMode,
        nextBillingCycleAt,
        uiTitle: 'Pending billing mode switch',
        uiDescription: `Switch ${currentMode || 'unknown'} -> ${targetMode || 'unknown'} is queued and will be applied at ${nextBillingCycleAt}.`,
      });

      const hwmCapturedAt = asString(hwmSnapshot.capturedAt, '').trim();
      const hwmSource = asString(hwmSnapshot.source, '').trim();
      const hwmCapturedMs = Date.parse(hwmCapturedAt);
      const hwmAgeHoursRaw = Number.isFinite(hwmCapturedMs) ? (nowMs - hwmCapturedMs) / 3600000 : Number.POSITIVE_INFINITY;
      const hwmAgeHours = Number.isFinite(hwmAgeHoursRaw) ? Math.round(hwmAgeHoursRaw * 10) / 10 : null;
      const staleSnapshot = !hwmCapturedAt || hwmSource === 'none' || hwmAgeHoursRaw > SAAS_OBSERVABILITY_HWM_STALE_HOURS;

      if (staleSnapshot) {
        const missingSnapshot = !hwmCapturedAt || hwmSource === 'none';
        alerts.push({
          severity: missingSnapshot ? 'high' : 'medium',
          type: 'stale_hwm_snapshot',
          tenantId,
          tenantSlug: tenant.slug,
          tenantName: tenant.display_name,
          hwmCapturedAt,
          hwmSource: hwmSource || 'none',
          hwmAgeHours,
          staleThresholdHours: SAAS_OBSERVABILITY_HWM_STALE_HOURS,
          uiTitle: 'Stale HWM snapshot before switch',
          uiDescription: missingSnapshot
            ? 'HWM snapshot is missing for a pending billing switch. Re-capture equity snapshot before cycle boundary.'
            : `HWM snapshot age is ${hwmAgeHours}h (threshold ${SAAS_OBSERVABILITY_HWM_STALE_HOURS}h). Refresh snapshot before cycle boundary.`,
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalAlerts: alerts.length,
    alerts,
  };
};

export const materializeStrategyClient = async (tenantId: number, activate: boolean) => {
  const state = await getStrategyClientState(tenantId);
  const profile = state.profile as (StrategyClientProfileRow & { selectedOfferIds: string[] }) | null;
  if (!profile || !state.catalog) {
    throw new Error('Strategy client profile or catalog is missing');
  }

  const plan = state.plan;
  if (!plan) {
    throw new Error('Active subscription plan not found');
  }

  const selectedOfferIds = Array.isArray(profile.selectedOfferIds) ? profile.selectedOfferIds : [];
  if (selectedOfferIds.length === 0) {
    throw new Error('No selected offers configured for this client');
  }

  const assignedApiKeyName = asString(profile.assigned_api_key_name || state.tenant.assigned_api_key_name);
  if (!assignedApiKeyName) {
    throw new Error('Assign an API key to this strategy client first');
  }

  const { sweep } = await loadCatalogAndSweepWithFallback();
  if (!sweep) {
    throw new Error('Historical sweep data unavailable (results and fallback sources are missing).');
  }

  const selectedRecords = selectedOfferIds.map((offerId) => {
    const offer = findOfferById(state.catalog as CatalogData, offerId);
    const preset = resolveOfferPreset(offer, profile.risk_level, profile.trade_frequency_level);
    const record = findSweepRecordByStrategyId(sweep, preset.strategyId);
    if (!record) {
      throw new Error(`Sweep record not found for strategyId=${preset.strategyId}`);
    }
    return {
      offerId,
      record,
      metrics: {
        ...preset.metrics,
        score: preset.score,
      },
    };
  });
  const materializeConstraints = buildStrategySelectionConstraints(plan, selectedOfferIds.map((offerId) => findOfferById(state.catalog as CatalogData, offerId)));
  if (materializeConstraints.violations.length > 0) {
    throw new Error(materializeConstraints.violations.join(' '));
  }

  const strategies = await upsertTenantStrategies(
    state.tenant as TenantRow,
    assignedApiKeyName,
    selectedRecords,
    asNumber(plan.max_deposit_total, 1000),
    profile.risk_level,
    activate || profile.requested_enabled === 1
  );

  // Atomically commit materialization state + audit log so partial failures
  // never leave actual_enabled out of sync with the audit trail.
  await runWithSqliteBusyRetry(async () => {
    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.run(
        `UPDATE strategy_client_profiles
         SET actual_enabled = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`,
        [activate || profile.requested_enabled === 1 ? 1 : 0, tenantId]
      );

      await db.run(
        `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
         VALUES (?, 'admin', 'materialize_strategy_client', ?, CURRENT_TIMESTAMP)`,
        [tenantId, JSON.stringify({ assignedApiKeyName, strategies })]
      );

      await db.exec('COMMIT');
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch { /* noop */ }
      throw err;
    }
  });

  return {
    tenant: state.tenant,
    plan,
    assignedApiKeyName,
    strategies,
  };
};

const getAlgofundClientSystemName = (tenant: TenantRow): string => `ALGOFUND::${tenant.slug}`;

const getAlgofundSystemApiKeyName = (tenant: TenantRow, profile: AlgofundProfileRow): string => {
  return asString(profile.assigned_api_key_name || tenant.assigned_api_key_name || profile.execution_api_key_name);
};

const getAlgofundExecutionApiKeyName = (tenant: TenantRow, profile: AlgofundProfileRow): string => {
  return asString(profile.execution_api_key_name || tenant.assigned_api_key_name || profile.assigned_api_key_name);
};

const getAlgofundPublishedSourceApiKeyName = (publishedSystemName: string): string => {
  const normalized = asString(publishedSystemName, '').trim();
  if (!normalized) {
    return '';
  }

  const chunks = normalized.split('::').map((part) => part.trim()).filter(Boolean);
  if (chunks.length >= 2 && chunks[0].toUpperCase() === 'ALGOFUND_MASTER') {
    return asString(chunks[1], '');
  }

  return '';
};

const normalizeAlgofundSystemToken = (value: string): string => {
  return asString(value, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
};

const resolvePublishedSystem = <T extends { name?: string }>(
  systems: T[],
  sourceSystemName: string,
): T | null => {
  const target = asString(sourceSystemName, '').trim();
  if (!target || !Array.isArray(systems) || systems.length === 0) {
    return null;
  }

  const exact = systems.find((item) => asString(item?.name, '').trim() === target);
  if (exact) {
    return exact;
  }

  const targetChunks = target.split('::').map((part) => part.trim()).filter(Boolean);
  const targetPrefix = targetChunks.slice(0, 2).join('::').toUpperCase();
  const targetToken = normalizeAlgofundSystemToken(targetChunks[targetChunks.length - 1] || target);
  if (!targetToken) {
    return null;
  }

  return systems.find((item) => {
    const candidateName = asString(item?.name, '').trim();
    if (!candidateName) {
      return false;
    }
    const candidateChunks = candidateName.split('::').map((part) => part.trim()).filter(Boolean);
    const candidatePrefix = candidateChunks.slice(0, 2).join('::').toUpperCase();
    if (targetPrefix && candidatePrefix && targetPrefix !== candidatePrefix) {
      return false;
    }
    const candidateToken = normalizeAlgofundSystemToken(candidateChunks[candidateChunks.length - 1] || candidateName);
    return candidateToken.includes(targetToken) || targetToken.includes(candidateToken);
  }) || null;
};

type MaterializeDraftMember = {
  strategyId: number;
  strategyName: string;
  strategyType: string;
  marketMode: string;
  market: string;
  interval?: string;
  score: number;
  weight: number;
};

const buildMaterializeDraftMemberFromRow = (m: Record<string, unknown>): MaterializeDraftMember => {
  const base = String(m['base_symbol'] || '');
  const quote = String(m['quote_symbol'] || '');
  return {
    strategyId: Number(m['strategy_id'] || 0),
    strategyName: String(m['strategy_name'] || `strategy-${m['strategy_id']}`),
    strategyType: String(m['strategy_type'] || ''),
    marketMode: String(m['market_mode'] || ''),
    market: quote ? `${base}/${quote}` : base,
    interval: String(m['interval'] || '').trim() || undefined,
    score: 0,
    weight: asNumber(m['weight'], 1),
  };
};

/** Drop archived master strategies so clients do not inherit zombie TS members. */
const filterMaterializeDraftMembers = async (
  tenant: TenantRow,
  draftMembers: MaterializeDraftMember[],
): Promise<MaterializeDraftMember[]> => {
  const strategyIds = draftMembers
    .map((member) => Number(member.strategyId || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (strategyIds.length === 0) {
    return draftMembers;
  }
  const placeholders = strategyIds.map(() => '?').join(',');
  const rows = (await db.all(
    `SELECT id, base_symbol, is_archived
     FROM strategies WHERE id IN (${placeholders})`,
    strategyIds,
  ).catch(() => [])) as Array<{ id: number; base_symbol: string; is_archived: number }>;
  const byId = new Map(rows.map((row) => [Number(row.id), row]));

  const kept: MaterializeDraftMember[] = [];
  for (const member of draftMembers) {
    const row = byId.get(Number(member.strategyId));
    if (!row) {
      logger.warn(`Algofund materialize: skip missing master strategy id=${member.strategyId} for ${tenant.slug}`);
      continue;
    }
    if (Number(row.is_archived) === 1) {
      logger.warn(`Algofund materialize: skip archived master strategy id=${member.strategyId} ${row.base_symbol} for ${tenant.slug}`);
      continue;
    }
    kept.push(member);
  }
  if (kept.length !== draftMembers.length) {
    logger.warn(`Algofund materialize: draft members ${draftMembers.length} -> ${kept.length} after archived filter for ${tenant.slug}`);
  }
  return kept;
};

/** Never attach archived client strategies to trading_system_members. */
const filterRunnableTradingSystemMembers = async (
  apiKeyName: string,
  members: TradingSystemMemberDraft[],
): Promise<TradingSystemMemberDraft[]> => {
  const strategyIds = members
    .map((member) => Number(member.strategy_id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (strategyIds.length === 0) {
    return members;
  }
  const placeholders = strategyIds.map(() => '?').join(',');
  const rows = (await db.all(
    `SELECT id, is_archived FROM strategies WHERE id IN (${placeholders})`,
    strategyIds,
  ).catch(() => [])) as Array<{ id: number; is_archived: number }>;
  const archivedIds = new Set(
    rows.filter((row) => Number(row.is_archived) === 1).map((row) => Number(row.id)),
  );
  if (archivedIds.size === 0) {
    return members;
  }
  const filtered = members.filter((member) => !archivedIds.has(Number(member.strategy_id)));
  logger.warn(
    `Algofund materialize: removed ${members.length - filtered.length} archived strategies from TS members on ${apiKeyName}`,
  );
  return filtered;
};

const pruneArchivedMasterCardMembers = async (cardId: number): Promise<number> => {
  const result = await db.run(
    `DELETE FROM master_card_members
     WHERE card_id = ?
       AND strategy_id IN (SELECT id FROM strategies WHERE COALESCE(is_archived, 0) = 1)`,
    [cardId],
  );
  return Number((result as { changes?: number })?.changes || 0);
};

const getAlgofundEngineState = async (
  tenant: TenantRow,
  profile: AlgofundProfileRow
): Promise<{ apiKeyName: string; systemId: number; systemName: string; isActive: boolean } | null> => {
  const apiKeyName = getAlgofundSystemApiKeyName(tenant, profile);
  if (!apiKeyName) {
    return null;
  }

  const preferredSystemName = asString(profile.published_system_name || getAlgofundClientSystemName(tenant));
  const systems = await listTradingSystems(apiKeyName);
  const existing = systems.find((item) => asString(item.name) === preferredSystemName)
    || systems.find((item) => asString(item.name) === getAlgofundClientSystemName(tenant));

  if (!existing?.id) {
    return null;
  }

  return {
    apiKeyName,
    systemId: Number(existing.id),
    systemName: asString(existing.name),
    isActive: Boolean(existing.is_active),
  };
};

const materializeAlgofundSystem = async (
  tenant: TenantRow,
  plan: PlanRow,
  profile: AlgofundProfileRow,
  activate: boolean,
  options?: {
    sourceSystemNameOverride?: string;
    clientSystemName?: string;
    preserveSiblingSystems?: boolean;
    memberWeightScale?: number;
    skipProfilePublishUpdate?: boolean;
    keepStrategyIdsExtra?: number[];
  },
) => {
  const { catalog, sweep } = await loadCatalogAndSweepWithFallback();
  if (!catalog || !sweep) {
    throw new Error('Catalog or sweep data unavailable (results and fallback sources are missing).');
  }

  const executionApiKeyName = getAlgofundExecutionApiKeyName(tenant, profile);
  if (!executionApiKeyName) {
    throw new Error('Assign an API key to this algofund client first');
  }

  const catalogDraftMembers = catalog.adminTradingSystemDraft?.members || [];
  const sourceSystemName = asString(
    options?.sourceSystemNameOverride || profile.published_system_name,
    '',
  ).trim();
  const sourceSystemApiKeyName = asString(
    getAlgofundPublishedSourceApiKeyName(sourceSystemName)
    || profile.assigned_api_key_name
    || tenant.assigned_api_key_name,
    ''
  ).trim();
  let draftMembers = catalogDraftMembers;

  // Member resolution priority (each step only runs if the previous gave 0 results):
  //  1. master_card_members — curated card explicitly pinned to this source system (DB, authoritative)
  //  2. trading_system_members — members of the source TS stored in the DB (DB, live-synced)
  //  3. live API fetch of source TS via resolvePublishedSystem (network, fuzzy-name fallback)
  //  4. catalogDraftMembers — sweep-catalog draft (stale partial last resort)

  const buildDraftMemberFromRow = buildMaterializeDraftMemberFromRow;

  if (sourceSystemName) {
    // Priority 1: master_card_members (curated card linked to this source system name)
    const cardCode = `CARD::${sourceSystemName.toUpperCase()}`;
    const card = await db.get<{ id: number }>('SELECT id FROM master_cards WHERE code = ? AND is_active = 1', [cardCode]).catch(() => null);
    if (card?.id) {
      const mcRows = (await db.all(
        `SELECT mcm.strategy_id, mcm.weight, s.name AS strategy_name,
                s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol, s.interval
         FROM master_card_members mcm
         JOIN strategies s ON s.id = mcm.strategy_id
         WHERE mcm.card_id = ? AND mcm.is_enabled = 1
           AND COALESCE(s.is_archived, 0) = 0`,
        [card.id]
      ).catch(() => [])) as Record<string, unknown>[];
      const cardMembers = mcRows.map(buildDraftMemberFromRow).filter((m) => m.strategyId > 0);
      if (cardMembers.length > 0) {
        draftMembers = cardMembers;
        logger.warn(`Algofund materialize [P1-card]: ${cardMembers.length} members from master_card '${cardCode}' for ${tenant.slug}.`);
      }
    }

    // Priority 2: trading_system_members from DB (exact name + api key lookup, no fuzzy match)
    if (draftMembers === catalogDraftMembers && sourceSystemApiKeyName) {
      const sourceTs = await db.get<{ id: number }>(
        `SELECT ts.id FROM trading_systems ts
         JOIN api_keys a ON a.id = ts.api_key_id
         WHERE ts.name = ? AND a.name = ?
         LIMIT 1`,
        [sourceSystemName, sourceSystemApiKeyName]
      ).catch(() => null);
      if (sourceTs?.id) {
        const tsRows = (await db.all(
          `SELECT tsm.strategy_id, tsm.weight, s.name AS strategy_name,
                  s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol, s.interval
           FROM trading_system_members tsm
           JOIN strategies s ON s.id = tsm.strategy_id
           WHERE tsm.system_id = ? AND tsm.is_enabled = 1
             AND COALESCE(s.is_archived, 0) = 0`,
          [sourceTs.id]
        ).catch(() => [])) as Record<string, unknown>[];
        const tsMembers = tsRows.map(buildDraftMemberFromRow).filter((m) => m.strategyId > 0);
        if (tsMembers.length > 0) {
          draftMembers = tsMembers;
          logger.warn(`Algofund materialize [P2-db-ts]: ${tsMembers.length} members from trading_system id=${sourceTs.id} ('${sourceSystemName}') for ${tenant.slug}.`);
        }
      }

      // Priority 2b: LIKE fallback — sourceSystemName short suffix matches ts.name substring (e.g. "aggressive-portfolio" → "...-aggressive-portf-f59clr")
      if (draftMembers === catalogDraftMembers && sourceSystemApiKeyName) {
        const shortToken = (sourceSystemName.split('::').pop() || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        // Slug generation truncates long portfolio names (e.g. "aggressive-portfolio" → "aggressive-portf"),
        // so use only the first 10 chars of the token for the LIKE to survive truncation.
        const likeToken = shortToken.substring(0, Math.min(10, shortToken.length));
        if (likeToken.length >= 4) {
          const sourceTsLike = await db.get<{ id: number }>(
            `SELECT ts.id FROM trading_systems ts
             JOIN api_keys a ON a.id = ts.api_key_id
             LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id AND tsm.is_enabled = 1
             WHERE ts.name LIKE ? AND a.name = ?
             GROUP BY ts.id
             ORDER BY COUNT(tsm.id) DESC
             LIMIT 1`,
            [`%${likeToken}%`, sourceSystemApiKeyName]
          ).catch(() => null);
          if (sourceTsLike?.id) {
            const tsLikeRows = (await db.all(
              `SELECT tsm.strategy_id, tsm.weight, s.name AS strategy_name,
                      s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol, s.interval
               FROM trading_system_members tsm
               JOIN strategies s ON s.id = tsm.strategy_id
               WHERE tsm.system_id = ? AND tsm.is_enabled = 1
                 AND COALESCE(s.is_archived, 0) = 0`,
              [sourceTsLike.id]
            ).catch(() => [])) as Record<string, unknown>[];
            const tsLikeMembers = tsLikeRows.map(buildDraftMemberFromRow).filter((m) => m.strategyId > 0);
            if (tsLikeMembers.length > 0) {
              draftMembers = tsLikeMembers;
              logger.warn(`Algofund materialize [P2b-db-ts-like]: ${tsLikeMembers.length} members from trading_system id=${sourceTsLike.id} (LIKE '%${likeToken}%') for ${tenant.slug}.`);
            }
          }
        }
      }
    }
  }

  // Priority 3: live API fetch (network) — only if DB gave nothing
  if (draftMembers === catalogDraftMembers && sourceSystemApiKeyName && sourceSystemName) {
    const sourceSystems = await listTradingSystems(sourceSystemApiKeyName).catch(() => []);
    const sourceSystem = resolvePublishedSystem(Array.isArray(sourceSystems) ? sourceSystems : [], sourceSystemName);
    if (sourceSystem?.id) {
      const fullSourceSystem = await getTradingSystem(sourceSystemApiKeyName, Number(sourceSystem.id)).catch(() => null);
      const sourceMembers = Array.isArray((fullSourceSystem as any)?.members)
        ? ((fullSourceSystem as any).members as Array<{ strategy_id?: number; strategy_name?: string; weight?: number }>)
            .map((member, index) => ({
              strategyId: Number(member?.strategy_id || 0),
              strategyName: asString(member?.strategy_name, `published member ${index + 1}`),
              strategyType: '',
              marketMode: '',
              market: '',
              score: 0,
              weight: asNumber(member?.weight, 1),
            }))
            .filter((member) => Number.isFinite(member.strategyId) && member.strategyId > 0)
        : [];

      if (sourceMembers.length > 0) {
        draftMembers = sourceMembers;
        logger.warn(`Algofund materialize [P3-live-api]: ${sourceMembers.length} members from live API TS '${sourceSystemName}' for ${tenant.slug}.`);
      }
    }
  }

  if (draftMembers === catalogDraftMembers && catalogDraftMembers.length > 0) {
    logger.warn(`Algofund materialize [P4-catalog-draft]: falling back to ${catalogDraftMembers.length} catalog draft members for ${tenant.slug}. DB and live API sources were empty.`);
  }

  if (draftMembers.length === 0) {
    throw new Error('Admin TS draft members are empty in latest client catalog');
  }

  draftMembers = await filterMaterializeDraftMembers(tenant, draftMembers);
  if (draftMembers.length === 0) {
    throw new Error('Admin TS draft members are empty after archived-master filter');
  }

  const riskMultiplier = Math.max(0, Math.min(asNumber(profile.risk_multiplier, 1), asNumber(plan.risk_cap_max, 1)));
  let sourceSystemFallbackRecordsByStrategyId: Map<number, SweepRecord> | null = null;
  let sourceSystemFallbackRecordsOrdered: SweepRecord[] | null = null;

  const loadSourceSystemFallbackRecords = async (): Promise<void> => {
    if (sourceSystemFallbackRecordsByStrategyId !== null && sourceSystemFallbackRecordsOrdered !== null) {
      return;
    }

    sourceSystemFallbackRecordsByStrategyId = new Map<number, SweepRecord>();
    sourceSystemFallbackRecordsOrdered = [];

    if (!sourceSystemApiKeyName) {
      return;
    }

    if (sourceSystemName) {
      const systems = await listTradingSystems(sourceSystemApiKeyName).catch(() => []);
      const sourceSystem = resolvePublishedSystem(Array.isArray(systems) ? systems : [], sourceSystemName);

      if (sourceSystem?.id) {
        const fullSystem = await getTradingSystem(sourceSystemApiKeyName, Number(sourceSystem.id)).catch(() => null);
        const members = Array.isArray((fullSystem as any)?.members) ? ((fullSystem as any).members as Array<{ strategy_id?: number }>) : [];
        for (const member of members) {
          const strategyId = Number(member?.strategy_id || 0);
          if (!strategyId) {
            continue;
          }
          const fallback = await buildSweepRecordFallbackByStrategyId(strategyId);
          if (!fallback) {
            continue;
          }
          sourceSystemFallbackRecordsByStrategyId.set(strategyId, fallback);
          sourceSystemFallbackRecordsOrdered.push(fallback);
        }
      }
    }

    // If source system members are unavailable, fallback to currently active source strategies.
    if (sourceSystemFallbackRecordsOrdered.length === 0) {
      const sourceStrategies = await getStrategies(sourceSystemApiKeyName, { includeLotPreview: false }).catch(() => []);
      for (const strategy of Array.isArray(sourceStrategies) ? sourceStrategies : []) {
        const strategyId = Number((strategy as { id?: number })?.id || 0);
        const isActive = Number((strategy as { is_active?: number | boolean })?.is_active ? 1 : 0) === 1;
        if (!strategyId || !isActive) {
          continue;
        }
        const fallback = await buildSweepRecordFallbackByStrategyId(strategyId);
        if (!fallback) {
          continue;
        }
        sourceSystemFallbackRecordsByStrategyId.set(strategyId, fallback);
        sourceSystemFallbackRecordsOrdered.push(fallback);
      }
      if (sourceSystemFallbackRecordsOrdered.length > 0) {
        logger.warn(`Algofund materialize fallback: using ${sourceSystemFallbackRecordsOrdered.length} active source strategies from api key ${sourceSystemApiKeyName}.`);
      }
    }
  };

  const recordsForMaterialization: Array<{
    offerId: string;
    record: SweepRecord;
    metrics: CatalogMetricSet & { score: number };
  }> = [];

  for (let index = 0; index < draftMembers.length; index += 1) {
    const member = draftMembers[index];
    const strategyId = Number(member.strategyId || 0);
    let record = findSweepRecordByStrategyId(sweep, strategyId);
    if (!record) {
      record = await buildSweepRecordFallbackByStrategyId(strategyId);
      if (record) {
        logger.warn(`Algofund materialize fallback: using DB strategy params for strategyId=${strategyId} (not found in latest sweep).`);
      }
    }
    if (!record) {
      await loadSourceSystemFallbackRecords();
      const fallbackByIdMap: Map<number, SweepRecord> = sourceSystemFallbackRecordsByStrategyId || new Map<number, SweepRecord>();
      const fallbackOrdered: SweepRecord[] = sourceSystemFallbackRecordsOrdered || [];
      const byId = fallbackByIdMap.get(strategyId) || null;
      const byIndex = fallbackOrdered[index] || null;
      record = byId || byIndex;
      if (record) {
        logger.warn(`Algofund materialize fallback: using published source system member strategyId=${record.strategyId} for draft strategyId=${strategyId}.`);
      }
    }
    if (!record) {
      throw new Error(`Cannot materialize member strategyId=${member.strategyId}: no sweep record and no DB strategy fallback.`);
    }

    recordsForMaterialization.push({
      offerId: `admin-ts-${index + 1}`,
      record,
      metrics: {
        ret: asNumber(record.totalReturnPercent, 0),
        pf: asNumber(record.profitFactor, 0),
        dd: asNumber(record.maxDrawdownPercent, 0),
        wr: asNumber(record.winRatePercent, 0),
        trades: asNumber(record.tradesCount, 0),
        score: asNumber(record.score, 0),
      },
    });
  }

  const materializedStrategies = await upsertTenantStrategies(
    tenant,
    executionApiKeyName,
    recordsForMaterialization,
    asNumber(plan.max_deposit_total, 1000),
    riskMultiplier <= 0.85 ? 'low' : riskMultiplier >= 1.4 ? 'high' : 'medium',
    activate || profile.requested_enabled === 1,
    { keepStrategyIds: options?.keepStrategyIdsExtra || [] },
  );

  if (materializedStrategies.length !== recordsForMaterialization.length) {
    logger.warn(
      `Algofund materialize: ${tenant.slug} materialized ${materializedStrategies.length}/${recordsForMaterialization.length} `
      + '(exchange pair filter or createStrategy failure — see saas_materialize_pair_unavailable audit)',
    );
  }

  const systems = await listTradingSystems(executionApiKeyName);
  const systemName = asString(options?.clientSystemName, '').trim() || getAlgofundClientSystemName(tenant);
  const existing = systems.find((item) => asString(item.name) === systemName);
  const uniqueMaterialized = materializedStrategies.filter((row, index, arr) => {
    const strategyId = Number(row.strategyId || 0);
    if (!strategyId) {
      return false;
    }
    return arr.findIndex((item) => Number(item.strategyId || 0) === strategyId) === index;
  });

  const weightScale = Math.max(0.05, Math.min(10, asNumber(options?.memberWeightScale, 1)));
  let members: TradingSystemMemberDraft[] = uniqueMaterialized.map((row, index) => ({
    strategy_id: Number(row.strategyId),
    weight: Number(((index === 0 ? 1.25 : index === 1 ? 1.1 : 1) * Math.max(0.25, riskMultiplier) * weightScale).toFixed(4)),
    member_role: index < 3 ? 'core' : 'satellite',
    is_enabled: true,
    notes: `algofund ${tenant.slug}`,
  }));
  members = await filterRunnableTradingSystemMembers(executionApiKeyName, members);
  if (members.length === 0) {
    throw new Error(`Algofund materialize produced no runnable members for ${tenant.slug}`);
  }

  // Resolve maxOpenPositions from master_cards metadata (card override).
  // cardSystemName = published_system_name || local systemName. Fallback: 2
  const cardSystemName = sourceSystemName || asString(profile.published_system_name, '').trim() || systemName;
  const _cardCfg = await getCardConfigBySystemName(cardSystemName);
  const resolvedMaxOpenPositions = _cardCfg.maxOpenPositions > 0 ? _cardCfg.maxOpenPositions : 2;

  // ARCHIVE-ORPHANS: previous SAAS materializations left is_active=1 legs that
  // keep trading after switch_system (zombie outbreak 2026-05-04).
  // Scope to this tenant's SAAS::slug:: rows only — never touch manual/research
  // strategies on the same API key. Flat orphans = DB soft-archive (no WEEX
  // cancel storm / -1058 hang). Non-flat orphans still cancel+close first.
  // When preserveSiblingSystems (portfolio multi-TS), keep extra strategy ids
  // from sibling books so we do not wipe B3 while materializing MRS (and vice versa).
  try {
    const newMemberIdSet = new Set<number>(members.map((m) => Number(m.strategy_id)).filter((id) => Number.isFinite(id) && id > 0));
    for (const extraId of options?.keepStrategyIdsExtra || []) {
      if (Number.isFinite(extraId) && extraId > 0) newMemberIdSet.add(Number(extraId));
    }
    if (!options?.preserveSiblingSystems) {
      const saasPrefix = `SAAS::${tenant.slug}::`;
      const orphanRows = (await db.all(
        `SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.market_mode, s.state
         FROM strategies s
         JOIN api_keys a ON a.id = s.api_key_id
         WHERE a.name = ?
           AND s.is_active = 1
           AND COALESCE(s.is_archived, 0) = 0
           AND s.name LIKE ?`,
        [executionApiKeyName, `${saasPrefix}%`]
      ).catch(() => [])) as Array<{ id: number; name: string; base_symbol: string | null; quote_symbol: string | null; market_mode: string | null; state: string | null }>;
      const orphans = orphanRows.filter((r) => !newMemberIdSet.has(Number(r.id)));
      if (orphans.length > 0) {
        const softCount = orphans.filter((r) => {
          const st = asString(r.state, 'flat').trim().toLowerCase();
          return !st || st === 'flat' || st === 'idle';
        }).length;
        logger.warn(
          `Algofund materialize [archive-orphans]: archiving ${orphans.length} stale SAAS strategies `
          + `on ${executionApiKeyName} (${softCount} soft/flat, ${orphans.length - softCount} exchange-touch) `
          + `not in new TS '${systemName}' (${members.length} new members)`,
        );
        for (const orphan of orphans) {
          await saasArchiveStrategy(executionApiKeyName, orphan);
        }
      }
    }
  } catch (err) {
    logger.warn(`Algofund materialize [archive-orphans] failed for ${executionApiKeyName}: ${(err as Error).message}`);
  }

  let systemId = 0;
  if (existing?.id) {
    await updateTradingSystem(executionApiKeyName, Number(existing.id), {
      name: systemName,
      description: `Algofund managed TS for ${tenant.display_name}`,
      auto_sync_members: false,
      discovery_enabled: false,
      max_members: Math.max(6, members.length),
      max_open_positions: resolvedMaxOpenPositions,
    });
    await replaceTradingSystemMembers(executionApiKeyName, Number(existing.id), members);
    systemId = Number(existing.id);
  } else {
    const created = await createTradingSystem(executionApiKeyName, {
      name: systemName,
      description: `Algofund managed TS for ${tenant.display_name}`,
      auto_sync_members: false,
      discovery_enabled: false,
      max_members: Math.max(6, members.length),
      max_open_positions: resolvedMaxOpenPositions,
      members,
    });
    systemId = Number(created.id);
  }

  const shouldActivate = activate || profile.requested_enabled === 1;
  if (shouldActivate) {
    await setTradingSystemActivation(executionApiKeyName, systemId, true, true);
  }

  await applyClientCardStrategyOverrides(executionApiKeyName, cardSystemName, {
    strategyIds: members.map((m) => Number(m.strategy_id)).filter((id) => id > 0),
  }).catch((error) => {
    logger.warn(`Algofund materialize card overrides failed for ${tenant.slug}: ${(error as Error).message}`);
  });

  const masterTargets = await resolveAlgofundSystemTargets({ systemName: cardSystemName }).catch(() => []);
  const masterTarget = masterTargets[0];
  if (masterTarget?.apiKeyName && masterTarget.systemId > 0) {
    const dcaStrategyIds = await materializeClassicDcaToClient(
      masterTarget.apiKeyName,
      executionApiKeyName,
      masterTarget.systemId,
    ).catch((error) => {
      logger.warn(`Algofund materialize classic DCA copy failed for ${tenant.slug}: ${(error as Error).message}`);
      return [] as number[];
    });
    if (dcaStrategyIds.length > 0 && systemId > 0) {
      await attachClientDcaMembersToTradingSystem(
        executionApiKeyName,
        systemId,
        dcaStrategyIds,
      ).catch((error) => {
        logger.warn(`Algofund attach client DCA members failed for ${tenant.slug}: ${(error as Error).message}`);
      });
    }
    await materializeDcaFuturesToClient(
      masterTarget.apiKeyName,
      executionApiKeyName,
      masterTarget.systemId,
    ).catch((error) => {
      logger.warn(`Algofund materialize dca_futures copy failed for ${tenant.slug}: ${(error as Error).message}`);
    });
  }

  if (!options?.skipProfilePublishUpdate) {
    await db.run(
      `UPDATE algofund_profiles
       SET assigned_api_key_name = ?,
           execution_api_key_name = ?,
           published_system_name = ?,
           requested_enabled = ?,
           actual_enabled = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [
        executionApiKeyName,
        executionApiKeyName,
        cardSystemName,
        shouldActivate ? 1 : Number(profile.requested_enabled || 0),
        shouldActivate ? 1 : Number(profile.actual_enabled || 0),
        tenant.id,
      ]
    );
  } else {
    await db.run(
      `UPDATE algofund_profiles
       SET assigned_api_key_name = ?,
           execution_api_key_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [executionApiKeyName, executionApiKeyName, tenant.id],
    );
  }

  return {
    systemId,
    systemName,
    assignedApiKeyName: executionApiKeyName,
    riskMultiplier,
    strategies: materializedStrategies,
    strategyIds: members.map((m) => Number(m.strategy_id)).filter((id) => id > 0),
  };
};

export const getAlgofundState = async (
  tenantId: number,
  requestedRiskMultiplier?: number,
  allowPreviewAbovePlan = false,
  forceRefreshPreview = false
) => {
  await ensureSaasSeedData();
  const tenant = await getTenantById(tenantId);

  const plan = await getPlanForTenant(tenantId, 'algofund_client');
  const profile = await getAlgofundProfile(tenantId);
  const offerStoreState = await getOfferStoreAdminState().catch(() => null);
  const storefrontSystemSet = new Set(
    (offerStoreState?.algofundStorefrontSystemNames || [])
      .map((item) => asString(item, '').trim().toUpperCase())
      .filter(Boolean)
  );
  const currentPublishedSystemName = asString(profile?.published_system_name, '').trim().toUpperCase();

  // Load available systems even without plan/profile (browse-only mode for dual-mode tenants).
  // Scan only master + tenant keys — iterating all client api keys triggers slow exchange snapshots.
  const tenantApiKeyName = asString(
    profile?.execution_api_key_name || profile?.assigned_api_key_name || tenant.assigned_api_key_name,
    '',
  ).trim();
  const apiKeysToScan = Array.from(new Set(
    ['BTDD_D1', tenantApiKeyName].filter(Boolean)
  ));
  const allAlgofundSystemsMap = new Map<string, any>();
  for (const apiKeyName of apiKeysToScan) {
    const systems = await listTradingSystems(apiKeyName, { skipMetrics: !forceRefreshPreview }).catch(() => []);
    for (const item of (Array.isArray(systems) ? systems : [])) {
      const systemName = asString(item?.name, '').trim();
      const normalizedSystemName = systemName.toUpperCase();
      // Only expose live master storefront cards here; hide archived/client-runtime systems.
      if (systemName && (normalizedSystemName.startsWith('ALGOFUND_MASTER::') || normalizedSystemName.startsWith('CLOUD'))) {
        const key = `${systemName}`;
        if (!allAlgofundSystemsMap.has(key)) {
          allAlgofundSystemsMap.set(key, item);
        }
      }
    }
  }
  let availableSystems = Array.from(allAlgofundSystemsMap.values()).map((item: any) => ({
    id: Number(item?.id || 0),
    apiKeyName: asString(item?.api_key_name || item?.apiKeyName || '', ''),
    name: asString(item?.name, ''),
    isActive: Boolean(item?.is_active),
    updatedAt: asString(item?.updated_at, ''),
    memberCount: Array.isArray(item?.members)
      ? item.members.filter((member: any) => member && member.is_enabled !== false).length
      : 0,
    memberStrategyIds: Array.isArray(item?.members)
      ? Array.from(new Set(
        item.members
          .map((member: any) => Number(member?.strategy_id || member?.strategy?.id || 0))
          .filter((value: number) => Number.isFinite(value) && value > 0)
      ))
      : [],
    memberWeightsByStrategyId: Array.isArray(item?.members)
      ? Object.fromEntries(
        item.members
          .filter((member: any) => member && member.is_enabled !== false)
          .map((member: any) => {
            const strategyId = Number(member?.strategy_id || member?.strategy?.id || 0);
            const weight = asNumber(member?.weight, 1);
            return [String(strategyId), Number((Number.isFinite(weight) && weight > 0 ? weight : 1).toFixed(6))] as const;
          })
          .filter(([strategyId]: [string, number]) => Number(strategyId) > 0)
      )
      : {},
    // Per-leg composition for client/admin TS modals (TF / type / market — previously discarded).
    memberDetails: Array.isArray(item?.members)
      ? item.members
          .filter((member: any) => member && member.is_enabled !== false)
          .map((member: any) => {
            const strategy = member?.strategy || {};
            const strategyId = Number(member?.strategy_id || strategy?.id || 0);
            const baseSymbol = asString(strategy?.base_symbol, '');
            const quoteSymbol = asString(strategy?.quote_symbol, '');
            const weight = asNumber(member?.weight, 1);
            return {
              strategyId,
              name: asString(strategy?.name, ''),
              strategyType: asString(strategy?.strategy_type, ''),
              interval: asString(strategy?.interval, ''),
              baseSymbol,
              quoteSymbol,
              market: quoteSymbol ? `${baseSymbol}/${quoteSymbol}` : baseSymbol,
              weight: Number((Number.isFinite(weight) && weight > 0 ? weight : 1).toFixed(6)),
            };
          })
          .filter((row: { strategyId: number }) => Number.isFinite(row.strategyId) && row.strategyId > 0)
      : [],
    metrics: item?.metrics ? {
      equityUsd: asNumber(item.metrics.equity_usd, 0),
      unrealizedPnl: asNumber(item.metrics.unrealized_pnl, 0),
      drawdownPercent: asNumber(item.metrics.drawdown_percent, 0),
      marginLoadPercent: asNumber(item.metrics.margin_load_percent, 0),
      effectiveLeverage: asNumber(item.metrics.effective_leverage, 0),
    } : null,
    maxOpenPositions: Math.max(0, Math.floor(asNumber(item?.max_open_positions, 0))),
  })).filter((item) => item.id > 0);

  // Attach cached tsBacktestSnapshots to each available system (lightweight — reads from app_runtime_flags)
  const tsSnapshots = await getTsBacktestSnapshots().catch(() => ({} as Record<string, TsBacktestSnapshot>));
  const snapshotKeys = Object.keys(tsSnapshots);
  const snapshotKeysLower = snapshotKeys.map((k) => k.toLowerCase());
  for (const system of availableSystems) {
    const systemName = system.name;
    const systemNameLower = systemName.toLowerCase();
    // Try exact match first
    let snapshot = tsSnapshots[systemName] || null;
    if (!snapshot) {
      // Case-insensitive exact match
      const ciIdx = snapshotKeysLower.indexOf(systemNameLower);
      if (ciIdx >= 0) snapshot = tsSnapshots[snapshotKeys[ciIdx]];
    }
    if (!snapshot) {
      // Extract short name from ALGOFUND_MASTER::API_KEY::short-name
      const parts = systemName.split('::').filter(Boolean);
      const shortName = parts.length >= 3 ? parts[parts.length - 1] : (parts.length === 2 ? parts[1] : '');
      // Only do fuzzy/short-name matching for child systems (3+ parts).
      // Parent systems (e.g. ALGOFUND_MASTER::BTDD_D1) must NOT grab a child snapshot.
      const isParentSystem = parts.length <= 2;
      if (shortName && !isParentSystem) {
        const shortLower = shortName.toLowerCase();
        snapshot = tsSnapshots[shortName] || null;
        if (!snapshot) {
          // Case-insensitive short name match — only match keys that end with exactly this short name
          const matchIdx = snapshotKeysLower.findIndex((k) => k === shortLower || k.endsWith(`::${shortLower}`));
          if (matchIdx >= 0) snapshot = tsSnapshots[snapshotKeys[matchIdx]];
        }
        // Fuzzy: strip common prefixes from short name and try partial/contains match
        if (!snapshot) {
          const stripped = shortLower.replace(/^(algofund-master-|btdd-d1-|btdd_d1-)+/gi, '');
          if (stripped.length >= 5) {
            const matchIdx = snapshotKeysLower.findIndex((k) => {
              const kStripped = k.replace(/.*::/, '').replace(/^(algofund-master-|btdd-d1-|btdd_d1-)+/gi, '').toLowerCase();
              return kStripped === stripped;
            });
            if (matchIdx >= 0) snapshot = tsSnapshots[snapshotKeys[matchIdx]];
          }
        }
      }
    }
    if (snapshot) {
      (system as any).backtestSnapshot = {
        ret: snapshot.ret,
        pf: snapshot.pf,
        dd: snapshot.dd,
        trades: snapshot.trades,
        tradesPerDay: snapshot.tradesPerDay,
        periodDays: snapshot.periodDays,
        finalEquity: snapshot.finalEquity,
        equityPoints: snapshot.equityPoints,
        backtestSettings: snapshot.backtestSettings,
        ...(snapshot.displayLabel !== undefined ? { displayLabel: snapshot.displayLabel } : {}),
        ...(snapshot.sharpe !== undefined ? { sharpe: snapshot.sharpe } : {}),
        ...(snapshot.membersCount !== undefined ? { membersCount: snapshot.membersCount } : {}),
        ...(snapshot.marketCount !== undefined ? { marketCount: snapshot.marketCount } : {}),
        ...(snapshot.maxPerMarket !== undefined ? { maxPerMarket: snapshot.maxPerMarket } : {}),
      };
      if (asString(snapshot.displayLabel, '').trim() && !asString((system as any).displayLabel, '').trim()) {
        (system as any).displayLabel = asString(snapshot.displayLabel, '').trim();
      }
    }
  }

  // Client LK whitelist = algofundStorefrontSystemNames (may omit personal/admin-only cards).
  // Admin TS grid uses algofundPublishedSystemNames separately (can include Whale personal).
  if (storefrontSystemSet.size > 0) {
    availableSystems = availableSystems.filter((system) => {
      const systemName = asString(system?.name, '').trim().toUpperCase();
      if (!systemName) return false;
      if (storefrontSystemSet.has(systemName)) return true;
      return Boolean(currentPublishedSystemName) && systemName === currentPublishedSystemName;
    });
  }

  // Keep canonical storefront set even when a card has no fresh snapshot.
  // This preserves strict admin/client atomicity by card list.
  availableSystems = availableSystems.filter((system) => {
    const systemName = asString(system?.name, '').trim().toUpperCase();
    if (!systemName) return false;
    if (storefrontSystemSet.size === 0) {
      return Boolean((system as any).backtestSnapshot)
        || (Boolean(currentPublishedSystemName) && systemName === currentPublishedSystemName);
    }
    if (storefrontSystemSet.has(systemName)) return true;
    return Boolean(currentPublishedSystemName) && systemName === currentPublishedSystemName;
  });

  const snapshotBacked = Object.entries(tsSnapshots)
    .filter(([key, snapshot]) => {
      const keyName = asString(key, '').trim();
      const normalizedKeyName = keyName.toUpperCase();
      const systemName = asString(snapshot?.systemName, '').trim();
      const normalizedSystemName = systemName.toUpperCase();
      const isStorefrontSnapshot = normalizedKeyName.startsWith('ALGOFUND_MASTER::')
        || normalizedKeyName.startsWith('CLOUD')
        || keyName.toLowerCase().startsWith('ts-')
        || normalizedSystemName.startsWith('ALGOFUND_MASTER::')
        || normalizedSystemName.startsWith('CLOUD');
      if (!isStorefrontSnapshot) return false;
      if (storefrontSystemSet.size > 0) {
        const storefrontCandidates = [normalizedKeyName, normalizedSystemName]
          .map((name) => name.trim())
          .filter(Boolean);
        const isAllowed = storefrontCandidates.some((candidate) =>
          storefrontSystemSet.has(candidate) || candidate === currentPublishedSystemName
        );
        if (!isAllowed) {
          return false;
        }
      }
      const eq = Array.isArray(snapshot?.equityPoints) ? snapshot.equityPoints.length : 0;
      return eq > 1;
    })
    .map(([key, snapshot], index) => {
      const runtimeName = asString(snapshot?.systemName, '').trim();
      const fallbackName = asString(key, '').trim();
      const storefrontName = fallbackName || runtimeName;
      return {
        id: 900000 + index,
        apiKeyName: asString(snapshot?.apiKeyName, ''),
        name: storefrontName,
        ...(asString(snapshot?.displayLabel, '').trim() ? { displayLabel: asString(snapshot?.displayLabel, '').trim() } : {}),
        isActive: false,
        updatedAt: asString(snapshot?.updatedAt, ''),
        memberCount: Array.isArray(snapshot?.offerIds) ? snapshot.offerIds.length : 0,
        memberStrategyIds: [],
        memberWeightsByStrategyId: {},
        metrics: null,
        backtestSnapshot: {
          ret: snapshot.ret,
          pf: snapshot.pf,
          dd: snapshot.dd,
          trades: snapshot.trades,
          tradesPerDay: snapshot.tradesPerDay,
          periodDays: snapshot.periodDays,
          finalEquity: snapshot.finalEquity,
          equityPoints: snapshot.equityPoints,
          ...(snapshot.displayLabel !== undefined ? { displayLabel: snapshot.displayLabel } : {}),
          ...(snapshot.sharpe !== undefined ? { sharpe: snapshot.sharpe } : {}),
          ...(snapshot.membersCount !== undefined ? { membersCount: snapshot.membersCount } : {}),
          ...(snapshot.marketCount !== undefined ? { marketCount: snapshot.marketCount } : {}),
          ...(snapshot.maxPerMarket !== undefined ? { maxPerMarket: snapshot.maxPerMarket } : {}),
        },
      };
    });

  if (snapshotBacked.length > 0) {
    const availableByName = new Map(
      availableSystems
        .map((item) => [asString(item?.name, '').trim().toUpperCase(), item] as const)
        .filter(([name]) => Boolean(name))
    );

    for (const snapshotSystem of snapshotBacked) {
      const key = asString(snapshotSystem?.name, '').trim().toUpperCase();
      if (!key) {
        continue;
      }
      if (!availableByName.has(key)) {
        availableByName.set(key, snapshotSystem as any);
        continue;
      }
      const current = availableByName.get(key) as any;
      if (!current?.backtestSnapshot && (snapshotSystem as any).backtestSnapshot) {
        availableByName.set(key, {
          ...current,
          backtestSnapshot: (snapshotSystem as any).backtestSnapshot,
          ...((snapshotSystem as any).displayLabel ? { displayLabel: (snapshotSystem as any).displayLabel } : {}),
        });
      } else if (!current?.displayLabel && (snapshotSystem as any).displayLabel) {
        availableByName.set(key, {
          ...current,
          displayLabel: (snapshotSystem as any).displayLabel,
        });
      }
    }

    availableSystems = Array.from(availableByName.values());
  }

  const algofundMemberStrategyIds = Array.from(new Set(
    availableSystems.flatMap((system) => (
      Array.isArray(system.memberStrategyIds)
        ? system.memberStrategyIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
        : []
    )),
  ));
  const algofundStrategyMarketType = new Map<number, 'futures' | 'spot'>();
  if (algofundMemberStrategyIds.length > 0) {
    const memberRows = await db.all(
      `SELECT id, COALESCE(market_type, 'futures') AS market_type
       FROM strategies
       WHERE id IN (${algofundMemberStrategyIds.map(() => '?').join(',')})`,
      algofundMemberStrategyIds,
    ) as Array<{ id?: number; market_type?: string }>;
    for (const row of memberRows) {
      const strategyId = Number(row.id || 0);
      if (strategyId > 0) {
        algofundStrategyMarketType.set(
          strategyId,
          String(row.market_type || 'futures') === 'spot' ? 'spot' : 'futures',
        );
      }
    }
  }
  for (const system of availableSystems) {
    const memberIds = Array.isArray(system.memberStrategyIds)
      ? system.memberStrategyIds.map((id) => Number(id)).filter((id) => id > 0)
      : [];
    const memberTypes = memberIds
      .map((id) => algofundStrategyMarketType.get(id))
      .filter((value): value is 'futures' | 'spot' => value === 'futures' || value === 'spot');
    const nameUpper = asString(system?.name, '').trim().toUpperCase();
    const marketType: 'futures' | 'spot' = memberTypes.length > 0
      ? (memberTypes.every((value) => value === 'spot') ? 'spot' : 'futures')
      : (nameUpper.includes('SPOT') ? 'spot' : 'futures');
    (system as { marketType?: 'futures' | 'spot' }).marketType = marketType;
  }

  const algofundClientPrefs = safeJsonParse<{ showFutures?: boolean; showSpot?: boolean }>(
    (tenant as { client_preferences_json?: string }).client_preferences_json,
    { showFutures: true, showSpot: true },
  );
  const showFuturesSystems = algofundClientPrefs.showFutures !== false;
  const showSpotSystems = algofundClientPrefs.showSpot !== false;
  availableSystems = availableSystems.filter((system) => {
    const marketType = (system as { marketType?: 'futures' | 'spot' }).marketType || 'futures';
    if (marketType === 'spot') {
      return showSpotSystems;
    }
    return showFuturesSystems;
  });

  // Browse-only mode: no plan or profile — return systems with snapshots but no controls
  if (!plan || !profile) {
    return {
      tenant,
      plan: null,
      capabilities: resolvePlanCapabilities(null),
      profile: null,
      engine: null,
      activeSystems: [],
      availableSystems,
      clientPreferences: algofundClientPrefs,
      preview: null,
      portfolioPassport: null,
      requests: [],
      catalog: null,
      browseOnly: true,
    };
  }

  const capabilities = resolvePlanCapabilities(plan);
  const activeSystems = await getAlgofundActiveSystems(profile.id).catch(() => []);

  const engine = await getAlgofundEngineState(tenant, profile);
  const effectiveStorefrontSystemName = asString(profile.published_system_name, '').trim().toUpperCase().startsWith('ALGOFUND_MASTER::')
    ? asString(profile.published_system_name, '').trim()
    : (engine?.systemName || profile.published_system_name);
  const effectiveProfile: AlgofundProfileRow = {
    ...profile,
    actual_enabled: engine ? (engine.isActive ? 1 : 0) : profile.actual_enabled,
    published_system_name: effectiveStorefrontSystemName,
    assigned_api_key_name: asString(profile.assigned_api_key_name, tenant.assigned_api_key_name),
    execution_api_key_name: asString(profile.execution_api_key_name, tenant.assigned_api_key_name),
  };

  if (
    effectiveProfile.actual_enabled !== profile.actual_enabled
    || effectiveProfile.published_system_name !== profile.published_system_name
    || effectiveProfile.assigned_api_key_name !== profile.assigned_api_key_name
    || effectiveProfile.execution_api_key_name !== profile.execution_api_key_name
  ) {
    await db.run(
      `UPDATE algofund_profiles
       SET actual_enabled = ?,
           published_system_name = ?,
           assigned_api_key_name = ?,
           execution_api_key_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [
        effectiveProfile.actual_enabled,
        effectiveProfile.published_system_name,
        effectiveProfile.assigned_api_key_name,
        effectiveProfile.execution_api_key_name,
        tenantId,
      ]
    );
  }

  const maxPreviewRiskMultiplier = allowPreviewAbovePlan
    ? Math.max(10, asNumber(plan.risk_cap_max, 1))
    : asNumber(plan.risk_cap_max, 1);
  const riskMultiplier = Math.max(0, Math.min(
    requestedRiskMultiplier !== undefined ? requestedRiskMultiplier : asNumber(profile.risk_multiplier, 1),
    maxPreviewRiskMultiplier
  ));

  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const offerStore = await getOfferStoreAdminState();
  const catalog = filterCatalogByStorefrontOfferIds(sourceCatalog, getStorefrontOfferIds(offerStore));
  const period = buildPeriodInfo(sweep);

  let preview: {
    riskMultiplier: number;
    sourceSystem?: {
      apiKeyName: string;
      systemId: number;
      systemName: string;
    } | null;
    summary?: Record<string, unknown> | null;
    period?: PeriodInfo | null;
    equityCurve?: Array<Record<string, unknown>>;
    blockedByPlan: boolean;
    blockedReason?: string;
  };

  const cachedPreview = safeJsonParse<any>(profile.latest_preview_json, null);
  const hasCachedPreviewRaw = cachedPreview && typeof cachedPreview === 'object';
  // Invalidate cache if the published system changed since the preview was cached
  const cachedSourceSystemName = asString(cachedPreview?.sourceSystem?.systemName, '').trim();
  const publishedSystemChanged = hasCachedPreviewRaw && cachedSourceSystemName !== '' && effectiveStorefrontSystemName !== ''
    && cachedSourceSystemName.toUpperCase() !== effectiveStorefrontSystemName.toUpperCase();
  const hasCachedPreview = hasCachedPreviewRaw && !publishedSystemChanged;
  if (publishedSystemChanged) {
    logger.info(`Algofund preview cache stale for tenant ${tenantId}: cached=${cachedSourceSystemName} published=${effectiveStorefrontSystemName} — will refresh`);
  }
  // Only run full backtest on initial load or forced refresh; slider changes use fast math scaling
  const canScaleFromCache = hasCachedPreview && requestedRiskMultiplier !== undefined && !forceRefreshPreview
    && Array.isArray(cachedPreview?.equityCurve) && cachedPreview.equityCurve.length > 1;
  const shouldRefreshPreview = forceRefreshPreview || (!hasCachedPreview);

  if (canScaleFromCache) {
    // Fast path: scale cached baseline equity curve mathematically instead of running full backtest
    const baseline = SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE;
    const cachedCurve: Array<Record<string, unknown>> = cachedPreview.equityCurve;
    const startEquity = asNumber(cachedCurve[0]?.equity, baseline);
    const scaledCurve = cachedCurve.map((point) => ({
      ...point,
      equity: Number(scaleEquityByRiskWithReinvest(
        asNumber(point.equity, startEquity),
        startEquity,
        baseline,
        riskMultiplier / Math.max(0.01, asNumber(cachedPreview.riskMultiplier, 1)),
        0.5
      ).toFixed(4)),
    }));
    const scaledFinalEquity = scaledCurve.length > 0 ? asNumber(scaledCurve[scaledCurve.length - 1].equity, baseline) : baseline;
    const cachedSummary = cachedPreview.summary || {};
    const baseRisk = asNumber(cachedPreview.riskMultiplier, 1);
    const relativeRisk = riskMultiplier / Math.max(0.01, baseRisk);
    const scaledRet = asNumber(cachedSummary.totalReturnPercent, 0) * relativeRisk;
    const scaledDd = Math.min(99, asNumber(cachedSummary.maxDrawdownPercent, 0) * Math.max(0.05, relativeRisk * (0.7 + 0.3)));
    const scaledPf = Math.max(0.15, asNumber(cachedSummary.profitFactor, 1) / Math.max(0.5, Math.sqrt(relativeRisk)));

    preview = {
      riskMultiplier,
      sourceSystem: cachedPreview.sourceSystem || null,
      summary: {
        ...cachedSummary,
        totalReturnPercent: Number(scaledRet.toFixed(3)),
        maxDrawdownPercent: Number(scaledDd.toFixed(3)),
        profitFactor: Number(scaledPf.toFixed(3)),
        finalEquity: scaledFinalEquity,
      },
      period: cachedPreview.period || period,
      equityCurve: scaledCurve,
      blockedByPlan: false,
    };
  } else if (shouldRefreshPreview) {
    try {
      const sourceSystem = await ensurePublishedSourceSystem(tenantId);
      const previewResult = await runTradingSystemBacktest(sourceSystem.apiKeyName, sourceSystem.systemId, {
        bars: SAAS_PREVIEW_BARS,
        warmupBars: SAAS_PREVIEW_WARMUP_BARS,
        skipMissingSymbols: true,
        initialBalance: SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE,
        riskMultiplier: 1, // Always cache at baseline risk=1 for fast scaling later
        commissionPercent: 0.1,
        slippagePercent: 0.05,
        fundingRatePercent: 0,
      });

      preview = {
        riskMultiplier: 1,
        sourceSystem,
        summary: {
          ...previewResult.summary,
        },
        period,
        equityCurve: previewResult.equityCurve as Array<Record<string, unknown>>,
        blockedByPlan: false,
      };
    } catch (error) {
      const message = (error as Error).message || 'Algofund preview unavailable';
      logger.warn(`Algofund preview unavailable for tenant ${tenantId}: ${message}`);
      const tsSnapshot = await getTsBacktestSnapshot().catch(() => null);
      if (tsSnapshot) {
        const baseline = SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE;
        const finalEquity = Number(tsSnapshot.finalEquity || baseline);
        const rawSeries = Array.isArray(tsSnapshot.equityPoints)
          ? tsSnapshot.equityPoints.map((point) => Number(point)).filter((point) => Number.isFinite(point))
          : [];
        const fallbackSeries = rawSeries.length > 1 ? rawSeries : [baseline, finalEquity];
        const equityCurve = fallbackSeries.map((equity, index) => ({ time: index, equity: Number(equity.toFixed(4)) }));

        preview = {
          riskMultiplier,
          sourceSystem: null,
          summary: {
            initialBalance: baseline,
            finalEquity,
            totalReturnPercent: Number(tsSnapshot.ret || 0),
            maxDrawdownPercent: Number(tsSnapshot.dd || 0),
            profitFactor: Number(tsSnapshot.pf || 0),
            tradesCount: Number(tsSnapshot.trades || 0),
          },
          period,
          equityCurve,
          blockedByPlan: false,
          blockedReason: undefined,
        };
      } else {
        preview = {
          riskMultiplier,
          sourceSystem: null,
          summary: null,
          period,
          equityCurve: [],
          blockedByPlan: true,
          blockedReason: message,
        };
      }
    }

    await db.run(
      `UPDATE algofund_profiles
       SET latest_preview_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [JSON.stringify(preview), tenantId]
    );
  } else {
    preview = {
      riskMultiplier: Number(cachedPreview?.riskMultiplier ?? riskMultiplier),
      sourceSystem: cachedPreview?.sourceSystem || null,
      summary: cachedPreview?.summary || null,
      period: cachedPreview?.period || period,
      equityCurve: Array.isArray(cachedPreview?.equityCurve) ? cachedPreview.equityCurve : [],
      blockedByPlan: Boolean(cachedPreview?.blockedByPlan),
      blockedReason: cachedPreview?.blockedReason ? String(cachedPreview.blockedReason) : undefined,
    };

    // If system is active, do not keep stale "blocked" markers from older preview failures.
    if (Number(effectiveProfile.actual_enabled || 0) === 1) {
      preview.blockedByPlan = false;
      preview.blockedReason = undefined;
      if (!preview.sourceSystem && asString(profile.published_system_name, '')) {
        preview.sourceSystem = {
          apiKeyName: asString(getAlgofundSystemApiKeyName(tenant, effectiveProfile), ''),
          systemId: Number(engine?.systemId || 0),
          systemName: asString(effectiveProfile.published_system_name, ''),
        };
      }
    }
  }

  const portfolios = await listAlgofundPortfolios().catch(() => []);

  return {
    tenant,
    plan,
    capabilities,
    clientPreferences: algofundClientPrefs,
    profile: {
      ...effectiveProfile,
      latestPreview: safeJsonParse<Record<string, unknown>>(profile.latest_preview_json, {}),
    },
    engine,
    activeSystems,
    availableSystems,
    portfolios,
    preview,
    portfolioPassport: buildAlgofundPortfolioPassport(catalog, sweep, period, preview, riskMultiplier),
    requests: await getAlgofundRequestsByTenant(tenantId),
    catalog,
  };
};

export const updateAlgofundState = async (
  tenantId: number,
  payload: { riskMultiplier?: number; assignedApiKeyName?: string; requestedEnabled?: boolean }
) => {
  const tenant = await getTenantById(tenantId);
  const profile = await getAlgofundProfile(tenantId);
  const plan = await getPlanForTenant(tenantId, 'algofund_client');
  if (!profile || !plan) {
    throw new Error('Algofund profile or plan not found');
  }

  const nextRiskMultiplier = Math.max(0, Math.min(
    payload.riskMultiplier !== undefined ? payload.riskMultiplier : asNumber(profile.risk_multiplier, 1),
    asNumber(plan.risk_cap_max, 1)
  ));
  const currentExecutionApiKeyName = getAlgofundExecutionApiKeyName(tenant, profile);
  const nextApiKeyName = resolveAssignedApiKeyInput(
    payload as Record<string, unknown>,
    'assignedApiKeyName',
    currentExecutionApiKeyName,
  );
  const nextRequestedEnabled = payload.requestedEnabled !== undefined
    ? payload.requestedEnabled
    : Number(profile.requested_enabled || 0) === 1;

  // D0: нельзя включать Алгофонд без отдельного назначенного API-ключа.
  if (nextRequestedEnabled && !nextApiKeyName) {
    throw new Error('Нельзя включить Алгофонд без назначенного API-ключа. Сначала сохраните отдельный ключ для Алгофонда.');
  }

  // D1+D2: проверка что ключ не занят другим тенантом / другим режимом.
  // Проверяем не только при смене ключа, но и при фактическом включении потока,
  // чтобы не оставлять старые конфликтные назначения незамеченными.
  if (nextApiKeyName && (payload.assignedApiKeyName !== undefined || nextRequestedEnabled)) {
    await validateApiKeyNotAssigned(nextApiKeyName, tenantId, 'algofund');
  }

  const wasEnabled = Number(profile.requested_enabled || 0) === 1;

  await db.run(
    `UPDATE algofund_profiles
     SET risk_multiplier = ?, assigned_api_key_name = ?, execution_api_key_name = ?, requested_enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [nextRiskMultiplier, nextApiKeyName, nextApiKeyName, nextRequestedEnabled ? 1 : 0, tenantId]
  );

  await syncTenantAssignedApiKeyName(tenantId);

  // When toggling OFF: cancel orders, close positions, mark actual_enabled = 0
  const shutdownApiKeyName = currentExecutionApiKeyName || nextApiKeyName;
  if (wasEnabled && !nextRequestedEnabled && shutdownApiKeyName) {
    logger.info(`[updateAlgofundState] Tenant ${tenantId} toggled OFF — stopping orders/positions for ${shutdownApiKeyName}`);
    try { await cancelAllOrders(shutdownApiKeyName); } catch (e) { logger.warn(`cancelAllOrders on toggle-off for ${shutdownApiKeyName}: ${(e as Error).message}`); }
    try { await closeAllPositions(shutdownApiKeyName); } catch (e) { logger.warn(`closeAllPositions on toggle-off for ${shutdownApiKeyName}: ${(e as Error).message}`); }
    await db.run(
      `UPDATE algofund_profiles SET actual_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`,
      [tenantId]
    );
  }

  return getAlgofundState(tenantId, nextRiskMultiplier);
};

export const requestAlgofundAction = async (
  tenantId: number,
  requestType: AlgofundRequestType,
  note: string,
  payload: AlgofundRequestPayload = {}
) => {
  const tenant = await getTenantById(tenantId);
  const plan = await getPlanForTenant(tenantId, 'algofund_client');
  const profile = await getAlgofundProfile(tenantId);
  if (!profile || !plan) {
    throw new Error(`Algofund profile not found for tenant ${tenant.slug}`);
  }

  const capabilities = resolvePlanCapabilities(plan);
  // startStopRequests capability no longer gated — instant connect/disconnect for all clients

  const requestedExecutionApiKeyName = asString(payload.executionApiKeyName, '').trim();
  const apiKeyName = requestedExecutionApiKeyName || getAlgofundSystemApiKeyName(tenant, profile);
  if (requestedExecutionApiKeyName) {
    const exists = await db.get('SELECT id FROM api_keys WHERE name = ? LIMIT 1', [requestedExecutionApiKeyName]);
    if (!exists) {
      throw new Error(`API key not found: ${requestedExecutionApiKeyName}`);
    }

    await db.run(
      `UPDATE algofund_profiles
       SET assigned_api_key_name = ?,
           execution_api_key_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [requestedExecutionApiKeyName, requestedExecutionApiKeyName, tenantId]
    );
    await syncTenantAssignedApiKeyName(tenantId);
  }

  const requestPayload: AlgofundRequestPayload = {
    targetSystemId: undefined,
    targetSystemName: undefined,
    executionApiKeyName: requestedExecutionApiKeyName || undefined,
  };

  if ((requestType === 'start' || requestType === 'switch_system') && !apiKeyName) {
    throw new Error('Сначала назначьте отдельный API-ключ для Алгофонда. Без ключа запуск и переключение системы недоступны.');
  }

  if (requestType === 'switch_system') {
    const targetSystemId = Math.floor(asNumber(payload.targetSystemId, 0));
    const targetSystemNameRaw = asString(payload.targetSystemName, '').trim();
    if ((!targetSystemId || targetSystemId <= 0) && !targetSystemNameRaw) {
      throw new Error('targetSystemId or targetSystemName is required for switch_system request');
    }
    let switchApiKeyName = apiKeyName;
    let systems = switchApiKeyName ? await listTradingSystems(switchApiKeyName).catch(() => []) : [];
    let target = targetSystemId > 0
      ? (Array.isArray(systems) ? systems : []).find((item) => Number(item.id) === targetSystemId)
      : (Array.isArray(systems) ? systems : []).find((item) => asString(item?.name, '').trim() === targetSystemNameRaw);

    if (!target?.id && targetSystemId > 0) {
      const globalTarget = await db.get(
        `SELECT ts.id AS system_id, ts.name AS system_name, ak.name AS api_key_name
         FROM trading_systems ts
         JOIN api_keys ak ON ak.id = ts.api_key_id
         WHERE ts.id = ?`,
        [targetSystemId]
      ) as { system_id?: number; system_name?: string; api_key_name?: string } | undefined;

      const globalApiKeyName = asString(globalTarget?.api_key_name, '');
      if (globalTarget?.system_id && globalApiKeyName) {
        switchApiKeyName = globalApiKeyName;
        systems = await listTradingSystems(switchApiKeyName).catch(() => []);
        target = (Array.isArray(systems) ? systems : []).find((item) => Number(item.id) === targetSystemId) || {
          id: Number(globalTarget.system_id),
          name: asString(globalTarget.system_name, ''),
        } as any;
      }
    }

    if (!target?.id && targetSystemNameRaw) {
      const globalByName = await db.get(
        `SELECT ts.id AS system_id, ts.name AS system_name, ak.name AS api_key_name
         FROM trading_systems ts
         JOIN api_keys ak ON ak.id = ts.api_key_id
         WHERE ts.name = ?
         ORDER BY COALESCE(ts.is_active, 0) DESC, ts.id DESC
         LIMIT 1`,
        [targetSystemNameRaw]
      ) as { system_id?: number; system_name?: string; api_key_name?: string } | undefined;

      const globalApiKeyName = asString(globalByName?.api_key_name, '');
      if (globalByName?.system_id && globalApiKeyName) {
        switchApiKeyName = globalApiKeyName;
        systems = await listTradingSystems(switchApiKeyName).catch(() => []);
        target = (Array.isArray(systems) ? systems : []).find((item) => Number(item.id) === Number(globalByName.system_id)) || {
          id: Number(globalByName.system_id),
          name: asString(globalByName.system_name, targetSystemNameRaw),
        } as any;
      }
    }

    let virtualTarget: { systemName: string; apiKeyName: string } | null = null;
    if (!target?.id && targetSystemNameRaw) {
      const tsSnapshots = await getTsBacktestSnapshots().catch(() => ({} as Record<string, TsBacktestSnapshot>));
      const targetNameNormalized = targetSystemNameRaw.toUpperCase();
      for (const [setKey, snapshot] of Object.entries(tsSnapshots || {})) {
        const keyNormalized = asString(setKey, '').trim().toUpperCase();
        const snapshotNameNormalized = asString(snapshot?.systemName, '').trim().toUpperCase();
        if (keyNormalized === targetNameNormalized || snapshotNameNormalized === targetNameNormalized) {
          const resolvedName = asString(setKey, targetSystemNameRaw).trim() || targetSystemNameRaw;
          virtualTarget = {
            systemName: resolvedName,
            apiKeyName: asString(snapshot?.apiKeyName, '').trim() || getAlgofundPublishedSourceApiKeyName(resolvedName),
          };
          break;
        }
      }
    }

    if (!target?.id && !virtualTarget) {
      throw new Error(`Target trading system not found: ${targetSystemId || targetSystemNameRaw}`);
    }

    requestPayload.targetSystemId = Number(target?.id || targetSystemId || 0);
    requestPayload.targetSystemName = asString(target?.name || virtualTarget?.systemName, targetSystemNameRaw);
    requestPayload.targetApiKeyName = asString(
      target?.id ? switchApiKeyName : (virtualTarget?.apiKeyName || switchApiKeyName),
      ''
    );
  }

  await db.run(
    `INSERT INTO algofund_start_stop_requests (tenant_id, request_type, status, note, decision_note, request_payload_json, created_at)
     VALUES (?, ?, 'approved', ?, 'auto-approved', ?, CURRENT_TIMESTAMP)`,
    [tenantId, requestType, note, JSON.stringify(requestPayload)]
  );

  if (requestType === 'start' || requestType === 'stop') {
    await db.run(
      `UPDATE algofund_profiles
       SET requested_enabled = ?, actual_enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [requestType === 'start' ? 1 : 0, requestType === 'start' ? 1 : 0, tenantId]
    );
  }

  if (requestType === 'switch_system') {
    const targetSystemName = asString(requestPayload.targetSystemName, '').trim();
    if (targetSystemName) {
      const runtimeApiKeyName = requestedExecutionApiKeyName
        || asString(getAlgofundExecutionApiKeyName(tenant, profile), '').trim();
      await db.run(
        `UPDATE algofund_profiles
         SET published_system_name = ?,
             execution_api_key_name = COALESCE(NULLIF(?, ''), execution_api_key_name),
             latest_preview_json = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`,
        [targetSystemName, runtimeApiKeyName, tenantId]
      );
    }
  }

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'algofund_client', ?, ?, CURRENT_TIMESTAMP)`,
    [tenantId, `algofund_${requestType}_request`, JSON.stringify({ note, requestPayload })]
  );

  return getAlgofundState(tenantId);
};

export const resolveAlgofundRequest = async (requestId: number, status: RequestStatus, decisionNote: string) => {
  const request = await db.get('SELECT * FROM algofund_start_stop_requests WHERE id = ?', [requestId]);
  if (!request) {
    throw new Error(`Algofund request not found: ${requestId}`);
  }

  const row = request as AlgofundRequestRow;
  const requestPayload = parseAlgofundRequestPayload(row.request_payload_json);
  const tenant = await getTenantById(row.tenant_id);
  const plan = await getPlanForTenant(row.tenant_id, 'algofund_client');
  const profile = await getAlgofundProfile(row.tenant_id);
  if (!plan || !profile) {
    throw new Error('Algofund plan/profile not found');
  }

  const capabilities = resolvePlanCapabilities(plan);
  if (status === 'approved' && !capabilities.startStopRequests) {
    throw new Error('Start/stop requests are not available for the current plan');
  }

  if (status === 'approved') {
    decisionNote = await applyApprovedAlgofundAction({
      row,
      requestPayload,
      tenant,
      profile,
      plan,
      decisionNote,
    });
  }

  await db.run(
    `UPDATE algofund_start_stop_requests
     SET status = ?, decision_note = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, decisionNote, requestId]
  );

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'admin', 'resolve_algofund_request', ?, CURRENT_TIMESTAMP)`,
    [row.tenant_id, JSON.stringify({ requestId, status, decisionNote })]
  );

  return getAlgofundState(row.tenant_id);
};

const applyApprovedAlgofundAction = async (params: {
  row: AlgofundRequestRow;
  requestPayload: AlgofundRequestPayload;
  tenant: TenantRow;
  profile: AlgofundProfileRow;
  plan: PlanRow;
  decisionNote: string;
}): Promise<string> => {
  const {
    row,
    requestPayload,
    tenant,
    profile,
    plan,
  } = params;
  let decisionNote = params.decisionNote;

  if (row.request_type === 'start') {
    try {
      await materializeAlgofundSystem(tenant, plan, { ...profile, requested_enabled: 1 }, true);
      await db.run('UPDATE algofund_profiles SET actual_enabled = 1, requested_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [row.tenant_id]);
      const publishedSystemName = asString(profile.published_system_name, '').trim();
      if (publishedSystemName) {
        await db.run(
          `INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
           VALUES (?, ?, 1, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(profile_id, system_name)
           DO UPDATE SET is_enabled = 1, updated_at = CURRENT_TIMESTAMP`,
          [profile.id, publishedSystemName]
        );
      }
    } catch (error) {
      const reason = (error as Error).message || 'Materialization failed';
      logger.warn(`Algofund request approve fallback for tenant ${row.tenant_id}: ${reason}`);
      await db.run('UPDATE algofund_profiles SET actual_enabled = 0, requested_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [row.tenant_id]);

      const note = decisionNote.trim();
      const suffix = `Auto-note: approved without materialization (${reason})`;
      decisionNote = note ? `${note} | ${suffix}` : suffix;
    }
  } else if (row.request_type === 'stop') {
    const algofundApiKey = getAlgofundExecutionApiKeyName(tenant, profile);
    const systems = algofundApiKey ? await listTradingSystems(algofundApiKey) : [];
    const existing = systems.find((item) => asString(item.name) === getAlgofundClientSystemName(tenant));
    if (existing?.id) {
      await setTradingSystemActivation(algofundApiKey, Number(existing.id), false, true);
    }
    if (algofundApiKey) {
      try {
        await cancelAllOrders(algofundApiKey);
      } catch (error) {
        logger.warn(`cancelAllOrders on stop for ${algofundApiKey}: ${(error as Error).message}`);
      }
      try {
        await closeAllPositions(algofundApiKey);
      } catch (error) {
        logger.warn(`closeAllPositions on stop for ${algofundApiKey}: ${(error as Error).message}`);
      }
    }
    await db.run('UPDATE algofund_profiles SET actual_enabled = 0, requested_enabled = 0, published_system_name = \'\', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [row.tenant_id]);
    // Disable all active systems for this profile
    logger.info(`[algofund-stop] Disabling active_systems for profile_id=${profile.id} tenant_id=${row.tenant_id}`);
    const stopResult = await db.run(
      `UPDATE algofund_active_systems
       SET is_enabled = 0, updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = ? AND COALESCE(is_enabled, 1) = 1`,
      [profile.id]
    );
    logger.info(`[algofund-stop] active_systems update result: changes=${(stopResult as any)?.changes ?? 'unknown'} profile_id=${profile.id}`);
  } else if (row.request_type === 'switch_system') {
    const targetSystemId = Math.floor(asNumber(requestPayload.targetSystemId, 0));
    let globalTarget: { system_id?: number; system_name?: string; source_api_key_name?: string } | undefined;
    if (targetSystemId > 0) {
      globalTarget = await db.get(
        `SELECT ts.id AS system_id, ts.name AS system_name, ak.name AS source_api_key_name
         FROM trading_systems ts
         JOIN api_keys ak ON ak.id = ts.api_key_id
         WHERE ts.id = ?`,
        [targetSystemId]
      ) as { system_id?: number; system_name?: string; source_api_key_name?: string } | undefined;
    }

    const targetSystemName = asString(
      globalTarget?.system_name || requestPayload.targetSystemName,
      ''
    ).trim();
    if (!targetSystemName) {
      throw new Error(`Target trading system not found: ${targetSystemId || asString(requestPayload.targetSystemName, '').trim()}`);
    }

    const runtimeApiKeyName = asString(getAlgofundExecutionApiKeyName(tenant, profile), '').trim();
    if (!runtimeApiKeyName) {
      throw new Error('Assign API key before approving switch request');
    }

    const switchProfile: AlgofundProfileRow = {
      ...profile,
      requested_enabled: 1,
      actual_enabled: 1,
      assigned_api_key_name: runtimeApiKeyName,
      execution_api_key_name: runtimeApiKeyName,
      published_system_name: targetSystemName,
    };

    await materializeAlgofundSystem(tenant, plan, switchProfile, true);

    // Fallback for card-materialized flows: if switch did not produce active strategies,
    // materialize the target system members directly and activate them.
    const activeAfterSwitch = await db.get(
      `SELECT COUNT(*) AS cnt
       FROM strategies s
       JOIN api_keys ak ON ak.id = s.api_key_id
       WHERE ak.name = ?
         AND COALESCE(s.is_runtime, 0) = 1
         AND COALESCE(s.is_active, 0) = 1`,
      [runtimeApiKeyName]
    ) as { cnt?: number } | undefined;

    const sourceApiKeyName = asString(globalTarget?.source_api_key_name, '').trim();
    if (Number(activeAfterSwitch?.cnt || 0) === 0 && targetSystemId > 0 && sourceApiKeyName) {
      const tsMembers = await db.all(
        `SELECT strategy_id
         FROM trading_system_members
         WHERE system_id = ?
           AND COALESCE(is_enabled, 1) = 1`,
        [targetSystemId]
      ) as Array<{ strategy_id?: number }>;

      const sourceStrategyIds = (Array.isArray(tsMembers) ? tsMembers : [])
        .map((row) => Number(row?.strategy_id || 0))
        .filter((id) => Number.isFinite(id) && id > 0);

      if (sourceStrategyIds.length === 0) {
        throw new Error(`Target system has no enabled members: ${targetSystemName}`);
      }

      let compatibleSourceStrategyIds = sourceStrategyIds;
      try {
        const [targetSymbols, sourceRows] = await Promise.all([
          getAllSymbols(runtimeApiKeyName),
          getStrategies(sourceApiKeyName, { includeLotPreview: false }),
        ]);
        const availableSymbols = new Set(
          (Array.isArray(targetSymbols) ? targetSymbols : [])
            .map((symbol) => asString(symbol, '').trim().toUpperCase())
            .filter((symbol) => symbol.length > 0)
        );

        if (availableSymbols.size > 0) {
          const sourceById = new Map<number, any>();
          for (const row of (Array.isArray(sourceRows) ? sourceRows : [])) {
            const id = Number((row as { id?: unknown })?.id || 0);
            if (Number.isFinite(id) && id > 0) {
              sourceById.set(id, row);
            }
          }
          const skippedPairs: Array<{ strategyId: number; market: string }> = [];
          const filteredIds: number[] = [];

          for (const strategyId of sourceStrategyIds) {
            const sourceStrategy = sourceById.get(strategyId) as Record<string, unknown> | undefined;
            if (!sourceStrategy) {
              filteredIds.push(strategyId);
              continue;
            }

            const marketMode = asString(sourceStrategy.market_mode || sourceStrategy.marketMode, 'mono');
            const base = asString(sourceStrategy.base_symbol || sourceStrategy.baseSymbol, '').trim().toUpperCase();
            const quote = asString(sourceStrategy.quote_symbol || sourceStrategy.quoteSymbol, '').trim().toUpperCase();
            const parsed = parseSweepMarketLegs({ marketMode, baseSymbol: base, quoteSymbol: quote });

            if (parsed.label && !isMarketAvailableOnExchange(availableSymbols, {
              marketMode,
              baseSymbol: base,
              quoteSymbol: quote,
            })) {
              skippedPairs.push({ strategyId, market: parsed.label });
              continue;
            }

            filteredIds.push(strategyId);
          }

          for (const skipped of skippedPairs) {
            await db.run(
              `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
               VALUES (?, 'system', 'saas_materialize_pair_unavailable', ?, CURRENT_TIMESTAMP)`,
              [
                tenant.id,
                JSON.stringify({
                  apiKeyName: runtimeApiKeyName,
                  market: skipped.market,
                  strategyId: skipped.strategyId,
                  reason: 'market_not_supported_on_exchange',
                  sourceSystem: targetSystemName,
                }),
              ]
            );
          }

          compatibleSourceStrategyIds = filteredIds;
          if (skippedPairs.length > 0) {
            logger.info(
              `Algofund switch fallback: skipped ${skippedPairs.length} incompatible strategies for ${runtimeApiKeyName}`
            );
          }
        }
      } catch (error) {
        logger.warn(
          `Algofund switch fallback: compatibility filter unavailable for ${runtimeApiKeyName}: ${(error as Error).message}`
        );
      }

      if (compatibleSourceStrategyIds.length > 0) {
        await copyStrategyBlock(sourceApiKeyName, runtimeApiKeyName, {
          replaceTarget: true,
          preserveActive: true,
          syncSymbols: false,
          sourceStrategyIds: compatibleSourceStrategyIds,
        });

        await db.run(
          `UPDATE strategies
           SET is_runtime = 1,
               is_archived = 0,
               is_active = 1,
               auto_update = 1,
               origin = CASE
                 WHEN COALESCE(origin, '') IN ('', 'manual') THEN 'card_materialized'
                 ELSE origin
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)` ,
          [runtimeApiKeyName]
        );
      } else {
        throw new Error(`No compatible strategies available for ${runtimeApiKeyName} in ${targetSystemName}`);
      }
    }

    await db.run(
      `UPDATE algofund_active_systems
       SET is_enabled = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = ?
         AND system_name != ?
         AND COALESCE(is_enabled, 1) = 1`,
      [profile.id, targetSystemName]
    );
    await db.run(
      `INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
       VALUES (?, ?, 1, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(profile_id, system_name)
       DO UPDATE SET is_enabled = 1, updated_at = CURRENT_TIMESTAMP`,
      [profile.id, targetSystemName]
    );
  }

  return decisionNote;
};

export const retryMaterializeAlgofundSystem = async (tenantId: number) => {
  const tenant = await getTenantById(tenantId);
  const plan = await getPlanForTenant(tenantId, 'algofund_client');
  const profile = await getAlgofundProfile(tenantId);
  if (!plan || !profile) {
    throw new Error('Algofund plan/profile not found');
  }

  if (!profile.requested_enabled) {
    throw new Error('Materialization retry only available when start has been requested');
  }

  // Defensive: if a previous run leaked a transaction (e.g. a failed ROLLBACK
  // left the shared sqlite connection inside an open BEGIN), clear it before
  // we start. Materialization opens its own transactions internally and will
  // otherwise fail with "cannot start a transaction within a transaction".
  await db.exec('ROLLBACK').catch(() => {});

  try {
    await materializeAlgofundSystem(tenant, plan, { ...profile, requested_enabled: 1 }, true);
    await db.run('UPDATE algofund_profiles SET actual_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [tenantId]);
  } catch (error) {
    const reason = (error as Error).message || 'Materialization failed';
    logger.warn(`Algofund retry materialize failed for tenant ${tenant.slug}: ${reason}`);
    // Keep actual_enabled = 0, blockedReason will be shown from preview
    throw new Error(`Retry failed: ${reason}`);
  }

  // Return lightweight state — skip live preview/balance fetch to avoid blocking exchange rate limiter.
  // Full state (with equity curve) is available via GET /algofund/:tenantId.
  const updatedProfile = await getAlgofundProfile(tenantId);
  const executionApiKeyName = updatedProfile ? getAlgofundExecutionApiKeyName(tenant, updatedProfile) : null;
  const engineTs = executionApiKeyName
    ? await db.get<{ id: number; name: string; is_active: number }>(
        `SELECT ts.id, ts.name, ts.is_active FROM trading_systems ts
         JOIN api_keys a ON a.id = ts.api_key_id
         WHERE a.name = ? AND ts.name LIKE 'ALGOFUND::%'
         ORDER BY ts.id DESC LIMIT 1`,
        [executionApiKeyName]
      ).catch(() => null)
    : null;
  return {
    tenant,
    plan,
    profile: updatedProfile,
    engine: engineTs
      ? { apiKeyName: executionApiKeyName, systemId: engineTs.id, systemName: engineTs.name, isActive: engineTs.is_active === 1 }
      : null,
  };
};

/**
 * Resolve an existing published source TS for a given setKey by looking up
 * `master_cards.code = CARD::ALGOFUND_MASTER::<api_key>::<SLUG>`.
 *
 * This is the inverse of the suffix-based "always-create-new" path used by
 * the auto-publish flow. It lets the publish endpoint detect "edit-in-place"
 * intent and reuse an already-deployed master TS instead of producing
 * orphaned `*-<hash>` duplicates.
 */
const resolveExistingPublishedTsForSetKey = async (setKey: string): Promise<{
  systemId: number;
  systemName: string;
  apiKeyName: string;
  cardId: number;
  cardCode: string;
  cardMetadata: Record<string, unknown>;
  membersCount: number;
  connectedClientCount: number;
} | null> => {
  const slug = buildSetSlug(setKey);
  if (!slug) {
    return null;
  }
  const slugUpper = slug.toUpperCase();
  const card = await db.get<{
    id: number;
    code: string;
    source_system_id: number;
    metadata_json: string;
  }>(
    `SELECT id, code, source_system_id, metadata_json FROM master_cards
     WHERE code LIKE ? AND is_active = 1
     ORDER BY id DESC LIMIT 1`,
    [`CARD::ALGOFUND_MASTER::%::${slugUpper}`]
  ).catch(() => null);
  if (!card || !card.source_system_id) {
    return null;
  }
  const tsRow = await db.get<{ id: number; name: string; api_key_name: string }>(
    `SELECT ts.id, ts.name, a.name AS api_key_name
     FROM trading_systems ts JOIN api_keys a ON a.id = ts.api_key_id
     WHERE ts.id = ?`,
    [Number(card.source_system_id)]
  ).catch(() => null);
  if (!tsRow) {
    return null;
  }
  const membersCount = Number((await db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM trading_system_members WHERE system_id = ?`,
    [tsRow.id]
  ).catch(() => null))?.c || 0);
  const connectedClientCount = Number((await db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM algofund_profiles WHERE published_system_name = ? AND requested_enabled = 1`,
    [tsRow.name]
  ).catch(() => null))?.c || 0);
  let cardMetadata: Record<string, unknown> = {};
  try {
    cardMetadata = card.metadata_json ? (JSON.parse(String(card.metadata_json)) as Record<string, unknown>) : {};
  } catch {
    cardMetadata = {};
  }
  return {
    systemId: Number(tsRow.id),
    systemName: String(tsRow.name),
    apiKeyName: String(tsRow.api_key_name),
    cardId: Number(card.id),
    cardCode: String(card.code),
    cardMetadata,
    membersCount,
    connectedClientCount,
  };
};

/**
 * GET /admin/publish/preview helper — returns whether a publish for this
 * setKey would hit an existing card (edit-in-place) and how many live
 * clients are attached. Frontend uses this to render an explicit
 * "затронет N клиентов" confirmation dialog before POST /admin/publish.
 */
export const previewPublishImpact = async (setKey: string): Promise<{
  setKey: string;
  slug: string;
  cardExists: boolean;
  systemName: string | null;
  systemId: number | null;
  apiKeyName: string | null;
  membersCount: number;
  connectedClientCount: number;
  cardMetadata: Record<string, unknown>;
}> => {
  const trimmed = asString(setKey, '').trim();
  const slug = buildSetSlug(trimmed);
  const existing = trimmed ? await resolveExistingPublishedTsForSetKey(trimmed) : null;
  return {
    setKey: trimmed,
    slug,
    cardExists: Boolean(existing),
    systemName: existing?.systemName || null,
    systemId: existing?.systemId || null,
    apiKeyName: existing?.apiKeyName || null,
    membersCount: existing?.membersCount || 0,
    connectedClientCount: existing?.connectedClientCount || 0,
    cardMetadata: existing?.cardMetadata || {},
  };
};

/**
 * Apply card-level overrides (lotPercentOverride, maxOpenPositions) into
 * `master_cards.metadata_json`. Re-materialization picks these up via the
 * existing routes.ts/applyCardLotOverride path.
 */
const applyCardMetadataOverrides = async (
  cardId: number,
  currentMetadata: Record<string, unknown>,
  overrides?: CardMetadataOverrides,
  sourceSystem?: { apiKeyName: string; systemId: number },
): Promise<{ changed: boolean; metadata: Record<string, unknown> }> => {
  if (!overrides) {
    return { changed: false, metadata: currentMetadata };
  }
  const next: Record<string, unknown> = { ...currentMetadata };
  let changed = false;
  if (overrides.lotPercentOverride !== undefined) {
    const lot = Number(overrides.lotPercentOverride);
    if (Number.isFinite(lot) && lot >= 0) {
      if (Number(next.lotPercentOverride) !== lot) {
        next.lotPercentOverride = lot;
        changed = true;
      }
    }
  }
  if (overrides.maxOpenPositions !== undefined) {
    const mop = Number(overrides.maxOpenPositions);
    if (Number.isFinite(mop) && mop >= 0) {
      const mopInt = Math.floor(mop);
      if (Number(next.maxOpenPositions) !== mopInt) {
        next.maxOpenPositions = mopInt;
        changed = true;
      }
    }
  }
  if (overrides.autoLotByChannelWidth !== undefined) {
    const enabled = overrides.autoLotByChannelWidth === true;
    if (Boolean(next.autoLotByChannelWidth) !== enabled) {
      next.autoLotByChannelWidth = enabled;
      changed = true;
    }
  }
  if (overrides.dcaPerLegSl !== undefined) {
    const enabled = overrides.dcaPerLegSl === true;
    if (Boolean(next.dcaPerLegSl) !== enabled) {
      next.dcaPerLegSl = enabled;
      changed = true;
    }
  }
  if (overrides.reinvestPercentOverride !== undefined) {
    const reinvest = Math.min(100, Math.max(0, Number(overrides.reinvestPercentOverride)));
    if (Number.isFinite(reinvest) && Number(next.reinvestPercentOverride) !== reinvest) {
      next.reinvestPercentOverride = reinvest;
      changed = true;
    }
  }
  if (overrides.macroShield !== undefined) {
    const enabled = overrides.macroShield === true;
    if (Boolean(next.macroShield) !== enabled) {
      next.macroShield = enabled;
      changed = true;
    }
  }
  if (overrides.macroExitOverlay === null) {
    if (next.macroExitOverlay !== undefined) {
      delete next.macroExitOverlay;
      changed = true;
    }
  } else if (overrides.macroExitOverlay) {
    const serialized = JSON.stringify(overrides.macroExitOverlay);
    if (JSON.stringify(next.macroExitOverlay || null) !== serialized) {
      next.macroExitOverlay = overrides.macroExitOverlay;
      changed = true;
    }
  }
  if (overrides.statArbEntryGate === null) {
    if (next.statArbEntryGate !== undefined) {
      delete next.statArbEntryGate;
      changed = true;
    }
  } else if (overrides.statArbEntryGate) {
    const serialized = JSON.stringify(overrides.statArbEntryGate);
    if (JSON.stringify(next.statArbEntryGate || null) !== serialized) {
      next.statArbEntryGate = overrides.statArbEntryGate;
      changed = true;
    }
  }
  if (overrides.tunePreset !== undefined) {
    const preset = String(overrides.tunePreset || '').trim();
    if (preset && next.tunePreset !== preset) {
      next.tunePreset = preset;
      changed = true;
    }
  }
  if (overrides.enablePairLock !== undefined) {
    const enabled = overrides.enablePairLock === true;
    if (Boolean(next.enablePairLock) !== enabled) {
      next.enablePairLock = enabled;
      changed = true;
    }
  }
  if (overrides.dcaMarkets !== undefined) {
    const markets = Array.from(new Set(
      overrides.dcaMarkets.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean),
    ));
    if (JSON.stringify(next.dcaMarkets || []) !== JSON.stringify(markets)) {
      next.dcaMarkets = markets;
      changed = true;
    }
  }
  if (overrides.dcaEnabled !== undefined) {
    const enabled = overrides.dcaEnabled === true;
    if (Boolean(next.dcaEnabled) !== enabled) {
      next.dcaEnabled = enabled;
      changed = true;
    }
  }
  if (overrides.portfolioCircuitBreaker === null) {
    if (next.portfolioCircuitBreaker !== undefined) {
      delete next.portfolioCircuitBreaker;
      changed = true;
    }
  } else if (overrides.portfolioCircuitBreaker) {
    const serialized = JSON.stringify(overrides.portfolioCircuitBreaker);
    if (JSON.stringify(next.portfolioCircuitBreaker || null) !== serialized) {
      next.portfolioCircuitBreaker = overrides.portfolioCircuitBreaker;
      changed = true;
    }
  }
  if (changed) {
    await db.run(
      `UPDATE master_cards SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [JSON.stringify(next), cardId]
    );
  }

  const resolvedMaxOpenPositions = Math.max(0, Math.floor(asNumber(next.maxOpenPositions, 0)));
  if (sourceSystem?.apiKeyName && sourceSystem.systemId > 0 && resolvedMaxOpenPositions > 0) {
    try {
      await updateTradingSystem(sourceSystem.apiKeyName, sourceSystem.systemId, {
        max_open_positions: resolvedMaxOpenPositions,
      });
      logger.info(
        `applyCardMetadataOverrides: synced master TS #${sourceSystem.systemId} max_open_positions=${resolvedMaxOpenPositions}`,
      );
    } catch (error) {
      logger.warn(
        `applyCardMetadataOverrides: failed to sync master TS max_open_positions: ${(error as Error).message}`,
      );
    }
  }

  const pruned = await pruneArchivedMasterCardMembers(cardId).catch(() => 0);
  if (pruned > 0) {
    logger.info(`applyCardMetadataOverrides: pruned ${pruned} archived rows from master_card_members for card #${cardId}`);
  }

  return { changed, metadata: next };
};

const syncCardMechanicsFromSnapshot = async (snapshot: TsBacktestSnapshot): Promise<void> => {
  const systemName = asString(snapshot.systemName, '').trim();
  if (!systemName) {
    return;
  }
  const overrides = buildCardMechanicsOverridesFromSnapshot(snapshot);
  if (Object.keys(overrides).length === 0) {
    return;
  }
  const code = `CARD::${systemName.toUpperCase()}`;
  const row = await db.get<{ id: number; metadata_json?: string; source_system_id?: number }>(
    'SELECT id, metadata_json, source_system_id FROM master_cards WHERE code = ? AND is_active = 1',
    [code],
  ).catch(() => null);
  if (!row?.id) {
    return;
  }
  const currentMeta = row.metadata_json
    ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
    : {};
  let sourceSystem: { apiKeyName: string; systemId: number } | undefined;
  if (row.source_system_id) {
    const tsRow = await db.get<{ id: number; api_key_name: string }>(
      `SELECT ts.id, ak.name AS api_key_name
       FROM trading_systems ts
       JOIN api_keys ak ON ak.id = ts.api_key_id
       WHERE ts.id = ?`,
      [row.source_system_id],
    ).catch(() => null);
    if (tsRow?.id && tsRow.api_key_name) {
      sourceSystem = { apiKeyName: tsRow.api_key_name, systemId: tsRow.id };
    }
  }
  const result = await applyCardMetadataOverrides(row.id, currentMeta, overrides, sourceSystem);
  if (result.changed) {
    logger.info(`syncCardMechanicsFromSnapshot: updated master_card metadata for ${systemName}`);
  }
};

const syncMasterStrategyFlagsFromSnapshot = async (snapshot: TsBacktestSnapshot): Promise<void> => {
  const settings = (snapshot.backtestSettings || {}) as Record<string, unknown>;
  const systemName = String(snapshot.systemName || snapshot.setKey || '').trim();
  if (!systemName) {
    return;
  }
  const targets = await resolveAlgofundSystemTargets({ systemName }).catch(() => []);
  const target = targets[0];
  if (!target?.systemId || !target.apiKeyName) {
    return;
  }
  const autoLot = settings.autoLotByChannelWidth === true ? 1 : 0;
  const dcaPerLegSl = settings.dcaPerLegSl === true ? 1 : 0;
  await db.run(
    `UPDATE strategies
     SET auto_lot_by_channel_width = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id IN (SELECT strategy_id FROM trading_system_members WHERE system_id = ?)
       AND api_key_id = (SELECT id FROM api_keys WHERE name = ?)
       AND COALESCE(strategy_type, '') NOT IN ('dca', 'dca_futures')`,
    [autoLot, target.systemId, target.apiKeyName],
  );
  await db.run(
    `UPDATE strategies
     SET dca_per_leg_sl = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id IN (SELECT strategy_id FROM trading_system_members WHERE system_id = ?)
       AND api_key_id = (SELECT id FROM api_keys WHERE name = ?)
       AND strategy_type = 'dca'`,
    [dcaPerLegSl, target.systemId, target.apiKeyName],
  );
};

/**
 * Re-materialize an existing published master TS to all algofund clients
 * currently attached to it. Used after edit-in-place publish to push
 * updated card metadata (lot %, max open positions, …) to live clients.
 *
 * Errors per tenant are collected and returned — we never abort the loop
 * because partial propagation is far better than total failure when one
 * tenant has a bad exchange key or stale balances.
 */
/** Append classic DCA strategy_ids to master TS + master_card_members (materialize source). */
const syncMasterTradingSystemDcaMembers = async (
  systemName: string,
  strategyIds: number[],
): Promise<number> => {
  const name = asString(systemName, '').trim();
  const ids = Array.from(new Set(
    (Array.isArray(strategyIds) ? strategyIds : [])
      .map((id) => Math.floor(Number(id)))
      .filter((id) => Number.isFinite(id) && id > 0),
  ));
  if (!name || ids.length === 0) {
    return 0;
  }

  const targets = await resolveAlgofundSystemTargets({ systemName: name }).catch(() => []);
  const target = targets[0];
  if (!target?.systemId || !target?.apiKeyName) {
    return 0;
  }

  const system = await getTradingSystem(target.apiKeyName, target.systemId);
  const memberById = new Map<number, TradingSystemMemberDraft>();
  for (const member of system.members || []) {
    const sid = Number(member.strategy_id || 0);
    if (sid > 0) {
      memberById.set(sid, {
        strategy_id: sid,
        weight: asNumber(member.weight, 1),
        member_role: asString(member.member_role, 'core'),
        is_enabled: member.is_enabled !== false,
        notes: asString(member.notes, ''),
      });
    }
  }

  let added = 0;
  for (const strategyId of ids) {
    if (memberById.has(strategyId)) {
      continue;
    }
    memberById.set(strategyId, {
      strategy_id: strategyId,
      weight: 0.85,
      member_role: 'satellite',
      is_enabled: true,
      notes: 'dca overlay',
    });
    added += 1;
  }

  if (added > 0) {
    await updateTradingSystem(target.apiKeyName, target.systemId, {
      max_members: Math.max(memberById.size, Number(system.max_members || 0), 6),
    });
    await replaceTradingSystemMembers(
      target.apiKeyName,
      target.systemId,
      Array.from(memberById.values()),
    );
  }

  const card = await db.get<{ id: number }>(
    'SELECT id FROM master_cards WHERE code = ? AND is_active = 1',
    [`CARD::${name.toUpperCase()}`],
  ).catch(() => null);
  if (card?.id) {
    for (const strategyId of ids) {
      await db.run(
        `INSERT INTO master_card_members (card_id, strategy_id, weight, member_role, is_enabled, notes, created_at)
         VALUES (?, ?, 0.85, 'satellite', 1, 'dca overlay', CURRENT_TIMESTAMP)
         ON CONFLICT(card_id, strategy_id) DO UPDATE SET
           is_enabled = 1,
           notes = excluded.notes`,
        [Number(card.id), strategyId],
      ).catch(() => {});
    }
  }

  if (added > 0) {
    logger.info(`[syncMasterTradingSystemDcaMembers] +${added} DCA members on ${name} (TS #${target.systemId})`);
  }
  return added;
};

/**
 * Copies all dca_futures master strategies that are members of `systemId`
 * from `masterApiKeyName` to `clientApiKeyName`.
 */
const materializeDcaFuturesToClient = async (
  masterApiKeyName: string,
  clientApiKeyName: string,
  systemId: number,
): Promise<void> => {
  const masters = await db.all<Array<{
    id: number; name: string; base_symbol: string; quote_symbol: string;
    dcaf_base_amount_usdt: number; dcaf_step_percent: number; dcaf_max_orders: number;
    dcaf_order_multiplier: number; dcaf_tp_percent: number; dcaf_sl_percent: number;
    dcaf_order_type: string; dcaf_auto_open: number; dcaf_leverage: number;
  }>>(
    `SELECT s.id, s.name, s.base_symbol, s.quote_symbol,
       s.dcaf_base_amount_usdt, s.dcaf_step_percent, s.dcaf_max_orders,
       s.dcaf_order_multiplier, s.dcaf_tp_percent, s.dcaf_sl_percent,
       s.dcaf_order_type, s.dcaf_auto_open, s.dcaf_leverage
     FROM trading_system_members tsm
     JOIN strategies s ON s.id = tsm.strategy_id
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE tsm.system_id = ? AND s.strategy_type = 'dca_futures'
       AND ak.name = ? AND s.is_archived = 0`,
    [systemId, masterApiKeyName],
  ).catch(() => []);
  if (!Array.isArray(masters) || masters.length === 0) return;

  const clientAkRow = await db.get<{ id: number }>(
    `SELECT id FROM api_keys WHERE name = ?`, [clientApiKeyName],
  ).catch(() => null);
  if (!clientAkRow) return;
  const clientAkId = Number(clientAkRow.id);

  for (const master of masters) {
    const clientName = master.name.replace(masterApiKeyName, clientApiKeyName);
    const existing = await db.get<{ id: number }>(
      `SELECT id FROM strategies WHERE api_key_id = ? AND name = ? AND is_archived = 0`,
      [clientAkId, clientName],
    ).catch(() => null);

    if (existing?.id) {
      await db.run(
        `UPDATE strategies SET dcaf_base_amount_usdt=?, dcaf_step_percent=?, dcaf_max_orders=?,
           dcaf_order_multiplier=?, dcaf_tp_percent=?, dcaf_sl_percent=?,
           dcaf_order_type=?, dcaf_auto_open=?, dcaf_leverage=?,
           is_active=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [master.dcaf_base_amount_usdt, master.dcaf_step_percent, master.dcaf_max_orders,
         master.dcaf_order_multiplier, master.dcaf_tp_percent, master.dcaf_sl_percent,
         master.dcaf_order_type, master.dcaf_auto_open, master.dcaf_leverage, existing.id],
      );
    } else {
      await db.run(
        `INSERT INTO strategies
           (api_key_id, name, strategy_type, market_mode, market_type,
            base_symbol, quote_symbol, is_active, is_runtime, is_archived, origin,
            auto_update, long_enabled, short_enabled,
            dcaf_base_amount_usdt, dcaf_step_percent, dcaf_max_orders,
            dcaf_order_multiplier, dcaf_tp_percent, dcaf_sl_percent,
            dcaf_order_type, dcaf_auto_open, dcaf_leverage,
            dcaf_state, created_at, updated_at)
         VALUES (?,?,'dca_futures','mono','futures',?,?,1,1,0,'saas_materialize',1,1,1,
                 ?,?,?,?,?,?,?,?,?,'idle',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [clientAkId, clientName, master.base_symbol, master.quote_symbol,
         master.dcaf_base_amount_usdt, master.dcaf_step_percent, master.dcaf_max_orders,
         master.dcaf_order_multiplier, master.dcaf_tp_percent, master.dcaf_sl_percent,
         master.dcaf_order_type, master.dcaf_auto_open, master.dcaf_leverage],
      );
    }
    logger.info(`[materializeDcaFutures] ${existing?.id ? 'updated' : 'created'} ${clientName} on ${clientApiKeyName}`);
  }
};

/** Attach copied DCA strategy_ids to a client's runtime trading system. */
const attachClientDcaMembersToTradingSystem = async (
  clientApiKeyName: string,
  clientSystemId: number,
  dcaStrategyIds: number[],
): Promise<number> => {
  const ids = Array.from(new Set(dcaStrategyIds.map((id) => Number(id || 0)).filter((id) => id > 0)));
  if (ids.length === 0 || clientSystemId <= 0) {
    return 0;
  }

  const system = await getTradingSystem(clientApiKeyName, clientSystemId).catch(() => null);
  if (!system) {
    return 0;
  }

  const memberById = new Map<number, TradingSystemMemberDraft>();
  for (const member of system.members || []) {
    const sid = Number(member.strategy_id || 0);
    if (sid > 0) {
      memberById.set(sid, {
        strategy_id: sid,
        weight: asNumber(member.weight, 1),
        member_role: asString(member.member_role, 'core'),
        is_enabled: member.is_enabled !== false,
        notes: asString(member.notes, ''),
      });
    }
  }

  let added = 0;
  for (const strategyId of ids) {
    if (memberById.has(strategyId)) {
      continue;
    }
    memberById.set(strategyId, {
      strategy_id: strategyId,
      weight: 0.85,
      member_role: 'satellite',
      is_enabled: true,
      notes: 'dca satellite',
    });
    added += 1;
  }

  if (added <= 0) {
    return 0;
  }

  await updateTradingSystem(clientApiKeyName, clientSystemId, {
    max_members: Math.max(memberById.size, Number(system.max_members || 0), 6),
  });
  await replaceTradingSystemMembers(
    clientApiKeyName,
    clientSystemId,
    Array.from(memberById.values()),
  );
  logger.info(`[attachClientDcaMembers] +${added} DCA on ${clientApiKeyName} TS #${clientSystemId}`);
  return added;
};

/** Copy classic `dca` strategies (modal apply path) from master TS to client API key. */
const materializeClassicDcaToClient = async (
  masterApiKeyName: string,
  clientApiKeyName: string,
  systemId: number,
): Promise<number[]> => {
  // Master DCA rows may be archived during card edits — restore before copy.
  await db.run(
    `UPDATE strategies
     SET is_archived = 0, is_active = 1, updated_at = CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT tsm.strategy_id FROM trading_system_members tsm
       JOIN strategies s ON s.id = tsm.strategy_id
       WHERE tsm.system_id = ? AND s.strategy_type = 'dca'
     )`,
    [systemId],
  ).catch(() => {});

  const masters = await db.all<Array<{
    id: number;
    name: string;
    base_symbol: string;
    quote_symbol: string;
    interval: string;
    detection_source: string;
    dca_base_amount_usdt: number;
    dca_base_amount_percent: number;
    dca_step_percent: number;
    dca_max_orders: number;
    dca_order_multiplier: number;
    dca_tp_percent: number;
    dca_sl_percent: number;
    dca_entry_filter: string;
    dca_reentry_bars: number;
    dca_rsi_period: number;
    dca_rsi_max: number;
    dca_per_leg_sl: number;
  }>>(
    `SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval, s.detection_source,
       s.dca_base_amount_usdt, s.dca_base_amount_percent, s.dca_step_percent, s.dca_max_orders,
       s.dca_order_multiplier, s.dca_tp_percent, s.dca_sl_percent,
       s.dca_entry_filter, s.dca_reentry_bars, s.dca_rsi_period, s.dca_rsi_max, s.dca_per_leg_sl
     FROM trading_system_members tsm
     JOIN strategies s ON s.id = tsm.strategy_id
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE tsm.system_id = ? AND s.strategy_type = 'dca'
       AND ak.name = ? AND COALESCE(tsm.is_enabled, 1) = 1`,
    [systemId, masterApiKeyName],
  ).catch(() => []);
  if (!Array.isArray(masters) || masters.length === 0) {
    logger.warn(`[materializeClassicDca] no enabled DCA masters on TS #${systemId} (${masterApiKeyName})`);
    return [];
  }

  const clientStrategyIds: number[] = [];

  const clientAkRow = await db.get<{ id: number }>(
    `SELECT id FROM api_keys WHERE name = ?`,
    [clientApiKeyName],
  ).catch(() => null);
  if (!clientAkRow) {
    return [];
  }
  const clientAkId = Number(clientAkRow.id);

  for (const master of masters) {
    const masterId = Number(master.id || 0);
    const clientName = master.name.replace(masterApiKeyName, clientApiKeyName);
    let existing = await db.get<{ id: number }>(
      `SELECT id FROM strategies WHERE api_key_id = ? AND name = ? AND is_archived = 0`,
      [clientAkId, clientName],
    ).catch(() => null);
    if (!existing?.id && masterId > 0) {
      existing = await db.get<{ id: number }>(
        `SELECT id FROM strategies
         WHERE api_key_id = ? AND strategy_type = 'dca' AND is_archived = 0
           AND name LIKE ?`,
        [clientAkId, `%::SID${masterId}%`],
      ).catch(() => null);
    }
    if (!existing?.id) {
      const market = asString(master.base_symbol, '').trim().toUpperCase();
      if (market) {
        existing = await db.get<{ id: number }>(
          `SELECT id FROM strategies
           WHERE api_key_id = ? AND strategy_type = 'dca' AND is_archived = 0
             AND upper(base_symbol) = ?
           ORDER BY id DESC LIMIT 1`,
          [clientAkId, market],
        ).catch(() => null);
      }
    }

    const dcaBasePercent = Math.max(0, asNumber(master.dca_base_amount_percent, 0));
    const dcaParams = [
      master.dca_base_amount_usdt,
      dcaBasePercent,
      master.dca_step_percent,
      master.dca_max_orders,
      master.dca_order_multiplier,
      master.dca_tp_percent,
      master.dca_sl_percent,
      master.dca_entry_filter,
      master.dca_reentry_bars,
      master.dca_rsi_period,
      master.dca_rsi_max,
      master.dca_per_leg_sl ? 1 : 0,
      master.interval,
      master.detection_source,
    ];

    if (existing?.id) {
      await db.run(
        `UPDATE strategies SET
           dca_base_amount_usdt = ?, dca_base_amount_percent = ?, dca_step_percent = ?, dca_max_orders = ?,
           dca_order_multiplier = ?, dca_tp_percent = ?, dca_sl_percent = ?,
           dca_entry_filter = ?, dca_reentry_bars = ?, dca_rsi_period = ?, dca_rsi_max = ?,
           dca_per_leg_sl = ?, interval = ?, detection_source = ?,
           is_active = 1, is_archived = 0, auto_update = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [...dcaParams, existing.id],
      );
      clientStrategyIds.push(Number(existing.id));
      logger.info(`[materializeClassicDca] updated strategy #${existing.id} (${master.base_symbol}) on ${clientApiKeyName}`);
    } else {
      const insertName = clientName !== master.name ? clientName : `DCA ${master.base_symbol}`;
      await db.run(
        `INSERT INTO strategies (
           api_key_id, name, strategy_type, market_mode, market_type,
           base_symbol, quote_symbol, is_active, is_runtime, is_archived, origin,
           auto_update, long_enabled, short_enabled,
           dca_base_amount_usdt, dca_base_amount_percent, dca_step_percent, dca_max_orders,
           dca_order_multiplier, dca_tp_percent, dca_sl_percent,
           dca_entry_filter, dca_reentry_bars, dca_rsi_period, dca_rsi_max, dca_per_leg_sl,
           interval, detection_source, dca_order_type, dca_state,
           created_at, updated_at
         ) VALUES (
           ?, ?, 'dca', 'mono', 'futures', ?, ?, 1, 1, 0, 'saas_materialize_dca',
           1, 1, 0,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'market', 'idle',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )`,
        [
          clientAkId,
          insertName,
          master.base_symbol,
          master.quote_symbol,
          ...dcaParams,
        ],
      );
      const created = await db.get<{ id: number }>('SELECT last_insert_rowid() AS id').catch(() => null);
      if (created?.id) {
        clientStrategyIds.push(Number(created.id));
      }
      logger.info(`[materializeClassicDca] created ${insertName} on ${clientApiKeyName}`);
    }
  }

  return clientStrategyIds;
};

type PropagationLogLevel = 'info' | 'warn' | 'error';

type PropagationJobLogEntry = {
  ts: string;
  level: PropagationLogLevel;
  message: string;
};

let propagationJob: {
  running: boolean;
  systemName: string;
  startedAt: number;
  finishedAt: number | null;
  currentSlug: string;
  attempted: number;
  succeeded: number;
  failed: Array<{ tenantId: number; slug: string; error: string }>;
  logs: PropagationJobLogEntry[];
  result: {
    systemName: string;
    attempted: number;
    succeeded: number;
    failed: Array<{ tenantId: number; slug: string; error: string }>;
  } | null;
  error: string | null;
} = {
  running: false,
  systemName: '',
  startedAt: 0,
  finishedAt: null,
  currentSlug: '',
  attempted: 0,
  succeeded: 0,
  failed: [],
  logs: [],
  result: null,
  error: null,
};

const pushPropagationJobLog = (level: PropagationLogLevel, message: string): void => {
  propagationJob.logs.push({
    ts: new Date().toISOString(),
    level,
    message: asString(message, ''),
  });
  if (propagationJob.logs.length > 400) {
    propagationJob.logs = propagationJob.logs.slice(-400);
  }
};

export const getPropagationJobStatus = () => ({
  running: propagationJob.running,
  systemName: propagationJob.systemName,
  startedAt: propagationJob.startedAt > 0 ? new Date(propagationJob.startedAt).toISOString() : null,
  finishedAt: propagationJob.finishedAt ? new Date(propagationJob.finishedAt).toISOString() : null,
  currentSlug: propagationJob.currentSlug,
  attempted: propagationJob.attempted,
  succeeded: propagationJob.succeeded,
  failed: propagationJob.failed,
  logs: propagationJob.logs,
  result: propagationJob.result,
  error: propagationJob.error,
});

export type AlgofundMaterializationClientAudit = {
  tenantId: number;
  slug: string;
  status: 'ok' | 'partial' | 'error';
  lotPercent: number;
  reinvestPercent: number;
  dcaCount: number;
  tsMemberCount: number;
  issues: string[];
};

/** Per-client runtime readiness for a published algofund system (materialization audit). */
export const getAlgofundMaterializationAudit = async (systemName: string) => {
  const target = asString(systemName, '').trim();
  if (!target) {
    throw new Error('systemName is required');
  }
  const cardCfg = await getCardConfigBySystemName(target);
  const expectedLot = cardCfg.lotPercent > 0 ? cardCfg.lotPercent : 20;
  const expectedReinvest = cardCfg.reinvestPercent > 0 ? cardCfg.reinvestPercent : 100;
  const expectedMembers = cardCfg.expectedMemberCount > 0 ? cardCfg.expectedMemberCount : 34;
  const dcaRequired = cardCfg.dcaLayersRequired !== false;
  const rows = await db.all<Array<{
    tenant_id: number;
    slug: string;
    execution_api_key_name: string;
    published_system_name: string;
  }>>(
    `SELECT ap.tenant_id, t.slug, ap.execution_api_key_name, ap.published_system_name
     FROM algofund_profiles ap
     JOIN tenants t ON t.id = ap.tenant_id
     WHERE TRIM(COALESCE(ap.published_system_name, '')) != ''`,
  ).catch(() => []);

  const clients: AlgofundMaterializationClientAudit[] = [];
  for (const row of rows) {
    const published = asString(row.published_system_name, '').trim();
    if (published !== target && !published.endsWith(target.split('::').pop() || '')) {
      continue;
    }
    const apiKey = asString(row.execution_api_key_name, '').trim();
    if (!apiKey) {
      clients.push({
        tenantId: Number(row.tenant_id),
        slug: asString(row.slug, ''),
        status: 'error',
        lotPercent: 0,
        reinvestPercent: 0,
        dcaCount: 0,
        tsMemberCount: 0,
        issues: ['missing execution_api_key_name'],
      });
      continue;
    }
    const stratRow = await db.get<{ lot: number; reinvest: number }>(
      `SELECT lot_long_percent AS lot, reinvest_percent AS reinvest
       FROM strategies s JOIN api_keys ak ON ak.id = s.api_key_id
       WHERE ak.name = ? AND s.is_active = 1 AND s.is_archived = 0
         AND COALESCE(s.strategy_type, '') NOT IN ('dca', 'dca_futures')
       LIMIT 1`,
      [apiKey],
    ).catch(() => null);
    const dcaCountRow = await db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM strategies s JOIN api_keys ak ON ak.id = s.api_key_id
       WHERE ak.name = ? AND s.strategy_type = 'dca' AND s.is_archived = 0
         AND s.base_symbol IN ('SUIUSDT', 'TRXUSDT')`,
      [apiKey],
    ).catch(() => null);
    const tsMembersRow = await db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM trading_system_members tsm
       JOIN trading_systems ts ON ts.id = tsm.system_id
       JOIN api_keys ak ON ak.id = ts.api_key_id
       WHERE ak.name = ? AND ts.name = 'ALGOFUND::' || ? AND ts.is_active = 1`,
      [apiKey, asString(row.slug, '')],
    ).catch(() => null);
    const lot = Number(stratRow?.lot || 0);
    const reinvest = Number(stratRow?.reinvest || 0);
    const dcaCount = Number(dcaCountRow?.cnt || 0);
    const tsMemberCount = Number(tsMembersRow?.cnt || 0);
    const issues: string[] = [];
    if (Math.abs(lot - expectedLot) > 0.01) issues.push(`lot ${lot}% (expected ${expectedLot}%)`);
    if (Math.abs(reinvest - expectedReinvest) > 0.01) issues.push(`reinvest ${reinvest}% (expected ${expectedReinvest}%)`);
    if (dcaRequired && dcaCount < 2) issues.push(`DCA satellites ${dcaCount}/2`);
    const minMembers = Math.max(1, Math.floor(expectedMembers * 0.5));
    if (tsMemberCount < minMembers) issues.push(`TS members ${tsMemberCount} (expected ≥${expectedMembers})`);
    const status: AlgofundMaterializationClientAudit['status'] = issues.length === 0
      ? 'ok'
      : (issues.every((item) => !item.includes('TS members') && !item.includes('missing')) ? 'partial' : 'error');
    clients.push({
      tenantId: Number(row.tenant_id),
      slug: asString(row.slug, ''),
      status,
      lotPercent: lot,
      reinvestPercent: reinvest,
      dcaCount,
      tsMemberCount,
      issues,
    });
  }
  const okCount = clients.filter((c) => c.status === 'ok').length;
  const partialCount = clients.filter((c) => c.status === 'partial').length;
  const errorCount = clients.filter((c) => c.status === 'error').length;
  const propagation = getPropagationJobStatus();
  let aggregateStatus: 'ok' | 'partial' | 'error' | 'running' = 'ok';
  if (propagation.running && propagation.systemName === target) {
    aggregateStatus = 'running';
  } else if (errorCount > 0) {
    aggregateStatus = 'error';
  } else if (partialCount > 0) {
    aggregateStatus = 'partial';
  }
  return {
    systemName: target,
    totalClients: clients.length,
    okCount,
    partialCount,
    errorCount,
    aggregateStatus,
    expectedLot,
    expectedReinvest,
    expectedMembers,
    dcaRequired,
    clients,
    propagation,
  };
};

export const startPropagationJob = (
  systemName: string,
  masterSystem?: { apiKeyName: string; systemId: number },
) => {
  const name = asString(systemName, '').trim();
  if (!name) {
    throw new Error('systemName is required for propagation job');
  }
  if (propagationJob.running) {
    return getPropagationJobStatus();
  }

  propagationJob = {
    running: true,
    systemName: name,
    startedAt: Date.now(),
    finishedAt: null,
    currentSlug: '',
    attempted: 0,
    succeeded: 0,
    failed: [],
    logs: [{
      ts: new Date().toISOString(),
      level: 'info',
      message: `Старт propagate для ${name}`,
    }],
    result: null,
    error: null,
  };

  void (async () => {
    try {
      const result = await propagatePublishToClients(name, masterSystem);
      propagationJob.result = result;
      propagationJob.attempted = result.attempted;
      propagationJob.succeeded = result.succeeded;
      propagationJob.failed = result.failed;
      pushPropagationJobLog(
        'info',
        `Готово: ${result.succeeded}/${result.attempted} клиентов${result.failed.length > 0 ? `, ошибок: ${result.failed.length}` : ''}`,
      );
    } catch (error) {
      propagationJob.error = asString((error as Error).message, 'Propagation failed');
      pushPropagationJobLog('error', propagationJob.error);
    } finally {
      propagationJob.running = false;
      propagationJob.finishedAt = Date.now();
      propagationJob.currentSlug = '';
    }
  })();

  return getPropagationJobStatus();
};

const propagatePublishToClients = async (systemName: string, masterSystem?: {
  apiKeyName: string;
  systemId: number;
}): Promise<{
  systemName: string;
  attempted: number;
  succeeded: number;
  failed: Array<{ tenantId: number; slug: string; error: string }>;
}> => {
  const rows = await db.all<Array<{ tenant_id: number }>>(
    `SELECT tenant_id FROM algofund_profiles
     WHERE published_system_name = ? AND requested_enabled = 1
     ORDER BY tenant_id`,
    [systemName]
  ).catch(() => []);
  const failed: Array<{ tenantId: number; slug: string; error: string }> = [];
  let succeeded = 0;
  const total = Array.isArray(rows) ? rows.length : 0;
  if (propagationJob.running) {
    propagationJob.attempted = total;
  }
  pushPropagationJobLog('info', `Клиентов в очереди: ${total}`);
  for (const row of Array.isArray(rows) ? rows : []) {
    const tenantId = Number(row.tenant_id);
    if (!Number.isFinite(tenantId) || tenantId <= 0) continue;
    let slug = '';
    try {
      const tenant = await getTenantById(tenantId);
      slug = tenant?.slug || String(tenantId);
      if (propagationJob.running) {
        propagationJob.currentSlug = slug;
      }
      pushPropagationJobLog('info', `[${succeeded + failed.length + 1}/${total}] Materialize ${slug}…`);
      const plan = await getPlanForTenant(tenantId, 'algofund_client');
      const profile = await getAlgofundProfile(tenantId);
      if (!plan || !profile) {
        throw new Error('plan/profile not found');
      }
      // Defensive cleanup against any leaked transaction from a prior failure
      // on the shared sqlite connection.
      await db.exec('ROLLBACK').catch(() => {});
      await materializeAlgofundSystem(tenant, plan, { ...profile, requested_enabled: 1 }, true);
      // Also copy dca_futures members from master TS to this client
      if (masterSystem?.apiKeyName && masterSystem?.systemId) {
        const clientApiKeyName = asString(
          (profile as any).execution_api_key_name || (profile as any).assigned_api_key_name || '',
        );
        if (clientApiKeyName) {
          await materializeDcaFuturesToClient(
            masterSystem.apiKeyName, clientApiKeyName, masterSystem.systemId,
          ).catch((e) => logger.warn(`[propagatePublishToClients] dca_futures copy failed for ${slug}: ${(e as Error)?.message}`));
          await materializeClassicDcaToClient(
            masterSystem.apiKeyName, clientApiKeyName, masterSystem.systemId,
          ).catch((e) => logger.warn(`[propagatePublishToClients] classic dca copy failed for ${slug}: ${(e as Error)?.message}`));
        }
      }
      await db.run(
        `UPDATE algofund_profiles SET actual_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`,
        [tenantId]
      );
      succeeded += 1;
      if (propagationJob.running) {
        propagationJob.succeeded = succeeded;
      }
      pushPropagationJobLog('info', `✓ ${slug} (${succeeded}/${total})`);
    } catch (error) {
      const msg = (error as Error)?.message || String(error);
      logger.warn(`[propagatePublishToClients] tenant=${tenantId} slug=${slug} failed: ${msg}`);
      failed.push({ tenantId, slug, error: msg });
      if (propagationJob.running) {
        propagationJob.failed = [...failed];
      }
      pushPropagationJobLog('error', `✗ ${slug}: ${msg}`);
    }
  }
  return {
    systemName,
    attempted: total,
    succeeded,
    failed,
  };
};

export const publishAdminTradingSystem = async (payload?: {
  offerIds?: string[];
  setKey?: string;
  /**
   * When true, reuse an existing master TS for this setKey (looked up via
   * `master_cards.code` slug match) instead of producing a new
   * `*-<hash>` system. Required for "Сохранить и отправить ТС на витрину"
   * on a card that is already on the storefront.
   */
  editInPlace?: boolean;
  /**
   * When true (only honored together with editInPlace) — after the card
   * metadata is updated, re-materialize the source TS to every connected
   * algofund client.
   */
  propagateToClients?: boolean;
  /**
   * Card-level overrides from the backtest controls. Persisted to
   * `master_cards.metadata_json` so that `routes.ts` materialize path
   * picks them up for every client.
   */
  cardOverrides?: CardMetadataOverrides;
}) => {
  const catalog = loadLatestClientCatalog();
  const offerIds = normalizePublishOfferIds(payload?.offerIds);
  const setKey = asString(payload?.setKey, '').trim();
  const editInPlace = payload?.editInPlace === true;
  const propagateToClients = payload?.propagateToClients === true;

  const existing = editInPlace ? await resolveExistingPublishedTsForSetKey(setKey) : null;

  let sourceSystem: { apiKeyName: string; systemId: number; systemName: string };
  let membersCount = 0;
  let cardUpdate: { changed: boolean; metadata: Record<string, unknown> } | null = null;

  if (existing) {
    // Edit-in-place path: do NOT generate a hash suffix and do NOT touch
    // members. The admin only edits "krutilki" (lot %, maxOpenPositions,
    // riskMul, …); membership changes are out of scope for this round and
    // require an explicit different flag to avoid accidentally yanking
    // open positions on dropped strategies.
    sourceSystem = {
      apiKeyName: existing.apiKeyName,
      systemId: existing.systemId,
      systemName: existing.systemName,
    };
    membersCount = existing.membersCount;
    cardUpdate = await applyCardMetadataOverrides(
      existing.cardId,
      existing.cardMetadata,
      payload?.cardOverrides,
      { apiKeyName: existing.apiKeyName, systemId: existing.systemId },
    );
  } else {
    // Legacy / new-card path: resolve members + suffix as before.
    const members = await resolvePublishDraftMembers(catalog, offerIds, setKey);
    sourceSystem = await ensurePublishedSourceSystem(undefined, {
      draftMembersOverride: members,
      systemNameSuffix: buildPublishSystemSuffix(setKey, offerIds),
    });
    membersCount = members.length;
  }

  const period = buildPeriodInfo(loadLatestSweep());
  const preview = await runTradingSystemBacktest(sourceSystem.apiKeyName, sourceSystem.systemId, {
    bars: SAAS_PREVIEW_BARS,
    warmupBars: SAAS_PREVIEW_WARMUP_BARS,
    skipMissingSymbols: true,
    initialBalance: SAAS_PREVIEW_INITIAL_BALANCE,
    commissionPercent: 0.1,
    slippagePercent: 0.05,
    fundingRatePercent: 0,
  });

  let propagation: ReturnType<typeof getPropagationJobStatus> | Awaited<ReturnType<typeof propagatePublishToClients>> | null = null;
  if (existing && propagateToClients) {
    // Background job: HTTP returns immediately; UI polls /admin/propagation-status.
    propagation = startPropagationJob(sourceSystem.systemName, {
      apiKeyName: sourceSystem.apiKeyName,
      systemId: sourceSystem.systemId,
    });
  }

  return {
    sourceSystem,
    publishMeta: {
      offerIds,
      setKey,
      membersCount,
      systemName: sourceSystem.systemName,
      editInPlace: Boolean(existing),
      cardMetadataChanged: cardUpdate?.changed || false,
      cardMetadata: cardUpdate?.metadata || existing?.cardMetadata || {},
      propagation,
    },
    preview: {
      ...preview,
      period,
    },
    catalog,
  };
};

/**
 * Remove an Algofund TS offer from the storefront.
 * Checks connected clients and optionally disconnects them.
 * Returns the list of affected clients for confirmation UI.
 */
export const removeAlgofundStorefrontSystem = async (payload: {
  systemName: string;
  force?: boolean;
  dryRun?: boolean;
  closePositions?: boolean;
}): Promise<{
  removed: boolean;
  clientsAffected: number;
  affectedTenants: Array<{ id: number; display_name: string }>;
  positionsByApiKey: Array<{ apiKeyName: string; openPositions: number; symbols: string[] }>;
  closeResult?: { requested: number; failed: number };
  warning?: string;
}> => {
  const systemName = asString(payload.systemName, '').trim();
  if (!systemName) {
    throw new Error('systemName is required');
  }

  // Find tenants connected to this TS
  const connectedRows = await db.all(
    `SELECT t.id, t.display_name, COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key_name
     FROM tenants t
     JOIN algofund_profiles ap ON ap.tenant_id = t.id
     WHERE ap.published_system_name = ?`,
    [systemName]
  ) as Array<{ id: number; display_name: string; api_key_name?: string }>;

  const clientCount = connectedRows.length;
  const affectedTenants = connectedRows.map((row) => ({ id: Number(row.id), display_name: asString(row.display_name, `tenant#${row.id}`) }));
  const apiKeys = Array.from(new Set(connectedRows.map((row) => asString(row.api_key_name, '')).filter(Boolean)));
  const positionsByApiKey: Array<{ apiKeyName: string; openPositions: number; symbols: string[] }> = [];

  for (const apiKeyName of apiKeys) {
    try {
      const positions = await getPositions(apiKeyName);
      const open = (Array.isArray(positions) ? positions : []).filter((item: any) => {
        const size = Math.abs(asNumber(item?.size, 0));
        return Number.isFinite(size) && size > 0;
      });
      positionsByApiKey.push({
        apiKeyName,
        openPositions: open.length,
        symbols: open.map((item: any) => asString(item?.symbol, '')).filter(Boolean).slice(0, 20),
      });
    } catch (error) {
      logger.warn(`positions dry-run failed for ${apiKeyName}: ${(error as Error).message}`);
      positionsByApiKey.push({
        apiKeyName,
        openPositions: -1,
        symbols: [],
      });
    }
  }

  if (payload.dryRun) {
    return {
      removed: false,
      clientsAffected: clientCount,
      affectedTenants,
      positionsByApiKey,
      warning: `Dry-run: TS "${systemName}" связана с ${clientCount} клиентами`,
    };
  }

  if (clientCount > 0 && !payload.force) {
    return {
      removed: false,
      clientsAffected: clientCount,
      affectedTenants,
      positionsByApiKey,
      warning: `TS "${systemName}" подключена к ${clientCount} клиентам. Подтвердите удаление и отключение клиентов.`,
    };
  }

  let closeResult: { requested: number; failed: number } | undefined;

  if (clientCount > 0 && payload.closePositions) {
    const tenantIds = affectedTenants.map((item) => Number(item.id)).filter((item) => item > 0);
    const batch = await requestAlgofundBatchAction(
      tenantIds,
      'stop',
      `Storefront remove ${systemName}`,
      {},
      { directExecute: true }
    );
    closeResult = {
      requested: Number((batch as any)?.createdCount || 0),
      failed: Number((batch as any)?.failedCount || 0),
    };
  }

  // Disconnect clients if any
  if (clientCount > 0) {
    await db.run(
      `UPDATE algofund_profiles
       SET published_system_name = NULL,
           requested_enabled = 0,
           actual_enabled = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE published_system_name = ?`,
      [systemName]
    );

    // Log the action
    for (const tenant of affectedTenants) {
      await db.run(
        `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
         VALUES (?, 'admin', 'algofund_ts_removed', ?, CURRENT_TIMESTAMP)`,
        [tenant.id, JSON.stringify({ systemName, reason: 'admin_remove_storefront' })]
      );
    }
  }

  // If this is the only (or last) published system, clear the tsBacktestSnapshot
  const remainingRows = await db.all(
    `SELECT COUNT(*) as cnt FROM algofund_profiles WHERE published_system_name IS NOT NULL AND published_system_name != ''`
  ) as Array<{ cnt: number }>;
  const remainingCount = Number(remainingRows[0]?.cnt || 0);

  if (remainingCount === 0) {
    // Clear snapshot so storefront shows empty state
    await setRuntimeFlag('offer.store.ts_backtest_snapshot', 'null');
  }

  const currentTsSnapshotMap = await getTsBacktestSnapshots();
  const nextTsSnapshotMap = Object.fromEntries(
    Object.entries(currentTsSnapshotMap).filter(([key, snapshot]) => {
      const snapshotKey = asString(key, '').trim();
      const snapshotSystemName = asString(snapshot?.systemName, '').trim();
      return snapshotKey !== systemName && snapshotSystemName !== systemName;
    })
  );
  await setRuntimeFlag('offer.store.ts_backtest_snapshots', JSON.stringify(nextTsSnapshotMap));

  const currentAlgofundPublished = safeJsonParse<string[]>(
    await getRuntimeFlag(OFFER_STORE_ALGOFUND_PUBLISHED_SYSTEMS_KEY, '[]'),
    [],
  );
  const nextAlgofundPublished = Array.from(new Set(
    currentAlgofundPublished
      .map((name) => asString(name, '').trim())
      .filter((name) => name && name !== systemName)
  ));
  await setRuntimeFlag(OFFER_STORE_ALGOFUND_PUBLISHED_SYSTEMS_KEY, JSON.stringify(nextAlgofundPublished));

  // Storefront is a visibility flag. Keep TS card in Offer/TS lists, only disable vitrine visibility.
  await db.run(
    `UPDATE algofund_active_systems
     SET is_enabled = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE system_name = ?`,
    [systemName]
  );

  // NOTE: TS stays ACTIVE in Offer/TS tables - only removed from vitrine.
  // This is safe removal: clients are disconnected, TS remains available for future reconnection or separate hard-delete.
  // If true hard-delete is needed later, it should be a separate admin action with explicit confirmation.

  return {
    removed: true,
    clientsAffected: clientCount,
    affectedTenants,
    positionsByApiKey,
    ...(closeResult ? { closeResult } : {}),
  };
};

export const getCopytradingState = async (tenantId: number) => {
  await ensureSaasSeedData();
  const tenant = await getTenantById(tenantId);
  if (tenant.product_mode !== 'copytrading_client') {
    throw new Error('Tenant is not a copytrading client');
  }
  const plan = await getPlanForTenant(tenantId);
  const profile = await getCopytradingProfile(tenantId);
  if (!profile) {
    throw new Error('Copytrading profile not found');
  }
  const tenants = safeJsonParse<Array<Record<string, unknown>>>(profile.tenants_json, []).slice(0, 5);
  return {
    tenant,
    plan,
    profile: {
      ...profile,
      tenants,
      engine: {
        type: 'simple_copy_engine',
        algorithm: profile.copy_algorithm,
        precision: profile.copy_precision,
      },
      copy_ratio: asNumber(profile.copy_ratio, 1),
    },
  };
};

export const updateCopytradingState = async (
  tenantId: number,
  payload: {
    masterApiKeyName?: string;
    masterName?: string;
    masterTags?: string;
    tenants?: Array<Record<string, unknown>>;
    copyAlgorithm?: string;
    copyPrecision?: string;
    copyRatio?: number;
    copyEnabled?: boolean;
  }
) => {
  const profile = await getCopytradingProfile(tenantId);
  if (!profile) {
    throw new Error('Copytrading profile not found');
  }

  const nextMasterApiKeyName = asString(payload.masterApiKeyName, profile.master_api_key_name);
  const nextMasterName = asString(payload.masterName, profile.master_name);
  const nextMasterTags = asString(payload.masterTags, profile.master_tags);
  const nextTenantsJson = payload.tenants !== undefined
    ? JSON.stringify(payload.tenants.slice(0, 5))
    : profile.tenants_json;
  const nextCopyAlgorithm = asString(payload.copyAlgorithm, profile.copy_algorithm);
  const nextCopyPrecision = asString(payload.copyPrecision, profile.copy_precision);
  const nextCopyRatio = clampNumber(asNumber(payload.copyRatio, asNumber(profile.copy_ratio, 1)), 0.01, 100);
  const nextCopyEnabled = payload.copyEnabled !== undefined
    ? (payload.copyEnabled ? 1 : 0)
    : Number(profile.copy_enabled || 0);

  await db.run(
    `UPDATE copytrading_profiles
     SET master_api_key_name = ?, master_name = ?, master_tags = ?,
         tenants_json = ?, copy_algorithm = ?, copy_precision = ?, copy_ratio = ?,
         copy_enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [nextMasterApiKeyName, nextMasterName, nextMasterTags,
     nextTenantsJson, nextCopyAlgorithm, nextCopyPrecision, nextCopyRatio,
     nextCopyEnabled, tenantId]
  );

  if (payload.masterApiKeyName !== undefined) {
    await db.run(
      `UPDATE tenants SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextMasterApiKeyName, tenantId]
    );
  }

  return getCopytradingState(tenantId);
};

export const stopCopytradingBaseline = async (tenantId: number) => {
  await db.run(
    `UPDATE copytrading_profiles
     SET copy_enabled = 0, last_master_positions_json = '[]', updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [tenantId]
  );
  return getCopytradingState(tenantId);
};

const ensureCopytradingSessionsTable = async (): Promise<void> => {
  await db.run(`
    CREATE TABLE IF NOT EXISTS copytrading_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      symbol TEXT NOT NULL,
      master_side TEXT NOT NULL,
      market_type TEXT DEFAULT 'swap',
      entry_price REAL,
      exit_price REAL,
      master_qty REAL DEFAULT 0,
      follower_results_json TEXT DEFAULT '{}',
      avg_delay_ms REAL DEFAULT 0,
      avg_match_pct REAL DEFAULT 0,
      followers_ok INTEGER DEFAULT 0,
      followers_total INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      error TEXT,
      log_json TEXT DEFAULT '[]',
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      FOREIGN KEY (profile_id) REFERENCES copytrading_profiles(id)
    )
  `).catch(() => {});
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_copytrading_sessions_profile
      ON copytrading_sessions (profile_id, started_at DESC)
  `).catch(() => {});
  // Migrations for existing table
  await db.run(`ALTER TABLE copytrading_sessions ADD COLUMN master_qty REAL DEFAULT 0`).catch(() => {});
  await db.run(`ALTER TABLE copytrading_sessions ADD COLUMN avg_delay_ms REAL DEFAULT 0`).catch(() => {});
  await db.run(`ALTER TABLE copytrading_sessions ADD COLUMN avg_match_pct REAL DEFAULT 0`).catch(() => {});
  await db.run(`ALTER TABLE copytrading_sessions ADD COLUMN followers_ok INTEGER DEFAULT 0`).catch(() => {});
  await db.run(`ALTER TABLE copytrading_sessions ADD COLUMN followers_total INTEGER DEFAULT 0`).catch(() => {});
};

export const executeCopytradingSession = async (
  tenantId: number,
  payload: {
    marketType?: 'spot' | 'swap';
    symbol?: string; // optional: filter sync to a specific symbol only
  } = {}
) => {
  await ensureCopytradingSessionsTable();

  const profile = await getCopytradingProfile(tenantId);
  if (!profile) throw new Error('Copytrading profile not found');
  if (!Number(profile.copy_enabled)) throw new Error('Copytrading is not enabled for this profile');

  const followers = safeJsonParse<Array<Record<string, unknown>>>(profile.tenants_json, []);
  if (followers.length === 0) throw new Error('No follower accounts configured');

  const marketType = payload.marketType === 'spot' ? 'spot' : 'swap';
  const isSpot = marketType === 'spot';
  const copyRatio = clampNumber(asNumber(profile.copy_ratio, 1), 0.01, 100);
  const normKey = (s: unknown) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const log: string[] = [];
  const tsStr = () => new Date().toISOString().slice(11, 23);
  const addLog = (msg: string) => {
    log.push(`[${tsStr()}] ${msg}`);
    logger.info(`[Copytrading Mirror] ${msg}`);
  };

  const sessionResult = await db.run(
    `INSERT INTO copytrading_sessions (profile_id, status, symbol, master_side, market_type, log_json, started_at)
     VALUES (?, 'running', 'MULTI', 'mirror', ?, '[]', CURRENT_TIMESTAMP)`,
    [profile.id, marketType]
  );
  const sessionId = (sessionResult as any)?.lastID;
  addLog(`Sync session #${sessionId}: mirror mode, marketType=${marketType}, copyRatio=${copyRatio}`);

  const saveLog = async () => {
    await db.run(`UPDATE copytrading_sessions SET log_json = ? WHERE id = ?`, [JSON.stringify(log), sessionId]);
  };

  try {
    const masterKeyName = asString(profile.master_api_key_name, '');
    if (!masterKeyName) throw new Error('Master API key not configured');

    await ensureExchangeClientInitialized(masterKeyName);

    for (const f of followers) {
      const keyName = asString(f.apiKeyName, '');
      if (keyName) await ensureExchangeClientInitialized(keyName);
    }

    const { getBalances, placeOrder, closePosition, getPositions, applySymbolRiskSettings, getInstrumentInfo } =
      await import('../bot/exchange');

    // === READ master positions (READ-ONLY — no trading on master key) ===
    addLog(`Reading master positions from ${masterKeyName}...`);
    let masterPositions: any[];
    try {
      masterPositions = await getPositions(masterKeyName);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('700007') || msg.includes('No permission to access the endpoint')) {
        throw new Error(
          `MEXC API key "${masterKeyName}" lacks Contract Read permission. Enable it in MEXC → API Management.`
        );
      }
      throw err;
    }

    // Filter by symbol if requested
    const masterPosFiltered = payload.symbol
      ? masterPositions.filter((p: any) => normKey(p.symbol) === normKey(payload.symbol))
      : masterPositions;

    addLog(`Master has ${masterPosFiltered.length} open position(s)`);

    // Load last known master positions from DB
    const lastPositions = safeJsonParse<Array<Record<string, unknown>>>(
      asString((profile as any).last_master_positions_json, '[]'),
      []
    );

    const posKey = (p: any) => `${normKey(p.symbol)}_${String(p.side).toLowerCase()}`;
    const currentPosMap = new Map<string, any>(masterPosFiltered.map((p: any) => [posKey(p), p]));
    const lastPosMap = new Map<string, any>(lastPositions.map((p: any) => [posKey(p), p]));

    // NEW positions: in current master but not in last snapshot
    const newPositions = masterPosFiltered.filter((p: any) => !lastPosMap.has(posKey(p)));
    // CLOSED positions: in last snapshot but no longer in master
    const closedPositions = lastPositions.filter((p: any) => !currentPosMap.has(posKey(p)));

    addLog(`Delta: ${newPositions.length} new, ${closedPositions.length} closed`);

    // Get master equity for proportional sizing
    const masterBalances = await getBalances(masterKeyName);
    const masterUsdtBal = (masterBalances || []).find((b: any) => String(b.coin).toUpperCase() === 'USDT');
    const masterEquity = asNumber(masterUsdtBal?.walletBalance, 0);
    addLog(`Master USDT equity: ${masterEquity.toFixed(2)}`);

    // Instrument info cache (for futures sizing)
    const instCache: Record<string, { minQty: number; qtyStep: number; contractSize: number }> = {};
    const getInst = async (sym: string) => {
      if (instCache[sym]) return instCache[sym];
      let minQty = 1, qtyStep = 1, contractSize = 1;
      if (!isSpot) {
        try {
          const info = await getInstrumentInfo(masterKeyName, sym);
          const lf = (info as any)?.lotSizeFilter;
          const rawMin = Number(lf?.minOrderQty ?? 0);
          const rawStep = Number(lf?.qtyStep ?? 0);
          const rawCS = Number((info as any)?.contractSize ?? 1);
          if (Number.isFinite(rawMin) && rawMin > 0) minQty = rawMin;
          if (Number.isFinite(rawStep) && rawStep > 0) qtyStep = rawStep;
          if (Number.isFinite(rawCS) && rawCS > 0) contractSize = rawCS;
        } catch { /* non-critical, use defaults */ }
      }
      instCache[sym] = { minQty, qtyStep, contractSize };
      return instCache[sym];
    };

    const roundToStep = (val: number, step: number): number => {
      if (step <= 0) return val;
      const result = Math.floor(val / step) * step;
      const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
      return Number(result.toFixed(decimals));
    };
    const enforceMin = (val: number, min: number, step: number): number => {
      const r = roundToStep(val, step);
      return r < min ? min : r;
    };

    const followerResults: Record<string, any> = {};
    let followersOk = 0;
    let followersTotal = 0;

    // === OPEN new positions on followers ===
    for (const masterPos of newPositions) {
      const sym = asString(masterPos.symbol, '');
      const side = asString(masterPos.side, 'Buy') as 'Buy' | 'Sell';
      const masterContracts = asNumber((masterPos as any).size, 0);
      const leverage = clampNumber(asNumber((masterPos as any).leverage, 5), 1, 125);
      const { minQty, qtyStep } = await getInst(sym);

      addLog(`NEW: ${sym} ${side} x${masterContracts} contracts (lev ${leverage}x)`);

      for (const f of followers) {
        const keyName = asString(f.apiKeyName, '');
        const displayName = asString(f.displayName, keyName);
        if (!keyName) continue;

        followersTotal++;
        const resultKey = `open:${sym}:${side}:${displayName}`;
        const startAt = Date.now();

        try {
          // Set leverage on follower (non-critical)
          if (!isSpot) {
            try {
              const followerLev = clampNumber(Math.floor(asNumber(f.leverage, leverage)), 1, 125);
              await applySymbolRiskSettings(keyName, sym, 'cross', followerLev);
            } catch { /* non-critical */ }
          }

          // Get follower equity for proportional sizing
          const folBalances = await getBalances(keyName);
          const folUsdtBal = (folBalances || []).find((b: any) => String(b.coin).toUpperCase() === 'USDT');
          const followerEquity = asNumber(folUsdtBal?.walletBalance, 0);

          // Scale contracts: master qty × (follower equity / master equity) × copyRatio
          const equityRatio = masterEquity > 0 ? followerEquity / masterEquity : 1;
          const rawQty = masterContracts * equityRatio * copyRatio;
          const followerContracts = isSpot
            ? Number(rawQty.toFixed(6))
            : enforceMin(rawQty, minQty, qtyStep);

          if (followerContracts <= 0) {
            addLog(`✗ ${displayName}: qty too small (equity=${followerEquity.toFixed(2)})`);
            followerResults[resultKey] = { status: 'skipped', error: 'qty too small' };
            continue;
          }

          // WEEX followers: skip pairs outside apiTradingSymbols (same -1058 trap as SaaS materialize).
          const followerExchange = String(getExchangeForApiKey(keyName) || '').toLowerCase();
          if (followerExchange === 'weex') {
            const tradable = await isWeexApiTradableSymbol(sym);
            if (!tradable) {
              addLog(`✗ ${displayName}: ${sym} not API-tradable on WEEX (apiTradingSymbols)`);
              followerResults[resultKey] = { status: 'skipped', error: 'weex apiTradingSymbols deny' };
              continue;
            }
          }

          addLog(`${displayName}: ${side} ${followerContracts} ${sym} (equityRatio=${equityRatio.toFixed(3)}, copyRatio=${copyRatio})`);
          await placeOrder(keyName, sym, side, String(followerContracts), undefined, { marketType });

          const delayMs = Date.now() - startAt;
          addLog(`✓ ${displayName} opened in ${delayMs}ms`);
          followerResults[resultKey] = { status: 'ok', qty: followerContracts, delayMs };
          followersOk++;
        } catch (err: any) {
          addLog(`✗ ${displayName} FAILED: ${err.message}`);
          followerResults[resultKey] = { status: 'failed', error: err.message };
        }
      }
    }

    // === CLOSE removed positions on followers ===
    for (const closedPos of closedPositions) {
      const sym = asString(closedPos.symbol, '');
      const side = asString(closedPos.side, 'Buy') as 'Buy' | 'Sell';

      addLog(`CLOSED by master: ${sym} ${side} → closing followers`);

      for (const f of followers) {
        const keyName = asString(f.apiKeyName, '');
        const displayName = asString(f.displayName, keyName);
        if (!keyName) continue;

        followersTotal++;
        const resultKey = `close:${sym}:${side}:${displayName}`;

        try {
          // Read follower's actual open position to get qty
          const folPositions = await getPositions(keyName, sym);
          const folPos = folPositions.find(
            (p: any) =>
              normKey(p.symbol) === normKey(sym) &&
              String(p.side).toLowerCase() === String(side).toLowerCase()
          );

          if (!folPos || asNumber((folPos as any).size, 0) <= 0) {
            addLog(`${displayName}: no matching ${sym} ${side} position, skipping`);
            followerResults[resultKey] = { status: 'skipped', error: 'position not found' };
            continue;
          }

          const qty = asNumber((folPos as any).size, 0);
          await closePosition(keyName, sym, String(qty), side, { marketType });
          addLog(`✓ ${displayName}: closed ${qty} ${sym} ${side}`);
          followerResults[resultKey] = { status: 'ok', qty };
          followersOk++;
        } catch (err: any) {
          addLog(`✗ ${displayName} close FAILED: ${err.message}`);
          followerResults[resultKey] = { status: 'failed', error: err.message };
        }
      }
    }

    // === Persist current master positions as new baseline ===
    await db.run(
      `UPDATE copytrading_profiles SET last_master_positions_json = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`,
      [JSON.stringify(masterPosFiltered), tenantId]
    );

    const summary = {
      masterPositions: masterPosFiltered.length,
      newPositions: newPositions.length,
      closedPositions: closedPositions.length,
      followersOk,
      followersTotal,
    };
    addLog(
      `Done: masterPos=${summary.masterPositions}, opened=${summary.newPositions}, closed=${summary.closedPositions}, followers=${followersOk}/${followersTotal}`
    );
    await saveLog();

    await db.run(
      `UPDATE copytrading_sessions
       SET status = 'open', follower_results_json = ?, followers_ok = ?, followers_total = ?, log_json = ?
       WHERE id = ?`,
      [JSON.stringify(followerResults), followersOk, followersTotal, JSON.stringify(log), sessionId]
    );

    return {
      sessionId,
      status: 'synced',
      marketType,
      summary,
      masterPositions: masterPosFiltered,
      followerResults,
      log,
    };
  } catch (err: any) {
    addLog(`✗ FATAL: ${err.message}`);
    await db.run(
      `UPDATE copytrading_sessions SET status = 'error', error = ?, log_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [String(err.message || err).slice(0, 500), JSON.stringify(log), sessionId]
    );
    throw err;
  }
};

export const closeCopytradingSession = async (tenantId: number, sessionId: number) => {
  await ensureCopytradingSessionsTable();

  const profile = await getCopytradingProfile(tenantId);
  if (!profile) throw new Error('Copytrading profile not found');

  const session = await db.get(
    `SELECT * FROM copytrading_sessions WHERE id = ? AND profile_id = ?`,
    [sessionId, profile.id]
  ) as Record<string, unknown> | null;
  if (!session) throw new Error('Session not found');
  const sessionStatus = asString(session.status, '');
  if (!['open', 'running', 'error'].includes(sessionStatus)) {
    throw new Error(`Session status "${sessionStatus}" cannot be closed`);
  }

  const symbol = asString(session.symbol, '');
  const masterSide = asString(session.master_side, 'long') as 'long' | 'short';
  const marketType = asString(session.market_type, 'swap') as 'spot' | 'swap';
  const isSpot = marketType === 'spot';
  const masterKeyName = asString(profile.master_api_key_name, '');
  const followers = safeJsonParse<Array<Record<string, unknown>>>(profile.tenants_json, []);

  const log: string[] = safeJsonParse<string[]>(asString(session.log_json, '[]'), []);
  const addLog = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    log.push(`[${ts}] ${msg}`);
    logger.info(`[Copytrading] ${msg}`);
  };

  addLog(`Closing session #${sessionId}: ${symbol} [${marketType}]`);

  const { closePosition, getPositions: getPos, getBalances } = await import('../bot/exchange');
  const normSym = (v: string) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const targetKey = normSym(symbol);

  // Close master position
  let masterClosed = false;
  try {
    if (isSpot) {
      // Spot: sell the base asset balance
      const masterBalances = await getBalances(masterKeyName);
      const baseCoin = symbol.replace(/USDT$/i, '').replace(/USDC$/i, '').toUpperCase();
      const baseBal = (masterBalances || []).find((b: any) => String(b.coin).toUpperCase() === baseCoin);
      const baseQty = asNumber(baseBal?.walletBalance, 0);
      addLog(`Master spot balance: ${baseCoin}=${baseQty}`);
      if (baseQty > 0) {
        await closePosition(masterKeyName, symbol, String(baseQty), 'Buy', { marketType: 'spot' });
        addLog(`✓ Master spot position closed (sold ${baseQty} ${baseCoin})`);
        masterClosed = true;
      } else {
        addLog(`⚠ Master: no ${baseCoin} balance to close`);
      }
    } else {
      const masterPositions = await getPos(masterKeyName, symbol);
      addLog(`Master positions found: ${(masterPositions || []).length}`);
      const masterPos = (masterPositions || []).find((p: any) => normSym(p.symbol) === targetKey);
      if (masterPos && asNumber(masterPos.size, 0) > 0) {
        const posSide: 'Buy' | 'Sell' = String(masterPos.side).includes('uy') ? 'Buy' : 'Sell';
        await closePosition(masterKeyName, symbol, String(masterPos.size), posSide);
        addLog(`✓ Master futures position closed`);
        masterClosed = true;
      } else {
        addLog(`⚠ Master: no open futures position for ${symbol}`);
      }
    }
  } catch (err: any) {
    addLog(`✗ Master close failed: ${err.message}`);
  }

  // Close follower positions
  const followerResults: Record<string, string> = {};
  for (const f of followers) {
    const keyName = asString(f.apiKeyName, '');
    const displayName = asString(f.displayName, keyName);
    if (!keyName) continue;

    try {
      if (isSpot) {
        const followerBalances = await getBalances(keyName);
        const baseCoin = symbol.replace(/USDT$/i, '').replace(/USDC$/i, '').toUpperCase();
        const baseBal = (followerBalances || []).find((b: any) => String(b.coin).toUpperCase() === baseCoin);
        const baseQty = asNumber(baseBal?.walletBalance, 0);
        if (baseQty > 0) {
          await closePosition(keyName, symbol, String(baseQty), 'Buy', { marketType: 'spot' });
          addLog(`✓ Follower ${displayName} spot closed (sold ${baseQty} ${baseCoin})`);
          followerResults[displayName] = 'closed';
        } else {
          addLog(`⚠ Follower ${displayName}: no spot balance`);
          followerResults[displayName] = 'no_balance';
        }
      } else {
        const followerPositions = await getPos(keyName, symbol);
        const followerPos = (followerPositions || []).find((p: any) => normSym(p.symbol) === targetKey);
        if (followerPos && asNumber(followerPos.size, 0) > 0) {
          const posSide: 'Buy' | 'Sell' = String(followerPos.side).includes('uy') ? 'Buy' : 'Sell';
          await closePosition(keyName, symbol, String(followerPos.size), posSide);
          addLog(`✓ Follower ${displayName} futures closed`);
          followerResults[displayName] = 'closed';
        } else {
          addLog(`⚠ Follower ${displayName}: no open position`);
          followerResults[displayName] = 'no_position';
        }
      }
    } catch (err: any) {
      addLog(`✗ Follower ${displayName} close failed: ${err.message}`);
      followerResults[displayName] = `error: ${err.message}`;
    }
  }

  // Get exit price
  let exitPrice = 0;
  try {
    const { getMarketData: getMD } = await import('../bot/exchange');
    const md = await getMD(masterKeyName, symbol, '1m', 1);
    exitPrice = asNumber((md?.[0] as any)?.[4], 0);
  } catch { /* non-critical */ }

  const startTime = new Date(asString(session.started_at, '')).getTime();
  const durationMs = Date.now() - (Number.isFinite(startTime) ? startTime : Date.now());

  addLog(`Session #${sessionId} closed. masterClosed=${masterClosed} followers=${JSON.stringify(followerResults)}`);

  await db.run(
    `UPDATE copytrading_sessions
     SET status = 'closed', exit_price = ?, follower_results_json = ?,
         duration_ms = ?, log_json = ?, finished_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [exitPrice, JSON.stringify(followerResults), durationMs, JSON.stringify(log), sessionId]
  );

  return { sessionId, status: 'closed', exitPrice, masterClosed, followerResults, durationMs, log };
};

export const getCopytradingSessions = async (tenantId: number, limit = 50) => {
  await ensureCopytradingSessionsTable();
  const profile = await getCopytradingProfile(tenantId);
  if (!profile) throw new Error('Copytrading profile not found');
  const sessions = (await db.all(
    `SELECT * FROM copytrading_sessions WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?`,
    [profile.id, Math.min(limit, 200)]
  ) || []) as Array<Record<string, unknown>>;
  return sessions.map((s) => ({
    ...s,
    followerResults: safeJsonParse<Record<string, unknown>>(asString(s.follower_results_json, '{}'), {}),
    log: safeJsonParse<string[]>(asString(s.log_json, '[]'), []),
  }));
};

export const getCopytradingStatus = async (tenantId: number) => {
  await ensureCopytradingSessionsTable();
  const profile = await getCopytradingProfile(tenantId);
  if (!profile) throw new Error('Copytrading profile not found');
  const active = (await db.all(
    `SELECT id, symbol, master_side, market_type, status, entry_price, master_qty,
            avg_delay_ms, avg_match_pct, followers_ok, followers_total, started_at
     FROM copytrading_sessions
     WHERE profile_id = ? AND status IN ('open', 'running')
     ORDER BY started_at DESC`,
    [profile.id]
  ) || []) as Array<Record<string, unknown>>;
  return {
    isActive: active.length > 0,
    activeSessions: active.length,
    sessions: active,
  };
};

export const getCopytradingReport = async (tenantId: number) => {
  await ensureCopytradingSessionsTable();
  const profile = await getCopytradingProfile(tenantId);
  if (!profile) throw new Error('Copytrading profile not found');

  const sessions = (await db.all(
    `SELECT symbol, market_type, status, entry_price, exit_price, master_qty,
            avg_delay_ms, avg_match_pct, followers_ok, followers_total,
            total_pnl, duration_ms, started_at, finished_at
     FROM copytrading_sessions
     WHERE profile_id = ?
     ORDER BY started_at DESC`,
    [profile.id]
  ) || []) as Array<Record<string, unknown>>;

  const total = sessions.length;
  const open = sessions.filter((s) => s.status === 'open' || s.status === 'running').length;
  const closed = sessions.filter((s) => s.status === 'closed').length;
  const errored = sessions.filter((s) => s.status === 'error').length;

  const withMatch = sessions.filter((s) => asNumber(s.avg_match_pct, 0) > 0);
  const avgMatchPct = withMatch.length > 0
    ? withMatch.reduce((acc, s) => acc + asNumber(s.avg_match_pct, 0), 0) / withMatch.length
    : 0;

  const withDelay = sessions.filter((s) => asNumber(s.avg_delay_ms, 0) > 0);
  const avgDelayMs = withDelay.length > 0
    ? withDelay.reduce((acc, s) => acc + asNumber(s.avg_delay_ms, 0), 0) / withDelay.length
    : 0;

  const totalFollowers = sessions.reduce((acc, s) => acc + asNumber(s.followers_total, 0), 0);
  const okFollowers = sessions.reduce((acc, s) => acc + asNumber(s.followers_ok, 0), 0);
  const successRate = totalFollowers > 0 ? (okFollowers / totalFollowers) * 100 : 0;

  // Per-symbol breakdown
  const bySymbol: Record<string, { count: number; avgMatch: number; avgDelay: number }> = {};
  for (const s of sessions) {
    const sym = asString(s.symbol, '?');
    if (!bySymbol[sym]) bySymbol[sym] = { count: 0, avgMatch: 0, avgDelay: 0 };
    bySymbol[sym].count++;
    bySymbol[sym].avgMatch += asNumber(s.avg_match_pct, 0);
    bySymbol[sym].avgDelay += asNumber(s.avg_delay_ms, 0);
  }
  for (const sym of Object.keys(bySymbol)) {
    const n = bySymbol[sym].count;
    bySymbol[sym].avgMatch = Number((bySymbol[sym].avgMatch / n).toFixed(1));
    bySymbol[sym].avgDelay = Math.round(bySymbol[sym].avgDelay / n);
  }

  return {
    total, open, closed, errored,
    avgMatchPct: Number(avgMatchPct.toFixed(1)),
    avgDelayMs: Math.round(avgDelayMs),
    totalFollowers, okFollowers,
    successRate: Number(successRate.toFixed(1)),
    bySymbol,
  };
};

export const seedDemoSaasData = async () => {
  await ensureSaasSeedData();
  return getSaasAdminSummary();
};

// ─── Multi-TS per Algofund client ────────────────────────────────────────────

type AlgofundActiveSystem = {
  id: number;
  profileId: number;
  systemName: string;
  weight: number;
  isEnabled: boolean;
  assignedBy: 'admin' | 'client';
  createdAt: string;
};

type ResolvedAlgofundSystem = {
  systemId: number;
  systemName: string;
  apiKeyId: number;
  apiKeyName: string;
  isActive: boolean;
};

const resolveAlgofundProfileId = async (profileOrTenantId: number): Promise<number> => {
  const direct = await db.get(
    `SELECT id FROM algofund_profiles WHERE id = ?`,
    [profileOrTenantId]
  ) as { id?: number } | undefined;
  if (Number(direct?.id || 0) > 0) {
    return Number(direct?.id || 0);
  }

  const byTenant = await db.get(
    `SELECT id FROM algofund_profiles WHERE tenant_id = ?`,
    [profileOrTenantId]
  ) as { id?: number } | undefined;
  if (Number(byTenant?.id || 0) > 0) {
    return Number(byTenant?.id || 0);
  }

  throw new Error(`Algofund profile not found for id/tenantId=${profileOrTenantId}`);
};

const resolveAlgofundSystemTargets = async (options: {
  tenantId?: number;
  systemName?: string;
}): Promise<ResolvedAlgofundSystem[]> => {
  const requestedSystemName = asString(options.systemName, '').trim();
  if (requestedSystemName) {
    const row = await db.get(
      `SELECT ts.id AS system_id, ts.name AS system_name, ts.api_key_id, ak.name AS api_key_name, COALESCE(ts.is_active, 0) AS is_active
       FROM trading_systems ts
       JOIN api_keys ak ON ak.id = ts.api_key_id
       WHERE ts.name = ?
       ORDER BY ts.id DESC
       LIMIT 1`,
      [requestedSystemName]
    ) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`Trading system not found: ${requestedSystemName}`);
    }

    return [{
      systemId: asNumber(row.system_id, 0),
      systemName: asString(row.system_name, ''),
      apiKeyId: asNumber(row.api_key_id, 0),
      apiKeyName: asString(row.api_key_name, ''),
      isActive: asNumber(row.is_active, 0) === 1,
    }].filter((item) => item.systemId > 0 && item.apiKeyId > 0 && item.apiKeyName);
  }

  const tenantId = asNumber(options.tenantId, 0);
  if (tenantId <= 0) {
    throw new Error('tenantId or systemName is required');
  }

  const profile = await getAlgofundProfile(tenantId);
  if (!profile) {
    throw new Error(`Algofund profile not found for tenant ${tenantId}`);
  }

  const rows = await db.all(
    `SELECT ts.id AS system_id, ts.name AS system_name, ts.api_key_id, ak.name AS api_key_name, COALESCE(ts.is_active, 0) AS is_active
     FROM trading_systems ts
     JOIN api_keys ak ON ak.id = ts.api_key_id
     WHERE ts.name IN (
       SELECT DISTINCT system_name
       FROM (
         SELECT COALESCE(ap.published_system_name, '') AS system_name
         FROM algofund_profiles ap
         WHERE ap.tenant_id = ?
         UNION ALL
         SELECT COALESCE(aas.system_name, '') AS system_name
         FROM algofund_active_systems aas
         WHERE aas.profile_id = ? AND COALESCE(aas.is_enabled, 1) = 1
       ) src
       WHERE TRIM(system_name) != ''
     )
     ORDER BY ts.id DESC`,
    [tenantId, profile.id]
  ) as Array<Record<string, unknown>>;

  const out = (Array.isArray(rows) ? rows : []).map((row) => ({
    systemId: asNumber(row.system_id, 0),
    systemName: asString(row.system_name, ''),
    apiKeyId: asNumber(row.api_key_id, 0),
    apiKeyName: asString(row.api_key_name, ''),
    isActive: asNumber(row.is_active, 0) === 1,
  })).filter((item) => item.systemId > 0 && item.apiKeyId > 0 && item.apiKeyName);

  if (out.length > 0) {
    return out;
  }

  const fallback = await db.get(
    `SELECT ts.id AS system_id, ts.name AS system_name, ts.api_key_id, ak.name AS api_key_name, COALESCE(ts.is_active, 0) AS is_active
     FROM trading_systems ts
     JOIN api_keys ak ON ak.id = ts.api_key_id
     WHERE ts.id = (
       SELECT id FROM trading_systems
       WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ? LIMIT 1)
       ORDER BY is_active DESC, id DESC
       LIMIT 1
     )`,
    [asString(profile.execution_api_key_name || profile.assigned_api_key_name, '')]
  ) as Record<string, unknown> | undefined;

  if (!fallback) {
    throw new Error(`No linked trading systems for tenant ${tenantId}`);
  }

  return [{
    systemId: asNumber(fallback.system_id, 0),
    systemName: asString(fallback.system_name, ''),
    apiKeyId: asNumber(fallback.api_key_id, 0),
    apiKeyName: asString(fallback.api_key_name, ''),
    isActive: asNumber(fallback.is_active, 0) === 1,
  }].filter((item) => item.systemId > 0 && item.apiKeyId > 0 && item.apiKeyName);
};

export const getAlgofundActiveSystems = async (profileId: number): Promise<AlgofundActiveSystem[]> => {
  const resolvedProfileId = await resolveAlgofundProfileId(profileId);
  const rows = await db.all(
    `SELECT id, profile_id, system_name, weight, is_enabled, assigned_by, created_at
     FROM algofund_active_systems
     WHERE profile_id = ?
     ORDER BY id ASC`,
    [resolvedProfileId]
  ) as Array<Record<string, unknown>>;

  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row.id || 0),
    profileId: Number(row.profile_id || 0),
    systemName: String(row.system_name || ''),
    weight: Number(row.weight ?? 1),
    isEnabled: Boolean(row.is_enabled),
    assignedBy: String(row.assigned_by || 'admin') as 'admin' | 'client',
    createdAt: String(row.created_at || ''),
  }));
};

type PairConflict = {
  pair: string;
  conflictingSystemName: string;
};

/**
 * D1+D2: Проверяет, что API-ключ не назначен другому тенанту (в любом режиме).
 * Кидает Error если ключ уже занят.
 */
export const validateApiKeyNotAssigned = async (
  apiKeyName: string,
  currentTenantId: number,
  targetMode: 'algofund' | 'strategy-client' | 'strategy-client-custom-ts'
): Promise<void> => {
  if (!apiKeyName) return;

  // D1: Проверка — ключ уже назначен другому algofund-профилю?
  const algofundConflict = await db.get(
    `SELECT ap.tenant_id, t.slug FROM algofund_profiles ap
     JOIN tenants t ON t.id = ap.tenant_id
     WHERE ap.assigned_api_key_name = ? AND ap.tenant_id != ?`,
    [apiKeyName, currentTenantId]
  );
  if (algofundConflict) {
    throw new Error(
      `API-ключ "${apiKeyName}" уже назначен algofund-клиенту "${algofundConflict.slug}" (tenant #${algofundConflict.tenant_id}). Один ключ = один клиент.`
    );
  }

  // D1: Проверка — ключ уже назначен другому strategy-client-профилю?
  const strategyConflict = await db.get(
    `SELECT scp.tenant_id, t.slug FROM strategy_client_profiles scp
     JOIN tenants t ON t.id = scp.tenant_id
     WHERE scp.assigned_api_key_name = ? AND scp.tenant_id != ?`,
    [apiKeyName, currentTenantId]
  );
  if (strategyConflict) {
    throw new Error(
      `API-ключ "${apiKeyName}" уже назначен strategy-клиенту "${strategyConflict.slug}" (tenant #${strategyConflict.tenant_id}). Один ключ = один клиент.`
    );
  }

  // D2: Кросс-мод блокировка — ключ из algofund нельзя использовать в strategy и наоборот
  if (targetMode === 'algofund') {
    const crossConflict = await db.get(
      `SELECT scp.tenant_id, t.slug FROM strategy_client_profiles scp
       JOIN tenants t ON t.id = scp.tenant_id
       WHERE scp.assigned_api_key_name = ? AND scp.tenant_id != ?`,
      [apiKeyName, currentTenantId]
    );
    if (crossConflict) {
      throw new Error(
        `API-ключ "${apiKeyName}" используется в режиме strategy-client у "${crossConflict.slug}". Нельзя использовать один ключ в двух режимах (Algofund↔Strategy).`
      );
    }
  } else {
    const crossConflict = await db.get(
      `SELECT ap.tenant_id, t.slug FROM algofund_profiles ap
       JOIN tenants t ON t.id = ap.tenant_id
       WHERE ap.assigned_api_key_name = ? AND ap.tenant_id != ?`,
      [apiKeyName, currentTenantId]
    );
    if (crossConflict) {
      throw new Error(
        `API-ключ "${apiKeyName}" используется в режиме algofund у "${crossConflict.slug}". Нельзя использовать один ключ в двух режимах (Algofund↔Strategy).`
      );
    }
  }
};

export const checkAlgofundSystemPairConflicts = async (
  profileId: number,
  proposedSystemName: string,
  apiKeyName: string
): Promise<PairConflict[]> => {
  const resolvedProfileId = await resolveAlgofundProfileId(profileId);
  // Get pairs used by the proposed system
  const proposedRows = await db.all(
    `SELECT DISTINCT s.base_symbol, s.quote_symbol
     FROM trading_systems ts
     JOIN api_keys ak ON ak.id = ts.api_key_id
     JOIN trading_system_members tsm ON tsm.system_id = ts.id
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE ak.name = ? AND ts.name = ? AND tsm.is_enabled = 1`,
    [apiKeyName, proposedSystemName]
  ) as Array<{ base_symbol: string; quote_symbol: string }>;

  if (!proposedRows.length) {
    return [];
  }

  const proposedPairs = new Set(proposedRows.map((r) => `${r.base_symbol}/${r.quote_symbol}`));

  // Get pairs from all currently-enabled active systems for this profile
  const currentRows = await db.all(
    `SELECT DISTINCT s.base_symbol, s.quote_symbol, aas.system_name
     FROM algofund_active_systems aas
     JOIN trading_systems ts ON ts.name = aas.system_name
     JOIN api_keys ak ON ak.id = ts.api_key_id
     JOIN trading_system_members tsm ON tsm.system_id = ts.id
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE aas.profile_id = ? AND aas.is_enabled = 1 AND aas.system_name != ?
       AND ak.name = ? AND tsm.is_enabled = 1`,
    [resolvedProfileId, proposedSystemName, apiKeyName]
  ) as Array<{ base_symbol: string; quote_symbol: string; system_name: string }>;

  const conflicts: PairConflict[] = [];
  for (const row of currentRows) {
    const pair = `${row.base_symbol}/${row.quote_symbol}`;
    if (proposedPairs.has(pair)) {
      conflicts.push({ pair, conflictingSystemName: row.system_name });
    }
  }

  return conflicts;
};

export const assignAlgofundSystems = async (payload: {
  profileId: number;
  systems: Array<{ systemName: string; weight?: number; isEnabled?: boolean; assignedBy?: 'admin' | 'client' }>;
  replace?: boolean;
}): Promise<AlgofundActiveSystem[]> => {
  const { systems, replace = false } = payload;
  const profileId = await resolveAlgofundProfileId(payload.profileId);

  if (replace) {
    await db.run(`DELETE FROM algofund_active_systems WHERE profile_id = ?`, [profileId]);
  }

  for (const sys of systems) {
    const systemName = String(sys.systemName || '').trim();
    if (!systemName) continue;
    const weight = Math.max(0.01, Number(sys.weight ?? 1));
    const isEnabled = sys.isEnabled !== false ? 1 : 0;
    const assignedBy = sys.assignedBy === 'client' ? 'client' : 'admin';

    await db.run(
      `INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (profile_id, system_name) DO UPDATE SET
         weight = excluded.weight,
         is_enabled = excluded.is_enabled,
         assigned_by = excluded.assigned_by,
         updated_at = CURRENT_TIMESTAMP`,
      [profileId, systemName, weight, isEnabled, assignedBy]
    );
  }

  return getAlgofundActiveSystems(profileId);
};

/** Assign all trading systems of an algofund portfolio onto a client profile (multi-TS). */
export const assignAlgofundPortfolio = async (payload: {
  profileId: number;
  portfolioId?: number;
  setKey?: string;
  replace?: boolean;
  assignedBy?: 'admin' | 'client';
}): Promise<{ portfolioId: number; setKey: string; activeSystems: AlgofundActiveSystem[] }> => {
  const profileId = await resolveAlgofundProfileId(payload.profileId);
  const setKey = asString(payload.setKey, '').trim();
  const portfolio = payload.portfolioId
    ? await db.get<{ id: number; set_key: string }>(
      `SELECT id, set_key FROM algofund_portfolios WHERE id = ? AND COALESCE(is_enabled,1)=1`,
      [payload.portfolioId],
    )
    : await db.get<{ id: number; set_key: string }>(
      `SELECT id, set_key FROM algofund_portfolios WHERE set_key = ? AND COALESCE(is_enabled,1)=1`,
      [setKey],
    );
  if (!portfolio?.id) {
    throw new Error(`Portfolio not found: id=${payload.portfolioId || ''} setKey=${setKey}`);
  }

  const members = await db.all(
    `SELECT system_name, role, capital_weight, is_enabled
     FROM algofund_portfolio_members
     WHERE portfolio_id = ? AND COALESCE(is_enabled,1)=1
     ORDER BY sort_order ASC, id ASC`,
    [portfolio.id],
  ) as Array<{ system_name: string; role: string; capital_weight: number; is_enabled: number }>;

  if (!members.length) {
    throw new Error(`Portfolio ${portfolio.set_key} has no members`);
  }

  await db.run(
    `INSERT INTO algofund_active_portfolios (profile_id, portfolio_id, is_enabled, assigned_by, created_at, updated_at)
     VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (profile_id, portfolio_id) DO UPDATE SET
       is_enabled = 1,
       assigned_by = excluded.assigned_by,
       updated_at = CURRENT_TIMESTAMP`,
    [profileId, portfolio.id, payload.assignedBy || 'admin'],
  );

  const systems = members.map((m) => ({
    systemName: asString(m.system_name, ''),
    weight: Math.max(0.01, asNumber(m.capital_weight, 1)),
    isEnabled: true,
    assignedBy: (payload.assignedBy || 'admin') as 'admin' | 'client',
  })).filter((s) => s.systemName);

  const activeSystems = await assignAlgofundSystems({
    profileId,
    systems,
    replace: payload.replace !== false,
  });

  // Keep storefront card matching in sync (admin vitrine joins by published_system_name).
  await db.run(
    `UPDATE algofund_profiles
     SET published_system_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [asString(portfolio.set_key, ''), profileId],
  ).catch(() => undefined);

  return {
    portfolioId: Number(portfolio.id),
    setKey: asString(portfolio.set_key, ''),
    activeSystems,
  };
};

/** Detach a portfolio from a client profile (does not stop trading by itself). */
export const unassignAlgofundPortfolio = async (payload: {
  profileId: number;
  portfolioId?: number;
  setKey?: string;
  clearPublished?: boolean;
}): Promise<{ portfolioId: number; setKey: string }> => {
  const profileId = await resolveAlgofundProfileId(payload.profileId);
  const setKey = asString(payload.setKey, '').trim();
  const portfolio = payload.portfolioId
    ? await db.get<{ id: number; set_key: string }>(
      `SELECT id, set_key FROM algofund_portfolios WHERE id = ?`,
      [payload.portfolioId],
    )
    : await db.get<{ id: number; set_key: string }>(
      `SELECT id, set_key FROM algofund_portfolios WHERE set_key = ?`,
      [setKey],
    );
  if (!portfolio?.id) {
    throw new Error(`Portfolio not found: id=${payload.portfolioId || ''} setKey=${setKey}`);
  }

  await db.run(
    `UPDATE algofund_active_portfolios
     SET is_enabled = 0, updated_at = CURRENT_TIMESTAMP
     WHERE profile_id = ? AND portfolio_id = ?`,
    [profileId, portfolio.id],
  );

  if (payload.clearPublished !== false) {
    await db.run(
      `UPDATE algofund_profiles
       SET published_system_name = CASE
             WHEN COALESCE(published_system_name, '') = ? THEN ''
             ELSE published_system_name
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [asString(portfolio.set_key, ''), profileId],
    ).catch(() => undefined);
  }

  return {
    portfolioId: Number(portfolio.id),
    setKey: asString(portfolio.set_key, ''),
  };
};

/**
 * Materialize every portfolio member TS onto the client key as separate
 * ALGOFUND::{slug}::{role} systems with independent OP. Archives only SAAS
 * orphans not belonging to any book in the portfolio.
 */
export const materializeAlgofundPortfolioFull = async (payload: {
  tenantId: number;
  portfolioId?: number;
  setKey?: string;
  activate?: boolean;
}): Promise<{
  portfolioId: number;
  setKey: string;
  systems: Array<{ role: string; systemName: string; systemId: number; strategyCount: number }>;
  activeSystems: AlgofundActiveSystem[];
}> => {
  await ensureSaasSeedData();
  const tenant = await getTenantById(payload.tenantId);
  const plan = await getPlanForTenant(payload.tenantId, 'algofund_client');
  if (!plan) throw new Error('Algofund plan is required to materialize portfolio');
  const profile = await getAlgofundProfile(payload.tenantId);
  if (!profile) throw new Error('Algofund profile missing');

  const assigned = await assignAlgofundPortfolio({
    profileId: payload.tenantId,
    portfolioId: payload.portfolioId,
    setKey: payload.setKey,
    replace: true,
    assignedBy: 'admin',
  });

  const members = await db.all(
    `SELECT system_name, role, capital_weight
     FROM algofund_portfolio_members
     WHERE portfolio_id = ? AND COALESCE(is_enabled,1)=1
     ORDER BY sort_order ASC, id ASC`,
    [assigned.portfolioId],
  ) as Array<{ system_name: string; role: string; capital_weight: number }>;

  const keepAll = new Set<number>();
  const systemsOut: Array<{ role: string; systemName: string; systemId: number; strategyCount: number }> = [];

  for (let i = 0; i < members.length; i += 1) {
    const member = members[i];
    const role = asString(member.role, `book${i + 1}`).trim() || `book${i + 1}`;
    const clientSystemName = `ALGOFUND::${tenant.slug}::${role}`;
    const result = await materializeAlgofundSystem(
      tenant,
      plan,
      profile,
      Boolean(payload.activate),
      {
        sourceSystemNameOverride: asString(member.system_name, ''),
        clientSystemName,
        preserveSiblingSystems: true,
        memberWeightScale: Math.max(0.05, asNumber(member.capital_weight, 1)),
        skipProfilePublishUpdate: true,
        keepStrategyIdsExtra: [...keepAll],
      },
    );
    for (const sid of result.strategyIds || []) keepAll.add(Number(sid));
    systemsOut.push({
      role,
      systemName: result.systemName,
      systemId: Number(result.systemId),
      strategyCount: (result.strategyIds || []).length,
    });
  }

  // Final orphan sweep: keep union of all portfolio strategy ids
  const executionApiKeyName = getAlgofundExecutionApiKeyName(tenant, profile);
  if (executionApiKeyName) {
    const saasPrefix = `SAAS::${tenant.slug}::`;
    const orphanRows = (await db.all(
      `SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.market_mode, s.state
       FROM strategies s
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE a.name = ?
         AND s.is_active = 1
         AND COALESCE(s.is_archived, 0) = 0
         AND s.name LIKE ?`,
      [executionApiKeyName, `${saasPrefix}%`],
    ).catch(() => [])) as Array<{ id: number; name: string; base_symbol: string | null; quote_symbol: string | null; market_mode: string | null; state: string | null }>;
    for (const orphan of orphanRows) {
      if (keepAll.has(Number(orphan.id))) continue;
      await saasArchiveStrategy(executionApiKeyName, orphan).catch(() => {});
    }
  }

  await db.run(
    `UPDATE algofund_profiles
     SET published_system_name = ?,
         requested_enabled = ?,
         actual_enabled = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [
      assigned.setKey,
      payload.activate ? 1 : Number(profile.requested_enabled || 0),
      payload.activate ? 1 : Number(profile.actual_enabled || 0),
      tenant.id,
    ],
  );

  return {
    portfolioId: assigned.portfolioId,
    setKey: assigned.setKey,
    systems: systemsOut,
    activeSystems: assigned.activeSystems,
  };
};

export const listAlgofundPortfolios = async (): Promise<Array<Record<string, unknown>>> => {
  const rows = await db.all(
    `SELECT p.id, p.set_key, p.display_label, p.description, p.is_storefront, p.is_personal,
            p.metadata_json, p.snapshot_json, p.is_enabled, p.updated_at,
            (SELECT COUNT(*) FROM algofund_portfolio_members m WHERE m.portfolio_id=p.id AND COALESCE(m.is_enabled,1)=1) AS member_count
     FROM algofund_portfolios p
     WHERE COALESCE(p.is_enabled,1)=1
     ORDER BY p.is_personal ASC, p.id ASC`,
  );
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows || []) {
    const portfolioId = Number((r as any).id);
    const memberCount = Number((r as any).member_count || 0);
    const members = await db.all(
      `SELECT role, system_name, capital_weight, sort_order
       FROM algofund_portfolio_members
       WHERE portfolio_id = ? AND COALESCE(is_enabled,1)=1
       ORDER BY sort_order ASC, id ASC`,
      [portfolioId],
    ) as Array<{ role: string; system_name: string; capital_weight: number }>;
    const metadata = (() => { try { return JSON.parse(String((r as any).metadata_json || '{}')); } catch { return {}; } })() as any;
    const snapshot = (() => { try { return JSON.parse(String((r as any).snapshot_json || '{}')); } catch { return {}; } })() as any;
    const books = Array.isArray(metadata?.books) ? metadata.books : [];
    const expectedBooks = Math.max(memberCount, members.length, 1);
    const tenantRows = await db.all(
      `SELECT t.id AS tenant_id, t.slug, t.display_name, ap.id AS profile_id,
              ap.actual_enabled, ap.requested_enabled, ap.published_system_name,
              COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key_name
       FROM algofund_active_portfolios aap
       JOIN algofund_profiles ap ON ap.id = aap.profile_id
       JOIN tenants t ON t.id = ap.tenant_id
       WHERE aap.portfolio_id = ? AND COALESCE(aap.is_enabled, 1) = 1
       ORDER BY t.slug ASC`,
      [portfolioId],
    ).catch(() => []) as Array<{
      tenant_id: number;
      slug: string;
      display_name: string;
      profile_id: number;
      actual_enabled: number;
      requested_enabled: number;
      published_system_name: string;
      api_key_name: string;
    }>;

    const tenants: Array<Record<string, unknown>> = [];
    let okCount = 0;
    let partialCount = 0;
    let errorCount = 0;
    for (const tr of tenantRows || []) {
      const slug = asString(tr.slug, '');
      const booksRow = await db.get<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM trading_systems
         WHERE is_active = 1
           AND name LIKE ?`,
        [`ALGOFUND::${slug}::%`],
      ).catch(() => null);
      const booksFound = Number(booksRow?.cnt || 0);
      let status: 'ok' | 'partial' | 'error' = 'ok';
      const issues: string[] = [];
      if (!asString(tr.api_key_name, '').trim()) {
        status = 'error';
        issues.push('missing api key');
      } else if (booksFound <= 0) {
        status = 'error';
        issues.push(`books 0/${expectedBooks}`);
      } else if (booksFound < expectedBooks) {
        status = 'partial';
        issues.push(`books ${booksFound}/${expectedBooks}`);
      }
      if (status === 'ok') okCount += 1;
      else if (status === 'partial') partialCount += 1;
      else errorCount += 1;
      tenants.push({
        tenantId: Number(tr.tenant_id),
        slug,
        displayName: asString(tr.display_name, slug),
        profileId: Number(tr.profile_id),
        actualEnabled: Number(tr.actual_enabled || 0) === 1,
        requestedEnabled: Number(tr.requested_enabled || 0) === 1,
        publishedSystemName: asString(tr.published_system_name, ''),
        booksFound,
        booksExpected: expectedBooks,
        materializationStatus: status,
        issues,
      });
    }

    let aggregateStatus: 'ok' | 'partial' | 'error' | 'empty' = 'empty';
    if (tenants.length > 0) {
      if (errorCount > 0) aggregateStatus = 'error';
      else if (partialCount > 0) aggregateStatus = 'partial';
      else aggregateStatus = 'ok';
    }

    out.push({
      id: portfolioId,
      setKey: asString((r as any).set_key, ''),
      displayLabel: asString((r as any).display_label, ''),
      description: asString((r as any).description, ''),
      isStorefront: Boolean((r as any).is_storefront),
      isPersonal: Boolean((r as any).is_personal),
      memberCount,
      metadata,
      snapshot,
      members: members.map((m, idx) => {
        const book = books.find((b: any) => String(b?.key || '') === String(m.role)) || books[idx] || {};
        return {
          role: asString(m.role, ''),
          systemName: asString(m.system_name, ''),
          weight: asNumber(m.capital_weight, 1),
          op: book?.op != null ? Number(book.op) : undefined,
          lot: book?.lot != null ? Number(book.lot) : undefined,
        };
      }),
      tenants,
      tenantCount: tenants.length,
      activeCount: tenants.filter((t) => Boolean(t.actualEnabled)).length,
      materialization: {
        okCount,
        partialCount,
        errorCount,
        totalClients: tenants.length,
        aggregateStatus,
      },
      updatedAt: asString((r as any).updated_at, ''),
    });
  }
  return out;
};

export const toggleAlgofundSystem = async (payload: {
  profileId: number;
  systemName: string;
  isEnabled: boolean;
  apiKeyName: string;
  actorMode?: 'admin' | 'client';
}): Promise<{ activeSystems: AlgofundActiveSystem[]; conflicts: PairConflict[] }> => {
  const { systemName, isEnabled, apiKeyName } = payload;
  const profileId = await resolveAlgofundProfileId(payload.profileId);
  const actorMode = payload.actorMode === 'client' ? 'client' : 'admin';

  let conflicts: PairConflict[] = [];
  if (isEnabled) {
    conflicts = await checkAlgofundSystemPairConflicts(profileId, systemName, apiKeyName);
    if (conflicts.length > 0) {
      return { activeSystems: await getAlgofundActiveSystems(profileId), conflicts };
    }
  }

  await db.run(
    `INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
     VALUES (?, ?, 1.0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (profile_id, system_name) DO UPDATE SET
       is_enabled = excluded.is_enabled,
       assigned_by = excluded.assigned_by,
       updated_at = CURRENT_TIMESTAMP`,
    [profileId, systemName, isEnabled ? 1 : 0, actorMode]
  );

  // When disabling: deactivate runtime strategies and close positions for the client's api key
  if (!isEnabled && apiKeyName) {
    try {
      // Check if any other system is still enabled for this profile
      const remainingEnabled = await db.get(
        `SELECT COUNT(*) as cnt FROM algofund_active_systems WHERE profile_id = ? AND is_enabled = 1`,
        [profileId]
      ) as { cnt: number } | undefined;

      if (Number(remainingEnabled?.cnt || 0) === 0) {
        // No systems enabled — deactivate all runtime strategies on this api key
        const deactivated = await db.run(
          `UPDATE strategies SET is_active = 0, auto_update = 0, updated_at = CURRENT_TIMESTAMP
           WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ? LIMIT 1)
             AND is_runtime = 1 AND is_active = 1`,
          [apiKeyName]
        ).catch(() => ({ changes: 0 }));
        logger.info(`[toggleAlgofundSystem] All systems disabled for ${apiKeyName}: deactivated ${(deactivated as any)?.changes || 0} runtime strategies`);

        await ensureExchangeClientInitialized(apiKeyName).catch(() => {});
        try { await cancelAllOrders(apiKeyName); } catch (e) { logger.warn(`[toggleAlgofundSystem] cancelAllOrders for ${apiKeyName}: ${(e as Error).message}`); }
        try { await closeAllPositions(apiKeyName); } catch (e) { logger.warn(`[toggleAlgofundSystem] closeAllPositions for ${apiKeyName}: ${(e as Error).message}`); }
      }
    } catch (e) {
      logger.warn(`[toggleAlgofundSystem] cleanup for "${systemName}" on ${apiKeyName}: ${(e as Error).message}`);
    }
  }

  return {
    activeSystems: await getAlgofundActiveSystems(profileId),
    conflicts: [],
  };
};

export const removeAlgofundSystemFromProfile = async (payload: {
  profileId: number;
  systemName: string;
  closePositions?: boolean;
  cancelOrders?: boolean;
}): Promise<AlgofundActiveSystem[]> => {
  const profileId = await resolveAlgofundProfileId(payload.profileId);
  const systemName = asString(payload.systemName, '').trim();
  // Defaults: keep current behavior (close + cancel) unless caller opts out
  const shouldClosePositions = payload.closePositions !== false;
  const shouldCancelOrders = payload.cancelOrders !== false;

  await db.run(
    `DELETE FROM algofund_active_systems WHERE profile_id = ? AND system_name = ?`,
    [profileId, systemName]
  );

  // Deactivate runtime strategies if no systems remain enabled for this profile
  if (systemName) {
    try {
      // Find tenant's API key from profile
      const profileRow = await db.get(
        `SELECT COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key_name
         FROM algofund_profiles ap
         JOIN tenants t ON t.id = ap.tenant_id
         WHERE ap.id = ?`,
        [profileId]
      ) as { api_key_name?: string } | undefined;
      const apiKeyName = asString(profileRow?.api_key_name, '').trim();

      if (apiKeyName) {
        // Check if any other system is still enabled for this profile
        const remainingEnabled = await db.get(
          `SELECT COUNT(*) as cnt FROM algofund_active_systems WHERE profile_id = ? AND is_enabled = 1`,
          [profileId]
        ) as { cnt: number } | undefined;

        if (Number(remainingEnabled?.cnt || 0) === 0) {
          // No systems left — fully demote runtime strategies (archive them so the
          // dashboard "sets" counter goes to 0 and the connect-modal stops listing
          // this tenant as connected to that TS). Positions on the exchange are NOT
          // touched here — that decision is controlled by shouldClosePositions below.
          const archived = await db.run(
            `UPDATE strategies
             SET is_active = 0,
                 is_runtime = 0,
                 is_archived = 1,
                 auto_update = 0,
                 updated_at = CURRENT_TIMESTAMP
             WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ? LIMIT 1)
               AND is_runtime = 1`,
            [apiKeyName]
          ).catch(() => ({ changes: 0 }));
          logger.info(`[removeAlgofundSystemFromProfile] No systems remain for ${apiKeyName}: archived ${(archived as any)?.changes || 0} runtime strategies`);

          // Clear published_system_name so this tenant disappears from the
          // connect-clients modal that lists tenants currently bound to the TS.
          try {
            await db.run(
              `UPDATE algofund_profiles
               SET published_system_name = '', updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [profileId]
            );
          } catch (e) {
            logger.warn(`[removeAlgofundSystem] clear published_system_name for profile ${profileId}: ${(e as Error).message}`);
          }

          // Mark card_deployments inactive so the card UI doesn't keep showing it as live
          try {
            await db.run(
              `UPDATE card_deployments
               SET status = 'inactive',
                   sync_status = ?,
                   sync_error = ?,
                   updated_at = CURRENT_TIMESTAMP
               WHERE execution_api_key_name = ?`,
              [
                shouldClosePositions ? 'admin_dematerialized_closed' : 'admin_dematerialized_kept_positions',
                shouldClosePositions ? '' : 'Dematerialized without closing positions',
                apiKeyName,
              ]
            );
          } catch (e) {
            logger.warn(`[removeAlgofundSystem] card_deployments update for ${apiKeyName}: ${(e as Error).message}`);
          }

          if (shouldCancelOrders || shouldClosePositions) {
            await ensureExchangeClientInitialized(apiKeyName).catch(() => {});
          }
          if (shouldCancelOrders) {
            try { await cancelAllOrders(apiKeyName); } catch (e) { logger.warn(`[removeAlgofundSystem] cancelAllOrders for ${apiKeyName}: ${(e as Error).message}`); }
          } else {
            logger.info(`[removeAlgofundSystem] cancelOrders skipped by request for ${apiKeyName}`);
          }
          if (shouldClosePositions) {
            try { await closeAllPositions(apiKeyName); } catch (e) { logger.warn(`[removeAlgofundSystem] closeAllPositions for ${apiKeyName}: ${(e as Error).message}`); }
          } else {
            logger.info(`[removeAlgofundSystem] closePositions skipped by request for ${apiKeyName}`);
          }
        }
      }
    } catch (e) {
      logger.warn(`[removeAlgofundSystemFromProfile] cleanup for "${systemName}": ${(e as Error).message}`);
    }
  }

  return getAlgofundActiveSystems(profileId);
};

export const getAlgofundSystemHealthReport = async (options: {
  tenantId?: number;
  systemName?: string;
  lookbackHours?: number;
}) => {
  const lookbackHours = Math.max(1, Math.floor(asNumber(options.lookbackHours, 24)));
  const sinceMs = Date.now() - lookbackHours * 3_600_000;
  const systems = await resolveAlgofundSystemTargets({
    tenantId: asNumber(options.tenantId, 0) || undefined,
    systemName: asString(options.systemName, '') || undefined,
  });

  const reportSystems = [] as Array<Record<string, unknown>>;
  for (const system of systems) {
    const members = await db.all(
      `SELECT
         tsm.strategy_id,
         COALESCE(tsm.is_enabled, 1) AS is_enabled,
         COALESCE(tsm.weight, 1) AS weight,
         COALESCE(tsm.member_role, '') AS member_role,
         COALESCE(s.name, '') AS strategy_name,
         COALESCE(s.base_symbol, '') AS base_symbol,
         COALESCE(s.quote_symbol, '') AS quote_symbol,
         COALESCE(s.last_signal, '') AS last_signal,
         COALESCE(s.last_action, '') AS last_action,
         COALESCE(s.updated_at, '') AS updated_at
       FROM trading_system_members tsm
       LEFT JOIN strategies s ON s.id = tsm.strategy_id
       WHERE tsm.system_id = ?
       ORDER BY tsm.id ASC`,
      [system.systemId]
    ) as Array<Record<string, unknown>>;

    const strategyIds = (Array.isArray(members) ? members : [])
      .map((row) => asNumber(row.strategy_id, 0))
      .filter((id) => id > 0);
    const strategyIdsUnique = Array.from(new Set(strategyIds));

    const eventRows = strategyIdsUnique.length > 0
      ? await db.all(
        `SELECT strategy_id, COUNT(*) AS events_count, MAX(actual_time) AS last_event_time
         FROM live_trade_events
         WHERE strategy_id IN (${strategyIdsUnique.map(() => '?').join(',')})
           AND COALESCE(event_origin, CASE WHEN COALESCE(source_trade_id, '') <> '' OR COALESCE(source_order_id, '') <> '' OR ABS(COALESCE(actual_fee, 0)) > 0 THEN 'exchange_fill' ELSE 'strategy_signal' END) = 'exchange_fill'
         GROUP BY strategy_id`,
        strategyIdsUnique
      ) as Array<Record<string, unknown>>
      : [];

    const eventRowsRecent = strategyIdsUnique.length > 0
      ? await db.all(
        `SELECT strategy_id, COUNT(*) AS events_count
         FROM live_trade_events
         WHERE strategy_id IN (${strategyIdsUnique.map(() => '?').join(',')}) AND actual_time >= ?
           AND COALESCE(event_origin, CASE WHEN COALESCE(source_trade_id, '') <> '' OR COALESCE(source_order_id, '') <> '' OR ABS(COALESCE(actual_fee, 0)) > 0 THEN 'exchange_fill' ELSE 'strategy_signal' END) = 'exchange_fill'
         GROUP BY strategy_id`,
        [...strategyIdsUnique, sinceMs]
      ) as Array<Record<string, unknown>>
      : [];

    const eventByStrategy = new Map<number, { total: number; lastEventTime: number }>();
    for (const row of (Array.isArray(eventRows) ? eventRows : [])) {
      const strategyId = asNumber(row.strategy_id, 0);
      if (strategyId <= 0) continue;
      eventByStrategy.set(strategyId, {
        total: asNumber(row.events_count, 0),
        lastEventTime: asNumber(row.last_event_time, 0),
      });
    }
    const recentByStrategy = new Map<number, number>();
    for (const row of (Array.isArray(eventRowsRecent) ? eventRowsRecent : [])) {
      const strategyId = asNumber(row.strategy_id, 0);
      if (strategyId <= 0) continue;
      recentByStrategy.set(strategyId, asNumber(row.events_count, 0));
    }

    const latestSnapshot = await db.get(
      `SELECT equity_usd, unrealized_pnl, notional_usd, margin_load_percent, recorded_at
       FROM monitoring_snapshots
       WHERE api_key_id = ?
       ORDER BY datetime(recorded_at) DESC
       LIMIT 1`,
      [system.apiKeyId]
    ) as Record<string, unknown> | undefined;

    const connectedClientsRow = await db.get(
      `SELECT COUNT(DISTINCT ap.tenant_id) AS connected_clients
       FROM algofund_profiles ap
       LEFT JOIN algofund_active_systems aas ON aas.profile_id = ap.id AND COALESCE(aas.is_enabled, 1) = 1
       WHERE COALESCE(ap.published_system_name, '') = ? OR COALESCE(aas.system_name, '') = ?`,
      [system.systemName, system.systemName]
    ) as Record<string, unknown> | undefined;

    const strategyHealth = (Array.isArray(members) ? members : []).map((row) => {
      const strategyId = asNumber(row.strategy_id, 0);
      const pair = asString(row.quote_symbol, '')
        ? `${asString(row.base_symbol, '')}/${asString(row.quote_symbol, '')}`
        : asString(row.base_symbol, '');
      const events = eventByStrategy.get(strategyId);
      const recentEvents = recentByStrategy.get(strategyId) || 0;
      return {
        strategyId,
        isEnabled: asNumber(row.is_enabled, 0) === 1,
        weight: asNumber(row.weight, 1),
        memberRole: asString(row.member_role, ''),
        strategyName: asString(row.strategy_name, ''),
        pair,
        lastSignal: asString(row.last_signal, ''),
        lastAction: asString(row.last_action, ''),
        strategyUpdatedAt: asString(row.updated_at, ''),
        liveEventsTotal: asNumber(events?.total, 0),
        liveEventsLookback: recentEvents,
        lastLiveEventAtMs: asNumber(events?.lastEventTime, 0),
      };
    });

    const enabledMembers = strategyHealth.filter((row) => row.isEnabled).length;
    const membersWithRecentEvents = strategyHealth.filter((row) => row.liveEventsLookback > 0).length;
    reportSystems.push({
      systemId: system.systemId,
      systemName: system.systemName,
      apiKeyName: system.apiKeyName,
      isActive: system.isActive,
      connectedClients: asNumber(connectedClientsRow?.connected_clients, 0),
      membersTotal: strategyHealth.length,
      membersEnabled: enabledMembers,
      membersWithRecentEvents,
      latestAccountSnapshot: latestSnapshot ? {
        equityUsd: asNumber(latestSnapshot.equity_usd, 0),
        unrealizedPnl: asNumber(latestSnapshot.unrealized_pnl, 0),
        notionalUsd: asNumber(latestSnapshot.notional_usd, 0),
        marginLoadPercent: asNumber(latestSnapshot.margin_load_percent, 0),
        recordedAt: asString(latestSnapshot.recorded_at, ''),
      } : null,
      strategies: strategyHealth,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    lookbackHours,
    systems: reportSystems,
  };
};

export const getAlgofundClosedPositionsReport = async (options: {
  tenantId?: number;
  systemName?: string;
  periodHours?: number;
  limit?: number;
}) => {
  const periodHours = Math.max(1, Math.floor(asNumber(options.periodHours, 24 * 7)));
  const limit = Math.max(1, Math.min(500, Math.floor(asNumber(options.limit, 100))));
  const sinceMs = Date.now() - periodHours * 3_600_000;
  const systems = await resolveAlgofundSystemTargets({
    tenantId: asNumber(options.tenantId, 0) || undefined,
    systemName: asString(options.systemName, '') || undefined,
  });

  const rowsOut = [] as Array<Record<string, unknown>>;

  for (const system of systems) {
    const members = await db.all(
      `SELECT strategy_id FROM trading_system_members WHERE system_id = ? AND COALESCE(is_enabled, 1) = 1`,
      [system.systemId]
    ) as Array<Record<string, unknown>>;
    const strategyIds = Array.from(new Set((Array.isArray(members) ? members : [])
      .map((row) => asNumber(row.strategy_id, 0))
      .filter((id) => id > 0)));

    if (strategyIds.length === 0) {
      continue;
    }

    const strategyMetaRows = await db.all(
      `SELECT id, COALESCE(name, '') AS name, COALESCE(base_symbol, '') AS base_symbol, COALESCE(quote_symbol, '') AS quote_symbol
       FROM strategies
       WHERE id IN (${strategyIds.map(() => '?').join(',')})`,
      strategyIds
    ) as Array<Record<string, unknown>>;
    const strategyMeta = new Map<number, { name: string; pair: string }>();
    for (const row of (Array.isArray(strategyMetaRows) ? strategyMetaRows : [])) {
      const id = asNumber(row.id, 0);
      if (id <= 0) continue;
      const pair = asString(row.quote_symbol, '')
        ? `${asString(row.base_symbol, '')}/${asString(row.quote_symbol, '')}`
        : asString(row.base_symbol, '');
      strategyMeta.set(id, { name: asString(row.name, ''), pair });
    }

    const events = await db.all(
      `SELECT strategy_id, trade_type, side, entry_time, entry_price, position_size, actual_price, actual_time, actual_fee, source_symbol
       FROM live_trade_events
       WHERE strategy_id IN (${strategyIds.map(() => '?').join(',')})
         AND actual_time >= ?
         AND COALESCE(event_origin, CASE WHEN COALESCE(source_trade_id, '') <> '' OR COALESCE(source_order_id, '') <> '' OR ABS(COALESCE(actual_fee, 0)) > 0 THEN 'exchange_fill' ELSE 'strategy_signal' END) = 'exchange_fill'
       ORDER BY actual_time ASC, id ASC`,
      [...strategyIds, sinceMs]
    ) as Array<Record<string, unknown>>;

    const openByKey = new Map<string, Array<Record<string, unknown>>>();
    for (const event of (Array.isArray(events) ? events : [])) {
      const strategyId = asNumber(event.strategy_id, 0);
      if (strategyId <= 0) continue;
      const side = asString(event.side, '');
      const symbol = asString(event.source_symbol, '') || strategyMeta.get(strategyId)?.pair || '';
      const key = `${strategyId}|${side}|${symbol}`;
      if (asString(event.trade_type, '').toLowerCase() === 'entry') {
        const list = openByKey.get(key) || [];
        list.push(event);
        openByKey.set(key, list);
        continue;
      }
      if (asString(event.trade_type, '').toLowerCase() === 'exit') {
        const list = openByKey.get(key) || [];
        const entry = list.shift();
        openByKey.set(key, list);
        if (!entry) {
          continue;
        }
        const qty = Math.max(0, asNumber(event.position_size, asNumber(entry.position_size, 0)));
        const entryPrice = asNumber(entry.actual_price, asNumber(entry.entry_price, 0));
        const exitPrice = asNumber(event.actual_price, 0);
        const entryFee = asNumber(entry.actual_fee, 0);
        const exitFee = asNumber(event.actual_fee, 0);
        const gross = side.toLowerCase() === 'short'
          ? (entryPrice - exitPrice) * qty
          : (exitPrice - entryPrice) * qty;
        const pnl = gross - entryFee - exitFee;
        rowsOut.push({
          systemId: system.systemId,
          systemName: system.systemName,
          strategyId,
          strategyName: strategyMeta.get(strategyId)?.name || '',
          symbol,
          side,
          qty,
          entryPrice,
          exitPrice,
          entryTime: asNumber(entry.actual_time, asNumber(entry.entry_time, 0)),
          exitTime: asNumber(event.actual_time, 0),
          entryFee,
          exitFee,
          realizedPnl: Number(pnl.toFixed(8)),
          holdMinutes: Number(((asNumber(event.actual_time, 0) - asNumber(entry.actual_time, asNumber(entry.entry_time, 0))) / 60_000).toFixed(2)),
        });
      }
    }
  }

  const sorted = rowsOut.sort((left, right) => asNumber(right.exitTime, 0) - asNumber(left.exitTime, 0)).slice(0, limit);
  const totalPnl = sorted.reduce((sum, row) => sum + asNumber(row.realizedPnl, 0), 0);
  const wins = sorted.filter((row) => asNumber(row.realizedPnl, 0) > 0).length;

  return {
    generatedAt: new Date().toISOString(),
    periodHours,
    rows: sorted,
    summary: {
      closedCount: sorted.length,
      wins,
      losses: Math.max(0, sorted.length - wins),
      winRatePercent: sorted.length > 0 ? Number(((wins / sorted.length) * 100).toFixed(2)) : 0,
      totalRealizedPnl: Number(totalPnl.toFixed(8)),
    },
  };
};

const renderSimpleChartSvg = (input: {
  candles: Array<{ ts: number; open: number; high: number; low: number; close: number }>;
  markers: Array<{ ts: number; price: number; kind: 'entry' | 'exit'; side: string }>;
  title: string;
  width: number;
  height: number;
}): string => {
  const width = Math.max(640, Math.floor(input.width));
  const height = Math.max(360, Math.floor(input.height));
  const left = 50;
  const right = 20;
  const top = 30;
  const bottom = 36;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const candles = input.candles;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  const priceRange = Math.max(1e-9, maxPrice - minPrice);
  const xStep = plotW / Math.max(1, candles.length - 1);
  const candleBodyW = Math.max(2, Math.min(8, xStep * 0.7));

  const y = (price: number): number => top + ((maxPrice - price) / priceRange) * plotH;

  const candleSvg = candles.map((c, idx) => {
    const x = left + idx * xStep;
    const up = c.close >= c.open;
    const color = up ? '#0a7f4f' : '#b3261e';
    const yOpen = y(c.open);
    const yClose = y(c.close);
    const yHigh = y(c.high);
    const yLow = y(c.low);
    const bodyY = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    return `<g><line x1="${x.toFixed(2)}" y1="${yHigh.toFixed(2)}" x2="${x.toFixed(2)}" y2="${yLow.toFixed(2)}" stroke="${color}" stroke-width="1"/><rect x="${(x - candleBodyW / 2).toFixed(2)}" y="${bodyY.toFixed(2)}" width="${candleBodyW.toFixed(2)}" height="${bodyH.toFixed(2)}" fill="${color}" opacity="0.85"/></g>`;
  }).join('');

  const markerSvg = input.markers.map((m) => {
    const idx = candles.findIndex((c) => c.ts >= m.ts);
    if (idx < 0) return '';
    const x = left + idx * xStep;
    const yy = y(m.price);
    const fill = m.kind === 'entry' ? '#1565c0' : '#ef6c00';
    const label = m.kind === 'entry' ? (m.side.toLowerCase() === 'short' ? 'SE' : 'LE') : (m.side.toLowerCase() === 'short' ? 'SX' : 'LX');
    return `<g><circle cx="${x.toFixed(2)}" cy="${yy.toFixed(2)}" r="4" fill="${fill}"/><text x="${(x + 6).toFixed(2)}" y="${(yy - 6).toFixed(2)}" font-size="10" fill="${fill}">${label}</text></g>`;
  }).join('');

  const axis = `<rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="#ffffff" stroke="#d0d7de"/><text x="${left}" y="18" font-size="14" fill="#111">${input.title.replace(/[&<>\"]/g, '')}</text><text x="${left}" y="${height - 10}" font-size="11" fill="#444">Bars: ${candles.length}</text><text x="${width - 200}" y="${height - 10}" font-size="11" fill="#444">Price ${minPrice.toFixed(6)} .. ${maxPrice.toFixed(6)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f7f9fb"/>${axis}${candleSvg}${markerSvg}</svg>`;
};

export const getAlgofundChartSnapshot = async (options: {
  tenantId?: number;
  systemName?: string;
  strategyId?: number;
  candles?: number;
  width?: number;
  height?: number;
  interval?: string;
}) => {
  const systems = await resolveAlgofundSystemTargets({
    tenantId: asNumber(options.tenantId, 0) || undefined,
    systemName: asString(options.systemName, '') || undefined,
  });
  const system = systems[0];
  if (!system) {
    throw new Error('No resolved system for snapshot');
  }

  const row = options.strategyId
    ? await db.get(
      `SELECT s.*
       FROM trading_system_members tsm
       JOIN strategies s ON s.id = tsm.strategy_id
       WHERE tsm.system_id = ? AND s.id = ?
       LIMIT 1`,
      [system.systemId, asNumber(options.strategyId, 0)]
    ) as Record<string, unknown> | undefined
    : await db.get(
      `SELECT s.*
       FROM trading_system_members tsm
       JOIN strategies s ON s.id = tsm.strategy_id
       WHERE tsm.system_id = ? AND COALESCE(tsm.is_enabled, 1) = 1
       ORDER BY tsm.id ASC
       LIMIT 1`,
      [system.systemId]
    ) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error('No strategy found for requested snapshot');
  }

  const strategyId = asNumber(row.id, 0);
  const interval = asString(options.interval || row.interval, '4h');
  const bars = Math.max(50, Math.min(500, Math.floor(asNumber(options.candles, 150))));
  const base = asString(row.base_symbol, '');
  const quote = asString(row.quote_symbol, '');
  const symbol = quote ? `${base}/${quote}` : base;
  let rawCandles: unknown[] = [];
  try {
    rawCandles = await getMarketData(system.apiKeyName, symbol, interval, bars);
  } catch (error) {
    const err = error as Error;
    logger.warn(`[SaaS] chart snapshot market-data fallback for ${system.apiKeyName}/${symbol}: ${err.message}`);
  }

  const normalized = (Array.isArray(rawCandles) ? rawCandles : [])
    .map((item) => {
      if (!Array.isArray(item) || item.length < 5) return null;
      const ts = asNumber(item[0], 0);
      const open = asNumber(item[1], 0);
      const high = asNumber(item[2], 0);
      const low = asNumber(item[3], 0);
      const close = asNumber(item[4], 0);
      if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        return null;
      }
      return { ts, open, high, low, close };
    })
    .filter((item): item is { ts: number; open: number; high: number; low: number; close: number } => Boolean(item))
    .sort((a, b) => a.ts - b.ts)
    .slice(-bars);

  if (normalized.length < 20 && base && quote) {
    try {
      const [baseRawCandles, quoteRawCandles] = await Promise.all([
        getMarketData(system.apiKeyName, base, interval, bars),
        getMarketData(system.apiKeyName, quote, interval, bars),
      ]);

      const normalizeCandles = (items: unknown[]) => (Array.isArray(items) ? items : [])
        .map((item) => {
          if (!Array.isArray(item) || item.length < 5) return null;
          const ts = asNumber(item[0], 0);
          const open = asNumber(item[1], 0);
          const high = asNumber(item[2], 0);
          const low = asNumber(item[3], 0);
          const close = asNumber(item[4], 0);
          if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            return null;
          }
          return { ts, open, high, low, close };
        })
        .filter((item): item is { ts: number; open: number; high: number; low: number; close: number } => Boolean(item))
        .sort((a, b) => a.ts - b.ts)
        .slice(-bars);

      const baseCandles = normalizeCandles(baseRawCandles);
      const quoteCandles = normalizeCandles(quoteRawCandles);
      const quoteByTs = new Map(quoteCandles.map((item) => [item.ts, item] as const));
      const syntheticCandles = baseCandles
        .map((baseCandle) => {
          const quoteCandle = quoteByTs.get(baseCandle.ts);
          if (!quoteCandle) return null;
          if (quoteCandle.open <= 0 || quoteCandle.high <= 0 || quoteCandle.low <= 0 || quoteCandle.close <= 0) {
            return null;
          }
          return {
            ts: baseCandle.ts,
            open: baseCandle.open / quoteCandle.open,
            high: baseCandle.high / quoteCandle.high,
            low: baseCandle.low / quoteCandle.low,
            close: baseCandle.close / quoteCandle.close,
          };
        })
        .filter((item): item is { ts: number; open: number; high: number; low: number; close: number } => Boolean(item))
        .slice(-bars);

      if (syntheticCandles.length >= 2) {
        normalized.splice(0, normalized.length, ...syntheticCandles);
      }
    } catch (error) {
      const err = error as Error;
      logger.warn(`[SaaS] synthetic chart snapshot fallback failed for ${system.apiKeyName}/${base}/${quote}: ${err.message}`);
    }
  }

  if (normalized.length < 20) {
    const fallbackTradeRows = await db.all(
      `SELECT actual_time, actual_price
       FROM live_trade_events
       WHERE strategy_id = ? AND actual_time > 0 AND actual_price > 0
       ORDER BY actual_time ASC
       LIMIT ?`,
      [strategyId, bars]
    ) as Array<Record<string, unknown>>;

    if (Array.isArray(fallbackTradeRows) && fallbackTradeRows.length >= 2) {
      const rebuilt = fallbackTradeRows
        .map((trade) => ({
          ts: asNumber(trade.actual_time, 0),
          price: asNumber(trade.actual_price, 0),
        }))
        .filter((trade) => trade.ts > 0 && trade.price > 0)
        .slice(-bars);

      for (let idx = 0; idx < rebuilt.length; idx += 1) {
        const current = rebuilt[idx];
        const prev = rebuilt[idx - 1] || current;
        const open = prev.price;
        const close = current.price;
        const high = Math.max(open, close);
        const low = Math.min(open, close);
        normalized.push({ ts: current.ts, open, high, low, close });
      }
    }
  }

  if (normalized.length < 2) {
    logger.warn(`[SaaS] chart snapshot: not enough candles (${normalized.length}) for ${system.systemName} / strategy ${strategyId} / ${symbol}`);
    return {
      generatedAt: new Date().toISOString(),
      system: { id: system.systemId, name: system.systemName, apiKeyName: system.apiKeyName },
      strategy: { id: strategyId, name: asString(row.name, ''), symbol, interval },
      candlesCount: 0,
      markersCount: 0,
      svg: '',
      svgBase64: '',
    };
  }

  const fromTs = normalized[0].ts;
  const toTs = normalized[normalized.length - 1].ts;
  const eventRows = await db.all(
    `SELECT trade_type, side, actual_time, actual_price, source_symbol
     FROM live_trade_events
     WHERE strategy_id = ? AND actual_time BETWEEN ? AND ?
     ORDER BY actual_time ASC`,
    [strategyId, fromTs, toTs]
  ) as Array<Record<string, unknown>>;

  const markers = (Array.isArray(eventRows) ? eventRows : []).map((rowEvent) => ({
    ts: asNumber(rowEvent.actual_time, 0),
    price: asNumber(rowEvent.actual_price, 0),
    kind: asString(rowEvent.trade_type, '').toLowerCase() === 'exit' ? 'exit' as const : 'entry' as const,
    side: asString(rowEvent.side, ''),
  })).filter((item) => item.ts > 0 && Number.isFinite(item.price));

  const svg = renderSimpleChartSvg({
    candles: normalized,
    markers,
    title: `${system.systemName} :: ${asString(row.name, `Strategy ${strategyId}`)} :: ${symbol} ${interval}`,
    width: Math.max(640, Math.floor(asNumber(options.width, 1280))),
    height: Math.max(360, Math.floor(asNumber(options.height, 720))),
  });

  return {
    generatedAt: new Date().toISOString(),
    system: {
      id: system.systemId,
      name: system.systemName,
      apiKeyName: system.apiKeyName,
    },
    strategy: {
      id: strategyId,
      name: asString(row.name, ''),
      symbol,
      interval,
    },
    candlesCount: normalized.length,
    markersCount: markers.length,
    svg,
    svgBase64: Buffer.from(svg, 'utf-8').toString('base64'),
  };
};

// Legacy block removed.


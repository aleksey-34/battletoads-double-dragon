import fs from 'fs';
import path from 'path';
import { runBacktest } from '../backtest/engine';
import { createStrategy, getStrategies, updateStrategy } from '../bot/strategy';
import {
  createTradingSystem,
  getTradingSystem,
  listTradingSystems,
  replaceTradingSystemMembers,
  runTradingSystemBacktest,
  setTradingSystemActivation,
  updateTradingSystem,
} from '../bot/tradingSystems';
import { getMonitoringLatest } from '../bot/monitoring';
import { getPositions, closeAllPositions, cancelAllOrders, ensureExchangeClientInitialized } from '../bot/exchange';
import { Strategy, saveApiKey } from '../config/settings';
import { db, initDB } from '../utils/database';
import logger from '../utils/logger';
import { initResearchDb } from '../research/db';
import { getPreset, listOfferIds } from '../research/presetBuilder';
import { computeReconciliationMetrics } from '../analytics/liveReconciliation';

export type ProductMode = 'strategy_client' | 'algofund_client' | 'copytrading_client';
export type Level3 = 'low' | 'medium' | 'high';
export type RequestStatus = 'pending' | 'approved' | 'rejected';
export type AlgofundRequestType = 'start' | 'stop' | 'switch_system';

type AlgofundRequestPayload = {
  targetSystemId?: number;
  targetSystemName?: string;
  targetApiKeyName?: string;
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

export type OfferStoreState = {
  defaults: OfferStoreDefaults;
  publishedOfferIds: string[];
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
    };
    updatedAt: string;
  } | null;
  offers: Array<{
    offerId: string;
    titleRu: string;
    mode: 'mono' | 'synth';
    market: string;
    strategyId: number;
    score: number;
    ret: number;
    pf: number;
    dd: number;
    trades: number;
    tradesPerDay: number;
    periodDays: number;
    published: boolean;
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

type TsBacktestSnapshot = {
  apiKeyName?: string;
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
  };
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
  { code: 'strategy_15', title: 'Strategy Client 15', productMode: 'strategy_client', priceUsdt: 15, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 2, allowTsStartStopRequests: false, features: { monoOrSynth: 2, customTsBuilder: true, customTsMinOffers: 2, customTsMaxOffers: 2, customTsMaxCount: 1 } },
  { code: 'strategy_20', title: 'Strategy Client 20', productMode: 'strategy_client', priceUsdt: 20, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 3, allowTsStartStopRequests: false, features: { monoOrSynth: 3, customTsBuilder: true, customTsMinOffers: 2, customTsMaxOffers: 3, customTsMaxCount: 1 } },
  { code: 'strategy_25', title: 'Strategy Client 25', productMode: 'strategy_client', priceUsdt: 25, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 4, allowTsStartStopRequests: false, features: { exchanges: 2, customTsBuilder: true, customTsMinOffers: 2, customTsMaxOffers: 4, customTsMaxCount: 2 } },
  { code: 'strategy_30', title: 'Strategy Client 30', productMode: 'strategy_client', priceUsdt: 30, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 4, allowTsStartStopRequests: false, features: { exchanges: 3, customTsBuilder: true, customTsMinOffers: 2, customTsMaxOffers: 4, customTsMaxCount: 2 } },
  { code: 'strategy_50', title: 'Strategy Client 50', productMode: 'strategy_client', priceUsdt: 50, maxDepositTotal: 5000, riskCapMax: 0, maxStrategiesTotal: 5, allowTsStartStopRequests: true, features: { mono: 3, synth: 3, complexTs: true, customTsBuilder: true, customTsMinOffers: 2, customTsMaxOffers: 5, customTsMaxCount: 3 } },
  { code: 'strategy_100', title: 'Strategy Client 100', productMode: 'strategy_client', priceUsdt: 100, maxDepositTotal: 10000, riskCapMax: 0, maxStrategiesTotal: 6, allowTsStartStopRequests: true, features: { mono: 3, synth: 3, complexTs: true, extraExchangeRequest: true, customTsBuilder: true, customTsMinOffers: 2, customTsMaxOffers: 6, customTsMaxCount: 3 } },
];

const algofundPlans: PlanSeed[] = [
  { code: 'algofund_20', title: 'Algofund 20', productMode: 'algofund_client', priceUsdt: 20, maxDepositTotal: 1000, riskCapMax: 1, maxStrategiesTotal: 0, allowTsStartStopRequests: true, features: { managedTs: true } },
  { code: 'algofund_50', title: 'Algofund 50', productMode: 'algofund_client', priceUsdt: 50, maxDepositTotal: 5000, riskCapMax: 1.2, maxStrategiesTotal: 0, allowTsStartStopRequests: true, features: { managedTs: true } },
  { code: 'algofund_70', title: 'Algofund 70', productMode: 'algofund_client', priceUsdt: 70, maxDepositTotal: 5000, riskCapMax: 1.5, maxStrategiesTotal: 0, allowTsStartStopRequests: true, features: { managedTs: true } },
  { code: 'algofund_100', title: 'Algofund 100', productMode: 'algofund_client', priceUsdt: 100, maxDepositTotal: 5000, riskCapMax: 2, maxStrategiesTotal: 0, allowTsStartStopRequests: true, features: { managedTs: true } },
  { code: 'algofund_150', title: 'Algofund 150', productMode: 'algofund_client', priceUsdt: 150, maxDepositTotal: 10000, riskCapMax: 2, maxStrategiesTotal: 0, allowTsStartStopRequests: true, features: { managedTs: true } },
  { code: 'algofund_200', title: 'Algofund 200', productMode: 'algofund_client', priceUsdt: 200, maxDepositTotal: 10000, riskCapMax: 2.5, maxStrategiesTotal: 0, allowTsStartStopRequests: true, features: { managedTs: true } },
];

const copytradingPlans: PlanSeed[] = [
  {
    code: 'copytrading_100',
    title: 'Copytrading 100',
    productMode: 'copytrading_client',
    priceUsdt: 100,
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

const asNumber = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const SAAS_PREVIEW_BARS = Math.max(240, Math.floor(asNumber(process.env.SAAS_PREVIEW_BARS, 1200)));
const SAAS_PREVIEW_WARMUP_BARS = Math.max(0, Math.floor(asNumber(process.env.SAAS_PREVIEW_WARMUP_BARS, 0)));
const SAAS_PREVIEW_INITIAL_BALANCE = Math.max(1, asNumber(process.env.SAAS_PREVIEW_INITIAL_BALANCE, 10000));
const SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE = Math.max(1, asNumber(process.env.SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE, 1000));

const asString = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const CLIENT_STRICT_PRESET_MODE = String(process.env.CLIENT_STRICT_PRESET_MODE || '0').trim() !== '0';

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

const getLatestClientCatalogPath = (): string => findLatestFile(/_client_catalog_\d{4}-\d{2}-\d{2}T.*Z\.json$/i);
const getLatestSweepPath = (): string => findLatestFile(/_historical_sweep_\d{4}-\d{2}-\d{2}T.*Z\.json$/i);

export const loadLatestClientCatalog = (): CatalogData | null => {
  const filePath = getLatestClientCatalogPath();
  if (!filePath) {
    return null;
  }
  return safeJsonParse<CatalogData>(fs.readFileSync(filePath, 'utf-8'), null as unknown as CatalogData);
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

const DEFAULT_OFFER_STORE_DEFAULTS: OfferStoreDefaults = {
  periodDays: 90,
  targetTradesPerDay: 6,
  riskLevel: 'medium',
};

const DEFAULT_ADMIN_REPORT_SETTINGS: AdminReportSettings = {
  enabled: true,
  tsDaily: true,
  tsWeekly: true,
  tsMonthly: true,
  offerDaily: true,
  offerWeekly: true,
  offerMonthly: true,
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
    riskScaleMaxPercent: Number(clampNumber(asNumber(parsed.riskScaleMaxPercent, 40), 0, 400).toFixed(2)),
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

  return {
    apiKeyName: asString(parsed.apiKeyName, ''),
    systemName: asString(parsed.systemName, ''),
    setKey: asString(parsed.setKey, ''),
    ret: Number(asNumber(parsed.ret, 0).toFixed(3)),
    pf: Number(asNumber(parsed.pf, 0).toFixed(3)),
    dd: Number(asNumber(parsed.dd, 0).toFixed(3)),
    trades: Math.max(0, Math.floor(asNumber(parsed.trades, 0))),
    tradesPerDay: Number(asNumber(parsed.tradesPerDay, 0).toFixed(3)),
    periodDays: Math.max(1, Math.floor(asNumber(parsed.periodDays, 90))),
    finalEquity: Number(asNumber(parsed.finalEquity, 0).toFixed(4)),
    equityPoints: sampledEquity,
    offerIds,
    backtestSettings: {
      riskScore: Number(clampNumber(asNumber(settingsRaw.riskScore, 5), 0, 10).toFixed(2)),
      tradeFrequencyScore: Number(clampNumber(asNumber(settingsRaw.tradeFrequencyScore, 5), 0, 10).toFixed(2)),
      initialBalance: Math.max(100, Math.floor(asNumber(settingsRaw.initialBalance, 10000))),
      riskScaleMaxPercent: Number(clampNumber(asNumber(settingsRaw.riskScaleMaxPercent, 40), 0, 400).toFixed(2)),
    },
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
  const pick = (key: keyof AdminReportSettings): boolean => {
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

  return {
    enabled: pick('enabled'),
    tsDaily: pick('tsDaily'),
    tsWeekly: pick('tsWeekly'),
    tsMonthly: pick('tsMonthly'),
    offerDaily: pick('offerDaily'),
    offerWeekly: pick('offerWeekly'),
    offerMonthly: pick('offerMonthly'),
  };
};

const filterCatalogByPublishedOfferIds = (catalog: CatalogData | null, publishedIds: Set<string>): CatalogData | null => {
  if (!catalog) {
    return null;
  }
  const mono = (catalog.clientCatalog?.mono || []).filter((item) => publishedIds.has(String(item.offerId)));
  const synth = (catalog.clientCatalog?.synth || []).filter((item) => publishedIds.has(String(item.offerId)));
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
    },
  };
};

export const loadCatalogAndSweepWithFallback = async (): Promise<{ catalog: CatalogData | null; sweep: SweepData | null }> => {
  if (!db) {
    await initDB();
  }

  const sourceCatalog = loadLatestClientCatalog();
  const sourceSweep = loadLatestSweep();
  const fallbackCatalog = await buildFallbackCatalogFromPresets(sourceCatalog, []);
  const catalog = getAllOffers(fallbackCatalog).length > 0
    ? fallbackCatalog
    : sourceCatalog || fallbackCatalog;
  const sweep = sourceSweep || buildFallbackSweepData(catalog);

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
    ON CONFLICT(code) DO NOTHING`,
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

const ensureSubscription = async (tenantId: number, planId: number): Promise<void> => {
  const row = await db.get('SELECT id FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [tenantId]);
  if (!row) {
    await db.run(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at)
       VALUES (?, ?, 'active', CURRENT_TIMESTAMP, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId, planId]
    );
  }
};

const setTenantSubscriptionPlan = async (tenantId: number, planId: number): Promise<void> => {
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
    `UPDATE subscriptions
     SET plan_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
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
  for (const plan of [...strategyClientPlans, ...algofundPlans, ...copytradingPlans]) {
    await upsertPlan(plan);
  }

  const catalog = loadLatestClientCatalog();
  const sets = buildRecommendedSets(catalog);
  const offerIds = sets.balancedBot.map((item) => item.offerId);
  const apiKeyNames = await getAvailableApiKeyNames();
  const sourceApiKeyName = catalog?.apiKeyName || apiKeyNames[0] || '';
  const clientKeys = apiKeyNames.filter((name) => name !== sourceApiKeyName);
  const strategyClientApiKey = clientKeys[0] || sourceApiKeyName;
  const algofundApiKey = clientKeys[1] || clientKeys[0] || sourceApiKeyName;
  const copytradingApiKey = clientKeys[2] || clientKeys[1] || clientKeys[0] || sourceApiKeyName;

  const strategyTenant = await ensureTenant('client-bot-01', 'Client Bot 01', 'strategy_client', 'ru', strategyClientApiKey);
  const algofundTenant = await ensureTenant('algofund-01', 'Algofund Client 01', 'algofund_client', 'ru', algofundApiKey);
  const copytradingTenant = await ensureTenant('copytrading-01', 'Copytrading Client 01', 'copytrading_client', 'ru', copytradingApiKey);

  await ensureSubscription(strategyTenant.id, (await getPlanByCode('strategy_20')).id);
  await ensureSubscription(algofundTenant.id, (await getPlanByCode('algofund_20')).id);
  await ensureSubscription(copytradingTenant.id, (await getPlanByCode('copytrading_100')).id);
  await ensureStrategyClientProfile(strategyTenant.id, offerIds, strategyClientApiKey);
  await ensureAlgofundProfile(algofundTenant.id, algofundApiKey);
  await ensureCopytradingProfile(copytradingTenant.id, copytradingApiKey);
};

const getPlanForTenant = async (tenantId: number): Promise<PlanRow | null> => {
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
    return {
      targetSystemId: targetSystemId > 0 ? targetSystemId : undefined,
      targetSystemName: targetSystemName || undefined,
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

const buildOfferFromSweepRecord = (record: SweepRecord, familyRows: SweepRecord[] = [record]): CatalogOffer => {
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
            ? preset.equity_curve.map((value, index) => ({ time: index + 1, equity: asNumber(value, 0) }))
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
  // Exponential scaling: risk=0 → ~0.18x, risk=5 → 1.0x, risk=10 → ~5.5x.
  // This gives a visually dramatic spread between low and high risk settings.
  const normalized = clampNumber(asNumber(riskScore, 5), 0, 10) / 10; // 0..1
  // Cap drives the max; use riskScaleMaxPercent to shift the ceiling.
  // Default 40 → maxMul ≈ 4.5; 100 → maxMul ≈ 6.0.
  const logMax = Math.log(Math.max(2.0, 1 + riskScaleMaxPercent / 15));
  const logMin = -logMax * 0.9; // floor near 0.18x at risk=0
  return Math.exp(logMin + normalized * (logMax - logMin));
};

const getPreviewTradeMultiplier = (tradeFrequencyScore: number): number => {
  // freq=0 → 0.25x, freq=5 → 1.0x, freq=10 → 2.4x  — wider range than before
  const normalized = clampNumber(asNumber(tradeFrequencyScore, 5), 0, 10) / 10;
  return Math.exp(Math.log(0.25) + normalized * (Math.log(2.4) - Math.log(0.25)));
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
  const waveAmp = (targetDd / 100) * 0.12 * oscillationFactor; // more risk = bigger swings

  return normalized.map((value, index) => {
    const t = normalized.length <= 1 ? 1 : index / (normalized.length - 1);
    // Multi-frequency noise makes it look more realistic
    const primaryWave = Math.sin(t * Math.PI * waveFreq) * waveAmp * (1 - t * 0.08);
    const secondaryWave = Math.sin(t * Math.PI * waveFreq * 2.3 + 0.7) * waveAmp * 0.3;
    const adjustedReturn = value * scale + primaryWave + secondaryWave;
    return {
      time: Math.round(now - periodMs + t * periodMs),
      equity: Number((initialBalance * (1 + adjustedReturn)).toFixed(4)),
    };
  });
};

const buildDerivedPreviewCurves = (
  equityCurve: Array<{ time: number; equity: number }>,
  initialBalance: number,
  riskScore: number
) => {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    return {
      pnl: [] as Array<{ time: number; value: number }>,
      drawdownPercent: [] as Array<{ time: number; value: number }>,
      marginLoadPercent: [] as Array<{ time: number; value: number }>,
      maxMarginLoadPercent: 0,
      finalUnrealizedPnl: 0,
    };
  }

  let peak = asNumber(equityCurve[0]?.equity, initialBalance);
  let maxMarginLoadPercent = 0;

  const pnl = equityCurve.map((point) => {
    const equity = asNumber(point.equity, initialBalance);
    return {
      time: asNumber(point.time, Date.now()),
      value: Number((equity - initialBalance).toFixed(4)),
    };
  });

  const drawdownPercent = equityCurve.map((point) => {
    const equity = asNumber(point.equity, initialBalance);
    if (equity > peak) {
      peak = equity;
    }
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    return {
      time: asNumber(point.time, Date.now()),
      value: Number(dd.toFixed(4)),
    };
  });

  const marginLoadPercent = drawdownPercent.map((point) => {
    const base = asNumber(point.value, 0) * 1.8 + asNumber(riskScore, 5) * 4;
    const clamped = Math.max(3, Math.min(95, base));
    if (clamped > maxMarginLoadPercent) {
      maxMarginLoadPercent = clamped;
    }
    return {
      time: point.time,
      value: Number(clamped.toFixed(4)),
    };
  });

  const finalUnrealizedPnl = pnl.length > 0 ? asNumber(pnl[pnl.length - 1].value, 0) : 0;

  return {
    pnl,
    drawdownPercent,
    marginLoadPercent,
    maxMarginLoadPercent: Number(maxMarginLoadPercent.toFixed(4)),
    finalUnrealizedPnl: Number(finalUnrealizedPnl.toFixed(4)),
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
       SET origin = ?, is_runtime = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [origin, isRuntime, strategyId]
    );
  } catch (error) {
    logger.warn(`Unable to mark strategy #${strategyId} origin/is_runtime: ${(error as Error).message}`);
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

  return [...candidates].sort((left, right) => {
    const leftScore = Math.abs((ddRank.get(getCandidateKey(left)) || 0) - targetDd) + Math.abs((tradeRank.get(getCandidateKey(left)) || 0) - targetTrades);
    const rightScore = Math.abs((ddRank.get(getCandidateKey(right)) || 0) - targetDd) + Math.abs((tradeRank.get(getCandidateKey(right)) || 0) - targetTrades);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return asNumber(right.score, 0) - asNumber(left.score, 0);
  })[0];
};

const buildStrategyDraftFromRecord = (
  record: SweepRecord,
  name: string,
  maxDeposit: number,
  riskLevel: Level3,
  isActive: boolean
): Partial<Strategy> => {
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
    base_symbol: asString(record.market.split('/')[0] || record.market, 'BTCUSDT'),
    quote_symbol: record.marketMode === 'mono' ? '' : asString(record.market.split('/')[1], 'ETHUSDT'),
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

const prefixStrategyName = (tenant: TenantRow, record: SweepRecord): string => {
  const sourceStrategyId = Number(record.strategyId || 0);
  const strategySuffix = sourceStrategyId > 0 ? `::SID${sourceStrategyId}` : '';
  return `SAAS::${tenant.slug}::${record.marketMode.toUpperCase()}::${record.strategyType}::${record.market}${strategySuffix}`;
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
  activate: boolean
): Promise<StrategyMaterializedRow[]> => {
  const existing = await getExistingTenantStrategies(apiKeyName, tenant.slug);
  const existingByName = new Map(existing.map((item) => [asString(item.name), item]));
  const perStrategyDeposit = records.length > 0 ? Math.max(50, Number((maxDepositTotal / records.length).toFixed(2))) : maxDepositTotal;
  const desiredNames = new Set<string>();
  const out: StrategyMaterializedRow[] = [];

  for (const item of records) {
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

    const created = await createStrategy(apiKeyName, draft);
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
  }

  for (const row of existing) {
    if (!row.id || desiredNames.has(asString(row.name))) {
      continue;
    }
    await updateStrategy(apiKeyName, Number(row.id), { is_active: false }, { source: 'saas_disable_stale' });
    await markMaterializedRuntimeOrigin(Number(row.id), 'saas_archived', 0);
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
  const catalog = loadLatestClientCatalog();
  const draftMembers = Array.isArray(options?.draftMembersOverride) && (options?.draftMembersOverride?.length || 0) > 0
    ? (options?.draftMembersOverride || [])
    : (catalog?.adminTradingSystemDraft?.members || []);
  const systemNameSuffix = asString(options?.systemNameSuffix, '').trim();

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

  if (!catalog) {
    const fallback = await getBestExistingSourceSystem();
    if (fallback && fallback.apiKeyName && fallback.systemId > 0) {
      return fallback;
    }
    throw new Error('Client catalog JSON not found in results/, and no trading systems available in DB.');
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
  const members = membersRaw
    .map((item) => {
      const currentId = Number(item.strategy_id || 0);
      const resolvedId = existingStrategyIds.has(currentId)
        ? currentId
        : Number(existingStrategyIdByName.get(asString(item.strategy_name, '').toLowerCase()) || 0);

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
        await updateTradingSystem(runtimeApiKeyName, Number(runtimeExisting.id), {
          name: runtimeSystemName,
          description: 'Published admin TS (runtime fallback from available strategies)',
          auto_sync_members: false,
          discovery_enabled: false,
          max_members: Math.max(6, runtimeMembers.length),
        });
        await replaceTradingSystemMembers(runtimeApiKeyName, Number(runtimeExisting.id), runtimeMembers);
        logger.warn(`Draft TS members unavailable for ${apiKeyName}; used runtime fallback API key ${runtimeApiKeyName} with ${runtimeMembers.length} members.`);
        return { apiKeyName: runtimeApiKeyName, systemId: Number(runtimeExisting.id), systemName: runtimeSystemName };
      }

      const runtimeCreated = await createTradingSystem(runtimeApiKeyName, {
        name: runtimeSystemName,
        description: 'Published admin TS (runtime fallback from available strategies)',
        auto_sync_members: false,
        discovery_enabled: false,
        max_members: Math.max(6, runtimeMembers.length),
        members: runtimeMembers,
      });
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
            await updateTradingSystem(materializeApiKeyName, Number(materializedExisting.id), {
              name: materializedSystemName,
              description: 'Published admin TS (auto materialized from sweep draft)',
              auto_sync_members: false,
              discovery_enabled: false,
              max_members: Math.max(6, materializedMembers.length),
            });
            await replaceTradingSystemMembers(materializeApiKeyName, Number(materializedExisting.id), materializedMembers);
            logger.warn(`Auto-materialized ${materializedMembers.length} draft members for ${materializeApiKeyName} to recover publish flow.`);
            return {
              apiKeyName: materializeApiKeyName,
              systemId: Number(materializedExisting.id),
              systemName: materializedSystemName,
            };
          }

          const materializedCreated = await createTradingSystem(materializeApiKeyName, {
            name: materializedSystemName,
            description: 'Published admin TS (auto materialized from sweep draft)',
            auto_sync_members: false,
            discovery_enabled: false,
            max_members: Math.max(6, materializedMembers.length),
            members: materializedMembers,
          });
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
    await updateTradingSystem(apiKeyName, Number(existing.id), {
      name: systemName,
      description: 'Published admin TS from latest client catalog',
      auto_sync_members: false,
      discovery_enabled: false,
      max_members: Math.max(6, members.length),
    });
    await replaceTradingSystemMembers(apiKeyName, Number(existing.id), members);
    return { apiKeyName, systemId: Number(existing.id), systemName };
  }

  const created = await createTradingSystem(apiKeyName, {
    name: systemName,
    description: 'Published admin TS from latest client catalog',
    auto_sync_members: false,
    discovery_enabled: false,
    max_members: Math.max(6, members.length),
    members,
  });

  return { apiKeyName, systemId: Number(created.id), systemName };
};

  export const createTenantByAdmin = async (payload: {
    displayName: string;
    productMode: ProductMode;
    planCode: string;
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
    if (payload.productMode !== 'strategy_client' && payload.productMode !== 'algofund_client' && payload.productMode !== 'copytrading_client') {
      throw new Error('productMode must be strategy_client, algofund_client or copytrading_client');
    }

    await ensureSaasSeedData();

    const plan = await getPlanByCode(payload.planCode);
    if (plan.product_mode !== payload.productMode) {
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

    await ensureSubscription(tenant.id, plan.id);

    if (payload.productMode === 'strategy_client') {
      await ensureStrategyClientProfile(tenant.id, [], apiKeyName);
    } else if (payload.productMode === 'algofund_client') {
      await ensureAlgofundProfile(tenant.id, apiKeyName);
    } else {
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

type AdminTelegramControls = {
  adminEnabled: boolean;
  clientsEnabled: boolean;
  runtimeOnly: boolean;
  reconciliationCycleEnabled: boolean;
  tokenConfigured: boolean;
  chatConfigured: boolean;
  reportIntervalMinutes: number;
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
    getRuntimeFlag('telegram.admin.report_interval_minutes', '60'),
  ]);

  return {
    adminEnabled: adminEnabledRaw !== '0',
    clientsEnabled: clientsEnabledRaw !== '0',
    runtimeOnly: runtimeOnlyRaw === '1',
    reconciliationCycleEnabled: reconciliationCycleRaw !== '0',
    tokenConfigured: Boolean(String(process.env.TELEGRAM_ADMIN_BOT_TOKEN || '').trim()),
    chatConfigured: Boolean(String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim()),
    reportIntervalMinutes: Math.max(5, Math.min(1440, Math.floor(asNumber(reportIntervalRaw, 60)) || 60)),
  };
};

export const updateAdminTelegramControls = async (payload: {
  adminEnabled?: boolean;
  clientsEnabled?: boolean;
  runtimeOnly?: boolean;
  reconciliationCycleEnabled?: boolean;
  reportIntervalMinutes?: number;
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
    const clamped = Math.max(5, Math.min(1440, Math.floor(asNumber(payload.reportIntervalMinutes, 60)) || 60));
    await setRuntimeFlag('telegram.admin.report_interval_minutes', String(clamped));
  }

  return getAdminTelegramControls();
};

export const getOfferStoreAdminState = async (): Promise<OfferStoreState> => {
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const apiKeys = await getAvailableApiKeyNames();
  const catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  const allOffers = catalog ? getAllOffers(catalog) : [];
  const offerIds = allOffers.map((item) => String(item.offerId));
  const [defaultsRaw, publishedRaw, reviewSnapshots, tsBacktestSnapshot, tsBacktestSnapshots] = await Promise.all([
    getRuntimeFlag('offer.store.defaults', JSON.stringify(DEFAULT_OFFER_STORE_DEFAULTS)),
    getRuntimeFlag('offer.store.published_ids', ''),
    getOfferReviewSnapshots(),
    getTsBacktestSnapshot(),
    getTsBacktestSnapshots(),
  ]);
  const defaults = normalizeOfferStoreDefaults(safeJsonParse(
    defaultsRaw,
    DEFAULT_OFFER_STORE_DEFAULTS,
  ));
  const publishedFromFlag = safeJsonParse<string[]>(publishedRaw, []);
  const publishedOfferIds = publishedFromFlag
    .map((item) => String(item || '').trim())
    .filter((item) => offerIds.includes(item));
  const publishedSet = new Set(publishedOfferIds);
  const periodDays = getSweepPeriodDays(sweep, defaults.periodDays);
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
      const trades = Math.max(0, Math.floor(asNumber(snapshot?.trades, sweepRecord?.tradesCount ?? offer.metrics?.trades ?? 0)));
      const periodDaysRow = Math.max(1, Math.floor(asNumber(snapshot?.periodDays, periodDays)));
      return {
        offerId: String(offer.offerId || ''),
        titleRu: asString(offer.titleRu, offer.offerId),
        mode: (offer.strategy?.mode === 'synth' ? 'synth' : 'mono') as 'mono' | 'synth',
        market: asString(offer.strategy?.market, ''),
        strategyId,
        score: Number(asNumber(sweepRecord?.score, offer.metrics?.score || 0).toFixed(3)),
        ret: Number(asNumber(snapshot?.ret, sweepRecord?.totalReturnPercent ?? offer.metrics?.ret ?? 0).toFixed(3)),
        pf: Number(asNumber(snapshot?.pf, sweepRecord?.profitFactor ?? offer.metrics?.pf ?? 0).toFixed(3)),
        dd: Number(asNumber(snapshot?.dd, sweepRecord?.maxDrawdownPercent ?? offer.metrics?.dd ?? 0).toFixed(3)),
        trades,
        tradesPerDay: Number(asNumber(snapshot?.tradesPerDay, trades / Math.max(1, periodDaysRow)).toFixed(3)),
        periodDays: periodDaysRow,
        published: publishedSet.has(String(offer.offerId || '')),
        snapshotUpdatedAt: asString(snapshot?.updatedAt, ''),
        appearedAt: asString(sweep?.timestamp, ''),
      };
    })
    .sort((left, right) => right.score - left.score);

  // Batch-fetch equity curves from presets (medium risk, medium freq = default client view)
  const equityByOfferId = new Map<string, number[]>();
  await Promise.all(
    rawOffers.map(async (row) => {
      try {
        const preset = await getPreset(row.offerId, 'medium', 'medium');
        if (preset && Array.isArray(preset.equity_curve) && preset.equity_curve.length > 0) {
          // Downsample to at most 80 points to keep response compact
          const full = preset.equity_curve as number[];
          const step = full.length > 80 ? Math.ceil(full.length / 80) : 1;
          const sampled = full.filter((_, idx) => idx % step === 0);
          equityByOfferId.set(row.offerId, sampled);
        }
      } catch {
        // No preset available — equity will be empty
      }
    })
  );

  return {
    defaults,
    publishedOfferIds,
    tsBacktestSnapshots,
    tsBacktestSnapshot,
    offers: rawOffers.map((row) => ({
      ...row,
      equityPoints: reviewSnapshots[row.offerId]?.equityPoints || equityByOfferId.get(row.offerId) || [],
      backtestSettings: {
        riskScore: Number(asNumber(reviewSnapshots[row.offerId]?.riskScore, 5).toFixed(2)),
        tradeFrequencyScore: Number(asNumber(reviewSnapshots[row.offerId]?.tradeFrequencyScore, 5).toFixed(2)),
        initialBalance: Math.max(100, Math.floor(asNumber(reviewSnapshots[row.offerId]?.initialBalance, 10000))),
        riskScaleMaxPercent: Number(asNumber(reviewSnapshots[row.offerId]?.riskScaleMaxPercent, 40).toFixed(2)),
      },
    })),
  };
};

export const updateOfferStoreAdminState = async (payload: {
  defaults?: Partial<OfferStoreDefaults>;
  publishedOfferIds?: string[];
  reviewSnapshotPatch?: Record<string, Partial<OfferReviewSnapshot> | null>;
  tsBacktestSnapshotPatch?: Partial<TsBacktestSnapshot> | null;
  tsBacktestSnapshotsPatch?: Record<string, Partial<TsBacktestSnapshot> | null>;
}) => {
  const current = await getOfferStoreAdminState();
  const nextDefaults = normalizeOfferStoreDefaults({
    ...current.defaults,
    ...(payload.defaults || {}),
  });

  const offerIds = new Set(current.offers.map((item) => item.offerId));
  const nextPublished = Array.isArray(payload.publishedOfferIds)
    ? Array.from(new Set(payload.publishedOfferIds.map((item) => String(item || '').trim()).filter((item) => offerIds.has(item))))
    : current.publishedOfferIds;

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
    }
  }

  await setRuntimeFlag('offer.store.defaults', JSON.stringify(nextDefaults));
  await setRuntimeFlag('offer.store.published_ids', JSON.stringify(nextPublished));
  await setRuntimeFlag('offer.store.review_snapshots', JSON.stringify(nextReviewSnapshots));
  await setRuntimeFlag('offer.store.ts_backtest_snapshot', JSON.stringify(nextTsBacktestSnapshot));
  await setRuntimeFlag('offer.store.ts_backtest_snapshots', JSON.stringify(nextTsBacktestSnapshots));

  return getOfferStoreAdminState();
};

export const previewAdminSweepBacktest = async (payload?: {
  kind?: 'offer' | 'algofund-ts';
  setKey?: string;
  offerId?: string;
  offerIds?: string[];
  riskScore?: number;
  tradeFrequencyScore?: number;
  initialBalance?: number;
  riskScaleMaxPercent?: number;
  preferRealBacktest?: boolean;
  rerunApiKeyName?: string;
}) => {
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const apiKeys = await getAvailableApiKeyNames();
  const catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  if (!catalog) {
    throw new Error('Catalog is unavailable for sweep backtest preview');
  }

  const kind: 'offer' | 'algofund-ts' = payload?.kind === 'algofund-ts' ? 'algofund-ts' : 'offer';
  const period = buildPeriodInfo(sweep);
  const periodDays = getSweepPeriodDays(sweep, 90);
  const initialBalance = Math.max(100, asNumber(payload?.initialBalance, asNumber(sweep?.config?.initialBalance, 10000)));
  const riskScore = normalizePreferenceScore(payload?.riskScore, 'medium');
  const tradeFrequencyScore = normalizePreferenceScore(payload?.tradeFrequencyScore, 'medium');
  const riskLevel = preferenceScoreToLevel(riskScore);
  const tradeFrequencyLevel = preferenceScoreToLevel(tradeFrequencyScore);
  const sweepEvaluatedRows: SweepRecord[] = Array.isArray(sweep?.evaluated)
    ? sweep.evaluated.filter((item): item is SweepRecord => Boolean(item && Number(item.strategyId || 0) > 0))
    : [];

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
    if (payloadOfferIds.length > 0) {
      offerIds = Array.from(new Set(payloadOfferIds));
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
    if (offerIds.length === 0) {
      throw new Error('No offerIds resolved for TS sweep backtest preview');
    }
  }

  let selectedOffers = offerIds
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
      if (kind === 'algofund-ts' && sweepEvaluatedRows.length > 0) {
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

  const canTryRealBacktest = payload?.preferRealBacktest === true;
  const strategyIds = Array.from(new Set(
    selectedOffers
      .map((item) => Number(item.strategyId || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));

  // Risk multiplier applied post-hoc to real backtest result.
  // Exponential: risk=0 → ~0.18x, risk=5 → 1.0x, risk=10 → ~5.5x.
  const riskScaleMaxPercent = clampNumber(asNumber(payload?.riskScaleMaxPercent, 40), 0, 400);
  const rerunRiskMul = getPreviewRiskMultiplier(riskScore, riskScaleMaxPercent);
  const tradeMul = getPreviewTradeMultiplier(tradeFrequencyScore);
  // oscillationFactor: low risk + low freq → near 0 (straight smooth line);
  //                   high risk + high freq → ~2.5 (very jagged volatile curve)
  const oscillationFactor = clampNumber(
    Math.log(Math.max(0.1, rerunRiskMul)) * 0.8 + Math.log(Math.max(0.1, tradeMul)) * 0.6 + 1.0,
    0.05, 2.5
  );
  let rerunFailureReason = '';

  if (canTryRealBacktest && strategyIds.length > 0) {
    const sweepConfigAny = (sweep?.config || {}) as Record<string, unknown>;
    const resolvedByStrategiesApiKey = await resolveApiKeyNameForStrategyIds(strategyIds, '', { strict: false });
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
        const rerunStrategyIds = [...strategyIds];

        const result = await runBacktest({
          apiKeyName: preferredApiKey,
          mode: kind === 'offer' ? 'single' : 'portfolio',
          strategyId: kind === 'offer' ? rerunStrategyIds[0] : undefined,
          strategyIds: kind === 'algofund-ts' ? rerunStrategyIds : undefined,
          bars: asNumber(sweep?.config?.backtestBars, 6000),
          warmupBars: asNumber(sweep?.config?.warmupBars, 400),
          skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
          initialBalance,
          commissionPercent: asNumber(sweep?.config?.commissionPercent, 0.1),
          slippagePercent: asNumber(sweep?.config?.slippagePercent, 0.05),
          fundingRatePercent: asNumber(sweep?.config?.fundingRatePercent, 0),
          dateFrom: asString(sweep?.config?.dateFrom, ''),
          dateTo: asString(sweep?.config?.dateTo, ''),
        });

        // Apply risk multiplier to returns/DD/equity (position sizing approximation)
        const summaryAny = result.summary as Record<string, unknown>;
        const scaledSummary = {
          ...result.summary,
          totalReturnPercent: result.summary.totalReturnPercent * rerunRiskMul,
          maxDrawdownPercent: result.summary.maxDrawdownPercent * rerunRiskMul,
          ...(summaryAny.netProfit != null ? { netProfit: Number(summaryAny.netProfit) * rerunRiskMul } : {}),
          marginLoadPercent: 0,
        };
        const scaledEquity = result.equityCurve.map((point) => ({
          ...point,
          equity: Number((initialBalance + (point.equity - initialBalance) * rerunRiskMul).toFixed(4)),
        }));

        return {
          kind,
          controls: {
            riskScore,
            tradeFrequencyScore,
            riskLevel,
            tradeFrequencyLevel,
            riskScaleMaxPercent,
          },
          period,
          sweepApiKeyName: asString((sweep as Record<string, unknown>)?.apiKeyName || ((sweep as Record<string, unknown>)?.config as Record<string, unknown>)?.apiKeyName, ''),
          selectedOffers,
          preview: {
            source: 'admin_sweep_rerun',
            summary: scaledSummary,
            equity: scaledEquity,
            curves: {
              pnl: scaledEquity.map((point) => ({ time: point.time, value: point.equity - initialBalance })),
              drawdownPercent: [],
              marginLoadPercent: [],
            },
            trades: result.trades,
            strictPresetMode: false,
            riskApproximated: rerunRiskMul !== 1,
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

  if (selectedOffers.length === 0) {
    if (kind === 'algofund-ts') {
      const snapshotMap = await getTsBacktestSnapshots();
      const requestedSetKey = normalizeTsSnapshotMapKey(asString(payload?.setKey, ''));
      const normalizeOfferIds = (raw: unknown): string[] => Array.from(new Set(
        (Array.isArray(raw) ? raw : [])
          .map((item) => asString(item, '').trim())
          .filter(Boolean)
      ));
      const requestedOfferIds = normalizeOfferIds(offerIds);

      let snapshot = requestedSetKey ? (snapshotMap[requestedSetKey] || null) : null;
      if (!snapshot && requestedOfferIds.length > 0) {
        snapshot = Object.values(snapshotMap).find((item) => {
          const snapshotOfferIds = normalizeOfferIds(item.offerIds);
          if (snapshotOfferIds.length === 0) {
            return false;
          }
          return requestedOfferIds.some((offerId) => snapshotOfferIds.includes(offerId));
        }) || null;
      }

      if (!snapshot) {
        const legacySnapshot = await getTsBacktestSnapshot();
        if (legacySnapshot) {
          const legacySetKey = normalizeTsSnapshotMapKey(asString(legacySnapshot.setKey, ''));
          const legacyOfferIds = normalizeOfferIds(legacySnapshot.offerIds);
          if (
            (requestedSetKey && legacySetKey === requestedSetKey)
            || (requestedOfferIds.length > 0 && requestedOfferIds.some((offerId) => legacyOfferIds.includes(offerId)))
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

          const snapshotEquity = (Array.isArray(snapshot.equityPoints) ? snapshot.equityPoints : [])
            .map((value, index) => ({ time: index, equity: Number(asNumber(value, 0).toFixed(4)) }))
            .filter((item) => Number.isFinite(item.equity));
          const snapshotStrategyIds = Array.from(new Set(snapshotSelectedOffers
            .map((item) => Number(item.strategyId || 0))
            .filter((value) => Number.isFinite(value) && value > 0)));

          let snapshotRerunFailureReason = '';
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

            if (preferredApiKey) {
              try {
                // Ensure the exchange client is initialized so getMarketData can fetch candles from the exchange
                await ensureExchangeClientInitialized(preferredApiKey);

                const primaryRequest: Parameters<typeof runBacktest>[0] = {
                  apiKeyName: preferredApiKey,
                  mode: 'portfolio',
                  strategyIds: snapshotStrategyIds,
                  bars: asNumber(sweep?.config?.backtestBars, 6000),
                  warmupBars: asNumber(sweep?.config?.warmupBars, 400),
                  skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
                  initialBalance,
                  commissionPercent: asNumber(sweep?.config?.commissionPercent, 0.1),
                  slippagePercent: asNumber(sweep?.config?.slippagePercent, 0.05),
                  fundingRatePercent: asNumber(sweep?.config?.fundingRatePercent, 0),
                  dateFrom: asString(sweep?.config?.dateFrom, ''),
                  dateTo: asString(sweep?.config?.dateTo, ''),
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
                    // Snapshot can come from historical ranges that no longer overlap latest sweep window.
                    // Retry without strict range to find executable candles for selected strategies.
                    dateFrom: '',
                    dateTo: '',
                    warmupBars: Math.max(50, Math.min(180, asNumber(sweep?.config?.warmupBars, 400))),
                  });
                  rerunRelaxedDateRange = true;
                }

                const summaryAny = result.summary as Record<string, unknown>;
                const scaledSummary = {
                  ...result.summary,
                  totalReturnPercent: result.summary.totalReturnPercent * rerunRiskMul,
                  maxDrawdownPercent: result.summary.maxDrawdownPercent * rerunRiskMul,
                  ...(summaryAny.netProfit != null ? { netProfit: Number(summaryAny.netProfit) * rerunRiskMul } : {}),
                  marginLoadPercent: 0,
                };
                const scaledEquity = result.equityCurve.map((point) => ({
                  ...point,
                  equity: Number((initialBalance + (point.equity - initialBalance) * rerunRiskMul).toFixed(4)),
                }));

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
                  },
                  period,
                  sweepApiKeyName: asString(snapshot.apiKeyName, ''),
                  selectedOffers: snapshotSelectedOffers,
                  preview: {
                    source: 'admin_saved_ts_snapshot_rerun',
                    summary: scaledSummary,
                    equity: scaledEquity,
                    curves: {
                      pnl: scaledEquity.map((point) => ({ time: point.time, value: point.equity - initialBalance })),
                      drawdownPercent: [],
                      marginLoadPercent: [],
                    },
                    trades: result.trades,
                    strictPresetMode: false,
                    riskApproximated: rerunRiskMul !== 1,
                  },
                  rerun: {
                    requested: true,
                    executed: true,
                    apiKeyName: preferredApiKey,
                    strategyIds: snapshotStrategyIds,
                    tsMembersCount: snapshotOfferIds.length,
                    riskMul: rerunRiskMul,
                    riskScaleMaxPercent,
                    freqLevel: tradeFrequencyLevel,
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
          const adjustedSnapshotMetrics = adjustPreviewMetrics(baselineMetrics, rerunRiskMul, tradeMul);
          const baseEquity = snapshotEquity.length > 1
            ? snapshotEquity
            : [
              { time: 0, equity: initialBalance },
              { time: 1, equity: Number(asNumber(snapshot.finalEquity, initialBalance).toFixed(4)) },
            ];
          const baseStartEquity = asNumber(baseEquity[0]?.equity, initialBalance);
          const baseEndEquity = asNumber(baseEquity[baseEquity.length - 1]?.equity, initialBalance);
          const scaledEndEquityByRisk = initialBalance + (baseEndEquity - baseStartEquity) * rerunRiskMul;
          const freqShapeFactor = clampNumber(0.7 + Math.log(Math.max(0.2, tradeMul)) * 0.45, 0.45, 1.8);
          const waveAmplitude = Math.abs(scaledEndEquityByRisk - initialBalance) * 0.08 * clampNumber(tradeMul, 0.6, 1.9);

          let adjustedSnapshotEquity = baseEquity.map((point, index, arr) => {
            const progress = arr.length > 1 ? (index / Math.max(1, arr.length - 1)) : 1;
            const scaledRaw = initialBalance + (asNumber(point.equity, baseStartEquity) - baseStartEquity) * rerunRiskMul;
            const trendLine = initialBalance + (scaledEndEquityByRisk - initialBalance) * progress;
            const deviation = scaledRaw - trendLine;
            const wave = Math.sin(progress * Math.PI * 2 * (1 + tradeMul * 0.8)) * waveAmplitude * (0.25 + 0.75 * progress);
            return {
              time: point.time,
              equity: Number((trendLine + deviation * freqShapeFactor + wave).toFixed(4)),
            };
          });

          const targetFinalEquity = Number((initialBalance * (1 + adjustedSnapshotMetrics.ret / 100)).toFixed(4));
          const currentFinalEquity = asNumber(adjustedSnapshotEquity[adjustedSnapshotEquity.length - 1]?.equity, initialBalance);
          const currentPnl = currentFinalEquity - initialBalance;
          const targetPnl = targetFinalEquity - initialBalance;
          if (Math.abs(currentPnl) > 1e-6) {
            const pnlScale = targetPnl / currentPnl;
            adjustedSnapshotEquity = adjustedSnapshotEquity.map((point) => ({
              time: point.time,
              equity: Number((initialBalance + (point.equity - initialBalance) * pnlScale).toFixed(4)),
            }));
          }
          if (adjustedSnapshotEquity.length > 0) {
            adjustedSnapshotEquity[adjustedSnapshotEquity.length - 1] = {
              ...adjustedSnapshotEquity[adjustedSnapshotEquity.length - 1],
              equity: targetFinalEquity,
            };
          }

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
            },
            period,
            sweepApiKeyName: asString(snapshot.apiKeyName, ''),
            selectedOffers: snapshotSelectedOffers,
            preview: {
              source: 'admin_saved_ts_snapshot_synthetic',
              summary: {
                finalEquity: Number(asNumber(adjustedSnapshotEquity[adjustedSnapshotEquity.length - 1]?.equity, initialBalance).toFixed(4)),
                totalReturnPercent: Number(adjustedSnapshotMetrics.ret.toFixed(3)),
                maxDrawdownPercent: Number(adjustedSnapshotMetrics.dd.toFixed(3)),
                profitFactor: Number(adjustedSnapshotMetrics.pf.toFixed(3)),
                winRatePercent: 0,
                tradesCount: Math.max(0, Math.floor(adjustedSnapshotMetrics.trades)),
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
    }
    throw new Error('No offers resolved for sweep backtest preview');
  }

  const adjustedSelectedOffers = selectedOffers.map((item) => {
    const adjustedMetrics = adjustPreviewMetrics(item.metrics, rerunRiskMul, tradeMul);
    return {
      ...item,
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
      },
      period,
      sweepApiKeyName,
      selectedOffers: adjustedSelectedOffers,
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
  const allOfferEquityArrays = adjustedSelectedOffers
    .map((item) => (Array.isArray(item.equityPoints) ? item.equityPoints as number[] : []))
    .filter((pts) => pts.length >= 2);

  let portfolioEquity: Array<{ time: number; equity: number }>;
  if (allOfferEquityArrays.length > 0) {
    const maxLen = allOfferEquityArrays.reduce((acc, pts) => Math.max(acc, pts.length), 0);
    const now = Date.now();
    const resolvedPeriodDays = Math.max(10, periodDays || 90);
    const periodMs = Math.round(resolvedPeriodDays * 24 * 3600 * 1000);
    portfolioEquity = Array.from({ length: maxLen }, (_, index) => {
      let sum = 0;
      let count = 0;
      for (const pts of allOfferEquityArrays) {
        const val = pts[Math.min(index, pts.length - 1)];
        if (Number.isFinite(val)) { sum += val; count += 1; }
      }
      const avgEq = count > 0 ? sum / count : initialBalance;
      return {
        time: Math.round(now - periodMs + (index / Math.max(1, maxLen - 1)) * periodMs),
        equity: Number(avgEq.toFixed(4)),
      };
    });
  } else {
    portfolioEquity = buildPortfolioPreviewEquityFromPresets(adjustedSelectedOffers, initialBalance, periodDays);
  }
  const portfolioCurves = buildDerivedPreviewCurves(portfolioEquity, initialBalance, riskScore);
  const portfolioSummary = buildPresetOnlyPortfolioSummary(initialBalance, pseudoSelectedOffers as any, {
    avgRet: adjustedSelectedOffers.reduce((acc, item) => acc + asNumber(item.metrics.ret, 0), 0) / Math.max(1, adjustedSelectedOffers.length),
    avgPf: adjustedSelectedOffers.reduce((acc, item) => acc + asNumber(item.metrics.pf, 0), 0) / Math.max(1, adjustedSelectedOffers.length),
    maxDd: adjustedSelectedOffers.reduce((acc, item) => Math.max(acc, asNumber(item.metrics.dd, 0)), 0),
    avgWr: adjustedSelectedOffers.reduce((acc, item) => acc + asNumber(item.metrics.wr, 0), 0) / Math.max(1, adjustedSelectedOffers.length),
    totalTrades: adjustedSelectedOffers.reduce((acc, item) => acc + Math.max(0, Math.floor(asNumber(item.metrics.trades, 0))), 0),
  });

  return {
    kind,
    controls: {
      riskScore,
      tradeFrequencyScore,
      riskLevel,
      tradeFrequencyLevel,
      riskScaleMaxPercent,
    },
    period,
    sweepApiKeyName,
    selectedOffers: adjustedSelectedOffers,
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

export const getAdminReportSettings = async (): Promise<AdminReportSettings> => {
  const raw = await getRuntimeFlag('admin.reports.settings', JSON.stringify(DEFAULT_ADMIN_REPORT_SETTINGS));
  return normalizeAdminReportSettings(safeJsonParse<Record<string, unknown>>(raw, DEFAULT_ADMIN_REPORT_SETTINGS));
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
      published: offer.published,
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
      suggestedDepositMin: Math.max(150, Number((maxDeposit * 1.5).toFixed(2))),
      suggestedLotPercent: lotPercent < 40 ? 50 : Math.min(100, lotPercent + 20),
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
    seenStrategyIds.add(sid);
    items.push(await buildItem(row as Record<string, unknown>, 'last_error'));
  }

  // ── Source 2: recent runtime events (low_lot_error, unresolved) ───────────
  const eventRows = await db.all(
    `SELECT
       e.strategy_id, e.api_key_name, e.message AS last_error,
       datetime(e.created_at / 1000, 'unixepoch') AS updated_at,
       a.id AS api_key_id,
       COALESCE(s.market_mode, 'synthetic') AS market_mode,
       COALESCE(s.base_symbol, '') AS base_symbol,
       COALESCE(s.quote_symbol, '') AS quote_symbol,
       COALESCE(s.max_deposit, 0) AS max_deposit,
       COALESCE(s.leverage, 1) AS leverage,
       COALESCE(s.lot_long_percent, 0) AS lot_long_percent,
       COALESCE(s.lot_short_percent, 0) AS lot_short_percent,
       COALESCE(s.name, e.strategy_name) AS strategy_name,
       (SELECT tsm.system_id FROM trading_system_members tsm WHERE tsm.strategy_id = e.strategy_id ORDER BY tsm.id ASC LIMIT 1) AS system_id
     FROM strategy_runtime_events e
     LEFT JOIN strategies s ON s.id = e.strategy_id
     LEFT JOIN api_keys a ON a.name = e.api_key_name
     WHERE e.event_type = 'low_lot_error'
       AND COALESCE(s.is_active, 0) = 1
       AND e.resolved_at = 0
       AND e.created_at >= ?
     ORDER BY e.created_at DESC
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
  replacementSymbol?: string;
}): Promise<{ success: boolean; changes: Record<string, unknown>; changeSummary: string[] }> => {
  const strategy = await db.get('SELECT * FROM strategies WHERE id = ?', [options.strategyId]);
  if (!strategy) {
    throw new Error(`Strategy ${options.strategyId} not found`);
  }

  const changes: Record<string, unknown> = {};
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (options.applyDepositFix) {
    const currentDeposit = Math.max(0, Number(strategy.max_deposit || 0));
    const newDeposit = Math.max(150, Number((currentDeposit * 1.5).toFixed(2)));
    setClauses.push('max_deposit = ?');
    values.push(newDeposit);
    changes['max_deposit'] = { from: currentDeposit, to: newDeposit };
  }

  if (options.applyLotFix) {
    const currentLot = Math.max(
      0,
      Number(strategy.lot_long_percent || 0),
      Number(strategy.lot_short_percent || 0)
    );
    const newLot = currentLot < 40 ? 50 : Math.min(100, currentLot + 20);
    setClauses.push('lot_long_percent = ?');
    values.push(newLot);
    setClauses.push('lot_short_percent = ?');
    values.push(newLot);
    changes['lot_percent'] = { from: currentLot, to: newLot };
  }

  if (options.replacementSymbol) {
    const parts = String(options.replacementSymbol).split('/').map((s) => s.trim().toUpperCase());
    const [base, quote] = parts;
    if (base) {
      setClauses.push('base_symbol = ?');
      values.push(base);
      changes['base_symbol'] = { from: String(strategy.base_symbol || ''), to: base };
    }
    if (quote) {
      setClauses.push('quote_symbol = ?');
      values.push(quote);
      changes['quote_symbol'] = { from: String(strategy.quote_symbol || ''), to: quote };
    }
  }

  if (setClauses.length === 0) {
    return { success: true, changes: {}, changeSummary: [] };
  }

  setClauses.push('last_error = ?');
  values.push('');
  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  values.push(options.strategyId);

  await db.run(
    `UPDATE strategies SET ${setClauses.join(', ')} WHERE id = ?`,
    values
  );

  const apiKeyRow = await db.get('SELECT name FROM api_keys WHERE id = ?', [strategy.api_key_id]);
  const apiKeyName = String(apiKeyRow?.name || '');
  const payloadJson = JSON.stringify({ strategy_id: options.strategyId, strategy_name: String(strategy.name || ''), changes });

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

  // Mark unresolved low-lot runtime events for this strategy as resolved.
  await db.run(
    `UPDATE strategy_runtime_events
     SET resolved_at = ?
     WHERE strategy_id = ? AND event_type = 'low_lot_error' AND resolved_at = 0`,
    [Date.now(), options.strategyId]
  );

  // Build human-readable change summary for the UI.
  const changeSummary: string[] = [];
  if (changes['max_deposit']) {
    const d = changes['max_deposit'] as { from: number; to: number };
     changeSummary.push(`Deposit: $${d.from} -> $${d.to}`);
  }
  if (changes['lot_percent']) {
    const l = changes['lot_percent'] as { from: number; to: number };
     changeSummary.push(`Lot%: ${l.from}% -> ${l.to}%`);
  }
  if (changes['base_symbol'] || changes['quote_symbol']) {
    const oldPair = `${String((changes['base_symbol'] as any)?.from || strategy.base_symbol || '')}/${String((changes['quote_symbol'] as any)?.from || strategy.quote_symbol || '')}`;
    const newPair = `${String((changes['base_symbol'] as any)?.to || strategy.base_symbol || '')}/${String((changes['quote_symbol'] as any)?.to || strategy.quote_symbol || '')}`;
     changeSummary.push(`Pair: ${oldPair} -> ${newPair}`);
  }

  return { success: true, changes, changeSummary };
};

export const getSaasAdminSummary = async (options?: {
  includeOfferStore?: boolean;
}) => {
  await ensureSaasSeedData();
  const includeOfferStore = options?.includeOfferStore !== false;
  const sourceCatalog = loadLatestClientCatalog();
  const sourceSweep = loadLatestSweep();
  const apiKeys = await getAvailableApiKeyNames();
  const fallbackCatalog = await buildFallbackCatalogFromPresets(sourceCatalog, []);
  const catalog = getAllOffers(fallbackCatalog).length > 0
    ? fallbackCatalog
    : sourceCatalog || fallbackCatalog;
  
  // Always use source draft if available, don't let fallback overwrite it
  if (sourceCatalog?.adminTradingSystemDraft && 
      sourceCatalog.adminTradingSystemDraft.name && 
      !sourceCatalog.adminTradingSystemDraft.name.includes('fallback')) {
    catalog.adminTradingSystemDraft = sourceCatalog.adminTradingSystemDraft;
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
  const [offerStore, reportSettings] = await Promise.all([
    includeOfferStore ? getOfferStoreAdminState() : Promise.resolve(null),
    getAdminReportSettings(),
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

  if (tenant.product_mode === 'strategy_client') {
    await db.run(
      `UPDATE strategy_client_profiles
       SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [nextAssignedApiKeyName, tenantId]
    );
  } else if (tenant.product_mode === 'copytrading_client') {
    await db.run(
      `UPDATE copytrading_profiles
       SET master_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [nextAssignedApiKeyName, tenantId]
    );
  } else {
    await db.run(
      `UPDATE algofund_profiles
       SET execution_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [nextAssignedApiKeyName, tenantId]
    );
  }

  if (payload.planCode) {
    const plan = await getPlanByCode(payload.planCode);
    if (plan.product_mode !== tenant.product_mode) {
      throw new Error(`Plan ${payload.planCode} does not belong to tenant mode ${tenant.product_mode}`);
    }
    await setTenantSubscriptionPlan(tenantId, plan.id);
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
    const capabilities = resolvePlanCapabilities(plan);
    const strategyProfile = await getStrategyClientProfile(tenant.id);
    const algofundProfile = await getAlgofundProfile(tenant.id);
    const copytradingProfile = await getCopytradingProfile(tenant.id);
    const effectiveMonitoringApiKeyName = asString(
      tenant.product_mode === 'strategy_client'
        ? strategyProfile?.assigned_api_key_name
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
  if (tenant.product_mode !== 'strategy_client') {
    throw new Error('Tenant is not a strategy client');
  }
  const plan = await getPlanForTenant(tenantId);
  const capabilities = resolvePlanCapabilities(plan);
  const profile = await getStrategyClientProfile(tenantId);
  let systemProfiles = await listStrategyClientSystemProfiles(tenantId);
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const offerStore = await getOfferStoreAdminState();
  const publishedSet = new Set(offerStore.publishedOfferIds);
  const catalog = filterCatalogByPublishedOfferIds(sourceCatalog, publishedSet);
  const directOffers = catalog ? getAllOffers(catalog) : [];
  const presetOffers = directOffers.length > 0 ? directOffers : await buildPresetBackedOffers(catalog);
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
    offers: presetOffers,
    recommendedSets,
    offerStoreDefaults: offerStore.defaults,
    sweepPeriod: buildPeriodInfo(sweep),
  };
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
  const plan = await getPlanForTenant(tenantId);
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
  const nextAssignedApiKeyName = asString(payload.assignedApiKeyName, existing.assigned_api_key_name || tenant.assigned_api_key_name);
  const nextRequestedEnabled = payload.requestedEnabled !== undefined ? payload.requestedEnabled : existing.requested_enabled === 1;
  const { catalog: sourceCatalog } = await loadCatalogAndSweepWithFallback();
  const offerStore = await getOfferStoreAdminState();
  const publishedSet = new Set(offerStore.publishedOfferIds);
  const catalog = filterCatalogByPublishedOfferIds(sourceCatalog, publishedSet);
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

  await db.run(
    `UPDATE strategy_client_profiles
     SET selected_offer_ids_json = ?,
         active_system_profile_id = ?,
         risk_level = ?,
         trade_frequency_level = ?,
         requested_enabled = ?,
         assigned_api_key_name = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [JSON.stringify(nextOfferIds), activeSystemProfile?.id || null, nextRiskLevel, nextTradeFrequencyLevel, nextRequestedEnabled ? 1 : 0, nextAssignedApiKeyName, tenantId]
  );

  if (activeSystemProfile?.id) {
    await db.run(
      `UPDATE strategy_client_system_profiles
       SET selected_offer_ids_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [JSON.stringify(nextOfferIds), activeSystemProfile.id, tenantId]
    );
  }

  await db.run(
    `UPDATE tenants
     SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextAssignedApiKeyName, tenantId]
  );

  return getStrategyClientState(tenantId);
};

export const listStrategyClientSystemProfilesState = async (tenantId: number) => {
  const tenant = await getTenantById(tenantId);
  if (tenant.product_mode !== 'strategy_client') {
    throw new Error('Tenant is not a strategy client');
  }
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
      if (tenant.product_mode !== 'algofund_client') {
        throw new Error('Tenant is not algofund client');
      }

      if (directExecute) {
        const plan = await getPlanForTenant(tenantId);
        const profile = await getAlgofundProfile(tenantId);
        if (!plan || !profile) {
          throw new Error('Algofund plan/profile not found');
        }

        const capabilities = resolvePlanCapabilities(plan);
        if (!capabilities.startStopRequests) {
          throw new Error('Start/stop requests are not available for the current plan');
        }

        await applyApprovedAlgofundAction({
          row: {
            tenant_id: tenantId,
            request_type: requestType,
          } as AlgofundRequestRow,
          requestPayload: payload,
          tenant,
          profile,
          plan,
          decisionNote: note,
        });

        await db.run(
          `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
           VALUES (?, 'admin', 'direct_algofund_action', ?, CURRENT_TIMESTAMP)`,
          [tenantId, JSON.stringify({ requestType, note, payload })]
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
    .filter((row) => row.tenant.product_mode === 'strategy_client')
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
  const baseEquity = offer.equity && offer.strategy.id === preset.strategyId ? offer.equity : null;

  if (baseEquity && Array.isArray(baseEquity.points) && baseEquity.points.length > 0) {
    const preview = {
      source: 'catalog_cache',
      summary: baseEquity.summary,
      equity: baseEquity,
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

  const record = findSweepRecordByStrategyId(sweep, preset.strategyId);
  const result = await runBacktest({
    apiKeyName: state.catalog.apiKeyName,
    mode: 'single',
    strategyId: record ? Number(record.strategyId) : preset.strategyId,
    bars: asNumber(sweep?.config?.backtestBars, 6000),
    warmupBars: asNumber(sweep?.config?.warmupBars, 400),
    skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
    initialBalance: asNumber(sweep?.config?.initialBalance, 10000),
    commissionPercent: asNumber(sweep?.config?.commissionPercent, 0.1),
    slippagePercent: asNumber(sweep?.config?.slippagePercent, 0.05),
    fundingRatePercent: asNumber(sweep?.config?.fundingRatePercent, 0),
  });

  const preview = {
    source: 'single_backtest',
    summary: result.summary,
    equity: result.equityCurve,
    trades: result.trades.slice(0, 30),
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

  const result = await runBacktest({
    apiKeyName: state.catalog.apiKeyName,
    mode: 'portfolio',
    strategyIds: uniqueStrategyIds,
    bars: asNumber(sweep?.config?.backtestBars, 6000),
    warmupBars: asNumber(sweep?.config?.warmupBars, 400),
    skipMissingSymbols: sweep?.config?.skipMissingSymbols !== false,
    initialBalance: asNumber(sweep?.config?.initialBalance, 10000),
    commissionPercent: asNumber(sweep?.config?.commissionPercent, 0.1),
    slippagePercent: asNumber(sweep?.config?.slippagePercent, 0.05),
    fundingRatePercent: asNumber(sweep?.config?.fundingRatePercent, 0),
  });

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
      summary: result.summary,
      equity: result.equityCurve,
      trades: result.trades.slice(0, 50),
    },
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
  activate: boolean
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
  const sourceSystemName = asString(profile.published_system_name, '').trim();
  const sourceSystemApiKeyName = asString(
    getAlgofundPublishedSourceApiKeyName(sourceSystemName)
    || profile.assigned_api_key_name
    || tenant.assigned_api_key_name,
    ''
  ).trim();
  let draftMembers = catalogDraftMembers;

  if (sourceSystemApiKeyName && sourceSystemName) {
    const sourceSystems = await listTradingSystems(sourceSystemApiKeyName).catch(() => []);
    const sourceSystem = (Array.isArray(sourceSystems) ? sourceSystems : []).find((item) => asString(item.name, '') === sourceSystemName);
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
        logger.warn(`Algofund materialize: using published source system members (${sourceMembers.length}) from ${sourceSystemName} instead of latest admin draft.`);
      }
    }
  }

  if (draftMembers.length === 0) {
    throw new Error('Admin TS draft members are empty in latest client catalog');
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
      const sourceSystem = (Array.isArray(systems) ? systems : []).find((item) => asString(item.name, '') === sourceSystemName);

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
    activate || profile.requested_enabled === 1
  );

  const systems = await listTradingSystems(executionApiKeyName);
  const systemName = getAlgofundClientSystemName(tenant);
  const existing = systems.find((item) => asString(item.name) === systemName);
  const uniqueMaterialized = materializedStrategies.filter((row, index, arr) => {
    const strategyId = Number(row.strategyId || 0);
    if (!strategyId) {
      return false;
    }
    return arr.findIndex((item) => Number(item.strategyId || 0) === strategyId) === index;
  });

  const members = uniqueMaterialized.map((row, index) => ({
    strategy_id: Number(row.strategyId),
    weight: Number(((index === 0 ? 1.25 : index === 1 ? 1.1 : 1) * Math.max(0.25, riskMultiplier)).toFixed(4)),
    member_role: index < 3 ? 'core' : 'satellite',
    is_enabled: true,
    notes: `algofund ${tenant.slug}`,
  }));

  let systemId = 0;
  if (existing?.id) {
    await updateTradingSystem(executionApiKeyName, Number(existing.id), {
      name: systemName,
      description: `Algofund managed TS for ${tenant.display_name}`,
      auto_sync_members: false,
      discovery_enabled: false,
      max_members: Math.max(6, members.length),
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
      members,
    });
    systemId = Number(created.id);
  }

  if (activate || profile.requested_enabled === 1) {
    await setTradingSystemActivation(executionApiKeyName, systemId, true, true);
  }

  const storefrontSystemName = asString(profile.published_system_name, '').trim().toUpperCase().startsWith('ALGOFUND_MASTER::')
    ? asString(profile.published_system_name, '').trim()
    : systemName;

  await db.run(
    `UPDATE algofund_profiles
     SET assigned_api_key_name = ?,
         execution_api_key_name = ?,
         published_system_name = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [executionApiKeyName, executionApiKeyName, storefrontSystemName, tenant.id]
  );

  return {
    systemId,
    systemName,
    assignedApiKeyName: executionApiKeyName,
    riskMultiplier,
    strategies: materializedStrategies,
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
  if (tenant.product_mode !== 'algofund_client') {
    throw new Error('Tenant is not an algofund client');
  }

  const plan = await getPlanForTenant(tenantId);
  const profile = await getAlgofundProfile(tenantId);
  if (!plan || !profile) {
    throw new Error('Algofund plan/profile not found');
  }

  const engine = await getAlgofundEngineState(tenant, profile);
  const effectiveStorefrontSystemName = asString(profile.published_system_name, '').trim().toUpperCase().startsWith('ALGOFUND_MASTER::')
    ? asString(profile.published_system_name, '').trim()
    : (engine?.systemName || profile.published_system_name);
  const effectiveProfile: AlgofundProfileRow = {
    ...profile,
    actual_enabled: engine ? (engine.isActive ? 1 : 0) : profile.actual_enabled,
    published_system_name: effectiveStorefrontSystemName,
    assigned_api_key_name: engine?.apiKeyName || profile.assigned_api_key_name,
    execution_api_key_name: profile.execution_api_key_name,
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

  const capabilities = resolvePlanCapabilities(plan);
  // Fetch ALL published Algofund TS from all API keys, not filtered by tenant's assigned key
  // This allows clients to see TS published under other API keys without API key binding
  const allApiKeyNames = await getAvailableApiKeyNames().catch(() => []);
  const allAlgofundSystemsMap = new Map<string, any>();
  for (const apiKeyName of allApiKeyNames) {
    const systems = await listTradingSystems(apiKeyName).catch(() => []);
    for (const item of (Array.isArray(systems) ? systems : [])) {
      const systemName = asString(item?.name, '');
      // Collect all ALGOFUND_MASTER systems published to the storefront
      if (systemName && systemName.toUpperCase().includes('ALGOFUND_MASTER')) {
        const key = `${systemName}`;
        if (!allAlgofundSystemsMap.has(key)) {
          allAlgofundSystemsMap.set(key, item);
        }
      }
    }
  }
  const availableSystems = Array.from(allAlgofundSystemsMap.values()).map((item: any) => ({
    id: Number(item?.id || 0),
    name: asString(item?.name, ''),
    isActive: Boolean(item?.is_active),
    updatedAt: asString(item?.updated_at, ''),
    metrics: item?.metrics ? {
      equityUsd: asNumber(item.metrics.equity_usd, 0),
      unrealizedPnl: asNumber(item.metrics.unrealized_pnl, 0),
      drawdownPercent: asNumber(item.metrics.drawdown_percent, 0),
      marginLoadPercent: asNumber(item.metrics.margin_load_percent, 0),
      effectiveLeverage: asNumber(item.metrics.effective_leverage, 0),
    } : null,
  })).filter((item) => item.id > 0);
  const maxPreviewRiskMultiplier = allowPreviewAbovePlan
    ? Math.max(10, asNumber(plan.risk_cap_max, 1))
    : asNumber(plan.risk_cap_max, 1);
  const riskMultiplier = Math.max(0, Math.min(
    requestedRiskMultiplier !== undefined ? requestedRiskMultiplier : asNumber(profile.risk_multiplier, 1),
    maxPreviewRiskMultiplier
  ));

  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const offerStore = await getOfferStoreAdminState();
  const catalog = filterCatalogByPublishedOfferIds(sourceCatalog, new Set(offerStore.publishedOfferIds));
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
  const hasCachedPreview = cachedPreview && typeof cachedPreview === 'object';
  const shouldRefreshPreview = forceRefreshPreview || requestedRiskMultiplier !== undefined || !hasCachedPreview;

  if (shouldRefreshPreview) {
    try {
      const sourceSystem = await ensurePublishedSourceSystem(tenantId);
      const previewResult = await runTradingSystemBacktest(sourceSystem.apiKeyName, sourceSystem.systemId, {
        bars: SAAS_PREVIEW_BARS,
        warmupBars: SAAS_PREVIEW_WARMUP_BARS,
        skipMissingSymbols: true,
        initialBalance: SAAS_ALGOFUND_BASELINE_INITIAL_BALANCE,
        riskMultiplier,
        commissionPercent: 0.1,
        slippagePercent: 0.05,
        fundingRatePercent: 0,
      });

      preview = {
        riskMultiplier,
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

  return {
    tenant,
    plan,
    capabilities,
    profile: {
      ...effectiveProfile,
      latestPreview: safeJsonParse<Record<string, unknown>>(profile.latest_preview_json, {}),
    },
    engine,
    availableSystems,
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
  const plan = await getPlanForTenant(tenantId);
  if (!profile || !plan) {
    throw new Error('Algofund profile or plan not found');
  }

  const nextRiskMultiplier = Math.max(0, Math.min(
    payload.riskMultiplier !== undefined ? payload.riskMultiplier : asNumber(profile.risk_multiplier, 1),
    asNumber(plan.risk_cap_max, 1)
  ));
  const currentExecutionApiKeyName = getAlgofundExecutionApiKeyName(tenant, profile);
  const nextApiKeyName = asString(payload.assignedApiKeyName, currentExecutionApiKeyName);
  const nextRequestedEnabled = payload.requestedEnabled !== undefined
    ? payload.requestedEnabled
    : Number(profile.requested_enabled || 0) === 1;

  await db.run(
    `UPDATE algofund_profiles
     SET risk_multiplier = ?, execution_api_key_name = ?, requested_enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [nextRiskMultiplier, nextApiKeyName, nextRequestedEnabled ? 1 : 0, tenantId]
  );

  await db.run(
    `UPDATE tenants
     SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextApiKeyName, tenantId]
  );

  return getAlgofundState(tenantId, nextRiskMultiplier);
};

export const requestAlgofundAction = async (
  tenantId: number,
  requestType: AlgofundRequestType,
  note: string,
  payload: AlgofundRequestPayload = {}
) => {
  const tenant = await getTenantById(tenantId);
  const plan = await getPlanForTenant(tenantId);
  const profile = await getAlgofundProfile(tenantId);
  if (!profile || !plan) {
    throw new Error(`Algofund profile not found for tenant ${tenant.slug}`);
  }

  const capabilities = resolvePlanCapabilities(plan);
  if (!capabilities.startStopRequests) {
    throw new Error('Start/stop requests are not available for the current plan');
  }

  const apiKeyName = getAlgofundSystemApiKeyName(tenant, profile);
  const requestPayload: AlgofundRequestPayload = {
    targetSystemId: undefined,
    targetSystemName: undefined,
  };

  if (requestType === 'switch_system') {
    const targetSystemId = Math.floor(asNumber(payload.targetSystemId, 0));
    if (!targetSystemId || targetSystemId <= 0) {
      throw new Error('targetSystemId is required for switch_system request');
    }
    let switchApiKeyName = apiKeyName;
    let systems = switchApiKeyName ? await listTradingSystems(switchApiKeyName).catch(() => []) : [];
    let target = (Array.isArray(systems) ? systems : []).find((item) => Number(item.id) === targetSystemId);

    if (!target?.id) {
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

    if (!target?.id) {
      throw new Error(`Target trading system not found: ${targetSystemId}`);
    }

    requestPayload.targetSystemId = Number(target.id);
    requestPayload.targetSystemName = asString(target.name, '');
    requestPayload.targetApiKeyName = asString(switchApiKeyName, '');
  }

  await db.run(
    `INSERT INTO algofund_start_stop_requests (tenant_id, request_type, status, note, decision_note, request_payload_json, created_at)
     VALUES (?, ?, 'pending', ?, '', ?, CURRENT_TIMESTAMP)`,
    [tenantId, requestType, note, JSON.stringify(requestPayload)]
  );

  if (requestType === 'start' || requestType === 'stop') {
    await db.run(
      `UPDATE algofund_profiles
       SET requested_enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [requestType === 'start' ? 1 : 0, tenantId]
    );
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
  const plan = await getPlanForTenant(row.tenant_id);
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
    await db.run('UPDATE algofund_profiles SET actual_enabled = 0, requested_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [row.tenant_id]);
  } else if (row.request_type === 'switch_system') {
    const targetSystemId = Math.floor(asNumber(requestPayload.targetSystemId, 0));
    let apiKeyName = asString(requestPayload.targetApiKeyName || getAlgofundSystemApiKeyName(tenant, profile));

    if (!apiKeyName && targetSystemId > 0) {
      const globalTarget = await db.get(
        `SELECT ak.name AS api_key_name
         FROM trading_systems ts
         JOIN api_keys ak ON ak.id = ts.api_key_id
         WHERE ts.id = ?`,
        [targetSystemId]
      ) as { api_key_name?: string } | undefined;
      apiKeyName = asString(globalTarget?.api_key_name, '');
    }

    if (!apiKeyName) {
      throw new Error('Assign API key before approving switch request');
    }

    if (targetSystemId <= 0) {
      throw new Error('Switch request payload is missing targetSystemId');
    }

    let systems = await listTradingSystems(apiKeyName).catch(() => []);
    let target = (Array.isArray(systems) ? systems : []).find((item) => Number(item.id) === targetSystemId);

    if (!target?.id) {
      const globalTarget = await db.get(
        `SELECT ts.id AS system_id, ts.name AS system_name, ak.name AS api_key_name
         FROM trading_systems ts
         JOIN api_keys ak ON ak.id = ts.api_key_id
         WHERE ts.id = ?`,
        [targetSystemId]
      ) as { system_id?: number; system_name?: string; api_key_name?: string } | undefined;

      const globalApiKeyName = asString(globalTarget?.api_key_name, '');
      if (globalTarget?.system_id && globalApiKeyName) {
        apiKeyName = globalApiKeyName;
        systems = await listTradingSystems(apiKeyName).catch(() => []);
        target = (Array.isArray(systems) ? systems : []).find((item) => Number(item.id) === targetSystemId) || {
          id: Number(globalTarget.system_id),
          name: asString(globalTarget.system_name, ''),
        } as any;
      }
    }

    if (!target?.id) {
      throw new Error(`Target trading system not found: ${targetSystemId}`);
    }

    // Do not implicitly rebind client execution key to the system owner key.

    for (const item of systems) {
      const id = Number(item.id || 0);
      if (!id || id === Number(target.id) || !Boolean(item.is_active)) {
        continue;
      }
      await setTradingSystemActivation(apiKeyName, id, false, true);
    }

    await setTradingSystemActivation(apiKeyName, Number(target.id), true, true);
    await db.run(
      `UPDATE algofund_profiles
       SET actual_enabled = 1,
           requested_enabled = 1,
           assigned_api_key_name = ?,
           published_system_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [apiKeyName, asString(target.name), row.tenant_id]
    );
  }

  return decisionNote;
};

export const retryMaterializeAlgofundSystem = async (tenantId: number) => {
  const tenant = await getTenantById(tenantId);
  const plan = await getPlanForTenant(tenantId);
  const profile = await getAlgofundProfile(tenantId);
  if (!plan || !profile) {
    throw new Error('Algofund plan/profile not found');
  }

  if (!profile.requested_enabled) {
    throw new Error('Materialization retry only available when start has been requested');
  }

  try {
    await materializeAlgofundSystem(tenant, plan, { ...profile, requested_enabled: 1 }, true);
    await db.run('UPDATE algofund_profiles SET actual_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [tenantId]);
  } catch (error) {
    const reason = (error as Error).message || 'Materialization failed';
    logger.warn(`Algofund retry materialize failed for tenant ${tenant.slug}: ${reason}`);
    // Keep actual_enabled = 0, blockedReason will be shown from preview
    throw new Error(`Retry failed: ${reason}`);
  }

  return getAlgofundState(tenantId);
};

export const publishAdminTradingSystem = async (payload?: { offerIds?: string[]; setKey?: string }) => {
  const catalog = loadLatestClientCatalog();
  const offerIds = normalizePublishOfferIds(payload?.offerIds);
  const setKey = asString(payload?.setKey, '').trim();
  const members = await resolvePublishDraftMembers(catalog, offerIds, setKey);
  const sourceSystem = await ensurePublishedSourceSystem(undefined, {
    draftMembersOverride: members,
    systemNameSuffix: buildPublishSystemSuffix(setKey, offerIds),
  });
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

  return {
    sourceSystem,
    publishMeta: {
      offerIds,
      setKey,
      membersCount: members.length,
      systemName: sourceSystem.systemName,
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
  const systemRows = await db.all(
    `SELECT ts.id, ak.name AS api_key_name
     FROM trading_systems ts
     JOIN api_keys ak ON ak.id = ts.api_key_id
     WHERE ts.name = ?`,
    [systemName]
  ) as Array<{ id?: number; api_key_name?: string }>;
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
    Object.entries(currentTsSnapshotMap).filter(([_key, snapshot]) => asString(snapshot?.systemName, '') !== systemName)
  );
  await setRuntimeFlag('offer.store.ts_backtest_snapshots', JSON.stringify(nextTsSnapshotMap));

  // Remove system from storefront listing by archiving its name away from ALGOFUND_MASTER::* prefix.
  // Keeping the row (instead of hard-delete) preserves auditability and avoids FK side effects.
  const archiveSuffix = `archived_${Date.now()}`;
  for (const row of (Array.isArray(systemRows) ? systemRows : [])) {
    const systemId = Number(row.id || 0);
    const apiKeyName = asString(row.api_key_name, '').trim();
    if (!systemId || !apiKeyName) {
      continue;
    }
    await updateTradingSystem(apiKeyName, systemId, {
      name: `ARCHIVED::${systemName}::${archiveSuffix}`,
      description: `Storefront removed at ${new Date().toISOString()}`,
      auto_sync_members: false,
      discovery_enabled: false,
    });
    await setTradingSystemActivation(apiKeyName, systemId, false, true).catch(() => undefined);
  }

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

export const getAlgofundActiveSystems = async (profileId: number): Promise<AlgofundActiveSystem[]> => {
  const rows = await db.all(
    `SELECT id, profile_id, system_name, weight, is_enabled, assigned_by, created_at
     FROM algofund_active_systems
     WHERE profile_id = ?
     ORDER BY id ASC`,
    [profileId]
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

export const checkAlgofundSystemPairConflicts = async (
  profileId: number,
  proposedSystemName: string,
  apiKeyName: string
): Promise<PairConflict[]> => {
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
    [profileId, proposedSystemName, apiKeyName]
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
  const { profileId, systems, replace = false } = payload;

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

export const toggleAlgofundSystem = async (payload: {
  profileId: number;
  systemName: string;
  isEnabled: boolean;
  apiKeyName: string;
  actorMode?: 'admin' | 'client';
}): Promise<{ activeSystems: AlgofundActiveSystem[]; conflicts: PairConflict[] }> => {
  const { profileId, systemName, isEnabled, apiKeyName } = payload;
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

  return {
    activeSystems: await getAlgofundActiveSystems(profileId),
    conflicts: [],
  };
};

export const removeAlgofundSystemFromProfile = async (payload: {
  profileId: number;
  systemName: string;
}): Promise<AlgofundActiveSystem[]> => {
  await db.run(
    `DELETE FROM algofund_active_systems WHERE profile_id = ? AND system_name = ?`,
    [payload.profileId, payload.systemName]
  );
  return getAlgofundActiveSystems(payload.profileId);
};


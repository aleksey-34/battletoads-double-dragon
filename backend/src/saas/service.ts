import fs from 'fs';
import path from 'path';
import { runBacktest } from '../backtest/engine';
import { createStrategy, getStrategies, updateStrategy } from '../bot/strategy';
import {
  createTradingSystem,
  listTradingSystems,
  replaceTradingSystemMembers,
  runTradingSystemBacktest,
  setTradingSystemActivation,
  updateTradingSystem,
} from '../bot/tradingSystems';
import { getMonitoringLatest } from '../bot/monitoring';
import { getPositions, closeAllPositions, cancelAllOrders } from '../bot/exchange';
import { Strategy } from '../config/settings';
import { db, initDB } from '../utils/database';
import logger from '../utils/logger';
import { initResearchDb } from '../research/db';
import { getPreset, listOfferIds } from '../research/presetBuilder';
import { computeReconciliationMetrics } from '../analytics/liveReconciliation';

export type ProductMode = 'strategy_client' | 'algofund_client';
export type Level3 = 'low' | 'medium' | 'high';
export type RequestStatus = 'pending' | 'approved' | 'rejected';
export type AlgofundRequestType = 'start' | 'stop' | 'switch_system';

type AlgofundRequestPayload = {
  targetSystemId?: number;
  targetSystemName?: string;
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
    equityPoints: number[];
  }>;
};

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
  published_system_name: string;
  latest_preview_json: string;
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

  const rows = fs.readdirSync(resultsDir)
    .filter((name) => matcher.test(name))
    .map((name) => {
      const filePath = path.join(resultsDir, name);
      return {
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return rows[0]?.filePath || '';
};

const getLatestClientCatalogPath = (): string => findLatestFile(/_client_catalog_.*\.json$/i);
const getLatestSweepPath = (): string => findLatestFile(/_historical_sweep_.*\.json$/i);

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

  return {
    timestamp: new Date().toISOString(),
    apiKeyName: sourceCatalog?.apiKeyName || apiKeys[0] || '',
    source: {
      sweepFile: sourceCatalog?.source?.sweepFile || 'fallback:preset-db',
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
    adminTradingSystemDraft: {
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
  const apiKeys = await getAvailableApiKeyNames();
  const catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  const sweep = sourceSweep || buildFallbackSweepData(catalog);
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
      tenant_id, risk_multiplier, requested_enabled, actual_enabled, assigned_api_key_name,
      published_system_name, latest_preview_json, created_at, updated_at
    ) VALUES (?, 1, 0, 0, ?, '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      assigned_api_key_name = CASE WHEN COALESCE(algofund_profiles.assigned_api_key_name, '') = '' THEN excluded.assigned_api_key_name ELSE algofund_profiles.assigned_api_key_name END,
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

  const balancedBot: CatalogOffer[] = [];
  if (mono[0]) balancedBot.push(mono[0]);
  if (synth[0]) balancedBot.push(synth[0]);
  for (const offer of all) {
    if (balancedBot.length >= 3) break;
    if (!balancedBot.find((item) => item.offerId === offer.offerId)) {
      balancedBot.push(offer);
    }
  }

  const premiumMix = all.slice(0, 6);

  return {
    balancedBot,
    conservativeBot: conservative.slice(0, 3),
    monoStarter: mono.slice(0, 3),
    synthStarter: synth.slice(0, 3),
    momentumBot: momentum.slice(0, 3),
    premiumMix,
  };
};

export const ensureSaasSeedData = async (): Promise<void> => {
  for (const plan of [...strategyClientPlans, ...algofundPlans]) {
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

  const strategyTenant = await ensureTenant('client-bot-01', 'Client Bot 01', 'strategy_client', 'ru', strategyClientApiKey);
  const algofundTenant = await ensureTenant('algofund-01', 'Algofund Client 01', 'algofund_client', 'ru', algofundApiKey);

  await ensureSubscription(strategyTenant.id, (await getPlanByCode('strategy_20')).id);
  await ensureSubscription(algofundTenant.id, (await getPlanByCode('algofund_20')).id);
  await ensureStrategyClientProfile(strategyTenant.id, offerIds, strategyClientApiKey);
  await ensureAlgofundProfile(algofundTenant.id, algofundApiKey);
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

const toCatalogPreset = (
  preset: { config: Record<string, unknown>; metrics: Record<string, unknown> } | null,
  fallback: { strategyId: number; strategyName: string; params: CatalogPreset['params']; metrics: CatalogMetricSet & { score?: number } }
): CatalogPreset | null => {
  if (!preset) {
    return null;
  }

  const config = (preset.config || {}) as Record<string, unknown>;
  const metrics = (preset.metrics || {}) as Record<string, unknown>;

  return {
    strategyId: asNumber(config.strategyId, fallback.strategyId),
    strategyName: asString(config.name, fallback.strategyName),
    score: asNumber(metrics.score, asNumber(fallback.metrics.score, fallback.metrics.ret)),
    metrics: {
      ret: asNumber(metrics.ret, fallback.metrics.ret),
      pf: asNumber(metrics.pf, fallback.metrics.pf),
      dd: asNumber(metrics.dd, fallback.metrics.dd),
      wr: asNumber(metrics.wr, fallback.metrics.wr),
      trades: asNumber(metrics.trades, fallback.metrics.trades),
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

const buildSweepPreset = (record: SweepRecord, riskLevel: Level3, freqLevel: Level3): CatalogPreset => {
  const riskMul = riskLevel === 'low' ? 0.75 : riskLevel === 'high' ? 1.35 : 1;
  const freqMul = freqLevel === 'low' ? 0.75 : freqLevel === 'high' ? 1.3 : 1;

  const scoreBase = asNumber(record.score, 0);
  const ret = asNumber(record.totalReturnPercent, 0) * riskMul;
  const dd = asNumber(record.maxDrawdownPercent, 0) * riskMul;
  const trades = Math.max(1, Math.round(asNumber(record.tradesCount, 0) * freqMul));

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
      length: Math.max(2, Math.round(asNumber(record.length, 50) * (freqLevel === 'low' ? 1.25 : freqLevel === 'high' ? 0.8 : 1))),
      takeProfitPercent: asNumber(record.takeProfitPercent, 0),
      detectionSource: asString(record.detectionSource, 'close'),
      zscoreEntry: asNumber(record.zscoreEntry, 2),
      zscoreExit: asNumber(record.zscoreExit, 0.5),
      zscoreStop: asNumber(record.zscoreStop, 3),
    },
  };
};

const buildOfferFromSweepRecord = (record: SweepRecord): CatalogOffer => {
  const rawMode = asString(record.marketMode, 'mono');
  const mode = rawMode === 'synthetic' || rawMode === 'synth' ? 'synth' : 'mono';
  const mediumMedium = buildSweepPreset(record, 'medium', 'medium');
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
        low: buildSweepPreset(record, 'low', 'medium'),
        medium: mediumMedium,
        high: buildSweepPreset(record, 'high', 'medium'),
      },
      tradeFrequency: {
        low: buildSweepPreset(record, 'medium', 'low'),
        medium: mediumMedium,
        high: buildSweepPreset(record, 'medium', 'high'),
      },
    },
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
    selected.push(buildOfferFromSweepRecord(row));
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
      const offer = buildOfferFromSweepRecord(row);
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
    for (const row of sorted) {
      const strategyId = Number(row.strategyId);
      if (seenIds.has(strategyId)) {
        continue;
      }
      selected.push(row);
      seenIds.add(strategyId);
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
        riskLow,
        riskMedium,
        riskHigh,
        freqLow,
        freqMedium,
        freqHigh,
      ] = await Promise.all([
        getPreset(offerId, 'low', 'medium'),
        getPreset(offerId, 'medium', 'medium'),
        getPreset(offerId, 'high', 'medium'),
        getPreset(offerId, 'medium', 'low'),
        getPreset(offerId, 'medium', 'medium'),
        getPreset(offerId, 'medium', 'high'),
      ]);

      const preset = riskMedium || freqMedium || riskLow || riskHigh || freqLow || freqHigh;
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

      const riskPresets = {
        low: toCatalogPreset(riskLow, fallbackPresetMeta) || legacy?.sliderPresets?.risk?.low || null,
        medium: toCatalogPreset(riskMedium || freqMedium, fallbackPresetMeta) || legacy?.sliderPresets?.risk?.medium || null,
        high: toCatalogPreset(riskHigh, fallbackPresetMeta) || legacy?.sliderPresets?.risk?.high || null,
      } as Record<Level3, CatalogPreset | null>;

      const tradeFrequencyPresets = {
        low: toCatalogPreset(freqLow, fallbackPresetMeta) || legacy?.sliderPresets?.tradeFrequency?.low || null,
        medium: toCatalogPreset(freqMedium || riskMedium, fallbackPresetMeta) || legacy?.sliderPresets?.tradeFrequency?.medium || null,
        high: toCatalogPreset(freqHigh, fallbackPresetMeta) || legacy?.sliderPresets?.tradeFrequency?.high || null,
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
        equity: {
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

const normalizeModeForStrategy = (mode: string): 'mono' | 'synthetic' => (mode === 'mono' ? 'mono' : 'synthetic');

const getRiskLotPercent = (riskLevel: Level3): number => {
  if (riskLevel === 'low') return 6;
  if (riskLevel === 'high') return 14;
  return 10;
};

const toPresetOnlyEquity = (initialBalance: number, retPercent: number): Array<{ time: number; equity: number }> => {
  const start = Number.isFinite(initialBalance) && initialBalance > 0 ? initialBalance : 10000;
  const end = Number((start * (1 + (Number(retPercent) || 0) / 100)).toFixed(4));
  const now = Date.now();
  return [
    { time: now - 1000, equity: start },
    { time: now, equity: end },
  ];
};

const buildPresetOnlySingleSummary = (
  initialBalance: number,
  preset: CatalogPreset,
  market: string,
  strategyName: string
): Record<string, unknown> => {
  const ret = asNumber(preset.metrics.ret, 0);
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
    maxDrawdownPercent: asNumber(preset.metrics.dd, 0),
    maxDrawdownAbsolute: Number((initialBalance * asNumber(preset.metrics.dd, 0) / 100).toFixed(4)),
    tradesCount: Math.max(0, Math.floor(asNumber(preset.metrics.trades, 0))),
    winRatePercent: asNumber(preset.metrics.wr, 0),
    profitFactor: asNumber(preset.metrics.pf, 1),
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
  selectedOffers: Array<{ offerId: string; offer: CatalogOffer; preset: CatalogPreset }>
): Record<string, unknown> => {
  const count = selectedOffers.length || 1;
  const avgRet = selectedOffers.reduce((acc, item) => acc + asNumber(item.preset.metrics.ret, 0), 0) / count;
  const avgPf = selectedOffers.reduce((acc, item) => acc + asNumber(item.preset.metrics.pf, 1), 0) / count;
  const avgWr = selectedOffers.reduce((acc, item) => acc + asNumber(item.preset.metrics.wr, 0), 0) / count;
  const maxDd = selectedOffers.reduce((acc, item) => Math.max(acc, asNumber(item.preset.metrics.dd, 0)), 0);
  const totalTrades = selectedOffers.reduce((acc, item) => acc + Math.max(0, Math.floor(asNumber(item.preset.metrics.trades, 0))), 0);
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
    offer.sliderPresets?.risk?.low,
    offer.sliderPresets?.risk?.medium,
    offer.sliderPresets?.risk?.high,
    offer.sliderPresets?.tradeFrequency?.low,
    offer.sliderPresets?.tradeFrequency?.medium,
    offer.sliderPresets?.tradeFrequency?.high,
  ].filter((item): item is CatalogPreset => !!item);

  const out: CatalogPreset[] = [];
  const seen = new Set<number>();
  for (const item of values) {
    if (seen.has(item.strategyId)) {
      continue;
    }
    seen.add(item.strategyId);
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
  const ddRank = new Map<number, number>();
  const tradeRank = new Map<number, number>();

  sortedByDd.forEach((item, index) => ddRank.set(item.strategyId, index));
  sortedByTrades.forEach((item, index) => tradeRank.set(item.strategyId, index));

  const targetDd = (levelToPreferenceScore(riskLevel) / 10) * Math.max(sortedByDd.length - 1, 0);
  const targetTrades = (levelToPreferenceScore(tradeFrequencyLevel) / 10) * Math.max(sortedByTrades.length - 1, 0);

  return [...candidates].sort((left, right) => {
    const leftScore = Math.abs((ddRank.get(left.strategyId) || 0) - targetDd) + Math.abs((tradeRank.get(left.strategyId) || 0) - targetTrades);
    const rightScore = Math.abs((ddRank.get(right.strategyId) || 0) - targetDd) + Math.abs((tradeRank.get(right.strategyId) || 0) - targetTrades);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return asNumber(right.score, 0) - asNumber(left.score, 0);
  })[0];
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
  const ddRank = new Map<number, number>();
  const tradeRank = new Map<number, number>();

  sortedByDd.forEach((item, index) => ddRank.set(item.strategyId, index));
  sortedByTrades.forEach((item, index) => tradeRank.set(item.strategyId, index));

  const targetDd = (normalizePreferenceScore(riskScore, riskLevel) / 10) * Math.max(sortedByDd.length - 1, 0);
  const targetTrades = (normalizePreferenceScore(tradeFrequencyScore, tradeFrequencyLevel) / 10) * Math.max(sortedByTrades.length - 1, 0);

  return [...candidates].sort((left, right) => {
    const leftScore = Math.abs((ddRank.get(left.strategyId) || 0) - targetDd) + Math.abs((tradeRank.get(left.strategyId) || 0) - targetTrades);
    const rightScore = Math.abs((ddRank.get(right.strategyId) || 0) - targetDd) + Math.abs((tradeRank.get(right.strategyId) || 0) - targetTrades);
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
  return `SAAS::${tenant.slug}::${record.marketMode.toUpperCase()}::${record.strategyType}::${record.market}`;
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
       SUM(CASE WHEN COALESCE(tsm.is_enabled, 1) = 1 THEN 1 ELSE 0 END) AS enabled_members
     FROM trading_systems ts
     JOIN api_keys ak ON ak.id = ts.api_key_id
     LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id
     GROUP BY ts.id, ts.name, ak.name, ts.is_active, ts.discovery_enabled, ts.updated_at
     ORDER BY
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

  return {
    apiKeyName: asString(row.api_key_name),
    systemId: asNumber(row.system_id, 0),
    systemName: asString(row.system_name),
  };
};

const ensurePublishedSourceSystem = async (tenantId?: number): Promise<{ apiKeyName: string; systemId: number; systemName: string }> => {
  const catalog = loadLatestClientCatalog();

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

  const apiKeyName = asString(catalog.apiKeyName);
  const systemName = `ALGOFUND_MASTER::${apiKeyName}`;
  const systems = await listTradingSystems(apiKeyName);
  const existing = systems.find((item) => asString(item.name) === systemName);
  const members = (catalog.adminTradingSystemDraft?.members || []).map((item, index) => ({
    strategy_id: Number(item.strategyId),
    weight: asNumber(item.weight, index === 0 ? 1.25 : index === 1 ? 1.1 : 1),
    member_role: index < 3 ? 'core' : 'satellite',
    is_enabled: true,
    notes: `algofund_master ${item.strategyType} ${item.market}`,
  }));

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
    language?: string;
    email?: string;
    fullName?: string;
  }) => {
    const displayName = asString(payload.displayName, '').trim();
    if (!displayName) throw new Error('displayName is required');
    if (payload.productMode !== 'strategy_client' && payload.productMode !== 'algofund_client') {
      throw new Error('productMode must be strategy_client or algofund_client');
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

    const apiKeyName = asString(payload.assignedApiKeyName, '');
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
    } else {
      await ensureAlgofundProfile(tenant.id, apiKeyName);
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
  tokenConfigured: boolean;
  chatConfigured: boolean;
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
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', [key]);
  const value = String(row?.value || '').trim();
  return value || fallback;
};

const setRuntimeFlag = async (key: string, value: string): Promise<void> => {
  await db.run(
    `INSERT INTO app_runtime_flags (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
};

export const getAdminTelegramControls = async (): Promise<AdminTelegramControls> => {
  const [adminEnabledRaw, clientsEnabledRaw] = await Promise.all([
    getRuntimeFlag('telegram.admin.enabled', '1'),
    getRuntimeFlag('telegram.clients.enabled', '0'),
  ]);

  return {
    adminEnabled: adminEnabledRaw !== '0',
    clientsEnabled: clientsEnabledRaw !== '0',
    tokenConfigured: Boolean(String(process.env.TELEGRAM_ADMIN_BOT_TOKEN || '').trim()),
    chatConfigured: Boolean(String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim()),
  };
};

export const updateAdminTelegramControls = async (payload: {
  adminEnabled?: boolean;
  clientsEnabled?: boolean;
}): Promise<AdminTelegramControls> => {
  if (payload.adminEnabled !== undefined) {
    await setRuntimeFlag('telegram.admin.enabled', payload.adminEnabled ? '1' : '0');
  }
  if (payload.clientsEnabled !== undefined) {
    await setRuntimeFlag('telegram.clients.enabled', payload.clientsEnabled ? '1' : '0');
  }

  return getAdminTelegramControls();
};

export const getOfferStoreAdminState = async (): Promise<OfferStoreState> => {
  const { catalog: sourceCatalog, sweep } = await loadCatalogAndSweepWithFallback();
  const apiKeys = await getAvailableApiKeyNames();
  const catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  const allOffers = catalog ? getAllOffers(catalog) : [];
  const offerIds = allOffers.map((item) => String(item.offerId));
  const defaults = normalizeOfferStoreDefaults(safeJsonParse(
    await getRuntimeFlag('offer.store.defaults', JSON.stringify(DEFAULT_OFFER_STORE_DEFAULTS)),
    DEFAULT_OFFER_STORE_DEFAULTS,
  ));
  const publishedFromFlag = safeJsonParse<string[]>(await getRuntimeFlag('offer.store.published_ids', ''), []);
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
      const trades = Math.max(0, Math.floor(asNumber(sweepRecord?.tradesCount, offer.metrics?.trades || 0)));
      return {
        offerId: String(offer.offerId || ''),
        titleRu: asString(offer.titleRu, offer.offerId),
        mode: (offer.strategy?.mode === 'synth' ? 'synth' : 'mono') as 'mono' | 'synth',
        market: asString(offer.strategy?.market, ''),
        strategyId,
        score: Number(asNumber(sweepRecord?.score, offer.metrics?.score || 0).toFixed(3)),
        ret: Number(asNumber(sweepRecord?.totalReturnPercent, offer.metrics?.ret || 0).toFixed(3)),
        pf: Number(asNumber(sweepRecord?.profitFactor, offer.metrics?.pf || 0).toFixed(3)),
        dd: Number(asNumber(sweepRecord?.maxDrawdownPercent, offer.metrics?.dd || 0).toFixed(3)),
        trades,
        tradesPerDay: Number((trades / Math.max(1, periodDays)).toFixed(3)),
        periodDays,
        published: publishedSet.has(String(offer.offerId || '')),
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
    offers: rawOffers.map((row) => ({
      ...row,
      equityPoints: equityByOfferId.get(row.offerId) || [],
    })),
  };
};

export const updateOfferStoreAdminState = async (payload: {
  defaults?: Partial<OfferStoreDefaults>;
  publishedOfferIds?: string[];
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

  await Promise.all([
    setRuntimeFlag('offer.store.defaults', JSON.stringify(nextDefaults)),
    setRuntimeFlag('offer.store.published_ids', JSON.stringify(nextPublished)),
  ]);

  return getOfferStoreAdminState();
};

export const getAdminReportSettings = async (): Promise<AdminReportSettings> => {
  const raw = await getRuntimeFlag('admin.reports.settings', JSON.stringify(DEFAULT_ADMIN_REPORT_SETTINGS));
  return normalizeAdminReportSettings(safeJsonParse<Record<string, unknown>>(raw, DEFAULT_ADMIN_REPORT_SETTINGS));
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
  const catalog = sourceCatalog || await buildFallbackCatalogFromPresets(sourceCatalog, apiKeys);
  const sweepSummary = sourceSweep
    ? {
      timestamp: sourceSweep.timestamp,
      period: buildPeriodInfo(sourceSweep),
      counts: sourceSweep.counts,
      selectedMembers: sourceSweep.selectedMembers,
      topByMode: sourceSweep.topByMode,
      topAll: (Array.isArray(sourceSweep.topAll) ? sourceSweep.topAll : []).slice(0, 12),
      portfolioFull: sourceSweep.portfolioResults?.[0] || null,
    }
    : buildFallbackSweepSummary(catalog);
  const recommendedSets = buildRecommendedSets(catalog);
  const tenants = await listTenantSummaries();
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
  } else {
    await db.run(
      `UPDATE algofund_profiles
       SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
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

const listTenantSummaries = async () => {
  const rows = await db.all('SELECT * FROM tenants ORDER BY id ASC');
  const out = [] as Array<Record<string, unknown>>;

  for (const tenant of (Array.isArray(rows) ? rows : []) as TenantRow[]) {
    const plan = await getPlanForTenant(tenant.id);
    const capabilities = resolvePlanCapabilities(plan);
    const strategyProfile = await getStrategyClientProfile(tenant.id);
    const algofundProfile = await getAlgofundProfile(tenant.id);
    const monitoring = capabilities.monitoring && tenant.assigned_api_key_name
      ? await getMonitoringLatest(tenant.assigned_api_key_name).catch(() => null)
      : null;
    out.push({
      tenant,
      plan,
      capabilities,
      strategyProfile: strategyProfile ? {
        ...strategyProfile,
        selectedOfferIds: safeJsonParse<string[]>(strategyProfile.selected_offer_ids_json, []),
        latestPreview: safeJsonParse<Record<string, unknown>>(strategyProfile.latest_preview_json, {}),
      } : null,
      algofundProfile: algofundProfile ? {
        ...algofundProfile,
        latestPreview: safeJsonParse<Record<string, unknown>>(algofundProfile.latest_preview_json, {}),
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
  const monitoring = capabilities.monitoring && tenant.assigned_api_key_name
    ? await getMonitoringLatest(tenant.assigned_api_key_name).catch(() => null)
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
  const directExecute = Boolean(options?.directExecute) && (requestType === 'start' || requestType === 'stop');

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

const getAlgofundEngineState = async (
  tenant: TenantRow,
  profile: AlgofundProfileRow
): Promise<{ apiKeyName: string; systemId: number; systemName: string; isActive: boolean } | null> => {
  const apiKeyName = asString(profile.assigned_api_key_name || tenant.assigned_api_key_name);
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

  const assignedApiKeyName = asString(profile.assigned_api_key_name || tenant.assigned_api_key_name);
  if (!assignedApiKeyName) {
    throw new Error('Assign an API key to this algofund client first');
  }

  const draftMembers = catalog.adminTradingSystemDraft?.members || [];
  if (draftMembers.length === 0) {
    throw new Error('Admin TS draft members are empty in latest client catalog');
  }

  const riskMultiplier = Math.max(0, Math.min(asNumber(profile.risk_multiplier, 1), asNumber(plan.risk_cap_max, 1)));
  const materializedStrategies = await upsertTenantStrategies(
    tenant,
    assignedApiKeyName,
    draftMembers.map((member, index) => {
      const record = findSweepRecordByStrategyId(sweep, Number(member.strategyId));
      if (!record) {
        throw new Error(`Sweep record not found for admin TS strategyId=${member.strategyId}`);
      }
      return {
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
      };
    }),
    asNumber(plan.max_deposit_total, 1000),
    riskMultiplier <= 0.85 ? 'low' : riskMultiplier >= 1.4 ? 'high' : 'medium',
    activate || profile.requested_enabled === 1
  );

  const systems = await listTradingSystems(assignedApiKeyName);
  const systemName = getAlgofundClientSystemName(tenant);
  const existing = systems.find((item) => asString(item.name) === systemName);
  const members = materializedStrategies.map((row, index) => ({
    strategy_id: Number(row.strategyId),
    weight: Number(((index === 0 ? 1.25 : index === 1 ? 1.1 : 1) * Math.max(0.25, riskMultiplier)).toFixed(4)),
    member_role: index < 3 ? 'core' : 'satellite',
    is_enabled: true,
    notes: `algofund ${tenant.slug}`,
  }));

  let systemId = 0;
  if (existing?.id) {
    await updateTradingSystem(assignedApiKeyName, Number(existing.id), {
      name: systemName,
      description: `Algofund managed TS for ${tenant.display_name}`,
      auto_sync_members: false,
      discovery_enabled: false,
      max_members: Math.max(6, members.length),
    });
    await replaceTradingSystemMembers(assignedApiKeyName, Number(existing.id), members);
    systemId = Number(existing.id);
  } else {
    const created = await createTradingSystem(assignedApiKeyName, {
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
    await setTradingSystemActivation(assignedApiKeyName, systemId, true, true);
  }

  await db.run(
    `UPDATE algofund_profiles
     SET assigned_api_key_name = ?,
         published_system_name = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [assignedApiKeyName, systemName, tenant.id]
  );

  return {
    systemId,
    systemName,
    assignedApiKeyName,
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
  const effectiveProfile: AlgofundProfileRow = {
    ...profile,
    actual_enabled: engine ? (engine.isActive ? 1 : 0) : profile.actual_enabled,
    published_system_name: engine?.systemName || profile.published_system_name,
    assigned_api_key_name: engine?.apiKeyName || profile.assigned_api_key_name,
  };

  if (
    effectiveProfile.actual_enabled !== profile.actual_enabled
    || effectiveProfile.published_system_name !== profile.published_system_name
    || effectiveProfile.assigned_api_key_name !== profile.assigned_api_key_name
  ) {
    await db.run(
      `UPDATE algofund_profiles
       SET actual_enabled = ?,
           published_system_name = ?,
           assigned_api_key_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [
        effectiveProfile.actual_enabled,
        effectiveProfile.published_system_name,
        effectiveProfile.assigned_api_key_name,
        tenantId,
      ]
    );
  }

  const capabilities = resolvePlanCapabilities(plan);
  const availableSystemsRaw = effectiveProfile.assigned_api_key_name || tenant.assigned_api_key_name
    ? await listTradingSystems(asString(effectiveProfile.assigned_api_key_name || tenant.assigned_api_key_name)).catch(() => [])
    : [];
  const availableSystems = (Array.isArray(availableSystemsRaw) ? availableSystemsRaw : []).map((item: any) => ({
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
          apiKeyName: asString(effectiveProfile.assigned_api_key_name || tenant.assigned_api_key_name, ''),
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
  const nextApiKeyName = asString(payload.assignedApiKeyName, profile.assigned_api_key_name || tenant.assigned_api_key_name);
  const nextRequestedEnabled = payload.requestedEnabled !== undefined
    ? payload.requestedEnabled
    : Number(profile.requested_enabled || 0) === 1;

  await db.run(
    `UPDATE algofund_profiles
     SET risk_multiplier = ?, assigned_api_key_name = ?, requested_enabled = ?, updated_at = CURRENT_TIMESTAMP
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

  const apiKeyName = asString(profile.assigned_api_key_name || tenant.assigned_api_key_name);
  const requestPayload: AlgofundRequestPayload = {
    targetSystemId: undefined,
    targetSystemName: undefined,
  };

  if (requestType === 'switch_system') {
    const targetSystemId = Math.floor(asNumber(payload.targetSystemId, 0));
    if (!targetSystemId || targetSystemId <= 0) {
      throw new Error('targetSystemId is required for switch_system request');
    }
    if (!apiKeyName) {
      throw new Error('Assign API key before requesting system switch');
    }

    const systems = await listTradingSystems(apiKeyName);
    const target = systems.find((item) => Number(item.id) === targetSystemId);
    if (!target?.id) {
      throw new Error(`Target trading system not found: ${targetSystemId}`);
    }

    requestPayload.targetSystemId = Number(target.id);
    requestPayload.targetSystemName = asString(target.name, '');
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
    const algofundApiKey = asString(profile.assigned_api_key_name || tenant.assigned_api_key_name);
    const systems = await listTradingSystems(algofundApiKey);
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
    const apiKeyName = asString(profile.assigned_api_key_name || tenant.assigned_api_key_name);
    if (!apiKeyName) {
      throw new Error('Assign API key before approving switch request');
    }

    const targetSystemId = Math.floor(asNumber(requestPayload.targetSystemId, 0));
    if (targetSystemId <= 0) {
      throw new Error('Switch request payload is missing targetSystemId');
    }

    const systems = await listTradingSystems(apiKeyName);
    const target = systems.find((item) => Number(item.id) === targetSystemId);
    if (!target?.id) {
      throw new Error(`Target trading system not found: ${targetSystemId}`);
    }

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
           published_system_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ?`,
      [asString(target.name), row.tenant_id]
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

export const publishAdminTradingSystem = async () => {
  const sourceSystem = await ensurePublishedSourceSystem(undefined);
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
    preview: {
      ...preview,
      period,
    },
    catalog: loadLatestClientCatalog(),
  };
};

export const seedDemoSaasData = async () => {
  await ensureSaasSeedData();
  return getSaasAdminSummary();
};

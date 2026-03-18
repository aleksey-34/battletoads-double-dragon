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
import { Strategy } from '../config/settings';
import { db } from '../utils/database';
import logger from '../utils/logger';
import { initResearchDb } from '../research/db';
import { getPreset, listOfferIds } from '../research/presetBuilder';

export type ProductMode = 'strategy_client' | 'algofund_client';
export type Level3 = 'low' | 'medium' | 'high';
export type RequestStatus = 'pending' | 'approved' | 'rejected';

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
  risk_level: Level3;
  trade_frequency_level: Level3;
  requested_enabled: number;
  actual_enabled: number;
  assigned_api_key_name: string;
  latest_preview_json: string;
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
  request_type: 'start' | 'stop';
  status: RequestStatus;
  note: string;
  decision_note: string;
  created_at: string;
  decided_at: string | null;
};

type CatalogMetricSet = {
  ret: number;
  pf: number;
  dd: number;
  wr: number;
  trades: number;
};

type CatalogPreset = {
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

type CatalogOffer = {
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

type CatalogData = {
  timestamp: string;
  apiKeyName: string;
  source: {
    sweepFile: string;
    sweepTimestamp: string | null;
  };
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

type SweepRecord = {
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

type SweepData = {
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
  { code: 'strategy_15', title: 'Strategy Client 15', productMode: 'strategy_client', priceUsdt: 15, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 1, allowTsStartStopRequests: false, features: { monoOrSynth: 1 } },
  { code: 'strategy_20', title: 'Strategy Client 20', productMode: 'strategy_client', priceUsdt: 20, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 3, allowTsStartStopRequests: false, features: { monoOrSynth: 3 } },
  { code: 'strategy_25', title: 'Strategy Client 25', productMode: 'strategy_client', priceUsdt: 25, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 3, allowTsStartStopRequests: false, features: { exchanges: 2 } },
  { code: 'strategy_30', title: 'Strategy Client 30', productMode: 'strategy_client', priceUsdt: 30, maxDepositTotal: 1000, riskCapMax: 0, maxStrategiesTotal: 3, allowTsStartStopRequests: false, features: { exchanges: 3 } },
  { code: 'strategy_50', title: 'Strategy Client 50', productMode: 'strategy_client', priceUsdt: 50, maxDepositTotal: 5000, riskCapMax: 0, maxStrategiesTotal: 6, allowTsStartStopRequests: true, features: { mono: 3, synth: 3, complexTs: true } },
  { code: 'strategy_100', title: 'Strategy Client 100', productMode: 'strategy_client', priceUsdt: 100, maxDepositTotal: 10000, riskCapMax: 0, maxStrategiesTotal: 6, allowTsStartStopRequests: true, features: { mono: 3, synth: 3, complexTs: true, extraExchangeRequest: true } },
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

const asString = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const CLIENT_STRICT_PRESET_MODE = String(process.env.CLIENT_STRICT_PRESET_MODE || '1').trim() !== '0';

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

const getAlgofundProfile = async (tenantId: number): Promise<AlgofundProfileRow | null> => {
  const row = await db.get('SELECT * FROM algofund_profiles WHERE tenant_id = ?', [tenantId]);
  return (row || null) as AlgofundProfileRow | null;
};

const getAlgofundRequestsByTenant = async (tenantId: number): Promise<AlgofundRequestRow[]> => {
  const rows = await db.all(
    'SELECT * FROM algofund_start_stop_requests WHERE tenant_id = ? ORDER BY id DESC LIMIT 30',
    [tenantId]
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
        descriptionRu: legacy?.descriptionRu || 'Preset-backed offer',
        strategy: {
          id: Number(config.strategyId || legacy?.strategy?.id || 0),
          name: String(config.name || legacy?.strategy?.name || offerId),
          type: String(config.strategy_type || legacy?.strategy?.type || 'DD_BattleToads'),
          mode: (String(config.market_mode || legacy?.strategy?.mode || 'mono') === 'synthetic' ? 'synth' : 'mono') as 'mono' | 'synth',
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

    return offers.filter((item): item is CatalogOffer => !!item);
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

const ensurePublishedSourceSystem = async (): Promise<{ apiKeyName: string; systemId: number; systemName: string }> => {
  const catalog = loadLatestClientCatalog();
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

const scaleEquityPreview = (
  points: Array<{ time: number; equity: number }>,
  riskMultiplier: number
): Array<{ time: number; equity: number }> => {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  const initial = asNumber(points[0].equity, 0);
  return points.map((item) => ({
    time: Number(item.time),
    equity: Number((initial + (asNumber(item.equity, initial) - initial) * riskMultiplier).toFixed(4)),
  }));
};

export const getSaasAdminSummary = async () => {
  await ensureSaasSeedData();
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
      topAll: sourceSweep.topAll.slice(0, 12),
      portfolioFull: sourceSweep.portfolioResults?.[0] || null,
    }
    : buildFallbackSweepSummary(catalog);
  const recommendedSets = buildRecommendedSets(catalog);
  const tenants = await listTenantSummaries();
  const plans = await listPlans();

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
  };
};

export const updateTenantAdminState = async (tenantId: number, payload: {
  displayName?: string;
  status?: string;
  assignedApiKeyName?: string;
  planCode?: string;
}) => {
  await ensureSaasSeedData();
  const tenant = await getTenantById(tenantId);

  const nextDisplayName = asString(payload.displayName, tenant.display_name);
  const nextStatus = asString(payload.status, tenant.status || 'active');
  const nextAssignedApiKeyName = asString(payload.assignedApiKeyName, tenant.assigned_api_key_name);

  await db.run(
    `UPDATE tenants
     SET display_name = ?, status = ?, assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextDisplayName, nextStatus, nextAssignedApiKeyName, tenantId]
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
  const catalog = loadLatestClientCatalog();
  const presetOffers = await buildPresetBackedOffers(catalog);
  const recommendedSets = buildRecommendedSets(catalog);
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
      selectedOfferIds: safeJsonParse<string[]>(profile.selected_offer_ids_json, []),
      latestPreview: hydrateStoredStrategyPreview(catalog, profile.latest_preview_json),
    } : null,
    catalog,
    offers: presetOffers,
    recommendedSets,
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
  if (!existing) {
    throw new Error(`Strategy client profile not found for tenant ${tenant.slug}`);
  }

  const nextRiskLevel = payload.riskLevel || existing.risk_level || 'medium';
  const nextTradeFrequencyLevel = payload.tradeFrequencyLevel || existing.trade_frequency_level || 'medium';
  const nextOfferIds = Array.isArray(payload.selectedOfferIds)
    ? payload.selectedOfferIds
    : safeJsonParse<string[]>(existing.selected_offer_ids_json, []);
  const nextAssignedApiKeyName = asString(payload.assignedApiKeyName, existing.assigned_api_key_name || tenant.assigned_api_key_name);
  const nextRequestedEnabled = payload.requestedEnabled !== undefined ? payload.requestedEnabled : existing.requested_enabled === 1;

  await db.run(
    `UPDATE strategy_client_profiles
     SET selected_offer_ids_json = ?,
         risk_level = ?,
         trade_frequency_level = ?,
         requested_enabled = ?,
         assigned_api_key_name = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [JSON.stringify(nextOfferIds), nextRiskLevel, nextTradeFrequencyLevel, nextRequestedEnabled ? 1 : 0, nextAssignedApiKeyName, tenantId]
  );

  await db.run(
    `UPDATE tenants
     SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextAssignedApiKeyName, tenantId]
  );

  return getStrategyClientState(tenantId);
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

  const uniqueStrategyIds = Array.from(new Set(selectedOffers.map((item) => Number(item.preset.strategyId)).filter((item) => Number.isFinite(item) && item > 0)));

  if (uniqueStrategyIds.length === 0) {
    throw new Error('Selected offers did not resolve to valid strategies');
  }

  const presetOnlyMode = CLIENT_STRICT_PRESET_MODE || !state.capabilities?.backtest;
  if (presetOnlyMode) {
    return {
      period,
      controls,
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

  if (plan.max_strategies_total > 0 && selectedOfferIds.length > plan.max_strategies_total) {
    throw new Error(`Selected offers exceed plan limit (${selectedOfferIds.length}/${plan.max_strategies_total})`);
  }

  const assignedApiKeyName = asString(profile.assigned_api_key_name || state.tenant.assigned_api_key_name);
  if (!assignedApiKeyName) {
    throw new Error('Assign an API key to this strategy client first');
  }

  const sweep = loadLatestSweep();
  if (!sweep) {
    throw new Error('Historical sweep JSON not found in results/.');
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

const materializeAlgofundSystem = async (
  tenant: TenantRow,
  plan: PlanRow,
  profile: AlgofundProfileRow,
  activate: boolean
) => {
  const catalog = loadLatestClientCatalog();
  const sweep = loadLatestSweep();
  if (!catalog || !sweep) {
    throw new Error('Catalog or sweep JSON missing in results/.');
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

  return {
    systemId,
    systemName,
    assignedApiKeyName,
    riskMultiplier,
    strategies: materializedStrategies,
  };
};

export const getAlgofundState = async (tenantId: number, requestedRiskMultiplier?: number, allowPreviewAbovePlan = false) => {
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

  const capabilities = resolvePlanCapabilities(plan);
  const maxPreviewRiskMultiplier = allowPreviewAbovePlan
    ? Math.max(10, asNumber(plan.risk_cap_max, 1))
    : asNumber(plan.risk_cap_max, 1);
  const riskMultiplier = Math.max(0, Math.min(
    requestedRiskMultiplier !== undefined ? requestedRiskMultiplier : asNumber(profile.risk_multiplier, 1),
    maxPreviewRiskMultiplier
  ));

  const sweep = loadLatestSweep();
  const period = buildPeriodInfo(sweep);

  const sourceSystem = await ensurePublishedSourceSystem();
  const basePreviewResult = await runTradingSystemBacktest(sourceSystem.apiKeyName, sourceSystem.systemId, {
    bars: 6000,
    warmupBars: 400,
    skipMissingSymbols: true,
    initialBalance: 10000,
    commissionPercent: 0.1,
    slippagePercent: 0.05,
    fundingRatePercent: 0,
  });

  const scaledEquity = scaleEquityPreview(basePreviewResult.equityCurve, riskMultiplier);
  const latest = scaledEquity.length > 0 ? scaledEquity[scaledEquity.length - 1] : null;
  const initial = scaledEquity.length > 0 ? scaledEquity[0].equity : asNumber(basePreviewResult.summary.initialBalance, 10000);
  const totalReturnPercent = initial > 0 && latest ? ((latest.equity - initial) / initial) * 100 : asNumber(basePreviewResult.summary.totalReturnPercent, 0) * riskMultiplier;

  const preview = {
    riskMultiplier,
    sourceSystem,
    summary: {
      ...basePreviewResult.summary,
      finalEquity: latest ? latest.equity : asNumber(basePreviewResult.summary.finalEquity, 0),
      totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
      maxDrawdownPercent: Number((asNumber(basePreviewResult.summary.maxDrawdownPercent, 0) * riskMultiplier).toFixed(2)),
    },
    period,
    equityCurve: scaledEquity,
    blockedByPlan: false,
  };

  await db.run(
    `UPDATE algofund_profiles
     SET latest_preview_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [JSON.stringify(preview), tenantId]
  );

  return {
    tenant,
    plan,
    capabilities,
    profile: {
      ...profile,
      latestPreview: safeJsonParse<Record<string, unknown>>(profile.latest_preview_json, {}),
    },
    preview,
    requests: await getAlgofundRequestsByTenant(tenantId),
    catalog: loadLatestClientCatalog(),
  };
};

export const updateAlgofundState = async (tenantId: number, payload: { riskMultiplier?: number; assignedApiKeyName?: string }) => {
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

  await db.run(
    `UPDATE algofund_profiles
     SET risk_multiplier = ?, assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [nextRiskMultiplier, nextApiKeyName, tenantId]
  );

  await db.run(
    `UPDATE tenants
     SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextApiKeyName, tenantId]
  );

  return getAlgofundState(tenantId, nextRiskMultiplier);
};

export const requestAlgofundAction = async (tenantId: number, requestType: 'start' | 'stop', note: string) => {
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

  await db.run(
    `INSERT INTO algofund_start_stop_requests (tenant_id, request_type, status, note, decision_note, created_at)
     VALUES (?, ?, 'pending', ?, '', CURRENT_TIMESTAMP)`,
    [tenantId, requestType, note]
  );

  await db.run(
    `UPDATE algofund_profiles
     SET requested_enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [requestType === 'start' ? 1 : 0, tenantId]
  );

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'algofund_client', ?, ?, CURRENT_TIMESTAMP)`,
    [tenantId, `algofund_${requestType}_request`, JSON.stringify({ note })]
  );

  return getAlgofundState(tenantId);
};

export const resolveAlgofundRequest = async (requestId: number, status: RequestStatus, decisionNote: string) => {
  const request = await db.get('SELECT * FROM algofund_start_stop_requests WHERE id = ?', [requestId]);
  if (!request) {
    throw new Error(`Algofund request not found: ${requestId}`);
  }

  const row = request as AlgofundRequestRow;
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
    if (row.request_type === 'start') {
      await materializeAlgofundSystem(tenant, plan, { ...profile, requested_enabled: 1 }, true);
      await db.run('UPDATE algofund_profiles SET actual_enabled = 1, requested_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [row.tenant_id]);
    } else {
      const systems = await listTradingSystems(asString(profile.assigned_api_key_name || tenant.assigned_api_key_name));
      const existing = systems.find((item) => asString(item.name) === getAlgofundClientSystemName(tenant));
      if (existing?.id) {
        await setTradingSystemActivation(asString(profile.assigned_api_key_name || tenant.assigned_api_key_name), Number(existing.id), false, true);
      }
      await db.run('UPDATE algofund_profiles SET actual_enabled = 0, requested_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?', [row.tenant_id]);
    }
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

export const publishAdminTradingSystem = async () => {
  const sourceSystem = await ensurePublishedSourceSystem();
  const period = buildPeriodInfo(loadLatestSweep());
  const preview = await runTradingSystemBacktest(sourceSystem.apiKeyName, sourceSystem.systemId, {
    bars: 6000,
    warmupBars: 400,
    skipMissingSymbols: true,
    initialBalance: 10000,
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  message,
  Modal,
  Row,
  Select,
  Segmented,
  Slider,
  Space,
  Spin,
  Steps,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

const { Paragraph, Text, Title } = Typography;
const LEGACY_PRESET_SET_KEYS = new Set(['balancedbot', 'conservativebot', 'monostarter', 'synthstarter', 'momentumbot', 'premiummix']);

type ProductMode = 'strategy_client' | 'algofund_client' | 'copytrading_client' | 'synctrade_client' | 'dual';
type Level3 = 'low' | 'medium' | 'high';
type RequestStatus = 'pending' | 'approved' | 'rejected';
type SaasTabKey = 'admin' | 'strategy-client' | 'algofund' | 'copytrading' | 'synctrade';
type AdminTabKey = 'offer-ts' | 'clients' | 'monitoring' | 'create-user';
type SummaryScope = 'light' | 'full';
type CopytradingUiStatus = 'idle' | 'copying' | 'stopped' | 'saving' | 'error';

type SaasBacktestContext = {
  kind: 'offer' | 'algofund-ts';
  title: string;
  description: string;
  offerId?: string;
  offerPublished?: boolean;
  offerIds?: string[];
  offerWeightsById?: Record<string, number>;
  setKey?: string;
  systemName?: string;
};

type AdminSweepBacktestPreviewResponse = {
  kind: 'offer' | 'algofund-ts';
  publishMeta?: {
    offerIds?: string[];
    setKey?: string;
    membersCount?: number;
    systemName?: string;
  };
  controls: {
    riskScore: number;
    tradeFrequencyScore: number;
    riskLevel: Level3;
    tradeFrequencyLevel: Level3;
    initialBalance?: number;
    riskScaleMaxPercent?: number;
  };
  period?: PeriodInfo | null;
  sweepApiKeyName?: string;
  selectedOffers: Array<{
    offerId: string;
    titleRu: string;
    weight?: number;
    mode: 'mono' | 'synth';
    market: string;
    strategyId: number;
    strategyName: string;
    score: number;
    metricsSource?: 'offer_store' | 'snapshot_only';
    metrics: {
      ret: number;
      pf: number;
      dd: number;
      wr: number;
      trades: number;
    };
    tradesPerDay: number;
    periodDays: number;
    equityPoints: number[];
  }>;
  preview: {
    source?: string;
    summary?: {
      finalEquity?: number;
      totalReturnPercent?: number;
      maxDrawdownPercent?: number;
      profitFactor?: number;
      winRatePercent?: number;
      tradesCount?: number;
      unrealizedPnl?: number;
      marginLoadPercent?: number;
    } | null;
    equity?: EquityPoint[];
    curves?: {
      pnl?: EquityPoint[];
      drawdownPercent?: EquityPoint[];
      marginLoadPercent?: EquityPoint[];
    } | null;
    trades?: Array<Record<string, unknown>>;
  };
  rerun?: {
    requested?: boolean;
    executed?: boolean;
    apiKeyName?: string;
    error?: string;
    strategyIds?: number[];
    tsMembersCount?: number;
    riskMul?: number;
    riskScaleMaxPercent?: number;
    freqLevel?: Level3;
  };
};

type TradingSystemListItem = {
  id?: number;
  name: string;
  is_active: boolean;
  updated_at?: string;
  metrics?: {
    equity_usd?: number;
    unrealized_pnl?: number;
    margin_load_percent?: number;
    drawdown_percent?: number;
    effective_leverage?: number;
  };
};

type EquityPoint = {
  time: number;
  equity?: number;
  value?: number;
};

type LinePoint = {
  time: number;
  value: number;
};

type MetricSet = {
  ret?: number;
  pf?: number;
  dd?: number;
  wr?: number;
  trades?: number;
  score?: number;
};

type CatalogPreset = {
  strategyId: number;
  strategyName: string;
  score: number;
  metrics: MetricSet;
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
  };
  metrics: MetricSet & { robust?: boolean };
  sliderPresets?: {
    risk?: Record<Level3, CatalogPreset | null>;
    tradeFrequency?: Record<Level3, CatalogPreset | null>;
  };
  equity?: {
    source?: string;
    generatedAt?: string;
    points?: EquityPoint[];
    summary?: Record<string, unknown>;
  };
};

type StrategySelectionConstraints = {
  limits?: {
    maxStrategies?: number | null;
    minOffersPerSystem?: number | null;
    maxOffersPerSystem?: number | null;
    maxCustomSystems?: number | null;
    mono?: number | null;
    synth?: number | null;
    depositCap?: number | null;
    riskCap?: number | null;
  };
  usage?: {
    selected?: number;
    mono?: number;
    synth?: number;
    uniqueMarkets?: number;
    remainingSlots?: number | null;
    currentCustomSystems?: number;
    remainingCustomSystems?: number | null;
    estimatedDepositPerStrategy?: number | null;
  };
  violations?: string[];
  warnings?: string[];
};

type AlgofundPortfolioPassport = {
  generatedAt?: string;
  source?: string;
  selectionPolicy?: 'conservative' | 'balanced' | 'aggressive';
  period?: PeriodInfo | null;
  candidates?: Array<{
    strategyId: number;
    strategyName: string;
    strategyType: string;
    marketMode: string;
    market: string;
    weight: number;
    score: number;
    metrics: MetricSet;
  }>;
  portfolioSummary?: {
    initialBalance?: number;
    finalEquity?: number;
    totalReturnPercent?: number;
    maxDrawdownPercent?: number;
    winRatePercent?: number;
    profitFactor?: number;
    tradesCount?: number;
  } | null;
  blockedReasons?: string[];
};

type Tenant = {
  id: number;
  slug: string;
  display_name: string;
  product_mode: ProductMode;
  status: string;
  preferred_language: string;
  assigned_api_key_name: string;
};

type PeriodInfo = {
  dateFrom?: string | null;
  dateTo?: string | null;
  interval?: string | null;
};

type Plan = {
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
};

type TenantCapabilities = {
  settings: boolean;
  apiKeyUpdate: boolean;
  monitoring: boolean;
  backtest: boolean;
  startStopRequests: boolean;
};

type TenantSummary = {
  tenant: Tenant;
  plan: Plan | null;
  capabilities?: TenantCapabilities;
  strategyProfile?: {
    selectedOfferIds?: string[];
    latestPreview?: Record<string, unknown>;
    risk_level?: Level3;
    trade_frequency_level?: Level3;
    requested_enabled?: number;
    actual_enabled?: number;
    assigned_api_key_name?: string;
  } | null;
  algofundProfile?: {
    latestPreview?: Record<string, unknown>;
    risk_multiplier?: number;
    requested_enabled?: number;
    actual_enabled?: number;
    assigned_api_key_name?: string;
    published_system_name?: string;
  } | null;
  copytradingProfile?: {
    master_api_key_name?: string;
    requested_enabled?: number;
    actual_enabled?: number;
  } | null;
  monitoring?: {
    equity_usd?: number;
    unrealized_pnl?: number;
    margin_load_percent?: number;
    drawdown_percent?: number;
    effective_leverage?: number;
  } | null;
};

type MonitoringSnapshotPoint = {
  recorded_at?: string;
  equity_usd?: number;
  margin_load_percent?: number;
  effective_leverage?: number;
  drawdown_percent?: number;
};

type TelegramControls = {
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

type MonitoringPositionsDigest = {
  openCount: number;
  symbols: string[];
};

type MonitoringStrategyDigest = {
  total: number;
  active: number;
  activeAuto: number;
  withLastError: number;
};

type MonitoringReconciliationDigest = {
  reportCount: number;
  strategyCount: number;
  problematicCount: number;
  avgSamples: number;
  avgPnlDeltaPercent: number | null;
  avgWinRateDeltaPercent: number | null;
  latestAt: string;
};

type LowLotRecommendation = {
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
  suggestedDepositMin: number;
  suggestedLotPercent: number;
  tenants: Array<{ id: number; slug: string; displayName: string; mode: ProductMode }>;
  replacementCandidates: Array<{ symbol: string; score: number; note: string }>;
  systemId: number | null;
  eventSource: 'last_error' | 'runtime_event' | 'liquidity_trigger';
};

type LowLotRecommendationResponse = {
  generatedAt: string;
  periodHours: number;
  items: LowLotRecommendation[];
};

type SaasSummary = {
  sourceFiles: {
    latestCatalogPath: string;
    latestSweepPath: string;
  };
  catalog: {
    apiKeyName?: string;
    timestamp?: string;
    counts?: {
      evaluated?: number;
      robust?: number;
      monoCatalog?: number;
      synthCatalog?: number;
      adminTsMembers?: number;
    };
    clientCatalog?: {
      mono?: CatalogOffer[];
      synth?: CatalogOffer[];
    };
    adminTradingSystemDraft?: {
      name?: string;
      members?: Array<{
        strategyId: number;
        strategyName: string;
        strategyType: string;
        marketMode: string;
        market: string;
        score: number;
        weight: number;
      }>;
    };
  } | null;
  sweepSummary: {
    timestamp?: string;
    period?: PeriodInfo | null;
    counts?: {
      potentialRuns?: number;
      scheduledRuns?: number;
      evaluated?: number;
      failures?: number;
      robust?: number;
      durationSec?: number;
    };
    selectedMembers?: Array<{
      strategyId: number;
      strategyName: string;
      strategyType: string;
      marketMode: string;
      market: string;
      score: number;
      totalReturnPercent: number;
      maxDrawdownPercent: number;
      profitFactor: number;
    }>;
    topAll?: Array<{
      strategyId: number;
      strategyName: string;
      strategyType: string;
      marketMode: string;
      market: string;
      score: number;
      totalReturnPercent: number;
      maxDrawdownPercent: number;
      profitFactor: number;
    }>;
    topByMode?: {
      mono?: Array<{
        strategyId: number;
        strategyName: string;
        strategyType: string;
        marketMode: string;
        market: string;
        score: number;
        totalReturnPercent: number;
        maxDrawdownPercent: number;
        profitFactor: number;
      }>;
      synth?: Array<{
        strategyId: number;
        strategyName: string;
        strategyType: string;
        marketMode: string;
        market: string;
        score: number;
        totalReturnPercent: number;
        maxDrawdownPercent: number;
        profitFactor: number;
      }>;
    };
    portfolioFull?: {
      type?: string;
      summary?: {
        finalEquity?: number;
        totalReturnPercent?: number;
        maxDrawdownPercent?: number;
        profitFactor?: number;
        winRatePercent?: number;
        tradesCount?: number;
      } | null;
      error?: string;
    } | null;
  } | null;
  recommendedSets: Record<string, CatalogOffer[]>;
  tenants: TenantSummary[];
  plans: Plan[];
  apiKeys: string[];
  backtestPairRequests?: {
    pending: number;
    total: number;
  };
  algofundRequestQueue?: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    items: AlgofundRequest[];
  };
  offerStore?: {
    defaults: {
      periodDays: number;
      targetTradesPerDay: number;
      riskLevel: Level3;
    };
    publishedOfferIds: string[];
    algofundStorefrontSystemNames?: string[];
    tsBacktestSnapshots?: Record<string, {
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
      equityPoints?: number[];
      offerIds?: string[];
      backtestSettings?: {
        riskScore?: number;
        tradeFrequencyScore?: number;
        initialBalance?: number;
        riskScaleMaxPercent?: number;
      };
      updatedAt?: string;
    }>;
    tsBacktestSnapshot?: {
      ret: number;
      pf: number;
      dd: number;
      trades: number;
      tradesPerDay: number;
      periodDays: number;
      finalEquity: number;
      equityPoints?: number[];
      offerIds?: string[];
      backtestSettings?: {
        riskScore?: number;
        tradeFrequencyScore?: number;
        initialBalance?: number;
        riskScaleMaxPercent?: number;
      };
      updatedAt?: string;
    } | null;
    offers: Array<{
      offerId: string;
      titleRu: string;
      mode: 'mono' | 'synth';
      market: string;
      strategyType?: string;
      interval?: string;
      strategyParams?: {
        interval?: string;
        length?: number;
        takeProfitPercent?: number;
        detectionSource?: string;
        zscoreEntry?: number;
        zscoreExit?: number;
        zscoreStop?: number;
      } | null;
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
      equityPoints?: number[];
      backtestSettings?: {
        riskScore?: number;
        tradeFrequencyScore?: number;
        initialBalance?: number;
        riskScaleMaxPercent?: number;
      };
    }>;
  };
  reportSettings?: {
    enabled: boolean;
    tsDaily: boolean;
    tsWeekly: boolean;
    tsMonthly: boolean;
    offerDaily: boolean;
    offerWeekly: boolean;
    offerMonthly: boolean;
    sweepSnapshotAutoRefreshEnabled?: boolean;
    sweepSnapshotRefreshHours?: number;
    watchdogEnabled?: boolean;
  };
  snapshotRefresh?: {
    lastRunAt?: string;
    lastSweepPath?: string;
    lastSweepTimestamp?: string;
    lastResult?: 'success' | 'failed' | 'skipped' | 'idle';
    lastReason?: string;
    lastError?: string;
    systemsUpdated?: number;
    offersUpdated?: number;
    durationMs?: number;
  };
};

type AdminPerformanceReport = {
  generatedAt: string;
  period: 'daily' | 'weekly' | 'monthly';
  periodHours: number;
  settings: SaasSummary['reportSettings'];
  tradingSystems: Array<{
    apiKeyName: string;
    id: number;
    name: string;
    isActive: boolean;
    equityUsd: number;
    unrealizedPnl: number;
    drawdownPercent: number;
    marginLoadPercent: number;
    effectiveLeverage: number;
    updatedAt: string;
  }>;
  offers: Array<{
    offerId: string;
    titleRu: string;
    strategyId: number;
    mode: 'mono' | 'synth';
    market: string;
    published: boolean;
    expected: {
      ret: number;
      pf: number;
      dd: number;
      trades: number;
      tradesPerDay: number;
    };
    live: {
      samples: number;
      entryPriceDeviationPercent: number;
      entryLagSeconds: number;
      realizedVsPredictedPnlPercent: number;
      winRatePercent: number | null;
    } | null;
    comparison: {
      expectedWinRatePercent: number | null;
      liveWinRatePercent: number | null;
      winRateDeltaPercent: number | null;
    } | null;
  }>;
};

type AdminTsHealthReport = {
  success?: boolean;
  generatedAt: string;
  lookbackHours: number;
  systems: Array<{
    systemId: number;
    systemName: string;
    apiKeyName: string;
    isActive: boolean;
    connectedClients: number;
    membersTotal: number;
    membersEnabled: number;
    membersWithRecentEvents: number;
    latestAccountSnapshot?: {
      equityUsd?: number;
      unrealizedPnl?: number;
      notionalUsd?: number;
      marginLoadPercent?: number;
      recordedAt?: string;
    } | null;
  }>;
};

type AdminClosedPositionsReport = {
  success?: boolean;
  generatedAt: string;
  periodHours: number;
  rows: Array<{
    systemId: number;
    systemName: string;
    strategyId: number;
    strategyName: string;
    symbol: string;
    side: string;
    qty: number;
    entryPrice: number;
    exitPrice: number;
    entryTime: number;
    exitTime: number;
    entryFee: number;
    exitFee: number;
    realizedPnl: number;
    holdMinutes: number;
  }>;
  summary: {
    closedCount: number;
    wins: number;
    losses: number;
    winRatePercent: number;
    totalRealizedPnl: number;
  };
};

type AdminChartSnapshotReport = {
  success?: boolean;
  generatedAt: string;
  candlesCount: number;
  markersCount: number;
  svg: string;
  svgBase64: string;
};

type StrategyClientState = {
  tenant: Tenant;
  plan: Plan | null;
  capabilities?: TenantCapabilities;
  monitoring?: TenantSummary['monitoring'];
  profile: {
    selectedOfferIds: string[];
    activeSystemProfileId?: number | null;
    latestPreview?: Record<string, unknown>;
    risk_level: Level3;
    trade_frequency_level: Level3;
    requested_enabled: number;
    actual_enabled: number;
    assigned_api_key_name: string;
  } | null;
  systemProfiles?: Array<{
    id: number;
    profileName: string;
    selectedOfferIds: string[];
    isActive: boolean;
    createdAt?: string;
    updatedAt?: string;
  }>;
  constraints?: StrategySelectionConstraints;
  catalog: SaasSummary['catalog'];
  offers: CatalogOffer[];
  recommendedSets: Record<string, CatalogOffer[]>;
};

type StrategyPreviewResponse = {
  offerId?: string;
  offer?: CatalogOffer | null;
  preset?: CatalogPreset | null;
  period?: PeriodInfo | null;
  controls?: {
    riskScore?: number;
    tradeFrequencyScore?: number;
    riskLevel?: Level3;
    tradeFrequencyLevel?: Level3;
  };
  preview: {
    source?: string;
    summary?: Record<string, unknown>;
    equity?: EquityPoint[] | { points?: EquityPoint[]; summary?: Record<string, unknown> };
    trades?: Array<Record<string, unknown>>;
  };
};

type StrategySelectionPreviewResponse = {
  period?: PeriodInfo | null;
  controls?: {
    riskScore?: number;
    tradeFrequencyScore?: number;
    riskLevel?: Level3;
    tradeFrequencyLevel?: Level3;
  };
  constraints?: StrategySelectionConstraints;
  selectedOffers: Array<{
    offerId: string;
    titleRu: string;
    market: string;
    mode: 'mono' | 'synth';
    strategyId: number;
    strategyName: string;
    score: number;
    metrics: MetricSet;
  }>;
  preview: {
    source?: string;
    summary?: Record<string, unknown> | null;
    equity?: EquityPoint[] | { points?: EquityPoint[]; summary?: Record<string, unknown> };
    trades?: Array<Record<string, unknown>>;
  };
};

type MaterializedStrategy = {
  id?: number;
  name: string;
  strategyId?: number;
  offerId: string;
  mode: string;
  market: string;
  type: string;
  metrics: MetricSet;
};

type MaterializeResponse = {
  assignedApiKeyName: string;
  strategies: MaterializedStrategy[];
};

type OfferUnpublishImpact = {
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

type ClientMagicLinkResponse = {
  success: boolean;
  token: string;
  expiresAt: string;
  loginUrl: string;
  tenantId: number;
  userId: number;
};

type AlgofundRequest = {
  id: number;
  tenant_id: number;
  tenant_display_name?: string;
  tenant_slug?: string;
  request_type: 'start' | 'stop' | 'switch_system';
  status: RequestStatus;
  note: string;
  decision_note: string;
  request_payload_json?: string;
  created_at: string;
  decided_at?: string | null;
};

type AlgofundState = {
  tenant: Tenant;
  plan: Plan | null;
  capabilities?: TenantCapabilities;
  profile: {
    latestPreview?: Record<string, unknown>;
    risk_multiplier: number;
    requested_enabled: number;
    actual_enabled: number;
    assigned_api_key_name: string;
    execution_api_key_name?: string;
    published_system_name?: string;
  };
  engine?: {
    apiKeyName: string;
    systemId: number;
    systemName: string;
    isActive: boolean;
  } | null;
  availableSystems?: Array<{
    id: number;
    apiKeyName?: string;
    name: string;
    isActive: boolean;
    updatedAt?: string;
    memberCount?: number;
    memberStrategyIds?: number[];
    metrics?: {
      equityUsd?: number;
      unrealizedPnl?: number;
      drawdownPercent?: number;
      marginLoadPercent?: number;
      effectiveLeverage?: number;
    } | null;
  }>;
  preview: {
    riskMultiplier: number;
    period?: PeriodInfo | null;
    sourceSystem?: {
      apiKeyName: string;
      systemId: number;
      systemName: string;
    } | null;
    summary?: {
      initialBalance?: number;
      finalEquity?: number;
      totalReturnPercent?: number;
      maxDrawdownPercent?: number;
      winRatePercent?: number;
      profitFactor?: number;
      tradesCount?: number;
    } | null;
    equityCurve?: EquityPoint[];
    blockedByPlan?: boolean;
    blockedReason?: string;
  };
  portfolioPassport?: AlgofundPortfolioPassport | null;
  requests: AlgofundRequest[];
  catalog: SaasSummary['catalog'];
};

type AdminPublishResponse = {
  sourceSystem?: {
    apiKeyName: string;
    systemId: number;
    systemName: string;
  };
  preview?: {
    period?: PeriodInfo | null;
    summary?: {
      finalEquity?: number;
      totalReturnPercent?: number;
      maxDrawdownPercent?: number;
      winRatePercent?: number;
      profitFactor?: number;
      tradesCount?: number;
    };
    equityCurve?: EquityPoint[];
  };
  publishMeta?: {
    offerIds?: string[];
    setKey?: string;
    membersCount?: number;
    systemName?: string;
  };
};

type AdminPublishPayload = {
  offerIds?: string[];
  setKey?: string;
};

type BacktestCardSettings = {
  riskScore: number;
  tradeFrequencyScore: number;
  initialBalance: number;
  riskScaleMaxPercent: number;
  maxOpenPositions: number;
};

const ADMIN_PUBLISH_RESPONSE_STORAGE_KEY = 'saasAdminPublishResponse';
const ADMIN_BACKTEST_SETTINGS_STORAGE_KEY = 'saasAdminBacktestSettingsByCard';
const DEFAULT_BACKTEST_SETTINGS: BacktestCardSettings = {
  riskScore: 5,
  tradeFrequencyScore: 5,
  initialBalance: 10000,
  riskScaleMaxPercent: 40,
  maxOpenPositions: 0,
};

const normalizeBacktestCardSettings = (raw: unknown): BacktestCardSettings => {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const riskScore = Number(parsed.riskScore);
  const tradeFrequencyScore = Number(parsed.tradeFrequencyScore);
  const initialBalance = Number(parsed.initialBalance);
  const riskScaleMaxPercent = Number(parsed.riskScaleMaxPercent);
  const maxOpenPositions = Number(parsed.maxOpenPositions);
  return {
    riskScore: Number.isFinite(riskScore) ? Math.min(10, Math.max(0, riskScore)) : DEFAULT_BACKTEST_SETTINGS.riskScore,
    tradeFrequencyScore: Number.isFinite(tradeFrequencyScore) ? Math.min(10, Math.max(0, tradeFrequencyScore)) : DEFAULT_BACKTEST_SETTINGS.tradeFrequencyScore,
    initialBalance: Number.isFinite(initialBalance) ? Math.max(100, Math.floor(initialBalance)) : DEFAULT_BACKTEST_SETTINGS.initialBalance,
    riskScaleMaxPercent: Number.isFinite(riskScaleMaxPercent) ? Math.min(1000, Math.max(0, riskScaleMaxPercent)) : DEFAULT_BACKTEST_SETTINGS.riskScaleMaxPercent,
    maxOpenPositions: Number.isFinite(maxOpenPositions) ? Math.max(0, Math.floor(maxOpenPositions)) : DEFAULT_BACKTEST_SETTINGS.maxOpenPositions,
  };
};

const parseAdminBacktestSettingsByCard = (raw?: string | null): Record<string, BacktestCardSettings> => {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, BacktestCardSettings> = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      const safeKey = String(key || '').trim();
      if (!safeKey) {
        continue;
      }
      out[safeKey] = normalizeBacktestCardSettings(value);
    }
    return out;
  } catch {
    return {};
  }
};

const getBacktestContextKey = (context?: SaasBacktestContext | null): string => {
  if (!context) {
    return '';
  }
  if (context.kind === 'offer') {
    return `offer:${String(context.offerId || '').trim()}`;
  }
  const setKey = String(context.setKey || '').trim();
  if (setKey) {
    return `ts-set:${setKey}`;
  }
  const ids = (context.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean).sort();
  return `ts:${ids.join('|')}`;
};

const parseAdminPublishResponse = (raw?: string | null): AdminPublishResponse | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as AdminPublishResponse;
    const apiKeyName = String(parsed?.sourceSystem?.apiKeyName || '').trim();
    const systemName = String(parsed?.sourceSystem?.systemName || '').trim();
    const systemId = Number(parsed?.sourceSystem?.systemId || 0);
    if (!apiKeyName || !systemName || !Number.isFinite(systemId) || systemId <= 0) {
      return null;
    }

    return {
      sourceSystem: {
        apiKeyName,
        systemId,
        systemName,
      },
      preview: parsed?.preview || undefined,
    };
  } catch {
    return null;
  }
};

type Copy = {
  title: string;
  subtitle: string;
  refresh: string;
  seed: string;
  publish: string;
  admin: string;
  strategyClient: string;
  algofund: string;
  latestCatalog: string;
  latestSweep: string;
  noCatalog: string;
  noSweep: string;
  recommendedSets: string;
  adminTsDraft: string;
  tenants: string;
  openStrategyClient: string;
  openAlgofund: string;
  saveProfile: string;
  preview: string;
  materialize: string;
  requestStart: string;
  requestStop: string;
  approve: string;
  reject: string;
  risk: string;
  tradeFrequency: string;
  apiKey: string;
  selectedOffers: string;
  monitoring: string;
  requestQueue: string;
  requestTenant: string;
  previewTitle: string;
  selectedOffersPreview: string;
  publishedTsPreview: string;
  noTenant: string;
  sourceSystem: string;
  tenantMode: string;
  plan: string;
  status: string;
  score: string;
  returnLabel: string;
  drawdown: string;
  profitFactor: string;
  trades: string;
  winRate: string;
  finalEquity: string;
  depositCap: string;
  strategyLimit: string;
  riskCap: string;
  period: string;
  connectedTenants: string;
  tenantWorkspace: string;
  planCapabilities: string;
  capabilitySettings: string;
  capabilityApiKeyUpdate: string;
  capabilityMonitoring: string;
  capabilityBacktest: string;
  capabilityStartStop: string;
  openSettings: string;
  openMonitoring: string;
  openBacktest: string;
  backtestLockedHint: string;
  settingsLockedHint: string;
  priceUsdt: string;
  saveTenant: string;
  savePlan: string;
  unrealizedPnl: string;
  marginLoad: string;
  depositLoad: string;
  liquidationRisk: string;
  displayName: string;
  tenantStatus: string;
  planGrid: string;
  previewUsesNearestPreset: string;
  previewPlanCapHint: string;
  previewRefreshing: string;
  riskApplied: string;
  initialBalance: string;
  openTradingSystems: string;
  persistedBucket: string;
  pending: string;
  approved: string;
  rejected: string;
  start: string;
  stop: string;
  note: string;
  decisionNote: string;
  chooseTenant: string;
  chooseOffer: string;
  saveSuccess: string;
  previewReady: string;
  materializeSuccess: string;
  requestSent: string;
  requestResolved: string;
  publishReady: string;
  seedReady: string;
  emergencyStop: string;
  createMagicLink: string;
  magicLinkReady: string;
  magicLinkExpires: string;
  createClient: string;
  createClientTitle: string;
  createClientSuccess: string;
  recommendedSetsHint: string;
  adminTsDraftHint: string;
  selectedOffersHint: string;
  selectedOffersEmptyHint: string;
  adminCreateHint: string;
  engineStatus: string;
  engineSystemId: string;
  engineRunning: string;
  enginePending: string;
  engineBlocked: string;
  engineStopped: string;
  engineNotMaterialized: string;
};

const COPY_BY_LANGUAGE: Record<'ru' | 'en' | 'tr', Copy> = {
  ru: {
    title: 'SaaS Control Room',
    subtitle: 'Единый MVP-контур для admin, strategy-client и Алгофонда поверх готовых результатов sweep/catalog.',
    refresh: 'Обновить',
    seed: 'Инициализировать demo tenants',
    publish: 'Опубликовать admin TS',
    admin: 'Admin',
    strategyClient: 'Клиент стратегий',
    algofund: 'Алгофонд',
    latestCatalog: 'Последний client catalog',
    latestSweep: 'Последний historical sweep',
    noCatalog: 'Каталог стратегий временно недоступен. Проверьте сборку каталога в админ-контуре.',
    noSweep: 'Исторический sweep временно недоступен. Материализация станет доступна после обновления данных.',
    recommendedSets: 'Наборы офферов из sweep',
    adminTsDraft: 'Черновик портфеля admin',
    tenants: 'Тестовые tenants',
    openStrategyClient: 'Открыть клиента стратегий',
    openAlgofund: 'Открыть Алгофонд',
    saveProfile: 'Сохранить профиль',
    preview: 'Показать preview',
    materialize: 'Материализовать на API key',
    requestStart: 'Запросить старт',
    requestStop: 'Запросить стоп',
    approve: 'Одобрить',
    reject: 'Отклонить',
    risk: 'Риск',
    tradeFrequency: 'Частота сделок',
    apiKey: 'API key',
    selectedOffers: 'Офферы для подключения',
    monitoring: 'Monitoring',
    requestQueue: 'Очередь запросов',
    requestTenant: 'Tenant',
    previewTitle: 'Preview ожиданий',
    selectedOffersPreview: 'SWEEP compare выбранных офферов (4D)',
    publishedTsPreview: 'Опубликованная ТС: результат бэктеста',
    noTenant: 'Тенант этого типа пока не найден.',
    sourceSystem: 'Source system',
    tenantMode: 'Тип клиента',
    plan: 'Тариф',
    status: 'Статус',
    score: 'Score',
    returnLabel: 'Доходность',
    drawdown: 'Макс DD',
    profitFactor: 'PF',
    trades: 'Сделки',
    winRate: 'Win Rate',
    finalEquity: 'Final equity',
    depositCap: 'Лимит депозита',
    strategyLimit: 'Лимит стратегий',
    riskCap: 'Потолок риска',
    period: 'Период',
    connectedTenants: 'Подключенные клиенты',
    tenantWorkspace: 'Кабинет клиента',
    planCapabilities: 'Возможности тарифа',
    capabilitySettings: 'Настройки',
    capabilityApiKeyUpdate: 'Смена API key',
    capabilityMonitoring: 'Мониторинг',
    capabilityBacktest: 'Бэктест',
    capabilityStartStop: 'Старт/стоп заявки',
    openSettings: 'Открыть Settings',
    openMonitoring: 'Открыть Monitoring',
    openBacktest: 'Открыть Backtest',
    backtestLockedHint: 'Backtest недоступен на текущем тарифе. Preview остаётся доступным.',
    settingsLockedHint: 'Изменение настроек недоступно на текущем тарифе.',
    priceUsdt: 'Цена, USDT/мес',
    saveTenant: 'Сохранить tenant',
    savePlan: 'Сохранить тариф',
    unrealizedPnl: 'Нереализ. PnL',
    marginLoad: 'Загрузка маржи',
    depositLoad: 'Загрузка депозита',
    liquidationRisk: 'Риск ликвидации',
    displayName: 'Имя клиента',
    tenantStatus: 'Статус tenant',
    planGrid: 'Тарифная сетка',
    previewUsesNearestPreset: 'Preview использует ближайший пресет и при сохранении всё равно маппится в low / medium / high.',
    previewPlanCapHint: 'В админ-режиме preview можно смотреть выше лимита тарифа, но сохранение всё равно ограничивается тарифным cap.',
    previewRefreshing: 'Пересчитываем preview...',
    riskApplied: 'Риск (множитель)',
    initialBalance: 'Начальный баланс',
    openTradingSystems: 'Открыть Trading Systems',
    persistedBucket: 'Сохраняемый bucket',
    pending: 'Ожидает',
    approved: 'Одобрено',
    rejected: 'Отклонено',
    start: 'Старт',
    stop: 'Стоп',
    note: 'Комментарий',
    decisionNote: 'Комментарий решения',
    chooseTenant: 'Выберите клиента (tenant)',
    chooseOffer: 'Выберите оффер для одиночного preview',
    saveSuccess: 'Профиль обновлен',
    previewReady: 'Preview обновлен',
    materializeSuccess: 'Стратегии материализованы',
    requestSent: 'Запрос отправлен',
    requestResolved: 'Запрос обработан',
    publishReady: 'Admin TS опубликован',
    seedReady: 'Demo tenants обновлены',
    emergencyStop: 'Стоп + закрыть позиции',
    createMagicLink: 'Сгенерировать ссылку входа',
    magicLinkReady: 'Ссылка готова (одноразовая)',
    magicLinkExpires: 'Действительна до',
    createClient: 'Создать нового пользователя',
    createClientTitle: 'Создание пользователя через Admin',
    createClientSuccess: 'Клиент создан',
    recommendedSetsHint: 'Это готовые подборки офферов из последнего SWEEP. Можно быстро выбрать набор и затем подключить его клиенту.',
    adminTsDraftHint: 'Служебный черновик портфеля для admin. Нужен для публикации admin trading system и контроля состава.',
    selectedOffersHint: 'Выбирайте офферы как товары. Если выбрано несколько, ниже строится SWEEP compare (4D), а не полный API backtest.',
    selectedOffersEmptyHint: 'Офферы не найдены в preset-базе. Показываю fallback из последнего SWEEP/client catalog, если он доступен.',
    adminCreateHint: 'Admin создаёт клиентов двух типов: Клиент стратегий и Алгофонд. После создания можно сразу открыть и настроить кабинет.',
    engineStatus: 'Статус движка',
    engineSystemId: 'System ID',
    engineRunning: 'Торговый движок запущен',
    enginePending: 'Запрос одобрен, запуск ожидается',
    engineBlocked: 'Не удалось материализовать клиента в engine',
    engineStopped: 'Торговый движок остановлен',
    engineNotMaterialized: 'Клиент ещё не заведён в торговый движок. Нужна materialization торговой системы.',
  },
  en: {
    title: 'SaaS Control Room',
    subtitle: 'One MVP surface for admin, strategy-client, and algofund modes on top of the latest sweep/catalog artifacts.',
    refresh: 'Refresh',
    seed: 'Seed demo tenants',
    publish: 'Publish admin TS',
    admin: 'Admin',
    strategyClient: 'Strategy Client',
    algofund: 'Algofund',
    latestCatalog: 'Latest client catalog',
    latestSweep: 'Latest historical sweep',
    noCatalog: 'Strategy catalog is temporarily unavailable. Check catalog build in admin mode.',
    noSweep: 'Historical sweep is temporarily unavailable. Materialization will be enabled after data refresh.',
    recommendedSets: 'Sweep-based offer bundles',
    adminTsDraft: 'Admin portfolio draft',
    tenants: 'Demo tenants',
    openStrategyClient: 'Open strategy client',
    openAlgofund: 'Open algofund',
    saveProfile: 'Save profile',
    preview: 'Preview',
    materialize: 'Materialize to API key',
    requestStart: 'Request start',
    requestStop: 'Request stop',
    approve: 'Approve',
    reject: 'Reject',
    risk: 'Risk',
    tradeFrequency: 'Trade frequency',
    apiKey: 'API key',
    selectedOffers: 'Offers to connect',
    monitoring: 'Monitoring',
    requestQueue: 'Request queue',
    requestTenant: 'Tenant',
    previewTitle: 'Expectation preview',
    selectedOffersPreview: 'Selected offers SWEEP compare (4D)',
    publishedTsPreview: 'Published TS: backtest result',
    noTenant: 'No tenant of this type is available yet.',
    sourceSystem: 'Source system',
    tenantMode: 'Client type',
    plan: 'Plan',
    status: 'Status',
    score: 'Score',
    returnLabel: 'Return',
    drawdown: 'Max DD',
    profitFactor: 'PF',
    trades: 'Trades',
    winRate: 'Win rate',
    finalEquity: 'Final equity',
    depositCap: 'Deposit cap',
    strategyLimit: 'Strategy limit',
    riskCap: 'Risk cap',
    period: 'Period',
    connectedTenants: 'Connected tenants',
    tenantWorkspace: 'Client workspace',
    planCapabilities: 'Plan capabilities',
    capabilitySettings: 'Settings',
    capabilityApiKeyUpdate: 'API key update',
    capabilityMonitoring: 'Monitoring',
    capabilityBacktest: 'Backtest',
    capabilityStartStop: 'Start/Stop requests',
    openSettings: 'Open Settings',
    openMonitoring: 'Open Monitoring',
    openBacktest: 'Open Backtest',
    backtestLockedHint: 'Backtest is not available on the current plan. Preview remains available.',
    settingsLockedHint: 'Settings update is not available for the current plan',
    priceUsdt: 'Price, USDT/mo',
    saveTenant: 'Save tenant',
    savePlan: 'Save plan',
    unrealizedPnl: 'Unrealized PnL',
    marginLoad: 'Margin load',
    depositLoad: 'Deposit load',
    liquidationRisk: 'Liquidation risk',
    displayName: 'Client name',
    tenantStatus: 'Tenant status',
    planGrid: 'Plan grid',
    previewUsesNearestPreset: 'Preview uses the nearest preset and save still maps to low / medium / high.',
    previewPlanCapHint: 'In admin mode you can preview above the plan cap, but saving still respects the subscribed cap.',
    previewRefreshing: 'Refreshing preview...',
    riskApplied: 'Risk (multiplier)',
    initialBalance: 'Initial balance',
    openTradingSystems: 'Open Trading Systems',
    persistedBucket: 'Saved bucket',
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    start: 'Start',
    stop: 'Stop',
    note: 'Note',
    decisionNote: 'Decision note',
    chooseTenant: 'Select client tenant',
    chooseOffer: 'Select offer for single preview',
    saveSuccess: 'Profile updated',
    previewReady: 'Preview updated',
    materializeSuccess: 'Strategies materialized',
    requestSent: 'Request sent',
    requestResolved: 'Request resolved',
    publishReady: 'Admin TS published',
    seedReady: 'Demo tenants refreshed',
    emergencyStop: 'Stop + close positions',
    createMagicLink: 'Create login link',
    magicLinkReady: 'Link ready (one-time use)',
    magicLinkExpires: 'Expires at',
    createClient: 'Create new user',
    createClientTitle: 'Admin user creation',
    createClientSuccess: 'Client created',
    recommendedSetsHint: 'These are ready offer bundles generated from the latest SWEEP. Pick a bundle and connect it to a client.',
    adminTsDraftHint: 'Internal admin portfolio draft used for publishing admin trading system and composition control.',
    selectedOffersHint: 'Pick offers like products. When several are selected, the panel runs SWEEP compare (4D), not full API backtest.',
    selectedOffersEmptyHint: 'No offers found in preset storage. Fallback from latest SWEEP/client catalog is used when available.',
    adminCreateHint: 'Admin creates two client types: Strategy Client and Algofund. After creation you can open and configure immediately.',
    engineStatus: 'Engine status',
    engineSystemId: 'System ID',
    engineRunning: 'Trading engine is running',
    enginePending: 'Request approved, engine launch pending',
    engineBlocked: 'Client could not be materialized into engine',
    engineStopped: 'Trading engine is stopped',
    engineNotMaterialized: 'This client is not materialized into the trading engine yet. Trading-system materialization is required.',
  },
  tr: {
    title: 'SaaS Control Room',
    subtitle: 'Admin, strategy-client ve algofund modlari icin sweep/catalog tabanli MVP paneli.',
    refresh: 'Yenile',
    seed: 'Demo tenant olustur',
    publish: 'Admin TS yayinla',
    admin: 'Admin',
    strategyClient: 'Strateji Musterisi',
    algofund: 'Algofund',
    latestCatalog: 'Son client catalog',
    latestSweep: 'Son historical sweep',
    noCatalog: 'Strateji katalogu gecici olarak kullanilamiyor. Admin modunda katalog build kontrol edin.',
    noSweep: 'Historical sweep gecici olarak kullanilamiyor. Veri yenilenince materialize acilacak.',
    recommendedSets: 'SWEEP teklif paketleri',
    adminTsDraft: 'Admin portfoy taslagi',
    tenants: 'Demo tenantlar',
    openStrategyClient: 'Strategy client ac',
    openAlgofund: 'Algofund ac',
    saveProfile: 'Profili kaydet',
    preview: 'Onizleme',
    materialize: 'API key uzerine yaz',
    requestStart: 'Baslatma talebi',
    requestStop: 'Durdurma talebi',
    approve: 'Onayla',
    reject: 'Reddet',
    risk: 'Risk',
    tradeFrequency: 'Islem sikligi',
    apiKey: 'API key',
    selectedOffers: 'Baglanacak teklifler',
    monitoring: 'Monitoring',
    requestQueue: 'Talep kuyrugu',
    requestTenant: 'Tenant',
    previewTitle: 'Beklenti onizlemesi',
    selectedOffersPreview: 'Secilen teklifler SWEEP compare (4D)',
    publishedTsPreview: 'Yayinlanan TS: backtest sonucu',
    noTenant: 'Bu tipte tenant yok.',
    sourceSystem: 'Source system',
    tenantMode: 'Musteri tipi',
    plan: 'Plan',
    status: 'Durum',
    score: 'Score',
    returnLabel: 'Getiri',
    drawdown: 'Maks DD',
    profitFactor: 'PF',
    trades: 'Islem',
    winRate: 'Win rate',
    finalEquity: 'Final equity',
    depositCap: 'Depozit limiti',
    strategyLimit: 'Strateji limiti',
    riskCap: 'Risk limiti',
    period: 'Periyot',
    connectedTenants: 'Bagli tenantlar',
    tenantWorkspace: 'Musteri paneli',
    planCapabilities: 'Plan ozellikleri',
    capabilitySettings: 'Ayarlar',
    capabilityApiKeyUpdate: 'API key guncelleme',
    capabilityMonitoring: 'Monitoring',
    capabilityBacktest: 'Backtest',
    capabilityStartStop: 'Baslat/Durdur talepleri',
    openSettings: 'Settings ac',
    openMonitoring: 'Monitoring ac',
    openBacktest: 'Backtest ac',
    backtestLockedHint: 'Bu planda backtest kapali. Onizleme kullanilmaya devam eder.',
    settingsLockedHint: 'Bu planda ayar guncelleme kapali',
    priceUsdt: 'Fiyat, USDT/ay',
    saveTenant: 'Tenant kaydet',
    savePlan: 'Plani kaydet',
    unrealizedPnl: 'Gerceklesmemis PnL',
    marginLoad: 'Marjin yuklenmesi',
    depositLoad: 'Depozit yuklenmesi',
    liquidationRisk: 'Likidasyon riski',
    displayName: 'Musteri adi',
    tenantStatus: 'Tenant durumu',
    planGrid: 'Plan tablosu',
    previewUsesNearestPreset: 'Onizleme en yakin preseti kullanir ve kayit sirasinda yine low / medium / high olarak saklanir.',
    previewPlanCapHint: 'Admin modunda plan limitinin ustunu onizleyebilirsiniz, ancak kayit yine mevcut plan limitine gore yapilir.',
    previewRefreshing: 'Onizleme guncelleniyor...',
    riskApplied: 'Risk (carpan)',
    initialBalance: 'Baslangic bakiyesi',
    openTradingSystems: 'Trading Systems ac',
    persistedBucket: 'Kaydedilecek bucket',
    pending: 'Bekliyor',
    approved: 'Onaylandi',
    rejected: 'Reddedildi',
    start: 'Baslat',
    stop: 'Durdur',
    note: 'Not',
    decisionNote: 'Karar notu',
    chooseTenant: 'Musteri tenant secin',
    chooseOffer: 'Tekli onizleme icin teklif secin',
    saveSuccess: 'Profil guncellendi',
    previewReady: 'Onizleme guncellendi',
    materializeSuccess: 'Stratejiler olusturuldu',
    requestSent: 'Talep gonderildi',
    requestResolved: 'Talep cozuldu',
    publishReady: 'Admin TS yayinlandi',
    seedReady: 'Demo tenantlar guncellendi',
    emergencyStop: 'Durdur + pozisyonlari kapat',
    createMagicLink: 'Giris linki olustur',
    magicLinkReady: 'Link hazir (tek kullanim)',
    magicLinkExpires: 'Son kullanim',
    createClient: 'Yeni kullanici olustur',
    createClientTitle: 'Admin kullanici olusturma',
    createClientSuccess: 'Musteri olusturuldu',
    recommendedSetsHint: 'Bunlar son SWEEP sonucundan gelen hazir teklif paketleridir. Paketi secip musteriye baglayabilirsiniz.',
    adminTsDraftHint: 'Admin trading system yayinlamasi ve kompozisyon kontrolu icin dahili portfoy taslagi.',
    selectedOffersHint: 'Teklifleri urun gibi secin. Birden fazla secimde panel tam API backtest degil SWEEP compare (4D) calistirir.',
    selectedOffersEmptyHint: 'Preset depoda teklif yok. Mumkunse son SWEEP/client catalog fallback gosterilir.',
    adminCreateHint: 'Admin iki musteri tipi olusturur: Strateji Musterisi ve Algofund. Olusturduktan sonra hemen acip ayarlayabilirsiniz.',
    engineStatus: 'Engine durumu',
    engineSystemId: 'System ID',
    engineRunning: 'Trading engine calisiyor',
    enginePending: 'Talep onaylandi, engine baslatma bekleniyor',
    engineBlocked: 'Musteri engine icine materialize edilemedi',
    engineStopped: 'Trading engine durdu',
    engineNotMaterialized: 'Bu musteri henuz trading engine icine alinmadi. Trading system materialization gerekli.',
  },
};

const formatNumber = (value: unknown, digits = 2): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0';
  }
  return numeric.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
};

const formatPercent = (value: unknown, digits = 2): string => `${formatNumber(value, digits)}%`;
const formatMoney = (value: unknown): string => `$${formatNumber(value, 2)}`;

const calcDepositLoadPercent = (row: TenantSummary): number | null => {
  const equity = Number(row.monitoring?.equity_usd ?? NaN);
  const cap = Number(row.plan?.max_deposit_total ?? NaN);
  if (!Number.isFinite(equity) || !Number.isFinite(cap) || cap <= 0) {
    return null;
  }
  return (equity / cap) * 100;
};

const calcLiquidationRisk = (row: TenantSummary): { level: 'low' | 'medium' | 'high'; color: string; bufferPercent: number | null } => {
  const marginLoad = Number(row.monitoring?.margin_load_percent ?? 0);
  const drawdown = Number(row.monitoring?.drawdown_percent ?? 0);
  const bufferPercent = Number.isFinite(marginLoad) ? Math.max(0, 100 - marginLoad) : null;

  // PRIMARY: margin_load is the main factor for liquidation risk
  // HIGH: If margin_load >= 80% OR (margin_load >= 65% AND drawdown >= 35%)
  if (marginLoad >= 80 || (marginLoad >= 65 && drawdown >= 35)) {
    return { level: 'high', color: 'red', bufferPercent };
  }
  
  // MEDIUM: If margin_load >= 60% OR (margin_load >= 45% AND drawdown >= 25%)
  if (marginLoad >= 60 || (marginLoad >= 45 && drawdown >= 25)) {
    return { level: 'medium', color: 'gold', bufferPercent };
  }
  
  // LOW: All other cases
  return { level: 'low', color: 'green', bufferPercent };
};

const toFiniteNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeSeriesTime = (value: unknown): number | null => {
  const numeric = toFiniteNumberOrNull(value);
  if (numeric !== null) {
    const normalizedNumeric = numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    return normalizedNumeric > 0 ? normalizedNumeric : null;
  }

  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const parsedMs = Date.parse(text);
  if (Number.isFinite(parsedMs)) {
    const normalizedDate = Math.floor(parsedMs / 1000);
    return normalizedDate > 0 ? normalizedDate : null;
  }

  return null;
};

const dedupeLinePoints = (points: LinePoint[]): LinePoint[] => {
  if (points.length <= 1) {
    return points;
  }

  const out: LinePoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.time === point.time) {
      out[out.length - 1] = point;
      continue;
    }
    out.push(point);
  }

  return out;
};

const dedupeOffersById = (offers: CatalogOffer[]): CatalogOffer[] => {
  const out: CatalogOffer[] = [];
  const seen = new Set<string>();
  for (const offer of offers) {
    const offerId = String(offer?.offerId || '').trim();
    if (!offerId || seen.has(offerId)) {
      continue;
    }
    seen.add(offerId);
    out.push(offer);
  }
  return out;
};

type NormalizedEquityPoint = {
  time: number;
  equity: number;
};

const extractEquityPoints = (payload: unknown): EquityPoint[] => {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    const normalized = payload
      .map((item) => {
        if (Array.isArray(item) && item.length >= 2) {
          const time = normalizeSeriesTime(item[0]);
          const equity = toFiniteNumberOrNull(item[1]);

          if (time === null || equity === null) {
            return null;
          }

          return { time, equity };
        }

        if (!item || typeof item !== 'object') {
          return null;
        }

        const row = item as Record<string, unknown>;
        const time = normalizeSeriesTime(row.time);
        const equity = toFiniteNumberOrNull(row.equity ?? row.value ?? row.close);

        if (time === null || equity === null) {
          return null;
        }

        return { time, equity };
      })
      .filter((item): item is NormalizedEquityPoint => !!item)
      .sort((left, right) => left.time - right.time);

    return normalized;
  }

  const objectPayload = payload as { points?: EquityPoint[]; equityCurve?: EquityPoint[] };
  return extractEquityPoints(objectPayload.points || objectPayload.equityCurve || []);
};

const downsampleLinePoints = (points: LinePoint[], maxPoints = 600): LinePoint[] => {
  if (!Array.isArray(points) || points.length <= maxPoints) {
    return points;
  }

  const out: LinePoint[] = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round(index * step);
    out.push(points[Math.min(points.length - 1, sourceIndex)]);
  }
  return out;
};

const downsampleNumericSeries = (values: number[], maxPoints = 160): number[] => {
  if (!Array.isArray(values) || values.length <= maxPoints) {
    return values;
  }

  const out: number[] = [];
  const step = (values.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round(index * step);
    const value = Number(values[Math.min(values.length - 1, sourceIndex)]);
    if (Number.isFinite(value)) {
      out.push(value);
    }
  }

  return out;
};

const toLineSeriesData = (payload: unknown): LinePoint[] => {
  const points = extractEquityPoints(payload)
    .map((point) => {
      const value = toFiniteNumberOrNull(point.equity ?? point.value);
      if (value === null || !Number.isFinite(point.time)) {
        return null;
      }

      return {
        time: point.time,
        value,
      };
    })
    .filter((point): point is LinePoint => !!point)
    .sort((left, right) => left.time - right.time);

  return downsampleLinePoints(dedupeLinePoints(points));
};

const normalizeEpochSeconds = (value: unknown): number | null => {
  const asNumberValue = Number(value);
  if (Number.isFinite(asNumberValue) && asNumberValue > 0) {
    return asNumberValue > 9999999999 ? Math.floor(asNumberValue / 1000) : Math.floor(asNumberValue);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed / 1000);
    }
  }
  return null;
};

const extractTradeEventTime = (trade: Record<string, unknown>): number | null => {
  const candidates = [
    trade.actual_time,
    trade.actualTime,
    trade.entry_time,
    trade.entryTime,
    trade.exit_time,
    trade.exitTime,
    trade.time,
    trade.timestamp,
    trade.created_at,
    trade.createdAt,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeEpochSeconds(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
};

const normalizeOverlayToEquityScale = (overlayPoints: LinePoint[], equityPoints: LinePoint[]): LinePoint[] => {
  if (!Array.isArray(overlayPoints) || overlayPoints.length === 0 || !Array.isArray(equityPoints) || equityPoints.length === 0) {
    return [];
  }
  const overlayValues = overlayPoints.map((item) => Number(item.value)).filter((item) => Number.isFinite(item));
  const equityValues = equityPoints.map((item) => Number(item.value)).filter((item) => Number.isFinite(item));
  if (overlayValues.length === 0 || equityValues.length === 0) {
    return [];
  }

  const overlayMin = Math.min(...overlayValues);
  const overlayMax = Math.max(...overlayValues);
  const equityMin = Math.min(...equityValues);
  const equityMax = Math.max(...equityValues);
  const equityRange = Math.max(1e-6, equityMax - equityMin);
  const targetMin = equityMin + equityRange * 0.08;
  const targetMax = equityMax - equityRange * 0.08;
  const targetRange = Math.max(1e-6, targetMax - targetMin);
  const overlayRange = Math.max(1e-6, overlayMax - overlayMin);

  return overlayPoints.map((point) => ({
    time: point.time,
    value: Number((targetMin + ((point.value - overlayMin) / overlayRange) * targetRange).toFixed(4)),
  }));
};

const buildDailyTradeFrequencySeries = (
  tradesRaw: unknown,
  equityPoints: LinePoint[],
  fallbackTradesCount?: number,
): LinePoint[] => {
  if (!Array.isArray(equityPoints) || equityPoints.length === 0) {
    return [];
  }

  const dayCounts = new Map<number, number>();
  if (Array.isArray(tradesRaw)) {
    for (const item of tradesRaw) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const time = extractTradeEventTime(item as Record<string, unknown>);
      if (time === null) {
        continue;
      }
      const day = Math.floor(time / 86400) * 86400;
      dayCounts.set(day, Number(dayCounts.get(day) || 0) + 1);
    }
  }

  const startTime = Math.min(...equityPoints.map((point) => point.time));
  const endTime = Math.max(...equityPoints.map((point) => point.time));
  const startDay = Math.floor(startTime / 86400) * 86400;
  const endDay = Math.floor(endTime / 86400) * 86400;

  if (dayCounts.size === 0 && Number(fallbackTradesCount || 0) > 0) {
    const totalTrades = Number(fallbackTradesCount || 0);
    const dayKeys: number[] = [];
    for (let day = startDay; day <= endDay; day += 86400) {
      dayKeys.push(day);
    }
    const days = Math.max(1, dayKeys.length);
    const perDay = totalTrades / days;

    // Interpolate equity value at any timestamp from the sorted equity series.
    const interpolateEquity = (ts: number): number => {
      if (equityPoints.length === 1) {
        return equityPoints[0].value;
      }
      // Clamp to bounds
      if (ts <= equityPoints[0].time) {
        return equityPoints[0].value;
      }
      if (ts >= equityPoints[equityPoints.length - 1].time) {
        return equityPoints[equityPoints.length - 1].value;
      }
      // Binary search for surrounding segment
      let lo = 0;
      let hi = equityPoints.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (equityPoints[mid].time <= ts) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const span = equityPoints[hi].time - equityPoints[lo].time;
      if (span <= 0) {
        return equityPoints[lo].value;
      }
      const t = (ts - equityPoints[lo].time) / span;
      return equityPoints[lo].value + t * (equityPoints[hi].value - equityPoints[lo].value);
    };

    // Build absolute daily equity deltas as activity signal.
    // Using absolute Δequity (not %) so range-normalization is meaningful.
    const rawWeights = dayKeys.map((day, index) => {
      const tCurr = day + 43200;
      const tPrev = index > 0 ? (dayKeys[index - 1] + 43200) : (startTime);
      return Math.abs(interpolateEquity(tCurr) - interpolateEquity(tPrev));
    });

    // Range-normalize to [0.3, 1.7] × perDay — guarantees always-visible variation.
    const minW = Math.min(...rawWeights);
    const maxW = Math.max(...rawWeights);
    const span = maxW - minW;
    const normalizedWeights = rawWeights.map((w) =>
      span < 1e-9
        ? 1.0                                          // truly flat equity → uniform
        : 0.3 + ((w - minW) / span) * 1.4             // map to [0.3, 1.7]
    );

    // Re-scale so sum(weights × perDay) ≈ totalTrades
    const sumN = normalizedWeights.reduce((acc, w) => acc + w, 0);
    const scale = sumN > 0 ? (days / sumN) : 1;

    // 3-day rolling average for visual smoothness
    const smoothed = normalizedWeights.map((w, i) => {
      const prev = i > 0 ? normalizedWeights[i - 1] : w;
      const next = i < normalizedWeights.length - 1 ? normalizedWeights[i + 1] : w;
      return (prev + w + next) / 3;
    });
    const sumS = smoothed.reduce((acc, w) => acc + w, 0);
    const scaleS = sumS > 0 ? (days / sumS) : scale;

    const fallbackPoints: LinePoint[] = dayKeys.map((day, index) => ({
      time: day + 43200,
      value: Number((perDay * smoothed[index] * scaleS).toFixed(4)),
    }));
    return downsampleLinePoints(fallbackPoints);
  }

  const points: LinePoint[] = [];
  for (let day = startDay; day <= endDay; day += 86400) {
    points.push({
      time: day + 43200,
      value: Number((dayCounts.get(day) || 0).toFixed(4)),
    });
  }
  return downsampleLinePoints(points);
};

const summarizeLineSeries = (points: LinePoint[]) => {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const initialEquity = points[0].value;
  const finalEquity = points[points.length - 1].value;

  let peak = initialEquity;
  let maxDrawdownPercent = 0;
  for (const point of points) {
    if (point.value > peak) {
      peak = point.value;
    }

    if (peak > 0) {
      const drawdown = ((peak - point.value) / peak) * 100;
      if (Number.isFinite(drawdown) && drawdown > maxDrawdownPercent) {
        maxDrawdownPercent = drawdown;
      }
    }
  }

  const totalReturnPercent = initialEquity !== 0
    ? ((finalEquity - initialEquity) / Math.abs(initialEquity)) * 100
    : 0;

  return {
    initialEquity,
    finalEquity,
    totalReturnPercent,
    maxDrawdownPercent,
  };
};

const deriveBacktestCurvesFromEquity = (
  equityPoints: LinePoint[],
  initialBalance: number,
  riskScore: number,
) => {
  if (!Array.isArray(equityPoints) || equityPoints.length === 0) {
    return {
      pnl: [] as LinePoint[],
      drawdown: [] as LinePoint[],
      finalPnl: 0,
    };
  }

  const safeInitial = Number.isFinite(initialBalance) && initialBalance > 0 ? initialBalance : equityPoints[0].value;
  let peak = equityPoints[0].value;

  const pnl = equityPoints.map((point) => ({
    time: point.time,
    value: Number((point.value - safeInitial).toFixed(4)),
  }));

  const drawdown = equityPoints.map((point) => {
    if (point.value > peak) {
      peak = point.value;
    }
    const dd = peak > 0 ? ((peak - point.value) / peak) * 100 : 0;
    return { time: point.time, value: Number(dd.toFixed(4)) };
  });

  return {
    pnl,
    drawdown,
    finalPnl: pnl.length > 0 ? Number(pnl[pnl.length - 1].value.toFixed(4)) : 0,
  };
};

const metricColor = (value: number, kind: 'return' | 'drawdown' | 'pf') => {
  if (kind === 'drawdown') {
    return value <= 2 ? 'success' : value <= 4 ? 'warning' : 'error';
  }
  if (kind === 'pf') {
    return value >= 2 ? 'success' : value >= 1.3 ? 'processing' : 'warning';
  }
  return value >= 0 ? 'success' : 'error';
};

const calcSeriesChangePercent = (points: LinePoint[]): number | null => {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  const first = Number(points[0]?.value);
  const last = Number(points[points.length - 1]?.value);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return null;
  }
  return Number((((last - first) / first) * 100).toFixed(2));
};

const resolveTradeActivity = (tradesCountRaw: unknown, periodDaysRaw: unknown): { color: string; label: string } | null => {
  const tradesCount = Number(tradesCountRaw);
  const periodDays = Number(periodDaysRaw);
  if (!Number.isFinite(tradesCount) || tradesCount < 0) {
    return null;
  }

  const perDay = Number.isFinite(periodDays) && periodDays > 0
    ? tradesCount / periodDays
    : null;

  if (perDay === null) {
    return { color: 'blue', label: `сделок ${formatNumber(tradesCount, 0)}` };
  }

  if (perDay >= 8) {
    return { color: 'volcano', label: `активность высокая (${formatNumber(perDay, 1)}/день)` };
  }
  if (perDay >= 3) {
    return { color: 'gold', label: `активность средняя (${formatNumber(perDay, 1)}/день)` };
  }
  return { color: 'green', label: `активность низкая (${formatNumber(perDay, 1)}/день)` };
};

const buildDraftStrategyConstraints = (
  offerIds: string[],
  offers: CatalogOffer[],
  baseline?: StrategySelectionConstraints | null,
): StrategySelectionConstraints => {
  const selectedSet = new Set((offerIds || []).map((item) => String(item || '').trim()).filter(Boolean));
  const selectedOffers = (offers || []).filter((offer) => selectedSet.has(offer.offerId));
  const mono = selectedOffers.filter((offer) => String(offer.strategy?.mode || 'mono') === 'mono').length;
  const synth = selectedOffers.filter((offer) => String(offer.strategy?.mode || 'mono') !== 'mono').length;
  const uniqueMarkets = new Set(selectedOffers.map((offer) => String(offer.strategy?.market || '').trim()).filter(Boolean)).size;
  const maxStrategies = baseline?.limits?.maxStrategies ?? null;
  const minOffersPerSystem = baseline?.limits?.minOffersPerSystem ?? null;
  const maxOffersPerSystem = baseline?.limits?.maxOffersPerSystem ?? null;
  const maxCustomSystems = baseline?.limits?.maxCustomSystems ?? null;
  const monoLimit = baseline?.limits?.mono ?? null;
  const synthLimit = baseline?.limits?.synth ?? null;
  const depositCap = baseline?.limits?.depositCap ?? null;
  const estimatedDepositPerStrategy = depositCap && selectedOffers.length > 0
    ? Number((depositCap / selectedOffers.length).toFixed(2))
    : null;

  const violations: string[] = [];
  const warnings: string[] = [];

  if (minOffersPerSystem !== null && selectedOffers.length > 0 && selectedOffers.length < minOffersPerSystem) {
    violations.push(`At least ${minOffersPerSystem} offers are required to build a custom TS.`);
  }
  if (maxStrategies !== null && selectedOffers.length > maxStrategies) {
    violations.push(`Too many offers selected (${selectedOffers.length}/${maxStrategies}).`);
  }
  if (maxOffersPerSystem !== null && selectedOffers.length > maxOffersPerSystem) {
    violations.push(`Custom TS offer cap exceeded (${selectedOffers.length}/${maxOffersPerSystem}).`);
  }
  if (monoLimit !== null && mono > monoLimit) {
    violations.push(`Mono offers exceed plan limit (${mono}/${monoLimit}).`);
  }
  if (synthLimit !== null && synth > synthLimit) {
    violations.push(`Synthetic offers exceed plan limit (${synth}/${synthLimit}).`);
  }
  if (selectedOffers.length > 1 && uniqueMarkets < selectedOffers.length) {
    warnings.push('Repeated markets reduce diversification.');
  }
  if (selectedOffers.length > 1 && (mono === 0 || synth === 0)) {
    warnings.push('Only one mode is selected; portfolio balance is weaker.');
  }
  if (estimatedDepositPerStrategy !== null && estimatedDepositPerStrategy < 250) {
    warnings.push(`Estimated deposit per strategy is thin (${estimatedDepositPerStrategy} USDT).`);
  }

  return {
    limits: {
      maxStrategies,
      minOffersPerSystem,
      maxOffersPerSystem,
      maxCustomSystems,
      mono: monoLimit,
      synth: synthLimit,
      depositCap,
      riskCap: baseline?.limits?.riskCap ?? null,
    },
    usage: {
      selected: selectedOffers.length,
      mono,
      synth,
      uniqueMarkets,
      remainingSlots: maxStrategies !== null ? Math.max(0, maxStrategies - selectedOffers.length) : null,
      currentCustomSystems: selectedOffers.length > 0 ? 1 : 0,
      remainingCustomSystems: maxCustomSystems !== null
        ? Math.max(0, maxCustomSystems - (selectedOffers.length > 0 ? 1 : 0))
        : null,
      estimatedDepositPerStrategy,
    },
    violations,
    warnings,
  };
};

const parseAlgofundRequestPayload = (raw?: string) => {
  if (!raw) {
    return { targetSystemId: undefined as number | undefined, targetSystemName: undefined as string | undefined };
  }

  try {
    const parsed = JSON.parse(raw) as { targetSystemId?: unknown; targetSystemName?: unknown };
    const targetSystemId = Number(parsed?.targetSystemId || 0);
    const targetSystemName = String(parsed?.targetSystemName || '').trim();
    return {
      targetSystemId: Number.isFinite(targetSystemId) && targetSystemId > 0 ? targetSystemId : undefined,
      targetSystemName: targetSystemName || undefined,
    };
  } catch {
    return { targetSystemId: undefined as number | undefined, targetSystemName: undefined as string | undefined };
  }
};

const buildApiKeyLogComments = (rawLines: unknown, apiKeys: string[]): Record<string, string[]> => {
  const lines = Array.isArray(rawLines) ? rawLines.map((item) => String(item || '')) : [];
  const out: Record<string, string[]> = {};
  const nowMs = Date.now();
  const maxAgeMs = 24 * 60 * 60 * 1000;
  for (const key of apiKeys) {
    out[key] = [];
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    let level = '';
    let message = line;
    let tsMs = Number.NaN;
    try {
      const parsed = JSON.parse(line);
      level = String(parsed?.level || '').toLowerCase();
      message = String(parsed?.message || line);
      const parsedTs = Date.parse(String(parsed?.timestamp || ''));
      if (Number.isFinite(parsedTs)) {
        tsMs = parsedTs;
      }
    } catch {
      // Keep raw line if not JSON-formatted.
    }

    if (Number.isFinite(tsMs) && nowMs - tsMs > maxAgeMs) {
      continue;
    }

    const normalizedMessage = message.toLowerCase();
    const looksImportant = level === 'error'
      || level === 'warn'
      || /error|failed|not initialized|exception|insufficient|liquidat|109400|positionside/.test(normalizedMessage);

    if (!looksImportant) {
      continue;
    }

    for (const key of apiKeys) {
      if (!normalizedMessage.includes(key.toLowerCase())) {
        continue;
      }
      if (out[key].length >= 2) {
        continue;
      }

      const compact = message.replace(/\s+/g, ' ').trim();
      out[key].push(compact.length > 160 ? `${compact.slice(0, 157)}...` : compact);
    }
  }

  return out;
};

const buildLotSizingHint = (notes: string[]): string | null => {
  const joined = notes.join(' | ');
  const oversizeMatch = joined.match(/oversize\s*=\s*(\d+(?:\.\d+)?)%/i);
  if (!oversizeMatch) {
    return null;
  }

  const oversize = Number(oversizeMatch[1]);
  if (!Number.isFinite(oversize)) {
    return 'Low lot size detected; consider increasing risk multiplier or replacing low-liquidity pair.';
  }

  if (oversize >= 180) {
    return 'Lot too small for pair balancing (oversize > 180%). Suggest risk x2.0+ or replace pair.';
  }
  if (oversize >= 130) {
    return 'Lot likely too small (oversize > 130%). Suggest risk x1.5+ or increase deposit.';
  }
  return 'Lot sizing warning detected. Suggest risk x1.2+ and re-check execution.';
};

const parseUnknownJson = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed JSON payloads in old records.
  }
  return {};
};

const productModeTag = (mode: ProductMode) => {
  if (mode === 'algofund_client') {
    return <Tag color="gold">algofund</Tag>;
  }
  if (mode === 'dual') {
    return <Tag color="purple">dual</Tag>;
  }
  if (mode === 'copytrading_client') {
    return <Tag color="cyan">copytrading</Tag>;
  }
  if (mode === 'synctrade_client') {
    return <Tag color="volcano">synctrade</Tag>;
  }
  return <Tag color="green">strategy</Tag>;
};

const requestStatusTag = (copy: Copy, status: RequestStatus) => {
  if (status === 'approved') {
    return <Tag color="success">{copy.approved}</Tag>;
  }
  if (status === 'rejected') {
    return <Tag color="error">{copy.rejected}</Tag>;
  }
  return <Tag color="processing">{copy.pending}</Tag>;
};

const capabilityTag = (label: string, enabled: boolean) => (
  <Tag color={enabled ? 'success' : 'default'}>{label}: {enabled ? 'on' : 'off'}</Tag>
);

const renderCapabilityTags = (copy: Copy, capabilities?: TenantCapabilities) => {
  if (!capabilities) {
    return null;
  }

  return (
    <Space wrap>
      {capabilityTag(copy.capabilitySettings, Boolean(capabilities.settings))}
      {capabilityTag(copy.capabilityApiKeyUpdate, Boolean(capabilities.apiKeyUpdate))}
      {capabilityTag(copy.capabilityMonitoring, Boolean(capabilities.monitoring))}
      {capabilityTag(copy.capabilityBacktest, Boolean(capabilities.backtest))}
      {capabilityTag(copy.capabilityStartStop, Boolean(capabilities.startStopRequests))}
    </Space>
  );
};

const strategyLevelMarks = {
  0: 'Low',
  5: 'Medium',
  10: 'High',
};

type SaaSProps = {
  initialTab?: SaasTabKey;
  surfaceMode?: 'admin' | 'strategy-client' | 'algofund' | 'copytrading' | 'synctrade';
};

const clampPreviewValue = (value: number, max = 10): number => Math.min(max, Math.max(0, value));

const getBacktestRiskMultiplier = (riskScore: number, riskScaleMaxPercent: number): number => {
  const centered = (clampPreviewValue(Number(riskScore || 5), 10) - 5) / 5;
  const maxMul = Math.max(1.4, 1 + Number(riskScaleMaxPercent || 40) / 45);
  const logMax = Math.log(maxMul);
  return Math.exp(centered * logMax);
};

const getBacktestTradeMultiplier = (tradeFrequencyScore: number): number => {
  const normalized = clampPreviewValue(Number(tradeFrequencyScore || 5), 10) / 10;
  const maxMul = 2.4;
  const minMul = 1 / maxMul;
  return Math.exp(Math.log(minMul) + normalized * (Math.log(maxMul) - Math.log(minMul)));
};

const levelToSliderValue = (level: Level3): number => {
  if (level === 'low') return 0;
  if (level === 'high') return 10;
  return 5;
};

const sliderValueToLevel = (value: number): Level3 => {
  if (value <= 3.33) return 'low';
  if (value >= 6.67) return 'high';
  return 'medium';
};
const snapToLevelValue = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 5;
  }
  if (value <= 2.5) {
    return 0;
  }
  if (value >= 7.5) {
    return 10;
  }
  return 5;
};

const formatDateShort = (value?: string | null): string => {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
};

const formatDateTimeShort = (value?: string | null): string => {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
};

const renderOfferLifecycleTag = (offer: {
  published?: boolean;
  appearedAt?: string;
  snapshotUpdatedAt?: string;
}) => {
  const published = Boolean(offer?.published);
  const hasSavedSnapshot = Boolean(String(offer?.snapshotUpdatedAt || '').trim());

  const statusColor = published ? 'success' : (hasSavedSnapshot ? 'warning' : 'error');
  const statusLabel = published
    ? 'Диод: сохранено + на витрине'
    : (hasSavedSnapshot ? 'Диод: сохранено после бэка' : 'Диод: свежий sweep');

  const appeared = formatDateTimeShort(offer?.appearedAt || null);
  const saved = hasSavedSnapshot ? formatDateTimeShort(offer?.snapshotUpdatedAt || null) : '—';
  const tooltip = `Появление: ${appeared} | Сохранение: ${saved} | Витрина: ${published ? 'да' : 'нет'}`;

  return (
    <Tooltip title={tooltip}>
      <Tag color={statusColor}>{statusLabel}</Tag>
    </Tooltip>
  );
};

const formatPeriodCoverage = (period?: PeriodInfo | null): string => {
  if (!period?.dateFrom || !period?.dateTo) {
    return '';
  }

  const fromMs = Date.parse(period.dateFrom);
  const toMs = Date.parse(period.dateTo);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return '';
  }

  const diffMs = toMs - fromMs;
  const days = diffMs / (24 * 60 * 60 * 1000);
  if (days >= 1) {
    return ` • ${Math.round(days)}d`;
  }

  const hours = diffMs / (60 * 60 * 1000);
  return ` • ${Math.max(1, Math.round(hours))}h`;
};

const getPeriodDurationDays = (period?: PeriodInfo | null): number | null => {
  if (!period?.dateFrom || !period?.dateTo) {
    return null;
  }

  const fromMs = Date.parse(period.dateFrom);
  const toMs = Date.parse(period.dateTo);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return null;
  }

  const days = (toMs - fromMs) / (24 * 60 * 60 * 1000);
  return days > 0 ? days : null;
};

const formatPeriodLabel = (period?: PeriodInfo | null): string => {
  if (!period) {
    return '—';
  }

  const from = formatDateShort(period.dateFrom);
  const to = formatDateShort(period.dateTo);
  const interval = period.interval ? ` • ${period.interval}` : '';
  const coverage = formatPeriodCoverage(period);
  return `${from} -> ${to}${interval}${coverage}`;
};

export const hydrateStrategyPreview = (
  payload: Record<string, unknown> | StrategyPreviewResponse | null | undefined,
  offers: CatalogOffer[]
): StrategyPreviewResponse | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate = payload as StrategyPreviewResponse;
  if (!candidate.preview) {
    return null;
  }

  const embeddedOffer = candidate.offer && typeof candidate.offer.titleRu === 'string'
    ? candidate.offer
    : null;
  const offerId = typeof candidate.offerId === 'string'
    ? candidate.offerId
    : embeddedOffer?.offerId;
  const resolvedOffer = embeddedOffer || (offerId ? offers.find((offer) => offer.offerId === offerId) || null : null);

  return {
    ...candidate,
    offerId,
    offer: resolvedOffer,
    preset: candidate.preset || null,
  };
};

const SaaS: React.FC<SaaSProps> = ({ initialTab = 'admin', surfaceMode = 'admin' }) => {
  const { language } = useI18n();
  const navigate = useNavigate();
  const copy = COPY_BY_LANGUAGE[language];
  const isAdminSurface = surfaceMode === 'admin';
  const [messageApi, contextHolder] = message.useMessage();
  const summaryRequestSeqRef = useRef(0);
  const algofundRequestSeqRef = useRef(0);
  const algofundAutoPreviewTimerRef = useRef<number | null>(null);
  const copytradingRequestSeqRef = useRef(0);
  const backtestRequestSeqRef = useRef(0);
  const backtestDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runAdminSweepBacktestPreviewRef = useRef<() => Promise<void>>(async () => {});
  const monitoringAbortRef = useRef<AbortController | null>(null);
  const [summary, setSummary] = useState<SaasSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [reportPeriod, setReportPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [performanceReport, setPerformanceReport] = useState<AdminPerformanceReport | null>(null);
  const [performanceReportLoading, setPerformanceReportLoading] = useState(false);
  const [reportTargetSystemName, setReportTargetSystemName] = useState('');
  const [tsHealthReport, setTsHealthReport] = useState<AdminTsHealthReport | null>(null);
  const [tsHealthLoading, setTsHealthLoading] = useState(false);
  const [closedPositionsReport, setClosedPositionsReport] = useState<AdminClosedPositionsReport | null>(null);
  const [closedPositionsLoading, setClosedPositionsLoading] = useState(false);
  const [reportLookbackHours, setReportLookbackHours] = useState(24);
  const [reportPeriodHours, setReportPeriodHours] = useState(24 * 7);
  const [chartSnapshotReport, setChartSnapshotReport] = useState<AdminChartSnapshotReport | null>(null);
  const [chartSnapshotLoading, setChartSnapshotLoading] = useState(false);
  const [runtimeWindowBacktests, setRuntimeWindowBacktests] = useState<Record<string, AdminSweepBacktestPreviewResponse | null>>({});
  const [runtimeWindowBacktestsLoading, setRuntimeWindowBacktestsLoading] = useState(false);
  const [sendTelegramLoading, setSendTelegramLoading] = useState(false);
  const reviewContextRef = useRef<HTMLDivElement | null>(null);
  const [strategyTenantId, setStrategyTenantId] = useState<number | null>(null);
  const [algofundTenantId, setAlgofundTenantId] = useState<number | null>(null);
  const [copytradingTenantId, setCopytradingTenantId] = useState<number | null>(null);
  const [strategyState, setStrategyState] = useState<StrategyClientState | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategyError, setStrategyError] = useState('');
  const [algofundState, setAlgofundState] = useState<AlgofundState | null>(null);
  const [algofundLoading, setAlgofundLoading] = useState(false);
  const [algofundError, setAlgofundError] = useState('');
  const [copytradingState, setCopytradingState] = useState<Record<string, any> | null>(null);
  const [copytradingLoading, setCopytradingLoading] = useState(false);
  const [copytradingError, setCopytradingError] = useState('');
  const [copytradingSyncing, setCopytradingSyncing] = useState(false);
  const [copytradingSyncMarketType, setCopytradingSyncMarketType] = useState<'swap' | 'spot'>('swap');
  const [copytradingMasterApiKeyName, setCopytradingMasterApiKeyName] = useState('');
  const [copytradingMasterName, setCopytradingMasterName] = useState('');
  const [copytradingMasterTags, setCopytradingMasterTags] = useState('copytrading-master');
  const [copytradingCopyRatio, setCopytradingCopyRatio] = useState(1);
  const [copytradingCopyEnabled, setCopytradingCopyEnabled] = useState(false);
  const [copytradingFollowers, setCopytradingFollowers] = useState<Array<Record<string, any>>>([]);
  const [copyFollowerTenantName, setCopyFollowerTenantName] = useState('');
  const [copyFollowerTenantSlug, setCopyFollowerTenantSlug] = useState('');
  const [copyFollowerApiKeyName, setCopyFollowerApiKeyName] = useState('');
  const [copyFollowerTags, setCopyFollowerTags] = useState('copytrading-tenant');
  const [copyKeyDraftRole, setCopyKeyDraftRole] = useState<'master' | 'tenant'>('master');
  const [copyKeyDraftName, setCopyKeyDraftName] = useState('');
  const [copyKeyDraftExchange, setCopyKeyDraftExchange] = useState('binance');
  const [copyKeyDraftApiKey, setCopyKeyDraftApiKey] = useState('');
  const [copyKeyDraftSecret, setCopyKeyDraftSecret] = useState('');
  const [copyKeyDraftPassphrase, setCopyKeyDraftPassphrase] = useState('');
  const [copyKeyDraftTestnet, setCopyKeyDraftTestnet] = useState(false);
  const [copyKeyDraftDemo, setCopyKeyDraftDemo] = useState(false);
  const [copytradingTenantDisplayName, setCopytradingTenantDisplayName] = useState('');
  const [copytradingTenantStatus, setCopytradingTenantStatus] = useState('active');
  const [copytradingTenantPlanCode, setCopytradingTenantPlanCode] = useState('');
  const [copytradingUiStatus, setCopytradingUiStatus] = useState<CopytradingUiStatus>('idle');
  const [copytradingUiMessage, setCopytradingUiMessage] = useState('Ожидание данных copytrading');
  const [copytradingLogs, setCopytradingLogs] = useState<string[]>([]);

  // ─── Synctrade state ───────────────────────────────────────────────────────
  const [synctradeTenantId, setSynctradeTenantId] = useState<number | null>(null);
  const [synctradeState, setSynctradeState] = useState<Record<string, any> | null>(null);
  const [synctradeLoading, setSynctradeLoading] = useState(false);
  const [synctradeError, setSynctradeError] = useState('');
  const [synctradeMasterApiKeyName, setSynctradeMasterApiKeyName] = useState('');
  const [synctradeMasterDisplayName, setSynctradeMasterDisplayName] = useState('');
  const [synctradeSymbol, setSynctradeSymbol] = useState('DOGEUSDT');
  const [synctradeNewHedgeMaxSpend, setSynctradeNewHedgeMaxSpend] = useState<number>(0);
  const [synctradeNewHedgeTargetLoss, setSynctradeNewHedgeTargetLoss] = useState<number>(0);
  const [synctradeTargetProfit, setSynctradeTargetProfit] = useState(50);
  const [synctradeTargetMode, setSynctradeTargetMode] = useState<'percent' | 'usdt'>('percent');
  const [synctradeIntervalMs, setSynctradeIntervalMs] = useState(500);
  const [synctradeEnabled, setSynctradeEnabled] = useState(false);
  const [synctradeHedgeAccounts, setSynctradeHedgeAccounts] = useState<Array<Record<string, any>>>([]);
  const [synctradeNewHedgeName, setSynctradeNewHedgeName] = useState('');
  const [synctradeNewHedgeApiKey, setSynctradeNewHedgeApiKey] = useState('');
  const [synctradeSessions, setSynctradeSessions] = useState<Array<Record<string, any>>>([]);
  const [synctradeExecSide, setSynctradeExecSide] = useState<'long' | 'short'>('long');
  const [synctradeExecLeverage, setSynctradeExecLeverage] = useState(5);
  const [synctradeExecLotPercent, setSynctradeExecLotPercent] = useState(10);
  const [synctradeExecuting, setSynctradeExecuting] = useState(false);
  const [synctradeLivePnl, setSynctradeLivePnl] = useState<Record<number, { masterPnl: number; totalPnl: number }>>({});

  // SyncAuto state
  const [syncAutoStatus, setSyncAutoStatus] = useState<any>(null);
  const [syncAutoLoading, setSyncAutoLoading] = useState(false);
  const [syncAutoMaxPairs, setSyncAutoMaxPairs] = useState(6);
  const [syncAutoLevMin, setSyncAutoLevMin] = useState(15);
  const [syncAutoLevMax, setSyncAutoLevMax] = useState(30);
  const [syncAutoLotPercent, setSyncAutoLotPercent] = useState(80);

  const [strategyOfferIds, setStrategyOfferIds] = useState<string[]>([]);
  const [strategySystemProfileId, setStrategySystemProfileId] = useState<number | null>(null);
  const [strategyNewProfileName, setStrategyNewProfileName] = useState('');
  const [strategyRiskInput, setStrategyRiskInput] = useState(5);
  const [strategyTradeInput, setStrategyTradeInput] = useState(5);
  const [strategyApiKeyName, setStrategyApiKeyName] = useState('');
  const [strategyTenantDisplayName, setStrategyTenantDisplayName] = useState('');
  const [strategyTenantStatus, setStrategyTenantStatus] = useState('active');
  const [strategyTenantPlanCode, setStrategyTenantPlanCode] = useState('');
  const [strategyPreviewOfferId, setStrategyPreviewOfferId] = useState('');
  const [strategyPreview, setStrategyPreview] = useState<StrategyPreviewResponse | null>(null);
  const [strategyPreviewLoading, setStrategyPreviewLoading] = useState(false);
  const [strategySelectionPreview, setStrategySelectionPreview] = useState<StrategySelectionPreviewResponse | null>(null);
  const [strategySelectionPreviewLoading, setStrategySelectionPreviewLoading] = useState(false);
  const [materializeResponse, setMaterializeResponse] = useState<MaterializeResponse | null>(null);
  const [strategyMagicLink, setStrategyMagicLink] = useState<ClientMagicLinkResponse | null>(null);
  const [algofundMagicLink, setAlgofundMagicLink] = useState<ClientMagicLinkResponse | null>(null);
  const [algofundRiskMultiplier, setAlgofundRiskMultiplier] = useState(1);
  const [algofundApiKeyName, setAlgofundApiKeyName] = useState('');
  const [algofundTenantDisplayName, setAlgofundTenantDisplayName] = useState('');
  const [algofundTenantStatus, setAlgofundTenantStatus] = useState('active');
  const [algofundTenantPlanCode, setAlgofundTenantPlanCode] = useState('');
  const [adminTab, setAdminTab] = useState<AdminTabKey>('clients');
  const [createTenantDisplayName, setCreateTenantDisplayName] = useState('');
  const [createTenantProductMode, setCreateTenantProductMode] = useState<ProductMode>('strategy_client');
  const [createTenantPlanCode, setCreateTenantPlanCode] = useState('');
  const [createTenantAlgofundPlanCode, setCreateTenantAlgofundPlanCode] = useState('');
  const [createTenantApiKey, setCreateTenantApiKey] = useState('');
  const [createTenantInlineApiKeyName, setCreateTenantInlineApiKeyName] = useState('');
  const [createTenantInlineApiKey, setCreateTenantInlineApiKey] = useState('');
  const [createTenantInlineApiSecret, setCreateTenantInlineApiSecret] = useState('');
  const [createTenantInlineApiPassphrase, setCreateTenantInlineApiPassphrase] = useState('');
  const [createTenantInlineApiExchange, setCreateTenantInlineApiExchange] = useState('bybit');
  const [createTenantInlineApiSpeedLimit, setCreateTenantInlineApiSpeedLimit] = useState(10);
  const [createTenantInlineApiTestnet, setCreateTenantInlineApiTestnet] = useState(false);
  const [createTenantInlineApiDemo, setCreateTenantInlineApiDemo] = useState(false);
  const [createTenantEmail, setCreateTenantEmail] = useState('');
  const [algofundNote, setAlgofundNote] = useState('');
  const [algofundDecisionNote, setAlgofundDecisionNote] = useState('');
  const [retryMaterializeModalVisible, setRetryMaterializeModalVisible] = useState(false);
  const [publishResponse, setPublishResponse] = useState<AdminPublishResponse | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    return parseAdminPublishResponse(window.localStorage.getItem(ADMIN_PUBLISH_RESPONSE_STORAGE_KEY));
  });
  const [monitoringSystemsByApiKey, setMonitoringSystemsByApiKey] = useState<Record<string, TradingSystemListItem[]>>({});
  const [monitoringSystemSelected, setMonitoringSystemSelected] = useState<Record<number, number | undefined>>({});
  const [monitoringLogCommentsByApiKey, setMonitoringLogCommentsByApiKey] = useState<Record<string, string[]>>({});
  const [monitoringPositionsByApiKey, setMonitoringPositionsByApiKey] = useState<Record<string, MonitoringPositionsDigest>>({});
  const [monitoringStrategiesByApiKey, setMonitoringStrategiesByApiKey] = useState<Record<string, MonitoringStrategyDigest>>({});
  const [monitoringReconciliationByApiKey, setMonitoringReconciliationByApiKey] = useState<Record<string, MonitoringReconciliationDigest>>({});
  const [monitoringTabLoading, setMonitoringTabLoading] = useState(false);
  const [monitoringModeFilter, setMonitoringModeFilter] = useState<'all' | ProductMode>('all');
  const [clientsModeFilter, setClientsModeFilter] = useState<'all' | ProductMode>('all');
  const [clientsClassKind, setClientsClassKind] = useState<'all' | 'offer' | 'ts'>('all');
  const [clientsClassValue, setClientsClassValue] = useState('');
  const [selectedAdminReviewKind, setSelectedAdminReviewKind] = useState<'offer' | 'algofund-ts'>('offer');
  const [adminSweepListMode, setAdminSweepListMode] = useState<'offers' | 'ts'>('offers');
  const [selectedAdminReviewOfferId, setSelectedAdminReviewOfferId] = useState('');
  const [approvalMinProfitFactor, setApprovalMinProfitFactor] = useState(1);
  const [telegramControls, setTelegramControls] = useState<TelegramControls | null>(null);
  const [telegramControlsLoading, setTelegramControlsLoading] = useState(false);
  const [lowLotRecommendations, setLowLotRecommendations] = useState<LowLotRecommendationResponse | null>(null);
  const [lowLotLoading, setLowLotLoading] = useState(false);
  const [applyLowLotTarget, setApplyLowLotTarget] = useState<LowLotRecommendation | null>(null);
  const [applyLowLotDeposit, setApplyLowLotDeposit] = useState(true);
  const [applyLowLotLot, setApplyLowLotLot] = useState(true);
  const [applyLowLotWholeSystem, setApplyLowLotWholeSystem] = useState(true);
  const [applyLowLotReplacement, setApplyLowLotReplacement] = useState('');
  const [applyLowLotWorking, setApplyLowLotWorking] = useState(false);
  const [batchTenantIds, setBatchTenantIds] = useState<number[]>([]);
  const [storefrontConnectTarget, setStorefrontConnectTarget] = useState<null | { systemId: number; systemName: string; tenantIds: number[]; originalTenantIds: number[] }>(null);
  const [strategyConnectTarget, setStrategyConnectTarget] = useState<null | { offerId: string; offerTitle: string; tenantIds: number[] }>(null);
  const [batchAlgofundAction, setBatchAlgofundAction] = useState<'start' | 'stop' | 'switch_system'>('start');
  const [batchTargetSystemId, setBatchTargetSystemId] = useState<number | null>(null);
  const [batchActionNote, setBatchActionNote] = useState('');
  const [unpublishWizardVisible, setUnpublishWizardVisible] = useState(false);
  const [unpublishTargetOfferId, setUnpublishTargetOfferId] = useState('');
  const [unpublishImpact, setUnpublishImpact] = useState<OfferUnpublishImpact | null>(null);
  const [unpublishImpactLoading, setUnpublishImpactLoading] = useState(false);
  const [unpublishAcknowledge, setUnpublishAcknowledge] = useState(false);
  const [algofundActiveSystems, setAlgofundActiveSystems] = useState<Array<{id:number;systemName:string;weight:number;isEnabled:boolean;assignedBy:string}>>([]);
  const [algofundActiveSystemsLoading, setAlgofundActiveSystemsLoading] = useState(false);
  const [algofundCardRiskDrafts, setAlgofundCardRiskDrafts] = useState<Record<string, number>>({});
  const [monitoringChartOpen, setMonitoringChartOpen] = useState(false);
  const [monitoringChartLoading, setMonitoringChartLoading] = useState(false);
  const [monitoringChartApiKey, setMonitoringChartApiKey] = useState('');
  const [monitoringChartPoints, setMonitoringChartPoints] = useState<LinePoint[]>([]);
  const [monitoringChartLatest, setMonitoringChartLatest] = useState<MonitoringSnapshotPoint | null>(null);
  const [monitoringChartDays, setMonitoringChartDays] = useState(1);
  const [planDrafts, setPlanDrafts] = useState<Record<string, Plan>>({});
  const [actionLoading, setActionLoading] = useState<string>('');
  const [activeTab, setActiveTab] = useState<SaasTabKey>(initialTab);
  const [approveRequestModalVisible, setApproveRequestModalVisible] = useState(false);
  const [approveRequestPendingId, setApproveRequestPendingId] = useState<number | null>(null);
  const [approveRequestSelectedPlan, setApproveRequestSelectedPlan] = useState('');
  const [approveRequestSelectedApiKey, setApproveRequestSelectedApiKey] = useState('');
  const [adminWizardTarget, setAdminWizardTarget] = useState<'offer' | 'algofund-ts'>('offer');
  const [backtestDrawerVisible, setBacktestDrawerVisible] = useState(false);
  const [backtestDrawerContext, setBacktestDrawerContext] = useState<SaasBacktestContext | null>(null);
  const [backtestTsWeightsByOfferId, setBacktestTsWeightsByOfferId] = useState<Record<string, number>>({});
  const [adminBacktestSettingsByCard, setAdminBacktestSettingsByCard] = useState<Record<string, BacktestCardSettings>>(() => {
    if (typeof window === 'undefined') {
      return {};
    }
    return parseAdminBacktestSettingsByCard(window.localStorage.getItem(ADMIN_BACKTEST_SETTINGS_STORAGE_KEY));
  });
  const [adminSweepBacktestRiskScore, setAdminSweepBacktestRiskScore] = useState(DEFAULT_BACKTEST_SETTINGS.riskScore);
  const [adminSweepBacktestTradeScore, setAdminSweepBacktestTradeScore] = useState(DEFAULT_BACKTEST_SETTINGS.tradeFrequencyScore);
  const [adminSweepBacktestInitialBalance, setAdminSweepBacktestInitialBalance] = useState(DEFAULT_BACKTEST_SETTINGS.initialBalance);
  const [adminSweepBacktestRiskScaleMaxPercent, setAdminSweepBacktestRiskScaleMaxPercent] = useState(DEFAULT_BACKTEST_SETTINGS.riskScaleMaxPercent);
  const [adminSweepBacktestMaxOpenPositions, setAdminSweepBacktestMaxOpenPositions] = useState(DEFAULT_BACKTEST_SETTINGS.maxOpenPositions);
  const [adminSweepBacktestLoading, setAdminSweepBacktestLoading] = useState(false);
  const [adminSweepBacktestResult, setAdminSweepBacktestResult] = useState<AdminSweepBacktestPreviewResponse | null>(null);
  const [adminSweepBacktestRerunApiKey, setAdminSweepBacktestRerunApiKey] = useState('');
  const [showBacktestBtcOverlay, setShowBacktestBtcOverlay] = useState(true);
  const [showBacktestTradeFreqOverlay, setShowBacktestTradeFreqOverlay] = useState(true);
  const [backtestBtcOverlayPoints, setBacktestBtcOverlayPoints] = useState<LinePoint[]>([]);
  const [backtestBtcOverlayLoading, setBacktestBtcOverlayLoading] = useState(false);
  // True when user moved a slider but hasn't yet recalculated — show stale indicator
  const [adminSweepBacktestStale, setAdminSweepBacktestStale] = useState(false);
  // Client-side scaling factor applied instantly to last equity curve while backend recalculates
  const [adminSweepPreviewRiskScale, setAdminSweepPreviewRiskScale] = useState(1);
  const [removeStorefrontTarget, setRemoveStorefrontTarget] = useState<string | null>(null);
  const [removeStorefrontClosePositions, setRemoveStorefrontClosePositions] = useState(true);
  const [removeStorefrontConfirm, setRemoveStorefrontConfirm] = useState<{
    systemName: string;
    mode: 'remove' | 'delete';
    clientCount: number;
    tenants: Array<{ id: number; display_name: string }>;
    positionsByApiKey: Array<{ apiKeyName: string; openPositions: number; symbols: string[] }>;
  } | null>(null);
  const [selectedAdminDraftTsOfferIds, setSelectedAdminDraftTsOfferIds] = useState<string[]>([]);
  const [selectedAdminDraftTsSetKey, setSelectedAdminDraftTsSetKey] = useState('');

  const strategyTenants = useMemo(
    () => (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'strategy_client' || item.tenant.product_mode === 'dual'),
    [summary?.tenants],
  );
  const algofundTenants = useMemo(
    () => (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'algofund_client' || item.tenant.product_mode === 'dual'),
    [summary?.tenants],
  );
  const copytradingTenants = useMemo(
    () => (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'copytrading_client'),
    [summary?.tenants],
  );
  const synctradeTenants = useMemo(
    () => (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'synctrade_client'),
    [summary?.tenants],
  );
  const batchEligibleAlgofundTenants = useMemo(
    () => (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'algofund_client' || item.tenant.product_mode === 'dual'),
    [summary?.tenants],
  );
  const algofundTenantsWithPublishedTs = useMemo(
    () => batchEligibleAlgofundTenants.filter((item) => String(item.algofundProfile?.published_system_name || '').trim().length > 0),
    [batchEligibleAlgofundTenants],
  );
  const publishedAlgofundSystems = useMemo(
    () => Array.from(new Set(
      [
        ...algofundTenantsWithPublishedTs
          .map((item) => String(item.algofundProfile?.published_system_name || '').trim())
          .filter(Boolean),
        ...((summary?.offerStore?.algofundStorefrontSystemNames || [])
          .map((name) => String(name || '').trim())
          .filter(Boolean)),
      ]
    )),
    [algofundTenantsWithPublishedTs, summary?.offerStore?.algofundStorefrontSystemNames],
  );
  const strategySystemProfiles = strategyState?.systemProfiles || [];
  const activeStrategySystemProfile = strategySystemProfiles.find((item) => item.isActive) || null;
  const selectedStrategyTenantSummary = strategyTenants.find((item) => item.tenant.id === strategyTenantId) || null;
  const selectedAlgofundTenantSummary = algofundTenants.find((item) => item.tenant.id === algofundTenantId) || null;
  const selectedAlgofundPublishedSystemName = String(
    selectedAlgofundTenantSummary?.algofundProfile?.published_system_name
    || algofundState?.profile?.published_system_name
    || ''
  ).trim();
  const connectedAlgofundCards = useMemo(() => {
    const enabled = (algofundActiveSystems || []).filter((item) => item.isEnabled);
    if (!selectedAlgofundPublishedSystemName) {
      return enabled;
    }
    const preferred = enabled.filter((item) => String(item.systemName || '').trim() === selectedAlgofundPublishedSystemName);
    return preferred.length > 0 ? preferred : enabled;
  }, [algofundActiveSystems, selectedAlgofundPublishedSystemName]);
  const reportSystemOptions = Array.from(new Set([
    selectedAlgofundPublishedSystemName,
    ...publishedAlgofundSystems,
    String(adminSweepBacktestResult?.publishMeta?.systemName || '').trim(),
  ].filter((name) => {
    const safeName = String(name || '').trim();
    return safeName.length > 0 && safeName.toUpperCase().startsWith('ALGOFUND_MASTER::');
  }))).map((name) => {
    const rawName = String(name || '').trim();
    const parts = rawName.split('::').filter(Boolean);
    let token = String(parts[parts.length - 1] || '').trim().toLowerCase();
    token = token.replace(/^algofund-master-btdd-d1-/, '');
    token = token.replace(/-h-([a-z0-9]{4,})$/i, '-$1');
    return { label: token || rawName, value: rawName };
  });
  const resolvedReportSystemName = String(
    reportTargetSystemName
    || selectedAlgofundPublishedSystemName
    || reportSystemOptions[0]?.value
    || ''
  ).trim();
  const strategyCapabilities = strategyState?.capabilities || selectedStrategyTenantSummary?.capabilities;
  const algofundCapabilities = algofundState?.capabilities || selectedAlgofundTenantSummary?.capabilities;
  const strategySettingsEnabled = strategyCapabilities ? Boolean(strategyCapabilities.settings) : true;
  const algofundSettingsEnabled = algofundCapabilities ? Boolean(algofundCapabilities.settings) : true;
  const strategyMonitoringEnabled = strategyCapabilities ? Boolean(strategyCapabilities.monitoring) : true;
  const algofundMonitoringEnabled = algofundCapabilities ? Boolean(algofundCapabilities.monitoring) : true;
  const strategyBacktestEnabled = strategyCapabilities ? Boolean(strategyCapabilities.backtest) : true;
  const algofundBacktestEnabled = algofundCapabilities ? Boolean(algofundCapabilities.backtest) : true;
  const algofundStartStopEnabled = algofundCapabilities ? Boolean(algofundCapabilities.startStopRequests) : true;
  const strategyApiKeyEditable = isAdminSurface && Boolean(strategyCapabilities?.apiKeyUpdate ?? true);
  const algofundApiKeyEditable = isAdminSurface && Boolean(algofundCapabilities?.apiKeyUpdate ?? true);
  const strategyPlanOptions = useMemo(() => (summary?.plans || [])
    .filter((plan) => plan.product_mode === 'strategy_client')
    .map((plan) => ({ value: plan.code, label: `${plan.title} · ${plan.original_price_usdt ? formatMoney(plan.original_price_usdt) + ' → ' : ''}${formatMoney(plan.price_usdt)}` })),
  [summary?.plans]);
  const algofundPlanOptions = useMemo(() => (summary?.plans || [])
    .filter((plan) => plan.product_mode === 'algofund_client')
    .map((plan) => ({ value: plan.code, label: `${plan.title} · ${plan.original_price_usdt ? formatMoney(plan.original_price_usdt) + ' → ' : ''}${formatMoney(plan.price_usdt)}` })),
  [summary?.plans]);
  const copytradingPlanOptions = useMemo(() => (summary?.plans || [])
    .filter((plan) => plan.product_mode === 'copytrading_client')
    .map((plan) => ({ value: plan.code, label: `${plan.title} · ${plan.original_price_usdt ? formatMoney(plan.original_price_usdt) + ' → ' : ''}${formatMoney(plan.price_usdt)}` })),
  [summary?.plans]);
  const apiKeyOptions = useMemo(() => (summary?.apiKeys || []).map((name) => ({ label: name, value: name })), [summary?.apiKeys]);
  const summaryCatalogOffers = useMemo(() => dedupeOffersById([
    ...(summary?.catalog?.clientCatalog?.mono || []),
    ...(summary?.catalog?.clientCatalog?.synth || []),
  ]), [summary?.catalog?.clientCatalog]);
  const strategyRecommendedOffers = useMemo(() => dedupeOffersById(
    Object.values(strategyState?.recommendedSets || {}).reduce<CatalogOffer[]>((acc, items) => {
      if (Array.isArray(items)) {
        acc.push(...items);
      }
      return acc;
    }, [])
  ), [strategyState?.recommendedSets]);
  const summaryRecommendedOffers = useMemo(() => dedupeOffersById(
    Object.values(summary?.recommendedSets || {}).reduce<CatalogOffer[]>((acc, items) => {
      if (Array.isArray(items)) {
        acc.push(...items);
      }
      return acc;
    }, [])
  ), [summary?.recommendedSets]);
  const publishedOfferIds = useMemo(
    () => new Set((summary?.offerStore?.publishedOfferIds || []).map((item) => String(item))),
    [summary?.offerStore?.publishedOfferIds],
  );

  const appendCopytradingLog = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    setCopytradingLogs((prev) => [`${ts} - ${line}`, ...prev].slice(0, 24));
  };
  const strategyOfferCatalog = useMemo(() => dedupeOffersById(
    (strategyState?.offers || []).length > 0
      ? (strategyState?.offers || [])
      : [...summaryCatalogOffers, ...strategyRecommendedOffers, ...summaryRecommendedOffers]
  ).filter((offer) => publishedOfferIds.has(String(offer.offerId || ''))),
  [strategyState?.offers, summaryCatalogOffers, strategyRecommendedOffers, summaryRecommendedOffers, publishedOfferIds]);
  const strategyDraftConstraints = useMemo(
    () => buildDraftStrategyConstraints(strategyOfferIds, strategyOfferCatalog, strategyState?.constraints || null),
    [strategyOfferIds, strategyOfferCatalog, strategyState?.constraints],
  );
  const pendingAlgofundRequests = useMemo(
    () => (summary?.algofundRequestQueue?.items || []).filter((item) => item.status === 'pending'),
    [summary?.algofundRequestQueue?.items],
  );
  const pendingAlgofundRequestsByTenant = useMemo(() => pendingAlgofundRequests.reduce<Record<number, AlgofundRequest[]>>((acc, item) => {
    const key = Number(item.tenant_id || 0);
    if (!Number.isFinite(key) || key <= 0) {
      return acc;
    }
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {}), [pendingAlgofundRequests]);
  const offerStoreOffers = useMemo(() => summary?.offerStore?.offers || [], [summary?.offerStore?.offers]);
  const sweepReviewRecords = useMemo(() => Array.from(
    new Map(
      [
        ...(summary?.sweepSummary?.selectedMembers || []),
        ...(summary?.sweepSummary?.topAll || []),
        ...(summary?.sweepSummary?.topByMode?.mono || []),
        ...(summary?.sweepSummary?.topByMode?.synth || []),
      ].map((item) => [Number(item.strategyId || 0), item])
    ).values()
  ).filter((item) => Number(item?.strategyId || 0) > 0), [summary?.sweepSummary]);
  const sweepRecordByStrategyId = useMemo(() => sweepReviewRecords.reduce<Record<number, typeof sweepReviewRecords[number]>>((acc, item) => {
    const key = Number(item.strategyId || 0);
    if (key > 0) {
      acc[key] = item;
    }
    return acc;
  }, {}), [sweepReviewRecords]);
  const publishedStorefrontOffers = useMemo(() => offerStoreOffers.filter((offer) => Boolean(offer.published)), [offerStoreOffers]);
  const offerStoreOfferByStrategyId = useMemo(() => new Map(
    offerStoreOffers
      .map((offer) => [Number(offer.strategyId || 0), offer] as const)
      .filter(([strategyId]) => Number.isFinite(strategyId) && strategyId > 0)
  ), [offerStoreOffers]);
  const reviewableSweepOffersRaw = useMemo(
    () => offerStoreOffers.filter(
      (offer) =>
        Number(offer.pf || 0) >= approvalMinProfitFactor &&
        (sweepReviewRecords.length === 0 || sweepRecordByStrategyId[Number(offer.strategyId || 0)] != null)
    ),
    [offerStoreOffers, sweepReviewRecords, sweepRecordByStrategyId, approvalMinProfitFactor],
  );
  const reviewTargetTradesPerDay = Number(summary?.offerStore?.defaults?.targetTradesPerDay || 0);
  const classifyOfferGroup = (offer: any): string => {
    const mode = String(offer?.mode || offer?.strategy?.mode || '').toLowerCase() === 'mono' ? 'mono' : 'synth';
    const familySource = String(
      offer?.strategyType
      || offer?.strategy?.strategyType
      || offer?.strategyName
      || offer?.titleRu
      || ''
    ).toLowerCase();
    if (familySource.includes('stat_arb')) {
      return mode === 'synth' ? 'statarb synth core' : 'statarb mono anchor';
    }
    if (familySource.includes('dd_battletoads')) {
      return mode === 'synth' ? 'dd synth decorrelation' : 'dd mono trend';
    }
    if (familySource.includes('zz_breakout')) {
      return mode === 'synth' ? 'zz synth decorrelation' : 'zz mono trend';
    }
    return mode === 'synth' ? 'synth other' : 'mono other';
  };

  const reviewableSweepOffers = useMemo(() => [...reviewableSweepOffersRaw]
    .sort((a, b) => {
      const target = Number.isFinite(reviewTargetTradesPerDay) ? reviewTargetTradesPerDay : 0;
      const aDistance = Math.abs(Number(a.tradesPerDay || 0) - target);
      const bDistance = Math.abs(Number(b.tradesPerDay || 0) - target);
      if (aDistance !== bDistance) {
        return aDistance - bDistance;
      }
      return Number(b.score || 0) - Number(a.score || 0);
    })
    .map((offer) => ({
      ...offer,
      groupLabel: classifyOfferGroup(offer),
    })), [reviewableSweepOffersRaw, reviewTargetTradesPerDay]);
  const researchCandidateOffers = useMemo(
    () => reviewableSweepOffers.filter((offer) => !Boolean(offer.published)),
    [reviewableSweepOffers],
  );
  const adminReviewOfferPool = useMemo(() => Array.from(
    new Map(
      [...reviewableSweepOffers, ...publishedStorefrontOffers]
        .map((offer) => [String(offer.offerId), offer])
    ).values()
  ), [reviewableSweepOffers, publishedStorefrontOffers]);
  const selectedAdminReviewOffer = useMemo(
    () => adminReviewOfferPool.find((offer) => String(offer.offerId) === selectedAdminReviewOfferId) || null,
    [adminReviewOfferPool, selectedAdminReviewOfferId],
  );
  const adminTradingSystemDraft = summary?.catalog?.adminTradingSystemDraft || null;
  type ReviewableSweepOffer = {
    offerId: string;
    strategyId: number;
    ret?: number;
    pf?: number;
    dd?: number;
  };
  const reviewableSweepOfferByStrategyId = useMemo(() => new Map(
    (offerStoreOffers as ReviewableSweepOffer[])
      .map((offer: ReviewableSweepOffer) => [Number(offer.strategyId || 0), offer] as const)
      .filter(([strategyId]) => Number.isFinite(strategyId) && strategyId > 0)
  ), [offerStoreOffers]);
  const strategySelectedBacktestOffer = useMemo(() => {
    const selectedOfferIds = (strategyState?.profile?.selectedOfferIds || [])
      .map((offerId) => String(offerId || '').trim())
      .filter(Boolean);
    if (selectedOfferIds.length === 0) {
      return null;
    }

    const offerStoreById = new Map(
      offerStoreOffers
        .map((offer) => [String(offer.offerId || '').trim(), offer] as const)
        .filter(([offerId]) => offerId.length > 0)
    );

    for (const offerId of selectedOfferIds) {
      const storefrontOffer = offerStoreById.get(offerId);
      if (storefrontOffer) {
        return storefrontOffer;
      }
    }

    const catalogById = new Map(
      [...(strategyState?.offers || []), ...strategyOfferCatalog]
        .map((offer) => [String(offer.offerId || '').trim(), offer] as const)
        .filter(([offerId]) => offerId.length > 0)
    );

    for (const offerId of selectedOfferIds) {
      const catalogOffer = catalogById.get(offerId);
      if (catalogOffer) {
        return {
          offerId,
          titleRu: String(catalogOffer.titleRu || `Карточка ${offerId}`),
          published: true,
        };
      }
    }

    return null;
  }, [strategyState?.profile?.selectedOfferIds, strategyState?.offers, strategyOfferCatalog, offerStoreOffers]);
  const runtimeMasterSystems = useMemo(() => ((algofundState?.availableSystems || []) as Array<any>)
    .filter((item: any) => String(item?.name || '').trim().toUpperCase().startsWith('ALGOFUND_MASTER::'))
    .map((item: any) => {
      const memberStrategyIds = Array.isArray(item?.memberStrategyIds)
        ? item.memberStrategyIds.map((value: any) => Number(value || 0)).filter((value: number) => Number.isFinite(value) && value > 0)
        : [];
      const rawMemberWeightsByStrategyId = item?.memberWeightsByStrategyId && typeof item.memberWeightsByStrategyId === 'object'
        ? (item.memberWeightsByStrategyId as Record<string, number>)
        : {};
      const runtimeOffers: ReviewableSweepOffer[] = memberStrategyIds
        .map((strategyId: number) => offerStoreOfferByStrategyId.get(strategyId) || reviewableSweepOfferByStrategyId.get(strategyId) || null)
        .filter((offer: ReviewableSweepOffer | null): offer is ReviewableSweepOffer => Boolean(offer));
      const runtimeOfferIds = Array.from(new Set(runtimeOffers.map((offer: ReviewableSweepOffer) => String(offer.offerId || '').trim()).filter(Boolean)));
      const avgRet = runtimeOffers.length > 0
        ? runtimeOffers.reduce((acc: number, offer: ReviewableSweepOffer) => acc + Number(offer.ret || 0), 0) / runtimeOffers.length
        : 0;
      const avgPf = runtimeOffers.length > 0
        ? runtimeOffers.reduce((acc: number, offer: ReviewableSweepOffer) => acc + Number(offer.pf || 0), 0) / runtimeOffers.length
        : 0;
      const avgDd = runtimeOffers.length > 0
        ? runtimeOffers.reduce((acc: number, offer: ReviewableSweepOffer) => acc + Number(offer.dd || 0), 0) / runtimeOffers.length
        : 0;

      const offerWeightsById = Object.fromEntries(
        runtimeOfferIds.map((offerId) => [offerId, 0])
      ) as Record<string, number>;
      memberStrategyIds.forEach((strategyId: number) => {
        const offer = offerStoreOfferByStrategyId.get(strategyId) || reviewableSweepOfferByStrategyId.get(strategyId) || null;
        const offerId = String(offer?.offerId || '').trim();
        if (!offerId) {
          return;
        }
        const strategyWeight = Number(rawMemberWeightsByStrategyId[String(strategyId)] || 0);
        const safeWeight = Number.isFinite(strategyWeight) && strategyWeight > 0 ? strategyWeight : 1;
        offerWeightsById[offerId] = Number((Number(offerWeightsById[offerId] || 0) + safeWeight).toFixed(6));
      });

      return {
        systemName: String(item?.name || '').trim(),
        memberCount: Math.max(runtimeOfferIds.length, Number(item?.memberCount || 0)),
        memberStrategyIds,
        offerIds: runtimeOfferIds,
        offerWeightsById,
        offers: runtimeOffers,
        avgRet,
        avgPf,
        avgDd,
      };
    })
    .filter((item) => item.systemName.length > 0),
  [algofundState?.availableSystems, offerStoreOfferByStrategyId, reviewableSweepOfferByStrategyId]);
  const runtimeMasterSystemByName = useMemo(
    () => new Map(runtimeMasterSystems.map((item) => [item.systemName, item] as const)),
    [runtimeMasterSystems],
  );
  const adminSweepTsSets = useMemo(() => Object.entries(summary?.recommendedSets || {})
    .filter(([setKey]) => !LEGACY_PRESET_SET_KEYS.has(String(setKey || '').trim().toLowerCase()))
    .map(([setKey, offers]) => {
      const safeOffers = Array.isArray(offers) ? offers : [];
      const offerIds = Array.from(new Set(safeOffers.map((offer) => String(offer.offerId || '')).filter(Boolean)));
      const avgRet = safeOffers.length > 0
        ? safeOffers.reduce((acc, offer) => acc + Number(offer.metrics?.ret || 0), 0) / safeOffers.length
        : 0;
      const avgPf = safeOffers.length > 0
        ? safeOffers.reduce((acc, offer) => acc + Number(offer.metrics?.pf || 0), 0) / safeOffers.length
        : 0;
      const avgDd = safeOffers.length > 0
        ? safeOffers.reduce((acc, offer) => acc + Number(offer.metrics?.dd || 0), 0) / safeOffers.length
        : 0;

      return {
        setKey,
        displayName: setKey,
        snapshotKey: setKey,
        isDraft: false,
        offers: safeOffers,
        offerIds,
        offerCount: offerIds.length,
        avgRet,
        avgPf,
        avgDd,
      };
    })
    .filter((item) => item.offerCount > 0),
  [summary?.recommendedSets]);
  const adminCuratedDraftTsSet = useMemo(() => {
    const draftMembers = adminTradingSystemDraft?.members ?? [];
    if (draftMembers.length === 0) {
      return null;
    }

    const draftOffers = reviewableSweepOffers.filter((offer) =>
      draftMembers.some((member) => Number(member.strategyId || 0) === Number(offer.strategyId || 0))
    );

    const offerIds = Array.from(new Set(draftOffers.map((offer) => String(offer.offerId || '')).filter(Boolean)));
    if (offerIds.length === 0) {
      return null;
    }

    const avgRet = draftOffers.length > 0
      ? draftOffers.reduce((acc, offer) => acc + Number(offer.ret || 0), 0) / draftOffers.length
      : 0;
    const avgPf = draftOffers.length > 0
      ? draftOffers.reduce((acc, offer) => acc + Number(offer.pf || 0), 0) / draftOffers.length
      : 0;
    const avgDd = draftOffers.length > 0
      ? draftOffers.reduce((acc, offer) => acc + Number(offer.dd || 0), 0) / draftOffers.length
      : 0;

    return {
      setKey: `draft:${String(adminTradingSystemDraft?.name || 'admin-ts-draft').trim() || 'admin-ts-draft'}`,
      displayName: `CURRENT DRAFT: ${String(adminTradingSystemDraft?.name || 'Admin TS draft').trim() || 'Admin TS draft'}`,
      snapshotKey: '',
      isDraft: true,
      offers: draftOffers,
      offerIds,
      offerCount: offerIds.length,
      avgRet,
      avgPf,
      avgDd,
    };
  }, [adminTradingSystemDraft, reviewableSweepOffers]);
  const adminSweepTsSetsWithCurated = useMemo(
    () => adminCuratedDraftTsSet
      ? [adminCuratedDraftTsSet, ...adminSweepTsSets.filter((item) => item.setKey !== adminCuratedDraftTsSet.setKey)]
      : adminSweepTsSets,
    [adminCuratedDraftTsSet, adminSweepTsSets],
  );
  const adminSweepSetKeysNormalized = useMemo(
    () => new Set(adminSweepTsSetsWithCurated.map((item) => String(item.setKey || '').trim().toLowerCase()).filter(Boolean)),
    [adminSweepTsSetsWithCurated],
  );
  const adminPublishedTsSets = useMemo(() => Array.from(
    new Set([
      selectedAlgofundPublishedSystemName,
      ...publishedAlgofundSystems,
      ...runtimeMasterSystems.map((item) => item.systemName),
    ].map((name) => String(name || '').trim()).filter(Boolean))
  )
    .filter((setName) => !adminSweepSetKeysNormalized.has(setName.toLowerCase()))
    .map((setName) => {
      const runtimeSystem = runtimeMasterSystemByName.get(setName) || null;
      const snapshot = summary?.offerStore?.tsBacktestSnapshots?.[setName] || null;
      const snapshotOfferIds = Array.isArray(snapshot?.offerIds) ? (snapshot?.offerIds || []).map((item: any) => String(item)) : [];
      const offerIds = runtimeSystem?.offerIds?.length ? runtimeSystem.offerIds : snapshotOfferIds;
      const offerCount = runtimeSystem?.memberCount || snapshotOfferIds.length;
      return {
        setKey: setName,
        displayName: setName,
        snapshotKey: setName,
        systemName: setName,
        isDraft: false,
        isPublishedLive: true,
        offers: runtimeSystem?.offers || [],
        offerIds,
        offerCount,
        avgRet: runtimeSystem?.offers?.length ? Number(runtimeSystem.avgRet || 0) : Number(snapshot?.ret || 0),
        avgPf: runtimeSystem?.offers?.length ? Number(runtimeSystem.avgPf || 0) : Number(snapshot?.pf || 0),
        avgDd: runtimeSystem?.offers?.length ? Number(runtimeSystem.avgDd || 0) : Number(snapshot?.dd || 0),
      };
    }),
  [selectedAlgofundPublishedSystemName, publishedAlgofundSystems, runtimeMasterSystems, adminSweepSetKeysNormalized, runtimeMasterSystemByName, summary?.offerStore?.tsBacktestSnapshots]);
  // Add saved snapshots that are NOT already covered by recommendedSets as explicit list entries
  const adminSnapshotOnlyTsSetsDeduped = useMemo(() => {
    const adminSweepSetKeys = new Set(adminSweepTsSets.map((item) => item.setKey));
    const adminSnapshotOnlyTsSets = Object.entries(summary?.offerStore?.tsBacktestSnapshots || {})
      .filter(([key]) => !adminSweepSetKeys.has(key))
      .map(([key, snap]) => ({
        setKey: key,
        displayName: key,
        snapshotKey: key,
        isDraft: false,
        isSnapshot: true,
        offers: [],
        offerIds: Array.isArray(snap.offerIds) ? snap.offerIds.map(String) : [],
        offerCount: Array.isArray(snap.offerIds) ? snap.offerIds.length : 0,
        avgRet: Number(snap.ret || 0),
        avgPf: Number(snap.pf || 0),
        avgDd: Number(snap.dd || 0),
      }));
    const generatedPattern = /^ts_snapshot_\d+$/i;
    const bySignature = new Map<string, typeof adminSnapshotOnlyTsSets>();
    for (const item of adminSnapshotOnlyTsSets) {
      const signature = [...(item.offerIds || [])].map((id) => String(id)).sort().join('|');
      const key = signature || `__set__:${String(item.setKey || '')}`;
      const list = bySignature.get(key) || [];
      list.push(item);
      bySignature.set(key, list);
    }

    const resolved: typeof adminSnapshotOnlyTsSets = [];
    Array.from(bySignature.values()).forEach((variants) => {
      if (variants.length <= 1) {
        resolved.push(variants[0]);
        return;
      }

      // Keep all explicitly named cards even if offer composition is identical.
      // Only collapse autogenerated ts_snapshot_* variants.
      const named = variants.filter((item: typeof variants[number]) => !generatedPattern.test(String(item.setKey || '').trim()));
      if (named.length > 0) {
        resolved.push(...named);
        return;
      }
      resolved.push(variants[variants.length - 1]);
    });
    return resolved;
  }, [adminSweepTsSets, summary?.offerStore?.tsBacktestSnapshots]);
  const adminSweepTsSetsAll = useMemo(() => [
    ...adminSweepTsSetsWithCurated,
    ...adminPublishedTsSets,
    ...adminSnapshotOnlyTsSetsDeduped,
  ], [adminSweepTsSetsWithCurated, adminPublishedTsSets, adminSnapshotOnlyTsSetsDeduped]);
  const adminDraftMemberStrategyIds = useMemo(() => new Set(
    (adminTradingSystemDraft?.members || [])
      .map((member) => Number(member.strategyId || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  ), [adminTradingSystemDraft?.members]);
  const adminDraftTsOfferCandidates = useMemo(
    () => reviewableSweepOffers.filter((offer) => adminDraftMemberStrategyIds.has(Number(offer.strategyId || 0))),
    [reviewableSweepOffers, adminDraftMemberStrategyIds],
  );
  const adminDraftTsOfferIdsAll = useMemo(
    () => adminDraftTsOfferCandidates.map((offer) => String(offer.offerId || '')).filter(Boolean),
    [adminDraftTsOfferCandidates],
  );
  const adminDraftMembersDetailed = useMemo(
    () => (adminTradingSystemDraft?.members || []).map((member) => ({
      ...member,
      reviewRecord: sweepRecordByStrategyId[Number(member.strategyId || 0)] || null,
    })),
    [adminTradingSystemDraft?.members, sweepRecordByStrategyId],
  );
  
  // Use per-set snapshot key if available; fall back to legacy single snapshot for backward compat
  const snapshotKeyForCurrentSet = String(selectedAdminDraftTsSetKey || '').trim();
  const adminSavedTsSnapshot = useMemo(() => snapshotKeyForCurrentSet
    ? (summary?.offerStore?.tsBacktestSnapshots?.[snapshotKeyForCurrentSet] || null)
    : (summary?.offerStore?.tsBacktestSnapshot || null),
  [snapshotKeyForCurrentSet, summary?.offerStore?.tsBacktestSnapshots, summary?.offerStore?.tsBacktestSnapshot]);
  
  const adminDraftPortfolioSummary = useMemo(() => adminSavedTsSnapshot
    ? {
      finalEquity: Number(adminSavedTsSnapshot.finalEquity || 0),
      totalReturnPercent: Number(adminSavedTsSnapshot.ret || 0),
      maxDrawdownPercent: Number(adminSavedTsSnapshot.dd || 0),
      profitFactor: Number(adminSavedTsSnapshot.pf || 0),
      tradesCount: Number(adminSavedTsSnapshot.trades || 0),
    }
    : (summary?.sweepSummary?.portfolioFull?.summary || null),
  [adminSavedTsSnapshot, summary?.sweepSummary?.portfolioFull?.summary]);
  const adminDraftPeriodDays = useMemo(
    () => getPeriodDurationDays(summary?.sweepSummary?.period || null),
    [summary?.sweepSummary?.period],
  );
  const adminDraftTradesPerDay = useMemo(() => adminSavedTsSnapshot
    ? Number(adminSavedTsSnapshot.tradesPerDay || 0)
    : (adminDraftPortfolioSummary && adminDraftPeriodDays && adminDraftPeriodDays > 0
      ? Number((Number(adminDraftPortfolioSummary.tradesCount || 0) / adminDraftPeriodDays).toFixed(2))
      : null),
  [adminSavedTsSnapshot, adminDraftPortfolioSummary, adminDraftPeriodDays]);
  const adminDraftPeriodLabel = useMemo(() => adminSavedTsSnapshot
    ? `snapshot ${formatNumber(Number(adminSavedTsSnapshot.periodDays || 0), 0)}d${adminSavedTsSnapshot.updatedAt ? ` • saved ${formatDateTimeShort(adminSavedTsSnapshot.updatedAt)}` : ''}`
    : (summary?.sweepSummary?.period ? formatPeriodLabel(summary.sweepSummary.period) : '—'),
  [adminSavedTsSnapshot, summary?.sweepSummary?.period]);
  const parseAlgofundPreviewSummary = (raw: any) => {
    const preview = raw?.preview && typeof raw.preview === 'object' ? raw.preview : raw;
    const summary = preview?.summary && typeof preview.summary === 'object' ? preview.summary : null;
    return summary;
  };
  const parseAlgofundPreviewEquity = (raw: any) => {
    const preview = raw?.preview && typeof raw.preview === 'object' ? raw.preview : raw;
    const curve = Array.isArray(preview?.equityCurve) ? preview.equityCurve : [];
    return curve
      .map((point: any, index: number) => ({
        time: Number(point?.time ?? index),
        equity: Number(point?.equity ?? point),
      }))
      .filter((point: any) => Number.isFinite(point.time) && Number.isFinite(point.equity));
  };

  const mapSnapshotEquityPoints = (equityPoints?: number[]) => {
    if (!Array.isArray(equityPoints) || equityPoints.length === 0) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    const dayS = 86400;
    const startSec = nowSec - (equityPoints.length - 1) * dayS;
    return equityPoints
      .map((equity: number, index: number) => ({
        time: startSec + index * dayS,
        equity: Number(equity),
      }))
      .filter((point: { time: number; equity: number }) => Number.isFinite(point.time) && Number.isFinite(point.equity));
  };

  const extractTsSuffixToken = useCallback((systemName: string): string => {
    const parts = String(systemName || '').trim().split('::').filter(Boolean);
    return String(parts[parts.length - 1] || '').trim().toLowerCase();
  }, []);

  const normalizeTsToken = useCallback((systemName: string): string => {
    let token = extractTsSuffixToken(systemName);
    token = token.replace(/^algofund-master-btdd-d1-/, '');
    token = token.replace(/-h-([a-z0-9]{4,})$/i, '-$1');
    return token;
  }, [extractTsSuffixToken]);

  const tsDisplayName = (systemName: string): string => normalizeTsToken(systemName) || systemName;

  const getTsStrategyHint = (systemName: string): string | null => {
    const upper = String(systemName || '').toUpperCase();
    if (upper.includes('_SA_') || upper.includes('STAT_ARB') || upper.includes('STATARB') || upper.includes('-SA-')) {
      return 'StatArb Z-Score — возврат к среднему\nОткрывает позицию когда цена отклоняется на ≥N σ от скользящего среднего пары и ждёт возврата к среднему.\nЛучше работает на синтетических парах в боковом рынке.';
    }
    if (upper.includes('_ZZ_') || upper.includes('ZIGZAG') || upper.includes('-ZZ-') || upper.includes('ZZ_BREAKOUT')) {
      return 'ZigZag Breakout — пробой канала (короткий период)\nЛонг/шорт при пробое N-бар максимума/минимума по Дончиану.\nКороткий период = более частые сделки, ниже удержание.';
    }
    if (upper.includes('_DD_') || upper.includes('BTDD') || upper.includes('DD_BATTLETOADS') || upper.includes('-DD-')) {
      return 'DoubleDragon Breakout — пробой канала Дончиана\nЛонг/шорт при пробое N-бар максимума/минимума.\nТрейлинговый TP от пика позиции. Работает на моно и синтетических парах.';
    }
    if (upper.includes('CLOUD')) {
      return 'Cloud OP2 — облачный мультибиржевой портфель\nАвтоматический подбор пар свипом с проверкой валидности на Bybit/MEXC/WEEX.\nПары, недоступные на вашей бирже, автоматически пропускаются.';
    }
    return null;
  };

  const matchesTsSnapshotToken = useCallback((systemName: string, token: string): boolean => {
    const rawToken = String(token || '').trim().toLowerCase();
    if (!rawToken) {
      return false;
    }
    const normalizedName = normalizeTsToken(systemName);
    const normalizedToken = rawToken.includes('::')
      ? (normalizeTsToken(rawToken) || rawToken)
      : normalizeTsToken(rawToken);
    if (normalizedName === normalizedToken) {
      return true;
    }
    return normalizedName.endsWith(`-${normalizedToken}`) || normalizedName.includes(`${normalizedToken}-`);
  }, [normalizeTsToken]);

  const resolveTsSnapshotForSystem = useCallback((systemName: string) => {
    const snapshotMap = summary?.offerStore?.tsBacktestSnapshots || {};
    const entries = Object.entries(snapshotMap)
      .map(([key, snapshot]) => ({
        key: String(key || '').trim(),
        snapshot,
      }))
      .filter((item) => item.key.length > 0 && item.snapshot);

    if (entries.length === 0) {
      return null;
    }

    const exactKeyMatch = entries.find((item) => String(item.key || '').trim() === systemName);
    if (exactKeyMatch?.snapshot) {
      return exactKeyMatch.snapshot;
    }

    const exactMatch = entries.find((item) => String(item.snapshot?.systemName || '').trim() === systemName);
    if (exactMatch?.snapshot) {
      return exactMatch.snapshot;
    }

    const suffixToken = extractTsSuffixToken(systemName);
    if (!suffixToken || !suffixToken.includes('-')) {
      return null;
    }

    const tokenMatch = entries.find((item) => {
      const setKey = String(item.snapshot?.setKey || '').trim();
      if (setKey && matchesTsSnapshotToken(systemName, setKey)) {
        return true;
      }
      return matchesTsSnapshotToken(systemName, item.key);
    });

    return tokenMatch?.snapshot || null;
  }, [summary?.offerStore?.tsBacktestSnapshots, matchesTsSnapshotToken, extractTsSuffixToken]);

  const masterSnapshotForReportSystem = useMemo(() => {
    const systemName = String(resolvedReportSystemName || '').trim();
    if (!systemName) {
      return null;
    }
    return resolveTsSnapshotForSystem(systemName);
  }, [resolvedReportSystemName, resolveTsSnapshotForSystem]);

  const algofundStorefrontSystems = useMemo(() => {
    // Build storefront from active/relevant TS systems only to avoid mixing stale historical entries.
    const availableSystems = Array.isArray(algofundState?.availableSystems) ? (algofundState?.availableSystems || []) : [];
    const availableSystemByName = new Map(
      availableSystems
        .map((item) => [String(item?.name || '').trim(), item] as const)
        .filter(([name]) => name.length > 0)
    );

    const isStorefrontSnapshotKey = (key: string, snapshot: any): boolean => {
      const safeKey = String(key || '').trim();
      if (!safeKey) {
        return false;
      }
      const lower = safeKey.toLowerCase();
      if (lower.startsWith('offer_')) {
        return false;
      }
      if (/^ts_snapshot_\d+$/i.test(safeKey)) {
        return false;
      }
      if (safeKey.toUpperCase().startsWith('ALGOFUND_MASTER::')) {
        return true;
      }
      if (lower.startsWith('ts-')) {
        return true;
      }
      const systemName = String(snapshot?.systemName || '').trim();
      return systemName.toUpperCase().startsWith('ALGOFUND_MASTER::');
    };

    const rawSnapshotEntries = Object.entries(summary?.offerStore?.tsBacktestSnapshots || {})
      .map(([key, snapshot]) => ({
        key: String(key || '').trim(),
        snapshot,
      }))
      .filter((item) => item.key.length > 0);

    const snapshotEntries = rawSnapshotEntries
      .filter((item) => isStorefrontSnapshotKey(item.key, item.snapshot))
      .filter((item) => {
        const lower = String(item.key || '').trim().toLowerCase();
        if (!lower.endsWith(' copy')) {
          return true;
        }
        const baseKey = String(item.key || '').trim().slice(0, -5).trim();
        if (!baseKey) {
          return true;
        }
        return !rawSnapshotEntries.some((candidate) => String(candidate.key || '').trim() === baseKey);
      });

    const snapshotSystemNames = snapshotEntries
      .map((item) => item.key)
      .filter(Boolean);

    // Only include the snapshot's systemName when the snapshot key itself wouldn't appear
    // on the storefront (avoids duplicate cards for ts-curated-* entries whose key already passes).
    const snapshotMasterSystemNames = snapshotEntries
      .filter((item) => {
        const key = String(item.key || '').trim();
        if (!key) return true;
        const lower = key.toLowerCase();
        // key already qualifies as storefront name → don't duplicate via systemName
        if (key.toUpperCase().startsWith('ALGOFUND_MASTER::') || lower.startsWith('ts-')) return false;
        return true;
      })
      .map((item) => String(item.snapshot?.systemName || '').trim())
      .filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::'));

    const masterSystemNames = Array.from(new Set([
      ...availableSystems
        .map((item) => String(item?.name || '').trim())
        .filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::')),
      ...snapshotSystemNames.filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::')),
      ...snapshotMasterSystemNames,
      String(publishResponse?.sourceSystem?.systemName || '').trim(),
    ].filter((name) => Boolean(name) && String(name).toUpperCase().startsWith('ALGOFUND_MASTER::'))));
    const singleMasterSystemName = masterSystemNames.length === 1 ? masterSystemNames[0] : '';

    const publishedSystemSet = new Set(
      publishedAlgofundSystems
        .map((name) => String(name || '').trim())
        .filter((name) => name.toUpperCase().startsWith('ALGOFUND_MASTER::'))
    );

    const isStorefrontSystemName = (name: string): boolean => {
      const safeName = String(name || '').trim();
      if (!safeName) {
        return false;
      }
      const lower = safeName.toLowerCase();
      if (lower.startsWith('offer_')) {
        return false;
      }
      if (/^ts_snapshot_\d+$/i.test(safeName)) {
        return false;
      }
      return safeName.toUpperCase().startsWith('ALGOFUND_MASTER::') || lower.startsWith('ts-');
    };

    const availableSystemNames = Array.from(new Set([
      ...Array.from(publishedSystemSet),
      ...batchEligibleAlgofundTenants
        .map((item) => String(item.algofundProfile?.published_system_name || '').trim())
        .filter(Boolean),
      ...snapshotSystemNames,
      ...snapshotMasterSystemNames,
      String(publishResponse?.sourceSystem?.systemName || '').trim(),
    ].filter((name) => isStorefrontSystemName(String(name || '')))));

    const mapped = availableSystemNames.map((systemName) => {
    const storefrontLabel = `TS offer #${availableSystemNames.indexOf(systemName) + 1}`;
    const tenants = batchEligibleAlgofundTenants.filter((tenant) => {
      const tenantSystemName = String(tenant.algofundProfile?.published_system_name || '').trim();
      if (!tenantSystemName) {
        return false;
      }
      if (tenantSystemName === systemName) {
        return true;
      }
      // Runtime per-tenant systems (ALGOFUND::<tenant>) should still be attached to
      // the single active master storefront card when one master exists.
      if (
        singleMasterSystemName
        && systemName === singleMasterSystemName
        && tenantSystemName.toUpperCase().startsWith('ALGOFUND::')
      ) {
        return true;
      }
      return false;
    });
    const snapshotForSystem = resolveTsSnapshotForSystem(systemName);
    const runtimeSystem = availableSystemByName.get(systemName);
    const runtimeSystemId = publishResponse?.sourceSystem?.systemName === systemName
      ? Number(publishResponse.sourceSystem.systemId || 0)
      : runtimeSystem?.id || null;
    const publishSummary = publishResponse?.sourceSystem?.systemName === systemName
      ? publishResponse?.preview?.summary || null
      : null;
    const publishEquityCurve = publishResponse?.sourceSystem?.systemName === systemName
      ? parseAlgofundPreviewEquity(publishResponse?.preview || null)
      : [];
    const tenantSummaries = tenants
      .map((tenant) => parseAlgofundPreviewSummary(tenant.algofundProfile?.latestPreview || null))
      .filter((summary) => summary && typeof summary === 'object');
    const tenantCurves = tenants
      .map((tenant) => parseAlgofundPreviewEquity(tenant.algofundProfile?.latestPreview || null))
      .filter((curve) => Array.isArray(curve) && curve.length > 1);
    const fallbackSummary = tenantSummaries[0] || null;
    const snapshotSummary = snapshotForSystem
      ? {
        totalReturnPercent: Number(snapshotForSystem.ret || 0),
        maxDrawdownPercent: Number(snapshotForSystem.dd || 0),
        profitFactor: Number(snapshotForSystem.pf || 0),
        tradesCount: Number(snapshotForSystem.trades || 0),
      }
      : null;
    const snapshotCurve = mapSnapshotEquityPoints(downsampleNumericSeries(Array.isArray(snapshotForSystem?.equityPoints) ? (snapshotForSystem?.equityPoints || []) : [], 64));

    const activeSetKey = String(selectedAdminDraftTsSetKey || '').trim();
    const latestBacktestMatchesSystem = activeSetKey
      ? matchesTsSnapshotToken(systemName, activeSetKey)
      : true;
    // Also use latest backtest result summary for the matching TS when available
    const latestBacktestSummary = (latestBacktestMatchesSystem
      && adminSweepBacktestResult?.kind === 'algofund-ts' && adminSweepBacktestResult?.preview?.summary
      && backtestDrawerContext?.kind === 'algofund-ts')
      ? adminSweepBacktestResult.preview.summary
      : null;
    const latestBacktestCurve = (latestBacktestMatchesSystem
      && adminSweepBacktestResult?.kind === 'algofund-ts' && backtestDrawerContext?.kind === 'algofund-ts')
      ? parseAlgofundPreviewEquity(adminSweepBacktestResult?.preview || null)
      : [];
    const safeLatestBacktestSummary = snapshotForSystem ? latestBacktestSummary : null;
    const safeLatestBacktestCurve = snapshotForSystem ? latestBacktestCurve : [];

    const snapshotSystemName = String(snapshotForSystem?.systemName || '').trim();
    const isStorefrontEnabled = publishedSystemSet.has(systemName) || (snapshotSystemName ? publishedSystemSet.has(snapshotSystemName) : false);
    const hasMeaningfulState = isStorefrontEnabled || tenants.length > 0 || Boolean(snapshotForSystem);

    return {
      systemName,
      storefrontLabel,
      isArchived: systemName.toUpperCase().startsWith('ARCHIVED::'),
      hasMeaningfulState,
      hasSnapshot: Boolean(snapshotForSystem),
      hasPublishSummary: Boolean(publishSummary),
      hasSnapshotCurve: snapshotCurve.length > 1,
      hasAnyCurve: snapshotCurve.length > 1 || publishEquityCurve.length > 1 || (tenantCurves[0] || safeLatestBacktestCurve).length > 1,
      runtimeSystemId,
      summary: snapshotSummary || publishSummary || fallbackSummary || safeLatestBacktestSummary || null,
      equityCurve: snapshotCurve.length > 1
        ? snapshotCurve
        : (publishEquityCurve.length > 1
          ? publishEquityCurve.slice(-64)
          : ((tenantCurves[0] || safeLatestBacktestCurve).slice(-64))),
      tenants,
      tenantCount: tenants.length,
      activeCount: tenants.filter((tenant) => Number(tenant.algofundProfile?.actual_enabled || 0) === 1).length,
      pendingCount: tenants.filter((tenant) => Number(tenant.algofundProfile?.requested_enabled || 0) === 1 && Number(tenant.algofundProfile?.actual_enabled || 0) !== 1).length,
    };
    }).filter((item) => item.hasMeaningfulState && (!item.isArchived || item.tenantCount > 0));

    // Keep separate storefront cards even when names are visually similar.
    // Merge only strict duplicates with the exact same runtime name.
    const dedupedBySystemName = new Map<string, typeof mapped[number]>();
    for (const item of mapped) {
      const key = String(item.systemName || '').trim().toLowerCase();
      const existing = dedupedBySystemName.get(key);
      if (!existing) {
        dedupedBySystemName.set(key, item);
        continue;
      }

      const mergedTenants = Array.from(new Map(
        [...(existing.tenants || []), ...(item.tenants || [])]
          .map((tenant) => [Number(tenant?.tenant?.id || 0), tenant] as const)
      ).values()).filter((tenant) => Number(tenant?.tenant?.id || 0) > 0);

      dedupedBySystemName.set(key, {
        ...existing,
        summary: existing.summary || item.summary,
        equityCurve: (existing.equityCurve?.length || 0) >= (item.equityCurve?.length || 0)
          ? existing.equityCurve
          : item.equityCurve,
        tenants: mergedTenants,
        tenantCount: Math.max(Number(existing.tenantCount || 0), Number(item.tenantCount || 0)),
        activeCount: Math.max(Number(existing.activeCount || 0), Number(item.activeCount || 0)),
        pendingCount: Math.max(Number(existing.pendingCount || 0), Number(item.pendingCount || 0)),
      });
    }

    return Array.from(dedupedBySystemName.values())
      .sort((left, right) => {
        const leftScore = (left.hasSnapshot ? 2 : 0) + (left.runtimeSystemId ? 1 : 0) + Number(left.tenantCount || 0);
        const rightScore = (right.hasSnapshot ? 2 : 0) + (right.runtimeSystemId ? 1 : 0) + Number(right.tenantCount || 0);
        return rightScore - leftScore;
      });
  }, [algofundState?.availableSystems, summary?.offerStore?.tsBacktestSnapshots, batchEligibleAlgofundTenants, publishResponse, adminSweepBacktestResult, backtestDrawerContext, selectedAdminDraftTsSetKey, matchesTsSnapshotToken, resolveTsSnapshotForSystem, publishedAlgofundSystems, normalizeTsToken]);
  const offerTitleById = useMemo(() => offerStoreOffers.reduce<Record<string, string>>((acc, offer) => {
    acc[String(offer.offerId)] = String(offer.titleRu || offer.offerId);
    return acc;
  }, {}), [offerStoreOffers]);
  const normalizeBacktestTsWeights = (offerIds: string[], source: Record<string, number>) => {
    const ids = Array.from(new Set((offerIds || []).map((item) => String(item || '').trim()).filter(Boolean)));
    if (ids.length === 0) {
      return {} as Record<string, number>;
    }

    const next: Record<string, number> = {};
    let total = 0;
    ids.forEach((id) => {
      const raw = Number(source[id]);
      const safe = Number.isFinite(raw) && raw > 0 ? raw : 1;
      next[id] = safe;
      total += safe;
    });
    const safeTotal = total > 0 ? total : ids.length;
    ids.forEach((id) => {
      next[id] = Number((next[id] / safeTotal).toFixed(4));
    });
    return next;
  };
  const storefrontOfferOptions = useMemo(() => offerStoreOffers.map((offer) => ({
    label: `${String(offer.titleRu || offer.offerId)} (${String(offer.mode || '').toUpperCase()} ${String(offer.market || '').trim()})`,
    value: String(offer.offerId || '').trim(),
  })).filter((item) => item.value.length > 0), [offerStoreOffers]);
  const clientsOfferFilterOptions = useMemo(() => offerStoreOffers.map((offer) => ({
    value: String(offer.offerId),
    label: `${offer.titleRu} (${String(offer.mode || '').toUpperCase()} ${offer.market})`,
  })), [offerStoreOffers]);
  const clientsTsFilterOptions = useMemo(() => Array.from(
    new Set(
      (summary?.tenants || [])
        .filter((item) => item.tenant.product_mode === 'algofund_client')
        .map((item) => String(item.algofundProfile?.published_system_name || '').trim())
        .filter((item) => item.length > 0)
    )
  ).map((name) => ({ value: name, label: name })), [summary?.tenants]);

  const filteredClients = useMemo(() => (summary?.tenants || []).filter((tenantSummary) => {
    if (clientsModeFilter !== 'all' && tenantSummary.tenant.product_mode !== clientsModeFilter) {
      return false;
    }
    if (clientsClassKind === 'all' || !clientsClassValue) {
      return true;
    }
    if (clientsClassKind === 'offer') {
      if (tenantSummary.tenant.product_mode !== 'strategy_client') {
        return false;
      }
      const selected = Array.isArray(tenantSummary.strategyProfile?.selectedOfferIds)
        ? tenantSummary.strategyProfile?.selectedOfferIds || []
        : [];
      return selected.includes(clientsClassValue);
    }
    if (clientsClassKind === 'ts') {
      if (tenantSummary.tenant.product_mode !== 'algofund_client') {
        return false;
      }
      return String(tenantSummary.algofundProfile?.published_system_name || '') === clientsClassValue;
    }
    return true;
  }), [summary?.tenants, clientsModeFilter, clientsClassKind, clientsClassValue]);
  const resolveSummaryScope = (): SummaryScope => {
    if (activeTab === 'admin' && adminTab === 'offer-ts') {
      return 'full';
    }
    return 'light';
  };

  const loadSummary = async (scope: SummaryScope = resolveSummaryScope()): Promise<SaasSummary | null> => {
    const requestSeq = summaryRequestSeqRef.current + 1;
    summaryRequestSeqRef.current = requestSeq;
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const response = await axios.get<SaasSummary>('/api/saas/admin/summary', {
        params: { scope },
      });
      if (requestSeq === summaryRequestSeqRef.current) {
        setSummary((prev) => {
          if (scope === 'light' && prev?.offerStore && !response.data.offerStore) {
            return {
              ...response.data,
              offerStore: prev.offerStore,
            };
          }
          return response.data;
        });
      }
      return response.data;
    } catch (error: any) {
      if (requestSeq === summaryRequestSeqRef.current) {
        setSummaryError(String(error?.response?.data?.error || error?.message || 'Failed to load SaaS summary'));
      }
      return null;
    } finally {
      if (requestSeq === summaryRequestSeqRef.current) {
        setSummaryLoading(false);
      }
    }
  };

  const loadSweepReviewCandidates = async () => {
    setActionLoading('load-sweep-review');
    try {
      const nextSummary = await loadSummary('full');
      setSelectedAdminReviewKind('offer');
      const shortlistCount = Array.isArray(nextSummary?.sweepSummary?.selectedMembers) ? nextSummary?.sweepSummary?.selectedMembers.length : 0;
      const draftMembersCount = Array.isArray(nextSummary?.catalog?.adminTradingSystemDraft?.members)
        ? nextSummary?.catalog?.adminTradingSystemDraft?.members.length
        : 0;
      messageApi.success(`Загружено из sweep: shortlist ${shortlistCount}, draft TS members ${draftMembersCount}`);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load shortlisted sweep candidates'));
    } finally {
      setActionLoading('');
    }
  };

  const toggleOfferPublished = async (offerId: string, published: boolean) => {
    const current = summary?.offerStore;
    if (!current) {
      return;
    }
    const set = new Set((current.publishedOfferIds || []).map((item) => String(item)));
    if (published) {
      set.add(String(offerId));
    } else {
      set.delete(String(offerId));
    }
    setActionLoading(`offer-store:${offerId}`);
    try {
      await axios.patch('/api/saas/admin/offer-store', {
        publishedOfferIds: Array.from(set),
      });
      await loadSummary();
      messageApi.success(published ? 'Offer published to store' : 'Offer unpublished from store');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to update offer visibility'));
    } finally {
      setActionLoading('');
    }
  };

  const deleteOfferFromStorefrontDb = async (offerId: string) => {
    const normalizedOfferId = String(offerId || '').trim();
    const current = summary?.offerStore;
    if (!normalizedOfferId || !current) {
      return;
    }

    const confirmed = window.confirm('Удалить оффер из витрины и админ-снимков?');
    if (!confirmed) {
      return;
    }

    const nextPublished = new Set((current.publishedOfferIds || []).map((item) => String(item)));
    nextPublished.delete(normalizedOfferId);

    setActionLoading(`offer-delete:${normalizedOfferId}`);
    try {
      await axios.patch('/api/saas/admin/offer-store', {
        publishedOfferIds: Array.from(nextPublished),
        reviewSnapshotPatch: {
          [normalizedOfferId]: null,
        },
      });
      await loadSummary('full');
      messageApi.success('Оффер удален из витрины и снимков');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось удалить оффер'));
    } finally {
      setActionLoading('');
    }
  };

  const openUnpublishWizard = async (offerId: string) => {
    setUnpublishTargetOfferId(String(offerId || ''));
    setUnpublishAcknowledge(false);
    setUnpublishWizardVisible(true);
    setUnpublishImpactLoading(true);
    try {
      const response = await axios.get<{ success: boolean } & OfferUnpublishImpact>(`/api/saas/admin/offer-store/unpublish-impact/${encodeURIComponent(String(offerId || ''))}`);
      setUnpublishImpact(response.data);
    } catch (error: any) {
      setUnpublishImpact(null);
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to analyze unpublish impact'));
    } finally {
      setUnpublishImpactLoading(false);
    }
  };

  const closeUnpublishWizard = () => {
    setUnpublishWizardVisible(false);
    setUnpublishImpact(null);
    setUnpublishTargetOfferId('');
    setUnpublishAcknowledge(false);
  };

  const confirmUnpublishOffer = async () => {
    if (!unpublishTargetOfferId) {
      return;
    }
    await toggleOfferPublished(unpublishTargetOfferId, false);
    closeUnpublishWizard();
  };

  const updateOfferStoreDefaults = async (patch: Partial<{ periodDays: number; targetTradesPerDay: number; riskLevel: Level3 }>) => {
    setActionLoading('offer-store-defaults');
    try {
      await axios.patch('/api/saas/admin/offer-store', {
        defaults: {
          ...(summary?.offerStore?.defaults || {}),
          ...patch,
        },
      });
      await loadSummary();
      messageApi.success('Store defaults updated');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to update store defaults'));
    } finally {
      setActionLoading('');
    }
  };

  const updateReportSettings = async (patch: Partial<NonNullable<SaasSummary['reportSettings']>>) => {
    const keys = Object.keys(patch || {});
    const loadingKey = keys.length === 1 ? `report-setting:${String(keys[0])}` : 'report-setting:batch';
    setActionLoading(loadingKey);
    try {
      await axios.patch('/api/saas/admin/reports/settings', patch || {});
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to update report settings'));
    } finally {
      setActionLoading('');
    }
  };

  const toggleReportSetting = async (key: keyof NonNullable<SaasSummary['reportSettings']>, value: boolean) => {
    await updateReportSettings({ [key]: value } as Partial<NonNullable<SaasSummary['reportSettings']>>);
  };

  const runSnapshotRefreshNow = async () => {
    setActionLoading('snapshot-refresh');
    try {
      await axios.post('/api/saas/admin/snapshots/refresh', { force: true, reason: 'admin_manual' });
      await loadSummary('full');
      messageApi.success('Snapshot карточек обновлены');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось обновить snapshot карточек'));
    } finally {
      setActionLoading('');
    }
  };

  const sendReportToTelegram = async () => {
    setSendTelegramLoading(true);
    try {
      await axios.post('/api/saas/admin/reports/send-telegram');
      messageApi.success('Отчёт отправлен в Telegram');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to send Telegram report'));
    } finally {
      setSendTelegramLoading(false);
    }
  };

  const loadPerformanceReport = async (period: 'daily' | 'weekly' | 'monthly' = reportPeriod) => {
    setPerformanceReportLoading(true);
    try {
      const response = await axios.get<AdminPerformanceReport>('/api/saas/admin/reports/performance', {
        params: { period },
      });
      setPerformanceReport(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load performance report'));
    } finally {
      setPerformanceReportLoading(false);
    }
  };

  const loadTsHealthReport = async () => {
    const targetSystemName = String(resolvedReportSystemName || '').trim();
    if (!targetSystemName) {
      messageApi.warning('Сначала выберите Algofund TS');
      return;
    }
    setTsHealthLoading(true);
    try {
      const response = await axios.get<AdminTsHealthReport>('/api/saas/admin/reports/ts-health', {
        params: {
          systemName: targetSystemName,
          lookbackHours: reportLookbackHours,
        },
      });
      setTsHealthReport(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load TS health report'));
    } finally {
      setTsHealthLoading(false);
    }
  };

  const loadClosedPositionsReport = async () => {
    const targetSystemName = String(resolvedReportSystemName || '').trim();
    if (!targetSystemName) {
      messageApi.warning('Сначала выберите Algofund TS');
      return;
    }
    setClosedPositionsLoading(true);
    try {
      const response = await axios.get<AdminClosedPositionsReport>('/api/saas/admin/reports/closed-positions', {
        params: {
          systemName: targetSystemName,
          periodHours: reportPeriodHours,
          limit: 40,
        },
      });
      setClosedPositionsReport(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load closed positions report'));
    } finally {
      setClosedPositionsLoading(false);
    }
  };

  const loadChartSnapshotReport = async () => {
    const targetSystemName = String(resolvedReportSystemName || '').trim();
    if (!targetSystemName) {
      messageApi.warning('Сначала выберите Algofund TS');
      return;
    }
    setChartSnapshotLoading(true);
    try {
      const response = await axios.post<AdminChartSnapshotReport>('/api/saas/admin/reports/chart-snapshot', {
        systemName: targetSystemName,
        candles: 180,
        width: 1280,
        height: 640,
        interval: '1h',
      });
      setChartSnapshotReport(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load chart snapshot'));
    } finally {
      setChartSnapshotLoading(false);
    }
  };

  const loadRuntimeWindowBacktests = async () => {
    const targetSystemName = String(resolvedReportSystemName || '').trim();
    if (!targetSystemName) {
      messageApi.warning('Сначала выберите Algofund TS');
      return;
    }
    setRuntimeWindowBacktestsLoading(true);
    try {
      const now = new Date();
      const windows = [
        { key: '1d', days: 1 },
        { key: '7d', days: 7 },
        { key: '30d', days: 30 },
      ];

      const results = await Promise.all(
        windows.map(async (window) => {
          const dateTo = now.toISOString();
          const dateFromDate = new Date(now.getTime() - window.days * 24 * 60 * 60 * 1000);
          const dateFrom = dateFromDate.toISOString();
          const response = await axios.post<AdminSweepBacktestPreviewResponse>('/api/saas/admin/sweep-backtest-preview', {
            source: 'runtime_system',
            kind: 'algofund-ts',
            systemName: targetSystemName,
            preferRealBacktest: true,
            dateFrom,
            dateTo,
            initialBalance: adminSweepBacktestInitialBalance,
            riskScore: adminSweepBacktestRiskScore,
            tradeFrequencyScore: adminSweepBacktestTradeScore,
            riskScaleMaxPercent: adminSweepBacktestRiskScaleMaxPercent,
            maxOpenPositions: adminSweepBacktestMaxOpenPositions > 0 ? adminSweepBacktestMaxOpenPositions : undefined,
          });
          return [window.key, response.data] as const;
        })
      );

      setRuntimeWindowBacktests(Object.fromEntries(results));
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load runtime backtests'));
    } finally {
      setRuntimeWindowBacktestsLoading(false);
    }
  };

  const loadStrategyTenant = async (tenantId: number) => {
    setStrategyLoading(true);
    setStrategyError('');
    try {
      const response = await axios.get<StrategyClientState>(`/api/saas/strategy-clients/${tenantId}`);
      setStrategyState(response.data);
    } catch (error: any) {
      setStrategyError(String(error?.response?.data?.error || error?.message || 'Failed to load strategy client'));
      setStrategyState(null);
    } finally {
      setStrategyLoading(false);
    }
  };

  const loadAlgofundActiveSystems = async (tenantId: number) => {
    setAlgofundActiveSystemsLoading(true);
    try {
      const response = await axios.get<{ success: boolean; systems: typeof algofundActiveSystems }>(`/api/saas/algofund/${tenantId}/active-systems`);
      setAlgofundActiveSystems(response.data.systems || []);
    } catch {
      // non-critical, ignore
    } finally {
      setAlgofundActiveSystemsLoading(false);
    }
  };

  const loadAlgofundTenant = async (tenantId: number, nextRiskMultiplier?: number, allowPreviewAbovePlan = false, forceRefreshPreview = false) => {
    const requestSeq = algofundRequestSeqRef.current + 1;
    algofundRequestSeqRef.current = requestSeq;
    setAlgofundLoading(true);
    setAlgofundError('');
    try {
      const params = new URLSearchParams();
      if (nextRiskMultiplier !== undefined) {
        params.set('riskMultiplier', String(nextRiskMultiplier));
      }
      if (allowPreviewAbovePlan) {
        params.set('allowPreviewAbovePlan', '1');
      }
      if (forceRefreshPreview) {
        params.set('refreshPreview', '1');
      }
      const query = params.toString() ? `?${params.toString()}` : '';
      const response = await axios.get<AlgofundState>(`/api/saas/algofund/${tenantId}${query}`);
      if (requestSeq === algofundRequestSeqRef.current) {
        setAlgofundState(response.data);
      }
    } catch (error: any) {
      if (requestSeq === algofundRequestSeqRef.current) {
        setAlgofundError(String(error?.response?.data?.error || error?.message || 'Failed to load algofund client'));
        setAlgofundState(null);
      }
    } finally {
      if (requestSeq === algofundRequestSeqRef.current) {
        setAlgofundLoading(false);
      }
    }
  };

  const loadCopytradingTenant = async (tenantId: number) => {
    const requestSeq = copytradingRequestSeqRef.current + 1;
    copytradingRequestSeqRef.current = requestSeq;
    setCopytradingLoading(true);
    setCopytradingError('');
    setCopytradingUiStatus('idle');
    setCopytradingUiMessage('Загрузка состояния copytrading...');
    try {
      const response = await axios.get<Record<string, any>>(`/api/saas/copytrading/${tenantId}`);
      if (requestSeq === copytradingRequestSeqRef.current) {
        const data = response.data as any;
        const enabled = Boolean(data?.profile?.copy_enabled);
        const followers = Array.isArray(data?.profile?.tenants) ? data.profile.tenants.slice(0, 5) : [];
        setCopytradingState(data);
        setCopytradingMasterApiKeyName(String(data?.profile?.master_api_key_name || data?.tenant?.assigned_api_key_name || ''));
        setCopytradingMasterName(String(data?.profile?.master_name || ''));
        setCopytradingMasterTags(String(data?.profile?.master_tags || 'copytrading-master'));
        setCopytradingCopyRatio(Number(data?.profile?.copy_ratio ?? 1) || 1);
        setCopytradingCopyEnabled(enabled);
        setCopytradingFollowers(followers);
        setCopytradingTenantDisplayName(String(data?.tenant?.display_name || ''));
        setCopytradingTenantStatus(String(data?.tenant?.status || 'active'));
        setCopytradingTenantPlanCode(String(data?.plan?.code || ''));
        setCopytradingUiStatus(enabled ? 'copying' : 'stopped');
        setCopytradingUiMessage(enabled ? 'Копирование активно' : 'Копирование остановлено');
        appendCopytradingLog(`Tenant #${tenantId}: состояние загружено, copy_enabled=${enabled ? 1 : 0}`);
      }
    } catch (error: any) {
      if (requestSeq === copytradingRequestSeqRef.current) {
        const message = String(error?.response?.data?.error || error?.message || 'Failed to load copytrading client');
        setCopytradingError(message);
        setCopytradingState(null);
        setCopytradingUiStatus('error');
        setCopytradingUiMessage(`Ошибка загрузки: ${message}`);
        appendCopytradingLog(`Tenant #${tenantId}: ошибка загрузки (${message})`);
      }
    } finally {
      if (requestSeq === copytradingRequestSeqRef.current) {
        setCopytradingLoading(false);
      }
    }
  };

  const createCopytradingTenantQuick = async () => {
    setActionLoading('create-copytrading-tenant');
    try {
      const defaultApiKey = String((summary?.apiKeys || [])[0] || '');
      await axios.post('/api/saas/admin/tenants', {
        displayName: `Copytrading Client ${(copytradingTenants.length || 0) + 1}`,
        productMode: 'copytrading_client',
        planCode: 'copytrading_100',
        assignedApiKeyName: defaultApiKey || undefined,
        language,
      });
      const nextSummary = await loadSummary('full');
      const firstCopyTenantId = Number((nextSummary?.tenants || []).find((item) => item.tenant.product_mode === 'copytrading_client')?.tenant.id || 0);
      if (firstCopyTenantId > 0) {
        setCopytradingTenantId(firstCopyTenantId);
      }
      messageApi.success('Copytrading client created');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create copytrading tenant'));
    } finally {
      setActionLoading('');
    }
  };

  const createCopytradingApiKeyInline = async () => {
    const name = String(copyKeyDraftName || '').trim();
    if (!name) {
      messageApi.warning('Укажите имя API key');
      return;
    }
    if (!String(copyKeyDraftApiKey || '').trim() || !String(copyKeyDraftSecret || '').trim()) {
      messageApi.warning('Укажите API key и Secret');
      return;
    }
    if (['bitget', 'weex'].includes(String(copyKeyDraftExchange || '').trim().toLowerCase()) && !String(copyKeyDraftPassphrase || '').trim()) {
      messageApi.warning('Для Bitget и WEEX укажите passphrase');
      return;
    }

    setActionLoading('copytrading-create-key');
    try {
      await axios.post('/api/api-keys', {
        name,
        exchange: String(copyKeyDraftExchange || 'binance').trim().toLowerCase(),
        api_key: String(copyKeyDraftApiKey || '').trim(),
        secret: String(copyKeyDraftSecret || '').trim(),
        passphrase: String(copyKeyDraftPassphrase || '').trim(),
        speed_limit: 10,
        testnet: copyKeyDraftTestnet,
        demo: copyKeyDraftDemo,
      });
      await loadSummary('light');

      if (copyKeyDraftRole === 'master') {
        setCopytradingMasterApiKeyName(name);
      } else {
        setCopyFollowerApiKeyName(name);
      }

      appendCopytradingLog(`Создан API key ${name} (${copyKeyDraftRole === 'master' ? 'master' : 'tenant'})`);
      setCopyKeyDraftName('');
      setCopyKeyDraftApiKey('');
      setCopyKeyDraftSecret('');
      setCopyKeyDraftPassphrase('');
      messageApi.success('API key сохранен');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create API key'));
    } finally {
      setActionLoading('');
    }
  };

  const addCopytradingFollower = () => {
    if (!copyFollowerApiKeyName) {
      messageApi.warning('Выберите API key для follower');
      return;
    }
    if ((copytradingFollowers || []).length >= 5) {
      messageApi.warning('Допускается максимум 5 copytrading-tenant');
      return;
    }

    const displayName = String(copyFollowerTenantName || '').trim() || `Copy Tenant ${(copytradingFollowers.length || 0) + 1}`;
    const slug = String(copyFollowerTenantSlug || '').trim()
      || displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      || `copy-tenant-${Date.now()}`;

    const next = {
      tenantId: Number(Date.now()),
      displayName,
      slug,
      apiKeyName: copyFollowerApiKeyName,
      tags: String(copyFollowerTags || 'copytrading-tenant').trim() || 'copytrading-tenant',
    };

    setCopytradingFollowers((current) => [...(current || []), next].slice(0, 5));
    setCopyFollowerTenantName('');
    setCopyFollowerTenantSlug('');
    setCopyFollowerApiKeyName('');
    appendCopytradingLog(`Добавлен follower tenant ${displayName}`);
  };

  const removeCopytradingFollower = (index: number) => {
    setCopytradingFollowers((current) => (current || []).filter((_, idx) => idx !== index));
  };

  // ─── Synctrade functions ─────────────────────────────────────────────────
  const loadSynctradeTenant = async (tenantId: number) => {
    setSynctradeLoading(true);
    setSynctradeError('');
    try {
      const response = await axios.get<Record<string, any>>(`/api/saas/synctrade/${tenantId}`);
      const data = response.data as any;
      setSynctradeState(data);
      setSynctradeMasterApiKeyName(String(data?.profile?.master_api_key_name || ''));
      setSynctradeMasterDisplayName(String(data?.profile?.master_display_name || ''));
      setSynctradeSymbol(String(data?.profile?.symbol || 'BTCUSDT'));
      setSynctradeTargetProfit(Number(data?.profile?.target_value ?? data?.profile?.target_profit_percent ?? 50));
      setSynctradeTargetMode(data?.profile?.target_mode === 'usdt' ? 'usdt' : 'percent');
      setSynctradeIntervalMs(Number(data?.profile?.interval_ms ?? 500));
      setSynctradeEnabled(Boolean(data?.profile?.enabled));
      setSynctradeHedgeAccounts(Array.isArray(data?.profile?.hedgeAccounts) ? data.profile.hedgeAccounts : []);
      setSynctradeSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      // Also fetch auto-engine status
      try { const autoRes = await axios.get('/api/saas/synctrade/auto/status'); setSyncAutoStatus(autoRes.data); } catch { /* ignore */ }
    } catch (error: any) {
      setSynctradeError(String(error?.response?.data?.error || error?.message || 'Failed to load synctrade state'));
      setSynctradeState(null);
    } finally {
      setSynctradeLoading(false);
    }
  };

  const saveSynctradeSettings = async () => {
    if (!synctradeTenantId) return;
    setSynctradeLoading(true);
    try {
      await axios.patch(`/api/saas/synctrade/${synctradeTenantId}`, {
        masterApiKeyName: synctradeMasterApiKeyName,
        masterDisplayName: synctradeMasterDisplayName,
        symbol: synctradeSymbol,
        hedgeAccounts: synctradeHedgeAccounts,
        targetProfitPercent: synctradeTargetProfit,
        targetMode: synctradeTargetMode,
        targetValue: synctradeTargetProfit,
        intervalMs: synctradeIntervalMs,
        enabled: synctradeEnabled,
      });
      await loadSynctradeTenant(synctradeTenantId);
      messageApi.success('Synctrade settings saved');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save'));
    } finally {
      setSynctradeLoading(false);
    }
  };

  const syncCopytradingSession = async () => {
    if (!copytradingTenantId) return;
    setCopytradingSyncing(true);
    try {
      const result = await axios.post(`/api/saas/copytrading/${copytradingTenantId}/execute`, {
        marketType: copytradingSyncMarketType,
      });
      const s = result.data?.summary;
      const msg = s
        ? `Sync done: master=${s.masterPositions}, opened=${s.newPositions}, closed=${s.closedPositions}, followers ${s.followersOk}/${s.followersTotal}`
        : 'Sync complete';
      messageApi.success(msg);
      await loadCopytradingTenant(copytradingTenantId);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Sync failed'));
    } finally {
      setCopytradingSyncing(false);
    }
  };

  const stopCopytradingAndReset = async () => {
    if (!copytradingTenantId) return;
    setCopytradingLoading(true);
    try {
      await axios.post(`/api/saas/copytrading/${copytradingTenantId}/stop`);
      setCopytradingCopyEnabled(false);
      setCopytradingUiStatus('stopped');
      setCopytradingUiMessage('Копирование остановлено, базовые позиции сброшены');
      appendCopytradingLog(`Tenant #${copytradingTenantId}: стоп + сброс базовых позиций`);
      await loadCopytradingTenant(copytradingTenantId);
      messageApi.success('Копирование остановлено');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Stop failed'));
    } finally {
      setCopytradingLoading(false);
    }
  };

  const executeSynctradeSession = async () => {
    if (!synctradeTenantId) return;
    setSynctradeExecuting(true);
    try {
      const result = await axios.post(`/api/saas/synctrade/${synctradeTenantId}/execute`, {
        symbol: synctradeSymbol,
        masterSide: synctradeExecSide,
        leverageMaster: synctradeExecLeverage,
        leverageHedge: synctradeExecLeverage,
        lotPercent: synctradeExecLotPercent,
      });
      messageApi.success(`Session #${result.data?.sessionId} opened`);
      await loadSynctradeTenant(synctradeTenantId);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to execute'));
    } finally {
      setSynctradeExecuting(false);
    }
  };

  const closeSynctradeSessionById = async (sessionId: number) => {
    if (!synctradeTenantId) return;
    setSynctradeExecuting(true);
    try {
      const result = await axios.post(`/api/saas/synctrade/${synctradeTenantId}/close/${sessionId}`);
      messageApi.success(`Session #${sessionId} closed, PnL: ${Number(result.data?.totalPnl || 0).toFixed(2)} USDT`);
      await loadSynctradeTenant(synctradeTenantId);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to close session'));
    } finally {
      setSynctradeExecuting(false);
    }
  };

  // SyncAuto handlers
  const fetchSyncAutoStatus = async () => {
    try {
      const res = await axios.get('/api/saas/synctrade/auto/status');
      setSyncAutoStatus(res.data);
    } catch { /* ignore */ }
  };

  const startSyncAuto = async () => {
    if (!synctradeTenantId) return;
    setSyncAutoLoading(true);
    try {
      await axios.post(`/api/saas/synctrade/${synctradeTenantId}/auto/start`, {
        maxPairs: syncAutoMaxPairs,
        leverageRange: [syncAutoLevMin, syncAutoLevMax],
        lotPercent: syncAutoLotPercent,
      });
      messageApi.success('SyncAuto запущен');
      await fetchSyncAutoStatus();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Ошибка запуска'));
    } finally {
      setSyncAutoLoading(false);
    }
  };

  const stopSyncAuto = async (closeAll: boolean) => {
    setSyncAutoLoading(true);
    try {
      const res = await axios.post(`/api/saas/synctrade/${synctradeTenantId}/auto/stop`, { closeAll });
      messageApi.success(`SyncAuto остановлен. Открыто: ${res.data?.totalOpened}, Закрыто: ${res.data?.totalClosed}`);
      setSyncAutoStatus(null);
      if (synctradeTenantId) await loadSynctradeTenant(synctradeTenantId);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Ошибка остановки'));
    } finally {
      setSyncAutoLoading(false);
    }
  };

  const addSynctradeHedgeAccount = () => {
    if (!synctradeNewHedgeApiKey) {
      messageApi.warning('Выберите API key для hedge-аккаунта');
      return;
    }
    if (synctradeHedgeAccounts.length >= 5) {
      messageApi.warning('Максимум 5 hedge-аккаунтов');
      return;
    }
    const displayName = String(synctradeNewHedgeName || '').trim() || `Hedge ${synctradeHedgeAccounts.length + 1}`;
    setSynctradeHedgeAccounts([...synctradeHedgeAccounts, {
      apiKeyName: synctradeNewHedgeApiKey,
      displayName,
      maxSpendUsdt: synctradeNewHedgeMaxSpend > 0 ? synctradeNewHedgeMaxSpend : 0,
      targetLossUsdt: synctradeNewHedgeTargetLoss > 0 ? synctradeNewHedgeTargetLoss : 0,
    }]);
    setSynctradeNewHedgeName('');
    setSynctradeNewHedgeApiKey('');
    setSynctradeNewHedgeMaxSpend(0);
    setSynctradeNewHedgeTargetLoss(0);
  };

  const removeSynctradeHedgeAccount = (index: number) => {
    setSynctradeHedgeAccounts((current) => current.filter((_, idx) => idx !== index));
  };

  const createSynctradeTenantQuick = async () => {
    setActionLoading('create-synctrade-tenant');
    try {
      const defaultApiKey = apiKeyOptions?.[0]?.value;
      await axios.post('/api/saas/admin/tenants', {
        displayName: `Synctrade Client ${(synctradeTenants.length || 0) + 1}`,
        productMode: 'synctrade_client',
        planCode: 'synctrade_100',
        assignedApiKeyName: defaultApiKey || undefined,
        language,
      });
      const nextSummary = await loadSummary('full');
      const firstSynctradeTenantId = Number((nextSummary?.tenants || []).find((item: any) => item.tenant.product_mode === 'synctrade_client')?.tenant.id || 0);
      if (firstSynctradeTenantId > 0) {
        setSynctradeTenantId(firstSynctradeTenantId);
      }
      messageApi.success('Synctrade client created');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create synctrade tenant'));
    } finally {
      setActionLoading('');
    }
  };

  useEffect(() => {
    void loadSummary(isAdminSurface ? 'full' : 'light');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSurface]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!isAdminSurface || typeof window === 'undefined') {
      return;
    }

    const applyFromUrl = () => {
      const path = window.location.pathname || '';
      const params = new URLSearchParams(window.location.search);
      const requestedAdminTab = String(params.get('adminTab') || '').trim() as AdminTabKey;
      const isAdminPath = path.includes('/saas/admin');
      if (isAdminPath) {
        setActiveTab('admin');
      }
      if (requestedAdminTab === 'offer-ts' || requestedAdminTab === 'clients' || requestedAdminTab === 'monitoring' || requestedAdminTab === 'create-user') {
        setAdminTab(requestedAdminTab);
      }
    };

    applyFromUrl();
    window.addEventListener('popstate', applyFromUrl);
    return () => {
      window.removeEventListener('popstate', applyFromUrl);
    };
  }, [isAdminSurface]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const persisted = parseAdminPublishResponse(window.localStorage.getItem(ADMIN_PUBLISH_RESPONSE_STORAGE_KEY));
    const currentApiKeyName = String(publishResponse?.sourceSystem?.apiKeyName || '').trim();
    const currentSystemName = String(publishResponse?.sourceSystem?.systemName || '').trim();
    const currentSystemId = Number(publishResponse?.sourceSystem?.systemId || 0);

    if (currentApiKeyName && currentSystemName && Number.isFinite(currentSystemId) && currentSystemId > 0) {
      window.localStorage.setItem(ADMIN_PUBLISH_RESPONSE_STORAGE_KEY, JSON.stringify(publishResponse));
      return;
    }

    if (!publishResponse && persisted) {
      setPublishResponse(persisted);
      return;
    }

    if (!persisted) {
      window.localStorage.removeItem(ADMIN_PUBLISH_RESPONSE_STORAGE_KEY);
    }
  }, [publishResponse]);

  useEffect(() => {
    if (!isAdminSurface) {
      return;
    }
    const adminNeedsSweepData = activeTab === 'admin' && adminTab === 'offer-ts';
    if (
      adminNeedsSweepData
      && (!summary?.offerStore || !summary?.sweepSummary || !summary?.catalog)
      && !summaryLoading
    ) {
      void loadSummary('full');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSurface, activeTab, adminTab, summary?.offerStore, summary?.sweepSummary, summary?.catalog]);

  useEffect(() => {
    setClientsClassValue('');
  }, [clientsClassKind]);

  useEffect(() => {
    if (selectedAdminReviewKind !== 'offer') {
      return;
    }
    if (reviewableSweepOffers.length === 0) {
      setSelectedAdminReviewOfferId('');
      return;
    }
    const exists = reviewableSweepOffers.some((item) => String(item.offerId) === String(selectedAdminReviewOfferId || ''));
    if (!exists) {
      setSelectedAdminReviewOfferId(String(reviewableSweepOffers[0].offerId));
    }
  }, [selectedAdminReviewKind, reviewableSweepOffers, selectedAdminReviewOfferId]);

  useEffect(() => {
    if (adminDraftTsOfferIdsAll.length === 0) {
      setSelectedAdminDraftTsOfferIds([]);
      setSelectedAdminDraftTsSetKey('');
      return;
    }

    setSelectedAdminDraftTsOfferIds((prev) => {
      const normalizedPrev = (prev || []).map((item) => String(item || '')).filter(Boolean);
      const stillAvailable = normalizedPrev.filter((item) => adminDraftTsOfferIdsAll.includes(item));
      if (stillAvailable.length > 0) {
        return stillAvailable;
      }
      setSelectedAdminDraftTsSetKey('');
      return adminDraftTsOfferIdsAll;
    });
  }, [adminDraftTsOfferIdsAll]);

  const loadTelegramControls = useCallback(async () => {
    setTelegramControlsLoading(true);
    try {
      const response = await axios.get<TelegramControls>('/api/saas/admin/telegram-controls');
      setTelegramControls(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load telegram controls'));
    } finally {
      setTelegramControlsLoading(false);
    }
  }, [messageApi]);

  const patchTelegramControls = useCallback(async (patch: Partial<TelegramControls>) => {
    setTelegramControlsLoading(true);
    try {
      const response = await axios.patch<TelegramControls>('/api/saas/admin/telegram-controls', patch);
      setTelegramControls(response.data);
      messageApi.success('Telegram control updated');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to update telegram controls'));
    } finally {
      setTelegramControlsLoading(false);
    }
  }, [messageApi]);

  const loadLowLotRecommendations = useCallback(async () => {
    setLowLotLoading(true);
    try {
      const response = await axios.get<LowLotRecommendationResponse>('/api/saas/admin/low-lot-recommendations', {
        params: { hours: 72, limit: 40, perStrategyReplacementLimit: 3 },
      });
      setLowLotRecommendations(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load low-lot recommendations'));
    } finally {
      setLowLotLoading(false);
    }
  }, [messageApi]);

  const submitApplyLowLotRecommendation = useCallback(async () => {
    if (!applyLowLotTarget) return;
    if (!applyLowLotDeposit && !applyLowLotLot && !applyLowLotReplacement) {
      messageApi.warning('Выберите хотя бы одно действие');
      return;
    }
    const strategyName = applyLowLotTarget.strategyName;
    setApplyLowLotWorking(true);
    try {
      const resp = await axios.post<{ success: boolean; changes: Record<string, unknown>; changeSummary: string[] }>(
        '/api/saas/admin/apply-low-lot-recommendation',
        {
          strategyId: applyLowLotTarget.strategyId,
          applyDepositFix: applyLowLotDeposit,
          applyLotFix: applyLowLotLot,
          applyToSystem: applyLowLotWholeSystem && Boolean(applyLowLotTarget.systemId),
          systemId: applyLowLotWholeSystem ? (applyLowLotTarget.systemId || undefined) : undefined,
          replacementSymbol: applyLowLotReplacement || undefined,
        }
      );
      const changeSummary = Array.isArray(resp.data?.changeSummary) ? resp.data.changeSummary : [];
      const summaryText = changeSummary.length > 0 ? ` (${changeSummary.join(', ')})` : '';
      messageApi.success(`Применено: ${strategyName}${summaryText}`, 8);
      setApplyLowLotTarget(null);
      void loadLowLotRecommendations();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Ошибка применения'));
    } finally {
      setApplyLowLotWorking(false);
    }
  }, [applyLowLotTarget, applyLowLotDeposit, applyLowLotLot, applyLowLotWholeSystem, applyLowLotReplacement, messageApi, loadLowLotRecommendations]);

  const loadMonitoringTabData = useCallback(async () => {
    if (!summary) {
      return;
    }

    const apiKeys = Array.from(new Set(
      (summary.tenants || [])
        .map((item) => String(item.tenant.assigned_api_key_name || item.strategyProfile?.assigned_api_key_name || item.algofundProfile?.assigned_api_key_name || '').trim())
        .filter(Boolean)
    ));

    if (apiKeys.length === 0) {
      setMonitoringSystemsByApiKey({});
      setMonitoringPositionsByApiKey({});
      setMonitoringStrategiesByApiKey({});
      setMonitoringReconciliationByApiKey({});
      return;
    }

    setMonitoringTabLoading(true);
    // Abort any previously in-flight monitoring request
    monitoringAbortRef.current?.abort();
    const controller = new AbortController();
    monitoringAbortRef.current = controller;
    const { signal } = controller;
    try {
      const entries = await Promise.all(
        apiKeys.map(async (apiKeyName) => {
          const [systems, positionsDigest, strategiesDigest, reconciliationDigest] = await Promise.all([
            (async (): Promise<TradingSystemListItem[]> => {
              try {
                const response = await axios.get<TradingSystemListItem[]>(`/api/trading-systems/${encodeURIComponent(apiKeyName)}`, { signal });
                return Array.isArray(response.data) ? response.data : [];
              } catch {
                return [];
              }
            })(),
            (async (): Promise<MonitoringPositionsDigest> => {
              try {
                const response = await axios.get<unknown[]>(`/api/positions/${encodeURIComponent(apiKeyName)}`, { signal });
                const rows = Array.isArray(response.data) ? response.data : [];
                const symbols = Array.from(new Set(rows
                  .map((item) => {
                    const row = item as Record<string, unknown>;
                    return String(row.symbol || row.base_symbol || row.baseSymbol || '').trim().toUpperCase();
                  })
                  .filter(Boolean)));
                return {
                  openCount: rows.length,
                  symbols,
                };
              } catch {
                return { openCount: 0, symbols: [] };
              }
            })(),
            (async (): Promise<MonitoringStrategyDigest> => {
              try {
                const response = await axios.get<unknown[]>(`/api/strategies/${encodeURIComponent(apiKeyName)}`, { signal });
                const rows = Array.isArray(response.data) ? response.data : [];
                const activeRows = rows.filter((item) => Number((item as Record<string, unknown>).is_active ? 1 : 0) === 1);
                const activeAutoRows = activeRows.filter((item) => Number((item as Record<string, unknown>).auto_update ? 1 : 0) === 1);
                const withLastError = activeRows.filter((item) => String((item as Record<string, unknown>).last_error || '').trim().length > 0).length;
                return {
                  total: rows.length,
                  active: activeRows.length,
                  activeAuto: activeAutoRows.length,
                  withLastError,
                };
              } catch {
                return { total: 0, active: 0, activeAuto: 0, withLastError: 0 };
              }
            })(),
            (async (): Promise<MonitoringReconciliationDigest> => {
              try {
                const response = await axios.get<{ reports?: unknown[] }>(
                  `/api/analytics/${encodeURIComponent(apiKeyName)}/reconciliation/reports`,
                  { params: { limit: 200 }, signal }
                );
                const rows = Array.isArray(response.data?.reports) ? response.data?.reports : [];
                const strategyIds = new Set<number>();
                let problematicCount = 0;
                let samplesTotal = 0;
                let pnlDeltaTotal = 0;
                let pnlDeltaCount = 0;
                let winRateDeltaTotal = 0;
                let winRateDeltaCount = 0;
                let latestAt = '';

                for (const rowUnknown of rows) {
                  const row = rowUnknown as Record<string, unknown>;
                  const strategyId = Number(row.strategy_id || 0);
                  if (strategyId > 0) {
                    strategyIds.add(strategyId);
                  }

                  const metrics = parseUnknownJson(row.metrics_json);
                  const recommendation = parseUnknownJson(row.recommendation_json);
                  const severity = String(recommendation.severity || '').toLowerCase();
                  const action = String(recommendation.action || '').toLowerCase();
                  if (severity === 'critical' || action === 'pause' || action === 'disable') {
                    problematicCount += 1;
                  }

                  const samples = Number(metrics.samples_count || 0);
                  if (Number.isFinite(samples)) {
                    samplesTotal += samples;
                  }

                  const pnlDelta = Number(metrics.realized_vs_predicted_pnl_percent);
                  if (Number.isFinite(pnlDelta)) {
                    pnlDeltaTotal += pnlDelta * 100;
                    pnlDeltaCount += 1;
                  }

                  const winRateLive = Number(metrics.win_rate_live);
                  const winRateBacktest = Number(metrics.win_rate_backtest);
                  if (Number.isFinite(winRateLive) && Number.isFinite(winRateBacktest)) {
                    winRateDeltaTotal += (winRateLive - winRateBacktest) * 100;
                    winRateDeltaCount += 1;
                  }

                  const createdAtRaw = String(row.created_at || '');
                  if (createdAtRaw && createdAtRaw > latestAt) {
                    latestAt = createdAtRaw;
                  }
                }

                return {
                  reportCount: rows.length,
                  strategyCount: strategyIds.size,
                  problematicCount,
                  avgSamples: rows.length > 0 ? Number((samplesTotal / rows.length).toFixed(2)) : 0,
                  avgPnlDeltaPercent: pnlDeltaCount > 0 ? Number((pnlDeltaTotal / pnlDeltaCount).toFixed(3)) : null,
                  avgWinRateDeltaPercent: winRateDeltaCount > 0 ? Number((winRateDeltaTotal / winRateDeltaCount).toFixed(3)) : null,
                  latestAt,
                };
              } catch {
                return {
                  reportCount: 0,
                  strategyCount: 0,
                  problematicCount: 0,
                  avgSamples: 0,
                  avgPnlDeltaPercent: null,
                  avgWinRateDeltaPercent: null,
                  latestAt: '',
                };
              }
            })(),
          ]);

          try {
            return {
              apiKeyName,
              systems,
              positionsDigest,
              strategiesDigest,
              reconciliationDigest,
            };
          } catch {
            return {
              apiKeyName,
              systems: [],
              positionsDigest: { openCount: 0, symbols: [] },
              strategiesDigest: { total: 0, active: 0, activeAuto: 0, withLastError: 0 },
              reconciliationDigest: {
                reportCount: 0,
                strategyCount: 0,
                problematicCount: 0,
                avgSamples: 0,
                avgPnlDeltaPercent: null,
                avgWinRateDeltaPercent: null,
                latestAt: '',
              },
            };
          }
        })
      );

      const nextMap: Record<string, TradingSystemListItem[]> = {};
      const nextPositionsMap: Record<string, MonitoringPositionsDigest> = {};
      const nextStrategiesMap: Record<string, MonitoringStrategyDigest> = {};
      const nextReconciliationMap: Record<string, MonitoringReconciliationDigest> = {};
      for (const entry of entries) {
        nextMap[entry.apiKeyName] = entry.systems;
        nextPositionsMap[entry.apiKeyName] = entry.positionsDigest;
        nextStrategiesMap[entry.apiKeyName] = entry.strategiesDigest;
        nextReconciliationMap[entry.apiKeyName] = entry.reconciliationDigest;
      }
      setMonitoringSystemsByApiKey(nextMap);
      setMonitoringPositionsByApiKey(nextPositionsMap);
      setMonitoringStrategiesByApiKey(nextStrategiesMap);
      setMonitoringReconciliationByApiKey(nextReconciliationMap);

      try {
        const logsResponse = await axios.get<string[]>('/api/logs', { signal });
        setMonitoringLogCommentsByApiKey(buildApiKeyLogComments(logsResponse.data, apiKeys));
      } catch {
        setMonitoringLogCommentsByApiKey({});
      }

      setMonitoringSystemSelected((current) => {
        const next = { ...current };
        for (const tenantSummary of summary.tenants || []) {
          const tenantId = Number(tenantSummary.tenant.id);
          if (Number.isFinite(tenantId) && next[tenantId] === undefined) {
            const apiKeyName = String(tenantSummary.tenant.assigned_api_key_name || '').trim();
            const systems = nextMap[apiKeyName] || [];
            const defaultSystem = systems.find((item) => item.is_active) || systems[0];
            next[tenantId] = defaultSystem?.id ? Number(defaultSystem.id) : undefined;
          }
        }
        return next;
      });
    } finally {
      if (!signal.aborted) {
        setMonitoringTabLoading(false);
      }
    }
  }, [summary]);

  const loadMonitoringChartData = async (key: string, days: number) => {
    setMonitoringChartLoading(true);
    try {
      const params: Record<string, number> = days > 1 ? { days } : { limit: 288 };
      const response = await axios.get<{ points?: MonitoringSnapshotPoint[]; latest?: MonitoringSnapshotPoint }>(
        `/api/monitoring/${encodeURIComponent(key)}`,
        { params }
      );

      const rows = Array.isArray(response.data?.points) ? response.data.points : [];
      const linePoints: LinePoint[] = rows
        .map((row) => {
          const time = normalizeSeriesTime(row?.recorded_at);
          const value = toFiniteNumberOrNull(row?.equity_usd);
          if (time === null || value === null) {
            return null;
          }
          return { time, value };
        })
        .filter((item): item is LinePoint => item !== null);

      setMonitoringChartPoints(linePoints);
      setMonitoringChartLatest(response.data?.latest || null);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to load monitoring chart'));
      setMonitoringChartPoints([]);
      setMonitoringChartLatest(null);
    } finally {
      setMonitoringChartLoading(false);
    }
  };

  const openMonitoringChart = async (apiKeyName: string) => {
    const key = String(apiKeyName || '').trim();
    if (!key) {
      return;
    }

    setMonitoringChartOpen(true);
    setMonitoringChartApiKey(key);
    setMonitoringChartDays(1);
    await loadMonitoringChartData(key, 1);
  };

  useEffect(() => {
    if (activeTab === 'admin' && adminTab === 'monitoring') {
      void loadMonitoringTabData();
      void loadTelegramControls();
      void loadLowLotRecommendations();
      if (!performanceReport) {
        void loadPerformanceReport('daily');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, adminTab, loadMonitoringTabData, loadTelegramControls, loadLowLotRecommendations, performanceReport]);

  useEffect(() => {
    if (monitoringChartOpen && monitoringChartApiKey) {
      void loadMonitoringChartData(monitoringChartApiKey, monitoringChartDays);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoringChartDays]);

  useEffect(() => {
    if (!summary) {
      return;
    }

    const nextStrategyTenant = (summary.tenants || []).find((item) => item.tenant.product_mode === 'strategy_client' || item.tenant.product_mode === 'dual')?.tenant.id || null;
    const nextAlgofundTenant =
      (summary.tenants || []).find((item) => (
        (item.tenant.product_mode === 'algofund_client' || item.tenant.product_mode === 'dual')
        && !!item.algofundProfile?.actual_enabled
        && String(item.algofundProfile?.published_system_name || '').trim().length > 0
      ))?.tenant.id
      || (summary.tenants || []).find((item) => (
        (item.tenant.product_mode === 'algofund_client' || item.tenant.product_mode === 'dual')
        && !!item.algofundProfile?.actual_enabled
      ))?.tenant.id
      || (summary.tenants || []).find((item) => (
        (item.tenant.product_mode === 'algofund_client' || item.tenant.product_mode === 'dual')
        && String(item.algofundProfile?.published_system_name || '').trim().length > 0
      ))?.tenant.id
      || (summary.tenants || []).find((item) => item.tenant.product_mode === 'algofund_client' || item.tenant.product_mode === 'dual')?.tenant.id
      || null;
    const nextCopytradingTenant =
      (summary.tenants || []).find((item) => item.tenant.product_mode === 'copytrading_client')?.tenant.id
      || null;

    const nextSynctradeTenant =
      (summary.tenants || []).find((item) => item.tenant.product_mode === 'synctrade_client')?.tenant.id
      || null;

    if (strategyTenantId === null && nextStrategyTenant !== null) {
      setStrategyTenantId(nextStrategyTenant);
    }
    if (algofundTenantId === null && nextAlgofundTenant !== null) {
      setAlgofundTenantId(nextAlgofundTenant);
      const selectedItem = (summary.tenants || []).find((t) => t.tenant.id === nextAlgofundTenant);
      if (selectedItem) {
        setAlgofundTenantStatus(selectedItem.algofundProfile?.actual_enabled ? 'active' : 'all');
      }
    }
    if (copytradingTenantId === null && nextCopytradingTenant !== null) {
      setCopytradingTenantId(nextCopytradingTenant);
    }
    if (synctradeTenantId === null && nextSynctradeTenant !== null) {
      setSynctradeTenantId(nextSynctradeTenant);
    }
  }, [summary, strategyTenantId, algofundTenantId, copytradingTenantId, synctradeTenantId]);

  useEffect(() => {
    if (strategyTenantId !== null) {
      void loadStrategyTenant(strategyTenantId);
    }
  }, [strategyTenantId]);

  useEffect(() => {
    if (algofundTenantId !== null) {
      void loadAlgofundTenant(algofundTenantId, undefined, isAdminSurface);
      if (isAdminSurface) {
        void loadAlgofundActiveSystems(algofundTenantId);
      }
    }
  }, [algofundTenantId, isAdminSurface]);

  useEffect(() => {
    setAlgofundCardRiskDrafts(
      Object.fromEntries((algofundActiveSystems || []).map((item) => [String(item.systemName || ''), Number(item.weight || 0)]))
    );
  }, [algofundActiveSystems]);

  useEffect(() => {
    if (reportTargetSystemName || !resolvedReportSystemName) {
      return;
    }
    setReportTargetSystemName(resolvedReportSystemName);
  }, [reportTargetSystemName, resolvedReportSystemName]);

  useEffect(() => {
    if (copytradingTenantId !== null) {
      void loadCopytradingTenant(copytradingTenantId);
    }
  }, [copytradingTenantId]);

  useEffect(() => {
    if (synctradeTenantId !== null) {
      void loadSynctradeTenant(synctradeTenantId);
    }
  }, [synctradeTenantId]);

  // Live PnL polling for open synctrade sessions
  // Auto-refresh sessions list every 15s to catch auto-close
  useEffect(() => {
    if (!synctradeTenantId) return;
    const openSessions = synctradeSessions.filter((s: any) => s.status === 'open');
    if (openSessions.length === 0) return;

    const refreshTimer = setInterval(() => {
      if (synctradeTenantId) void loadSynctradeTenant(synctradeTenantId);
    }, 15000);
    return () => { clearInterval(refreshTimer); };
  }, [synctradeTenantId, synctradeSessions]);

  useEffect(() => {
    const nextDrafts = Object.fromEntries((summary?.plans || []).map((plan) => [plan.code, { ...plan }])) as Record<string, Plan>;
    setPlanDrafts(nextDrafts);
  }, [summary?.plans]);

  useEffect(() => {
    if (!strategyState?.profile) {
      return;
    }
    const effectiveOffers = dedupeOffersById([
      ...(strategyState.offers || []),
      ...(strategyState.catalog?.clientCatalog?.mono || []),
      ...(strategyState.catalog?.clientCatalog?.synth || []),
      ...Object.values(strategyState.recommendedSets || {}).reduce<CatalogOffer[]>((acc, items) => {
        if (Array.isArray(items)) {
          acc.push(...items);
        }
        return acc;
      }, []),
    ]);
    const selected = Array.isArray(strategyState.profile.selectedOfferIds) ? strategyState.profile.selectedOfferIds : [];
    const activeProfileId = Number(strategyState.profile.activeSystemProfileId || 0);
    setStrategyOfferIds(selected);
    setStrategySystemProfileId(Number.isFinite(activeProfileId) && activeProfileId > 0 ? activeProfileId : null);
    setStrategyRiskInput(levelToSliderValue(strategyState.profile.risk_level || 'medium'));
    setStrategyTradeInput(levelToSliderValue(strategyState.profile.trade_frequency_level || 'medium'));
    setStrategyApiKeyName(strategyState.profile.assigned_api_key_name || strategyState.tenant.assigned_api_key_name || '');
    setStrategyTenantDisplayName(strategyState.tenant.display_name || '');
    setStrategyTenantStatus(strategyState.tenant.status || 'active');
    setStrategyTenantPlanCode(strategyState.plan?.code || '');
    setStrategyPreviewOfferId((current) => (current && selected.includes(current) ? current : selected[0] || effectiveOffers[0]?.offerId || ''));
    const latestPreview = hydrateStrategyPreview(strategyState.profile.latestPreview as StrategyPreviewResponse | null | undefined, effectiveOffers);
    setStrategyPreview(latestPreview);
  }, [strategyState]);

  useEffect(() => {
    if (!algofundState?.profile) {
      return;
    }
    setAlgofundRiskMultiplier(Number(algofundState.preview?.riskMultiplier ?? algofundState.profile?.risk_multiplier ?? 1));
    setAlgofundApiKeyName(
      algofundState.profile?.execution_api_key_name
      || algofundState.profile?.assigned_api_key_name
      || algofundState.tenant.assigned_api_key_name
      || ''
    );
    setAlgofundTenantDisplayName(algofundState.tenant.display_name || '');
    setAlgofundTenantStatus(algofundState.tenant.status || 'active');
    setAlgofundTenantPlanCode(algofundState.plan?.code || '');
  }, [algofundState]);

  useEffect(() => {
    const allowedTenantIds = new Set(batchEligibleAlgofundTenants.map((item) => Number(item.tenant.id)));
    setBatchTenantIds((current) => current.filter((item) => allowedTenantIds.has(Number(item))));
  }, [batchEligibleAlgofundTenants]);

  const runStrategyPreview = useCallback(async (silent = false) => {
    if (!strategyTenantId || !strategyPreviewOfferId) {
      return;
    }
    setStrategyPreviewLoading(true);
    try {
      const response = await axios.post<StrategyPreviewResponse>(`/api/saas/strategy-clients/${strategyTenantId}/preview`, {
        offerId: strategyPreviewOfferId,
        riskLevel: sliderValueToLevel(strategyRiskInput),
        tradeFrequencyLevel: sliderValueToLevel(strategyTradeInput),
        riskScore: strategyRiskInput,
        tradeFrequencyScore: strategyTradeInput,
      });
      setStrategyPreview(hydrateStrategyPreview(response.data, strategyOfferCatalog));
      if (!silent) {
        messageApi.success(copy.previewReady);
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to build preview'));
    } finally {
      setStrategyPreviewLoading(false);
    }
  }, [copy.previewReady, messageApi, strategyOfferCatalog, strategyPreviewOfferId, strategyRiskInput, strategyTenantId, strategyTradeInput]);

  const runStrategySelectionPreview = useCallback(async (silent = false) => {
    if (!strategyTenantId || strategyOfferIds.length === 0) {
      setStrategySelectionPreview(null);
      return;
    }

    setStrategySelectionPreviewLoading(true);
    try {
      const response = await axios.post<StrategySelectionPreviewResponse>(`/api/saas/strategy-clients/${strategyTenantId}/selection-preview`, {
        selectedOfferIds: strategyOfferIds,
        riskLevel: sliderValueToLevel(strategyRiskInput),
        tradeFrequencyLevel: sliderValueToLevel(strategyTradeInput),
        riskScore: strategyRiskInput,
        tradeFrequencyScore: strategyTradeInput,
      });
      setStrategySelectionPreview(response.data);
      if (!silent) {
        messageApi.success(copy.previewReady);
      }
    } catch (error: any) {
      setStrategySelectionPreview(null);
      if (!silent) {
        messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to build selected offers preview'));
      }
    } finally {
      setStrategySelectionPreviewLoading(false);
    }
  }, [copy.previewReady, messageApi, strategyOfferIds, strategyRiskInput, strategyTenantId, strategyTradeInput]);

  const activateStrategySystemProfile = async (profileId: number) => {
    if (!strategyTenantId) {
      return;
    }
    setActionLoading('strategy-profile-activate');
    try {
      const response = await axios.post<StrategyClientState>(`/api/saas/strategy-clients/${strategyTenantId}/system-profiles/${profileId}/activate`);
      setStrategyState(response.data);
      messageApi.success('Custom TS profile activated');
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to activate custom TS profile'));
    } finally {
      setActionLoading('');
    }
  };

  const createStrategySystemProfile = async () => {
    if (!strategyTenantId) {
      return;
    }
    const profileName = String(strategyNewProfileName || '').trim() || `Custom TS ${((strategyState?.systemProfiles?.length || 0) + 1)}`;
    setActionLoading('strategy-profile-create');
    try {
      await axios.post(`/api/saas/strategy-clients/${strategyTenantId}/system-profiles`, {
        profileName,
        selectedOfferIds: strategyOfferIds,
        activate: true,
      });
      await loadStrategyTenant(strategyTenantId);
      await loadSummary();
      setStrategyNewProfileName('');
      messageApi.success('Custom TS profile created');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create custom TS profile'));
    } finally {
      setActionLoading('');
    }
  };

  const deleteStrategySystemProfile = async () => {
    if (!strategyTenantId || !strategySystemProfileId) {
      return;
    }
    setActionLoading('strategy-profile-delete');
    try {
      await axios.delete(`/api/saas/strategy-clients/${strategyTenantId}/system-profiles/${strategySystemProfileId}`);
      await loadStrategyTenant(strategyTenantId);
      await loadSummary();
      messageApi.success('Custom TS profile deleted');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to delete custom TS profile'));
    } finally {
      setActionLoading('');
    }
  };

  const confirmAlgofundAdminDirectAction = async (
    action: 'start' | 'stop',
    tenantCount: number
  ): Promise<boolean> => {
    const actionLabel = action === 'start' ? 'START' : 'STOP + CLOSE POSITIONS';
    const first = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: `Confirm ${actionLabel}`,
        content: `Apply ${actionLabel} for ${tenantCount} tenant(s) immediately, without creating request queue items?`,
        okText: 'Confirm',
        cancelText: 'Cancel',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!first) {
      return false;
    }

    const second = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: `Final confirmation: ${actionLabel}`,
        content: 'This action executes immediately.',
        okText: 'Execute now',
        okType: action === 'stop' ? 'danger' : 'primary',
        cancelText: 'Back',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

    return second;
  };

  const runAlgofundBatchAction = async () => {
    const selectedTenantIds = Array.from(new Set((batchTenantIds || []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)));
    if (selectedTenantIds.length === 0) {
      messageApi.warning('Select at least one tenant for batch action');
      return;
    }
    if (batchAlgofundAction === 'switch_system' && (!Number.isFinite(Number(batchTargetSystemId)) || Number(batchTargetSystemId) <= 0)) {
      messageApi.warning('targetSystemId is required for switch_system');
      return;
    }

    if ((batchAlgofundAction === 'start' || batchAlgofundAction === 'stop') && isAdminSurface) {
      const confirmed = await confirmAlgofundAdminDirectAction(batchAlgofundAction, selectedTenantIds.length);
      if (!confirmed) {
        return;
      }
    }

    setActionLoading('algofund-batch');
    try {
      const response = await axios.post('/api/saas/admin/algofund-batch-actions', {
        tenantIds: selectedTenantIds,
        requestType: batchAlgofundAction,
        note: batchActionNote,
        targetSystemId: batchAlgofundAction === 'switch_system' ? Number(batchTargetSystemId) : undefined,
        directExecute: isAdminSurface && (batchAlgofundAction === 'start' || batchAlgofundAction === 'stop'),
      });
      const created = Number(response.data?.createdCount || 0);
      const failed = Number(response.data?.failedCount || 0);
      messageApi.success(
        isAdminSurface && (batchAlgofundAction === 'start' || batchAlgofundAction === 'stop')
          ? `Batch completed: executed ${created}, failed ${failed}`
          : `Batch completed: created ${created}, failed ${failed}`
      );
      await loadSummary();
      if (activeTab === 'admin' && adminTab === 'monitoring') {
        await loadMonitoringTabData();
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to run algofund batch action'));
    } finally {
      setActionLoading('');
    }
  };

  const runSingleAlgofundAction = async (tenantId: number, action: 'start' | 'stop' | 'switch_system', targetSystemId?: number) => {
    if ((action === 'start' || action === 'stop') && isAdminSurface) {
      const confirmed = await confirmAlgofundAdminDirectAction(action, 1);
      if (!confirmed) {
        return;
      }
    }

    setActionLoading(`algofund-single:${tenantId}`);
    try {
      const response = await axios.post('/api/saas/admin/algofund-batch-actions', {
        tenantIds: [tenantId],
        requestType: action,
        targetSystemId: action === 'switch_system' ? Number(targetSystemId) : undefined,
        directExecute: isAdminSurface && (action === 'start' || action === 'stop'),
      });
      const created = Number(response.data?.createdCount || 0);
      messageApi.success(
        isAdminSurface && (action === 'start' || action === 'stop')
          ? `Действие выполнено: ${created}`
          : `Запрос создан: ${created}`
      );
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Ошибка'));
    } finally {
      setActionLoading('');
    }
  };

  // Strategy previews are manual-only to avoid API storms on SaaS page load.

  useEffect(() => {
    return () => {
      if (algofundAutoPreviewTimerRef.current !== null) {
        window.clearTimeout(algofundAutoPreviewTimerRef.current);
        algofundAutoPreviewTimerRef.current = null;
      }
      monitoringAbortRef.current?.abort();
    };
  }, []);

  const saveStrategyProfile = async () => {
    if (!strategyTenantId) {
      return;
    }
    if (!strategySettingsEnabled) {
      messageApi.warning(copy.settingsLockedHint);
      return;
    }
    const nextRiskLevel = sliderValueToLevel(strategyRiskInput);
    const nextTradeLevel = sliderValueToLevel(strategyTradeInput);

    if ((strategyDraftConstraints.violations || []).length > 0) {
      messageApi.error((strategyDraftConstraints.violations || []).join(' '));
      return;
    }

    setActionLoading('strategy-save');
    try {
      const response = await axios.patch(`/api/saas/strategy-clients/${strategyTenantId}`, {
        selectedOfferIds: strategyOfferIds,
        riskLevel: nextRiskLevel,
        tradeFrequencyLevel: nextTradeLevel,
        assignedApiKeyName: strategyApiKeyName,
      });
      setStrategyState(response.data);
      messageApi.success(copy.saveSuccess);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save profile'));
    } finally {
      setActionLoading('');
    }
  };

  const runMaterialize = async () => {
    if (!strategyTenantId) {
      return;
    }
    if ((strategyDraftConstraints.violations || []).length > 0) {
      messageApi.error((strategyDraftConstraints.violations || []).join(' '));
      return;
    }
    setActionLoading('strategy-materialize');
    try {
      const response = await axios.post<MaterializeResponse>(`/api/saas/strategy-clients/${strategyTenantId}/materialize`, { activate: true });
      setMaterializeResponse(response.data);
      messageApi.success(copy.materializeSuccess);
      await loadStrategyTenant(strategyTenantId);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to materialize strategies'));
    } finally {
      setActionLoading('');
    }
  };

  const saveAlgofundProfile = async () => {
    if (!algofundTenantId) {
      return;
    }
    if (!algofundSettingsEnabled) {
      messageApi.warning(copy.settingsLockedHint);
      return;
    }
    setActionLoading('algofund-save');
    try {
      const response = await axios.patch(`/api/saas/algofund/${algofundTenantId}`, {
        riskMultiplier: algofundRiskMultiplier,
        assignedApiKeyName: algofundApiKeyName,
      });
      setAlgofundState(response.data);
      messageApi.success(copy.saveSuccess);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save algofund profile'));
    } finally {
      setActionLoading('');
    }
  };

  const refreshAlgofundPreview = async () => {
    if (!algofundTenantId) {
      return;
    }
    await loadAlgofundTenant(algofundTenantId, algofundRiskMultiplier, isAdminSurface, true);
    messageApi.success(copy.previewReady);
  };

  const saveStrategyTenantAdmin = async () => {
    if (!strategyTenantId) {
      return;
    }

    setActionLoading('strategy-tenant-save');
    try {
      await axios.patch(`/api/saas/admin/tenants/${strategyTenantId}`, {
        displayName: strategyTenantDisplayName,
        status: strategyTenantStatus,
        assignedApiKeyName: strategyApiKeyName,
        planCode: strategyTenantPlanCode,
      });
      messageApi.success(copy.saveTenant);
      await loadSummary();
      await loadStrategyTenant(strategyTenantId);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save tenant'));
    } finally {
      setActionLoading('');
    }
  };

  const emergencyStopStrategy = async () => {
    const apiKeyName = strategyApiKeyName || strategyState?.tenant?.assigned_api_key_name;
    if (!apiKeyName) {
      messageApi.warning('No API key assigned to this tenant');
      return;
    }
    setActionLoading('strategy-emergency');
    try {
      await axios.post(`/api/api-keys/${encodeURIComponent(apiKeyName)}/actions`, { action: 'pause-bots' });
      await axios.post(`/api/api-keys/${encodeURIComponent(apiKeyName)}/actions`, { action: 'close-positions' });
      messageApi.success(`Bots paused and positions closed for ${apiKeyName}`);
      if (strategyTenantId) {
        await loadStrategyTenant(strategyTenantId);
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Emergency stop failed'));
    } finally {
      setActionLoading('');
    }
  };

  const createStrategyMagicLink = async () => {
    if (!strategyTenantId) return;
    setActionLoading('strategy-magic-link');
    try {
      const response = await axios.post<ClientMagicLinkResponse>(`/api/saas/admin/tenants/${strategyTenantId}/magic-link`);
      setStrategyMagicLink(response.data);
      Modal.info({
        title: 'Magic-link готов',
        width: 760,
        okText: 'Закрыть',
        content: (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text type="secondary">Ссылка для быстрого входа клиента:</Text>
            <a href={response.data.loginUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{response.data.loginUrl}</a>
            <Text type="secondary">{copy.magicLinkExpires}: {new Date(response.data.expiresAt).toLocaleString()}</Text>
          </Space>
        ),
      });
      messageApi.success(copy.magicLinkReady);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create magic link'));
    } finally {
      setActionLoading('');
    }
  };

  const createAlgofundMagicLink = async () => {
    if (!algofundTenantId) return;
    setActionLoading('algofund-magic-link');
    try {
      const response = await axios.post<ClientMagicLinkResponse>(`/api/saas/admin/tenants/${algofundTenantId}/magic-link`);
      setAlgofundMagicLink(response.data);
      Modal.info({
        title: 'Magic-link готов',
        width: 760,
        okText: 'Закрыть',
        content: (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text type="secondary">Ссылка для быстрого входа клиента:</Text>
            <a href={response.data.loginUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{response.data.loginUrl}</a>
            <Text type="secondary">{copy.magicLinkExpires}: {new Date(response.data.expiresAt).toLocaleString()}</Text>
          </Space>
        ),
      });
      messageApi.success(copy.magicLinkReady);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create magic link'));
    } finally {
      setActionLoading('');
    }
  };

  const emergencyStopAlgofund = async () => {
    const apiKeyName = algofundApiKeyName || algofundState?.tenant?.assigned_api_key_name;
    if (!apiKeyName) {
      messageApi.warning('No API key assigned to this tenant');
      return;
    }
    setActionLoading('algofund-emergency');
    try {
      await axios.post(`/api/api-keys/${encodeURIComponent(apiKeyName)}/actions`, { action: 'pause-bots' });
      await axios.post(`/api/api-keys/${encodeURIComponent(apiKeyName)}/actions`, { action: 'close-positions' });
      messageApi.success(`Bots paused and positions closed for ${apiKeyName}`);
      if (algofundTenantId) {
        await loadAlgofundTenant(algofundTenantId, undefined, isAdminSurface);
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Emergency stop failed'));
    } finally {
      setActionLoading('');
    }
  };

  const saveAlgofundTenantAdmin = async () => {
    if (!algofundTenantId) {
      return;
    }

    setActionLoading('algofund-tenant-save');
    try {
      await axios.patch(`/api/saas/admin/tenants/${algofundTenantId}`, {
        displayName: algofundTenantDisplayName,
        status: algofundTenantStatus,
        assignedApiKeyName: algofundApiKeyName,
        planCode: algofundTenantPlanCode,
      });
      messageApi.success(copy.saveTenant);
      await loadSummary();
      await loadAlgofundTenant(algofundTenantId, undefined, isAdminSurface);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save tenant'));
    } finally {
      setActionLoading('');
    }
  };

  const updatePlanDraft = (planCode: string, patch: Partial<Plan>) => {
    setPlanDrafts((current) => {
      const existing = current[planCode];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [planCode]: {
          ...existing,
          ...patch,
        },
      };
    });
  };

  const savePlanDraft = async (planCode: string) => {
    const draft = planDrafts[planCode];
    if (!draft) {
      return;
    }

    setActionLoading(`plan-${planCode}`);
    try {
      await axios.patch(`/api/saas/admin/plans/${encodeURIComponent(planCode)}`, {
        title: draft.title,
        priceUsdt: draft.price_usdt,
        maxDepositTotal: draft.max_deposit_total,
        riskCapMax: draft.risk_cap_max,
        maxStrategiesTotal: draft.max_strategies_total,
        allowTsStartStopRequests: Boolean(draft.allow_ts_start_stop_requests),
      });
      messageApi.success(copy.savePlan);
      await loadSummary();
      if (strategyTenantId) {
        await loadStrategyTenant(strategyTenantId);
      }
      if (algofundTenantId) {
        await loadAlgofundTenant(algofundTenantId, undefined, isAdminSurface);
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save plan'));
    } finally {
      setActionLoading('');
    }
  };

  const sendAlgofundRequest = async (
    requestType: 'start' | 'stop' | 'switch_system',
    payload?: { targetSystemId?: number; targetSystemName?: string }
  ) => {
    if (!algofundTenantId) {
      return;
    }
    setActionLoading(`algofund-${requestType}`);
    try {
      const response = await axios.post(`/api/saas/algofund/${algofundTenantId}/request`, {
        requestType,
        note: algofundNote,
        targetSystemId: payload?.targetSystemId,
        targetSystemName: payload?.targetSystemName,
      });
      setAlgofundState(response.data);
      setAlgofundNote('');
      messageApi.success(copy.requestSent);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to send request'));
    } finally {
      setActionLoading('');
    }
  };

  const resolveRequest = async (requestId: number, status: 'approved' | 'rejected') => {
    setActionLoading(`resolve-${requestId}`);
    try {
      const response = await axios.post(`/api/saas/algofund/requests/${requestId}/resolve`, {
        status,
        decisionNote: algofundDecisionNote,
      });
      setAlgofundState(response.data);
      setAlgofundDecisionNote('');
      messageApi.success(copy.requestResolved);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to resolve request'));
    } finally {
      setActionLoading('');
    }
  };

  const handleApproveAlgofundRequest = async () => {
    const request = (summary?.algofundRequestQueue?.items || []).find((r) => r.id === approveRequestPendingId);
    if (!request) {
      messageApi.error('Request not found');
      return;
    }

    if (!approveRequestSelectedPlan) {
      messageApi.error('Please select a plan');
      return;
    }

    if (!approveRequestSelectedApiKey) {
      messageApi.error('Please select an API key');
      return;
    }

    setActionLoading(`approve-request-${approveRequestPendingId}`);
    try {
      const tenantId = Number(request.tenant_id || 0);
      if (!Number.isFinite(tenantId) || tenantId <= 0) {
        throw new Error('Invalid tenant ID');
      }

      // Step 1: Update tenant with new plan and API key
      await axios.patch(`/api/saas/admin/tenants/${tenantId}`, {
        planCode:approveRequestSelectedPlan,
        assignedApiKeyName: approveRequestSelectedApiKey,
      });

      // Step 2: Approve the request
      await axios.post(`/api/saas/algofund/requests/${approveRequestPendingId}/resolve`, {
        status: 'approved',
        decisionNote: `Plan: ${approveRequestSelectedPlan}, API Key: ${approveRequestSelectedApiKey}`,
      });

      messageApi.success('Algofund client request approved');
      setApproveRequestModalVisible(false);
      setApproveRequestPendingId(null);
      setApproveRequestSelectedPlan('');
      setApproveRequestSelectedApiKey('');
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to approve request'));
    } finally {
      setActionLoading('');
    }
  };

  const retryMaterialize = async () => {
    if (!algofundTenantId) {
      messageApi.error('No tenant selected');
      return;
    }
    setActionLoading('retry-materialize');
    try {
      const response = await axios.post(`/api/saas/algofund/${algofundTenantId}/retry-materialize`);
      const nextState = response.data as AlgofundState;
      setAlgofundState(nextState);
      if (Number(nextState?.profile?.actual_enabled || 0) === 1) {
        messageApi.success('Materialization completed. The client system is now running in the trading engine.');
      } else {
        const reason = String(nextState?.preview?.blockedReason || '').trim();
        messageApi.warning(reason || 'Materialization finished without engine start. Check Engine Status and Trading Systems.');
      }
      setRetryMaterializeModalVisible(false);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to retry materialization'));
    } finally {
      setActionLoading('');
    }
  };

  const seedDemoTenants = async () => {
    setActionLoading('seed');
    try {
      await axios.post('/api/saas/admin/seed');
      messageApi.success(copy.seedReady);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to seed tenants'));
    } finally {
      setActionLoading('');
    }
  };

  const publishAdminTs = async (payload?: AdminPublishPayload) => {
    const fallbackOfferIds = selectedAdminDraftTsOfferIds.length > 0
      ? selectedAdminDraftTsOfferIds
      : adminDraftTsOfferIdsAll;
    const offerIds = Array.from(new Set(
      (Array.isArray(payload?.offerIds) && payload?.offerIds?.length ? payload.offerIds : fallbackOfferIds)
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    ));
    const fallbackDraftKey = String(
      selectedAdminDraftTsSetKey
      || adminTradingSystemDraft?.name
      || publishResponse?.sourceSystem?.systemName
      || 'BTDD D1 Expanded TS v2'
    ).trim();
    const requestedSetKey = String(payload?.setKey || selectedAdminDraftTsSetKey || '').trim();
    let setKey = requestedSetKey;

    if (!setKey) {
      const promptText = 'Сохранение TS: оставьте текущее имя для сохранения в эту же карточку, или введите новое имя для новой карточки.';
      const enteredSetKey = window.prompt(promptText, fallbackDraftKey || undefined);
      if (enteredSetKey === null) {
        messageApi.info('Публикация ТС отменена');
        return;
      }
      setKey = String(enteredSetKey || '').trim() || fallbackDraftKey;
      if (!setKey) {
        messageApi.warning('Имя карточки TS не задано');
        return;
      }
      setSelectedAdminDraftTsSetKey(setKey);
    }

    setActionLoading('publish');
    try {
      const response = await axios.post<AdminPublishResponse>('/api/saas/admin/publish', {
        offerIds,
        setKey: setKey || undefined,
      });
      setPublishResponse(response.data);
      messageApi.success(copy.publishReady);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to publish admin TS'));
    } finally {
      setActionLoading('');
    }
  };

  const initiateStorefrontSystemAction = async (systemName: string, mode: 'remove' | 'delete') => {
    setRemoveStorefrontTarget(systemName);
    try {
      const response = await axios.post<{
        removed: boolean;
        clientsAffected: number;
        affectedTenants: Array<{ id: number; display_name: string }>;
        positionsByApiKey: Array<{ apiKeyName: string; openPositions: number; symbols: string[] }>;
        warning?: string;
      }>('/api/saas/admin/storefront-system/remove', { systemName, force: false, dryRun: true, hardDelete: mode === 'delete' });
      if (response.data.removed) {
        messageApi.success(mode === 'delete' ? `TS "${systemName}" удалена из базы` : `TS "${systemName}" снята с витрины`);
        await loadSummary('full');
      } else {
        setRemoveStorefrontConfirm({
          systemName,
          mode,
          clientCount: response.data.clientsAffected,
          tenants: response.data.affectedTenants || [],
          positionsByApiKey: response.data.positionsByApiKey || [],
        });
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || (mode === 'delete' ? 'Ошибка при удалении ТС из базы' : 'Ошибка при снятии ТС с витрины')));
    } finally {
      setRemoveStorefrontTarget(null);
    }
  };

  const initiateRemoveStorefront = async (systemName: string) => initiateStorefrontSystemAction(systemName, 'remove');
  const initiateDeleteStorefrontFromDb = async (systemName: string) => initiateStorefrontSystemAction(systemName, 'delete');

  const confirmRemoveStorefront = async () => {
    const systemName = removeStorefrontConfirm?.systemName;
    if (!systemName) return;
    setActionLoading(`remove-storefront:${systemName}`);
    try {
      const response = await axios.post('/api/saas/admin/storefront-system/remove', {
        systemName,
        force: true,
        closePositions: removeStorefrontClosePositions,
        hardDelete: removeStorefrontConfirm?.mode === 'delete',
      });
      const closeFailed = Number(response.data?.closeResult?.failed || 0);
      const hardDeleted = Number(response.data?.hardDeletedCount || 0);
      if (removeStorefrontConfirm?.mode === 'delete') {
        messageApi.success(`TS "${systemName}" удалена из базы (rows: ${hardDeleted}). ${removeStorefrontConfirm?.clientCount || 0} клиентов отключено.${removeStorefrontClosePositions ? ` Ошибок закрытия: ${closeFailed}` : ''}`);
      } else {
        messageApi.success(`TS "${systemName}" снята с витрины. ${removeStorefrontConfirm?.clientCount || 0} клиентов отключено.${removeStorefrontClosePositions ? ` Ошибок закрытия: ${closeFailed}` : ''}`);
      }
      setRemoveStorefrontConfirm(null);
      await loadSummary('full');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || (removeStorefrontConfirm?.mode === 'delete' ? 'Ошибка при удалении ТС из базы' : 'Ошибка при принудительном снятии ТС с витрины')));
    } finally {
      setActionLoading('');
    }
  };

  const openTenantWorkspace = (row: TenantSummary) => {
    const tenantId = Number(row.tenant.id || 0);
    if (!tenantId) {
      return;
    }

    if (row.tenant.product_mode === 'strategy_client' || row.tenant.product_mode === 'dual') {
      setStrategyTenantId(tenantId);
      navigateSaasTab('strategy-client');
      return;
    }

    if (row.tenant.product_mode === 'copytrading_client') {
      setCopytradingTenantId(tenantId);
      navigateSaasTab('copytrading');
      return;
    }

    if (row.tenant.product_mode === 'synctrade_client') {
      setSynctradeTenantId(tenantId);
      navigateSaasTab('synctrade');
      return;
    }

    setAlgofundTenantId(tenantId);
    navigateSaasTab('algofund');
  };

  const openPublishedAdminTsForClients = () => {
    const publishedSystemId = Number(publishResponse?.sourceSystem?.systemId || 0);
    const publishedSystemName = String(publishResponse?.sourceSystem?.systemName || '').trim();
    if (!publishedSystemId || !publishedSystemName) {
      messageApi.warning('Сначала отправьте draft ТС на апрув, чтобы получить runtime system id');
      return;
    }

    navigateToAdminTab('clients');
    setClientsModeFilter('algofund_client');
    setClientsClassKind('ts');
    setClientsClassValue(publishedSystemName);
    setBatchAlgofundAction('switch_system');
    setBatchTargetSystemId(publishedSystemId);
    setBatchTenantIds(batchEligibleAlgofundTenants.map((item) => Number(item.tenant.id)).filter((item) => item > 0));
    messageApi.success('Открыт шаг применения клиентам: выбран switch_system и подставлен опубликованный admin TS');
  };

  const focusClientsByOffer = (offerId: string) => {
    navigateToAdminTab('clients');
    setClientsClassKind('offer');
    setClientsClassValue(String(offerId || ''));
    messageApi.info('Открыт список клиентов, подключённых к выбранному офферу.');
  };

  const openAdminMonitoring = (mode: 'all' | ProductMode = 'all') => {
    navigateToAdminTab('monitoring');
    setMonitoringModeFilter(mode);
  };

  const persistBacktestSettingsByCard = useCallback((next: Record<string, BacktestCardSettings>) => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(ADMIN_BACKTEST_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  }, []);

  const applyBacktestSettings = useCallback((settings: BacktestCardSettings) => {
    setAdminSweepBacktestRiskScore(settings.riskScore);
    setAdminSweepBacktestTradeScore(settings.tradeFrequencyScore);
    setAdminSweepBacktestInitialBalance(settings.initialBalance);
    setAdminSweepBacktestRiskScaleMaxPercent(settings.riskScaleMaxPercent);
    setAdminSweepBacktestMaxOpenPositions(settings.maxOpenPositions ?? 0);
  }, []);

  const resolveBacktestSettingsForContext = useCallback((context: SaasBacktestContext): BacktestCardSettings => {
    const contextKey = getBacktestContextKey(context);
    const saved = contextKey ? adminBacktestSettingsByCard[contextKey] : null;
    if (saved) {
      return normalizeBacktestCardSettings(saved);
    }

    if (context.kind === 'algofund-ts') {
      const snapshots = Object.values(summary?.offerStore?.tsBacktestSnapshots || {});
      const contextSetKey = String(context.setKey || selectedAdminDraftTsSetKey || '').trim();
      const contextOfferIds = Array.from(new Set((context.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean))).sort();

      let matchingSnapshot = null as (typeof snapshots[number] | null);

      if (contextSetKey) {
        matchingSnapshot = snapshots.find((snapshot) => String(snapshot?.setKey || '').trim() === contextSetKey) || null;
      }

      if (!matchingSnapshot && contextOfferIds.length > 0) {
        matchingSnapshot = snapshots.find((snapshot) => {
          const snapshotOfferIds = Array.from(new Set((snapshot?.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean))).sort();
          if (snapshotOfferIds.length !== contextOfferIds.length) {
            return false;
          }
          return snapshotOfferIds.every((id, index) => id === contextOfferIds[index]);
        }) || null;
      }

      if (!matchingSnapshot) {
        const systemName = String(publishResponse?.sourceSystem?.systemName || selectedAlgofundPublishedSystemName || '').trim();
        if (systemName) {
          matchingSnapshot = resolveTsSnapshotForSystem(systemName);
        }
      }

      if (matchingSnapshot?.backtestSettings) {
        return normalizeBacktestCardSettings(matchingSnapshot.backtestSettings);
      }
    }

    if (context.kind === 'offer' && context.offerId) {
      const offer = (summary?.offerStore?.offers || []).find((item) => String(item.offerId) === String(context.offerId));
      if (offer?.backtestSettings) {
        return normalizeBacktestCardSettings(offer.backtestSettings);
      }
    }

    return { ...DEFAULT_BACKTEST_SETTINGS };
  }, [
    adminBacktestSettingsByCard,
    summary?.offerStore?.offers,
    summary?.offerStore?.tsBacktestSnapshots,
    selectedAdminDraftTsSetKey,
    publishResponse?.sourceSystem?.systemName,
    selectedAlgofundPublishedSystemName,
    resolveTsSnapshotForSystem,
  ]);

  const storeCurrentBacktestSettingsForContext = useCallback((context: SaasBacktestContext | null | undefined, patch: Partial<BacktestCardSettings>) => {
    const contextKey = getBacktestContextKey(context);
    if (!contextKey) {
      return;
    }

    setAdminBacktestSettingsByCard((current) => {
      const nextSettings = normalizeBacktestCardSettings({
        ...(current[contextKey] || DEFAULT_BACKTEST_SETTINGS),
        ...patch,
      });
      const next = {
        ...current,
        [contextKey]: nextSettings,
      };
      persistBacktestSettingsByCard(next);
      return next;
    });
  }, [persistBacktestSettingsByCard]);

  // Debounce helper: triggers auto-recalculate after slider changes with 700ms delay
  const scheduleBacktestDebounce = useCallback(() => {
    if (backtestDebounceRef.current !== null) {
      clearTimeout(backtestDebounceRef.current);
    }
    backtestDebounceRef.current = setTimeout(() => {
      backtestDebounceRef.current = null;
      void runAdminSweepBacktestPreviewRef.current();
    }, 700);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runAdminSweepBacktestPreview = async (
    context?: SaasBacktestContext | null,
    options?: { preferRealBacktest?: boolean; settingsOverride?: Partial<BacktestCardSettings> }
  ) => {
    const targetContext = context || backtestDrawerContext;
    if (!targetContext) {
      return;
    }

    const requestSeq = ++backtestRequestSeqRef.current;
    setAdminSweepBacktestLoading(true);
    setAdminSweepBacktestStale(false);
    setAdminSweepPreviewRiskScale(1);

    const effectiveRiskScore = Number(options?.settingsOverride?.riskScore ?? adminSweepBacktestRiskScore);
    const effectiveTradeFrequencyScore = Number(options?.settingsOverride?.tradeFrequencyScore ?? adminSweepBacktestTradeScore);
    const effectiveInitialBalance = Number(options?.settingsOverride?.initialBalance ?? adminSweepBacktestInitialBalance);
    const effectiveRiskScaleMaxPercent = Number(options?.settingsOverride?.riskScaleMaxPercent ?? adminSweepBacktestRiskScaleMaxPercent);
    const effectiveMaxOpenPositions = Math.max(0, Math.floor(Number(options?.settingsOverride?.maxOpenPositions ?? adminSweepBacktestMaxOpenPositions)));
    try {
      const response = await axios.post<AdminSweepBacktestPreviewResponse>('/api/saas/admin/sweep-backtest-preview', {
        kind: targetContext.kind,
        setKey: targetContext.setKey,
        systemName: targetContext.systemName,
        offerId: targetContext.offerId,
        offerIds: targetContext.offerIds,
        offerWeightsById: targetContext.kind === 'algofund-ts'
          ? normalizeBacktestTsWeights(
            Array.from(new Set((targetContext.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean))),
            backtestTsWeightsByOfferId,
          )
          : undefined,
        riskScore: effectiveRiskScore,
        tradeFrequencyScore: effectiveTradeFrequencyScore,
        initialBalance: effectiveInitialBalance,
        riskScaleMaxPercent: effectiveRiskScaleMaxPercent,
        maxOpenPositions: effectiveMaxOpenPositions > 0 ? effectiveMaxOpenPositions : undefined,
        preferRealBacktest: options?.preferRealBacktest === true,
        rerunApiKeyName: options?.preferRealBacktest
          ? (adminSweepBacktestRerunApiKey || undefined)
          : undefined,
      });
      if (requestSeq !== backtestRequestSeqRef.current) {
        return;
      }
      setAdminSweepBacktestResult(response.data);
      // Auto-set rerun key to sweep's key when none has been chosen yet
      if (response.data.sweepApiKeyName && !adminSweepBacktestRerunApiKey) {
        setAdminSweepBacktestRerunApiKey(response.data.sweepApiKeyName);
      }
      // Auto-store current settings for this context card
      storeCurrentBacktestSettingsForContext(targetContext, {
        riskScore: effectiveRiskScore,
        tradeFrequencyScore: effectiveTradeFrequencyScore,
        initialBalance: effectiveInitialBalance,
        riskScaleMaxPercent: effectiveRiskScaleMaxPercent,
        maxOpenPositions: effectiveMaxOpenPositions,
      });
    } catch (error: any) {
      if (requestSeq !== backtestRequestSeqRef.current) {
        return;
      }
      const errorMessage = String(error?.response?.data?.error || error?.message || '');
      setAdminSweepBacktestResult(null);
      messageApi.error(errorMessage || 'Не удалось построить sweep backtest preview');
    } finally {
      if (requestSeq === backtestRequestSeqRef.current) {
        setAdminSweepBacktestLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!backtestDrawerVisible || !showBacktestBtcOverlay || !adminSweepBacktestResult) {
      setBacktestBtcOverlayPoints([]);
      return;
    }

    const equity = toLineSeriesData(adminSweepBacktestResult.preview?.equity || []);
    if (equity.length < 2) {
      setBacktestBtcOverlayPoints([]);
      return;
    }

    const startTime = Math.min(...equity.map((point) => point.time));
    const endTime = Math.max(...equity.map((point) => point.time));
    const apiKeyName = String(
      adminSweepBacktestResult.rerun?.apiKeyName
      || adminSweepBacktestResult.sweepApiKeyName
      || adminSweepBacktestRerunApiKey
      || 'BTDD_D1'
    ).trim();
    const interval = String(adminSweepBacktestResult.period?.interval || '4h').trim() || '4h';

    let ignore = false;
    setBacktestBtcOverlayLoading(true);

    axios.get<any[]>(`/api/market-data/${encodeURIComponent(apiKeyName)}`, {
      params: {
        symbol: 'BTCUSDT',
        interval,
        limit: Math.max(300, equity.length * 3),
      },
    })
      .then((response) => {
        if (ignore) {
          return;
        }
        const rows = Array.isArray(response.data) ? response.data : [];
        const points: LinePoint[] = rows
          .map((row) => {
            if (Array.isArray(row) && row.length >= 5) {
              const time = normalizeEpochSeconds(row[0]);
              const value = Number(row[4]);
              if (time === null || !Number.isFinite(value)) {
                return null;
              }
              return { time, value };
            }
            if (row && typeof row === 'object') {
              const objectRow = row as Record<string, unknown>;
              const time = normalizeEpochSeconds(objectRow.time ?? objectRow.timestamp);
              const value = Number(objectRow.close ?? objectRow.value);
              if (time === null || !Number.isFinite(value)) {
                return null;
              }
              return { time, value };
            }
            return null;
          })
          .filter((point): point is LinePoint => !!point)
          .sort((left, right) => left.time - right.time)
          .filter((point) => point.time >= startTime && point.time <= endTime);

        setBacktestBtcOverlayPoints(downsampleLinePoints(points));
      })
      .catch(() => {
        if (!ignore) {
          setBacktestBtcOverlayPoints([]);
        }
      })
      .finally(() => {
        if (!ignore) {
          setBacktestBtcOverlayLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [
    backtestDrawerVisible,
    showBacktestBtcOverlay,
    adminSweepBacktestResult,
    adminSweepBacktestRerunApiKey,
  ]);
  // Keep ref always pointing to the latest function so debounce never uses a stale closure
  runAdminSweepBacktestPreviewRef.current = () => runAdminSweepBacktestPreview();

  const updateBacktestTsComposition = (
    nextOfferIdsRaw: string[],
    nextWeightsRaw?: Record<string, number>,
  ) => {
    if (!backtestDrawerContext || backtestDrawerContext.kind !== 'algofund-ts') {
      return;
    }
    const nextOfferIds = Array.from(new Set((nextOfferIdsRaw || [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)));
    if (nextOfferIds.length === 0) {
      messageApi.warning('Для backtest ТС нужен хотя бы один оффер');
      return;
    }

    setBacktestTsWeightsByOfferId((prev) => normalizeBacktestTsWeights(nextOfferIds, nextWeightsRaw || prev));
    setBacktestDrawerContext((prev) => {
      if (!prev || prev.kind !== 'algofund-ts') {
        return prev;
      }
      return {
        ...prev,
        offerIds: nextOfferIds,
      };
    });
    setAdminSweepBacktestStale(true);
    scheduleBacktestDebounce();
  };

  const startHistoricalSweepForBacktest = async () => {
    const apiKeyName = String(
      adminSweepBacktestResult?.rerun?.apiKeyName
      || adminSweepBacktestResult?.sweepApiKeyName
      || adminSweepBacktestRerunApiKey
      || ''
    ).trim();
    if (!apiKeyName) {
      messageApi.warning('Не найден API key для запуска historical sweep');
      return;
    }

    const sweepConfig = ((summary?.sweepSummary as any)?.config || {}) as Record<string, unknown>;
    setActionLoading('admin-rerun-historical-sweep');
    try {
      const response = await axios.post<{
        started?: boolean;
        reason?: string;
        jobId?: number;
      }>('/api/research/sweeps/full-historical/start', {
        mode: 'light',
        apiKeyName,
        dateFrom: sweepConfig.dateFrom ? String(sweepConfig.dateFrom) : undefined,
        dateTo: sweepConfig.dateTo ? String(sweepConfig.dateTo) : undefined,
        backtestBars: Number(sweepConfig.backtestBars || 6000),
        warmupBars: Number(sweepConfig.warmupBars || 400),
        initialBalance: Number(sweepConfig.initialBalance || adminSweepBacktestInitialBalance || 10000),
        commissionPercent: Number(sweepConfig.commissionPercent || 0.1),
        slippagePercent: Number(sweepConfig.slippagePercent || 0.05),
      });
      if (response.data?.started === false) {
        messageApi.warning(response.data?.reason || 'Historical sweep уже запущен');
        return;
      }
      messageApi.success(`Historical sweep запущен${response.data?.jobId ? `, job #${response.data.jobId}` : ''}. После завершения повтори API rerun.`);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось запустить historical sweep'));
    } finally {
      setActionLoading('');
    }
  };

  const saveOfferReviewSnapshotFromBacktest = async () => {
    if (!backtestDrawerContext?.offerId || !adminSweepBacktestResult || adminSweepBacktestResult.kind !== 'offer') {
      messageApi.warning('Сначала открой backtest оффера и дождись метрик');
      return;
    }

    const selected = adminSweepBacktestResult.selectedOffers[0];
    const summary = adminSweepBacktestResult.preview?.summary || {};
    if (!selected) {
      messageApi.warning('Нет данных для сохранения метрик оффера');
      return;
    }

    const equityPointsRaw = Array.isArray(adminSweepBacktestResult.preview?.equity)
      ? (adminSweepBacktestResult.preview?.equity || [])
        .map((point) => Number(point?.equity ?? point?.value ?? NaN))
        .filter((value) => Number.isFinite(value))
      : [];
    const equityPoints = downsampleNumericSeries(equityPointsRaw, 160);
    const snapshotApiKeyName = String(
      adminSweepBacktestResult?.rerun?.apiKeyName
      || adminSweepBacktestResult?.sweepApiKeyName
      || ''
    ).trim();

    setActionLoading(`offer-review-snapshot:${backtestDrawerContext.offerId}`);
    try {
      await axios.patch('/api/saas/admin/offer-store', {
        reviewSnapshotPatch: {
          [String(backtestDrawerContext.offerId)]: {
            offerId: String(backtestDrawerContext.offerId),
            apiKeyName: snapshotApiKeyName,
            ret: Number(summary.totalReturnPercent ?? selected.metrics.ret ?? 0),
            pf: Number(summary.profitFactor ?? selected.metrics.pf ?? 0),
            dd: Number(summary.maxDrawdownPercent ?? selected.metrics.dd ?? 0),
            trades: Number(summary.tradesCount ?? selected.metrics.trades ?? 0),
            tradesPerDay: Number(selected.tradesPerDay ?? 0),
            periodDays: Number(selected.periodDays ?? 90),
            equityPoints,
            riskScore: Number(adminSweepBacktestRiskScore ?? 5),
            tradeFrequencyScore: Number(adminSweepBacktestTradeScore ?? 5),
            initialBalance: Number(adminSweepBacktestInitialBalance ?? 10000),
            riskScaleMaxPercent: Number(adminSweepBacktestRiskScaleMaxPercent ?? 40),
          },
        },
      });
      await loadSummary('full');
      messageApi.success('Метрики оффера сохранены в карточке витрины');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось сохранить метрики оффера'));
    } finally {
      setActionLoading('');
    }
  };

  const saveTsReviewSnapshotFromBacktest = async (options?: { publishAfterSave?: boolean }) => {
    if (!backtestDrawerContext || backtestDrawerContext.kind !== 'algofund-ts' || !adminSweepBacktestResult || adminSweepBacktestResult.kind !== 'algofund-ts') {
      messageApi.warning('Сначала открой backtest ТС и дождись метрик');
      return;
    }

    const summary = adminSweepBacktestResult.preview?.summary || {};
    const equityPointsRaw = Array.isArray(adminSweepBacktestResult.preview?.equity)
      ? (adminSweepBacktestResult.preview?.equity || [])
        .map((point) => Number(point?.equity ?? point?.value ?? NaN))
        .filter((value) => Number.isFinite(value))
      : [];
    const equityPoints = downsampleNumericSeries(equityPointsRaw, 160);
    const resultOfferIds = (adminSweepBacktestResult.selectedOffers || [])
      .map((item) => String(item.offerId || '').trim())
      .filter(Boolean);
    const offerIds = resultOfferIds.length > 0
      ? Array.from(new Set(resultOfferIds))
      : (backtestDrawerContext.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean);
    const periodDays = Number(getPeriodDurationDays(adminSweepBacktestResult.period || null) || 90);
    const finalEquity = Number(summary.finalEquity ?? (equityPoints.length > 0 ? equityPoints[equityPoints.length - 1] : adminSweepBacktestInitialBalance));
    const trades = Number(summary.tradesCount ?? 0);
    const snapshotSetKey = String(
      adminSweepBacktestResult?.publishMeta?.setKey
      || backtestDrawerContext?.setKey
      || selectedAdminDraftTsSetKey
      || ''
    ).trim();
    const snapshotApiKeyName = String(
      adminSweepBacktestResult?.rerun?.apiKeyName
      || adminSweepBacktestResult?.sweepApiKeyName
      || ''
    ).trim();
    const fallbackDraftKey = String(
      adminTradingSystemDraft?.name
      || backtestDrawerContext?.title?.replace(/^Бэктест ТС:\s*/i, '')
      || 'BTDD D1 Expanded TS v2'
    ).trim();
    const defaultSnapshotKey = snapshotSetKey || fallbackDraftKey;

    // Detect if this card is already published on the storefront
    const contextSystemName = String(backtestDrawerContext?.systemName || snapshotSetKey || '').trim();
    const isOnStorefront = Boolean(
      (contextSystemName && (runtimeMasterSystemByName.has(contextSystemName) || publishedAlgofundSystems.includes(contextSystemName)))
      || (snapshotSetKey && publishedAlgofundSystems.includes(snapshotSetKey))
    );
    const storefrontClientCount = isOnStorefront
      ? algofundTenantsWithPublishedTs.filter((t) => String(t.algofundProfile?.published_system_name || '').trim() === contextSystemName).length
      : 0;

    const promptText = 'Сохранение TS: оставьте текущее имя для сохранения в эту же карточку, или введите новое имя для новой карточки.';
    const enteredSnapshotKey = window.prompt(promptText, defaultSnapshotKey);
    if (enteredSnapshotKey === null) {
      messageApi.info('Сохранение TS отменено');
      return null;
    }
    const snapshotKey = String(enteredSnapshotKey || '').trim() || defaultSnapshotKey;

    if (!snapshotKey) {
      messageApi.warning('Имя карточки TS не задано');
      return null;
    }

    const snapshotKeyOnStorefront = Boolean(
      snapshotKey && (runtimeMasterSystemByName.has(snapshotKey) || publishedAlgofundSystems.includes(snapshotKey))
    );
    const sameNameStorefrontUpdate = isOnStorefront && snapshotKey === (contextSystemName || defaultSnapshotKey);
    // New name entered → user explicitly named a new card (prompt text says so) → auto-publish as new storefront entry
    const isNewCardName = snapshotKey !== defaultSnapshotKey && !snapshotKeyOnStorefront;
    const shouldPublishAfterSave = options?.publishAfterSave === true || sameNameStorefrontUpdate || isNewCardName;
    const storefrontClientCountBySnapshotKey = snapshotKeyOnStorefront
      ? algofundTenantsWithPublishedTs.filter((t) => String(t.algofundProfile?.published_system_name || '').trim() === snapshotKey).length
      : 0;
    const willAffectStorefront = shouldPublishAfterSave && snapshotKeyOnStorefront && storefrontClientCountBySnapshotKey > 0;

    // If saving/publishing will touch storefront card, ask explicit confirmation.
    if (willAffectStorefront) {
      try {
        await new Promise<void>((resolve, reject) => {
          Modal.confirm({
            title: 'Карточка уже на витрине',
            content: `Настройки риска и частоты сделок одни — сохранение обновит их${storefrontClientCountBySnapshotKey > 0 ? ` для ${storefrontClientCountBySnapshotKey} клиентов` : ''} в торговле. Продолжить?`,
            okText: 'Сохранить и обновить витрину',
            cancelText: 'Отмена',
            onOk: () => resolve(),
            onCancel: () => reject(new Error('cancelled')),
          });
        });
      } catch {
        messageApi.info('Сохранение отменено');
        return null;
      }
    }

    setActionLoading('ts-review-snapshot');
    try {
      // When publishing (incl. new card), do publish FIRST to get the actual new systemName,
      // then save the snapshot with the correct systemName so the vitrine card resolves properly.
      let resolvedSystemName = String(adminSweepBacktestResult?.publishMeta?.systemName || '').trim();

      if (shouldPublishAfterSave) {
        const publishRes = await axios.post('/api/saas/admin/publish', {
          offerIds,
          setKey: snapshotKey || undefined,
        });
        const publishedSystemName = String(publishRes.data?.sourceSystem?.systemName || '').trim();
        if (publishedSystemName) {
          resolvedSystemName = publishedSystemName;
        }
        messageApi.success(isNewCardName
          ? `Новая карточка ТС «${snapshotKey}» создана на витрине`
          : 'Метрики ТС сохранены и витрина обновлена');
      }

      await axios.patch('/api/saas/admin/offer-store', {
        tsBacktestSnapshotsPatch: {
          [snapshotKey]: {
            apiKeyName: snapshotApiKeyName,
            setKey: snapshotKey,
            systemName: resolvedSystemName || undefined,
            ret: Number(summary.totalReturnPercent ?? 0),
            pf: Number(summary.profitFactor ?? 0),
            dd: Number(summary.maxDrawdownPercent ?? 0),
            trades,
            tradesPerDay: Number((trades / Math.max(1, periodDays)).toFixed(3)),
            periodDays,
            finalEquity,
            equityPoints,
            offerIds,
            backtestSettings: {
              riskScore: Number(adminSweepBacktestRiskScore ?? 5),
              tradeFrequencyScore: Number(adminSweepBacktestTradeScore ?? 5),
              initialBalance: Number(adminSweepBacktestInitialBalance ?? 10000),
              riskScaleMaxPercent: Number(adminSweepBacktestRiskScaleMaxPercent ?? 40),
            },
          },
        },
      });

      if (!shouldPublishAfterSave) {
        messageApi.success('Метрики ТС сохранены как черновик');
      }
      // Update localStorage under the new snapshotKey so re-opens use saved settings
      storeCurrentBacktestSettingsForContext(
        { ...backtestDrawerContext!, setKey: snapshotKey },
        {
          riskScore: Number(adminSweepBacktestRiskScore ?? 5),
          tradeFrequencyScore: Number(adminSweepBacktestTradeScore ?? 5),
          initialBalance: Number(adminSweepBacktestInitialBalance ?? 10000),
          riskScaleMaxPercent: Number(adminSweepBacktestRiskScaleMaxPercent ?? 40),
        }
      );
      await loadSummary('full');
      setSelectedAdminDraftTsSetKey(snapshotKey);
      return {
        snapshotKey,
        offerIds,
      };
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось сохранить метрики ТС'));
      return null;
    } finally {
      setActionLoading('');
    }
  };

  const saveOfferReviewSnapshotFromRow = async (offer: any) => {
    const offerId = String(offer?.offerId || '').trim();
    if (!offerId) {
      return;
    }

    const equityPointsRaw = Array.isArray(offer?.equityPoints)
      ? offer.equityPoints
        .map((point: unknown) => Number(point))
        .filter((value: number) => Number.isFinite(value))
      : [];
    const equityPoints = downsampleNumericSeries(equityPointsRaw, 160);

    setActionLoading(`offer-review-snapshot:${offerId}`);
    try {
      await axios.patch('/api/saas/admin/offer-store', {
        reviewSnapshotPatch: {
          [offerId]: {
            offerId,
            ret: Number(offer?.ret ?? 0),
            pf: Number(offer?.pf ?? 0),
            dd: Number(offer?.dd ?? 0),
            trades: Number(offer?.trades ?? 0),
            tradesPerDay: Number(offer?.tradesPerDay ?? 0),
            periodDays: Number(offer?.periodDays ?? 90),
            equityPoints,
            riskScore: Number(offer?.backtestSettings?.riskScore ?? 5),
            tradeFrequencyScore: Number(offer?.backtestSettings?.tradeFrequencyScore ?? 5),
            initialBalance: Number(offer?.backtestSettings?.initialBalance ?? 10000),
            riskScaleMaxPercent: Number(offer?.backtestSettings?.riskScaleMaxPercent ?? 40),
          },
        },
      });
      await loadSummary('full');
      messageApi.success('Черновик карточки сохранен');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось сохранить черновик карточки'));
    } finally {
      setActionLoading('');
    }
  };

  const openEmbeddedBacktest = (context: SaasBacktestContext) => {
    backtestRequestSeqRef.current += 1;
    const settings = resolveBacktestSettingsForContext(context);
    applyBacktestSettings(settings);

    // Persist resolved settings to localStorage under the context key so that
    // re-opening the same card (even after server-side snapshot refresh) retains
    // the last-known settings rather than falling through to defaults.
    const contextKey = getBacktestContextKey(context);
    if (contextKey) {
      setAdminBacktestSettingsByCard((current) => {
        if (current[contextKey]) {
          return current; // already has explicit user settings — do not overwrite
        }
        const next = { ...current, [contextKey]: settings };
        persistBacktestSettingsByCard(next);
        return next;
      });
    }
    if (context.kind === 'algofund-ts') {
      const offerIds = Array.from(new Set((context.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean)));
      setBacktestTsWeightsByOfferId((prev) => {
        const source = context.offerWeightsById && Object.keys(context.offerWeightsById).length > 0
          ? context.offerWeightsById
          : prev;
        return normalizeBacktestTsWeights(offerIds, source);
      });
    } else {
      setBacktestTsWeightsByOfferId({});
    }
    setBacktestDrawerContext(context);
    setBacktestDrawerVisible(true);
    setAdminSweepBacktestResult(null);
    setAdminSweepBacktestRerunApiKey('');
    window.setTimeout(() => {
      void runAdminSweepBacktestPreview(context, { settingsOverride: settings });
    }, 0);
  };

  const openOfferBacktest = (offer?: typeof adminReviewOfferPool[number] | null) => {
    if (!offer) {
      messageApi.warning('Сначала выбери оффер из sweep-кандидатов');
      return;
    }

    openEmbeddedBacktest({
      kind: 'offer',
      title: `Бэктест оффера: ${offer.titleRu}`,
      description: 'Sweep-бэктест карточки из последнего свепа. Регулируй риск и частоту, проверяй метрики/equity и решай: отправить на витрину или закрыть.',
      offerId: String(offer.offerId || ''),
      offerPublished: Boolean(offer.published),
    });
  };

  const openSingleOfferBacktestAsTs = (offer?: { offerId?: string; titleRu?: string } | null) => {
    const offerId = String(offer?.offerId || '').trim();
    if (!offerId) {
      messageApi.warning('Сначала выбери оффер');
      return;
    }

    const title = String(offer?.titleRu || offerId).trim();
    openEmbeddedBacktest({
      kind: 'algofund-ts',
      title: `Бэктест оффера: ${title}`,
      description: 'Бэктест карточки оффера в том же режиме, что и ТС (один оффер как single-member TS).',
      offerIds: [offerId],
      offerWeightsById: { [offerId]: 1 },
      setKey: offerId,
    });
  };

  const openDraftTsBacktest = (params?: { setKey?: string; offerIds?: string[]; systemName?: string; offerWeightsById?: Record<string, number> }) => {
    const directOfferIds = (params?.offerIds || []).map((item) => String(item || '')).filter(Boolean);
    const selectedOfferIds = directOfferIds.length > 0
      ? directOfferIds
      : (selectedAdminDraftTsOfferIds || []).map((item) => String(item || '')).filter(Boolean);
    const offerIds = selectedOfferIds.length > 0 ? selectedOfferIds : adminDraftTsOfferIdsAll;
    const selectedOfferIdSet = new Set(offerIds);
    const selectedOffers = adminDraftTsOfferCandidates.filter((offer) => selectedOfferIdSet.has(String(offer.offerId || '').trim()));
    const selectedStrategyNames = Array.from(new Set(
      selectedOffers
        .map((offer) => String(offer?.titleRu || '').trim())
        .filter(Boolean)
    ));
    const inferredSelectedTsName = String(params?.setKey || '').trim()
      || selectedAdminDraftTsSetKey
      || String(params?.systemName || '').trim()
      || (selectedStrategyNames.length === 1 ? selectedStrategyNames[0] : '');
    const runtimeSystemName = String(params?.systemName || '').trim();
    const canUseRuntimeSystem = runtimeSystemName.length > 0;

    if (!canUseRuntimeSystem && Number(adminTradingSystemDraft?.members?.length || 0) === 0) {
      messageApi.warning('Для бэктеста ТС нужен draft из последнего sweep');
      return;
    }

    if (!canUseRuntimeSystem && offerIds.length === 0) {
      messageApi.warning('Для sweep бэктеста ТС выбери хотя бы одну карточку из draft ТС');
      return;
    }

    const tsName = String(
      inferredSelectedTsName
      || adminTradingSystemDraft?.name
      || publishResponse?.sourceSystem?.systemName
      || algofundState?.engine?.systemName
      || 'Algofund TS'
    ).trim();

    openEmbeddedBacktest({
      kind: 'algofund-ts',
      title: `Бэктест ТС: ${tsName}`,
      description: 'Sweep-портфельный бэктест draft ТС из последнего свепа. После проверки метрик можно отправлять ТС на витрину.',
      offerIds,
      offerWeightsById: params?.offerWeightsById,
      setKey: String(params?.setKey || selectedAdminDraftTsSetKey || '').trim() || undefined,
      systemName: runtimeSystemName || undefined,
    });
  };

  const wizardOfferCandidate = selectedAdminReviewOffer || reviewableSweepOffers[0] || null;
  const openWizardReviewStep = () => {
    if (adminWizardTarget === 'algofund-ts') {
      openAdminReviewContext('algofund-ts');
      return;
    }

    if (!wizardOfferCandidate) {
      messageApi.warning('Сначала загрузи sweep-кандидаты');
      return;
    }

    openAdminReviewContext('offer', String(wizardOfferCandidate.offerId));
  };

  const openWizardBacktestStep = () => {
    if (adminWizardTarget === 'algofund-ts') {
      openDraftTsBacktest();
      return;
    }

    openOfferBacktest(wizardOfferCandidate);
  };

  const publishFromWizard = async () => {
    if (adminWizardTarget === 'algofund-ts') {
      await publishAdminTs({
        offerIds: selectedAdminDraftTsOfferIds,
        setKey: selectedAdminDraftTsSetKey,
      });
      return;
    }

    if (!wizardOfferCandidate) {
      messageApi.warning('Нет выбранного оффера для витрины');
      return;
    }

    await toggleOfferPublished(String(wizardOfferCandidate.offerId), true);
  };

  const publishFromBacktestContext = async () => {
    if (!backtestDrawerContext) {
      return;
    }

    if (backtestDrawerContext.kind === 'algofund-ts') {
      const saved = await saveTsReviewSnapshotFromBacktest({ publishAfterSave: true });
      if (!saved) {
        return;
      }
      setBacktestDrawerVisible(false);
      setBacktestDrawerContext(null);
      return;
    }

    if (!backtestDrawerContext.offerId) {
      messageApi.warning('В этом backtest-контексте не найден offer id');
      return;
    }

    await saveOfferReviewSnapshotFromBacktest();
    await toggleOfferPublished(String(backtestDrawerContext.offerId), true);
    setBacktestDrawerContext((prev) => prev ? { ...prev, offerPublished: true } : prev);
    setBacktestDrawerVisible(false);
    setBacktestDrawerContext(null);
  };

  const returnToReviewFromBacktest = () => {
    if (!backtestDrawerContext) {
      return;
    }

    setBacktestDrawerVisible(false);
    if (backtestDrawerContext.kind === 'algofund-ts') {
      openAdminReviewContext('algofund-ts');
      return;
    }

    if (backtestDrawerContext.offerId) {
      openAdminReviewContext('offer', backtestDrawerContext.offerId);
    }
  };

  const openBacktestDrawerForAdminTs = () => {
    openDraftTsBacktest();
  };

  const openBacktestDrawerForStorefrontTs = (systemName: string) => {
    const normalizedSystemName = String(systemName || '').trim();
    if (!normalizedSystemName) {
      openDraftTsBacktest();
      return;
    }

    const snapshot = resolveTsSnapshotForSystem(normalizedSystemName);
    const runtimeSystem = runtimeMasterSystemByName.get(normalizedSystemName) || null;
    const snapshotSetKey = String(snapshot?.setKey || '').trim();
    const setKey = snapshotSetKey || (snapshot ? normalizedSystemName : '');
    const rawSnapshotOfferIds = snapshot?.offerIds;
    const snapshotOfferIds = Array.isArray(rawSnapshotOfferIds) ? rawSnapshotOfferIds : [];
    const runtimeOfferIds = Array.isArray(runtimeSystem?.offerIds) ? (runtimeSystem?.offerIds || []) : [];
    const offerIds = snapshotOfferIds.length > 0
      ? snapshotOfferIds.map((item) => String(item || '').trim()).filter(Boolean)
      : runtimeOfferIds.map((item) => String(item || '').trim()).filter(Boolean);

    if (setKey) {
      setSelectedAdminDraftTsSetKey(setKey);
    }

    openDraftTsBacktest({
      setKey,
      offerIds,
      offerWeightsById: runtimeSystem?.offerWeightsById,
      systemName: normalizedSystemName,
    });
  };

  const navigateSaasTab = (tab: SaasTabKey, nextAdminTab?: AdminTabKey) => {
    if (isAdminSurface) {
      const target = nextAdminTab || adminTab;
      navigate(`/saas/admin?adminTab=${target}`);
    } else if (tab === 'admin') {
      const target = nextAdminTab || adminTab;
      navigate(`/saas/admin?adminTab=${target}`);
    } else if (tab === 'strategy-client') {
      navigate('/saas/strategy-client');
    } else if (tab === 'algofund') {
      navigate('/saas/algofund');
    } else if (tab === 'copytrading') {
      navigate('/saas/copytrading');
    } else if (tab === 'synctrade') {
      navigate('/saas/synctrade');
    }
    setActiveTab(tab);
    if (tab === 'admin' && nextAdminTab) {
      setAdminTab(nextAdminTab);
    }
  };

  const navigateToAdminTab = (tab: AdminTabKey) => {
    navigateSaasTab('admin', tab);
  };

  const openSaasBacktestFlow = (
    offerOverride?: typeof adminReviewOfferPool[number] | null,
    options?: { forceKind?: 'offer' | 'algofund-ts' }
  ) => {
    const resolvedKind = options?.forceKind || selectedAdminReviewKind;
    if (resolvedKind === 'algofund-ts') {
      openDraftTsBacktest();
      return;
    }

    const targetOffer = offerOverride || selectedAdminReviewOffer || reviewableSweepOffers[0] || strategySelectedBacktestOffer || null;
    openOfferBacktest(targetOffer);
  };

  const preferredClientSwitchTarget = (() => {
    const explicitSystemId = Number(batchTargetSystemId || 0);
    if (Number.isFinite(explicitSystemId) && explicitSystemId > 0) {
      return {
        systemId: explicitSystemId,
        systemName: String(publishResponse?.sourceSystem?.systemName || '').trim(),
        source: 'batch-target',
      };
    }

    const publishedSystemId = Number(publishResponse?.sourceSystem?.systemId || 0);
    if (Number.isFinite(publishedSystemId) && publishedSystemId > 0) {
      return {
        systemId: publishedSystemId,
        systemName: String(publishResponse?.sourceSystem?.systemName || '').trim(),
        source: 'published-admin-ts',
      };
    }

    return null;
  })();

  const openAdminReviewContext = (kind: 'offer' | 'algofund-ts', offerId?: string) => {
    navigateToAdminTab('offer-ts');
    setSelectedAdminReviewKind(kind);
    if (kind === 'offer' && offerId) {
      setSelectedAdminReviewOfferId(String(offerId));
    }
    window.setTimeout(() => {
      reviewContextRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  const applyPublishedAdminTsToSelectedClients = async () => {
    const publishedSystemId = Number(publishResponse?.sourceSystem?.systemId || 0);
    const publishedSystemName = String(publishResponse?.sourceSystem?.systemName || '').trim();
    const selectedTenantIds = Array.from(new Set((batchTenantIds || []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)));

    if (!publishedSystemId || !publishedSystemName) {
      messageApi.warning('Сначала отправьте draft ТС на апрув, чтобы получить runtime system id');
      return;
    }
    if (selectedTenantIds.length === 0) {
      messageApi.warning('Сначала выберите algofund-клиентов в разделе Клиенты');
      return;
    }

    setActionLoading('apply-published-admin-ts');
    try {
      const response = await axios.post('/api/saas/admin/algofund-batch-actions', {
        tenantIds: selectedTenantIds,
        requestType: 'switch_system',
        note: `Apply published admin TS ${publishedSystemName}`,
        targetSystemId: publishedSystemId,
        targetSystemName: publishedSystemName,
        directExecute: true,
      });
      const created = Number(response.data?.createdCount || 0);
      const failed = Number(response.data?.failedCount || 0);
      messageApi.success(`Применение завершено: switched ${created}, failed ${failed}`);
      const failures = Array.isArray(response.data?.failures) ? response.data.failures : [];
      if (failures.length > 0) {
        const details = failures
          .slice(0, 3)
          .map((item: any) => `tenant ${Number(item?.tenantId || 0)}: ${String(item?.error || 'failed')}`)
          .join('; ');
        messageApi.warning(`Ошибки применения: ${details}`);
      }
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to apply published admin TS to selected clients'));
    } finally {
      setActionLoading('');
    }
  };

  const applyStorefrontTsToClients = async () => {
    const systemId = Number(storefrontConnectTarget?.systemId || 0);
    const systemName = String(storefrontConnectTarget?.systemName || '').trim();
    const selectedTenantIds = Array.from(new Set((storefrontConnectTarget?.tenantIds || []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)));
    const originalTenantIds = Array.from(new Set((storefrontConnectTarget?.originalTenantIds || []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)));
    const deselectedTenantIds = originalTenantIds.filter((id) => !selectedTenantIds.includes(id));

    if (!systemId || !systemName) {
      messageApi.warning('Не найдена TS для применения');
      return;
    }

    // If there are deselected tenants, show confirmation before proceeding
    if (deselectedTenantIds.length > 0) {
      const deselectedNames = (summary?.tenants || [])
        .filter((row: any) => deselectedTenantIds.includes(Number(row.tenant?.id)))
        .map((row: any) => row.tenant?.display_name || row.tenant?.slug || `tenant-${row.tenant?.id}`)
        .join(', ');
      Modal.confirm({
        title: `Отключить ${deselectedTenantIds.length} клиент(ов) от TS?`,
        content: (
          <Space direction="vertical" size={8}>
            <Text>Клиенты: <Text strong>{deselectedNames || deselectedTenantIds.join(', ')}</Text></Text>
            <Text>Все открытые позиции будут закрыты, ордера отменены.</Text>
            <Text type="secondary">TS будет снята с дашборда для отключённых клиентов.</Text>
          </Space>
        ),
        okText: 'Отключить и закрыть позиции',
        okType: 'danger',
        cancelText: 'Отмена',
        onOk: () => executeApplyStorefrontTs(systemId, systemName, selectedTenantIds, deselectedTenantIds),
      });
      return;
    }

    await executeApplyStorefrontTs(systemId, systemName, selectedTenantIds, deselectedTenantIds);
  };

  const executeApplyStorefrontTs = async (systemId: number, systemName: string, selectedTenantIds: number[], deselectedTenantIds: number[]) => {
    setActionLoading('apply-storefront-ts');
    try {
      // Stop deselected tenants (cancelled from TS connection) — close positions and cancel orders
      if (deselectedTenantIds.length > 0) {
        try {
          await axios.post('/api/saas/admin/algofund-batch-actions', {
            tenantIds: deselectedTenantIds,
            requestType: 'stop',
            note: `Disconnected from storefront TS ${systemName}`,
            directExecute: true,
          });
        } catch (stopError: any) {
          messageApi.warning(`Ошибка при остановке отключённых клиентов: ${String(stopError?.response?.data?.error || stopError?.message || 'stop failed')}`);
        }
      }

      if (selectedTenantIds.length === 0) {
        // Only disconnections, no new switches
        setStorefrontConnectTarget(null);
        if (deselectedTenantIds.length > 0) {
          messageApi.success(`Отключено клиентов: ${deselectedTenantIds.length}. Позиции закрыты.`);
        }
        await loadSummary('full');
        return;
      }

      const response = await axios.post('/api/saas/admin/algofund-batch-actions', {
        tenantIds: selectedTenantIds,
        requestType: 'switch_system',
        note: `Apply storefront TS ${systemName}`,
        targetSystemId: systemId,
        targetSystemName: systemName,
        directExecute: true,
      });
      const created = Number(response.data?.createdCount || 0);
      const failed = Number(response.data?.failedCount || 0);
      const stopNote = deselectedTenantIds.length > 0 ? ` Отключено и остановлено: ${deselectedTenantIds.length}.` : '';
      messageApi.success(`TS применена: switched ${created}, failed ${failed}.${stopNote}`);
      const failures = Array.isArray(response.data?.failures) ? response.data.failures : [];
      if (failures.length > 0) {
        const details = failures
          .slice(0, 3)
          .map((item: any) => `tenant ${Number(item?.tenantId || 0)}: ${String(item?.error || 'failed')}`)
          .join('; ');
        messageApi.warning(`Причина ошибок: ${details}`);
      }
      setStorefrontConnectTarget(null);
      await loadSummary('full');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось применить TS к клиентам'));
    } finally {
      setActionLoading('');
    }
  };

  const applyStrategyConnectToClients = async () => {
    if (!strategyConnectTarget) return;
    const { offerId, tenantIds } = strategyConnectTarget;
    if (!offerId || tenantIds.length === 0) {
      messageApi.warning('Выберите хотя бы одного клиента');
      return;
    }
    setActionLoading('apply-strategy-connect');
    try {
      const response = await axios.post('/api/saas/admin/strategy-client-batch-connect', {
        offerIds: [offerId],
        tenantIds,
      });
      const successCount = Number(response.data?.success || 0);
      const errors = Array.isArray(response.data?.errors) ? response.data.errors : [];
      messageApi.success(`Оффер подключён: ${successCount} клиент(ов).${errors.length > 0 ? ` Ошибки: ${errors.slice(0, 3).join('; ')}` : ''}`);
      if (errors.length > 0) {
        errors.slice(0, 3).forEach((err: string) => messageApi.warning(err));
      }
      setStrategyConnectTarget(null);
      await loadSummary('full');
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Batch connect failed'));
    } finally {
      setActionLoading('');
    }
  };

  const saveAlgofundCardRisk = async (systemName: string) => {
    if (!algofundTenantId) {
      messageApi.warning('Сначала выбери клиента Алгофонда');
      return;
    }
    const normalizedSystemName = String(systemName || '').trim();
    if (!normalizedSystemName) {
      return;
    }
    const nextWeight = Number(algofundCardRiskDrafts[normalizedSystemName] ?? 1);
    if (!Number.isFinite(nextWeight) || nextWeight < 0) {
      messageApi.warning('Риск карточки должен быть числом >= 0');
      return;
    }

    setActionLoading(`algofund-card-risk:${normalizedSystemName}`);
    try {
      await axios.put(`/api/saas/algofund/${algofundTenantId}/active-systems`, {
        systems: [{ systemName: normalizedSystemName, weight: nextWeight, isEnabled: true, assignedBy: 'client' }],
        replace: false,
      });
      await loadAlgofundActiveSystems(algofundTenantId);
      messageApi.success(`Риск карточки обновлен: ${normalizedSystemName}`);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Не удалось обновить риск карточки'));
    } finally {
      setActionLoading('');
    }
  };

  const createTenantAdmin = async () => {
    if (!createTenantDisplayName.trim() || !createTenantPlanCode) {
      messageApi.error('Display name and plan are required');
      return;
    }
    if (createTenantProductMode === 'dual' && !createTenantAlgofundPlanCode) {
      messageApi.error('Для dual режима выберите и стратегический, и алгофонд план');
      return;
    }
    const inlineApiKey = createTenantInlineApiKey.trim();
    const inlineApiSecret = createTenantInlineApiSecret.trim();
    const inlineApiPassphrase = createTenantInlineApiPassphrase.trim();
    if ((inlineApiKey && !inlineApiSecret) || (!inlineApiKey && inlineApiSecret)) {
      messageApi.error('Для нового API ключа заполните и API Key, и API Secret');
      return;
    }
    if (inlineApiKey && ['bitget', 'weex'].includes(String(createTenantInlineApiExchange || '').trim().toLowerCase()) && !inlineApiPassphrase) {
      messageApi.error('Для Bitget и WEEX укажите passphrase');
      return;
    }
    setActionLoading('createTenant');
    try {
      await axios.post('/api/saas/admin/tenants', {
        displayName: createTenantDisplayName,
        productMode: createTenantProductMode,
        planCode: createTenantPlanCode,
        algofundPlanCode: createTenantProductMode === 'dual' ? createTenantAlgofundPlanCode : undefined,
        assignedApiKeyName: createTenantApiKey || undefined,
        inlineApiKeyName: createTenantInlineApiKeyName.trim() || undefined,
        inlineApiKey: inlineApiKey || undefined,
        inlineApiSecret: inlineApiSecret || undefined,
        inlineApiPassphrase: inlineApiPassphrase || undefined,
        inlineApiExchange: createTenantInlineApiExchange || undefined,
        inlineApiSpeedLimit: createTenantInlineApiSpeedLimit || undefined,
        inlineApiTestnet: createTenantInlineApiTestnet,
        inlineApiDemo: createTenantInlineApiDemo,
        email: createTenantEmail || undefined,
        language,
      });
      messageApi.success(copy.createClientSuccess);
      setCreateTenantDisplayName('');
      setCreateTenantProductMode('strategy_client');
      setCreateTenantPlanCode('');
      setCreateTenantAlgofundPlanCode('');
      setCreateTenantApiKey('');
      setCreateTenantInlineApiKeyName('');
      setCreateTenantInlineApiKey('');
      setCreateTenantInlineApiSecret('');
      setCreateTenantInlineApiPassphrase('');
      setCreateTenantInlineApiExchange('bybit');
      setCreateTenantInlineApiSpeedLimit(10);
      setCreateTenantInlineApiTestnet(false);
      setCreateTenantInlineApiDemo(false);
      setCreateTenantEmail('');
      navigateToAdminTab('offer-ts');
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create tenant'));
    } finally {
      setActionLoading('');
    }
  };

  const doToggleTenantEnabled = async (tenantId: number, productMode: string, nextEnabled: boolean, displayName: string) => {
    setActionLoading(`monitor-toggle-${tenantId}`);
    try {
      if (productMode === 'strategy_client') {
        await axios.patch(`/api/saas/strategy-clients/${tenantId}`, { requestedEnabled: nextEnabled });
      } else {
        await axios.patch(`/api/saas/algofund/${tenantId}`, { requestedEnabled: nextEnabled });
      }
      messageApi.success(`Updated ${displayName}: requested ${nextEnabled ? 'ON' : 'OFF'}`);
      await loadSummary();
      if (activeTab === 'admin' && adminTab === 'monitoring') {
        await loadMonitoringTabData();
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to update requested status'));
    } finally {
      setActionLoading('');
    }
  };

  const toggleTenantRequestedEnabled = async (row: TenantSummary, nextEnabled: boolean) => {
    const tenantId = Number(row.tenant.id);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return;
    }

    // E1: При отключении — подтверждение с опцией архивации стратегий
    if (!nextEnabled) {
      Modal.confirm({
        title: `Отключить торговлю для ${row.tenant.display_name || row.tenant.slug}?`,
        content: (
          <Space direction="vertical" size={8}>
            <Text>Все открытые ордера будут отменены, позиции закрыты.</Text>
            <Text type="secondary">Стратегии клиента останутся в системе для возможного переподключения.</Text>
          </Space>
        ),
        okText: 'Отключить',
        okType: 'danger',
        cancelText: 'Отмена',
        onOk: () => doToggleTenantEnabled(tenantId, row.tenant.product_mode, false, row.tenant.display_name || row.tenant.slug),
      });
      return;
    }

    await doToggleTenantEnabled(tenantId, row.tenant.product_mode, nextEnabled, row.tenant.display_name || row.tenant.slug);
  };

  const resolveTenantRuntimeStatus = (row: TenantSummary) => {
    const profile = row.tenant.product_mode === 'strategy_client' ? row.strategyProfile : row.algofundProfile;
    const requestedEnabled = Number(profile?.requested_enabled || 0) === 1;
    const actualEnabled = Number(profile?.actual_enabled || 0) === 1;
    const apiKeyName = String(
      profile?.assigned_api_key_name
      || row.tenant.assigned_api_key_name
      || row.copytradingProfile?.master_api_key_name
      || ''
    ).trim();

    const hasMismatch = requestedEnabled !== actualEnabled;
    const level: 'success' | 'warning' | 'error' = hasMismatch
      ? 'error'
      : requestedEnabled
        ? 'success'
        : 'warning';

    const stateLabel = level === 'success' ? 'активен' : level === 'warning' ? 'выключен' : 'ошибка';
    const details = [
      `Тенант: ${row.tenant.status}`,
      `Торговля: ${requestedEnabled ? 'включена' : 'выключена'}`,
      `Движок: ${actualEnabled ? 'активен' : 'выключен'}`,
      apiKeyName ? `API key: ${apiKeyName}` : 'API key: не назначен',
      row.tenant.product_mode === 'algofund_client' && String(row.algofundProfile?.published_system_name || '').trim()
        ? `TS: ${String(row.algofundProfile?.published_system_name || '').trim()}`
        : '',
      hasMismatch ? 'Состояния торговли и движка расходятся: требуется проверка materialization/runtime.' : '',
    ].filter(Boolean).join(' | ');

    return {
      requestedEnabled,
      actualEnabled,
      level,
      stateLabel,
      details,
    };
  };

  const extractTenantBillingInfo = (row: TenantSummary) => {
    const raw = row as any;
    const status = String(raw?.billing?.status || raw?.paymentStatus || raw?.payment_status || '').trim();
    const daysRaw = raw?.billing?.daysToPayment ?? raw?.daysToPayment ?? raw?.days_to_payment;
    const daysToPayment = Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : null;

    if (!status && daysToPayment === null) {
      return {
        color: 'default' as const,
        label: 'n/a',
        details: 'Поля оплаты будут добавлены позже.',
      };
    }

    const normalized = status.toLowerCase();
    const color: 'success' | 'warning' | 'error' | 'default' =
      normalized.includes('paid') || normalized.includes('опла')
        ? 'success'
        : normalized.includes('due') || normalized.includes('ожида') || normalized.includes('pending')
          ? 'warning'
          : normalized.includes('overdue') || normalized.includes('error') || normalized.includes('проср')
            ? 'error'
            : 'default';

    return {
      color,
      label: status || 'n/a',
      details: daysToPayment !== null ? `До оплаты: ${daysToPayment} дн.` : 'Срок оплаты не указан.',
    };
  };

  const tenantColumns: ColumnsType<TenantSummary> = [
    {
      title: 'Клиент',
      key: 'tenant',
      width: 150,
      fixed: 'left',
      render: (_, row) => (
        <Tooltip title={`ID: ${row.tenant.id} • ${row.tenant.slug}`}>
          <Text strong style={{ fontSize: 12 }}>{row.tenant.display_name}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Тип',
      key: 'mode',
      width: 80,
      render: (_, row) => productModeTag(row.tenant.product_mode),
    },
    {
      title: 'Тариф',
      key: 'plan',
      width: 120,
      render: (_, row) => {
        if (!row.plan) return <Tag color="default">—</Tag>;
        const billing = extractTenantBillingInfo(row);
        return (
          <Tooltip title={`${row.plan.title} • ${billing.details}`}>
            <Space size={2} direction="vertical">
              <Text style={{ fontSize: 11 }}>{formatMoney(row.plan.price_usdt)}</Text>
              <Tag color={billing.color} style={{ fontSize: 10 }}>{billing.label}</Tag>
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: 'API',
      key: 'apiKey',
      width: 100,
      render: (_, row) => {
        const key = row.tenant.product_mode === 'strategy_client'
          ? row.strategyProfile?.assigned_api_key_name || row.tenant.assigned_api_key_name || ''
          : row.tenant.product_mode === 'algofund_client'
            ? row.algofundProfile?.assigned_api_key_name || row.tenant.assigned_api_key_name || ''
            : row.copytradingProfile?.master_api_key_name || row.tenant.assigned_api_key_name || '';
        return key ? <Text style={{ fontSize: 11 }}>{key}</Text> : <Text type="secondary">—</Text>;
      },
    },
    {
      title: 'Торговля',
      key: 'trading',
      width: 90,
      render: (_, row) => {
        const runtime = resolveTenantRuntimeStatus(row);
        return (
          <Tooltip title={runtime.details}>
            <Space size={2} direction="vertical" align="center">
              <Switch
                size="small"
                checked={runtime.requestedEnabled}
                loading={actionLoading === `monitor-toggle-${row.tenant.id}`}
                onChange={(checked) => { void toggleTenantRequestedEnabled(row, checked); }}
              />
              <Tag color={runtime.actualEnabled ? 'success' : 'default'} style={{ fontSize: 10 }}>{runtime.actualEnabled ? 'engine' : 'off'}</Tag>
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: 'Мониторинг',
      key: 'monitoring',
      width: 200,
      render: (_, row) => row.monitoring ? (
        <Space size={2} wrap>
          <Tag color="blue" style={{ fontSize: 10 }}>Eq {formatMoney(row.monitoring.equity_usd)}</Tag>
          <Tag color="geekblue" style={{ fontSize: 10 }}>PnL {formatMoney(row.monitoring.unrealized_pnl)}</Tag>
          <Tag color="orange" style={{ fontSize: 10 }}>DD {formatPercent(row.monitoring.drawdown_percent)}</Tag>
          {(() => {
            const liq = calcLiquidationRisk(row);
            return liq.level !== 'low' ? <Tag color={liq.color} style={{ fontSize: 10 }}>Liq: {liq.level}</Tag> : null;
          })()}
        </Space>
      ) : <Tag color="default" style={{ fontSize: 10 }}>no data</Tag>,
    },
    {
      title: 'ТС / Офер',
      key: 'classification',
      width: 180,
      render: (_, row) => {
        const selected = Array.isArray(row.strategyProfile?.selectedOfferIds)
          ? row.strategyProfile?.selectedOfferIds || []
          : [];
        const systemName = String(row.algofundProfile?.published_system_name || '').trim();
        if (selected.length === 0 && !systemName) return <Tag color="default" style={{ fontSize: 10 }}>нет офера</Tag>;
        return (
          <Space size={2} wrap>
            {selected.slice(0, 2).map((offerId) => (
              <Tag key={`${row.tenant.id}:${offerId}`} color="blue" style={{ fontSize: 10 }}>{offerTitleById[String(offerId)] || String(offerId)}</Tag>
            ))}
            {selected.length > 2 ? <Tag color="default" style={{ fontSize: 10 }}>+{selected.length - 2}</Tag> : null}
            {systemName ? <Tag color="purple" style={{ fontSize: 10 }}>{systemName.split('::').pop()}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: 'Действия',
      key: 'action',
      width: 200,
      fixed: 'right',
      render: (_, row) => {
        const openBtn = (label: string, onClick: () => void) => (
          <Button size="small" style={{ fontSize: 11, padding: '0 6px' }} onClick={onClick}>{label}</Button>
        );
        const deleteBtn = () => (
          <Button size="small" danger style={{ fontSize: 11, padding: '0 6px' }} onClick={() => {
            Modal.confirm({
              title: `Удалить клиента «${row.tenant.display_name}»?`,
              content: 'Профиль, API ключ и все данные будут удалены.',
              okText: 'Удалить',
              okType: 'danger',
              cancelText: 'Отмена',
              onOk: async () => {
                try {
                  await axios.delete(`/api/saas/admin/tenants/${row.tenant.id}`);
                  messageApi.success(`Клиент «${row.tenant.display_name}» удалён`);
                  void loadSummary('full');
                } catch (err: any) {
                  messageApi.error(String(err?.response?.data?.error || err.message || 'Ошибка'));
                }
              },
            });
          }}>Del</Button>
        );

        if (row.tenant.product_mode === 'strategy_client' || row.tenant.product_mode === 'dual') {
          return (
            <Space size={2} wrap>
              {openBtn('Strategy', () => { setStrategyTenantId(row.tenant.id); navigateSaasTab('strategy-client'); })}
              {deleteBtn()}
            </Space>
          );
        }
        if (row.tenant.product_mode === 'copytrading_client') {
          return (
            <Space size={2} wrap>
              {openBtn('Copy', () => { setCopytradingTenantId(row.tenant.id); navigateSaasTab('copytrading'); })}
              {deleteBtn()}
            </Space>
          );
        }
        if (row.tenant.product_mode === 'synctrade_client') {
          return (
            <Space size={2} wrap>
              {deleteBtn()}
            </Space>
          );
        }
        return (
          <Space size={2} wrap>
            {openBtn('AF', () => { setAlgofundTenantId(row.tenant.id); navigateSaasTab('algofund'); })}
            <Button size="small" type="primary" style={{ fontSize: 11, padding: '0 6px' }} loading={actionLoading === `algofund-single:${row.tenant.id}`} onClick={() => void runSingleAlgofundAction(Number(row.tenant.id), 'start')}>On</Button>
            <Button size="small" danger style={{ fontSize: 11, padding: '0 6px' }} loading={actionLoading === `algofund-single:${row.tenant.id}`} onClick={() => void runSingleAlgofundAction(Number(row.tenant.id), 'stop')}>Off</Button>
            <Button size="small" style={{ fontSize: 11, padding: '0 6px' }} disabled={!preferredClientSwitchTarget?.systemId} loading={actionLoading === `algofund-single:${row.tenant.id}`} onClick={() => void runSingleAlgofundAction(Number(row.tenant.id), 'switch_system', Number(preferredClientSwitchTarget?.systemId || 0))}>Sw</Button>
            {deleteBtn()}
          </Space>
        );
      },
    },
  ];

  const planColumns: ColumnsType<Plan> = [
    {
      title: 'Code',
      dataIndex: 'code',
      width: 130,
      render: (_, row) => <Text code>{row.code}</Text>,
    },
    {
      title: copy.plan,
      key: 'title',
      render: (_, row) => (
        <Input
          value={planDrafts[row.code]?.title || row.title}
          onChange={(event) => updatePlanDraft(row.code, { title: event.target.value })}
        />
      ),
    },
    {
      title: copy.priceUsdt,
      key: 'price',
      width: 150,
      render: (_, row) => (
        <InputNumber
          min={0}
          step={1}
          style={{ width: '100%' }}
          value={planDrafts[row.code]?.price_usdt ?? row.price_usdt}
          onChange={(value) => updatePlanDraft(row.code, { price_usdt: Number(value ?? 0) })}
        />
      ),
    },
    {
      title: copy.depositCap,
      key: 'deposit',
      width: 160,
      render: (_, row) => (
        <InputNumber
          min={0}
          step={100}
          style={{ width: '100%' }}
          value={planDrafts[row.code]?.max_deposit_total ?? row.max_deposit_total}
          onChange={(value) => updatePlanDraft(row.code, { max_deposit_total: Number(value ?? 0) })}
        />
      ),
    },
    {
      title: copy.riskCap,
      key: 'riskCap',
      width: 140,
      render: (_, row) => (
        <InputNumber
          min={0}
          step={0.1}
          style={{ width: '100%' }}
          value={planDrafts[row.code]?.risk_cap_max ?? row.risk_cap_max}
          onChange={(value) => updatePlanDraft(row.code, { risk_cap_max: Number(value ?? 0) })}
        />
      ),
    },
    {
      title: copy.strategyLimit,
      key: 'limit',
      width: 140,
      render: (_, row) => (
        <InputNumber
          min={0}
          step={1}
          style={{ width: '100%' }}
          value={planDrafts[row.code]?.max_strategies_total ?? row.max_strategies_total}
          onChange={(value) => updatePlanDraft(row.code, { max_strategies_total: Number(value ?? 0) })}
        />
      ),
    },
    {
      title: 'Start/Stop',
      key: 'allowStartStop',
      width: 130,
      render: (_, row) => (
        <Checkbox
          checked={Boolean(planDrafts[row.code]?.allow_ts_start_stop_requests ?? row.allow_ts_start_stop_requests)}
          onChange={(event) => updatePlanDraft(row.code, { allow_ts_start_stop_requests: event.target.checked ? 1 : 0 })}
        />
      ),
    },
    {
      title: 'Action',
      key: 'save',
      width: 140,
      render: (_, row) => (
        <Button
          type="primary"
          size="small"
          loading={actionLoading === `plan-${row.code}`}
          onClick={() => void savePlanDraft(row.code)}
        >
          {copy.savePlan}
        </Button>
      ),
    },
  ];

  const confirmResolveRequest = (row: AlgofundRequest, status: 'approved' | 'rejected') => {
    const actionText = status === 'approved' ? 'Approve' : 'Reject';
    const typeText = row.request_type === 'start'
      ? 'start'
      : row.request_type === 'stop'
        ? 'stop'
        : 'switch';

    Modal.confirm({
      title: `${actionText} ${typeText} request?`,
      content: row.note ? `Client note: ${row.note}` : undefined,
      okText: actionText,
      okType: status === 'approved' ? 'primary' : 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        await resolveRequest(row.id, status);
      },
    });
  };

  const requestColumns: ColumnsType<AlgofundRequest> = [
    {
      title: copy.requestTenant,
      key: 'tenant',
      width: 260,
      render: (_, row) => {
        const tenantName = String(row.tenant_display_name || algofundState?.tenant?.display_name || '').trim();
        const tenantSlug = String(row.tenant_slug || algofundState?.tenant?.slug || '').trim();

        if (tenantName && tenantSlug) {
          return `${tenantName} (${tenantSlug})`;
        }

        return tenantName || tenantSlug || '—';
      },
    },
    {
      title: 'ID',
      dataIndex: 'id',
      width: 80,
    },
    {
      title: copy.status,
      key: 'status',
      width: 140,
      render: (_, row) => requestStatusTag(copy, row.status),
    },
    {
      title: 'Type',
      key: 'type',
      width: 160,
      render: (_, row) => {
        if (row.request_type === 'start') {
          return copy.start;
        }
        if (row.request_type === 'stop') {
          return copy.stop;
        }
        const payload = parseAlgofundRequestPayload(row.request_payload_json);
        return payload.targetSystemName
          ? `Switch to ${payload.targetSystemName}`
          : payload.targetSystemId
            ? `Switch to #${payload.targetSystemId}`
            : 'Switch system';
      },
    },
    {
      title: copy.note,
      dataIndex: 'note',
    },
    {
      title: 'Result',
      key: 'result',
      width: 140,
      render: (_, row) => {
        if (row.status === 'pending') {
          return <Tag color="default">Pending</Tag>;
        }
        if (row.status === 'rejected') {
          return <Tag color="default">Rejected</Tag>;
        }
        if (row.status === 'approved') {
          const isBlocked = row.decision_note && row.decision_note.includes('Auto-note: approved without materialization');
          if (row.request_type === 'start') {
            if (isBlocked) {
              return <Tag color="red">Blocked</Tag>;
            }
            return <Tag color="success">Started</Tag>;
          }
          if (row.request_type === 'stop') {
            return <Tag color="green">Stopped</Tag>;
          }
          if (row.request_type === 'switch_system') {
            return <Tag color="cyan">Switched</Tag>;
          }
        }
        return <Tag color="default">—</Tag>;
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      width: 180,
    },
    {
      title: 'Action',
      key: 'action',
      width: 240,
      render: (_, row) => row.status === 'pending' ? (
        <Space wrap>
          <Button
            size="small"
            type="primary"
            loading={actionLoading === `approve-request-${row.id}`}
            onClick={() => {
              setApproveRequestPendingId(row.id);
              setApproveRequestModalVisible(true);
              setApproveRequestSelectedPlan('');
              setApproveRequestSelectedApiKey('');
            }}
          >
            {copy.approve}
          </Button>
          <Button
            size="small"
            danger
            loading={actionLoading === `resolve-${row.id}`}
            onClick={() => confirmResolveRequest(row, 'rejected')}
          >
            {copy.reject}
          </Button>
        </Space>
      ) : (
        row.decision_note || '—'
      ),
    },
  ];

  const strategyPreviewSummary = strategyPreview?.preview?.summary || (strategyPreview?.preview?.equity && !Array.isArray(strategyPreview.preview.equity)
    ? strategyPreview.preview.equity.summary
    : undefined);
  const strategyPreviewOffer = strategyPreview?.offer || (strategyPreview?.offerId ? (strategyState?.offers || []).find((offer) => offer.offerId === strategyPreview.offerId) || null : null);
  const strategyPreviewMetrics = strategyPreview?.preset?.metrics || strategyPreviewOffer?.metrics;
  const strategyPreviewPoints = strategyPreview?.preview ? toLineSeriesData(strategyPreview.preview.equity) : [];
  const strategySelectionPreviewSummary = strategySelectionPreview?.preview?.summary || undefined;
  const strategySelectionPreviewOffers = Array.isArray(strategySelectionPreview?.selectedOffers)
    ? (strategySelectionPreview?.selectedOffers || [])
    : [];
  const strategySelectionPreviewPoints = strategySelectionPreview?.preview ? toLineSeriesData(strategySelectionPreview.preview.equity) : [];
  const algofundPreviewPoints = algofundState?.preview ? toLineSeriesData(algofundState.preview.equityCurve) : [];
  const publishPreviewPoints = publishResponse?.preview ? toLineSeriesData(publishResponse.preview.equityCurve) : [];
  const strategyPreviewDerivedSummary = summarizeLineSeries(strategyPreviewPoints);
  const strategySelectionPreviewDerivedSummary = summarizeLineSeries(strategySelectionPreviewPoints);
  const algofundPreviewDerivedSummary = summarizeLineSeries(algofundPreviewPoints);
  const publishPreviewDerivedSummary = summarizeLineSeries(publishPreviewPoints);
  const summaryPeriod = summary?.sweepSummary?.period || null;
  const strategyPreviewPeriod = strategyPreview?.period || summaryPeriod;
  const strategySelectionPreviewPeriod = strategySelectionPreview?.period || summaryPeriod;
  const algofundPreviewPeriod = algofundState?.preview?.period || summaryPeriod;
  const publishPreviewPeriod = publishResponse?.preview?.period || summaryPeriod;
  const strategyPersistedRiskBucket = sliderValueToLevel(strategyRiskInput);
  const strategyPersistedTradeBucket = sliderValueToLevel(strategyTradeInput);
  const adminWizardCurrentStep = (() => {
    if (reviewableSweepOffers.length === 0 && Number(adminTradingSystemDraft?.members?.length || 0) === 0) {
      return 0;
    }

    if (adminWizardTarget === 'offer') {
      if (!wizardOfferCandidate) {
        return 1;
      }
      if (selectedAdminReviewKind !== 'offer') {
        return 1;
      }
      return 2;
    }

    if (selectedAdminReviewKind !== 'algofund-ts') {
      return 1;
    }
    return 2;
  })();
  const algofundEngineRunning = Boolean(algofundState?.profile?.actual_enabled);
  const algofundEnginePending = Boolean(algofundState?.profile?.requested_enabled) && !algofundEngineRunning;
  const algofundEngineBlockedReason = String(algofundState?.preview?.blockedReason || '').trim();
  const monitoringRows = (summary?.tenants || [])
    .filter((row) => monitoringModeFilter === 'all' || row.tenant.product_mode === monitoringModeFilter)
    .map((row) => {
      const profile = (row.tenant.product_mode === 'strategy_client' || row.tenant.product_mode === 'dual') ? row.strategyProfile : row.algofundProfile;
      const requestedEnabled = Number(profile?.requested_enabled || 0) === 1;
      const actualEnabled = Number(profile?.actual_enabled || 0) === 1;
      const apiKeyName = String(profile?.assigned_api_key_name || row.tenant.assigned_api_key_name || '').trim();
      const systems = monitoringSystemsByApiKey[apiKeyName] || [];
      const positionsDigest = monitoringPositionsByApiKey[apiKeyName] || { openCount: 0, symbols: [] };
      const strategiesDigest = monitoringStrategiesByApiKey[apiKeyName] || { total: 0, active: 0, activeAuto: 0, withLastError: 0 };
      const reconciliationDigest = monitoringReconciliationByApiKey[apiKeyName] || {
        reportCount: 0,
        strategyCount: 0,
        problematicCount: 0,
        avgSamples: 0,
        avgPnlDeltaPercent: null,
        avgWinRateDeltaPercent: null,
        latestAt: '',
      };
      const logNotes = monitoringLogCommentsByApiKey[apiKeyName] || [];
      const selectedSystemId = monitoringSystemSelected[row.tenant.id];
      const selectedSystem = systems.find((system) => Number(system.id) === Number(selectedSystemId)) || null;
      const liq = calcLiquidationRisk(row);
      const tenantPendingRequests = pendingAlgofundRequestsByTenant[row.tenant.id] || [];
      const comments: string[] = [];
      if (!apiKeyName) comments.push('Инфо: API key не назначен');
      if (requestedEnabled && !actualEnabled) comments.push('Торговля включена, но движок ещё не стартовал');
      if (tenantPendingRequests.length > 0) comments.push(`Pending requests: ${tenantPendingRequests.map((item) => `${item.request_type} #${item.id}`).join(', ')}`);
      if (actualEnabled && liq.level === 'high') comments.push('Высокий риск ликвидации');
      if (!row.monitoring) comments.push('Снимок мониторинга пока недоступен');
      if (strategiesDigest.active > 0 && strategiesDigest.activeAuto < strategiesDigest.active) {
        comments.push(`Reconciliation coverage неполная: auto_update ${strategiesDigest.activeAuto}/${strategiesDigest.active}`);
      }
      const lotHint = buildLotSizingHint(logNotes);
      if (lotHint) comments.push(lotHint);

      return {
        ...row,
        requestedEnabled,
        actualEnabled,
        apiKeyName,
        systems,
        positionsDigest,
        strategiesDigest,
        reconciliationDigest,
        logNotes,
        selectedSystem,
        tenantPendingRequests,
        comments: comments.join(' | ') || 'OK',
      };
    });

  const monitoringCrossReportRows = monitoringRows.map((row) => {
    const analyticsParts: string[] = [];
    if (row.monitoring) {
      analyticsParts.push(`Eq ${formatMoney(row.monitoring.equity_usd)}`);
      analyticsParts.push(`PnL ${formatMoney(row.monitoring.unrealized_pnl)}`);
      analyticsParts.push(`DD ${formatPercent(row.monitoring.drawdown_percent)}`);
    } else {
      analyticsParts.push('Monitoring snapshot: no data');
    }
    analyticsParts.push(`Open positions: ${row.positionsDigest.openCount}`);
    analyticsParts.push(`Recon reports: ${row.reconciliationDigest.reportCount}`);

    const clientsParts = [
      `${row.tenant.display_name} (${row.tenant.slug})`,
      row.tenant.product_mode,
    ];

    const correspondenceParts: string[] = [];
    correspondenceParts.push(`Active systems: ${row.systems.length}`);
    correspondenceParts.push(`Selected: ${row.selectedSystem?.name || '—'}`);
    correspondenceParts.push(`Strategies active/auto: ${row.strategiesDigest.active}/${row.strategiesDigest.activeAuto}`);
    correspondenceParts.push(`Recon strategy coverage: ${row.reconciliationDigest.strategyCount}`);
    correspondenceParts.push(`Symbols in positions: ${row.positionsDigest.symbols.join(', ') || '—'}`);

    const problems: string[] = [];
    if (!row.apiKeyName) {
      problems.push('API key не назначен (инфо)');
    }
    if (row.requestedEnabled && !row.actualEnabled) {
      problems.push('Торговля запрошена, но движок остановлен');
    }
    if (row.strategiesDigest.active > 0 && row.strategiesDigest.activeAuto < row.strategiesDigest.active) {
      problems.push('Не все активные стратегии участвуют в reconciliation');
    }
    if (row.reconciliationDigest.problematicCount > 0) {
      problems.push(`Есть стратегии с critical/pause рекомендациями: ${row.reconciliationDigest.problematicCount}`);
    }
    if (row.strategiesDigest.withLastError > 0) {
      problems.push(`Активные стратегии с last_error: ${row.strategiesDigest.withLastError}`);
    }

    const suggestions: string[] = [];
    if (row.strategiesDigest.active > 0 && row.strategiesDigest.activeAuto < row.strategiesDigest.active) {
      suggestions.push('Включить auto_update для активных стратегий ключа');
    }
    if (!telegramControls?.reconciliationCycleEnabled) {
      suggestions.push('Включить runtime.cycle.reconciliation.enabled');
    }
    if (row.requestedEnabled && !row.actualEnabled && row.apiKeyName) {
      suggestions.push('Проверить ключ и выполнить retry materialize/start');
    }
    if (row.reconciliationDigest.reportCount === 0 && row.strategiesDigest.activeAuto > 0) {
      suggestions.push('Запустить reconciliation/run вручную для первичного слепка');
    }

    return {
      key: row.tenant.id,
      card: `${row.apiKeyName || 'NO_KEY'} • ${row.tenant.display_name}`,
      analytics: analyticsParts.join(' | '),
      clients: clientsParts.join(' | '),
      correspondence: correspondenceParts.join(' | '),
      problems: problems.length > 0 ? problems.join(' | ') : '—',
      suggestions: suggestions.length > 0 ? suggestions.join(' | ') : '—',
    };
  });

  const monitoringColumns: ColumnsType<(typeof monitoringRows)[number]> = [
    {
      title: 'Client',
      key: 'tenant',
      width: 240,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{row.tenant.display_name}</Text>
          <Text type="secondary">{row.tenant.slug}</Text>
        </Space>
      ),
    },
    {
      title: 'Mode',
      key: 'mode',
      width: 130,
      render: (_, row) => productModeTag(row.tenant.product_mode),
    },
    {
      title: copy.apiKey,
      key: 'apiKey',
      width: 170,
      render: (_, row) => row.apiKeyName || '—',
    },
    {
      title: 'Включить торговлю',
      key: 'requested',
      width: 140,
      render: (_, row) => (
        <Tooltip title="Режим торговли включен: энгин запрошен о старте и должен быть активен. Выключено: клиент не торгует.">
          <Switch
            size="small"
            checked={row.requestedEnabled}
            loading={actionLoading === `monitor-toggle-${row.tenant.id}`}
            onChange={(checked) => {
              void toggleTenantRequestedEnabled(row, checked);
            }}
          />
        </Tooltip>
      ),
    },
    {
      title: 'Engine',
      key: 'engine',
      width: 120,
      render: (_, row) => row.actualEnabled ? <Tag color="success">running</Tag> : <Tag color="default">stopped</Tag>,
    },
    {
      title: 'Monitoring',
      key: 'monitoring',
      width: 250,
      render: (_, row) => row.monitoring ? (
        <Space size={4} wrap>
          <Tag color="blue">Eq {formatMoney(row.monitoring.equity_usd)}</Tag>
          <Tag color="geekblue">PnL {formatMoney(row.monitoring.unrealized_pnl)}</Tag>
          <Tag color="orange">DD {formatPercent(row.monitoring.drawdown_percent)}</Tag>
        </Space>
      ) : <Tag color="default">no data</Tag>,
    },
    {
      title: 'Approved systems',
      key: 'systems',
      width: 360,
      render: (_, row) => {
        const options = row.systems.map((system) => ({
          value: Number(system.id),
          label: `${system.name}${system.is_active ? ' [active]' : ''} В· PnL ${formatMoney(system.metrics?.unrealized_pnl)} В· DD ${formatPercent(system.metrics?.drawdown_percent)}`,
        }));

        return (
          <Space>
            <Select
              style={{ width: 280 }}
              value={row.selectedSystem?.id ? Number(row.selectedSystem.id) : undefined}
              onChange={(value) => {
                setMonitoringSystemSelected((current) => ({ ...current, [row.tenant.id]: Number(value) }));
              }}
              options={options}
              placeholder="No systems"
              allowClear
            />
            <Button
              size="small"
              onClick={() => openTenantWorkspace(row)}
            >
              Открыть в SaaS
            </Button>
          </Space>
        );
      },
    },
    {
      title: 'Comment',
      key: 'comment',
      render: (_, row) => row.comments,
    },
    {
      title: 'Charts',
      key: 'charts',
      width: 120,
      render: (_, row) => (
        <Button
          size="small"
          disabled={!row.apiKeyName}
          onClick={() => {
            void openMonitoringChart(row.apiKeyName);
          }}
        >
          Open chart
        </Button>
      ),
    },
    {
      title: 'Log notes',
      key: 'logNotes',
      width: 360,
      render: (_, row) => row.logNotes.length > 0 ? row.logNotes.join(' | ') : '—',
    },
  ];

  return (
    <div className="saas-page">
      {contextHolder}
      <Card className="battletoads-card" bordered={false}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} lg={15}>
            <Title level={3} style={{ marginTop: 0, marginBottom: 8 }}>{copy.title}</Title>
            <Paragraph style={{ marginBottom: 0 }}>{copy.subtitle}</Paragraph>
          </Col>
          <Col xs={24} lg={9}>
            <Space wrap className="saas-page-actions">
              <Button onClick={() => void loadSummary()} loading={summaryLoading}>{copy.refresh}</Button>
              {isAdminSurface ? <Button onClick={() => void seedDemoTenants()} loading={actionLoading === 'seed'}>{copy.seed}</Button> : null}
              {isAdminSurface ? <Button type="dashed" onClick={() => navigateToAdminTab('create-user')}>{copy.createClient}</Button> : null}
              {isAdminSurface ? <Button type="primary" onClick={() => void publishAdminTs()} loading={actionLoading === 'publish'}>{copy.publish}</Button> : null}
            </Space>
          </Col>
        </Row>
      </Card>

      {summaryError ? <Alert style={{ marginTop: 16 }} type="error" message={summaryError} showIcon /> : null}

      <Spin spinning={summaryLoading && !summary}>
        <Tabs
          className="saas-tabs"
          destroyOnHidden
          activeKey={activeTab}
          onChange={(key) => {
            const next = key as SaasTabKey;
            if (next === 'admin') {
              navigateToAdminTab(adminTab);
            } else {
              navigateSaasTab(next);
            }
          }}
          items={[
            {
              key: 'admin',
              label: copy.admin,
              children: (
                <Tabs
                  destroyOnHidden
                  activeKey={adminTab}
                  onChange={(key) => {
                    const nextKey = key as AdminTabKey;
                    navigateToAdminTab(nextKey);
                    if (nextKey === 'offer-ts') {
                      void loadSummary('full');
                    }
                  }}
                  items={[
                    {
                      key: 'offer-ts',
                      label: 'Оферы и ТС',
                      children: (
                        <Space direction="vertical" size={16} style={{ width: '100%' }}>
                          {!summary?.catalog ? <Alert type="warning" showIcon message={copy.noCatalog} /> : null}
                          {!summary?.sweepSummary ? <Alert type="warning" showIcon message={copy.noSweep} /> : null}
                          {summaryPeriod ? <Alert type="info" showIcon message={`${copy.period}: ${formatPeriodLabel(summaryPeriod)}`} /> : null}
                          {summary?.catalog?.apiKeyName ? (
                            <Alert
                              type="success"
                              showIcon
                              message={`Каталог из sweep · ${String(summary.catalog.timestamp || '').slice(0, 16).replace('T', ' ')} UTC · ${summary.catalog.counts?.monoCatalog || 0} mono + ${summary.catalog.counts?.synthCatalog || 0} synth оферов · draft TS: ${summary.catalog.adminTradingSystemDraft?.members?.length || 0} стратегий`}
                            />
                          ) : null}

                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={8}>
                              <Card className="battletoads-card">
                                <Statistic title={copy.latestCatalog} value={summary?.catalog?.counts?.monoCatalog || 0} suffix={`mono / ${summary?.catalog?.counts?.synthCatalog || 0} synth`} />
                                <Space direction="vertical" size={2}>
                                  <Text type="secondary">{String(summary?.catalog?.timestamp || '').slice(0, 16).replace('T', ' ') || summary?.sourceFiles?.latestCatalogPath || 'results/*.json not found'}</Text>
                                </Space>
                              </Card>
                            </Col>
                            <Col xs={24} md={8}>
                              <Card className="battletoads-card">
                                <Statistic title={copy.latestSweep} value={summary?.sweepSummary?.counts?.evaluated || 0} suffix={`/ ${summary?.sweepSummary?.counts?.scheduledRuns || 0}`} />
                                <Text type="secondary">{summary?.sourceFiles?.latestSweepPath || 'results/*.json not found'}</Text>
                              </Card>
                            </Col>
                            <Col xs={24} md={8}>
                              <Card className="battletoads-card">
                                <Statistic title={copy.adminTsDraft} value={summary?.catalog?.adminTradingSystemDraft?.members?.length || 0} suffix="members" />
                                <Text type="secondary">{summary?.catalog?.adminTradingSystemDraft?.name || '—'}</Text>
                              </Card>
                            </Col>
                          </Row>

                          <Card className="battletoads-card" title="Pipeline: Sweep → Backtest → Storefront">
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                              <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 0 }}>
                                Жесткий путь без параллельных веток: сначала обнови sweep-кандидаты, затем backtest, затем публикация на витрину, затем применение к клиентам.
                              </Paragraph>
                              <Space wrap>
                                <Select
                                  value={adminWizardTarget}
                                  style={{ width: 260 }}
                                  options={[
                                    { value: 'offer', label: 'Поток оффера на витрину' },
                                    { value: 'algofund-ts', label: 'Поток ТС Алгофонда' },
                                  ]}
                                  onChange={(value) => setAdminWizardTarget(value)}
                                />
                                <Tag color="blue">шаг 1: sweep</Tag>
                                <Tag color="purple">шаг 2: backtest</Tag>
                                <Tag color="success">шаг 3: storefront</Tag>
                                <Tag color="geekblue">шаг 4: apply clients</Tag>
                              </Space>
                              <Steps
                                size="small"
                                current={adminWizardCurrentStep}
                                items={[
                                  { title: 'Sweep', description: reviewableSweepOffers.length > 0 ? `${reviewableSweepOffers.length} кандидатов` : 'кандидаты не загружены' },
                                  { title: 'Backtest', description: adminWizardTarget === 'offer' ? (wizardOfferCandidate ? `offer #${wizardOfferCandidate.offerId}` : 'оффер не выбран') : `draft TS members: ${Number(adminTradingSystemDraft?.members?.length || 0)}` },
                                  { title: 'Storefront', description: adminWizardTarget === 'offer' ? 'на витрину офферов' : 'на витрину ТС Алгофонда' },
                                  { title: 'Apply', description: 'применить опубликованное к клиентам' },
                                ]}
                              />
                              <Space wrap>
                                <Button size="small" loading={actionLoading === 'load-sweep-review'} onClick={() => void loadSweepReviewCandidates()}>
                                  1) Обновить из sweep
                                </Button>
                                <Button size="small" onClick={openWizardReviewStep}>
                                  2) Открыть детали
                                </Button>
                                <Button size="small" onClick={openWizardBacktestStep}>
                                  3) Открыть backtest
                                </Button>
                                <Button
                                  type="primary"
                                  size="small"
                                  disabled={adminWizardTarget === 'offer' ? !wizardOfferCandidate : Number(adminTradingSystemDraft?.members?.length || 0) === 0}
                                  loading={actionLoading === 'publish' || actionLoading === `offer-store:${String(wizardOfferCandidate?.offerId || '')}`}
                                  onClick={() => void publishFromWizard()}
                                >
                                  4) На витрину
                                </Button>
                              </Space>
                            </Space>
                          </Card>

                          <Card className="battletoads-card" title="Кандидаты из sweep: Оферы и ТС" style={{ display: 'none' }}>
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                              <Space wrap>
                                <Text strong>Что показывать:</Text>
                                <Segmented
                                  value={adminSweepListMode}
                                  options={[
                                    { value: 'offers', label: 'Оферы' },
                                    { value: 'ts', label: 'ТС-наборы' },
                                  ]}
                                  onChange={(value) => setAdminSweepListMode(String(value) === 'ts' ? 'ts' : 'offers')}
                                />
                                <Tag color="default">offers: {reviewableSweepOffers.length}</Tag>
                                <Tag color="processing">ts sets: {adminSweepTsSetsAll.length}</Tag>
                              </Space>

                              {adminSweepListMode === 'offers' ? (
                                <Table
                                  size="small"
                                  rowKey="offerId"
                                  dataSource={reviewableSweepOffers}
                                  pagination={{ pageSize: 8, showSizeChanger: false }}
                                  columns={[
                                    {
                                      title: 'Карточка',
                                      key: 'offer',
                                      render: (_, row: any) => (
                                        <Space direction="vertical" size={0}>
                                          <Space>
                                            <Badge
                                              status={row.published ? 'success' : Number(row.ret || 0) >= 1 ? 'processing' : 'default'}
                                              title={row.published ? 'На витрине' : Number(row.ret || 0) >= 1 ? 'Хороший кандидат' : 'Кандидат'}
                                            />
                                            <Text strong>{row.titleRu}</Text>
                                            {row.published ? <Tag color="success" style={{ marginLeft: 2 }}>витрина</Tag> : null}
                                          </Space>
                                          <Text type="secondary" style={{ paddingLeft: 16 }}>{String(row.mode || '').toUpperCase()} • {row.market}</Text>
                                          <Text type="secondary" style={{ paddingLeft: 16 }}>group: {String(row.groupLabel || '—')}</Text>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Метрики',
                                      key: 'metrics',
                                      render: (_, row: any) => (
                                        <Space wrap>
                                          <Tag color="geekblue">{String(row.groupLabel || 'group')}</Tag>
                                          <Tag color={metricColor(Number(row.ret || 0), 'return')}>Ret {formatPercent(row.ret)}</Tag>
                                          <Tag color={metricColor(Number(row.dd || 0), 'drawdown')}>DD {formatPercent(row.dd)}</Tag>
                                          <Tag color={metricColor(Number(row.pf || 0), 'pf')}>PF {formatNumber(row.pf)}</Tag>
                                          <Tag color="blue">tpd {formatNumber(row.tradesPerDay, 2)}</Tag>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Действия',
                                      key: 'actions',
                                      width: 280,
                                      render: (_, row: any) => (
                                        <Space wrap>
                                          <Button
                                            size="small"
                                            onClick={() => {
                                              setSelectedAdminReviewKind('offer');
                                              setSelectedAdminReviewOfferId(String(row.offerId));
                                            }}
                                          >
                                            Выбрать офер
                                          </Button>
                                          <Button size="small" type="primary" onClick={() => openOfferBacktest(row)}>
                                            Бэктест
                                          </Button>
                                        </Space>
                                      ),
                                    },
                                  ]}
                                />
                              ) : (
                                <List
                                  size="small"
                                  dataSource={adminSweepTsSetsAll}
                                  locale={{ emptyText: <Empty description="Sweep TS-наборы пока не найдены" /> }}
                                  renderItem={(set) => (
                                    <List.Item
                                      actions={[
                                        <Button
                                          key="pick"
                                          size="small"
                                          onClick={() => {
                                            const offerIds = (Array.isArray(set.offerIds) ? set.offerIds : []).map((item) => String(item || '')).filter(Boolean);
                                            setSelectedAdminDraftTsOfferIds(offerIds);
                                            setSelectedAdminDraftTsSetKey(String(set.snapshotKey || '').trim());
                                            setSelectedAdminReviewKind('algofund-ts');
                                            messageApi.success(`Выбран TS-набор ${set.displayName}: ${set.offerCount} карточек`);
                                          }}
                                        >
                                          Выбрать ТС-набор
                                        </Button>,
                                        <Button
                                          key="bt"
                                          type="primary"
                                          size="small"
                                          onClick={() => {
                                            const offerIds = (Array.isArray(set.offerIds) ? set.offerIds : []).map((item) => String(item || '')).filter(Boolean);
                                            setSelectedAdminDraftTsOfferIds(offerIds);
                                            setSelectedAdminDraftTsSetKey(String(set.snapshotKey || '').trim());
                                            openDraftTsBacktest({
                                              setKey: String(set.snapshotKey || '').trim() || undefined,
                                              offerIds,
                                              systemName: String((set as any).systemName || set.displayName || '').trim() || undefined,
                                            });
                                          }}
                                        >
                                          Бэктест ТС
                                        </Button>,
                                        <Button
                                          key="delete-db"
                                          danger
                                          size="small"
                                          loading={removeStorefrontTarget === set.displayName}
                                          disabled={Boolean(set.isDraft)}
                                          onClick={() => {
                                            void initiateRemoveStorefront(String(set.displayName || '').trim());
                                          }}
                                        >
                                          Снять с витрины
                                        </Button>,
                                      ]}
                                    >
                                      <Space wrap>
                                        <Badge
                                          status={Number(set.avgRet || 0) >= 1 ? 'processing' : 'default'}
                                          title={Number(set.avgRet || 0) >= 1 ? 'Хороший набор' : 'Набор кандидатов'}
                                        />
                                        <Text strong>{set.displayName}</Text>
                                        {set.isDraft ? <Tag color="gold">draft</Tag> : (set as any).isSnapshot ? <Tag color="cyan">snapshot</Tag> : null}
                                        <Tag color="processing">offers {set.offerCount}</Tag>
                                        <Tag color={metricColor(Number(set.avgRet || 0), 'return')}>avg Ret {formatPercent(set.avgRet)}</Tag>
                                        <Tag color={metricColor(Number(set.avgDd || 0), 'drawdown')}>avg DD {formatPercent(set.avgDd)}</Tag>
                                        <Tag color={metricColor(Number(set.avgPf || 0), 'pf')}>avg PF {formatNumber(set.avgPf)}</Tag>
                                      </Space>
                                    </List.Item>
                                  )}
                                />
                              )}
                            </Space>
                          </Card>

                          <div ref={reviewContextRef}>
                          <Card className="battletoads-card" title="Детали и публикация выбранного" style={{ display: 'none' }}>
                            {selectedAdminReviewKind === 'algofund-ts' ? (
                              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                <Paragraph type="secondary" style={{ marginTop: 0 }}>
                                  Здесь полный workflow по ТС Алгофонда после sweep: просмотр состава и метрик, запуск бэктеста, публикация ТС на витрину, затем применение к клиентам Алгофонда.
                                </Paragraph>
                                <Space wrap>
                                  <Tag color={publishResponse?.sourceSystem ? 'success' : 'processing'}>{publishResponse?.sourceSystem ? 'runtime TS ready' : 'draft from sweep'}</Tag>
                                  <Tag color="processing">members: {Number(adminTradingSystemDraft?.members?.length || 0)}</Tag>
                                  <Tag color="blue">{adminTradingSystemDraft?.name || 'Admin TS draft'}</Tag>
                                  {publishResponse?.sourceSystem?.systemId ? <Tag color="geekblue">system #{publishResponse.sourceSystem.systemId}</Tag> : null}
                                  {publishResponse?.preview?.summary ? <Tag color={metricColor(Number(publishResponse.preview.summary.totalReturnPercent || 0), 'return')}>Ret {formatPercent(publishResponse.preview.summary.totalReturnPercent)}</Tag> : null}
                                  {publishResponse?.preview?.summary ? <Tag color={metricColor(Number(publishResponse.preview.summary.maxDrawdownPercent || 0), 'drawdown')}>DD {formatPercent(publishResponse.preview.summary.maxDrawdownPercent)}</Tag> : null}
                                  {publishResponse?.preview?.summary ? <Tag color={metricColor(Number(publishResponse.preview.summary.profitFactor || 0), 'pf')}>PF {formatNumber(publishResponse.preview.summary.profitFactor)}</Tag> : null}
                                </Space>
                                {publishResponse?.sourceSystem ? (
                                  <Descriptions column={1} size="small" bordered>
                                    <Descriptions.Item label="Runtime TS">{publishResponse.sourceSystem.systemName}</Descriptions.Item>
                                    <Descriptions.Item label="Следующий шаг">Открой шаг применения клиентам Алгофонда и выполни switch_system на этот runtime TS</Descriptions.Item>
                                  </Descriptions>
                                ) : null}
                                <List
                                  dataSource={adminDraftMembersDetailed}
                                  locale={{ emptyText: <Empty description="Sweep еще не подготовил draft ТС для review" /> }}
                                  renderItem={(member, index) => (
                                    <List.Item>
                                      <Space direction="vertical" size={0}>
                                        <Text strong>{member.strategyName}</Text>
                                        <Text type="secondary">{member.marketMode.toUpperCase()} • {member.market}</Text>
                                      </Space>
                                      <Space wrap>
                                        <Tag color={index < 3 ? 'geekblue' : 'default'}>{index < 3 ? 'core' : 'satellite'}</Tag>
                                        <Tag color="cyan">score {formatNumber(member.score)}</Tag>
                                        <Tag color="purple">w {formatNumber(member.weight)}</Tag>
                                        {member.reviewRecord ? <Tag color={metricColor(Number(member.reviewRecord.totalReturnPercent || 0), 'return')}>Ret {formatPercent(member.reviewRecord.totalReturnPercent)}</Tag> : null}
                                        {member.reviewRecord ? <Tag color={metricColor(Number(member.reviewRecord.maxDrawdownPercent || 0), 'drawdown')}>DD {formatPercent(member.reviewRecord.maxDrawdownPercent)}</Tag> : null}
                                        {member.reviewRecord ? <Tag color={metricColor(Number(member.reviewRecord.profitFactor || 0), 'pf')}>PF {formatNumber(member.reviewRecord.profitFactor)}</Tag> : null}
                                      </Space>
                                    </List.Item>
                                  )}
                                />
                                <Space wrap>
                                  <Button type="primary" onClick={() => void publishAdminTs()} loading={actionLoading === 'publish'}>На витрину ТС</Button>
                                  <Button size="small" onClick={openBacktestDrawerForAdminTs}>Открыть бэктест ТС</Button>
                                  <Button size="small" onClick={() => setBatchTenantIds(batchEligibleAlgofundTenants.map((item) => Number(item.tenant.id)).filter((item) => item > 0))}>Выбрать всех algofund-клиентов</Button>
                                  <Button size="small" disabled={!publishResponse?.sourceSystem?.systemId} onClick={openPublishedAdminTsForClients}>Применить к клиентам Алгофонда</Button>
                                  <Button size="small" disabled={!publishResponse?.sourceSystem?.systemId || batchTenantIds.length === 0} loading={actionLoading === 'apply-published-admin-ts'} onClick={() => void applyPublishedAdminTsToSelectedClients()}>
                                    Применить к выбранным ({batchTenantIds.length})
                                  </Button>
                                </Space>
                              </Space>
                            ) : selectedAdminReviewOffer ? (
                              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                {(() => {
                                  const equityPoints = Array.isArray(selectedAdminReviewOffer.equityPoints) ? selectedAdminReviewOffer.equityPoints : [];
                                  return (
                                    <>
                                <Space wrap>
                                  <Tag color={selectedAdminReviewOffer.published ? 'success' : 'processing'}>{selectedAdminReviewOffer.published ? 'on storefront' : 'not on storefront'}</Tag>
                                  <Tag color="blue">offer #{selectedAdminReviewOffer.offerId}</Tag>
                                  <Tag>{selectedAdminReviewOffer.mode.toUpperCase()}</Tag>
                                  <Tag>{selectedAdminReviewOffer.market}</Tag>
                                </Space>
                                <Descriptions column={1} size="small" bordered>
                                  <Descriptions.Item label="Карточка">{selectedAdminReviewOffer.titleRu}</Descriptions.Item>
                                  <Descriptions.Item label="Период">{Number(selectedAdminReviewOffer.periodDays || 0)}d</Descriptions.Item>
                                  <Descriptions.Item label="Return">{formatPercent(selectedAdminReviewOffer.ret)}</Descriptions.Item>
                                  <Descriptions.Item label="Drawdown">{formatPercent(selectedAdminReviewOffer.dd)}</Descriptions.Item>
                                  <Descriptions.Item label="Profit factor">{formatNumber(selectedAdminReviewOffer.pf)}</Descriptions.Item>
                                  <Descriptions.Item label="Trades/day">{formatNumber(selectedAdminReviewOffer.tradesPerDay, 2)}</Descriptions.Item>
                                </Descriptions>
                                {equityPoints.length > 0 ? (
                                  <ChartComponent data={(() => { const nowSec = Math.floor(Date.now() / 1000); const dayS = 86400; const startSec = nowSec - (equityPoints.length - 1) * dayS; return equityPoints.map((value, index) => ({ time: startSec + index * dayS, equity: value })); })()} type="line" />
                                ) : (
                                  <Empty description="Для этой карточки пока нет equity-кривой" />
                                )}
                                <Space wrap>
                                  <Button
                                    type="primary"
                                    size="small"
                                    loading={actionLoading === `offer-store:${String(selectedAdminReviewOffer.offerId)}`}
                                    onClick={() => void toggleOfferPublished(String(selectedAdminReviewOffer.offerId), true)}
                                  >
                                    {selectedAdminReviewOffer.published ? 'Обновить витрину' : 'На витрину'}
                                  </Button>
                                  <Button size="small" onClick={() => openOfferBacktest(selectedAdminReviewOffer)}>
                                    Открыть бэктест оффера
                                  </Button>
                                  {selectedAdminReviewOffer.published ? <Button size="small" danger onClick={() => void openUnpublishWizard(String(selectedAdminReviewOffer.offerId))}>Снять с витрины</Button> : null}
                                </Space>
                                    </>
                                  );
                                })()}
                              </Space>
                            ) : (
                              <Empty description="Выбери карточку из списка sweep или витрины для бэктеста" />
                            )}
                          </Card>
                          </div>

                          <Card className="battletoads-card" title="Оферы и ТС на витринах">
                            <Paragraph type="secondary" style={{ marginTop: 0 }}>
                              Здесь только опубликованные оферы и ТС. Чтобы пересчитать или перепубликовать, выбери офер или ТС-набор выше.
                            </Paragraph>
                            <Space wrap style={{ marginBottom: 12 }}>
                              <Tag color="processing">storefront offers: {publishedStorefrontOffers.length}</Tag>
                              <Tag color="gold">waitlist offers: {researchCandidateOffers.length}</Tag>
                              <Tag color="blue">period: {Number(summary?.offerStore?.defaults?.periodDays || 0)}d</Tag>
                              <Tag color="geekblue">target: {Number(summary?.offerStore?.defaults?.targetTradesPerDay || 0)}/day</Tag>
                            </Space>
                            <Space wrap style={{ marginBottom: 16 }}>
                              <Button
                                size="small"
                                onClick={() => {
                                  const firstStorefrontTs = algofundStorefrontSystems[0] || null;
                                  if (firstStorefrontTs?.systemName) {
                                    openBacktestDrawerForStorefrontTs(firstStorefrontTs.systemName);
                                    return;
                                  }
                                  openDraftTsBacktest();
                                }}
                              >
                                Открыть бэктест ТС
                              </Button>
                            </Space>

                            <Row gutter={[16, 16]}>
                              <Col xs={24} lg={12}>
                                <Card className="battletoads-card" size="small" title="Витрина оферов клиентов стратегий">
                                  {publishedStorefrontOffers.length === 0 ? (
                                    <Empty description="Пока на витрине нет оферов" />
                                  ) : (
                                    <Table
                                      size="small"
                                      rowKey="offerId"
                                      dataSource={publishedStorefrontOffers}
                                      pagination={{ pageSize: 6, showSizeChanger: false }}
                                      scroll={{ x: 900 }}
                                      columns={[
                                        {
                                          title: 'Офер',
                                          key: 'offer',
                                          width: 380,
                                          render: (_, row: any) => (
                                            <Space direction="vertical" size={0}>
                                              <Text strong>{row.titleRu}</Text>
                                              <Text type="secondary">{String(row.mode || '').toUpperCase()} • {row.market}</Text>
                                            </Space>
                                          ),
                                        },
                                        {
                                          title: 'Метрики',
                                          key: 'metrics',
                                          render: (_, row: any) => (
                                            <Space wrap>
                                              <Tag color={metricColor(Number(row.ret || 0), 'return')}>Ret {formatPercent(row.ret)}</Tag>
                                              <Tag color={metricColor(Number(row.dd || 0), 'drawdown')}>DD {formatPercent(row.dd)}</Tag>
                                              <Tag color={metricColor(Number(row.pf || 0), 'pf')}>PF {formatNumber(row.pf)}</Tag>
                                              <Tag color={Number(row.connectedClients || 0) > 0 ? 'cyan' : 'default'}>clients {Number(row.connectedClients || 0)}</Tag>
                                              <Tag color={Boolean(row.published) ? 'success' : 'warning'}>{Boolean(row.published) ? '✓ На витрине' : '⊘ Не на витрине'}</Tag>
                                            </Space>
                                          ),
                                        },
                                        {
                                          title: 'Действия',
                                          key: 'actions',
                                          width: 220,
                                          render: (_, row: any) => (
                                            <Space wrap>
                                              <Button
                                                size="small"
                                                onClick={() => {
                                                  openOfferBacktest(row);
                                                }}
                                              >
                                                Бэктест
                                              </Button>
                                              <Button
                                                size="small"
                                                danger
                                                loading={actionLoading === `offer-store:${String(row.offerId || '')}`}
                                                onClick={() => {
                                                  void openUnpublishWizard(String(row.offerId || ''));
                                                }}
                                              >
                                                Снять с витрины
                                              </Button>
                                            </Space>
                                          ),
                                        },
                                      ]}
                                    />
                                  )}
                                </Card>
                              </Col>
                              <Col xs={24} lg={12}>
                                <Card className="battletoads-card" size="small" title="Витрина ТС Алгофонда">
                                  {algofundStorefrontSystems.length === 0 ? (
                                    <Empty description="Пока нет опубликованной ТС Алгофонда на витрине" />
                                  ) : (
                                    <List
                                      dataSource={algofundStorefrontSystems}
                                      renderItem={(item) => (
                                        <List.Item
                                          actions={[
                                            <Button key="review" size="small" onClick={() => openBacktestDrawerForStorefrontTs(item.systemName)}>Бэктест ТС</Button>,
                                            <Button
                                              key="connect"
                                              size="small"
                                              onClick={() => {
                                                const runtimeSystemId = Number(item.runtimeSystemId || 0);
                                                if (!runtimeSystemId) {
                                                  messageApi.warning('Для этой карточки пока нет runtime system id. Сначала опубликуйте/синхронизируйте ТС.');
                                                  return;
                                                }
                                                const initialIds = (item.tenants || [])
                                                    .map((tenant) => Number(tenant?.tenant?.id || 0))
                                                    .filter((tenantId) => Number.isFinite(tenantId) && tenantId > 0);
                                                setStorefrontConnectTarget({
                                                  systemId: runtimeSystemId,
                                                  systemName: item.systemName,
                                                  tenantIds: initialIds,
                                                  originalTenantIds: initialIds,
                                                });
                                              }}
                                            >
                                              Подключить клиентов
                                            </Button>,
                                            <Button
                                              key="remove-storefront"
                                              danger
                                              size="small"
                                              loading={removeStorefrontTarget === item.systemName}
                                              onClick={() => void initiateRemoveStorefront(item.systemName)}
                                            >
                                              Снять с витрины
                                            </Button>,
                                          ]}
                                        >
                                          <List.Item.Meta
                                            title={
                                              <Space wrap>
                                                <Tooltip title={getTsStrategyHint(item.systemName) ?? undefined} placement="topLeft"><Text strong style={{ cursor: getTsStrategyHint(item.systemName) ? 'help' : undefined }}>{tsDisplayName(item.systemName)}</Text></Tooltip>
                                                {item.runtimeSystemId ? <Tag color="geekblue">system #{item.runtimeSystemId}</Tag> : null}
                                                <Tag color="processing">clients {item.tenantCount}</Tag>
                                                <Tag color="success">active {item.activeCount}</Tag>
                                                {item.pendingCount > 0 ? <Tag color="warning">pending {item.pendingCount}</Tag> : null}
                                                {item.summary ? <Tag color={metricColor(Number(item.summary.totalReturnPercent || 0), 'return')}>Ret {formatPercent(item.summary.totalReturnPercent)}</Tag> : null}
                                                {item.summary ? <Tag color={metricColor(Number(item.summary.maxDrawdownPercent || 0), 'drawdown')}>DD {formatPercent(item.summary.maxDrawdownPercent)}</Tag> : null}
                                                {item.summary ? <Tag color={metricColor(Number(item.summary.profitFactor || 0), 'pf')}>PF {formatNumber(item.summary.profitFactor)}</Tag> : null}
                                                {item.summary?.tradesCount !== undefined ? <Tag color="blue">trades {formatNumber(item.summary.tradesCount, 0)}</Tag> : null}
                                              </Space>
                                            }
                                            description={
                                            <Space wrap size={4} style={{ fontSize: 11 }}>
                                              {item.tenants.length > 0
                                                ? item.tenants.map((tenant) => {
                                                    const isActive = Number(tenant.algofundProfile?.actual_enabled || 0) === 1;
                                                    return (
                                                      <Tag key={tenant.tenant.id} color={isActive ? 'success' : 'default'} style={{ fontSize: 11 }}>
                                                        {tenant.tenant.display_name}{!isActive ? ' · стоп' : ''}
                                                      </Tag>
                                                    );
                                                  })
                                                : <Text type="secondary" style={{ fontSize: 11 }}>нет подключённых клиентов</Text>}
                                            </Space>
                                          }
                                          />
                                        </List.Item>
                                      )}
                                    />
                                  )}
                                </Card>
                              </Col>
                            </Row>

                          </Card>
                          {summary?.sweepSummary?.portfolioFull ? (
                            <Row gutter={[16, 16]}>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.returnLabel} value={Number(summary.sweepSummary.portfolioFull.summary?.totalReturnPercent || 0)} precision={2} suffix="%" /></Card></Col>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.drawdown} value={Number(summary.sweepSummary.portfolioFull.summary?.maxDrawdownPercent || 0)} precision={2} suffix="%" /></Card></Col>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.profitFactor} value={Number(summary.sweepSummary.portfolioFull.summary?.profitFactor || 0)} precision={2} /></Card></Col>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.trades} value={Number(summary.sweepSummary.portfolioFull.summary?.tradesCount || 0)} precision={0} /></Card></Col>
                            </Row>
                          ) : null}
                          <Alert
                            type="info"
                            showIcon
                            message="Live-отчёты и сравнение runtime vs backtest перенесены во вкладку Мониторинг."
                          />
                        </Space>
                      ),
                    },
                    {
                      key: 'clients',
                      label: 'Клиенты',
                      children: (
                        <Space direction="vertical" size={16} style={{ width: '100%' }}>
                          <Card className="battletoads-card" title={copy.connectedTenants} extra={<Button type="primary" onClick={() => navigateToAdminTab('create-user')}>{copy.createClient}</Button>}>
                            <Paragraph type="secondary" style={{ marginTop: 0 }}>{copy.adminCreateHint}</Paragraph>
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                              <Space wrap>
                                <Select
                                  style={{ width: 220 }}
                                  value={clientsModeFilter}
                                  onChange={(value) => setClientsModeFilter(value)}
                                  options={[
                                    { value: 'all', label: 'Все клиенты' },
                                    { value: 'strategy_client', label: 'Strategy Client' },
                                    { value: 'algofund_client', label: 'Algofund' },
                                    { value: 'dual', label: 'Dual' },
                                  ]}
                                />
                                <Select
                                  style={{ width: 180 }}
                                  value={clientsClassKind}
                                  onChange={(value) => setClientsClassKind(value)}
                                  options={[
                                    { value: 'all', label: 'Все категории' },
                                    { value: 'offer', label: 'Офер' },
                                    { value: 'ts', label: 'ТС' },
                                  ]}
                                />
                                <Select
                                  allowClear
                                  style={{ width: 320 }}
                                  value={clientsClassValue || undefined}
                                  onChange={(value) => setClientsClassValue(String(value || ''))}
                                  disabled={clientsClassKind === 'all'}
                                  placeholder={
                                    clientsClassKind === 'offer'
                                      ? 'Выберите офер'
                                      : clientsClassKind === 'ts'
                                        ? 'Выберите ТС'
                                        : 'Категория не выбрана'
                                  }
                                  options={clientsClassKind === 'offer' ? clientsOfferFilterOptions : clientsTsFilterOptions}
                                />
                                <Tag color="default">
                                  {filteredClients.length} клиентов
                                </Tag>
                                {clientsClassKind !== 'all' && clientsClassValue ? (
                                  <Tag color="processing">
                                    Фильтр: {clientsClassKind === 'offer' ? 'Офер' : 'ТС'}: {clientsClassValue}
                                  </Tag>
                                ) : null}
                                {preferredClientSwitchTarget?.systemId ? (
                                  <Tag color="purple">
                                    Switch target: #{preferredClientSwitchTarget.systemId}{preferredClientSwitchTarget.systemName ? ` • ${preferredClientSwitchTarget.systemName}` : ''}
                                  </Tag>
                                ) : null}
                                <Button
                                  size="small"
                                  onClick={() => {
                                    setClientsClassKind('all');
                                    setClientsClassValue('');
                                    setClientsModeFilter('all');
                                  }}
                                >
                                  Сбросить фильтры
                                </Button>
                                <Button size="small" onClick={() => void loadMonitoringTabData()} loading={monitoringTabLoading}>Обновить мониторинг</Button>
                              </Space>
                              <Card size="small" className="battletoads-card" title="Algofund batch actions">
                                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                                  <Space wrap>
                                    <Tag color="processing">Selected: {batchTenantIds.length}</Tag>
                                    <Tag>Algofund tenants: {batchEligibleAlgofundTenants.length}</Tag>
                                    <Button
                                      size="small"
                                      onClick={() => setBatchTenantIds(batchEligibleAlgofundTenants.map((item) => Number(item.tenant.id)))}
                                    >
                                      Select all algofund
                                    </Button>
                                    <Button size="small" onClick={() => setBatchTenantIds([])}>Clear selection</Button>
                                  </Space>
                                  <Space wrap style={{ width: '100%' }}>
                                    <Select
                                      style={{ width: 180 }}
                                      value={batchAlgofundAction}
                                      onChange={(value) => setBatchAlgofundAction(value)}
                                      options={[
                                        { value: 'start', label: 'start' },
                                        { value: 'stop', label: 'stop' },
                                        { value: 'switch_system', label: 'switch_system' },
                                      ]}
                                    />
                                    <InputNumber
                                      min={1}
                                      style={{ width: 180 }}
                                      value={batchTargetSystemId || undefined}
                                      onChange={(value) => setBatchTargetSystemId(Number(value || 0) || null)}
                                      disabled={batchAlgofundAction !== 'switch_system'}
                                      placeholder="target system id"
                                    />
                                    <Input
                                      style={{ width: 360 }}
                                      value={batchActionNote}
                                      onChange={(event) => setBatchActionNote(event.target.value)}
                                      placeholder="optional admin note"
                                    />
                                    <Button
                                      type="primary"
                                      loading={actionLoading === 'algofund-batch'}
                                      onClick={() => void runAlgofundBatchAction()}
                                    >
                                      Run batch
                                    </Button>
                                  </Space>
                                </Space>
                              </Card>

                              {algofundTenantId !== null ? (
                                <Card
                                  size="small"
                                  className="battletoads-card"
                                  title="Multi-TS назначение клиенту"
                                  extra={<Button size="small" loading={algofundActiveSystemsLoading} onClick={() => void loadAlgofundActiveSystems(algofundTenantId)}>Обновить</Button>}
                                >
                                  <Space direction="vertical" style={{ width: '100%' }}>
                                    <Space wrap>
                                      <Text type="secondary">Клиент:</Text>
                                      <Select
                                        style={{ width: 320 }}
                                        value={algofundTenantId ?? undefined}
                                        onChange={(value) => setAlgofundTenantId(Number(value))}
                                        options={algofundTenants.map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                                      />
                                    </Space>
                                    {algofundActiveSystems.length === 0 ? (
                                      <Text type="secondary">Нет назначенных TS (используется legacy single-system режим)</Text>
                                    ) : (
                                      algofundActiveSystems.map((sys) => (
                                        <Space key={sys.id} style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                                          <Space>
                                            <Switch
                                              size="small"
                                              checked={sys.isEnabled}
                                              loading={algofundActiveSystemsLoading}
                                              onChange={async (checked) => {
                                                const apiKeyName = algofundState?.profile?.assigned_api_key_name || algofundState?.tenant?.assigned_api_key_name || '';
                                                setAlgofundActiveSystemsLoading(true);
                                                try {
                                                  await axios.patch(`/api/saas/algofund/${algofundTenantId}/active-systems/${encodeURIComponent(sys.systemName)}/toggle`, {
                                                    isEnabled: checked,
                                                    apiKeyName,
                                                    actorMode: 'admin',
                                                  });
                                                  await loadAlgofundActiveSystems(algofundTenantId);
                                                } catch (err: any) {
                                                  const conflicts = err?.response?.data?.conflicts;
                                                  if (conflicts?.length) {
                                                    messageApi.error(`Конфликт пар: ${conflicts.map((c: any) => `${c.pair} (${c.conflictingSystemName})`).join(', ')}`);
                                                  } else {
                                                    messageApi.error(String(err?.response?.data?.error || err.message || 'Error'));
                                                  }
                                                } finally {
                                                  setAlgofundActiveSystemsLoading(false);
                                                }
                                              }}
                                            />
                                            <Text>{sys.systemName}</Text>
                                            <Tag color="blue">w={sys.weight}</Tag>
                                            <Tag color={sys.assignedBy === 'client' ? 'purple' : 'default'}>{sys.assignedBy}</Tag>
                                          </Space>
                                          <Button
                                            size="small"
                                            danger
                                            onClick={async () => {
                                              setAlgofundActiveSystemsLoading(true);
                                              try {
                                                await axios.delete(`/api/saas/algofund/${algofundTenantId}/active-systems/${encodeURIComponent(sys.systemName)}`);
                                                await loadAlgofundActiveSystems(algofundTenantId);
                                              } catch (err: any) {
                                                messageApi.error(String(err?.response?.data?.error || err.message || 'Error'));
                                              } finally {
                                                setAlgofundActiveSystemsLoading(false);
                                              }
                                            }}
                                          >Убрать</Button>
                                        </Space>
                                      ))
                                    )}
                                    <Space wrap style={{ marginTop: 8 }}>
                                      {algofundStorefrontSystems.map((item) => (
                                        algofundActiveSystems.some((s) => s.systemName === item.systemName) ? null : (
                                          <Button
                                            key={item.systemName}
                                            size="small"
                                            onClick={async () => {
                                              setAlgofundActiveSystemsLoading(true);
                                              try {
                                                await axios.put(`/api/saas/algofund/${algofundTenantId}/active-systems`, {
                                                  systems: [{ systemName: item.systemName, weight: 1, isEnabled: true, assignedBy: 'admin' }],
                                                  replace: false,
                                                });
                                                await loadAlgofundActiveSystems(algofundTenantId);
                                                messageApi.success(`TS ${item.systemName} добавлена`);
                                              } catch (err: any) {
                                                messageApi.error(String(err?.response?.data?.error || err.message || 'Error'));
                                              } finally {
                                                setAlgofundActiveSystemsLoading(false);
                                              }
                                            }}
                                          >+ {item.storefrontLabel || item.systemName}</Button>
                                        )
                                      ))}
                                    </Space>
                                  </Space>
                                </Card>
                              ) : null}

                              <Table
                                rowKey={(row) => row.tenant.id}
                                columns={tenantColumns}
                                dataSource={filteredClients}
                                tableLayout="fixed"
                                pagination={{ pageSize: 10, showSizeChanger: false }}
                                scroll={{ x: 1200 }}
                                size="small"
                                rowSelection={{
                                  selectedRowKeys: batchTenantIds,
                                  onChange: (keys) => {
                                    const next = Array.from(new Set((keys || []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)));
                                    setBatchTenantIds(next);
                                  },
                                  getCheckboxProps: (row) => ({
                                    disabled: row.tenant.product_mode !== 'algofund_client' && row.tenant.product_mode !== 'dual',
                                  }),
                                }}
                              />
                            </Space>
                          </Card>

                          <Card size="small" className="battletoads-card" title="Сквозной отчёт" style={{ marginTop: 16 }}>
                                <Table
                                  rowKey="key"
                                  size="small"
                                  pagination={{ pageSize: 8, showSizeChanger: false }}
                                  scroll={{ x: 2200 }}
                                  dataSource={monitoringCrossReportRows}
                                  columns={[
                                    { title: 'Карточка', dataIndex: 'card', key: 'card', width: 220 },
                                    { title: 'Аналитика', dataIndex: 'analytics', key: 'analytics', width: 360 },
                                    { title: 'Клиенты', dataIndex: 'clients', key: 'clients', width: 260 },
                                    { title: 'Соответствие', dataIndex: 'correspondence', key: 'correspondence', width: 420 },
                                    { title: 'Проблемы', dataIndex: 'problems', key: 'problems', width: 360 },
                                    { title: 'Предложения', dataIndex: 'suggestions', key: 'suggestions', width: 420 },
                                  ]}
                                />
                          </Card>

                          <Row gutter={[16, 16]}>
                            <Col xs={24} xl={12}>
                              <Card className="battletoads-card" title={`${copy.strategyClient} В· ${copy.planGrid}`}>
                                <Table
                                  rowKey="code"
                                  columns={planColumns}
                                  dataSource={(summary?.plans || []).filter((plan) => plan.product_mode === 'strategy_client')}
                                  pagination={false}
                                  scroll={{ x: 980 }}
                                  size="small"
                                />
                              </Card>
                            </Col>
                            <Col xs={24} xl={12}>
                              <Card className="battletoads-card" title={`${copy.algofund} В· ${copy.planGrid}`}>
                                <Table
                                  rowKey="code"
                                  columns={planColumns}
                                  dataSource={(summary?.plans || []).filter((plan) => plan.product_mode === 'algofund_client')}
                                  pagination={false}
                                  scroll={{ x: 980 }}
                                  size="small"
                                />
                              </Card>
                            </Col>
                          </Row>
                        </Space>
                      ),
                    },
                    {
                      key: 'monitoring',
                      label: 'Настройки SaaS',
                      children: (
                        <Space direction="vertical" size={16} style={{ width: '100%' }}>
                          <Card className="battletoads-card" title="Admin обзор / отчёты">
                            <Space direction="vertical" style={{ width: '100%' }}>
                              <Space wrap>
                                <Text>Telegram</Text>
                                <Switch
                                  size="small"
                                  checked={Boolean(telegramControls?.adminEnabled)}
                                  loading={telegramControlsLoading}
                                  onChange={(checked) => { void patchTelegramControls({ adminEnabled: checked }); }}
                                />
                                <Tag color={telegramControls?.tokenConfigured ? 'success' : 'default'}>
                                  token {telegramControls?.tokenConfigured ? 'ok' : 'missing'}
                                </Tag>
                                <Button
                                  size="small"
                                  loading={sendTelegramLoading}
                                  disabled={!telegramControls?.tokenConfigured || !telegramControls?.chatConfigured}
                                  onClick={() => void sendReportToTelegram()}
                                >
                                  Отправить сейчас
                                </Button>
                                <Divider type="vertical" />
                                <Text>Интервал отчёта (мин)</Text>
                                <InputNumber
                                  size="small"
                                  min={5}
                                  max={1440}
                                  step={5}
                                  value={telegramControls?.reportIntervalMinutes ?? 60}
                                  disabled={telegramControlsLoading}
                                  onBlur={(e) => {
                                    const val = parseInt(e.target.value, 10);
                                    if (Number.isFinite(val) && val >= 5) {
                                      void patchTelegramControls({ reportIntervalMinutes: val });
                                    }
                                  }}
                                  style={{ width: 80 }}
                                />
                                <Divider type="vertical" />
                                <Text>Reconciliation cycle</Text>
                                <Switch
                                  size="small"
                                  checked={Boolean(telegramControls?.reconciliationCycleEnabled)}
                                  loading={telegramControlsLoading}
                                  onChange={(checked) => { void patchTelegramControls({ reconciliationCycleEnabled: checked }); }}
                                />
                                <Tag color={telegramControls?.reconciliationCycleEnabled ? 'success' : 'default'}>
                                  runtime {telegramControls?.reconciliationCycleEnabled ? 'on' : 'off'}
                                </Tag>
                              </Space>
                              <Divider style={{ margin: '6px 0' }} />
                              <Space wrap>
                                <Text type="secondary">Секции отчёта:</Text>
                                <Tag>Аккаунты <Switch size="small" checked={Boolean(telegramControls?.sectionAccounts)} loading={telegramControlsLoading} onChange={(checked) => { void patchTelegramControls({ sectionAccounts: checked }); }} /></Tag>
                                <Tag>Drift <Switch size="small" checked={Boolean(telegramControls?.sectionDrift)} loading={telegramControlsLoading} onChange={(checked) => { void patchTelegramControls({ sectionDrift: checked }); }} /></Tag>
                                <Tag>Low-lot <Switch size="small" checked={Boolean(telegramControls?.sectionLowlot)} loading={telegramControlsLoading} onChange={(checked) => { void patchTelegramControls({ sectionLowlot: checked }); }} /></Tag>
                              </Space>
                              <Space>
                                <Text type="secondary">Вкл.</Text>
                                <Switch
                                  size="small"
                                  checked={Boolean(summary?.reportSettings?.enabled)}
                                  loading={actionLoading === 'report-setting:enabled'}
                                  onChange={(checked) => { void toggleReportSetting('enabled', checked); }}
                                />
                              </Space>
                              <Space wrap>
                                <Tag>TS daily <Switch size="small" checked={Boolean(summary?.reportSettings?.tsDaily)} onChange={(checked) => { void toggleReportSetting('tsDaily', checked); }} /></Tag>
                                <Tag>TS weekly <Switch size="small" checked={Boolean(summary?.reportSettings?.tsWeekly)} onChange={(checked) => { void toggleReportSetting('tsWeekly', checked); }} /></Tag>
                                <Tag>TS monthly <Switch size="small" checked={Boolean(summary?.reportSettings?.tsMonthly)} onChange={(checked) => { void toggleReportSetting('tsMonthly', checked); }} /></Tag>
                              </Space>
                              <Space wrap>
                                <Tag>Offer daily <Switch size="small" checked={Boolean(summary?.reportSettings?.offerDaily)} onChange={(checked) => { void toggleReportSetting('offerDaily', checked); }} /></Tag>
                                <Tag>Offer weekly <Switch size="small" checked={Boolean(summary?.reportSettings?.offerWeekly)} onChange={(checked) => { void toggleReportSetting('offerWeekly', checked); }} /></Tag>
                                <Tag>Offer monthly <Switch size="small" checked={Boolean(summary?.reportSettings?.offerMonthly)} onChange={(checked) => { void toggleReportSetting('offerMonthly', checked); }} /></Tag>
                              </Space>
                              <Divider style={{ margin: '6px 0' }} />
                              <Space wrap>
                                <Text>Авто-обновление snapshot из sweep</Text>
                                <Switch
                                  size="small"
                                  checked={Boolean(summary?.reportSettings?.sweepSnapshotAutoRefreshEnabled ?? true)}
                                  loading={actionLoading === 'report-setting:sweepSnapshotAutoRefreshEnabled'}
                                  onChange={(checked) => {
                                    void updateReportSettings({ sweepSnapshotAutoRefreshEnabled: checked });
                                  }}
                                />
                                <Text type="secondary">Интервал (часы)</Text>
                                <InputNumber
                                  size="small"
                                  min={1}
                                  max={168}
                                  step={1}
                                  value={Number(summary?.reportSettings?.sweepSnapshotRefreshHours ?? 24)}
                                  disabled={actionLoading.startsWith('report-setting:')}
                                  onBlur={(e) => {
                                    const val = Number.parseInt(e.target.value, 10);
                                    if (Number.isFinite(val) && val >= 1) {
                                      void updateReportSettings({ sweepSnapshotRefreshHours: val });
                                    }
                                  }}
                                  style={{ width: 88 }}
                                />
                              </Space>
                              <Space wrap>
                                <Text>Watchdog: алерты при rate-limit / сбоях</Text>
                                <Switch
                                  size="small"
                                  checked={Boolean(summary?.reportSettings?.watchdogEnabled ?? true)}
                                  loading={actionLoading === 'report-setting:watchdogEnabled'}
                                  onChange={(checked) => {
                                    void updateReportSettings({ watchdogEnabled: checked });
                                  }}
                                />
                                <Text type="secondary">При всплеске rate-limit (&ge;5 за 15 мин) или 10 сбоях подряд отправит алерт в Telegram</Text>
                              </Space>
                                <Button
                                  size="small"
                                  loading={actionLoading === 'snapshot-refresh'}
                                  onClick={() => { void runSnapshotRefreshNow(); }}
                                >
                                  Обновить snapshot сейчас
                                </Button>
                              <Space wrap>
                                <Tag color={String(summary?.snapshotRefresh?.lastResult || 'idle') === 'success' ? 'success' : (String(summary?.snapshotRefresh?.lastResult || 'idle') === 'failed' ? 'error' : 'default')}>
                                  snapshot: {String(summary?.snapshotRefresh?.lastResult || 'idle')}
                                </Tag>
                                {summary?.snapshotRefresh?.lastRunAt ? (
                                  <Tag color="blue">last run {String(summary.snapshotRefresh.lastRunAt).slice(0, 16).replace('T', ' ')}</Tag>
                                ) : null}
                                {summary?.snapshotRefresh?.systemsUpdated !== undefined ? (
                                  <Tag color="geekblue">TS {Number(summary.snapshotRefresh.systemsUpdated || 0)}</Tag>
                                ) : null}
                                {summary?.snapshotRefresh?.offersUpdated !== undefined ? (
                                  <Tag color="processing">offers {Number(summary.snapshotRefresh.offersUpdated || 0)}</Tag>
                                ) : null}
                              </Space>
                              <Divider style={{ margin: '6px 0' }} />
                              <Space wrap>
                                <Select
                                  value={reportPeriod}
                                  style={{ width: 130 }}
                                  options={[
                                    { value: 'daily', label: 'daily' },
                                    { value: 'weekly', label: 'weekly' },
                                    { value: 'monthly', label: 'monthly' },
                                  ]}
                                  onChange={(value) => setReportPeriod(value)}
                                />
                                <Button loading={performanceReportLoading} onClick={() => void loadPerformanceReport(reportPeriod)}>Обновить обзор</Button>
                              </Space>
                              <Space wrap>
                                <Tag color="blue">TS: {Number(performanceReport?.tradingSystems?.length || 0)}</Tag>
                                <Tag color="geekblue">Offers: {Number(performanceReport?.offers?.length || 0)}</Tag>
                                {performanceReport ? <Tag color="default">{performanceReport.generatedAt.slice(0, 16).replace('T', ' ')}</Tag> : null}
                              </Space>
                              <Divider style={{ margin: '6px 0' }} />
                              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                <Text strong>Algofund reports MVP (1 TS card, connected clients)</Text>
                                <Space wrap>
                                  <Select
                                    style={{ width: 360 }}
                                    placeholder="Выберите Algofund TS"
                                    value={resolvedReportSystemName || undefined}
                                    options={reportSystemOptions}
                                    onChange={(value) => setReportTargetSystemName(String(value || ''))}
                                  />
                                  <Button loading={tsHealthLoading} onClick={() => void loadTsHealthReport()}>TS Health</Button>
                                  <Button loading={closedPositionsLoading} onClick={() => void loadClosedPositionsReport()}>Closed Positions</Button>
                                  <Button loading={runtimeWindowBacktestsLoading} onClick={() => void loadRuntimeWindowBacktests()}>Backtest 1d/7d/30d</Button>
                                  <Button loading={chartSnapshotLoading} onClick={() => void loadChartSnapshotReport()}>Chart Snapshot</Button>
                                  <Button
                                    loading={chartSnapshotLoading}
                                    onClick={async () => {
                                      try {
                                        const response = await axios.post('/api/saas/admin/reports/send-telegram', { format: 'full' });
                                        if (response.data?.success) {
                                          messageApi.success('Скриншот отправлен в Телеграм');
                                        } else {
                                          messageApi.error(response.data?.error || 'Failed to send telegram');
                                        }
                                      } catch (error: any) {
                                        messageApi.error(String(error?.response?.data?.error || error?.message || 'Ошибка отправки в Телеграм'));
                                      }
                                    }}
                                  >
                                    Send to Telegram
                                  </Button>
                                </Space>
                                <Space wrap style={{ marginTop: 8 }}>
                                  <Space>
                                    <Text>TS Health lookback (часов):</Text>
                                    <InputNumber min={1} max={720} value={reportLookbackHours} onChange={(val) => setReportLookbackHours(Number(val || 24))} style={{ width: 80 }} />
                                  </Space>
                                  <Space>
                                    <Text>Closed Positions период (часов):</Text>
                                    <InputNumber min={1} max={2160} value={reportPeriodHours} onChange={(val) => setReportPeriodHours(Number(val || 168))} style={{ width: 80 }} />
                                  </Space>
                                  <Button size="small" onClick={() => { setReportLookbackHours(24); setReportPeriodHours(24 * 7); }}>Reset</Button>
                                </Space>
                                <Space wrap>
                                  <Tag color="blue">health: {Number(tsHealthReport?.systems?.length || 0)} systems</Tag>
                                  <Tag color="gold">closed: {Number(closedPositionsReport?.summary?.closedCount || 0)}</Tag>
                                  <Tag color="magenta">bt windows: {Object.keys(runtimeWindowBacktests || {}).length}</Tag>
                                  <Tag color="purple">snapshot candles: {Number(chartSnapshotReport?.candlesCount || 0)}</Tag>
                                  {chartSnapshotReport?.generatedAt ? <Tag>{chartSnapshotReport.generatedAt.slice(0, 16).replace('T', ' ')}</Tag> : null}
                                </Space>
                                <Row gutter={[12, 12]}>
                                  <Col xs={24} xl={12}>
                                    <Card size="small" title="Master backtest/live (card контур)">
                                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                        {masterSnapshotForReportSystem ? (
                                          <Space wrap>
                                            <Tag color="blue">ret: {formatPercent(masterSnapshotForReportSystem.ret)}</Tag>
                                            <Tag color="green">pf: {formatNumber(masterSnapshotForReportSystem.pf, 2)}</Tag>
                                            <Tag color="orange">dd: {formatPercent(masterSnapshotForReportSystem.dd)}</Tag>
                                            <Tag color="geekblue">trades: {Number(masterSnapshotForReportSystem.trades || 0)}</Tag>
                                            <Tag color="cyan">period: {Number(masterSnapshotForReportSystem.periodDays || 0)}d</Tag>
                                          </Space>
                                        ) : (
                                          <Text type="secondary">Нет snapshot master-бэктеста для выбранной карточки.</Text>
                                        )}
                                        <Text type="secondary">
                                          Этот блок показывает метрики карточки/витрины (master).
                                        </Text>
                                      </Space>
                                    </Card>
                                  </Col>
                                  <Col xs={24} xl={12}>
                                    <Card size="small" title="Client runtime live (клиентский контур)">
                                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                        {tsHealthReport?.systems?.[0] ? (
                                          <Space wrap>
                                            <Tag color="cyan">clients: {Number(tsHealthReport.systems[0].connectedClients || 0)}</Tag>
                                            <Tag>members: {Number(tsHealthReport.systems[0].membersEnabled || 0)}/{Number(tsHealthReport.systems[0].membersTotal || 0)}</Tag>
                                            <Tag color="green">members with events(24h): {Number(tsHealthReport.systems[0].membersWithRecentEvents || 0)}</Tag>
                                            <Tag color="blue">equity: {formatMoney(tsHealthReport.systems[0].latestAccountSnapshot?.equityUsd)}</Tag>
                                          </Space>
                                        ) : (
                                          <Text type="secondary">Live-данные runtime пока не загружены.</Text>
                                        )}
                                        {closedPositionsReport?.summary ? (
                                          <Space wrap>
                                            <Tag color="gold">closed(lookback): {Number(closedPositionsReport.summary.closedCount || 0)}</Tag>
                                            <Tag color={(Number(closedPositionsReport.summary.totalRealizedPnl || 0) >= 0) ? 'green' : 'red'}>
                                              pnl: {formatMoney(closedPositionsReport.summary.totalRealizedPnl)}
                                            </Tag>
                                          </Space>
                                        ) : null}
                                      </Space>
                                    </Card>
                                  </Col>
                                </Row>
                                {Object.keys(runtimeWindowBacktests || {}).length > 0 ? (
                                  <Table
                                    size="small"
                                    pagination={false}
                                    rowKey="window"
                                    dataSource={[
                                      { window: '1d', data: runtimeWindowBacktests['1d'] || null },
                                      { window: '7d', data: runtimeWindowBacktests['7d'] || null },
                                      { window: '30d', data: runtimeWindowBacktests['30d'] || null },
                                    ]}
                                    columns={[
                                      { title: 'Window', dataIndex: 'window', key: 'window' },
                                      {
                                        title: 'Trades',
                                        key: 'trades',
                                        render: (_, row: { window: string; data: AdminSweepBacktestPreviewResponse | null }) => Number(row.data?.preview?.summary?.tradesCount || 0),
                                      },
                                      {
                                        title: 'Return %',
                                        key: 'ret',
                                        render: (_, row: { window: string; data: AdminSweepBacktestPreviewResponse | null }) => formatPercent(row.data?.preview?.summary?.totalReturnPercent),
                                      },
                                      {
                                        title: 'P/L',
                                        key: 'pl',
                                        render: (_, row: { window: string; data: AdminSweepBacktestPreviewResponse | null }) => {
                                          const summary = row.data?.preview?.summary;
                                          const initial = Number(adminSweepBacktestInitialBalance || 0);
                                          const final = Number(summary?.finalEquity || 0);
                                          if (!Number.isFinite(final) || !Number.isFinite(initial) || initial <= 0) {
                                            return formatMoney(0);
                                          }
                                          return formatMoney(final - initial);
                                        },
                                      },
                                      {
                                        title: 'PF',
                                        key: 'pf',
                                        render: (_, row: { window: string; data: AdminSweepBacktestPreviewResponse | null }) => formatNumber(row.data?.preview?.summary?.profitFactor, 2),
                                      },
                                      {
                                        title: 'DD %',
                                        key: 'dd',
                                        render: (_, row: { window: string; data: AdminSweepBacktestPreviewResponse | null }) => formatPercent(row.data?.preview?.summary?.maxDrawdownPercent),
                                      },
                                    ]}
                                  />
                                ) : null}
                                {tsHealthReport?.systems?.[0] ? (
                                  <Space wrap>
                                    <Tag color="cyan">clients: {Number(tsHealthReport.systems[0].connectedClients || 0)}</Tag>
                                    <Tag>members: {Number(tsHealthReport.systems[0].membersEnabled || 0)}/{Number(tsHealthReport.systems[0].membersTotal || 0)}</Tag>
                                    <Tag color="green">live(24h): {Number(tsHealthReport.systems[0].membersWithRecentEvents || 0)}</Tag>
                                    <Tag>equity: {formatMoney(tsHealthReport.systems[0].latestAccountSnapshot?.equityUsd)}</Tag>
                                  </Space>
                                ) : null}
                                {closedPositionsReport?.rows?.length ? (
                                  <Table
                                    size="small"
                                    pagination={{ pageSize: 5, showSizeChanger: false }}
                                    rowKey={(row, index) => `${row.systemId}-${row.strategyId}-${row.exitTime}-${index}`}
                                    dataSource={closedPositionsReport.rows.slice(0, 12)}
                                    columns={[
                                      { title: 'Time', dataIndex: 'exitTime', key: 'exitTime', render: (value: number) => new Date(value).toLocaleString() },
                                      { title: 'Symbol', dataIndex: 'symbol', key: 'symbol' },
                                      { title: 'Side', dataIndex: 'side', key: 'side' },
                                      { title: 'PnL', dataIndex: 'realizedPnl', key: 'realizedPnl', render: (value: number) => formatMoney(value) },
                                      { title: 'Hold min', dataIndex: 'holdMinutes', key: 'holdMinutes', render: (value: number) => formatNumber(value, 2) },
                                    ]}
                                  />
                                ) : null}
                                {chartSnapshotReport?.svgBase64 ? (
                                  <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
                                    <img
                                      src={`data:image/svg+xml;base64,${chartSnapshotReport.svgBase64}`}
                                      alt="Algofund TS snapshot"
                                      style={{ display: 'block', width: '100%', maxHeight: 360, objectFit: 'contain', background: '#f7f9fb' }}
                                    />
                                  </div>
                                ) : null}
                              </Space>
                            </Space>
                          </Card>
                          <Card className="battletoads-card" title="Живые клиенты и торговые движки">
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Paragraph type="secondary" style={{ marginTop: 0 }}>
                              Сводка по strategy-client и algofund: состояние движка, краткие метрики, комментарии и выбор систем.
                            </Paragraph>
                            <Space wrap>
                              <Select
                                style={{ width: 260 }}
                                value={monitoringModeFilter}
                                onChange={(value) => setMonitoringModeFilter(value)}
                                options={[
                                  { value: 'all', label: 'Все режимы' },
                                  { value: 'strategy_client', label: 'Strategy Client' },
                                  { value: 'algofund_client', label: 'Algofund' },
                                  { value: 'dual', label: 'Dual' },
                                ]}
                              />
                              <Button onClick={() => void loadMonitoringTabData()} loading={monitoringTabLoading}>Обновить список систем</Button>
                              <Button onClick={() => void loadLowLotRecommendations()} loading={lowLotLoading}>Обновить low-lot</Button>
                              <Button onClick={() => void loadTelegramControls()} loading={telegramControlsLoading}>Обновить Telegram controls</Button>
                            </Space>

                            <Row gutter={[16, 16]}>
                              <Col xs={24} xl={10}>
                                <Card size="small" className="battletoads-card" title="Telegram controls">
                                  <Space direction="vertical" style={{ width: '100%' }}>
                                    <Space>
                                      <Text>Admin reporter</Text>
                                      <Switch
                                        checked={Boolean(telegramControls?.adminEnabled)}
                                        loading={telegramControlsLoading}
                                        onChange={(checked) => {
                                          void patchTelegramControls({ adminEnabled: checked });
                                        }}
                                      />
                                    </Space>
                                    <Space>
                                      <Text>Client reporter</Text>
                                      <Switch
                                        checked={Boolean(telegramControls?.clientsEnabled)}
                                        loading={telegramControlsLoading}
                                        onChange={(checked) => {
                                          void patchTelegramControls({ clientsEnabled: checked });
                                        }}
                                      />
                                    </Space>
                                    <Space>
                                      <Text>Только runtime-клиенты</Text>
                                      <Switch
                                        checked={Boolean(telegramControls?.runtimeOnly)}
                                        loading={telegramControlsLoading}
                                        onChange={(checked) => {
                                          void patchTelegramControls({ runtimeOnly: checked });
                                        }}
                                      />
                                    </Space>
                                    <Space>
                                      <Text>Reconciliation runtime cycle</Text>
                                      <Switch
                                        checked={Boolean(telegramControls?.reconciliationCycleEnabled)}
                                        loading={telegramControlsLoading}
                                        onChange={(checked) => {
                                          void patchTelegramControls({ reconciliationCycleEnabled: checked });
                                        }}
                                      />
                                    </Space>
                                    <Space wrap>
                                      <Tag color={telegramControls?.tokenConfigured ? 'success' : 'default'}>token {telegramControls?.tokenConfigured ? 'ok' : 'missing'}</Tag>
                                      <Tag color={telegramControls?.chatConfigured ? 'success' : 'default'}>chat_id {telegramControls?.chatConfigured ? 'ok' : 'missing'}</Tag>
                                      <Tag color={telegramControls?.reconciliationCycleEnabled ? 'success' : 'default'}>
                                        reconciliation {telegramControls?.reconciliationCycleEnabled ? 'on' : 'off'}
                                      </Tag>
                                    </Space>
                                    <Button
                                      size="small"
                                      type="primary"
                                      loading={sendTelegramLoading}
                                      disabled={!telegramControls?.tokenConfigured || !telegramControls?.chatConfigured}
                                      onClick={() => { void sendReportToTelegram(); }}
                                    >
                                      Запросить отчёт сейчас
                                    </Button>
                                  </Space>
                                </Card>
                              </Col>

                              <Col xs={24} xl={14}>
                                <Card size="small" className="battletoads-card" title="Рекомендации по лотам (последние 72ч)" extra={<Tooltip title="Стратегии, где за 72ч были ошибки ликвидности или нарушения маржина. Нажми 'Обновить low-lot' вверху для актуальных данных."><Text type="secondary" style={{ cursor: 'help', fontSize: 13 }}>ⓘ</Text></Tooltip>}>
                                  <Table
                                    size="small"
                                    rowKey={(row) => `${row.apiKeyName}:${row.strategyId}`}
                                    dataSource={lowLotRecommendations?.items || []}
                                    pagination={{ pageSize: 5 }}
                                    scroll={{ x: 900 }}
                                    columns={[
                                      {
                                        title: 'Strategy',
                                        key: 'strategy',
                                        render: (_, row) => (
                                          <Space direction="vertical" size={0}>
                                            <Text strong>{row.strategyName}</Text>
                                            <Text type="secondary">{row.apiKeyName} • {row.pair}</Text>
                                          </Space>
                                        ),
                                      },
                                      {
                                        title: 'Source',
                                        key: 'source',
                                        width: 110,
                                        render: (_, row) => {
                                          const colors: Record<string, string> = {
                                            last_error: 'red',
                                            runtime_event: 'orange',
                                            liquidity_trigger: 'blue',
                                          };
                                          const labels: Record<string, string> = {
                                            last_error: 'error',
                                            runtime_event: 'realtime',
                                            liquidity_trigger: 'liquidity',
                                          };
                                          const src = row.eventSource || 'last_error';
                                          return <Tag color={colors[src] || 'default'}>{labels[src] || src}</Tag>;
                                        },
                                      },
                                      {
                                        title: 'Current',
                                        key: 'current',
                                        render: (_, row) => `dep=${formatMoney(row.maxDeposit)} lot=${formatNumber(row.lotPercent, 1)}% lev=${formatNumber(row.leverage, 1)}`,
                                      },
                                      {
                                        title: 'Recommend',
                                        key: 'recommend',
                                        render: (_, row) => (
                                          <Space direction="vertical" size={0}>
                                            <Text>min dep: {formatMoney(row.suggestedDepositMin)}</Text>
                                            <Text>target lot: {formatNumber(row.suggestedLotPercent, 0)}%</Text>
                                            <Text type="secondary">{row.replacementCandidates?.map((c) => c.symbol).filter(Boolean).join(', ') || 'replace by sweep candidate'}</Text>
                                          </Space>
                                        ),
                                      },
                                      {
                                        title: 'Clients',
                                        key: 'clients',
                                        render: (_, row) => row.tenants?.length || 0,
                                      },
                                      {
                                        title: '',
                                        key: 'action',
                                        width: 90,
                                        render: (_, row) => (
                                          <Button
                                            size="small"
                                            onClick={() => {
                                              setApplyLowLotTarget(row);
                                              setApplyLowLotDeposit(true);
                                              setApplyLowLotLot(true);
                                              setApplyLowLotWholeSystem(Boolean(row.systemId));
                                              setApplyLowLotReplacement(row.replacementCandidates?.[0]?.symbol ? `${row.replacementCandidates[0].symbol}/USDT` : '');
                                            }}
                                          >
                                            Apply
                                          </Button>
                                        ),
                                      },
                                    ]}
                                  />
                                </Card>
                              </Col>
                            </Row>

                            <Alert
                              type="info"
                              showIcon
                              message="Операционные таблицы перенесены во вкладку Клиенты"
                              description="Здесь оставлены только настройки и отчёты SaaS/Telegram/аналитики."
                            />
                          </Space>
                        </Card>
                        </Space>
                      ),
                    },
                    {
                      key: 'create-user',
                      label: 'Создать пользователя',
                      children: (
                        <Card className="battletoads-card" title={copy.createClientTitle}>
                          <Space direction="vertical" style={{ width: '100%' }} size={12}>
                            <Paragraph type="secondary" style={{ marginTop: 0 }}>{copy.adminCreateHint}</Paragraph>
                            <div>
                              <Text strong>{copy.displayName} *</Text>
                              <Input style={{ marginTop: 4 }} value={createTenantDisplayName} onChange={(e) => setCreateTenantDisplayName(e.target.value)} placeholder="AlphaFund Client" />
                            </div>
                            <div>
                              <Text strong>{copy.tenantMode} *</Text>
                              <Select style={{ width: '100%', marginTop: 4 }} value={createTenantProductMode} onChange={setCreateTenantProductMode} options={[{ value: 'strategy_client', label: copy.strategyClient }, { value: 'algofund_client', label: copy.algofund }, { value: 'dual', label: 'Dual (стратегии + алгофонд)' }]} />
                            </div>
                            <div>
                              <Text strong>{createTenantProductMode === 'dual' ? 'План стратегий *' : copy.plan + ' *'}</Text>
                              <Select style={{ width: '100%', marginTop: 4 }} value={createTenantPlanCode || undefined} onChange={(v) => setCreateTenantPlanCode(v || '')} options={(summary?.plans || []).filter((p) => createTenantProductMode === 'dual' ? p.product_mode === 'strategy_client' : p.product_mode === createTenantProductMode).map((p) => ({ value: p.code, label: p.title }))} />
                            </div>
                            {createTenantProductMode === 'dual' && (
                            <div>
                              <Text strong>План алгофонда *</Text>
                              <Select style={{ width: '100%', marginTop: 4 }} value={createTenantAlgofundPlanCode || undefined} onChange={(v) => setCreateTenantAlgofundPlanCode(v || '')} options={(summary?.plans || []).filter((p) => p.product_mode === 'algofund_client').map((p) => ({ value: p.code, label: p.title }))} />
                            </div>
                            )}
                            <div>
                              <Text strong>{copy.apiKey}</Text>
                              <Select allowClear style={{ width: '100%', marginTop: 4 }} value={createTenantApiKey || undefined} onChange={(v) => setCreateTenantApiKey(v || '')} options={apiKeyOptions} />
                            </div>
                            <div>
                              <Text strong>Новый API Key Name (опционально)</Text>
                              <Input
                                style={{ marginTop: 4 }}
                                value={createTenantInlineApiKeyName}
                                onChange={(e) => setCreateTenantInlineApiKeyName(e.target.value)}
                                placeholder="alpha-client-key"
                              />
                            </div>
                            <div>
                              <Text strong>Биржа</Text>
                              <Select
                                style={{ width: '100%', marginTop: 4 }}
                                value={createTenantInlineApiExchange}
                                onChange={(value) => setCreateTenantInlineApiExchange(String(value || 'bybit'))}
                                options={[
                                  { value: 'bybit', label: 'Bybit' },
                                  { value: 'bingx', label: 'BingX' },
                                  { value: 'bitget', label: 'Bitget' },
                                  { value: 'binance', label: 'Binance Futures' },
                                  { value: 'weex', label: 'WEEX Futures' },
                                  { value: 'mexc', label: 'MEXC Futures' },
                                ]}
                              />
                            </div>
                            <div>
                              <Text strong>Новый API Key</Text>
                              <Input
                                style={{ marginTop: 4 }}
                                value={createTenantInlineApiKey}
                                onChange={(e) => setCreateTenantInlineApiKey(e.target.value)}
                                placeholder="Введите API Key (public)"
                              />
                            </div>
                            <div>
                              <Text strong>API Secret</Text>
                              <Input
                                type="password"
                                style={{ marginTop: 4 }}
                                value={createTenantInlineApiSecret}
                                onChange={(e) => setCreateTenantInlineApiSecret(e.target.value)}
                                placeholder="Введите API Secret"
                              />
                            </div>
                            <div>
                              <Text strong>Passphrase</Text>
                              <Input
                                style={{ marginTop: 4 }}
                                value={createTenantInlineApiPassphrase}
                                onChange={(e) => setCreateTenantInlineApiPassphrase(e.target.value)}
                                placeholder="Для Bitget и WEEX обязательно, иначе опционально"
                              />
                            </div>
                            <div>
                              <Text strong>RPS</Text>
                              <InputNumber
                                min={1}
                                max={200}
                                style={{ width: '100%', marginTop: 4 }}
                                value={createTenantInlineApiSpeedLimit}
                                onChange={(value) => setCreateTenantInlineApiSpeedLimit(Math.max(1, Number(value || 10)))}
                              />
                            </div>
                            <Space wrap>
                              <Space>
                                <Text>Testnet:</Text>
                                <Switch checked={createTenantInlineApiTestnet} onChange={setCreateTenantInlineApiTestnet} />
                              </Space>
                              <Space>
                                <Text>Demo-trading:</Text>
                                <Switch checked={createTenantInlineApiDemo} onChange={setCreateTenantInlineApiDemo} />
                              </Space>
                            </Space>
                            <div>
                              <Text strong>Email</Text>
                              <Input type="email" style={{ marginTop: 4 }} value={createTenantEmail} onChange={(e) => setCreateTenantEmail(e.target.value)} placeholder="client@example.com" />
                            </div>
                            <Space>
                              <Button type="primary" onClick={() => void createTenantAdmin()} loading={actionLoading === 'createTenant'}>{copy.createClient}</Button>
                              <Button onClick={() => navigateToAdminTab('offer-ts')}>Назад к оферам и ТС</Button>
                            </Space>
                          </Space>
                        </Card>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'strategy-client',
              label: copy.strategyClient,
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {strategyTenants.length === 0 ? <Alert type="info" showIcon message={copy.noTenant} /> : null}
                  {strategyError ? <Alert type="error" showIcon message={strategyError} /> : null}

                  <Spin spinning={strategyLoading && !strategyState}>
                    {strategyState ? (
                      <>
                        <Card className="battletoads-card" title={isAdminSurface ? 'Витрина Клиент стратегий' : copy.tenantWorkspace}>
                          {isAdminSurface ? (
                            <Tabs
                              destroyOnHidden
                              items={[
                                {
                                  key: 'strategy-storefront',
                                  label: 'Витрина',
                                  children: (
                                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                      <Alert
                                        type="info"
                                        showIcon
                                        message="Витрина оферов Клиента стратегий: опубликованные карточки и быстрые действия."
                                      />
                                      {publishedStorefrontOffers.length === 0 ? (
                                        <Empty description="Витрина оферов пока пустая: сначала апрувни карточки в Админ → Оферы и ТС" />
                                      ) : (
                                        <List
                                          grid={{ gutter: 10, xs: 1, md: 2, xl: 4 }}
                                          dataSource={publishedStorefrontOffers}
                                          renderItem={(row: any) => {
                                            const points = downsampleNumericSeries(
                                              (Array.isArray(row.equityPoints) ? row.equityPoints : [])
                                                .map((value: unknown) => Number(value))
                                                .filter((value: number) => Number.isFinite(value)),
                                              36
                                            );
                                            return (
                                              <List.Item key={String(row.offerId || '')}>
                                                <Card size="small" bordered>
                                                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                                    <Space direction="vertical" size={0}>
                                                      <Tooltip title={(() => {
                                                        const sType = String(row.strategyType || '').trim();
                                                        const hint = getTsStrategyHint(sType) || `Стратегия ${sType || row.titleRu}`;
                                                        const params = row.strategyParams;
                                                        const interval = String(params?.interval || row.interval || '');
                                                        const length = Number(params?.length || 0);
                                                        const tp = Number(params?.takeProfitPercent || 0);
                                                        const src = String(params?.detectionSource || '');
                                                        const ze = Number(params?.zscoreEntry || 0);
                                                        let detail = `Таймфрейм: ${interval || '?'} • Период: ${length || '?'} • Пара: ${row.market}`;
                                                        if (tp) detail += `\nTP: ${tp}% • Источник: ${src || '?'}`;
                                                        if (ze) detail += `\nZ-entry: ${ze}, Z-exit: ${params?.zscoreExit ?? '?'}, Z-stop: ${params?.zscoreStop ?? '?'}`;
                                                        return `${hint}\n${detail}`;
                                                      })()} placement="topLeft">
                                                        <Text strong style={{ cursor: 'help' }}>{row.titleRu}</Text>
                                                      </Tooltip>
                                                      <Text type="secondary" style={{ fontSize: 11 }}>{String(row.mode || '').toUpperCase()} • {row.market}</Text>
                                                    </Space>
                                                    <Space size={4} wrap>
                                                      <Tag color="default">{Number(row.periodDays || 0)}d</Tag>
                                                      <Tag color={metricColor(Number(row.ret || 0), 'return')}>Ret {formatPercent(row.ret)}</Tag>
                                                      <Tag color={metricColor(Number(row.dd || 0), 'drawdown')}>DD {formatPercent(row.dd)}</Tag>
                                                      <Tag color={metricColor(Number(row.pf || 0), 'pf')}>PF {formatNumber(row.pf)}</Tag>
                                                      <Tag color={Number(row.connectedClients || 0) > 0 ? 'cyan' : 'default'}>clients {Number(row.connectedClients || 0)}</Tag>
                                                      <Tag color={Boolean(row.published) ? 'success' : 'warning'}>{Boolean(row.published) ? '✓ На витрине' : '⊘ Не на витрине'}</Tag>
                                                    </Space>
                                                    {points.length >= 2 ? (
                                                      <ChartComponent
                                                        data={(() => { const nowSec = Math.floor(Date.now() / 1000); const dayS = 86400; const startSec = nowSec - (points.length - 1) * dayS; return points.map((value, index) => ({ time: startSec + index * dayS, equity: value })); })()}
                                                        type="line"
                                                        fixedHeight={120}
                                                      />
                                                    ) : (
                                                      <Text type="secondary" style={{ fontSize: 11 }}>no snapshot</Text>
                                                    )}
                                                    <Space size={4} wrap>
                                                      <Button size="small" onClick={() => openOfferBacktest(row)}>Бэктест</Button>
                                                      <Button
                                                        size="small"
                                                        type="primary"
                                                        onClick={() => setStrategyConnectTarget({ offerId: String(row.offerId), offerTitle: String(row.titleRu || row.offerId), tenantIds: [] })}
                                                      >
                                                        Подключить клиентов
                                                      </Button>
                                                      <Button
                                                        size="small"
                                                        danger
                                                        onClick={() => { void openUnpublishWizard(String(row.offerId)); }}
                                                      >
                                                        Снять с витрины
                                                      </Button>
                                                    </Space>
                                                  </Space>
                                                </Card>
                                              </List.Item>
                                            );
                                          }}
                                        />
                                      )}
                                    </Space>
                                  ),
                                },
                                {
                                  key: 'strategy-client-card',
                                  label: 'Карточка клиента',
                                  children: (() => {
                                    const runtime = selectedStrategyTenantSummary ? resolveTenantRuntimeStatus(selectedStrategyTenantSummary) : null;
                                    const billing = selectedStrategyTenantSummary ? extractTenantBillingInfo(selectedStrategyTenantSummary) : null;
                                    const selectedOfferIds = Array.isArray(strategyState.profile?.selectedOfferIds)
                                      ? (strategyState.profile?.selectedOfferIds || []).map((item) => String(item))
                                      : [];
                                    const offerById = new Map((strategyState.offers || []).map((item) => [String(item.offerId), item]));
                                    return (
                                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                        <Alert
                                          type="info"
                                          showIcon
                                          message="Карточка клиента Strategy Client: выбор клиента, тариф, риск-профиль, метрики и настройки."
                                        />
                                        <Row gutter={[12, 12]}>
                                          <Col xs={24} md={8}>
                                            <Text strong>{copy.chooseTenant}</Text>
                                            <Select
                                              style={{ width: '100%', marginTop: 8 }}
                                              value={strategyTenantId ?? undefined}
                                              onChange={(value) => setStrategyTenantId(Number(value))}
                                              options={strategyTenants.map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                                            />
                                          </Col>
                                          <Col xs={24} md={8}>
                                            <Text strong>{copy.displayName}</Text>
                                            <Input style={{ marginTop: 8 }} value={strategyTenantDisplayName} onChange={(event) => setStrategyTenantDisplayName(event.target.value)} />
                                          </Col>
                                          <Col xs={24} md={8}>
                                            <Text strong>{copy.apiKey}</Text>
                                            <Select
                                              style={{ width: '100%', marginTop: 8 }}
                                              value={strategyApiKeyName || undefined}
                                              onChange={setStrategyApiKeyName}
                                              options={apiKeyOptions}
                                              disabled={!strategyApiKeyEditable}
                                            />
                                          </Col>
                                        </Row>
                                        <Space wrap>
                                          {runtime ? (
                                            <Tooltip title={runtime.details}>
                                              <Tag color={runtime.level}>Движок: {runtime.stateLabel}</Tag>
                                            </Tooltip>
                                          ) : null}
                                          <Tag color={strategyState.profile?.requested_enabled ? 'processing' : 'warning'}>
                                            {strategyState.profile?.requested_enabled ? 'торговля включена' : 'торговля выключена'}
                                          </Tag>
                                          <Tag color={strategyState.tenant.status === 'active' ? 'success' : 'default'}>{copy.tenantStatus}: {strategyState.tenant.status || '—'}</Tag>
                                          {billing ? (
                                            <Tooltip title={billing.details}>
                                              <Tag color={billing.color}>Оплата: {billing.label}</Tag>
                                            </Tooltip>
                                          ) : null}
                                        </Space>
                                        <Descriptions column={1} size="small" bordered>
                                          <Descriptions.Item label={copy.displayName}>{strategyState.tenant.display_name || '—'}</Descriptions.Item>
                                          <Descriptions.Item label={copy.plan}>{strategyState.plan ? `${strategyState.plan.title} • ${strategyState.plan.original_price_usdt ? formatMoney(strategyState.plan.original_price_usdt) + ' → ' : ''}${formatMoney(strategyState.plan.price_usdt)}` : '—'}</Descriptions.Item>
                                          <Descriptions.Item label={copy.depositCap}>{formatMoney(strategyState.plan?.max_deposit_total)}</Descriptions.Item>
                                          <Descriptions.Item label={copy.strategyLimit}>{formatNumber(strategyState.plan?.max_strategies_total, 0)}</Descriptions.Item>
                                          <Descriptions.Item label={copy.risk}>{String(strategyState.profile?.risk_level || '—')}</Descriptions.Item>
                                          <Descriptions.Item label={copy.tradeFrequency}>{String(strategyState.profile?.trade_frequency_level || '—')}</Descriptions.Item>
                                        </Descriptions>
                                        <Space wrap>
                                          {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="green">Eq {formatMoney(selectedStrategyTenantSummary.monitoring.equity_usd)}</Tag> : null}
                                          {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="geekblue">{copy.unrealizedPnl}: {formatMoney(selectedStrategyTenantSummary.monitoring.unrealized_pnl)}</Tag> : null}
                                          {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="orange">DD {formatPercent(selectedStrategyTenantSummary.monitoring.drawdown_percent)}</Tag> : null}
                                          {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="purple">{copy.marginLoad}: {formatPercent(selectedStrategyTenantSummary.monitoring.margin_load_percent)}</Tag> : null}
                                          {!strategyMonitoringEnabled ? <Tag color="default">{copy.monitoring}: off</Tag> : null}
                                        </Space>
                                        <Space wrap>
                                          <Select
                                            value={strategyTenantPlanCode || undefined}
                                            onChange={setStrategyTenantPlanCode}
                                            style={{ width: 180 }}
                                            options={strategyPlanOptions}
                                          />
                                          <Select
                                            value={strategyTenantStatus}
                                            onChange={setStrategyTenantStatus}
                                            style={{ width: 180 }}
                                            options={[
                                              { value: 'active', label: 'active' },
                                              { value: 'suspended', label: 'suspended' },
                                              { value: 'paused', label: 'paused' },
                                            ]}
                                          />
                                          <Button type="primary" onClick={() => void saveStrategyTenantAdmin()} loading={actionLoading === 'strategy-tenant-save'}>
                                            {copy.saveTenant}
                                          </Button>
                                          <Button danger onClick={() => void emergencyStopStrategy()} loading={actionLoading === 'strategy-emergency'}>
                                            {copy.emergencyStop}
                                          </Button>
                                          <Button onClick={() => void createStrategyMagicLink()} loading={actionLoading === 'strategy-magic-link'}>
                                            {copy.createMagicLink}
                                          </Button>
                                        </Space>
                                        <Card size="small" className="battletoads-card" title="Подключенные карточки клиента">
                                          {selectedOfferIds.length === 0 ? (
                                            <Empty description="Карточки не подключены" />
                                          ) : (
                                            <List
                                              size="small"
                                              dataSource={selectedOfferIds}
                                              rowKey={(item) => item}
                                              renderItem={(offerId) => {
                                                const offer = offerById.get(String(offerId));
                                                return (
                                                  <List.Item>
                                                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                                                      <Text strong>{offer?.titleRu || `Карточка ${offerId}`}</Text>
                                                      <Space wrap>
                                                        <Tag color="blue">id {offerId}</Tag>
                                                        {offer?.strategy?.market ? <Tag color="default">{offer.strategy.market}</Tag> : null}
                                                        {offer?.metrics?.score !== undefined ? <Tag color="cyan">score {formatNumber(offer.metrics.score)}</Tag> : null}
                                                        {offer?.metrics?.ret !== undefined ? <Tag color={metricColor(Number(offer.metrics.ret || 0), 'return')}>Ret {formatPercent(offer.metrics.ret)}</Tag> : null}
                                                        {offer?.metrics?.dd !== undefined ? <Tag color={metricColor(Number(offer.metrics.dd || 0), 'drawdown')}>DD {formatPercent(offer.metrics.dd)}</Tag> : null}
                                                      </Space>
                                                    </Space>
                                                  </List.Item>
                                                );
                                              }}
                                            />
                                          )}
                                        </Card>
                                      </Space>
                                    );
                                  })(),
                                },
                              ]}
                            />
                          ) : (
                            <>
                          {/* Клиентская витрина Стратегий */}
                          {publishedStorefrontOffers.length > 0 ? (
                            <Card className="battletoads-card" title="Витрина стратегий" style={{ marginBottom: 16 }}>
                              <List
                                grid={{ gutter: 12, xs: 1, md: 2, xl: 3 }}
                                dataSource={publishedStorefrontOffers}
                                renderItem={(offer: any) => {
                                  const points = downsampleNumericSeries(
                                    (Array.isArray(offer.equityPoints) ? offer.equityPoints : [])
                                      .map((value: unknown) => Number(value))
                                      .filter((value: number) => Number.isFinite(value)),
                                    36
                                  );
                                  return (
                                  <List.Item key={offer.offerId}>
                                    <Card size="small" bordered title={<Text strong>{offer.titleRu || offer.offerId}</Text>}>
                                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                        <Space wrap>
                                          {offer.mode ? <Tag color="blue">{String(offer.mode).toUpperCase()}</Tag> : null}
                                          {offer.market ? <Tag color="default">{offer.market}</Tag> : null}
                                          {offer.ret !== undefined ? <Tag color={metricColor(Number(offer.ret || 0), 'return')}>Ret {formatPercent(offer.ret)}</Tag> : null}
                                          {offer.dd !== undefined ? <Tag color={metricColor(Number(offer.dd || 0), 'drawdown')}>DD {formatPercent(offer.dd)}</Tag> : null}
                                          {offer.pf !== undefined ? <Tag color={metricColor(Number(offer.pf || 0), 'pf')}>PF {formatNumber(offer.pf)}</Tag> : null}
                                        </Space>
                                        {points.length >= 2 ? (
                                          <ChartComponent data={(() => { const nowSec = Math.floor(Date.now() / 1000); const dayS = 86400; const startSec = nowSec - (points.length - 1) * dayS; return points.map((value: number, index: number) => ({ time: startSec + index * dayS, equity: value })); })()} type="line" fixedHeight={120} />
                                        ) : (
                                          <Text type="secondary" style={{ fontSize: 12 }}>График не сохранен</Text>
                                        )}
                                        <Button size="small" onClick={() => openSaasBacktestFlow(offer.offerId)}>Бэктест</Button>
                                      </Space>
                                    </Card>
                                  </List.Item>
                                  );
                                }}
                              />
                            </Card>
                          ) : (
                            <Alert type="info" showIcon message="Витрина стратегий пока пуста" style={{ marginBottom: 16 }} />
                          )}

                          <Row gutter={[16, 16]} align="middle">
                            {isAdminSurface ? (
                              <Col xs={24} md={6}>
                                <Text strong>{copy.chooseTenant}</Text>
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={strategyTenantId ?? undefined}
                                  onChange={(value) => setStrategyTenantId(Number(value))}
                                  options={strategyTenants.map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                                />
                              </Col>
                            ) : null}
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>{copy.displayName}</Text>
                              {isAdminSurface ? (
                                <Input style={{ marginTop: 8 }} value={strategyTenantDisplayName} onChange={(event) => setStrategyTenantDisplayName(event.target.value)} />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{strategyState.tenant.display_name}</Text></div>
                              )}
                            </Col>
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>{copy.apiKey}</Text>
                              {isAdminSurface ? (
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={strategyApiKeyName || undefined}
                                  onChange={setStrategyApiKeyName}
                                  options={apiKeyOptions}
                                  disabled={!strategyApiKeyEditable}
                                />
                              ) : (
                                <div style={{ marginTop: 8 }}>
                                  <Space>
                                    <Text>{strategyApiKeyName || '—'}</Text>
                                    {strategyApiKeyName
                                      ? <Tag color={strategyState?.profile?.actual_enabled ? 'success' : 'default'}>{strategyState?.profile?.actual_enabled ? 'подключён' : 'не активен'}</Tag>
                                      : null}
                                  </Space>
                                </div>
                              )}
                            </Col>
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>{copy.plan}</Text>
                              {isAdminSurface ? (
                                <Select style={{ width: '100%', marginTop: 8 }} value={strategyTenantPlanCode || undefined} onChange={setStrategyTenantPlanCode} options={strategyPlanOptions} />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{strategyState.plan ? `${strategyState.plan.title} • ${strategyState.plan.original_price_usdt ? formatMoney(strategyState.plan.original_price_usdt) + ' → ' : ''}${formatMoney(strategyState.plan.price_usdt)}` : '—'}</Text></div>
                              )}
                            </Col>
                          </Row>
                          <Space wrap style={{ marginTop: 12 }}>
                            <Text strong>{copy.planCapabilities}:</Text>
                            {renderCapabilityTags(copy, strategyCapabilities)}
                          </Space>
                          <Space wrap style={{ marginTop: 16 }}>
                            <Tag color="blue">{copy.depositCap}: {formatMoney(strategyState.plan?.max_deposit_total)}</Tag>
                            <Tag color="cyan">{copy.strategyLimit}: {formatNumber(strategyState.plan?.max_strategies_total, 0)}</Tag>
                            <Tag color="gold">{copy.tenantStatus}: {isAdminSurface ? strategyTenantStatus : strategyState.tenant.status}</Tag>
                            {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="green">Eq {formatMoney(selectedStrategyTenantSummary.monitoring.equity_usd)}</Tag> : null}
                            {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="geekblue">{copy.unrealizedPnl}: {formatMoney(selectedStrategyTenantSummary.monitoring.unrealized_pnl)}</Tag> : null}
                            {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="orange">DD {formatPercent(selectedStrategyTenantSummary.monitoring.drawdown_percent)}</Tag> : null}
                            {strategyMonitoringEnabled && selectedStrategyTenantSummary?.monitoring ? <Tag color="purple">{copy.marginLoad}: {formatPercent(selectedStrategyTenantSummary.monitoring.margin_load_percent)}</Tag> : null}
                            {strategyMonitoringEnabled && selectedStrategyTenantSummary ? (() => {
                              const load = calcDepositLoadPercent(selectedStrategyTenantSummary);
                              return load !== null ? <Tag color="cyan">{copy.depositLoad}: {formatPercent(load)}</Tag> : null;
                            })() : null}
                            {strategyMonitoringEnabled && selectedStrategyTenantSummary ? (() => {
                              const liq = calcLiquidationRisk(selectedStrategyTenantSummary);
                              return <Tag color={liq.color}>{copy.liquidationRisk}: {liq.level}{liq.bufferPercent !== null ? ` (${formatPercent(liq.bufferPercent)} buf)` : ''}</Tag>;
                            })() : null}
                            {!strategyMonitoringEnabled ? <Tag color="default">{copy.monitoring}: off</Tag> : null}
                          </Space>
                          <Space wrap style={{ marginTop: 12 }}>
                            <Button size="small" href="/settings" disabled={!strategySettingsEnabled}>{copy.openSettings}</Button>
                            <Button size="small" href="/positions" disabled={!strategyMonitoringEnabled && !isAdminSurface}>{copy.openMonitoring}</Button>
                            <Button size="small" onClick={() => openOfferBacktest(strategySelectedBacktestOffer as any)} disabled={!strategyBacktestEnabled}>{copy.openBacktest}</Button>
                          </Space>
                          {isAdminSurface ? (
                            <>
                              <Space wrap style={{ marginTop: 12 }}>
                                <Select
                                  value={strategyTenantStatus}
                                  onChange={setStrategyTenantStatus}
                                  style={{ width: 180 }}
                                  options={[
                                    { value: 'active', label: 'active' },
                                    { value: 'suspended', label: 'suspended' },
                                    { value: 'paused', label: 'paused' },
                                  ]}
                                />
                                <Button type="primary" onClick={() => void saveStrategyTenantAdmin()} loading={actionLoading === 'strategy-tenant-save'}>
                                  {copy.saveTenant}
                                </Button>
                                <Button danger onClick={() => void emergencyStopStrategy()} loading={actionLoading === 'strategy-emergency'}>
                                  {copy.emergencyStop}
                                </Button>
                                <Button onClick={() => void createStrategyMagicLink()} loading={actionLoading === 'strategy-magic-link'}>
                                  {copy.createMagicLink}
                                </Button>
                              </Space>
                              {strategyMagicLink && strategyMagicLink.loginUrl ? (
                                <Alert
                                  style={{ marginTop: 8 }}
                                  type="info"
                                  showIcon
                                  message={copy.magicLinkReady}
                                  description={
                                    <>
                                      <div style={{ marginBottom: 8 }}><strong>Ссылка для входа:</strong></div>
                                      <div><a href={strategyMagicLink.loginUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{strategyMagicLink.loginUrl}</a></div>
                                      <div style={{ marginTop: 8 }}>{copy.magicLinkExpires}: {new Date(strategyMagicLink.expiresAt).toLocaleString()}</div>
                                    </>
                                  }
                                />
                              ) : null}
                            </>
                          ) : null}
                            </>
                          )}
                        </Card>

                        {!isAdminSurface ? (
                        <>
                        <Card className="battletoads-card" title="Мои торговые системы">
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Space wrap>
                              <Tag color="blue">Профилей: {strategySystemProfiles.length}</Tag>
                              {strategyState?.constraints?.limits?.maxCustomSystems !== null && strategyState?.constraints?.limits?.maxCustomSystems !== undefined ? (
                                <Tag color="purple">Лимит по тарифу: {strategyState?.constraints?.limits?.maxCustomSystems}</Tag>
                              ) : null}
                              {activeStrategySystemProfile ? <Tag color="success">Активная: {activeStrategySystemProfile.profileName}</Tag> : null}
                            </Space>
                            <Row gutter={[12, 12]}>
                              <Col xs={24} lg={12}>
                                <Text strong>Активный профиль</Text>
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={strategySystemProfileId || undefined}
                                  onChange={(value) => {
                                    const numericId = Number(value);
                                    setStrategySystemProfileId(numericId);
                                    void activateStrategySystemProfile(numericId);
                                  }}
                                  options={strategySystemProfiles.map((item) => ({
                                    value: Number(item.id),
                                    label: `${item.profileName}${item.isActive ? ' [активный]' : ''}`,
                                  }))}
                                />
                              </Col>
                              <Col xs={24} lg={7}>
                                <Text strong>Название нового профиля</Text>
                                <Input
                                  style={{ marginTop: 8 }}
                                  value={strategyNewProfileName}
                                  onChange={(event) => setStrategyNewProfileName(event.target.value)}
                                  placeholder={`Мой ТС ${strategySystemProfiles.length + 1}`}
                                />
                              </Col>
                              <Col xs={12} lg={3}>
                                <Text strong style={{ opacity: 0 }}>.</Text>
                                <Button
                                  type="primary"
                                  style={{ width: '100%', marginTop: 8 }}
                                  loading={actionLoading === 'strategy-profile-create'}
                                  onClick={() => void createStrategySystemProfile()}
                                  disabled={
                                    Number(strategyState?.constraints?.limits?.maxCustomSystems || 0) > 0
                                    && strategySystemProfiles.length >= Number(strategyState?.constraints?.limits?.maxCustomSystems || 0)
                                  }
                                >
                                  Создать
                                </Button>
                              </Col>
                              <Col xs={12} lg={2}>
                                <Text strong style={{ opacity: 0 }}>.</Text>
                                <Button
                                  danger
                                  style={{ width: '100%', marginTop: 8 }}
                                  loading={actionLoading === 'strategy-profile-delete'}
                                  disabled={!strategySystemProfileId || strategySystemProfiles.length <= 1}
                                  onClick={() => {
                                    Modal.confirm({
                                      title: 'Удалить профиль ТС?',
                                      content: 'Выбранный профиль будет удалён. Активный профиль удалить нельзя.',
                                      okText: 'Удалить',
                                      okType: 'danger',
                                      cancelText: 'Отмена',
                                      onOk: async () => {
                                        await deleteStrategySystemProfile();
                                      },
                                    });
                                  }}
                                >
                                  Удалить
                                </Button>
                              </Col>
                            </Row>
                            <Table
                              size="small"
                              rowKey="id"
                              dataSource={strategySystemProfiles}
                              pagination={false}
                              columns={[
                                {
                                  title: 'Профиль',
                                  key: 'profileName',
                                  render: (_, row: any) => (
                                    <Space>
                                      <Text strong>{row.profileName}</Text>
                                      {row.isActive ? <Tag color="success">активный</Tag> : <Tag color="default">неактивный</Tag>}
                                    </Space>
                                  ),
                                },
                                {
                                  title: 'Оферы',
                                  key: 'offers',
                                  render: (_, row: any) => Array.isArray(row.selectedOfferIds) ? row.selectedOfferIds.length : 0,
                                  width: 100,
                                },
                                {
                                  title: 'Обновлено',
                                  dataIndex: 'updatedAt',
                                  width: 200,
                                  render: (value: any) => value || '—',
                                },
                              ]}
                            />
                          </Space>
                        </Card>

                        <Card className="battletoads-card">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} lg={12}>
                              <Text strong>{copy.risk}: {formatNumber(strategyRiskInput, 1)}</Text>
                              <Slider min={0} max={10} step={0.1} marks={strategyLevelMarks} value={strategyRiskInput} onChange={(value) => setStrategyRiskInput(clampPreviewValue(Number(value)))} />
                              <InputNumber min={0} max={10} step={0.1} style={{ width: '100%' }} value={strategyRiskInput} onChange={(value) => setStrategyRiskInput(clampPreviewValue(Number(value ?? 0)))} />
                            </Col>
                            <Col xs={24} lg={12}>
                              <Text strong>{copy.tradeFrequency}: {formatNumber(strategyTradeInput, 1)}</Text>
                              <Slider min={0} max={10} step={null} marks={strategyLevelMarks} value={strategyTradeInput} onChange={(value) => setStrategyTradeInput(snapToLevelValue(Number(value)))} />
                              <InputNumber min={0} max={10} step={5} style={{ width: '100%' }} value={strategyTradeInput} onChange={(value) => setStrategyTradeInput(snapToLevelValue(Number(value ?? 5)))} />
                            </Col>
                          </Row>
                          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>{copy.previewUsesNearestPreset}</Paragraph>
                          <Space wrap>
                            <Tag color="processing">{copy.persistedBucket}: {strategyPersistedRiskBucket}</Tag>
                            <Tag color="processing">{copy.tradeFrequency}: {strategyPersistedTradeBucket}</Tag>
                          </Space>
                          <Space wrap style={{ marginTop: 16 }}>
                            <Button type="primary" onClick={() => void saveStrategyProfile()} loading={actionLoading === 'strategy-save'} disabled={!strategySettingsEnabled}>{copy.saveProfile}</Button>
                            <Button onClick={() => void runMaterialize()} loading={actionLoading === 'strategy-materialize'}>{copy.materialize}</Button>
                          </Space>
                        </Card>

                        <Card className="battletoads-card" title="Ограничения конструктора">
                          <Row gutter={[12, 12]}>
                            <Col xs={24} md={6}>
                              <Statistic
                                title="Выбрано"
                                value={`${strategyDraftConstraints.usage?.selected ?? 0}${strategyDraftConstraints.limits?.maxOffersPerSystem !== null && strategyDraftConstraints.limits?.maxOffersPerSystem !== undefined ? ` / ${strategyDraftConstraints.limits?.maxOffersPerSystem}` : strategyDraftConstraints.limits?.maxStrategies !== null && strategyDraftConstraints.limits?.maxStrategies !== undefined ? ` / ${strategyDraftConstraints.limits?.maxStrategies}` : ''}`}
                              />
                            </Col>
                            <Col xs={24} md={6}>
                              <Statistic title="Mono / Synth" value={`${strategyDraftConstraints.usage?.mono ?? 0} / ${strategyDraftConstraints.usage?.synth ?? 0}`} />
                            </Col>
                            <Col xs={24} md={6}>
                              <Statistic title="Рынки" value={strategyDraftConstraints.usage?.uniqueMarkets ?? 0} />
                            </Col>
                            <Col xs={24} md={6}>
                              <Statistic title="Депозит на ТС" value={strategyDraftConstraints.usage?.estimatedDepositPerStrategy ?? 0} precision={2} suffix="USDT" />
                            </Col>
                          </Row>
                          <Space wrap style={{ marginTop: 12 }}>
                            {strategyDraftConstraints.usage?.remainingSlots !== null && strategyDraftConstraints.usage?.remainingSlots !== undefined ? <Tag color="blue">Осталось слотов: {strategyDraftConstraints.usage?.remainingSlots}</Tag> : null}
                            {strategyDraftConstraints.limits?.minOffersPerSystem !== null && strategyDraftConstraints.limits?.minOffersPerSystem !== undefined ? <Tag color="purple">Мин оферов в ТС: {strategyDraftConstraints.limits?.minOffersPerSystem}</Tag> : null}
                            {strategyDraftConstraints.limits?.maxOffersPerSystem !== null && strategyDraftConstraints.limits?.maxOffersPerSystem !== undefined ? <Tag color="purple">Макс оферов в ТС: {strategyDraftConstraints.limits?.maxOffersPerSystem}</Tag> : null}
                            {strategyDraftConstraints.limits?.maxCustomSystems !== null && strategyDraftConstraints.limits?.maxCustomSystems !== undefined ? <Tag color="cyan">Лимит ТС: {strategyDraftConstraints.limits?.maxCustomSystems}</Tag> : null}
                            {strategyDraftConstraints.limits?.mono !== null && strategyDraftConstraints.limits?.mono !== undefined ? <Tag color="green">Лимит Mono: {strategyDraftConstraints.limits?.mono}</Tag> : null}
                            {strategyDraftConstraints.limits?.synth !== null && strategyDraftConstraints.limits?.synth !== undefined ? <Tag color="geekblue">Лимит Synth: {strategyDraftConstraints.limits?.synth}</Tag> : null}
                            {strategyDraftConstraints.limits?.depositCap !== null && strategyDraftConstraints.limits?.depositCap !== undefined ? <Tag color="gold">Лимит депозита: {formatMoney(strategyDraftConstraints.limits?.depositCap)}</Tag> : null}
                          </Space>
                          {(strategyDraftConstraints.violations || []).map((item) => (
                            <Alert key={item} style={{ marginTop: 12 }} type="error" showIcon message={item} />
                          ))}
                          {(strategyDraftConstraints.warnings || []).map((item) => (
                            <Alert key={item} style={{ marginTop: 12 }} type="warning" showIcon message={item} />
                          ))}
                        </Card>

                        <Card className="battletoads-card" title={copy.selectedOffers}>
                          <Paragraph type="secondary" style={{ marginTop: 0 }}>{copy.selectedOffersHint}</Paragraph>
                          {strategyOfferCatalog.length === 0 ? (
                            <>
                              <Alert type="warning" showIcon message={copy.selectedOffersEmptyHint} style={{ marginBottom: 12 }} />
                              <Empty description={copy.noCatalog} />
                            </>
                          ) : (
                            <List
                              grid={{ gutter: 12, xs: 1, md: 2, xl: 3 }}
                              dataSource={strategyOfferCatalog}
                              renderItem={(offer) => {
                                const checked = strategyOfferIds.includes(offer.offerId);
                                return (
                                  <List.Item key={offer.offerId}>
                                    <Card
                                      size="small"
                                      className="battletoads-card"
                                      title={<Text strong>{offer.titleRu}</Text>}
                                      extra={(
                                        <Checkbox
                                          checked={checked}
                                          onChange={(event) => {
                                            const nextChecked = event.target.checked;
                                            setStrategyOfferIds((current) => {
                                              const next = nextChecked
                                                ? Array.from(new Set([...current, offer.offerId]))
                                                : current.filter((item) => item !== offer.offerId);
                                              const nextConstraints = buildDraftStrategyConstraints(next, strategyOfferCatalog, strategyState?.constraints || null);
                                              if (nextChecked && (nextConstraints.violations || []).length > 0) {
                                                messageApi.warning((nextConstraints.violations || [copy.settingsLockedHint])[0]);
                                                return current;
                                              }
                                              return next;
                                            });
                                          }}
                                        />
                                      )}
                                    >
                                      <Space direction="vertical" size={10} style={{ width: '100%' }}>
                                        <Text type="secondary">{offer.strategy.mode.toUpperCase()} • {offer.strategy.type} • {offer.strategy.market}</Text>
                                        <Row gutter={[8, 8]}>
                                          <Col span={12}>
                                            <Card size="small" bordered>
                                              <Text type="secondary">{copy.returnLabel}</Text>
                                              <div><Text strong style={{ color: Number(offer.metrics.ret || 0) >= 0 ? '#389e0d' : '#cf1322' }}>{formatPercent(offer.metrics.ret)}</Text></div>
                                            </Card>
                                          </Col>
                                          <Col span={12}>
                                            <Card size="small" bordered>
                                              <Text type="secondary">{copy.drawdown}</Text>
                                              <div><Text strong>{formatPercent(offer.metrics.dd)}</Text></div>
                                            </Card>
                                          </Col>
                                          <Col span={12}>
                                            <Card size="small" bordered>
                                              <Text type="secondary">{copy.profitFactor}</Text>
                                              <div><Text strong>{formatNumber(offer.metrics.pf)}</Text></div>
                                            </Card>
                                          </Col>
                                          <Col span={12}>
                                            <Card size="small" bordered>
                                              <Text type="secondary">{copy.trades}</Text>
                                              <div><Text strong>{formatNumber(offer.metrics.trades, 0)}</Text></div>
                                            </Card>
                                          </Col>
                                        </Row>
                                        <Space wrap>
                                          <Tag color="cyan">{copy.score}: {formatNumber(offer.metrics.score)}</Tag>
                                          {offer.metrics.robust ? <Tag color="success">robust</Tag> : <Tag color="default">candidate</Tag>}
                                          {summary?.sweepSummary?.period ? <Tag color="blue">SWEEP {formatPeriodLabel(summary.sweepSummary.period)}</Tag> : null}
                                          {summary?.offerStore?.defaults?.periodDays ? <Tag color="default">period {summary.offerStore.defaults.periodDays}d</Tag> : null}
                                          {offer.equity?.source ? <Tag color="processing">{String(offer.equity.source)}</Tag> : null}
                                        </Space>
                                        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                                          {offer.descriptionRu || 'Sweep-backed offer with preset-based selection.'}
                                        </Paragraph>
                                      </Space>
                                    </Card>
                                  </List.Item>
                                );
                              }}
                            />
                          )}
                        </Card>

                        {materializeResponse?.strategies?.length ? (
                          <Card className="battletoads-card" title="Материализованные стратегии">
                            <List
                              dataSource={materializeResponse.strategies}
                              renderItem={(item) => (
                                <List.Item>
                                  <Space direction="vertical" size={0}>
                                    <Text strong>{item.name}</Text>
                                    <Text type="secondary">{item.mode.toUpperCase()} • {item.type} • {item.market}</Text>
                                  </Space>
                                  <Space wrap>
                                    <Tag color="blue">id {item.strategyId || item.id}</Tag>
                                    <Tag color="cyan">{copy.score}: {formatNumber(item.metrics.score)}</Tag>
                                  </Space>
                                </List.Item>
                              )}
                            />
                          </Card>
                        ) : null}
                        </>
                        ) : (
                          <Alert type="info" showIcon message="Редактирование, настройка риска и подбор оферов выполняются через Админ → Оферы и ТС. Здесь оставлена только витрина." />
                        )}
                      </>
                    ) : null}
                  </Spin>
                </Space>
              ),
            },
            {
              key: 'algofund',
              label: copy.algofund,
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {algofundTenants.length === 0 ? <Alert type="info" showIcon message={copy.noTenant} /> : null}
                  {algofundError ? <Alert type="error" showIcon message={algofundError} /> : null}

                  <Spin spinning={algofundLoading && !algofundState}>
                    {algofundState ? (
                      <>
                        <Card className="battletoads-card" title={isAdminSurface ? 'Витрина Алгофонд' : copy.tenantWorkspace}>
                          {isAdminSurface ? (
                            <Tabs
                              destroyOnHidden
                              items={[
                                {
                                  key: 'algofund-storefront',
                                  label: 'Витрина',
                                  children: (
                                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                      <Alert
                                        type="info"
                                        showIcon
                                        message="Одобренная витрина Алгофонда и текущие TS-офферы."
                                      />
                                      {algofundStorefrontSystems.length === 0 ? (
                                        <Empty description="Витрина Алгофонда сейчас пуста: опубликованная TS еще не привязана к algofund-клиентам" />
                                      ) : (
                                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                          <Tag color="success">Опубликованные TS: {algofundStorefrontSystems.length}</Tag>
                                          <Text>Витринные TS офферы синхронизированы и доступны в карточках ниже</Text>
                                          <Text type="secondary">Клиентов с привязанной TS: {algofundTenantsWithPublishedTs.length}</Text>
                                        </Space>
                                      )}
                                      {algofundStorefrontSystems.length > 0 ? (
                                        <List
                                          grid={{ gutter: 12, xs: 1, md: 2, xl: 3 }}
                                          dataSource={algofundStorefrontSystems}
                                          renderItem={(item) => (
                                            <List.Item key={item.systemName}>
                                              <Card
                                                size="small"
                                                bordered
                                                title={
                                                  <Space>
                                                    <Tooltip title={getTsStrategyHint(item.systemName) ?? undefined} placement="topLeft"><Text strong style={{ cursor: getTsStrategyHint(item.systemName) ? 'help' : undefined }}>{tsDisplayName(item.systemName)}</Text></Tooltip>
                                                    {item.activeCount > 0
                                                      ? <Badge status="success" text="active" />
                                                      : item.pendingCount > 0
                                                        ? <Badge status="processing" text="pending" />
                                                        : <Badge status="default" text="no clients" />}
                                                  </Space>
                                                }
                                              >
                                                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                                  <Space wrap>
                                                    <Tag color="blue">clients {Number(item.tenantCount || 0)}</Tag>
                                                    <Tag color="green">active {Number(item.activeCount || 0)}</Tag>
                                                    {item.pendingCount > 0 ? <Tag color="gold">pending {item.pendingCount}</Tag> : null}
                                                    {!item.tenants.length && !item.runtimeSystemId ? <Tag color="default">legacy snapshot</Tag> : null}
                                                    {item.summary?.totalReturnPercent !== undefined
                                                      ? <Tag color={metricColor(Number(item.summary.totalReturnPercent || 0), 'return')}>Ret {formatPercent(item.summary.totalReturnPercent)}</Tag>
                                                      : null}
                                                    {item.summary?.maxDrawdownPercent !== undefined
                                                      ? <Tag color={metricColor(Number(item.summary.maxDrawdownPercent || 0), 'drawdown')}>DD {formatPercent(item.summary.maxDrawdownPercent)}</Tag>
                                                      : null}
                                                    {item.summary?.profitFactor !== undefined
                                                      ? <Tag color={metricColor(Number(item.summary.profitFactor || 0), 'pf')}>PF {formatNumber(item.summary.profitFactor)}</Tag>
                                                      : null}
                                                    {item.summary?.tradesCount !== undefined
                                                      ? (() => {
                                                          const activity = resolveTradeActivity(item.summary.tradesCount, item.summary?.periodDays);
                                                          return activity
                                                            ? <Tag color={activity.color}>{activity.label}</Tag>
                                                            : <Tag color="blue">сделок {formatNumber(item.summary.tradesCount, 0)}</Tag>;
                                                        })()
                                                      : null}
                                                  </Space>
                                                  {Array.isArray(item.equityCurve) && item.equityCurve.length > 1 ? (
                                                    <ChartComponent data={item.equityCurve} type="line" fixedHeight={120} />
                                                  ) : (
                                                    <Text type="secondary" style={{ fontSize: 12 }}>График не сохранен</Text>
                                                  )}
                                                  {item.tenants.length > 0
                                                    ? <Text type="secondary" style={{ fontSize: 12 }}>{item.tenants.map((t) => t.tenant.display_name).join(', ')}</Text>
                                                    : <Text type="secondary" style={{ fontSize: 12 }}>Нет подключённых клиентов</Text>}
                                                  <Space wrap>
                                                    <Button size="small" onClick={() => openBacktestDrawerForStorefrontTs(item.systemName)}>Бэктест ТС</Button>
                                                    <Button
                                                      size="small"
                                                      onClick={() => {
                                                        const runtimeSystemId = Number(item.runtimeSystemId || 0);
                                                        if (!runtimeSystemId) {
                                                          messageApi.warning('Для этой карточки пока нет runtime system id. Сначала опубликуйте/синхронизируйте ТС.');
                                                          return;
                                                        }
                                                        const initialIds2 = (item.tenants || [])
                                                            .map((tenant) => Number(tenant?.tenant?.id || 0))
                                                            .filter((tenantId) => Number.isFinite(tenantId) && tenantId > 0);
                                                        setStorefrontConnectTarget({
                                                          systemId: runtimeSystemId,
                                                          systemName: item.systemName,
                                                          tenantIds: initialIds2,
                                                          originalTenantIds: initialIds2,
                                                        });
                                                      }}
                                                    >
                                                      Подключить клиентов
                                                    </Button>
                                                    <Button
                                                      size="small"
                                                      danger
                                                      loading={removeStorefrontTarget === item.systemName}
                                                      onClick={() => void initiateRemoveStorefront(item.systemName)}
                                                    >
                                                      Снять с витрины
                                                    </Button>
                                                  </Space>
                                                </Space>
                                              </Card>
                                            </List.Item>
                                          )}
                                        />
                                      ) : null}
                                      <Space wrap>
                                        <Button onClick={() => navigateToAdminTab('clients')}>К клиентам Алгофонда</Button>
                                      </Space>
                                    </Space>
                                  ),
                                },
                                {
                                  key: 'algofund-client-card',
                                  label: 'Карточка клиента',
                                  children: (() => {
                                    const runtime = selectedAlgofundTenantSummary ? resolveTenantRuntimeStatus(selectedAlgofundTenantSummary) : null;
                                    const billing = selectedAlgofundTenantSummary ? extractTenantBillingInfo(selectedAlgofundTenantSummary) : null;
                                    return (
                                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                        <Alert
                                          type="info"
                                          showIcon
                                          message="Карточка клиента Algofund: выбор клиента, тариф, риск, метрики и настройки."
                                        />
                                        <Row gutter={[12, 12]}>
                                          <Col xs={24} md={8}>
                                            <Text strong>{copy.chooseTenant}</Text>
                                            <div style={{ marginTop: 4, marginBottom: 4 }}>
                                              <Segmented
                                                size="small"
                                                value={algofundTenantStatus}
                                                onChange={(v) => setAlgofundTenantStatus(String(v))}
                                                options={[
                                                  { label: 'Активные', value: 'active' },
                                                  { label: 'Стоп', value: 'standby' },
                                                  { label: 'Все', value: 'all' },
                                                ]}
                                              />
                                            </div>
                                            <Select
                                              style={{ width: '100%', marginTop: 4 }}
                                              value={algofundTenantId ?? undefined}
                                              onChange={(value) => setAlgofundTenantId(Number(value))}
                                              options={algofundTenants
                                                .filter((item) => {
                                                  if (algofundTenantStatus === 'all') return true;
                                                  const enabled = !!item.algofundProfile?.actual_enabled;
                                                  return algofundTenantStatus === 'active' ? enabled : !enabled;
                                                })
                                                .map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                                            />
                                          </Col>
                                          <Col xs={24} md={8}>
                                            <Text strong>{copy.displayName}</Text>
                                            <Input style={{ marginTop: 8 }} value={algofundTenantDisplayName} onChange={(event) => setAlgofundTenantDisplayName(event.target.value)} />
                                          </Col>
                                          <Col xs={24} md={8}>
                                            <Text strong>{copy.apiKey}</Text>
                                            <Select
                                              style={{ width: '100%', marginTop: 8 }}
                                              value={algofundApiKeyName || undefined}
                                              onChange={setAlgofundApiKeyName}
                                              options={apiKeyOptions}
                                              disabled={!algofundApiKeyEditable}
                                            />
                                          </Col>
                                        </Row>
                                        <Space wrap>
                                          {runtime ? (
                                            <Tooltip title={runtime.details}>
                                              <Tag color={runtime.level}>Движок: {runtime.stateLabel}</Tag>
                                            </Tooltip>
                                          ) : null}
                                          <Tag color={algofundState.profile?.requested_enabled ? 'processing' : 'warning'}>
                                            {algofundState.profile?.requested_enabled ? 'торговля включена' : 'торговля выключена'}
                                          </Tag>
                                          <Tag color={algofundState.tenant.status === 'active' ? 'success' : 'default'}>{copy.tenantStatus}: {algofundState.tenant.status || '—'}</Tag>
                                          {billing ? (
                                            <Tooltip title={billing.details}>
                                              <Tag color={billing.color}>Оплата: {billing.label}</Tag>
                                            </Tooltip>
                                          ) : null}
                                        </Space>
                                        <Descriptions column={1} size="small" bordered>
                                          <Descriptions.Item label={copy.displayName}>{algofundState.tenant.display_name || '—'}</Descriptions.Item>
                                          <Descriptions.Item label={copy.plan}>{algofundState.plan ? `${algofundState.plan.title} • ${formatMoney(algofundState.plan.price_usdt)}` : '—'}</Descriptions.Item>
                                          <Descriptions.Item label={copy.depositCap}>{formatMoney(algofundState.plan?.max_deposit_total)}</Descriptions.Item>
                                          <Descriptions.Item label={copy.riskCap}>{formatNumber(algofundState.plan?.risk_cap_max)}</Descriptions.Item>
                                          <Descriptions.Item label={copy.risk}>{formatNumber(algofundRiskMultiplier)}x</Descriptions.Item>
                                          <Descriptions.Item label="Published TS">{String(algofundState.profile?.published_system_name || '—')}</Descriptions.Item>
                                        </Descriptions>
                                        <Space wrap>
                                          {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="green">Eq {formatMoney(selectedAlgofundTenantSummary.monitoring.equity_usd)}</Tag> : null}
                                          {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="geekblue">{copy.unrealizedPnl}: {formatMoney(selectedAlgofundTenantSummary.monitoring.unrealized_pnl)}</Tag> : null}
                                          {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="orange">DD {formatPercent(selectedAlgofundTenantSummary.monitoring.drawdown_percent)}</Tag> : null}
                                          {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="purple">{copy.marginLoad}: {formatPercent(selectedAlgofundTenantSummary.monitoring.margin_load_percent)}</Tag> : null}
                                          {!algofundMonitoringEnabled ? <Tag color="default">{copy.monitoring}: off</Tag> : null}
                                        </Space>
                                        <Space wrap>
                                          <Select
                                            style={{ width: 180 }}
                                            value={algofundTenantPlanCode || undefined}
                                            onChange={setAlgofundTenantPlanCode}
                                            options={algofundPlanOptions}
                                          />
                                          <InputNumber
                                            min={0}
                                            max={10}
                                            step={0.05}
                                            style={{ width: 140 }}
                                            value={algofundRiskMultiplier}
                                            onChange={(value) => setAlgofundRiskMultiplier(clampPreviewValue(Number(value ?? 0), 10))}
                                          />
                                          <Button onClick={() => void saveAlgofundProfile()} loading={actionLoading === 'algofund-save'} disabled={!algofundSettingsEnabled}>
                                            {copy.saveProfile}
                                          </Button>
                                        </Space>
                                        <Space wrap>
                                          <Select
                                            value={algofundTenantStatus}
                                            onChange={setAlgofundTenantStatus}
                                            style={{ width: 180 }}
                                            options={[
                                              { value: 'active', label: 'active' },
                                              { value: 'suspended', label: 'suspended' },
                                              { value: 'paused', label: 'paused' },
                                            ]}
                                          />
                                          <Button type="primary" onClick={() => void saveAlgofundTenantAdmin()} loading={actionLoading === 'algofund-tenant-save'}>
                                            {copy.saveTenant}
                                          </Button>
                                          <Button danger onClick={() => void emergencyStopAlgofund()} loading={actionLoading === 'algofund-emergency'}>
                                            {copy.emergencyStop}
                                          </Button>
                                          <Button onClick={() => void createAlgofundMagicLink()} loading={actionLoading === 'algofund-magic-link'}>
                                            {copy.createMagicLink}
                                          </Button>
                                        </Space>
                                        <Card size="small" className="battletoads-card" title="Подключенные карточки (ТС) и клиентский риск">
                                          {connectedAlgofundCards.length === 0 ? (
                                            <Empty description="У клиента нет подключенных карточек ТС" />
                                          ) : (
                                            <List
                                              size="small"
                                              rowKey={(item) => `${item.id}:${item.systemName}`}
                                              dataSource={connectedAlgofundCards}
                                              renderItem={(item) => {
                                                const draftWeight = Number(algofundCardRiskDrafts[String(item.systemName || '')] ?? item.weight ?? 0);
                                                return (
                                                  <List.Item
                                                    actions={[
                                                      <Button
                                                        key="save"
                                                        size="small"
                                                        type="primary"
                                                        loading={actionLoading === `algofund-card-risk:${item.systemName}`}
                                                        onClick={() => void saveAlgofundCardRisk(item.systemName)}
                                                      >
                                                        Сохранить риск
                                                      </Button>,
                                                    ]}
                                                  >
                                                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                                      <Space wrap>
                                                        <Text strong>{item.systemName}</Text>
                                                        <Tag color={item.isEnabled ? 'success' : 'warning'}>{item.isEnabled ? 'active' : 'disabled'}</Tag>
                                                        <Tag color={item.assignedBy === 'client' ? 'purple' : 'default'}>{item.assignedBy}</Tag>
                                                      </Space>
                                                      <Space wrap>
                                                        <Text type="secondary">Клиентский риск карточки:</Text>
                                                        <InputNumber
                                                          min={0}
                                                          max={10}
                                                          step={0.05}
                                                          value={draftWeight}
                                                          onChange={(value) => {
                                                            const next = Number(value ?? 0);
                                                            setAlgofundCardRiskDrafts((current) => ({
                                                              ...current,
                                                              [String(item.systemName || '')]: Number.isFinite(next) ? next : 0,
                                                            }));
                                                          }}
                                                        />
                                                      </Space>
                                                    </Space>
                                                  </List.Item>
                                                );
                                              }}
                                            />
                                          )}
                                        </Card>
                                        <Alert
                                          type="info"
                                          showIcon
                                          message="Multi-TS назначение перенесено во вкладку Клиенты"
                                          description="Там же доступно управление активными TS, флагами и назначениями без дублирования блоков."
                                          action={<Button size="small" onClick={() => navigateToAdminTab('clients')}>Открыть Клиенты</Button>}
                                        />
                                      </Space>
                                    );
                                  })(),
                                },
                              ]}
                            />
                          ) : (
                            <>
                          {/* Клиентская витрина Алгофонда */}
                          {algofundStorefrontSystems.length > 0 ? (
                            <Card className="battletoads-card" title="Витрина Алгофонда" style={{ marginBottom: 16 }}>
                              <List
                                grid={{ gutter: 12, xs: 1, md: 2, xl: 3 }}
                                dataSource={algofundStorefrontSystems}
                                renderItem={(item) => (
                                  <List.Item key={item.systemName}>
                                    <Card size="small" bordered title={<Text strong>{tsDisplayName(item.systemName)}</Text>}>
                                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                        <Space wrap>
                                          {item.summary?.totalReturnPercent !== undefined
                                            ? <Tag color={metricColor(Number(item.summary.totalReturnPercent || 0), 'return')}>Ret {formatPercent(item.summary.totalReturnPercent)}</Tag>
                                            : null}
                                          {item.summary?.maxDrawdownPercent !== undefined
                                            ? <Tag color={metricColor(Number(item.summary.maxDrawdownPercent || 0), 'drawdown')}>DD {formatPercent(item.summary.maxDrawdownPercent)}</Tag>
                                            : null}
                                          {item.summary?.profitFactor !== undefined
                                            ? <Tag color={metricColor(Number(item.summary.profitFactor || 0), 'pf')}>PF {formatNumber(item.summary.profitFactor)}</Tag>
                                            : null}
                                          {item.summary?.tradesCount !== undefined
                                            ? (() => {
                                                const activity = resolveTradeActivity(item.summary.tradesCount, item.summary?.periodDays);
                                                return activity
                                                  ? <Tag color={activity.color}>{activity.label}</Tag>
                                                  : <Tag color="blue">сделок {formatNumber(item.summary.tradesCount, 0)}</Tag>;
                                              })()
                                            : null}
                                        </Space>
                                        {Array.isArray(item.equityCurve) && item.equityCurve.length > 1 ? (
                                          <ChartComponent data={item.equityCurve} type="line" fixedHeight={120} />
                                        ) : (
                                          <Text type="secondary" style={{ fontSize: 12 }}>График не сохранен</Text>
                                        )}
                                        <Button size="small" onClick={() => openBacktestDrawerForStorefrontTs(item.systemName)}>Бэктест</Button>
                                      </Space>
                                    </Card>
                                  </List.Item>
                                )}
                              />
                            </Card>
                          ) : (
                            <Alert type="info" showIcon message="Витрина Алгофонда пока пуста" style={{ marginBottom: 16 }} />
                          )}

                          <Row gutter={[16, 16]} align="middle">
                            {isAdminSurface ? (
                              <Col xs={24} md={6}>
                                <Text strong>{copy.chooseTenant}</Text>
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={algofundTenantId ?? undefined}
                                  onChange={(value) => setAlgofundTenantId(Number(value))}
                                  options={algofundTenants.map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                                />
                              </Col>
                            ) : null}
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>{copy.displayName}</Text>
                              {isAdminSurface ? (
                                <Input style={{ marginTop: 8 }} value={algofundTenantDisplayName} onChange={(event) => setAlgofundTenantDisplayName(event.target.value)} />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{algofundState.tenant.display_name}</Text></div>
                              )}
                            </Col>
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>{copy.apiKey}</Text>
                              {isAdminSurface ? (
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={algofundApiKeyName || undefined}
                                  onChange={setAlgofundApiKeyName}
                                  options={apiKeyOptions}
                                  disabled={!algofundApiKeyEditable}
                                />
                              ) : (
                                <div style={{ marginTop: 8 }}>
                                  <Space>
                                    <Text>{algofundApiKeyName || '—'}</Text>
                                    {algofundApiKeyName
                                      ? <Tag color={algofundState.profile?.actual_enabled ? 'success' : 'default'}>{algofundState.profile?.actual_enabled ? 'подключён' : 'не активен'}</Tag>
                                      : null}
                                  </Space>
                                </div>
                              )}
                            </Col>
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>{copy.plan}</Text>
                              {isAdminSurface ? (
                                <Select style={{ width: '100%', marginTop: 8 }} value={algofundTenantPlanCode || undefined} onChange={setAlgofundTenantPlanCode} options={algofundPlanOptions} />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{algofundState.plan ? `${algofundState.plan.title} · ${formatMoney(algofundState.plan.price_usdt)}` : '—'}</Text></div>
                              )}
                            </Col>
                          </Row>
                          <Space wrap style={{ marginTop: 12 }}>
                            <Text strong>{copy.planCapabilities}:</Text>
                            {renderCapabilityTags(copy, algofundCapabilities)}
                          </Space>
                          <Space wrap style={{ marginTop: 16 }}>
                            <Tag color="blue">{copy.depositCap}: {formatMoney(algofundState.plan?.max_deposit_total)}</Tag>
                            <Tag color="gold">{copy.riskCap}: {formatNumber(algofundState.plan?.risk_cap_max)}</Tag>
                            <Tag color="cyan">{copy.tenantStatus}: {isAdminSurface ? algofundTenantStatus : algofundState.tenant.status}</Tag>
                            {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="green">Eq {formatMoney(selectedAlgofundTenantSummary.monitoring.equity_usd)}</Tag> : null}
                            {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="geekblue">{copy.unrealizedPnl}: {formatMoney(selectedAlgofundTenantSummary.monitoring.unrealized_pnl)}</Tag> : null}
                            {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="orange">DD {formatPercent(selectedAlgofundTenantSummary.monitoring.drawdown_percent)}</Tag> : null}
                            {algofundMonitoringEnabled && selectedAlgofundTenantSummary?.monitoring ? <Tag color="purple">{copy.marginLoad}: {formatPercent(selectedAlgofundTenantSummary.monitoring.margin_load_percent)}</Tag> : null}
                            {algofundMonitoringEnabled && selectedAlgofundTenantSummary ? (() => {
                              const load = calcDepositLoadPercent(selectedAlgofundTenantSummary);
                              return load !== null ? <Tag color="cyan">{copy.depositLoad}: {formatPercent(load)}</Tag> : null;
                            })() : null}
                            {algofundMonitoringEnabled && selectedAlgofundTenantSummary ? (() => {
                              const liq = calcLiquidationRisk(selectedAlgofundTenantSummary);
                              return <Tag color={liq.color}>{copy.liquidationRisk}: {liq.level}{liq.bufferPercent !== null ? ` (${formatPercent(liq.bufferPercent)} buf)` : ''}</Tag>;
                            })() : null}
                            {!algofundMonitoringEnabled ? <Tag color="default">{copy.monitoring}: off</Tag> : null}
                          </Space>
                          <Space wrap style={{ marginTop: 12 }}>
                            <Button size="small" href="/settings" disabled={!algofundSettingsEnabled}>{copy.openSettings}</Button>
                            <Button size="small" href="/positions" disabled={!algofundMonitoringEnabled && !isAdminSurface}>{copy.openMonitoring}</Button>
                            <Button size="small" onClick={() => openSaasBacktestFlow(undefined, { forceKind: 'algofund-ts' })} disabled={!algofundBacktestEnabled}>{copy.openBacktest}</Button>
                          </Space>
                          {isAdminSurface ? (
                            <>
                              <Space wrap style={{ marginTop: 12 }}>
                                <Select
                                  value={algofundTenantStatus}
                                  onChange={setAlgofundTenantStatus}
                                  style={{ width: 180 }}
                                  options={[
                                    { value: 'active', label: 'active' },
                                    { value: 'suspended', label: 'suspended' },
                                    { value: 'paused', label: 'paused' },
                                  ]}
                                />
                                <Button type="primary" onClick={() => void saveAlgofundTenantAdmin()} loading={actionLoading === 'algofund-tenant-save'}>
                                  {copy.saveTenant}
                                </Button>
                                <Button danger onClick={() => void emergencyStopAlgofund()} loading={actionLoading === 'algofund-emergency'}>
                                  {copy.emergencyStop}
                                </Button>
                                <Button onClick={() => void createAlgofundMagicLink()} loading={actionLoading === 'algofund-magic-link'}>
                                  {copy.createMagicLink}
                                </Button>
                              </Space>
                              {algofundMagicLink && algofundMagicLink.loginUrl ? (
                                <Alert
                                  style={{ marginTop: 8 }}
                                  type="info"
                                  showIcon
                                  message={copy.magicLinkReady}
                                  description={
                                    <>
                                      <div style={{ marginBottom: 8 }}><strong>Ссылка для входа:</strong></div>
                                      <div><a href={algofundMagicLink.loginUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{algofundMagicLink.loginUrl}</a></div>
                                      <div style={{ marginTop: 8 }}>{copy.magicLinkExpires}: {new Date(algofundMagicLink.expiresAt).toLocaleString()}</div>
                                    </>
                                  }
                                />
                              ) : null}
                            </>
                          ) : null}
                            </>
                          )}
                        </Card>

                        <Card className="battletoads-card">
                          <Row gutter={[16, 16]} align="middle">
                            <Col xs={24} lg={16}>
                              <Text strong>{copy.risk}: {formatNumber(algofundRiskMultiplier)}x</Text>
                              <Slider
                                min={0}
                                max={isAdminSurface ? 10 : Number(algofundState.plan?.risk_cap_max || 1)}
                                step={0.05}
                                value={algofundRiskMultiplier}
                                onChange={(value) => setAlgofundRiskMultiplier(clampPreviewValue(Number(value), isAdminSurface ? 10 : Number(algofundState.plan?.risk_cap_max || 1)))}
                              />
                              <InputNumber
                                min={0}
                                max={isAdminSurface ? 10 : Number(algofundState.plan?.risk_cap_max || 1)}
                                step={0.05}
                                style={{ width: '100%' }}
                                value={algofundRiskMultiplier}
                                onChange={(value) => setAlgofundRiskMultiplier(clampPreviewValue(Number(value ?? 0), isAdminSurface ? 10 : Number(algofundState.plan?.risk_cap_max || 1)))}
                              />
                              <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                                1.0x = базовый размер позиции выбранной ТС. Значение выше усиливает размер позиций, ниже уменьшает. Состав ТС и набор стратегий этот слайдер не меняет.
                              </Paragraph>
                            </Col>
                            <Col xs={24} lg={8}>
                              <Space wrap style={{ marginTop: 24 }}>
                                <Button type="primary" onClick={() => void saveAlgofundProfile()} loading={actionLoading === 'algofund-save'} disabled={!algofundSettingsEnabled}>{copy.saveProfile}</Button>
                                <Button onClick={() => void runStrategySelectionPreview()} loading={strategySelectionPreviewLoading}>Preview selected offers</Button>
                                <Button onClick={() => void refreshAlgofundPreview()}>{copy.preview}</Button>
                              </Space>
                            </Col>
                          </Row>
                          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>{copy.previewPlanCapHint}</Paragraph>
                        </Card>

                        <Card className="battletoads-card" title={copy.engineStatus}>
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Space wrap>
                              {algofundEngineRunning ? <Tag color="success">{copy.engineRunning}</Tag> : null}
                              {algofundEnginePending ? <Tag color="processing">{copy.enginePending}</Tag> : null}
                              {!algofundEngineRunning && !algofundEnginePending ? <Tag color="default">{copy.engineStopped}</Tag> : null}
                              {algofundEngineBlockedReason ? <Tag color="warning">{copy.engineBlocked}</Tag> : null}
                            </Space>
                            <Descriptions column={1} size="small" bordered>
                              <Descriptions.Item label={copy.engineStatus}>
                                {algofundEngineRunning
                                  ? copy.engineRunning
                                  : algofundEnginePending
                                    ? copy.enginePending
                                    : copy.engineStopped}
                              </Descriptions.Item>
                              <Descriptions.Item label="Engine fact">{algofundEngineRunning ? 'STARTED' : 'NOT STARTED'}</Descriptions.Item>
                              <Descriptions.Item label={copy.sourceSystem}>{algofundState.engine?.systemName || algofundState.profile?.published_system_name || '—'}</Descriptions.Item>
                              <Descriptions.Item label={copy.engineSystemId}>{algofundState.engine?.systemId ?? '—'}</Descriptions.Item>
                              <Descriptions.Item label={copy.apiKey}>{algofundState.engine?.apiKeyName || algofundState.profile?.assigned_api_key_name || algofundState.tenant.assigned_api_key_name || '—'}</Descriptions.Item>
                            </Descriptions>
                            <Button onClick={() => { navigateToAdminTab('clients'); setClientsModeFilter('algofund_client'); }}>{copy.openTradingSystems}</Button>
                            {algofundEnginePending && !algofundEngineRunning ? (
                              <>
                                <Alert
                                  type="warning"
                                  showIcon
                                  message={copy.engineNotMaterialized}
                                  description={algofundEngineBlockedReason || undefined}
                                />
                                <Button
                                  type="primary"
                                  onClick={() => setRetryMaterializeModalVisible(true)}
                                  loading={actionLoading === 'retry-materialize'}
                                >
                                  Retry materialization
                                </Button>
                              </>
                            ) : null}
                            {algofundEngineRunning ? (
                              <Alert
                                type="success"
                                showIcon
                                message={copy.engineRunning}
                                description={algofundState.preview?.sourceSystem?.systemName || undefined}
                              />
                            ) : null}
                          </Space>
                        </Card>

                        <Card className="battletoads-card" title="Client requests">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} lg={16}>
                              <Input.TextArea rows={3} value={algofundNote} onChange={(event) => setAlgofundNote(event.target.value)} placeholder={copy.note} />
                              <Space wrap style={{ marginTop: 12 }}>
                                <Button type="primary" onClick={() => void sendAlgofundRequest('start')} loading={actionLoading === 'algofund-start'} disabled={!algofundStartStopEnabled}>{copy.requestStart}</Button>
                                <Button danger onClick={() => void sendAlgofundRequest('stop')} loading={actionLoading === 'algofund-stop'} disabled={!algofundStartStopEnabled}>{copy.requestStop}</Button>
                                {algofundState.profile?.actual_enabled ? <Tag color="success">live enabled</Tag> : <Tag color="default">live disabled</Tag>}
                                {algofundState.profile?.requested_enabled ? <Tag color="processing">запрошен запуск</Tag> : null}
                                {!algofundStartStopEnabled ? <Tag color="default">{copy.capabilityStartStop}: off</Tag> : null}
                              </Space>
                            </Col>
                            <Col xs={24} lg={8}>
                              <Descriptions column={1} size="small" bordered>
                                <Descriptions.Item label={copy.status}>{algofundState.tenant.status}</Descriptions.Item>
                                <Descriptions.Item label={copy.apiKey}>{algofundState.profile?.assigned_api_key_name || algofundState.tenant.assigned_api_key_name || '—'}</Descriptions.Item>
                                <Descriptions.Item label={copy.riskCap}>{formatNumber(algofundState.plan?.risk_cap_max)}</Descriptions.Item>
                              </Descriptions>
                            </Col>
                          </Row>
                        </Card>


                      </>
                    ) : null}
                  </Spin>
                </Space>
              ),
            },
            {
              key: 'copytrading',
              label: 'Copytrading',
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {copytradingTenants.length === 0 ? (
                    <Alert
                      type="info"
                      showIcon
                      message={copy.noTenant}
                      description={isAdminSurface ? (
                        <Button
                          style={{ marginTop: 8 }}
                          type="primary"
                          loading={actionLoading === 'create-copytrading-tenant'}
                          onClick={() => void createCopytradingTenantQuick()}
                        >
                          Создать copytrading-клиента
                        </Button>
                      ) : undefined}
                    />
                  ) : null}
                  {copytradingError ? <Alert type="error" showIcon message={copytradingError} /> : null}

                  <Spin spinning={copytradingLoading && !copytradingState}>
                    {copytradingState ? (
                      <>
                        <Card className="battletoads-card" title="Copytrading — Mirror Mode">
                          {/* ── Top row: tenant + master key + plan ─────────────────── */}
                          <Row gutter={[16, 16]} align="middle">
                            {isAdminSurface ? (
                              <Col xs={24} md={6}>
                                <Text strong>{copy.chooseTenant}</Text>
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={copytradingTenantId ?? undefined}
                                  onChange={(value) => setCopytradingTenantId(Number(value))}
                                  options={copytradingTenants.map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                                />
                              </Col>
                            ) : null}
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>Название</Text>
                              {isAdminSurface ? (
                                <Input style={{ marginTop: 8 }} value={copytradingTenantDisplayName} onChange={(event) => setCopytradingTenantDisplayName(event.target.value)} />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{copytradingState.tenant?.display_name}</Text></div>
                              )}
                            </Col>
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>API ключ мастера</Text>
                              {isAdminSurface ? (
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={copytradingMasterApiKeyName || undefined}
                                  onChange={setCopytradingMasterApiKeyName}
                                  options={apiKeyOptions}
                                  placeholder="Выбрать из существующих"
                                />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{copytradingMasterApiKeyName || '—'}</Text></div>
                              )}
                            </Col>
                            {isAdminSurface ? (
                              <Col xs={24} md={6}>
                                <Text strong>{copy.plan}</Text>
                                <Select style={{ width: '100%', marginTop: 8 }} value={copytradingTenantPlanCode || undefined} onChange={setCopytradingTenantPlanCode} options={copytradingPlanOptions} />
                              </Col>
                            ) : null}
                          </Row>

                          {/* ── Status strip ─────────────────────────────────────────── */}
                          <Space wrap style={{ marginTop: 12 }}>
                            <Tag color="purple">Ratio: {formatNumber(copytradingCopyRatio, 2)}x</Tag>
                            <Tag color={copytradingCopyEnabled ? 'success' : 'default'}>
                              {copytradingCopyEnabled ? '● Копирование ВКЛ' : '○ Копирование ВЫКЛ'}
                            </Tag>
                            <Tag color="cyan">{copytradingState.tenant?.status}</Tag>
                            <Tag color="green">{copytradingState.plan?.title || 'copytrading_100'}</Tag>
                          </Space>

                          {isAdminSurface ? (
                            <>
                              {/* ── Master + ratio settings ─────────────────────────── */}
                              <Card size="small" title="Настройки мастера" style={{ marginTop: 16 }}>
                                <Row gutter={[12, 12]}>
                                  <Col xs={24} md={10}>
                                    <Text strong>Имя мастера</Text>
                                    <Input style={{ marginTop: 8 }} value={copytradingMasterName} onChange={(event) => setCopytradingMasterName(event.target.value)} />
                                  </Col>
                                  <Col xs={24} md={6}>
                                    <Text strong>Коэффициент копирования</Text>
                                    <InputNumber
                                      style={{ width: '100%', marginTop: 8 }}
                                      min={0.01} max={100} step={0.01}
                                      value={copytradingCopyRatio}
                                      onChange={(value) => setCopytradingCopyRatio(Number(value || 1))}
                                    />
                                  </Col>
                                  <Col xs={24} md={8}>
                                    <Space align="center" style={{ marginTop: 28 }}>
                                      <Switch checked={copytradingCopyEnabled} onChange={setCopytradingCopyEnabled} />
                                      <Text>Копирование включено</Text>
                                    </Space>
                                  </Col>
                                </Row>
                              </Card>

                              {/* ── Follower tenants ─────────────────────────────────── */}
                              <Card size="small" title={`Подключённые фолловеры (${(copytradingFollowers || []).length}/5)`} style={{ marginTop: 16 }}>
                                {/* Add follower row — select from existing API keys */}
                                <Row gutter={[12, 8]} style={{ marginBottom: 12 }}>
                                  <Col xs={24} md={9}>
                                    <Select
                                      style={{ width: '100%' }}
                                      value={copyFollowerApiKeyName || undefined}
                                      onChange={setCopyFollowerApiKeyName}
                                      options={apiKeyOptions}
                                      placeholder="API ключ фолловера"
                                      showSearch
                                    />
                                  </Col>
                                  <Col xs={24} md={9}>
                                    <Input
                                      value={copyFollowerTenantName}
                                      onChange={(e) => setCopyFollowerTenantName(e.target.value)}
                                      placeholder="Имя (необязательно)"
                                    />
                                  </Col>
                                  <Col xs={24} md={6}>
                                    <Button style={{ width: '100%' }} onClick={addCopytradingFollower} disabled={(copytradingFollowers || []).length >= 5}>
                                      + Добавить
                                    </Button>
                                  </Col>
                                </Row>

                                {(copytradingFollowers || []).length === 0 ? (
                                  <Empty description="Нет подключённых фолловеров" />
                                ) : (
                                  <Table
                                    size="small"
                                    rowKey={(_, idx) => String(idx)}
                                    dataSource={copytradingFollowers || []}
                                    pagination={false}
                                    columns={[
                                      { title: 'Имя', dataIndex: 'displayName', width: 160 },
                                      { title: 'API Key', dataIndex: 'apiKeyName', width: 200 },
                                      { title: 'Tags', dataIndex: 'tags', width: 160 },
                                      {
                                        title: '',
                                        key: 'action',
                                        width: 80,
                                        render: (_: any, __: any, index: number) => (
                                          <Button danger size="small" onClick={() => removeCopytradingFollower(index)}>Удалить</Button>
                                        ),
                                      },
                                    ]}
                                  />
                                )}
                                <Text type="secondary" style={{ marginTop: 8, display: 'block' }}>Лимит: до 5 фолловеров</Text>
                              </Card>

                              {/* ── Copy status / log ────────────────────────────────── */}
                              <Card size="small" title="Статус копирования" style={{ marginTop: 16 }}>
                                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                  <Alert
                                    showIcon
                                    type={copytradingUiStatus === 'error' ? 'error' : copytradingUiStatus === 'copying' ? 'success' : copytradingUiStatus === 'saving' ? 'warning' : 'info'}
                                    message={copytradingUiMessage}
                                  />
                                  <List
                                    size="small"
                                    bordered
                                    dataSource={copytradingLogs.slice(-8)}
                                    locale={{ emptyText: 'Лог пуст' }}
                                    renderItem={(item) => <List.Item style={{ fontSize: 12 }}>{item}</List.Item>}
                                    style={{ maxHeight: 160, overflowY: 'auto' }}
                                  />
                                </Space>
                              </Card>

                              {/* ── Action buttons ──────────────────────────────────── */}
                              <Space wrap style={{ marginTop: 16 }}>
                                <Button
                                  type="primary"
                                  loading={copytradingLoading}
                                  onClick={async () => {
                                    try {
                                      if (!copytradingTenantId) return;
                                      setCopytradingUiStatus('saving');
                                      setCopytradingUiMessage('Сохраняем настройки copytrading...');
                                      appendCopytradingLog(`Tenant #${copytradingTenantId}: отправка обновления`);
                                      await axios.patch(`/api/saas/admin/tenants/${copytradingTenantId}`, {
                                        displayName: copytradingTenantDisplayName,
                                        planCode: copytradingTenantPlanCode,
                                        assignedApiKeyName: copytradingMasterApiKeyName,
                                      });
                                      await axios.patch(`/api/saas/copytrading/${copytradingTenantId}`, {
                                        masterApiKeyName: copytradingMasterApiKeyName,
                                        masterName: copytradingMasterName,
                                        masterTags: copytradingMasterTags,
                                        tenants: copytradingFollowers,
                                        copyAlgorithm: 'vwap_basic',
                                        copyPrecision: 'standard',
                                        copyRatio: copytradingCopyRatio,
                                        copyEnabled: copytradingCopyEnabled,
                                      });
                                      appendCopytradingLog(`Tenant #${copytradingTenantId}: обновление применено`);
                                      await loadSummary('light');
                                      await loadCopytradingTenant(copytradingTenantId);
                                    } catch (err: any) {
                                      const msg = String(err?.response?.data?.error || err?.message || 'Update failed');
                                      setCopytradingError(msg);
                                      setCopytradingUiStatus('error');
                                      setCopytradingUiMessage(`Ошибка: ${msg}`);
                                    }
                                  }}
                                >
                                  💾 Сохранить
                                </Button>

                                <Select
                                  value={copytradingSyncMarketType}
                                  onChange={(v) => setCopytradingSyncMarketType(v)}
                                  style={{ width: 110 }}
                                  options={[
                                    { value: 'swap', label: 'Futures' },
                                    { value: 'spot', label: 'Spot' },
                                  ]}
                                />
                                <Button
                                  type="primary"
                                  style={{ background: '#52c41a', borderColor: '#52c41a' }}
                                  loading={copytradingSyncing}
                                  onClick={() => void syncCopytradingSession()}
                                  disabled={!copytradingCopyEnabled || !copytradingTenantId}
                                  title="Читает позиции мастера и зеркалирует изменения фолловерам"
                                >
                                  🔄 Синхронизировать позиции
                                </Button>

                                <Button
                                  danger
                                  loading={copytradingLoading}
                                  onClick={() => void stopCopytradingAndReset()}
                                  disabled={!copytradingTenantId}
                                  title="Выключает копирование и сбрасывает базовые позиции"
                                >
                                  ⛔ Стоп + Сброс
                                </Button>
                              </Space>
                            </>
                          ) : (
                            /* ── Client view ──────────────────────────────────────── */
                            <Card size="small" title="Статус копирования" style={{ marginTop: 16 }}>
                              <Alert
                                showIcon
                                type={copytradingUiStatus === 'error' ? 'error' : copytradingUiStatus === 'copying' ? 'success' : 'info'}
                                message={copytradingUiMessage}
                              />
                            </Card>
                          )}
                        </Card>
                      </>
                    ) : null}
                  </Spin>
                </Space>
              ),
            },
            {
              key: 'synctrade',
              label: 'Синхротрейд',
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {synctradeTenants.length === 0 ? (
                    <Alert
                      type="info"
                      showIcon
                      message="Нет клиентов Синхротрейд"
                      description={isAdminSurface ? (
                        <Button
                          style={{ marginTop: 8 }}
                          type="primary"
                          loading={actionLoading === 'create-synctrade-tenant'}
                          onClick={() => void createSynctradeTenantQuick()}
                        >
                          Создать synctrade-клиента
                        </Button>
                      ) : undefined}
                    />
                  ) : null}
                  {synctradeError ? <Alert type="error" showIcon message={synctradeError} /> : null}

                  <Spin spinning={synctradeLoading && !synctradeState}>
                    {synctradeState ? (
                      <>
                        <Card className="battletoads-card" title="Синхротрейд · Hedge PnL Engine">
                          <Alert
                            type="warning"
                            showIcon
                            message="Синхронная торговля на MEXC Futures"
                            description="Мастер-аккаунт генерирует прибыль (+), hedge-аккаунты генерируют управляемый убыток (−). Суммарный P&L = 0 ± комиссии."
                            style={{ marginBottom: 16 }}
                          />
                          <Row gutter={[16, 16]} align="middle">
                            {isAdminSurface ? (
                              <Col xs={24} md={6}>
                                <Text strong>Клиент</Text>
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={synctradeTenantId ?? undefined}
                                  onChange={(value) => setSynctradeTenantId(Number(value))}
                                  options={synctradeTenants.map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                                />
                              </Col>
                            ) : null}
                            <Col xs={24} md={6}>
                              <Text strong>Master API Key (MEXC)</Text>
                              {isAdminSurface ? (
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={synctradeMasterApiKeyName || undefined}
                                  onChange={setSynctradeMasterApiKeyName}
                                  options={apiKeyOptions}
                                />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{synctradeMasterApiKeyName || '—'}</Text></div>
                              )}
                            </Col>
                            <Col xs={24} md={4}>
                              <Text strong>Символ</Text>
                              <Select
                                style={{ width: '100%', marginTop: 8 }}
                                value={synctradeSymbol}
                                onChange={setSynctradeSymbol}
                                options={[
                                  { value: 'BTCUSDT', label: 'BTCUSDT' },
                                  { value: 'ETHUSDT', label: 'ETHUSDT' },
                                  { value: 'SOLUSDT', label: 'SOLUSDT' },
                                  { value: 'XRPUSDT', label: 'XRPUSDT' },
                                  { value: 'DOGEUSDT', label: 'DOGEUSDT' },
                                ]}
                              />
                            </Col>
                            <Col xs={24} md={6}>
                              <Text strong>Целевой профит ({synctradeTargetMode === 'usdt' ? 'USDT' : '%'})</Text>
                              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                <InputNumber
                                  style={{ flex: 1 }}
                                  min={0.01}
                                  max={synctradeTargetMode === 'usdt' ? 1000000 : 500}
                                  step={synctradeTargetMode === 'usdt' ? 1 : 1}
                                  value={synctradeTargetProfit}
                                  onChange={(v) => setSynctradeTargetProfit(Number(v ?? 50))}
                                />
                                <Select
                                  value={synctradeTargetMode}
                                  onChange={(v) => setSynctradeTargetMode(v as 'percent' | 'usdt')}
                                  style={{ width: 80 }}
                                  options={[
                                    { value: 'percent', label: '%' },
                                    { value: 'usdt', label: 'USDT' },
                                  ]}
                                />
                              </div>
                              <Text type="secondary" style={{ fontSize: 11 }}>При достижении — сессия закроется автоматически</Text>
                            </Col>
                            <Col xs={24} md={4}>
                              <Text strong>Enabled</Text>
                              <div style={{ marginTop: 8 }}>
                                <Switch checked={synctradeEnabled} onChange={setSynctradeEnabled} />
                              </div>
                            </Col>
                          </Row>

                          {isAdminSurface ? (
                            <Space style={{ marginTop: 16 }}>
                              <Button type="primary" onClick={() => void saveSynctradeSettings()} loading={synctradeLoading}>
                                Сохранить настройки
                              </Button>
                            </Space>
                          ) : null}

                          {/* Hedge Accounts */}
                          <Card size="small" title="Hedge-аккаунты (убыточная сторона)" style={{ marginTop: 16 }}>
                            {isAdminSurface ? (
                              <Space direction="vertical" size={12} style={{ width: '100%', marginBottom: 12 }}>
                                <Row gutter={[12, 12]}>
                                  <Col xs={24} md={8}>
                                    <Text strong>Имя аккаунта</Text>
                                    <Input style={{ marginTop: 8 }} value={synctradeNewHedgeName} onChange={(e) => setSynctradeNewHedgeName(e.target.value)} placeholder="Hedge Account 1" />
                                  </Col>
                                  <Col xs={24} md={6}>
                                    <Text strong>API Key (MEXC)</Text>
                                    <Select
                                      style={{ width: '100%', marginTop: 8 }}
                                      value={synctradeNewHedgeApiKey || undefined}
                                      onChange={setSynctradeNewHedgeApiKey}
                                      options={apiKeyOptions}
                                    />
                                  </Col>
                                  <Col xs={24} md={4}>
                                    <Text strong>Макс расход USDT</Text>
                                    <InputNumber
                                      style={{ width: '100%', marginTop: 8 }}
                                      min={0}
                                      max={100000}
                                      value={synctradeNewHedgeMaxSpend}
                                      onChange={(v) => setSynctradeNewHedgeMaxSpend(Number(v ?? 0))}
                                      placeholder="0 = авто"
                                    />
                                  </Col>
                                  <Col xs={24} md={4}>
                                    <Text strong>Целевой убыток USDT</Text>
                                    <InputNumber
                                      style={{ width: '100%', marginTop: 8 }}
                                      min={0}
                                      max={100000}
                                      value={synctradeNewHedgeTargetLoss}
                                      onChange={(v) => setSynctradeNewHedgeTargetLoss(Number(v ?? 0))}
                                      placeholder="0 = авто"
                                    />
                                  </Col>
                                  <Col xs={24} md={2}>
                                    <Button style={{ marginTop: 30, width: '100%' }} onClick={addSynctradeHedgeAccount}>
                                      +
                                    </Button>
                                  </Col>
                                </Row>
                                <Text type="secondary">Лимит: до 5 hedge-аккаунтов</Text>
                              </Space>
                            ) : null}

                            {synctradeHedgeAccounts.length === 0 ? (
                              <Empty description="Hedge-аккаунты не настроены" />
                            ) : (
                              <Table
                                size="small"
                                rowKey={(_, idx) => String(idx)}
                                dataSource={synctradeHedgeAccounts}
                                pagination={false}
                                columns={[
                                  { title: 'Имя', dataIndex: 'displayName', width: 180 },
                                  { title: 'API Key', dataIndex: 'apiKeyName', width: 220 },
                                  { title: 'Макс расход USDT', dataIndex: 'maxSpendUsdt', width: 130, render: (v: number) => v > 0 ? `${v} USDT` : 'авто' },
                                  { title: 'Целевой убыток USDT', dataIndex: 'targetLossUsdt', width: 150, render: (v: number) => v > 0 ? `${v} USDT` : 'авто' },
                                  ...(isAdminSurface ? [{
                                    title: '',
                                    key: 'action',
                                    width: 100,
                                    render: (_: any, __: any, index: number) => (
                                      <Button danger size="small" onClick={() => removeSynctradeHedgeAccount(index)}>Удалить</Button>
                                    ),
                                  }] : []),
                                ]}
                              />
                            )}
                          </Card>

                          {/* Execution Panel */}
                          <Card size="small" title="Запуск сессии" style={{ marginTop: 16 }}>
                            <Row gutter={[16, 16]} align="middle">
                              <Col xs={24} md={4}>
                                <Text strong>Master Side</Text>
                                <Select
                                  style={{ width: '100%', marginTop: 8 }}
                                  value={synctradeExecSide}
                                  onChange={setSynctradeExecSide}
                                  options={[
                                    { value: 'long', label: 'Long (Profit)' },
                                    { value: 'short', label: 'Short (Profit)' },
                                  ]}
                                />
                              </Col>
                              <Col xs={24} md={4}>
                                <Text strong>Leverage</Text>
                                <InputNumber
                                  style={{ width: '100%', marginTop: 8 }}
                                  min={1}
                                  max={50}
                                  value={synctradeExecLeverage}
                                  onChange={(v) => setSynctradeExecLeverage(Number(v ?? 5))}
                                />
                              </Col>
                              <Col xs={24} md={4}>
                                <Text strong>Lot %</Text>
                                <InputNumber
                                  style={{ width: '100%', marginTop: 8 }}
                                  min={1}
                                  max={100}
                                  value={synctradeExecLotPercent}
                                  onChange={(v) => setSynctradeExecLotPercent(Number(v ?? 10))}
                                />
                              </Col>
                              <Col xs={24} md={6}>
                                <Button
                                  type="primary"
                                  danger
                                  style={{ marginTop: 28, width: '100%' }}
                                  loading={synctradeExecuting}
                                  disabled={!synctradeEnabled || synctradeHedgeAccounts.length === 0}
                                  onClick={() => void executeSynctradeSession()}
                                >
                                  {synctradeExecuting ? 'Выполняется...' : 'Открыть хедж-сессию'}
                                </Button>
                              </Col>
                              {synctradeExecuting ? (
                                <Col xs={24}>
                                  <Alert type="info" showIcon message="Идёт открытие позиций на всех аккаунтах..." />
                                </Col>
                              ) : null}
                            </Row>
                          </Card>

                          {/* SyncAuto Engine */}
                          <Card size="small" title="⚡ Авто-режим (SyncAuto Engine)" style={{ marginTop: 16 }}>
                            {syncAutoStatus?.running ? (
                              <>
                                <Alert type="success" showIcon message={`Движок работает. Активных пар: ${Object.keys(syncAutoStatus.activePairs || {}).length}/${syncAutoStatus.config?.maxPairs || '?'}, циклов: ${syncAutoStatus.totalCycles || 0}`} style={{ marginBottom: 12 }} />
                                <Row gutter={[12, 8]}>
                                  {Object.entries(syncAutoStatus.activePairs || {}).map(([sym, info]: [string, any]) => (
                                    <Col key={sym} xs={12} md={6}>
                                      <div style={{ background: '#1a1a2e', padding: '8px 12px', borderRadius: 6, fontSize: 12 }}>
                                        <div style={{ color: '#00ff88', fontWeight: 600 }}>{sym}</div>
                                        <div style={{ color: '#aaa' }}>lev: {info.leverage}x | entry: {info.entryPrice}</div>
                                        <div style={{ color: '#888' }}>{Math.round(info.runningMs / 60000)} мин</div>
                                      </div>
                                    </Col>
                                  ))}
                                </Row>
                                {(syncAutoStatus.recentErrors || []).length > 0 && (
                                  <Alert type="warning" showIcon message="Последние ошибки" description={<pre style={{ fontSize: 11, margin: 0, maxHeight: 100, overflow: 'auto' }}>{(syncAutoStatus.recentErrors || []).join('\n')}</pre>} style={{ marginTop: 8 }} />
                                )}
                                <Row gutter={12} style={{ marginTop: 12 }}>
                                  <Col>
                                    <Button onClick={() => void fetchSyncAutoStatus()} loading={syncAutoLoading}>Обновить</Button>
                                  </Col>
                                  <Col>
                                    <Button danger onClick={() => void stopSyncAuto(false)} loading={syncAutoLoading}>Стоп (оставить позиции)</Button>
                                  </Col>
                                  <Col>
                                    <Button danger type="primary" onClick={() => void stopSyncAuto(true)} loading={syncAutoLoading}>Стоп + закрыть все</Button>
                                  </Col>
                                </Row>
                              </>
                            ) : (
                              <>
                                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                                  Автоматический скан ликвидных пар, открытие позиций с адаптивным leverage, защита от ликвидации.
                                </Text>
                                <Row gutter={[16, 12]} align="middle">
                                  <Col xs={12} md={4}>
                                    <Text strong style={{ fontSize: 12 }}>Макс пар</Text>
                                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={1} max={20} value={syncAutoMaxPairs} onChange={(v) => setSyncAutoMaxPairs(Number(v ?? 6))} />
                                  </Col>
                                  <Col xs={12} md={4}>
                                    <Text strong style={{ fontSize: 12 }}>Lev мин</Text>
                                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={1} max={50} value={syncAutoLevMin} onChange={(v) => setSyncAutoLevMin(Number(v ?? 15))} />
                                  </Col>
                                  <Col xs={12} md={4}>
                                    <Text strong style={{ fontSize: 12 }}>Lev макс</Text>
                                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={1} max={50} value={syncAutoLevMax} onChange={(v) => setSyncAutoLevMax(Number(v ?? 30))} />
                                  </Col>
                                  <Col xs={12} md={4}>
                                    <Text strong style={{ fontSize: 12 }}>Lot %</Text>
                                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={1} max={100} value={syncAutoLotPercent} onChange={(v) => setSyncAutoLotPercent(Number(v ?? 80))} />
                                  </Col>
                                  <Col xs={24} md={6}>
                                    <Button type="primary" style={{ marginTop: 20, width: '100%', background: '#7c3aed' }} loading={syncAutoLoading} disabled={!synctradeEnabled || synctradeHedgeAccounts.length === 0} onClick={() => void startSyncAuto()}>
                                      ⚡ Запустить авто
                                    </Button>
                                  </Col>
                                </Row>
                              </>
                            )}
                          </Card>

                          {/* Sessions History */}
                          <Card size="small" title="История сессий" style={{ marginTop: 16 }}>
                            {synctradeSessions.length === 0 ? (
                              <Empty description="Нет сессий" />
                            ) : (
                              <Table
                                size="small"
                                rowKey="id"
                                dataSource={synctradeSessions}
                                pagination={{ pageSize: 10 }}
                                expandable={{
                                  expandedRowRender: (record: any) => {
                                    const sessionLog: string[] = Array.isArray(record.log) ? record.log : [];
                                    return sessionLog.length > 0 ? (
                                      <pre style={{ margin: 0, fontSize: 11, maxHeight: 300, overflow: 'auto', background: '#1a1a2e', color: '#00ff88', padding: 8, borderRadius: 4, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                                        {sessionLog.join('\n')}
                                      </pre>
                                    ) : <Text type="secondary">Нет логов</Text>;
                                  },
                                  rowExpandable: () => true,
                                }}
                                columns={[
                                  { title: 'ID', dataIndex: 'id', width: 60 },
                                  { title: 'Символ', dataIndex: 'symbol', width: 100 },
                                  { title: 'Master Side', dataIndex: 'master_side', width: 100 },
                                  { title: 'Статус', dataIndex: 'status', width: 100,
                                    render: (status: string) => (
                                      <Tag color={status === 'open' ? 'blue' : status === 'closed' ? 'green' : status === 'error' ? 'red' : status === 'running' ? 'orange' : 'default'}>
                                        {status === 'running' ? '⏳ running' : status === 'open' ? '🟢 open' : status === 'closed' ? '✅ closed' : status === 'error' ? '❌ error' : status}
                                      </Tag>
                                    ),
                                  },
                                  { title: 'Entry', dataIndex: 'entry_price', width: 100, render: (v: number) => v ? Number(v).toFixed(4) : '—' },
                                  { title: 'Exit', dataIndex: 'exit_price', width: 100, render: (v: number) => v ? Number(v).toFixed(4) : '—' },
                                  { title: 'Master PnL', dataIndex: 'master_pnl', width: 100,
                                    render: (v: number, record: any) => {
                                      const live = record.status === 'open' ? synctradeLivePnl[record.id] : null;
                                      const val = live ? live.masterPnl : Number(v || 0);
                                      return <Text type={val > 0 ? 'success' : val < 0 ? 'danger' : undefined} strong={!!live}>{val.toFixed(4)}{live ? ' ⚡' : ''}</Text>;
                                    },
                                  },
                                  { title: 'Total PnL', dataIndex: 'total_pnl', width: 100,
                                    render: (v: number, record: any) => {
                                      const live = record.status === 'open' ? synctradeLivePnl[record.id] : null;
                                      const val = live ? live.totalPnl : Number(v || 0);
                                      return <Text type={val > 0 ? 'success' : val < 0 ? 'danger' : undefined} strong={!!live}>{val.toFixed(4)}{live ? ' ⚡' : ''}</Text>;
                                    },
                                  },
                                  { title: 'Дата', dataIndex: 'started_at', width: 160, render: (v: string) => v ? String(v).slice(0, 19).replace('T', ' ') : '—' },
                                  {
                                    title: '',
                                    key: 'action',
                                    width: 120,
                                    render: (_: any, record: any) => ['open', 'running', 'error'].includes(record.status) ? (
                                      <Button
                                        size="small"
                                        danger
                                        loading={synctradeExecuting}
                                        onClick={() => void closeSynctradeSessionById(record.id)}
                                      >
                                        {synctradeExecuting ? 'Закрытие...' : record.status === 'error' ? 'Закрыть (force)' : 'Закрыть'}
                                      </Button>
                                    ) : null,
                                  },
                                ]}
                              />
                            )}
                          </Card>
                        </Card>
                      </>
                    ) : null}
                  </Spin>
                </Space>
              ),
            },
          ].filter((item) => item.key !== 'synctrade' && (isAdminSurface || item.key === surfaceMode))}
        />
      </Spin>

      <Modal
        title="Retry Algofund Materialization"
        open={retryMaterializeModalVisible}
        onCancel={() => setRetryMaterializeModalVisible(false)}
        footer={null}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <p>
            The system has been approved but materialization is blocked (catalog/sweep unavailable).
            Click the button below to retry materialization. If catalog/sweep are now available, the system will start.
          </p>
          <div>
            <Button
              type="primary"
              loading={actionLoading === 'retry-materialize'}
              onClick={() => void retryMaterialize()}
              style={{ width: '100%' }}
            >
              Retry Materialization Now
            </Button>
          </div>
        </Space>
      </Modal>

      <Modal
        title={`Подключить клиентов к TS: ${storefrontConnectTarget?.systemName || '—'}`}
        open={Boolean(storefrontConnectTarget)}
        onCancel={() => setStorefrontConnectTarget(null)}
        onOk={() => void applyStorefrontTsToClients()}
        okText="Применить TS"
        cancelText="Отмена"
        confirmLoading={actionLoading === 'apply-storefront-ts'}
        width={720}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="Прямое подключение клиентов к выбранной TS"
            description="Будет выполнен direct switch_system для выбранных Algofund-клиентов без дополнительного перехода в batch-раздел."
          />
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="Выберите клиентов Algofund"
            value={storefrontConnectTarget?.tenantIds || []}
            onChange={(values) => setStorefrontConnectTarget((current) => (current ? {
              ...current,
              tenantIds: values.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0),
            } : current))}
            options={batchEligibleAlgofundTenants.map((item) => ({
              value: Number(item.tenant.id),
              label: `${item.tenant.display_name || item.tenant.slug || `tenant-${item.tenant.id}`} (${item.tenant.slug || item.tenant.id})${item.algofundProfile?.published_system_name ? ` - текущая TS: ${item.algofundProfile.published_system_name}` : ''}`,
            }))}
            optionFilterProp="label"
          />
          <Space wrap>
            <Button
              size="small"
              onClick={() => setStorefrontConnectTarget((current) => (current ? {
                ...current,
                tenantIds: batchEligibleAlgofundTenants.map((item) => Number(item.tenant.id)).filter((item) => item > 0),
              } : current))}
            >
              Выбрать всех algofund-клиентов
            </Button>
            <Button
              size="small"
              onClick={() => setStorefrontConnectTarget((current) => (current ? {
                ...current,
                tenantIds: [],
              } : current))}
            >
              Очистить выбор
            </Button>
          </Space>
          <Text type="secondary">
            Выбрано клиентов: {(storefrontConnectTarget?.tenantIds || []).length}
          </Text>
        </Space>
      </Modal>

      {/* Strategy Client batch connect modal */}
      <Modal
        title={`Подключить клиентов к оферу: ${strategyConnectTarget?.offerTitle || '—'}`}
        open={Boolean(strategyConnectTarget)}
        onCancel={() => setStrategyConnectTarget(null)}
        onOk={() => void applyStrategyConnectToClients()}
        okText="Подключить офер"
        cancelText="Отмена"
        confirmLoading={actionLoading === 'apply-strategy-connect'}
        width={720}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="Офер будет добавлен в портфель выбранных клиентов"
            description="Если у клиента уже есть стратегия с такой же парой — подключение будет отклонено (валидация дублирования пар)."
          />
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="Выберите клиентов Strategy Client"
            value={strategyConnectTarget?.tenantIds || []}
            onChange={(values) => setStrategyConnectTarget((current) => (current ? {
              ...current,
              tenantIds: values.map((item: any) => Number(item)).filter((item: number) => Number.isFinite(item) && item > 0),
            } : current))}
            options={strategyTenants.map((item: any) => ({
              value: Number(item.tenant.id),
              label: `${item.tenant.display_name || item.tenant.slug || `tenant-${item.tenant.id}`} (${item.tenant.slug || item.tenant.id})`,
            }))}
            optionFilterProp="label"
          />
          <Space wrap>
            <Button
              size="small"
              onClick={() => setStrategyConnectTarget((current) => (current ? {
                ...current,
                tenantIds: strategyTenants.map((item: any) => Number(item.tenant.id)).filter((item: number) => item > 0),
              } : current))}
            >
              Выбрать всех клиентов
            </Button>
            <Button
              size="small"
              onClick={() => setStrategyConnectTarget((current) => (current ? { ...current, tenantIds: [] } : current))}
            >
              Очистить выбор
            </Button>
          </Space>
          <Text type="secondary">
            Выбрано клиентов: {(strategyConnectTarget?.tenantIds || []).length}
          </Text>
        </Space>
      </Modal>

      <Modal
        title={removeStorefrontConfirm?.mode === 'delete' ? 'Удалить ТС из базы' : 'Снять ТС с витрины'}
        open={removeStorefrontConfirm !== null}
        onCancel={() => setRemoveStorefrontConfirm(null)}
        onOk={() => void confirmRemoveStorefront()}
        okButtonProps={{ danger: true, loading: actionLoading.startsWith('remove-storefront:') }}
        okText={removeStorefrontConfirm?.mode === 'delete' ? 'Подтвердить удаление из базы' : 'Подтвердить снятие'}
        cancelText="Отмена"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message={`TS "${removeStorefrontConfirm?.systemName}" подключена к ${removeStorefrontConfirm?.clientCount || 0} клиентам`}
            description={removeStorefrontConfirm?.mode === 'delete'
              ? 'После подтверждения клиенты будут отключены от этой ТС, а запись ТС удалена из базы. Ниже можно выбрать, нужно ли пытаться закрыть открытые позиции через stop-flow.'
              : 'После подтверждения клиенты будут отключены от этой ТС. Ниже можно выбрать, нужно ли пытаться закрыть открытые позиции через stop-flow.'}
          />
          <Space>
            <Switch checked={removeStorefrontClosePositions} onChange={setRemoveStorefrontClosePositions} />
            <Text>Пытаться закрыть открытые позиции и остановить engine</Text>
          </Space>
          {(removeStorefrontConfirm?.positionsByApiKey || []).length > 0 ? (
            <Card size="small" title="Dry-run по API key">
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {(removeStorefrontConfirm?.positionsByApiKey || []).map((item) => (
                  <div key={item.apiKeyName}>
                    <Space wrap>
                      <Tag color="blue">{item.apiKeyName}</Tag>
                      <Tag color={item.openPositions > 0 ? 'warning' : 'success'}>
                        open positions: {item.openPositions < 0 ? 'unknown' : item.openPositions}
                      </Tag>
                      {item.symbols.slice(0, 6).map((symbol) => <Tag key={symbol}>{symbol}</Tag>)}
                    </Space>
                  </div>
                ))}
              </Space>
            </Card>
          ) : null}
          {(removeStorefrontConfirm?.tenants || []).length > 0 ? (
            <div>
              <Text strong>Затронутые клиенты:</Text>
              <ul style={{ marginTop: 4 }}>
                {(removeStorefrontConfirm?.tenants || []).map((t) => (
                  <li key={t.id}>{t.display_name}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Space>
      </Modal>

      <Modal
        title={`Monitoring chart: ${monitoringChartApiKey || '—'}`}
        open={monitoringChartOpen}
        onCancel={() => setMonitoringChartOpen(false)}
        footer={<Button onClick={() => setMonitoringChartOpen(false)}>Close</Button>}
        width={960}
      >
        <Spin spinning={monitoringChartLoading}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
              <Space wrap>
                {monitoringChartLatest ? <Tag color="blue">Eq {formatMoney(monitoringChartLatest.equity_usd)}</Tag> : null}
                {monitoringChartLatest ? <Tag color="purple">ML {formatPercent(monitoringChartLatest.margin_load_percent)}</Tag> : null}
                {monitoringChartLatest ? <Tag color="red">Lev {formatNumber(monitoringChartLatest.effective_leverage, 2)}x</Tag> : null}
                {monitoringChartLatest ? <Tag color="orange">DD {formatPercent(monitoringChartLatest.drawdown_percent)}</Tag> : null}
              </Space>
              <Segmented
                options={[
                  { label: '1д', value: 1 },
                  { label: '7д', value: 7 },
                  { label: '30д', value: 30 },
                  { label: '60д', value: 60 },
                  { label: '90д', value: 90 },
                ]}
                value={monitoringChartDays}
                onChange={(v) => setMonitoringChartDays(Number(v))}
              />
            </Space>
            {monitoringChartPoints.length > 0 ? (
              <ChartComponent data={monitoringChartPoints} type="line" />
            ) : (
              <Empty description="No monitoring points" />
            )}
          </Space>
        </Spin>
      </Modal>

      <Modal
        title={`Apply recommendation: ${applyLowLotTarget?.strategyName || ''}`}
        open={Boolean(applyLowLotTarget)}
        onCancel={() => setApplyLowLotTarget(null)}
        onOk={() => void submitApplyLowLotRecommendation()}
        okText="Apply"
        cancelText="Cancel"
        confirmLoading={applyLowLotWorking}
        width={520}
        footer={[
          <Button key="cancel" onClick={() => setApplyLowLotTarget(null)}>Cancel</Button>,
          applyLowLotTarget?.systemId ? (
            <Button
              key="open-ts"
              onClick={() => {
                setApplyLowLotTarget(null);
                navigateToAdminTab('monitoring');
              }}
            >
              Открыть в SaaS
            </Button>
          ) : null,
          <Button key="apply" type="primary" loading={applyLowLotWorking} onClick={() => void submitApplyLowLotRecommendation()}>Apply</Button>,
        ]}
      >
        {applyLowLotTarget && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <Tag>{applyLowLotTarget.apiKeyName}</Tag>
              <Tag>{applyLowLotTarget.pair}</Tag>
              <Tag>Clients: {applyLowLotTarget.tenants?.length || 0}</Tag>
            </Space>
            <Checkbox
              checked={applyLowLotDeposit}
              onChange={(e) => setApplyLowLotDeposit(e.target.checked)}
            >
              Increase deposit: {applyLowLotTarget.maxDeposit} {'→'} {applyLowLotTarget.suggestedDepositMin} USD
            </Checkbox>
            <Checkbox
              checked={applyLowLotLot}
              onChange={(e) => setApplyLowLotLot(e.target.checked)}
            >
              Increase lot%: {applyLowLotTarget.lotPercent}% {'→'} {applyLowLotTarget.suggestedLotPercent}%
            </Checkbox>
            {applyLowLotTarget.systemId ? (
              <Checkbox
                checked={applyLowLotWholeSystem}
                onChange={(e) => setApplyLowLotWholeSystem(e.target.checked)}
              >
                Apply to whole TS system (preserve relative behavior across members)
              </Checkbox>
            ) : null}
            {applyLowLotTarget.replacementCandidates?.length > 0 && !applyLowLotWholeSystem && (
              <div>
                <Text strong>Replace pair optionally:</Text>
                <Select
                  allowClear
                  style={{ width: '100%', marginTop: 4 }}
                  placeholder="Keep current pair"
                  value={applyLowLotReplacement || undefined}
                  onChange={(v) => setApplyLowLotReplacement(v || '')}
                  options={applyLowLotTarget.replacementCandidates.map((c) => ({
                    value: c.symbol.includes('/') ? c.symbol : `${c.symbol}/USDT`,
                    label: `${c.symbol.includes('/') ? c.symbol : `${c.symbol}/USDT`} (score ${c.score})${c.note ? ' - ' + c.note : ''}`,
                  }))}
                />
              </div>
            )}
            {applyLowLotTarget.tenants?.length > 0 && (
              <div>
                <Text type="secondary">Affected clients: </Text>
                <Space wrap>
                  {applyLowLotTarget.tenants.map((t) => (
                    <Tag key={t.id}>{t.displayName || t.slug}</Tag>
                  ))}
                </Space>
              </div>
            )}
          </Space>
        )}
      </Modal>

      <Modal
        title={`Unpublish offer: ${unpublishTargetOfferId || '—'}`}
        open={unpublishWizardVisible}
        onCancel={closeUnpublishWizard}
        onOk={() => void confirmUnpublishOffer()}
        okText="Unpublish"
        okButtonProps={{
          danger: true,
          disabled: unpublishImpactLoading || !unpublishAcknowledge || !unpublishTargetOfferId,
        }}
        cancelText="Cancel"
        confirmLoading={actionLoading === `offer-store:${String(unpublishTargetOfferId || '')}`}
        width={860}
      >
        <Spin spinning={unpublishImpactLoading}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {unpublishImpact ? (
              <Alert
                type={unpublishImpact.summary?.openPositionsCount > 0 ? 'warning' : 'info'}
                showIcon
                message={`Affected tenants: ${Number(unpublishImpact.summary?.tenantCount || 0)} | Open positions: ${Number(unpublishImpact.summary?.openPositionsCount || 0)}`}
                description="Unpublishing blocks new activations for this offer. Existing runtime positions may stay open until managed by client/admin actions."
              />
            ) : (
              <Alert type="warning" showIcon message="Impact data unavailable. Retry before unpublishing." />
            )}

            {unpublishImpact ? (
              <Alert
                type={Number(unpublishImpact.summary?.openPositionsCount || 0) > 0 ? 'error' : 'info'}
                showIcon
                message="Recommended next steps"
                description={Number(unpublishImpact.summary?.openPositionsCount || 0) > 0
                  ? 'Сначала открой Мониторинг и Клиенты по этому офферу: проверь открытые позиции, затем останови/переведи затронутых клиентов и только после этого подтверждай снятие с витрины.'
                  : 'Открой Клиенты по этому офферу и проверь, нужны ли stop/switch действия для затронутых пользователей после снятия с витрины.'}
              />
            ) : null}

            <Space wrap>
              <Button
                size="small"
                disabled={!unpublishTargetOfferId}
                onClick={() => focusClientsByOffer(unpublishTargetOfferId)}
              >
                Открыть клиентов по офферу
              </Button>
              <Button
                size="small"
                onClick={() => openAdminMonitoring('all')}
              >
                Открыть мониторинг
              </Button>
            </Space>

            {unpublishImpact?.affectedTenants?.length ? (
              <Table
                size="small"
                rowKey={(row) => `${row.tenantId}:${row.assignedApiKeyName}`}
                dataSource={unpublishImpact.affectedTenants}
                pagination={{ pageSize: 5, showSizeChanger: false }}
                columns={[
                  {
                    title: 'Tenant',
                    key: 'tenant',
                    render: (_, row: any) => (
                      <Space direction="vertical" size={0}>
                        <Text strong>{row.displayName}</Text>
                        <Text type="secondary">{row.slug}</Text>
                      </Space>
                    ),
                  },
                  {
                    title: 'Mode',
                    dataIndex: 'productMode',
                    width: 140,
                    render: (value: ProductMode) => productModeTag(value),
                  },
                  {
                    title: 'API key',
                    dataIndex: 'assignedApiKeyName',
                    width: 180,
                    render: (value: string) => value || '—',
                  },
                ]}
              />
            ) : null}

            {unpublishImpact?.openPositions?.length ? (
              <Table
                size="small"
                rowKey={(row) => `${row.tenantId}:${row.apiKeyName}`}
                dataSource={unpublishImpact.openPositions}
                pagination={false}
                columns={[
                  {
                    title: 'Tenant ID',
                    dataIndex: 'tenantId',
                    width: 120,
                  },
                  {
                    title: 'API key',
                    dataIndex: 'apiKeyName',
                    width: 200,
                  },
                  {
                    title: 'Open positions',
                    dataIndex: 'count',
                    width: 140,
                  },
                  {
                    title: 'Symbols',
                    key: 'symbols',
                    render: (_, row: any) => (row.symbols || []).join(', ') || '—',
                  },
                ]}
              />
            ) : (
              <Alert type="success" showIcon message="No open positions for affected tenants." />
            )}

            <Checkbox
              checked={unpublishAcknowledge}
              onChange={(event) => setUnpublishAcknowledge(event.target.checked)}
            >
              I reviewed impact and confirm unpublish for this offer.
            </Checkbox>
          </Space>
        </Spin>
      </Modal>

      <Modal
        title="Approve Algofund Connection Request"
        open={approveRequestModalVisible}
        onCancel={() => {
          setApproveRequestModalVisible(false);
          setApproveRequestPendingId(null);
        }}
        onOk={() => void handleApproveAlgofundRequest()}
        confirmLoading={actionLoading.startsWith('approve-request-')}
        width={600}
      >
        {approveRequestPendingId !== null && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions size="small" bordered>
              <Descriptions.Item label="Request ID" span={3}>
                {approveRequestPendingId}
              </Descriptions.Item>
              <Descriptions.Item label="Tenant" span={3}>
                {(() => {
                  const req = (summary?.algofundRequestQueue?.items || []).find((r) => r.id === approveRequestPendingId);
                  if (!req) return '—';
                  const name = String(req.tenant_display_name || '').trim();
                  const slug = String(req.tenant_slug || '').trim();
                  return name && slug ? `${name} (${slug})` : name || slug || '—';
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="Request Type" span={3}>
                {(() => {
                  const req = (summary?.algofundRequestQueue?.items || []).find((r) => r.id === approveRequestPendingId);
                  if (!req) return '—';
                  if (req.request_type === 'start') return 'Start';
                  if (req.request_type === 'stop') return 'Stop';
                  const payload = parseAlgofundRequestPayload(req.request_payload_json);
                  return `Switch to ${payload.targetSystemName || `#${payload.targetSystemId}`}`;
                })()}
              </Descriptions.Item>
            </Descriptions>

            <Card size="small" title="Assign Plan & API Key">
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div>
                  <label htmlFor="approve-plan-select">Plan <span style={{ color: 'red' }}>*</span></label>
                  <Select
                    id="approve-plan-select"
                    style={{ width: '100%', marginTop: 4 }}
                    placeholder="Select plan for this client"
                    value={approveRequestSelectedPlan || undefined}
                    onChange={(value) => setApproveRequestSelectedPlan(value)}
                    options={algofundPlanOptions}
                  />
                </div>

                <div>
                  <label htmlFor="approve-apikey-select">API Key <span style={{ color: 'red' }}>*</span></label>
                  <Select
                    id="approve-apikey-select"
                    style={{ width: '100%', marginTop: 4 }}
                    placeholder="Select API key for trading engine"
                    value={approveRequestSelectedApiKey || undefined}
                    onChange={(value) => setApproveRequestSelectedApiKey(value)}
                    options={apiKeyOptions}
                  />
                </div>

                {approveRequestSelectedPlan && (
                  (() => {
                    const plan = (summary?.plans || []).find((p) => p.code === approveRequestSelectedPlan);
                    if (!plan) return null;
                    return (
                      <Card size="small" style={{ backgroundColor: '#fafafa' }}>
                        <Descriptions size="small">
                          <Descriptions.Item label="Price" span={3}>
                            {formatMoney(plan.price_usdt)}/mo
                          </Descriptions.Item>
                          <Descriptions.Item label="Max Deposit" span={3}>
                            ${Number(plan.max_deposit_total || 0).toFixed(2)}
                          </Descriptions.Item>
                          <Descriptions.Item label="Risk Cap" span={3}>
                            {Number(plan.risk_cap_max || 0).toFixed(4)}
                          </Descriptions.Item>
                          <Descriptions.Item label="Start/Stop Requests" span={3}>
                            {plan.allow_ts_start_stop_requests ? '✓ Allowed' : '✗ Not allowed'}
                          </Descriptions.Item>
                        </Descriptions>
                      </Card>
                    );
                  })()
                )}
              </Space>
            </Card>
          </Space>
        )}
      </Modal>

      <Drawer
        title={isAdminSurface ? (backtestDrawerContext?.title || 'Backtest из SaaS') : 'Бэктест стратегии'}
        placement="right"
        width={isAdminSurface ? '92vw' : '60vw'}
        open={backtestDrawerVisible}
        onClose={() => {
          setBacktestDrawerVisible(false);
          setBacktestDrawerContext(null);
          setBacktestTsWeightsByOfferId({});
        }}
      >
        {backtestDrawerContext ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={isAdminSurface
                ? "Sweep backtest: настрой риск и частоту сделок, проверь сделки/PnL/DD/margin и графики, сохрани метрики карточки и реши — отправить на витрину или закрыть."
                : "Настройте уровень риска и посмотрите, как изменится кривая доходности вашего портфеля."
              }
            />
            {isAdminSurface && backtestDrawerContext.kind === 'algofund-ts' ? (
              <Space wrap>
                <Tag color="geekblue">Тестируемая ТС: {(() => {
                  const rawTitle = String(backtestDrawerContext.title || '').trim();
                  const prefix = 'Бэктест ТС:';
                  return rawTitle.startsWith(prefix) ? rawTitle.slice(prefix.length).trim() || '—' : (rawTitle || '—');
                })()}</Tag>
                <Tag color="blue">Карточек в тесте: {Array.isArray(backtestDrawerContext.offerIds) ? backtestDrawerContext.offerIds.length : 0}</Tag>
              </Space>
            ) : null}
            <Space wrap>
              {isAdminSurface && (
                <Button size="small" onClick={returnToReviewFromBacktest}>
                  Вернуться к карточке
                </Button>
              )}
              <Button
                size="small"
                loading={adminSweepBacktestLoading}
                onClick={() => {
                  void runAdminSweepBacktestPreview();
                }}
              >
                {isAdminSurface ? 'Пересчитать sweep backtest' : 'Пересчитать'}
              </Button>
              {isAdminSurface && (
                <>
                  <Select
                    allowClear
                    size="small"
                    style={{ minWidth: 220 }}
                    placeholder="API key для real rerun (опц.)"
                    value={adminSweepBacktestRerunApiKey || undefined}
                    onChange={(value) => setAdminSweepBacktestRerunApiKey(String(value || ''))}
                    options={apiKeyOptions}
                  />
                  <Button
                    size="small"
                    loading={adminSweepBacktestLoading}
                    onClick={() => {
                      void runAdminSweepBacktestPreview(undefined, { preferRealBacktest: true });
                    }}
                  >
                    API rerun (реальный)
                  </Button>
                  {backtestDrawerContext.kind === 'offer' ? (
                    <Button
                      size="small"
                      loading={actionLoading === `offer-review-snapshot:${String(backtestDrawerContext.offerId || '')}`}
                      onClick={() => {
                        void saveOfferReviewSnapshotFromBacktest();
                      }}
                    >
                      Сохранить
                    </Button>
                  ) : null}
                  {backtestDrawerContext.kind === 'algofund-ts' ? (
                    <Button
                      size="small"
                      loading={actionLoading === 'ts-review-snapshot'}
                      onClick={() => {
                        void saveTsReviewSnapshotFromBacktest({ publishAfterSave: false });
                      }}
                    >
                      Сохранить
                    </Button>
                  ) : null}
                  <Button
                    type="primary"
                    size="small"
                    loading={
                      backtestDrawerContext.kind === 'algofund-ts'
                        ? actionLoading === 'publish' || actionLoading === 'ts-review-snapshot'
                        : actionLoading === `offer-store:${String(backtestDrawerContext.offerId || '')}`
                          || actionLoading === `offer-review-snapshot:${String(backtestDrawerContext.offerId || '')}`
                    }
                    onClick={() => void publishFromBacktestContext()}
                  >
                    {backtestDrawerContext.kind === 'algofund-ts'
                      ? 'Сохранить и отправить ТС на витрину'
                      : (backtestDrawerContext.offerPublished ? 'Сохранить и обновить витрину оффера' : 'Сохранить и отправить оффер на витрину')}
                  </Button>
                </>
              )}
            </Space>

            <Row gutter={[12, 12]}>
              <Col xs={24} md={isAdminSurface ? 6 : 12}>
                <Card size="small" title={<Space>{adminSweepBacktestStale ? <Tag color="orange">⟳ Обновить</Tag> : null}<span>Риск{isAdminSurface ? ' бэктеста' : ''} (0-10)</span></Space>}>
                  <Slider
                    min={0}
                    max={10}
                    step={0.1}
                    value={adminSweepBacktestRiskScore}
                    onChange={(value) => {
                      const next = Number(value || 0);
                      setAdminSweepBacktestRiskScore(next);
                      storeCurrentBacktestSettingsForContext(backtestDrawerContext, { riskScore: next });
                      const prevScore = adminSweepBacktestResult?.controls?.riskScore ?? 5;
                      const scale = getBacktestRiskMultiplier(next, adminSweepBacktestRiskScaleMaxPercent)
                        / Math.max(0.01, getBacktestRiskMultiplier(prevScore, adminSweepBacktestRiskScaleMaxPercent));
                      setAdminSweepPreviewRiskScale(Number(scale.toFixed(4)));
                      setAdminSweepBacktestStale(true);
                      scheduleBacktestDebounce();
                    }}
                  />
                  <Text type="secondary">Текущий уровень: {sliderValueToLevel(adminSweepBacktestRiskScore)}</Text>
                  <br />
                  <Text type="secondary">Текущий множитель: {formatNumber(getBacktestRiskMultiplier(adminSweepBacktestRiskScore, adminSweepBacktestRiskScaleMaxPercent), 2)}x к базовой позиции</Text>
                </Card>
              </Col>
              {(isAdminSurface || activeTab === 'strategy-client') && (
                <Col xs={24} md={isAdminSurface ? 6 : 12}>
                  <Card size="small" title={<Space>{adminSweepBacktestStale ? <Tag color="orange">⟳ Обновить</Tag> : null}<span>Частота сделок (0-10)</span></Space>}>
                    <Slider
                      min={0}
                      max={10}
                      step={0.1}
                      value={adminSweepBacktestTradeScore}
                      onChange={(value) => {
                        const next = Number(value || 0);
                        setAdminSweepBacktestTradeScore(next);
                        storeCurrentBacktestSettingsForContext(backtestDrawerContext, { tradeFrequencyScore: next });
                        setAdminSweepBacktestStale(true);
                        scheduleBacktestDebounce();
                      }}
                    />
                    <Text type="secondary">Текущий уровень: {sliderValueToLevel(adminSweepBacktestTradeScore)}</Text>
                  </Card>
                </Col>
              )}
              {isAdminSurface && (
                <Col xs={24} md={5}>
                  <Card size="small" title="Начальный баланс">
                    <InputNumber
                      min={100}
                      step={100}
                      style={{ width: '100%' }}
                      value={adminSweepBacktestInitialBalance}
                      onChange={(value) => {
                        const next = Math.max(100, Number(value || 10000));
                        setAdminSweepBacktestInitialBalance(next);
                        storeCurrentBacktestSettingsForContext(backtestDrawerContext, { initialBalance: next });
                      }}
                    />
                  </Card>
                </Col>
              )}
              {isAdminSurface && (
                <Col xs={24} md={5}>
                  <Card size="small" title="Потолок риска, %">
                    <InputNumber
                      min={0}
                      max={1000}
                      step={10}
                      style={{ width: '100%' }}
                      value={adminSweepBacktestRiskScaleMaxPercent}
                      onChange={(value) => {
                        const next = Math.max(0, Math.min(1000, Number(value || 40)));
                        setAdminSweepBacktestRiskScaleMaxPercent(next);
                        storeCurrentBacktestSettingsForContext(backtestDrawerContext, { riskScaleMaxPercent: next });
                      }}
                    />
                    <Text type="secondary">Ограничивает верхний множитель риска. При score=10 потолок сейчас около {formatNumber(getBacktestRiskMultiplier(10, adminSweepBacktestRiskScaleMaxPercent), 2)}x.</Text>
                  </Card>
                </Col>
              )}
              {isAdminSurface && backtestDrawerContext?.kind === 'algofund-ts' && (
                <Col xs={24} md={4}>
                  <Card size="small" title="Макс. ОП">
                    <InputNumber
                      min={0}
                      max={20}
                      step={1}
                      style={{ width: '100%' }}
                      value={adminSweepBacktestMaxOpenPositions}
                      onChange={(value) => {
                        const next = Math.max(0, Math.floor(Number(value || 0)));
                        setAdminSweepBacktestMaxOpenPositions(next);
                        storeCurrentBacktestSettingsForContext(backtestDrawerContext, { maxOpenPositions: next });
                        setAdminSweepBacktestStale(true);
                        scheduleBacktestDebounce();
                      }}
                    />
                    <Text type="secondary">{adminSweepBacktestMaxOpenPositions > 0 ? `≤${adminSweepBacktestMaxOpenPositions} позиций` : '0 = без огр.'}</Text>
                  </Card>
                </Col>
              )}
            </Row>

            {adminSweepBacktestResult ? (
              <Card size="small" title={adminSweepBacktestStale ? <Space><Tag color="orange">⟳ Пересчёт запущен...</Tag><span>Результат sweep backtest</span></Space> : 'Результат sweep backtest'}>
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {(() => {
                    const rawEquitySeries = toLineSeriesData(adminSweepBacktestResult.preview?.equity || []);
                    // Apply instant client-side scale while backend recalculates (stale mode)
                    const balance = Number(adminSweepBacktestInitialBalance || 10000);
                    const scale = adminSweepBacktestStale ? adminSweepPreviewRiskScale : 1;
                    const equitySeries = scale !== 1
                      ? rawEquitySeries.map((point) => ({ ...point, value: balance + (point.value - balance) * scale }))
                      : rawEquitySeries;
                    const summary = adminSweepBacktestResult.preview?.summary || {};
                    const fallbackCurves = deriveBacktestCurvesFromEquity(
                      equitySeries,
                      balance,
                      Number(adminSweepBacktestResult.controls?.riskScore || adminSweepBacktestRiskScore || 5),
                    );

                    const pnlCurve = toLineSeriesData(adminSweepBacktestResult.preview?.curves?.pnl || []);
                    const drawdownCurve = toLineSeriesData(adminSweepBacktestResult.preview?.curves?.drawdownPercent || []);
                    const effectivePnlCurve = pnlCurve.length > 0 ? pnlCurve : fallbackCurves.pnl;
                    const effectiveDrawdownCurve = drawdownCurve.length > 0 ? drawdownCurve : fallbackCurves.drawdown;

                    const finalPnl = Number(summary.unrealizedPnl ?? (effectivePnlCurve.length > 0 ? effectivePnlCurve[effectivePnlCurve.length - 1].value : fallbackCurves.finalPnl) ?? 0);
                    const serverTradesCount = Number(summary.tradesCount ?? 0);
                    const baseTradeScore = Number(adminSweepBacktestResult.controls?.tradeFrequencyScore ?? 5);
                    const tradesCount = adminSweepBacktestStale && Number.isFinite(serverTradesCount) && serverTradesCount > 0
                      ? Math.max(
                        1,
                        Math.round(
                          serverTradesCount
                          * (getBacktestTradeMultiplier(adminSweepBacktestTradeScore)
                            / Math.max(0.1, getBacktestTradeMultiplier(baseTradeScore)))
                        )
                      )
                      : (Number.isFinite(serverTradesCount) ? serverTradesCount : 0);
                    const maxDd = Number(summary.maxDrawdownPercent ?? (effectiveDrawdownCurve.length > 0 ? Math.max(...effectiveDrawdownCurve.map((point) => point.value)) : 0));
                    const marginLoad = Number(summary.marginLoadPercent ?? 0);
                    const rerunErrorText = String(adminSweepBacktestResult.rerun?.error || '').trim();
                    const rerunNeedsHistoricalSweep = /Исторические свечи не найдены|No executable candles|No runnable strategies|No candles in selected date range/i.test(rerunErrorText);

                    return (
                      <>
                  {isAdminSurface ? (
                  <Space wrap>
                    <Tag color="blue">offers: {adminSweepBacktestResult.selectedOffers.length}</Tag>
                    {backtestDrawerContext?.kind === 'algofund-ts' && adminSweepBacktestMaxOpenPositions > 0 && <Tag color="volcano">ОП: {adminSweepBacktestMaxOpenPositions}</Tag>}
                    <Tag color="geekblue">risk: {adminSweepBacktestResult.controls.riskLevel}</Tag>
                    <Tag color="purple">frequency: {adminSweepBacktestResult.controls.tradeFrequencyLevel}</Tag>
                    {adminSweepBacktestResult.rerun?.executed ? (
                      <Tag color="green">real rerun: {adminSweepBacktestResult.rerun.apiKeyName || 'api_key'}</Tag>
                    ) : adminSweepBacktestResult.rerun?.requested && adminSweepBacktestResult.rerun?.error ? (
                      <Tag color="red">real rerun failed: {adminSweepBacktestResult.rerun.error}</Tag>
                    ) : (
                      <Tag color="default">mode: sweep-only</Tag>
                    )}
                    {adminSweepBacktestResult.period ? <Tag color="default">{formatPeriodLabel(adminSweepBacktestResult.period)}</Tag> : null}
                    {adminSweepBacktestResult.preview?.summary ? <Tag color={metricColor(Number(adminSweepBacktestResult.preview.summary.totalReturnPercent || 0), 'return')}>Ret {formatPercent(adminSweepBacktestResult.preview.summary.totalReturnPercent)}</Tag> : null}
                    {adminSweepBacktestResult.preview?.summary ? <Tag color={metricColor(Number(adminSweepBacktestResult.preview.summary.maxDrawdownPercent || 0), 'drawdown')}>DD {formatPercent(adminSweepBacktestResult.preview.summary.maxDrawdownPercent)}</Tag> : null}
                    {adminSweepBacktestResult.preview?.summary ? <Tag color={metricColor(Number(adminSweepBacktestResult.preview.summary.profitFactor || 0), 'pf')}>PF {formatNumber(adminSweepBacktestResult.preview.summary.profitFactor)}</Tag> : null}
                    {Number.isFinite(tradesCount) ? <Tag color="cyan">trades {formatNumber(tradesCount, 0)}</Tag> : null}
                  </Space>
                  ) : (
                  <Space wrap>
                    <Tag color="geekblue">Риск: {adminSweepBacktestResult.controls.riskLevel}</Tag>
                    {adminSweepBacktestResult.preview?.summary ? <Tag color={metricColor(Number(adminSweepBacktestResult.preview.summary.totalReturnPercent || 0), 'return')}>Доходность {formatPercent(adminSweepBacktestResult.preview.summary.totalReturnPercent)}</Tag> : null}
                    {adminSweepBacktestResult.preview?.summary ? <Tag color={metricColor(Number(adminSweepBacktestResult.preview.summary.maxDrawdownPercent || 0), 'drawdown')}>Просадка {formatPercent(adminSweepBacktestResult.preview.summary.maxDrawdownPercent)}</Tag> : null}
                  </Space>
                  )}

                  {/* Low-lot / deposit warnings */}
                  {isAdminSurface && (() => {
                    const offersCount = adminSweepBacktestResult.selectedOffers.length || 1;
                    const balance = Number(adminSweepBacktestInitialBalance || 10000);
                    const riskMul = getBacktestRiskMultiplier(adminSweepBacktestRiskScore, adminSweepBacktestRiskScaleMaxPercent);
                    const effectiveBalance = balance * Math.max(0.01, riskMul);
                    const perStrategy = effectiveBalance / offersCount;
                    const synthOffers = adminSweepBacktestResult.selectedOffers.filter((o) => o.mode === 'synth');
                    const warnings: string[] = [];
                    if (perStrategy < 150) {
                      warnings.push(
                        `На стратегию приходится ~${perStrategy.toFixed(0)} USDT — ниже минимального лота большинства пар (~150 USDT). `
                        + `Увеличьте начальный баланс или снизьте количество стратегий.`
                      );
                    } else if (perStrategy < 300) {
                      warnings.push(
                        `На стратегию приходится ~${perStrategy.toFixed(0)} USDT — депозит около минимального порога. `
                        + `Синтетические пары могут работать в режиме min-lot.`
                      );
                    }
                    if (synthOffers.length > 0 && perStrategy < 400) {
                      warnings.push(
                        `${synthOffers.length} синт. ${synthOffers.length === 1 ? 'стратегия требует' : 'стратегии требуют'} балансировки двух ног: `
                        + `рекомендуется ≥ 400 USDT на синт. пару. Сейчас ~${perStrategy.toFixed(0)} USDT.`
                      );
                    }
                    if (warnings.length === 0) {
                      return null;
                    }
                    return (
                      <Alert
                        type="warning"
                        showIcon
                        message="Предупреждение о размере лота"
                        description={
                          <ul style={{ margin: 0, paddingLeft: 16 }}>
                            {warnings.map((w, i) => <li key={i}>{w}</li>)}
                          </ul>
                        }
                      />
                    );
                  })()}

                  {isAdminSurface && adminSweepBacktestResult.rerun?.requested && rerunErrorText ? (
                    <Alert
                      type={rerunNeedsHistoricalSweep ? 'warning' : 'error'}
                      showIcon
                      message={rerunNeedsHistoricalSweep ? 'API rerun не смог найти исторические свечи для выбранного диапазона' : 'API rerun завершился с ошибкой'}
                      description={(
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Text>{rerunErrorText}</Text>
                          {rerunNeedsHistoricalSweep ? (
                            <Space wrap>
                              <Button
                                size="small"
                                loading={actionLoading === 'admin-rerun-historical-sweep'}
                                onClick={() => { void startHistoricalSweepForBacktest(); }}
                              >
                                Запустить historical sweep
                              </Button>
                              <Text type="secondary">Скачает исторические данные и обновит sweep-артефакты для этого API key.</Text>
                            </Space>
                          ) : null}
                        </Space>
                      )}
                    />
                  ) : null}

                  {isAdminSurface && (
                  <Row gutter={[12, 12]}>
                    <Col xs={12} md={6}>
                      <Card
                        size="small"
                        title={<Space size={6}><span>Сделки</span><Tag color="geekblue" style={{ marginInlineEnd: 0 }}>зависят от частоты</Tag></Space>}
                      >
                        <Statistic value={Number.isFinite(tradesCount) ? tradesCount : 0} precision={0} />
                        <Text type="secondary" style={{ fontSize: 12 }}>Риск меняет P/L и DD, частота меняет число сделок.</Text>
                      </Card>
                    </Col>
                    <Col xs={12} md={6}><Card size="small"><Statistic title="P/L" value={finalPnl} precision={2} suffix="USDT" /></Card></Col>
                    <Col xs={12} md={6}><Card size="small"><Statistic title="Max DD" value={maxDd} precision={2} suffix="%" /></Card></Col>
                    <Col xs={12} md={6}><Card size="small"><Statistic title="Margin load" value={marginLoad} precision={2} suffix="%" /></Card></Col>
                  </Row>
                  )}

                  {equitySeries.length > 0 ? (
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      {isAdminSurface && (
                      <Space wrap>
                        <Checkbox checked={showBacktestTradeFreqOverlay} onChange={(event) => setShowBacktestTradeFreqOverlay(event.target.checked)}>
                          Показать частоту сделок по дням
                        </Checkbox>
                        <Checkbox checked={showBacktestBtcOverlay} onChange={(event) => setShowBacktestBtcOverlay(event.target.checked)}>
                          Показать цену BTCUSDT
                        </Checkbox>
                        {backtestBtcOverlayLoading ? <Tag color="processing">BTCUSDT: загрузка...</Tag> : null}
                        {showBacktestBtcOverlay && !backtestBtcOverlayLoading && backtestBtcOverlayPoints.length > 1
                          ? (() => {
                              const btcChangePercent = calcSeriesChangePercent(backtestBtcOverlayPoints);
                              if (btcChangePercent === null) {
                                return null;
                              }
                              return (
                                <Tag color={btcChangePercent >= 0 ? 'green' : 'red'}>
                                  BTC {btcChangePercent >= 0 ? '+' : ''}{formatPercent(btcChangePercent)}
                                </Tag>
                              );
                            })()
                          : null}
                      </Space>
                      )}
                      <ChartComponent
                        data={equitySeries.map((point) => ({ time: point.time, equity: point.value }))}
                        type="line"
                        overlayLines={(() => {
                          const overlays: Array<{ id: string; color: string; lineWidth?: number; data: Array<{ time: number; value: number }> }> = [];

                          if (showBacktestTradeFreqOverlay) {
                            const frequencySeriesRaw = buildDailyTradeFrequencySeries(
                              adminSweepBacktestResult.preview?.trades,
                              equitySeries,
                              Number(summary.tradesCount ?? 0),
                            );
                            const frequencySeries = normalizeOverlayToEquityScale(frequencySeriesRaw, equitySeries);
                            if (frequencySeries.length > 0) {
                              overlays.push({
                                id: 'trade-frequency-daily',
                                color: '#111111',
                                lineWidth: 1,
                                data: frequencySeries,
                              });
                            }
                          }

                          if (showBacktestBtcOverlay && backtestBtcOverlayPoints.length > 0) {
                            const btcSeries = normalizeOverlayToEquityScale(backtestBtcOverlayPoints, equitySeries);
                            if (btcSeries.length > 0) {
                              overlays.push({
                                id: 'btc-usdt-price',
                                color: '#ff7a00',
                                lineWidth: 1,
                                data: btcSeries,
                              });
                            }
                          }

                          return overlays;
                        })()}
                      />
                    </Space>
                  ) : (
                    <Empty description="Пока нет equity-кривой" />
                  )}

                  {isAdminSurface && (
                  <Row gutter={[12, 12]}>
                    <Col xs={24} md={8}>
                      <Card size="small" title="График P/L">
                        {effectivePnlCurve.length > 0 ? (
                          <ChartComponent data={effectivePnlCurve.map((point) => ({ time: point.time, equity: point.value }))} type="line" />
                        ) : (
                          <Empty description="Нет данных P/L" />
                        )}
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card size="small" title="График просадки (DD)">
                        {effectiveDrawdownCurve.length > 0 ? (
                          <ChartComponent data={effectiveDrawdownCurve.map((point) => ({ time: point.time, equity: point.value }))} type="line" />
                        ) : (
                          <Empty description="Нет данных просадки" />
                        )}
                      </Card>
                    </Col>
                  </Row>
                  )}

                  {isAdminSurface && backtestDrawerContext.kind === 'algofund-ts' ? (
                    <Card size="small" title="Состав ТС в backtest (пары и веса)">
                      {(() => {
                        const idsFromResult = (adminSweepBacktestResult.selectedOffers || [])
                          .map((item) => String(item.offerId || '').trim())
                          .filter(Boolean);
                        const idsFromContext = (backtestDrawerContext.offerIds || [])
                          .map((item) => String(item || '').trim())
                          .filter(Boolean);
                        const currentOfferIds = Array.from(new Set([...idsFromResult, ...idsFromContext]));
                        const optionMap = new Map<string, string>(
                          storefrontOfferOptions.map((item) => [String(item.value), String(item.label)])
                        );
                        currentOfferIds.forEach((offerId) => {
                          if (!optionMap.has(offerId)) {
                            const title = String(offerTitleById[offerId] || offerId);
                            optionMap.set(offerId, `${title} (${offerId})`);
                          }
                        });
                        const options = Array.from(optionMap.entries()).map(([value, label]) => ({ value, label }));
                        const normalizedWeights = normalizeBacktestTsWeights(currentOfferIds, backtestTsWeightsByOfferId);
                        const totalWeight = currentOfferIds.reduce((acc, offerId) => acc + Number(normalizedWeights[offerId] || 0), 0);

                        return (
                          <Space direction="vertical" size={10} style={{ width: '100%' }}>
                            <Space wrap>
                              <Select
                                mode="multiple"
                                style={{ minWidth: 560, maxWidth: '100%' }}
                                placeholder="Добавь/убери офферы ТС"
                                value={currentOfferIds}
                                options={options}
                                onChange={(values) => {
                                  updateBacktestTsComposition((values || []).map((item) => String(item || '')));
                                }}
                              />
                              <Button
                                size="small"
                                onClick={() => {
                                  const equalWeights = Object.fromEntries(currentOfferIds.map((offerId) => [offerId, 1]));
                                  updateBacktestTsComposition(currentOfferIds, equalWeights);
                                }}
                                disabled={currentOfferIds.length === 0}
                              >
                                Равные веса
                              </Button>
                              <Tag color="blue">Σ весов: {formatNumber(totalWeight * 100, 2)}%</Tag>
                            </Space>
                            <Text type="secondary">Редактирование весов и состава выполняется в строках таблицы ниже, в колонке «Вес».</Text>
                          </Space>
                        );
                      })()}
                    </Card>
                  ) : null}

                      </>
                    );
                  })()}

                  {isAdminSurface && (
                  <Table
                    size="small"
                    rowKey="offerId"
                    pagination={false}
                    dataSource={adminSweepBacktestResult.selectedOffers}
                    columns={[
                      {
                        title: 'Карточка',
                        key: 'offer',
                        render: (_, row: any) => (
                          <Space direction="vertical" size={0}>
                            <Text strong>{row.titleRu}</Text>
                            <Text type="secondary">{String(row.mode || '').toUpperCase()} • {row.market || '—'}</Text>
                            <Text type="secondary">strategy #{Number(row.strategyId || 0)} • {String(row.strategyName || '').trim() || '—'}</Text>
                          </Space>
                        ),
                      },
                      {
                        title: 'Вес',
                        key: 'weight',
                        width: 240,
                        render: (_, row: any) => {
                          const offerId = String(row?.offerId || '').trim();
                          const activeOfferIds = Array.from(new Set((backtestDrawerContext?.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean)));
                          const normalizedWeights = normalizeBacktestTsWeights(activeOfferIds, backtestTsWeightsByOfferId);
                          const weight = Number(normalizedWeights[offerId] ?? row?.weight ?? 0);

                          if (backtestDrawerContext.kind !== 'algofund-ts') {
                            return weight > 0 ? `${formatNumber(weight * 100, 2)}%` : '—';
                          }

                          return (
                            <Space wrap>
                              <InputNumber
                                min={0.001}
                                max={1}
                                step={0.01}
                                value={weight > 0 ? weight : undefined}
                                onChange={(value) => {
                                  const nextWeights = {
                                    ...normalizedWeights,
                                    [offerId]: Number(value || 0),
                                  };
                                  updateBacktestTsComposition(activeOfferIds, nextWeights);
                                }}
                                style={{ width: 100 }}
                              />
                              <Tag>{formatNumber(weight * 100, 2)}%</Tag>
                            </Space>
                          );
                        },
                      },
                      {
                        title: 'Действия',
                        key: 'row-actions',
                        width: 140,
                        render: (_, row: any) => {
                          if (backtestDrawerContext.kind !== 'algofund-ts') {
                            return '—';
                          }
                          const offerId = String(row?.offerId || '').trim();
                          const activeOfferIds = Array.from(new Set((backtestDrawerContext?.offerIds || []).map((item) => String(item || '').trim()).filter(Boolean)));
                          const normalizedWeights = normalizeBacktestTsWeights(activeOfferIds, backtestTsWeightsByOfferId);
                          return (
                            <Button
                              size="small"
                              danger
                              disabled={activeOfferIds.length <= 1}
                              onClick={() => {
                                updateBacktestTsComposition(activeOfferIds.filter((id) => id !== offerId), normalizedWeights);
                              }}
                            >
                              Удалить
                            </Button>
                          );
                        },
                      },
                      {
                        title: 'Метрики',
                        key: 'metrics',
                        render: (_, row: any) => (
                          <Space wrap>
                            {String(row.metricsSource || '') === 'snapshot_only' ? (
                              <Tag color="default">источник: snapshot-only (без per-offer метрик)</Tag>
                            ) : (
                              <>
                                <Tag color={metricColor(Number(row.metrics?.ret || 0), 'return')}>Ret {formatPercent(row.metrics?.ret)}</Tag>
                                <Tag color={metricColor(Number(row.metrics?.dd || 0), 'drawdown')}>DD {formatPercent(row.metrics?.dd)}</Tag>
                                <Tag color={metricColor(Number(row.metrics?.pf || 0), 'pf')}>PF {formatNumber(row.metrics?.pf)}</Tag>
                                <Tag color="blue">trades {formatNumber(row.metrics?.trades, 0)}</Tag>
                                <Tag color="cyan">tpd {formatNumber(row.tradesPerDay, 2)}</Tag>
                              </>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                  )}
                </Space>
              </Card>
            ) : (
              <Empty description={adminSweepBacktestLoading ? 'Считаю sweep backtest...' : 'Запусти sweep backtest для просмотра метрик'} />
            )}
          </Space>
        ) : (
          <Empty description="Нет данных для открытия backtest" />
        )}
      </Drawer>
    </div>
  );
};

export default SaaS;

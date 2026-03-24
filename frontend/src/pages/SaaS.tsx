import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert,
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
  Slider,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

const { Paragraph, Text, Title } = Typography;

type ProductMode = 'strategy_client' | 'algofund_client';
type Level3 = 'low' | 'medium' | 'high';
type RequestStatus = 'pending' | 'approved' | 'rejected';
type SaasTabKey = 'admin' | 'strategy-client' | 'algofund';
type AdminTabKey = 'offer-ts' | 'research-analysis' | 'clients' | 'monitoring' | 'create-user';
type SummaryScope = 'light' | 'full';

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
  tokenConfigured: boolean;
  chatConfigured: boolean;
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
      equityPoints?: number[];
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
    name: string;
    isActive: boolean;
    updatedAt?: string;
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
    publishedTsPreview: 'Preview опубликованного admin TS',
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
    publishedTsPreview: 'Published admin TS preview',
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
    publishedTsPreview: 'Yayinlanan admin TS onizlemesi',
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

  return dedupeLinePoints(points);
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

const metricColor = (value: number, kind: 'return' | 'drawdown' | 'pf') => {
  if (kind === 'drawdown') {
    return value <= 2 ? 'success' : value <= 4 ? 'warning' : 'error';
  }
  if (kind === 'pf') {
    return value >= 2 ? 'success' : value >= 1.3 ? 'processing' : 'warning';
  }
  return value >= 0 ? 'success' : 'error';
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
    try {
      const parsed = JSON.parse(line);
      level = String(parsed?.level || '').toLowerCase();
      message = String(parsed?.message || line);
    } catch {
      // Keep raw line if not JSON-formatted.
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

const productModeTag = (mode: ProductMode) => {
  if (mode === 'algofund_client') {
    return <Tag color="gold">algofund</Tag>;
  }
  return <Tag color="green">strategy-client</Tag>;
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
  surfaceMode?: 'admin' | 'strategy-client' | 'algofund';
};

const clampPreviewValue = (value: number, max = 10): number => Math.min(max, Math.max(0, value));

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
  const copy = COPY_BY_LANGUAGE[language];
  const isAdminSurface = surfaceMode === 'admin';
  const [messageApi, contextHolder] = message.useMessage();
  const [summary, setSummary] = useState<SaasSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [reportPeriod, setReportPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [performanceReport, setPerformanceReport] = useState<AdminPerformanceReport | null>(null);
  const [performanceReportLoading, setPerformanceReportLoading] = useState(false);
  const [sendTelegramLoading, setSendTelegramLoading] = useState(false);
  const reviewContextRef = useRef<HTMLDivElement | null>(null);
  const [strategyTenantId, setStrategyTenantId] = useState<number | null>(null);
  const [algofundTenantId, setAlgofundTenantId] = useState<number | null>(null);
  const [strategyState, setStrategyState] = useState<StrategyClientState | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategyError, setStrategyError] = useState('');
  const [algofundState, setAlgofundState] = useState<AlgofundState | null>(null);
  const [algofundLoading, setAlgofundLoading] = useState(false);
  const [algofundError, setAlgofundError] = useState('');
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
  const [createTenantApiKey, setCreateTenantApiKey] = useState('');
  const [createTenantEmail, setCreateTenantEmail] = useState('');
  const [algofundNote, setAlgofundNote] = useState('');
  const [algofundDecisionNote, setAlgofundDecisionNote] = useState('');
  const [retryMaterializeModalVisible, setRetryMaterializeModalVisible] = useState(false);
  const [publishResponse, setPublishResponse] = useState<AdminPublishResponse | null>(null);
  const [monitoringSystemsByApiKey, setMonitoringSystemsByApiKey] = useState<Record<string, TradingSystemListItem[]>>({});
  const [monitoringSystemSelected, setMonitoringSystemSelected] = useState<Record<number, number | undefined>>({});
  const [monitoringLogCommentsByApiKey, setMonitoringLogCommentsByApiKey] = useState<Record<string, string[]>>({});
  const [monitoringTabLoading, setMonitoringTabLoading] = useState(false);
  const [monitoringModeFilter, setMonitoringModeFilter] = useState<'all' | ProductMode>('all');
  const [clientsModeFilter, setClientsModeFilter] = useState<'all' | ProductMode>('all');
  const [clientsClassKind, setClientsClassKind] = useState<'all' | 'offer' | 'ts'>('all');
  const [clientsClassValue, setClientsClassValue] = useState('');
  const [selectedAdminReviewKind, setSelectedAdminReviewKind] = useState<'offer' | 'algofund-ts'>('offer');
  const [selectedAdminReviewOfferId, setSelectedAdminReviewOfferId] = useState('');
  const [approvalMinProfitFactor, setApprovalMinProfitFactor] = useState(1);
  const [telegramControls, setTelegramControls] = useState<TelegramControls | null>(null);
  const [telegramControlsLoading, setTelegramControlsLoading] = useState(false);
  const [lowLotRecommendations, setLowLotRecommendations] = useState<LowLotRecommendationResponse | null>(null);
  const [lowLotLoading, setLowLotLoading] = useState(false);
  const [applyLowLotTarget, setApplyLowLotTarget] = useState<LowLotRecommendation | null>(null);
  const [applyLowLotDeposit, setApplyLowLotDeposit] = useState(true);
  const [applyLowLotLot, setApplyLowLotLot] = useState(true);
  const [applyLowLotReplacement, setApplyLowLotReplacement] = useState('');
  const [applyLowLotWorking, setApplyLowLotWorking] = useState(false);
  const [batchTenantIds, setBatchTenantIds] = useState<number[]>([]);
  const [batchAlgofundAction, setBatchAlgofundAction] = useState<'start' | 'stop' | 'switch_system'>('start');
  const [batchTargetSystemId, setBatchTargetSystemId] = useState<number | null>(null);
  const [batchActionNote, setBatchActionNote] = useState('');
  const [unpublishWizardVisible, setUnpublishWizardVisible] = useState(false);
  const [unpublishTargetOfferId, setUnpublishTargetOfferId] = useState('');
  const [unpublishImpact, setUnpublishImpact] = useState<OfferUnpublishImpact | null>(null);
  const [unpublishImpactLoading, setUnpublishImpactLoading] = useState(false);
  const [unpublishAcknowledge, setUnpublishAcknowledge] = useState(false);
  const [monitoringChartOpen, setMonitoringChartOpen] = useState(false);
  const [monitoringChartLoading, setMonitoringChartLoading] = useState(false);
  const [monitoringChartApiKey, setMonitoringChartApiKey] = useState('');
  const [monitoringChartPoints, setMonitoringChartPoints] = useState<LinePoint[]>([]);
  const [monitoringChartLatest, setMonitoringChartLatest] = useState<MonitoringSnapshotPoint | null>(null);
  const [planDrafts, setPlanDrafts] = useState<Record<string, Plan>>({});
  const [actionLoading, setActionLoading] = useState<string>('');
  const [activeTab, setActiveTab] = useState<SaasTabKey>(initialTab);
  const [approveRequestModalVisible, setApproveRequestModalVisible] = useState(false);
  const [approveRequestPendingId, setApproveRequestPendingId] = useState<number | null>(null);
  const [approveRequestSelectedPlan, setApproveRequestSelectedPlan] = useState('');
  const [approveRequestSelectedApiKey, setApproveRequestSelectedApiKey] = useState('');
  const [backtestDrawerVisible, setBacktestDrawerVisible] = useState(false);
  const [backtestDrawerApiKeyName, setBacktestDrawerApiKeyName] = useState('');
  const [backtestDrawerSystemId, setBacktestDrawerSystemId] = useState<number | null>(null);

  const strategyTenants = (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'strategy_client');
  const algofundTenants = (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'algofund_client');
  const batchEligibleAlgofundTenants = (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'algofund_client');
  const strategySystemProfiles = strategyState?.systemProfiles || [];
  const activeStrategySystemProfile = strategySystemProfiles.find((item) => item.isActive) || null;
  const selectedStrategyTenantSummary = strategyTenants.find((item) => item.tenant.id === strategyTenantId) || null;
  const selectedAlgofundTenantSummary = algofundTenants.find((item) => item.tenant.id === algofundTenantId) || null;
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
  const strategyPlanOptions = (summary?.plans || [])
    .filter((plan) => plan.product_mode === 'strategy_client')
    .map((plan) => ({ value: plan.code, label: `${plan.title} В· ${formatMoney(plan.price_usdt)}` }));
  const algofundPlanOptions = (summary?.plans || [])
    .filter((plan) => plan.product_mode === 'algofund_client')
    .map((plan) => ({ value: plan.code, label: `${plan.title} В· ${formatMoney(plan.price_usdt)}` }));
  const apiKeyOptions = (summary?.apiKeys || []).map((name) => ({ label: name, value: name }));
  const summaryCatalogOffers = dedupeOffersById([
    ...(summary?.catalog?.clientCatalog?.mono || []),
    ...(summary?.catalog?.clientCatalog?.synth || []),
  ]);
  const strategyRecommendedOffers = dedupeOffersById(
    Object.values(strategyState?.recommendedSets || {}).reduce<CatalogOffer[]>((acc, items) => {
      if (Array.isArray(items)) {
        acc.push(...items);
      }
      return acc;
    }, [])
  );
  const summaryRecommendedOffers = dedupeOffersById(
    Object.values(summary?.recommendedSets || {}).reduce<CatalogOffer[]>((acc, items) => {
      if (Array.isArray(items)) {
        acc.push(...items);
      }
      return acc;
    }, [])
  );
  const publishedOfferIds = new Set((summary?.offerStore?.publishedOfferIds || []).map((item) => String(item)));
  const strategyOfferCatalog = dedupeOffersById(
    (strategyState?.offers || []).length > 0
      ? (strategyState?.offers || [])
      : [...summaryCatalogOffers, ...strategyRecommendedOffers, ...summaryRecommendedOffers]
  ).filter((offer) => publishedOfferIds.has(String(offer.offerId || '')));
  const strategyDraftConstraints = buildDraftStrategyConstraints(strategyOfferIds, strategyOfferCatalog, strategyState?.constraints || null);
  const pendingAlgofundRequests = (summary?.algofundRequestQueue?.items || []).filter((item) => item.status === 'pending');
  const pendingSwitchSystemIds = new Set(
    pendingAlgofundRequests
      .filter((item) => item.request_type === 'switch_system')
      .map((item) => parseAlgofundRequestPayload(item.request_payload_json).targetSystemId)
      .filter((id): id is number => Number.isFinite(Number(id)) && Number(id) > 0)
  );
  const pendingAlgofundRequestsByTenant = pendingAlgofundRequests.reduce<Record<number, AlgofundRequest[]>>((acc, item) => {
    const key = Number(item.tenant_id || 0);
    if (!Number.isFinite(key) || key <= 0) {
      return acc;
    }
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {});
  const offerStoreOffers = summary?.offerStore?.offers || [];
  const sweepReviewRecords = Array.from(
    new Map(
      [
        ...(summary?.sweepSummary?.selectedMembers || []),
        ...(summary?.sweepSummary?.topAll || []),
        ...(summary?.sweepSummary?.topByMode?.mono || []),
        ...(summary?.sweepSummary?.topByMode?.synth || []),
      ].map((item) => [Number(item.strategyId || 0), item])
    ).values()
  ).filter((item) => Number(item?.strategyId || 0) > 0);
  const sweepRecordByStrategyId = sweepReviewRecords.reduce<Record<number, typeof sweepReviewRecords[number]>>((acc, item) => {
    const key = Number(item.strategyId || 0);
    if (key > 0) {
      acc[key] = item;
    }
    return acc;
  }, {});
  const sweepCandidateStrategyIds = new Set(
    [
      ...(summary?.sweepSummary?.selectedMembers || []),
      ...(summary?.sweepSummary?.topAll || []),
      ...(summary?.sweepSummary?.topByMode?.mono || []),
      ...(summary?.sweepSummary?.topByMode?.synth || []),
    ]
      .map((item) => Number(item.strategyId || 0))
      .filter((item) => Number.isFinite(item) && item > 0)
  );
  const recommendedOfferIds = new Set(
    summaryRecommendedOffers
      .map((offer) => String(offer.offerId || '').trim())
      .filter(Boolean)
  );
  const publishedStorefrontOffers = offerStoreOffers.filter((offer) => Boolean(offer.published));
  const reviewableSweepOffers = offerStoreOffers.filter((offer) => (
    sweepCandidateStrategyIds.size > 0
      ? sweepCandidateStrategyIds.has(Number(offer.strategyId || 0))
      : recommendedOfferIds.size > 0
        ? recommendedOfferIds.has(String(offer.offerId || ''))
        : true
  ) && Number(offer.pf || 0) >= approvalMinProfitFactor);
  const researchCandidateOffers = reviewableSweepOffers.filter((offer) => !Boolean(offer.published));
  const adminReviewOfferPool = Array.from(
    new Map(
      [...reviewableSweepOffers, ...publishedStorefrontOffers]
        .map((offer) => [String(offer.offerId), offer])
    ).values()
  );
  const selectedAdminReviewOffer = adminReviewOfferPool.find((offer) => String(offer.offerId) === selectedAdminReviewOfferId) || null;
  const adminTradingSystemDraft = summary?.catalog?.adminTradingSystemDraft || null;
  const adminDraftMembersDetailed = (adminTradingSystemDraft?.members || []).map((member) => ({
    ...member,
    reviewRecord: sweepRecordByStrategyId[Number(member.strategyId || 0)] || null,
  }));
  const adminDraftPortfolioSummary = summary?.sweepSummary?.portfolioFull?.summary || null;
  const adminDraftPeriodDays = getPeriodDurationDays(summary?.sweepSummary?.period || null);
  const adminDraftTradesPerDay = adminDraftPortfolioSummary && adminDraftPeriodDays && adminDraftPeriodDays > 0
    ? Number((Number(adminDraftPortfolioSummary.tradesCount || 0) / adminDraftPeriodDays).toFixed(2))
    : null;
  const algofundStorefrontSystems = Array.from(
    new Set([
      ...batchEligibleAlgofundTenants
        .map((item) => String(item.algofundProfile?.published_system_name || '').trim())
        .filter(Boolean),
      String(publishResponse?.sourceSystem?.systemName || '').trim(),
    ].filter(Boolean))
  ).map((systemName) => {
    const tenants = batchEligibleAlgofundTenants.filter((tenant) => String(tenant.algofundProfile?.published_system_name || '').trim() === systemName);
    const runtimeSystemId = publishResponse?.sourceSystem?.systemName === systemName
      ? Number(publishResponse.sourceSystem.systemId || 0)
      : null;

    return {
      systemName,
      runtimeSystemId,
      apiKeyName: publishResponse?.sourceSystem?.systemName === systemName
        ? String(publishResponse.sourceSystem.apiKeyName || '')
        : '',
      tenants,
      tenantCount: tenants.length,
      activeCount: tenants.filter((tenant) => Number(tenant.algofundProfile?.actual_enabled || 0) === 1).length,
      pendingCount: tenants.filter((tenant) => Number(tenant.algofundProfile?.requested_enabled || 0) === 1 && Number(tenant.algofundProfile?.actual_enabled || 0) !== 1).length,
    };
  });
  const publishedAdminTsEditorTarget = (() => {
    const sourceApiKeyName = String(publishResponse?.sourceSystem?.apiKeyName || '').trim();
    const sourceSystemId = Number(publishResponse?.sourceSystem?.systemId || 0);
    if (sourceApiKeyName) {
      return {
        apiKeyName: sourceApiKeyName,
        systemId: sourceSystemId > 0 ? sourceSystemId : undefined,
      };
    }

    const fallbackTenant = batchEligibleAlgofundTenants.find((item) => {
      const apiKey = String(item.algofundProfile?.assigned_api_key_name || item.tenant.assigned_api_key_name || '').trim();
      return apiKey.length > 0;
    });
    if (!fallbackTenant) {
      return null;
    }

    return {
      apiKeyName: String(fallbackTenant.algofundProfile?.assigned_api_key_name || fallbackTenant.tenant.assigned_api_key_name || '').trim(),
      systemId: undefined,
    };
  })();
  const offerTitleById = offerStoreOffers.reduce<Record<string, string>>((acc, offer) => {
    acc[String(offer.offerId)] = String(offer.titleRu || offer.offerId);
    return acc;
  }, {});
  const clientsOfferFilterOptions = offerStoreOffers.map((offer) => ({
    value: String(offer.offerId),
    label: `${offer.titleRu} (${String(offer.mode || '').toUpperCase()} ${offer.market})`,
  }));
  const clientsTsFilterOptions = Array.from(
    new Set(
      (summary?.tenants || [])
        .filter((item) => item.tenant.product_mode === 'algofund_client')
        .map((item) => String(item.algofundProfile?.published_system_name || '').trim())
        .filter((item) => item.length > 0)
    )
  ).map((name) => ({ value: name, label: name }));

  const filteredClients = (summary?.tenants || []).filter((tenantSummary) => {
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
  });
  const resolveSummaryScope = (): SummaryScope => {
    if (activeTab === 'admin' && (adminTab === 'offer-ts' || adminTab === 'research-analysis')) {
      return 'full';
    }
    return 'light';
  };

  const loadSummary = async (scope: SummaryScope = resolveSummaryScope()): Promise<SaasSummary | null> => {
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const response = await axios.get<SaasSummary>('/api/saas/admin/summary', {
        params: { scope },
      });
      setSummary((prev) => {
        if (scope === 'light' && prev?.offerStore && !response.data.offerStore) {
          return {
            ...response.data,
            offerStore: prev.offerStore,
          };
        }
        return response.data;
      });
      return response.data;
    } catch (error: any) {
      setSummaryError(String(error?.response?.data?.error || error?.message || 'Failed to load SaaS summary'));
      return null;
    } finally {
      setSummaryLoading(false);
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

  const toggleReportSetting = async (key: keyof NonNullable<SaasSummary['reportSettings']>, value: boolean) => {
    setActionLoading(`report-setting:${String(key)}`);
    try {
      await axios.patch('/api/saas/admin/reports/settings', {
        [key]: value,
      });
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to update report settings'));
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

  const loadAlgofundTenant = async (tenantId: number, nextRiskMultiplier?: number, allowPreviewAbovePlan = false, forceRefreshPreview = false) => {
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
      setAlgofundState(response.data);
    } catch (error: any) {
      setAlgofundError(String(error?.response?.data?.error || error?.message || 'Failed to load algofund client'));
      setAlgofundState(null);
    } finally {
      setAlgofundLoading(false);
    }
  };

  useEffect(() => {
    if (!isAdminSurface) {
      return;
    }
    void loadSummary('full');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSurface]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!isAdminSurface) {
      return;
    }
    if (
      activeTab === 'admin'
      && (adminTab === 'offer-ts' || adminTab === 'research-analysis')
      && !summary?.offerStore
      && !summaryLoading
    ) {
      void loadSummary('full');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSurface, activeTab, adminTab, summary?.offerStore]);

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
          replacementSymbol: applyLowLotReplacement || undefined,
        }
      );
      const changeSummary = Array.isArray(resp.data?.changeSummary) ? resp.data.changeSummary : [];
      const summaryText = changeSummary.length > 0 ? ` (${changeSummary.join(', ')})` : '';
      messageApi.success(`Применено к стратегии ${strategyName}${summaryText}`, 8);
      setApplyLowLotTarget(null);
      void loadLowLotRecommendations();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Ошибка применения'));
    } finally {
      setApplyLowLotWorking(false);
    }
  }, [applyLowLotTarget, applyLowLotDeposit, applyLowLotLot, applyLowLotReplacement, messageApi, loadLowLotRecommendations]);

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
      return;
    }

    setMonitoringTabLoading(true);
    try {
      const entries: Array<[string, TradingSystemListItem[]]> = await Promise.all(
        apiKeys.map(async (apiKeyName) => {
          try {
            const response = await axios.get<TradingSystemListItem[]>(`/api/trading-systems/${encodeURIComponent(apiKeyName)}`);
            return [apiKeyName, Array.isArray(response.data) ? response.data : []];
          } catch {
            return [apiKeyName, []];
          }
        })
      );

      const nextMap: Record<string, TradingSystemListItem[]> = {};
      for (const [apiKeyName, systems] of entries) {
        nextMap[apiKeyName] = systems;
      }
      setMonitoringSystemsByApiKey(nextMap);

      try {
        const logsResponse = await axios.get<string[]>('/api/logs');
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
      setMonitoringTabLoading(false);
    }
  }, [summary]);

  const openMonitoringChart = async (apiKeyName: string) => {
    const key = String(apiKeyName || '').trim();
    if (!key) {
      return;
    }

    setMonitoringChartOpen(true);
    setMonitoringChartApiKey(key);
    setMonitoringChartLoading(true);
    try {
      const response = await axios.get<{ points?: MonitoringSnapshotPoint[]; latest?: MonitoringSnapshotPoint }>(
        `/api/monitoring/${encodeURIComponent(key)}`,
        { params: { limit: 240 } }
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

  useEffect(() => {
    if (activeTab === 'admin' && adminTab === 'research-analysis') {
      if (!performanceReport) {
        void loadPerformanceReport('daily');
      }
      void loadTelegramControls();
    }
    if (activeTab === 'admin' && adminTab === 'monitoring') {
      void loadMonitoringTabData();
      void loadTelegramControls();
      void loadLowLotRecommendations();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, adminTab, loadMonitoringTabData, loadTelegramControls, loadLowLotRecommendations]);

  useEffect(() => {
    if (!summary) {
      return;
    }

    const nextStrategyTenant = (summary.tenants || []).find((item) => item.tenant.product_mode === 'strategy_client')?.tenant.id || null;
    const nextAlgofundTenant = (summary.tenants || []).find((item) => item.tenant.product_mode === 'algofund_client')?.tenant.id || null;

    if (strategyTenantId === null && nextStrategyTenant !== null) {
      setStrategyTenantId(nextStrategyTenant);
    }
    if (algofundTenantId === null && nextAlgofundTenant !== null) {
      setAlgofundTenantId(nextAlgofundTenant);
    }
  }, [summary, strategyTenantId, algofundTenantId]);

  useEffect(() => {
    if (strategyTenantId !== null) {
      void loadStrategyTenant(strategyTenantId);
    }
  }, [strategyTenantId]);

  useEffect(() => {
    if (algofundTenantId !== null) {
      void loadAlgofundTenant(algofundTenantId, undefined, isAdminSurface);
    }
  }, [algofundTenantId, isAdminSurface]);

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
    setAlgofundApiKeyName(algofundState.profile?.assigned_api_key_name || algofundState.tenant.assigned_api_key_name || '');
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
    if (!algofundTenantId || !algofundState || algofundLoading) {
      return;
    }

    const currentPreviewRisk = Number(algofundState.preview?.riskMultiplier ?? algofundState.profile?.risk_multiplier ?? 1);
    const targetRisk = Number(algofundRiskMultiplier);
    if (!Number.isFinite(targetRisk)) {
      return;
    }

    if (Math.abs(currentPreviewRisk - targetRisk) < 0.01) {
      return;
    }

    const timer = window.setTimeout(() => {
      void loadAlgofundTenant(algofundTenantId, Number(targetRisk.toFixed(2)), isAdminSurface);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [algofundLoading, algofundRiskMultiplier, algofundTenantId, algofundState, isAdminSurface]);

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

  const publishAdminTs = async () => {
    setActionLoading('publish');
    try {
      const response = await axios.post<AdminPublishResponse>('/api/saas/admin/publish');
      setPublishResponse(response.data);
      messageApi.success(copy.publishReady);
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to publish admin TS'));
    } finally {
      setActionLoading('');
    }
  };

  const openTenantWorkspace = (row: TenantSummary) => {
    const tenantId = Number(row.tenant.id || 0);
    if (!tenantId) {
      return;
    }

    if (row.tenant.product_mode === 'strategy_client') {
      setStrategyTenantId(tenantId);
      setActiveTab('strategy-client');
      return;
    }

    setAlgofundTenantId(tenantId);
    setActiveTab('algofund');
  };

  const openPublishedAdminTsForClients = () => {
    const publishedSystemId = Number(publishResponse?.sourceSystem?.systemId || 0);
    const publishedSystemName = String(publishResponse?.sourceSystem?.systemName || '').trim();
    if (!publishedSystemId || !publishedSystemName) {
      messageApi.warning('Сначала отправьте draft ТС на апрув, чтобы получить runtime system id');
      return;
    }

    setActiveTab('admin');
    setAdminTab('clients');
    setClientsModeFilter('algofund_client');
    setClientsClassKind('ts');
    setClientsClassValue(publishedSystemName);
    setBatchAlgofundAction('switch_system');
    setBatchTargetSystemId(publishedSystemId);
    setBatchTenantIds(batchEligibleAlgofundTenants.map((item) => Number(item.tenant.id)).filter((item) => item > 0));
    messageApi.success('Открыт шаг применения клиентам: выбран switch_system и подставлен опубликованный admin TS');
  };

  const focusClientsByOffer = (offerId: string) => {
    setActiveTab('admin');
    setAdminTab('clients');
    setClientsClassKind('offer');
    setClientsClassValue(String(offerId || ''));
    messageApi.info('Открыт список клиентов, подключённых к выбранному офферу.');
  };

  const focusClientsByTradingSystem = (systemName: string) => {
    const normalizedSystemName = String(systemName || '').trim();
    if (!normalizedSystemName) {
      messageApi.warning('Для фильтрации клиентов нужна опубликованная runtime ТС.');
      return;
    }

    setActiveTab('admin');
    setAdminTab('clients');
    setClientsModeFilter('algofund_client');
    setClientsClassKind('ts');
    setClientsClassValue(normalizedSystemName);
    messageApi.info('Открыт список algofund-клиентов с выбранной ТС.');
  };

  const openAdminMonitoring = (mode: 'all' | ProductMode = 'all') => {
    setActiveTab('admin');
    setAdminTab('monitoring');
    setMonitoringModeFilter(mode);
  };

  const openPublishedAdminTsEditor = () => {
    if (!publishedAdminTsEditorTarget?.apiKeyName) {
      messageApi.warning('Для открытия редактора ТС нужен назначенный API key и опубликованная runtime ТС');
      return;
    }

    const params = new URLSearchParams();
    params.set('apiKeyName', publishedAdminTsEditorTarget.apiKeyName);
    if (publishedAdminTsEditorTarget.systemId && publishedAdminTsEditorTarget.systemId > 0) {
      params.set('systemId', String(publishedAdminTsEditorTarget.systemId));
    }
    window.location.href = `/trading-systems?${params.toString()}`;
  };

  const openBacktestDrawerForAdminTs = () => {
    if (!publishedAdminTsEditorTarget?.apiKeyName) {
      messageApi.warning('Для открытия backtest нужен назначенный API key и опубликованная runtime ТС');
      return;
    }

    setBacktestDrawerApiKeyName(publishedAdminTsEditorTarget.apiKeyName);
    setBacktestDrawerSystemId(Number(publishedAdminTsEditorTarget.systemId || 0));
    setBacktestDrawerVisible(true);
  };

  const openSaasBacktestFlow = () => {
    setActiveTab('admin');
    setAdminTab('offer-ts');
    messageApi.info('Backtest по sweep доступен в Админ -> Оферы и ТС (review) и через кнопку "Backtest ТС (в редакторе)".');
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
    setAdminTab('offer-ts');
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
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to apply published admin TS to selected clients'));
    } finally {
      setActionLoading('');
    }
  };

  const createTenantAdmin = async () => {
    if (!createTenantDisplayName.trim() || !createTenantPlanCode) {
      messageApi.error('Display name and plan are required');
      return;
    }
    setActionLoading('createTenant');
    try {
      await axios.post('/api/saas/admin/tenants', {
        displayName: createTenantDisplayName,
        productMode: createTenantProductMode,
        planCode: createTenantPlanCode,
        assignedApiKeyName: createTenantApiKey || undefined,
        email: createTenantEmail || undefined,
        language,
      });
      messageApi.success(copy.createClientSuccess);
      setCreateTenantDisplayName('');
      setCreateTenantProductMode('strategy_client');
      setCreateTenantPlanCode('');
      setCreateTenantApiKey('');
      setCreateTenantEmail('');
      setAdminTab('offer-ts');
      await loadSummary();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to create tenant'));
    } finally {
      setActionLoading('');
    }
  };

  const toggleTenantRequestedEnabled = async (row: TenantSummary, nextEnabled: boolean) => {
    const tenantId = Number(row.tenant.id);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return;
    }

    setActionLoading(`monitor-toggle-${tenantId}`);
    try {
      if (row.tenant.product_mode === 'strategy_client') {
        await axios.patch(`/api/saas/strategy-clients/${tenantId}`, { requestedEnabled: nextEnabled });
      } else {
        await axios.patch(`/api/saas/algofund/${tenantId}`, { requestedEnabled: nextEnabled });
      }
      messageApi.success(`Updated ${row.tenant.display_name}: requested ${nextEnabled ? 'ON' : 'OFF'}`);
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

  const tenantColumns: ColumnsType<TenantSummary> = [
    {
      title: 'Tenant',
      key: 'tenant',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{row.tenant.display_name}</Text>
          <Text type="secondary">{row.tenant.slug}</Text>
        </Space>
      ),
    },
    {
      title: copy.tenantMode,
      key: 'mode',
      width: 140,
      render: (_, row) => productModeTag(row.tenant.product_mode),
    },
    {
      title: copy.plan,
      key: 'plan',
      render: (_, row) => row.plan ? `${row.plan.title} • ${formatMoney(row.plan.price_usdt)}` : '—',
    },
    {
      title: copy.apiKey,
      key: 'apiKey',
      render: (_, row) => (
        <Space wrap>
          <Text>{row.tenant.assigned_api_key_name || '—'}</Text>
          {row.capabilities && !row.capabilities.apiKeyUpdate ? <Tag color="default">readonly</Tag> : null}
        </Space>
      ),
    },
    {
      title: copy.planCapabilities,
      key: 'capabilities',
      width: 240,
      render: (_, row) => renderCapabilityTags(copy, row.capabilities),
    },
    {
      title: copy.monitoring,
      key: 'monitoring',
      render: (_, row) => row.capabilities?.monitoring ? (row.monitoring ? (
        <Space size={4} wrap>
          <Tag color="blue">Eq {formatMoney(row.monitoring.equity_usd)}</Tag>
          <Tag color="geekblue">PnL {formatMoney(row.monitoring.unrealized_pnl)}</Tag>
          <Tag color="orange">DD {formatPercent(row.monitoring.drawdown_percent)}</Tag>
          <Tag color="purple">ML {formatPercent(row.monitoring.margin_load_percent)}</Tag>
          {Number.isFinite(row.monitoring.effective_leverage) ? <Tag color="red">Lev {formatNumber(row.monitoring.effective_leverage, 2)}x</Tag> : null}
          {calcDepositLoadPercent(row) !== null ? <Tag color="cyan">{copy.depositLoad}: {formatPercent(calcDepositLoadPercent(row))}</Tag> : null}
          {(() => {
            const liq = calcLiquidationRisk(row);
            return <Tag color={liq.color}>{copy.liquidationRisk}: {liq.level}{liq.bufferPercent !== null ? ` (${formatPercent(liq.bufferPercent)} buf)` : ''}</Tag>;
          })()}
        </Space>
      ) : <Tag color="default">off</Tag>) : <Tag color="default">off</Tag>,
    },
    {
      title: 'Классификация',
      key: 'classification',
      width: 260,
      render: (_, row) => {
        if (row.tenant.product_mode === 'strategy_client') {
          const selected = Array.isArray(row.strategyProfile?.selectedOfferIds)
            ? row.strategyProfile?.selectedOfferIds || []
            : [];
          if (selected.length === 0) {
            return <Tag color="default">Офер не выбран</Tag>;
          }
          return (
            <Space size={4} wrap>
              {selected.slice(0, 3).map((offerId) => (
                <Tag key={`${row.tenant.id}:${offerId}`} color="blue">{offerTitleById[String(offerId)] || String(offerId)}</Tag>
              ))}
              {selected.length > 3 ? <Tag color="default">+{selected.length - 3}</Tag> : null}
            </Space>
          );
        }

        const systemName = String(row.algofundProfile?.published_system_name || '').trim();
        return systemName ? <Tag color="purple">{systemName}</Tag> : <Tag color="default">ТС не выбрана</Tag>;
      },
    },
    {
      title: copy.status,
      key: 'status',
      width: 220,
      render: (_, row) => {
        const profile = row.tenant.product_mode === 'strategy_client' ? row.strategyProfile : row.algofundProfile;
        const requestedEnabled = Number(profile?.requested_enabled || 0) === 1;
        const actualEnabled = Number(profile?.actual_enabled || 0) === 1;
        return (
          <Space direction="vertical" size={2}>
            <Tag color={row.tenant.status === 'active' ? 'success' : 'default'}>{row.tenant.status}</Tag>
            <Space size={4} wrap>
              <Tag color={actualEnabled ? 'success' : 'default'}>{actualEnabled ? 'runtime on' : 'runtime off'}</Tag>
              <Tag color={requestedEnabled ? 'processing' : 'default'}>{requestedEnabled ? 'requested on' : 'requested off'}</Tag>
            </Space>
          </Space>
        );
      },
    },
    {
      title: 'Action',
      key: 'action',
      width: 260,
      render: (_, row) => row.tenant.product_mode === 'strategy_client' ? (
        <Button
          size="small"
          onClick={() => {
            setStrategyTenantId(row.tenant.id);
            setActiveTab('strategy-client');
          }}
        >
          {copy.openStrategyClient}
        </Button>
      ) : (
        <Space size={4} wrap>
          <Button
            size="small"
            onClick={() => {
              setAlgofundTenantId(row.tenant.id);
              setActiveTab('algofund');
            }}
          >
            {copy.openAlgofund}
          </Button>
          <Button
            size="small"
            type="primary"
            loading={actionLoading === `algofund-single:${row.tenant.id}`}
            onClick={() => void runSingleAlgofundAction(Number(row.tenant.id), 'start')}
          >
            Start
          </Button>
          <Button
            size="small"
            danger
            loading={actionLoading === `algofund-single:${row.tenant.id}`}
            onClick={() => void runSingleAlgofundAction(Number(row.tenant.id), 'stop')}
          >
            Stop
          </Button>
          <Button
            size="small"
            disabled={!preferredClientSwitchTarget?.systemId}
            loading={actionLoading === `algofund-single:${row.tenant.id}`}
            onClick={() => void runSingleAlgofundAction(Number(row.tenant.id), 'switch_system', Number(preferredClientSwitchTarget?.systemId || 0))}
          >
            Switch TS
          </Button>
        </Space>
      ),
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
  const algofundEngineRunning = Boolean(algofundState?.profile?.actual_enabled);
  const algofundEnginePending = Boolean(algofundState?.profile?.requested_enabled) && !algofundEngineRunning;
  const algofundEngineBlockedReason = String(algofundState?.preview?.blockedReason || '').trim();
  const monitoringRows = (summary?.tenants || [])
    .filter((row) => monitoringModeFilter === 'all' || row.tenant.product_mode === monitoringModeFilter)
    .map((row) => {
      const profile = row.tenant.product_mode === 'strategy_client' ? row.strategyProfile : row.algofundProfile;
      const requestedEnabled = Number(profile?.requested_enabled || 0) === 1;
      const actualEnabled = Number(profile?.actual_enabled || 0) === 1;
      const apiKeyName = String(profile?.assigned_api_key_name || row.tenant.assigned_api_key_name || '').trim();
      const systems = monitoringSystemsByApiKey[apiKeyName] || [];
      const logNotes = monitoringLogCommentsByApiKey[apiKeyName] || [];
      const selectedSystemId = monitoringSystemSelected[row.tenant.id];
      const selectedSystem = systems.find((system) => Number(system.id) === Number(selectedSystemId)) || null;
      const liq = calcLiquidationRisk(row);
      const tenantPendingRequests = pendingAlgofundRequestsByTenant[row.tenant.id] || [];
      const comments: string[] = [];
      if (!apiKeyName) comments.push('API key is not assigned');
      if (requestedEnabled && !actualEnabled) comments.push('Requested ON, but engine is not started yet');
      if (tenantPendingRequests.length > 0) comments.push(`Pending requests: ${tenantPendingRequests.map((item) => `${item.request_type} #${item.id}`).join(', ')}`);
      if (actualEnabled && liq.level === 'high') comments.push('High liquidation risk');
      if (!row.monitoring) comments.push('Monitoring snapshot unavailable');
      const lotHint = buildLotSizingHint(logNotes);
      if (lotHint) comments.push(lotHint);

      return {
        ...row,
        requestedEnabled,
        actualEnabled,
        apiKeyName,
        systems,
        logNotes,
        selectedSystem,
        tenantPendingRequests,
        comments: comments.join(' | ') || 'OK',
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
      title: 'Requested',
      key: 'requested',
      width: 120,
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.requestedEnabled}
          loading={actionLoading === `monitor-toggle-${row.tenant.id}`}
          onChange={(checked) => {
            void toggleTenantRequestedEnabled(row, checked);
          }}
        />
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
              {isAdminSurface ? <Button type="dashed" onClick={() => { setActiveTab('admin'); setAdminTab('create-user'); }}>{copy.createClient}</Button> : null}
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
          onChange={(key) => setActiveTab(key as SaasTabKey)}
          items={[
            {
              key: 'admin',
              label: copy.admin,
              children: (
                <Tabs
                  activeKey={adminTab}
                  onChange={(key) => {
                    const nextKey = key as AdminTabKey;
                    setAdminTab(nextKey);
                    if (nextKey === 'offer-ts' || nextKey === 'research-analysis') {
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

                          <Row gutter={[16, 16]}>
                            <Col xs={24} md={8}>
                              <Card className="battletoads-card">
                                <Statistic title={copy.latestCatalog} value={summary?.catalog?.counts?.monoCatalog || 0} suffix={`mono / ${summary?.catalog?.counts?.synthCatalog || 0} synth`} />
                                <Text type="secondary">{summary?.sourceFiles?.latestCatalogPath || 'results/*.json not found'}</Text>
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

                          <div ref={reviewContextRef}>
                          <Card className="battletoads-card" title="Контекст review: оффер или ТС">
                            {selectedAdminReviewKind === 'algofund-ts' ? (
                              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                <Paragraph type="secondary" style={{ marginTop: 0 }}>
                                  Здесь полный workflow по ТС Алгофонда после sweep: просмотр состава и метрик, отправка draft ТС на апрув, затем переход к применению опубликованной ТС на клиентов Алгофонда.
                                </Paragraph>
                                <Space wrap>
                                  <Tag color={publishResponse?.sourceSystem ? 'success' : 'processing'}>{publishResponse?.sourceSystem ? 'published runtime TS ready' : 'pending review'}</Tag>
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
                                    <Descriptions.Item label="API key">{publishResponse.sourceSystem.apiKeyName}</Descriptions.Item>
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
                                  <Button type="primary" onClick={() => void publishAdminTs()} loading={actionLoading === 'publish'}>Отправить ТС на апрув</Button>
                                  <Button size="small" onClick={() => setAdminTab('research-analysis')}>Открыть sweep/backtest</Button>
                                  <Button size="small" onClick={openPublishedAdminTsEditor}>Редактировать ТС</Button>
                                  <Button size="small" onClick={() => setBatchTenantIds(batchEligibleAlgofundTenants.map((item) => Number(item.tenant.id)).filter((item) => item > 0))}>Выбрать всех algofund-клиентов</Button>
                                  <Button size="small" disabled={!publishResponse?.sourceSystem?.systemId} onClick={openPublishedAdminTsForClients}>Применить к клиентам Алгофонда</Button>
                                  <Button size="small" onClick={openBacktestDrawerForAdminTs}>Backtest ТС (в окне)</Button>
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
                                  <Tag color={selectedAdminReviewOffer.published ? 'success' : 'processing'}>{selectedAdminReviewOffer.published ? 'already on storefront' : 'awaiting review'}</Tag>
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
                                  <ChartComponent data={equityPoints.map((value, index) => ({ time: index, equity: value }))} type="line" />
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
                                    {selectedAdminReviewOffer.published ? 'Обновить витрину' : 'Отправить на апрув'}
                                  </Button>
                                  <Button size="small" onClick={() => setActiveTab('strategy-client')}>Проверить витрину клиентов стратегий</Button>
                                  <Button size="small" onClick={() => setAdminTab('research-analysis')} disabled={!strategyBacktestEnabled}>Открыть sweep/backtest</Button>
                                  {selectedAdminReviewOffer.published ? <Button size="small" danger onClick={() => void openUnpublishWizard(String(selectedAdminReviewOffer.offerId))}>Снять с витрины</Button> : null}
                                </Space>
                                    </>
                                  );
                                })()}
                              </Space>
                            ) : (
                              <Empty description="Выбери карточку из Анализа ресерча или approved-витрины для review" />
                            )}
                          </Card>
                          </div>

                          <Card className="battletoads-card" title="Оферы и ТС: только approved на витринах">
                            <Paragraph type="secondary" style={{ marginTop: 0 }}>
                              Здесь только то, что уже апрувлено и показано на витринах. Для редактирования вернись в блок review выше, для снятия с витрины используй флаг в таблице ниже.
                            </Paragraph>
                            <Space wrap style={{ marginBottom: 12 }}>
                              <Tag color="processing">approved storefront: {publishedStorefrontOffers.length}</Tag>
                              <Tag color="blue">period: {Number(summary?.offerStore?.defaults?.periodDays || 0)}d</Tag>
                              <Tag color="geekblue">target: {Number(summary?.offerStore?.defaults?.targetTradesPerDay || 0)}/day</Tag>
                            </Space>
                            <Space wrap style={{ marginBottom: 16 }}>
                              <Button size="small" onClick={() => openAdminReviewContext('algofund-ts')}>Открыть review ТС</Button>
                            </Space>

                            <Row gutter={[16, 16]}>
                              <Col xs={24} lg={12}>
                                <Card className="battletoads-card" size="small" title="Витрина оферов клиентов стратегий (approved)">
                                  {publishedStorefrontOffers.length === 0 ? (
                                    <Empty description="Пока ничего не апрувлено на витрину" />
                                  ) : (
                                    <Table
                                      size="small"
                                      rowKey="offerId"
                                      dataSource={publishedStorefrontOffers}
                                      expandable={{
                                        expandedRowRender: (row: any) => {
                                          const pts: number[] = Array.isArray(row.equityPoints) ? row.equityPoints : [];
                                          if (pts.length === 0) {
                                            return <Text type="secondary">Equity curve unavailable</Text>;
                                          }
                                          return <ChartComponent data={pts.map((v, i) => ({ time: i, equity: v }))} type="line" />;
                                        },
                                        rowExpandable: () => true,
                                      }}
                                      pagination={{ pageSize: 6, showSizeChanger: false }}
                                      scroll={{ x: 760 }}
                                      columns={[
                                        {
                                          title: 'Офер',
                                          key: 'offer',
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
                                              <Tag>{Number(row.periodDays || 0)}d</Tag>
                                              <Tag color={metricColor(Number(row.ret || 0), 'return')}>Ret {formatPercent(row.ret)}</Tag>
                                              <Tag color={metricColor(Number(row.dd || 0), 'drawdown')}>DD {formatPercent(row.dd)}</Tag>
                                              <Tag color={metricColor(Number(row.pf || 0), 'pf')}>PF {formatNumber(row.pf)}</Tag>
                                            </Space>
                                          ),
                                        },
                                        {
                                          title: 'Действия',
                                          key: 'actions',
                                          width: 180,
                                          render: (_, row: any) => (
                                            <Space wrap>
                                              <Button
                                                size="small"
                                                onClick={() => {
                                                  setSelectedAdminReviewKind('offer');
                                                  setSelectedAdminReviewOfferId(String(row.offerId));
                                                }}
                                              >
                                                Редактировать
                                              </Button>
                                              <Button size="small" danger onClick={() => void openUnpublishWizard(String(row.offerId))}>Снять</Button>
                                            </Space>
                                          ),
                                        },
                                      ]}
                                    />
                                  )}
                                </Card>
                              </Col>
                              <Col xs={24} lg={12}>
                                <Card className="battletoads-card" size="small" title="Витрина ТС Алгофонда (approved)">
                                  {algofundStorefrontSystems.length === 0 ? (
                                    <Empty description="Пока нет опубликованной ТС Алгофонда на витрине" />
                                  ) : (
                                    <List
                                      dataSource={algofundStorefrontSystems}
                                      renderItem={(item) => (
                                        <List.Item
                                          actions={[
                                            <Button key="review" size="small" onClick={() => openAdminReviewContext('algofund-ts')}>Review</Button>,
                                            <Button
                                              key="apply"
                                              size="small"
                                              disabled={!item.runtimeSystemId || batchTenantIds.length === 0}
                                              loading={actionLoading === 'apply-published-admin-ts'}
                                              onClick={() => void applyPublishedAdminTsToSelectedClients()}
                                            >
                                              Apply ({batchTenantIds.length})
                                            </Button>,
                                          ]}
                                        >
                                          <List.Item.Meta
                                            title={
                                              <Space wrap>
                                                <Text strong>{item.systemName}</Text>
                                                {item.runtimeSystemId ? <Tag color="geekblue">system #{item.runtimeSystemId}</Tag> : null}
                                                <Tag color="processing">clients {item.tenantCount}</Tag>
                                                <Tag color="success">active {item.activeCount}</Tag>
                                                {item.pendingCount > 0 ? <Tag color="warning">pending {item.pendingCount}</Tag> : null}
                                              </Space>
                                            }
                                            description={item.tenants.length > 0 ? item.tenants.map((tenant) => tenant.tenant.display_name).join(', ') : 'TS опубликована, но ещё не привязана к клиентам'}
                                          />
                                        </List.Item>
                                      )}
                                    />
                                  )}
                                </Card>
                              </Col>
                            </Row>
                          </Card>

                          {performanceReport ? (
                            <Card className="battletoads-card" title={`Performance report (${performanceReport.period})`}>
                              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                <Text type="secondary">Generated: {performanceReport.generatedAt}</Text>
                                <Alert
                                  type="info"
                                  showIcon
                                  message="Где аналитика: ниже два блока. 1) TS runtime-аналитика (equity/pnl/dd/левередж). 2) Offer-аналитика с сопоставлением live vs backtest (samples, lag, pnl delta, win-rate delta)."
                                />
                                <Table
                                  size="small"
                                  rowKey={(row) => `${row.apiKeyName}:${row.id}`}
                                  dataSource={performanceReport.tradingSystems || []}
                                  pagination={{ pageSize: 8, showSizeChanger: false }}
                                  scroll={{ x: 1200 }}
                                  columns={[
                                    {
                                      title: 'TS',
                                      key: 'ts',
                                      render: (_, row: any) => (
                                        <Space direction="vertical" size={0}>
                                          <Text strong>{row.name}</Text>
                                          <Text type="secondary">{row.apiKeyName} • #{row.id}</Text>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Status',
                                      key: 'status',
                                      render: (_, row: any) => row.isActive ? <Tag color="success">active</Tag> : <Tag color="default">inactive</Tag>,
                                    },
                                    {
                                      title: 'Runtime metrics',
                                      key: 'runtime',
                                      render: (_, row: any) => (
                                        <Space wrap>
                                          <Tag color="blue">Eq {formatMoney(row.equityUsd)}</Tag>
                                          <Tag color={metricColor(Number(row.unrealizedPnl || 0), 'return')}>PnL {formatMoney(row.unrealizedPnl)}</Tag>
                                          <Tag color={metricColor(Number(row.drawdownPercent || 0), 'drawdown')}>DD {formatPercent(row.drawdownPercent)}</Tag>
                                          <Tag color="purple">Lev {formatNumber(row.effectiveLeverage, 2)}</Tag>
                                          <Tag color="orange">Margin {formatPercent(row.marginLoadPercent)}</Tag>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Updated',
                                      dataIndex: 'updatedAt',
                                      width: 220,
                                    },
                                  ]}
                                />
                                <Table
                                  size="small"
                                  rowKey={(row) => `${row.offerId}:${row.strategyId}`}
                                  dataSource={performanceReport.offers || []}
                                  pagination={{ pageSize: 8, showSizeChanger: false }}
                                  scroll={{ x: 1200 }}
                                  columns={[
                                    {
                                      title: 'Offer',
                                      key: 'offer',
                                      render: (_, row: any) => (
                                        <Space direction="vertical" size={0}>
                                          <Text strong>{row.titleRu}</Text>
                                          <Text type="secondary">{String(row.mode || '').toUpperCase()} • {row.market}</Text>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Expected',
                                      key: 'expected',
                                      render: (_, row: any) => (
                                        <Space wrap>
                                          <Tag color="default">period {Number(row.periodDays || summary?.offerStore?.defaults?.periodDays || 0)}d</Tag>
                                          <Tag>Ret {formatPercent(row.expected?.ret)}</Tag>
                                          <Tag>PF {formatNumber(row.expected?.pf)}</Tag>
                                          <Tag>DD {formatPercent(row.expected?.dd)}</Tag>
                                          <Tag>tpd {formatNumber(row.expected?.tradesPerDay, 2)}</Tag>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Live vs BT',
                                      key: 'cmp',
                                      render: (_, row: any) => row.live ? (
                                        <Space wrap>
                                          <Tag color="processing">samples {Number(row.live?.samples || 0)}</Tag>
                                          <Tag color="blue">lag {formatNumber(row.live?.entryLagSeconds, 2)}s</Tag>
                                          <Tag color={metricColor(Number(row.live?.realizedVsPredictedPnlPercent || 0), 'return')}>pnlΔ {formatPercent(row.live?.realizedVsPredictedPnlPercent)}</Tag>
                                          <Tag color={metricColor(Number(row.comparison?.winRateDeltaPercent || 0), 'return')}>wrΔ {formatNumber(row.comparison?.winRateDeltaPercent, 2)}pp</Tag>
                                        </Space>
                                      ) : <Tag color="default">no live data</Tag>,
                                    },
                                  ]}
                                />
                              </Space>
                            </Card>
                          ) : null}

                          {summary?.sweepSummary?.portfolioFull ? (
                            <Row gutter={[16, 16]}>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.returnLabel} value={Number(summary.sweepSummary.portfolioFull.summary?.totalReturnPercent || 0)} precision={2} suffix="%" /></Card></Col>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.drawdown} value={Number(summary.sweepSummary.portfolioFull.summary?.maxDrawdownPercent || 0)} precision={2} suffix="%" /></Card></Col>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.profitFactor} value={Number(summary.sweepSummary.portfolioFull.summary?.profitFactor || 0)} precision={2} /></Card></Col>
                              <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.trades} value={Number(summary.sweepSummary.portfolioFull.summary?.tradesCount || 0)} precision={0} /></Card></Col>
                            </Row>
                          ) : null}

                          {publishResponse?.preview ? (
                            <Card className="battletoads-card" title={copy.publishedTsPreview}>
                              <Row gutter={[16, 16]}>
                                <Col xs={24} lg={8}>
                                  <Descriptions column={1} size="small" bordered>
                                    <Descriptions.Item label={copy.sourceSystem}>{publishResponse.sourceSystem?.systemName || '—'}</Descriptions.Item>
                                    <Descriptions.Item label={copy.apiKey}>{publishResponse.sourceSystem?.apiKeyName || '—'}</Descriptions.Item>
                                    <Descriptions.Item label={copy.period}>{formatPeriodLabel(publishPreviewPeriod)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.finalEquity}>{formatMoney(publishResponse.preview.summary?.finalEquity ?? publishPreviewDerivedSummary?.finalEquity)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.returnLabel}>{formatPercent(publishResponse.preview.summary?.totalReturnPercent ?? publishPreviewDerivedSummary?.totalReturnPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.drawdown}>{formatPercent(publishResponse.preview.summary?.maxDrawdownPercent ?? publishPreviewDerivedSummary?.maxDrawdownPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.profitFactor}>{formatNumber(publishResponse.preview.summary?.profitFactor)}</Descriptions.Item>
                                  </Descriptions>
                                </Col>
                                <Col xs={24} lg={16}>
                                  {publishPreviewPoints.length > 0 ? <ChartComponent data={publishPreviewPoints} type="line" /> : <Empty description={copy.noCatalog} />}
                                </Col>
                              </Row>
                            </Card>
                          ) : null}
                        </Space>
                      ),
                    },
                    {
                      key: 'research-analysis',
                      label: 'Анализ ресерча',
                      children: (
                        <Space direction="vertical" size={16} style={{ width: '100%' }}>
                          <Row gutter={[16, 16]}>
                            <Col xs={24}>
                              <Card
                                className="battletoads-card"
                                title="Backtest requests"
                                extra={<Button size="small" href="/research">Research</Button>}
                              >
                                <Space>
                                  <Tag color="processing">pending: {Number(summary?.backtestPairRequests?.pending || 0)}</Tag>
                                  <Tag>total: {Number(summary?.backtestPairRequests?.total || 0)}</Tag>
                                  <Button size="small" loading={actionLoading === 'load-sweep-review'} onClick={() => void loadSweepReviewCandidates()}>
                                    Загрузить оферы и ТС из sweep
                                  </Button>
                                  <Button
                                    size="small"
                                    onClick={() => {
                                      setSelectedAdminReviewKind('algofund-ts');
                                      setAdminTab('offer-ts');
                                    }}
                                  >
                                    Открыть в Оферы и ТС (sweep backtest)
                                  </Button>
                                </Space>
                                <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                                  Очередь запросов на бэктест и переход в Research для запуска sweep.
                                </Paragraph>
                              </Card>
                            </Col>
                          </Row>

                          <Card className="battletoads-card" title="Approval center: оферы клиентов стратегий и ТС Алгофонда">
                            <Paragraph type="secondary" style={{ marginTop: 0 }}>
                              После sweep настраивай параметры, проверяй метрики/equity и апрувь кандидатов. Далее в Оферы и ТС остаются только approved-витрины и управление флагами.
                            </Paragraph>
                            <Space wrap style={{ marginBottom: 12 }}>
                              <Tag color="default">sweep offers: {reviewableSweepOffers.length}</Tag>
                              <Tag color="processing">awaiting review: {researchCandidateOffers.length}</Tag>
                              <Tag color="blue">period: {Number(summary?.offerStore?.defaults?.periodDays || 0)}d</Tag>
                              <Tag color="geekblue">target: {Number(summary?.offerStore?.defaults?.targetTradesPerDay || 0)}/day</Tag>
                            </Space>
                            <Space wrap style={{ marginBottom: 16 }}>
                              <InputNumber
                                min={7}
                                max={365}
                                value={Number(summary?.offerStore?.defaults?.periodDays || 90)}
                                onChange={(value) => {
                                  const numeric = Number(value || 90);
                                  void updateOfferStoreDefaults({ periodDays: Math.max(7, Math.min(365, Math.floor(numeric))) });
                                }}
                                addonBefore="Period d"
                              />
                              <InputNumber
                                min={1}
                                max={20}
                                step={0.5}
                                value={Number(summary?.offerStore?.defaults?.targetTradesPerDay || 6)}
                                onChange={(value) => {
                                  const numeric = Number(value || 6);
                                  void updateOfferStoreDefaults({ targetTradesPerDay: Math.max(1, Math.min(20, numeric)) });
                                }}
                                addonBefore="Target/day"
                              />
                              <InputNumber
                                min={0.5}
                                max={5}
                                step={0.05}
                                value={approvalMinProfitFactor}
                                onChange={(value) => {
                                  const numeric = Number(value || 1);
                                  setApprovalMinProfitFactor(Math.max(0.5, Math.min(5, Number(numeric.toFixed(2)))));
                                }}
                                addonBefore="Min PF"
                              />
                              <Button
                                size="small"
                                onClick={() => {
                                  setSelectedAdminReviewKind('algofund-ts');
                                  setAdminTab('offer-ts');
                                }}
                              >
                                Перейти в review ТС
                              </Button>
                              <Button
                                size="small"
                                onClick={() => {
                                  void openPublishedAdminTsForClients();
                                }}
                              >
                                Применение ТС к клиентам
                              </Button>
                            </Space>
                            <Table
                              size="small"
                              rowKey="offerId"
                              dataSource={reviewableSweepOffers}
                              pagination={{ pageSize: 8, showSizeChanger: false }}
                              scroll={{ x: 980 }}
                              expandable={{
                                expandedRowRender: (row: any) => {
                                  const pts: number[] = Array.isArray(row.equityPoints) ? row.equityPoints : [];
                                  return (
                                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                      <Descriptions size="small" bordered column={3}>
                                        <Descriptions.Item label="Score">{formatNumber(row.score)}</Descriptions.Item>
                                        <Descriptions.Item label="PF">{formatNumber(row.pf)}</Descriptions.Item>
                                        <Descriptions.Item label="Trades/day">{formatNumber(row.tradesPerDay, 2)}</Descriptions.Item>
                                        <Descriptions.Item label="Ret">{formatPercent(row.ret)}</Descriptions.Item>
                                        <Descriptions.Item label="DD">{formatPercent(row.dd)}</Descriptions.Item>
                                        <Descriptions.Item label="Win rate">{formatPercent(row.wr)}</Descriptions.Item>
                                      </Descriptions>
                                      <Space wrap>
                                        <Button
                                          size="small"
                                          type="primary"
                                          onClick={() => {
                                            setSelectedAdminReviewKind('offer');
                                            setSelectedAdminReviewOfferId(String(row.offerId));
                                            setAdminTab('offer-ts');
                                          }}
                                        >
                                          Открыть review офера
                                        </Button>
                                        <Button
                                          size="small"
                                          onClick={() => {
                                            if (row.published) {
                                              void openUnpublishWizard(String(row.offerId));
                                              return;
                                            }
                                            void toggleOfferPublished(String(row.offerId), true);
                                          }}
                                        >
                                          {row.published ? 'Снять с витрины' : 'Отправить на апрув'}
                                        </Button>
                                      </Space>
                                      {pts.length > 0
                                        ? <ChartComponent data={pts.map((v, i) => ({ time: i, equity: v }))} type="line" />
                                        : <Text type="secondary">Equity curve unavailable</Text>}
                                    </Space>
                                  );
                                },
                                rowExpandable: () => true,
                              }}
                              columns={[
                                {
                                  title: 'Карточка',
                                  key: 'offer',
                                  render: (_, row: any) => (
                                    <Space direction="vertical" size={0}>
                                      <Text strong>{row.titleRu}</Text>
                                      <Text type="secondary">{String(row.mode || '').toUpperCase()} • {row.market}</Text>
                                    </Space>
                                  ),
                                },
                                {
                                  title: 'Период и метрики',
                                  key: 'metrics',
                                  render: (_, row: any) => (
                                    <Space size={4} wrap>
                                      <Tag color="default">period {Number(row.periodDays || 0)}d</Tag>
                                      <Tag color={metricColor(Number(row.ret || 0), 'return')}>Ret {formatPercent(row.ret)}</Tag>
                                      <Tag color={metricColor(Number(row.dd || 0), 'drawdown')}>DD {formatPercent(row.dd)}</Tag>
                                      <Tag color={metricColor(Number(row.pf || 0), 'pf')}>PF {formatNumber(row.pf)}</Tag>
                                      <Tag color="blue">tpd {formatNumber(row.tradesPerDay, 2)}</Tag>
                                    </Space>
                                  ),
                                },
                                {
                                  title: 'Витрина',
                                  key: 'store',
                                  width: 280,
                                  render: (_, row: any) => (
                                    <Space size={4} wrap>
                                      <Tag color={row.published ? 'success' : 'processing'}>{row.published ? 'approved' : 'pending review'}</Tag>
                                      <Button
                                        size="small"
                                        onClick={() => {
                                          setSelectedAdminReviewKind('offer');
                                          setSelectedAdminReviewOfferId(String(row.offerId));
                                          setAdminTab('offer-ts');
                                        }}
                                      >
                                        Открыть в Оферы и ТС
                                      </Button>
                                      <Switch
                                        checked={Boolean(row.published)}
                                        loading={actionLoading === `offer-store:${String(row.offerId)}`}
                                        onChange={(checked) => {
                                          if (checked) {
                                            void toggleOfferPublished(String(row.offerId), true);
                                          } else {
                                            void openUnpublishWizard(String(row.offerId));
                                          }
                                        }}
                                      />
                                    </Space>
                                  ),
                                },
                              ]}
                            />
                          </Card>

                          <Card className="battletoads-card" title="ТС Алгофонда из последнего sweep">
                            <Paragraph type="secondary" style={{ marginTop: 0 }}>
                              Это текущий draft торговой системы, собранный из последнего sweep. Здесь должен быть полный путь: проверить состав и метрики, перейти в review, отправить ТС на апрув, затем открыть шаг применения и перевести клиентов Алгофонда на опубликованную runtime ТС.
                            </Paragraph>
                            <Alert
                              type="info"
                              showIcon
                              style={{ marginBottom: 12 }}
                              message="Шаги: 1) review состава и метрик, 2) апрув draft ТС, 3) публикация на витрину Алгофонда, 4) switch_system на выбранных клиентов."
                            />
                            <Space wrap style={{ marginBottom: 12 }}>
                              <Tag color="processing">members: {Number(adminTradingSystemDraft?.members?.length || 0)}</Tag>
                              <Tag color="blue">{adminTradingSystemDraft?.name || 'Admin TS draft'}</Tag>
                              <Tag color="gold">pending review</Tag>
                              {summary?.sweepSummary?.period ? <Tag color="default">{formatPeriodLabel(summary.sweepSummary.period)}</Tag> : null}
                              {adminDraftPortfolioSummary ? <Tag color={metricColor(Number(adminDraftPortfolioSummary.totalReturnPercent || 0), 'return')}>Ret {formatPercent(adminDraftPortfolioSummary.totalReturnPercent)}</Tag> : null}
                              {adminDraftPortfolioSummary ? <Tag color={metricColor(Number(adminDraftPortfolioSummary.maxDrawdownPercent || 0), 'drawdown')}>DD {formatPercent(adminDraftPortfolioSummary.maxDrawdownPercent)}</Tag> : null}
                              {adminDraftPortfolioSummary ? <Tag color={metricColor(Number(adminDraftPortfolioSummary.profitFactor || 0), 'pf')}>PF {formatNumber(adminDraftPortfolioSummary.profitFactor)}</Tag> : null}
                              {adminDraftTradesPerDay !== null ? <Tag color="blue">tpd {formatNumber(adminDraftTradesPerDay, 2)}</Tag> : null}
                            </Space>
                            {summary?.sweepSummary?.portfolioFull?.error ? (
                              <Alert
                                type="warning"
                                showIcon
                                style={{ marginBottom: 12 }}
                                message={`Portfolio backtest error: ${summary.sweepSummary.portfolioFull.error}`}
                              />
                            ) : null}
                            {adminDraftPortfolioSummary ? (
                              <Descriptions size="small" bordered column={2} style={{ marginBottom: 12 }}>
                                <Descriptions.Item label="Статус">Черновик из sweep</Descriptions.Item>
                                <Descriptions.Item label="Источник">full_range portfolio backtest</Descriptions.Item>
                                <Descriptions.Item label="Final equity">{formatMoney(adminDraftPortfolioSummary.finalEquity)}</Descriptions.Item>
                                <Descriptions.Item label="Сделок">{formatNumber(adminDraftPortfolioSummary.tradesCount, 0)}</Descriptions.Item>
                              </Descriptions>
                            ) : (
                              <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
                                Метрики портфеля еще не доступны. Ниже все равно показан состав draft ТС из последнего sweep.
                              </Paragraph>
                            )}
                            <List
                              dataSource={adminTradingSystemDraft?.members || []}
                              locale={{ emptyText: <Empty description="Недавний sweep еще не сформировал draft ТС" /> }}
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
                                  </Space>
                                </List.Item>
                              )}
                            />
                            <Space wrap style={{ marginTop: 12 }}>
                              <Button size="small" loading={actionLoading === 'load-sweep-review'} onClick={() => void loadSweepReviewCandidates()}>
                                Обновить из sweep
                              </Button>
                              <Button size="small" onClick={() => setAdminTab('research-analysis')}>
                                Открыть sweep/backtest
                              </Button>
                              <Button
                                type="primary"
                                size="small"
                                onClick={() => {
                                  setSelectedAdminReviewKind('algofund-ts');
                                  setAdminTab('offer-ts');
                                }}
                              >
                                Открыть review ТС
                              </Button>
                              <Button size="small" loading={actionLoading === 'publish'} onClick={() => void publishAdminTs()}>
                                Отправить ТС на апрув
                              </Button>
                              <Button
                                size="small"
                                onClick={() => {
                                  void openPublishedAdminTsForClients();
                                }}
                              >
                                Применение к клиентам
                              </Button>
                              <Button size="small" onClick={openPublishedAdminTsEditor}>
                                Редактировать ТС
                              </Button>
                              <Button size="small" onClick={openBacktestDrawerForAdminTs}>
                                Backtest ТС (в окне)
                              </Button>
                            </Space>
                          </Card>

                          <Card className="battletoads-card" title="Отчёты и аналитика">
                            <Space direction="vertical" style={{ width: '100%' }}>
                              <Space wrap>
                                <Select
                                  value={reportPeriod}
                                  style={{ width: 140 }}
                                  options={[
                                    { value: 'daily', label: 'daily' },
                                    { value: 'weekly', label: 'weekly' },
                                    { value: 'monthly', label: 'monthly' },
                                  ]}
                                  onChange={(value) => setReportPeriod(value)}
                                />
                                <Button loading={performanceReportLoading} onClick={() => void loadPerformanceReport(reportPeriod)}>Обновить отчёт</Button>
                                <Button
                                  loading={sendTelegramLoading}
                                  disabled={!telegramControls?.tokenConfigured || !telegramControls?.chatConfigured}
                                  onClick={() => void sendReportToTelegram()}
                                >
                                  Отправить в Telegram
                                </Button>
                              </Space>
                              <Space wrap>
                                <Tag color="blue">TS: {Number(performanceReport?.tradingSystems?.length || 0)}</Tag>
                                <Tag color="geekblue">Offers: {Number(performanceReport?.offers?.length || 0)}</Tag>
                                {performanceReport ? <Tag color="default">{performanceReport.generatedAt.slice(0, 16).replace('T', ' ')}</Tag> : null}
                              </Space>
                            </Space>
                          </Card>
                        </Space>
                      ),
                    },
                    {
                      key: 'clients',
                      label: 'Клиенты',
                      children: (
                        <Space direction="vertical" size={16} style={{ width: '100%' }}>
                          <Card className="battletoads-card" title={copy.requestQueue}>
                            <Space wrap>
                              <Tag color="processing">pending: {Number(summary?.algofundRequestQueue?.pending || 0)}</Tag>
                              <Tag color="success">approved: {Number(summary?.algofundRequestQueue?.approved || 0)}</Tag>
                              <Tag color="default">rejected: {Number(summary?.algofundRequestQueue?.rejected || 0)}</Tag>
                              <Tag>total: {Number(summary?.algofundRequestQueue?.total || 0)}</Tag>
                            </Space>
                            <div style={{ marginTop: 12 }}>
                              <Table
                                rowKey="id"
                                columns={requestColumns}
                                dataSource={summary?.algofundRequestQueue?.items || []}
                                pagination={{ pageSize: 8, showSizeChanger: false }}
                                scroll={{ x: 960 }}
                              />
                            </div>
                          </Card>

                          <Card className="battletoads-card" title={copy.connectedTenants} extra={<Button type="primary" onClick={() => setAdminTab('create-user')}>{copy.createClient}</Button>}>
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
                              <Table
                                rowKey={(row) => row.tenant.id}
                                columns={tenantColumns}
                                dataSource={filteredClients}
                                pagination={{ pageSize: 10, showSizeChanger: false }}
                                scroll={{ x: 1100 }}
                                rowSelection={{
                                  selectedRowKeys: batchTenantIds,
                                  onChange: (keys) => {
                                    const next = Array.from(new Set((keys || []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)));
                                    setBatchTenantIds(next);
                                  },
                                  getCheckboxProps: (row) => ({
                                    disabled: row.tenant.product_mode !== 'algofund_client',
                                  }),
                                }}
                              />
                            </Space>
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
                                />
                              </Card>
                            </Col>
                          </Row>
                        </Space>
                      ),
                    },
                    {
                      key: 'monitoring',
                      label: 'Мониторинг',
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
                              </Space>
                              <Divider style={{ margin: '6px 0' }} />
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
                                ]}
                              />
                              <Button onClick={() => void loadMonitoringTabData()} loading={monitoringTabLoading}>Обновить список систем</Button>
                              <Button onClick={() => void loadLowLotRecommendations()} loading={lowLotLoading}>Обновить low-lot</Button>
                              <Button onClick={() => void loadTelegramControls()} loading={telegramControlsLoading}>Обновить Telegram controls</Button>
                            </Space>

                            <Row gutter={[16, 16]}>
                              <Col xs={24} xl={10}>
                                <Card size="small" className="battletoads-card" title="Pending algofund requests">
                                  <Space wrap>
                                    <Tag color="processing">pending: {pendingAlgofundRequests.length}</Tag>
                                    <Tag>clients: {Object.keys(pendingAlgofundRequestsByTenant).length}</Tag>
                                  </Space>
                                  <div style={{ marginTop: 12 }}>
                                    <Table
                                      size="small"
                                      rowKey="id"
                                      columns={requestColumns}
                                      dataSource={pendingAlgofundRequests}
                                      pagination={{ pageSize: 4, showSizeChanger: false }}
                                      scroll={{ x: 760 }}
                                    />
                                  </div>
                                </Card>
                              </Col>
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
                                    <Space wrap>
                                      <Tag color={telegramControls?.tokenConfigured ? 'success' : 'default'}>token {telegramControls?.tokenConfigured ? 'ok' : 'missing'}</Tag>
                                      <Tag color={telegramControls?.chatConfigured ? 'success' : 'default'}>chat_id {telegramControls?.chatConfigured ? 'ok' : 'missing'}</Tag>
                                    </Space>
                                  </Space>
                                </Card>
                              </Col>

                              <Col xs={24} xl={14}>
                                <Card size="small" className="battletoads-card" title="Low-lot recommendations (72h)">
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

                            <Table
                              rowKey={(row) => row.tenant.id}
                              columns={monitoringColumns}
                              dataSource={monitoringRows}
                              pagination={{ pageSize: 8 }}
                              scroll={{ x: 1500 }}
                              loading={monitoringTabLoading && monitoringRows.length === 0}
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
                              <Select style={{ width: '100%', marginTop: 4 }} value={createTenantProductMode} onChange={setCreateTenantProductMode} options={[{ value: 'strategy_client', label: copy.strategyClient }, { value: 'algofund_client', label: copy.algofund }]} />
                            </div>
                            <div>
                              <Text strong>{copy.plan} *</Text>
                              <Select style={{ width: '100%', marginTop: 4 }} value={createTenantPlanCode || undefined} onChange={(v) => setCreateTenantPlanCode(v || '')} options={(summary?.plans || []).filter((p) => p.product_mode === createTenantProductMode).map((p) => ({ value: p.code, label: p.title }))} />
                            </div>
                            <div>
                              <Text strong>{copy.apiKey}</Text>
                              <Select allowClear style={{ width: '100%', marginTop: 4 }} value={createTenantApiKey || undefined} onChange={(v) => setCreateTenantApiKey(v || '')} options={apiKeyOptions} />
                            </div>
                            <div>
                              <Text strong>Email</Text>
                              <Input type="email" style={{ marginTop: 4 }} value={createTenantEmail} onChange={(e) => setCreateTenantEmail(e.target.value)} placeholder="client@example.com" />
                            </div>
                            <Space>
                              <Button type="primary" onClick={() => void createTenantAdmin()} loading={actionLoading === 'createTenant'}>{copy.createClient}</Button>
                              <Button onClick={() => setAdminTab('offer-ts')}>Назад к оферам и ТС</Button>
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
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                              <Alert
                                type="info"
                                showIcon
                                message="Здесь для admin показывается витрина карточек. Кабинет клиента перенесен в Админ → Оферы и ТС."
                              />
                              {publishedStorefrontOffers.length === 0 ? (
                                <Empty description="Витрина оферов пока пустая: сначала апрувни карточки в Админ → Оферы и ТС" />
                              ) : (
                                <Table
                                  size="small"
                                  rowKey="offerId"
                                  dataSource={publishedStorefrontOffers}
                                  pagination={{ pageSize: 8, showSizeChanger: false }}
                                  scroll={{ x: 900 }}
                                  columns={[
                                    {
                                      title: 'Карточка',
                                      key: 'offer',
                                      render: (_, row: any) => (
                                        <Space direction="vertical" size={0}>
                                          <Text strong>{row.titleRu}</Text>
                                          <Text type="secondary">{String(row.mode || '').toUpperCase()} • {row.market}</Text>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Период/метрики',
                                      key: 'metrics',
                                      render: (_, row: any) => (
                                        <Space size={4} wrap>
                                          <Tag color="default">{Number(row.periodDays || 0)}d</Tag>
                                          <Tag color={metricColor(Number(row.ret || 0), 'return')}>Ret {formatPercent(row.ret)}</Tag>
                                          <Tag color={metricColor(Number(row.dd || 0), 'drawdown')}>DD {formatPercent(row.dd)}</Tag>
                                          <Tag color={metricColor(Number(row.pf || 0), 'pf')}>PF {formatNumber(row.pf)}</Tag>
                                        </Space>
                                      ),
                                    },
                                    {
                                      title: 'Действия',
                                      key: 'actions',
                                      width: 280,
                                      render: (_, row: any) => (
                                        <Space size={4} wrap>
                                          <Button size="small" onClick={() => { setActiveTab('admin'); setAdminTab('offer-ts'); }}>Редактировать</Button>
                                          <Button size="small" onClick={() => openAdminReviewContext('offer', String(row.offerId))}>Бэктест</Button>
                                          <Tag color="success">на витрине</Tag>
                                        </Space>
                                      ),
                                    },
                                  ]}
                                />
                              )}
                            </Space>
                          ) : (
                            <>
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
                                <div style={{ marginTop: 8 }}><Text>{strategyApiKeyName || '—'}</Text></div>
                              )}
                            </Col>
                            <Col xs={24} md={isAdminSurface ? 6 : 8}>
                              <Text strong>{copy.plan}</Text>
                              {isAdminSurface ? (
                                <Select style={{ width: '100%', marginTop: 8 }} value={strategyTenantPlanCode || undefined} onChange={setStrategyTenantPlanCode} options={strategyPlanOptions} />
                              ) : (
                                <div style={{ marginTop: 8 }}><Text>{strategyState.plan ? `${strategyState.plan.title} • ${formatMoney(strategyState.plan.price_usdt)}` : '—'}</Text></div>
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
                            <Button size="small" onClick={openSaasBacktestFlow} disabled={!strategyBacktestEnabled}>{copy.openBacktest}</Button>
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
                              {strategyMagicLink ? (
                                <Alert
                                  style={{ marginTop: 8 }}
                                  type="info"
                                  showIcon
                                  message={copy.magicLinkReady}
                                  description={
                                    <>
                                      <div><a href={strategyMagicLink.loginUrl} target="_blank" rel="noreferrer">{strategyMagicLink.loginUrl}</a></div>
                                      <div>{copy.magicLinkExpires}: {new Date(strategyMagicLink.expiresAt).toLocaleString()}</div>
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
                        <Card className="battletoads-card" title="Custom TS profiles">
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Space wrap>
                              <Tag color="blue">Profiles: {strategySystemProfiles.length}</Tag>
                              {strategyState?.constraints?.limits?.maxCustomSystems !== null && strategyState?.constraints?.limits?.maxCustomSystems !== undefined ? (
                                <Tag color="purple">Plan cap: {strategyState?.constraints?.limits?.maxCustomSystems}</Tag>
                              ) : null}
                              {activeStrategySystemProfile ? <Tag color="success">Active: {activeStrategySystemProfile.profileName}</Tag> : null}
                            </Space>
                            <Row gutter={[12, 12]}>
                              <Col xs={24} lg={12}>
                                <Text strong>Active profile</Text>
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
                                    label: `${item.profileName}${item.isActive ? ' [active]' : ''}`,
                                  }))}
                                />
                              </Col>
                              <Col xs={24} lg={7}>
                                <Text strong>New profile name</Text>
                                <Input
                                  style={{ marginTop: 8 }}
                                  value={strategyNewProfileName}
                                  onChange={(event) => setStrategyNewProfileName(event.target.value)}
                                  placeholder={`Custom TS ${strategySystemProfiles.length + 1}`}
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
                                  Create
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
                                      title: 'Delete custom TS profile?',
                                      content: 'Selected profile will be removed. Active profile cannot be deleted.',
                                      okText: 'Delete',
                                      okType: 'danger',
                                      cancelText: 'Cancel',
                                      onOk: async () => {
                                        await deleteStrategySystemProfile();
                                      },
                                    });
                                  }}
                                >
                                  Delete
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
                                  title: 'Profile',
                                  key: 'profileName',
                                  render: (_, row: any) => (
                                    <Space>
                                      <Text strong>{row.profileName}</Text>
                                      {row.isActive ? <Tag color="success">active</Tag> : <Tag color="default">inactive</Tag>}
                                    </Space>
                                  ),
                                },
                                {
                                  title: 'Offers',
                                  key: 'offers',
                                  render: (_, row: any) => Array.isArray(row.selectedOfferIds) ? row.selectedOfferIds.length : 0,
                                  width: 100,
                                },
                                {
                                  title: 'Updated',
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

                        <Card className="battletoads-card" title="Builder constraints">
                          <Row gutter={[12, 12]}>
                            <Col xs={24} md={6}>
                              <Statistic
                                title="Selected"
                                value={`${strategyDraftConstraints.usage?.selected ?? 0}${strategyDraftConstraints.limits?.maxOffersPerSystem !== null && strategyDraftConstraints.limits?.maxOffersPerSystem !== undefined ? ` / ${strategyDraftConstraints.limits?.maxOffersPerSystem}` : strategyDraftConstraints.limits?.maxStrategies !== null && strategyDraftConstraints.limits?.maxStrategies !== undefined ? ` / ${strategyDraftConstraints.limits?.maxStrategies}` : ''}`}
                              />
                            </Col>
                            <Col xs={24} md={6}>
                              <Statistic title="Mono / Synth" value={`${strategyDraftConstraints.usage?.mono ?? 0} / ${strategyDraftConstraints.usage?.synth ?? 0}`} />
                            </Col>
                            <Col xs={24} md={6}>
                              <Statistic title="Markets" value={strategyDraftConstraints.usage?.uniqueMarkets ?? 0} />
                            </Col>
                            <Col xs={24} md={6}>
                              <Statistic title="Deposit per TS" value={strategyDraftConstraints.usage?.estimatedDepositPerStrategy ?? 0} precision={2} suffix="USDT" />
                            </Col>
                          </Row>
                          <Space wrap style={{ marginTop: 12 }}>
                            {strategyDraftConstraints.usage?.remainingSlots !== null && strategyDraftConstraints.usage?.remainingSlots !== undefined ? <Tag color="blue">Remaining slots: {strategyDraftConstraints.usage?.remainingSlots}</Tag> : null}
                            {strategyDraftConstraints.limits?.minOffersPerSystem !== null && strategyDraftConstraints.limits?.minOffersPerSystem !== undefined ? <Tag color="purple">Min offers per TS: {strategyDraftConstraints.limits?.minOffersPerSystem}</Tag> : null}
                            {strategyDraftConstraints.limits?.maxOffersPerSystem !== null && strategyDraftConstraints.limits?.maxOffersPerSystem !== undefined ? <Tag color="purple">Max offers per TS: {strategyDraftConstraints.limits?.maxOffersPerSystem}</Tag> : null}
                            {strategyDraftConstraints.limits?.maxCustomSystems !== null && strategyDraftConstraints.limits?.maxCustomSystems !== undefined ? <Tag color="cyan">Custom TS cap: {strategyDraftConstraints.limits?.maxCustomSystems}</Tag> : null}
                            {strategyDraftConstraints.limits?.mono !== null && strategyDraftConstraints.limits?.mono !== undefined ? <Tag color="green">Mono cap: {strategyDraftConstraints.limits?.mono}</Tag> : null}
                            {strategyDraftConstraints.limits?.synth !== null && strategyDraftConstraints.limits?.synth !== undefined ? <Tag color="geekblue">Synth cap: {strategyDraftConstraints.limits?.synth}</Tag> : null}
                            {strategyDraftConstraints.limits?.depositCap !== null && strategyDraftConstraints.limits?.depositCap !== undefined ? <Tag color="gold">Deposit cap: {formatMoney(strategyDraftConstraints.limits?.depositCap)}</Tag> : null}
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

                        <Card
                          className="battletoads-card"
                          title={copy.selectedOffersPreview}
                          extra={strategySelectionPreviewLoading ? <Tag color="processing">{copy.previewRefreshing}</Tag> : null}
                        >
                          <Spin spinning={strategySelectionPreviewLoading}>
                            {strategySelectionPreview && strategySelectionPreviewOffers.length > 0 ? (
                              <Row gutter={[16, 16]}>
                                <Col xs={24} lg={8}>
                                  <Descriptions column={1} size="small" bordered>
                                    <Descriptions.Item label="Offers">{strategySelectionPreviewOffers.length}</Descriptions.Item>
                                    <Descriptions.Item label={copy.period}>{formatPeriodLabel(strategySelectionPreviewPeriod)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.finalEquity}>{formatMoney((strategySelectionPreviewSummary as any)?.finalEquity ?? strategySelectionPreviewDerivedSummary?.finalEquity)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.returnLabel}>{formatPercent((strategySelectionPreviewSummary as any)?.totalReturnPercent ?? strategySelectionPreviewDerivedSummary?.totalReturnPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.drawdown}>{formatPercent((strategySelectionPreviewSummary as any)?.maxDrawdownPercent ?? strategySelectionPreviewDerivedSummary?.maxDrawdownPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.profitFactor}>{formatNumber((strategySelectionPreviewSummary as any)?.profitFactor)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.trades}>{formatNumber((strategySelectionPreviewSummary as any)?.tradesCount, 0)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.persistedBucket}>{strategySelectionPreview.controls?.riskLevel || strategyPersistedRiskBucket} / {strategySelectionPreview.controls?.tradeFrequencyLevel || strategyPersistedTradeBucket}</Descriptions.Item>
                                  </Descriptions>
                                </Col>
                                <Col xs={24} lg={16}>
                                  <Space wrap style={{ marginBottom: 12 }}>
                                    {strategySelectionPreviewOffers.map((item) => (
                                      <Tag key={item.offerId} color={item.mode === 'mono' ? 'green' : 'blue'}>
                                        {item.market} • {formatNumber(item.score)}
                                      </Tag>
                                    ))}
                                  </Space>
                                  {strategySelectionPreviewPoints.length > 0 ? <ChartComponent data={strategySelectionPreviewPoints} type="line" /> : <Empty description={copy.selectedOffersPreview} />}
                                </Col>
                              </Row>
                            ) : (
                              <Empty description={copy.selectedOffersPreview} />
                            )}
                          </Spin>
                        </Card>

                        <Card className="battletoads-card" title={copy.previewTitle} extra={strategyPreviewLoading ? <Tag color="processing">{copy.previewRefreshing}</Tag> : null}>
                          <Row gutter={[16, 16]} align="middle">
                            <Col xs={24} md={10}>
                              <Text strong>{copy.chooseOffer}</Text>
                              <Select
                                style={{ width: '100%', marginTop: 8 }}
                                value={strategyPreviewOfferId || undefined}
                                onChange={setStrategyPreviewOfferId}
                                options={strategyOfferCatalog.map((offer) => ({ value: offer.offerId, label: `${offer.titleRu} • ${offer.strategy.market}` }))}
                              />
                            </Col>
                            <Col xs={24} md={14}>
                              <Space wrap style={{ marginTop: 28 }}>
                                <Button type="primary" onClick={() => void runStrategyPreview()} loading={strategyPreviewLoading}>{copy.preview}</Button>
                                {strategyState.profile?.actual_enabled ? <Tag color="success">live enabled</Tag> : <Tag color="default">live disabled</Tag>}
                                {strategyState.profile?.requested_enabled ? <Tag color="processing">requested active</Tag> : null}
                              </Space>
                            </Col>
                          </Row>

                          <Spin spinning={strategyPreviewLoading}>
                            {strategyPreview ? (
                              <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
                                <Col xs={24} lg={8}>
                                  <Descriptions column={1} size="small" bordered>
                                    <Descriptions.Item label="Offer">{strategyPreviewOffer?.titleRu || '—'}</Descriptions.Item>
                                    <Descriptions.Item label={copy.period}>{formatPeriodLabel(strategyPreviewPeriod)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.score}>{formatNumber(strategyPreview?.preset?.score ?? strategyPreviewMetrics?.score)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.finalEquity}>{formatMoney((strategyPreviewSummary as any)?.finalEquity ?? strategyPreviewDerivedSummary?.finalEquity)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.returnLabel}>{formatPercent((strategyPreviewSummary as any)?.totalReturnPercent ?? strategyPreviewDerivedSummary?.totalReturnPercent ?? strategyPreviewMetrics?.ret)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.drawdown}>{formatPercent((strategyPreviewSummary as any)?.maxDrawdownPercent ?? strategyPreviewDerivedSummary?.maxDrawdownPercent ?? strategyPreviewMetrics?.dd)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.profitFactor}>{formatNumber((strategyPreviewSummary as any)?.profitFactor ?? strategyPreviewMetrics?.pf)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.trades}>{formatNumber((strategyPreviewSummary as any)?.tradesCount ?? strategyPreviewMetrics?.trades, 0)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.persistedBucket}>{strategyPreview.controls?.riskLevel || strategyPersistedRiskBucket} / {strategyPreview.controls?.tradeFrequencyLevel || strategyPersistedTradeBucket}</Descriptions.Item>
                                  </Descriptions>
                                </Col>
                                <Col xs={24} lg={16}>
                                  {strategyPreviewPoints.length > 0 ? <ChartComponent data={strategyPreviewPoints} type="line" /> : <Empty description={copy.noCatalog} />}
                                </Col>
                              </Row>
                            ) : (
                              <Empty style={{ marginTop: 16 }} description={copy.previewTitle} />
                            )}
                          </Spin>
                        </Card>

                        {materializeResponse?.strategies?.length ? (
                          <Card className="battletoads-card" title="Materialized strategies">
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
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                              <Alert
                                type="info"
                                showIcon
                                message="Здесь для admin показывается только одобренная витрина Алгофонда. Кандидаты и настройка TS находятся в Админ → Оферы и ТС."
                              />
                              <Empty description="Витрина Алгофонда сейчас пуста, пока не опубликован admin TS через Админ → Оферы и ТС" />
                              <Space wrap>
                                <Button type="primary" onClick={() => { setActiveTab('admin'); setAdminTab('offer-ts'); }}>Перейти в approval center</Button>
                                <Button onClick={() => { setActiveTab('admin'); setAdminTab('clients'); setClientsModeFilter('algofund_client'); }}>К клиентам Алгофонда</Button>
                                <Button onClick={() => { setActiveTab('admin'); setAdminTab('offer-ts'); }}>Бэктест</Button>
                              </Space>
                            </Space>
                          ) : (
                            <>
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
                                <div style={{ marginTop: 8 }}><Text>{algofundApiKeyName || '—'}</Text></div>
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
                            <Button size="small" onClick={openSaasBacktestFlow} disabled={!algofundBacktestEnabled}>{copy.openBacktest}</Button>
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
                              {algofundMagicLink ? (
                                <Alert
                                  style={{ marginTop: 8 }}
                                  type="info"
                                  showIcon
                                  message={copy.magicLinkReady}
                                  description={
                                    <>
                                      <div><a href={algofundMagicLink.loginUrl} target="_blank" rel="noreferrer">{algofundMagicLink.loginUrl}</a></div>
                                      <div>{copy.magicLinkExpires}: {new Date(algofundMagicLink.expiresAt).toLocaleString()}</div>
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
                              <Text strong>{copy.risk}: {formatNumber(algofundRiskMultiplier)}</Text>
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
                            </Col>
                            <Col xs={24} lg={8}>
                              <Space wrap style={{ marginTop: 24 }}>
                                <Button type="primary" onClick={() => void saveAlgofundProfile()} loading={actionLoading === 'algofund-save'} disabled={!algofundSettingsEnabled}>{copy.saveProfile}</Button>
                                <Button onClick={() => void refreshAlgofundPreview()}>{copy.preview}</Button>
                              </Space>
                            </Col>
                          </Row>
                          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>{copy.previewPlanCapHint}</Paragraph>
                        </Card>

                        <Card className="battletoads-card" title="Algofund TS offers">
                          {isAdminSurface ? (
                            <Alert
                              type="info"
                              showIcon
                              message="Карточки TS скрыты в admin-режиме. Sweep/backtest и подготовка кандидатов выполняются в Админ → Анализ ресерча; approved-витрины управляются в Админ → Оферы и ТС."
                            />
                          ) : Array.isArray(algofundState?.availableSystems) && algofundState.availableSystems.length > 0 ? (
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                              <Space wrap>
                                <Tag color="processing">Client can switch between published TS offers</Tag>
                                <Tag color="blue">Current engine: {algofundState.engine?.systemName || 'not materialized'}</Tag>
                                {pendingAlgofundRequestsByTenant[algofundState.tenant.id]?.length ? <Tag color="gold">Pending requests: {pendingAlgofundRequestsByTenant[algofundState.tenant.id].length}</Tag> : null}
                              </Space>
                              <List
                                grid={{ gutter: 12, xs: 1, md: 2, xl: 3 }}
                                dataSource={algofundState.availableSystems || []}
                                renderItem={(item) => (
                                  <List.Item key={item.id}>
                                    <Card size="small" bordered>
                                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                        <Text strong>{item.name}</Text>
                                        <Text type="secondary">Trading System offer #{item.id}</Text>
                                        <Space wrap>
                                          {item.isActive ? <Tag color="success">active</Tag> : <Tag color="default">inactive</Tag>}
                                          <Tag color="blue">Backtest period {formatPeriodLabel(algofundState.portfolioPassport?.period || null)}</Tag>
                                          <Tag color="geekblue">Ret {formatPercent(algofundState.portfolioPassport?.portfolioSummary?.totalReturnPercent)}</Tag>
                                          <Tag color="orange">DD {formatPercent(algofundState.portfolioPassport?.portfolioSummary?.maxDrawdownPercent)}</Tag>
                                          <Tag color="purple">PF {formatNumber(algofundState.portfolioPassport?.portfolioSummary?.profitFactor)}</Tag>
                                          {pendingSwitchSystemIds.has(Number(item.id)) ? <Tag color="gold">switch pending</Tag> : null}
                                        </Space>
                                        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                                          Для витрины показываем backtest/sweep-метрики и сравнение профиля риска. Runtime-метрики движка доступны отдельно в мониторинге.
                                        </Paragraph>
                                        <Button
                                          type="primary"
                                          size="small"
                                          disabled={Boolean(item.isActive) || pendingSwitchSystemIds.has(Number(item.id))}
                                          loading={actionLoading === 'algofund-switch_system'}
                                          onClick={() => void sendAlgofundRequest('switch_system', {
                                            targetSystemId: Number(item.id),
                                            targetSystemName: String(item.name || ''),
                                          })}
                                        >
                                          {item.isActive ? 'Current TS' : pendingSwitchSystemIds.has(Number(item.id)) ? 'Switch pending' : 'Request switch'}
                                        </Button>
                                      </Space>
                                    </Card>
                                  </List.Item>
                                )}
                              />
                            </Space>
                          ) : (
                            <Empty description="Опубликованные TS для этого API key пока не найдены." />
                          )}
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
                            <Button onClick={() => { setActiveTab('admin'); setAdminTab('clients'); setClientsModeFilter('algofund_client'); }}>{copy.openTradingSystems}</Button>
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

                        <Card className="battletoads-card" title={copy.previewTitle} extra={algofundLoading ? <Tag color="processing">{copy.previewRefreshing}</Tag> : null}>
                          <Spin spinning={algofundLoading}>
                            {
                              <Row gutter={[16, 16]}>
                                <Col xs={24} lg={8}>
                                  <Descriptions column={1} size="small" bordered>
                                    <Descriptions.Item label={copy.sourceSystem}>{algofundState.preview?.sourceSystem?.systemName || '—'}</Descriptions.Item>
                                    <Descriptions.Item label={copy.period}>{formatPeriodLabel(algofundPreviewPeriod)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.riskApplied}>
                                      <Tag color={Number(algofundState.preview?.riskMultiplier ?? 1) === 1 ? 'green' : 'blue'}>
                                        {formatNumber(algofundState.preview?.riskMultiplier ?? algofundRiskMultiplier)}x
                                      </Tag>
                                      {Number(algofundState.preview?.riskMultiplier ?? 1) === 1 ? <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>= Trading Systems baseline</span> : null}
                                    </Descriptions.Item>
                                    <Descriptions.Item label={copy.initialBalance}>{formatMoney(algofundState.preview?.summary?.initialBalance)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.finalEquity}>{formatMoney(algofundState.preview?.summary?.finalEquity ?? algofundPreviewDerivedSummary?.finalEquity)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.returnLabel}>{formatPercent(algofundState.preview?.summary?.totalReturnPercent ?? algofundPreviewDerivedSummary?.totalReturnPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.drawdown}>{formatPercent(algofundState.preview?.summary?.maxDrawdownPercent ?? algofundPreviewDerivedSummary?.maxDrawdownPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.profitFactor}>{formatNumber(algofundState.preview?.summary?.profitFactor)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.trades}>{formatNumber(algofundState.preview?.summary?.tradesCount, 0)}</Descriptions.Item>
                                  </Descriptions>
                                </Col>
                                <Col xs={24} lg={16}>
                                  {algofundPreviewPoints.length > 0 ? <ChartComponent data={algofundPreviewPoints} type="line" /> : <Empty description={copy.previewTitle} />}
                                </Col>
                              </Row>
                            }
                          </Spin>
                        </Card>

                        <Card className="battletoads-card" title="Client requests">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} lg={16}>
                              <Input.TextArea rows={3} value={algofundNote} onChange={(event) => setAlgofundNote(event.target.value)} placeholder={copy.note} />
                              <Space wrap style={{ marginTop: 12 }}>
                                <Button type="primary" onClick={() => void sendAlgofundRequest('start')} loading={actionLoading === 'algofund-start'} disabled={!algofundStartStopEnabled}>{copy.requestStart}</Button>
                                <Button danger onClick={() => void sendAlgofundRequest('stop')} loading={actionLoading === 'algofund-stop'} disabled={!algofundStartStopEnabled}>{copy.requestStop}</Button>
                                {algofundState.profile?.actual_enabled ? <Tag color="success">live enabled</Tag> : <Tag color="default">live disabled</Tag>}
                                {algofundState.profile?.requested_enabled ? <Tag color="processing">requested start</Tag> : null}
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

                        {isAdminSurface ? (
                          <Card className="battletoads-card" title={copy.requestQueue}>
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                              <Input.TextArea rows={2} value={algofundDecisionNote} onChange={(event) => setAlgofundDecisionNote(event.target.value)} placeholder={copy.decisionNote} />
                              <Table rowKey="id" columns={requestColumns} dataSource={algofundState.requests || []} pagination={false} scroll={{ x: 960 }} />
                            </Space>
                          </Card>
                        ) : null}
                      </>
                    ) : null}
                  </Spin>
                </Space>
              ),
            },
          ].filter((item) => isAdminSurface || item.key === surfaceMode)}
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
        title={`Monitoring chart: ${monitoringChartApiKey || '—'}`}
        open={monitoringChartOpen}
        onCancel={() => setMonitoringChartOpen(false)}
        footer={<Button onClick={() => setMonitoringChartOpen(false)}>Close</Button>}
        width={960}
      >
        <Spin spinning={monitoringChartLoading}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              {monitoringChartLatest ? <Tag color="blue">Eq {formatMoney(monitoringChartLatest.equity_usd)}</Tag> : null}
              {monitoringChartLatest ? <Tag color="purple">ML {formatPercent(monitoringChartLatest.margin_load_percent)}</Tag> : null}
              {monitoringChartLatest ? <Tag color="red">Lev {formatNumber(monitoringChartLatest.effective_leverage, 2)}x</Tag> : null}
              {monitoringChartLatest ? <Tag color="orange">DD {formatPercent(monitoringChartLatest.drawdown_percent)}</Tag> : null}
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
                setActiveTab('admin');
                setAdminTab('monitoring');
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
            {applyLowLotTarget.replacementCandidates?.length > 0 && (
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
        title="Backtest ТС из SaaS"
        placement="right"
        width="92vw"
        open={backtestDrawerVisible}
        onClose={() => setBacktestDrawerVisible(false)}
      >
        {backtestDrawerApiKeyName ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="Контекст SaaS сохранен: после анализа backtest закрой окно и продолжай review/publish."
            />
            <iframe
              title="Trading Systems Backtest"
              src={`/trading-systems?apiKeyName=${encodeURIComponent(backtestDrawerApiKeyName)}${backtestDrawerSystemId && backtestDrawerSystemId > 0 ? `&systemId=${backtestDrawerSystemId}` : ''}`}
              style={{ width: '100%', height: 'calc(100vh - 180px)', border: '1px solid #f0f0f0', borderRadius: 8 }}
            />
          </Space>
        ) : (
          <Empty description="Нет данных для открытия backtest" />
        )}
      </Drawer>
    </div>
  );
};

export default SaaS;

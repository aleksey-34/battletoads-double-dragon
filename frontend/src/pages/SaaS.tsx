import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  List,
  message,
  Row,
  Select,
  Slider,
  Space,
  Spin,
  Statistic,
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
    points?: EquityPoint[];
    summary?: Record<string, unknown>;
  };
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

type UpdateCommit = {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
};

type UpdateStatus = {
  configured: boolean;
  updateEnabled: boolean;
  repoDir: string;
  appDir: string;
  branch: string;
  originUrl: string;
  localHash: string;
  remoteHash: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  updateAvailable: boolean;
  latestCommit: UpdateCommit | null;
  pendingCommits: UpdateCommit[];
  message?: string;
};

type UpdateJob = {
  unit: string;
  exists: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  execMainStatus: string;
  startedAt: string;
  exitedAt: string;
  logs: string;
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
  } | null;
  monitoring?: {
    equity_usd?: number;
    unrealized_pnl?: number;
    margin_load_percent?: number;
    drawdown_percent?: number;
  } | null;
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
    portfolioFull?: {
      totalReturnPercent?: number;
      maxDrawdownPercent?: number;
      profitFactor?: number;
      winRatePercent?: number;
      tradesCount?: number;
    } | null;
  } | null;
  recommendedSets: Record<string, CatalogOffer[]>;
  tenants: TenantSummary[];
  plans: Plan[];
  apiKeys: string[];
};

type StrategyClientState = {
  tenant: Tenant;
  plan: Plan | null;
  capabilities?: TenantCapabilities;
  monitoring?: TenantSummary['monitoring'];
  profile: {
    selectedOfferIds: string[];
    latestPreview?: Record<string, unknown>;
    risk_level: Level3;
    trade_frequency_level: Level3;
    requested_enabled: number;
    actual_enabled: number;
    assigned_api_key_name: string;
  } | null;
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

type AlgofundRequest = {
  id: number;
  tenant_id: number;
  request_type: 'start' | 'stop';
  status: RequestStatus;
  note: string;
  decision_note: string;
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
  };
  preview: {
    riskMultiplier: number;
    period?: PeriodInfo | null;
    sourceSystem?: {
      apiKeyName: string;
      systemId: number;
      systemName: string;
    } | null;
    summary?: {
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
};

const COPY_BY_LANGUAGE: Record<'ru' | 'en' | 'tr', Copy> = {
  ru: {
    title: 'SaaS Control Room',
    subtitle: 'Один MVP-контур для admin, strategy-client и Алгофонд поверх готовых sweep/catalog результатов.',
    refresh: 'Обновить',
    seed: 'Инициализировать demo tenants',
    publish: 'Опубликовать admin TS',
    admin: 'Admin',
    strategyClient: 'Клиент стратегий',
    algofund: 'Алгофонд',
    latestCatalog: 'Последний client catalog',
    latestSweep: 'Последний historical sweep',
    noCatalog: 'Каталог стратегий временно недоступен. Проверьте сборку каталога в админ-контуре.',
    noSweep: 'Исторический sweep временно недоступен. Материализация будет доступна после обновления данных.',
    recommendedSets: 'Рекомендуемые наборы',
    adminTsDraft: 'Черновик admin trading system',
    tenants: 'Тестовые tenants',
    openStrategyClient: 'Открыть клиента стратегий',
    openAlgofund: 'Открыть Алгофонд',
    saveProfile: 'Сохранить профиль',
    preview: 'Показать preview',
    materialize: 'Materialize на API key',
    requestStart: 'Запросить старт',
    requestStop: 'Запросить стоп',
    approve: 'Одобрить',
    reject: 'Отклонить',
    risk: 'Риск',
    tradeFrequency: 'Частота сделок',
    apiKey: 'API key',
    selectedOffers: 'Выбранные офферы',
    monitoring: 'Monitoring',
    requestQueue: 'Очередь запросов',
    previewTitle: 'Preview ожиданий',
    selectedOffersPreview: 'Preview выбранных офферов',
    publishedTsPreview: 'Preview опубликованного admin TS',
    noTenant: 'Тенант этого типа пока не найден.',
    sourceSystem: 'Source system',
    tenantMode: 'Режим',
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
    capabilityBacktest: 'Бэктест/Preview',
    capabilityStartStop: 'Старт/Стоп заявки',
    openSettings: 'Открыть Settings',
    openMonitoring: 'Открыть Monitoring',
    openBacktest: 'Открыть Backtest',
    backtestLockedHint: 'Расширенный backtest недоступен на текущем тарифе. Показывается упрощенный preview.',
    settingsLockedHint: 'Изменение настроек недоступно на текущем тарифе',
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
    previewUsesNearestPreset: 'Preview использует ближайший пресет и при сохранении маппится в low / medium / high.',
    previewPlanCapHint: 'В админ-режиме preview можно смотреть выше лимита тарифа, но сохранение все равно ограничивается тарифным cap.',
    previewRefreshing: 'Пересчитываем preview...',
    openTradingSystems: 'Открыть Trading Systems',
    persistedBucket: 'Сохраняемый bucket',
    pending: 'Ожидает',
    approved: 'Одобрено',
    rejected: 'Отклонено',
    start: 'Старт',
    stop: 'Стоп',
    note: 'Комментарий',
    decisionNote: 'Комментарий решения',
    chooseTenant: 'Выберите тенанта',
    chooseOffer: 'Выберите оффер',
    saveSuccess: 'Профиль обновлен',
    previewReady: 'Preview обновлен',
    materializeSuccess: 'Стратегии материализованы',
    requestSent: 'Запрос отправлен',
    requestResolved: 'Запрос обработан',
    publishReady: 'Admin TS опубликован',
    seedReady: 'Demo tenants обновлены',
    emergencyStop: 'Стоп + закрыть позиции',
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
    recommendedSets: 'Recommended sets',
    adminTsDraft: 'Admin trading system draft',
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
    selectedOffers: 'Selected offers',
    monitoring: 'Monitoring',
    requestQueue: 'Request queue',
    previewTitle: 'Expectation preview',
    selectedOffersPreview: 'Selected offers preview',
    publishedTsPreview: 'Published admin TS preview',
    noTenant: 'No tenant of this type is available yet.',
    sourceSystem: 'Source system',
    tenantMode: 'Mode',
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
    capabilityBacktest: 'Backtest/Preview',
    capabilityStartStop: 'Start/Stop requests',
    openSettings: 'Open Settings',
    openMonitoring: 'Open Monitoring',
    openBacktest: 'Open Backtest',
    backtestLockedHint: 'Extended backtest is not available for this plan. Simplified preview is shown.',
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
    openTradingSystems: 'Open Trading Systems',
    persistedBucket: 'Saved bucket',
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    start: 'Start',
    stop: 'Stop',
    note: 'Note',
    decisionNote: 'Decision note',
    chooseTenant: 'Select tenant',
    chooseOffer: 'Select offer',
    saveSuccess: 'Profile updated',
    previewReady: 'Preview updated',
    materializeSuccess: 'Strategies materialized',
    requestSent: 'Request sent',
    requestResolved: 'Request resolved',
    publishReady: 'Admin TS published',
    seedReady: 'Demo tenants refreshed',
    emergencyStop: 'Stop + close positions',
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
    recommendedSets: 'Onerilen setler',
    adminTsDraft: 'Admin trading system taslagi',
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
    selectedOffers: 'Secilen teklifler',
    monitoring: 'Monitoring',
    requestQueue: 'Talep kuyrugu',
    previewTitle: 'Beklenti onizlemesi',
    selectedOffersPreview: 'Secilen teklifler onizlemesi',
    publishedTsPreview: 'Yayinlanan admin TS onizlemesi',
    noTenant: 'Bu tipte tenant yok.',
    sourceSystem: 'Source system',
    tenantMode: 'Mod',
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
    capabilityBacktest: 'Backtest/Onizleme',
    capabilityStartStop: 'Baslat/Durdur talepleri',
    openSettings: 'Settings ac',
    openMonitoring: 'Monitoring ac',
    openBacktest: 'Backtest ac',
    backtestLockedHint: 'Bu planda gelismis backtest kapali. Basit onizleme gosteriliyor.',
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
    openTradingSystems: 'Trading Systems ac',
    persistedBucket: 'Kaydedilecek bucket',
    pending: 'Bekliyor',
    approved: 'Onaylandi',
    rejected: 'Reddedildi',
    start: 'Baslat',
    stop: 'Durdur',
    note: 'Not',
    decisionNote: 'Karar notu',
    chooseTenant: 'Tenant secin',
    chooseOffer: 'Teklif secin',
    saveSuccess: 'Profil guncellendi',
    previewReady: 'Onizleme guncellendi',
    materializeSuccess: 'Stratejiler olusturuldu',
    requestSent: 'Talep gonderildi',
    requestResolved: 'Talep cozuldu',
    publishReady: 'Admin TS yayinlandi',
    seedReady: 'Demo tenantlar guncellendi',
    emergencyStop: 'Durdur + pozisyonlari kapat',
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
  const score = marginLoad * 0.75 + drawdown * 0.35;
  const bufferPercent = Number.isFinite(marginLoad) ? Math.max(0, 100 - marginLoad) : null;

  if (marginLoad >= 85 || drawdown >= 35 || score >= 85) {
    return { level: 'high', color: 'red', bufferPercent };
  }
  if (marginLoad >= 65 || drawdown >= 20 || score >= 60) {
    return { level: 'medium', color: 'gold', bufferPercent };
  }
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
  if (numeric === null) {
    return null;
  }

  const normalized = numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  return normalized > 0 ? normalized : null;
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
    return ` · ${Math.round(days)}d`;
  }

  const hours = diffMs / (60 * 60 * 1000);
  return ` · ${Math.max(1, Math.round(hours))}h`;
};

const formatPeriodLabel = (period?: PeriodInfo | null): string => {
  if (!period) {
    return '—';
  }

  const from = formatDateShort(period.dateFrom);
  const to = formatDateShort(period.dateTo);
  const interval = period.interval ? ` · ${period.interval}` : '';
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
  const { language, t } = useI18n();
  const copy = COPY_BY_LANGUAGE[language];
  const isAdminSurface = surfaceMode === 'admin';
  const [messageApi, contextHolder] = message.useMessage();
  const [summary, setSummary] = useState<SaasSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [strategyTenantId, setStrategyTenantId] = useState<number | null>(null);
  const [algofundTenantId, setAlgofundTenantId] = useState<number | null>(null);
  const [strategyState, setStrategyState] = useState<StrategyClientState | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategyError, setStrategyError] = useState('');
  const [algofundState, setAlgofundState] = useState<AlgofundState | null>(null);
  const [algofundLoading, setAlgofundLoading] = useState(false);
  const [algofundError, setAlgofundError] = useState('');
  const [strategyOfferIds, setStrategyOfferIds] = useState<string[]>([]);
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
  const [algofundRiskMultiplier, setAlgofundRiskMultiplier] = useState(1);
  const [algofundApiKeyName, setAlgofundApiKeyName] = useState('');
  const [algofundTenantDisplayName, setAlgofundTenantDisplayName] = useState('');
  const [algofundTenantStatus, setAlgofundTenantStatus] = useState('active');
  const [algofundTenantPlanCode, setAlgofundTenantPlanCode] = useState('');
  const [algofundNote, setAlgofundNote] = useState('');
  const [algofundDecisionNote, setAlgofundDecisionNote] = useState('');
  const [publishResponse, setPublishResponse] = useState<AdminPublishResponse | null>(null);
  const [planDrafts, setPlanDrafts] = useState<Record<string, Plan>>({});
  const [actionLoading, setActionLoading] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateRunLoading, setUpdateRunLoading] = useState(false);
  const [jobLoading, setJobLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<SaasTabKey>(initialTab);

  const strategyTenants = (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'strategy_client');
  const algofundTenants = (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'algofund_client');
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
    .map((plan) => ({ value: plan.code, label: `${plan.title} · ${formatMoney(plan.price_usdt)}` }));
  const algofundPlanOptions = (summary?.plans || [])
    .filter((plan) => plan.product_mode === 'algofund_client')
    .map((plan) => ({ value: plan.code, label: `${plan.title} · ${formatMoney(plan.price_usdt)}` }));
  const apiKeyOptions = (summary?.apiKeys || []).map((name) => ({ label: name, value: name }));

  const loadSummary = async () => {
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const response = await axios.get<SaasSummary>('/api/saas/admin/summary');
      setSummary(response.data);
    } catch (error: any) {
      setSummaryError(String(error?.response?.data?.error || error?.message || 'Failed to load SaaS summary'));
    } finally {
      setSummaryLoading(false);
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

  const loadAlgofundTenant = async (tenantId: number, nextRiskMultiplier?: number, allowPreviewAbovePlan = false) => {
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

  const fetchUpdateStatus = async (refreshRemote: boolean = true) => {
    setUpdateLoading(true);
    try {
      const response = await axios.get<UpdateStatus>('/api/system/update/status', {
        params: {
          refresh: refreshRemote ? 1 : 0,
        },
      });
      setUpdateStatus(response.data);
    } catch (error: any) {
      messageApi.error(error?.response?.data?.error || t('settings.msg.statusLoadError', 'Failed to load git update status'));
    } finally {
      setUpdateLoading(false);
    }
  };

  const fetchUpdateJob = async () => {
    setJobLoading(true);
    try {
      const response = await axios.get<UpdateJob>('/api/system/update/job');
      setUpdateJob(response.data);
    } catch (error: any) {
      messageApi.error(error?.response?.data?.error || t('settings.msg.jobLoadError', 'Failed to load git update job status'));
    } finally {
      setJobLoading(false);
    }
  };

  const runGitUpdate = async () => {
    setUpdateRunLoading(true);
    try {
      const response = await axios.post('/api/system/update/run');
      const unit = String(response?.data?.unit || 'btdd-git-update');
      messageApi.success(t('settings.msg.runStarted', 'Update started ({unit}). Backend may restart during deploy.', { unit }));

      window.setTimeout(() => {
        void fetchUpdateJob();
        void fetchUpdateStatus(true);
      }, 1200);
    } catch (error: any) {
      messageApi.error(error?.response?.data?.error || t('settings.msg.runError', 'Failed to start git update'));
    } finally {
      setUpdateRunLoading(false);
    }
  };

  useEffect(() => {
    void loadSummary();
    if (isAdminSurface) {
      void fetchUpdateStatus(true);
      void fetchUpdateJob();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSurface]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!isAdminSurface) {
      return;
    }

    const activeState = String(updateJob?.activeState || '').toLowerCase();
    if (activeState !== 'active' && activeState !== 'activating') {
      return;
    }

    const timer = window.setInterval(() => {
      void fetchUpdateJob();
      void fetchUpdateStatus(false);
    }, 5000);

    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSurface, updateJob?.activeState]);

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
    const selected = Array.isArray(strategyState.profile.selectedOfferIds) ? strategyState.profile.selectedOfferIds : [];
    setStrategyOfferIds(selected);
    setStrategyRiskInput(levelToSliderValue(strategyState.profile.risk_level || 'medium'));
    setStrategyTradeInput(levelToSliderValue(strategyState.profile.trade_frequency_level || 'medium'));
    setStrategyApiKeyName(strategyState.profile.assigned_api_key_name || strategyState.tenant.assigned_api_key_name || '');
    setStrategyTenantDisplayName(strategyState.tenant.display_name || '');
    setStrategyTenantStatus(strategyState.tenant.status || 'active');
    setStrategyTenantPlanCode(strategyState.plan?.code || '');
    setStrategyPreviewOfferId((current) => (current && selected.includes(current) ? current : selected[0] || strategyState.offers[0]?.offerId || ''));
    const latestPreview = hydrateStrategyPreview(strategyState.profile.latestPreview as StrategyPreviewResponse | null | undefined, strategyState.offers || []);
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
      setStrategyPreview(hydrateStrategyPreview(response.data, strategyState?.offers || []));
      if (!silent) {
        messageApi.success(copy.previewReady);
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to build preview'));
    } finally {
      setStrategyPreviewLoading(false);
    }
  }, [copy.previewReady, messageApi, strategyPreviewOfferId, strategyRiskInput, strategyState, strategyTenantId, strategyTradeInput]);

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

  useEffect(() => {
    if (!strategyTenantId || !strategyPreviewOfferId || !strategyState) {
      return;
    }

    const timer = window.setTimeout(() => {
      void runStrategyPreview(true);
    }, 350);

    return () => window.clearTimeout(timer);
  }, [runStrategyPreview, strategyPreviewOfferId, strategyState, strategyTenantId]);

  useEffect(() => {
    if (!strategyTenantId || !strategyState) {
      return;
    }

    if (strategyOfferIds.length === 0) {
      setStrategySelectionPreview(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void runStrategySelectionPreview(true);
    }, 350);

    return () => window.clearTimeout(timer);
  }, [runStrategySelectionPreview, strategyOfferIds, strategyState, strategyTenantId]);

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
    await loadAlgofundTenant(algofundTenantId, algofundRiskMultiplier, isAdminSurface);
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

  const sendAlgofundRequest = async (requestType: 'start' | 'stop') => {
    if (!algofundTenantId) {
      return;
    }
    setActionLoading(`algofund-${requestType}`);
    try {
      const response = await axios.post(`/api/saas/algofund/${algofundTenantId}/request`, {
        requestType,
        note: algofundNote,
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

  const offerColumns: ColumnsType<CatalogOffer> = [
    {
      title: copy.selectedOffers,
      key: 'selected',
      width: 76,
      render: (_, offer) => (
        <Checkbox
          checked={strategyOfferIds.includes(offer.offerId)}
          onChange={(event) => {
            const checked = event.target.checked;
            setStrategyOfferIds((current) => {
              if (checked) {
                return Array.from(new Set([...current, offer.offerId]));
              }
              return current.filter((item) => item !== offer.offerId);
            });
          }}
        />
      ),
    },
    {
      title: 'Offer',
      key: 'offer',
      render: (_, offer) => (
        <Space direction="vertical" size={0}>
          <Text strong>{offer.titleRu}</Text>
          <Text type="secondary">{offer.strategy.mode.toUpperCase()} · {offer.strategy.type} · {offer.strategy.market}</Text>
        </Space>
      ),
    },
    {
      title: copy.score,
      dataIndex: ['metrics', 'score'],
      width: 100,
      render: (value) => <Tag color="cyan">{formatNumber(value)}</Tag>,
    },
    {
      title: copy.returnLabel,
      width: 110,
      render: (_, offer) => <Tag color={metricColor(Number(offer.metrics.ret || 0), 'return')}>{formatPercent(offer.metrics.ret)}</Tag>,
    },
    {
      title: copy.drawdown,
      width: 110,
      render: (_, offer) => <Tag color={metricColor(Number(offer.metrics.dd || 0), 'drawdown')}>{formatPercent(offer.metrics.dd)}</Tag>,
    },
    {
      title: copy.profitFactor,
      width: 100,
      render: (_, offer) => <Tag color={metricColor(Number(offer.metrics.pf || 0), 'pf')}>{formatNumber(offer.metrics.pf)}</Tag>,
    },
    {
      title: copy.trades,
      width: 96,
      render: (_, offer) => formatNumber(offer.metrics.trades, 0),
    },
  ];

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
      render: (_, row) => row.plan ? `${row.plan.title} · ${formatMoney(row.plan.price_usdt)}` : '—',
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
          {calcDepositLoadPercent(row) !== null ? <Tag color="cyan">{copy.depositLoad}: {formatPercent(calcDepositLoadPercent(row))}</Tag> : null}
          {(() => {
            const liq = calcLiquidationRisk(row);
            return <Tag color={liq.color}>{copy.liquidationRisk}: {liq.level}{liq.bufferPercent !== null ? ` (${formatPercent(liq.bufferPercent)} buf)` : ''}</Tag>;
          })()}
        </Space>
      ) : <Tag color="default">off</Tag>) : <Tag color="default">off</Tag>,
    },
    {
      title: copy.status,
      key: 'status',
      width: 120,
      render: (_, row) => <Tag color={row.tenant.status === 'active' ? 'success' : 'default'}>{row.tenant.status}</Tag>,
    },
    {
      title: 'Action',
      key: 'action',
      width: 170,
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
        <Button
          size="small"
          onClick={() => {
            setAlgofundTenantId(row.tenant.id);
            setActiveTab('algofund');
          }}
        >
          {copy.openAlgofund}
        </Button>
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

  const requestColumns: ColumnsType<AlgofundRequest> = [
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
      width: 100,
      render: (_, row) => row.request_type === 'start' ? copy.start : copy.stop,
    },
    {
      title: copy.note,
      dataIndex: 'note',
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
            loading={actionLoading === `resolve-${row.id}`}
            onClick={() => void resolveRequest(row.id, 'approved')}
          >
            {copy.approve}
          </Button>
          <Button
            size="small"
            danger
            loading={actionLoading === `resolve-${row.id}`}
            onClick={() => void resolveRequest(row.id, 'rejected')}
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
  const jobActiveState = String(updateJob?.activeState || '').toLowerCase();
  const updateJobRunning = jobActiveState === 'active' || jobActiveState === 'activating';
  const hasLocalServerChanges = Number(updateStatus?.dirtyCount || 0) > 0 || Number(updateStatus?.ahead || 0) > 0;
  const canRunGitUpdate = Boolean(
    updateStatus?.configured &&
    updateStatus?.updateEnabled &&
    updateStatus?.updateAvailable &&
    !hasLocalServerChanges
  );

  const renderUpdateStatusTag = () => {
    if (!updateStatus) {
      return <Tag color="processing">{t('settings.update.loading', 'Loading update status...')}</Tag>;
    }

    if (!updateStatus.updateEnabled) {
      return <Tag color="warning">{t('settings.update.disabled', 'Update API disabled')}</Tag>;
    }

    if (updateStatus.updateAvailable) {
      const count = Number(updateStatus.behind || updateStatus.pendingCommits?.length || 0);
      return <Tag color="gold">{t('settings.update.available', 'Update available ({count})', { count })}</Tag>;
    }

    return <Tag color="success">{t('settings.update.upToDate', 'Up to date')}</Tag>;
  };

  const renderGitUpdateCard = (scopeLabel: string, compact: boolean) => (
    <Card
      className="battletoads-card"
      title={`${t('settings.update.title', 'Git Update (VPS)')} · ${scopeLabel}`}
      extra={(
        <Space wrap>
          <Button size="small" onClick={() => void fetchUpdateStatus(true)} loading={updateLoading}>
            {t('settings.update.check', 'Check updates')}
          </Button>
          <Button size="small" onClick={() => void fetchUpdateJob()} loading={jobLoading}>
            {t('settings.update.refreshJob', 'Refresh job')}
          </Button>
          <Button
            size="small"
            type="primary"
            onClick={() => void runGitUpdate()}
            loading={updateRunLoading}
            disabled={!canRunGitUpdate}
          >
            {t('settings.update.install', 'Install from Git')}
          </Button>
        </Space>
      )}
    >
      <Space wrap>
        {renderUpdateStatusTag()}
        {updateStatus?.branch ? <Tag color="blue">{updateStatus.branch}</Tag> : null}
        {Number(updateStatus?.behind || 0) > 0 ? <Tag color="gold">behind {updateStatus?.behind}</Tag> : null}
        {Number(updateStatus?.ahead || 0) > 0 ? <Tag color="purple">ahead {updateStatus?.ahead}</Tag> : null}
        {Number(updateStatus?.dirtyCount || 0) > 0 ? <Tag color="red">dirty {updateStatus?.dirtyCount}</Tag> : null}
        {updateJob?.activeState ? <Tag color={updateJobRunning ? 'processing' : 'default'}>{t('settings.update.job', 'Update Job')}: {updateJob.activeState}</Tag> : null}
        {updateJob?.result && updateJob.result !== 'success' ? <Tag color="warning">result: {updateJob.result}</Tag> : null}
      </Space>

      {updateStatus?.message ? (
        <Alert style={{ marginTop: 12 }} type="info" showIcon message={updateStatus.message} />
      ) : null}

      {hasLocalServerChanges ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message="Server repo has local changes (ahead/dirty). Clean or commit them before running git update."
        />
      ) : null}

      {!compact && Number(updateStatus?.pendingCommits?.length || 0) > 0 ? (
        <>
          <Text strong style={{ display: 'block', marginTop: 12 }}>{t('settings.update.whatsNew', "What's new in Git")}</Text>
          <List
            size="small"
            dataSource={updateStatus?.pendingCommits || []}
            renderItem={(commit) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <Text code>{commit.shortHash}</Text>
                  <Text>{commit.subject}</Text>
                  <Text type="secondary">{commit.date}</Text>
                </Space>
              </List.Item>
            )}
          />
        </>
      ) : null}

      {!compact && updateJob?.logs ? (
        <Paragraph style={{ marginTop: 12, marginBottom: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
          {String(updateJob.logs || '').split('\n').slice(-10).join('\n')}
        </Paragraph>
      ) : null}
    </Card>
  );

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
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {renderGitUpdateCard(copy.admin, false)}
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

                  {summary?.sweepSummary?.portfolioFull ? (
                    <Row gutter={[16, 16]}>
                      <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.returnLabel} value={Number(summary.sweepSummary.portfolioFull.totalReturnPercent || 0)} precision={2} suffix="%" /></Card></Col>
                      <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.drawdown} value={Number(summary.sweepSummary.portfolioFull.maxDrawdownPercent || 0)} precision={2} suffix="%" /></Card></Col>
                      <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.profitFactor} value={Number(summary.sweepSummary.portfolioFull.profitFactor || 0)} precision={2} /></Card></Col>
                      <Col xs={12} md={6}><Card className="battletoads-card"><Statistic title={copy.trades} value={Number(summary.sweepSummary.portfolioFull.tradesCount || 0)} precision={0} /></Card></Col>
                    </Row>
                  ) : null}

                  <Row gutter={[16, 16]}>
                    <Col xs={24} xl={14}>
                      <Card className="battletoads-card" title={copy.recommendedSets}>
                        <List
                          dataSource={Object.entries(summary?.recommendedSets || {})}
                          locale={{ emptyText: <Empty description={copy.noCatalog} /> }}
                          renderItem={([setName, offers]) => (
                            <List.Item>
                              <div style={{ width: '100%' }}>
                                <Text strong>{setName}</Text>
                                <div className="saas-offer-badges">
                                  {(offers || []).map((offer) => (
                                    <Tag key={offer.offerId} color={offer.strategy.mode === 'mono' ? 'green' : 'blue'}>
                                      {offer.strategy.market} · {formatNumber(offer.metrics.score)}
                                    </Tag>
                                  ))}
                                </div>
                              </div>
                            </List.Item>
                          )}
                        />
                      </Card>
                    </Col>
                    <Col xs={24} xl={10}>
                      <Card className="battletoads-card" title={copy.adminTsDraft} extra={<Button size="small" href="/trading-systems">{copy.openTradingSystems}</Button>}>
                        <List
                          dataSource={summary?.catalog?.adminTradingSystemDraft?.members || []}
                          locale={{ emptyText: <Empty description={copy.noCatalog} /> }}
                          renderItem={(member) => (
                            <List.Item>
                              <Space direction="vertical" size={0}>
                                <Text strong>{member.strategyName}</Text>
                                <Text type="secondary">{member.marketMode.toUpperCase()} · {member.market}</Text>
                              </Space>
                              <Space>
                                <Tag color="cyan">{copy.score}: {formatNumber(member.score)}</Tag>
                                <Tag color="purple">w {formatNumber(member.weight)}</Tag>
                              </Space>
                            </List.Item>
                          )}
                        />
                      </Card>
                    </Col>
                  </Row>

                  <Card className="battletoads-card" title={copy.connectedTenants}>
                    <Table rowKey={(row) => row.tenant.id} columns={tenantColumns} dataSource={summary?.tenants || []} pagination={false} scroll={{ x: 980 }} />
                  </Card>

                  <Row gutter={[16, 16]}>
                    <Col xs={24} xl={12}>
                      <Card className="battletoads-card" title={`${copy.strategyClient} · ${copy.planGrid}`}>
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
                      <Card className="battletoads-card" title={`${copy.algofund} · ${copy.planGrid}`}>
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

                  {publishResponse?.preview ? (
                    <Card className="battletoads-card" title={copy.publishedTsPreview}>
                      <Row gutter={[16, 16]}>
                        <Col xs={24} lg={8}>
                          <Descriptions column={1} size="small" bordered>
                            <Descriptions.Item label={copy.sourceSystem}>{publishResponse.sourceSystem?.systemName || '—'}</Descriptions.Item>
                            <Descriptions.Item label={copy.apiKey}>{publishResponse.sourceSystem?.apiKeyName || '—'}</Descriptions.Item>
                            <Descriptions.Item label={copy.period}>{formatPeriodLabel(publishPreviewPeriod)}</Descriptions.Item>
                            <Descriptions.Item label={copy.finalEquity}>{formatMoney(publishPreviewDerivedSummary?.finalEquity ?? publishResponse.preview.summary?.finalEquity)}</Descriptions.Item>
                            <Descriptions.Item label={copy.returnLabel}>{formatPercent(publishPreviewDerivedSummary?.totalReturnPercent ?? publishResponse.preview.summary?.totalReturnPercent)}</Descriptions.Item>
                            <Descriptions.Item label={copy.drawdown}>{formatPercent(publishPreviewDerivedSummary?.maxDrawdownPercent ?? publishResponse.preview.summary?.maxDrawdownPercent)}</Descriptions.Item>
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
              key: 'strategy-client',
              label: copy.strategyClient,
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {strategyTenants.length === 0 ? <Alert type="info" showIcon message={copy.noTenant} /> : null}
                  {strategyError ? <Alert type="error" showIcon message={strategyError} /> : null}

                  <Spin spinning={strategyLoading && !strategyState}>
                    {strategyState ? (
                      <>
                        <Card className="battletoads-card" title={copy.tenantWorkspace}>
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
                                <div style={{ marginTop: 8 }}><Text>{strategyState.plan ? `${strategyState.plan.title} · ${formatMoney(strategyState.plan.price_usdt)}` : '—'}</Text></div>
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
                            <Button size="small" href="/positions" disabled={!strategyMonitoringEnabled}>{copy.openMonitoring}</Button>
                            <Button size="small" href="/backtest" disabled={!strategyBacktestEnabled}>{copy.openBacktest}</Button>
                          </Space>
                          {isAdminSurface ? (
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
                            </Space>
                          ) : null}
                        </Card>

                        {!strategyBacktestEnabled ? <Alert type="warning" showIcon message={copy.backtestLockedHint} /> : null}

                        <Card className="battletoads-card">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} lg={12}>
                              <Text strong>{copy.risk}: {formatNumber(strategyRiskInput, 1)}</Text>
                              <Slider min={0} max={10} step={0.1} marks={strategyLevelMarks} value={strategyRiskInput} onChange={(value) => setStrategyRiskInput(clampPreviewValue(Number(value)))} />
                              <InputNumber min={0} max={10} step={0.1} style={{ width: '100%' }} value={strategyRiskInput} onChange={(value) => setStrategyRiskInput(clampPreviewValue(Number(value ?? 0)))} />
                            </Col>
                            <Col xs={24} lg={12}>
                              <Text strong>{copy.tradeFrequency}: {formatNumber(strategyTradeInput, 1)}</Text>
                              <Slider min={0} max={10} step={0.1} marks={strategyLevelMarks} value={strategyTradeInput} onChange={(value) => setStrategyTradeInput(clampPreviewValue(Number(value)))} />
                              <InputNumber min={0} max={10} step={0.1} style={{ width: '100%' }} value={strategyTradeInput} onChange={(value) => setStrategyTradeInput(clampPreviewValue(Number(value ?? 0)))} />
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

                        <Card className="battletoads-card" title={copy.selectedOffers}>
                          <Table rowKey="offerId" columns={offerColumns} dataSource={strategyState.offers || []} pagination={false} scroll={{ x: 920 }} />
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
                                    <Descriptions.Item label={copy.finalEquity}>{formatMoney(strategySelectionPreviewDerivedSummary?.finalEquity ?? (strategySelectionPreviewSummary as any)?.finalEquity)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.returnLabel}>{formatPercent(strategySelectionPreviewDerivedSummary?.totalReturnPercent ?? (strategySelectionPreviewSummary as any)?.totalReturnPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.drawdown}>{formatPercent(strategySelectionPreviewDerivedSummary?.maxDrawdownPercent ?? (strategySelectionPreviewSummary as any)?.maxDrawdownPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.profitFactor}>{formatNumber((strategySelectionPreviewSummary as any)?.profitFactor)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.trades}>{formatNumber((strategySelectionPreviewSummary as any)?.tradesCount, 0)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.persistedBucket}>{strategySelectionPreview.controls?.riskLevel || strategyPersistedRiskBucket} / {strategySelectionPreview.controls?.tradeFrequencyLevel || strategyPersistedTradeBucket}</Descriptions.Item>
                                  </Descriptions>
                                </Col>
                                <Col xs={24} lg={16}>
                                  <Space wrap style={{ marginBottom: 12 }}>
                                    {strategySelectionPreviewOffers.map((item) => (
                                      <Tag key={item.offerId} color={item.mode === 'mono' ? 'green' : 'blue'}>
                                        {item.market} · {formatNumber(item.score)}
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
                                options={(strategyState.offers || []).map((offer) => ({ value: offer.offerId, label: `${offer.titleRu} · ${offer.strategy.market}` }))}
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
                                    <Descriptions.Item label={copy.finalEquity}>{formatMoney(strategyPreviewDerivedSummary?.finalEquity ?? (strategyPreviewSummary as any)?.finalEquity)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.returnLabel}>{formatPercent(strategyPreviewDerivedSummary?.totalReturnPercent ?? (strategyPreviewSummary as any)?.totalReturnPercent ?? strategyPreviewMetrics?.ret)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.drawdown}>{formatPercent(strategyPreviewDerivedSummary?.maxDrawdownPercent ?? (strategyPreviewSummary as any)?.maxDrawdownPercent ?? strategyPreviewMetrics?.dd)}</Descriptions.Item>
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
                                    <Text type="secondary">{item.mode.toUpperCase()} · {item.type} · {item.market}</Text>
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
                        <Card className="battletoads-card" title={copy.tenantWorkspace}>
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
                            <Button size="small" href="/positions" disabled={!algofundMonitoringEnabled}>{copy.openMonitoring}</Button>
                            <Button size="small" href="/backtest" disabled={!algofundBacktestEnabled}>{copy.openBacktest}</Button>
                          </Space>
                          {isAdminSurface ? (
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
                            </Space>
                          ) : null}
                        </Card>

                        {!algofundBacktestEnabled ? <Alert type="warning" showIcon message={copy.backtestLockedHint} /> : null}

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

                        <Card className="battletoads-card" title={copy.previewTitle} extra={algofundLoading ? <Tag color="processing">{copy.previewRefreshing}</Tag> : null}>
                          <Spin spinning={algofundLoading}>
                            {
                              <Row gutter={[16, 16]}>
                                <Col xs={24} lg={8}>
                                  <Descriptions column={1} size="small" bordered>
                                    <Descriptions.Item label={copy.sourceSystem}>{algofundState.preview?.sourceSystem?.systemName || '—'}</Descriptions.Item>
                                    <Descriptions.Item label={copy.period}>{formatPeriodLabel(algofundPreviewPeriod)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.finalEquity}>{formatMoney(algofundPreviewDerivedSummary?.finalEquity ?? algofundState.preview?.summary?.finalEquity)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.returnLabel}>{formatPercent(algofundPreviewDerivedSummary?.totalReturnPercent ?? algofundState.preview?.summary?.totalReturnPercent)}</Descriptions.Item>
                                    <Descriptions.Item label={copy.drawdown}>{formatPercent(algofundPreviewDerivedSummary?.maxDrawdownPercent ?? algofundState.preview?.summary?.maxDrawdownPercent)}</Descriptions.Item>
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
    </div>
  );
};

export default SaaS;

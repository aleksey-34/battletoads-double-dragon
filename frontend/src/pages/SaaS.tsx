import React, { useEffect, useState } from 'react';
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
  List,
  message,
  Row,
  Segmented,
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

type EquityPoint = {
  time: number;
  equity?: number;
  value?: number;
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
  apiKeys: string[];
};

type StrategyClientState = {
  tenant: Tenant;
  plan: Plan | null;
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
  offer: CatalogOffer;
  preset: CatalogPreset;
  preview: {
    source?: string;
    summary?: Record<string, unknown>;
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
  profile: {
    latestPreview?: Record<string, unknown>;
    risk_multiplier: number;
    requested_enabled: number;
    actual_enabled: number;
    assigned_api_key_name: string;
  };
  preview: {
    riskMultiplier: number;
    sourceSystem?: {
      apiKeyName: string;
      systemId: number;
      systemName: string;
    };
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
    noCatalog: 'Файл client catalog не найден в results/. Сначала прогоните catalog builder на VPS или локально.',
    noSweep: 'Файл historical sweep не найден в results/. Без него не получится materialize клиентские стратегии.',
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
    noCatalog: 'Client catalog JSON was not found in results/. Run the catalog builder first.',
    noSweep: 'Historical sweep JSON was not found in results/. Strategy materialization requires it.',
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
    noCatalog: 'results/ icinde client catalog JSON bulunamadi. Once catalog builder calistirin.',
    noSweep: 'results/ icinde historical sweep JSON bulunamadi. Materialize icin gerekli.',
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

const extractEquityPoints = (payload: unknown): EquityPoint[] => {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload
      .map((item) => ({
        time: Number((item as EquityPoint).time),
        equity: Number((item as EquityPoint).equity ?? (item as EquityPoint).value),
      }))
      .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.equity));
  }
  const objectPayload = payload as { points?: EquityPoint[]; equityCurve?: EquityPoint[] };
  return extractEquityPoints(objectPayload.points || objectPayload.equityCurve || []);
};

const toLineSeriesData = (payload: unknown) => extractEquityPoints(payload).map((point) => ({ time: point.time, value: Number(point.equity || 0) }));

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

const strategyLevelOptions = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
];

const SaaS: React.FC = () => {
  const { language, t } = useI18n();
  const copy = COPY_BY_LANGUAGE[language];
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
  const [strategyRiskLevel, setStrategyRiskLevel] = useState<Level3>('medium');
  const [strategyTradeLevel, setStrategyTradeLevel] = useState<Level3>('medium');
  const [strategyApiKeyName, setStrategyApiKeyName] = useState('');
  const [strategyPreviewOfferId, setStrategyPreviewOfferId] = useState('');
  const [strategyPreview, setStrategyPreview] = useState<StrategyPreviewResponse | null>(null);
  const [strategyPreviewLoading, setStrategyPreviewLoading] = useState(false);
  const [materializeResponse, setMaterializeResponse] = useState<MaterializeResponse | null>(null);
  const [algofundRiskMultiplier, setAlgofundRiskMultiplier] = useState(1);
  const [algofundApiKeyName, setAlgofundApiKeyName] = useState('');
  const [algofundNote, setAlgofundNote] = useState('');
  const [algofundDecisionNote, setAlgofundDecisionNote] = useState('');
  const [publishResponse, setPublishResponse] = useState<AdminPublishResponse | null>(null);
  const [actionLoading, setActionLoading] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateRunLoading, setUpdateRunLoading] = useState(false);
  const [jobLoading, setJobLoading] = useState(false);

  const strategyTenants = (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'strategy_client');
  const algofundTenants = (summary?.tenants || []).filter((item) => item.tenant.product_mode === 'algofund_client');
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

  const loadAlgofundTenant = async (tenantId: number, nextRiskMultiplier?: number) => {
    setAlgofundLoading(true);
    setAlgofundError('');
    try {
      const query = nextRiskMultiplier !== undefined ? `?riskMultiplier=${encodeURIComponent(String(nextRiskMultiplier))}` : '';
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
    void fetchUpdateStatus(true);
    void fetchUpdateJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
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
  }, [updateJob?.activeState]);

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
      void loadAlgofundTenant(algofundTenantId);
    }
  }, [algofundTenantId]);

  useEffect(() => {
    if (!strategyState?.profile) {
      return;
    }
    const selected = Array.isArray(strategyState.profile.selectedOfferIds) ? strategyState.profile.selectedOfferIds : [];
    setStrategyOfferIds(selected);
    setStrategyRiskLevel(strategyState.profile.risk_level || 'medium');
    setStrategyTradeLevel(strategyState.profile.trade_frequency_level || 'medium');
    setStrategyApiKeyName(strategyState.profile.assigned_api_key_name || strategyState.tenant.assigned_api_key_name || '');
    setStrategyPreviewOfferId((current) => (current && selected.includes(current) ? current : selected[0] || strategyState.offers[0]?.offerId || ''));
  }, [strategyState]);

  useEffect(() => {
    if (!algofundState?.profile) {
      return;
    }
    setAlgofundRiskMultiplier(Number(algofundState.profile.risk_multiplier || algofundState.preview?.riskMultiplier || 1));
    setAlgofundApiKeyName(algofundState.profile.assigned_api_key_name || algofundState.tenant.assigned_api_key_name || '');
  }, [algofundState]);

  const saveStrategyProfile = async () => {
    if (!strategyTenantId) {
      return;
    }
    setActionLoading('strategy-save');
    try {
      const response = await axios.patch(`/api/saas/strategy-clients/${strategyTenantId}`, {
        selectedOfferIds: strategyOfferIds,
        riskLevel: strategyRiskLevel,
        tradeFrequencyLevel: strategyTradeLevel,
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

  const runStrategyPreview = async () => {
    if (!strategyTenantId || !strategyPreviewOfferId) {
      return;
    }
    setStrategyPreviewLoading(true);
    try {
      const response = await axios.post<StrategyPreviewResponse>(`/api/saas/strategy-clients/${strategyTenantId}/preview`, {
        offerId: strategyPreviewOfferId,
        riskLevel: strategyRiskLevel,
        tradeFrequencyLevel: strategyTradeLevel,
      });
      setStrategyPreview(response.data);
      messageApi.success(copy.previewReady);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to build preview'));
    } finally {
      setStrategyPreviewLoading(false);
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
    await loadAlgofundTenant(algofundTenantId, algofundRiskMultiplier);
    messageApi.success(copy.previewReady);
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
      render: (_, row) => row.tenant.assigned_api_key_name || '—',
    },
    {
      title: copy.monitoring,
      key: 'monitoring',
      render: (_, row) => row.monitoring ? (
        <Space size={4} wrap>
          <Tag color="blue">Eq {formatMoney(row.monitoring.equity_usd)}</Tag>
          <Tag color="orange">DD {formatPercent(row.monitoring.drawdown_percent)}</Tag>
        </Space>
      ) : '—',
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
        <Button size="small" onClick={() => setStrategyTenantId(row.tenant.id)}>{copy.openStrategyClient}</Button>
      ) : (
        <Button size="small" onClick={() => setAlgofundTenantId(row.tenant.id)}>{copy.openAlgofund}</Button>
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
  const strategyPreviewPoints = strategyPreview?.preview ? toLineSeriesData(strategyPreview.preview.equity) : [];
  const algofundPreviewPoints = algofundState?.preview ? toLineSeriesData(algofundState.preview.equityCurve) : [];
  const publishPreviewPoints = publishResponse?.preview ? toLineSeriesData(publishResponse.preview.equityCurve) : [];
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
              <Button onClick={() => void seedDemoTenants()} loading={actionLoading === 'seed'}>{copy.seed}</Button>
              <Button type="primary" onClick={() => void publishAdminTs()} loading={actionLoading === 'publish'}>{copy.publish}</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {summaryError ? <Alert style={{ marginTop: 16 }} type="error" message={summaryError} showIcon /> : null}

      <Spin spinning={summaryLoading && !summary}>
        <Tabs
          className="saas-tabs"
          items={[
            {
              key: 'admin',
              label: copy.admin,
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {renderGitUpdateCard(copy.admin, false)}
                  {!summary?.catalog ? <Alert type="warning" showIcon message={copy.noCatalog} /> : null}
                  {!summary?.sweepSummary ? <Alert type="warning" showIcon message={copy.noSweep} /> : null}

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
                      <Card className="battletoads-card" title={copy.adminTsDraft}>
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

                  <Card className="battletoads-card" title={copy.tenants}>
                    <Table rowKey={(row) => row.tenant.id} columns={tenantColumns} dataSource={summary?.tenants || []} pagination={false} scroll={{ x: 980 }} />
                  </Card>

                  {publishResponse?.preview ? (
                    <Card className="battletoads-card" title={copy.publishedTsPreview}>
                      <Row gutter={[16, 16]}>
                        <Col xs={24} lg={8}>
                          <Descriptions column={1} size="small" bordered>
                            <Descriptions.Item label={copy.sourceSystem}>{publishResponse.sourceSystem?.systemName || '—'}</Descriptions.Item>
                            <Descriptions.Item label={copy.apiKey}>{publishResponse.sourceSystem?.apiKeyName || '—'}</Descriptions.Item>
                            <Descriptions.Item label={copy.returnLabel}>{formatPercent(publishResponse.preview.summary?.totalReturnPercent)}</Descriptions.Item>
                            <Descriptions.Item label={copy.drawdown}>{formatPercent(publishResponse.preview.summary?.maxDrawdownPercent)}</Descriptions.Item>
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
                  {renderGitUpdateCard(copy.strategyClient, true)}
                  {strategyTenants.length === 0 ? <Alert type="info" showIcon message={copy.noTenant} /> : null}
                  {strategyError ? <Alert type="error" showIcon message={strategyError} /> : null}

                  <Spin spinning={strategyLoading && !strategyState}>
                    <Card className="battletoads-card">
                      <Row gutter={[16, 16]} align="middle">
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
                          <Text strong>{copy.apiKey}</Text>
                          <Select style={{ width: '100%', marginTop: 8 }} value={strategyApiKeyName || undefined} onChange={setStrategyApiKeyName} options={apiKeyOptions} />
                        </Col>
                        <Col xs={24} md={8}>
                          <Space direction="vertical" size={4}>
                            <Text strong>{copy.plan}</Text>
                            <Text>{strategyState?.plan ? `${strategyState.plan.title} · ${formatMoney(strategyState.plan.price_usdt)}` : '—'}</Text>
                            <Text type="secondary">{copy.depositCap}: {formatMoney(strategyState?.plan?.max_deposit_total)}</Text>
                            <Text type="secondary">{copy.strategyLimit}: {formatNumber(strategyState?.plan?.max_strategies_total, 0)}</Text>
                          </Space>
                        </Col>
                      </Row>
                    </Card>

                    {strategyState ? (
                      <>
                        <Card className="battletoads-card">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} lg={12}>
                              <Text strong>{copy.risk}</Text>
                              <div className="saas-segment-wrap">
                                <Segmented block options={strategyLevelOptions} value={strategyRiskLevel} onChange={(value) => setStrategyRiskLevel(value as Level3)} />
                              </div>
                            </Col>
                            <Col xs={24} lg={12}>
                              <Text strong>{copy.tradeFrequency}</Text>
                              <div className="saas-segment-wrap">
                                <Segmented block options={strategyLevelOptions} value={strategyTradeLevel} onChange={(value) => setStrategyTradeLevel(value as Level3)} />
                              </div>
                            </Col>
                          </Row>
                          <Space wrap style={{ marginTop: 16 }}>
                            <Button type="primary" onClick={() => void saveStrategyProfile()} loading={actionLoading === 'strategy-save'}>{copy.saveProfile}</Button>
                            <Button onClick={() => void runMaterialize()} loading={actionLoading === 'strategy-materialize'}>{copy.materialize}</Button>
                          </Space>
                        </Card>

                        <Card className="battletoads-card" title={copy.selectedOffers}>
                          <Table rowKey="offerId" columns={offerColumns} dataSource={strategyState.offers || []} pagination={false} scroll={{ x: 920 }} />
                        </Card>

                        <Card className="battletoads-card" title={copy.previewTitle}>
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

                          {strategyPreview ? (
                            <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
                              <Col xs={24} lg={8}>
                                <Descriptions column={1} size="small" bordered>
                                  <Descriptions.Item label="Offer">{strategyPreview.offer.titleRu}</Descriptions.Item>
                                  <Descriptions.Item label={copy.score}>{formatNumber(strategyPreview.preset.score)}</Descriptions.Item>
                                  <Descriptions.Item label={copy.returnLabel}>{formatPercent((strategyPreviewSummary as any)?.totalReturnPercent ?? strategyPreview.preset.metrics.ret)}</Descriptions.Item>
                                  <Descriptions.Item label={copy.drawdown}>{formatPercent((strategyPreviewSummary as any)?.maxDrawdownPercent ?? strategyPreview.preset.metrics.dd)}</Descriptions.Item>
                                  <Descriptions.Item label={copy.profitFactor}>{formatNumber((strategyPreviewSummary as any)?.profitFactor ?? strategyPreview.preset.metrics.pf)}</Descriptions.Item>
                                  <Descriptions.Item label={copy.trades}>{formatNumber((strategyPreviewSummary as any)?.tradesCount ?? strategyPreview.preset.metrics.trades, 0)}</Descriptions.Item>
                                </Descriptions>
                              </Col>
                              <Col xs={24} lg={16}>
                                {strategyPreviewPoints.length > 0 ? <ChartComponent data={strategyPreviewPoints} type="line" /> : <Empty description={copy.noCatalog} />}
                              </Col>
                            </Row>
                          ) : (
                            <Empty style={{ marginTop: 16 }} description={copy.previewTitle} />
                          )}
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
                  {renderGitUpdateCard(copy.algofund, true)}
                  {algofundTenants.length === 0 ? <Alert type="info" showIcon message={copy.noTenant} /> : null}
                  {algofundError ? <Alert type="error" showIcon message={algofundError} /> : null}

                  <Spin spinning={algofundLoading && !algofundState}>
                    <Card className="battletoads-card">
                      <Row gutter={[16, 16]} align="middle">
                        <Col xs={24} md={8}>
                          <Text strong>{copy.chooseTenant}</Text>
                          <Select
                            style={{ width: '100%', marginTop: 8 }}
                            value={algofundTenantId ?? undefined}
                            onChange={(value) => setAlgofundTenantId(Number(value))}
                            options={algofundTenants.map((item) => ({ value: item.tenant.id, label: `${item.tenant.display_name} (${item.tenant.slug})` }))}
                          />
                        </Col>
                        <Col xs={24} md={8}>
                          <Text strong>{copy.apiKey}</Text>
                          <Select style={{ width: '100%', marginTop: 8 }} value={algofundApiKeyName || undefined} onChange={setAlgofundApiKeyName} options={apiKeyOptions} />
                        </Col>
                        <Col xs={24} md={8}>
                          <Space direction="vertical" size={4}>
                            <Text strong>{copy.plan}</Text>
                            <Text>{algofundState?.plan ? `${algofundState.plan.title} · ${formatMoney(algofundState.plan.price_usdt)}` : '—'}</Text>
                            <Text type="secondary">{copy.depositCap}: {formatMoney(algofundState?.plan?.max_deposit_total)}</Text>
                            <Text type="secondary">{copy.riskCap}: {formatNumber(algofundState?.plan?.risk_cap_max)}</Text>
                          </Space>
                        </Col>
                      </Row>
                    </Card>

                    {algofundState ? (
                      <>
                        <Card className="battletoads-card">
                          <Row gutter={[16, 16]} align="middle">
                            <Col xs={24} lg={16}>
                              <Text strong>{copy.risk}: {formatNumber(algofundRiskMultiplier)}</Text>
                              <Slider
                                min={0.25}
                                max={Number(algofundState.plan?.risk_cap_max || 1)}
                                step={0.05}
                                value={algofundRiskMultiplier}
                                onChange={(value) => setAlgofundRiskMultiplier(Number(value))}
                              />
                            </Col>
                            <Col xs={24} lg={8}>
                              <Space wrap style={{ marginTop: 24 }}>
                                <Button type="primary" onClick={() => void saveAlgofundProfile()} loading={actionLoading === 'algofund-save'}>{copy.saveProfile}</Button>
                                <Button onClick={() => void refreshAlgofundPreview()}>{copy.preview}</Button>
                              </Space>
                            </Col>
                          </Row>
                        </Card>

                        <Card className="battletoads-card" title={copy.previewTitle}>
                          <Row gutter={[16, 16]}>
                            <Col xs={24} lg={8}>
                              <Descriptions column={1} size="small" bordered>
                                <Descriptions.Item label={copy.sourceSystem}>{algofundState.preview?.sourceSystem?.systemName || '—'}</Descriptions.Item>
                                <Descriptions.Item label={copy.finalEquity}>{formatMoney(algofundState.preview?.summary?.finalEquity)}</Descriptions.Item>
                                <Descriptions.Item label={copy.returnLabel}>{formatPercent(algofundState.preview?.summary?.totalReturnPercent)}</Descriptions.Item>
                                <Descriptions.Item label={copy.drawdown}>{formatPercent(algofundState.preview?.summary?.maxDrawdownPercent)}</Descriptions.Item>
                                <Descriptions.Item label={copy.profitFactor}>{formatNumber(algofundState.preview?.summary?.profitFactor)}</Descriptions.Item>
                                <Descriptions.Item label={copy.trades}>{formatNumber(algofundState.preview?.summary?.tradesCount, 0)}</Descriptions.Item>
                              </Descriptions>
                            </Col>
                            <Col xs={24} lg={16}>
                              {algofundPreviewPoints.length > 0 ? <ChartComponent data={algofundPreviewPoints} type="line" /> : <Empty description={copy.previewTitle} />}
                            </Col>
                          </Row>
                        </Card>

                        <Card className="battletoads-card" title="Client requests">
                          <Row gutter={[16, 16]}>
                            <Col xs={24} lg={16}>
                              <Input.TextArea rows={3} value={algofundNote} onChange={(event) => setAlgofundNote(event.target.value)} placeholder={copy.note} />
                              <Space wrap style={{ marginTop: 12 }}>
                                <Button type="primary" onClick={() => void sendAlgofundRequest('start')} loading={actionLoading === 'algofund-start'}>{copy.requestStart}</Button>
                                <Button danger onClick={() => void sendAlgofundRequest('stop')} loading={actionLoading === 'algofund-stop'}>{copy.requestStop}</Button>
                                {algofundState.profile.actual_enabled ? <Tag color="success">live enabled</Tag> : <Tag color="default">live disabled</Tag>}
                                {algofundState.profile.requested_enabled ? <Tag color="processing">requested start</Tag> : null}
                              </Space>
                            </Col>
                            <Col xs={24} lg={8}>
                              <Descriptions column={1} size="small" bordered>
                                <Descriptions.Item label={copy.status}>{algofundState.tenant.status}</Descriptions.Item>
                                <Descriptions.Item label={copy.apiKey}>{algofundState.profile.assigned_api_key_name || algofundState.tenant.assigned_api_key_name || '—'}</Descriptions.Item>
                                <Descriptions.Item label={copy.riskCap}>{formatNumber(algofundState.plan?.risk_cap_max)}</Descriptions.Item>
                              </Descriptions>
                            </Col>
                          </Row>
                        </Card>

                        <Card className="battletoads-card" title={copy.requestQueue}>
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Input.TextArea rows={2} value={algofundDecisionNote} onChange={(event) => setAlgofundDecisionNote(event.target.value)} placeholder={copy.decisionNote} />
                            <Table rowKey="id" columns={requestColumns} dataSource={algofundState.requests || []} pagination={false} scroll={{ x: 960 }} />
                          </Space>
                        </Card>
                      </>
                    ) : null}
                  </Spin>
                </Space>
              ),
            },
          ]}
        />
      </Spin>
    </div>
  );
};

export default SaaS;

/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Pagination,
  Row,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Statistic,
  Tag,
  Tabs,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

type ProductMode = 'strategy_client' | 'algofund_client' | 'dual';
type Level3 = 'low' | 'medium' | 'high';

type MetricSet = {
  ret?: number;
  pf?: number;
  dd?: number;
  wr?: number;
  trades?: number;
  score?: number;
};

type TenantCapabilities = {
  settings: boolean;
  apiKeyUpdate: boolean;
  monitoring: boolean;
  backtest: boolean;
  startStopRequests: boolean;
};

type Plan = {
  code: string;
  title: string;
  price_usdt: number;
  original_price_usdt: number | null;
  max_deposit_total: number;
  max_strategies_total: number;
  risk_cap_max: number;
};

type Tenant = {
  id: number;
  slug: string;
  display_name: string;
  product_mode: ProductMode;
  status: string;
};

type GuideItem = {
  id: string;
  title: string;
  downloadUrl?: string;
  contentUrl?: string;
};

type GuideContentPayload = {
  id: string;
  title: string;
  content: string;
};

type ClientApiKeyDraft = {
  exchange: string;
  apiKey: string;
  secret: string;
  passphrase: string;
  testnet: boolean;
  demo: boolean;
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

type StrategyOffer = {
  offerId: string;
  titleRu: string;
  strategy: {
    market: string;
    mode: 'mono' | 'synth';
    type: string;
    params?: {
      interval?: string;
      length?: number;
      takeProfitPercent?: number;
      detectionSource?: string;
      zscoreEntry?: number;
      zscoreExit?: number;
      zscoreStop?: number;
    };
  };
  metrics: MetricSet;
  equityPoints?: number[];
  equity?: {
    points?: Array<{ time: number; equity: number }>;
    summary?: {
      finalEquity?: number;
      totalReturnPercent?: number;
      maxDrawdownPercent?: number;
      winRatePercent?: number;
      profitFactor?: number;
      tradesCount?: number;
    };
  };
};

type StrategyState = {
  tenant: Tenant;
  plan: Plan | null;
  capabilities?: TenantCapabilities;
  monitoring?: Record<string, unknown> | null;
  profile: {
    selectedOfferIds: string[];
    risk_level: Level3;
    trade_frequency_level: Level3;
    requested_enabled: number;
    actual_enabled: number;
    assigned_api_key_name?: string;
    activeSystemProfileId?: number | null;
  } | null;
  offers: StrategyOffer[];
};

type StrategySelectionPreviewResponse = {
  selectedOffers: Array<{
    offerId: string;
    titleRu: string;
    market: string;
    mode: 'mono' | 'synth';
    score: number;
  }>;
  preview: {
    summary?: Record<string, unknown> | null;
    equity?: EquityPoint[] | { points?: EquityPoint[] };
  };
  controls?: {
    riskLevel?: Level3;
    tradeFrequencyLevel?: Level3;
  };
};

type AlgofundRequest = {
  id: number;
  request_type: 'start' | 'stop';
  status: 'pending' | 'approved' | 'rejected';
  note: string;
  decision_note: string;
  created_at: string;
};

type StrategyBacktestPairRequest = {
  id: number;
  tenant_id: number;
  base_symbol: string;
  quote_symbol: string;
  interval: string;
  note: string;
  status: 'pending' | 'approved' | 'in_sweep' | 'done' | 'rejected' | 'ignored';
  created_at: string;
  decided_at: string | null;
};

type AlgofundState = {
  tenant: Tenant;
  plan: Plan | null;
  capabilities?: TenantCapabilities;
  profile: {
    risk_multiplier: number;
    requested_enabled: number;
    actual_enabled: number;
    published_system_name?: string;
    assigned_api_key_name?: string;
  };
  activeSystems?: Array<{
    id: number;
    systemName: string;
    weight: number;
    isEnabled: boolean;
    assignedBy: 'admin' | 'client';
  }>;
  preview: {
    riskMultiplier: number;
    summary?: {
      finalEquity?: number;
      totalReturnPercent?: number;
      maxDrawdownPercent?: number;
      profitFactor?: number;
      tradesCount?: number;
    } | null;
    equityCurve?: EquityPoint[];
    blockedByPlan?: boolean;
    blockedReason?: string;
  };
  requests: AlgofundRequest[];
  availableSystems?: Array<{
    id: number;
    apiKeyName: string;
    name: string;
    isActive: boolean;
    memberCount: number;
    metrics?: {
      equityUsd?: number;
      drawdownPercent?: number;
      marginLoadPercent?: number;
      effectiveLeverage?: number;
    } | null;
    backtestSnapshot?: {
      ret: number;
      pf: number;
      dd: number;
      trades: number;
      tradesPerDay: number;
      periodDays: number;
      finalEquity: number;
      equityPoints: number[];
    } | null;
  }>;
};

type ClientApiKeyInfo = {
  id: number;
  name: string;
  exchange: string;
  testnet: boolean;
  demo: boolean;
  createdAt: string;
  updatedAt: string;
  isAssigned: boolean;
  usedByStrategy?: boolean;
  usedByAlgofund?: boolean;
};

type TariffPlan = {
  code: string;
  title: string;
  price_usdt: number;
  original_price_usdt: number | null;
  max_deposit_total: number;
  max_strategies_total: number;
  risk_cap_max: number;
  allow_ts_start_stop_requests: number;
};

type TariffRequestItem = {
  id: number;
  createdAt: string;
  payload: {
    targetPlanCode?: string;
    targetPlanTitle?: string;
    note?: string;
  };
};

type TariffPayload = {
  success: boolean;
  productMode: ProductMode;
  currentPlan: TariffPlan | null;
  availablePlans: TariffPlan[];
  requests: TariffRequestItem[];
};

type MonitoringPayload = {
  success: boolean;
  apiKeyName: string;
  latest: {
    equity_usd?: number;
    drawdown_pct?: number;
    unrealized_pnl_usd?: number;
    margin_usage_pct?: number;
    ts?: string;
  } | null;
  points: Array<{
    ts?: string;
    recorded_at?: string;
    equity_usd?: number;
    equity?: number;
    value?: number;
    time?: number;
  }>;
  streams?: {
    strategy?: {
      apiKeyName?: string;
      latest?: Record<string, unknown> | null;
      points?: Array<Record<string, unknown>>;
    };
    algofund?: {
      apiKeyName?: string;
      latest?: Record<string, unknown> | null;
      points?: Array<Record<string, unknown>>;
    };
  };
};

type ClientAuthUser = {
  id: number;
  email: string;
  fullName: string;
  onboardingCompletedAt: string | null;
  tenantId: number;
  tenantSlug: string;
  tenantDisplayName: string;
  tenantStatus: string;
  productMode: ProductMode;
};

type WorkspacePayload = {
  success: boolean;
  productMode: ProductMode;
  auth: {
    token: string;
    expiresAt: string;
    workspaceRoute: string;
    user: ClientAuthUser;
  };
  strategyState: StrategyState | null;
  algofundState: AlgofundState | null;
};

const CLIENT_SESSION_STORAGE_KEY = 'clientSessionToken';

const toFinite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const formatNumber = (value: unknown, digits = 2): string => toFinite(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
const formatPercent = (value: unknown, digits = 2): string => `${formatNumber(value, digits)}%`;
const formatMoney = (value: unknown): string => `$${formatNumber(value, 2)}`;

const normalizeTime = (value: unknown): number | null => {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  if (typeof value === 'string' && value.length >= 10) {
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return null;
};

const toLineSeriesData = (payload: unknown): LinePoint[] => {
  const raw = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray((payload as any).points)
      ? (payload as any).points
      : []);

  const points = raw
    .map((row: any) => {
      const time = normalizeTime(row?.time ?? row?.[0]);
      const value = Number(row?.equity ?? row?.value ?? row?.[1]);
      if (time === null || !Number.isFinite(value)) {
        return null;
      }
      return { time, value };
    })
    .filter((item: LinePoint | null): item is LinePoint => !!item)
    .sort((left: LinePoint, right: LinePoint) => left.time - right.time);

  if (points.length <= 1) {
    return points;
  }

  const deduped: LinePoint[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.time === point.time) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    deduped.push(point);
  }

  return deduped;
};

const sliderValueToLevel = (value: number): Level3 => {
  if (value <= 3.33) return 'low';
  if (value >= 6.67) return 'high';
  return 'medium';
};

const levelToSliderValue = (level: Level3): number => {
  if (level === 'low') return 0;
  if (level === 'high') return 10;
  return 5;
};

const equityPointsToSeries = (points: number[], periodDays?: number): LinePoint[] => {
  if (!Array.isArray(points) || points.length < 2) return [];
  const days = Number(periodDays) > 0 ? Number(periodDays) : 365;
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86400;
  const step = (endTs - startTs) / Math.max(points.length - 1, 1);
  return points.map((v, i) => ({ time: Math.floor(startTs + i * step), value: v }));
};

const normalizeOfferEquityValues = (points: number[], offer?: StrategyOffer | null): number[] => {
  if (!Array.isArray(points) || points.length < 2) {
    return Array.isArray(points) ? points : [];
  }

  const initialBalance = 10000;
  const firstDistance = Math.abs(Number(points[0] || 0) - initialBalance);
  const lastDistance = Math.abs(Number(points[points.length - 1] || 0) - initialBalance);

  if (lastDistance + 1e-6 < firstDistance) {
    return [...points].reverse();
  }

  return points;
};

/** Extract flat equity number[] from offer (supports both equityPoints and equity.points) */
const getOfferEquityValues = (offer: StrategyOffer): number[] => {
  if (Array.isArray(offer.equityPoints) && offer.equityPoints.length > 0) return normalizeOfferEquityValues(offer.equityPoints, offer);
  if (offer.equity?.points && Array.isArray(offer.equity.points) && offer.equity.points.length > 0) {
    return normalizeOfferEquityValues(offer.equity.points.map((p) => p.equity), offer);
  }
  return [];
};

const getIntervalSortRank = (intervalRaw?: string): number => {
  const interval = String(intervalRaw || '').trim().toLowerCase();
  switch (interval) {
    case '4h':
      return 0;
    case '1h':
      return 1;
    case '15m':
      return 2;
    case '5m':
      return 3;
    default:
      return 9;
  }
};

const getOfferDescription = (offer: any, detailed: boolean = false): string => {
  const type = String(offer?.strategy?.type || '').trim();
  const mode = String(offer?.strategy?.mode || '').toLowerCase();
  const market = String(offer?.strategy?.market || '');
  const interval = String(offer?.strategy?.params?.interval || '');
  const length = Number(offer?.strategy?.params?.length || 0);
  const tp = Number(offer?.strategy?.params?.takeProfitPercent || 0);
  const src = String(offer?.strategy?.params?.detectionSource || '');
  const ze = Number(offer?.strategy?.params?.zscoreEntry || 0);
  const zx = Number(offer?.strategy?.params?.zscoreExit || 0);
  const zs = Number(offer?.strategy?.params?.zscoreStop || 0);
  const modeLabel = mode === 'synth' ? 'Синтетическая пара' : 'Моно-пара';

  if (!detailed) {
    // Client-facing: marketing / summary
    if (type.includes('stat_arb') || type.includes('zscore')) {
      return `Арбитражная стратегия возврата к среднему\n${modeLabel} ${market} • Таймфрейм ${interval}\nОткрывает сделки при аномальном отклонении цены — зарабатывает на возврате к норме. Лучше всего в боковом рынке.`;
    }
    if (type.includes('zz_breakout') || type.includes('zigzag')) {
      return `Канальная стратегия прорыва\n${modeLabel} ${market} • Таймфрейм ${interval}\nЛовит сильные движения при пробое ценового канала. Частые входы, короткие удержания.`;
    }
    if (type.includes('DD_BattleToads') || type.includes('dd_battletoads')) {
      return `Трендовая стратегия DoubleDragon\n${modeLabel} ${market} • Таймфрейм ${interval}\nВходит при пробое канала Дончиана, фиксирует прибыль трейлинговым тейк-профитом от пика позиции.`;
    }
    return `Стратегия ${type}\n${modeLabel} ${market} • Таймфрейм ${interval}`;
  }

  // Admin-facing: full technical detail
  let lines: string[] = [];
  if (type.includes('stat_arb') || type.includes('zscore')) {
    lines.push('StatArb Z-Score — возврат к среднему');
    lines.push(`Вход: Z-score ≥ ${ze} (отклонение на ${ze}σ от скользящего среднего)`);
    lines.push(`Выход: Z-score ≤ ${zx} (возврат к среднему)`);
    lines.push(`Стоп: Z-score ≥ ${zs} (аварийный стоп-лосс при ${zs}σ)`);
  } else if (type.includes('zz_breakout') || type.includes('zigzag')) {
    lines.push('ZigZag Breakout — пробой канала Дончиана (короткий период)');
    lines.push(`Вход: Лонг при пробое ${length}-бар максимума / Шорт при пробое ${length}-бар минимума`);
    lines.push(`Выход: Трейлинговый TP ${tp}% от пика позиции`);
    lines.push(`Источник: ${src || 'close'} • Без фиксированного SL (TP выступает и как SL)`);
  } else if (type.includes('DD_BattleToads') || type.includes('dd_battletoads')) {
    lines.push('DoubleDragon Breakout — пробой канала Дончиана');
    lines.push(`Вход: Лонг при пробое ${length}-бар максимума / Шорт при пробое ${length}-бар минимума`);
    lines.push(`Выход: Трейлинговый TP ${tp}% от пика позиции`);
    lines.push(`Источник: ${src || 'close'} • Адаптивный период канала`);
  } else {
    lines.push(`Стратегия ${type}`);
  }
  lines.push(`${modeLabel} ${market} • Таймфрейм ${interval} • Период канала: ${length}`);
  if (ze) lines.push(`Z-score: entry=${ze}, exit=${zx}, stop=${zs}`);
  if (tp) lines.push(`Take-profit: ${tp}%`);
  return lines.join('\n');
};

const getTsHint = (systemName: string): string | null => {
  const upper = String(systemName || '').toUpperCase();
  if (upper.includes('_SA_') || upper.includes('STAT_ARB') || upper.includes('STATARB') || upper.includes('-SA-')) {
    return 'StatArb Z-Score — возврат к среднему\nОткрывает позицию когда цена отклоняется на ≥N σ от скользящего среднего пары.';
  }
  if (upper.includes('_ZZ_') || upper.includes('ZIGZAG') || upper.includes('-ZZ-') || upper.includes('ZZ_BREAKOUT')) {
    return 'ZigZag Breakout — пробой канала\nЛонг/шорт при пробое N-бар максимума/минимума по Дончиану.';
  }
  if (upper.includes('_DD_') || upper.includes('BTDD') || upper.includes('DD_BATTLETOADS') || upper.includes('-DD-')) {
    return 'DoubleDragon Breakout — пробой канала Дончиана\nТрейлинговый TP от пика позиции.';
  }
  if (upper.includes('MULTISET') || upper.includes('CURATED') || upper.includes('BALANCED')) {
    return 'Мультистратегия — портфель из нескольких стратегий\nДиверсификация рисков за счёт множества пар и типов.';
  }
  return null;
};

const tsDisplayName = (systemName: string): string => {
  const parts = String(systemName || '').trim().split('::').filter(Boolean);
  let token = String(parts[parts.length - 1] || '').trim().toLowerCase();
  token = token.replace(/^algofund-master-btdd-d1-/, '');
  token = token.replace(/-h-([a-z0-9]{4,})$/i, '-$1');
  return token || systemName;
};

const capabilityTag = (label: string, enabled: boolean) => <Tag color={enabled ? 'success' : 'default'}>{label}: {enabled ? 'on' : 'off'}</Tag>;

const CLIENT_STOREFRONT_PAGE_SIZE = 24;
type ClientCabinetTabKey = 'strategy' | 'algofund' | 'settings';

const ClientCabinet: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [activeTabKey, setActiveTabKey] = useState<ClientCabinetTabKey>('strategy');
  const [strategyStateExtra, setStrategyStateExtra] = useState<StrategyState | null>(null);
  const [algofundStateExtra, setAlgofundStateExtra] = useState<AlgofundState | null>(null);
  const [guides, setGuides] = useState<GuideItem[]>([]);
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  const [guideModalTitle, setGuideModalTitle] = useState('');
  const [guideModalContent, setGuideModalContent] = useState('');
  const [clientApiKeys, setClientApiKeys] = useState<ClientApiKeyInfo[]>([]);
  const [tariff, setTariff] = useState<TariffPayload | null>(null);
  const [targetPlanCode, setTargetPlanCode] = useState('');
  const [tariffNote, setTariffNote] = useState('');
  const [monitoring, setMonitoring] = useState<MonitoringPayload | null>(null);
  const [monitoringDays, setMonitoringDays] = useState(1);
  const [monitoringModalVisible, setMonitoringModalVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState<ClientApiKeyDraft>({
    exchange: 'bybit',
    apiKey: '',
    secret: '',
    passphrase: '',
    testnet: false,
    demo: false,
  });
  const [editingApiKeyId, setEditingApiKeyId] = useState<number | null>(null);
  const [editingApiKeyName, setEditingApiKeyName] = useState('');
  const [strategyAssignedApiKeyName, setStrategyAssignedApiKeyName] = useState('');
  const [algofundAssignedApiKeyName, setAlgofundAssignedApiKeyName] = useState('');

  const [strategyOfferIds, setStrategyOfferIds] = useState<string[]>([]);
  const [strategyRiskInput, setStrategyRiskInput] = useState(5);
  const [strategyTradeInput, setStrategyTradeInput] = useState(5);
  const [offerFilterInstrument, setOfferFilterInstrument] = useState<string>('all');
  const [offerSortBy, setOfferSortBy] = useState<'ret' | 'dd' | 'pf' | 'trades'>('ret');
  const [clientStorefrontPage, setClientStorefrontPage] = useState(1);
  const [algofundStorefrontPageState, setAlgofundStorefrontPageState] = useState(1);
  const [strategySelectionPreview, setStrategySelectionPreview] = useState<StrategySelectionPreviewResponse | null>(null);
  const [strategySelectionPreviewLoading, setStrategySelectionPreviewLoading] = useState(false);
  const [singleOfferPreview, setSingleOfferPreview] = useState<any>(null);
  const [singleOfferPreviewLoading, setSingleOfferPreviewLoading] = useState(false);
  const [backtestRequests, setBacktestRequests] = useState<StrategyBacktestPairRequest[]>([]);
  const [requestMarket, setRequestMarket] = useState('');
  const [requestInterval, setRequestInterval] = useState('1h');
  const [requestNote, setRequestNote] = useState('');

  const [algofundRiskMultiplier, setAlgofundRiskMultiplier] = useState(1);
  const algofundInitializedRef = useRef(false);
  const [algofundNote, setAlgofundNote] = useState('');
  const [systemDetailModal, setSystemDetailModal] = useState<{ name: string; id: number } | null>(null);
  const [tsModalRiskMultiplier, setTsModalRiskMultiplier] = useState(1);
  const [strategyOfferDetail, setStrategyOfferDetail] = useState<string | null>(null);

  const strategyState = workspace?.strategyState || null;
  const algofundState = workspace?.algofundState || null;
  const strategyWorkspace = strategyState || strategyStateExtra;
  const algofundWorkspace = algofundState || algofundStateExtra;
  const clientUser = workspace?.auth?.user || null;
  const onboardingCompleted = Boolean(clientUser?.onboardingCompletedAt);

  useEffect(() => {
    if (!workspace) return;
    setActiveTabKey(workspace.productMode === 'algofund_client' ? 'algofund' : 'strategy');
  }, [workspace]);

  const strategyPreviewSummary = strategySelectionPreview?.preview?.summary || {};
  const strategyPreviewSeries = useMemo(() => toLineSeriesData(strategySelectionPreview?.preview?.equity), [strategySelectionPreview]);
  const singleOfferPreviewSummary = singleOfferPreview?.preview?.summary || singleOfferPreview?.preview?.equity?.summary || null;
  const singleOfferPreviewSeries = useMemo(() => toLineSeriesData(singleOfferPreview?.preview?.equity), [singleOfferPreview]);
  const algofundPreviewSeries = useMemo(() => toLineSeriesData(algofundWorkspace?.preview?.equityCurve), [algofundWorkspace]);

  const strategyPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!strategyWorkspace) return;
    if (strategyPreviewTimerRef.current) clearTimeout(strategyPreviewTimerRef.current);
    strategyPreviewTimerRef.current = setTimeout(() => { void runStrategySelectionPreview(); }, 600);
    return () => { if (strategyPreviewTimerRef.current) clearTimeout(strategyPreviewTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyRiskInput, strategyTradeInput]);

  // Per-offer preview: triggers when modal opens or sliders change
  const singleOfferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!strategyOfferDetail) { setSingleOfferPreview(null); return; }
    if (singleOfferTimerRef.current) clearTimeout(singleOfferTimerRef.current);
    singleOfferTimerRef.current = setTimeout(() => { void runSingleOfferPreview(strategyOfferDetail); }, 400);
    return () => { if (singleOfferTimerRef.current) clearTimeout(singleOfferTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyOfferDetail, strategyRiskInput, strategyTradeInput]);

  const algofundPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!algofundWorkspace) return;
    if (algofundPreviewTimerRef.current) clearTimeout(algofundPreviewTimerRef.current);
    algofundPreviewTimerRef.current = setTimeout(() => { void refreshAlgofundState(); }, 600);
    return () => { if (algofundPreviewTimerRef.current) clearTimeout(algofundPreviewTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [algofundRiskMultiplier]);

  const algofundPublishedSystemName = String((algofundWorkspace?.profile as any)?.published_system_name || '').trim();
  const algofundAssignedApiKey = String((algofundWorkspace?.profile as any)?.assigned_api_key_name || '').trim();
  const algofundAvailableSystems = Array.isArray(algofundWorkspace?.availableSystems) ? (algofundWorkspace?.availableSystems || []) : [];
  const algofundActiveSystems = Array.isArray(algofundWorkspace?.activeSystems) ? (algofundWorkspace?.activeSystems || []) : [];
  const enabledAlgofundSystemNames = new Set(
    algofundActiveSystems
      .filter((item) => item && item.isEnabled)
      .map((item) => String(item.systemName || '').trim())
      .filter(Boolean)
  );
  if (enabledAlgofundSystemNames.size === 0 && algofundPublishedSystemName) {
    enabledAlgofundSystemNames.add(algofundPublishedSystemName);
  }
  const isAlgofundSystemEnabled = (systemNameRaw: unknown): boolean => {
    const systemName = String(systemNameRaw || '').trim();
    return Boolean(systemName) && enabledAlgofundSystemNames.has(systemName);
  };
  const monitoringSeries = useMemo(
    () => toLineSeriesData((monitoring?.points || []).map((point) => ({
      time: point.time ?? point.ts ?? point.recorded_at,
      equity: point.equity_usd ?? point.equity ?? point.value,
    }))),
    [monitoring]
  );

  const strategyStorefrontOffers = useMemo(() => {
    const workspaceOffers = strategyWorkspace?.offers;
    const offers = Array.isArray(workspaceOffers) ? [...workspaceOffers] : [];
    return offers
      .filter((offer) => offerFilterInstrument === 'all' || offer.strategy.market === offerFilterInstrument)
      .sort((a, b) => {
        const aSelected = strategyOfferIds.includes(a.offerId) ? 0 : 1;
        const bSelected = strategyOfferIds.includes(b.offerId) ? 0 : 1;
        if (aSelected !== bSelected) return aSelected - bSelected;

        if (offerSortBy === 'ret') return Number(b.metrics.ret || 0) - Number(a.metrics.ret || 0);
        if (offerSortBy === 'dd') return Number(a.metrics.dd || 0) - Number(b.metrics.dd || 0);
        if (offerSortBy === 'pf') return Number(b.metrics.pf || 0) - Number(a.metrics.pf || 0);
        if (offerSortBy === 'trades') return Number(b.metrics.trades || 0) - Number(a.metrics.trades || 0);

        return Number(b.metrics.ret || 0) - Number(a.metrics.ret || 0);
      });
  }, [strategyWorkspace?.offers, offerFilterInstrument, offerSortBy, strategyOfferIds]);

  const strategyStorefrontPageCount = Math.max(1, Math.ceil(strategyStorefrontOffers.length / CLIENT_STOREFRONT_PAGE_SIZE));
  const strategyStorefrontPage = Math.min(clientStorefrontPage, strategyStorefrontPageCount);
  const strategyStorefrontPagedOffers = strategyStorefrontOffers.slice(
    (strategyStorefrontPage - 1) * CLIENT_STOREFRONT_PAGE_SIZE,
    strategyStorefrontPage * CLIENT_STOREFRONT_PAGE_SIZE,
  );

  const algofundSortedSystems = useMemo(() => {
    return [...algofundAvailableSystems].sort((a, b) => {
      const aCurrent = isAlgofundSystemEnabled(a?.name) ? 0 : 1;
      const bCurrent = isAlgofundSystemEnabled(b?.name) ? 0 : 1;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
      const aRet = Number((a as any)?.backtestSnapshot?.ret || 0);
      const bRet = Number((b as any)?.backtestSnapshot?.ret || 0);
      if (aRet !== bRet) return bRet - aRet;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    });
  }, [algofundAvailableSystems, enabledAlgofundSystemNames]);

  const algofundStorefrontPageCount = Math.max(1, Math.ceil(algofundSortedSystems.length / CLIENT_STOREFRONT_PAGE_SIZE));
  const algofundStorefrontPage = Math.min(algofundStorefrontPageState, algofundStorefrontPageCount);

  const algofundStorefrontPagedSystems = algofundSortedSystems.slice(
    (algofundStorefrontPage - 1) * CLIENT_STOREFRONT_PAGE_SIZE,
    algofundStorefrontPage * CLIENT_STOREFRONT_PAGE_SIZE,
  );

  const closeStrategyOfferModal = () => {
    setStrategyOfferDetail(null);
    setSingleOfferPreview(null);
    setSingleOfferPreviewLoading(false);
    setStrategyRiskInput(levelToSliderValue(strategyWorkspace?.profile?.risk_level || 'medium'));
    setStrategyTradeInput(levelToSliderValue(strategyWorkspace?.profile?.trade_frequency_level || 'medium'));
  };

  const closeSystemDetailModal = () => {
    setSystemDetailModal(null);
    setTsModalRiskMultiplier(1);
    setAlgofundRiskMultiplier(toFinite(algofundWorkspace?.profile?.risk_multiplier, 1));
  };

  useEffect(() => {
    if (clientStorefrontPage !== strategyStorefrontPage) {
      setClientStorefrontPage(strategyStorefrontPage);
    }
  }, [clientStorefrontPage, strategyStorefrontPage]);

  useEffect(() => {
    if (algofundStorefrontPageState !== algofundStorefrontPage) {
      setAlgofundStorefrontPageState(algofundStorefrontPage);
    }
  }, [algofundStorefrontPageState, algofundStorefrontPage]);

  const loadWorkspace = async () => {
    setLoading(true);
    setErrorText('');

    try {
      const loadMonitoringWithRetry = async () => {
        try {
          return await axios.get<MonitoringPayload>('/api/client/monitoring');
        } catch (error: any) {
          const status = Number(error?.response?.status || 0);
          if (status === 502 || status === 503 || status === 504) {
            return axios.get<MonitoringPayload>('/api/client/monitoring');
          }
          throw error;
        }
      };

      const [workspaceResponse, guidesResponse] = await Promise.all([
        axios.get<WorkspacePayload>('/api/client/workspace'),
        axios.get<{ guides?: GuideItem[] }>('/api/client/guides'),
      ]);

      setWorkspace(workspaceResponse.data);
      setGuides(Array.isArray(guidesResponse.data?.guides) ? guidesResponse.data.guides : []);

      const [strategyResponse, algofundResponse, apiKeysResponse, tariffResponse, monitoringResponse] = await Promise.allSettled([
        axios.get<{ success: boolean; state: StrategyState }>('/api/client/strategy/state'),
        axios.get<{ success: boolean; state: AlgofundState }>('/api/client/algofund/state'),
        axios.get<{ success: boolean; keys: ClientApiKeyInfo[] }>('/api/client/api-keys'),
        axios.get<TariffPayload>('/api/client/tariff'),
        loadMonitoringWithRetry(),
      ]);

      setStrategyStateExtra(strategyResponse.status === 'fulfilled' ? (strategyResponse.value.data?.state || null) : null);
      setAlgofundStateExtra(algofundResponse.status === 'fulfilled' ? (algofundResponse.value.data?.state || null) : null);
      setClientApiKeys(apiKeysResponse.status === 'fulfilled' ? (apiKeysResponse.value.data?.keys || []) : []);
      setTariff(tariffResponse.status === 'fulfilled' ? (tariffResponse.value.data || null) : null);
      setMonitoring(monitoringResponse.status === 'fulfilled' ? (monitoringResponse.value.data || null) : null);
    } catch (error: any) {
      setErrorText(String(error?.response?.data?.error || error?.message || t('client.workspace.loadFailed', 'Failed to load client workspace')));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, []);

  useEffect(() => {
    if (!strategyWorkspace?.profile) {
      return;
    }

    setStrategyOfferIds(Array.isArray(strategyWorkspace.profile.selectedOfferIds) ? strategyWorkspace.profile.selectedOfferIds : []);
    setStrategyRiskInput(levelToSliderValue(strategyWorkspace.profile.risk_level || 'medium'));
    setStrategyTradeInput(levelToSliderValue(strategyWorkspace.profile.trade_frequency_level || 'medium'));
    setStrategyAssignedApiKeyName(String(strategyWorkspace.profile.assigned_api_key_name || '').trim());
  }, [strategyWorkspace]);

  useEffect(() => {
    if (!algofundWorkspace?.profile) {
      return;
    }

    if (!algofundInitializedRef.current) {
      setAlgofundRiskMultiplier(toFinite(algofundWorkspace.profile.risk_multiplier, 1));
      algofundInitializedRef.current = true;
    }
    setAlgofundAssignedApiKeyName(String(algofundWorkspace.profile.assigned_api_key_name || '').trim());
  }, [algofundWorkspace]);

  useEffect(() => {
    if (workspace?.productMode === 'strategy_client' || workspace?.productMode === 'dual') {
      void loadBacktestRequests();
    }
  }, [workspace?.productMode]);

  const logoutClient = async () => {
    try {
      await axios.post('/api/auth/client/logout');
    } catch (_error) {
      // ignore logout transport errors, local cleanup still applies.
    }

    localStorage.removeItem(CLIENT_SESSION_STORAGE_KEY);
    window.dispatchEvent(new Event('auth-changed'));
    navigate('/client/login');
  };

  const markOnboardingCompleted = async () => {
    setActionLoading('onboarding');
    try {
      await axios.post('/api/auth/client/onboarding/complete');
      messageApi.success(t('client.onboarding.completed', 'Onboarding marked as completed'));
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.onboarding.completeFailed', 'Failed to mark onboarding complete')));
    } finally {
      setActionLoading('');
    }
  };

  const saveStrategyProfile = async (requestedEnabled?: boolean) => {
    setActionLoading(requestedEnabled === undefined ? 'strategy-save' : requestedEnabled ? 'strategy-start' : 'strategy-stop');
    try {
      const response = await axios.patch('/api/client/strategy/profile', {
        selectedOfferIds: strategyOfferIds,
        riskLevel: sliderValueToLevel(strategyRiskInput),
        tradeFrequencyLevel: sliderValueToLevel(strategyTradeInput),
        assignedApiKeyName: strategyAssignedApiKeyName || undefined,
        requestedEnabled,
      });

      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          strategyState: response.data?.state || current.strategyState,
        };
      });
      messageApi.success(
        requestedEnabled === undefined
          ? t('client.strategy.saved', 'Preferences saved')
          : requestedEnabled
            ? 'Торговля включена'
            : 'Торговля выключена'
      );
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.strategy.saveFailed', 'Failed to save strategy preferences')));
    } finally {
      setActionLoading('');
    }
  };

  const runStrategySelectionPreview = async () => {
    setStrategySelectionPreviewLoading(true);
    try {
      const response = await axios.post<StrategySelectionPreviewResponse>('/api/client/strategy/selection-preview', {
        selectedOfferIds: strategyOfferIds,
        riskLevel: sliderValueToLevel(strategyRiskInput),
        tradeFrequencyLevel: sliderValueToLevel(strategyTradeInput),
        riskScore: strategyRiskInput,
        tradeFrequencyScore: strategyTradeInput,
      });

      setStrategySelectionPreview(response.data);
      messageApi.success(t('client.strategy.previewReady', 'Preview updated'));
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.strategy.previewFailed', 'Failed to build preview')));
      setStrategySelectionPreview(null);
    } finally {
      setStrategySelectionPreviewLoading(false);
    }
  };

  const runSingleOfferPreview = async (offerId: string) => {
    setSingleOfferPreviewLoading(true);
    try {
      const response = await axios.post('/api/client/strategy/preview', {
        offerId,
        riskLevel: sliderValueToLevel(strategyRiskInput),
        tradeFrequencyLevel: sliderValueToLevel(strategyTradeInput),
        riskScore: strategyRiskInput,
        tradeFrequencyScore: strategyTradeInput,
      });
      setSingleOfferPreview(response.data);
    } catch {
      setSingleOfferPreview(null);
    } finally {
      setSingleOfferPreviewLoading(false);
    }
  };

  const loadBacktestRequests = async () => {
    try {
      const response = await axios.get<{ requests: StrategyBacktestPairRequest[] }>('/api/client/strategy/backtest-requests');
      setBacktestRequests(response.data?.requests || []);
    } catch {
      // Optional endpoint on older backend versions.
    }
  };

  const sendBacktestPairRequest = async () => {
    const market = requestMarket.trim().toUpperCase();
    if (!market) {
      messageApi.warning(t('client.strategy.backtestRequest.enterMarket', 'Enter market, for example SOLUSDT or BTC/ETH'));
      return;
    }

    setActionLoading('strategy-backtest-request');
    try {
      await axios.post('/api/client/strategy/backtest-request', {
        market,
        interval: requestInterval || '1h',
        note: requestNote,
      });
      messageApi.success(t('client.strategy.backtestRequest.sent', 'Backtest pair request sent'));
      setRequestMarket('');
      setRequestNote('');
      await loadBacktestRequests();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.strategy.backtestRequest.sendFailed', 'Failed to send request')));
    } finally {
      setActionLoading('');
    }
  };

  const saveAlgofundProfile = async () => {
    setActionLoading('algofund-save');
    try {
      const response = await axios.patch('/api/client/algofund/profile', {
        riskMultiplier: algofundRiskMultiplier,
        assignedApiKeyName: algofundAssignedApiKeyName || undefined,
      });

      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          algofundState: response.data?.state || current.algofundState,
        };
      });
      messageApi.success(t('client.algofund.saved', 'Risk profile saved'));
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.algofund.saveFailed', 'Failed to save algofund profile')));
    } finally {
      setActionLoading('');
    }
  };

  const refreshAlgofundState = async () => {
    setActionLoading('algofund-refresh');
    try {
      const response = await axios.get('/api/client/algofund/state', {
        params: {
          riskMultiplier: algofundRiskMultiplier,
        },
      });

      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          algofundState: response.data?.state || current.algofundState,
        };
      });
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.algofund.refreshFailed', 'Failed to refresh algofund preview')));
    } finally {
      setActionLoading('');
    }
  };

  const sendAlgofundRequest = async (
    requestType: 'start' | 'stop',
    targetSystem?: { id: number; name: string } | null,
  ) => {
    setActionLoading(`algofund-${requestType}`);
    try {
      if (requestType === 'start' && targetSystem && Number(targetSystem.id) > 0) {
        await axios.post('/api/client/algofund/request', {
          requestType: 'switch_system',
          note: algofundNote,
          targetSystemId: Number(targetSystem.id),
          targetSystemName: String(targetSystem.name || ''),
        });
      }

      const response = await axios.post('/api/client/algofund/request', {
        requestType,
        note: algofundNote,
      });

      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          algofundState: response.data?.state || current.algofundState,
        };
      });

      setAlgofundNote('');
      messageApi.success(t('client.algofund.requestSent', 'Request sent'));
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.algofund.requestFailed', 'Failed to send request')));
    } finally {
      setActionLoading('');
    }
  };

  const openGuideModal = async (guide: GuideItem) => {
    setActionLoading(`guide-${guide.id}`);
    try {
      const contentUrl = guide.contentUrl || `/api/client/guides/${guide.id}/content`;
      const response = await axios.get<{ guide?: GuideContentPayload }>(contentUrl);
      const payload = response.data?.guide;
      if (!payload?.content) {
        throw new Error('Guide content is empty');
      }
      setGuideModalTitle(payload.title || guide.title || 'Гайд API-ключа');
      setGuideModalContent(payload.content);
      setGuideModalOpen(true);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.onboarding.guideDownloadFailed', 'Failed to open guide')));
    } finally {
      setActionLoading('');
    }
  };

  const resetApiKeyDraft = () => {
    setApiKeyDraft({
      exchange: 'bybit',
      apiKey: '',
      secret: '',
      passphrase: '',
      testnet: false,
      demo: false,
    });
    setEditingApiKeyId(null);
    setEditingApiKeyName('');
  };

  const saveClientApiKey = async () => {
    if (!apiKeyDraft.apiKey.trim() || !apiKeyDraft.secret.trim()) {
      messageApi.error(t('client.apiKey.required', 'API key and secret are required'));
      return;
    }

    const requiresPassphrase = ['bitget', 'weex'].includes(String(apiKeyDraft.exchange || '').trim().toLowerCase());
    if (requiresPassphrase && !String(apiKeyDraft.passphrase || '').trim()) {
      messageApi.error('Для Bitget и WEEX нужен passphrase');
      return;
    }

    const isEditing = editingApiKeyId !== null;
    setActionLoading('client-api-key');
    try {
      const response = isEditing
        ? await axios.patch(`/api/client/api-keys/${editingApiKeyId}`, {
            exchange: apiKeyDraft.exchange,
            apiKey: apiKeyDraft.apiKey,
            secret: apiKeyDraft.secret,
            passphrase: apiKeyDraft.passphrase,
            testnet: apiKeyDraft.testnet,
            demo: apiKeyDraft.demo,
          })
        : await axios.post('/api/client/api-key', {
            exchange: apiKeyDraft.exchange,
            apiKey: apiKeyDraft.apiKey,
            secret: apiKeyDraft.secret,
            passphrase: apiKeyDraft.passphrase,
            testnet: apiKeyDraft.testnet,
            demo: apiKeyDraft.demo,
          });

      resetApiKeyDraft();

      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          strategyState: response.data?.strategyState || current.strategyState,
          algofundState: response.data?.algofundState || current.algofundState,
        };
      });

      messageApi.success(isEditing ? 'API ключ обновлён' : t('client.apiKey.saved', 'API key saved and connected to your workspace'));
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.apiKey.saveFailed', 'Failed to save API key')));
    } finally {
      setActionLoading('');
    }
  };

  const startEditingApiKey = (item: ClientApiKeyInfo) => {
    setEditingApiKeyId(item.id);
    setEditingApiKeyName(item.name);
    setApiKeyDraft({
      exchange: item.exchange || 'bybit',
      apiKey: '',
      secret: '',
      passphrase: '',
      testnet: Boolean(item.testnet),
      demo: Boolean(item.demo),
    });
  };

  const deleteClientApiKey = async (id: number) => {
    setActionLoading(`delete-client-api-key-${id}`);
    try {
      await axios.delete(`/api/client/api-keys/${id}`);
      messageApi.success(t('client.apiKey.deleted', 'API key deleted'));
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.apiKey.deleteFailed', 'Failed to delete API key')));
    } finally {
      setActionLoading('');
    }
  };

  const sendTariffRequest = async () => {
    const planCode = targetPlanCode.trim();
    if (!planCode) {
      messageApi.warning(t('client.tariff.selectPlanWarning', 'Select target tariff plan'));
      return;
    }

    setActionLoading('tariff-request');
    try {
      await axios.post('/api/client/tariff/request', {
        targetPlanCode: planCode,
        note: tariffNote,
      });
      messageApi.success(t('client.tariff.requestSent', 'Tariff request sent'));
      setTariffNote('');
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.tariff.requestFailed', 'Failed to send tariff request')));
    } finally {
      setActionLoading('');
    }
  };

  const refreshMonitoring = async (days?: number) => {
    setActionLoading('monitoring-refresh');
    try {
      const params = days && days > 1 ? { days } : { limit: 288 };
      const response = await axios.get<MonitoringPayload>('/api/client/monitoring', { params });
      setMonitoring(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.monitoring.loadFailed', 'Failed to load monitoring')));
    } finally {
      setActionLoading('');
    }
  };

  const renderCapabilities = (capabilities?: TenantCapabilities) => {
    if (!capabilities) return null;
    return (
      <Space wrap>
        {capabilityTag('Настройки', Boolean(capabilities.settings))}
        {capabilityTag('Мониторинг', Boolean(capabilities.monitoring))}
        {capabilityTag('Бэктест', Boolean(capabilities.backtest))}
        {capabilityTag('Старт/Стоп', Boolean(capabilities.startStopRequests))}
      </Space>
    );
  };

  // — Tab: Стратегии —————————————————————————————————————————————
  const strategyTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {strategyWorkspace && strategyWorkspace.offers.length > 0 ? (
        <>
          {/* Предупреждение: нет API ключа */}
          {clientApiKeys.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="Сначала добавьте API-ключ биржи"
              description={(
                <Space direction="vertical" size={4}>
                  <Typography.Text>
                    Для подключения стратегий необходимо добавить API-ключ.
                  </Typography.Text>
                  <Button
                    type="link"
                    style={{ padding: 0, height: 'auto' }}
                    onClick={() => {
                      setActiveTabKey('settings');
                      setTimeout(() => {
                        const node = document.getElementById('client-api-keys-card');
                        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }, 60);
                    }}
                  >
                    Перейти в раздел «API ключи»
                  </Button>
                </Space>
              )}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          {/* Витрина офферов */}
          <Card className="battletoads-card" title={<span className="storefront-title-accent">Витрина стратегий</span>} size="small">
            {strategyWorkspace.offers.length === 0 ? (
              <Empty description="Офферов на витрине пока нет" />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {strategyWorkspace.capabilities?.settings ? (
                  <Typography.Text type="secondary">
                    Выберите стратегии для вашего портфеля и нажмите «Сохранить выбор».
                  </Typography.Text>
                ) : null}
                <Space wrap size={8}>
                  <Select
                    size="small"
                    style={{ width: 180 }}
                    value={offerFilterInstrument}
                    onChange={(value) => {
                      setOfferFilterInstrument(value);
                      setClientStorefrontPage(1);
                    }}
                    options={[
                      { value: 'all', label: `Все инструменты (${strategyWorkspace.offers.length})` },
                      ...Array.from(new Set(strategyWorkspace.offers.map((o) => o.strategy.market).filter(Boolean))).sort().map((m) => ({
                        value: m,
                        label: `${m} (${strategyWorkspace.offers.filter((o) => o.strategy.market === m).length})`,
                      })),
                    ]}
                  />
                  <Select
                    size="small"
                    style={{ width: 160 }}
                    value={offerSortBy}
                    onChange={(value) => {
                      setOfferSortBy(value);
                      setClientStorefrontPage(1);
                    }}
                    options={[
                      { value: 'ret', label: '↓ По доходности' },
                      { value: 'dd', label: '↑ По просадке' },
                      { value: 'pf', label: '↓ По PF' },
                      { value: 'trades', label: '↓ По сделкам' },
                    ]}
                  />
                </Space>
                <Row gutter={[12, 12]}>
                  {strategyStorefrontPagedOffers.map((offer) => (
                    <Col key={offer.offerId} xs={24} sm={12} md={8} xl={6}>
                      <Card size="small" bordered style={strategyOfferIds.includes(offer.offerId) ? { borderColor: '#f5a623', borderWidth: 2 } : undefined}>
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          <Space direction="vertical" size={0}>
                            <Space>
                              <Tooltip title={getOfferDescription(offer, false)} placement="topLeft">
                                <Typography.Text strong style={{ fontSize: 12, cursor: 'help' }}>{offer.titleRu}</Typography.Text>
                              </Tooltip>
                              {strategyOfferIds.includes(offer.offerId) ? <Tag color="gold" style={{ fontSize: 10 }}>В портфеле</Tag> : null}
                              {strategyWorkspace.capabilities?.settings
                                ? <Checkbox checked={strategyOfferIds.includes(offer.offerId)} onChange={(e) => {
                                    e.stopPropagation();
                                    if (e.target.checked) {
                                      setStrategyOfferIds((current) => current.includes(offer.offerId) ? current : [...current, offer.offerId]);
                                    } else {
                                      setStrategyOfferIds((current) => current.filter((id) => id !== offer.offerId));
                                    }
                                  }} />
                                : null}
                            </Space>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>{offer.strategy.mode.toUpperCase()} • {offer.strategy.market}</Typography.Text>
                          </Space>
                          <Space size={4} wrap>
                              <Tag style={{ fontSize: 11 }}>{String(offer.strategy.params?.interval || '1h')}</Tag>
                            <Tag color="gold" style={{ fontSize: 11 }}>Ret {formatPercent(offer.metrics.ret)}</Tag>
                            <Tag color="volcano" style={{ fontSize: 11 }}>DD {formatPercent(offer.metrics.dd)}</Tag>
                            <Tag color="orange" style={{ fontSize: 11 }}>PF {formatNumber(offer.metrics.pf)}</Tag>
                            {offer.metrics.trades ? <Tag color="cyan" style={{ fontSize: 11 }}>{formatNumber(offer.metrics.trades, 0)} сд.</Tag> : null}
                          </Space>
                          {(() => {
                            const eqVals = getOfferEquityValues(offer);
                            return eqVals.length > 1 ? (
                              <ChartComponent data={equityPointsToSeries(eqVals)} type="line" fixedHeight={120} compact />
                            ) : (
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>Бэктест не загружен</Typography.Text>
                            );
                          })()}
                          <Space wrap>
                            <Button size="small" onClick={() => setStrategyOfferDetail(offer.offerId)}>Подробнее</Button>
                            {strategyWorkspace.capabilities?.settings && !strategyOfferIds.includes(offer.offerId) ? (
                              <Button size="small" type="primary" onClick={() => {
                                setStrategyOfferIds((current) => [...current, offer.offerId]);
                              }}>Подключить</Button>
                            ) : null}
                          </Space>
                        </Space>
                      </Card>
                    </Col>
                  ))}
                </Row>
                {strategyStorefrontOffers.length > CLIENT_STOREFRONT_PAGE_SIZE ? (
                  <Pagination
                    size="small"
                    current={strategyStorefrontPage}
                    total={strategyStorefrontOffers.length}
                    pageSize={CLIENT_STOREFRONT_PAGE_SIZE}
                    showSizeChanger={false}
                    onChange={(page) => setClientStorefrontPage(page)}
                  />
                ) : null}
                {strategyWorkspace.capabilities?.settings ? (
                  <Space wrap>
                    <Typography.Text>
                      Выбрано: <Typography.Text strong>{strategyOfferIds.length}</Typography.Text> из {strategyWorkspace.offers.length}
                    </Typography.Text>
                    <Button type="primary" loading={actionLoading === 'strategy-save'} onClick={() => void saveStrategyProfile()}>
                      Сохранить выбор
                    </Button>
                  </Space>
                ) : null}
              </Space>
            )}
          </Card>

          {/* Strategy offer detail modal */}
          <Modal
            title={(() => {
              const o = strategyWorkspace?.offers.find((x) => x.offerId === strategyOfferDetail);
              return o ? o.titleRu : '';
            })()}
            open={!!strategyOfferDetail}
            onCancel={closeStrategyOfferModal}
            footer={null}
            width={640}
          >
            {(() => {
              const offer = strategyWorkspace?.offers.find((x) => x.offerId === strategyOfferDetail);
              if (!offer) return <Empty description="Стратегия не найдена" />;
              const eqPts = getOfferEquityValues(offer);
              const hasChart = eqPts.length > 1;
              const isSelected = strategyOfferIds.includes(offer.offerId);
              // Per-offer preview from backend (recalculated with sliders)
              const offerSummary = singleOfferPreviewSummary ?? null;
              const offerSeries = singleOfferPreviewSeries;
              const startBalance = offerSummary?.finalEquity != null ? 10000 : (hasChart ? eqPts[0] : null);
              const endBalance = offerSummary?.finalEquity ?? (hasChart ? eqPts[eqPts.length - 1] : null);
              return (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap>
                    {isSelected ? <Tag color="gold">В вашем портфеле</Tag> : <Tag color="blue">Доступна для подключения</Tag>}
                    <Tag>{offer.strategy.mode.toUpperCase()}</Tag>
                    <Tag>{offer.strategy.market}</Tag>
                    <Tag>{String(offer.strategy.params?.interval || '1h')}</Tag>
                    {offer.strategy.type ? <Tag>{offer.strategy.type}</Tag> : null}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-line' }}>
                    {getOfferDescription(offer, false)}
                  </Typography.Text>
                  {singleOfferPreviewLoading ? (
                    <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>
                  ) : offerSeries.length > 0 ? (
                    <div style={{ height: 240 }}>
                      <ChartComponent key={`strat-offer-${offer.offerId}-${offerSeries.length}-${offerSeries[offerSeries.length-1]?.value ?? 0}`} data={offerSeries} type="line" />
                    </div>
                  ) : hasChart ? (
                    <div style={{ height: 240 }}>
                      <ChartComponent key={`strat-${offer.offerId}`} data={equityPointsToSeries(eqPts, 365)} type="line" />
                    </div>
                  ) : null}
                  <Row gutter={[12, 12]}>
                    {startBalance != null ? <Col xs={12} sm={6}><Statistic title="Старт. капитал" value={formatMoney(startBalance)} /></Col> : null}
                    {endBalance != null ? <Col xs={12} sm={6}><Statistic title="Итог. капитал" value={formatMoney(endBalance)} valueStyle={{ color: endBalance >= (startBalance || 0) ? '#f5a623' : '#ff4d4f' }} /></Col> : null}
                    <Col xs={12} sm={6}><Statistic title="Доход" value={formatPercent(offerSummary?.totalReturnPercent ?? offer.metrics.ret)} valueStyle={{ color: (offerSummary?.totalReturnPercent ?? offer.metrics.ret ?? 0) >= 0 ? '#f5a623' : '#ff4d4f' }} /></Col>
                    <Col xs={12} sm={6}><Statistic title="Макс. DD" value={formatPercent(offerSummary?.maxDrawdownPercent ?? offer.metrics.dd)} valueStyle={{ color: '#ff7a45' }} /></Col>
                    <Col xs={12} sm={6}><Statistic title="PF" value={formatNumber(offerSummary?.profitFactor ?? offer.metrics.pf)} /></Col>
                    {(offerSummary?.tradesCount ?? offer.metrics.trades) ? <Col xs={12} sm={6}><Statistic title="Сделки" value={formatNumber(offerSummary?.tradesCount ?? offer.metrics.trades, 0)} /></Col> : null}
                  </Row>
                  {strategyWorkspace?.capabilities?.settings ? (
                    <>
                      <Card size="small" title="Настройки риска и частоты" style={{ marginTop: 8 }}>
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <div>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Риск: {sliderValueToLevel(strategyRiskInput)} ({strategyRiskInput.toFixed(1)})</Typography.Text>
                            <Slider min={0} max={10} step={0.1} value={strategyRiskInput} onChange={(v) => setStrategyRiskInput(toFinite(v))} />
                          </div>
                          <div>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Частота сделок: {sliderValueToLevel(strategyTradeInput)} ({strategyTradeInput.toFixed(1)})</Typography.Text>
                            <Slider min={0} max={10} step={0.1} value={strategyTradeInput} onChange={(v) => setStrategyTradeInput(toFinite(v))} />
                          </div>
                          <Space wrap>
                            <Button type="primary" loading={actionLoading === 'strategy-save'} onClick={() => void saveStrategyProfile()}>Сохранить</Button>
                            <Button onClick={() => { setStrategyRiskInput(levelToSliderValue(strategyWorkspace?.profile?.risk_level || 'medium')); setStrategyTradeInput(levelToSliderValue(strategyWorkspace?.profile?.trade_frequency_level || 'medium')); }}>Дефолт</Button>
                          </Space>
                        </Space>
                      </Card>
                      <Button
                        type={isSelected ? 'default' : 'primary'}
                        danger={isSelected}
                        onClick={() => {
                          setStrategyOfferIds((current) =>
                            isSelected
                              ? current.filter((id) => id !== offer.offerId)
                              : [...current, offer.offerId]
                          );
                        }}
                      >
                        {isSelected ? 'Убрать из портфеля' : 'Добавить в портфель'}
                      </Button>
                    </>
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      message="Хотите подключить индивидуальные стратегии?"
                      description="Для подключения продукта «Клиент стратегий» обратитесь к администратору."
                    />
                  )}
                </Space>
              );
            })()}
          </Modal>

          {/* Статус торговли */}
          <Card className="battletoads-card" title="Статус торговли" size="small">
            <Space wrap style={{ marginBottom: 8 }}>
              <Tag color="blue">Тариф: {strategyWorkspace.plan?.title || '—'}</Tag>
              <Tag color="cyan">Депозит до: {formatMoney(strategyWorkspace.plan?.max_deposit_total)}</Tag>
              <Tag color="purple">Стратегий до: {formatNumber(strategyWorkspace.plan?.max_strategies_total, 0)}</Tag>
              <Tag color={strategyWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                {strategyWorkspace.profile?.actual_enabled ? 'Торговля активна' : 'Торговля остановлена'}
              </Tag>
            </Space>

            {clientApiKeys.length > 0 ? (
              <Space wrap style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary">API ключ для потока стратегий:</Typography.Text>
                <Select
                  style={{ minWidth: 240 }}
                  value={strategyAssignedApiKeyName || undefined}
                  placeholder="Выберите API ключ"
                  onChange={(value) => setStrategyAssignedApiKeyName(String(value || ''))}
                  options={clientApiKeys.map((item) => ({ value: item.name, label: `${item.name} (${item.exchange})` }))}
                />
                <Button loading={actionLoading === 'strategy-save'} onClick={() => void saveStrategyProfile()}>
                  Сохранить API/настройки
                </Button>
              </Space>
            ) : null}

            {renderCapabilities(strategyWorkspace.capabilities)}
          </Card>

          {strategyWorkspace.capabilities?.settings ? (
            <Card className="battletoads-card" title="Управление торговлей" size="small">
              <Space wrap>
                {!strategyWorkspace.profile?.actual_enabled ? (
                  <Button type="primary" loading={actionLoading === 'strategy-start'} onClick={() => void saveStrategyProfile(true)}>
                    Включить торговлю
                  </Button>
                ) : (
                  <Button danger loading={actionLoading === 'strategy-stop'} onClick={() => void saveStrategyProfile(false)}>
                    Выключить торговлю
                  </Button>
                )}
              </Space>
            </Card>
          ) : null}

          {/* Запросить бэктест пары */}
          <Card className="battletoads-card" title="Запросить бэктест по паре" size="small">
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Row gutter={[8, 8]}>
                <Col xs={24} sm={12}>
                  <Input
                    placeholder="Пара: SOLUSDT или BTC/ETH"
                    value={requestMarket}
                    onChange={(e) => setRequestMarket(e.target.value)}
                  />
                </Col>
                <Col xs={24} sm={12}>
                  <Input
                    placeholder="Интервал (1h, 4h, 1d)"
                    value={requestInterval}
                    onChange={(e) => setRequestInterval(e.target.value)}
                  />
                </Col>
              </Row>
              <Input.TextArea
                rows={2}
                value={requestNote}
                onChange={(e) => setRequestNote(e.target.value)}
                placeholder="Комментарий для исследования (необязательно)"
              />
              <Space wrap>
                <Button type="primary" loading={actionLoading === 'strategy-backtest-request'} onClick={() => void sendBacktestPairRequest()}>
                  Отправить запрос
                </Button>
                <Button onClick={() => void loadBacktestRequests()}>Обновить список</Button>
              </Space>
              {backtestRequests.length > 0 ? (
                <List
                  size="small"
                  dataSource={backtestRequests}
                  renderItem={(item) => (
                    <List.Item>
                      <Space wrap>
                        <Typography.Text strong>{[item.base_symbol, item.quote_symbol].filter(Boolean).join('/') || item.base_symbol}</Typography.Text>
                        <Tag>{item.interval}</Tag>
                        <Tag color={item.status === 'done' ? 'success' : item.status === 'rejected' ? 'error' : 'processing'}>{item.status}</Tag>
                        <Typography.Text type="secondary">#{item.id}</Typography.Text>
                        {item.note ? <Typography.Text type="secondary">{item.note}</Typography.Text> : null}
                      </Space>
                    </List.Item>
                  )}
                />
              ) : null}
            </Space>
          </Card>
        </>
      ) : strategyWorkspace && strategyWorkspace.offers.length === 0 ? (
        <Card className="battletoads-card" size="small">
          <Empty description="На витрине стратегий пока нет доступных офферов." />
        </Card>
      ) : (
        <Card className="battletoads-card" size="small">
          <Empty
            description={
              <Space direction="vertical" size={8}>
                <Typography.Text>Витрина стратегий загружается...</Typography.Text>
                <Typography.Text type="secondary">Если витрина не появилась — обратитесь к администратору.</Typography.Text>
              </Space>
            }
          />
        </Card>
      )}
    </Space>
  );

  // — Tab: Алгофонд —————————————————————————————————————————————
  const algofundTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {algofundWorkspace ? (
        <>
          {(algofundWorkspace as any).browseOnly ? (
            <Alert
              type="info"
              showIcon
              message="Автоматическое управление через Алгофонд"
              description="Ознакомьтесь с доступными торговыми системами. Для подключения обратитесь к администратору."
              style={{ marginBottom: 8 }}
            />
          ) : (
          <Card className="battletoads-card" title="Статус Алгофонда" size="small">
            <Space wrap style={{ marginBottom: 8 }}>
              <Tag color="blue">Тариф: {algofundWorkspace.plan?.title || '—'}</Tag>
              <Tag color="cyan">Депозит до: {formatMoney(algofundWorkspace.plan?.max_deposit_total)}</Tag>
              <Tag color="purple">Риск-кап: {formatNumber(algofundWorkspace.plan?.risk_cap_max)}</Tag>
              <Tag color={algofundWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                {algofundWorkspace.profile?.actual_enabled ? 'Торговля активна' : 'Торговля остановлена'}
              </Tag>
              {algofundAssignedApiKey ? <Tag color="geekblue">API: {algofundAssignedApiKey}</Tag> : null}
            </Space>

            {clientApiKeys.length > 0 ? (
              <Space wrap style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary">API ключ для потока Алгофонда:</Typography.Text>
                <Select
                  style={{ minWidth: 240 }}
                  value={algofundAssignedApiKeyName || undefined}
                  placeholder="Выберите API ключ"
                  onChange={(value) => setAlgofundAssignedApiKeyName(String(value || ''))}
                  options={clientApiKeys.map((item) => ({ value: item.name, label: `${item.name} (${item.exchange})` }))}
                />
                <Button loading={actionLoading === 'algofund-save'} onClick={() => void saveAlgofundProfile()}>
                  Сохранить API/риск-профиль
                </Button>
              </Space>
            ) : null}

            {renderCapabilities(algofundWorkspace.capabilities)}
          </Card>
          )}

          <Card className="battletoads-card" title={<span className="storefront-title-accent">Витрина торговых систем Алгофонда</span>} size="small">
            {algofundAvailableSystems.length === 0 ? (
              <Empty description="Торговые системы Алгофонда пока не опубликованы" />
            ) : (
              <>
                <Row gutter={[12, 12]}>
                  {algofundStorefrontPagedSystems.map((system) => {
                    const systemName = String(system?.name || '').trim();
                    const matchingActiveSystems = algofundActiveSystems.filter((item) => String(item.systemName || '').trim() === systemName);
                    const isCurrent = isAlgofundSystemEnabled(systemName);
                    const currentWeights = matchingActiveSystems
                      .map((item) => Number(item.weight || 0))
                      .filter((value) => Number.isFinite(value) && value > 0);
                    const snap = (system as any).backtestSnapshot as { ret: number; pf: number; dd: number; trades: number; equityPoints: number[]; finalEquity: number; periodDays: number; tradesPerDay: number } | null | undefined;
                    const eqPts = snap?.equityPoints;
                    const hasChart = isCurrent ? (algofundPreviewSeries.length > 0 || (Array.isArray(eqPts) && eqPts.length > 1)) : (Array.isArray(eqPts) && eqPts.length > 1);
                    return (
                      <Col xs={24} sm={12} md={8} xl={6} key={String(system?.id || system?.name || Math.random())}>
                        <Card
                          size="small"
                          bordered
                          style={isCurrent ? { borderColor: '#f5a623', borderWidth: 2 } : undefined}
                        >
                          <Space direction="vertical" size={6} style={{ width: '100%' }}>
                            <Space direction="vertical" size={0}>
                              <Space>
                                <Tooltip title={getTsHint(system.name) ?? undefined} placement="topLeft">
                                  <Typography.Text strong style={{ fontSize: 12, cursor: getTsHint(system.name) ? 'help' : undefined }}>{tsDisplayName(system.name)}</Typography.Text>
                                </Tooltip>
                                {isCurrent ? <Tag color="success" style={{ fontSize: 10, fontWeight: 700 }}>Подключена</Tag> : null}
                                {currentWeights.length > 0 ? <Tag color="blue" style={{ fontSize: 10 }}>Риск {formatNumber(currentWeights[0])}x</Tag> : null}
                              </Space>
                            </Space>
                            <Space size={4} wrap>
                              {snap?.periodDays ? <Tag style={{ fontSize: 11 }}>{Math.round(snap.periodDays)}d</Tag> : null}
                              {snap ? <Tag color="gold" style={{ fontSize: 11 }}>Ret {formatPercent(snap.ret)}</Tag> : null}
                              {snap ? <Tag color="volcano" style={{ fontSize: 11 }}>DD {formatPercent(snap.dd)}</Tag> : null}
                              {snap ? <Tag color="orange" style={{ fontSize: 11 }}>PF {formatNumber(snap.pf)}</Tag> : null}
                              {snap?.trades ? <Tag color="cyan" style={{ fontSize: 11 }}>{formatNumber(snap.trades, 0)} сд.</Tag> : null}
                            </Space>
                            {hasChart ? (
                              <ChartComponent
                                data={isCurrent && algofundPreviewSeries.length > 0
                                  ? algofundPreviewSeries
                                  : equityPointsToSeries(eqPts || [], snap?.periodDays)}
                                type="line"
                                fixedHeight={120}
                                compact
                              />
                            ) : (
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>Бэктест не загружен</Typography.Text>
                            )}
                            <Space size={4} wrap>
                              <Button size="small" onClick={() => { setTsModalRiskMultiplier(1); setSystemDetailModal({ name: system.name, id: system.id }); }}>Подробнее</Button>
                              {!isCurrent ? (
                                <Button size="small" type="primary" loading={actionLoading === 'algofund-start'} onClick={() => { void sendAlgofundRequest('start', { id: Number(system.id || 0), name: String(system.name || '') }); }}>
                                  Подключить
                                </Button>
                              ) : null}
                            </Space>
                          </Space>
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
                {algofundSortedSystems.length > CLIENT_STOREFRONT_PAGE_SIZE ? (
                  <Pagination
                    size="small"
                    current={algofundStorefrontPage}
                    total={algofundSortedSystems.length}
                    pageSize={CLIENT_STOREFRONT_PAGE_SIZE}
                    showSizeChanger={false}
                    onChange={(page) => setAlgofundStorefrontPageState(page)}
                    style={{ marginTop: 12 }}
                  />
                ) : null}
              </>
            )}
          </Card>

          {/* Detail modal for a selected system card */}
          <Modal
            title={systemDetailModal ? tsDisplayName(systemDetailModal.name) : ''}
            open={!!systemDetailModal}
            onCancel={closeSystemDetailModal}
            footer={null}
            width={640}
          >
            {(() => {
              if (!systemDetailModal) return null;
              const system = algofundAvailableSystems.find((s) => s.id === systemDetailModal.id);
              if (!system) return <Empty description="Система не найдена" />;
              const isCurrent = isAlgofundSystemEnabled(system.name);
              const snap = (system as any).backtestSnapshot as { ret: number; pf: number; dd: number; trades: number; equityPoints: number[]; finalEquity: number; periodDays: number; tradesPerDay: number } | null | undefined;
              const eqPts = snap?.equityPoints;
              // For connected system: use backend preview when risk matches saved profile;
              // otherwise show immediate local scaling so slider feedback is instant.
              const riskMul = isCurrent ? algofundRiskMultiplier : tsModalRiskMultiplier;
              const baseRiskMul = toFinite(algofundWorkspace?.profile?.risk_multiplier, 1);
              const usePreviewForCurrent = isCurrent && Math.abs(riskMul - baseRiskMul) < 0.01;
              const scaledEqPts = Array.isArray(eqPts) && eqPts.length > 1 && riskMul !== 1
                ? (() => {
                    const base = eqPts[0] || 10000;
                    const reinvest = 0.5;
                    return eqPts.map((v) => {
                      const linear = base + (v - base) * riskMul;
                      const compound = base * Math.pow(Math.max(0.0001, v / Math.max(0.0001, base)), riskMul);
                      return linear * (1 - reinvest) + compound * reinvest;
                    });
                  })()
                : eqPts;
              const chartData = usePreviewForCurrent && algofundPreviewSeries.length > 0
                ? algofundPreviewSeries
                : Array.isArray(scaledEqPts) && scaledEqPts.length > 1
                  ? equityPointsToSeries(scaledEqPts, snap?.periodDays)
                  : [];
              const startBalance = Array.isArray(eqPts) && eqPts.length > 0 ? eqPts[0] : null;
              const scaledFinalEquity = !isCurrent && snap?.finalEquity != null && startBalance != null
                ? (() => {
                    const linear = startBalance + (snap.finalEquity - startBalance) * riskMul;
                    const compound = startBalance * Math.pow(Math.max(0.0001, snap.finalEquity / Math.max(0.0001, startBalance)), riskMul);
                    return linear * 0.5 + compound * 0.5;
                  })()
                : snap?.finalEquity ?? null;
              const endBalance = usePreviewForCurrent && algofundWorkspace?.preview?.summary?.finalEquity != null
                ? algofundWorkspace.preview.summary.finalEquity
                : scaledFinalEquity;
              const chartKey = isCurrent
                ? `af-preview-${algofundRiskMultiplier}-${algofundPreviewSeries.length}-${algofundPreviewSeries[algofundPreviewSeries.length - 1]?.value ?? 0}`
                : `af-snap-${systemDetailModal?.id}-${riskMul}`;
              // Compute display metrics: backend preview for connected, client-side scaling for others (matching backend formulas)
              const previewSummary = usePreviewForCurrent && algofundWorkspace?.preview?.summary ? algofundWorkspace.preview.summary : null;
              const relativeRisk = riskMul; // baseline is always 1 for snapshots
              const displayRet = previewSummary?.totalReturnPercent ?? (snap?.ret != null ? snap.ret * relativeRisk : undefined);
              const displayDd = previewSummary?.maxDrawdownPercent ?? (snap?.dd != null ? Math.min(99, snap.dd * Math.max(0.05, relativeRisk)) : undefined);
              const displayPf = previewSummary?.profitFactor ?? (snap?.pf != null && relativeRisk > 0 ? Math.max(0.15, snap.pf / Math.max(0.5, Math.sqrt(relativeRisk))) : snap?.pf);
              const displayTrades = previewSummary?.tradesCount ?? snap?.trades;
              const displayTpd = previewSummary?.tradesCount && snap?.periodDays ? (Number(previewSummary.tradesCount) / snap.periodDays) : snap?.tradesPerDay;
              return (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap>
                    {isCurrent ? <Tag color="success" style={{ fontWeight: 700 }}>Подключена к вашему аккаунту</Tag> : <Tag color="blue">Доступна для подключения</Tag>}
                    {snap?.periodDays ? <Tag>Период: {Math.round(snap.periodDays)}д</Tag> : null}
                    {displayRet != null ? <Tag color="gold">Ret {formatPercent(displayRet)}</Tag> : null}
                    {displayDd != null ? <Tag color="volcano">DD {formatPercent(displayDd)}</Tag> : null}
                    {snap?.trades ? <Tag>{snap.trades} сделок</Tag> : null}
                  </Space>
                  {getTsHint(system.name) ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-line' }}>
                      {getTsHint(system.name)}
                    </Typography.Text>
                  ) : null}
                  {chartData.length > 0 ? (
                    <div style={{ height: 240 }}>
                      <ChartComponent key={chartKey} data={chartData} type="line" />
                    </div>
                  ) : null}
                  {(snap || startBalance != null) ? (
                    <Row gutter={[12, 12]}>
                      {startBalance != null ? <Col xs={12} sm={6}><Statistic title="Старт. капитал" value={formatMoney(startBalance)} /></Col> : null}
                      {endBalance != null ? <Col xs={12} sm={6}><Statistic title="Итог. капитал" value={formatMoney(endBalance)} valueStyle={{ color: endBalance >= (startBalance || 0) ? '#f5a623' : '#ff4d4f' }} /></Col> : null}
                      {displayRet != null ? <Col xs={12} sm={6}><Statistic title="Доход" value={formatPercent(displayRet)} valueStyle={{ color: Number(displayRet) >= 0 ? '#f5a623' : '#ff4d4f' }} /></Col> : null}
                      {displayDd != null ? <Col xs={12} sm={6}><Statistic title="Макс. DD" value={formatPercent(displayDd)} valueStyle={{ color: '#ff7a45' }} /></Col> : null}
                      {displayPf != null ? <Col xs={12} sm={6}><Statistic title="PF" value={formatNumber(displayPf)} /></Col> : null}
                      {displayTrades != null ? <Col xs={12} sm={6}><Statistic title="Сделки" value={formatNumber(displayTrades, 0)} /></Col> : null}
                      {displayTpd != null ? <Col xs={12} sm={6}><Statistic title="Сд./день" value={formatNumber(displayTpd, 1)} /></Col> : null}
                    </Row>
                  ) : null}
                  <div style={{ padding: '8px 0' }}>
                    <Typography.Text strong>Мультипликатор риска: × {formatNumber(riskMul, 2)}</Typography.Text>
                    <Slider
                      min={0.1}
                      max={toFinite(algofundWorkspace?.plan?.risk_cap_max, 2.5)}
                      step={0.05}
                      value={riskMul}
                      onChange={(v) => {
                        const clamped = Math.min(toFinite(v), toFinite(algofundWorkspace?.plan?.risk_cap_max, 2.5));
                        if (isCurrent) setAlgofundRiskMultiplier(clamped);
                        else setTsModalRiskMultiplier(clamped);
                      }}
                      onChangeComplete={() => { if (isCurrent) void refreshAlgofundState(); }}
                      onAfterChange={() => { if (isCurrent) void refreshAlgofundState(); }}
                    />
                    <Space wrap>
                      {isCurrent ? (
                        <>
                          <Button type="primary" size="small" loading={actionLoading === 'algofund-save'} onClick={() => void saveAlgofundProfile()}>
                            Сохранить риск
                          </Button>
                          <Button size="small" onClick={() => setAlgofundRiskMultiplier(toFinite(algofundWorkspace?.profile?.risk_multiplier, 1))}>
                            Дефолт
                          </Button>
                        </>
                      ) : (
                        <Button size="small" onClick={() => setTsModalRiskMultiplier(1)}>
                          Дефолт
                        </Button>
                      )}
                    </Space>
                  </div>
                  {!isCurrent ? (
                    <Button type="primary" loading={actionLoading === 'algofund-start'} onClick={() => { void sendAlgofundRequest('start', { id: Number(system.id || 0), name: String(system.name || '') }); closeSystemDetailModal(); }}>
                      Подключить эту систему
                    </Button>
                  ) : (
                    <Button danger loading={actionLoading === 'algofund-stop'} onClick={() => { void sendAlgofundRequest('stop'); closeSystemDetailModal(); }}>
                      Отключить
                    </Button>
                  )}
                </Space>
              );
            })()}
          </Modal>

          {!(algofundWorkspace as any)?.browseOnly && (
          <Card className="battletoads-card" title="Управление подключением" size="small">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space wrap>
                {!algofundWorkspace.profile?.actual_enabled ? (
                  <Button type="primary" loading={actionLoading === 'algofund-start'} onClick={() => void sendAlgofundRequest('start')}>
                    Подключить Алгофонд
                  </Button>
                ) : (
                  <Button danger loading={actionLoading === 'algofund-stop'} onClick={() => void sendAlgofundRequest('stop')}>
                    Отключить Алгофонд
                  </Button>
                )}
              </Space>

              {(algofundWorkspace.requests || []).length > 0 ? null : null}
            </Space>
          </Card>
          )}
        </>
      ) : (
        <Card className="battletoads-card" size="small">
          <Empty
            description={
              <Space direction="vertical" size={8}>
                <Typography.Text>Алгофонд недоступен для вашего аккаунта.</Typography.Text>
                <Typography.Text type="secondary">Хотите подключить автоматическое управление через Алгофонд? Обратитесь к администратору.</Typography.Text>
              </Space>
            }
          />
        </Card>
      )}
    </Space>
  );

  // — Tab: Настройки и мониторинг ————————————————————————————
  const settingsTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card className="battletoads-card" title="Аккаунт" size="small">
        <Descriptions
          column={{ xs: 1, sm: 2 }}
          size="small"
          bordered
          labelStyle={{ minWidth: 130, fontWeight: 600 }}
        >
          <Descriptions.Item label="Email">
            <span style={{ wordBreak: 'break-all' }}>{clientUser?.email || '—'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="Имя">{clientUser?.fullName || '—'}</Descriptions.Item>
          <Descriptions.Item label="Tenant">{clientUser?.tenantDisplayName || '—'}</Descriptions.Item>
          <Descriptions.Item label="Slug">{clientUser?.tenantSlug || '—'}</Descriptions.Item>
          <Descriptions.Item label="Режим">
            {workspace?.productMode === 'dual'
              ? 'Dual: стратегии + Алгофонд'
              : workspace?.productMode === 'algofund_client'
                ? 'Алгофонд-клиент'
                : 'Клиент стратегий'}
          </Descriptions.Item>
          <Descriptions.Item label="Статус">{clientUser?.tenantStatus || '—'}</Descriptions.Item>
        </Descriptions>
        <div style={{ marginTop: 8 }}>
          <Space wrap>
            {!onboardingCompleted ? (
              <Button loading={actionLoading === 'onboarding'} onClick={() => void markOnboardingCompleted()}>
                Отметить onboarding пройденным
              </Button>
            ) : null}
          </Space>
        </div>
      </Card>

      <Card className="battletoads-card" title="Мониторинг счёта" size="small">
        <Space wrap>
          <Button type="primary" onClick={() => { setMonitoringModalVisible(true); void refreshMonitoring(monitoringDays); }}>
            Открыть мониторинг
          </Button>
          {monitoring?.latest?.equity_usd != null ? <Tag color="blue">Капитал: {formatMoney(monitoring.latest.equity_usd)}</Tag> : null}
          {monitoring?.latest?.drawdown_pct != null ? <Tag color="orange">DD: {formatPercent(monitoring.latest.drawdown_pct)}</Tag> : null}
        </Space>
      </Card>

      <Modal
        title="Мониторинг счёта"
        open={monitoringModalVisible}
        onCancel={() => setMonitoringModalVisible(false)}
        footer={null}
        width={720}
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented
            size="small"
            options={[
              { label: '1д', value: 1 },
              { label: '7д', value: 7 },
              { label: '30д', value: 30 },
              { label: '60д', value: 60 },
            ]}
            value={monitoringDays}
            onChange={(v) => {
              const d = Number(v);
              setMonitoringDays(d);
              void refreshMonitoring(d);
            }}
          />
          <Button size="small" loading={actionLoading === 'monitoring-refresh'} onClick={() => void refreshMonitoring(monitoringDays)}>Обновить</Button>
        </Space>
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} sm={6}>
            <Statistic title="Капитал" value={formatMoney(monitoring?.latest?.equity_usd)} precision={0} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="Просадка" value={formatPercent(monitoring?.latest?.drawdown_pct)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="Нереал. P/L" value={formatMoney(monitoring?.latest?.unrealized_pnl_usd)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="Загрузка маржи" value={formatPercent(monitoring?.latest?.margin_usage_pct)} />
          </Col>
        </Row>
        <Space wrap style={{ marginBottom: 8 }}>
          {monitoring?.apiKeyName ? <Tag color="blue">Активный API: {monitoring.apiKeyName}</Tag> : null}
          {monitoring?.streams?.strategy?.apiKeyName ? <Tag color="geekblue">Стратегии: {monitoring.streams.strategy.apiKeyName}</Tag> : null}
          {monitoring?.streams?.algofund?.apiKeyName ? <Tag color="purple">Алгофонд: {monitoring.streams.algofund.apiKeyName}</Tag> : null}
        </Space>
        {monitoringSeries.length > 0 ? (
          <ChartComponent data={monitoringSeries} type="line" />
        ) : (
          <Empty description="Нет данных мониторинга" />
        )}
      </Modal>

      <Card id="client-api-keys-card" className="battletoads-card" title="API ключи биржи" size="small">
        {!onboardingCompleted ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Первый вход — чек-лист"
            description={
              <>
                <ol style={{ margin: '8px 0 8px 18px', padding: 0 }}>
                  <li>Создайте API ключ на бирже с правами Trade и Read.</li>
                  <li>Добавьте IP адрес сервера в белый список биржи.</li>
                  <li>Вставьте ключ и секрет в форму ниже и подключите его к нужному потоку.</li>
                </ol>
                <Space wrap>
                  {guides.length > 0 ? guides.map((guide) => (
                    <Button key={guide.id} size="small" loading={actionLoading === `guide-${guide.id}`} onClick={() => void openGuideModal(guide)}>
                      {guide.title}
                    </Button>
                  )) : <Tag>Гайды временно недоступны</Tag>}
                </Space>
              </>
            }
          />
        ) : guides.length > 0 ? (
          <Space wrap style={{ marginBottom: 12 }}>
            {guides.map((guide) => (
              <Button key={guide.id} size="small" loading={actionLoading === `guide-${guide.id}`} onClick={() => void openGuideModal(guide)}>
                {guide.title}
              </Button>
            ))}
          </Space>
        ) : null}

        <Modal
          title={guideModalTitle || 'Гайд API-ключа'}
          open={guideModalOpen}
          onCancel={() => setGuideModalOpen(false)}
          footer={null}
          width={860}
        >
          <div className="docs-markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{guideModalContent}</ReactMarkdown>
          </div>
        </Modal>

        <Typography.Text strong>
          {editingApiKeyId ? `Редактировать ключ: ${editingApiKeyName}` : 'Добавить новый ключ'}
        </Typography.Text>
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col xs={24} sm={8}>
            <Select
              style={{ width: '100%' }}
              value={apiKeyDraft.exchange || 'bybit'}
              onChange={(value) => setApiKeyDraft((cur) => ({ ...cur, exchange: String(value || 'bybit').trim().toLowerCase() || 'bybit' }))}
              options={[
                { value: 'bybit', label: 'Bybit Futures' },
                { value: 'binance', label: 'Binance Futures' },
                { value: 'bingx', label: 'BingX Futures' },
                { value: 'bitget', label: 'Bitget Futures' },
                { value: 'weex', label: 'WEEX Futures' },
                { value: 'mexc', label: 'MEXC Futures' },
              ]}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Input
              addonBefore="API Key"
              value={apiKeyDraft.apiKey}
              onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, apiKey: e.target.value }))}
              placeholder="xxxxxxxx"
            />
          </Col>
          <Col xs={24} sm={8}>
            <Input.Password
              addonBefore="Secret"
              value={apiKeyDraft.secret}
              onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, secret: e.target.value }))}
              placeholder="xxxxxxxx"
            />
          </Col>
          <Col xs={24} sm={8}>
            <Input
              addonBefore="Passphrase"
              value={apiKeyDraft.passphrase}
              onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, passphrase: e.target.value }))}
              placeholder="Для Bitget и WEEX обязателен"
            />
          </Col>
          <Col xs={24} sm={16}>
            <Space wrap style={{ paddingTop: 6 }}>
              <Checkbox checked={apiKeyDraft.testnet} onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, testnet: e.target.checked }))}>Testnet</Checkbox>
              <Checkbox checked={apiKeyDraft.demo} onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, demo: e.target.checked }))}>Demo Trading</Checkbox>
              <Button type="primary" loading={actionLoading === 'client-api-key'} onClick={() => void saveClientApiKey()}>
                {editingApiKeyId ? 'Сохранить изменения' : 'Сохранить и подключить'}
              </Button>
              {editingApiKeyId ? <Button onClick={resetApiKeyDraft}>Отмена</Button> : null}
            </Space>
          </Col>
        </Row>

        {clientApiKeys.length > 0 ? (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Typography.Text strong>Подключённые ключи</Typography.Text>
            <List
              size="small"
              style={{ marginTop: 8 }}
              dataSource={clientApiKeys}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Button key={`edit-${item.id}`} size="small" onClick={() => startEditingApiKey(item)}>
                      Редактировать
                    </Button>,
                    <Popconfirm
                      key={`del-${item.id}`}
                      title="Удалить API ключ?"
                      description="Ключ будет удалён из базы данных."
                      okText="Удалить"
                      cancelText="Отмена"
                      onConfirm={() => void deleteClientApiKey(item.id)}
                    >
                      <Button danger size="small" loading={actionLoading === `delete-client-api-key-${item.id}`}>Удалить</Button>
                    </Popconfirm>,
                  ]}
                >
                  <Space wrap>
                    <Typography.Text strong>{item.name}</Typography.Text>
                    <Tag>{item.exchange}</Tag>
                    {item.testnet ? <Tag color="gold">testnet</Tag> : null}
                    {item.demo ? <Tag color="magenta">demo</Tag> : null}
                    {item.usedByStrategy ? <Tag color="blue">поток стратегий</Tag> : null}
                    {item.usedByAlgofund ? <Tag color="purple">поток Алгофонда</Tag> : null}
                    {!item.usedByStrategy && !item.usedByAlgofund ? <Tag>не назначен</Tag> : null}
                  </Space>
                </List.Item>
              )}
            />
          </>
        ) : null}
      </Card>

      <Card className="battletoads-card" title="Тариф и лимиты" size="small">
        <Space wrap style={{ marginBottom: 12 }}>
          <Tag color="blue">Тариф: {tariff?.currentPlan?.title || '—'}</Tag>
          <Tag color="green">Цена: {tariff?.currentPlan?.original_price_usdt ? <><s style={{ opacity: 0.5 }}>{formatMoney(tariff.currentPlan.original_price_usdt)}</s>{' '}</> : null}{formatMoney(tariff?.currentPlan?.price_usdt)}/мес</Tag>
          <Tag color="cyan">Макс. депозит: {formatMoney(tariff?.currentPlan?.max_deposit_total)}</Tag>
          <Tag color="purple">Риск-кап: {formatNumber(tariff?.currentPlan?.risk_cap_max)}</Tag>
          {tariff?.currentPlan?.allow_ts_start_stop_requests ? <Tag color="success">Старт/Стоп: вкл</Tag> : null}
        </Space>

        <Typography.Text strong>Запросить смену тарифа</Typography.Text>
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col xs={24} sm={12}>
            <Select
              style={{ width: '100%' }}
              placeholder="Выберите тариф"
              value={targetPlanCode || undefined}
              onChange={setTargetPlanCode}
              options={(tariff?.availablePlans || []).map((plan) => ({
                value: plan.code,
                label: `${plan.title} (${plan.original_price_usdt ? `${formatMoney(plan.original_price_usdt)} → ` : ''}${formatMoney(plan.price_usdt)}/мес — до ${formatMoney(plan.max_deposit_total)})`,
              }))}
            />
          </Col>
          <Col xs={24} sm={12}>
            <Input
              placeholder="Комментарий (необязательно)"
              value={tariffNote}
              onChange={(e) => setTariffNote(e.target.value)}
            />
          </Col>
        </Row>
        <Button type="primary" style={{ marginTop: 8 }} loading={actionLoading === 'tariff-request'} onClick={() => void sendTariffRequest()}>
          Отправить заявку на смену тарифа
        </Button>

        {(tariff?.requests || []).length > 0 ? (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Typography.Text type="secondary">Последние заявки:</Typography.Text>
            <List
              size="small"
              style={{ marginTop: 8 }}
              dataSource={tariff?.requests || []}
              renderItem={(item) => (
                <List.Item>
                  <Space wrap>
                    <Tag color="blue">#{item.id}</Tag>
                    <Typography.Text>{item.payload?.targetPlanTitle || item.payload?.targetPlanCode || '—'}</Typography.Text>
                    <Typography.Text type="secondary">{item.createdAt}</Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </>
        ) : null}
      </Card>

      {/* — Поддержка и обращения — */}
      <Card className="battletoads-card" title="Поддержка" size="small">
        <Typography.Paragraph style={{ marginBottom: 12 }}>
          Если у вас есть вопросы, предложения, замечания или вы нашли баг — обращайтесь к нам любым удобным способом:
        </Typography.Paragraph>
        <Space wrap size={12}>
          <Button
            type="primary"
            icon={<span style={{ marginRight: 6 }}>💬</span>}
            href="https://t.me/BT_bot_Dashboard_bot"
            target="_blank"
            style={{ borderRadius: 8 }}
          >
            Написать в Telegram-бот
          </Button>
          <Button
            href="https://t.me/yakovbyakov"
            target="_blank"
            style={{ borderRadius: 8 }}
          >
            Связаться с менеджером
          </Button>
          <Button
            href="https://t.me/BTDD_Discuss"
            target="_blank"
            style={{ borderRadius: 8 }}
          >
            💬 Чат сообщества
          </Button>
          <Button
            href="mailto:aiaetrade17@gmail.com"
            style={{ borderRadius: 8 }}
          >
            📩 Email
          </Button>
        </Space>
        <Divider style={{ margin: '16px 0 12px' }} />
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Бот работает 24/7 — ответ обычно в течение нескольких часов. Для срочных вопросов используйте прямой контакт с менеджером.
        </Typography.Text>
      </Card>

      {/* — Настройки уведомлений (placeholder) — */}
      <Card className="battletoads-card" title="Уведомления" size="small">
        <Typography.Paragraph style={{ marginBottom: 12 }}>
          Настройте уведомления, которые хотите получать в Telegram:
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Checkbox defaultChecked disabled>Баланс и изменения капитала</Checkbox>
          <Checkbox defaultChecked disabled>Информация о сделках (открытие/закрытие)</Checkbox>
          <Checkbox defaultChecked disabled>Напоминания об оплате подписки</Checkbox>
          <Checkbox disabled>Ежедневный отчёт по позициям</Checkbox>
        </Space>
        <div style={{ marginTop: 16 }}>
          <Tag color="blue">Скоро!</Tag>
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 13 }}>
            Push-уведомления через Telegram-бот будут доступны в ближайшем обновлении.
          </Typography.Text>
        </div>
      </Card>
    </Space>
  );

  return (
    <div className="saas-page client-cabinet-page">
      {contextHolder}

      {/* — Шапка ——————————————————————————————————————————————————— */}
      <Card className="battletoads-card" bordered={false} style={{ marginBottom: 0 }}>
        <Row align="middle" justify="space-between" gutter={[8, 8]}>
          <Col>
            <Typography.Title level={3} style={{ margin: 0 }}>Личный кабинет</Typography.Title>
            <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
              {clientUser?.email || '—'}{clientUser?.tenantDisplayName ? ` · ${clientUser.tenantDisplayName}` : ''}
            </Typography.Text>
          </Col>
          <Col>
            <Space wrap>
              <Button onClick={() => void loadWorkspace()} loading={loading}>Обновить</Button>
              <Button danger onClick={() => void logoutClient()}>Выйти</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

      <Spin spinning={loading && !workspace}>
        {workspace ? (
          <Tabs
            activeKey={activeTabKey}
            onChange={(key) => setActiveTabKey((key as ClientCabinetTabKey) || 'strategy')}
            items={[
              {
                key: 'strategy',
                label: workspace.productMode === 'dual' ? 'Стратегии' : 'Клиент стратегий',
                children: strategyTabContent,
              },
              {
                key: 'algofund',
                label: 'Алгофонд',
                children: algofundTabContent,
              },
              {
                key: 'settings',
                label: 'Настройки и мониторинг',
                children: settingsTabContent,
              },
            ]}
          />
        ) : !loading ? (
          <Alert type="warning" showIcon message="Не удалось загрузить рабочее пространство. Попробуйте обновить страницу." />
        ) : null}
      </Spin>
    </div>
  );
};

export default ClientCabinet;

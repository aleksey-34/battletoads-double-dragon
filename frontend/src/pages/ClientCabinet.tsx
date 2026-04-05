import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
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
  Row,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Statistic,
  Tag,
  Tabs,
  Typography,
  message,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

type ProductMode = 'strategy_client' | 'algofund_client' | 'synctrade_client';
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
  downloadUrl: string;
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
  };
  metrics: MetricSet;
  equityPoints?: number[];
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

const tsDisplayName = (systemName: string): string => {
  const parts = String(systemName || '').trim().split('::').filter(Boolean);
  let token = String(parts[parts.length - 1] || '').trim().toLowerCase();
  token = token.replace(/^algofund-master-btdd-d1-/, '');
  token = token.replace(/-h-([a-z0-9]{4,})$/i, '-$1');
  return token || systemName;
};

const capabilityTag = (label: string, enabled: boolean) => <Tag color={enabled ? 'success' : 'default'}>{label}: {enabled ? 'on' : 'off'}</Tag>;

const ClientCabinet: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [strategyStateExtra, setStrategyStateExtra] = useState<StrategyState | null>(null);
  const [algofundStateExtra, setAlgofundStateExtra] = useState<AlgofundState | null>(null);
  const [guides, setGuides] = useState<GuideItem[]>([]);
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
  const [strategySelectionPreview, setStrategySelectionPreview] = useState<StrategySelectionPreviewResponse | null>(null);
  const [strategySelectionPreviewLoading, setStrategySelectionPreviewLoading] = useState(false);
  const [backtestRequests, setBacktestRequests] = useState<StrategyBacktestPairRequest[]>([]);
  const [requestMarket, setRequestMarket] = useState('');
  const [requestInterval, setRequestInterval] = useState('1h');
  const [requestNote, setRequestNote] = useState('');

  const [algofundRiskMultiplier, setAlgofundRiskMultiplier] = useState(1);
  const [algofundNote, setAlgofundNote] = useState('');
  const [systemDetailModal, setSystemDetailModal] = useState<{ name: string; id: number } | null>(null);

  const strategyState = workspace?.strategyState || null;
  const algofundState = workspace?.algofundState || null;
  const strategyWorkspace = strategyState || strategyStateExtra;
  const algofundWorkspace = algofundState || algofundStateExtra;
  const clientUser = workspace?.auth?.user || null;
  const onboardingCompleted = Boolean(clientUser?.onboardingCompletedAt);

  const strategyPreviewSummary = strategySelectionPreview?.preview?.summary || {};
  const strategyPreviewSeries = useMemo(() => toLineSeriesData(strategySelectionPreview?.preview?.equity), [strategySelectionPreview]);
  const algofundPreviewSeries = useMemo(() => toLineSeriesData(algofundWorkspace?.preview?.equityCurve), [algofundWorkspace]);
  const algofundPublishedSystemName = String((algofundWorkspace?.profile as any)?.published_system_name || '').trim();
  const algofundAssignedApiKey = String((algofundWorkspace?.profile as any)?.assigned_api_key_name || '').trim();
  const algofundAvailableSystems = Array.isArray(algofundWorkspace?.availableSystems) ? (algofundWorkspace?.availableSystems || []) : [];
  const algofundCurrentSystem = algofundPublishedSystemName
    ? (algofundAvailableSystems.find((item) => String(item?.name || '').trim() === algofundPublishedSystemName) || null)
    : null;
  const monitoringSeries = useMemo(
    () => toLineSeriesData((monitoring?.points || []).map((point) => ({
      time: point.time ?? point.ts ?? point.recorded_at,
      equity: point.equity_usd ?? point.equity ?? point.value,
    }))),
    [monitoring]
  );

  const loadWorkspace = async () => {
    setLoading(true);
    setErrorText('');

    try {
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
        axios.get<MonitoringPayload>('/api/client/monitoring'),
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

    setAlgofundRiskMultiplier(toFinite(algofundWorkspace.profile.risk_multiplier, 1));
    setAlgofundAssignedApiKeyName(String(algofundWorkspace.profile.assigned_api_key_name || '').trim());
  }, [algofundWorkspace]);

  useEffect(() => {
    if (workspace?.productMode === 'strategy_client') {
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
            ? 'Запрос на запуск отправлен'
            : 'Запрос на остановку отправлен'
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

  const sendAlgofundRequest = async (requestType: 'start' | 'stop') => {
    setActionLoading(`algofund-${requestType}`);
    try {
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

  const downloadGuide = async (guide: GuideItem) => {
    setActionLoading(`guide-${guide.id}`);
    try {
      const response = await axios.get(guide.downloadUrl, { responseType: 'blob' });
      const blob = new Blob([response.data], { type: 'text/markdown;charset=utf-8' });
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${guide.id}-api-key-quick-guide.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.onboarding.guideDownloadFailed', 'Failed to download guide')));
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
          {/* Витрина офферов */}
          <Card className="battletoads-card" title="Витрина стратегий" size="small">
            {strategyWorkspace.offers.length === 0 ? (
              <Empty description="Офферов на витрине пока нет" />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {strategyWorkspace.capabilities?.settings ? (
                  <Typography.Text type="secondary">
                    Выберите стратегии для вашего портфеля и нажмите «Сохранить выбор».
                  </Typography.Text>
                ) : null}
                <Row gutter={[12, 12]}>
                  {strategyWorkspace.offers.map((offer) => (
                    <Col key={offer.offerId} xs={24} sm={12} xl={8}>
                      <Card
                        size="small"
                        bordered
                        style={{ height: '100%', cursor: strategyWorkspace.capabilities?.settings ? 'pointer' : 'default' }}
                        onClick={() => {
                          if (!strategyWorkspace.capabilities?.settings) return;
                          setStrategyOfferIds((current) =>
                            current.includes(offer.offerId)
                              ? current.filter((id) => id !== offer.offerId)
                              : [...current, offer.offerId]
                          );
                        }}
                        extra={
                          strategyWorkspace.capabilities?.settings
                            ? <Checkbox checked={strategyOfferIds.includes(offer.offerId)} onChange={(e) => { e.stopPropagation(); setStrategyOfferIds((current) => e.target.checked ? (current.includes(offer.offerId) ? current : [...current, offer.offerId]) : current.filter((id) => id !== offer.offerId)); }} />
                            : null
                        }
                      >
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <Typography.Text strong style={{ fontSize: 13 }}>{offer.titleRu}</Typography.Text>
                          <Space size={4} wrap>
                            <Tag style={{ fontSize: 11 }}>{offer.strategy.mode.toUpperCase()}</Tag>
                            <Tag style={{ fontSize: 11 }}>{offer.strategy.market}</Tag>
                            {offer.strategy.type ? <Tag style={{ fontSize: 11 }}>{offer.strategy.type}</Tag> : null}
                          </Space>
                          <Space size={4} wrap>
                            <Tag color="green">Ret: {formatPercent(offer.metrics.ret)}</Tag>
                            <Tag color="orange">DD: {formatPercent(offer.metrics.dd)}</Tag>
                            <Tag color="blue">PF: {formatNumber(offer.metrics.pf)}</Tag>
                            {offer.metrics.trades ? <Tag color="cyan">Сделки: {formatNumber(offer.metrics.trades, 0)}</Tag> : null}
                          </Space>
                          {Array.isArray(offer.equityPoints) && offer.equityPoints.length > 0 ? (
                            <div style={{ height: 80, marginTop: 4 }}>
                              <ChartComponent data={offer.equityPoints.map((v, i) => ({ time: i, value: v }))} type="line" />
                            </div>
                          ) : null}
                        </Space>
                      </Card>
                    </Col>
                  ))}
                </Row>
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

          {/* Настройки риска */}
          {strategyWorkspace.capabilities?.settings ? (
            <Card className="battletoads-card" title="Настройки риска и частоты" size="small">
              <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                  <Typography.Text strong>Риск: {formatNumber(strategyRiskInput, 1)}</Typography.Text>
                  <Slider min={0} max={10} step={0.1} value={strategyRiskInput} onChange={(v) => setStrategyRiskInput(toFinite(v))} />
                </Col>
                <Col xs={24} md={12}>
                  <Typography.Text strong>Частота сделок: {formatNumber(strategyTradeInput, 1)}</Typography.Text>
                  <Slider min={0} max={10} step={0.1} value={strategyTradeInput} onChange={(v) => setStrategyTradeInput(toFinite(v))} />
                </Col>
              </Row>
              <Button type="primary" style={{ marginTop: 8 }} loading={actionLoading === 'strategy-save'} onClick={() => void saveStrategyProfile()}>
                Сохранить настройки
              </Button>
            </Card>
          ) : null}

          <Card className="battletoads-card" title="Статус торговли" size="small">
            <Space wrap style={{ marginBottom: 8 }}>
              <Tag color="blue">Тариф: {strategyWorkspace.plan?.title || '—'}</Tag>
              <Tag color="cyan">Депозит до: {formatMoney(strategyWorkspace.plan?.max_deposit_total)}</Tag>
              <Tag color="purple">Стратегий до: {formatNumber(strategyWorkspace.plan?.max_strategies_total, 0)}</Tag>
              <Tag color={strategyWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                {strategyWorkspace.profile?.actual_enabled ? 'Торговля активна' : 'Торговля остановлена'}
              </Tag>
              <Tag color={strategyWorkspace.profile?.requested_enabled ? 'processing' : 'default'}>
                Запрос: {strategyWorkspace.profile?.requested_enabled ? 'запуск' : 'остановка'}
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

          {strategyWorkspace.capabilities?.startStopRequests ? (
            <Card className="battletoads-card" title="Подключение / отключение" size="small">
              <Space wrap>
                <Button type="primary" loading={actionLoading === 'strategy-start'} onClick={() => void saveStrategyProfile(true)}>
                  Запросить запуск
                </Button>
                <Button danger loading={actionLoading === 'strategy-stop'} onClick={() => void saveStrategyProfile(false)}>
                  Запросить остановку
                </Button>
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
      ) : workspace?.productMode === 'algofund_client' && algofundAvailableSystems.length > 0 ? (
        <Card className="battletoads-card" title="Доступные торговые системы" size="small">
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            Ваш аккаунт подключён к продукту «Алгофонд». Подробности — на вкладке «Алгофонд».
          </Typography.Text>
          <Row gutter={[8, 8]}>
            {algofundAvailableSystems.map((system) => {
              const isCurrent = algofundPublishedSystemName.length > 0 && String(system?.name || '').trim() === algofundPublishedSystemName;
              const snap = (system as any).backtestSnapshot as { equityPoints?: number[]; periodDays?: number; ret?: number; dd?: number; pf?: number; trades?: number } | null;
              const eqPts = snap?.equityPoints;
              return (
                <Col xs={24} sm={12} md={8} xl={6} key={String(system?.id || system?.name || Math.random())}>
                  <Card
                    size="small"
                    hoverable
                    onClick={() => setSystemDetailModal({ name: system.name, id: system.id })}
                    style={isCurrent ? { borderColor: '#52c41a', borderWidth: 2, cursor: 'pointer' } : { cursor: 'pointer' }}
                  >
                    <Typography.Text strong style={{ fontSize: 12 }}>{tsDisplayName(system.name)}</Typography.Text>
                    {isCurrent ? <Tag color="gold" style={{ marginLeft: 4, fontSize: 10 }}>Подключена</Tag> : null}
                    {Array.isArray(eqPts) && eqPts.length > 1 ? (
                      <div style={{ height: 60, marginTop: 4 }}>
                        <ChartComponent data={equityPointsToSeries(eqPts, snap?.periodDays)} type="line" />
                      </div>
                    ) : null}
                    {snap ? (
                      <Row gutter={[4, 0]} style={{ marginTop: 4 }}>
                        <Col span={12}><Statistic title="Доход" value={formatPercent(snap.ret ?? 0)} valueStyle={{ fontSize: 12, color: (snap.ret ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }} /></Col>
                        <Col span={12}><Statistic title="DD" value={formatPercent(snap.dd ?? 0)} valueStyle={{ fontSize: 12, color: '#ff7a45' }} /></Col>
                      </Row>
                    ) : null}
                    <Typography.Text type="secondary" style={{ fontSize: 10, marginTop: 2, display: 'block' }}>
                      📊 Нажмите для настройки
                    </Typography.Text>
                  </Card>
                </Col>
              );
            })}
          </Row>
        </Card>
      ) : (
        <Card className="battletoads-card" size="small">
          <Empty
            description={
              <Space direction="vertical" size={8}>
                <Typography.Text>Витрина стратегий недоступна для вашего аккаунта.</Typography.Text>
                <Typography.Text type="secondary">Обратитесь к администратору для подключения к продукту «Клиент стратегий».</Typography.Text>
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

          <Card className="battletoads-card" title="Витрина торговых систем Алгофонда" size="small">
            {algofundAvailableSystems.length === 0 ? (
              <Empty description="Торговые системы Алгофонда пока не опубликованы" />
            ) : (
              <>
                {algofundWorkspace.capabilities?.settings ? (
                  <div style={{ marginBottom: 16, padding: '8px 12px', background: '#fafafa', borderRadius: 6 }}>
                    <Row align="middle" gutter={16}>
                      <Col flex="auto">
                        <Typography.Text strong>Риск × {formatNumber(algofundRiskMultiplier, 2)}</Typography.Text>
                        <Slider
                          style={{ margin: '4px 0 0' }}
                          min={0}
                          max={toFinite(algofundWorkspace.plan?.risk_cap_max, 1)}
                          step={0.05}
                          value={algofundRiskMultiplier}
                          onChange={(v) => setAlgofundRiskMultiplier(Math.min(toFinite(v), toFinite(algofundWorkspace.plan?.risk_cap_max, 1)))}
                        />
                      </Col>
                      <Col>
                        <Space>
                          <Button size="small" type="primary" loading={actionLoading === 'algofund-save'} onClick={() => void saveAlgofundProfile()}>
                            Сохранить
                          </Button>
                          <Button size="small" loading={actionLoading === 'algofund-refresh'} onClick={() => void refreshAlgofundState()}>
                            Обновить
                          </Button>
                        </Space>
                      </Col>
                    </Row>
                  </div>
                ) : null}
                <Row gutter={[8, 8]}>
                  {algofundAvailableSystems.map((system) => {
                    const isCurrent = algofundPublishedSystemName.length > 0 && String(system?.name || '').trim() === algofundPublishedSystemName;
                    const snap = (system as any).backtestSnapshot as { ret: number; pf: number; dd: number; trades: number; equityPoints: number[]; finalEquity: number; periodDays: number; tradesPerDay: number } | null | undefined;
                    const previewSummary = isCurrent ? (algofundWorkspace?.preview?.summary || null) : null;
                    const eqPts = snap?.equityPoints;
                    const hasChart = isCurrent ? algofundPreviewSeries.length > 0 : (Array.isArray(eqPts) && eqPts.length > 1);
                    return (
                      <Col xs={24} sm={12} md={8} xl={6} key={String(system?.id || system?.name || Math.random())}>
                        <Card
                          size="small"
                          className="battletoads-card"
                          hoverable
                          onClick={() => setSystemDetailModal({ name: system.name, id: system.id })}
                          style={isCurrent ? { borderColor: '#52c41a', borderWidth: 2, cursor: 'pointer' } : { cursor: 'pointer' }}
                          title={
                            <span>
                              <Typography.Text strong style={{ fontSize: 12 }}>{tsDisplayName(system.name)}</Typography.Text>
                              {isCurrent ? <Tag color="gold" style={{ marginLeft: 4, fontSize: 10 }}>Подключена</Tag> : null}
                            </span>
                          }
                        >
                          <Space wrap size={4} style={{ marginBottom: 4 }}>
                            {snap?.periodDays ? <Tag style={{ fontSize: 11 }}>{Math.round(snap.periodDays)}д</Tag> : null}
                            {snap?.trades ? <Tag style={{ fontSize: 11 }}>{snap.trades} сд.</Tag> : null}
                          </Space>
                          {hasChart ? (
                            <div style={{ height: 80, marginBottom: 4 }}>
                              <ChartComponent
                                data={isCurrent && algofundPreviewSeries.length > 0
                                  ? algofundPreviewSeries
                                  : equityPointsToSeries(eqPts || [], snap?.periodDays)}
                                type="line"
                              />
                            </div>
                          ) : (
                            <div style={{ height: 80, marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>Бэктест не загружен</Typography.Text>
                            </div>
                          )}
                          {snap ? (
                            <Row gutter={[4, 0]}>
                              <Col span={12}><Statistic title="Доход" value={formatPercent(previewSummary?.totalReturnPercent ?? snap.ret)} valueStyle={{ fontSize: 12, color: (previewSummary?.totalReturnPercent ?? snap.ret) >= 0 ? '#52c41a' : '#ff4d4f' }} /></Col>
                              <Col span={12}><Statistic title="DD" value={formatPercent(previewSummary?.maxDrawdownPercent ?? snap.dd)} valueStyle={{ fontSize: 12, color: '#ff7a45' }} /></Col>
                              <Col span={12}><Statistic title="PF" value={formatNumber(previewSummary?.profitFactor ?? snap.pf)} valueStyle={{ fontSize: 12 }} /></Col>
                              <Col span={12}><Statistic title="Сделки" value={formatNumber(previewSummary?.tradesCount ?? snap.trades, 0)} valueStyle={{ fontSize: 12 }} /></Col>
                            </Row>
                          ) : previewSummary ? (
                            <Row gutter={[4, 0]}>
                              {previewSummary.totalReturnPercent != null ? <Col span={12}><Statistic title="Доход" value={formatPercent(previewSummary.totalReturnPercent)} valueStyle={{ fontSize: 12 }} /></Col> : null}
                              {previewSummary.maxDrawdownPercent != null ? <Col span={12}><Statistic title="DD" value={formatPercent(previewSummary.maxDrawdownPercent)} valueStyle={{ fontSize: 12 }} /></Col> : null}
                              {previewSummary.profitFactor != null ? <Col span={12}><Statistic title="PF" value={formatNumber(previewSummary.profitFactor)} valueStyle={{ fontSize: 12 }} /></Col> : null}
                              {previewSummary.tradesCount != null ? <Col span={12}><Statistic title="Сделки" value={formatNumber(previewSummary.tradesCount, 0)} valueStyle={{ fontSize: 12 }} /></Col> : null}
                            </Row>
                          ) : null}
                          <Typography.Text type="secondary" style={{ fontSize: 10, marginTop: 2, display: 'block' }}>
                            📊 Нажмите для бэктеста
                          </Typography.Text>
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
              </>
            )}
          </Card>

          {/* Detail modal for a selected system card */}
          <Modal
            title={systemDetailModal ? tsDisplayName(systemDetailModal.name) : ''}
            open={!!systemDetailModal}
            onCancel={() => setSystemDetailModal(null)}
            footer={null}
            width={640}
          >
            {(() => {
              if (!systemDetailModal) return null;
              const system = algofundAvailableSystems.find((s) => s.id === systemDetailModal.id);
              if (!system) return <Empty description="Система не найдена" />;
              const isCurrent = algofundPublishedSystemName.length > 0 && String(system.name || '').trim() === algofundPublishedSystemName;
              const snap = (system as any).backtestSnapshot as { ret: number; pf: number; dd: number; trades: number; equityPoints: number[]; finalEquity: number; periodDays: number; tradesPerDay: number } | null | undefined;
              const eqPts = snap?.equityPoints;
              const chartData = isCurrent && algofundPreviewSeries.length > 0
                ? algofundPreviewSeries
                : Array.isArray(eqPts) && eqPts.length > 1
                  ? equityPointsToSeries(eqPts, snap?.periodDays)
                  : [];
              return (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap>
                    {isCurrent ? <Tag color="gold">Подключена к вашему аккаунту</Tag> : <Tag color="blue">Доступна для подключения</Tag>}
                    {snap?.periodDays ? <Tag>Период: {Math.round(snap.periodDays)}д</Tag> : null}
                    {snap?.trades ? <Tag>{snap.trades} сделок</Tag> : null}
                  </Space>
                  {chartData.length > 0 ? (
                    <div style={{ height: 240 }}>
                      <ChartComponent data={chartData} type="line" />
                    </div>
                  ) : null}
                  {snap ? (
                    <Row gutter={[12, 12]}>
                      <Col xs={12} sm={6}><Statistic title="Доход" value={formatPercent(snap.ret)} valueStyle={{ color: snap.ret >= 0 ? '#52c41a' : '#ff4d4f' }} /></Col>
                      <Col xs={12} sm={6}><Statistic title="Макс. DD" value={formatPercent(snap.dd)} valueStyle={{ color: '#ff7a45' }} /></Col>
                      <Col xs={12} sm={6}><Statistic title="PF" value={formatNumber(snap.pf)} /></Col>
                      <Col xs={12} sm={6}><Statistic title="Сделки" value={formatNumber(snap.trades, 0)} /></Col>
                      <Col xs={12} sm={6}><Statistic title="Сд./день" value={formatNumber(snap.tradesPerDay, 1)} /></Col>
                      <Col xs={12} sm={6}><Statistic title="Итог. капитал" value={formatMoney(snap.finalEquity)} /></Col>
                    </Row>
                  ) : null}
                  {algofundWorkspace?.capabilities?.settings ? (
                    <div style={{ padding: '8px 0' }}>
                      <Typography.Text strong>Мультипликатор риска: × {formatNumber(algofundRiskMultiplier, 2)}</Typography.Text>
                      <Slider
                        min={0}
                        max={toFinite(algofundWorkspace.plan?.risk_cap_max, 1)}
                        step={0.05}
                        value={algofundRiskMultiplier}
                        onChange={(v) => setAlgofundRiskMultiplier(Math.min(toFinite(v), toFinite(algofundWorkspace.plan?.risk_cap_max, 1)))}
                        onAfterChange={() => void refreshAlgofundState()}
                      />
                      <Space wrap>
                        <Button type="primary" size="small" loading={actionLoading === 'algofund-save'} onClick={() => void saveAlgofundProfile()}>
                          Сохранить риск
                        </Button>
                        <Button size="small" loading={actionLoading === 'algofund-refresh'} onClick={() => void refreshAlgofundState()}>
                          Обновить предпросмотр
                        </Button>
                      </Space>
                    </div>
                  ) : null}
                  {!isCurrent ? (
                    <Typography.Text type="secondary">
                      Для подключения этой системы используйте раздел «Подключение / отключение» ниже.
                    </Typography.Text>
                  ) : null}
                </Space>
              );
            })()}
          </Modal>

          <Card className="battletoads-card" title="Подключение / отключение" size="small">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Input.TextArea
                rows={2}
                value={algofundNote}
                onChange={(e) => setAlgofundNote(e.target.value)}
                placeholder="Комментарий к запросу (необязательно)"
              />
              <Space wrap>
                <Button type="primary" loading={actionLoading === 'algofund-start'} onClick={() => void sendAlgofundRequest('start')}>
                  Запросить подключение
                </Button>
                <Button danger loading={actionLoading === 'algofund-stop'} onClick={() => void sendAlgofundRequest('stop')}>
                  Запросить отключение
                </Button>
              </Space>

              {(algofundWorkspace.requests || []).length > 0 ? (
                <>
                  <Typography.Text type="secondary">История запросов:</Typography.Text>
                  <List
                    size="small"
                    dataSource={algofundWorkspace.requests || []}
                    renderItem={(item) => (
                      <List.Item>
                        <Space wrap>
                          <Tag color="blue">#{item.id}</Tag>
                          <Tag color={item.request_type === 'start' ? 'success' : 'orange'}>{item.request_type === 'start' ? 'Подключение' : 'Отключение'}</Tag>
                          <Tag color={item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'error' : 'processing'}>
                            {item.status === 'approved' ? 'Одобрено' : item.status === 'rejected' ? 'Отклонено' : 'В обработке'}
                          </Tag>
                          <Typography.Text type="secondary">{item.created_at}</Typography.Text>
                          {item.note ? <Typography.Text type="secondary">{item.note}</Typography.Text> : null}
                          {item.decision_note ? <Typography.Text type="secondary">({item.decision_note})</Typography.Text> : null}
                        </Space>
                      </List.Item>
                    )}
                  />
                </>
              ) : null}
            </Space>
          </Card>
        </>
      ) : (
        <Card className="battletoads-card" size="small">
          <Empty
            description={
              <Space direction="vertical" size={8}>
                <Typography.Text>Алгофонд недоступен для вашего аккаунта.</Typography.Text>
                <Typography.Text type="secondary">Обратитесь к администратору для подключения к продукту «Алгофонд».</Typography.Text>
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
            {workspace?.productMode === 'algofund_client' ? 'Алгофонд-клиент' : 'Клиент стратегий'}
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

      <Card className="battletoads-card" title="API ключи биржи" size="small">
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
                    <Button key={guide.id} size="small" loading={actionLoading === `guide-${guide.id}`} onClick={() => void downloadGuide(guide)}>
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
              <Button key={guide.id} size="small" loading={actionLoading === `guide-${guide.id}`} onClick={() => void downloadGuide(guide)}>
                {guide.title}
              </Button>
            ))}
          </Space>
        ) : null}

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
          <Tag color="green">Цена: {formatMoney(tariff?.currentPlan?.price_usdt)}/мес</Tag>
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
                label: `${plan.title} (${formatMoney(plan.price_usdt)}/мес — до ${formatMoney(plan.max_deposit_total)})`,
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
            defaultActiveKey={workspace.productMode === 'algofund_client' ? 'algofund' : 'strategy'}
            items={[
              {
                key: 'strategy',
                label: 'Клиент стратегий',
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

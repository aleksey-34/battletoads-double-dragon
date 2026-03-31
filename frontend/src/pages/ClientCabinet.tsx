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
  Popconfirm,
  Row,
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

type ProductMode = 'strategy_client' | 'algofund_client';
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
    equity_usd?: number;
    equity?: number;
    value?: number;
    time?: number;
  }>;
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
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
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
      time: point.time ?? point.ts,
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
  }, [strategyWorkspace]);

  useEffect(() => {
    if (!algofundWorkspace?.profile) {
      return;
    }

    setAlgofundRiskMultiplier(toFinite(algofundWorkspace.profile.risk_multiplier, 1));
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

  const saveStrategyProfile = async () => {
    setActionLoading('strategy-save');
    try {
      const response = await axios.patch('/api/client/strategy/profile', {
        selectedOfferIds: strategyOfferIds,
        riskLevel: sliderValueToLevel(strategyRiskInput),
        tradeFrequencyLevel: sliderValueToLevel(strategyTradeInput),
      });

      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          strategyState: response.data?.state || current.strategyState,
        };
      });
      messageApi.success(t('client.strategy.saved', 'Preferences saved'));
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

  const saveClientApiKey = async () => {
    if (!apiKeyDraft.apiKey.trim() || !apiKeyDraft.secret.trim()) {
      messageApi.error(t('client.apiKey.required', 'API key and secret are required'));
      return;
    }

    setActionLoading('client-api-key');
    try {
      const response = await axios.post('/api/client/api-key', {
        exchange: apiKeyDraft.exchange,
        apiKey: apiKeyDraft.apiKey,
        secret: apiKeyDraft.secret,
        passphrase: apiKeyDraft.passphrase,
        testnet: apiKeyDraft.testnet,
        demo: apiKeyDraft.demo,
      });

      setApiKeyDraft((current) => ({
        ...current,
        apiKey: '',
        secret: '',
        passphrase: '',
      }));

      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          strategyState: response.data?.strategyState || current.strategyState,
          algofundState: response.data?.algofundState || current.algofundState,
        };
      });

      messageApi.success(t('client.apiKey.saved', 'API key saved and connected to your workspace'));
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.apiKey.saveFailed', 'Failed to save API key')));
    } finally {
      setActionLoading('');
    }
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

  const refreshMonitoring = async () => {
    setActionLoading('monitoring-refresh');
    try {
      const response = await axios.get<MonitoringPayload>('/api/client/monitoring');
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
        {capabilityTag('РќР°СЃС‚СЂРѕР№РєРё', Boolean(capabilities.settings))}
        {capabilityTag('РњРѕРЅРёС‚РѕСЂРёРЅРі', Boolean(capabilities.monitoring))}
        {capabilityTag('Р‘СЌРєС‚РµСЃС‚', Boolean(capabilities.backtest))}
        {capabilityTag('РЎС‚Р°СЂС‚/РЎС‚РѕРї', Boolean(capabilities.startStopRequests))}
      </Space>
    );
  };

  // в”Ђв”Ђ Tab: РЎС‚СЂР°С‚РµРіРёРё в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  const strategyTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {strategyWorkspace ? (
        <>
          {/* Р’РёС‚СЂРёРЅР° РѕС„С„РµСЂРѕРІ */}
          <Card className="battletoads-card" title="Р’РёС‚СЂРёРЅР° СЃС‚СЂР°С‚РµРіРёР№" size="small">
            {strategyWorkspace.offers.length === 0 ? (
              <Empty description="РћС„С„РµСЂРѕРІ РЅР° РІРёС‚СЂРёРЅРµ РїРѕРєР° РЅРµС‚" />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {strategyWorkspace.capabilities?.settings ? (
                  <Typography.Text type="secondary">
                    Р’С‹Р±РµСЂРёС‚Рµ СЃС‚СЂР°С‚РµРіРёРё РґР»СЏ РІР°С€РµРіРѕ РїРѕСЂС‚С„РµР»СЏ Рё РЅР°Р¶РјРёС‚Рµ В«РЎРѕС…СЂР°РЅРёС‚СЊ РІС‹Р±РѕСЂВ».
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
                            {offer.metrics.trades ? <Tag color="cyan">РЎРґРµР»РєРё: {formatNumber(offer.metrics.trades, 0)}</Tag> : null}
                          </Space>
                        </Space>
                      </Card>
                    </Col>
                  ))}
                </Row>
                {strategyWorkspace.capabilities?.settings ? (
                  <Space wrap>
                    <Typography.Text>
                      Р’С‹Р±СЂР°РЅРѕ: <Typography.Text strong>{strategyOfferIds.length}</Typography.Text> РёР· {strategyWorkspace.offers.length}
                    </Typography.Text>
                    <Button type="primary" loading={actionLoading === 'strategy-save'} onClick={() => void saveStrategyProfile()}>
                      РЎРѕС…СЂР°РЅРёС‚СЊ РІС‹Р±РѕСЂ
                    </Button>
                    <Button loading={strategySelectionPreviewLoading} onClick={() => void runStrategySelectionPreview()}>
                      РџСЂРµРґРїСЂРѕСЃРјРѕС‚СЂ РїРѕСЂС‚С„РµР»СЏ
                    </Button>
                  </Space>
                ) : null}
              </Space>
            )}
          </Card>

          {/* РџСЂРµРґРїСЂРѕСЃРјРѕС‚СЂ РїРѕСЂС‚С„РµР»СЏ */}
          {strategySelectionPreview ? (
            <Card className="battletoads-card" title="РџСЂРµРґРїСЂРѕСЃРјРѕС‚СЂ РІС‹Р±СЂР°РЅРЅС‹С… СЃС‚СЂР°С‚РµРіРёР№" size="small">
              <Space wrap style={{ marginBottom: 12 }}>
                <Tag color="cyan">РЎС‚СЂР°С‚РµРіРёР№: {strategySelectionPreview.selectedOffers.length}</Tag>
                <Tag color="green">Р”РѕС…РѕРґРЅРѕСЃС‚СЊ: {formatPercent((strategyPreviewSummary as any)?.totalReturnPercent)}</Tag>
                <Tag color="orange">DD: {formatPercent((strategyPreviewSummary as any)?.maxDrawdownPercent)}</Tag>
                <Tag color="purple">PF: {formatNumber((strategyPreviewSummary as any)?.profitFactor)}</Tag>
              </Space>
              {strategyPreviewSeries.length > 0 ? (
                <ChartComponent data={strategyPreviewSeries} type="line" />
              ) : (
                <Empty description="РќРµС‚ РґР°РЅРЅС‹С… РґР»СЏ РїСЂРµРґРїСЂРѕСЃРјРѕС‚СЂР°" />
              )}
            </Card>
          ) : null}

          {/* РќР°СЃС‚СЂРѕР№РєРё СЂРёСЃРєР° */}
          {strategyWorkspace.capabilities?.settings ? (
            <Card className="battletoads-card" title="РќР°СЃС‚СЂРѕР№РєРё СЂРёСЃРєР° Рё С‡Р°СЃС‚РѕС‚С‹" size="small">
              <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                  <Typography.Text strong>Р РёСЃРє: {formatNumber(strategyRiskInput, 1)}</Typography.Text>
                  <Slider min={0} max={10} step={0.1} value={strategyRiskInput} onChange={(v) => setStrategyRiskInput(toFinite(v))} />
                </Col>
                <Col xs={24} md={12}>
                  <Typography.Text strong>Р§Р°СЃС‚РѕС‚Р° СЃРґРµР»РѕРє: {formatNumber(strategyTradeInput, 1)}</Typography.Text>
                  <Slider min={0} max={10} step={0.1} value={strategyTradeInput} onChange={(v) => setStrategyTradeInput(toFinite(v))} />
                </Col>
              </Row>
              <Button type="primary" style={{ marginTop: 8 }} loading={actionLoading === 'strategy-save'} onClick={() => void saveStrategyProfile()}>
                РЎРѕС…СЂР°РЅРёС‚СЊ РЅР°СЃС‚СЂРѕР№РєРё
              </Button>
            </Card>
          ) : null}

          {/* РЎС‚Р°С‚СѓСЃ С‚РѕСЂРіРѕРІР»Рё */}
          <Card className="battletoads-card" title="РЎС‚Р°С‚СѓСЃ С‚РѕСЂРіРѕРІР»Рё" size="small">
            <Space wrap>
              <Tag color="blue">РўР°СЂРёС„: {strategyWorkspace.plan?.title || 'вЂ”'}</Tag>
              <Tag color="cyan">Р”РµРїРѕР·РёС‚ РґРѕ: {formatMoney(strategyWorkspace.plan?.max_deposit_total)}</Tag>
              <Tag color="purple">РЎС‚СЂР°С‚РµРіРёР№ РґРѕ: {formatNumber(strategyWorkspace.plan?.max_strategies_total, 0)}</Tag>
              <Tag color={strategyWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                {strategyWorkspace.profile?.actual_enabled ? 'РўРѕСЂРіРѕРІР»СЏ Р°РєС‚РёРІРЅР°' : 'РўРѕСЂРіРѕРІР»СЏ РѕСЃС‚Р°РЅРѕРІР»РµРЅР°'}
              </Tag>
              <Tag color={strategyWorkspace.profile?.requested_enabled ? 'processing' : 'default'}>
                Р—Р°РїСЂРѕСЃ: {strategyWorkspace.profile?.requested_enabled ? 'Р·Р°РїСѓС‰РµРЅ' : 'РѕСЃС‚Р°РЅРѕРІР»РµРЅ'}
              </Tag>
            </Space>
            {renderCapabilities(strategyWorkspace.capabilities)}
          </Card>

          {/* Р—Р°РїСЂРѕСЃС‹ РЅР° СЃС‚Р°СЂС‚/СЃС‚РѕРї */}
          {strategyWorkspace.capabilities?.startStopRequests ? (
            <Card className="battletoads-card" title="Р—Р°РїСЂРѕСЃРёС‚СЊ Р·Р°РїСѓСЃРє / РѕСЃС‚Р°РЅРѕРІРєСѓ" size="small">
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input.TextArea
                  rows={2}
                  value={algofundNote}
                  onChange={(e) => setAlgofundNote(e.target.value)}
                  placeholder="РљРѕРјРјРµРЅС‚Р°СЂРёР№ Рє Р·Р°РїСЂРѕСЃСѓ (РЅРµРѕР±СЏР·Р°С‚РµР»СЊРЅРѕ)"
                />
                <Space wrap>
                  <Button type="primary" loading={actionLoading === 'algofund-start'} onClick={() => void sendAlgofundRequest('start')}>
                    Р—Р°РїСЂРѕСЃРёС‚СЊ Р·Р°РїСѓСЃРє
                  </Button>
                  <Button danger loading={actionLoading === 'algofund-stop'} onClick={() => void sendAlgofundRequest('stop')}>
                    Р—Р°РїСЂРѕСЃРёС‚СЊ РѕСЃС‚Р°РЅРѕРІРєСѓ
                  </Button>
                </Space>
              </Space>
            </Card>
          ) : null}

          {/* Р—Р°РїСЂРѕСЃРёС‚СЊ Р±СЌРєС‚РµСЃС‚ РїР°СЂС‹ */}
          <Card className="battletoads-card" title="Р—Р°РїСЂРѕСЃРёС‚СЊ Р±СЌРєС‚РµСЃС‚ РїРѕ РїР°СЂРµ" size="small">
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Row gutter={[8, 8]}>
                <Col xs={24} sm={12}>
                  <Input
                    placeholder="РџР°СЂР°: SOLUSDT РёР»Рё BTC/ETH"
                    value={requestMarket}
                    onChange={(e) => setRequestMarket(e.target.value)}
                  />
                </Col>
                <Col xs={24} sm={12}>
                  <Input
                    placeholder="РРЅС‚РµСЂРІР°Р» (1h, 4h, 1d)"
                    value={requestInterval}
                    onChange={(e) => setRequestInterval(e.target.value)}
                  />
                </Col>
              </Row>
              <Input.TextArea
                rows={2}
                value={requestNote}
                onChange={(e) => setRequestNote(e.target.value)}
                placeholder="РљРѕРјРјРµРЅС‚Р°СЂРёР№ РґР»СЏ РёСЃСЃР»РµРґРѕРІР°РЅРёСЏ (РЅРµРѕР±СЏР·Р°С‚РµР»СЊРЅРѕ)"
              />
              <Space wrap>
                <Button type="primary" loading={actionLoading === 'strategy-backtest-request'} onClick={() => void sendBacktestPairRequest()}>
                  РћС‚РїСЂР°РІРёС‚СЊ Р·Р°РїСЂРѕСЃ
                </Button>
                <Button onClick={() => void loadBacktestRequests()}>РћР±РЅРѕРІРёС‚СЊ СЃРїРёСЃРѕРє</Button>
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
      ) : (
        <Card className="battletoads-card" size="small">
          <Empty
            description={
              <Space direction="vertical" size={8}>
                <Typography.Text>Р’РёС‚СЂРёРЅР° СЃС‚СЂР°С‚РµРіРёР№ РЅРµРґРѕСЃС‚СѓРїРЅР° РґР»СЏ РІР°С€РµРіРѕ Р°РєРєР°СѓРЅС‚Р°.</Typography.Text>
                <Typography.Text type="secondary">РћР±СЂР°С‚РёС‚РµСЃСЊ Рє Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ РґР»СЏ РїРѕРґРєР»СЋС‡РµРЅРёСЏ Рє РїСЂРѕРґСѓРєС‚Сѓ В«РљР»РёРµРЅС‚ СЃС‚СЂР°С‚РµРіРёР№В».</Typography.Text>
              </Space>
            }
          />
        </Card>
      )}
    </Space>
  );

  // в”Ђв”Ђ Tab: РђР»РіРѕС„РѕРЅРґ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  const algofundTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {algofundWorkspace ? (
        <>
          {/* РЎС‚Р°С‚СѓСЃ */}
          <Card className="battletoads-card" title="РЎС‚Р°С‚СѓСЃ РђР»РіРѕС„РѕРЅРґР°" size="small">
            <Space wrap>
              <Tag color="blue">РўР°СЂРёС„: {algofundWorkspace.plan?.title || 'вЂ”'}</Tag>
              <Tag color="cyan">Р”РµРїРѕР·РёС‚ РґРѕ: {formatMoney(algofundWorkspace.plan?.max_deposit_total)}</Tag>
              <Tag color="purple">Р РёСЃРє-РєР°Рї: {formatNumber(algofundWorkspace.plan?.risk_cap_max)}</Tag>
              <Tag color={algofundWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                {algofundWorkspace.profile?.actual_enabled ? 'РўРѕСЂРіРѕРІР»СЏ Р°РєС‚РёРІРЅР°' : 'РўРѕСЂРіРѕРІР»СЏ РѕСЃС‚Р°РЅРѕРІР»РµРЅР°'}
              </Tag>
              {algofundAssignedApiKey ? <Tag color="geekblue">API: {algofundAssignedApiKey}</Tag> : null}
            </Space>
            {renderCapabilities(algofundWorkspace.capabilities)}
          </Card>

          {/* Р’РёС‚СЂРёРЅР° РўРЎ РђР»РіРѕС„РѕРЅРґР° */}
          <Card className="battletoads-card" title="Р”РѕСЃС‚СѓРїРЅС‹Рµ С‚РѕСЂРіРѕРІС‹Рµ СЃРёСЃС‚РµРјС‹" size="small">
            {algofundAvailableSystems.length === 0 ? (
              <Empty description="РўРѕСЂРіРѕРІС‹Рµ СЃРёСЃС‚РµРјС‹ РђР»РіРѕС„РѕРЅРґР° РЅРµ РѕРїСѓР±Р»РёРєРѕРІР°РЅС‹" />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <List
                  dataSource={algofundAvailableSystems}
                  renderItem={(system) => {
                    const isCurrent = String(system?.name || '').trim() === algofundPublishedSystemName;
                    return (
                      <List.Item>
                        <Space wrap style={{ width: '100%' }}>
                          <Typography.Text strong>{system.name}</Typography.Text>
                          <Tag color="blue">API: {system.apiKeyName}</Tag>
                          <Tag color="cyan">РЈС‡Р°СЃС‚РЅРёРєРё: {Number(system.memberCount || 0)}</Tag>
                          {system.isActive ? <Tag color="success">РђРєС‚РёРІРЅР°</Tag> : <Tag color="default">РќРµР°РєС‚РёРІРЅР°</Tag>}
                          {isCurrent ? <Tag color="gold">Р’Р°С€Р° С‚РµРєСѓС‰Р°СЏ РўРЎ</Tag> : null}
                        </Space>
                      </List.Item>
                    );
                  }}
                />
              </Space>
            )}
          </Card>

          {/* РџСЂРµРґРїСЂРѕСЃРјРѕС‚СЂ РїРѕСЂС‚С„РµР»СЏ Р°Р»РіРѕС„РѕРЅРґР° */}
          {!algofundWorkspace.preview?.blockedByPlan ? (
            <Card className="battletoads-card" title="РџСЂРµРґРїСЂРѕСЃРјРѕС‚СЂ РїРѕСЂС‚С„РµР»СЏ" size="small">
              <Space wrap style={{ marginBottom: 12 }}>
                <Tag color="green">Р”РѕС…РѕРґРЅРѕСЃС‚СЊ: {formatPercent(algofundWorkspace.preview?.summary?.totalReturnPercent)}</Tag>
                <Tag color="orange">DD: {formatPercent(algofundWorkspace.preview?.summary?.maxDrawdownPercent)}</Tag>
                <Tag color="purple">PF: {formatNumber(algofundWorkspace.preview?.summary?.profitFactor)}</Tag>
                <Tag color="blue">РЎРґРµР»РєРё: {formatNumber(algofundWorkspace.preview?.summary?.tradesCount, 0)}</Tag>
              </Space>
              {algofundPreviewSeries.length > 0 ? (
                <ChartComponent data={algofundPreviewSeries} type="line" />
              ) : (
                <Empty description="РќРµС‚ РґР°РЅРЅС‹С… РїСЂРµРґРїСЂРѕСЃРјРѕС‚СЂР°" />
              )}
            </Card>
          ) : (
            <Alert type="warning" showIcon message={algofundWorkspace.preview?.blockedReason || 'РџСЂРµРґРїСЂРѕСЃРјРѕС‚СЂ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ С‚РµРєСѓС‰РёРј С‚Р°СЂРёС„РѕРј'} />
          )}

          {/* Р РёСЃРє-РїСЂРѕС„РёР»СЊ */}
          {algofundWorkspace.capabilities?.settings ? (
            <Card className="battletoads-card" title="Р РёСЃРє-РїСЂРѕС„РёР»СЊ" size="small">
              <Typography.Text strong>РњСѓР»СЊС‚РёРїР»РёРєР°С‚РѕСЂ СЂРёСЃРєР°: {formatNumber(algofundRiskMultiplier, 2)}</Typography.Text>
              <Slider
                min={0}
                max={toFinite(algofundWorkspace.plan?.risk_cap_max, 1)}
                step={0.05}
                value={algofundRiskMultiplier}
                onChange={(v) => setAlgofundRiskMultiplier(Math.min(toFinite(v), toFinite(algofundWorkspace.plan?.risk_cap_max, 1)))}
              />
              <Space wrap style={{ marginTop: 8 }}>
                <Button type="primary" loading={actionLoading === 'algofund-save'} onClick={() => void saveAlgofundProfile()}>
                  РЎРѕС…СЂР°РЅРёС‚СЊ СЂРёСЃРє-РїСЂРѕС„РёР»СЊ
                </Button>
                <Button loading={actionLoading === 'algofund-refresh'} onClick={() => void refreshAlgofundState()}>
                  РћР±РЅРѕРІРёС‚СЊ РїСЂРµРґРїСЂРѕСЃРјРѕС‚СЂ
                </Button>
              </Space>
            </Card>
          ) : null}

          {/* Р—Р°РїСЂРѕСЃС‹ РЅР° СЃС‚Р°СЂС‚/СЃС‚РѕРї */}
          <Card className="battletoads-card" title="РџРѕРґРєР»СЋС‡РµРЅРёРµ / РѕС‚РєР»СЋС‡РµРЅРёРµ" size="small">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Input.TextArea
                rows={2}
                value={algofundNote}
                onChange={(e) => setAlgofundNote(e.target.value)}
                placeholder="РљРѕРјРјРµРЅС‚Р°СЂРёР№ Рє Р·Р°РїСЂРѕСЃСѓ (РЅРµРѕР±СЏР·Р°С‚РµР»СЊРЅРѕ)"
              />
              <Space wrap>
                <Button type="primary" loading={actionLoading === 'algofund-start'} onClick={() => void sendAlgofundRequest('start')}>
                  Р—Р°РїСЂРѕСЃРёС‚СЊ РїРѕРґРєР»СЋС‡РµРЅРёРµ
                </Button>
                <Button danger loading={actionLoading === 'algofund-stop'} onClick={() => void sendAlgofundRequest('stop')}>
                  Р—Р°РїСЂРѕСЃРёС‚СЊ РѕС‚РєР»СЋС‡РµРЅРёРµ
                </Button>
              </Space>

              {(algofundWorkspace.requests || []).length > 0 ? (
                <>
                  <Typography.Text type="secondary">РСЃС‚РѕСЂРёСЏ Р·Р°РїСЂРѕСЃРѕРІ:</Typography.Text>
                  <List
                    size="small"
                    dataSource={algofundWorkspace.requests || []}
                    renderItem={(item) => (
                      <List.Item>
                        <Space wrap>
                          <Tag color="blue">#{item.id}</Tag>
                          <Tag color={item.request_type === 'start' ? 'success' : 'orange'}>{item.request_type === 'start' ? 'РџРѕРґРєР»СЋС‡РµРЅРёРµ' : 'РћС‚РєР»СЋС‡РµРЅРёРµ'}</Tag>
                          <Tag color={item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'error' : 'processing'}>
                            {item.status === 'approved' ? 'РћРґРѕР±СЂРµРЅРѕ' : item.status === 'rejected' ? 'РћС‚РєР»РѕРЅРµРЅРѕ' : 'Р’ РѕР±СЂР°Р±РѕС‚РєРµ'}
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
                <Typography.Text>РђР»РіРѕС„РѕРЅРґ РЅРµРґРѕСЃС‚СѓРїРµРЅ РґР»СЏ РІР°С€РµРіРѕ Р°РєРєР°СѓРЅС‚Р°.</Typography.Text>
                <Typography.Text type="secondary">РћР±СЂР°С‚РёС‚РµСЃСЊ Рє Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ РґР»СЏ РїРѕРґРєР»СЋС‡РµРЅРёСЏ Рє РїСЂРѕРґСѓРєС‚Сѓ В«РђР»РіРѕС„РѕРЅРґВ».</Typography.Text>
              </Space>
            }
          />
        </Card>
      )}
    </Space>
  );

  // в”Ђв”Ђ Tab: РќР°СЃС‚СЂРѕР№РєРё Рё РјРѕРЅРёС‚РѕСЂРёРЅРі в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  const settingsTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* РђРєРєР°СѓРЅС‚ */}
      <Card className="battletoads-card" title="РђРєРєР°СѓРЅС‚" size="small">
        <Descriptions
          column={{ xs: 1, sm: 2 }}
          size="small"
          bordered
          labelStyle={{ minWidth: 130, fontWeight: 600 }}
        >
          <Descriptions.Item label="Email">
            <span style={{ wordBreak: 'break-all' }}>{clientUser?.email || 'вЂ”'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="РРјСЏ">{clientUser?.fullName || 'вЂ”'}</Descriptions.Item>
          <Descriptions.Item label="Tenant">{clientUser?.tenantDisplayName || 'вЂ”'}</Descriptions.Item>
          <Descriptions.Item label="Slug">{clientUser?.tenantSlug || 'вЂ”'}</Descriptions.Item>
          <Descriptions.Item label="Р РµР¶РёРј">
            {workspace?.productMode === 'algofund_client' ? 'РђР»РіРѕС„РѕРЅРґ-РєР»РёРµРЅС‚' : 'РљР»РёРµРЅС‚ СЃС‚СЂР°С‚РµРіРёР№'}
          </Descriptions.Item>
          <Descriptions.Item label="РЎС‚Р°С‚СѓСЃ">{clientUser?.tenantStatus || 'вЂ”'}</Descriptions.Item>
        </Descriptions>
        <div style={{ marginTop: 8 }}>
          <Space wrap>
            {!onboardingCompleted ? (
              <Button loading={actionLoading === 'onboarding'} onClick={() => void markOnboardingCompleted()}>
                РћС‚РјРµС‚РёС‚СЊ onboarding РїСЂРѕР№РґРµРЅРЅС‹Рј
              </Button>
            ) : null}
          </Space>
        </div>
      </Card>

      {/* РњРѕРЅРёС‚РѕСЂРёРЅРі */}
      <Card
        className="battletoads-card"
        title="РњРѕРЅРёС‚РѕСЂРёРЅРі СЃС‡С‘С‚Р°"
        size="small"
        extra={<Button size="small" loading={actionLoading === 'monitoring-refresh'} onClick={() => void refreshMonitoring()}>РћР±РЅРѕРІРёС‚СЊ</Button>}
      >
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} sm={6}>
            <Statistic title="РљР°РїРёС‚Р°Р»" value={formatMoney(monitoring?.latest?.equity_usd)} precision={0} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="РџСЂРѕСЃР°РґРєР°" value={formatPercent(monitoring?.latest?.drawdown_pct)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="РќРµСЂРµР°Р». P/L" value={formatMoney(monitoring?.latest?.unrealized_pnl_usd)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="Р—Р°РіСЂСѓР·РєР° РјР°СЂР¶Рё" value={formatPercent(monitoring?.latest?.margin_usage_pct)} />
          </Col>
        </Row>
        {monitoring?.apiKeyName ? <Tag color="blue" style={{ marginBottom: 8 }}>API: {monitoring.apiKeyName}</Tag> : null}
        {monitoringSeries.length > 0 ? (
          <ChartComponent data={monitoringSeries} type="line" />
        ) : (
          <Empty description="РќРµС‚ РґР°РЅРЅС‹С… РјРѕРЅРёС‚РѕСЂРёРЅРіР°" />
        )}
      </Card>

      {/* API РєР»СЋС‡Рё */}
      <Card className="battletoads-card" title="API РєР»СЋС‡Рё Р±РёСЂР¶Рё" size="small">
        {!onboardingCompleted ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="РџРµСЂРІС‹Р№ РІС…РѕРґ вЂ” С‡РµРє-Р»РёСЃС‚"
            description={
              <>
                <ol style={{ margin: '8px 0 8px 18px', padding: 0 }}>
                  <li>РЎРѕР·РґР°Р№С‚Рµ API-РєР»СЋС‡ РЅР° Р±РёСЂР¶Рµ СЃ СЂР°Р·СЂРµС€РµРЅРёСЏРјРё Trade Рё Read.</li>
                  <li>Р”РѕР±Р°РІСЊС‚Рµ IP-Р°РґСЂРµСЃ СЃРµСЂРІРµСЂР° РІ Р±РµР»С‹Р№ СЃРїРёСЃРѕРє Р±РёСЂР¶Рё.</li>
                  <li>Р’СЃС‚Р°РІСЊС‚Рµ РєР»СЋС‡ Рё СЃРµРєСЂРµС‚ РІ С„РѕСЂРјСѓ РЅРёР¶Рµ.</li>
                </ol>
                <Space wrap>
                  {guides.length > 0 ? guides.map((guide) => (
                    <Button key={guide.id} size="small" loading={actionLoading === `guide-${guide.id}`} onClick={() => void downloadGuide(guide)}>
                      {guide.title}
                    </Button>
                  )) : <Tag>Р“Р°Р№РґС‹ РЅРµРґРѕСЃС‚СѓРїРЅС‹</Tag>}
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

        <Typography.Text strong>Р”РѕР±Р°РІРёС‚СЊ РЅРѕРІС‹Р№ РєР»СЋС‡</Typography.Text>
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col xs={24} sm={8}>
            <Input
              addonBefore="Р‘РёСЂР¶Р°"
              value={apiKeyDraft.exchange}
              onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, exchange: e.target.value.trim().toLowerCase() || 'bybit' }))}
              placeholder="bybit"
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
              placeholder="РўРѕР»СЊРєРѕ РґР»СЏ РЅРµРєРѕС‚РѕСЂС‹С… Р±РёСЂР¶"
            />
          </Col>
          <Col xs={24} sm={16}>
            <Space wrap style={{ paddingTop: 6 }}>
              <Checkbox checked={apiKeyDraft.testnet} onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, testnet: e.target.checked }))}>Testnet</Checkbox>
              <Checkbox checked={apiKeyDraft.demo} onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, demo: e.target.checked }))}>Demo Trading</Checkbox>
              <Button type="primary" loading={actionLoading === 'client-api-key'} onClick={() => void saveClientApiKey()}>
                РЎРѕС…СЂР°РЅРёС‚СЊ Рё РїРѕРґРєР»СЋС‡РёС‚СЊ
              </Button>
            </Space>
          </Col>
        </Row>

        {clientApiKeys.length > 0 ? (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Typography.Text strong>РџРѕРґРєР»СЋС‡С‘РЅРЅС‹Рµ РєР»СЋС‡Рё</Typography.Text>
            <List
              size="small"
              style={{ marginTop: 8 }}
              dataSource={clientApiKeys}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Popconfirm
                      key={`del-${item.id}`}
                      title="РЈРґР°Р»РёС‚СЊ API РєР»СЋС‡?"
                      description="РљР»СЋС‡ Р±СѓРґРµС‚ СѓРґР°Р»С‘РЅ РёР· Р±Р°Р·С‹ РґР°РЅРЅС‹С…."
                      okText="РЈРґР°Р»РёС‚СЊ"
                      cancelText="РћС‚РјРµРЅР°"
                      onConfirm={() => void deleteClientApiKey(item.id)}
                    >
                      <Button danger size="small" loading={actionLoading === `delete-client-api-key-${item.id}`}>РЈРґР°Р»РёС‚СЊ</Button>
                    </Popconfirm>,
                  ]}
                >
                  <Space wrap>
                    <Typography.Text strong>{item.name}</Typography.Text>
                    <Tag>{item.exchange}</Tag>
                    {item.testnet ? <Tag color="gold">testnet</Tag> : null}
                    {item.demo ? <Tag color="magenta">demo</Tag> : null}
                    {item.isAssigned ? <Tag color="success">РїРѕРґРєР»СЋС‡С‘РЅ Рє РїРѕС‚РѕРєСѓ</Tag> : <Tag>РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ</Tag>}
                  </Space>
                </List.Item>
              )}
            />
          </>
        ) : null}
      </Card>

      {/* РўР°СЂРёС„ */}
      <Card className="battletoads-card" title="РўР°СЂРёС„ Рё Р»РёРјРёС‚С‹" size="small">
        <Space wrap style={{ marginBottom: 12 }}>
          <Tag color="blue">РўР°СЂРёС„: {tariff?.currentPlan?.title || 'вЂ”'}</Tag>
          <Tag color="green">Р¦РµРЅР°: {formatMoney(tariff?.currentPlan?.price_usdt)}/РјРµСЃ</Tag>
          <Tag color="cyan">РњР°РєСЃ. РґРµРїРѕР·РёС‚: {formatMoney(tariff?.currentPlan?.max_deposit_total)}</Tag>
          <Tag color="purple">Р РёСЃРє-РєР°Рї: {formatNumber(tariff?.currentPlan?.risk_cap_max)}</Tag>
          {tariff?.currentPlan?.allow_ts_start_stop_requests ? <Tag color="success">РЎС‚Р°СЂС‚/РЎС‚РѕРї: РІРєР»</Tag> : null}
        </Space>

        <Typography.Text strong>Р—Р°РїСЂРѕСЃРёС‚СЊ СЃРјРµРЅСѓ С‚Р°СЂРёС„Р°</Typography.Text>
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col xs={24} sm={12}>
            <Select
              style={{ width: '100%' }}
              placeholder="Р’С‹Р±РµСЂРёС‚Рµ С‚Р°СЂРёС„"
              value={targetPlanCode || undefined}
              onChange={setTargetPlanCode}
              options={(tariff?.availablePlans || []).map((plan) => ({
                value: plan.code,
                label: `${plan.title} (${formatMoney(plan.price_usdt)}/РјРµСЃ вЂ” РґРѕ ${formatMoney(plan.max_deposit_total)})`,
              }))}
            />
          </Col>
          <Col xs={24} sm={12}>
            <Input
              placeholder="РљРѕРјРјРµРЅС‚Р°СЂРёР№ (РЅРµРѕР±СЏР·Р°С‚РµР»СЊРЅРѕ)"
              value={tariffNote}
              onChange={(e) => setTariffNote(e.target.value)}
            />
          </Col>
        </Row>
        <Button type="primary" style={{ marginTop: 8 }} loading={actionLoading === 'tariff-request'} onClick={() => void sendTariffRequest()}>
          РћС‚РїСЂР°РІРёС‚СЊ Р·Р°СЏРІРєСѓ РЅР° СЃРјРµРЅСѓ С‚Р°СЂРёС„Р°
        </Button>

        {(tariff?.requests || []).length > 0 ? (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Typography.Text type="secondary">РџРѕСЃР»РµРґРЅРёРµ Р·Р°СЏРІРєРё:</Typography.Text>
            <List
              size="small"
              style={{ marginTop: 8 }}
              dataSource={tariff?.requests || []}
              renderItem={(item) => (
                <List.Item>
                  <Space wrap>
                    <Tag color="blue">#{item.id}</Tag>
                    <Typography.Text>{item.payload?.targetPlanTitle || item.payload?.targetPlanCode || 'вЂ”'}</Typography.Text>
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

      {/* в”Ђв”Ђ РЁР°РїРєР° в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */}
      <Card className="battletoads-card" bordered={false} style={{ marginBottom: 0 }}>
        <Row align="middle" justify="space-between" gutter={[8, 8]}>
          <Col>
            <Typography.Title level={3} style={{ margin: 0 }}>Р›РёС‡РЅС‹Р№ РєР°Р±РёРЅРµС‚</Typography.Title>
            <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
              {clientUser?.email || 'вЂ”'}{clientUser?.tenantDisplayName ? ` В· ${clientUser.tenantDisplayName}` : ''}
            </Typography.Text>
          </Col>
          <Col>
            <Space wrap>
              <Button onClick={() => void loadWorkspace()} loading={loading}>РћР±РЅРѕРІРёС‚СЊ</Button>
              <Button danger onClick={() => void logoutClient()}>Р’С‹Р№С‚Рё</Button>
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
                label: 'РљР»РёРµРЅС‚ СЃС‚СЂР°С‚РµРіРёР№',
                children: strategyTabContent,
              },
              {
                key: 'algofund',
                label: 'РђР»РіРѕС„РѕРЅРґ',
                children: algofundTabContent,
              },
              {
                key: 'settings',
                label: 'РќР°СЃС‚СЂРѕР№РєРё Рё РјРѕРЅРёС‚РѕСЂРёРЅРі',
                children: settingsTabContent,
              },
            ]}
          />
        ) : !loading ? (
          <Alert type="warning" showIcon message="РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ СЂР°Р±РѕС‡РµРµ РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІРѕ. РџРѕРїСЂРѕР±СѓР№С‚Рµ РѕР±РЅРѕРІРёС‚СЊ СЃС‚СЂР°РЅРёС†Сѓ." />
        ) : null}
      </Spin>
    </div>
  );
};

export default ClientCabinet;

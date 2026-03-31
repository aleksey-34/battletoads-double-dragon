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
        {capabilityTag('Настройки', Boolean(capabilities.settings))}
        {capabilityTag('Мониторинг', Boolean(capabilities.monitoring))}
        {capabilityTag('Бэктест', Boolean(capabilities.backtest))}
        {capabilityTag('Старт/Стоп', Boolean(capabilities.startStopRequests))}
      </Space>
    );
  };

  // ── Tab: Стратегии ─────────────────────────────────────────────────────
  const strategyTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {strategyWorkspace ? (
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
                            ? <Checkbox checked={strategyOfferIds.includes(offer.offerId)} onChange={(e) => { e.stopPropagation(); setStrategyOfferIds((current) => e.target.checked ? [...new Set([...current, offer.offerId])] : current.filter((id) => id !== offer.offerId)); }} />
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
                    <Button loading={strategySelectionPreviewLoading} onClick={() => void runStrategySelectionPreview()}>
                      Предпросмотр портфеля
                    </Button>
                  </Space>
                ) : null}
              </Space>
            )}
          </Card>

          {/* Предпросмотр портфеля */}
          {strategySelectionPreview ? (
            <Card className="battletoads-card" title="Предпросмотр выбранных стратегий" size="small">
              <Space wrap style={{ marginBottom: 12 }}>
                <Tag color="cyan">Стратегий: {strategySelectionPreview.selectedOffers.length}</Tag>
                <Tag color="green">Доходность: {formatPercent((strategyPreviewSummary as any)?.totalReturnPercent)}</Tag>
                <Tag color="orange">DD: {formatPercent((strategyPreviewSummary as any)?.maxDrawdownPercent)}</Tag>
                <Tag color="purple">PF: {formatNumber((strategyPreviewSummary as any)?.profitFactor)}</Tag>
              </Space>
              {strategyPreviewSeries.length > 0 ? (
                <ChartComponent data={strategyPreviewSeries} type="line" />
              ) : (
                <Empty description="Нет данных для предпросмотра" />
              )}
            </Card>
          ) : null}

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

          {/* Статус торговли */}
          <Card className="battletoads-card" title="Статус торговли" size="small">
            <Space wrap>
              <Tag color="blue">Тариф: {strategyWorkspace.plan?.title || '—'}</Tag>
              <Tag color="cyan">Депозит до: {formatMoney(strategyWorkspace.plan?.max_deposit_total)}</Tag>
              <Tag color="purple">Стратегий до: {formatNumber(strategyWorkspace.plan?.max_strategies_total, 0)}</Tag>
              <Tag color={strategyWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                {strategyWorkspace.profile?.actual_enabled ? 'Торговля активна' : 'Торговля остановлена'}
              </Tag>
              <Tag color={strategyWorkspace.profile?.requested_enabled ? 'processing' : 'default'}>
                Запрос: {strategyWorkspace.profile?.requested_enabled ? 'запущен' : 'остановлен'}
              </Tag>
            </Space>
            {renderCapabilities(strategyWorkspace.capabilities)}
          </Card>

          {/* Запросы на старт/стоп */}
          {strategyWorkspace.capabilities?.startStopRequests ? (
            <Card className="battletoads-card" title="Запросить запуск / остановку" size="small">
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input.TextArea
                  rows={2}
                  value={algofundNote}
                  onChange={(e) => setAlgofundNote(e.target.value)}
                  placeholder="Комментарий к запросу (необязательно)"
                />
                <Space wrap>
                  <Button type="primary" loading={actionLoading === 'algofund-start'} onClick={() => void sendAlgofundRequest('start')}>
                    Запросить запуск
                  </Button>
                  <Button danger loading={actionLoading === 'algofund-stop'} onClick={() => void sendAlgofundRequest('stop')}>
                    Запросить остановку
                  </Button>
                </Space>
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

  // ── Tab: Алгофонд ─────────────────────────────────────────────────────
  const algofundTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {algofundWorkspace ? (
        <>
          {/* Статус */}
          <Card className="battletoads-card" title="Статус Алгофонда" size="small">
            <Space wrap>
              <Tag color="blue">Тариф: {algofundWorkspace.plan?.title || '—'}</Tag>
              <Tag color="cyan">Депозит до: {formatMoney(algofundWorkspace.plan?.max_deposit_total)}</Tag>
              <Tag color="purple">Риск-кап: {formatNumber(algofundWorkspace.plan?.risk_cap_max)}</Tag>
              <Tag color={algofundWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                {algofundWorkspace.profile?.actual_enabled ? 'Торговля активна' : 'Торговля остановлена'}
              </Tag>
              {algofundAssignedApiKey ? <Tag color="geekblue">API: {algofundAssignedApiKey}</Tag> : null}
            </Space>
            {renderCapabilities(algofundWorkspace.capabilities)}
          </Card>

          {/* Витрина ТС Алгофонда */}
          <Card className="battletoads-card" title="Доступные торговые системы" size="small">
            {algofundAvailableSystems.length === 0 ? (
              <Empty description="Торговые системы Алгофонда не опубликованы" />
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
                          <Tag color="cyan">Участники: {Number(system.memberCount || 0)}</Tag>
                          {system.isActive ? <Tag color="success">Активна</Tag> : <Tag color="default">Неактивна</Tag>}
                          {isCurrent ? <Tag color="gold">Ваша текущая ТС</Tag> : null}
                        </Space>
                      </List.Item>
                    );
                  }}
                />
              </Space>
            )}
          </Card>

          {/* Предпросмотр портфеля алгофонда */}
          {!algofundWorkspace.preview?.blockedByPlan ? (
            <Card className="battletoads-card" title="Предпросмотр портфеля" size="small">
              <Space wrap style={{ marginBottom: 12 }}>
                <Tag color="green">Доходность: {formatPercent(algofundWorkspace.preview?.summary?.totalReturnPercent)}</Tag>
                <Tag color="orange">DD: {formatPercent(algofundWorkspace.preview?.summary?.maxDrawdownPercent)}</Tag>
                <Tag color="purple">PF: {formatNumber(algofundWorkspace.preview?.summary?.profitFactor)}</Tag>
                <Tag color="blue">Сделки: {formatNumber(algofundWorkspace.preview?.summary?.tradesCount, 0)}</Tag>
              </Space>
              {algofundPreviewSeries.length > 0 ? (
                <ChartComponent data={algofundPreviewSeries} type="line" />
              ) : (
                <Empty description="Нет данных предпросмотра" />
              )}
            </Card>
          ) : (
            <Alert type="warning" showIcon message={algofundWorkspace.preview?.blockedReason || 'Предпросмотр заблокирован текущим тарифом'} />
          )}

          {/* Риск-профиль */}
          {algofundWorkspace.capabilities?.settings ? (
            <Card className="battletoads-card" title="Риск-профиль" size="small">
              <Typography.Text strong>Мультипликатор риска: {formatNumber(algofundRiskMultiplier, 2)}</Typography.Text>
              <Slider
                min={0}
                max={toFinite(algofundWorkspace.plan?.risk_cap_max, 1)}
                step={0.05}
                value={algofundRiskMultiplier}
                onChange={(v) => setAlgofundRiskMultiplier(Math.min(toFinite(v), toFinite(algofundWorkspace.plan?.risk_cap_max, 1)))}
              />
              <Space wrap style={{ marginTop: 8 }}>
                <Button type="primary" loading={actionLoading === 'algofund-save'} onClick={() => void saveAlgofundProfile()}>
                  Сохранить риск-профиль
                </Button>
                <Button loading={actionLoading === 'algofund-refresh'} onClick={() => void refreshAlgofundState()}>
                  Обновить предпросмотр
                </Button>
              </Space>
            </Card>
          ) : null}

          {/* Запросы на старт/стоп */}
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

  // ── Tab: Настройки и мониторинг ───────────────────────────────────────
  const settingsTabContent = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Аккаунт */}
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

      {/* Мониторинг */}
      <Card
        className="battletoads-card"
        title="Мониторинг счёта"
        size="small"
        extra={<Button size="small" loading={actionLoading === 'monitoring-refresh'} onClick={() => void refreshMonitoring()}>Обновить</Button>}
      >
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
        {monitoring?.apiKeyName ? <Tag color="blue" style={{ marginBottom: 8 }}>API: {monitoring.apiKeyName}</Tag> : null}
        {monitoringSeries.length > 0 ? (
          <ChartComponent data={monitoringSeries} type="line" />
        ) : (
          <Empty description="Нет данных мониторинга" />
        )}
      </Card>

      {/* API ключи */}
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
                  <li>Создайте API-ключ на бирже с разрешениями Trade и Read.</li>
                  <li>Добавьте IP-адрес сервера в белый список биржи.</li>
                  <li>Вставьте ключ и секрет в форму ниже.</li>
                </ol>
                <Space wrap>
                  {guides.length > 0 ? guides.map((guide) => (
                    <Button key={guide.id} size="small" loading={actionLoading === `guide-${guide.id}`} onClick={() => void downloadGuide(guide)}>
                      {guide.title}
                    </Button>
                  )) : <Tag>Гайды недоступны</Tag>}
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

        <Typography.Text strong>Добавить новый ключ</Typography.Text>
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col xs={24} sm={8}>
            <Input
              addonBefore="Биржа"
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
              placeholder="Только для некоторых бирж"
            />
          </Col>
          <Col xs={24} sm={16}>
            <Space wrap style={{ paddingTop: 6 }}>
              <Checkbox checked={apiKeyDraft.testnet} onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, testnet: e.target.checked }))}>Testnet</Checkbox>
              <Checkbox checked={apiKeyDraft.demo} onChange={(e) => setApiKeyDraft((cur) => ({ ...cur, demo: e.target.checked }))}>Demo Trading</Checkbox>
              <Button type="primary" loading={actionLoading === 'client-api-key'} onClick={() => void saveClientApiKey()}>
                Сохранить и подключить
              </Button>
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
                    {item.isAssigned ? <Tag color="success">подключён к потоку</Tag> : <Tag>не подключён</Tag>}
                  </Space>
                </List.Item>
              )}
            />
          </>
        ) : null}
      </Card>

      {/* Тариф */}
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

      {/* ── Шапка ──────────────────────────────────────────────────────────── */}
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
              <Descriptions column={{ xs: 1, md: 2 }} bordered size="small">
                <Descriptions.Item label={t('client.cabinet.email', 'Email')}>{clientUser?.email || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.user', 'User')}>{clientUser?.fullName || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.workspace', 'Workspace')}>{clientUser?.tenantDisplayName || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.slug', 'Workspace slug')}>{clientUser?.tenantSlug || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.mode', 'Mode')}>
                  {workspace.productMode === 'algofund_client'
                    ? t('client.auth.productModeAlgofund', 'Algofund Client')
                    : t('client.auth.productModeStrategy', 'Strategy Client')}
                </Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.status', 'Status')}>{clientUser?.tenantStatus || '—'}</Descriptions.Item>
              </Descriptions>
            </Card>

            <Card className="battletoads-card" title={t('client.workspaceShowcase.title', 'Product showcases')}>
              <Typography.Paragraph className="client-cabinet-muted">
                {t('client.workspaceShowcase.subtitle', 'Unified client area for Strategy and Algofund. If a product is not enabled, its tab remains available as a preview.')}
              </Typography.Paragraph>
              <Tabs
                items={[
                  {
                    key: 'strategy-vitrine',
                    label: t('client.workspaceShowcase.strategyLabel', 'Strategy Client'),
                    children: strategyWorkspace ? (
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Space wrap>
                          <Tag color="blue">{t('client.workspaceShowcase.plan', 'Plan')}: {strategyWorkspace.plan?.title || '—'}</Tag>
                          <Tag color="green">{t('client.workspaceShowcase.offers', 'Offers')}: {strategyWorkspace.offers?.length || 0}</Tag>
                          <Tag color="purple">{t('client.workspaceShowcase.selected', 'Selected')}: {strategyWorkspace.profile?.selectedOfferIds?.length || 0}</Tag>
                        </Space>
                        {renderCapabilities(strategyWorkspace.capabilities)}
                      </Space>
                    ) : (
                      <Empty description={t('client.workspaceShowcase.strategyUnavailable', 'Strategy showcase is not enabled for your tenant yet')} />
                    ),
                  },
                  {
                    key: 'algofund-vitrine',
                    label: t('client.workspaceShowcase.algofundLabel', 'Algofund Client'),
                    children: algofundWorkspace ? (
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Space wrap>
                          <Tag color="blue">{t('client.workspaceShowcase.plan', 'Plan')}: {algofundWorkspace.plan?.title || '—'}</Tag>
                          <Tag color="cyan">{t('client.workspaceShowcase.publishedSystems', 'Published systems')}: {algofundWorkspace.availableSystems?.length || 0}</Tag>
                          <Tag color={algofundWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                            {algofundWorkspace.profile?.actual_enabled
                              ? t('client.algofund.liveEnabled', 'Live enabled')
                              : t('client.algofund.liveDisabled', 'Live disabled')}
                          </Tag>
                        </Space>
                        {renderCapabilities(algofundWorkspace.capabilities)}
                      </Space>
                    ) : (
                      <Empty description={t('client.workspaceShowcase.algofundUnavailable', 'Algofund showcase is not enabled for your tenant yet')} />
                    ),
                  },
                ]}
              />
            </Card>

            <Card className="battletoads-card" title={t('client.monitoring.title', 'Monitoring')}>
              <Space wrap style={{ marginBottom: 12 }}>
                <Tag color="blue">{t('client.monitoring.apiKey', 'API key')}: {monitoring?.apiKeyName || '—'}</Tag>
                <Tag color="green">{t('client.monitoring.equity', 'Equity')}: {formatMoney(monitoring?.latest?.equity_usd)}</Tag>
                <Tag color="orange">DD: {formatPercent(monitoring?.latest?.drawdown_pct)}</Tag>
                <Tag color="purple">UPNL: {formatMoney(monitoring?.latest?.unrealized_pnl_usd)}</Tag>
                <Button size="small" loading={actionLoading === 'monitoring-refresh'} onClick={() => void refreshMonitoring()}>
                  {t('client.monitoring.refresh', 'Refresh monitoring')}
                </Button>
              </Space>
              {monitoringSeries.length > 0 ? (
                <ChartComponent data={monitoringSeries} type="line" />
              ) : (
                <Empty description={t('client.monitoring.empty', 'Monitoring chart is empty')} />
              )}
            </Card>

            {!onboardingCompleted ? (
              <Card className="battletoads-card" title={t('client.onboarding.title', 'First Login Checklist')}>
                <Typography.Paragraph>
                  {t('client.onboarding.subtitle', 'Complete these steps once to start safely.')}
                </Typography.Paragraph>
                <ol className="client-onboarding-list">
                  <li>{t('client.onboarding.step1', 'Secure your account and keep credentials private.')}</li>
                  <li>{t('client.onboarding.step2', 'Create exchange API keys with trade/read permissions only.')}</li>
                  <li>{t('client.onboarding.step3', 'Add IP whitelist for your server IP in exchange settings.')}</li>
                  <li>{t('client.onboarding.step4', 'Download and follow the exchange quick guide from the list below.')}</li>
                </ol>
                <Space wrap style={{ marginBottom: 12 }}>
                  {guides.length > 0 ? guides.map((guide) => (
                    <Button key={guide.id} loading={actionLoading === `guide-${guide.id}`} onClick={() => void downloadGuide(guide)}>
                      {guide.title}
                    </Button>
                  )) : <Tag color="default">{t('client.onboarding.noGuides', 'No guides available')}</Tag>}
                </Space>
                <div>
                  <Button type="primary" loading={actionLoading === 'onboarding'} onClick={() => void markOnboardingCompleted()}>
                    {t('client.onboarding.completeAction', 'Mark checklist as done')}
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="battletoads-card" title={t('client.onboarding.guidesTitle', 'Exchange Quick Guides')}>
                <Space wrap>
                  {guides.length > 0 ? guides.map((guide) => (
                    <Button key={guide.id} loading={actionLoading === `guide-${guide.id}`} onClick={() => void downloadGuide(guide)}>
                      {guide.title}
                    </Button>
                  )) : <Tag color="default">{t('client.onboarding.noGuides', 'No guides available')}</Tag>}
                </Space>
              </Card>
            )}

            <Card className="battletoads-card" title={t('client.apiKey.title', 'Exchange API key')}>
              <Row gutter={[12, 12]}>
                <Col xs={24} md={8}>
                  <Typography.Text strong>{t('client.apiKey.exchange', 'Exchange')}</Typography.Text>
                  <Input
                    style={{ marginTop: 6 }}
                    value={apiKeyDraft.exchange}
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, exchange: event.target.value.trim().toLowerCase() || 'bybit' }))}
                    placeholder="bybit"
                  />
                </Col>
                <Col xs={24} md={8}>
                  <Typography.Text strong>{t('client.apiKey.apiKey', 'API key')}</Typography.Text>
                  <Input
                    style={{ marginTop: 6 }}
                    value={apiKeyDraft.apiKey}
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, apiKey: event.target.value }))}
                    placeholder="xxxxxxxx"
                  />
                </Col>
                <Col xs={24} md={8}>
                  <Typography.Text strong>{t('client.apiKey.secret', 'Secret')}</Typography.Text>
                  <Input.Password
                    style={{ marginTop: 6 }}
                    value={apiKeyDraft.secret}
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, secret: event.target.value }))}
                    placeholder="xxxxxxxx"
                  />
                </Col>
                <Col xs={24} md={8}>
                  <Typography.Text strong>{t('client.apiKey.passphrase', 'Passphrase')}</Typography.Text>
                  <Input
                    style={{ marginTop: 6 }}
                    value={apiKeyDraft.passphrase}
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, passphrase: event.target.value }))}
                    placeholder={t('client.apiKey.passphraseOptional', 'Optional (required on some exchanges)')}
                  />
                </Col>
                <Col xs={24} md={16}>
                  <Space wrap style={{ marginTop: 26 }}>
                    <Checkbox
                      checked={apiKeyDraft.testnet}
                      onChange={(event) => setApiKeyDraft((current) => ({ ...current, testnet: event.target.checked }))}
                    >
                      {t('client.apiKey.testnet', 'Testnet')}
                    </Checkbox>
                    <Checkbox
                      checked={apiKeyDraft.demo}
                      onChange={(event) => setApiKeyDraft((current) => ({ ...current, demo: event.target.checked }))}
                    >
                      {t('client.apiKey.demo', 'Demo trading')}
                    </Checkbox>
                    <Button type="primary" loading={actionLoading === 'client-api-key'} onClick={() => void saveClientApiKey()}>
                      {t('client.apiKey.save', 'Save and connect')}
                    </Button>
                  </Space>
                </Col>
              </Row>

              <Typography.Title level={5} className="client-cabinet-section-title">{t('client.apiKey.connectedTitle', 'Connected API keys')}</Typography.Title>
              <List
                size="small"
                dataSource={clientApiKeys}
                locale={{ emptyText: <Empty description={t('client.apiKey.noKeys', 'No API keys yet')} /> }}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Popconfirm
                        key={`delete-${item.id}`}
                        title={t('client.apiKey.deleteTitle', 'Delete API key')}
                        description={t('client.apiKey.deleteDescription', 'This action removes the key from DB')}
                        okText={t('client.apiKey.deleteAction', 'Delete')}
                        cancelText={t('client.apiKey.cancelAction', 'Cancel')}
                        onConfirm={() => void deleteClientApiKey(item.id)}
                      >
                        <Button danger size="small" loading={actionLoading === `delete-client-api-key-${item.id}`}>{t('client.apiKey.deleteAction', 'Delete')}</Button>
                      </Popconfirm>,
                    ]}
                  >
                    <Space wrap>
                      <Typography.Text strong>{item.name}</Typography.Text>
                      <Tag>{item.exchange}</Tag>
                      {item.testnet ? <Tag color="gold">{t('client.apiKey.tagTestnet', 'testnet')}</Tag> : null}
                      {item.demo ? <Tag color="magenta">{t('client.apiKey.tagDemo', 'demo')}</Tag> : null}
                      {item.isAssigned ? <Tag color="success">{t('client.apiKey.tagAssigned', 'assigned')}</Tag> : null}
                    </Space>
                  </List.Item>
                )}
              />
            </Card>

            <Card className="battletoads-card" title={t('client.tariff.title', 'Tariff and limits')}>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Space wrap>
                  <Tag color="blue">{t('client.tariff.current', 'Current')}: {tariff?.currentPlan?.title || '—'}</Tag>
                  <Tag color="green">{t('client.tariff.price', 'Price')}: {formatMoney(tariff?.currentPlan?.price_usdt)}</Tag>
                  <Tag color="cyan">{t('client.tariff.maxDeposit', 'Max deposit')}: {formatMoney(tariff?.currentPlan?.max_deposit_total)}</Tag>
                  <Tag color="purple">{t('client.tariff.riskCap', 'Risk cap')}: {formatNumber(tariff?.currentPlan?.risk_cap_max)}</Tag>
                </Space>

                <Typography.Text strong>{t('client.tariff.changeRequest', 'Tariff change request')}</Typography.Text>
                <Row gutter={[12, 12]}>
                  <Col xs={24} md={10}>
                    <Input
                      placeholder={t('client.tariff.planCodePlaceholder', 'Plan code')}
                      value={targetPlanCode}
                      onChange={(event) => setTargetPlanCode(event.target.value)}
                    />
                  </Col>
                  <Col xs={24} md={14}>
                    <Input
                      placeholder={t('client.tariff.notePlaceholder', 'Optional note')}
                      value={tariffNote}
                      onChange={(event) => setTariffNote(event.target.value)}
                    />
                  </Col>
                </Row>
                <Space wrap>
                  <Button type="primary" loading={actionLoading === 'tariff-request'} onClick={() => void sendTariffRequest()}>
                    {t('client.tariff.sendRequest', 'Send tariff request')}
                  </Button>
                  {tariff?.availablePlans?.map((plan) => (
                    <Button key={plan.code} onClick={() => setTargetPlanCode(plan.code)}>
                      {plan.code} ({formatMoney(plan.price_usdt)})
                    </Button>
                  ))}
                </Space>

                <List
                  size="small"
                  header={t('client.tariff.recentRequests', 'Recent tariff requests')}
                  dataSource={tariff?.requests || []}
                  locale={{ emptyText: <Empty description={t('client.tariff.noRequests', 'No tariff requests yet')} /> }}
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
              </Space>
            </Card>

            {strategyWorkspace ? (
              <>
                <Card className="battletoads-card" title={t('client.strategy.workspace', 'Strategy Workspace')}>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag color="blue">{t('client.plan', 'Plan')}: {strategyWorkspace.plan?.title || '—'}</Tag>
                      <Tag color="cyan">{t('client.depositCap', 'Deposit cap')}: {formatMoney(strategyWorkspace.plan?.max_deposit_total)}</Tag>
                      <Tag color="purple">{t('client.strategyLimit', 'Strategy limit')}: {formatNumber(strategyWorkspace.plan?.max_strategies_total, 0)}</Tag>
                    </Space>
                    {renderCapabilities(strategyWorkspace.capabilities)}
                  </Space>
                </Card>

                <Card className="battletoads-card" title={t('client.strategy.preferences', 'Preferences')}>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} lg={12}>
                      <Typography.Text strong>{t('client.strategy.risk', 'Risk')}: {formatNumber(strategyRiskInput, 1)}</Typography.Text>
                      <Slider min={0} max={10} step={0.1} value={strategyRiskInput} onChange={(value) => setStrategyRiskInput(toFinite(value))} />
                    </Col>
                    <Col xs={24} lg={12}>
                      <Typography.Text strong>{t('client.strategy.tradeFrequency', 'Trade frequency')}: {formatNumber(strategyTradeInput, 1)}</Typography.Text>
                      <Slider min={0} max={10} step={0.1} value={strategyTradeInput} onChange={(value) => setStrategyTradeInput(toFinite(value))} />
                    </Col>
                  </Row>
                  <Space wrap style={{ marginTop: 12 }}>
                    <Button type="primary" loading={actionLoading === 'strategy-save'} onClick={() => void saveStrategyProfile()}>
                      {t('client.strategy.save', 'Save preferences')}
                    </Button>
                    <Button loading={strategySelectionPreviewLoading} onClick={() => void runStrategySelectionPreview()}>
                      {t('client.strategy.previewSelection', 'Preview selected offers')}
                    </Button>
                  </Space>
                </Card>

                <Card className="battletoads-card" title={t('client.strategy.offers', 'Available offers')}>
                  {strategyWorkspace.offers.length === 0 ? (
                    <Empty description={t('client.strategy.noOffers', 'No offers available')} />
                  ) : (
                    <List
                      dataSource={strategyWorkspace.offers}
                      renderItem={(offer) => {
                        const checked = strategyOfferIds.includes(offer.offerId);
                        return (
                          <List.Item>
                            <Space direction="vertical" size={0} style={{ flex: 1 }}>
                              <Checkbox
                                checked={checked}
                                onChange={(event) => {
                                  const nextChecked = event.target.checked;
                                  setStrategyOfferIds((current) => {
                                    if (nextChecked) {
                                      return Array.from(new Set([...current, offer.offerId]));
                                    }
                                    return current.filter((item) => item !== offer.offerId);
                                  });
                                }}
                              >
                                <Typography.Text strong>{offer.titleRu}</Typography.Text>
                              </Checkbox>
                              <Typography.Text type="secondary">
                                {offer.strategy.mode.toUpperCase()} · {offer.strategy.type} · {offer.strategy.market}
                              </Typography.Text>
                            </Space>
                            <Space wrap>
                              <Tag color="cyan">{t('client.score', 'Score')}: {formatNumber(offer.metrics.score)}</Tag>
                              <Tag color="green">{t('client.return', 'Return')}: {formatPercent(offer.metrics.ret)}</Tag>
                              <Tag color="orange">DD: {formatPercent(offer.metrics.dd)}</Tag>
                              <Tag color="blue">PF: {formatNumber(offer.metrics.pf)}</Tag>
                            </Space>
                          </List.Item>
                        );
                      }}
                    />
                  )}
                </Card>

                <Card className="battletoads-card" title={t('client.strategy.selectionPreview', 'Selected Offers Preview')}>
                  <Spin spinning={strategySelectionPreviewLoading}>
                    {strategySelectionPreview ? (
                      <>
                        <Space wrap style={{ marginBottom: 12 }}>
                          <Tag color="blue">{t('client.offers', 'Offers')}: {strategySelectionPreview.selectedOffers.length}</Tag>
                          <Tag color="green">{t('client.finalEquity', 'Final equity')}: {formatMoney((strategyPreviewSummary as any)?.finalEquity)}</Tag>
                          <Tag color="cyan">{t('client.return', 'Return')}: {formatPercent((strategyPreviewSummary as any)?.totalReturnPercent)}</Tag>
                          <Tag color="orange">DD: {formatPercent((strategyPreviewSummary as any)?.maxDrawdownPercent)}</Tag>
                          <Tag color="purple">PF: {formatNumber((strategyPreviewSummary as any)?.profitFactor)}</Tag>
                        </Space>
                        {strategyPreviewSeries.length > 0 ? (
                          <ChartComponent data={strategyPreviewSeries} type="line" />
                        ) : (
                          <Empty description={t('client.strategy.previewEmpty', 'No preview chart yet')} />
                        )}
                      </>
                    ) : (
                      <Empty description={t('client.strategy.previewEmpty', 'No preview chart yet')} />
                    )}
                  </Spin>
                </Card>

                <Card className="battletoads-card" title={t('client.strategy.backtestRequest.title', 'Request New Pair Backtest')}>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Space wrap>
                      <Input
                        style={{ width: 240 }}
                        placeholder={t('client.strategy.backtestRequest.marketPlaceholder', 'Market: SOLUSDT or BTC/ETH')}
                        value={requestMarket}
                        onChange={(event) => setRequestMarket(event.target.value)}
                      />
                      <Input
                        style={{ width: 90 }}
                        placeholder={t('client.strategy.backtestRequest.intervalPlaceholder', 'Interval')}
                        value={requestInterval}
                        onChange={(event) => setRequestInterval(event.target.value)}
                      />
                    </Space>
                    <Input.TextArea
                      rows={2}
                      value={requestNote}
                      onChange={(event) => setRequestNote(event.target.value)}
                      placeholder={t('client.strategy.backtestRequest.notePlaceholder', 'Optional note for admin/research')}
                    />
                    <Space wrap>
                      <Button type="primary" loading={actionLoading === 'strategy-backtest-request'} onClick={() => void sendBacktestPairRequest()}>
                        {t('client.strategy.backtestRequest.send', 'Send request')}
                      </Button>
                      <Button onClick={() => void loadBacktestRequests()}>{t('client.strategy.backtestRequest.refresh', 'Refresh list')}</Button>
                    </Space>

                    <List
                      size="small"
                      dataSource={backtestRequests}
                      locale={{ emptyText: <Empty description={t('client.strategy.backtestRequest.noRequests', 'No pair requests yet')} /> }}
                      renderItem={(item) => (
                        <List.Item>
                          <Space direction="vertical" size={0} style={{ width: '100%' }}>
                            <Space wrap>
                              <Typography.Text strong>{[item.base_symbol, item.quote_symbol].filter(Boolean).join('/') || item.base_symbol}</Typography.Text>
                              <Tag>{item.interval}</Tag>
                              <Tag color={item.status === 'done' ? 'success' : item.status === 'rejected' ? 'error' : 'processing'}>{item.status}</Tag>
                              <Typography.Text type="secondary">#{item.id}</Typography.Text>
                            </Space>
                            {item.note ? <Typography.Text type="secondary">{item.note}</Typography.Text> : null}
                          </Space>
                        </List.Item>
                      )}
                    />
                  </Space>
                </Card>
              </>
            ) : null}

            {algofundWorkspace ? (
              <>
                <Card className="battletoads-card" title={t('client.algofund.workspace', 'Algofund Workspace')}>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag color="blue">{t('client.plan', 'Plan')}: {algofundWorkspace.plan?.title || '—'}</Tag>
                      <Tag color="cyan">{t('client.depositCap', 'Deposit cap')}: {formatMoney(algofundWorkspace.plan?.max_deposit_total)}</Tag>
                      <Tag color="purple">{t('client.riskCap', 'Risk cap')}: {formatNumber(algofundWorkspace.plan?.risk_cap_max)}</Tag>
                    </Space>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Typography.Text strong>
                        {t('client.algofund.currentSystem', 'Connected trading system')}: {algofundPublishedSystemName || t('client.algofund.noSystem', 'Not assigned')}
                      </Typography.Text>
                      <Space wrap>
                        <Tag color={algofundWorkspace.profile?.actual_enabled ? 'success' : 'default'}>
                          {algofundWorkspace.profile?.actual_enabled
                            ? t('client.algofund.liveEnabled', 'Live enabled')
                            : t('client.algofund.liveDisabled', 'Live disabled')}
                        </Tag>
                        <Tag color="geekblue">
                          {t('client.algofund.availableSystems', 'Available TS')}: {algofundAvailableSystems.length}
                        </Tag>
                        {algofundAssignedApiKey ? <Tag color="blue">API: {algofundAssignedApiKey}</Tag> : null}
                        {algofundCurrentSystem ? <Tag color="green">members: {Number(algofundCurrentSystem.memberCount || 0)}</Tag> : null}
                      </Space>
                      {algofundAvailableSystems.length > 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {algofundAvailableSystems.map((item) => String(item?.name || '').trim()).filter(Boolean).join(' | ')}
                        </Typography.Text>
                      ) : null}
                    </Space>
                    {renderCapabilities(algofundWorkspace.capabilities)}
                  </Space>
                </Card>

                <Card className="battletoads-card" title={t('client.algofund.risk', 'Risk profile')}>
                  <Typography.Text strong>{t('client.algofund.multiplier', 'Risk multiplier')}: {formatNumber(algofundRiskMultiplier, 2)}</Typography.Text>
                  <Slider
                    min={0}
                    max={toFinite(algofundWorkspace.plan?.risk_cap_max, 1)}
                    step={0.05}
                    value={algofundRiskMultiplier}
                    onChange={(value) => setAlgofundRiskMultiplier(Math.min(toFinite(value), toFinite(algofundWorkspace.plan?.risk_cap_max, 1)))}
                  />
                  <Space wrap>
                    <Button type="primary" loading={actionLoading === 'algofund-save'} onClick={() => void saveAlgofundProfile()}>
                      {t('client.algofund.save', 'Save risk profile')}
                    </Button>
                    <Button loading={actionLoading === 'algofund-refresh'} onClick={() => void refreshAlgofundState()}>
                      {t('client.algofund.refreshPreview', 'Refresh preview')}
                    </Button>
                  </Space>
                </Card>

                <Card className="battletoads-card" title={t('client.algofund.preview', 'Portfolio preview')}>
                  {algofundWorkspace.preview?.blockedByPlan ? (
                    <Alert type="warning" showIcon message={algofundWorkspace.preview?.blockedReason || t('client.algofund.previewBlocked', 'Preview is blocked by your current plan')} />
                  ) : (
                    <>
                      <Space wrap style={{ marginBottom: 12 }}>
                        <Tag color="green">{t('client.finalEquity', 'Final equity')}: {formatMoney(algofundWorkspace.preview?.summary?.finalEquity)}</Tag>
                        <Tag color="cyan">{t('client.return', 'Return')}: {formatPercent(algofundWorkspace.preview?.summary?.totalReturnPercent)}</Tag>
                        <Tag color="orange">DD: {formatPercent(algofundWorkspace.preview?.summary?.maxDrawdownPercent)}</Tag>
                        <Tag color="purple">PF: {formatNumber(algofundWorkspace.preview?.summary?.profitFactor)}</Tag>
                      </Space>
                      {algofundPreviewSeries.length > 0 ? (
                        <ChartComponent data={algofundPreviewSeries} type="line" />
                      ) : (
                        <Empty description={t('client.algofund.previewEmpty', 'No preview chart yet')} />
                      )}
                    </>
                  )}
                </Card>

                <Card className="battletoads-card" title={t('client.algofund.requests', 'Start/Stop requests')}>
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Input.TextArea
                      rows={3}
                      value={algofundNote}
                      onChange={(event) => setAlgofundNote(event.target.value)}
                      placeholder={t('client.algofund.notePlaceholder', 'Optional note for your request')}
                    />
                    <Space wrap>
                      <Button type="primary" loading={actionLoading === 'algofund-start'} onClick={() => void sendAlgofundRequest('start')}>
                        {t('client.algofund.requestStart', 'Request start')}
                      </Button>
                      <Button danger loading={actionLoading === 'algofund-stop'} onClick={() => void sendAlgofundRequest('stop')}>
                        {t('client.algofund.requestStop', 'Request stop')}
                      </Button>
                      {algofundWorkspace.profile?.actual_enabled ? <Tag color="success">{t('client.algofund.liveEnabled', 'Live enabled')}</Tag> : <Tag color="default">{t('client.algofund.liveDisabled', 'Live disabled')}</Tag>}
                    </Space>

                    <List
                      header={t('client.algofund.requestHistory', 'Recent requests')}
                      dataSource={algofundWorkspace.requests || []}
                      locale={{ emptyText: t('client.algofund.noRequests', 'No requests yet') }}
                      renderItem={(item) => (
                        <List.Item>
                          <Space direction="vertical" size={0} style={{ width: '100%' }}>
                            <Space wrap>
                              <Tag color="blue">#{item.id}</Tag>
                              <Tag color={item.request_type === 'start' ? 'success' : 'orange'}>{item.request_type}</Tag>
                              <Tag color={item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'error' : 'processing'}>{item.status}</Tag>
                            </Space>
                            <Typography.Text type="secondary">{item.created_at}</Typography.Text>
                            <Typography.Text>{item.note || '—'}</Typography.Text>
                            {item.decision_note ? <Typography.Text type="secondary">{item.decision_note}</Typography.Text> : null}
                          </Space>
                        </List.Item>
                      )}
                    />
                  </Space>
                </Card>
              </>
            ) : null}
          </>
        ) : null}
      </Spin>
    </div>
  );
};

export default ClientCabinet;

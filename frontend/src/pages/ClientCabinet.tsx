import React, { useEffect, useMemo, useState } from 'react';
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
  Row,
  Slider,
  Space,
  Spin,
  Tag,
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

type AlgofundState = {
  tenant: Tenant;
  plan: Plan | null;
  capabilities?: TenantCapabilities;
  profile: {
    risk_multiplier: number;
    requested_enabled: number;
    actual_enabled: number;
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
  const [guides, setGuides] = useState<GuideItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [actionLoading, setActionLoading] = useState('');

  const [strategyOfferIds, setStrategyOfferIds] = useState<string[]>([]);
  const [strategyRiskInput, setStrategyRiskInput] = useState(5);
  const [strategyTradeInput, setStrategyTradeInput] = useState(5);
  const [strategySelectionPreview, setStrategySelectionPreview] = useState<StrategySelectionPreviewResponse | null>(null);
  const [strategySelectionPreviewLoading, setStrategySelectionPreviewLoading] = useState(false);

  const [algofundRiskMultiplier, setAlgofundRiskMultiplier] = useState(1);
  const [algofundNote, setAlgofundNote] = useState('');

  const strategyState = workspace?.strategyState || null;
  const algofundState = workspace?.algofundState || null;
  const clientUser = workspace?.auth?.user || null;
  const onboardingCompleted = Boolean(clientUser?.onboardingCompletedAt);

  const strategyPreviewSummary = strategySelectionPreview?.preview?.summary || {};
  const strategyPreviewSeries = useMemo(() => toLineSeriesData(strategySelectionPreview?.preview?.equity), [strategySelectionPreview]);
  const algofundPreviewSeries = useMemo(() => toLineSeriesData(algofundState?.preview?.equityCurve), [algofundState]);

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
    } catch (error: any) {
      setErrorText(String(error?.response?.data?.error || error?.message || 'Failed to load client workspace'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, []);

  useEffect(() => {
    if (!strategyState?.profile) {
      return;
    }

    setStrategyOfferIds(Array.isArray(strategyState.profile.selectedOfferIds) ? strategyState.profile.selectedOfferIds : []);
    setStrategyRiskInput(levelToSliderValue(strategyState.profile.risk_level || 'medium'));
    setStrategyTradeInput(levelToSliderValue(strategyState.profile.trade_frequency_level || 'medium'));
  }, [strategyState]);

  useEffect(() => {
    if (!algofundState?.profile) {
      return;
    }

    setAlgofundRiskMultiplier(toFinite(algofundState.profile.risk_multiplier, 1));
  }, [algofundState]);

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
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to mark onboarding complete'));
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
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save strategy preferences'));
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
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to build preview'));
      setStrategySelectionPreview(null);
    } finally {
      setStrategySelectionPreviewLoading(false);
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
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to save algofund profile'));
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
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to refresh algofund preview'));
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
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Failed to send request'));
    } finally {
      setActionLoading('');
    }
  };

  const renderCapabilities = (capabilities?: TenantCapabilities) => {
    if (!capabilities) {
      return null;
    }

    return (
      <Space wrap>
        {capabilityTag(t('client.cap.settings', 'Settings'), Boolean(capabilities.settings))}
        {capabilityTag(t('client.cap.monitoring', 'Monitoring'), Boolean(capabilities.monitoring))}
        {capabilityTag(t('client.cap.backtest', 'Backtest'), Boolean(capabilities.backtest))}
        {capabilityTag(t('client.cap.startStop', 'Start/Stop'), Boolean(capabilities.startStopRequests))}
      </Space>
    );
  };

  return (
    <div className="saas-page client-cabinet-page">
      {contextHolder}

      <Card className="battletoads-card" bordered={false}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} lg={18}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {t('client.cabinet.title', 'Personal Cabinet')}
            </Typography.Title>
            <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>
              {t('client.cabinet.subtitle', 'Your account is tenant-aware: every login always opens your own workspace.')}
            </Typography.Paragraph>
          </Col>
          <Col xs={24} lg={6}>
            <Space wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
              <Button onClick={() => void loadWorkspace()} loading={loading}>{t('common.refresh', 'Refresh')}</Button>
              <Button danger onClick={() => void logoutClient()}>{t('action.logout', 'Logout')}</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

      <Spin spinning={loading && !workspace}>
        {workspace ? (
          <>
            <Card className="battletoads-card" title={t('client.cabinet.account', 'Account')}>
              <Descriptions column={{ xs: 1, md: 2 }} bordered size="small">
                <Descriptions.Item label={t('client.cabinet.email', 'Email')}>{clientUser?.email || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.user', 'User')}>{clientUser?.fullName || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.workspace', 'Workspace')}>{clientUser?.tenantDisplayName || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.slug', 'Workspace slug')}>{clientUser?.tenantSlug || '—'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.mode', 'Mode')}>{workspace.productMode === 'algofund_client' ? 'algofund' : 'strategy'}</Descriptions.Item>
                <Descriptions.Item label={t('client.cabinet.status', 'Status')}>{clientUser?.tenantStatus || '—'}</Descriptions.Item>
              </Descriptions>
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
                    <Button key={guide.id} href={guide.downloadUrl} target="_blank">
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
                    <Button key={guide.id} href={guide.downloadUrl} target="_blank">
                      {guide.title}
                    </Button>
                  )) : <Tag color="default">{t('client.onboarding.noGuides', 'No guides available')}</Tag>}
                </Space>
              </Card>
            )}

            {strategyState ? (
              <>
                <Card className="battletoads-card" title={t('client.strategy.workspace', 'Strategy Workspace')}>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag color="blue">{t('client.plan', 'Plan')}: {strategyState.plan?.title || '—'}</Tag>
                      <Tag color="cyan">{t('client.depositCap', 'Deposit cap')}: {formatMoney(strategyState.plan?.max_deposit_total)}</Tag>
                      <Tag color="purple">{t('client.strategyLimit', 'Strategy limit')}: {formatNumber(strategyState.plan?.max_strategies_total, 0)}</Tag>
                    </Space>
                    {renderCapabilities(strategyState.capabilities)}
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
                  {strategyState.offers.length === 0 ? (
                    <Empty description={t('client.strategy.noOffers', 'No offers available')} />
                  ) : (
                    <List
                      dataSource={strategyState.offers}
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
              </>
            ) : null}

            {algofundState ? (
              <>
                <Card className="battletoads-card" title={t('client.algofund.workspace', 'Algofund Workspace')}>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag color="blue">{t('client.plan', 'Plan')}: {algofundState.plan?.title || '—'}</Tag>
                      <Tag color="cyan">{t('client.depositCap', 'Deposit cap')}: {formatMoney(algofundState.plan?.max_deposit_total)}</Tag>
                      <Tag color="purple">{t('client.riskCap', 'Risk cap')}: {formatNumber(algofundState.plan?.risk_cap_max)}</Tag>
                    </Space>
                    {renderCapabilities(algofundState.capabilities)}
                  </Space>
                </Card>

                <Card className="battletoads-card" title={t('client.algofund.risk', 'Risk profile')}>
                  <Typography.Text strong>{t('client.algofund.multiplier', 'Risk multiplier')}: {formatNumber(algofundRiskMultiplier, 2)}</Typography.Text>
                  <Slider
                    min={0}
                    max={toFinite(algofundState.plan?.risk_cap_max, 1)}
                    step={0.05}
                    value={algofundRiskMultiplier}
                    onChange={(value) => setAlgofundRiskMultiplier(Math.min(toFinite(value), toFinite(algofundState.plan?.risk_cap_max, 1)))}
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
                  {algofundState.preview?.blockedByPlan ? (
                    <Alert type="warning" showIcon message={algofundState.preview?.blockedReason || t('client.algofund.previewBlocked', 'Preview is blocked by your current plan')} />
                  ) : (
                    <>
                      <Space wrap style={{ marginBottom: 12 }}>
                        <Tag color="green">{t('client.finalEquity', 'Final equity')}: {formatMoney(algofundState.preview?.summary?.finalEquity)}</Tag>
                        <Tag color="cyan">{t('client.return', 'Return')}: {formatPercent(algofundState.preview?.summary?.totalReturnPercent)}</Tag>
                        <Tag color="orange">DD: {formatPercent(algofundState.preview?.summary?.maxDrawdownPercent)}</Tag>
                        <Tag color="purple">PF: {formatNumber(algofundState.preview?.summary?.profitFactor)}</Tag>
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
                      {algofundState.profile?.actual_enabled ? <Tag color="success">{t('client.algofund.liveEnabled', 'Live enabled')}</Tag> : <Tag color="default">{t('client.algofund.liveDisabled', 'Live disabled')}</Tag>}
                    </Space>

                    <List
                      header={t('client.algofund.requestHistory', 'Recent requests')}
                      dataSource={algofundState.requests || []}
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

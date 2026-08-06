import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { CopyOutlined, DeleteOutlined, LineChartOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

type ExitLeg = {
  id: string;
  kind: 'tp' | 'sl';
  mode: 'percent' | 'trailing';
  percent: number;
  closePercent: number;
  priceOffsetPercent?: number;
  maLength?: number;
  maType?: 'sma' | 'ema';
};

type TvAlert = {
  id: number;
  name: string;
  slug: string;
  symbol: string;
  exchange: string;
  apiKeyName: string;
  enabled: boolean;
  lotMode: 'usdt' | 'percent_deposit';
  lotValue: number;
  leverage: number;
  config: {
    exitLegs: ExitLeg[];
    marketType?: 'swap' | 'spot';
    closeOnOppositeSignal?: boolean;
  };
  webhookUrl: string;
};

type WorkspaceState = {
  profile: {
    defaultApiKeyName: string;
    defaultExchange: string;
    enabled: boolean;
    signalConflictMode: 'wait_close' | 'accept_new' | 'close_and_open';
  } | null;
  alerts: TvAlert[];
  openPositions: Array<{
    id: number;
    alert_id: number;
    symbol: string;
    side: string;
    status: string;
    entry_price: number;
    qty: string;
    remaining_qty: string;
  }>;
  recentEvents: Array<{
    id: number;
    alert_id: number;
    action: string;
    status: string;
    error_message?: string;
    created_at: string;
  }>;
};

type ApiKeyRow = {
  id: number;
  name: string;
  exchange: string;
  isAssigned?: boolean;
};

const EXCHANGES = ['bybit', 'bitget', 'bingx', 'binance', 'mexc', 'weex'];

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
};

type LinePoint = { time: number; value: number };

const toFinite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const formatNumber = (value: unknown, digits = 2): string => (
  toFinite(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
);

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
  const raw = Array.isArray(payload) ? payload : [];
  const points = raw
    .map((row: Record<string, unknown>) => {
      const time = normalizeTime(row?.time ?? row?.ts ?? row?.recorded_at);
      const val = Number(row?.equity_usd ?? row?.equity ?? row?.value);
      if (time === null || !Number.isFinite(val)) return null;
      return { time, value: val };
    })
    .filter((item): item is LinePoint => !!item)
    .sort((a, b) => a.time - b.time);

  if (points.length <= 1) return points;
  const deduped: LinePoint[] = [];
  for (const point of points) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === point.time) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }
  return deduped;
};

const TvAlertsCabinet: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(true);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [editingAlert, setEditingAlert] = useState<TvAlert | null>(null);
  const [setupGuideAlert, setSetupGuideAlert] = useState<TvAlert | null>(null);
  const [terminalAlertId, setTerminalAlertId] = useState<number | null>(null);
  const [monitoringModalVisible, setMonitoringModalVisible] = useState(false);
  const [monitoring, setMonitoring] = useState<MonitoringPayload | null>(null);
  const [monitoringDays, setMonitoringDays] = useState(1);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [alertForm] = Form.useForm();
  const [profileForm] = Form.useForm();
  const [apiKeyForm] = Form.useForm();

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const [wsRes, keysRes, monitoringRes] = await Promise.all([
        axios.get('/api/client/tv-alerts/workspace'),
        axios.get('/api/client/api-keys'),
        axios.get<MonitoringPayload>('/api/client/monitoring', { params: { limit: 120 } }).catch(() => null),
      ]);
      setWorkspace(wsRes.data);
      setApiKeys(Array.isArray(keysRes.data?.keys) ? keysRes.data.keys : []);
      if (monitoringRes?.data) {
        setMonitoring(monitoringRes.data);
      }
      const profile = wsRes.data?.profile;
      if (profile) {
        profileForm.setFieldsValue({
          defaultApiKeyName: profile.defaultApiKeyName,
          defaultExchange: profile.defaultExchange,
          enabled: profile.enabled,
          signalConflictMode: profile.signalConflictMode,
        });
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || 'Load failed'));
    } finally {
      setLoading(false);
    }
  }, [messageApi, profileForm]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const monitoringSeries = useMemo(
    () => toLineSeriesData((monitoring?.points || []).map((point) => ({
      time: point.time ?? point.ts ?? point.recorded_at,
      equity_usd: point.equity_usd ?? point.equity ?? point.value,
    }))),
    [monitoring],
  );

  const refreshMonitoring = async (days?: number) => {
    setMonitoringLoading(true);
    try {
      const params = days && days > 1 ? { days } : { limit: 288 };
      const response = await axios.get<MonitoringPayload>('/api/client/monitoring', { params });
      setMonitoring(response.data);
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message || t('client.monitoring.loadFailed', 'Failed to load monitoring')));
    } finally {
      setMonitoringLoading(false);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      messageApi.success(t('tvAlerts.copied', 'Copied'));
    } catch {
      messageApi.error(t('tvAlerts.copyFailed', 'Copy failed'));
    }
  };

  /** Ready-to-paste TradingView alert message (Message field). */
  const buildTvAlertMessage = (symbol?: string): string => {
    const safeSymbol = String(symbol || '').trim().toUpperCase();
    return `{
  "action": "{{strategy.order.action}}",
  "symbol": "${safeSymbol || '{{ticker}}'}",
  "price": {{close}}
}`;
  };

  const normalizeAlertFromApi = (raw: any, fallbackSymbol?: string): TvAlert | null => {
    if (!raw) return null;
    const webhookUrl = String(raw.webhookUrl || '').trim();
    if (!webhookUrl) return null;
    let config: TvAlert['config'] = {};
    try {
      config = typeof raw.config_json === 'string'
        ? JSON.parse(raw.config_json || '{}')
        : (raw.config || {});
    } catch {
      config = raw.config || {};
    }
    return {
      id: Number(raw.id || 0),
      name: String(raw.name || ''),
      slug: String(raw.slug || ''),
      symbol: String(raw.symbol || fallbackSymbol || ''),
      exchange: String(raw.exchange || ''),
      apiKeyName: String(raw.apiKeyName || raw.api_key_name || ''),
      enabled: Boolean(raw.enabled),
      lotMode: (raw.lotMode || raw.lot_mode || 'usdt') as TvAlert['lotMode'],
      lotValue: Number(raw.lotValue ?? raw.lot_value ?? 0),
      leverage: Number(raw.leverage || 1),
      config,
      webhookUrl,
    };
  };

  const openCreateAlert = () => {
    setEditingAlert(null);
    setSetupGuideAlert(null);
    alertForm.resetFields();
    alertForm.setFieldsValue({
      lotMode: 'usdt',
      lotValue: 100,
      leverage: 1,
      marketType: 'swap',
      closeOnOppositeSignal: true,
      exitLegs: [],
      enabled: true,
      exchange: workspace?.profile?.defaultExchange || 'bybit',
      apiKeyName: workspace?.profile?.defaultApiKeyName || '',
    });
    setAlertModalOpen(true);
  };

  const openEditAlert = (alert: TvAlert) => {
    setEditingAlert(alert);
    setSetupGuideAlert(null);
    alertForm.setFieldsValue({
      name: alert.name,
      symbol: alert.symbol,
      exchange: alert.exchange,
      apiKeyName: alert.apiKeyName,
      lotMode: alert.lotMode,
      lotValue: alert.lotValue,
      leverage: alert.leverage,
      enabled: alert.enabled,
      marketType: alert.config?.marketType || 'swap',
      closeOnOppositeSignal: alert.config?.closeOnOppositeSignal !== false,
      exitLegs: alert.config?.exitLegs || [],
    });
    setAlertModalOpen(true);
  };

  const saveAlert = async () => {
    const values = await alertForm.validateFields();
    const payload = {
      name: values.name,
      symbol: values.symbol,
      exchange: values.exchange,
      apiKeyName: values.apiKeyName,
      lotMode: values.lotMode,
      lotValue: values.lotValue,
      leverage: values.leverage,
      enabled: values.enabled,
      config: {
        marketType: values.marketType,
        closeOnOppositeSignal: values.closeOnOppositeSignal,
        exitLegs: values.exitLegs || [],
      },
    };

    try {
      const response = editingAlert
        ? await axios.patch(`/api/client/tv-alerts/${editingAlert.id}`, payload)
        : await axios.post('/api/client/tv-alerts', payload);
      messageApi.success(
        editingAlert
          ? t('tvAlerts.alertUpdated', 'Alert updated')
          : t('tvAlerts.alertCreated', 'Alert created'),
      );
      setAlertModalOpen(false);
      await loadWorkspace();
      const guide = normalizeAlertFromApi(response.data?.alert, payload.symbol);
      if (guide) {
        setSetupGuideAlert(guide);
      }
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message));
    }
  };

  const deleteAlert = async (id: number) => {
    try {
      await axios.delete(`/api/client/tv-alerts/${id}`);
      messageApi.success(t('tvAlerts.alertDeleted', 'Alert deleted'));
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message));
    }
  };

  const saveProfile = async () => {
    const values = await profileForm.validateFields();
    try {
      await axios.patch('/api/client/tv-alerts/profile', values);
      messageApi.success(t('tvAlerts.profileSaved', 'Settings saved'));
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message));
    }
  };

  const saveApiKey = async () => {
    const values = await apiKeyForm.validateFields();
    try {
      await axios.post('/api/client/api-key', values);
      messageApi.success(t('tvAlerts.apiKeySaved', 'API key added'));
      apiKeyForm.resetFields();
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message));
    }
  };

  const runTerminal = async (action: string, percent?: number) => {
    if (!terminalAlertId) {
      return;
    }
    try {
      await axios.post(`/api/client/tv-alerts/${terminalAlertId}/terminal`, { action, percent });
      messageApi.success(t('tvAlerts.terminalOk', 'Command executed'));
      await loadWorkspace();
    } catch (error: any) {
      messageApi.error(String(error?.response?.data?.error || error?.message));
    }
  };

  const alertColumns = useMemo(() => [
    { title: t('tvAlerts.colName', 'Name'), dataIndex: 'name', key: 'name' },
    { title: t('tvAlerts.colSymbol', 'Symbol'), dataIndex: 'symbol', key: 'symbol' },
    {
      title: t('tvAlerts.colLot', 'Lot'),
      key: 'lot',
      render: (_: unknown, row: TvAlert) => (
        <span>{row.lotMode === 'percent_deposit' ? `${row.lotValue}%` : `$${row.lotValue}`}</span>
      ),
    },
    {
      title: t('tvAlerts.colStatus', 'Status'),
      key: 'status',
      render: (_: unknown, row: TvAlert) => (
        <Tag color={row.enabled ? 'success' : 'default'}>{row.enabled ? 'ON' : 'OFF'}</Tag>
      ),
    },
    {
      title: t('tvAlerts.colWebhook', 'Webhook'),
      key: 'webhook',
      render: (_: unknown, row: TvAlert) => (
        <Space wrap>
          <Button size="small" icon={<CopyOutlined />} onClick={() => void copyText(row.webhookUrl)}>
            URL
          </Button>
          <Button
            size="small"
            onClick={() => void copyText(buildTvAlertMessage(row.symbol))}
          >
            {t('tvAlerts.copyMessage', 'Текст алерта')}
          </Button>
          <Button size="small" type="link" onClick={() => setSetupGuideAlert(row)}>
            {t('tvAlerts.setupGuide', 'Инструкция')}
          </Button>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, row: TvAlert) => (
        <Space>
          <Button size="small" onClick={() => openEditAlert(row)}>{t('action.edit', 'Edit')}</Button>
          <Button size="small" onClick={() => setTerminalAlertId(row.id)}>{t('tvAlerts.terminal', 'Terminal')}</Button>
          <Popconfirm title={t('tvAlerts.confirmDelete', 'Delete alert?')} onConfirm={() => void deleteAlert(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ], [t]);

  return (
    <div className="battletoads-page-shell">
      {contextHolder}
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Typography.Title level={2} style={{ marginBottom: 4 }}>
            {t('tvAlerts.title', 'TradingView Alerts')}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('tvAlerts.subtitle', 'Connect TradingView webhooks to your exchange. No storefront — only your signals and risk rules.')}
          </Typography.Paragraph>
        </div>

        <Card className="battletoads-card" size="small" title={t('tvAlerts.accountMonitoring', 'Account monitoring')}>
          <Space wrap>
            <Button
              type="primary"
              icon={<LineChartOutlined />}
              onClick={() => {
                setMonitoringModalVisible(true);
                void refreshMonitoring(monitoringDays);
              }}
            >
              {t('tvAlerts.openMonitoring', 'Open monitoring')}
            </Button>
            {monitoring?.latest?.equity_usd != null ? (
              <Tag color="blue">{t('tvAlerts.equity', 'Equity')}: {formatMoney(monitoring.latest.equity_usd)}</Tag>
            ) : null}
            {monitoring?.latest?.drawdown_pct != null ? (
              <Tag color="orange">DD: {formatPercent(monitoring.latest.drawdown_pct)}</Tag>
            ) : null}
            {workspace?.profile?.defaultApiKeyName ? (
              <Tag>{workspace.profile.defaultApiKeyName}</Tag>
            ) : null}
          </Space>
        </Card>

        <Alert
          type="info"
          showIcon
          message={t('tvAlerts.hintTitle', 'How it works')}
          description={
            <ol style={{ marginBottom: 0, paddingLeft: 18 }}>
              <li>{t('tvAlerts.hint1', 'Add exchange API keys and pick default exchange.')}</li>
              <li>{t('tvAlerts.hint2', 'Create an alert — copy webhook URL into TradingView alert settings.')}</li>
              <li>{t('tvAlerts.hint3', 'Configure lot, TP/SL ladder or trailing exits.')}</li>
              <li>{t('tvAlerts.hint4', 'When signal arrives, engine opens position, places exit orders, monitors trailing.')}</li>
            </ol>
          }
        />

        <Tabs
          items={[
            {
              key: 'alerts',
              label: t('tvAlerts.tabAlerts', 'Alerts'),
              children: (
                <Card
                  title={t('tvAlerts.myAlerts', 'My alerts')}
                  extra={(
                    <Space>
                      <Button icon={<ReloadOutlined />} onClick={() => void loadWorkspace()} loading={loading} />
                      <Button type="primary" icon={<PlusOutlined />} onClick={openCreateAlert}>
                        {t('tvAlerts.newAlert', 'New alert')}
                      </Button>
                    </Space>
                  )}
                >
                  <Table
                    rowKey="id"
                    loading={loading}
                    dataSource={workspace?.alerts || []}
                    columns={alertColumns}
                    pagination={false}
                    locale={{ emptyText: t('tvAlerts.noAlerts', 'No alerts yet') }}
                  />
                </Card>
              ),
            },
            {
              key: 'settings',
              label: t('tvAlerts.tabSettings', 'Settings'),
              children: (
                <Row gutter={[16, 16]}>
                  <Col xs={24} lg={12}>
                    <Card title={t('tvAlerts.workspaceSettings', 'Workspace')}>
                      <Form form={profileForm} layout="vertical" onFinish={() => void saveProfile()}>
                        <Form.Item name="defaultExchange" label={t('tvAlerts.defaultExchange', 'Default exchange')}>
                          <Select options={EXCHANGES.map((e) => ({ value: e, label: e.toUpperCase() }))} />
                        </Form.Item>
                        <Form.Item name="defaultApiKeyName" label={t('tvAlerts.defaultApiKey', 'Default API key')}>
                          <Select
                            allowClear
                            options={apiKeys.map((k) => ({ value: k.name, label: `${k.name} (${k.exchange})` }))}
                          />
                        </Form.Item>
                        <Form.Item
                          name="signalConflictMode"
                          label={t('tvAlerts.conflictMode', 'If position is open on new signal')}
                        >
                          <Select
                            options={[
                              { value: 'wait_close', label: t('tvAlerts.conflictWait', 'Wait until position closes') },
                              { value: 'accept_new', label: t('tvAlerts.conflictAccept', 'Accept and process new signal') },
                              { value: 'close_and_open', label: t('tvAlerts.conflictReplace', 'Close current and open new') },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item name="enabled" label={t('tvAlerts.workspaceEnabled', 'Trading enabled')} valuePropName="checked">
                          <Switch />
                        </Form.Item>
                        <Button type="primary" htmlType="submit">{t('action.save', 'Save')}</Button>
                      </Form>
                    </Card>
                  </Col>
                  <Col xs={24} lg={12}>
                    <Card title={t('tvAlerts.addApiKey', 'Add API key')}>
                      <Form form={apiKeyForm} layout="vertical" onFinish={() => void saveApiKey()}>
                        <Form.Item name="exchange" label="Exchange" rules={[{ required: true }]}>
                          <Select options={EXCHANGES.map((e) => ({ value: e, label: e.toUpperCase() }))} />
                        </Form.Item>
                        <Form.Item name="apiKey" label="API Key" rules={[{ required: true }]}>
                          <Input.Password />
                        </Form.Item>
                        <Form.Item name="secret" label="Secret" rules={[{ required: true }]}>
                          <Input.Password />
                        </Form.Item>
                        <Form.Item name="passphrase" label="Passphrase">
                          <Input.Password />
                        </Form.Item>
                        <Button type="primary" htmlType="submit">{t('tvAlerts.saveKey', 'Save key')}</Button>
                      </Form>
                    </Card>
                  </Col>
                </Row>
              ),
            },
            {
              key: 'positions',
              label: t('tvAlerts.tabPositions', 'Positions'),
              children: (
                <Card>
                  <List
                    dataSource={workspace?.openPositions || []}
                    locale={{ emptyText: t('tvAlerts.noPositions', 'No open positions') }}
                    renderItem={(item) => (
                      <List.Item>
                        <List.Item.Meta
                          title={`#${item.alert_id} ${item.symbol} ${item.side}`}
                          description={`qty ${item.remaining_qty || item.qty} @ ${item.entry_price}`}
                        />
                        <Tag color="processing">{item.status}</Tag>
                      </List.Item>
                    )}
                  />
                </Card>
              ),
            },
            {
              key: 'events',
              label: t('tvAlerts.tabEvents', 'Event log'),
              children: (
                <Card>
                  <List
                    dataSource={workspace?.recentEvents || []}
                    locale={{ emptyText: t('tvAlerts.noEvents', 'No events yet') }}
                    renderItem={(ev) => (
                      <List.Item>
                        <Space direction="vertical" size={0}>
                          <Typography.Text>
                            #{ev.id} alert {ev.alert_id} · {ev.action} · <Tag>{ev.status}</Tag>
                          </Typography.Text>
                          <Typography.Text type="secondary">{ev.created_at}</Typography.Text>
                          {ev.error_message ? (
                            <Typography.Text type="danger">{ev.error_message}</Typography.Text>
                          ) : null}
                        </Space>
                      </List.Item>
                    )}
                  />
                </Card>
              ),
            },
            {
              key: 'docs',
              label: t('tvAlerts.tabDocs', 'TradingView'),
              children: (
                <Card title={t('tvAlerts.tvPayload', 'Текст алерта для TradingView')}>
                  <Typography.Paragraph>
                    {t(
                      'tvAlerts.tvPayloadHint',
                      'В TradingView: Create Alert → Notifications → Webhook URL (из карточки алерта) + Message (JSON ниже). Мы генерируем текст сами — скопируйте и вставьте.',
                    )}
                  </Typography.Paragraph>
                  <Input.TextArea rows={6} value={buildTvAlertMessage()} readOnly />
                  <Divider />
                  <Typography.Paragraph>
                    {t(
                      'tvAlerts.tvActions',
                      'Поддерживаемые action: long/buy, short/sell, close, close_long, close_short. Для Strategy Alert поле {{strategy.order.action}} даёт buy/sell — это нормально.',
                    )}
                  </Typography.Paragraph>
                  <Button onClick={() => void copyText(buildTvAlertMessage())} icon={<CopyOutlined />}>
                    {t('tvAlerts.copyJson', 'Скопировать JSON')}
                  </Button>
                </Card>
              ),
            },
          ]}
        />
      </Space>

      <Modal
        title={editingAlert ? t('tvAlerts.editAlert', 'Edit alert') : t('tvAlerts.createAlert', 'Create alert')}
        open={alertModalOpen}
        onCancel={() => setAlertModalOpen(false)}
        onOk={() => void saveAlert()}
        width={720}
        okText={t('action.save', 'Save')}
      >
        <Form form={alertForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label={t('tvAlerts.fieldName', 'Name')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="symbol" label={t('tvAlerts.fieldSymbol', 'Symbol')} rules={[{ required: true }]}>
                <Input placeholder="BTCUSDT" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="exchange" label="Exchange">
                <Select options={EXCHANGES.map((e) => ({ value: e, label: e.toUpperCase() }))} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="apiKeyName" label="API key">
                <Select
                  allowClear
                  options={apiKeys.map((k) => ({ value: k.name, label: k.name }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="lotMode" label={t('tvAlerts.lotMode', 'Lot mode')}>
                <Select
                  options={[
                    { value: 'usdt', label: 'USDT' },
                    { value: 'percent_deposit', label: '% deposit' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="lotValue" label={t('tvAlerts.lotValue', 'Lot value')}>
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="leverage" label={t('tvAlerts.leverage', 'Leverage')}>
                <InputNumber min={1} max={125} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="marketType" label={t('tvAlerts.marketType', 'Market')}>
                <Select options={[{ value: 'swap', label: 'Futures' }, { value: 'spot', label: 'Spot' }]} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="closeOnOppositeSignal" label={t('tvAlerts.closeOpposite', 'Close on opposite signal')} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="enabled" label={t('tvAlerts.enabled', 'Enabled')} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Form.List name="exitLegs">
            {(fields, { add, remove }) => (
              <>
                <Divider>{t('tvAlerts.exitLegs', 'TP / SL legs (ladder)')}</Divider>
                {fields.map((field) => (
                  <Card key={field.key} size="small" style={{ marginBottom: 8 }}>
                    <Row gutter={8}>
                      <Col span={4}>
                        <Form.Item {...field} name={[field.name, 'kind']} label="Type">
                          <Select options={[{ value: 'tp', label: 'TP' }, { value: 'sl', label: 'SL' }]} />
                        </Form.Item>
                      </Col>
                      <Col span={5}>
                        <Form.Item {...field} name={[field.name, 'mode']} label="Mode">
                          <Select options={[{ value: 'percent', label: '% price' }, { value: 'trailing', label: 'Trailing' }]} />
                        </Form.Item>
                      </Col>
                      <Col span={4}>
                        <Form.Item {...field} name={[field.name, 'percent']} label="%">
                          <InputNumber min={0.1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={4}>
                        <Form.Item {...field} name={[field.name, 'closePercent']} label="Close %">
                          <InputNumber min={1} max={100} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={4}>
                        <Form.Item {...field} name={[field.name, 'priceOffsetPercent']} label="Grid %">
                          <InputNumber style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={3}>
                        <Button danger onClick={() => remove(field.name)} style={{ marginTop: 30 }}>×</Button>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button type="dashed" onClick={() => add({ id: `leg_${Date.now()}`, kind: 'tp', mode: 'percent', percent: 2, closePercent: 50, priceOffsetPercent: 0 })} block>
                  + {t('tvAlerts.addLeg', 'Add TP/SL leg')}
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Modal
        title={t('tvAlerts.accountMonitoring', 'Account monitoring')}
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
          <Button size="small" loading={monitoringLoading} onClick={() => void refreshMonitoring(monitoringDays)}>
            {t('action.refresh', 'Refresh')}
          </Button>
        </Space>
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} sm={6}>
            <Statistic title={t('tvAlerts.equity', 'Equity')} value={formatMoney(monitoring?.latest?.equity_usd)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title={t('tvAlerts.drawdown', 'Drawdown')} value={formatPercent(monitoring?.latest?.drawdown_pct)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title={t('tvAlerts.unrealizedPnl', 'Unrealized P/L')} value={formatMoney(monitoring?.latest?.unrealized_pnl_usd)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title={t('tvAlerts.marginUsage', 'Margin usage')} value={formatPercent(monitoring?.latest?.margin_usage_pct)} />
          </Col>
        </Row>
        {monitoring?.apiKeyName ? (
          <Tag color="blue" style={{ marginBottom: 8 }}>API: {monitoring.apiKeyName}</Tag>
        ) : (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message={t('tvAlerts.monitoringNoKey', 'Select default API key in Settings to see account equity.')}
          />
        )}
        {monitoringSeries.length > 0 ? (
          <ChartComponent data={monitoringSeries} type="line" />
        ) : (
          <Empty description={t('tvAlerts.monitoringEmpty', 'No monitoring data yet')} />
        )}
      </Modal>

      <Modal
        title={t('tvAlerts.manualTerminal', 'Manual terminal')}
        open={terminalAlertId !== null}
        onCancel={() => setTerminalAlertId(null)}
        footer={null}
      >
        <Space wrap>
          <Button type="primary" onClick={() => void runTerminal('open_long')}>Long</Button>
          <Button onClick={() => void runTerminal('open_short')}>Short</Button>
          <Button onClick={() => void runTerminal('close_partial', 50)}>Close 50%</Button>
          <Button danger onClick={() => void runTerminal('close_all')}>Close all</Button>
          <Button onClick={() => void runTerminal('cancel_orders')}>Cancel orders</Button>
        </Space>
      </Modal>

      <Modal
        title={t('tvAlerts.setupTitle', 'Вставка в TradingView')}
        open={!!setupGuideAlert}
        onCancel={() => setSetupGuideAlert(null)}
        footer={(
          <Button type="primary" onClick={() => setSetupGuideAlert(null)}>
            {t('action.close', 'Закрыть')}
          </Button>
        )}
        width={720}
      >
        {setupGuideAlert ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={t('tvAlerts.setupStepsTitle', 'Два поля в алерте TradingView')}
              description={t(
                'tvAlerts.setupStepsBody',
                '1) Webhook URL — куда слать сигнал. 2) Message — JSON-текст, который мы сгенерировали ниже.',
              )}
            />
            <div>
              <Typography.Text strong>Webhook URL</Typography.Text>
              <Input.TextArea
                style={{ marginTop: 6 }}
                rows={2}
                readOnly
                value={setupGuideAlert.webhookUrl}
              />
              <Button
                style={{ marginTop: 8 }}
                icon={<CopyOutlined />}
                onClick={() => void copyText(setupGuideAlert.webhookUrl)}
              >
                Скопировать URL
              </Button>
            </div>
            <div>
              <Typography.Text strong>Message (текст алерта)</Typography.Text>
              <Input.TextArea
                style={{ marginTop: 6 }}
                rows={6}
                readOnly
                value={buildTvAlertMessage(setupGuideAlert.symbol)}
              />
              <Button
                style={{ marginTop: 8 }}
                type="primary"
                icon={<CopyOutlined />}
                onClick={() => void copyText(buildTvAlertMessage(setupGuideAlert.symbol))}
              >
                Скопировать текст алерта
              </Button>
            </div>
          </Space>
        ) : null}
      </Modal>

      <div style={{ marginTop: 24 }}>
        <Button type="link" onClick={() => navigate('/cabinet')}>← В кабинет</Button>
        <Button type="link" onClick={() => navigate('/client/login')}>{t('action.logout', 'Logout')}</Button>
      </div>
    </div>
  );
};

export default TvAlertsCabinet;

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import axios from 'axios';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

const { Paragraph, Text, Title } = Typography;

type ApiKeyRecord = {
  id: number;
  name: string;
  exchange: string;
};

type StrategySummary = {
  id: number;
  name: string;
  strategy_type?: string;
  base_symbol?: string;
  quote_symbol?: string;
  interval?: string;
};

type TradingSystemMember = {
  id?: number;
  system_id: number;
  strategy_id: number;
  weight: number;
  member_role: string;
  is_enabled: boolean;
  notes: string;
  strategy?: StrategySummary | null;
};

type TradingSystem = {
  id?: number;
  name: string;
  description: string;
  is_active: boolean;
  auto_sync_members: boolean;
  discovery_enabled: boolean;
  discovery_interval_hours: number;
  max_members: number;
  members: TradingSystemMember[];
};

type BacktestPoint = {
  time: number;
  equity: number;
};

type BacktestSummary = {
  initialBalance: number;
  finalEquity: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  tradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  strategyNames: string[];
  interval: string;
};

type BacktestResult = {
  runId?: number;
  summary: BacktestSummary;
  equityCurve: BacktestPoint[];
};

type AnalysisReport = {
  strategyId: number;
  strategyName: string;
  symbol: string;
  metrics: Record<string, any>;
  recommendation: {
    recommendation: string;
    severity: string;
    confidence: number;
    rationale: string;
  };
};

type AnalysisResponse = {
  system_id: number;
  system_name: string;
  period_hours: number;
  recommendations_count: number;
  reports: AnalysisReport[];
};

type LiquiditySuggestion = {
  id: number;
  system_id: number;
  symbol: string;
  suggested_action: 'add' | 'replace' | 'watch';
  score: number;
  details_json?: string;
  status: 'new' | 'accepted' | 'rejected' | 'applied';
  created_at: string | number;
};

type Copy = {
  title: string;
  subtitle: string;
  apiKey: string;
  refresh: string;
  systems: string;
  members: string;
  open: string;
  delete: string;
  deleteConfirm: string;
  backtest: string;
  analysis: string;
  suggestions: string;
  scan: string;
  periodHours: string;
  status: string;
  active: string;
  discovery: string;
  interval: string;
  noSystems: string;
  loading: string;
  weights: string;
  role: string;
  notes: string;
  recommendation: string;
  severity: string;
  confidence: string;
  rationale: string;
  replaceSymbol: string;
  action: string;
};

const COPY_BY_LANGUAGE: Record<'ru' | 'en' | 'tr', Copy> = {
  ru: {
    title: 'Trading Systems',
    subtitle: 'Состав торговых систем, быстрый backtest, анализ и liquidity suggestions.',
    apiKey: 'API-ключ',
    refresh: 'Обновить',
    systems: 'Системы',
    members: 'Состав',
    open: 'Открыть',
    delete: 'Удалить',
    deleteConfirm: 'Удалить эту торговую систему?',
    backtest: 'Запустить backtest ТС',
    analysis: 'Анализировать ТС',
    suggestions: 'Liquidity suggestions',
    scan: 'Скан ликвидности',
    periodHours: 'Период анализа, ч',
    status: 'Статус',
    active: 'Активна',
    discovery: 'Discovery',
    interval: 'Интервал',
    noSystems: 'Для этого API-ключа торговые системы не найдены.',
    loading: 'Загрузка...',
    weights: 'Вес',
    role: 'Роль',
    notes: 'Заметки',
    recommendation: 'Рекомендация',
    severity: 'Серьезность',
    confidence: 'Уверенность',
    rationale: 'Обоснование',
    replaceSymbol: 'Замена',
    action: 'Действие',
  },
  en: {
    title: 'Trading Systems',
    subtitle: 'Trading system composition, quick backtests, analysis, and liquidity suggestions.',
    apiKey: 'API Key',
    refresh: 'Refresh',
    systems: 'Systems',
    members: 'Members',
    open: 'Open',
    delete: 'Delete',
    deleteConfirm: 'Delete this trading system?',
    backtest: 'Run system backtest',
    analysis: 'Analyze system',
    suggestions: 'Liquidity suggestions',
    scan: 'Liquidity scan',
    periodHours: 'Analysis period, h',
    status: 'Status',
    active: 'Active',
    discovery: 'Discovery',
    interval: 'Interval',
    noSystems: 'No trading systems found for this API key.',
    loading: 'Loading...',
    weights: 'Weight',
    role: 'Role',
    notes: 'Notes',
    recommendation: 'Recommendation',
    severity: 'Severity',
    confidence: 'Confidence',
    rationale: 'Rationale',
    replaceSymbol: 'Replace',
    action: 'Action',
  },
  tr: {
    title: 'Trading Systems',
    subtitle: 'Trading system uyeleri, hizli backtest, analiz ve liquidity suggestions.',
    apiKey: 'API Key',
    refresh: 'Yenile',
    systems: 'Sistemler',
    members: 'Uyeler',
    open: 'Ac',
    delete: 'Sil',
    deleteConfirm: 'Bu trading system silinsin mi?',
    backtest: 'System backtest calistir',
    analysis: 'System analiz et',
    suggestions: 'Liquidity suggestions',
    scan: 'Likidite taramasi',
    periodHours: 'Analiz periyodu, saat',
    status: 'Durum',
    active: 'Aktif',
    discovery: 'Discovery',
    interval: 'Interval',
    noSystems: 'Bu API key icin trading system bulunamadi.',
    loading: 'Yukleniyor...',
    weights: 'Agirlik',
    role: 'Rol',
    notes: 'Notlar',
    recommendation: 'Oneri',
    severity: 'Seviye',
    confidence: 'Guven',
    rationale: 'Gerekce',
    replaceSymbol: 'Degistir',
    action: 'Aksiyon',
  },
};

const formatNumber = (value: unknown, digits = 2): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '—';
  }
  return numeric.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
};

const formatPercent = (value: unknown, digits = 2): string => `${formatNumber(value, digits)}%`;

const parseSuggestionDetails = (value?: string): Record<string, any> => {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const TradingSystems: React.FC = () => {
  const { language } = useI18n();
  const copy = COPY_BY_LANGUAGE[language];
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [apiKeyName, setApiKeyName] = useState('');
  const [systems, setSystems] = useState<TradingSystem[]>([]);
  const [selectedSystemId, setSelectedSystemId] = useState<number | null>(null);
  const [selectedSystem, setSelectedSystem] = useState<TradingSystem | null>(null);
  const [systemsLoading, setSystemsLoading] = useState(false);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemActionLoading, setSystemActionLoading] = useState('');
  const [periodHours, setPeriodHours] = useState(24);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResponse | null>(null);
  const [suggestions, setSuggestions] = useState<LiquiditySuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  useEffect(() => {
    const password = localStorage.getItem('password');
    if (!password) {
      window.location.href = '/login';
      return;
    }

    axios.defaults.headers.common.Authorization = `Bearer ${password}`;
    void loadApiKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!apiKeyName) {
      setSystems([]);
      setSelectedSystemId(null);
      setSelectedSystem(null);
      return;
    }

    void loadSystems(apiKeyName);
    void loadSuggestions(apiKeyName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyName]);

  useEffect(() => {
    if (!apiKeyName || !selectedSystemId) {
      setSelectedSystem(null);
      return;
    }

    void loadSystem(apiKeyName, selectedSystemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyName, selectedSystemId]);

  const loadApiKeys = useCallback(async () => {
    try {
      const response = await axios.get<ApiKeyRecord[]>('/api/api-keys');
      const rows = Array.isArray(response.data) ? response.data : [];
      setApiKeys(rows);
      if (rows.length > 0) {
        setApiKeyName((current) => current || rows[0].name);
      }
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load API keys'));
    }
  }, []);

  const loadSystems = useCallback(async (nextApiKeyName: string) => {
    setSystemsLoading(true);
    try {
      const response = await axios.get<TradingSystem[]>(`/api/trading-systems/${encodeURIComponent(nextApiKeyName)}`);
      const rows = Array.isArray(response.data) ? response.data : [];
      setSystems(rows);
      setSelectedSystemId((current) => {
        if (current && rows.some((item) => Number(item.id) === current)) {
          return current;
        }
        return rows[0]?.id ? Number(rows[0].id) : null;
      });
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load trading systems'));
      setSystems([]);
      setSelectedSystemId(null);
      setSelectedSystem(null);
    } finally {
      setSystemsLoading(false);
    }
  }, []);

  const loadSystem = useCallback(async (nextApiKeyName: string, systemId: number) => {
    setSystemLoading(true);
    try {
      const response = await axios.get<TradingSystem>(`/api/trading-systems/${encodeURIComponent(nextApiKeyName)}/${systemId}`);
      setSelectedSystem(response.data);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load trading system'));
      setSelectedSystem(null);
    } finally {
      setSystemLoading(false);
    }
  }, []);

  const runSystemBacktest = async () => {
    if (!apiKeyName || !selectedSystemId) {
      return;
    }

    setSystemActionLoading('backtest');
    try {
      const response = await axios.post(`/api/trading-systems/${encodeURIComponent(apiKeyName)}/${selectedSystemId}/backtest`, {
        saveResult: true,
      });
      const result = response.data?.result as BacktestResult | undefined;
      if (!result) {
        throw new Error('Trading system backtest returned empty result');
      }
      setBacktestResult(result);
      message.success('Trading system backtest finished');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to run trading system backtest'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const runSystemAnalysis = async () => {
    if (!apiKeyName || !selectedSystemId) {
      return;
    }

    setSystemActionLoading('analysis');
    try {
      const response = await axios.post<AnalysisResponse>(`/api/analytics/${encodeURIComponent(apiKeyName)}/system/${selectedSystemId}/analysis`, {
        periodHours,
      });
      setAnalysisResult(response.data);
      message.success('Trading system analysis finished');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to analyze trading system'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const loadSuggestions = useCallback(async (nextApiKeyName: string) => {
    if (!nextApiKeyName) {
      return;
    }

    setSuggestionsLoading(true);
    try {
      const response = await axios.get(`/api/analytics/${encodeURIComponent(nextApiKeyName)}/liquidity-suggestions`, {
        params: {
          status: 'all',
          limit: 100,
        },
      });
      const rows = Array.isArray(response.data?.suggestions) ? response.data.suggestions : [];
      setSuggestions(rows);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load liquidity suggestions'));
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  const runLiquidityScan = async () => {
    if (!apiKeyName) {
      return;
    }

    setSystemActionLoading('scan');
    try {
      await axios.post(`/api/analytics/${encodeURIComponent(apiKeyName)}/liquidity-scan/run`, {
        topUniverseLimit: 120,
        maxAddSuggestions: 3,
        maxReplaceSuggestions: 2,
      });
      await loadSuggestions(apiKeyName);
      message.success('Liquidity scan finished');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to run liquidity scan'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const updateSuggestionStatus = async (suggestionId: number, status: 'accepted' | 'rejected' | 'applied') => {
    if (!apiKeyName) {
      return;
    }

    setSystemActionLoading(`suggestion-${suggestionId}`);
    try {
      await axios.patch(`/api/analytics/${encodeURIComponent(apiKeyName)}/liquidity-suggestions/${suggestionId}/status`, {
        status,
      });
      await loadSuggestions(apiKeyName);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to update suggestion status'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const deleteSystem = async (systemId: number) => {
    if (!apiKeyName) {
      return;
    }

    setSystemActionLoading(`delete-${systemId}`);
    try {
      await axios.delete(`/api/trading-systems/${encodeURIComponent(apiKeyName)}/${systemId}`);
      if (selectedSystemId === systemId) {
        setBacktestResult(null);
        setAnalysisResult(null);
      }
      await loadSystems(apiKeyName);
      await loadSuggestions(apiKeyName);
      message.success('Trading system deleted');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to delete trading system'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const equityChartData = useMemo(
    () => (backtestResult?.equityCurve || [])
      .map((point) => ({ time: point.time, value: point.equity }))
      .sort((left, right) => left.time - right.time),
    [backtestResult]
  );

  const visibleSuggestions = useMemo(
    () => suggestions.filter((item) => !selectedSystemId || Number(item.system_id) === selectedSystemId),
    [selectedSystemId, suggestions]
  );

  return (
    <div className="battletoads-form-shell">
      <Card className="battletoads-card" bordered={false}>
        <Title level={3} style={{ marginTop: 0, marginBottom: 8 }}>{copy.title}</Title>
        <Paragraph style={{ marginBottom: 0 }}>{copy.subtitle}</Paragraph>
      </Card>

      <Card className="battletoads-card" style={{ marginTop: 16 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} lg={8}>
            <Text strong>{copy.apiKey}</Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={apiKeyName || undefined}
              onChange={setApiKeyName}
              options={apiKeys.map((item) => ({ value: item.name, label: `${item.name} (${item.exchange})` }))}
            />
          </Col>
          <Col xs={24} md={12} lg={4}>
            <Text strong>{copy.periodHours}</Text>
            <InputNumber min={1} max={720} style={{ width: '100%', marginTop: 8 }} value={periodHours} onChange={(value) => setPeriodHours(Number(value || 24))} />
          </Col>
          <Col xs={24} lg={12}>
            <Space wrap style={{ marginTop: 30 }}>
              <Button onClick={() => void loadSystems(apiKeyName)} loading={systemsLoading}>{copy.refresh}</Button>
              <Button onClick={() => void loadSuggestions(apiKeyName)} loading={suggestionsLoading}>{copy.suggestions}</Button>
              <Button onClick={() => void runLiquidityScan()} loading={systemActionLoading === 'scan'}>{copy.scan}</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 0 }}>
        <Col xs={24} xl={10}>
          <Card className="battletoads-card" title={copy.systems}>
            <Table<TradingSystem>
              rowKey={(row) => String(row.id)}
              dataSource={systems}
              loading={systemsLoading}
              pagination={false}
              locale={{ emptyText: <Empty description={copy.noSystems} /> }}
              scroll={{ x: 720 }}
              columns={[
                {
                  title: 'Name',
                  key: 'name',
                  render: (_value, row) => (
                    <Space direction="vertical" size={0}>
                      <Text strong>{row.name}</Text>
                      <Text type="secondary">#{row.id}</Text>
                    </Space>
                  ),
                },
                {
                  title: copy.status,
                  key: 'status',
                  width: 180,
                  render: (_value, row) => (
                    <Space wrap>
                      <Tag color={row.is_active ? 'success' : 'default'}>{copy.active}: {row.is_active ? 'yes' : 'no'}</Tag>
                      <Tag color={row.discovery_enabled ? 'processing' : 'default'}>{copy.discovery}: {row.discovery_enabled ? 'on' : 'off'}</Tag>
                    </Space>
                  ),
                },
                {
                  title: copy.action,
                  key: 'action',
                  width: 180,
                  render: (_value, row) => (
                    <Space wrap>
                      <Button size="small" onClick={() => setSelectedSystemId(Number(row.id))}>{copy.open}</Button>
                      <Popconfirm title={copy.deleteConfirm} onConfirm={() => void deleteSystem(Number(row.id))}>
                        <Button size="small" danger loading={systemActionLoading === `delete-${row.id}`}>
                          {copy.delete}
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={14}>
          <Card
            className="battletoads-card"
            title={selectedSystem?.name || copy.members}
            extra={selectedSystem ? (
              <Space wrap>
                <Button onClick={() => void runSystemBacktest()} loading={systemActionLoading === 'backtest'}>{copy.backtest}</Button>
                <Button onClick={() => void runSystemAnalysis()} loading={systemActionLoading === 'analysis'}>{copy.analysis}</Button>
              </Space>
            ) : null}
          >
            <Spin spinning={systemLoading} tip={copy.loading}>
              {selectedSystem ? (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <Descriptions column={1} bordered size="small">
                    <Descriptions.Item label="ID">{selectedSystem.id}</Descriptions.Item>
                    <Descriptions.Item label={copy.status}>{selectedSystem.is_active ? 'active' : 'inactive'}</Descriptions.Item>
                    <Descriptions.Item label={copy.discovery}>{selectedSystem.discovery_enabled ? `on (${selectedSystem.discovery_interval_hours}h)` : 'off'}</Descriptions.Item>
                    <Descriptions.Item label="Auto sync">{selectedSystem.auto_sync_members ? 'on' : 'off'}</Descriptions.Item>
                    <Descriptions.Item label="Max members">{selectedSystem.max_members}</Descriptions.Item>
                    <Descriptions.Item label="Description">{selectedSystem.description || '—'}</Descriptions.Item>
                  </Descriptions>

                  <Table<TradingSystemMember>
                    rowKey={(row) => `${row.system_id}-${row.strategy_id}`}
                    dataSource={selectedSystem.members || []}
                    pagination={false}
                    scroll={{ x: 860 }}
                    columns={[
                      {
                        title: 'Strategy',
                        key: 'strategy',
                        render: (_value, row) => (
                          <Space direction="vertical" size={0}>
                            <Text strong>{row.strategy?.name || `#${row.strategy_id}`}</Text>
                            <Text type="secondary">{row.strategy?.base_symbol || '—'} · {row.strategy?.interval || '—'}</Text>
                          </Space>
                        ),
                      },
                      {
                        title: copy.weights,
                        dataIndex: 'weight',
                        key: 'weight',
                        width: 100,
                        render: (value) => formatNumber(value, 3),
                      },
                      {
                        title: copy.role,
                        dataIndex: 'member_role',
                        key: 'member_role',
                        width: 110,
                        render: (value) => <Tag>{String(value || 'core')}</Tag>,
                      },
                      {
                        title: copy.status,
                        dataIndex: 'is_enabled',
                        key: 'is_enabled',
                        width: 110,
                        render: (value) => <Tag color={value ? 'success' : 'default'}>{value ? 'enabled' : 'disabled'}</Tag>,
                      },
                      {
                        title: copy.notes,
                        dataIndex: 'notes',
                        key: 'notes',
                      },
                    ]}
                  />
                </Space>
              ) : (
                <Empty description={copy.noSystems} />
              )}
            </Spin>
          </Card>
        </Col>
      </Row>

      {backtestResult ? (
        <Card className="battletoads-card" title={copy.backtest} style={{ marginTop: 16 }}>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Initial">{formatNumber(backtestResult.summary.initialBalance)}</Descriptions.Item></Descriptions></Col>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Final">{formatNumber(backtestResult.summary.finalEquity)}</Descriptions.Item></Descriptions></Col>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Return">{formatPercent(backtestResult.summary.totalReturnPercent)}</Descriptions.Item></Descriptions></Col>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Max DD">{formatPercent(backtestResult.summary.maxDrawdownPercent)}</Descriptions.Item></Descriptions></Col>
          </Row>

          <Space wrap style={{ marginTop: 12 }}>
            <Tag>{copy.interval}: {backtestResult.summary.interval || '—'}</Tag>
            <Tag>Trades: {formatNumber(backtestResult.summary.tradesCount, 0)}</Tag>
            <Tag>PF: {formatNumber(backtestResult.summary.profitFactor)}</Tag>
            <Tag>WR: {formatPercent(backtestResult.summary.winRatePercent)}</Tag>
          </Space>

          <div style={{ marginTop: 16 }}>
            {equityChartData.length > 0 ? <ChartComponent data={equityChartData} type="line" /> : <Empty description={copy.backtest} />}
          </div>
        </Card>
      ) : null}

      {analysisResult ? (
        <Card className="battletoads-card" title={copy.analysis} style={{ marginTop: 16 }}>
          <Table<AnalysisReport>
            rowKey={(row) => String(row.strategyId)}
            dataSource={analysisResult.reports || []}
            pagination={false}
            scroll={{ x: 980 }}
            columns={[
              {
                title: 'Strategy',
                key: 'strategy',
                render: (_value, row) => (
                  <Space direction="vertical" size={0}>
                    <Text strong>{row.strategyName}</Text>
                    <Text type="secondary">{row.symbol || '—'}</Text>
                  </Space>
                ),
              },
              {
                title: copy.recommendation,
                key: 'recommendation',
                width: 160,
                render: (_value, row) => <Tag color="blue">{row.recommendation?.recommendation || 'none'}</Tag>,
              },
              {
                title: copy.severity,
                key: 'severity',
                width: 130,
                render: (_value, row) => <Tag color={row.recommendation?.severity === 'critical' ? 'error' : row.recommendation?.severity === 'warning' ? 'warning' : 'default'}>{row.recommendation?.severity || 'info'}</Tag>,
              },
              {
                title: copy.confidence,
                key: 'confidence',
                width: 120,
                render: (_value, row) => formatPercent(Number(row.recommendation?.confidence || 0) * 100, 0),
              },
              {
                title: copy.rationale,
                key: 'rationale',
                render: (_value, row) => row.recommendation?.rationale || '—',
              },
            ]}
          />
        </Card>
      ) : null}

      <Card className="battletoads-card" title={copy.suggestions} style={{ marginTop: 16 }}>
        {selectedSystemId && visibleSuggestions.length === 0 && !suggestionsLoading ? (
          <Alert type="info" showIcon message="Для выбранной системы suggestions пока нет." style={{ marginBottom: 12 }} />
        ) : null}

        <Table<LiquiditySuggestion>
          rowKey={(row) => String(row.id)}
          dataSource={visibleSuggestions}
          loading={suggestionsLoading}
          pagination={{ pageSize: 8 }}
          scroll={{ x: 980 }}
          columns={[
            {
              title: 'System',
              dataIndex: 'system_id',
              key: 'system_id',
              width: 90,
            },
            {
              title: 'Symbol',
              dataIndex: 'symbol',
              key: 'symbol',
              width: 120,
            },
            {
              title: copy.action,
              dataIndex: 'suggested_action',
              key: 'suggested_action',
              width: 120,
              render: (value) => <Tag color={value === 'replace' ? 'gold' : value === 'add' ? 'green' : 'default'}>{String(value || 'watch')}</Tag>,
            },
            {
              title: 'Score',
              dataIndex: 'score',
              key: 'score',
              width: 100,
              render: (value) => formatNumber(value),
            },
            {
              title: copy.replaceSymbol,
              key: 'replace',
              render: (_value, row) => parseSuggestionDetails(row.details_json).replace_symbol || '—',
            },
            {
              title: copy.status,
              dataIndex: 'status',
              key: 'status',
              width: 120,
              render: (value) => <Tag color={value === 'accepted' ? 'success' : value === 'rejected' ? 'error' : value === 'applied' ? 'processing' : 'default'}>{String(value || 'new')}</Tag>,
            },
            {
              title: copy.notes,
              key: 'notes',
              render: (_value, row) => parseSuggestionDetails(row.details_json).reason || '—',
            },
            {
              title: copy.action,
              key: 'buttons',
              width: 220,
              render: (_value, row) => (
                <Space wrap>
                  <Button size="small" onClick={() => void updateSuggestionStatus(row.id, 'accepted')} loading={systemActionLoading === `suggestion-${row.id}`}>Accept</Button>
                  <Button size="small" danger onClick={() => void updateSuggestionStatus(row.id, 'rejected')} loading={systemActionLoading === `suggestion-${row.id}`}>Reject</Button>
                  <Button size="small" type="primary" onClick={() => void updateSuggestionStatus(row.id, 'applied')} loading={systemActionLoading === `suggestion-${row.id}`}>Applied</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default TradingSystems;
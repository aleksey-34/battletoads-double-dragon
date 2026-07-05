import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Input, Modal, Progress, Segmented, Space, Spin, Table, Tabs, Tag, Typography, message,
} from 'antd';
import axios from 'axios';
import ChartComponent from '../components/ChartComponent';

type PartnerClient = {
  tenantId: number;
  slug: string;
  displayName: string;
  apiKeyName: string;
  publishedSystem: string;
  enabled: boolean;
  tsMemberCount?: number;
  tsExpected?: number | null;
  tsComplete?: boolean | null;
  lastTradeAt: string | null;
  trades24h?: number;
  monitoring: {
    equityUsd: number;
    unrealizedPnl: number;
    marginLoadPercent: number;
    drawdownPercent: number;
    effectiveLeverage: number;
    pnlNetUsd: number | null;
    recordedAt: string;
    ageMinutes?: number | null;
  } | null;
};

type PartnerRefreshJob = {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  failed: number;
  current: string | null;
};

type TradeSummaryRow = {
  slug: string;
  displayName: string;
  apiKeyName: string;
  publishedSystem: string;
  tradesCount: number;
  entries: number;
  exits: number;
  lastTradeAt: string | null;
  deviationPct: number | null;
  isOutlier: boolean;
};

type MonitoringSnapshot = {
  recorded_at?: string;
  equity_usd?: number;
  unrealized_pnl?: number;
  drawdown_percent?: number;
  pnl_net_usd?: number | null;
  deposit_base_usd?: number | null;
};

type LinePoint = { time: number; value: number };

const fmt = (v: unknown, d = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '—';
};

const systemShort = (name: string) => {
  const s = String(name || '');
  if (s.includes('v4-2') || s.includes('v4-4') || s.includes('b3')) return 'B3/v4';
  if (s.includes('shield')) return 'shield-v2';
  return s.split('::').pop() || s;
};

const ChartLegend = ({ items }: { items: Array<{ color: string; label: string; active: boolean }> }) => (
  <Space wrap size={12}>
    {items.map((item) => (
      <Space key={item.label} size={6}>
        <span style={{
          width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
          backgroundColor: item.active ? item.color : '#d9d9d9',
          boxShadow: item.active ? `0 0 4px ${item.color}88` : 'none',
        }} />
        <span style={{ fontSize: 12, color: item.active ? '#374151' : '#9ca3af' }}>{item.label}</span>
      </Space>
    ))}
  </Space>
);

const PartnerCabinet: React.FC = () => {
  const [activeTab, setActiveTab] = useState('monitoring');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{ clients: PartnerClient[]; totals?: Record<string, number> } | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [chartClient, setChartClient] = useState<PartnerClient | null>(null);
  const [chartDays, setChartDays] = useState(1);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartRaw, setChartRaw] = useState<MonitoringSnapshot[]>([]);
  const [showEquity, setShowEquity] = useState(true);
  const [showPnl, setShowPnl] = useState(true);
  const [showUpnl, setShowUpnl] = useState(true);
  const [showDd, setShowDd] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshJob, setRefreshJob] = useState<PartnerRefreshJob | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesHours, setTradesHours] = useState(24);
  const [tradesData, setTradesData] = useState<{
    rows: TradeSummaryRow[];
    systemMedian: number;
    outliers: TradeSummaryRow[];
    periodHours: number;
    totals?: { clients: number; withTrades: number; trades: number; entries: number; exits: number };
  } | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/saas/partner/dashboard', { timeout: 30_000 });
      setData(res.data);
      setGeneratedAt(String(res.data?.generatedAt || ''));
      if (res.data?.refreshJob) {
        setRefreshJob(res.data.refreshJob);
        if (res.data.refreshJob.status === 'running') {
          setRefreshing(true);
        }
      }
    } catch (err: any) {
      message.error(err?.response?.data?.error || 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTradesSummary = useCallback(async (hours = tradesHours) => {
    setTradesLoading(true);
    try {
      const res = await axios.get('/api/saas/partner/trades-summary', {
        params: { hours },
        timeout: 30_000,
      });
      setTradesData(res.data);
    } catch (err: any) {
      message.error(err?.response?.data?.error || 'Не удалось загрузить сводку сделок');
    } finally {
      setTradesLoading(false);
    }
  }, [tradesHours]);

  const stopPolling = () => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollRefreshStatus = useCallback(() => {
    stopPolling();
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const [statusRes, dashRes] = await Promise.all([
            axios.get('/api/saas/partner/refresh-status', { timeout: 15_000 }),
            axios.get('/api/saas/partner/dashboard', { timeout: 15_000 }),
          ]);
          setRefreshJob(statusRes.data);
          setData(dashRes.data);
          setGeneratedAt(String(dashRes.data?.generatedAt || ''));
          if (statusRes.data?.status !== 'running') {
            stopPolling();
            setRefreshing(false);
            if (statusRes.data?.status === 'done') {
              message.success(`Обновлено: ${statusRes.data.done}/${statusRes.data.total} клиентов`);
            } else if (statusRes.data?.status === 'error') {
              message.warning(`Обновление завершено с ошибками (${statusRes.data.failed || 0})`);
            }
            void loadDashboard();
          }
        } catch {
          // keep polling
        }
      })();
    }, 3000);
  }, [loadDashboard]);

  const startLiveRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await axios.post('/api/saas/partner/refresh', {}, { timeout: 20_000 });
      if (res.data?.refreshSkipped) {
        const min = Math.ceil(Number(res.data.refreshRetryAfterSec || 0) / 60);
        message.warning(min > 0
          ? `С биржи можно обновить через ~${min} мин`
          : 'Обновление недоступно — показаны сохранённые снимки');
        setRefreshing(false);
        return;
      }
      if (res.data?.job) {
        setRefreshJob(res.data.job);
      }
      message.info('Опрос биржи запущен — обновляем клиентов пакетами');
      pollRefreshStatus();
    } catch (err: any) {
      message.error(err?.response?.data?.error || 'Не удалось запустить обновление');
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const token = localStorage.getItem('partner_token') || localStorage.getItem('password');
    if (!token) {
      window.location.href = '/partner/login';
      return;
    }
    axios.defaults.headers.common.Authorization = `Bearer ${token}`;
    void loadDashboard();
    return () => stopPolling();
  }, [loadDashboard]);

  useEffect(() => {
    if (activeTab === 'trades') {
      void loadTradesSummary();
    }
  }, [activeTab, loadTradesSummary]);

  const loadChart = async (client: PartnerClient, days: number) => {
    if (!client.apiKeyName) return;
    setChartLoading(true);
    try {
      const params: Record<string, number> = days > 1 ? { days } : { limit: 288 };
      const res = await axios.get(`/api/saas/partner/monitoring/${encodeURIComponent(client.apiKeyName)}`, { params });
      setChartRaw(Array.isArray(res.data?.points) ? res.data.points : []);
    } catch {
      setChartRaw([]);
    } finally {
      setChartLoading(false);
    }
  };

  const openChart = (client: PartnerClient) => {
    setChartClient(client);
    setChartOpen(true);
    setChartDays(1);
    void loadChart(client, 1);
  };

  useEffect(() => {
    if (chartOpen && chartClient) void loadChart(chartClient, chartDays);
  }, [chartDays]);

  const equitySeries = useMemo(() => chartRaw.map((r) => {
    const t = r.recorded_at ? new Date(r.recorded_at).getTime() / 1000 : 0;
    const v = Number(r.equity_usd);
    return Number.isFinite(t) && t > 0 && Number.isFinite(v) ? { time: Math.floor(t), value: v } : null;
  }).filter((x): x is LinePoint => x !== null), [chartRaw]);

  const monitoringColumns = [
    { title: 'Клиент', dataIndex: 'slug', render: (_: string, row: PartnerClient) => (
      <Space direction="vertical" size={0}>
        <strong>{row.displayName || row.slug}</strong>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{row.slug}</span>
      </Space>
    ) },
    { title: 'ТС', dataIndex: 'publishedSystem', width: 100, render: (v: string, row: PartnerClient) => (
      <Space direction="vertical" size={0}>
        <Tag color={v.includes('v4') ? 'green' : 'default'}>{systemShort(v)}</Tag>
        {row.tsExpected ? (
          <span style={{ fontSize: 11, color: row.tsComplete ? '#16a34a' : '#d97706' }}>
            {row.tsMemberCount}/{row.tsExpected} legs
          </span>
        ) : null}
      </Space>
    ) },
    { title: 'Статус', dataIndex: 'enabled', width: 90, render: (v: boolean) => (
      <Tag color={v ? 'success' : 'default'}>{v ? 'активен' : 'стоп'}</Tag>
    ) },
    { title: 'Equity', render: (_: unknown, row: PartnerClient) => (
      <Space direction="vertical" size={0}>
        <span>${fmt(row.monitoring?.equityUsd)}</span>
        {row.monitoring?.recordedAt ? (
          <span style={{ fontSize: 10, color: (row.monitoring.ageMinutes ?? 0) > 15 ? '#d97706' : '#9ca3af' }}>
            {(row.monitoring.ageMinutes ?? 0) <= 1 ? 'только что' : `${row.monitoring.ageMinutes} мин назад`}
          </span>
        ) : (
          <span style={{ fontSize: 10, color: '#9ca3af' }}>нет snapshot</span>
        )}
      </Space>
    ) },
    { title: 'UPNL', render: (_: unknown, row: PartnerClient) => {
      const v = Number(row.monitoring?.unrealizedPnl || 0);
      return <span style={{ color: v >= 0 ? '#16a34a' : '#dc2626' }}>${fmt(v)}</span>;
    } },
    { title: 'DD %', render: (_: unknown, row: PartnerClient) => `${fmt(row.monitoring?.drawdownPercent)}%` },
    { title: 'PnL net', render: (_: unknown, row: PartnerClient) => {
      const v = row.monitoring?.pnlNetUsd;
      if (v == null) return '—';
      return <span style={{ color: Number(v) >= 0 ? '#16a34a' : '#dc2626' }}>${fmt(v)}</span>;
    } },
    { title: 'Сделки 24ч', width: 100, render: (_: unknown, row: PartnerClient) => (
      <Space direction="vertical" size={0}>
        <span>{row.trades24h ?? 0}</span>
        {row.lastTradeAt ? (
          <span style={{ fontSize: 10, color: '#9ca3af' }}>
            посл. {new Date(row.lastTradeAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : (
          <span style={{ fontSize: 10, color: '#9ca3af' }}>нет сделок</span>
        )}
      </Space>
    ) },
    { title: '', width: 110, render: (_: unknown, row: PartnerClient) => (
      <Button size="small" type="primary" ghost disabled={!row.apiKeyName} onClick={() => openChart(row)}>
        График
      </Button>
    ) },
  ];

  const tradesColumns = [
    { title: 'Клиент', dataIndex: 'displayName', render: (v: string, row: TradeSummaryRow) => (
      <Space direction="vertical" size={0}>
        <strong>{v || row.slug}</strong>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{systemShort(row.publishedSystem)}</span>
      </Space>
    ) },
    { title: 'Сделок', dataIndex: 'tradesCount', width: 90, sorter: (a: TradeSummaryRow, b: TradeSummaryRow) => a.tradesCount - b.tradesCount },
    { title: 'In', dataIndex: 'entries', width: 70 },
    { title: 'Out', dataIndex: 'exits', width: 70 },
    { title: 'vs медиана', render: (_: unknown, row: TradeSummaryRow) => {
      if (row.deviationPct == null) return '—';
      const color = row.isOutlier ? '#d97706' : '#6b7280';
      const sign = row.deviationPct > 0 ? '+' : '';
      return <span style={{ color }}>{sign}{row.deviationPct}%</span>;
    } },
    { title: 'Последняя', render: (_: unknown, row: TradeSummaryRow) => (
      row.lastTradeAt ? new Date(row.lastTradeAt).toLocaleString('ru-RU') : '—'
    ) },
    { title: '', width: 90, render: (_: unknown, row: TradeSummaryRow) => (
      row.isOutlier ? <Tag color="warning">отклонение</Tag> : null
    ) },
  ];

  const refreshPercent = refreshJob && refreshJob.total > 0
    ? Math.round((refreshJob.done / refreshJob.total) * 100)
    : 0;

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <Card
        title="Кабинет партнёра"
        extra={(
          <Space>
            {activeTab === 'monitoring' ? (
              <Button onClick={() => void startLiveRefresh()} loading={refreshing} disabled={refreshing}>
                Обновить с биржи
              </Button>
            ) : (
              <Button onClick={() => void loadTradesSummary()} loading={tradesLoading}>
                Обновить сводку
              </Button>
            )}
            <Button onClick={() => { localStorage.removeItem('partner_token'); window.location.href = '/partner/login'; }}>
              Выйти
            </Button>
          </Space>
        )}
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: 'monitoring', label: 'Мониторинг' },
            { key: 'trades', label: 'Сделки' },
          ]}
        />

        {refreshing && refreshJob ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`Опрос биржи: ${refreshJob.done}/${refreshJob.total}${refreshJob.current ? ` — ${refreshJob.current}` : ''}`}
            description={<Progress percent={refreshPercent} size="small" status="active" />}
          />
        ) : null}

        {activeTab === 'monitoring' ? (
          <>
            {data?.totals ? (
              <Space wrap style={{ marginBottom: 16 }}>
                <Tag color="blue">Клиентов: {data.totals.clients}</Tag>
                <Tag color="green">Активных: {data.totals.enabled}</Tag>
                <Tag color="purple">На v4.2+: {data.totals.onV42}</Tag>
                {typeof data.totals.tsComplete === 'number' ? (
                  <Tag color="cyan">TS 20/20: {data.totals.tsComplete}</Tag>
                ) : null}
                {generatedAt ? (
                  <Tag>обновлено {new Date(generatedAt).toLocaleTimeString()}</Tag>
                ) : null}
              </Space>
            ) : null}
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
              Цифры из снимков мониторинга (runtime ~10 мин). Кнопка запускает фоновый опрос биржи
              (WEEX по одному, остальные пакетами) — не чаще 1 раза в час.
            </Typography.Paragraph>
            <Spin spinning={loading}>
              <Table
                rowKey="tenantId"
                size="small"
                pagination={{ pageSize: 20 }}
                dataSource={data?.clients || []}
                columns={monitoringColumns}
              />
            </Spin>
          </>
        ) : (
          <>
            <Space style={{ marginBottom: 12 }} wrap>
              <Segmented
                options={[
                  { label: '6ч', value: 6 },
                  { label: '24ч', value: 24 },
                  { label: '7д', value: 168 },
                ]}
                value={tradesHours}
                onChange={(v) => {
                  const hours = Number(v);
                  setTradesHours(hours);
                  void loadTradesSummary(hours);
                }}
              />
              {tradesData?.totals ? (
                <>
                  <Tag color="blue">Сделок: {tradesData.totals.trades}</Tag>
                  <Tag color="green">Клиентов с сделками: {tradesData.totals.withTrades}/{tradesData.totals.clients}</Tag>
                  <Tag>Медиана: {tradesData.systemMedian}</Tag>
                </>
              ) : null}
            </Space>
            {!tradesLoading && tradesData && tradesData.totals?.trades === 0 ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={`За последние ${tradesData.periodHours}ч новых сделок нет`}
                description="Runtime работает — стратегии в no_signal на закрытых барах. Смотрите колонку «Сделки 24ч» на вкладке Мониторинг или переключите период на 24ч/7д."
              />
            ) : null}
            {tradesData?.outliers?.length ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`Отклонения: ${tradesData.outliers.length} клиент(ов) сильно отличаются от медианы по своей ТС`}
              />
            ) : null}
            <Spin spinning={tradesLoading}>
              <Table
                rowKey="slug"
                size="small"
                pagination={{ pageSize: 20 }}
                dataSource={tradesData?.rows || []}
                columns={tradesColumns}
              />
            </Spin>
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
              Та же сводка уходит в Telegram админ-бота каждые 6 часов (отклонения и топ активности).
            </Typography.Paragraph>
          </>
        )}
      </Card>

      <Modal
        title={`Мониторинг: ${chartClient?.displayName || chartClient?.slug || '—'}`}
        open={chartOpen}
        onCancel={() => setChartOpen(false)}
        footer={null}
        width={960}
      >
        <Spin spinning={chartLoading}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <ChartLegend items={[
              { color: '#2563eb', label: 'Equity', active: showEquity },
              { color: '#16a34a', label: 'PnL net', active: showPnl },
              { color: '#7c3aed', label: 'UPNL', active: showUpnl },
              { color: '#d97706', label: 'DD %', active: showDd },
            ]} />
            <Space wrap>
              <Checkbox checked={showEquity} onChange={(e) => setShowEquity(e.target.checked)}>Equity</Checkbox>
              <Checkbox checked={showPnl} onChange={(e) => setShowPnl(e.target.checked)}>PnL</Checkbox>
              <Checkbox checked={showUpnl} onChange={(e) => setShowUpnl(e.target.checked)}>UPNL</Checkbox>
              <Checkbox checked={showDd} onChange={(e) => setShowDd(e.target.checked)}>DD %</Checkbox>
              <Segmented
                options={[{ label: '1д', value: 1 }, { label: '7д', value: 7 }, { label: '30д', value: 30 }]}
                value={chartDays}
                onChange={(v) => setChartDays(Number(v))}
              />
            </Space>
            {equitySeries.length > 0 ? (
              <ChartComponent
                data={showEquity ? equitySeries : equitySeries}
                type="line"
                overlayLines={[
                  ...(showPnl ? [{
                    id: 'pnl-net',
                    color: '#16a34a',
                    lineWidth: 2,
                    data: chartRaw.map((r) => {
                      const t = r.recorded_at ? new Date(r.recorded_at).getTime() / 1000 : 0;
                      const v = Number(r.pnl_net_usd != null ? r.pnl_net_usd : Number(r.equity_usd || 0) - Number(r.unrealized_pnl || 0) - Number(r.deposit_base_usd || 0));
                      return Number.isFinite(t) && t > 0 && Number.isFinite(v) ? { time: Math.floor(t), value: v } : null;
                    }).filter((p): p is LinePoint => !!p),
                  }] : []),
                  ...(showUpnl ? [{
                    id: 'upnl',
                    color: '#7c3aed',
                    lineWidth: 2,
                    data: chartRaw.map((r) => {
                      const t = r.recorded_at ? new Date(r.recorded_at).getTime() / 1000 : 0;
                      const v = Number(r.unrealized_pnl);
                      return Number.isFinite(t) && t > 0 && Number.isFinite(v) ? { time: Math.floor(t), value: v } : null;
                    }).filter((p): p is LinePoint => !!p),
                  }] : []),
                  ...(showDd ? [{
                    id: 'drawdown-pct',
                    color: '#d97706',
                    lineWidth: 1,
                    priceScaleId: 'left' as const,
                    data: chartRaw.map((r) => {
                      const t = r.recorded_at ? new Date(r.recorded_at).getTime() / 1000 : 0;
                      const v = Number(r.drawdown_percent);
                      return Number.isFinite(t) && t > 0 && Number.isFinite(v) ? { time: Math.floor(t), value: v } : null;
                    }).filter((p): p is LinePoint => !!p),
                  }] : []),
                ]}
              />
            ) : (
              <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Нет снимков мониторинга</div>
            )}
          </Space>
        </Spin>
      </Modal>
    </div>
  );
};

export const PartnerLogin: React.FC = () => {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const value = token.trim();
    if (!value) return;
    setLoading(true);
    try {
      axios.defaults.headers.common.Authorization = `Bearer ${value}`;
      await axios.get('/api/saas/partner/dashboard');
      localStorage.setItem('partner_token', value);
      window.location.href = '/partner';
    } catch {
      message.error('Неверный код доступа');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card title="Вход в кабинет партнёра" style={{ width: 360 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.Password placeholder="Код доступа" value={token} onChange={(e) => setToken(e.target.value)} onPressEnter={() => void submit()} />
          <Button type="primary" block loading={loading} onClick={() => void submit()}>Войти</Button>
        </Space>
      </Card>
    </div>
  );
};

export default PartnerCabinet;

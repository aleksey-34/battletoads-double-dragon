import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Checkbox, Input, Modal, Segmented, Space, Spin, Table, Tag, message,
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
  monitoring: {
    equityUsd: number;
    unrealizedPnl: number;
    marginLoadPercent: number;
    drawdownPercent: number;
    effectiveLeverage: number;
    pnlNetUsd: number | null;
    recordedAt: string;
  } | null;
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
  if (s.includes('v4-2')) return 'v4.2';
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

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/saas/partner/dashboard');
      setData(res.data);
    } catch (err: any) {
      message.error(err?.response?.data?.error || 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('partner_token') || localStorage.getItem('password');
    if (!token) {
      window.location.href = '/partner/login';
      return;
    }
    axios.defaults.headers.common.Authorization = `Bearer ${token}`;
    void loadDashboard();
  }, [loadDashboard]);

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

  const columns = [
    { title: 'Клиент', dataIndex: 'slug', render: (_: string, row: PartnerClient) => (
      <Space direction="vertical" size={0}>
        <strong>{row.displayName || row.slug}</strong>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{row.slug}</span>
      </Space>
    ) },
    { title: 'ТС', dataIndex: 'publishedSystem', render: (v: string) => (
      <Tag color={v.includes('v4-2') ? 'green' : 'default'}>{systemShort(v)}</Tag>
    ) },
    { title: 'Статус', dataIndex: 'enabled', width: 90, render: (v: boolean) => (
      <Tag color={v ? 'success' : 'default'}>{v ? 'активен' : 'стоп'}</Tag>
    ) },
    { title: 'Equity', render: (_: unknown, row: PartnerClient) => `$${fmt(row.monitoring?.equityUsd)}` },
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
    { title: '', width: 110, render: (_: unknown, row: PartnerClient) => (
      <Button size="small" type="primary" ghost disabled={!row.apiKeyName} onClick={() => openChart(row)}>
        График
      </Button>
    ) },
  ];

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <Card
        title="Кабинет партнёра — мониторинг клиентов"
        extra={(
          <Space>
            <Button onClick={() => void loadDashboard()} loading={loading}>Обновить</Button>
            <Button onClick={() => { localStorage.removeItem('partner_token'); window.location.href = '/partner/login'; }}>
              Выйти
            </Button>
          </Space>
        )}
      >
        {data?.totals ? (
          <Space wrap style={{ marginBottom: 16 }}>
            <Tag color="blue">Клиентов: {data.totals.clients}</Tag>
            <Tag color="green">Активных: {data.totals.enabled}</Tag>
            <Tag color="purple">На v4.2: {data.totals.onV42}</Tag>
          </Space>
        ) : null}
        <Spin spinning={loading}>
          <Table
            rowKey="tenantId"
            size="small"
            pagination={{ pageSize: 20 }}
            dataSource={data?.clients || []}
            columns={columns}
          />
        </Spin>
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

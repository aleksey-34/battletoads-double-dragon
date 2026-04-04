import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Card, Row, Col, Statistic, Button, Space, Switch, Tag, Table, InputNumber,
  Select, Input, Divider, Typography, Alert, Tooltip, Progress, Badge, message,
} from 'antd';
import {
  PlayCircleOutlined, PauseCircleOutlined, StopOutlined,
  ThunderboltOutlined, RocketOutlined, DollarOutlined,
  ReloadOutlined, SettingOutlined, SaveOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { useI18n } from '../i18n';

const { Title, Text } = Typography;

const API = '/api/razgon';

type ApiKeyRecord = { id: number; name: string; exchange: string };

interface RazgonStats {
  status: 'stopped' | 'running' | 'paused' | 'error';
  balance: number;
  startBalance: number;
  peakBalance: number;
  totalPnl: number;
  todayPnl: number;
  totalTrades: number;
  todayTrades: number;
  winRate: number;
  avgRR: number;
  openPositions: any[];
  lastError?: string;
}

interface RazgonTrade {
  id: string;
  subStrategy: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  notional: number;
  grossPnl: number;
  fee: number;
  netPnl: number;
  openedAt: number;
  closedAt: number;
  exitReason: string;
}

const statusColors: Record<string, string> = {
  running: 'green',
  paused: 'orange',
  stopped: 'default',
  error: 'red',
};

const DEFAULT_CONFIG = {
  exchange: 'mexc',
  apiKeyName: 'razgon_mexc',
  startBalance: 40,
  momentum: {
    enabled: true, allocation: 0.60, leverage: 25, marginType: 'isolated' as const,
    donchianPeriod: 15, volumeMultiplier: 2.0, trailingTpPercent: 0.3,
    stopLossPercent: 0.2, maxPositionTimeSec: 900, tickIntervalSec: 5,
    maxConcurrentPositions: 3, atrFilterMin: 0.005,
    watchlist: ['PEPEUSDT', 'WIFUSDT', 'SUIUSDT', 'DOGEUSDT', 'SOLUSDT', 'ARBUSDT', 'ORDIUSDT'],
  },
  sniper: {
    enabled: true, allocation: 0.25, leverage: 10, marginType: 'isolated' as const,
    entryDelayMs: 60000, takeProfitPercent: 15, stopLossPercent: 5,
    maxPositionTimeSec: 300, scanIntervalSec: 30,
  },
  funding: {
    enabled: false, allocation: 0.15, leverage: 10, marginType: 'isolated' as const,
    minFundingRate: 0.0005, minVolume24h: 5000000, maxPositions: 3,
    stopLossPercent: 3, scanIntervalSec: 14400,
  },
  risk: {
    maxRiskPerTrade: 0.05, maxDailyLoss: 0.20,
    rescaleThreshold: 0.25, noAveragingDown: true, forceIsolatedMargin: true,
  },
  withdraw: {
    enabled: false, threshold: 100, withdrawPercent: 0.30,
    minWithdraw: 10, targetAddress: '', cooldownHours: 24,
  },
};

export default function Razgon() {
  const { t } = useI18n();
  const [stats, setStats] = useState<RazgonStats | null>(null);
  const [trades, setTrades] = useState<RazgonTrade[]>([]);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [showPositions, setShowPositions] = useState(false);
  const [posAutoRefresh, setPosAutoRefresh] = useState(false);
  const posRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [sRes, tRes] = await Promise.all([
        axios.get(`${API}/status`),
        axios.get(`${API}/trades?limit=50`),
      ]);
      setStats(sRes.data);
      setTrades(tRes.data);
    } catch { /* ignore */ }
  }, []);

  const fetchLiveRefresh = useCallback(async () => {
    try {
      const [sRes, tRes] = await Promise.all([
        axios.post(`${API}/refresh`),
        axios.get(`${API}/trades?limit=50`),
      ]);
      setStats(sRes.data);
      setTrades(tRes.data);
    } catch { /* ignore */ }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/config`);
      if (res.data && typeof res.data === 'object' && res.data.apiKeyName) {
        setConfig(res.data);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchConfig();
    axios.get('/api/api-keys').then(r => {
      const keys = Array.isArray(r.data) ? r.data as ApiKeyRecord[] : [];
      setApiKeys(keys);
    }).catch(err => console.error('Failed to load API keys:', err));
    pollRef.current = setInterval(fetchStatus, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus, fetchConfig]);

  // Positions auto-refresh (slow, 30s)
  useEffect(() => {
    if (posRefreshRef.current) { clearInterval(posRefreshRef.current); posRefreshRef.current = null; }
    if (posAutoRefresh && showPositions) {
      posRefreshRef.current = setInterval(fetchLiveRefresh, 30000);
    }
    return () => { if (posRefreshRef.current) clearInterval(posRefreshRef.current); };
  }, [posAutoRefresh, showPositions, fetchLiveRefresh]);

  const handleStart = async () => {
    if (!config.apiKeyName || !apiKeys.some(k => k.name === config.apiKeyName)) {
      message.warning('Сначала выберите API ключ!');
      return;
    }
    setLoading(true);
    try {
      const res = await axios.post(`${API}/start`, config);
      if (res.data.ok) { message.success('Разгон запущен!'); }
      else { message.error(res.data.error || 'Error'); }
    } catch (e: any) { message.error(e.response?.data?.error || 'Failed'); }
    setLoading(false);
    fetchStatus();
  };

  const handleStop = async () => {
    await axios.post(`${API}/stop`);
    message.info('Разгон остановлен');
    fetchStatus();
  };

  const handlePause = async () => {
    await axios.post(`${API}/pause`);
    message.info('Разгон на паузе');
    fetchStatus();
  };

  const handleSaveConfig = async () => {
    try {
      await axios.patch(`${API}/config`, config);
      message.success('Настройки сохранены');
    } catch (e: any) {
      message.error(e.response?.data?.error || 'Ошибка сохранения');
    }
  };

  const pnlColor = (v: number) => v >= 0 ? '#3f8600' : '#cf1322';
  const isRunning = stats?.status === 'running';
  const isPaused = stats?.status === 'paused';

  const tradeColumns = [
    {
      title: 'Время', dataIndex: 'closedAt', key: 'time', width: 150,
      render: (v: number) => new Date(v).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' }),
    },
    { title: 'Стратегия', dataIndex: 'subStrategy', key: 'sub', width: 100,
      render: (v: string) => <Tag color={v === 'momentum' ? 'blue' : v === 'sniper' ? 'volcano' : 'green'}>{v}</Tag>,
    },
    { title: 'Символ', dataIndex: 'symbol', key: 'sym', width: 120 },
    { title: 'Сторона', dataIndex: 'side', key: 'side', width: 80,
      render: (v: string) => <Tag color={v === 'long' ? 'green' : 'red'}>{(v ?? '').toUpperCase()}</Tag>,
    },
    { title: 'Нотионал', dataIndex: 'notional', key: 'not', width: 100,
      render: (v: number) => `$${(v ?? 0).toFixed(0)}`,
    },
    { title: 'PnL', dataIndex: 'netPnl', key: 'pnl', width: 100,
      render: (v: number) => { const n = v ?? 0; return <Text style={{ color: pnlColor(n) }}>{n >= 0 ? '+' : ''}{n.toFixed(2)}</Text>; },
    },
    { title: 'Выход', dataIndex: 'exitReason', key: 'exit', width: 90,
      render: (v: string) => {
        const colors: Record<string, string> = { tp: 'green', sl: 'red', timeout: 'orange', manual: 'default', daily_limit: 'purple' };
        return <Tag color={colors[v] || 'default'}>{v ?? '-'}</Tag>;
      },
    },
  ];

  const positionColumns = [
    { title: 'Символ', dataIndex: 'symbol', key: 'sym' },
    { title: 'Стратегия', dataIndex: 'subStrategy', key: 'sub',
      render: (v: string) => <Tag color={v === 'momentum' ? 'blue' : v === 'sniper' ? 'volcano' : 'green'}>{v ?? '-'}</Tag>,
    },
    { title: 'Сторона', dataIndex: 'side', key: 'side',
      render: (v: string) => <Tag color={v === 'long' ? 'green' : 'red'}>{(v ?? '').toUpperCase()}</Tag>,
    },
    { title: 'Вход', dataIndex: 'entryPrice', key: 'entry', render: (v: number) => (v ?? 0).toFixed(6) },
    { title: 'Нотионал', dataIndex: 'notional', key: 'not', render: (v: number) => `$${(v ?? 0).toFixed(0)}` },
    { title: 'UPnL', dataIndex: 'unrealizedPnl', key: 'upnl',
      render: (v: number) => { const n = v ?? 0; return <Text style={{ color: pnlColor(n) }}>{n >= 0 ? '+' : ''}{n.toFixed(2)}</Text>; },
    },
    { title: 'Время', dataIndex: 'openedAt', key: 'time',
      render: (v: number) => { const s = Math.floor((Date.now() - v) / 1000); return `${s}s`; },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row gutter={[16, 16]} align="middle" style={{ marginBottom: 16 }}>
        <Col flex="auto">
          <Title level={3} style={{ margin: 0 }}>
            <ThunderboltOutlined /> Разгон
            <Badge
              status={isRunning ? 'processing' : isPaused ? 'warning' : 'default'}
              style={{ marginLeft: 12 }}
            />
            <Tag color={statusColors[stats?.status || 'stopped']} style={{ marginLeft: 8 }}>
              {stats?.status?.toUpperCase() || 'STOPPED'}
            </Tag>
          </Title>
        </Col>
        <Col>
          <Space>
            <Button
              type="primary" icon={<PlayCircleOutlined />}
              onClick={handleStart}
              loading={loading}
              disabled={isRunning}
            >
              Запуск
            </Button>
            <Button icon={<PauseCircleOutlined />} onClick={handlePause} disabled={!isRunning}>
              Пауза
            </Button>
            <Button danger icon={<StopOutlined />} onClick={handleStop} disabled={!isRunning && !isPaused}>
              Стоп
            </Button>
            <Button icon={<ReloadOutlined />} onClick={fetchStatus} />
          </Space>
        </Col>
      </Row>

      {/* Stats Cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Баланс" value={stats?.balance ?? 0} precision={2} prefix="$" />
          </Card>
        </Col>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Общий PnL" value={stats?.totalPnl ?? 0} precision={2} prefix="$"
              valueStyle={{ color: pnlColor(stats?.totalPnl ?? 0) }} />
          </Card>
        </Col>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Сегодня PnL" value={stats?.todayPnl ?? 0} precision={2} prefix="$"
              valueStyle={{ color: pnlColor(stats?.todayPnl ?? 0) }} />
          </Card>
        </Col>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Win Rate" value={(stats?.winRate ?? 0) * 100} precision={1} suffix="%" />
          </Card>
        </Col>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Сделок всего" value={stats?.totalTrades ?? 0} />
          </Card>
        </Col>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Сегодня сделок" value={stats?.todayTrades ?? 0} />
          </Card>
        </Col>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Пик баланса" value={stats?.peakBalance ?? 0} precision={2} prefix="$" />
          </Card>
        </Col>
        <Col xs={12} sm={6} lg={3}>
          <Card size="small">
            <Statistic title="Avg RR" value={stats?.avgRR ?? 0} precision={2} suffix="x" />
          </Card>
        </Col>
      </Row>

      {/* Open Positions */}
      <Card
        title={<Space>
          <span>Открытые позиции</span>
          <Badge count={stats?.openPositions?.length ?? 0} style={{ backgroundColor: '#1890ff' }} />
        </Space>}
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchLiveRefresh()}>Обновить</Button>
            <Tag color={posAutoRefresh ? 'green' : 'default'}>
              {posAutoRefresh ? 'Авто: 30с' : 'Авто: выкл'}
            </Tag>
            <Button size="small" onClick={() => setPosAutoRefresh(p => !p)}>
              {posAutoRefresh ? 'Выкл авто' : 'Вкл авто'}
            </Button>
            <Button size="small" type={showPositions ? 'primary' : 'default'} onClick={() => setShowPositions(p => !p)}>
              {showPositions ? 'Свернуть' : 'Развернуть'}
            </Button>
          </Space>
        }
      >
        {showPositions && (
          <Table
            dataSource={stats?.openPositions ?? []}
            columns={positionColumns}
            rowKey="id"
            pagination={false}
            size="small"
            locale={{ emptyText: 'Нет открытых позиций' }}
          />
        )}
      </Card>

      {/* Configuration */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {/* Momentum Settings */}
        <Col xs={24} lg={8}>
          <Card
            title={<><ThunderboltOutlined /> Momentum Scalping</>}
            size="small"
            extra={
              <Switch
                checked={config.momentum.enabled}
                onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, enabled: v } }))}
                disabled={isRunning}
              />
            }
          >
            <Row gutter={[8, 8]}>
              <Col span={12}>
                <Text type="secondary">Леверидж</Text>
                <InputNumber min={1} max={100} value={config.momentum.leverage} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, leverage: v ?? 25 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Аллокация %</Text>
                <InputNumber min={0.1} max={1} step={0.05} value={config.momentum.allocation} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, allocation: v ?? 0.6 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Donchian period</Text>
                <InputNumber min={5} max={60} value={config.momentum.donchianPeriod} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, donchianPeriod: v ?? 15 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Volume mult</Text>
                <InputNumber min={1} max={5} step={0.5} value={config.momentum.volumeMultiplier} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, volumeMultiplier: v ?? 2 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">TP trail %</Text>
                <InputNumber min={0.1} max={5} step={0.1} value={config.momentum.trailingTpPercent} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, trailingTpPercent: v ?? 0.3 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">SL %</Text>
                <InputNumber min={0.05} max={5} step={0.05} value={config.momentum.stopLossPercent} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, stopLossPercent: v ?? 0.2 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Таймаут (сек)</Text>
                <InputNumber min={60} max={3600} step={60} value={config.momentum.maxPositionTimeSec} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, maxPositionTimeSec: v ?? 900 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Макс. позиций</Text>
                <InputNumber min={1} max={10} value={config.momentum.maxConcurrentPositions} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, momentum: { ...c.momentum, maxConcurrentPositions: v ?? 3 } }))}
                  disabled={isRunning} />
              </Col>
            </Row>
          </Card>
        </Col>

        {/* Sniper Settings */}
        <Col xs={24} lg={8}>
          <Card
            title={<><RocketOutlined /> Listing Sniper</>}
            size="small"
            extra={
              <Switch
                checked={config.sniper.enabled}
                onChange={v => setConfig(c => ({ ...c, sniper: { ...c.sniper, enabled: v } }))}
                disabled={isRunning}
              />
            }
          >
            <Row gutter={[8, 8]}>
              <Col span={12}>
                <Text type="secondary">Леверидж</Text>
                <InputNumber min={1} max={50} value={config.sniper.leverage} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, sniper: { ...c.sniper, leverage: v ?? 10 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Аллокация %</Text>
                <InputNumber min={0.05} max={0.5} step={0.05} value={config.sniper.allocation} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, sniper: { ...c.sniper, allocation: v ?? 0.25 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">TP %</Text>
                <InputNumber min={1} max={50} value={config.sniper.takeProfitPercent} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, sniper: { ...c.sniper, takeProfitPercent: v ?? 15 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">SL %</Text>
                <InputNumber min={1} max={20} value={config.sniper.stopLossPercent} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, sniper: { ...c.sniper, stopLossPercent: v ?? 5 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Задержка входа (мс)</Text>
                <InputNumber min={5000} max={300000} step={5000} value={config.sniper.entryDelayMs} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, sniper: { ...c.sniper, entryDelayMs: v ?? 60000 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Таймаут (сек)</Text>
                <InputNumber min={60} max={1800} step={60} value={config.sniper.maxPositionTimeSec} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, sniper: { ...c.sniper, maxPositionTimeSec: v ?? 300 } }))}
                  disabled={isRunning} />
              </Col>
            </Row>
          </Card>
        </Col>

        {/* Funding Settings */}
        <Col xs={24} lg={8}>
          <Card
            title={<><DollarOutlined /> Funding Farming</>}
            size="small"
            extra={
              <Switch
                checked={config.funding.enabled}
                onChange={v => setConfig(c => ({ ...c, funding: { ...c.funding, enabled: v } }))}
                disabled={isRunning}
              />
            }
          >
            <Row gutter={[8, 8]}>
              <Col span={12}>
                <Text type="secondary">Леверидж</Text>
                <InputNumber min={1} max={50} value={config.funding.leverage} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, funding: { ...c.funding, leverage: v ?? 10 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Мин. FR %</Text>
                <InputNumber min={0.0001} max={0.01} step={0.0001} value={config.funding.minFundingRate} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, funding: { ...c.funding, minFundingRate: v ?? 0.0005 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">Макс. позиций</Text>
                <InputNumber min={1} max={10} value={config.funding.maxPositions} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, funding: { ...c.funding, maxPositions: v ?? 3 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={12}>
                <Text type="secondary">SL %</Text>
                <InputNumber min={1} max={10} value={config.funding.stopLossPercent} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, funding: { ...c.funding, stopLossPercent: v ?? 3 } }))}
                  disabled={isRunning} />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      {/* Risk & Global Settings */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <Card title={<><SettingOutlined /> Риск-менеджмент</>} size="small">
            <Row gutter={[8, 8]}>
              <Col span={8}>
                <Text type="secondary">Макс. риск на сделку %</Text>
                <InputNumber min={0.01} max={0.2} step={0.01} value={config.risk.maxRiskPerTrade}
                  size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, risk: { ...c.risk, maxRiskPerTrade: v ?? 0.05 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={8}>
                <Text type="secondary">Макс. дневной убыток %</Text>
                <InputNumber min={0.05} max={0.5} step={0.05} value={config.risk.maxDailyLoss}
                  size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, risk: { ...c.risk, maxDailyLoss: v ?? 0.2 } }))}
                  disabled={isRunning} />
              </Col>
              <Col span={8}>
                <Text type="secondary">Rescale порог %</Text>
                <InputNumber min={0.1} max={1} step={0.05} value={config.risk.rescaleThreshold}
                  size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, risk: { ...c.risk, rescaleThreshold: v ?? 0.25 } }))}
                  disabled={isRunning} />
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="Подключение" size="small">
            <Row gutter={[8, 8]}>
              <Col span={12}>
                <Text type="secondary">API ключ (биржа)</Text>
                <Select
                  value={apiKeys.some(k => k.name === config.apiKeyName) ? config.apiKeyName : undefined}
                  style={{ width: '100%' }}
                  onChange={v => {
                    const key = apiKeys.find(k => k.name === v);
                    setConfig(c => ({ ...c, apiKeyName: v, exchange: key?.exchange?.toLowerCase() || c.exchange }));
                  }}
                  disabled={isRunning}
                  options={apiKeys.map(k => ({ value: k.name, label: `${k.name} (${k.exchange})` }))}
                  showSearch
                  placeholder="— Выберите API ключ —"
                  notFoundContent="Нет ключей. Добавьте в Настройках."
                />
              </Col>
              <Col span={6}>
                <Text type="secondary">Биржа</Text>
                <Input value={(config.exchange || '').toUpperCase()} size="small" readOnly
                  style={{ background: '#1a1a2e' }} />
              </Col>
              <Col span={6}>
                <Text type="secondary">Стартовый баланс</Text>
                <InputNumber min={1} value={config.startBalance} size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, startBalance: v ?? 40 }))}
                  disabled={isRunning} />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      {/* Save Config Button */}
      <Row style={{ marginBottom: 16 }}>
        <Col span={24} style={{ textAlign: 'right' }}>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveConfig} size="large">
            Сохранить настройки
          </Button>
        </Col>
      </Row>

      {/* Trade History */}
      <Card title="Журнал сделок" size="small">
        <Table
          dataSource={trades}
          columns={tradeColumns}
          rowKey="id"
          pagination={{ pageSize: 20, size: 'small' }}
          size="small"
          scroll={{ x: 800 }}
        />
      </Card>
    </div>
  );
}

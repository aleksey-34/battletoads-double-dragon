import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Card, Row, Col, Statistic, Button, Space, Switch, Tag, Table, InputNumber,
  Select, Input, Divider, Typography, Alert, Tooltip, Progress, Badge, message,
  Segmented, Popconfirm,
} from 'antd';
import {
  PlayCircleOutlined, PauseCircleOutlined, StopOutlined,
  ThunderboltOutlined, RocketOutlined, DollarOutlined,
  ReloadOutlined, SettingOutlined, SaveOutlined, ControlOutlined,
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

const PRESET_CONFIGS = {
  low:  { label: 'Low',  color: 'green',  momentum: { leverage: 10, allocation: 0.20, stopLossPercent: 0.50, trailingTpPercent: 0.60, maxConcurrentPositions: 2, atrFilterMin: 0.002,  volumeMultiplier: 1.8 }, risk: { maxDailyLoss: 0.08, maxRiskPerTrade: 0.03 } },
  mid:  { label: 'Mid',  color: 'orange', momentum: { leverage: 15, allocation: 0.22, stopLossPercent: 0.40, trailingTpPercent: 0.50, maxConcurrentPositions: 2, atrFilterMin: 0.0018, volumeMultiplier: 1.6 }, risk: { maxDailyLoss: 0.10, maxRiskPerTrade: 0.04 } },
  high: { label: 'High', color: 'red',    momentum: { leverage: 20, allocation: 0.25, stopLossPercent: 0.30, trailingTpPercent: 0.45, maxConcurrentPositions: 2, atrFilterMin: 0.0015, volumeMultiplier: 1.5 }, risk: { maxDailyLoss: 0.10, maxRiskPerTrade: 0.05 } },
} as const;
type PresetMode = keyof typeof PRESET_CONFIGS;

const DEFAULT_CONFIG = {
  exchange: 'mexc',
  apiKeyName: 'BTDD_MEX_1',
  apiKeys: [{ name: 'BTDD_MEX_1', exchange: 'mexc', enabled: true, startBalancePct: 0.9, label: 'MEXC Main' }] as Array<{ name: string; exchange: string; enabled: boolean; startBalancePct: number; label?: string }>,
  startBalance: 40,
  startBalancePct: 0,
  presetMode: 'high' as PresetMode,
  momentum: {
    enabled: true, allocation: 0.25, leverage: 20, marginType: 'isolated' as const,
    donchianPeriod: 5, volumeMultiplier: 1.5, trailingTpPercent: 0.45,
    stopLossPercent: 0.30, maxPositionTimeSec: 900, tickIntervalSec: 5,
    maxConcurrentPositions: 2, atrFilterMin: 0.0015,
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
    maxRiskPerTrade: 0.05, maxDailyLoss: 0.10,
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
  const [keyBalances, setKeyBalances] = useState<Array<{ name: string; exchange: string; label?: string; enabled: boolean; balance: number; equity: number }>>([]);

  const fetchKeyBalances = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/key-balances`);
      setKeyBalances(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
  }, []);

  const applyPreset = useCallback((mode: PresetMode) => {
    const p = PRESET_CONFIGS[mode];
    setConfig(c => ({
      ...c,
      presetMode: mode,
      momentum: { ...c.momentum, ...p.momentum },
      risk: { ...c.risk, ...p.risk },
    }));
  }, []);

  const handleKeyToggle = async (keyName: string, enabled: boolean) => {
    try {
      await axios.post(`${API}/key-toggle`, { name: keyName, enabled });
      setConfig(c => ({ ...c, apiKeys: (c.apiKeys ?? []).map(k => k.name === keyName ? { ...k, enabled } : k) }));
      message.success(`Ключ ${keyName} ${enabled ? 'включён' : 'выключён'}`);
    } catch (e: any) {
      message.error(e.response?.data?.error || 'Ошибка');
    }
  };
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
      if (res.data && typeof res.data === 'object') {
        setConfig(c => ({ ...c, ...res.data }));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchConfig();
    fetchKeyBalances();
    axios.get('/api/api-keys').then(r => {
      const keys = Array.isArray(r.data) ? r.data as ApiKeyRecord[] : [];
      setApiKeys(keys);
    }).catch(err => console.error('Failed to load API keys:', err));
    pollRef.current = setInterval(fetchStatus, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus, fetchConfig]);

  // Sync presetMode from loaded config
  useEffect(() => {
    if (config.presetMode && PRESET_CONFIGS[config.presetMode as PresetMode]) {
      // config already loaded with preset values, no override needed
    }
  }, [config.presetMode]);

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
        <Col xs={24} lg={12}>          <Card title={<><ControlOutlined /> Подключение & Режим</>} size="small">
            {/* Preset Switcher */}
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>Режим риска</Text>
              <Segmented
                value={config.presetMode ?? 'high'}
                onChange={v => applyPreset(v as PresetMode)}
                disabled={isRunning}
                options={[
                  { label: <Tag color="green">○ Low</Tag>, value: 'low' },
                  { label: <Tag color="orange">● Mid</Tag>, value: 'mid' },
                  { label: <Tag color="red">⚡ High</Tag>, value: 'high' },
                ]}
                style={{ width: '100%' }}
              />
            </div>
            {/* API Keys */}
            <div style={{ marginBottom: 8 }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Text type="secondary">Ключи API</Text>
                <Button size="small" icon={<ReloadOutlined />} onClick={fetchKeyBalances}>Балансы</Button>
              </Space>
            </div>
            {(config.apiKeys ?? []).map(k => (
              <div key={k.name} style={{ marginBottom: 6, padding: '6px 8px', background: '#1a1a2e', borderRadius: 6 }}>
                <Row align="middle" gutter={8}>
                  <Col flex="auto">
                    <Text strong style={{ fontSize: 12 }}>{k.label ?? k.name}</Text>
                    <Tag color="blue" style={{ marginLeft: 4, fontSize: 10 }}>{k.exchange.toUpperCase()}</Tag>
                    {keyBalances.find(b => b.name === k.name) && (
                      <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                        ${keyBalances.find(b => b.name === k.name)?.equity.toFixed(2)}
                      </Text>
                    )}
                  </Col>
                  <Col>
                    <Text type="secondary" style={{ fontSize: 10, marginRight: 4 }}>
                      {Math.round((k.startBalancePct ?? 0.9) * 100)}%
                    </Text>
                    {k.enabled ? (
                      <Popconfirm
                        title="Выключить ключ?"
                        description="Закрыть позиции и отменить ордера?"
                        onConfirm={() => handleKeyToggle(k.name, false)}
                        okText="Да, выключить" cancelText="Отмена"
                      >
                        <Switch size="small" checked={true} />
                      </Popconfirm>
                    ) : (
                      <Switch size="small" checked={false} onChange={v => v && handleKeyToggle(k.name, true)} />
                    )}
                  </Col>
                </Row>
              </div>
            ))}
            {/* Add new key */}
            <Select
              style={{ width: '100%', marginTop: 8 }}
              placeholder="+ Добавить API ключ"
              size="small"
              value={undefined}
              onChange={(v: string) => {
                const key = apiKeys.find(k => k.name === v);
                if (!key) return;
                const already = (config.apiKeys ?? []).some(k => k.name === v);
                if (already) { message.info('Ключ уже добавлен'); return; }
                setConfig(c => ({
                  ...c,
                  apiKeyName: c.apiKeyName || v,
                  apiKeys: [...(c.apiKeys ?? []), { name: v, exchange: key.exchange?.toLowerCase() || 'mexc', enabled: true, startBalancePct: 0.9, label: `${key.exchange?.toUpperCase()} ${v}` }],
                }));
              }}
              options={apiKeys.filter(k => !(config.apiKeys ?? []).some(ck => ck.name === k.name)).map(k => ({ value: k.name, label: `${k.name} (${k.exchange})` }))}
              disabled={isRunning}
              showSearch
              notFoundContent="Нет ключей. Добавьте в Настройках."
            />
            <Row gutter={8} style={{ marginTop: 8 }}>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 11 }}>Старт. бал. % (от аккаунта)</Text>
                <InputNumber
                  min={0} max={100} step={5}
                  value={Math.round((config.startBalancePct ?? 0) * 100)}
                  size="small" style={{ width: '100%' }}
                  formatter={v => `${v}%`}
                  parser={v => Number((v ?? '0').replace('%', ''))}
                  onChange={v => setConfig(c => ({ ...c, startBalancePct: (v ?? 0) / 100 }))}
                  disabled={isRunning}
                />
              </Col>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 11 }}>Старт. бал. USDT (если % = 0)</Text>
                <InputNumber
                  min={1} value={config.startBalance}
                  size="small" style={{ width: '100%' }}
                  onChange={v => setConfig(c => ({ ...c, startBalance: v ?? 40 }))}
                  disabled={isRunning || (config.startBalancePct ?? 0) > 0}
                />
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

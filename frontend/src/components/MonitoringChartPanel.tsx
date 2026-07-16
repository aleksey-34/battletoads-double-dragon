import React, { useMemo, useState } from 'react';
import { Button, Checkbox, Segmented, Space, Table, Tag, Typography } from 'antd';
import ChartComponent from './ChartComponent';

export type MonitoringSnapshot = {
  recorded_at?: string;
  equity_usd?: number;
  unrealized_pnl?: number;
  drawdown_percent?: number;
  deposit_base_usd?: number | null;
  pnl_net_usd?: number | null;
};

export type MonitoringTradeMarker = {
  time: number;
  tradeType: 'entry' | 'exit';
  side: 'long' | 'short';
  symbol: string;
};

export type MonitoringPeriodStats = {
  returnPercent: number;
  pnlUsd: number;
  startEquityUsd: number;
  endEquityUsd: number;
  startAt: string | null;
  endAt: string | null;
  pointCount: number;
};

export type MonitoringTradeRow = {
  id: number;
  tradeType: 'entry' | 'exit';
  side: 'long' | 'short';
  symbol: string;
  price: number;
  size: number;
  fee: number | null;
  time: string;
  strategyId: number | null;
};

type LinePoint = { time: number; value: number };

type SeriesKey = 'equity' | 'pnl' | 'upnl' | 'dd';

/** 0 = весь период счёта */
export type ChartPeriodDays = 0 | 1 | 7 | 30 | 90;

const SERIES_META: Record<SeriesKey, { label: string; color: string }> = {
  equity: { label: 'Equity', color: '#2563eb' },
  pnl: { label: 'PnL net', color: '#16a34a' },
  upnl: { label: 'UPNL', color: '#7c3aed' },
  dd: { label: 'DD %', color: '#d97706' },
};

const PERIOD_OPTIONS: Array<{ label: string; value: ChartPeriodDays }> = [
  { label: '1д', value: 1 },
  { label: '7д', value: 7 },
  { label: '30д', value: 30 },
  { label: '90д', value: 90 },
  { label: 'Всё', value: 0 },
];

const fmt = (v: unknown, d = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '—';
};

const fmtSignedUsd = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
};

const fmtSignedPct = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
};

const snapshotToPoints = (
  rows: MonitoringSnapshot[],
  pick: (row: MonitoringSnapshot) => number | null,
): LinePoint[] => rows.map((row) => {
  const t = row.recorded_at ? new Date(row.recorded_at).getTime() / 1000 : 0;
  const v = pick(row);
  return Number.isFinite(t) && t > 0 && v != null && Number.isFinite(v)
    ? { time: Math.floor(t), value: v }
    : null;
}).filter((x): x is LinePoint => x !== null);

const normalizeSeries = (points: LinePoint[]): LinePoint[] => {
  if (points.length === 0) return [];
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  if (!Number.isFinite(span) || span <= 1e-9) {
    return points.map((p) => ({ time: p.time, value: 50 }));
  }
  return points.map((p) => ({
    time: p.time,
    value: ((p.value - min) / span) * 100,
  }));
};

const toReturnPercentSeries = (points: LinePoint[]): LinePoint[] => {
  if (points.length === 0) return [];
  const base = points[0].value;
  if (!Number.isFinite(base) || base <= 0) return points;
  return points.map((p) => ({
    time: p.time,
    value: ((p.value - base) / base) * 100,
  }));
};

type MonitoringChartPanelProps = {
  snapshots: MonitoringSnapshot[];
  chartDays: ChartPeriodDays;
  onChartDaysChange: (days: ChartPeriodDays) => void;
  periodStats?: MonitoringPeriodStats | null;
  trades?: MonitoringTradeRow[];
  trades24h?: number;
  lastTradeAt?: string | null;
  tradeMarkers?: MonitoringTradeMarker[];
  loading?: boolean;
  currencyLabel?: string;
};

const MonitoringChartPanel: React.FC<MonitoringChartPanelProps> = ({
  snapshots,
  chartDays,
  onChartDaysChange,
  periodStats = null,
  trades = [],
  trades24h = 0,
  lastTradeAt = null,
  tradeMarkers: _tradeMarkers = [],
  loading = false,
  currencyLabel = 'USD',
}) => {
  const [showEquity, setShowEquity] = useState(true);
  const [showPnl, setShowPnl] = useState(false);
  const [showUpnl, setShowUpnl] = useState(false);
  const [showDd, setShowDd] = useState(false);
  const [independentScale, setIndependentScale] = useState(false);
  const [equityAsReturn, setEquityAsReturn] = useState(true);

  const seriesRaw = useMemo(() => ({
    equity: snapshotToPoints(snapshots, (r) => Number(r.equity_usd)),
    pnl: snapshotToPoints(snapshots, (r) => {
      const direct = r.pnl_net_usd;
      if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
      return Number(r.equity_usd || 0) - Number(r.unrealized_pnl || 0) - Number(r.deposit_base_usd || 0);
    }),
    upnl: snapshotToPoints(snapshots, (r) => Number(r.unrealized_pnl)),
    dd: snapshotToPoints(snapshots, (r) => Number(r.drawdown_percent)),
  }), [snapshots]);

  const visibleKeys = useMemo(() => {
    const keys: SeriesKey[] = [];
    if (showEquity) keys.push('equity');
    if (showPnl) keys.push('pnl');
    if (showUpnl) keys.push('upnl');
    if (showDd) keys.push('dd');
    return keys;
  }, [showDd, showEquity, showPnl, showUpnl]);

  const useNormalized = independentScale && visibleKeys.length > 1;

  const transformSeries = (key: SeriesKey, raw: LinePoint[]): LinePoint[] => {
    if (key === 'equity' && equityAsReturn && !useNormalized) {
      return toReturnPercentSeries(raw);
    }
    return useNormalized ? normalizeSeries(raw) : raw;
  };

  const primarySeries = useMemo(() => {
    const key = visibleKeys[0];
    if (!key) return [] as LinePoint[];
    return transformSeries(key, seriesRaw[key]);
  }, [equityAsReturn, seriesRaw, useNormalized, visibleKeys]);

  const overlayLines = useMemo(() => visibleKeys.slice(1).map((key) => {
    const raw = seriesRaw[key];
    const data = transformSeries(key, raw);
    return {
      id: key,
      color: SERIES_META[key].color,
      lineWidth: key === 'dd' ? 1 : 2,
      priceScaleId: key === 'dd' ? 'left' as const : undefined,
      data,
    };
  }), [equityAsReturn, seriesRaw, useNormalized, visibleKeys]);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const allSelected = showEquity && showPnl && showUpnl && showDd;
  const noneSelected = !showEquity && !showPnl && !showUpnl && !showDd;

  const localPeriodStats = useMemo(() => {
    if (periodStats) return periodStats;
    if (snapshots.length < 2) return null;
    const startEquity = Number(snapshots[0]?.equity_usd);
    const endEquity = Number(snapshots[snapshots.length - 1]?.equity_usd);
    if (!Number.isFinite(startEquity) || startEquity <= 0 || !Number.isFinite(endEquity)) {
      return null;
    }
    return {
      returnPercent: ((endEquity - startEquity) / startEquity) * 100,
      pnlUsd: endEquity - startEquity,
      startEquityUsd: startEquity,
      endEquityUsd: endEquity,
      startAt: snapshots[0]?.recorded_at || null,
      endAt: snapshots[snapshots.length - 1]?.recorded_at || null,
      pointCount: snapshots.length,
    };
  }, [periodStats, snapshots]);

  const toggleAll = () => {
    const next = !allSelected;
    setShowEquity(next);
    setShowPnl(next);
    setShowUpnl(next);
    setShowDd(next);
  };

  const onlyOne = (key: SeriesKey) => {
    setShowEquity(key === 'equity');
    setShowPnl(key === 'pnl');
    setShowUpnl(key === 'upnl');
    setShowDd(key === 'dd');
  };

  const tradeColumns = [
    {
      title: 'Время',
      dataIndex: 'time',
      width: 140,
      render: (v: string) => (v ? new Date(v).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      }) : '—'),
    },
    {
      title: 'Тип',
      dataIndex: 'tradeType',
      width: 70,
      render: (v: string) => (
        <Tag color={v === 'entry' ? 'blue' : 'orange'}>{v === 'entry' ? 'IN' : 'OUT'}</Tag>
      ),
    },
    {
      title: 'Сторона',
      dataIndex: 'side',
      width: 70,
      render: (v: string) => (
        <span style={{ color: v === 'long' ? '#16a34a' : '#dc2626' }}>{v}</span>
      ),
    },
    { title: 'Символ', dataIndex: 'symbol', width: 90 },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap size={[8, 8]}>
          <Typography.Text strong style={{ fontSize: 16 }}>
            Сделок за 24ч: {trades24h}
          </Typography.Text>
          <Typography.Text type="secondary">
            Последняя: {lastTradeAt
              ? new Date(lastTradeAt).toLocaleString('ru-RU')
              : 'нет'}
          </Typography.Text>
        </Space>
        <Segmented
          options={PERIOD_OPTIONS}
          value={chartDays}
          onChange={(v) => onChartDaysChange(Number(v) as ChartPeriodDays)}
        />
      </Space>

      {localPeriodStats ? (
        <Space wrap size={[12, 8]} style={{
          padding: '10px 14px',
          background: 'rgba(148, 163, 184, 0.08)',
          borderRadius: 8,
          border: '1px solid rgba(148, 163, 184, 0.18)',
          width: '100%',
        }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Доходность за период
            {chartDays === 0 ? ' (всё время)' : ` · ${chartDays}д`}
          </Typography.Text>
          <Tag
            color={localPeriodStats.returnPercent >= 0 ? 'green' : 'red'}
            style={{ fontSize: 14, padding: '2px 10px' }}
          >
            {fmtSignedPct(localPeriodStats.returnPercent)}
          </Tag>
          <Tag
            color={localPeriodStats.pnlUsd >= 0 ? 'green' : 'red'}
            style={{ fontSize: 14, padding: '2px 10px' }}
          >
            {fmtSignedUsd(localPeriodStats.pnlUsd)}
            {' · '}
            {currencyLabel}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {localPeriodStats.startAt
              ? new Date(localPeriodStats.startAt).toLocaleDateString('ru-RU')
              : '—'}
            {' → '}
            {localPeriodStats.endAt
              ? new Date(localPeriodStats.endAt).toLocaleDateString('ru-RU')
              : '—'}
            {' · '}
            {localPeriodStats.pointCount}
            {' снимков'}
          </Typography.Text>
        </Space>
      ) : null}

      {latest ? (
        <Space wrap>
          <Tag color="blue">Equity ${fmt(latest.equity_usd)}</Tag>
          <Tag color="purple">UPNL ${fmt(latest.unrealized_pnl)}</Tag>
          <Tag color={Number(latest.pnl_net_usd ?? 0) >= 0 ? 'green' : 'red'}>
            PnL ${fmt(latest.pnl_net_usd)}
          </Tag>
          <Tag color="orange">DD {fmt(latest.drawdown_percent)}%</Tag>
        </Space>
      ) : null}

      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <Button size="small" onClick={toggleAll}>
            {allSelected ? 'Снять все' : 'Все линии'}
          </Button>
          {(Object.keys(SERIES_META) as SeriesKey[]).map((key) => (
            <Checkbox
              key={key}
              checked={key === 'equity' ? showEquity : key === 'pnl' ? showPnl : key === 'upnl' ? showUpnl : showDd}
              onChange={(e) => {
                const checked = e.target.checked;
                if (key === 'equity') setShowEquity(checked);
                if (key === 'pnl') setShowPnl(checked);
                if (key === 'upnl') setShowUpnl(checked);
                if (key === 'dd') setShowDd(checked);
              }}
            >
              <span style={{ color: SERIES_META[key].color }}>●</span>
              {' '}
              {SERIES_META[key].label}
            </Checkbox>
          ))}
        </Space>
        <Space wrap>
          {(Object.keys(SERIES_META) as SeriesKey[]).map((key) => (
            <Button key={`solo-${key}`} size="small" type="link" onClick={() => onlyOne(key)}>
              только {SERIES_META[key].label}
            </Button>
          ))}
        </Space>
      </Space>

      <Space wrap>
        <Checkbox
          checked={equityAsReturn}
          onChange={(e) => setEquityAsReturn(e.target.checked)}
        >
          Equity как % доходности за период
        </Checkbox>
        <Checkbox checked={independentScale} onChange={(e) => setIndependentScale(e.target.checked)}>
          Свой масштаб для каждой линии (0–100% диапазона)
        </Checkbox>
      </Space>
      {useNormalized ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          При нескольких линиях каждая растягивается на свой min–max за период. Абсолютные значения — в тегах выше.
        </Typography.Text>
      ) : equityAsReturn && showEquity ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Ось Y: изменение equity от начала периода, %. Абсолютный баланс — в тегах.
        </Typography.Text>
      ) : null}

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Загрузка…</div>
      ) : noneSelected ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Выберите хотя бы одну линию</div>
      ) : primarySeries.length > 0 ? (
        <ChartComponent
          data={primarySeries}
          type="line"
          overlayLines={overlayLines}
        />
      ) : (
        <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Нет снимков мониторинга</div>
      )}

      {trades.length > 0 ? (
        <div>
          <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
            Сделки за период ({trades.length}
            {trades.length >= 200 ? ', показаны последние 200' : ''}
            )
          </Typography.Text>
          <Table
            size="small"
            rowKey="id"
            pagination={{ pageSize: 10, size: 'small' }}
            dataSource={trades}
            columns={tradeColumns}
            scroll={{ x: 420 }}
          />
        </div>
      ) : null}
    </Space>
  );
};

export default MonitoringChartPanel;

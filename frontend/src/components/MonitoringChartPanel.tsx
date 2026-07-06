import React, { useMemo, useState } from 'react';
import { Button, Checkbox, Segmented, Space, Tag, Typography } from 'antd';
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

type LinePoint = { time: number; value: number };

type SeriesKey = 'equity' | 'pnl' | 'upnl' | 'dd';

const SERIES_META: Record<SeriesKey, { label: string; color: string }> = {
  equity: { label: 'Equity', color: '#2563eb' },
  pnl: { label: 'PnL net', color: '#16a34a' },
  upnl: { label: 'UPNL', color: '#7c3aed' },
  dd: { label: 'DD %', color: '#d97706' },
};

const fmt = (v: unknown, d = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '—';
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

type MonitoringChartPanelProps = {
  snapshots: MonitoringSnapshot[];
  chartDays: number;
  onChartDaysChange: (days: number) => void;
  trades24h?: number;
  lastTradeAt?: string | null;
  tradeMarkers?: MonitoringTradeMarker[];
  loading?: boolean;
};

const MonitoringChartPanel: React.FC<MonitoringChartPanelProps> = ({
  snapshots,
  chartDays,
  onChartDaysChange,
  trades24h = 0,
  lastTradeAt = null,
  tradeMarkers: _tradeMarkers = [],
  loading = false,
}) => {
  const [showEquity, setShowEquity] = useState(true);
  const [showPnl, setShowPnl] = useState(false);
  const [showUpnl, setShowUpnl] = useState(false);
  const [showDd, setShowDd] = useState(false);
  const [independentScale, setIndependentScale] = useState(false);

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

  const primarySeries = useMemo(() => {
    const key = visibleKeys[0];
    if (!key) return [] as LinePoint[];
    const raw = seriesRaw[key];
    return useNormalized ? normalizeSeries(raw) : raw;
  }, [seriesRaw, useNormalized, visibleKeys]);

  const overlayLines = useMemo(() => visibleKeys.slice(1).map((key) => {
    const raw = seriesRaw[key];
    const data = useNormalized ? normalizeSeries(raw) : raw;
    return {
      id: key,
      color: SERIES_META[key].color,
      lineWidth: key === 'dd' ? 1 : 2,
      data,
    };
  }), [seriesRaw, useNormalized, visibleKeys]);

  // Trade markers on chart: disabled for now — list view + DB restore planned (see docs/MONITORING_CHART_ROADMAP.md).
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const allSelected = showEquity && showPnl && showUpnl && showDd;
  const noneSelected = !showEquity && !showPnl && !showUpnl && !showDd;

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
          options={[
            { label: '1д', value: 1 },
            { label: '7д', value: 7 },
            { label: '30д', value: 30 },
          ]}
          value={chartDays}
          onChange={(v) => onChartDaysChange(Number(v))}
        />
      </Space>

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

      <Checkbox checked={independentScale} onChange={(e) => setIndependentScale(e.target.checked)}>
        Свой масштаб для каждой линии (0–100% диапазона периода)
      </Checkbox>
      {useNormalized ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          При нескольких линиях каждая растягивается на свой min–max за период. Абсолютные значения — в тегах выше.
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
    </Space>
  );
};

export default MonitoringChartPanel;

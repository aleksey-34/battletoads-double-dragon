import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Segmented, Space, Table, Tag, Typography, message } from 'antd';
import axios from 'axios';
import ChartComponent from './ChartComponent';
import MonitoringSymbolChartModal from './MonitoringSymbolChartModal';
import {
  DisplayMonitoringTradeRow,
  EnrichedMonitoringTradeRow,
  MonitoringTradeGroupMode,
  buildSynthStrategyMap,
  collapseSynthTradeLegs,
  enrichMonitoringTrades,
  SynthStrategyMeta,
  flowTypeLabel,
  groupMonitoringTrades,
  pnlBucketLabel,
} from '../utils/monitoringTradeEnrichment';
import type { StrategyChartStrategy } from '../utils/strategyChartOverlays';

export type MonitoringSnapshot = {
  recorded_at?: string;
  equity_usd?: number;
  unrealized_pnl?: number;
  drawdown_percent?: number;
  deposit_base_usd?: number | null;
  pnl_net_usd?: number | null;
  margin_load_percent?: number | null;
  exchange?: string | null;
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
  /** Original entry price stored on exit rows (live_trade_events.entry_price). */
  entryPrice?: number | null;
};

export type MonitoringTradeFrequencyPoint = {
  time: number;
  count: number;
  bucket?: 'hour' | 'day';
};

type LinePoint = { time: number; value: number };

type SeriesKey = 'equity' | 'pnl' | 'upnl' | 'dd' | 'freq';

/** 0 = весь период счёта */
export type ChartPeriodDays = 0 | 1 | 7 | 30 | 90;

const SERIES_META: Record<SeriesKey, { label: string; color: string }> = {
  equity: { label: 'Equity', color: '#2563eb' },
  pnl: { label: 'PnL net', color: '#16a34a' },
  upnl: { label: 'UPNL', color: '#7c3aed' },
  dd: { label: 'DD %', color: '#d97706' },
  freq: { label: 'Частота сделок', color: '#0891b2' },
};

const PERIOD_OPTIONS: Array<{ label: string; value: ChartPeriodDays }> = [
  { label: '1д', value: 1 },
  { label: '7д', value: 7 },
  { label: '30д', value: 30 },
  { label: '90д', value: 90 },
  { label: 'Всё (БД)', value: 0 },
];

const downloadCsv = (filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) => {
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const body = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n');
  const blob = new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

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

const toReturnPercentSeries = (points: LinePoint[]): LinePoint[] => {
  if (points.length === 0) return [];
  const base = points[0].value;
  if (!Number.isFinite(base) || base <= 0) return points;
  return points.map((p) => ({
    time: p.time,
    value: ((p.value - base) / base) * 100,
  }));
};

const buildFrequencyFromTrades = (
  rows: MonitoringTradeRow[],
  chartDays: ChartPeriodDays,
): LinePoint[] => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const hourly = chartDays === 1;
  const bucketSec = hourly ? 3600 : 86_400;
  const counts = new Map<number, number>();
  for (const row of rows) {
    const ms = Date.parse(String(row.time || ''));
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const bucket = Math.floor(ms / 1000 / bucketSec) * bucketSec;
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([time, value]) => ({ time, value }))
    .sort((a, b) => a.time - b.time);
};

type MonitoringChartPanelProps = {
  snapshots: MonitoringSnapshot[];
  chartDays: ChartPeriodDays;
  onChartDaysChange: (days: ChartPeriodDays) => void;
  periodStats?: MonitoringPeriodStats | null;
  trades?: MonitoringTradeRow[];
  tradeFrequency?: MonitoringTradeFrequencyPoint[];
  trades24h?: number;
  lastTradeAt?: string | null;
  tradeMarkers?: MonitoringTradeMarker[];
  loading?: boolean;
  currencyLabel?: string;
  apiKeyName?: string;
  /** On-demand: pull equity history from the exchange (Bybit). */
  onBackfillFromExchange?: () => void | Promise<void>;
  backfillLoading?: boolean;
  backfillSupported?: boolean;
};

const MonitoringChartPanel: React.FC<MonitoringChartPanelProps> = ({
  snapshots,
  chartDays,
  onChartDaysChange,
  periodStats = null,
  trades = [],
  tradeFrequency = [],
  trades24h = 0,
  lastTradeAt = null,
  tradeMarkers: _tradeMarkers = [],
  loading = false,
  currencyLabel = 'USD',
  apiKeyName = '',
  onBackfillFromExchange,
  backfillLoading = false,
  backfillSupported = true,
}) => {
  const [showEquity, setShowEquity] = useState(true);
  const [showPnl, setShowPnl] = useState(false);
  const [showUpnl, setShowUpnl] = useState(false);
  const [showDd, setShowDd] = useState(false);
  const [showFreq, setShowFreq] = useState(false);
  const [equityAsReturn, setEquityAsReturn] = useState(true);
  const [tradeGroupMode, setTradeGroupMode] = useState<MonitoringTradeGroupMode>('none');
  const [groupSynthLegs, setGroupSynthLegs] = useState(true);
  const [showStrategyCol, setShowStrategyCol] = useState(true);
  const [synthById, setSynthById] = useState(() => new Map<number, SynthStrategyMeta>());
  const [strategiesById, setStrategiesById] = useState(() => new Map<number, StrategyChartStrategy>());
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartStrategyId, setChartStrategyId] = useState<number | null>(null);

  useEffect(() => {
    if (!apiKeyName) {
      setSynthById(new Map());
      setStrategiesById(new Map());
      return;
    }
    let cancelled = false;
    void axios.get<unknown[]>(`/api/strategies/${encodeURIComponent(apiKeyName)}`, { timeout: 60_000 })
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res.data) ? res.data : [];
        const map = buildSynthStrategyMap(rows as Array<Record<string, unknown>>);
        setSynthById(map);
        const byId = new Map<number, StrategyChartStrategy>();
        for (const raw of rows as Array<Record<string, unknown>>) {
          const id = Number(raw.id);
          if (!Number.isFinite(id) || id <= 0) continue;
          byId.set(id, {
            id,
            name: String(raw.name || `strategy-${id}`),
            market_mode: String(raw.market_mode || 'mono') === 'synthetic' ? 'synthetic' : 'mono',
            base_symbol: String(raw.base_symbol || ''),
            quote_symbol: String(raw.quote_symbol || ''),
            interval: String(raw.interval || '4h'),
            base_coef: Number(raw.base_coef) || 1,
            quote_coef: Number(raw.quote_coef) || 1,
            price_channel_length: Number(raw.price_channel_length) || 20,
            detection_source: String(raw.detection_source || 'wick') === 'close' ? 'close' : 'wick',
            take_profit_percent: Number(raw.take_profit_percent) || 0,
            state: String(raw.state || 'flat'),
            entry_ratio: raw.entry_ratio == null ? null : Number(raw.entry_ratio),
            last_signal: raw.last_signal != null ? String(raw.last_signal) : null,
            strategy_type: String(raw.strategy_type || ''),
          });
        }
        setStrategiesById(byId);
        if (map.size > 0 || byId.size > 0) {
          setGroupSynthLegs(true);
          setShowStrategyCol(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSynthById(new Map());
          setStrategiesById(new Map());
        }
      });
    return () => { cancelled = true; };
  }, [apiKeyName]);

  const enrichedTrades = useMemo(() => enrichMonitoringTrades(trades), [trades]);
  const displayTrades = useMemo(
    () => collapseSynthTradeLegs(enrichedTrades, synthById, groupSynthLegs),
    [enrichedTrades, groupSynthLegs, synthById],
  );
  const tradeGroups = useMemo(
    () => groupMonitoringTrades(displayTrades, tradeGroupMode),
    [displayTrades, tradeGroupMode],
  );

  const chartSymbolTrades = useMemo(() => {
    if (!chartSymbol && !chartStrategyId) return [];
    if (chartStrategyId) {
      return enrichedTrades.filter((t) => Number(t.strategyId || 0) === chartStrategyId);
    }
    return enrichedTrades.filter((t) => String(t.symbol).toUpperCase() === chartSymbol);
  }, [chartStrategyId, chartSymbol, enrichedTrades]);

  const openTradeChart = (row: DisplayMonitoringTradeRow) => {
    const strategyId = Number(row.strategyId || 0) || null;
    setChartStrategyId(strategyId);
    if (row.synthGrouped && row.synthPairLabel) {
      setChartSymbol(row.synthPairLabel);
      return;
    }
    setChartSymbol(String(row.symbol || '').toUpperCase());
  };

  const freqPoints = useMemo(() => {
    const fromApi = (Array.isArray(tradeFrequency) ? tradeFrequency : [])
      .map((row) => {
        const time = Math.floor(Number(row.time) || 0);
        const value = Number(row.count);
        if (time <= 0 || !Number.isFinite(value)) return null;
        return { time, value };
      })
      .filter((row): row is LinePoint => row !== null);
    if (fromApi.length > 0) return fromApi;
    return buildFrequencyFromTrades(trades, chartDays);
  }, [chartDays, tradeFrequency, trades]);

  const freqBucketLabel = tradeFrequency[0]?.bucket === 'hour' || chartDays === 1
    ? 'час'
    : 'день';

  const coverageHint = useMemo(() => {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      return chartDays === 0
        ? 'В БД пока нет снимков. Нажмите «С биржи (весь период)» — подтянем историю с Bybit по запросу.'
        : null;
    }
    const first = String(snapshots[0]?.recorded_at || '').trim();
    const last = String(snapshots[snapshots.length - 1]?.recorded_at || '').trim();
    if (chartDays !== 0) return null;
    return `Сейчас в графике: ${first || '—'} → ${last || '—'} · ${snapshots.length} точек. Кнопка «С биржи» догружает историю с биржи до первого live-снимка.`;
  }, [chartDays, snapshots]);

  const handleDownloadCsv = () => {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      message.warning('Нет снимков для выгрузки');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadCsv(
      `monitoring-snapshots-${stamp}.csv`,
      ['recorded_at', 'equity_usd', 'unrealized_pnl', 'pnl_net_usd', 'drawdown_percent', 'margin_load_percent', 'exchange'],
      snapshots.map((row) => [
        row.recorded_at,
        row.equity_usd,
        row.unrealized_pnl,
        row.pnl_net_usd,
        row.drawdown_percent,
        row.margin_load_percent,
        row.exchange,
      ]),
    );
    if (trades.length > 0) {
      downloadCsv(
        `monitoring-trades-${stamp}.csv`,
        ['time', 'flowType', 'tradeType', 'side', 'symbol', 'price', 'size', 'pnlPercent', 'fee', 'strategyId'],
        enrichedTrades.map((row) => [
          row.time,
          row.flowType,
          row.tradeType,
          row.side,
          row.symbol,
          row.price,
          row.size,
          row.pnlPercent,
          row.fee,
          row.strategyId,
        ]),
      );
    }
    message.success(trades.length > 0 ? 'Скачаны CSV: снимки + сделки' : 'Скачан CSV со снимками');
  };

  const freqSummary = useMemo(() => {
    if (freqPoints.length === 0) return null;
    const nonzero = freqPoints.filter((p) => p.value > 0);
    const base = nonzero.length > 0 ? nonzero : freqPoints;
    const total = freqPoints.reduce((sum, p) => sum + p.value, 0);
    const avg = base.reduce((sum, p) => sum + p.value, 0) / base.length;
    const peak = Math.max(...freqPoints.map((p) => p.value));
    return { total, avg, peak, buckets: freqPoints.length };
  }, [freqPoints]);

  const seriesRaw = useMemo(() => ({
    equity: snapshotToPoints(snapshots, (r) => Number(r.equity_usd)),
    pnl: snapshotToPoints(snapshots, (r) => {
      const direct = r.pnl_net_usd;
      if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
      return Number(r.equity_usd || 0) - Number(r.unrealized_pnl || 0) - Number(r.deposit_base_usd || 0);
    }),
    upnl: snapshotToPoints(snapshots, (r) => Number(r.unrealized_pnl)),
    dd: snapshotToPoints(snapshots, (r) => Number(r.drawdown_percent)),
    freq: freqPoints,
  }), [freqPoints, snapshots]);

  const visibleKeys = useMemo(() => {
    const keys: SeriesKey[] = [];
    if (showEquity) keys.push('equity');
    if (showPnl) keys.push('pnl');
    if (showUpnl) keys.push('upnl');
    if (showDd) keys.push('dd');
    if (showFreq) keys.push('freq');
    return keys;
  }, [showDd, showEquity, showFreq, showPnl, showUpnl]);

  const multiSeries = visibleKeys.length > 1;

  const transformSeries = (key: SeriesKey, raw: LinePoint[]): LinePoint[] => {
    if (key === 'equity' && equityAsReturn) {
      return toReturnPercentSeries(raw);
    }
    return raw;
  };

  const primarySeries = useMemo(() => {
    const key = visibleKeys[0];
    if (!key) return [] as LinePoint[];
    return transformSeries(key, seriesRaw[key]);
  }, [equityAsReturn, seriesRaw, visibleKeys]);

  const overlayLines = useMemo(() => visibleKeys.slice(1).map((key) => {
    const raw = seriesRaw[key];
    const data = transformSeries(key, raw);
    return {
      id: key,
      color: SERIES_META[key].color,
      lineWidth: key === 'dd' || key === 'freq' ? 1 : 2,
      priceScaleId: `own-${key}`,
      data,
    };
  }), [equityAsReturn, seriesRaw, visibleKeys]);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const allSelected = showEquity && showPnl && showUpnl && showDd && showFreq;
  const noneSelected = !showEquity && !showPnl && !showUpnl && !showDd && !showFreq;

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
    setShowFreq(next);
  };

  const onlyOne = (key: SeriesKey) => {
    setShowEquity(key === 'equity');
    setShowPnl(key === 'pnl');
    setShowUpnl(key === 'upnl');
    setShowDd(key === 'dd');
    setShowFreq(key === 'freq');
  };

  const flowTagColor = (flow: EnrichedMonitoringTradeRow['flowType']) => {
    if (flow === 'in') return 'blue';
    if (flow === 'out') return 'orange';
    return 'purple';
  };

  const tradeColumns = [
    {
      title: 'Время',
      dataIndex: 'time',
      width: 132,
      sorter: (a: EnrichedMonitoringTradeRow, b: EnrichedMonitoringTradeRow) =>
        Date.parse(String(a.time || '')) - Date.parse(String(b.time || '')),
      defaultSortOrder: 'descend' as const,
      render: (v: string) => (v ? new Date(v).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      }) : '—'),
    },
    {
      title: 'Тип',
      dataIndex: 'flowType',
      width: 72,
      filters: [
        { text: 'IN — вход', value: 'in' },
        { text: 'OUT — выход', value: 'out' },
        { text: 'REV — переворот', value: 'reverse' },
      ],
      onFilter: (value: React.Key | boolean, row: EnrichedMonitoringTradeRow) => row.flowType === value,
      render: (v: EnrichedMonitoringTradeRow['flowType']) => (
        <Tag color={flowTagColor(v)} title={
          v === 'in' ? 'Открытие позиции'
            : v === 'out' ? 'Закрытие позиции'
              : 'Переворот: вход в противоположную сторону без отдельного OUT'
        }
        >
          {flowTypeLabel[v] || v}
        </Tag>
      ),
    },
    {
      title: 'Сторона',
      dataIndex: 'side',
      width: 72,
      filters: [
        { text: 'long', value: 'long' },
        { text: 'short', value: 'short' },
      ],
      onFilter: (value: React.Key | boolean, row: EnrichedMonitoringTradeRow) => row.side === value,
      render: (v: string) => (
        <span style={{ color: v === 'long' ? '#16a34a' : '#dc2626' }}>{v}</span>
      ),
    },
    {
      title: 'Символ',
      dataIndex: 'symbol',
      width: 130,
      sorter: (a: DisplayMonitoringTradeRow, b: DisplayMonitoringTradeRow) =>
        String(a.symbol).localeCompare(String(b.symbol)),
      render: (_: string, row: DisplayMonitoringTradeRow) => (
        <Space size={4} wrap>
          <span>{row.symbol}</span>
          {row.synthGrouped || row.synthPairLabel ? (
            <Tag color="purple" style={{ margin: 0, fontSize: 10 }}>synth</Tag>
          ) : null}
        </Space>
      ),
    },
    ...(showStrategyCol ? [{
      title: 'Стратегия',
      key: 'strategy',
      width: 160,
      render: (_: unknown, row: DisplayMonitoringTradeRow) => {
        const meta = strategiesById.get(Number(row.strategyId || 0));
        if (!meta) {
          return <Typography.Text type="secondary">{row.strategyId ? `#${row.strategyId}` : '—'}</Typography.Text>;
        }
        return (
          <span title={`${meta.name} · ${meta.strategy_type} #${meta.id}`}>
            {meta.name}
          </span>
        );
      },
    }] : []),
    {
      title: 'PnL %',
      dataIndex: 'pnlPercent',
      width: 88,
      sorter: (a: EnrichedMonitoringTradeRow, b: EnrichedMonitoringTradeRow) =>
        Number(a.pnlPercent ?? -999) - Number(b.pnlPercent ?? -999),
      filters: [
        { text: 'Профит', value: 'profit' },
        { text: 'Убыток', value: 'loss' },
        { text: '— (вход)', value: 'pending' },
      ],
      onFilter: (value: React.Key | boolean, row: EnrichedMonitoringTradeRow) => {
        if (value === 'profit') return row.flowType === 'out' && row.pnlPercent != null && row.pnlPercent >= 0;
        if (value === 'loss') return row.flowType === 'out' && row.pnlPercent != null && row.pnlPercent < 0;
        return row.flowType !== 'out' || row.pnlPercent == null;
      },
      render: (v: number | null, row: EnrichedMonitoringTradeRow) => {
        if (row.flowType !== 'out' || v == null || !Number.isFinite(v)) {
          return <Typography.Text type="secondary">{row.flowType === 'out' ? '—' : 'вход'}</Typography.Text>;
        }
        const color = v >= 0 ? '#16a34a' : '#dc2626';
        return <span style={{ color, fontWeight: 600 }}>{fmtSignedPct(v)}</span>;
      },
    },
    {
      title: '',
      key: 'chart',
      width: 88,
      render: (_: unknown, row: DisplayMonitoringTradeRow) => (
        apiKeyName ? (
          <Button
            size="small"
            type="link"
            onClick={() => openTradeChart(row)}
          >
            График
          </Button>
        ) : null
      ),
    },
  ];

  const renderTradesTable = (data: DisplayMonitoringTradeRow[], keyPrefix = '') => (
    <Table
      size="small"
      rowKey={(row) => `${keyPrefix}${row.id}-${row.time}-${row.synthGrouped ? 'g' : 's'}`}
      pagination={{ pageSize: 10, size: 'small' }}
      dataSource={data}
      columns={tradeColumns}
      scroll={{ x: 600 }}
      expandable={{
        rowExpandable: (row) => Boolean(row.synthGrouped && (row.synthLegs?.length || 0) > 1),
        expandedRowRender: (row) => (
          <Table
            size="small"
            pagination={false}
            rowKey={(leg) => `leg-${leg.id}-${leg.time}`}
            dataSource={row.synthLegs || []}
            columns={[
              { title: 'Время', dataIndex: 'time', render: (v: string) => new Date(v).toLocaleString('ru-RU') },
              { title: 'Нога', dataIndex: 'symbol' },
              { title: 'Сторона', dataIndex: 'side' },
              {
                title: 'PnL %',
                dataIndex: 'pnlPercent',
                render: (v: number | null) => (v != null ? fmtSignedPct(v) : '—'),
              },
            ]}
          />
        ),
      }}
    />
  );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap size={[8, 8]}>
          <Typography.Text strong style={{ fontSize: 16 }}>
            Входов (signal) за 24ч: {trades24h}
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

      <Space wrap>
        {onBackfillFromExchange ? (
          <Button
            size="small"
            type="primary"
            loading={backfillLoading}
            disabled={!backfillSupported || loading}
            onClick={() => void onBackfillFromExchange()}
          >
            С биржи (весь период)
          </Button>
        ) : null}
        <Button size="small" onClick={handleDownloadCsv} disabled={!snapshots.length}>
          Скачать CSV
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {backfillSupported === false
            ? 'История с биржи пока только для Bybit.'
            : '«С биржи» — по запросу: equity (Transaction Log) + fills (Execution List). Bybit. Не крутится в фоне.'}
        </Typography.Text>
      </Space>

      {coverageHint ? (
        <Alert type="info" showIcon message={coverageHint} />
      ) : null}

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
          {freqSummary ? (
            <Tag color="cyan">
              Частота: ср. {freqSummary.avg.toFixed(1)}/{freqBucketLabel}
              {' · '}
              пик {freqSummary.peak}
              {' · '}
              всего {freqSummary.total}
            </Tag>
          ) : null}
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
              checked={
                key === 'equity' ? showEquity
                  : key === 'pnl' ? showPnl
                    : key === 'upnl' ? showUpnl
                      : key === 'dd' ? showDd
                        : showFreq
              }
              onChange={(e) => {
                const checked = e.target.checked;
                if (key === 'equity') setShowEquity(checked);
                if (key === 'pnl') setShowPnl(checked);
                if (key === 'upnl') setShowUpnl(checked);
                if (key === 'dd') setShowDd(checked);
                if (key === 'freq') setShowFreq(checked);
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
      </Space>
      {multiSeries ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          У каждой линии свой автомасштаб — форма не схлопывается. Абсолютные значения — в тегах выше.
        </Typography.Text>
      ) : equityAsReturn && showEquity ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Ось Y: изменение equity от начала периода, %. Абсолютный баланс — в тегах.
        </Typography.Text>
      ) : showFreq && !showEquity ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Ось Y: число сделок за {freqBucketLabel}.
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
        <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
          {showFreq && !showEquity && !showPnl && !showUpnl && !showDd
            ? 'Нет данных по частоте сделок за период'
            : 'Нет снимков мониторинга'}
        </div>
      )}

      {displayTrades.length > 0 ? (
        <div>
          <Space wrap style={{ justifyContent: 'space-between', width: '100%', marginBottom: 8 }}>
            <Typography.Text strong>
              Сделки за период ({displayTrades.length}
              {groupSynthLegs && displayTrades.length !== enrichedTrades.length
                ? ` · ${enrichedTrades.length} fills`
                : ''}
              {trades.length >= 200 ? ', показаны последние 200' : ''}
              )
            </Typography.Text>
            <Space wrap>
              {synthById.size > 0 ? (
                <Checkbox
                  checked={groupSynthLegs}
                  onChange={(e) => setGroupSynthLegs(e.target.checked)}
                >
                  Группировать synth-ноги
                </Checkbox>
              ) : null}
              {strategiesById.size > 0 ? (
                <Checkbox
                  checked={showStrategyCol}
                  onChange={(e) => setShowStrategyCol(e.target.checked)}
                >
                  Показать стратегию
                </Checkbox>
              ) : null}
              <Segmented
                size="small"
                value={tradeGroupMode}
                onChange={(v) => setTradeGroupMode(v as MonitoringTradeGroupMode)}
                options={[
                  { label: 'Список', value: 'none' },
                  { label: 'Символ', value: 'symbol' },
                  { label: 'Тип', value: 'flowType' },
                  { label: 'Сторона', value: 'side' },
                  { label: 'PnL', value: 'pnl' },
                ]}
              />
            </Space>
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            IN — вход · OUT — выход · REV — переворот.
            PnL% только на OUT (вход без цены закрытия — не 0%).
            {synthById.size > 0
              ? ' Synth: BCH+APE (и др. пары) в одной строке · раскрой строку для ног.'
              : ''}
          </Typography.Text>
          {tradeGroupMode === 'none' || !tradeGroups ? (
            renderTradesTable(displayTrades)
          ) : (
            <Collapse
              size="small"
              items={tradeGroups.map((group) => ({
                key: group.key,
                label: (
                  <Space wrap>
                    <span>{group.label}</span>
                    <Tag>{group.rows.length}</Tag>
                    {group.totalPnl != null ? (
                      <Tag color={group.totalPnl >= 0 ? 'green' : 'red'}>
                        Σ {fmtSignedPct(group.totalPnl)}
                      </Tag>
                    ) : null}
                    {tradeGroupMode === 'symbol' && apiKeyName ? (
                      <Button
                        size="small"
                        type="link"
                        onClick={(e) => {
                          e.stopPropagation();
                          const sid = Number(group.rows[0]?.strategyId || 0) || null;
                          setChartStrategyId(sid);
                          setChartSymbol(group.key);
                        }}
                      >
                        График
                      </Button>
                    ) : null}
                  </Space>
                ),
                children: renderTradesTable(group.rows, `${group.key}-`),
              }))}
            />
          )}
        </div>
      ) : null}

      <MonitoringSymbolChartModal
        open={!!(chartSymbol || chartStrategyId) && !!apiKeyName}
        apiKeyName={apiKeyName}
        symbol={chartSymbol || ''}
        trades={chartSymbolTrades}
        strategyHint={chartStrategyId ? (strategiesById.get(chartStrategyId) || null) : null}
        onClose={() => {
          setChartSymbol(null);
          setChartStrategyId(null);
        }}
      />
    </Space>
  );
};

export default MonitoringChartPanel;

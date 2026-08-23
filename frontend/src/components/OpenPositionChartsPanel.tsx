import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Collapse, Space, Spin, Tag, Typography } from 'antd';
import axios from 'axios';
import ChartComponent from './ChartComponent';
import {
  buildOpenStrategyChartLayers,
  StrategyChartStrategy,
  StrategyTradeEvent,
  TradeHistoryRow,
} from '../utils/strategyChartOverlays';

type Props = {
  apiKeyName: string;
  active?: boolean;
  compact?: boolean;
};

type LoadedChart = {
  data: unknown[];
  layers: ReturnType<typeof buildOpenStrategyChartLayers>;
  error?: string;
};

const formatPnlTag = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
};

const isOpenState = (state: unknown): boolean => {
  const normalized = String(state || 'flat').toLowerCase();
  return normalized === 'long' || normalized === 'short';
};

const mapStrategyRow = (row: Record<string, unknown>): StrategyChartStrategy => ({
  id: Number(row.id),
  name: String(row.name || `strategy-${row.id}`),
  market_mode: String(row.market_mode || 'mono') === 'synthetic' ? 'synthetic' : 'mono',
  base_symbol: String(row.base_symbol || ''),
  quote_symbol: String(row.quote_symbol || ''),
  interval: String(row.interval || '1h'),
  base_coef: Number(row.base_coef) || 1,
  quote_coef: Number(row.quote_coef) || 1,
  price_channel_length: Number(row.price_channel_length) || 20,
  detection_source: String(row.detection_source || 'wick') === 'close' ? 'close' : 'wick',
  take_profit_percent: Number(row.take_profit_percent) || 0,
  state: String(row.state || 'flat') as StrategyChartStrategy['state'],
  entry_ratio: row.entry_ratio === null || row.entry_ratio === undefined ? null : Number(row.entry_ratio),
  last_signal: row.last_signal != null ? String(row.last_signal) : null,
});

const mapStrategyTradeEvent = (row: Record<string, unknown>): StrategyTradeEvent | null => {
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  return {
    id,
    strategyId: Number(row.strategyId),
    tradeType: String(row.tradeType || 'entry') === 'exit' ? 'exit' : 'entry',
    side: String(row.side || 'long').toLowerCase() === 'short' ? 'short' : 'long',
    symbol: String(row.symbol || '').toUpperCase(),
    price: Number(row.price) || 0,
    qtyUsdt: Number(row.qty) || 0,
    timestamp: Number(row.timestamp) || 0,
    fee: Number(row.fee) || 0,
    eventOrigin: String(row.eventOrigin || ''),
  };
};

const strategyLabel = (strategy: StrategyChartStrategy): string => {
  const pair = strategy.market_mode === 'synthetic'
    ? `${strategy.base_symbol}/${strategy.quote_symbol}`
    : strategy.base_symbol;
  return `${strategy.name} · ${pair} · ${String(strategy.state).toUpperCase()}`;
};

const OpenPositionChartsPanel: React.FC<Props> = ({ apiKeyName, active = true, compact = false }) => {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [openStrategies, setOpenStrategies] = useState<StrategyChartStrategy[]>([]);
  const [chartsByStrategyId, setChartsByStrategyId] = useState<Record<number, LoadedChart>>({});
  const [exchangeTrades, setExchangeTrades] = useState<TradeHistoryRow[]>([]);
  const [strategyEvents, setStrategyEvents] = useState<StrategyTradeEvent[]>([]);

  const loadOpenCharts = useCallback(async () => {
    if (!apiKeyName) {
      return;
    }
    setLoading(true);
    setLoadError('');
    setChartsByStrategyId({});
    try {
      const [strategiesRes, tradesRes, eventsRes] = await Promise.all([
        axios.get(`/api/strategies/${encodeURIComponent(apiKeyName)}`, {
          params: { limit: 500, includeLotPreview: '0' },
          timeout: 60_000,
        }),
        axios.get(`/api/trades/${encodeURIComponent(apiKeyName)}`, {
          params: { limit: 300 },
          timeout: 60_000,
        }).catch(() => ({ data: [] })),
        axios.get(`/api/strategy-trades/${encodeURIComponent(apiKeyName)}`, {
          params: { limit: 2000, days: 30 },
          timeout: 60_000,
        }).catch(() => ({ data: [] })),
      ]);

      const allStrategies = (Array.isArray(strategiesRes.data) ? strategiesRes.data : [])
        .map((row: Record<string, unknown>) => mapStrategyRow(row));
      const open = allStrategies.filter((s) => isOpenState(s.state));
      setOpenStrategies(open);

      const trades = (Array.isArray(tradesRes.data) ? tradesRes.data : []) as TradeHistoryRow[];
      setExchangeTrades(trades);

      const events = (Array.isArray(eventsRes.data) ? eventsRes.data : [])
        .map((row: Record<string, unknown>) => mapStrategyTradeEvent(row))
        .filter((row): row is StrategyTradeEvent => !!row);
      setStrategyEvents(events);

      if (open.length === 0) {
        return;
      }

      const chartEntries = await Promise.all(open.map(async (strategy) => {
        try {
          let payload: unknown[] = [];
          if (strategy.market_mode === 'synthetic') {
            const res = await axios.get(`/api/synthetic-chart/${encodeURIComponent(apiKeyName)}`, {
              params: {
                base: strategy.base_symbol,
                quote: strategy.quote_symbol,
                baseCoef: strategy.base_coef || 1,
                quoteCoef: strategy.quote_coef || 1,
                interval: strategy.interval || '1h',
                limit: 220,
              },
              timeout: 55_000,
            });
            payload = Array.isArray(res.data) ? res.data : [];
          } else {
            const res = await axios.get(`/api/market-data/${encodeURIComponent(apiKeyName)}`, {
              params: {
                symbol: strategy.base_symbol,
                interval: strategy.interval || '1h',
                limit: 220,
              },
              timeout: 55_000,
            });
            payload = Array.isArray(res.data) ? res.data : [];
          }

          const idPrefix = `${apiKeyName}:${strategy.id}`;
          const layers = buildOpenStrategyChartLayers(
            strategy,
            payload,
            events,
            trades,
            idPrefix,
          );
          return [strategy.id, { data: payload, layers }] as const;
        } catch (error: unknown) {
          const message = String((error as { response?: { data?: { error?: string } }; message?: string })
            ?.response?.data?.error
            || (error as Error)?.message
            || 'chart load failed');
          return [strategy.id, { data: [], layers: { overlayLines: [], markers: [] }, error: message }] as const;
        }
      }));

      setChartsByStrategyId(Object.fromEntries(chartEntries));
    } catch (error: unknown) {
      setLoadError(String((error as Error)?.message || 'Не удалось загрузить открытые позиции'));
      setOpenStrategies([]);
    } finally {
      setLoading(false);
    }
  }, [apiKeyName]);

  useEffect(() => {
    if (!active || !expanded) {
      return;
    }
    void loadOpenCharts();
  }, [active, expanded, loadOpenCharts]);

  const collapseItems = useMemo(() => openStrategies.map((strategy) => {
    const loaded = chartsByStrategyId[strategy.id];
    const stateColor = strategy.state === 'long' ? 'green' : strategy.state === 'short' ? 'red' : 'default';
    return {
      key: String(strategy.id),
      label: (
        <Space wrap size={8}>
          <span>{strategyLabel(strategy)}</span>
          <Tag color={stateColor}>{String(strategy.state).toUpperCase()}</Tag>
          <Tag>{strategy.interval}</Tag>
          {strategy.market_mode === 'synthetic' ? <Tag color="purple">synthetic</Tag> : null}
        </Space>
      ),
      children: loaded?.error ? (
        <Alert type="error" showIcon message={loaded.error} />
      ) : (
        <>
          {loaded?.layers.summary ? (
            <div style={{ fontSize: 12, color: '#4b5563', marginBottom: 8, lineHeight: 1.5 }}>
              <div>
                <strong>Сигнал:</strong> {loaded.layers.summary.lastSignal}
                {' · '}
                <strong>Закрытых round-trip:</strong> {loaded.layers.summary.roundTrips.length}
                {loaded.layers.summary.openTrip ? (
                  <>
                    {' · '}
                    <strong>Открыта:</strong> {String(strategy.state).toUpperCase()}
                    {' '}
                    UPnL {formatPnlTag(loaded.layers.summary.upnlPercent)}
                  </>
                ) : null}
              </div>
              <div style={{ color: '#6b7280', marginTop: 2 }}>
                Линия IN→OUT = сделка; на выходе % PnL. Несколько L/X раньше — это DCA/частичные филлы, теперь сведены в пары.
              </div>
            </div>
          ) : null}
          <ChartComponent
            data={loaded?.data || []}
            type="candlestick"
            overlayLines={loaded?.layers.overlayLines || []}
            markers={loaded?.layers.markers || []}
            fixedHeight={compact ? 280 : 360}
          />
        </>
      ),
    };
  }), [chartsByStrategyId, compact, openStrategies]);

  if (!active) {
    return null;
  }

  return (
    <div style={{ marginTop: 16 }}>
      <Space wrap style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text strong>Графики открытых позиций</Typography.Text>
        <Button
          size="small"
          type={expanded ? 'default' : 'primary'}
          loading={loading && expanded}
          onClick={() => {
            if (expanded) {
              setExpanded(false);
              return;
            }
            setExpanded(true);
          }}
        >
          {expanded ? 'Свернуть' : 'Показать графики'}
        </Button>
      </Space>

      {expanded && loading ? (
        <div style={{ textAlign: 'center', padding: 24 }}><Spin tip="Загрузка свечей и уровней…" /></div>
      ) : null}

      {expanded && loadError ? (
        <Alert type="error" showIcon message={loadError} style={{ marginBottom: 8 }} />
      ) : null}

      {expanded && !loading && !loadError && openStrategies.length === 0 ? (
        <Typography.Text type="secondary">Нет открытых позиций на этом ключе.</Typography.Text>
      ) : null}

      {expanded && !loading && openStrategies.length > 0 ? (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            Donchian + Entry/TP. Сделки: линия IN→OUT со стрелкой, на выходе % PnL; открытая — UPnL до текущей цены.
          </Typography.Paragraph>
          <Collapse items={collapseItems} defaultActiveKey={openStrategies.length === 1 ? [String(openStrategies[0].id)] : undefined} />
        </>
      ) : null}
    </div>
  );
};

export default OpenPositionChartsPanel;

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox, Collapse, Modal, Space, Spin, Tag, Typography } from 'antd';
import axios from 'axios';
import ChartComponent from './ChartComponent';
import type { EnrichedMonitoringTradeRow } from '../utils/monitoringTradeEnrichment';
import { shortStrategyLabel } from '../utils/monitoringTradeEnrichment';
import {
  buildOpenStrategyChartLayers,
  buildStrategyTradeMarkersFromEvents,
  mapLiveTradeRowToEvent,
  StrategyChartStrategy,
  StrategyTradeEvent,
} from '../utils/strategyChartOverlays';

type Props = {
  open: boolean;
  apiKeyName: string;
  symbol: string;
  trades: EnrichedMonitoringTradeRow[];
  strategyHint?: StrategyChartStrategy | null;
  onClose: () => void;
};

const toStrategyEvents = (rows: EnrichedMonitoringTradeRow[]): StrategyTradeEvent[] =>
  rows.map((row) => {
    const barTime = Number(row.barTime || 0);
    const fillTime = Date.parse(String(row.time || ''));
    return {
      id: row.id,
      strategyId: Number(row.strategyId || 0),
      tradeType: row.tradeType,
      side: row.side,
      symbol: row.symbol,
      price: row.price,
      qtyUsdt: Math.abs(row.price * (row.size || 0)),
      timestamp: barTime > 0 ? barTime : fillTime,
      barTime: barTime > 0 ? barTime : undefined,
      entryPrice: row.entryPrice,
      fee: row.fee ?? 0,
      eventOrigin: 'monitoring',
    };
  });

const mapStrategyRow = (row: Record<string, unknown>): StrategyChartStrategy | null => {
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    name: String(row.name || `strategy-${id}`),
    market_mode: String(row.market_mode || 'mono') === 'synthetic' ? 'synthetic' : 'mono',
    base_symbol: String(row.base_symbol || ''),
    quote_symbol: String(row.quote_symbol || ''),
    base_coef: Number(row.base_coef) || 1,
    quote_coef: Number(row.quote_coef) || 1,
    interval: String(row.interval || '4h'),
    price_channel_length: Number(row.price_channel_length) || 20,
    detection_source: String(row.detection_source || 'wick') === 'close' ? 'close' : 'wick',
    take_profit_percent: Number(row.take_profit_percent) || 0,
    state: String(row.state || 'flat'),
    entry_ratio: row.entry_ratio === null || row.entry_ratio === undefined ? null : Number(row.entry_ratio),
    last_signal: row.last_signal != null ? String(row.last_signal) : null,
    strategy_type: String(row.strategy_type || ''),
  };
};

const MonitoringSymbolChartModal: React.FC<Props> = ({
  open,
  apiKeyName,
  symbol,
  trades,
  strategyHint = null,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chartData, setChartData] = useState<unknown[]>([]);
  const [strategyMeta, setStrategyMeta] = useState<StrategyChartStrategy | null>(null);
  const [legCharts, setLegCharts] = useState<Record<string, { loading: boolean; data: unknown[]; error?: string }>>({});
  const [showStrategyLabel, setShowStrategyLabel] = useState(true);
  const [showLevels, setShowLevels] = useState(true);
  const [showTradePath, setShowTradePath] = useState(true);
  const [fetchedEvents, setFetchedEvents] = useState<StrategyTradeEvent[]>([]);

  const primaryStrategyId = useMemo(() => {
    if (strategyHint?.id) return strategyHint.id;
    const ids = trades.map((t) => Number(t.strategyId || 0)).filter((id) => id > 0);
    return ids[0] || 0;
  }, [strategyHint, trades]);

  const loadLegChart = useCallback(async (legSymbol: string, interval: string) => {
    if (!apiKeyName || !legSymbol) return;
    setLegCharts((prev) => ({
      ...prev,
      [legSymbol]: { loading: true, data: prev[legSymbol]?.data || [] },
    }));
    try {
      const res = await axios.get(`/api/market-data/${encodeURIComponent(apiKeyName)}`, {
        params: { symbol: legSymbol, interval, limit: 500 },
        timeout: 55_000,
      });
      setLegCharts((prev) => ({
        ...prev,
        [legSymbol]: { loading: false, data: Array.isArray(res.data) ? res.data : [] },
      }));
    } catch (err: unknown) {
      setLegCharts((prev) => ({
        ...prev,
        [legSymbol]: {
          loading: false,
          data: [],
          error: String((err as Error)?.message || 'leg chart failed'),
        },
      }));
    }
  }, [apiKeyName]);

  useEffect(() => {
    if (!open || !apiKeyName || (!symbol && !primaryStrategyId)) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setChartData([]);
    setStrategyMeta(strategyHint || null);
    setFetchedEvents([]);
    setLegCharts({});

    void (async () => {
      try {
        let meta: StrategyChartStrategy | null = strategyHint || null;
        if (!meta && primaryStrategyId > 0) {
          const strategiesRes = await axios.get<unknown[]>(`/api/strategies/${encodeURIComponent(apiKeyName)}`, {
            timeout: 60_000,
          });
          const rows = Array.isArray(strategiesRes.data) ? strategiesRes.data : [];
          meta = rows
            .map((row) => mapStrategyRow(row as Record<string, unknown>))
            .find((item) => item?.id === primaryStrategyId) || null;
        }

        if (cancelled) return;
        setStrategyMeta(meta);

        const interval = meta?.interval || '4h';
        const candleLimit = 500;
        const strategyIdForTrades = meta?.id || primaryStrategyId;
        const tradesReq = strategyIdForTrades > 0
          ? axios.get(`/api/strategy-trades/${encodeURIComponent(apiKeyName)}`, {
            params: { strategyId: strategyIdForTrades, days: 180, limit: 2000 },
            timeout: 55_000,
          }).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] });

        let payload: unknown[] = [];
        const chartReq = meta?.market_mode === 'synthetic' && meta.base_symbol && meta.quote_symbol
          ? axios.get(`/api/synthetic-chart/${encodeURIComponent(apiKeyName)}`, {
            params: {
              base: meta.base_symbol,
              quote: meta.quote_symbol,
              baseCoef: meta.base_coef || 1,
              quoteCoef: meta.quote_coef || 1,
              interval,
              limit: candleLimit,
            },
            timeout: 55_000,
          })
          : axios.get(`/api/market-data/${encodeURIComponent(apiKeyName)}`, {
            params: { symbol: symbol.split('/')[0] || symbol, interval, limit: candleLimit },
            timeout: 55_000,
          });

        const [chartRes, tradesRes] = await Promise.all([chartReq, tradesReq]);
        payload = Array.isArray(chartRes.data) ? chartRes.data : [];
        const mappedEvents = (Array.isArray(tradesRes.data) ? tradesRes.data : [])
          .map((row: Record<string, unknown>) => mapLiveTradeRowToEvent(row))
          .filter((row: StrategyTradeEvent | null): row is StrategyTradeEvent => !!row);

        if (!cancelled) {
          setChartData(payload);
          setFetchedEvents(mappedEvents);
        }

        if (meta?.market_mode === 'synthetic' && meta.base_symbol && meta.quote_symbol) {
          void loadLegChart(meta.base_symbol, interval);
          void loadLegChart(meta.quote_symbol, interval);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(String((err as Error)?.message || 'Не удалось загрузить свечи'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, apiKeyName, symbol, primaryStrategyId, strategyHint]);

  const markerSymbols = useMemo(() => {
    if (strategyMeta?.market_mode === 'synthetic') {
      return [strategyMeta.base_symbol, strategyMeta.quote_symbol].filter(Boolean);
    }
    return symbol ? [symbol] : [];
  }, [strategyMeta, symbol]);

  const strategyEvents = useMemo(() => {
    if (fetchedEvents.length > 0) {
      return fetchedEvents;
    }
    return toStrategyEvents(trades);
  }, [fetchedEvents, trades]);

  const layers = useMemo(() => {
    if (!strategyMeta || chartData.length === 0) {
      return {
        overlayLines: [],
        markers: buildStrategyTradeMarkersFromEvents(
          strategyEvents,
          markerSymbols,
          {
            chartData,
            markerLimit: 400,
            strategyId: primaryStrategyId > 0 ? primaryStrategyId : undefined,
          },
        ),
      };
    }
    return buildOpenStrategyChartLayers(
      strategyMeta,
      chartData,
      strategyEvents,
      [],
      `mon:${apiKeyName}:${strategyMeta.id}`,
      { chartRole: 'primary' },
    );
  }, [apiKeyName, chartData, markerSymbols, primaryStrategyId, strategyEvents, strategyMeta]);

  const overlayLines = useMemo(() => {
    const lines = layers.overlayLines || [];
    return lines.filter((line) => {
      const id = String(line.id || '');
      const isFlow = id.includes(':flow');
      const isLevel = !isFlow;
      if (isFlow) return showTradePath;
      return showLevels && isLevel;
    });
  }, [layers.overlayLines, showLevels, showTradePath]);

  const flowHint = useMemo(() => {
    const summary = layers.summary;
    if (summary) {
      const closed = summary.roundTrips.length;
      const open = summary.openTrip ? 1 : 0;
      const openBit = open ? ' · OPEN' : '';
      const upnl = summary.upnlPercent != null
        ? ` · UPnL ${summary.upnlPercent > 0 ? '+' : ''}${summary.upnlPercent.toFixed(1)}%`
        : '';
      return `${closed} круг(ов)${openBit}${upnl}`;
    }
    const ins = trades.filter((t) => t.flowType === 'in').length;
    const outs = trades.filter((t) => t.flowType === 'out').length;
    return `IN ${ins} · OUT ${outs}`;
  }, [layers.summary, trades]);

  const synthTitle = strategyMeta?.market_mode === 'synthetic'
    ? `${strategyMeta.base_symbol}/${strategyMeta.quote_symbol} (synth)`
    : symbol;

  const strategyTitle = showStrategyLabel && strategyMeta
    ? shortStrategyLabel(strategyMeta.strategy_type, strategyMeta.name)
    : null;

  const legItems = strategyMeta?.market_mode === 'synthetic'
    ? [
      strategyMeta.base_symbol,
      strategyMeta.quote_symbol,
    ].filter(Boolean).map((legSymbol) => {
      const legEvents = strategyEvents.filter(
        (event) => String(event.symbol || '').toUpperCase() === String(legSymbol).toUpperCase(),
      );
      const leg = legCharts[legSymbol];
      const legLayers = !leg?.data?.length
        ? { overlayLines: [], markers: [] }
        : buildOpenStrategyChartLayers(
          { ...strategyMeta, market_mode: 'mono', base_symbol: legSymbol, quote_symbol: '', state: 'flat', entry_ratio: null },
          leg.data,
          legEvents,
          [],
          `mon-leg:${apiKeyName}:${strategyMeta.id}:${legSymbol}`,
          { chartRole: 'leg' },
        );
      return {
        key: legSymbol,
        label: (
          <SpaceLike>
            <span>{legSymbol}</span>
            <Tag>leg</Tag>
            <Tag>{legEvents.length} fills</Tag>
          </SpaceLike>
        ),
        children: (() => {
          if (!leg || leg.loading) {
            return <div style={{ padding: 16, textAlign: 'center' }}><Spin size="small" /></div>;
          }
          if (leg.error) {
            return <Typography.Text type="danger">{leg.error}</Typography.Text>;
          }
          if (!leg.data.length) {
            return <Typography.Text type="secondary">Нет данных</Typography.Text>;
          }
          return (
            <ChartComponent
              data={leg.data}
              type="candlestick"
              markers={showTradePath ? legLayers.markers : []}
              overlayLines={(showLevels || showTradePath)
                ? (legLayers.overlayLines || []).filter((line) => {
                  const id = String(line.id || '');
                  const isFlow = id.includes(':flow');
                  if (isFlow) return showTradePath;
                  return showLevels;
                })
                : []}
            />
          );
        })(),
      };
    })
    : [];

  return (
    <Modal
      title={strategyTitle ? `${synthTitle} · ${strategyTitle}` : `${synthTitle} · сделки на графике`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={920}
      destroyOnClose
    >
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        {flowHint}
        {' · '}
        {strategyMeta?.interval || '4h'}
        {' свечи · маркеры на закрытом баре (как runtime/BT) · ZZ/Donchian + SMA · линия IN→OUT'}
      </Typography.Text>
      <Space wrap size={[8, 8]} style={{ marginBottom: 8 }}>
        <Checkbox checked={showStrategyLabel} onChange={(e) => setShowStrategyLabel(e.target.checked)}>
          Подпись стратегии
        </Checkbox>
        <Checkbox checked={showLevels} onChange={(e) => setShowLevels(e.target.checked)}>
          Уровни ZZ / канал / MA
        </Checkbox>
        <Checkbox checked={showTradePath} onChange={(e) => setShowTradePath(e.target.checked)}>
          Линия хода сделки
        </Checkbox>
        {strategyMeta?.market_mode === 'synthetic' ? (
          <Tag color="purple">synthetic #{strategyMeta.id}</Tag>
        ) : null}
        {strategyMeta?.state && strategyMeta.state !== 'flat' ? (
          <Tag color={strategyMeta.state === 'long' ? 'green' : 'red'}>{String(strategyMeta.state).toUpperCase()}</Tag>
        ) : null}
      </Space>
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
      ) : error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : chartData.length > 0 ? (
        <ChartComponent
          data={chartData}
          type="candlestick"
          markers={layers.markers}
          overlayLines={overlayLines}
        />
      ) : (
        <Typography.Text type="secondary">Нет данных свечей</Typography.Text>
      )}
      {legItems.length > 0 ? (
        <Collapse
          style={{ marginTop: 12 }}
          defaultActiveKey={legItems.map((item) => item.key)}
          items={legItems}
          onChange={(keys) => {
            const opened = Array.isArray(keys) ? keys : [keys];
            for (const key of opened) {
              const legSymbol = String(key || '');
              if (!legCharts[legSymbol]?.data?.length && !legCharts[legSymbol]?.loading) {
                void loadLegChart(legSymbol, strategyMeta?.interval || '4h');
              }
            }
          }}
        />
      ) : null}
    </Modal>
  );
};

const SpaceLike: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>{children}</span>
);

export default MonitoringSymbolChartModal;

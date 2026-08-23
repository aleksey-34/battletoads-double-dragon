import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Collapse, Modal, Spin, Tag, Typography } from 'antd';
import axios from 'axios';
import ChartComponent from './ChartComponent';
import type { EnrichedMonitoringTradeRow } from '../utils/monitoringTradeEnrichment';
import { buildStrategyTradeMarkersFromEvents } from '../utils/strategyChartOverlays';
import type { StrategyTradeEvent } from '../utils/strategyChartOverlays';

type Props = {
  open: boolean;
  apiKeyName: string;
  symbol: string;
  trades: EnrichedMonitoringTradeRow[];
  onClose: () => void;
};

type StrategyMeta = {
  id: number;
  market_mode: 'mono' | 'synthetic';
  base_symbol: string;
  quote_symbol: string;
  base_coef: number;
  quote_coef: number;
  interval: string;
};

const toStrategyEvents = (rows: EnrichedMonitoringTradeRow[]): StrategyTradeEvent[] =>
  rows.map((row) => ({
    id: row.id,
    strategyId: Number(row.strategyId || 0),
    tradeType: row.tradeType,
    side: row.side,
    symbol: row.symbol,
    price: row.price,
    qtyUsdt: Math.abs(row.price * (row.size || 0)),
    timestamp: Date.parse(String(row.time || '')),
    fee: row.fee ?? 0,
    eventOrigin: 'monitoring',
  }));

const mapStrategyRow = (row: Record<string, unknown>): StrategyMeta | null => {
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    market_mode: String(row.market_mode || 'mono') === 'synthetic' ? 'synthetic' : 'mono',
    base_symbol: String(row.base_symbol || ''),
    quote_symbol: String(row.quote_symbol || ''),
    base_coef: Number(row.base_coef) || 1,
    quote_coef: Number(row.quote_coef) || 1,
    interval: String(row.interval || '4h'),
  };
};

const MonitoringSymbolChartModal: React.FC<Props> = ({
  open,
  apiKeyName,
  symbol,
  trades,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chartData, setChartData] = useState<unknown[]>([]);
  const [strategyMeta, setStrategyMeta] = useState<StrategyMeta | null>(null);
  const [legCharts, setLegCharts] = useState<Record<string, { loading: boolean; data: unknown[]; error?: string }>>({});

  const primaryStrategyId = useMemo(() => {
    const ids = trades.map((t) => Number(t.strategyId || 0)).filter((id) => id > 0);
    return ids[0] || 0;
  }, [trades]);

  const loadLegChart = useCallback(async (legSymbol: string, interval: string) => {
    if (!apiKeyName || !legSymbol) return;
    setLegCharts((prev) => ({
      ...prev,
      [legSymbol]: { loading: true, data: prev[legSymbol]?.data || [] },
    }));
    try {
      const res = await axios.get(`/api/market-data/${encodeURIComponent(apiKeyName)}`, {
        params: { symbol: legSymbol, interval, limit: 320 },
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
    if (!open || !apiKeyName || !symbol) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setChartData([]);
    setStrategyMeta(null);
    setLegCharts({});

    void (async () => {
      try {
        let meta: StrategyMeta | null = null;
        if (primaryStrategyId > 0) {
          const strategiesRes = await axios.get<unknown[]>(`/api/strategies/${encodeURIComponent(apiKeyName)}`, {
            timeout: 30_000,
          });
          const rows = Array.isArray(strategiesRes.data) ? strategiesRes.data : [];
          meta = rows
            .map((row) => mapStrategyRow(row as Record<string, unknown>))
            .find((item) => item?.id === primaryStrategyId) || null;
        }

        if (cancelled) return;
        setStrategyMeta(meta);

        const interval = meta?.interval || '4h';
        let payload: unknown[] = [];
        if (meta?.market_mode === 'synthetic' && meta.base_symbol && meta.quote_symbol) {
          const synthRes = await axios.get(`/api/synthetic-chart/${encodeURIComponent(apiKeyName)}`, {
            params: {
              base: meta.base_symbol,
              quote: meta.quote_symbol,
              baseCoef: meta.base_coef || 1,
              quoteCoef: meta.quote_coef || 1,
              interval,
              limit: 320,
            },
            timeout: 55_000,
          });
          payload = Array.isArray(synthRes.data) ? synthRes.data : [];
        } else {
          const monoRes = await axios.get(`/api/market-data/${encodeURIComponent(apiKeyName)}`, {
            params: { symbol, interval, limit: 320 },
            timeout: 55_000,
          });
          payload = Array.isArray(monoRes.data) ? monoRes.data : [];
        }

        if (!cancelled) {
          setChartData(payload);
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
  }, [open, apiKeyName, symbol, primaryStrategyId]);

  const markers = useMemo(
    () => buildStrategyTradeMarkersFromEvents(
      toStrategyEvents(trades),
      [symbol],
      { chartData, markerLimit: 400 },
    ),
    [chartData, symbol, trades],
  );

  const flowHint = useMemo(() => {
    const ins = trades.filter((t) => t.flowType === 'in').length;
    const outs = trades.filter((t) => t.flowType === 'out').length;
    const revs = trades.filter((t) => t.flowType === 'reverse').length;
    return `IN ${ins} · OUT ${outs} · REV ${revs}`;
  }, [trades]);

  const synthTitle = strategyMeta?.market_mode === 'synthetic'
    ? `${strategyMeta.base_symbol}/${strategyMeta.quote_symbol} (synth)`
    : symbol;

  const legItems = strategyMeta?.market_mode === 'synthetic'
    ? [
      strategyMeta.base_symbol,
      strategyMeta.quote_symbol,
    ].filter(Boolean).map((legSymbol) => ({
      key: legSymbol,
      label: (
        <SpaceLike>
          <span>{legSymbol}</span>
          <Tag>leg</Tag>
        </SpaceLike>
      ),
      children: (() => {
        const leg = legCharts[legSymbol];
        if (!leg || leg.loading) {
          return <div style={{ padding: 16, textAlign: 'center' }}><Spin size="small" /></div>;
        }
        if (leg.error) {
          return <Typography.Text type="danger">{leg.error}</Typography.Text>;
        }
        if (!leg.data.length) {
          return <Typography.Text type="secondary">Нет данных</Typography.Text>;
        }
        return <ChartComponent data={leg.data} type="candlestick" />;
      })(),
    }))
    : [];

  return (
    <Modal
      title={`${synthTitle} · сделки на графике`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={920}
      destroyOnClose
    >
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        {flowHint}
        {' · '}
        {strategyMeta?.market_mode === 'synthetic' ? 'synth ratio chart + legs по запросу' : '4h свечи'}
        {' · '}
        маркеры: L/S вход, X выход
      </Typography.Text>
      {strategyMeta?.market_mode === 'synthetic' ? (
        <Tag color="purple" style={{ marginBottom: 8 }}>synthetic #{strategyMeta.id}</Tag>
      ) : null}
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
      ) : error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : chartData.length > 0 ? (
        <ChartComponent data={chartData} type="candlestick" markers={markers} />
      ) : (
        <Typography.Text type="secondary">Нет данных свечей</Typography.Text>
      )}
      {legItems.length > 0 ? (
        <Collapse
          style={{ marginTop: 12 }}
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

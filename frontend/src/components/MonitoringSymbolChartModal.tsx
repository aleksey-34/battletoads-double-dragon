import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Spin, Typography } from 'antd';
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

const toStrategyEvents = (rows: EnrichedMonitoringTradeRow[]): StrategyTradeEvent[] =>
  rows.map((row) => ({
    id: row.id,
    strategyId: Number(row.strategyId || 0),
    tradeType: row.tradeType,
    side: row.side,
    symbol: row.symbol,
    price: row.price,
    qtyUsdt: Math.abs(row.price * row.size),
    timestamp: Date.parse(String(row.time || '')),
    fee: row.fee ?? 0,
    eventOrigin: 'monitoring',
  }));

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

  useEffect(() => {
    if (!open || !apiKeyName || !symbol) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setChartData([]);
    void axios.get(`/api/market-data/${encodeURIComponent(apiKeyName)}`, {
      params: { symbol, interval: '4h', limit: 320 },
      timeout: 55_000,
    })
      .then((res) => {
        if (cancelled) return;
        setChartData(Array.isArray(res.data) ? res.data : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String((err as Error)?.message || 'Не удалось загрузить свечи'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, apiKeyName, symbol]);

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

  return (
    <Modal
      title={`${symbol} · сделки на графике`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={920}
      destroyOnClose
    >
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        {flowHint}
        {' · '}
        4h свечи, маркеры: L/S вход, X выход
      </Typography.Text>
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
      ) : error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : chartData.length > 0 ? (
        <ChartComponent data={chartData} type="candlestick" markers={markers} />
      ) : (
        <Typography.Text type="secondary">Нет данных свечей</Typography.Text>
      )}
    </Modal>
  );
};

export default MonitoringSymbolChartModal;

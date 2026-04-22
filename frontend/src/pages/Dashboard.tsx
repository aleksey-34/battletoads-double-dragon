import React, { useEffect, useRef, useState } from 'react';
import { Card, Button, Switch, Row, Col, Form, Input, Select, Collapse, Spin, Alert, Space, InputNumber, Tag, Popconfirm, message, Divider, Badge } from 'antd';
import axios from 'axios';
import ChartComponent, { HoverOHLC, OverlayLine, ChartMarker } from '../components/ChartComponent';
import StatusIndicator from '../components/StatusIndicator';

/* eslint-disable react-hooks/exhaustive-deps */

const { Option } = Select;

type ApiKey = {
  id: number;
  name: string;
  exchange: string;
  tenantDisplayName?: string;
  tenantProductMode?: string;
};

type KeyStatus = {
  status: string;
  message?: string;
};

type ChartType = 'line' | 'candlestick';
type DashboardChartType = 'mono' | 'synthetic';

type ChartSetting = {
  type: DashboardChartType;
  symbol: string;
  base: string;
  quote: string;
  baseCoef: number;
  quoteCoef: number;
  interval: string;
  chartType: ChartType;
  updateSec: number;
  showSettings: boolean;
  showChart: boolean;
  showMonitoring: boolean;
};

type LastOHLC = {
  time?: number;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
};

type DetectionSource = 'wick' | 'close';
type MarginType = 'cross' | 'isolated';
type StrategyKind = 'DD_BattleToads' | 'zz_breakout' | 'stat_arb_zscore';

type DDStrategy = {
  id: number;
  name: string;
  strategy_type: StrategyKind;
  market_mode: 'mono' | 'synthetic';
  is_active: boolean;
  display_on_chart: boolean;
  take_profit_percent: number;
  price_channel_length: number;
  detection_source: DetectionSource;
  base_symbol: string;
  quote_symbol: string;
  interval: string;
  base_coef: number;
  quote_coef: number;
  show_chart: boolean;
  show_settings: boolean;
  show_indicators: boolean;
  show_positions_on_chart: boolean;
  show_trades_on_chart: boolean;
  show_values_each_bar: boolean;
  auto_update: boolean;
  long_enabled: boolean;
  short_enabled: boolean;
  lot_long_percent: number;
  lot_short_percent: number;
  max_deposit: number;
  margin_type: MarginType;
  leverage: number;
  fixed_lot: boolean;
  reinvest_percent: number;
  state: 'flat' | 'long' | 'short';
  entry_ratio?: number | null;
  last_signal?: string | null;
  last_action?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
  lot_long_usdt?: number | null;
  lot_short_usdt?: number | null;
  lot_balance_usdt?: number | null;
  is_runtime?: boolean;
  is_archived?: boolean;
  origin?: string;
  isDirty?: boolean;
};

type TradeHistoryRow = {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  price: string;
  notional: string;
  fee: string;
  feeCurrency: string;
  realizedPnl: string;
  isMaker: boolean;
  timestamp: string;
};

type CopyBlockResponse = {
  copied?: number;
  deleted?: number;
  adjustedSymbols?: number;
  disabledStrategies?: number;
  symbolValidationEnabled?: boolean;
  issues?: string[];
  chartSuggestion?: {
    base: string;
    quote: string;
    interval: string;
    baseCoef: number;
    quoteCoef: number;
  } | null;
};

const defaultChartSetting = (): ChartSetting => ({
  type: 'mono',
  symbol: 'BTCUSDT',
  base: 'BTCUSDT',
  quote: 'ETHUSDT',
  baseCoef: 1,
  quoteCoef: 1,
  interval: '1h',
  chartType: 'candlestick',
  updateSec: 60,
  showSettings: true,
  showChart: true,
  showMonitoring: true,
});

const AUTO_UPDATE_MIN_SEC = 5;
const AUTO_UPDATE_MAX_SEC = 3600;
const STRATEGY_FETCH_LIMIT = 120;
const STRATEGY_RENDER_CHUNK = 80;

const normalizeUpdateSec = (rawValue: unknown): number => {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.min(AUTO_UPDATE_MAX_SEC, Math.max(AUTO_UPDATE_MIN_SEC, Math.round(numeric)));
};

type ParsedCandlePoint = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const parseCandlePoint = (point: any): ParsedCandlePoint | null => {
  if (Array.isArray(point) && point.length >= 5) {
    const time = Number(point[0]);
    const open = Number(point[1]);
    const high = Number(point[2]);
    const low = Number(point[3]);
    const close = Number(point[4]);

    if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      return null;
    }

    return {
      time,
      open,
      high,
      low,
      close,
    };
  }

  if (point && typeof point === 'object') {
    if (point.open !== undefined && point.high !== undefined && point.low !== undefined && point.close !== undefined) {
      const time = Number(point.time);
      const open = Number(point.open);
      const high = Number(point.high);
      const low = Number(point.low);
      const close = Number(point.close);

      if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        return null;
      }

      return {
        time: Number.isFinite(time) ? time : Date.now(),
        open,
        high,
        low,
        close,
      };
    }
  }

  return null;
};

const pickLatestOHLC = (payload: any[]): LastOHLC | null => {
  const candles = payload
    .map(parseCandlePoint)
    .filter((item): item is ParsedCandlePoint => !!item);

  if (candles.length === 0) {
    return null;
  }

  const latest = candles.reduce((acc, item) => (item.time > acc.time ? item : acc));
  return latest;
};

const formatOHLCValue = (value: number | string) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  return numeric.toFixed(8).replace(/\.?0+$/, '');
};

const formatCompactNumber = (value: number | string, digits: number = 2) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  return numeric.toFixed(digits).replace(/\.?0+$/, '');
};

const formatStrategyUpdatedAt = (value?: string | null): string => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '-';
  }

  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }

  return parsed.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

type DiagnosticLiveState = 'flat' | 'long' | 'short' | 'mixed';
type StrategyDiagnosticStatus = 'ok' | 'warning' | 'error';

type StrategyDiagnosticRow = {
  strategyId: number;
  strategyName: string;
  pair: string;
  runtimeState: string;
  liveState: DiagnosticLiveState;
  lastSignal: string;
  status: StrategyDiagnosticStatus;
  reason: string;
  liveSymbols: string;
};

const normalizePositionSide = (value: unknown): 'long' | 'short' | 'flat' => {
  const side = String(value || '').trim().toLowerCase();
  if (side === 'buy') {
    return 'long';
  }
  if (side === 'sell') {
    return 'short';
  }
  return 'flat';
};

const inferLiveStateForStrategy = (strategy: DDStrategy, positions: any[]): DiagnosticLiveState => {
  const safePositions = Array.isArray(positions) ? positions : [];

  const getOpenSymbolPosition = (symbolRaw: string): any | null => {
    const symbol = String(symbolRaw || '').toUpperCase().trim();
    if (!symbol) {
      return null;
    }

    return safePositions.find((row: any) => {
      const rowSymbol = String(row?.symbol || '').toUpperCase().trim();
      const size = Number(row?.size || 0);
      return rowSymbol === symbol && Number.isFinite(size) && size > 0;
    }) || null;
  };

  const basePosition = getOpenSymbolPosition(strategy.base_symbol);
  if (strategy.market_mode === 'mono') {
    const baseSide = normalizePositionSide(basePosition?.side);
    if (!basePosition || baseSide === 'flat') {
      return 'flat';
    }
    return baseSide;
  }

  const quotePosition = getOpenSymbolPosition(strategy.quote_symbol);
  const baseSide = normalizePositionSide(basePosition?.side);
  const quoteSide = normalizePositionSide(quotePosition?.side);

  if (!basePosition && !quotePosition) {
    return 'flat';
  }

  if (!basePosition || !quotePosition || baseSide === 'flat' || quoteSide === 'flat') {
    return 'mixed';
  }

  if (baseSide === 'long' && quoteSide === 'short') {
    return 'long';
  }

  if (baseSide === 'short' && quoteSide === 'long') {
    return 'short';
  }

  return 'mixed';
};

const buildStrategyDiagnostics = (strategies: DDStrategy[], positions: any[]): StrategyDiagnosticRow[] => {
  return (Array.isArray(strategies) ? strategies : []).map((strategy) => {
    const liveState = inferLiveStateForStrategy(strategy, positions);
    const runtimeState = String(strategy.state || 'flat').toLowerCase();
    const normalizedRuntimeState = runtimeState === 'long' || runtimeState === 'short' ? runtimeState : 'flat';
    const lastSignal = String(strategy.last_signal || '').trim().toLowerCase();

    const strategySymbols = strategy.market_mode === 'mono'
      ? [strategy.base_symbol]
      : [strategy.base_symbol, strategy.quote_symbol]
      .map((symbol) => String(symbol || '').toUpperCase().trim())
      .filter((symbol, index, array) => Boolean(symbol) && array.indexOf(symbol) === index);

    const liveSymbolRows = (Array.isArray(positions) ? positions : [])
      .filter((row: any) => {
        const symbol = String(row?.symbol || '').toUpperCase().trim();
        const size = Number(row?.size || 0);
        return strategySymbols.includes(symbol) && Number.isFinite(size) && size > 0;
      })
      .map((row: any) => {
        const symbol = String(row?.symbol || '').toUpperCase().trim();
        const side = normalizePositionSide(row?.side);
        const size = formatCompactNumber(row?.size, 6);
        return `${symbol}:${side}:${size}`;
      });

    let status: StrategyDiagnosticStatus = 'ok';
    let reason = 'synced';

    if (liveState === 'mixed') {
      status = 'error';
      reason = 'mixed_live_legs';
    } else if (normalizedRuntimeState === 'flat' && liveState !== 'flat') {
      status = 'error';
      reason = 'ghost_live_position';
    } else if (normalizedRuntimeState !== 'flat' && liveState === 'flat') {
      status = 'error';
      reason = 'stale_runtime_state';
    } else if (normalizedRuntimeState !== 'flat' && liveState !== 'flat' && normalizedRuntimeState !== liveState) {
      status = 'error';
      reason = 'side_mismatch';
    } else if (String(strategy.last_error || '').trim()) {
      status = 'warning';
      reason = 'runtime_error_present';
    } else if (lastSignal && lastSignal !== 'none' && normalizedRuntimeState === 'flat' && liveState === 'flat') {
      status = 'warning';
      reason = 'signal_without_position';
    }

    return {
      strategyId: Number(strategy.id || 0),
      strategyName: String(strategy.name || `strategy-${strategy.id}`),
      pair: strategySymbols.join('/'),
      runtimeState: normalizedRuntimeState,
      liveState,
      lastSignal: lastSignal || '-',
      status,
      reason,
      liveSymbols: liveSymbolRows.length > 0 ? liveSymbolRows.join(' | ') : 'flat',
    };
  });
};

const resolveLotUsdt = (
  runtimeLotUsdt: number | null | undefined,
  maxDeposit: number,
  lotPercent: number
): { value: number | null; estimated: boolean } => {
  if (runtimeLotUsdt !== null && runtimeLotUsdt !== undefined && Number.isFinite(Number(runtimeLotUsdt))) {
    return { value: Number(runtimeLotUsdt), estimated: false };
  }

  const deposit = Number(maxDeposit);
  const percent = Number(lotPercent);
  if (!Number.isFinite(deposit) || !Number.isFinite(percent) || deposit <= 0 || percent < 0) {
    return { value: null, estimated: false };
  }

  return {
    value: (deposit * percent) / 100,
    estimated: true,
  };
};

const normalizeTimestampMs = (value: any): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric > 9999999999 ? Math.floor(numeric) : Math.floor(numeric * 1000);
};

const buildStrategyTradeMarkers = (
  trades: TradeHistoryRow[],
  symbols: string[],
  markerLimit: number = 500
): ChartMarker[] => {
  if (!Array.isArray(trades) || trades.length === 0 || symbols.length === 0) {
    return [];
  }

  const symbolSet = new Set(symbols.map((symbol) => String(symbol || '').toUpperCase()));

  return trades
    .filter((trade) => symbolSet.has(String(trade.symbol || '').toUpperCase()))
    .map((trade, index) => {
      const timeMs = normalizeTimestampMs(trade.timestamp);
      if (timeMs === null) {
        return null;
      }

      const sideRaw = String(trade.side || '').toLowerCase();
      const isBuy = sideRaw === 'buy';

      return {
        id: `${trade.tradeId || trade.orderId || `trade-${index}`}-${trade.symbol}-${timeMs}`,
        time: timeMs,
        color: isBuy ? '#16a34a' : '#dc2626',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        position: isBuy ? 'belowBar' : 'aboveBar',
        text: `${isBuy ? 'B' : 'S'} ${trade.symbol}`,
      } as ChartMarker;
    })
    .filter((marker): marker is ChartMarker => !!marker)
    .sort((left, right) => left.time - right.time)
    .slice(-Math.max(10, Math.min(2000, markerLimit)));
};

type DonchianSnapshot = {
  high: number;
  low: number;
  center: number;
  highSeries: Array<{ time: number; value: number }>;
  lowSeries: Array<{ time: number; value: number }>;
  centerSeries: Array<{ time: number; value: number }>;
  overlays: OverlayLine[];
};

type TpWaveSnapshot = {
  longSeries: Array<{ time: number; value: number }>;
  shortSeries: Array<{ time: number; value: number }>;
  overlays: OverlayLine[];
};

type MarginStats = {
  walletUsd: number;
  unrealizedPnlUsd: number;
  equityWithUpnlUsd: number;
  equityUsd: number;
  notionalUsd: number;
  marginUsedUsd: number;
  effectiveLeverage: number;
  marginLoadPercent: number;
};

type MonitoringSnapshot = {
  id: number;
  api_key_id: number;
  exchange: string;
  equity_usd: number;
  unrealized_pnl: number;
  margin_used_usd: number;
  margin_load_percent: number;
  effective_leverage: number;
  notional_usd: number;
  drawdown_percent: number;
  recorded_at: string;
};

type MonitoringPayload = {
  points: MonitoringSnapshot[];
  latest: MonitoringSnapshot | null;
};

const normalizeOverlayTime = (time: number): number => {
  const numeric = Number(time);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
};

const pickOverlayValueAtTime = (
  series: Array<{ time: number; value: number }>,
  hoverTime?: number
): number | null => {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }

  if (!Number.isFinite(hoverTime as number)) {
    return series[series.length - 1].value;
  }

  const normalizedHover = normalizeOverlayTime(Number(hoverTime));
  let best = series[series.length - 1];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const point of series) {
    const distance = Math.abs(normalizeOverlayTime(point.time) - normalizedHover);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }

  return best.value;
};

const buildDonchianSnapshot = (
  payload: any[],
  length: number,
  source: DetectionSource,
  idPrefix: string
): DonchianSnapshot | null => {
  const safeLength = Math.max(2, Math.floor(length));
  const candles = payload
    .map(parseCandlePoint)
    .filter((item): item is ParsedCandlePoint => !!item)
    .sort((a, b) => a.time - b.time);

  if (candles.length < safeLength) {
    return null;
  }

  const highData: Array<{ time: number; value: number }> = [];
  const lowData: Array<{ time: number; value: number }> = [];
  const centerData: Array<{ time: number; value: number }> = [];

  for (let i = 0; i < candles.length; i += 1) {
    // TV parity: Donchian window is based on previous bars (equivalent to [1] shift).
    const end = i - 1;
    const start = end - safeLength + 1;
    if (start < 0 || end < 0) {
      continue;
    }

    const window = candles.slice(start, end + 1);
    if (window.length < safeLength) {
      continue;
    }

    const highs = source === 'close' ? window.map((item) => item.close) : window.map((item) => item.high);
    const lows = source === 'close' ? window.map((item) => item.close) : window.map((item) => item.low);

    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const center = (high + low) / 2;

    highData.push({ time: candles[i].time, value: high });
    lowData.push({ time: candles[i].time, value: low });
    centerData.push({ time: candles[i].time, value: center });
  }

  const latestHigh = highData[highData.length - 1];
  const latestLow = lowData[lowData.length - 1];
  const latestCenter = centerData[centerData.length - 1];

  if (!latestHigh || !latestLow || !latestCenter) {
    return null;
  }

  return {
    high: latestHigh.value,
    low: latestLow.value,
    center: latestCenter.value,
    highSeries: highData,
    lowSeries: lowData,
    centerSeries: centerData,
    overlays: [
      {
        id: `${idPrefix}:donchian_high`,
        color: '#1f78ff',
        lineWidth: 2,
        data: highData,
      },
      {
        id: `${idPrefix}:donchian_low`,
        color: '#1f78ff',
        lineWidth: 2,
        data: lowData,
      },
      {
        id: `${idPrefix}:donchian_center`,
        color: '#ff8c00',
        lineWidth: 1,
        data: centerData,
      },
    ],
  };
};

const buildConstantOverlay = (
  payload: any[],
  id: string,
  color: string,
  value: number,
  lineWidth: number = 1
): OverlayLine | null => {
  const candles = payload
    .map(parseCandlePoint)
    .filter((item): item is ParsedCandlePoint => !!item)
    .sort((a, b) => a.time - b.time);

  if (candles.length === 0 || !Number.isFinite(value)) {
    return null;
  }

  return {
    id,
    color,
    lineWidth,
    data: candles.map((item) => ({
      time: item.time,
      value,
    })),
  };
};

const buildEntryOverlay = (payload: any[], id: string, entryRatio: number): OverlayLine | null => {
  return buildConstantOverlay(payload, id, '#13c2c2', entryRatio, 1);
};

const toFiniteNumber = (value: any, fallback: number = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const buildTpWaveSnapshot = (
  donchian: DonchianSnapshot | null,
  takeProfitPercent: number,
  idPrefix: string
): TpWaveSnapshot | null => {
  if (!donchian) {
    return null;
  }

  const factor = 1 + Math.max(0, toFiniteNumber(takeProfitPercent, 0)) / 100;
  if (!Number.isFinite(factor) || factor <= 0) {
    return null;
  }

  const longSeries = donchian.highSeries.map((point) => ({
    time: point.time,
    value: point.value * factor,
  }));

  const shortSeries = donchian.lowSeries.map((point) => ({
    time: point.time,
    value: point.value / factor,
  }));

  return {
    longSeries,
    shortSeries,
    overlays: [
      {
        id: `${idPrefix}:tp_long_wave`,
        color: '#52c41a',
        lineWidth: 1,
        data: longSeries,
      },
      {
        id: `${idPrefix}:tp_short_wave`,
        color: '#faad14',
        lineWidth: 1,
        data: shortSeries,
      },
    ],
  };
};

const getPositionNotionalUsd = (position: any): number => {
  const positionValue = Math.abs(toFiniteNumber(position?.positionValue, NaN));
  if (Number.isFinite(positionValue) && positionValue > 0) {
    return positionValue;
  }

  const size = Math.abs(toFiniteNumber(position?.size, NaN));
  const markPrice = toFiniteNumber(position?.markPrice, NaN);
  const avgPrice = toFiniteNumber(position?.avgPrice, NaN);
  const price = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : avgPrice;

  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return 0;
  }

  return size * price;
};

const calculateMarginStats = (balances: any[], positions: any[]): MarginStats => {
  const safeBalances = Array.isArray(balances) ? balances : [];
  const safePositions = Array.isArray(positions) ? positions : [];

  const walletUsd = safeBalances.reduce((sum, balance) => {
    const usdValue = toFiniteNumber(balance?.usdValue, NaN);
    if (Number.isFinite(usdValue) && usdValue > 0) {
      return sum + usdValue;
    }

    const coin = String(balance?.coin || '').toUpperCase();
    const walletBalance = toFiniteNumber(balance?.walletBalance, NaN);
    if ((coin === 'USDT' || coin === 'USDC' || coin === 'USD') && Number.isFinite(walletBalance) && walletBalance > 0) {
      return sum + walletBalance;
    }

    return sum;
  }, 0);

  let notionalUsd = 0;
  let marginUsedUsd = 0;
  let unrealizedPnlUsd = 0;

  for (const position of safePositions) {
    const notional = getPositionNotionalUsd(position);

    if (Number.isFinite(notional) && notional > 0) {
      const leverage = Math.max(1, toFiniteNumber(position?.leverage, 1));
      notionalUsd += notional;
      marginUsedUsd += notional / leverage;
    }

    const upnl = toFiniteNumber(position?.unrealisedPnl ?? position?.unrealizedPnl, NaN);
    if (Number.isFinite(upnl)) {
      unrealizedPnlUsd += upnl;
    }
  }

  const equityWithUpnlUsd = walletUsd + unrealizedPnlUsd;
  const baseEquityUsd = equityWithUpnlUsd > 0 ? equityWithUpnlUsd : walletUsd;

  const effectiveLeverage = baseEquityUsd > 0 ? notionalUsd / baseEquityUsd : 0;
  const marginLoadPercent = baseEquityUsd > 0 ? (marginUsedUsd / baseEquityUsd) * 100 : 0;

  return {
    walletUsd,
    unrealizedPnlUsd,
    equityWithUpnlUsd,
    equityUsd: walletUsd,
    notionalUsd,
    marginUsedUsd,
    effectiveLeverage,
    marginLoadPercent,
  };
};

const parseMonitoringSnapshot = (raw: any): MonitoringSnapshot => {
  const asNumber = (value: any): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };

  return {
    id: Number(raw?.id || 0),
    api_key_id: Number(raw?.api_key_id || 0),
    exchange: String(raw?.exchange || ''),
    equity_usd: asNumber(raw?.equity_usd),
    unrealized_pnl: asNumber(raw?.unrealized_pnl),
    margin_used_usd: asNumber(raw?.margin_used_usd),
    margin_load_percent: asNumber(raw?.margin_load_percent),
    effective_leverage: asNumber(raw?.effective_leverage),
    notional_usd: asNumber(raw?.notional_usd),
    drawdown_percent: asNumber(raw?.drawdown_percent),
    recorded_at: String(raw?.recorded_at || ''),
  };
};

const toLineSeriesData = (
  points: MonitoringSnapshot[],
  pickValue: (point: MonitoringSnapshot) => number
) => {
  return points
    .map((point) => {
      const value = Number(pickValue(point));
      const timeMs = Date.parse(point.recorded_at);

      if (!Number.isFinite(value) || !Number.isFinite(timeMs)) {
        return null;
      }

      return {
        time: Math.floor(timeMs / 1000),
        open: value,
        high: value,
        low: value,
        close: value,
      };
    })
    .filter((point): point is { time: number; open: number; high: number; low: number; close: number } => !!point);
};

const isSameHoverOHLC = (left: HoverOHLC | null | undefined, right: HoverOHLC | null | undefined): boolean => {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  const epsilon = 1e-9;

  return (
    left.time === right.time &&
    Math.abs(left.open - right.open) < epsilon &&
    Math.abs(left.high - right.high) < epsilon &&
    Math.abs(left.low - right.low) < epsilon &&
    Math.abs(left.close - right.close) < epsilon
  );
};

const getStrategyUiDefaults = (strategyType: StrategyKind) => {
  if (strategyType === 'stat_arb_zscore') {
    return {
      takeProfitPercent: 0,
      channelLength: 120,
      detectionSource: 'close' as DetectionSource,
    };
  }

  return {
    takeProfitPercent: 7.5,
    channelLength: 50,
    detectionSource: 'close' as DetectionSource,
  };
};

const mergeDirtyStrategyWithServer = (serverStrategy: DDStrategy, localStrategy?: DDStrategy | null): DDStrategy => {
  if (!localStrategy?.isDirty) {
    return serverStrategy;
  }

  return {
    ...serverStrategy,
    name: localStrategy.name,
    display_on_chart: localStrategy.display_on_chart,
    take_profit_percent: localStrategy.take_profit_percent,
    price_channel_length: localStrategy.price_channel_length,
    detection_source: localStrategy.detection_source,
    base_symbol: localStrategy.base_symbol,
    quote_symbol: localStrategy.quote_symbol,
    interval: localStrategy.interval,
    base_coef: localStrategy.base_coef,
    quote_coef: localStrategy.quote_coef,
    show_chart: localStrategy.show_chart,
    show_settings: localStrategy.show_settings,
    show_indicators: localStrategy.show_indicators,
    show_positions_on_chart: localStrategy.show_positions_on_chart,
    show_trades_on_chart: localStrategy.show_trades_on_chart,
    show_values_each_bar: localStrategy.show_values_each_bar,
    auto_update: localStrategy.auto_update,
    long_enabled: localStrategy.long_enabled,
    short_enabled: localStrategy.short_enabled,
    lot_long_percent: localStrategy.lot_long_percent,
    lot_short_percent: localStrategy.lot_short_percent,
    max_deposit: localStrategy.max_deposit,
    margin_type: localStrategy.margin_type,
    leverage: localStrategy.leverage,
    fixed_lot: localStrategy.fixed_lot,
    reinvest_percent: localStrategy.reinvest_percent,
    isDirty: true,
  };
};

const parseStrategy = (raw: any): DDStrategy => {
  const readBoolean = (value: any, fallback: boolean): boolean => {
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
    return fallback;
  };

  const readNumber = (value: any, fallback: number): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };

  const nameText = String(raw?.name || '').toUpperCase();
  const modeRaw = String(raw?.market_mode || '').trim().toLowerCase();
  const inferredMarketMode: 'mono' | 'synthetic' =
    modeRaw === 'mono'
      ? 'mono'
      : modeRaw === 'synthetic'
        ? 'synthetic'
        : nameText.includes('::MONO::')
          ? 'mono'
          : nameText.includes('::SYNTHETIC::')
            ? 'synthetic'
            : (String(raw?.quote_symbol || '').trim() ? 'synthetic' : 'mono');

  const strategyType: StrategyKind = String(raw?.strategy_type || 'DD_BattleToads') === 'zz_breakout'
    ? 'zz_breakout'
    : String(raw?.strategy_type || 'DD_BattleToads') === 'stat_arb_zscore'
      ? 'stat_arb_zscore'
      : 'DD_BattleToads';
  const strategyDefaults = getStrategyUiDefaults(strategyType);

  const normalizedQuoteSymbol = inferredMarketMode === 'mono'
    ? ''
    : String(raw?.quote_symbol || 'ETHUSDT').toUpperCase();

  return {
    id: Number(raw?.id || 0),
    name: String(raw?.name || 'DD_BattleToads'),
    strategy_type: strategyType,
    market_mode: inferredMarketMode,
    is_active: readBoolean(raw?.is_active, true),
    display_on_chart: readBoolean(raw?.display_on_chart, true),
    take_profit_percent: readNumber(raw?.take_profit_percent, strategyDefaults.takeProfitPercent),
    price_channel_length: Math.max(2, Math.floor(readNumber(raw?.price_channel_length, strategyDefaults.channelLength))),
    detection_source: String(raw?.detection_source || strategyDefaults.detectionSource) === 'wick' ? 'wick' : 'close',
    base_symbol: String(raw?.base_symbol || 'BTCUSDT').toUpperCase(),
    quote_symbol: normalizedQuoteSymbol,
    interval: String(raw?.interval || '1h'),
    base_coef: readNumber(raw?.base_coef, 1),
    quote_coef: readNumber(raw?.quote_coef, 1),
    show_chart: readBoolean(raw?.show_chart, true),
    show_settings: readBoolean(raw?.show_settings, true),
    show_indicators: readBoolean(raw?.show_indicators, true),
    show_positions_on_chart: readBoolean(raw?.show_positions_on_chart, true),
    show_trades_on_chart: readBoolean(raw?.show_trades_on_chart, false),
    show_values_each_bar: readBoolean(raw?.show_values_each_bar, false),
    auto_update: readBoolean(raw?.auto_update, true),
    long_enabled: readBoolean(raw?.long_enabled, true),
    short_enabled: readBoolean(raw?.short_enabled, true),
    lot_long_percent: readNumber(raw?.lot_long_percent, 100),
    lot_short_percent: readNumber(raw?.lot_short_percent, 100),
    max_deposit: readNumber(raw?.max_deposit, 1000),
    margin_type: String(raw?.margin_type || 'cross') === 'isolated' ? 'isolated' : 'cross',
    leverage: Math.max(1, readNumber(raw?.leverage, 1)),
    fixed_lot: readBoolean(raw?.fixed_lot, false),
    reinvest_percent: readNumber(raw?.reinvest_percent, 0),
    state: String(raw?.state || 'flat') === 'long' ? 'long' : String(raw?.state || 'flat') === 'short' ? 'short' : 'flat',
    entry_ratio: raw?.entry_ratio !== undefined && raw?.entry_ratio !== null ? readNumber(raw?.entry_ratio, 0) : null,
    last_signal: raw?.last_signal ?? null,
    last_action: raw?.last_action ?? null,
    last_error: raw?.last_error ?? null,
    updated_at: raw?.updated_at ?? null,
    lot_long_usdt: raw?.lot_long_usdt !== undefined && raw?.lot_long_usdt !== null ? readNumber(raw?.lot_long_usdt, 0) : null,
    lot_short_usdt: raw?.lot_short_usdt !== undefined && raw?.lot_short_usdt !== null ? readNumber(raw?.lot_short_usdt, 0) : null,
    lot_balance_usdt: raw?.lot_balance_usdt !== undefined && raw?.lot_balance_usdt !== null ? readNumber(raw?.lot_balance_usdt, 0) : null,
    is_runtime: readBoolean(raw?.is_runtime, false),
    is_archived: readBoolean(raw?.is_archived, false),
    origin: String(raw?.origin || 'manual'),
    isDirty: false,
  };
};

const Dashboard: React.FC = () => {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [selectedApiKey, setSelectedApiKey] = useState<string>('');
  const [chartDataByKey, setChartDataByKey] = useState<{ [key: string]: any[] }>({});
  const [strategyChartDataByKey, setStrategyChartDataByKey] = useState<{ [key: string]: { [strategyId: string]: any[] } }>({});
  const [strategyChartLoadingByKey, setStrategyChartLoadingByKey] = useState<{ [key: string]: { [strategyId: string]: boolean } }>({});
  const [strategyChartErrorByKey, setStrategyChartErrorByKey] = useState<{ [key: string]: { [strategyId: string]: string } }>({});
  const [lastOHLCByKey, setLastOHLCByKey] = useState<{ [key: string]: LastOHLC | null }>({});
  const [hoverOHLCByKey, setHoverOHLCByKey] = useState<{ [key: string]: HoverOHLC | null }>({});
  const [strategyHoverOHLCByKey, setStrategyHoverOHLCByKey] = useState<{ [key: string]: { [strategyId: string]: HoverOHLC | null } }>({});
  const [keyStatuses, setKeyStatuses] = useState<{ [key: string]: KeyStatus }>({});
  const [apiKeyToggles, setApiKeyToggles] = useState<{ [key: string]: boolean }>({});
  const [balances, setBalances] = useState<{ [key: string]: any[] }>({});
  const [positionsByKey, setPositionsByKey] = useState<{ [key: string]: any[] }>({});
  const [tradesByKey, setTradesByKey] = useState<{ [key: string]: TradeHistoryRow[] }>({});
  const [chartSettings, setChartSettings] = useState<{ [key: string]: ChartSetting }>({});
  const [activePanel, setActivePanel] = useState<string[]>([]);
  const [chartLoadingKey, setChartLoadingKey] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<{ [key: string]: string[] }>({});
  const [syntheticErrorByKey, setSyntheticErrorByKey] = useState<{ [key: string]: string }>({});
  const [balancesError, setBalancesError] = useState<{ [key: string]: string }>({});
  const [symbolsError, setSymbolsError] = useState<{ [key: string]: string }>({});
  const [strategiesByKey, setStrategiesByKey] = useState<{ [key: string]: DDStrategy[] }>({});
  const [strategyRenderLimitByKey, setStrategyRenderLimitByKey] = useState<{ [key: string]: number }>({});
  const [strategiesTotalByKey, setStrategiesTotalByKey] = useState<{ [key: string]: number }>({});
  const [strategiesRunningByKey, setStrategiesRunningByKey] = useState<{ [key: string]: number }>({});
  const [fullStrategiesLoadedByKey, setFullStrategiesLoadedByKey] = useState<{ [key: string]: boolean }>({});
  const [strategiesLoadingByKey, setStrategiesLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const [strategiesErrorByKey, setStrategiesErrorByKey] = useState<{ [key: string]: string }>({});
  const [strategyDetailsLoadedByKey, setStrategyDetailsLoadedByKey] = useState<{ [key: string]: { [strategyId: string]: boolean } }>({});
  const [strategyDetailsLoadingByKey, setStrategyDetailsLoadingByKey] = useState<{ [key: string]: { [strategyId: string]: boolean } }>({});
  const [strategyDetailsErrorByKey, setStrategyDetailsErrorByKey] = useState<{ [key: string]: { [strategyId: string]: string } }>({});
  const [activeStrategyPanelsByKey, setActiveStrategyPanelsByKey] = useState<{ [key: string]: string[] }>({});
  const [newStrategyNameByKey, setNewStrategyNameByKey] = useState<{ [key: string]: string }>({});
  const [newSetStrategyTypeByKey, setNewSetStrategyTypeByKey] = useState<{ [key: string]: StrategyKind }>({});
  const [strategyActionLoading, setStrategyActionLoading] = useState<{ [key: string]: boolean }>({});
  const [accountRefreshLoadingByKey, setAccountRefreshLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const [refreshAllAccountsLoading, setRefreshAllAccountsLoading] = useState<boolean>(false);
  const [monitoringByKey, setMonitoringByKey] = useState<{ [key: string]: MonitoringPayload }>({});
  const [monitoringLoadingByKey, setMonitoringLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const [monitoringErrorByKey, setMonitoringErrorByKey] = useState<{ [key: string]: string }>({});
  const [keyActionLoading, setKeyActionLoading] = useState<{ [key: string]: boolean }>({});
  const [globalActionLoading, setGlobalActionLoading] = useState<{ [key: string]: boolean }>({});
  const [copySourceByTargetKey, setCopySourceByTargetKey] = useState<{ [key: string]: string }>({});
  const [copyActionLoadingByKey, setCopyActionLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const [showArchivedByKey, setShowArchivedByKey] = useState<{ [key: string]: boolean }>({});
  const [runtimeOnlyByKey, setRuntimeOnlyByKey] = useState<{ [key: string]: boolean }>({});
  const [archiveActionLoadingByKey, setArchiveActionLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const requestLocksRef = useRef<Record<string, boolean>>({});

  const isApiKeyActive = (keyName: string): boolean => apiKeyToggles[keyName] ?? true;
  const acquireRequestLock = (lockKey: string): boolean => {
    if (requestLocksRef.current[lockKey]) {
      return false;
    }

    requestLocksRef.current[lockKey] = true;
    return true;
  };

  const releaseRequestLock = (lockKey: string) => {
    delete requestLocksRef.current[lockKey];
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const password = localStorage.getItem('password');
    if (!password) {
      window.location.href = '/login';
      return;
    }

    axios.defaults.headers.common.Authorization = `Bearer ${password}`;

    const savedSelectedKey = localStorage.getItem('selectedApiKey');
    if (savedSelectedKey) {
      setSelectedApiKey(savedSelectedKey);
    }

    const savedApiKeyToggles = localStorage.getItem('apiKeyToggles');
    if (savedApiKeyToggles) {
      try {
        setApiKeyToggles(JSON.parse(savedApiKeyToggles));
      } catch {
        setApiKeyToggles({});
      }
    }

    const savedChartSettings = localStorage.getItem('chartSettings');
    if (savedChartSettings) {
      try {
        setChartSettings(JSON.parse(savedChartSettings));
      } catch {
        setChartSettings({});
      }
    }

    void fetchApiKeys();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selectedApiKey || !isApiKeyActive(selectedApiKey)) {
      return;
    }

    const selectedSettings = chartSettings[selectedApiKey] || defaultChartSetting();
    if (!selectedSettings) {
      return;
    }

    const normalizedUpdateSec = normalizeUpdateSec(selectedSettings.updateSec);
    if (normalizedUpdateSec <= 0) {
      return;
    }

    const selectedStrategies = strategiesByKey[selectedApiKey] || [];
    const hasVisibleMainChart = selectedSettings.showChart !== false;
    const hasVisibleMainSettings = selectedSettings.showSettings !== false;
    const hasVisibleMonitoring = selectedSettings.showMonitoring !== false;
    const hasVisibleStrategyChart = selectedStrategies.some((strategy) => strategy.show_chart);
    const hasTradeMarkersEnabled = selectedStrategies.some((strategy) => strategy.show_chart && strategy.show_trades_on_chart);
    const hasVisibleStrategyBlock = selectedStrategies.some((strategy) => strategy.show_settings || strategy.show_chart);
    const hasAnyVisibleBlock = hasVisibleMainChart || hasVisibleMainSettings || hasVisibleStrategyBlock;
    const shouldRefreshChart = hasVisibleMainChart || hasVisibleStrategyChart;
    const shouldRefreshStrategies = hasAnyVisibleBlock && selectedStrategies.some(
      (strategy) => strategy.auto_update && (strategy.show_settings || strategy.show_chart)
    );
    const shouldRefreshMonitoring = hasVisibleMonitoring;
    const shouldRefreshTrades = hasTradeMarkersEnabled;

    if (!shouldRefreshChart && !shouldRefreshStrategies && !shouldRefreshMonitoring && !shouldRefreshTrades) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (shouldRefreshChart) {
        void loadChartForKey(selectedApiKey, { silent: true });
      }

      const expandedPanels = new Set(activeStrategyPanelsByKey[selectedApiKey] || []);
      selectedStrategies
        .filter((strategy) => expandedPanels.has(String(strategy.id)) && strategy.show_chart)
        .forEach((strategy) => {
          void loadStrategyChart(selectedApiKey, strategy, { silent: true, force: true });
        });

      if (shouldRefreshStrategies) {
        void fetchStrategies(selectedApiKey, { silent: true });
      }

      if (shouldRefreshMonitoring) {
        void fetchMonitoring(selectedApiKey, { capture: true, silent: true });
      }

      if (shouldRefreshTrades) {
        void fetchTradesForKey(selectedApiKey, { silent: true });
      }
    }, normalizedUpdateSec * 1000);

    return () => window.clearInterval(intervalId);
  }, [selectedApiKey, chartSettings, apiKeyToggles, strategiesByKey, activeStrategyPanelsByKey]);

  const persistChartSettings = (nextSettings: { [key: string]: ChartSetting }) => {
    localStorage.setItem('chartSettings', JSON.stringify(nextSettings));
  };

  const fetchApiKeys = async () => {
    try {
      const res = await axios.get('/api/api-keys');
      const keys: ApiKey[] = Array.isArray(res.data) ? res.data : [];
      setApiKeys(keys);

      const hasSelectedKey = Boolean(selectedApiKey) && keys.some((key) => key.name === selectedApiKey);
      const preferredKeyName = hasSelectedKey ? selectedApiKey : (keys[0]?.name || '');

      let storedToggles: { [key: string]: boolean } = {};
      const rawStoredToggles = localStorage.getItem('apiKeyToggles');
      if (rawStoredToggles) {
        try {
          storedToggles = JSON.parse(rawStoredToggles);
        } catch {
          storedToggles = {};
        }
      }

      const mergedToggles: { [key: string]: boolean } = { ...storedToggles };
      keys.forEach((key) => {
        if (mergedToggles[key.name] === undefined) {
          mergedToggles[key.name] = true;
        }
      });
      setApiKeyToggles(mergedToggles);
      localStorage.setItem('apiKeyToggles', JSON.stringify(mergedToggles));

      setChartSettings((prev) => {
        const next = { ...prev };
        keys.forEach((key) => {
          const merged = {
            ...defaultChartSetting(),
            ...(next[key.name] || {}),
          };

          merged.updateSec = normalizeUpdateSec(merged.updateSec);
          next[key.name] = {
            ...merged,
          };
        });
        persistChartSettings(next);
        return next;
      });

      setCopySourceByTargetKey((prev) => {
        const next = { ...prev };
        keys.forEach((target) => {
          if (!next[target.name] || next[target.name] === target.name) {
            const source = keys.find((candidate) => candidate.name !== target.name);
            if (source) {
              next[target.name] = source.name;
            }
          }
        });
        return next;
      });

      setRuntimeOnlyByKey((prev) => {
        const next = { ...prev };
        keys.forEach((key) => {
          if (next[key.name] === undefined) {
            next[key.name] = true;
          }
        });
        return next;
      });

      if (keys.length > 0 && (!selectedApiKey || !keys.some((key) => key.name === selectedApiKey))) {
        setSelectedApiKey(keys[0].name);
        localStorage.setItem('selectedApiKey', keys[0].name);
      }

      // Prefetch lightweight strategy counts for instant badge display
      try {
        const countsRes = await axios.get('/api/strategies/counts');
        const counts = countsRes.data || {};
        const totalPatch: Record<string, number> = {};
        const runningPatch: Record<string, number> = {};
        for (const [kn, v] of Object.entries(counts)) {
          const c = v as { total: number; running: number };
          totalPatch[kn] = c.total;
          runningPatch[kn] = c.running;
        }
        setStrategiesTotalByKey((prev) => ({ ...prev, ...totalPatch }));
        setStrategiesRunningByKey((prev) => ({ ...prev, ...runningPatch }));
      } catch { /* counts will be filled by individual fetches */ }

      for (const key of keys) {
        const panelOpened = activePanel.includes(String(key.id));
        const shouldLoadFullStrategies = key.name === preferredKeyName || panelOpened;
        const keySettings = chartSettings[key.name] || defaultChartSetting();
        const isUnboundResearchLike = !key.tenantDisplayName && /RESEARCH|_SOURCE/i.test(String(key.name || ''));

        if (isUnboundResearchLike) {
          setKeyStatuses((prev) => ({ ...prev, [key.name]: { status: 'warning', message: 'No tenant binding' } }));
          setBalances((prev) => ({ ...prev, [key.name]: [] }));
          setBalancesError((prev) => ({ ...prev, [key.name]: '' }));
          setSymbols((prev) => ({ ...prev, [key.name]: [] }));
          setSymbolsError((prev) => ({ ...prev, [key.name]: '' }));
          setHoverOHLCByKey((prev) => ({ ...prev, [key.name]: null }));
          setSyntheticErrorByKey((prev) => ({ ...prev, [key.name]: '' }));
          setMonitoringByKey((prev) => ({
            ...prev,
            [key.name]: { points: [], latest: null },
          }));
          setTradesByKey((prev) => ({ ...prev, [key.name]: [] }));
          setMonitoringErrorByKey((prev) => ({ ...prev, [key.name]: '' }));
          continue;
        }

        if (mergedToggles[key.name]) {
          void fetchKeyStatus(key.name);
          void fetchBalances(key.name);
          void fetchPositionsForKey(key.name);
          void fetchTradesForKey(key.name, { silent: true });
          void fetchSymbols(key.name);
          // Always fetch at least a lightweight strategy count for dashboard badges
          if (shouldLoadFullStrategies) {
            void fetchStrategies(key.name);
          } else {
            void fetchStrategies(key.name, { silent: true });
          }
          if (shouldLoadFullStrategies && keySettings.showMonitoring !== false) {
            void fetchMonitoring(key.name, { capture: true });
          }
        } else {
          setKeyStatuses((prev) => ({ ...prev, [key.name]: { status: 'warning', message: 'Disabled' } }));
          setBalances((prev) => ({ ...prev, [key.name]: [] }));
          setBalancesError((prev) => ({ ...prev, [key.name]: '' }));
          setSymbols((prev) => ({ ...prev, [key.name]: [] }));
          setSymbolsError((prev) => ({ ...prev, [key.name]: '' }));
          setHoverOHLCByKey((prev) => ({ ...prev, [key.name]: null }));
          setSyntheticErrorByKey((prev) => ({ ...prev, [key.name]: '' }));
          setMonitoringByKey((prev) => ({
            ...prev,
            [key.name]: { points: [], latest: null },
          }));
          setTradesByKey((prev) => ({ ...prev, [key.name]: [] }));
          setMonitoringErrorByKey((prev) => ({ ...prev, [key.name]: '' }));
        }
      }
    } catch (error) {
      console.error(error);
    }
  };

  const fetchKeyStatus = async (keyName: string) => {
    try {
      const res = await axios.get(`/api/key-status/${keyName}`);
      setKeyStatuses((prev) => ({ ...prev, [keyName]: res.data }));
    } catch (error: any) {
      const message = String(
        error?.response?.data?.message
        || error?.response?.data?.error
        || 'Error fetching status'
      );
      setKeyStatuses((prev) => ({
        ...prev,
        [keyName]: { status: 'critical', message },
      }));
    }
  };

  const fetchBalances = async (keyName: string) => {
    if (!isApiKeyActive(keyName)) {
      return;
    }

    try {
      const res = await axios.get(`/api/balances/${keyName}`);
      const payload = Array.isArray(res.data) ? res.data : [];
      setBalances((prev) => ({ ...prev, [keyName]: payload }));
      setBalancesError((prev) => ({ ...prev, [keyName]: '' }));
    } catch (error: any) {
      console.error(error);
      setBalances((prev) => ({ ...prev, [keyName]: [] }));
      setBalancesError((prev) => ({ ...prev, [keyName]: error.response?.data?.error || 'Failed to load balances' }));
    }
  };

  const fetchPositionsForKey = async (keyName: string) => {
    if (!isApiKeyActive(keyName)) {
      return;
    }

    try {
      const res = await axios.get(`/api/positions/${keyName}`);
      const payload = Array.isArray(res.data) ? res.data : [];
      setPositionsByKey((prev) => ({ ...prev, [keyName]: payload }));
    } catch (error) {
      console.error(error);
      setPositionsByKey((prev) => ({ ...prev, [keyName]: [] }));
    }
  };

  const fetchTradesForKey = async (keyName: string, options?: { silent?: boolean }) => {
    if (!isApiKeyActive(keyName)) {
      return;
    }

    const requestLockKey = `trades:${keyName}`;
    if (!acquireRequestLock(requestLockKey)) {
      return;
    }

    try {
      const res = await axios.get(`/api/trades/${keyName}`, {
        params: {
          limit: 200,
        },
      });

      const raw = Array.isArray(res.data) ? res.data : [];
      const payload: TradeHistoryRow[] = raw.map((trade: any, index: number) => ({
        tradeId: String(trade.tradeId || `trade_${index}`),
        orderId: String(trade.orderId || ''),
        symbol: String(trade.symbol || ''),
        side: String(trade.side || 'Buy') as 'Buy' | 'Sell',
        price: String(trade.price || '0'),
        qty: String(trade.qty || '0'),
        notional: String(trade.notional || '0'),
        fee: String(trade.fee || '0'),
        feeCurrency: String(trade.feeCurrency || 'USDT'),
        realizedPnl: String(trade.realizedPnl || '0'),
        isMaker: Boolean(trade.isMaker),
        timestamp: String(trade.timestamp || '0'),
      }));
      setTradesByKey((prev) => ({ ...prev, [keyName]: payload }));
    } catch (error) {
      if (options?.silent !== true) {
        console.error(error);
      }
      setTradesByKey((prev) => ({ ...prev, [keyName]: [] }));
    } finally {
      releaseRequestLock(requestLockKey);
    }
  };

  const fetchMonitoring = async (
    keyName: string,
    options?: { capture?: boolean; silent?: boolean }
  ) => {
    if (!isApiKeyActive(keyName)) {
      return;
    }

    const capture = options?.capture === true;
    const silent = options?.silent === true;
    const requestLockKey = `monitoring:${keyName}`;

    if (!acquireRequestLock(requestLockKey)) {
      return;
    }

    if (!silent) {
      setMonitoringLoadingByKey((prev) => ({ ...prev, [keyName]: true }));
      setMonitoringErrorByKey((prev) => ({ ...prev, [keyName]: '' }));
    }

    try {
      const res = await axios.get(`/api/monitoring/${keyName}`, {
        params: {
          limit: 240,
          capture: capture ? 1 : 0,
        },
      });

      const pointsRaw = Array.isArray(res?.data?.points) ? res.data.points : [];
      const points = pointsRaw.map(parseMonitoringSnapshot);
      const latest = res?.data?.latest ? parseMonitoringSnapshot(res.data.latest) : (points.length > 0 ? points[points.length - 1] : null);

      setMonitoringByKey((prev) => ({
        ...prev,
        [keyName]: {
          points,
          latest,
        },
      }));
      setMonitoringErrorByKey((prev) => ({ ...prev, [keyName]: '' }));
    } catch (error: any) {
      console.error(error);
      setMonitoringErrorByKey((prev) => ({
        ...prev,
        [keyName]: error?.response?.data?.error || 'Failed to load monitoring data',
      }));
      if (!silent) {
        setMonitoringByKey((prev) => ({
          ...prev,
          [keyName]: {
            points: [],
            latest: null,
          },
        }));
      }
    } finally {
      releaseRequestLock(requestLockKey);
      if (!silent) {
        setMonitoringLoadingByKey((prev) => ({ ...prev, [keyName]: false }));
      }
    }
  };

  const fetchSymbols = async (keyName: string) => {
    if (!isApiKeyActive(keyName)) {
      return;
    }

    try {
      const res = await axios.get(`/api/symbols/${keyName}`);
      const payload = Array.isArray(res.data) ? res.data : [];
      setSymbols((prev) => ({ ...prev, [keyName]: payload }));
      setSymbolsError((prev) => ({ ...prev, [keyName]: '' }));
    } catch (error: any) {
      console.error(error);
      const statusCode = error?.response?.status;
      const serverError = error?.response?.data?.error;

      let message = serverError || 'Failed to load symbols';
      if (statusCode === 404) {
        message = 'Endpoint /api/symbols not found. Restart backend after update.';
      }

      setSymbols((prev) => ({ ...prev, [keyName]: [] }));
      setSymbolsError((prev) => ({ ...prev, [keyName]: message }));
    }
  };

  const getDefaultStrategyBinding = (keyName: string) => {
    const keySettings = chartSettings[keyName] || defaultChartSetting();
    if (keySettings.type === 'synthetic') {
      return {
        base: String(keySettings.base || 'BTCUSDT').toUpperCase(),
        quote: String(keySettings.quote || 'ETHUSDT').toUpperCase(),
        interval: String(keySettings.interval || '1h'),
        baseCoef: Number(keySettings.baseCoef) || 1,
        quoteCoef: Number(keySettings.quoteCoef) || 1,
      };
    }

    const monoSymbol = String(keySettings.symbol || 'BTCUSDT').toUpperCase();
    return {
      base: monoSymbol,
      quote: 'USDT',
      interval: String(keySettings.interval || '1h'),
      baseCoef: 1,
      quoteCoef: 1,
    };
  };

  const strategyActionKey = (keyName: string, strategyId: number, action: string) => `${keyName}:${strategyId}:${action}`;

  const increaseStrategyRenderLimit = (keyName: string, total: number) => {
    setStrategyRenderLimitByKey((prev) => {
      const current = Math.max(STRATEGY_RENDER_CHUNK, Number(prev[keyName] || STRATEGY_RENDER_CHUNK));
      const nextValue = Math.min(Math.max(total, STRATEGY_RENDER_CHUNK), current + STRATEGY_RENDER_CHUNK);

      if (nextValue === current) {
        return prev;
      }

      return {
        ...prev,
        [keyName]: nextValue,
      };
    });
  };

  const resetStrategyRenderLimit = (keyName: string, total: number) => {
    setStrategyRenderLimitByKey((prev) => {
      const nextValue = Math.min(Math.max(total, 0), STRATEGY_RENDER_CHUNK);
      if (prev[keyName] === nextValue) {
        return prev;
      }
      return {
        ...prev,
        [keyName]: nextValue,
      };
    });
  };

  const fetchStrategies = async (keyName: string, options?: { silent?: boolean; full?: boolean; includeArchived?: boolean; runtimeOnly?: boolean }) => {
    const silent = options?.silent === true;
    const full = options?.full === true;
    const includeArchived = options?.includeArchived ?? showArchivedByKey[keyName] ?? false;
    const runtimeOnly = options?.runtimeOnly ?? runtimeOnlyByKey[keyName] ?? true;
    const requestLockKey = `strategies:${keyName}`;

    if (!acquireRequestLock(requestLockKey)) {
      return;
    }

    if (!silent) {
      setStrategiesLoadingByKey((prev) => ({ ...prev, [keyName]: true }));
      setStrategiesErrorByKey((prev) => ({ ...prev, [keyName]: '' }));
    }

    try {
      const res = await axios.get(`/api/strategies/${keyName}/summary`, {
        params: {
          ...(full ? {} : { limit: STRATEGY_FETCH_LIMIT, offset: 0 }),
          runtimeOnly: runtimeOnly ? '1' : '0',
          ...(includeArchived ? { includeArchived: '1' } : {}),
        },
      });
      const payload = Array.isArray(res.data) ? res.data.map(parseStrategy) : [];
      const totalHeader = Number(res.headers?.['x-total-count']);
      const total = Number.isFinite(totalHeader) && totalHeader >= 0 ? totalHeader : payload.length;

      setStrategiesByKey((prev) => {
        const currentList = prev[keyName] || [];
        const currentById = new Map(currentList.map((item) => [Number(item.id), item]));
        const mergedPayload = payload.map((item) => mergeDirtyStrategyWithServer(item, currentById.get(Number(item.id))));
        return { ...prev, [keyName]: mergedPayload };
      });
      setStrategiesTotalByKey((prev) => ({ ...prev, [keyName]: total }));
      setFullStrategiesLoadedByKey((prev) => ({ ...prev, [keyName]: full || payload.length >= total }));
      setStrategyRenderLimitByKey((prev) => {
        const previousLimit = Number(prev[keyName] || 0);
        const defaultLimit = Math.min(payload.length, STRATEGY_RENDER_CHUNK);
        const nextLimit = previousLimit > 0 ? Math.min(previousLimit, payload.length) : defaultLimit;

        if (previousLimit === nextLimit) {
          return prev;
        }

        return {
          ...prev,
          [keyName]: nextLimit,
        };
      });
      setActiveStrategyPanelsByKey((prev) => {
        const currentPanels = prev[keyName] || [];
        const existingIds = new Set(payload.map((strategy) => String(strategy.id)));
        const nextPanels = currentPanels.filter((panel) => existingIds.has(panel));

        if (nextPanels.length === currentPanels.length) {
          return prev;
        }

        return {
          ...prev,
          [keyName]: nextPanels,
        };
      });
    } catch (error: any) {
      console.error(error);
      if (!silent) {
        setStrategiesByKey((prev) => ({ ...prev, [keyName]: [] }));
      }
      setStrategiesErrorByKey((prev) => ({
        ...prev,
        [keyName]: error?.response?.data?.error || 'Failed to load strategies',
      }));
    } finally {
      releaseRequestLock(requestLockKey);
      if (!silent) {
        setStrategiesLoadingByKey((prev) => ({ ...prev, [keyName]: false }));
      }
    }
  };

  const fetchStrategyDetails = async (keyName: string, strategyId: number, options?: { silent?: boolean }) => {
    const strategyIdKey = String(strategyId);
    const loadedMap = strategyDetailsLoadedByKey[keyName] || {};
    const loadingMap = strategyDetailsLoadingByKey[keyName] || {};

    if (loadedMap[strategyIdKey] || loadingMap[strategyIdKey]) {
      return;
    }

    setStrategyDetailsLoadingByKey((prev) => ({
      ...prev,
      [keyName]: {
        ...(prev[keyName] || {}),
        [strategyIdKey]: true,
      },
    }));
    setStrategyDetailsErrorByKey((prev) => ({
      ...prev,
      [keyName]: {
        ...(prev[keyName] || {}),
        [strategyIdKey]: '',
      },
    }));

    try {
      const res = await axios.get(`/api/strategies/${keyName}/${strategyId}`, {
        params: {
          includeLotPreview: 0,
        },
      });

      const detailed = parseStrategy(res.data);
      setStrategiesByKey((prev) => {
        const list = prev[keyName] || [];
        return {
          ...prev,
          [keyName]: list.map((strategy) => (strategy.id === strategyId ? mergeDirtyStrategyWithServer(detailed, strategy) : strategy)),
        };
      });

      setStrategyDetailsLoadedByKey((prev) => ({
        ...prev,
        [keyName]: {
          ...(prev[keyName] || {}),
          [strategyIdKey]: true,
        },
      }));

      if (detailed.show_chart) {
        void loadStrategyChart(keyName, detailed, { silent: true, force: true });
      }
    } catch (error) {
      const fallback = 'Failed to load strategy details';
      const errorMessage = (error as any)?.response?.data?.error || (error as any)?.message || fallback;
      setStrategyDetailsErrorByKey((prev) => ({
        ...prev,
        [keyName]: {
          ...(prev[keyName] || {}),
          [strategyIdKey]: String(errorMessage),
        },
      }));
      if (options?.silent !== true) {
        console.error(error);
      }
    } finally {
      setStrategyDetailsLoadingByKey((prev) => ({
        ...prev,
        [keyName]: {
          ...(prev[keyName] || {}),
          [strategyIdKey]: false,
        },
      }));
    }
  };

  const updateStrategyDraft = (keyName: string, strategyId: number, patch: Partial<DDStrategy>) => {
    setStrategiesByKey((prev) => {
      const list = prev[keyName] || [];
      return {
        ...prev,
        [keyName]: list.map((strategy) => (
          strategy.id === strategyId
            ? { ...strategy, ...patch, isDirty: patch.isDirty ?? true }
            : strategy
        )),
      };
    });
  };

  const addStrategy = async (keyName: string) => {
    const strategyBinding = getDefaultStrategyBinding(keyName);
    const settings = chartSettings[keyName] || defaultChartSetting();

    const strategyType = newSetStrategyTypeByKey[keyName] || 'DD_BattleToads';
    const newStrategyDefaults = getStrategyUiDefaults(strategyType);
    const name = (newStrategyNameByKey[keyName] || '').trim() || strategyType;

    try {
      setStrategyActionLoading((prev) => ({ ...prev, [`${keyName}:new`]: true }));

      const createRes = await axios.post(`/api/strategies/${keyName}`, {
        name,
        strategy_type: strategyType,
        market_mode: settings.type === 'mono' ? 'mono' : 'synthetic',
        display_on_chart: true,
        show_settings: true,
        show_chart: true,
        show_indicators: true,
        show_positions_on_chart: true,
        show_trades_on_chart: false,
        show_values_each_bar: false,
        auto_update: true,
        take_profit_percent: newStrategyDefaults.takeProfitPercent,
        price_channel_length: newStrategyDefaults.channelLength,
        detection_source: newStrategyDefaults.detectionSource,
        base_symbol: strategyBinding.base,
        quote_symbol: strategyBinding.quote,
        interval: strategyBinding.interval,
        base_coef: strategyBinding.baseCoef,
        quote_coef: strategyBinding.quoteCoef,
        long_enabled: true,
        short_enabled: true,
        lot_long_percent: 100,
        lot_short_percent: 100,
        max_deposit: 1000,
        margin_type: 'cross',
        leverage: 1,
        fixed_lot: false,
        reinvest_percent: 0,
      });

      const created = parseStrategy(createRes.data);
      setActiveStrategyPanelsByKey((prev) => {
        const currentPanels = prev[keyName] || [];
        const nextPanels = Array.from(new Set([...currentPanels, String(created.id)]));
        return {
          ...prev,
          [keyName]: nextPanels,
        };
      });

      setNewStrategyNameByKey((prev) => ({ ...prev, [keyName]: '' }));
      message.success(`Set ${name} added`);
      await fetchStrategies(keyName);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to add set');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [`${keyName}:new`]: false }));
    }
  };

  const saveStrategy = async (keyName: string, strategy: DDStrategy) => {
    const actionKey = strategyActionKey(keyName, strategy.id, 'save');

    const currentStrategies = strategiesByKey[keyName] || [];
    const invalidIdExists = currentStrategies.some((item) => !Number.isFinite(Number(item.id)) || Number(item.id) <= 0);
    const seenIds = new Set<number>();
    const duplicateIds = new Set<number>();

    currentStrategies.forEach((item) => {
      const id = Number(item.id);
      if (!Number.isFinite(id) || id <= 0) {
        return;
      }

      if (seenIds.has(id)) {
        duplicateIds.add(id);
      }

      seenIds.add(id);
    });

    if (invalidIdExists || duplicateIds.size > 0) {
      const duplicateText = duplicateIds.size > 0 ? ` Duplicate IDs: ${Array.from(duplicateIds).join(', ')}` : '';
      message.error(`Unsafe strategies state detected. Save blocked.${duplicateText} Refreshing from backend...`);
      await fetchStrategies(keyName);
      return;
    }

    const strategyToSave = currentStrategies.find((item) => item.id === strategy.id) || strategy;
    const strategyId = Number(strategyToSave.id);

    if (!Number.isFinite(strategyId) || strategyId <= 0) {
      message.error('Invalid strategy id. Refreshing from backend...');
      await fetchStrategies(keyName);
      return;
    }

    const normalizedBase = String(strategyToSave.base_symbol || '').trim().toUpperCase();
    const normalizedQuote = String(strategyToSave.quote_symbol || '').trim().toUpperCase();
    const normalizedInterval = String(strategyToSave.interval || '').trim() || '1h';

    if (!normalizedBase || !normalizedQuote) {
      message.error('Strategy pair is required: set both Trade Base and Trade Quote');
      return;
    }

    if (normalizedBase === normalizedQuote) {
      message.error('Strategy pair invalid: Trade Base and Trade Quote must be different');
      return;
    }

    const payload: Partial<DDStrategy> = {
      id: strategyId,
      name: strategyToSave.name,
      display_on_chart: strategyToSave.display_on_chart,
      show_settings: strategyToSave.show_settings,
      show_chart: strategyToSave.show_chart,
      show_indicators: strategyToSave.show_indicators,
      show_positions_on_chart: strategyToSave.show_positions_on_chart,
      show_trades_on_chart: strategyToSave.show_trades_on_chart,
      show_values_each_bar: strategyToSave.show_values_each_bar,
      auto_update: strategyToSave.auto_update,
      take_profit_percent: strategyToSave.take_profit_percent,
      price_channel_length: strategyToSave.price_channel_length,
      detection_source: strategyToSave.detection_source,
      base_symbol: normalizedBase,
      quote_symbol: normalizedQuote,
      interval: normalizedInterval,
      base_coef: strategyToSave.base_coef,
      quote_coef: strategyToSave.quote_coef,
      long_enabled: strategyToSave.long_enabled,
      short_enabled: strategyToSave.short_enabled,
      lot_long_percent: strategyToSave.lot_long_percent,
      lot_short_percent: strategyToSave.lot_short_percent,
      max_deposit: strategyToSave.max_deposit,
      margin_type: strategyToSave.margin_type,
      leverage: strategyToSave.leverage,
      fixed_lot: strategyToSave.fixed_lot,
      reinvest_percent: strategyToSave.reinvest_percent,
    };

    try {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      const res = await axios.put(`/api/strategies/${keyName}/${strategyId}`, payload);
      const updated = parseStrategy(res.data);

      if (updated.id !== strategyId) {
        throw new Error(`Unexpected strategy id in response: expected ${strategyId}, got ${updated.id}`);
      }

      updateStrategyDraft(keyName, strategyId, { ...updated, isDirty: false });
      await fetchStrategies(keyName, { silent: true });
      message.success(`Strategy ${strategyToSave.name} saved`);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to save strategy');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const executeStrategyNow = async (keyName: string, strategy: DDStrategy) => {
    const actionKey = strategyActionKey(keyName, strategy.id, 'execute');

    try {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: true }));

      if (!strategy.is_active) {
        await axios.put(`/api/strategies/${keyName}/${strategy.id}`, {
          is_active: true,
        });
      }

      const res = await axios.post(`/api/execute-strategy/${keyName}/${strategy.id}`);
      const resultText = res?.data?.result || 'Strategy executed';
      message.success(resultText);
      await Promise.all([
        fetchStrategies(keyName),
        fetchTradesForKey(keyName, { silent: true }),
      ]);
      if (selectedApiKey === keyName) {
        void loadChartForKey(keyName);
      }
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Strategy execution failed');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const pauseStrategyNow = async (keyName: string, strategy: DDStrategy) => {
    const actionKey = strategyActionKey(keyName, strategy.id, 'pause');
    try {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.post(`/api/pause-strategy/${keyName}/${strategy.id}`);
      message.success(`Strategy ${strategy.name} paused`);
      await fetchStrategies(keyName);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to pause strategy');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const stopStrategyNow = async (keyName: string, strategy: DDStrategy) => {
    const actionKey = strategyActionKey(keyName, strategy.id, 'stop');
    try {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.post(`/api/stop-strategy/${keyName}/${strategy.id}`);
      message.success(`Strategy ${strategy.name} stopped`);
      await Promise.all([
        fetchStrategies(keyName),
        fetchTradesForKey(keyName, { silent: true }),
      ]);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to stop strategy');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const cancelStrategyOrdersNow = async (keyName: string, strategy: DDStrategy) => {
    const actionKey = strategyActionKey(keyName, strategy.id, 'cancel-orders');
    try {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.post(`/api/strategies/${keyName}/${strategy.id}/cancel-orders`);
      message.success(`Orders cancelled for ${strategy.name}`);
      await fetchStrategies(keyName);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to cancel strategy orders');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const closeStrategyPositionsNow = async (keyName: string, strategy: DDStrategy) => {
    const actionKey = strategyActionKey(keyName, strategy.id, 'close-positions');
    try {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.post(`/api/strategies/${keyName}/${strategy.id}/close-positions`);
      message.success(`Pair positions closed for ${strategy.name}`);
      await Promise.all([
        fetchStrategies(keyName),
        fetchPositionsForKey(keyName),
        fetchTradesForKey(keyName, { silent: true }),
      ]);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to close strategy positions');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const deleteStrategyNow = async (keyName: string, strategy: DDStrategy) => {
    const actionKey = strategyActionKey(keyName, strategy.id, 'delete');
    try {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.delete(`/api/strategies/${keyName}/${strategy.id}`);
      message.success(`Strategy ${strategy.name} deleted`);
      await fetchStrategies(keyName);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to delete strategy');
    } finally {
      setStrategyActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const bulkArchiveStrategies = async (keyName: string, dryRun: boolean) => {
    setArchiveActionLoadingByKey((prev) => ({ ...prev, [keyName]: true }));
    try {
      const res = await axios.post(`/api/strategies/${keyName}/bulk-archive`, {
        dryRun,
        olderThanDays: 0,
      });
      const data = res.data as { dryRun: boolean; count?: number; archived?: number; sample?: { id: number; name: string }[] };
      if (dryRun) {
        const sample = (data.sample || []).slice(0, 5).map((s) => s.name).join(', ');
        message.info(`Dry run: ${data.count ?? 0} paused strategies will be archived${sample ? ` (e.g. ${sample}...)` : ''}`);
      } else {
        message.success(`Archived ${data.archived ?? 0} paused strategies for ${keyName}`);
        void fetchStrategies(keyName);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Bulk archive failed');
    } finally {
      setArchiveActionLoadingByKey((prev) => ({ ...prev, [keyName]: false }));
    }
  };

  const runApiKeyAction = async (
    keyName: string,
    action: 'play-bots' | 'pause-bots' | 'cancel-orders' | 'close-positions',
    successMessage: string
  ) => {
    const loadingKey = `${keyName}:${action}`;
    try {
      setKeyActionLoading((prev) => ({ ...prev, [loadingKey]: true }));
      await axios.post(`/api/api-keys/${keyName}/actions`, {
        action,
      });
      message.success(successMessage);

      await Promise.all([
        fetchStrategies(keyName),
        fetchPositionsForKey(keyName),
        fetchTradesForKey(keyName, { silent: true }),
        fetchMonitoring(keyName, { capture: true }),
      ]);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || `Failed to run action ${action}`);
    } finally {
      setKeyActionLoading((prev) => ({ ...prev, [loadingKey]: false }));
    }
  };

  const runGlobalAction = async (
    action: 'play-bots' | 'pause-bots' | 'cancel-orders' | 'close-positions',
    successMessage: string
  ) => {
    const loadingKey = `global:${action}`;
    try {
      setGlobalActionLoading((prev) => ({ ...prev, [loadingKey]: true }));
      const res = await axios.post('/api/controls/global', { action });

      if (res.status === 207 || res?.data?.errors?.length) {
        message.warning(`Global action finished with partial errors: ${res?.data?.errors?.length || 0}`);
      } else {
        message.success(successMessage);
      }

      for (const key of apiKeys) {
        if (isApiKeyActive(key.name)) {
          if (key.name === selectedApiKey) {
            void fetchStrategies(key.name);
          }
          void fetchPositionsForKey(key.name);
          void fetchTradesForKey(key.name, { silent: true });
          void fetchMonitoring(key.name, { capture: true, silent: true });
        }
      }
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || `Failed to run global action ${action}`);
    } finally {
      setGlobalActionLoading((prev) => ({ ...prev, [loadingKey]: false }));
    }
  };

  const copyStrategyBlockToKey = async (targetKeyName: string) => {
    const sourceKeyName = copySourceByTargetKey[targetKeyName];
    if (!sourceKeyName) {
      message.warning('Select source API key first');
      return;
    }

    if (sourceKeyName === targetKeyName) {
      message.warning('Source and target API key must be different');
      return;
    }

    try {
      setCopyActionLoadingByKey((prev) => ({ ...prev, [targetKeyName]: true }));
      const res = await axios.post('/api/strategies/copy-block', {
        sourceApiKey: sourceKeyName,
        targetApiKey: targetKeyName,
        replaceTarget: true,
        preserveActive: false,
        syncSymbols: true,
      });

      const payload = (res?.data || {}) as CopyBlockResponse;
      const copied = Number(payload.copied || 0);
      const deleted = Number(payload.deleted || 0);
      const adjusted = Number(payload.adjustedSymbols || 0);
      const disabled = Number(payload.disabledStrategies || 0);
      const issues = Array.isArray(payload.issues) ? payload.issues : [];

      message.success(
        `Copied ${copied} strategies from ${sourceKeyName} to ${targetKeyName} (replaced ${deleted}, adjusted ${adjusted}, disabled ${disabled})`
      );

      if (issues.length > 0) {
        message.warning(issues[0]);
      }

      await fetchStrategies(targetKeyName);

      const suggestion = payload.chartSuggestion;
      if (suggestion && suggestion.base && suggestion.quote) {
        updateChartSetting(targetKeyName, {
          type: 'synthetic',
          base: suggestion.base,
          quote: suggestion.quote,
          interval: suggestion.interval || '1h',
          baseCoef: Number(suggestion.baseCoef) || 1,
          quoteCoef: Number(suggestion.quoteCoef) || 1,
        });
      }
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to copy strategy block');
    } finally {
      setCopyActionLoadingByKey((prev) => ({ ...prev, [targetKeyName]: false }));
    }
  };

  const refreshAccountInfo = async (keyName: string, includeChart: boolean = true) => {
    setAccountRefreshLoadingByKey((prev) => ({ ...prev, [keyName]: true }));
    try {
      const keySettings = chartSettings[keyName] || defaultChartSetting();
      const keyMeta = apiKeys.find((item) => item.name === keyName);
      const panelOpened = keyMeta ? activePanel.includes(String(keyMeta.id)) : false;
      const shouldLoadFullStrategies = keyName === selectedApiKey || panelOpened;

      await Promise.all([
        fetchKeyStatus(keyName),
        fetchBalances(keyName),
        fetchPositionsForKey(keyName),
        fetchTradesForKey(keyName, { silent: true }),
        fetchSymbols(keyName),
        ...(shouldLoadFullStrategies ? [fetchStrategies(keyName)] : []),
        ...(keySettings.showMonitoring !== false ? [fetchMonitoring(keyName, { capture: true })] : []),
      ]);

      const keyStrategies = strategiesByKey[keyName] || [];
      const hasVisibleStrategyChart = keyStrategies.some((strategy) => strategy.show_chart);
      if (includeChart && isApiKeyActive(keyName) && (keySettings.showChart !== false || hasVisibleStrategyChart)) {
        await loadChartForKey(keyName);
      }
    } catch (error) {
      console.error(error);
      message.error(`Failed to refresh account data for ${keyName}`);
    } finally {
      setAccountRefreshLoadingByKey((prev) => ({ ...prev, [keyName]: false }));
    }
  };

  const refreshAllAccounts = async () => {
    setRefreshAllAccountsLoading(true);
    try {
      for (const key of apiKeys) {
        await refreshAccountInfo(key.name, false);
      }
      if (selectedApiKey) {
        const selectedSettings = chartSettings[selectedApiKey] || defaultChartSetting();
        const selectedStrategies = strategiesByKey[selectedApiKey] || [];
        const hasVisibleStrategyChart = selectedStrategies.some((strategy) => strategy.show_chart);
        if (selectedSettings.showChart !== false || hasVisibleStrategyChart) {
          await loadChartForKey(selectedApiKey);
        }
      }
      message.success('Account info updated for all API keys');
    } catch (error) {
      console.error(error);
      message.error('Failed to refresh all API keys');
    } finally {
      setRefreshAllAccountsLoading(false);
    }
  };

  const updateChartSetting = (keyName: string, patch: Partial<ChartSetting>) => {
    const normalizedPatch: Partial<ChartSetting> = patch.updateSec === undefined
      ? patch
      : {
          ...patch,
          updateSec: normalizeUpdateSec(patch.updateSec),
        };

    const dataAffectingFields = new Set(['type', 'symbol', 'base', 'quote', 'baseCoef', 'quoteCoef', 'interval']);
    const shouldResetChart = Object.keys(normalizedPatch).some((field) => dataAffectingFields.has(field));

    setChartSettings((prev) => {
      const next = {
        ...prev,
        [keyName]: {
          ...(prev[keyName] || defaultChartSetting()),
          ...normalizedPatch,
        },
      };
      persistChartSettings(next);
      return next;
    });

    if (shouldResetChart) {
      setChartDataByKey((prev) => {
        const next = { ...prev };
        delete next[keyName];
        return next;
      });
      setLastOHLCByKey((prev) => ({ ...prev, [keyName]: null }));
      setHoverOHLCByKey((prev) => ({ ...prev, [keyName]: null }));
      setSyntheticErrorByKey((prev) => ({ ...prev, [keyName]: '' }));
    }
  };

  const toggleApiKey = async (key: ApiKey) => {
    const currentState = isApiKeyActive(key.name);
    const nextState = !currentState;

    setApiKeyToggles((prev) => {
      const next = { ...prev, [key.name]: nextState };
      localStorage.setItem('apiKeyToggles', JSON.stringify(next));
      return next;
    });

    if (nextState) {
      const keySettings = chartSettings[key.name] || defaultChartSetting();
      void fetchKeyStatus(key.name);
      void fetchBalances(key.name);
      void fetchPositionsForKey(key.name);
      void fetchTradesForKey(key.name, { silent: true });
      void fetchSymbols(key.name);
      if (selectedApiKey === key.name) {
        void fetchStrategies(key.name);
      }
      if (keySettings.showMonitoring !== false) {
        void fetchMonitoring(key.name, { capture: true });
      }
      if (selectedApiKey === key.name) {
        const keyStrategies = strategiesByKey[key.name] || [];
        const hasVisibleStrategyChart = keyStrategies.some((strategy) => strategy.show_chart);
        if (keySettings.showChart !== false || hasVisibleStrategyChart) {
          void loadChartForKey(key.name);
        }
      }
      return;
    }

    setBalances((prev) => ({ ...prev, [key.name]: [] }));
    setPositionsByKey((prev) => ({ ...prev, [key.name]: [] }));
    setKeyStatuses((prev) => ({ ...prev, [key.name]: { status: 'warning', message: 'Disabled' } }));
    setBalancesError((prev) => ({ ...prev, [key.name]: '' }));
    setSymbols((prev) => ({ ...prev, [key.name]: [] }));
    setSymbolsError((prev) => ({ ...prev, [key.name]: '' }));
    setChartDataByKey((prev) => ({ ...prev, [key.name]: [] }));
    setStrategyChartDataByKey((prev) => ({ ...prev, [key.name]: {} }));
    setStrategyChartLoadingByKey((prev) => ({ ...prev, [key.name]: {} }));
    setStrategyChartErrorByKey((prev) => ({ ...prev, [key.name]: {} }));
    setLastOHLCByKey((prev) => ({ ...prev, [key.name]: null }));
    setHoverOHLCByKey((prev) => ({ ...prev, [key.name]: null }));
    setStrategyHoverOHLCByKey((prev) => ({ ...prev, [key.name]: {} }));
    setSyntheticErrorByKey((prev) => ({ ...prev, [key.name]: '' }));
    setMonitoringByKey((prev) => ({
      ...prev,
      [key.name]: { points: [], latest: null },
    }));
    setTradesByKey((prev) => ({ ...prev, [key.name]: [] }));
    setMonitoringErrorByKey((prev) => ({ ...prev, [key.name]: '' }));
  };

  const loadChartForKey = async (keyName: string, options?: { silent?: boolean }) => {
    if (!isApiKeyActive(keyName)) {
      return;
    }

    const silent = options?.silent === true;
    const requestLockKey = `chart:${keyName}`;

    if (!acquireRequestLock(requestLockKey)) {
      return;
    }

    const settings = chartSettings[keyName] || defaultChartSetting();

    if (!silent) {
      setChartLoadingKey(keyName);
      setHoverOHLCByKey((prev) => ({ ...prev, [keyName]: null }));
      setSyntheticErrorByKey((prev) => ({ ...prev, [keyName]: '' }));
    }

    try {
      let payload: any[] = [];

      if (settings.type === 'synthetic') {
        if (!settings.base || !settings.quote) {
          if (!silent) {
            setSyntheticErrorByKey((prev) => ({ ...prev, [keyName]: 'Select both base and quote pairs first' }));
            setChartDataByKey((prev) => ({ ...prev, [keyName]: [] }));
            setLastOHLCByKey((prev) => ({ ...prev, [keyName]: null }));
          }
          return;
        }

        const res = await axios.get(`/api/synthetic-chart/${keyName}`, {
          params: {
            base: settings.base,
            quote: settings.quote,
            baseCoef: settings.baseCoef || 1,
            quoteCoef: settings.quoteCoef || 1,
            interval: settings.interval || '1h',
            limit: 100,
          },
        });
        payload = Array.isArray(res.data) ? res.data : [];
      } else {
        const symbol = settings.symbol || 'BTCUSDT';
        const res = await axios.get(`/api/market-data/${keyName}`, {
          params: {
            symbol,
            interval: settings.interval || '1h',
            limit: 100,
          },
        });
        payload = Array.isArray(res.data) ? res.data : [];
      }

      setChartDataByKey((prev) => ({ ...prev, [keyName]: payload }));
      setLastOHLCByKey((prev) => ({ ...prev, [keyName]: pickLatestOHLC(payload) }));
    } catch (error: any) {
      console.error(error);
      const message = error?.response?.data?.error || 'Failed to load chart';
      if (!silent) {
        setChartDataByKey((prev) => ({ ...prev, [keyName]: [] }));
        setLastOHLCByKey((prev) => ({ ...prev, [keyName]: null }));
      }
      if (settings.type === 'synthetic' && !silent) {
        setSyntheticErrorByKey((prev) => ({ ...prev, [keyName]: message }));
      }
    } finally {
      releaseRequestLock(requestLockKey);
      if (!silent) {
        setChartLoadingKey((prev) => (prev === keyName ? null : prev));
      }
    }
  };

  const loadStrategyChart = async (
    keyName: string,
    strategy: DDStrategy,
    options?: { silent?: boolean; force?: boolean }
  ) => {
    if (!isApiKeyActive(keyName)) {
      return;
    }

    const strategyIdKey = String(strategy.id);
    const existing = strategyChartDataByKey[keyName]?.[strategyIdKey];
    if (!options?.force && Array.isArray(existing) && existing.length > 0) {
      return;
    }

    const requestLockKey = `strategy-chart:${keyName}:${strategyIdKey}`;
    if (!acquireRequestLock(requestLockKey)) {
      return;
    }

    setStrategyChartLoadingByKey((prev) => ({
      ...prev,
      [keyName]: {
        ...(prev[keyName] || {}),
        [strategyIdKey]: true,
      },
    }));
    setStrategyChartErrorByKey((prev) => ({
      ...prev,
      [keyName]: {
        ...(prev[keyName] || {}),
        [strategyIdKey]: '',
      },
    }));

    try {
      let payload: any[] = [];

      if (strategy.market_mode === 'synthetic') {
        if (!strategy.base_symbol || !strategy.quote_symbol) {
          throw new Error('Synthetic strategy requires both base and quote symbols');
        }

        const res = await axios.get(`/api/synthetic-chart/${keyName}`, {
          params: {
            base: strategy.base_symbol,
            quote: strategy.quote_symbol,
            baseCoef: strategy.base_coef || 1,
            quoteCoef: strategy.quote_coef || 1,
            interval: strategy.interval || '1h',
            limit: 100,
          },
        });
        payload = Array.isArray(res.data) ? res.data : [];
      } else {
        const res = await axios.get(`/api/market-data/${keyName}`, {
          params: {
            symbol: strategy.base_symbol,
            interval: strategy.interval || '1h',
            limit: 100,
          },
        });
        payload = Array.isArray(res.data) ? res.data : [];
      }

      setStrategyChartDataByKey((prev) => ({
        ...prev,
        [keyName]: {
          ...(prev[keyName] || {}),
          [strategyIdKey]: payload,
        },
      }));
    } catch (error: any) {
      const errorText = String(error?.response?.data?.error || error?.message || 'Failed to load strategy chart');
      setStrategyChartErrorByKey((prev) => ({
        ...prev,
        [keyName]: {
          ...(prev[keyName] || {}),
          [strategyIdKey]: errorText,
        },
      }));
      if (options?.silent !== true) {
        console.error(error);
      }
    } finally {
      releaseRequestLock(requestLockKey);
      setStrategyChartLoadingByKey((prev) => ({
        ...prev,
        [keyName]: {
          ...(prev[keyName] || {}),
          [strategyIdKey]: false,
        },
      }));
    }
  };

  const handlePanelChange = (key: string | string[]) => {
    const panels = Array.isArray(key) ? key.map((item) => String(item)) : key ? [String(key)] : [];
    setActivePanel(panels);

    if (panels.length === 0) {
      return;
    }

    const openedPanel = panels[panels.length - 1];
    const openedApiKey = apiKeys.find((item) => String(item.id) === openedPanel);

    if (openedApiKey) {
      setSelectedApiKey(openedApiKey.name);
      localStorage.setItem('selectedApiKey', openedApiKey.name);

      if (strategiesByKey[openedApiKey.name] === undefined) {
        void fetchStrategies(openedApiKey.name);
      }

      const openedSettings = chartSettings[openedApiKey.name] || defaultChartSetting();
      const openedStrategies = strategiesByKey[openedApiKey.name] || [];
      const hasVisibleStrategyChart = openedStrategies.some((strategy) => strategy.show_chart);

      if (
        isApiKeyActive(openedApiKey.name) &&
        chartDataByKey[openedApiKey.name] === undefined &&
        (openedSettings.showChart !== false || hasVisibleStrategyChart)
      ) {
        void loadChartForKey(openedApiKey.name);
      }

      if (
        isApiKeyActive(openedApiKey.name) &&
        (openedSettings.showMonitoring !== false) &&
        monitoringByKey[openedApiKey.name] === undefined
      ) {
        void fetchMonitoring(openedApiKey.name, { capture: true });
      }
    }
  };


  const collapseItems = apiKeys.map((key) => {
    const keyName = key.name;
    const keyActive = isApiKeyActive(keyName);
    const keyStatus = keyStatuses[keyName] || { status: keyActive ? 'ok' : 'warning', message: keyActive ? 'Connected' : 'Disabled' };
    const keyStatusText = keyStatus.status === 'ok' ? 'connected' : String(keyStatus.message || keyStatus.status);
    const settings = chartSettings[keyName] || defaultChartSetting();
    const keyChartData = chartDataByKey[keyName];
    const keyLastOHLC = lastOHLCByKey[keyName];
    const keyHoverOHLC = hoverOHLCByKey[keyName];
    const keySyntheticError = syntheticErrorByKey[keyName] || '';
    const keyStrategies = strategiesByKey[keyName] || [];
    const keyStrategiesTotal = Number.isFinite(strategiesTotalByKey[keyName])
      ? Math.max(strategiesTotalByKey[keyName], keyStrategies.length)
      : keyStrategies.length;
    const keyFullLoaded = fullStrategiesLoadedByKey[keyName] === true;
    const keyStrategiesLoading = strategiesLoadingByKey[keyName] || false;
    const keyStrategiesError = strategiesErrorByKey[keyName] || '';
    const keyBalances = balances[keyName] || [];
    const keyPositions = positionsByKey[keyName] || [];
    const keyTrades = tradesByKey[keyName] || [];
    const marginStats = calculateMarginStats(keyBalances, keyPositions);
    const activeStrategyPanels = activeStrategyPanelsByKey[keyName] || [];
    const newStrategyName = newStrategyNameByKey[keyName] || '';
    const newSetStrategyType = newSetStrategyTypeByKey[keyName] || 'DD_BattleToads';
    const shownOHLC = keyHoverOHLC || keyLastOHLC;
    const ohlcTitle = keyHoverOHLC ? 'Hovered OHLC' : 'Last OHLC';
    const monitoringPayload = monitoringByKey[keyName] || { points: [], latest: null };
    const monitoringPoints = monitoringPayload.points;
    const monitoringLatest = monitoringPayload.latest;
    const monitoringEquityWithUpnl = monitoringLatest
      ? monitoringLatest.equity_usd + monitoringLatest.unrealized_pnl
      : 0;
    const monitoringLoading = monitoringLoadingByKey[keyName] || false;
    const monitoringError = monitoringErrorByKey[keyName] || '';
    const copySourceKey = copySourceByTargetKey[keyName] || '';
    const copyLoading = copyActionLoadingByKey[keyName] || false;
    const detailsLoadedForKey = strategyDetailsLoadedByKey[keyName] || {};
    const detailsLoadingForKey = strategyDetailsLoadingByKey[keyName] || {};
    const detailsErrorForKey = strategyDetailsErrorByKey[keyName] || {};
    const totalStrategies = keyStrategies.length;
    const strategyRenderLimit = Math.min(totalStrategies, Math.max(STRATEGY_RENDER_CHUNK, Number(strategyRenderLimitByKey[keyName] || STRATEGY_RENDER_CHUNK)));
    const visibleStrategies = keyStrategies.slice(0, strategyRenderLimit);
    const hasHiddenStrategies = totalStrategies > visibleStrategies.length;
    const runningStrategies = keyStrategies.length > 0
      ? keyStrategies.filter((strategy) => strategy.is_active).length
      : (strategiesRunningByKey[keyName] ?? 0);
    const pausedStrategies = Math.max(0, keyStrategiesTotal - runningStrategies);
    const errorStrategies = keyStrategies.filter((strategy) => Boolean(String(strategy.last_error || '').trim())).length;
    const strategyDiagnostics = buildStrategyDiagnostics(keyStrategies, keyPositions);
    const desyncCount = strategyDiagnostics.filter((row) => row.status === 'error').length;
    const warningCount = strategyDiagnostics.filter((row) => row.status === 'warning').length;
    const setTypeOptions: Array<{ value: StrategyKind; label: string }> = [
      { value: 'DD_BattleToads', label: 'DD' },
      { value: 'zz_breakout', label: 'ZZ' },
      { value: 'stat_arb_zscore', label: 'HD' },
    ];
    const strategyTypeLabel = (value: StrategyKind): string => {
      if (value === 'zz_breakout') return 'ZZ';
      if (value === 'stat_arb_zscore') return 'HD';
      return 'DD';
    };
    const currentModeLabel = settings.type === 'mono' ? 'mono' : 'synthetic';

    return {
      key: String(key.id),
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>{key.name} ({key.exchange})</span>
          {key.tenantDisplayName ? <Tag color={key.tenantProductMode === 'algofund_client' ? 'purple' : key.tenantProductMode === 'strategy_client' ? 'cyan' : 'default'}>{key.tenantDisplayName}{key.tenantProductMode === 'algofund_client' ? ' · Алгофонд' : key.tenantProductMode === 'strategy_client' ? ' · Стратегии' : ''}</Tag> : <Tag color='default'>без привязки</Tag>}
          <StatusIndicator status={keyStatus.status} message={keyStatus.message} />
          <span style={{ fontSize: 12, color: '#666666' }}>API: {keyStatusText}</span>
          <Tag color="blue">sets: {keyStrategiesTotal}</Tag>
          <Tag color="green">running: {runningStrategies}</Tag>
          <Tag color="orange">paused: {pausedStrategies}</Tag>
          {errorStrategies > 0 ? <Tag color="red">errors: {errorStrategies}</Tag> : null}
          {desyncCount > 0
            ? <Tag color="red">desync: {desyncCount}</Tag>
            : <Tag color="green">desync: 0</Tag>}
        </div>
      ),
      children: (
        <>
          <Row gutter={16} align="top">
            <Col xs={24} lg={8}>
              <Card title="Account">
                {!keyActive && <Alert type="info" message="API key disabled: balances and pairs are not loaded." showIcon style={{ marginBottom: 8 }} />}
                {keyActive && balancesError[keyName] && <Alert type="error" message={balancesError[keyName]} showIcon style={{ marginBottom: 8 }} />}

                {keyActive && balances[keyName] === undefined ? <Spin /> : null}

                {keyActive && balances[keyName] && balances[keyName].length > 0
                  ? balances[keyName].map((bal: any, idx: number) => (
                    <div key={`${bal.coin || 'unknown'}-${idx}`}>
                      {bal.coin}: {bal.walletBalance} (Available: {bal.availableBalance})
                    </div>
                  ))
                  : null}

                {keyActive && balances[keyName] && balances[keyName].length === 0 && !balancesError[keyName]
                  ? <Alert type="warning" message="No balances found" showIcon />
                  : null}

                {keyActive && (marginStats.equityUsd > 0 || marginStats.notionalUsd > 0)
                  ? (
                    <div style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
                      Wallet: {formatCompactNumber(marginStats.walletUsd, 2)} USDT
                      {' '}| UPnL: {formatCompactNumber(marginStats.unrealizedPnlUsd, 2)} USDT
                      {' '}| Equity: {formatCompactNumber(marginStats.equityWithUpnlUsd, 2)} USDT
                    </div>
                  )
                  : null}

                {keyActive && (marginStats.equityWithUpnlUsd > 0 || marginStats.notionalUsd > 0)
                  ? (
                    <div style={{ marginTop: 2, fontSize: 12, color: '#374151' }}>
                      Margin load: {formatCompactNumber(marginStats.marginLoadPercent, 1)}%
                      {' '}({formatCompactNumber(marginStats.marginUsedUsd, 2)} USDT)
                      {' '}| Leverage: x{formatCompactNumber(marginStats.effectiveLeverage, 2)}
                    </div>
                  )
                  : null}

                <Space direction="vertical" style={{ marginTop: 12, width: '100%' }}>
                  <Space>
                    <Switch checked={keyActive} onChange={() => toggleApiKey(key)} style={{ marginLeft: 0 }} />
                    <span>Active</span>
                  </Space>

                  <Space>
                    <Switch
                      checked={(settings.showChart !== false) || (settings.showSettings !== false)}
                      onChange={(checked) => updateChartSetting(keyName, { showChart: checked, showSettings: checked })}
                      disabled={!keyActive}
                    />
                    <span>Show chart + settings</span>
                  </Space>

                  <Space>
                    <Switch
                      checked={settings.showMonitoring !== false}
                      onChange={(checked) => updateChartSetting(keyName, { showMonitoring: checked })}
                      disabled={!keyActive}
                    />
                    <span>Show monitoring</span>
                  </Space>

                  <Button
                    size="small"
                    loading={Boolean(accountRefreshLoadingByKey[keyName])}
                    onClick={() => {
                      void refreshAccountInfo(keyName);
                    }}
                  >
                    Update account info
                  </Button>

                  <Divider style={{ margin: '8px 0' }} />
                  <span style={{ fontSize: 12, color: '#374151' }}>API key controls</span>
                  <Space wrap>
                    <Button
                      size="small"
                      loading={Boolean(keyActionLoading[`${keyName}:play-bots`])}
                      disabled={!keyActive}
                      onClick={() => {
                        void runApiKeyAction(keyName, 'play-bots', `All bots resumed for ${keyName}`);
                      }}
                    >
                      Play all bots
                    </Button>
                    <Button
                      size="small"
                      loading={Boolean(keyActionLoading[`${keyName}:pause-bots`])}
                      disabled={!keyActive}
                      onClick={() => {
                        void runApiKeyAction(keyName, 'pause-bots', `All bots paused for ${keyName}`);
                      }}
                    >
                      Pause all bots
                    </Button>
                    <Popconfirm
                      title="Cancel all open orders for this API key?"
                      onConfirm={() => {
                        void runApiKeyAction(keyName, 'cancel-orders', `All orders cancelled for ${keyName}`);
                      }}
                    >
                      <Button
                        size="small"
                        loading={Boolean(keyActionLoading[`${keyName}:cancel-orders`])}
                        disabled={!keyActive}
                      >
                        Cancel all orders
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title="Close all positions for this API key?"
                      onConfirm={() => {
                        void runApiKeyAction(keyName, 'close-positions', `All positions closed for ${keyName}`);
                      }}
                    >
                      <Button
                        size="small"
                        danger
                        loading={Boolean(keyActionLoading[`${keyName}:close-positions`])}
                        disabled={!keyActive}
                      >
                        Close all positions
                      </Button>
                    </Popconfirm>
                  </Space>
                </Space>
              </Card>

              {settings.showSettings !== false ? (
                <Card title="Chart Settings" style={{ marginTop: 12 }}>
                  {!keyActive && <Alert type="info" message="Enable the key to load symbols and charts." showIcon style={{ marginBottom: 8 }} />}
                  {symbolsError[keyName] && keyActive && <Alert type="warning" message={symbolsError[keyName]} showIcon style={{ marginBottom: 8 }} />}

                  <Form
                    layout="horizontal"
                    className="dashboard-compact-form dashboard-inline-form"
                    labelCol={{ span: 10 }}
                    wrapperCol={{ span: 14 }}
                  >
                    <Form.Item label="Chart Type">
                      <Select
                        value={settings.type}
                        onChange={(value) => updateChartSetting(keyName, { type: value as DashboardChartType })}
                        disabled={!keyActive}
                      >
                        <Option value="mono">Mono</Option>
                        <Option value="synthetic">Synthetic</Option>
                      </Select>
                    </Form.Item>

                    {settings.type === 'synthetic' ? (
                      <>
                        <Form.Item label="Base">
                          <Select
                            placeholder="BTCUSDT"
                            value={settings.base}
                            onChange={(value) => updateChartSetting(keyName, { base: value })}
                            showSearch
                            disabled={!keyActive}
                            notFoundContent={symbolsError[keyName] ? symbolsError[keyName] : 'No pairs'}
                          >
                            {(symbols[keyName] || []).map((symbol) => (
                              <Option key={symbol} value={symbol}>{symbol}</Option>
                            ))}
                          </Select>
                        </Form.Item>

                        <Form.Item label="Quote">
                          <Select
                            placeholder="ETHUSDT"
                            value={settings.quote}
                            onChange={(value) => updateChartSetting(keyName, { quote: value })}
                            showSearch
                            disabled={!keyActive}
                            notFoundContent={symbolsError[keyName] ? symbolsError[keyName] : 'No pairs'}
                          >
                            {(symbols[keyName] || []).map((symbol) => (
                              <Option key={symbol} value={symbol}>{symbol}</Option>
                            ))}
                          </Select>
                        </Form.Item>

                        <Form.Item label="Base Coef">
                          <Input
                            type="number"
                            value={settings.baseCoef}
                            onChange={(e) => updateChartSetting(keyName, { baseCoef: Number(e.target.value) || 1 })}
                            disabled={!keyActive}
                          />
                        </Form.Item>

                        <Form.Item label="Quote Coef">
                          <Input
                            type="number"
                            value={settings.quoteCoef}
                            onChange={(e) => updateChartSetting(keyName, { quoteCoef: Number(e.target.value) || 1 })}
                            disabled={!keyActive}
                          />
                        </Form.Item>
                      </>
                    ) : (
                      <Form.Item label="Symbol">
                        <Select
                          placeholder="BTCUSDT"
                          value={settings.symbol}
                          onChange={(value) => updateChartSetting(keyName, { symbol: value })}
                          showSearch
                          disabled={!keyActive}
                          notFoundContent={symbolsError[keyName] ? symbolsError[keyName] : 'No pairs'}
                        >
                          {(symbols[keyName] || []).map((symbol) => (
                            <Option key={symbol} value={symbol}>{symbol}</Option>
                          ))}
                        </Select>
                      </Form.Item>
                    )}

                    <Form.Item label="Interval">
                      <Select
                        value={settings.interval}
                        onChange={(value) => updateChartSetting(keyName, { interval: value })}
                        disabled={!keyActive}
                      >
                        <Option value="1m">1m</Option>
                        <Option value="3m">3m</Option>
                        <Option value="5m">5m</Option>
                        <Option value="15m">15m</Option>
                        <Option value="30m">30m</Option>
                        <Option value="1h">1h</Option>
                        <Option value="2h">2h</Option>
                        <Option value="4h">4h</Option>
                        <Option value="6h">6h</Option>
                        <Option value="12h">12h</Option>
                        <Option value="1d">1d</Option>
                        <Option value="1w">1w</Option>
                        <Option value="1M">1M</Option>
                      </Select>
                    </Form.Item>

                    <Form.Item label="Chart Render">
                      <Select
                        value={settings.chartType}
                        onChange={(value) => updateChartSetting(keyName, { chartType: value as ChartType })}
                        disabled={!keyActive}
                      >
                        <Option value="line">Line</Option>
                        <Option value="candlestick">Candlestick</Option>
                      </Select>
                    </Form.Item>

                    <Form.Item label="Update (sec)">
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        value={settings.updateSec}
                        onChange={(e) => updateChartSetting(keyName, { updateSec: normalizeUpdateSec(e.target.value) })}
                        disabled={!keyActive}
                      />
                    </Form.Item>

                    <Form.Item>
                      <Button
                        type="primary"
                        size="small"
                        loading={chartLoadingKey === keyName}
                        disabled={!keyActive}
                        onClick={() => {
                          void loadChartForKey(keyName);
                        }}
                      >
                        Load Chart
                      </Button>
                      {keySyntheticError && settings.type === 'synthetic'
                        ? <Alert type="error" message={keySyntheticError} showIcon style={{ marginTop: 8 }} />
                        : null}
                    </Form.Item>
                  </Form>
                </Card>
              ) : null}
            </Col>

            <Col xs={24} lg={16}>
              <Card title="Chart">
                {!keyActive
                  ? <Alert type="info" message="API key disabled: chart updates are paused." showIcon />
                  : settings.showChart === false
                    ? <Alert type="info" message="Chart is hidden by flag. Enable display in account block." showIcon />
                    : chartLoadingKey === keyName
                      ? <Spin />
                      : keyChartData === undefined
                        ? <Alert type="info" message="Click Load Chart to fetch data" showIcon />
                        : keyChartData.length === 0
                          ? <Alert type="warning" message="No chart data" showIcon />
                          : (
                            <>
                              {shownOHLC
                                ? (
                                  <div>
                                    <strong>{ohlcTitle}:</strong> O: {formatOHLCValue(shownOHLC.open)} H: {formatOHLCValue(shownOHLC.high)} L: {formatOHLCValue(shownOHLC.low)} C: {formatOHLCValue(shownOHLC.close)}
                                  </div>
                                )
                                : null}
                              {settings.updateSec > 0 ? <div>Auto update every {settings.updateSec} sec</div> : null}
                              <ChartComponent
                                data={keyChartData}
                                type={settings.chartType}
                                onHoverOHLC={(ohlc) => {
                                  setHoverOHLCByKey((prev) => {
                                    const current = prev[keyName];
                                    if (isSameHoverOHLC(current, ohlc)) {
                                      return prev;
                                    }
                                    return { ...prev, [keyName]: ohlc };
                                  });
                                }}
                              />
                            </>
                          )}
              </Card>
            </Col>
          </Row>

          <Row style={{ marginTop: 16 }}>
            <Col span={24}>
              <Card title="Runtime vs Exchange Diagnostic">
                <Space wrap style={{ marginBottom: 12 }}>
                  <Tag color={desyncCount > 0 ? 'red' : 'green'}>Errors: {desyncCount}</Tag>
                  <Tag color={warningCount > 0 ? 'gold' : 'blue'}>Warnings: {warningCount}</Tag>
                  <Tag color="blue">Strategies: {strategyDiagnostics.length}</Tag>
                </Space>

                {strategyDiagnostics.length === 0
                  ? <Alert type="info" showIcon message="No strategies loaded yet for diagnostics." />
                  : (
                    <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Strategy</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Pair</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Runtime state</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Live state</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Signal</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Status</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Reason</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Live legs</th>
                          </tr>
                        </thead>
                        <tbody>
                          {strategyDiagnostics.map((row) => (
                            <tr key={`diag-${keyName}-${row.strategyId}`} style={{ borderTop: '1px solid #f0f0f0' }}>
                              <td style={{ padding: '6px 8px' }}>{row.strategyName}</td>
                              <td style={{ padding: '6px 8px' }}>{row.pair}</td>
                              <td style={{ padding: '6px 8px' }}>{row.runtimeState}</td>
                              <td style={{ padding: '6px 8px' }}>{row.liveState}</td>
                              <td style={{ padding: '6px 8px' }}>{row.lastSignal}</td>
                              <td style={{ padding: '6px 8px' }}>
                                <Tag color={row.status === 'error' ? 'red' : row.status === 'warning' ? 'gold' : 'green'}>
                                  {row.status}
                                </Tag>
                              </td>
                              <td style={{ padding: '6px 8px' }}>{row.reason}</td>
                              <td style={{ padding: '6px 8px' }}>{row.liveSymbols}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </Card>
            </Col>
          </Row>

          <Row style={{ marginTop: 16 }}>
            <Col span={24}>
              <Card title="Sets">
                <Space style={{ marginBottom: 12 }} wrap>
                  <Input
                    placeholder="Set name"
                    value={newStrategyName}
                    onChange={(e) => setNewStrategyNameByKey((prev) => ({ ...prev, [keyName]: e.target.value }))}
                    style={{ width: 260 }}
                    disabled={!keyActive}
                  />
                  <Select
                    value={newSetStrategyType}
                    style={{ width: 180 }}
                    onChange={(value) => setNewSetStrategyTypeByKey((prev) => ({ ...prev, [keyName]: value as StrategyKind }))}
                    disabled={!keyActive}
                    options={setTypeOptions}
                  />
                  <Button
                    type="primary"
                    onClick={() => {
                      void addStrategy(keyName);
                    }}
                    loading={Boolean(strategyActionLoading[`${keyName}:new`] && keyActive)}
                    disabled={!keyActive}
                  >
                    Add set
                  </Button>
                  <Tag color="blue">Chart preview is configured once in API key Chart Settings</Tag>
                  <Tag color="green">New set mode: {currentModeLabel} (from chart settings)</Tag>
                  <Tag color="purple">Type: {strategyTypeLabel(newSetStrategyType)} | Name: set_name | Strategy: DD/ZZ/HD</Tag>
                  <Tag color="cyan">rendered: {visibleStrategies.length}/{totalStrategies}</Tag>
                  {!keyFullLoaded ? <Tag color="gold">light mode: {totalStrategies}/{keyStrategiesTotal}</Tag> : null}
                  {!keyFullLoaded ? (
                    <Button
                      size="small"
                      onClick={() => {
                        void fetchStrategies(keyName, { full: true });
                      }}
                    >
                      Load all strategies
                    </Button>
                  ) : null}
                  {hasHiddenStrategies ? (
                    <Button
                      size="small"
                      onClick={() => increaseStrategyRenderLimit(keyName, totalStrategies)}
                    >
                      Show +{STRATEGY_RENDER_CHUNK}
                    </Button>
                  ) : null}
                  {visibleStrategies.length > STRATEGY_RENDER_CHUNK ? (
                    <Button
                      size="small"
                      onClick={() => resetStrategyRenderLimit(keyName, totalStrategies)}
                    >
                      Show less
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    type={showArchivedByKey[keyName] ? 'primary' : 'default'}
                    onClick={() => {
                      const next = !showArchivedByKey[keyName];
                      setShowArchivedByKey((prev) => ({ ...prev, [keyName]: next }));
                      void fetchStrategies(keyName, { includeArchived: next });
                    }}
                  >
                    {showArchivedByKey[keyName] ? 'Hide archived' : 'Show archived'}
                  </Button>
                  <Button
                    size="small"
                    type={(runtimeOnlyByKey[keyName] ?? true) ? 'primary' : 'default'}
                    onClick={() => {
                      const next = !(runtimeOnlyByKey[keyName] ?? true);
                      setRuntimeOnlyByKey((prev) => ({ ...prev, [keyName]: next }));
                      void fetchStrategies(keyName, { runtimeOnly: next });
                    }}
                  >
                    {(runtimeOnlyByKey[keyName] ?? true) ? 'Show templates' : 'Hide templates'}
                  </Button>
                  <Button
                    size="small"
                    danger
                    loading={archiveActionLoadingByKey[keyName]}
                    onClick={() => void bulkArchiveStrategies(keyName, true)}
                  >
                    Dry-run archive paused
                  </Button>
                  <Button
                    size="small"
                    danger
                    loading={archiveActionLoadingByKey[keyName]}
                    onClick={() => {
                      void bulkArchiveStrategies(keyName, false);
                    }}
                  >
                    Archive all paused
                  </Button>

                  {apiKeys.length > 1 ? (
                    <>
                      <Select
                        value={copySourceKey || undefined}
                        style={{ width: 220 }}
                        placeholder="Copy strategies from..."
                        onChange={(value) => setCopySourceByTargetKey((prev) => ({ ...prev, [keyName]: value }))}
                        disabled={!keyActive}
                      >
                        {apiKeys
                          .filter((apiKey) => apiKey.name !== keyName)
                          .map((apiKey) => (
                            <Option key={apiKey.name} value={apiKey.name}>
                              {apiKey.name} ({apiKey.exchange})
                            </Option>
                          ))}
                      </Select>
                      <Popconfirm
                        title={`Replace all strategies in ${keyName} with strategies from ${copySourceKey || 'selected key'}?`}
                        onConfirm={() => {
                          void copyStrategyBlockToKey(keyName);
                        }}
                      >
                        <Button
                          loading={copyLoading}
                          disabled={!keyActive || !copySourceKey}
                        >
                          Copy full strategy block
                        </Button>
                      </Popconfirm>
                    </>
                  ) : null}
                </Space>

                {keyStrategiesError ? <Alert type="error" showIcon message={keyStrategiesError} style={{ marginBottom: 12 }} /> : null}

                {keyStrategiesLoading
                  ? <Spin />
                  : keyStrategies.length === 0
                    ? (
                      <Alert
                        type="info"
                        showIcon
                        message={(runtimeOnlyByKey[keyName] ?? true)
                          ? 'No runtime sets yet. Click "Show templates" to choose and add sets.'
                          : 'No set selected: balance, chart and positions remain visible.'}
                      />
                    )
                    : (
                      <Collapse
                        activeKey={activeStrategyPanels}
                        destroyInactivePanel
                        onChange={(key) => {
                          const panels = Array.isArray(key) ? key.map((item) => String(item)) : key ? [String(key)] : [];
                          const prevPanels = activeStrategyPanelsByKey[keyName] || [];
                          const openedPanels = panels.filter((panelId) => !prevPanels.includes(panelId));
                          setActiveStrategyPanelsByKey((prev) => {
                            return { ...prev, [keyName]: panels };
                          });

                          openedPanels.forEach((panelId) => {
                            const strategyId = Number(panelId);
                            if (Number.isFinite(strategyId) && strategyId > 0) {
                              void fetchStrategyDetails(keyName, strategyId, { silent: true });
                            }
                          });
                        }}
                        items={visibleStrategies.map((strategy) => {
                          // ── label vars (lightweight, run for all visible items) ──
                          const strategyPositions = keyPositions.filter((position: any) => {
                            const symbol = String(position?.symbol || '').toUpperCase();
                            const size = Number.parseFloat(String(position?.size || '0'));
                            return Number.isFinite(size) && size > 0 && (symbol === strategy.base_symbol || symbol === strategy.quote_symbol);
                          });
                          const pairSymbols = strategy.market_mode === 'mono'
                            ? [strategy.base_symbol]
                            : [strategy.base_symbol, strategy.quote_symbol]
                            .map((symbol) => String(symbol || '').toUpperCase())
                            .filter((symbol, index, array) => Boolean(symbol) && array.indexOf(symbol) === index);
                          const orderedPairRows = pairSymbols.map((symbol) => {
                            const position = strategyPositions.find(
                              (item: any) => String(item?.symbol || '').toUpperCase() === symbol
                            );
                            return {
                              symbol,
                              position: position || null,
                            };
                          });
                          const collapsedPairSummary = orderedPairRows
                            .map(({ symbol, position }) => {
                              if (!position) {
                                return `${symbol}: flat`;
                              }

                              const sideRaw = String(position?.side || '').toLowerCase();
                              const sideLabel = sideRaw === 'buy' ? 'LONG' : sideRaw === 'sell' ? 'SHORT' : '-';
                              const sizeText = formatCompactNumber(position?.size, 6);
                              const pnlRaw = Number(position?.unrealisedPnl);
                              const pnlText = Number.isFinite(pnlRaw) ? formatCompactNumber(pnlRaw, 4) : '-';
                              return `${symbol}: ${sideLabel} ${sizeText}, UPnL ${pnlText}`;
                            })
                            .join(' | ');
                          const strategyStatus = strategy.last_error
                            ? { color: 'red', label: 'error', text: String(strategy.last_error) }
                            : strategy.is_active
                              ? { color: 'green', label: 'active', text: String(strategy.last_action || 'running') }
                              : { color: 'orange', label: 'paused', text: String(strategy.last_action || 'paused') };
                          const updatedAtText = formatStrategyUpdatedAt(strategy.updated_at);
                          const strategyBadgeStatus: 'error' | 'processing' | 'default' = strategy.last_error
                            ? 'error'
                            : strategy.is_active
                              ? 'processing'
                              : 'default';
                          const strategyBadgeText = strategy.last_error ? 'ERR' : strategy.is_active ? 'RUN' : 'PAUSE';
                          const isExpandedStrategyPanel = activeStrategyPanels.includes(String(strategy.id));
                          const strategyIdKey = String(strategy.id);
                          const detailsLoaded = detailsLoadedForKey[strategyIdKey] === true;
                          const detailsLoading = detailsLoadingForKey[strategyIdKey] === true;
                          const detailsError = String(detailsErrorForKey[strategyIdKey] || '').trim();
                          const strategyChartData = strategyChartDataByKey[keyName]?.[strategyIdKey];
                          const strategyChartLoading = Boolean(strategyChartLoadingByKey[keyName]?.[strategyIdKey]);
                          const strategyChartError = String(strategyChartErrorByKey[keyName]?.[strategyIdKey] || '').trim();
                          const strategyHoverOHLC = strategyHoverOHLCByKey[keyName]?.[strategyIdKey] || null;

                          return {
                            key: String(strategy.id),
                            label: (
                              <Space wrap>
                                <span>{strategy.name}</span>
                                <Badge status={strategyBadgeStatus} text={strategyBadgeText} />
                                <Tag color={strategyStatus.color}>{strategyStatus.label}</Tag>
                                <Tag color="geekblue">set type: {strategyTypeLabel(strategy.strategy_type)}</Tag>
                                <Tag color={strategy.market_mode === 'mono' ? 'green' : 'blue'}>{strategy.market_mode}</Tag>
                                {strategy.is_runtime ? <Tag color="purple">runtime</Tag> : null}
                                {strategy.is_archived ? <Tag color="default">archived</Tag> : null}
                                {strategy.origin && strategy.origin !== 'manual' ? <Tag color="geekblue">{strategy.origin}</Tag> : null}
                                <Tag color={strategy.state === 'long' ? 'green' : strategy.state === 'short' ? 'red' : 'default'}>
                                  state: {strategy.state}
                                </Tag>
                                <Tag color="blue">
                                  {strategy.market_mode === 'mono'
                                    ? strategy.base_symbol
                                    : `${strategy.base_symbol}/${strategy.quote_symbol}`}
                                </Tag>
                                <Tag>{strategy.interval}</Tag>
                                <span style={{ color: '#6b7280' }}>{strategyStatus.text}</span>
                                <span style={{ color: '#9ca3af', fontSize: 12 }}>upd: {updatedAtText}</span>
                                <span style={{ color: '#4b5563', fontSize: 12 }}>{collapsedPairSummary || 'Pair positions: flat'}</span>
                              </Space>
                            ),
                            children: (() => {
                              if (!isExpandedStrategyPanel) {
                                return <div style={{ color: '#6b7280' }}>Expand strategy to load full controls and chart preview.</div>;
                              }

                              if (!detailsLoaded) {
                                return detailsLoading
                                  ? <Spin size="small" />
                                  : detailsError
                                    ? (
                                      <Alert
                                        type="error"
                                        showIcon
                                        message={detailsError}
                                        action={(
                                          <Button
                                            size="small"
                                            onClick={() => {
                                              void fetchStrategyDetails(keyName, strategy.id, { silent: false });
                                            }}
                                          >
                                            Retry
                                          </Button>
                                        )}
                                      />
                                    )
                                    : <Alert type="info" showIcon message="Loading strategy details..." />;
                              }

                              // ── body vars (only run for visible + expanded items) ──
                              const saveLoading = Boolean(strategyActionLoading[strategyActionKey(keyName, strategy.id, 'save')]);
                              const executeLoading = Boolean(strategyActionLoading[strategyActionKey(keyName, strategy.id, 'execute')]);
                              const pauseLoading = Boolean(strategyActionLoading[strategyActionKey(keyName, strategy.id, 'pause')]);
                              const stopLoading = Boolean(strategyActionLoading[strategyActionKey(keyName, strategy.id, 'stop')]);
                              const cancelOrdersLoading = Boolean(strategyActionLoading[strategyActionKey(keyName, strategy.id, 'cancel-orders')]);
                              const closePositionsLoading = Boolean(strategyActionLoading[strategyActionKey(keyName, strategy.id, 'close-positions')]);
                              const deleteLoading = Boolean(strategyActionLoading[strategyActionKey(keyName, strategy.id, 'delete')]);
                              const strategySymbolOptions = Array.from(
                                new Set(
                                  [
                                    ...pairSymbols,
                                    ...(symbols[keyName] || []).map((symbol) => String(symbol || '').toUpperCase()),
                                  ].filter((symbol) => Boolean(symbol))
                                )
                              );
                              const effectiveStrategyChartData = Array.isArray(strategyChartData) ? strategyChartData : [];
                              const strategyLastOHLC = pickLatestOHLC(effectiveStrategyChartData);
                              const strategyShownOHLC = strategyHoverOHLC || strategyLastOHLC;
                              const strategyOhlcTitle = strategyHoverOHLC ? 'Hovered OHLC' : 'Last OHLC';
                              const donchian = strategy.show_indicators
                                ? buildDonchianSnapshot(
                                  effectiveStrategyChartData,
                                  strategy.price_channel_length,
                                  strategy.detection_source,
                                  `${keyName}:${strategy.id}`
                                )
                                : null;
                              const donchianHighValue = donchian
                                ? pickOverlayValueAtTime(donchian.highSeries, strategy.show_values_each_bar ? strategyHoverOHLC?.time : undefined)
                                : null;
                              const donchianLowValue = donchian
                                ? pickOverlayValueAtTime(donchian.lowSeries, strategy.show_values_each_bar ? strategyHoverOHLC?.time : undefined)
                                : null;
                              const donchianCenterValue = donchian
                                ? pickOverlayValueAtTime(donchian.centerSeries, strategy.show_values_each_bar ? strategyHoverOHLC?.time : undefined)
                                : null;
                              const tpWave = strategy.show_indicators
                                ? buildTpWaveSnapshot(donchian, strategy.take_profit_percent, `${keyName}:${strategy.id}`)
                                : null;
                              const tpLongWaveValue = tpWave
                                ? pickOverlayValueAtTime(tpWave.longSeries, strategy.show_values_each_bar ? strategyHoverOHLC?.time : undefined)
                                : null;
                              const tpShortWaveValue = tpWave
                                ? pickOverlayValueAtTime(tpWave.shortSeries, strategy.show_values_each_bar ? strategyHoverOHLC?.time : undefined)
                                : null;
                              const entryOverlay = strategy.show_positions_on_chart && strategy.entry_ratio !== null && strategy.entry_ratio !== undefined
                                ? buildEntryOverlay(
                                  effectiveStrategyChartData,
                                  `${keyName}:${strategy.id}:entry`,
                                  Number(strategy.entry_ratio)
                                )
                                : null;
                              const activeTpRatio = strategy.entry_ratio !== null && strategy.entry_ratio !== undefined
                                ? strategy.state === 'long'
                                  ? Number(strategy.entry_ratio) * (1 + strategy.take_profit_percent / 100)
                                  : strategy.state === 'short'
                                    ? Number(strategy.entry_ratio) / (1 + strategy.take_profit_percent / 100)
                                    : null
                                : null;
                              const longLotUsdt = resolveLotUsdt(strategy.lot_long_usdt, strategy.max_deposit, strategy.lot_long_percent);
                              const shortLotUsdt = resolveLotUsdt(strategy.lot_short_usdt, strategy.max_deposit, strategy.lot_short_percent);
                              const tradeMarkers = strategy.display_on_chart && strategy.show_trades_on_chart
                                ? buildStrategyTradeMarkers(keyTrades, pairSymbols)
                                : [];
                              const strategyOverlays: OverlayLine[] = [
                                ...(strategy.display_on_chart && strategy.show_indicators && donchian ? donchian.overlays : []),
                                ...(strategy.display_on_chart && strategy.show_indicators && tpWave ? tpWave.overlays : []),
                                ...(strategy.display_on_chart && strategy.show_positions_on_chart && entryOverlay ? [entryOverlay] : []),
                              ];
                              return (
                              <>
                                {strategy.last_action ? <Alert type="info" showIcon message={`Last action: ${strategy.last_action}`} style={{ marginBottom: 12 }} /> : null}
                                {strategy.last_error ? <Alert type="error" showIcon message={strategy.last_error} style={{ marginBottom: 12 }} /> : null}

                                <Row gutter={16}>
                                  <Col xs={24} lg={8}>
                                    {strategy.show_settings ? (
                                      <>
                                        <Alert
                                          type="info"
                                          showIcon
                                          message="Chart preview settings are configured in the API key Chart Settings block above."
                                          style={{ marginBottom: 10 }}
                                        />

                                        <Card size="small" title="Strategy Settings">
                                          <Form
                                            layout="horizontal"
                                            className="strategy-compact-form strategy-inline-form"
                                            labelCol={{ span: 11 }}
                                            wrapperCol={{ span: 13 }}
                                          >
                                            <Form.Item label="Name">
                                              <Input
                                                value={strategy.name}
                                                onChange={(e) => updateStrategyDraft(keyName, strategy.id, { name: e.target.value })}
                                                disabled={!keyActive}
                                              />
                                            </Form.Item>

                                            <Form.Item label="Trade Base">
                                              <Select
                                                value={strategy.base_symbol}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { base_symbol: String(value || '').toUpperCase() })}
                                                showSearch
                                                disabled={!keyActive}
                                                notFoundContent={symbolsError[keyName] ? symbolsError[keyName] : 'No pairs'}
                                              >
                                                {strategySymbolOptions.map((symbol) => (
                                                  <Option key={`strategy-base-${strategy.id}-${symbol}`} value={symbol}>{symbol}</Option>
                                                ))}
                                              </Select>
                                            </Form.Item>

                                            <Form.Item label="Trade Quote">
                                              <Select
                                                value={strategy.quote_symbol}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { quote_symbol: String(value || '').toUpperCase() })}
                                                showSearch
                                                disabled={!keyActive}
                                                notFoundContent={symbolsError[keyName] ? symbolsError[keyName] : 'No pairs'}
                                              >
                                                {strategySymbolOptions.map((symbol) => (
                                                  <Option key={`strategy-quote-${strategy.id}-${symbol}`} value={symbol}>{symbol}</Option>
                                                ))}
                                              </Select>
                                            </Form.Item>

                                            <Form.Item label="Trade TF">
                                              <Select
                                                value={strategy.interval}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { interval: String(value || '1h') })}
                                                disabled={!keyActive}
                                              >
                                                <Option value="1m">1m</Option>
                                                <Option value="3m">3m</Option>
                                                <Option value="5m">5m</Option>
                                                <Option value="15m">15m</Option>
                                                <Option value="30m">30m</Option>
                                                <Option value="1h">1h</Option>
                                                <Option value="2h">2h</Option>
                                                <Option value="4h">4h</Option>
                                                <Option value="6h">6h</Option>
                                                <Option value="12h">12h</Option>
                                                <Option value="1d">1d</Option>
                                                <Option value="1w">1w</Option>
                                                <Option value="1M">1M</Option>
                                              </Select>
                                            </Form.Item>

                                            <Form.Item label="Base Coef">
                                              <InputNumber
                                                value={strategy.base_coef}
                                                min={-999}
                                                max={999}
                                                step={0.1}
                                                style={{ width: '100%' }}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { base_coef: Number(value) || 1 })}
                                                disabled={!keyActive}
                                              />
                                            </Form.Item>

                                            <Form.Item label="Quote Coef">
                                              <InputNumber
                                                value={strategy.quote_coef}
                                                min={-999}
                                                max={999}
                                                step={0.1}
                                                style={{ width: '100%' }}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { quote_coef: Number(value) || 1 })}
                                                disabled={!keyActive}
                                              />
                                            </Form.Item>

                                            <Form.Item
                                              label="Take-profit %"
                                              extra={strategy.strategy_type === 'stat_arb_zscore' ? '0 = TP disabled for stat-arb' : undefined}
                                            >
                                              <InputNumber
                                                value={strategy.take_profit_percent}
                                                min={0}
                                                max={200}
                                                step={0.1}
                                                style={{ width: '100%' }}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { take_profit_percent: Number(value) || 0 })}
                                                disabled={!keyActive}
                                              />
                                            </Form.Item>

                                            <Form.Item label="Channel Length">
                                              <InputNumber
                                                value={strategy.price_channel_length}
                                                min={2}
                                                max={500}
                                                style={{ width: '100%' }}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { price_channel_length: Math.max(2, Number(value) || 2) })}
                                                disabled={!keyActive}
                                              />
                                            </Form.Item>

                                            <Form.Item label="Detection">
                                              <Select
                                                value={strategy.detection_source}
                                                onChange={(value) => updateStrategyDraft(keyName, strategy.id, { detection_source: value as DetectionSource })}
                                                disabled={!keyActive}
                                              >
                                                <Option value="close">Close</Option>
                                                <Option value="wick">High/Low</Option>
                                              </Select>
                                            </Form.Item>

                                            <Form.Item label="Flags">
                                              <div className="strategy-flag-grid">
                                                <div className="strategy-flag-item">
                                                  <span>Display on chart</span>
                                                  <Switch
                                                    checked={strategy.display_on_chart}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { display_on_chart: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                                <div className="strategy-flag-item">
                                                  <span>Show settings</span>
                                                  <Switch
                                                    checked={strategy.show_settings}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { show_settings: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                                <div className="strategy-flag-item">
                                                  <span>Show chart</span>
                                                  <Switch
                                                    checked={strategy.show_chart}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { show_chart: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                                <div className="strategy-flag-item">
                                                  <span>Show indicators</span>
                                                  <Switch
                                                    checked={strategy.show_indicators}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { show_indicators: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                                <div className="strategy-flag-item">
                                                  <span>Show positions</span>
                                                  <Switch
                                                    checked={strategy.show_positions_on_chart}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { show_positions_on_chart: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                                <div className="strategy-flag-item">
                                                  <span>Show trades</span>
                                                  <Switch
                                                    checked={strategy.show_trades_on_chart}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { show_trades_on_chart: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                                <div className="strategy-flag-item">
                                                  <span>Values each bar</span>
                                                  <Switch
                                                    checked={strategy.show_values_each_bar}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { show_values_each_bar: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                                <div className="strategy-flag-item">
                                                  <span>Auto update</span>
                                                  <Switch
                                                    checked={strategy.auto_update}
                                                    onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { auto_update: checked })}
                                                    disabled={!keyActive}
                                                  />
                                                </div>
                                              </div>
                                            </Form.Item>
                                          </Form>
                                        </Card>
                                      </>
                                    ) : (
                                      <Card size="small" title="Strategy Settings">
                                        <Alert type="info" showIcon message="Strategy settings hidden by flag." />
                                        <Form
                                          layout="horizontal"
                                          className="strategy-compact-form strategy-inline-form"
                                          labelCol={{ span: 11 }}
                                          wrapperCol={{ span: 13 }}
                                          style={{ marginTop: 10 }}
                                        >
                                          <Form.Item label="Show settings">
                                            <Switch
                                              checked={strategy.show_settings}
                                              onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { show_settings: checked })}
                                              disabled={!keyActive}
                                            />
                                          </Form.Item>
                                        </Form>
                                      </Card>
                                    )}

                                    <Card size="small" title="Risk / Money Management" style={{ marginTop: 10 }}>
                                      <Form
                                        layout="horizontal"
                                        className="strategy-compact-form strategy-inline-form"
                                        labelCol={{ span: 11 }}
                                        wrapperCol={{ span: 13 }}
                                      >
                                        <Form.Item label="Name">
                                          <Input value={strategy.name} disabled />
                                        </Form.Item>

                                        <Form.Item label="Long enabled">
                                          <Switch
                                            checked={strategy.long_enabled}
                                            onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { long_enabled: checked })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>

                                        <Form.Item label="Short enabled">
                                          <Switch
                                            checked={strategy.short_enabled}
                                            onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { short_enabled: checked })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>

                                        <Form.Item label="Lot long, %">
                                          <InputNumber
                                            value={strategy.lot_long_percent}
                                            min={0}
                                            max={10000}
                                            step={0.1}
                                            style={{ width: '100%' }}
                                            onChange={(value) => updateStrategyDraft(keyName, strategy.id, { lot_long_percent: Number(value) || 0 })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>

                                        <Form.Item label="Lot short, %">
                                          <InputNumber
                                            value={strategy.lot_short_percent}
                                            min={0}
                                            max={10000}
                                            step={0.1}
                                            style={{ width: '100%' }}
                                            onChange={(value) => updateStrategyDraft(keyName, strategy.id, { lot_short_percent: Number(value) || 0 })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>

                                        <Form.Item label="Max deposit">
                                          <InputNumber
                                            value={strategy.max_deposit}
                                            min={0}
                                            max={100000000}
                                            step={1}
                                            style={{ width: '100%' }}
                                            onChange={(value) => updateStrategyDraft(keyName, strategy.id, { max_deposit: Number(value) || 0 })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>

                                        <Form.Item label="Margin">
                                          <Select
                                            value={strategy.margin_type}
                                            onChange={(value) => updateStrategyDraft(keyName, strategy.id, { margin_type: value as MarginType })}
                                            disabled={!keyActive}
                                          >
                                            <Option value="cross">Cross</Option>
                                            <Option value="isolated">Isolated</Option>
                                          </Select>
                                        </Form.Item>

                                        <Form.Item label="Leverage">
                                          <InputNumber
                                            value={strategy.leverage}
                                            min={1}
                                            max={100}
                                            step={1}
                                            style={{ width: '100%' }}
                                            onChange={(value) => updateStrategyDraft(keyName, strategy.id, { leverage: Math.max(1, Number(value) || 1) })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>

                                        <Form.Item label="Fixed lot">
                                          <Switch
                                            checked={strategy.fixed_lot}
                                            onChange={(checked) => updateStrategyDraft(keyName, strategy.id, { fixed_lot: checked })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>

                                        <Form.Item label="Reinvest, %">
                                          <InputNumber
                                            value={strategy.reinvest_percent}
                                            min={0}
                                            max={10000}
                                            step={0.1}
                                            style={{ width: '100%' }}
                                            onChange={(value) => updateStrategyDraft(keyName, strategy.id, { reinvest_percent: Number(value) || 0 })}
                                            disabled={!keyActive}
                                          />
                                        </Form.Item>
                                      </Form>
                                    </Card>
                                    <Space style={{ marginTop: 10 }} wrap>
                                      <Button
                                        type="primary"
                                        loading={saveLoading}
                                        disabled={!keyActive}
                                        onClick={() => {
                                          void saveStrategy(keyName, strategy);
                                        }}
                                      >
                                        Save
                                      </Button>

                                      <Button
                                        loading={executeLoading}
                                        disabled={!keyActive}
                                        onClick={() => {
                                          void executeStrategyNow(keyName, strategy);
                                        }}
                                      >
                                        Run now
                                      </Button>

                                      <Button
                                        loading={pauseLoading}
                                        disabled={!keyActive}
                                        onClick={() => {
                                          void pauseStrategyNow(keyName, strategy);
                                        }}
                                      >
                                        Pause
                                      </Button>

                                      <Button
                                        loading={cancelOrdersLoading}
                                        disabled={!keyActive}
                                        onClick={() => {
                                          void cancelStrategyOrdersNow(keyName, strategy);
                                        }}
                                      >
                                        Cancel orders
                                      </Button>

                                      <Button
                                        danger
                                        loading={closePositionsLoading}
                                        disabled={!keyActive}
                                        onClick={() => {
                                          void closeStrategyPositionsNow(keyName, strategy);
                                        }}
                                      >
                                        Close positions
                                      </Button>

                                      <Button
                                        danger
                                        loading={stopLoading}
                                        disabled={!keyActive}
                                        onClick={() => {
                                          void stopStrategyNow(keyName, strategy);
                                        }}
                                      >
                                        Stop
                                      </Button>

                                      <Popconfirm
                                        title="Delete strategy?"
                                        onConfirm={() => {
                                          void deleteStrategyNow(keyName, strategy);
                                        }}
                                      >
                                        <Button danger loading={deleteLoading} disabled={!keyActive}>Delete</Button>
                                      </Popconfirm>
                                    </Space>
                                  </Col>

                                  <Col xs={24} lg={16}>
                                    <Card size="small" title="Strategy Chart">
                                      {!strategy.show_chart
                                        ? <Alert type="info" showIcon message="Chart is hidden by strategy flag." />
                                        : strategyChartLoading && effectiveStrategyChartData.length === 0
                                          ? <Spin size="small" />
                                          : strategyChartError
                                            ? <Alert type="warning" showIcon message={strategyChartError} />
                                            : effectiveStrategyChartData.length === 0
                                              ? <Alert type="info" showIcon message="Loading strategy chart..." />
                                          : (
                                            <>
                                              {strategyShownOHLC
                                                ? (
                                                  <div style={{ marginBottom: 6 }}>
                                                    <strong>{strategyOhlcTitle}:</strong> O: {formatOHLCValue(strategyShownOHLC.open)} H: {formatOHLCValue(strategyShownOHLC.high)} L: {formatOHLCValue(strategyShownOHLC.low)} C: {formatOHLCValue(strategyShownOHLC.close)}
                                                  </div>
                                                )
                                                : null}

                                              {strategy.show_indicators && donchian
                                                ? (
                                                  <div style={{ marginBottom: 6 }}>
                                                    <strong>Donchian{strategy.show_values_each_bar ? ' (bar)' : ' (last)'}:</strong>
                                                    {' '}H: {donchianHighValue !== null ? formatOHLCValue(donchianHighValue) : '-'}
                                                    {' '}L: {donchianLowValue !== null ? formatOHLCValue(donchianLowValue) : '-'}
                                                    {' '}Center: {donchianCenterValue !== null ? formatOHLCValue(donchianCenterValue) : '-'}
                                                  </div>
                                                )
                                                : null}

                                              {strategy.show_indicators
                                                ? (
                                                  <div style={{ marginBottom: 6 }}>
                                                    <strong>TP type:</strong> Trailing
                                                    {' '}| <strong>SL type:</strong> Center
                                                    {donchianCenterValue !== null ? ` (${formatOHLCValue(donchianCenterValue)})` : ''}
                                                  </div>
                                                )
                                                : null}

                                              {strategy.show_indicators
                                                ? (
                                                  <div style={{ marginBottom: 6 }}>
                                                    <strong>Lot (USDT):</strong>
                                                    {' '}LONG: {longLotUsdt.value !== null ? `${formatCompactNumber(longLotUsdt.value, 2)}${longLotUsdt.estimated ? ' (est.)' : ''}` : '-'}
                                                    {' '}| SHORT: {shortLotUsdt.value !== null ? `${formatCompactNumber(shortLotUsdt.value, 2)}${shortLotUsdt.estimated ? ' (est.)' : ''}` : '-'}
                                                    {strategy.lot_balance_usdt !== null && strategy.lot_balance_usdt !== undefined
                                                      ? ` | Balance: ${formatCompactNumber(strategy.lot_balance_usdt, 2)}`
                                                      : ''}
                                                  </div>
                                                )
                                                : null}

                                              {strategy.show_indicators && tpWave
                                                ? (
                                                  <div style={{ marginBottom: 6 }}>
                                                    <strong>TP wave{strategy.show_values_each_bar ? ' (bar)' : ' (last)'}:</strong>
                                                    {' '}LONG: {tpLongWaveValue !== null ? formatOHLCValue(tpLongWaveValue) : '-'}
                                                    {' '}SHORT: {tpShortWaveValue !== null ? formatOHLCValue(tpShortWaveValue) : '-'}
                                                    {activeTpRatio !== null ? ` | Active TP: ${formatOHLCValue(activeTpRatio)}` : ''}
                                                  </div>
                                                )
                                                : null}

                                              {strategy.show_positions_on_chart
                                                ? (
                                                  <div style={{ marginBottom: 8 }}>
                                                    <strong>Position:</strong> {strategy.state.toUpperCase()}
                                                    {' '}<Tag color="cyan">SID{strategy.id}</Tag>
                                                    {strategy.last_signal ? ` | Signal: ${String(strategy.last_signal).toUpperCase()}` : ''}
                                                    {strategy.entry_ratio !== null && strategy.entry_ratio !== undefined
                                                      ? ` | Entry ratio: ${formatOHLCValue(strategy.entry_ratio)}`
                                                      : ''}
                                                    {strategy.last_action
                                                      ? <span style={{ marginLeft: 8, color: '#6b7280', fontSize: 11 }}>({String(strategy.last_action).split('@')[0]})</span>
                                                      : null}
                                                    {orderedPairRows.length > 0
                                                      ? orderedPairRows.map(({ symbol, position }) => {
                                                        const sideRaw = String(position?.side || '').toLowerCase();
                                                        const sideLabel = sideRaw === 'buy' ? 'LONG' : sideRaw === 'sell' ? 'SHORT' : 'FLAT';
                                                        const sideTagColor = sideRaw === 'buy' ? 'green' : sideRaw === 'sell' ? 'red' : 'default';
                                                        const sideBg = sideRaw === 'buy' ? 'rgba(22,163,74,0.08)' : sideRaw === 'sell' ? 'rgba(220,38,38,0.08)' : 'transparent';
                                                        const pnlRaw = Number(position?.unrealisedPnl);
                                                        const pnlColor = pnlRaw > 0 ? '#16a34a' : pnlRaw < 0 ? '#dc2626' : '#6b7280';
                                                        const sizeRaw = Number(position?.size || 0);
                                                        const sizeText = position ? formatCompactNumber(sizeRaw, 6) : '0';
                                                        const markPriceRaw = Number(position?.markPrice ?? position?.avgPrice ?? 0);
                                                        const sizeUsdt = Math.abs(sizeRaw) * markPriceRaw;
                                                        const entryRaw = Number(position?.avgPrice ?? position?.entryPrice);
                                                        const entryText = position && Number.isFinite(entryRaw)
                                                          ? formatCompactNumber(entryRaw, 6)
                                                          : '-';
                                                        const liqRaw = Number(position?.liqPrice);
                                                        const liqText = position && Number.isFinite(liqRaw) && liqRaw > 0
                                                          ? formatCompactNumber(liqRaw, 6)
                                                          : '-';
                                                        return (
                                                          <div
                                                            key={symbol}
                                                            style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '3px 6px', borderRadius: 4, background: sideBg }}
                                                          >
                                                            <Tag color={sideTagColor} style={{ fontWeight: 600 }}>{sideLabel}</Tag>
                                                            <Tag color="blue">{symbol}</Tag>
                                                            <span>{sizeText} coin</span>
                                                            <span style={{ color: '#6b7280' }}>≈ {Number.isFinite(sizeUsdt) && sizeUsdt > 0 ? formatCompactNumber(sizeUsdt, 2) : '-'} USDT</span>
                                                            <span>entry {entryText}</span>
                                                            <span style={{ color: pnlColor, fontWeight: 600 }}>
                                                              UPnL {position ? (Number.isFinite(pnlRaw) ? formatCompactNumber(pnlRaw, 4) : '-') : '0'} USDT
                                                            </span>
                                                            <span style={{ color: liqText !== '-' ? '#d97706' : '#6b7280' }}>liq {liqText}</span>
                                                          </div>
                                                        );
                                                      })
                                                      : null}
                                                  </div>
                                                )
                                                : null}

                                              <ChartComponent
                                                data={effectiveStrategyChartData}
                                                type={settings.chartType}
                                                overlayLines={strategyOverlays}
                                                markers={tradeMarkers}
                                                onHoverOHLC={(ohlc) => {
                                                  setStrategyHoverOHLCByKey((prev) => {
                                                    const current = prev[keyName]?.[strategyIdKey] || null;
                                                    if (isSameHoverOHLC(current, ohlc)) {
                                                      return prev;
                                                    }
                                                    return {
                                                      ...prev,
                                                      [keyName]: {
                                                        ...(prev[keyName] || {}),
                                                        [strategyIdKey]: ohlc,
                                                      },
                                                    };
                                                  });
                                                }}
                                              />
                                            </>
                                          )}
                                    </Card>
                                  </Col>
                                </Row>
                              </>
                              );
                            })(),
                          };
                        })}
                      />
                    )}
              </Card>
            </Col>
          </Row>

          {settings.showMonitoring !== false ? (
            <Row style={{ marginTop: 16 }}>
              <Col span={24}>
                <Card title="Monitoring">
                  <Space wrap style={{ marginBottom: 12 }}>
                    <Button
                      loading={monitoringLoading}
                      disabled={!keyActive}
                      onClick={() => {
                        void fetchMonitoring(keyName, { capture: true });
                      }}
                    >
                      Capture snapshot
                    </Button>
                    <Button
                      loading={monitoringLoading}
                      disabled={!keyActive}
                      onClick={() => {
                        void fetchMonitoring(keyName, { capture: false });
                      }}
                    >
                      Reload history
                    </Button>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>
                      Points: {monitoringPoints.length}
                    </span>
                    {monitoringLatest
                      ? (
                        <span style={{ fontSize: 12, color: '#6b7280' }}>
                          Last: {new Date(monitoringLatest.recorded_at).toLocaleString()}
                        </span>
                      )
                      : null}
                  </Space>

                  {monitoringError ? <Alert type="error" showIcon message={monitoringError} style={{ marginBottom: 12 }} /> : null}

                  {monitoringLoading
                    ? <Spin />
                    : monitoringPoints.length === 0
                      ? <Alert type="info" showIcon message="No monitoring history yet. Click Capture snapshot." />
                      : (
                        <>
                          {monitoringLatest ? (
                            <Space wrap style={{ marginBottom: 12 }}>
                              <Tag color="blue">Wallet: {formatCompactNumber(monitoringLatest.equity_usd, 2)} USDT</Tag>
                              <Tag color={monitoringLatest.unrealized_pnl >= 0 ? 'green' : 'red'}>
                                UPnL: {formatCompactNumber(monitoringLatest.unrealized_pnl, 2)}
                              </Tag>
                              <Tag color="cyan">
                                Equity: {formatCompactNumber(monitoringEquityWithUpnl, 2)} USDT
                              </Tag>
                              <Tag color="gold">
                                Drawdown: {formatCompactNumber(monitoringLatest.drawdown_percent, 2)}%
                              </Tag>
                              <Tag color="purple">
                                Margin load: {formatCompactNumber(monitoringLatest.margin_load_percent, 2)}%
                              </Tag>
                              <Tag>
                                Effective leverage: x{formatCompactNumber(monitoringLatest.effective_leverage, 2)}
                              </Tag>
                            </Space>
                          ) : null}

                          <Row gutter={[12, 12]}>
                            <Col xs={24} md={12}>
                              <Card size="small" title="Wallet (USDT)">
                                <ChartComponent
                                  data={toLineSeriesData(monitoringPoints, (point) => point.equity_usd)}
                                  type="line"
                                />
                              </Card>
                            </Col>
                            <Col xs={24} md={12}>
                              <Card size="small" title="Unrealized PnL">
                                <ChartComponent
                                  data={toLineSeriesData(monitoringPoints, (point) => point.unrealized_pnl)}
                                  type="line"
                                />
                              </Card>
                            </Col>
                            <Col xs={24} md={12}>
                              <Card size="small" title="Drawdown %">
                                <ChartComponent
                                  data={toLineSeriesData(monitoringPoints, (point) => point.drawdown_percent)}
                                  type="line"
                                />
                              </Card>
                            </Col>
                            <Col xs={24} md={12}>
                              <Card size="small" title="Margin Load %">
                                <ChartComponent
                                  data={toLineSeriesData(monitoringPoints, (point) => point.margin_load_percent)}
                                  type="line"
                                />
                              </Card>
                            </Col>
                          </Row>
                        </>
                      )}
                </Card>
              </Col>
            </Row>
          ) : null}
        </>
      ),
    };
  });

  return (
    <div className="dashboard-page">
      <Space style={{ marginBottom: 12 }} wrap>
        <h1 style={{ margin: 0 }}>Trading Bot Dashboard</h1>
        <Button
          loading={refreshAllAccountsLoading}
          onClick={() => {
            void refreshAllAccounts();
          }}
        >
          Update all keys
        </Button>
        <Button
          loading={Boolean(globalActionLoading['global:play-bots'])}
          onClick={() => {
            void runGlobalAction('play-bots', 'All bots resumed across all API keys');
          }}
        >
          Play all bots
        </Button>
        <Button
          loading={Boolean(globalActionLoading['global:pause-bots'])}
          onClick={() => {
            void runGlobalAction('pause-bots', 'All bots paused across all API keys');
          }}
        >
          Pause all bots
        </Button>
        <Popconfirm
          title="Cancel all open orders for all API keys?"
          onConfirm={() => {
            void runGlobalAction('cancel-orders', 'All open orders cancelled across all API keys');
          }}
        >
          <Button loading={Boolean(globalActionLoading['global:cancel-orders'])}>
            Cancel all orders
          </Button>
        </Popconfirm>
        <Popconfirm
          title="Close all positions for all API keys?"
          onConfirm={() => {
            void runGlobalAction('close-positions', 'All positions closed across all API keys');
          }}
        >
          <Button danger loading={Boolean(globalActionLoading['global:close-positions'])}>
            Close all positions
          </Button>
        </Popconfirm>
      </Space>
      <Collapse activeKey={activePanel} onChange={handlePanelChange} items={collapseItems} />
    </div>
  );
};

export default Dashboard;
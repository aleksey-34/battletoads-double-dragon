import type { ChartMarker, OverlayLine } from '../components/ChartComponent';

export type DetectionSource = 'wick' | 'close';

export type StrategyChartStrategy = {
  id: number;
  name: string;
  market_mode: 'mono' | 'synthetic';
  base_symbol: string;
  quote_symbol: string;
  interval: string;
  base_coef?: number;
  quote_coef?: number;
  price_channel_length: number;
  detection_source: DetectionSource;
  take_profit_percent: number;
  state: 'flat' | 'long' | 'short' | string;
  entry_ratio?: number | null;
  last_signal?: string | null;
  strategy_type?: string;
};

export type TradeRoundTrip = {
  entry: StrategyTradeEvent;
  exit?: StrategyTradeEvent;
};

export type TradeFlowSummary = {
  roundTrips: TradeRoundTrip[];
  openTrip?: TradeRoundTrip;
  upnlPercent: number | null;
  lastSignal: string;
};

export type StrategyTradeEvent = {
  id: number;
  strategyId: number;
  tradeType: 'entry' | 'exit';
  side: 'long' | 'short';
  symbol: string;
  price: number;
  qtyUsdt: number;
  timestamp: number;
  fee?: number;
  eventOrigin?: string;
};

export type TradeHistoryRow = {
  tradeId?: string;
  orderId?: string;
  symbol: string;
  side: string;
  qty?: string;
  price?: string;
  notional?: string;
  timestamp: string | number;
};

type ParsedCandlePoint = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type DonchianSnapshot = {
  highSeries: Array<{ time: number; value: number }>;
  lowSeries: Array<{ time: number; value: number }>;
  centerSeries: Array<{ time: number; value: number }>;
  overlays: OverlayLine[];
};

type TpWaveSnapshot = {
  overlays: OverlayLine[];
};

export const parseCandlePoint = (point: unknown): ParsedCandlePoint | null => {
  if (Array.isArray(point) && point.length >= 5) {
    const time = Number(point[0]);
    const open = Number(point[1]);
    const high = Number(point[2]);
    const low = Number(point[3]);
    const close = Number(point[4]);
    if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      return null;
    }
    return { time, open, high, low, close };
  }

  if (point && typeof point === 'object') {
    const row = point as Record<string, unknown>;
    if (row.open !== undefined && row.high !== undefined && row.low !== undefined && row.close !== undefined) {
      const time = Number(row.time);
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
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

const normalizeTimestampMs = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric > 9999999999 ? Math.floor(numeric) : Math.floor(numeric * 1000);
};

const formatTradeUsdtLabel = (usdt: number): string => {
  if (!Number.isFinite(usdt) || usdt <= 0) {
    return '';
  }
  if (usdt >= 1000) {
    return `${(usdt / 1000).toFixed(1)}k$`;
  }
  if (usdt >= 100) {
    return `${Math.round(usdt)}$`;
  }
  if (usdt >= 10) {
    return `${usdt.toFixed(0)}$`;
  }
  return `${usdt.toFixed(1)}$`;
};

const chartTimeBoundsFromCandles = (chartData: unknown[]): { minSec: number; maxSec: number } | null => {
  if (!Array.isArray(chartData) || chartData.length === 0) {
    return null;
  }
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = 0;
  chartData.forEach((point) => {
    const parsed = parseCandlePoint(point);
    if (!parsed) {
      return;
    }
    minMs = Math.min(minMs, parsed.time);
    maxMs = Math.max(maxMs, parsed.time);
  });
  if (!Number.isFinite(minMs) || maxMs <= 0) {
    return null;
  }
  return {
    minSec: Math.floor(minMs / 1000) - 120,
    maxSec: Math.floor(maxMs / 1000) + 120,
  };
};

export const strategyPairSymbols = (strategy: StrategyChartStrategy): string[] => {
  if (strategy.market_mode === 'mono') {
    return [String(strategy.base_symbol || '').toUpperCase()].filter(Boolean);
  }
  return [strategy.base_symbol, strategy.quote_symbol]
    .map((symbol) => String(symbol || '').toUpperCase().trim())
    .filter((symbol, index, array) => Boolean(symbol) && array.indexOf(symbol) === index);
};

/** Display symbol without ORDIUSDTUSDT-style duplication. */
export const formatStrategyDisplaySymbol = (strategy: Pick<StrategyChartStrategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>): string => {
  const base = String(strategy.base_symbol || '').trim().toUpperCase();
  const quote = String(strategy.quote_symbol || 'USDT').trim().toUpperCase();
  if (strategy.market_mode === 'synthetic') {
    return `${base}/${quote}`;
  }
  if (!base) {
    return quote;
  }
  if (base.endsWith(quote) || base.endsWith('USDT') || base.endsWith('USDC')) {
    return base;
  }
  return `${base}${quote}`;
};

const formatPnlPercent = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
};

export const roundTripPnlPercent = (entry: StrategyTradeEvent, exit: StrategyTradeEvent): number => {
  const ep = Number(entry.price);
  const xp = Number(exit.price);
  if (!Number.isFinite(ep) || !Number.isFinite(xp) || ep <= 0) {
    return 0;
  }
  if (entry.side === 'long') {
    return ((xp - ep) / ep) * 100;
  }
  return ((ep - xp) / ep) * 100;
};

export const pairStrategyRoundTrips = (events: StrategyTradeEvent[], strategyId?: number): TradeRoundTrip[] => {
  const sorted = [...events]
    .filter((e) => (strategyId === undefined || e.strategyId === strategyId))
    .sort((a, b) => a.timestamp - b.timestamp);

  const openEntries: StrategyTradeEvent[] = [];
  const trips: TradeRoundTrip[] = [];

  for (const event of sorted) {
    if (event.tradeType === 'entry') {
      openEntries.push(event);
      continue;
    }
    let matchIdx = -1;
    for (let i = openEntries.length - 1; i >= 0; i -= 1) {
      if (openEntries[i].side === event.side) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx >= 0) {
      const [entry] = openEntries.splice(matchIdx, 1);
      trips.push({ entry, exit: event });
    }
  }
  for (const entry of openEntries) {
    trips.push({ entry });
  }
  return trips;
};

const eventTimeSec = (event: StrategyTradeEvent): number | null => {
  const ms = normalizeTimestampMs(event.timestamp);
  return ms === null ? null : Math.floor(ms / 1000);
};

const latestCloseFromChart = (chartData: unknown[]): number | null => {
  const candles = chartData
    .map(parseCandlePoint)
    .filter((item): item is ParsedCandlePoint => !!item)
    .sort((a, b) => a.time - b.time);
  if (candles.length === 0) {
    return null;
  }
  const close = Number(candles[candles.length - 1].close);
  return Number.isFinite(close) && close > 0 ? close : null;
};

export const computeOpenUpnlPercent = (
  strategy: StrategyChartStrategy,
  openEntry: StrategyTradeEvent | undefined,
  chartData: unknown[],
): number | null => {
  const entryPrice = Number(openEntry?.price ?? strategy.entry_ratio);
  const mark = latestCloseFromChart(chartData);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || mark === null) {
    return null;
  }
  const state = String(strategy.state || 'flat').toLowerCase();
  if (state === 'long') {
    return ((mark - entryPrice) / entryPrice) * 100;
  }
  if (state === 'short') {
    return ((entryPrice - mark) / entryPrice) * 100;
  }
  return null;
};

export const buildTradeFlowSummary = (
  strategy: StrategyChartStrategy,
  events: StrategyTradeEvent[],
  chartData: unknown[],
): TradeFlowSummary => {
  const trips = pairStrategyRoundTrips(events, strategy.id);
  const completed = trips.filter((t) => t.exit);
  const openCandidates = trips.filter((t) => !t.exit);
  const openTrip = openCandidates.length > 0 ? openCandidates[openCandidates.length - 1] : undefined;
  return {
    roundTrips: completed.slice(-40),
    openTrip,
    upnlPercent: computeOpenUpnlPercent(strategy, openTrip?.entry, chartData),
    lastSignal: String(strategy.last_signal || '').trim() || '—',
  };
};

const MAX_FLOW_TRIPS = 24;

export const buildTradeFlowLayers = (
  strategy: StrategyChartStrategy,
  events: StrategyTradeEvent[],
  chartData: unknown[],
  idPrefix: string,
  options?: { maxTrips?: number },
): { overlayLines: OverlayLine[]; markers: ChartMarker[]; summary: TradeFlowSummary } => {
  const summary = buildTradeFlowSummary(strategy, events, chartData);
  const displaySymbol = formatStrategyDisplaySymbol(strategy);
  const overlayLines: OverlayLine[] = [];
  const markers: ChartMarker[] = [];
  const bounds = chartTimeBoundsFromCandles(chartData);
  const maxTrips = Math.max(1, Math.min(80, options?.maxTrips ?? MAX_FLOW_TRIPS));

  const tripsToDraw = [
    ...summary.roundTrips.slice(-maxTrips),
    ...(summary.openTrip ? [summary.openTrip] : []),
  ];

  tripsToDraw.forEach((trip, index) => {
    const entrySec = eventTimeSec(trip.entry);
    const entryPrice = Number(trip.entry.price);
    if (entrySec === null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return;
    }
    if (bounds && (entrySec < bounds.minSec || entrySec > bounds.maxSec)) {
      return;
    }

    const isLong = trip.entry.side === 'long';
    const entryColor = isLong ? '#16a34a' : '#dc2626';

    if (trip.exit) {
      const exitSec = eventTimeSec(trip.exit);
      const exitPrice = Number(trip.exit.price);
      if (exitSec === null || !Number.isFinite(exitPrice) || exitPrice <= 0) {
        return;
      }
      const pnl = roundTripPnlPercent(trip.entry, trip.exit);
      const flowColor = pnl >= 0 ? '#22c55e' : '#ef4444';

      overlayLines.push({
        id: `${idPrefix}:flow:${index}`,
        color: flowColor,
        lineWidth: 2,
        data: [
          { time: entrySec, value: entryPrice },
          { time: exitSec, value: exitPrice },
        ],
      });

      markers.push({
        id: `${idPrefix}:in:${trip.entry.id}`,
        time: entrySec,
        color: entryColor,
        shape: isLong ? 'arrowUp' : 'arrowDown',
        position: isLong ? 'belowBar' : 'aboveBar',
        text: `IN ${isLong ? 'L' : 'S'}`,
      });
      markers.push({
        id: `${idPrefix}:out:${trip.exit.id}`,
        time: exitSec,
        color: flowColor,
        shape: isLong ? 'arrowDown' : 'arrowUp',
        position: isLong ? 'aboveBar' : 'belowBar',
        text: `OUT ${formatPnlPercent(pnl)}`,
      });
      return;
    }

    // Open leg — arrow to current mark (UPnL preview)
    const mark = latestCloseFromChart(chartData);
    const upnl = summary.upnlPercent;
    const lastCandle = chartData
      .map(parseCandlePoint)
      .filter((item): item is ParsedCandlePoint => !!item)
      .sort((a, b) => a.time - b.time)
      .pop();
    const markSec = lastCandle ? normalizeOverlayTime(lastCandle.time) : entrySec;

    if (mark !== null && markSec > entrySec) {
      const previewColor = upnl !== null && upnl >= 0 ? '#22c55e' : '#f97316';
      overlayLines.push({
        id: `${idPrefix}:flow-open:${index}`,
        color: previewColor,
        lineWidth: 2,
        data: [
          { time: entrySec, value: entryPrice },
          { time: markSec, value: mark },
        ],
      });
    }

    markers.push({
      id: `${idPrefix}:open-in:${trip.entry.id}`,
      time: entrySec,
      color: entryColor,
      shape: isLong ? 'arrowUp' : 'arrowDown',
      position: isLong ? 'belowBar' : 'aboveBar',
      text: `IN ${displaySymbol} @ ${entryPrice.toFixed(4)}`,
    });
    if (upnl !== null) {
      markers.push({
        id: `${idPrefix}:open-upnl:${trip.entry.id}`,
        time: markSec,
        color: upnl >= 0 ? '#16a34a' : '#dc2626',
        shape: 'circle',
        position: 'aboveBar',
        text: `UPnL ${formatPnlPercent(upnl)}`,
      });
    }
  });

  return { overlayLines, markers, summary };
};

const normalizeOverlayTime = (time: number): number => {
  const numeric = Number(time);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
};

export const buildDonchianSnapshot = (
  payload: unknown[],
  length: number,
  source: DetectionSource,
  idPrefix: string,
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
    highSeries: highData,
    lowSeries: lowData,
    centerSeries: centerData,
    overlays: [
      { id: `${idPrefix}:donchian_high`, color: '#1f78ff', lineWidth: 2, data: highData },
      { id: `${idPrefix}:donchian_low`, color: '#1f78ff', lineWidth: 2, data: lowData },
      { id: `${idPrefix}:donchian_center`, color: '#ff8c00', lineWidth: 1, data: centerData },
    ],
  };
};

const buildConstantOverlay = (
  payload: unknown[],
  id: string,
  color: string,
  value: number,
  lineWidth: number = 1,
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
    data: candles.map((item) => ({ time: item.time, value })),
  };
};

export const buildEntryOverlay = (payload: unknown[], id: string, entryRatio: number): OverlayLine | null => {
  return buildConstantOverlay(payload, id, '#d97706', entryRatio, 2);
};

export const buildTpOverlay = (payload: unknown[], id: string, tpRatio: number): OverlayLine | null => {
  return buildConstantOverlay(payload, id, '#16a34a', tpRatio, 2);
};

const isZzPivotChartType = (strategyType: string): boolean => {
  const token = String(strategyType || '').trim();
  return token === 'ZZ_Fast' || token === 'ZZ_Instance' || token === 'zz_hamster_zz6' || token === 'zz_hamster_zz2';
};

const zzSlowMultiplier = (strategyType: string): number => {
  const token = String(strategyType || '').trim();
  return token === 'ZZ_Instance' || token === 'zz_hamster_zz2' ? 2 : 3;
};

const windowExtrema = (
  candles: ParsedCandlePoint[],
  endIndex: number,
  length: number,
  field: 'high' | 'low',
): number => {
  const start = Math.max(0, endIndex - length + 1);
  let extreme = field === 'high' ? -Infinity : Infinity;
  for (let i = start; i <= endIndex; i += 1) {
    const value = candles[i][field];
    extreme = field === 'high' ? Math.max(extreme, value) : Math.min(extreme, value);
  }
  return extreme;
};

export const buildZzPivotSnapshot = (
  payload: unknown[],
  fastLen: number,
  strategyType: string,
  idPrefix: string,
): DonchianSnapshot | null => {
  const candles = payload
    .map(parseCandlePoint)
    .filter((item): item is ParsedCandlePoint => !!item)
    .sort((a, b) => a.time - b.time);
  const fast = Math.max(2, Math.floor(fastLen || 20));
  const slow = Math.max(fast + 1, Math.round(fast * zzSlowMultiplier(strategyType)));
  if (candles.length < slow + 2) {
    return null;
  }

  const highData: Array<{ time: number; value: number }> = [];
  const lowData: Array<{ time: number; value: number }> = [];
  const centerData: Array<{ time: number; value: number }> = [];
  let levelLong = 0;
  let levelShort = 0;

  for (let i = 0; i < candles.length; i += 1) {
    if (i >= slow) {
      const fasth = windowExtrema(candles, i, fast, 'high');
      const slowh = windowExtrema(candles, i, slow, 'high');
      const fastl = windowExtrema(candles, i, fast, 'low');
      const slowl = windowExtrema(candles, i, slow, 'low');
      const prevFasth = windowExtrema(candles, i - 1, fast, 'high');
      const prevSlowh = windowExtrema(candles, i - 1, slow, 'high');
      const prevFastl = windowExtrema(candles, i - 1, fast, 'low');
      const prevSlowl = windowExtrema(candles, i - 1, slow, 'low');
      if (prevFasth === prevSlowh && fasth < prevFasth) {
        levelLong = prevFasth;
      }
      if (prevFastl === prevSlowl && fastl > prevFastl) {
        levelShort = prevFastl;
      }
    }
    const fallback = candles[i].close;
    const high = levelLong > 0 ? levelLong : fallback;
    const low = levelShort > 0 ? levelShort : fallback;
    highData.push({ time: candles[i].time, value: high });
    lowData.push({ time: candles[i].time, value: low });
    centerData.push({ time: candles[i].time, value: (high + low) / 2 });
  }

  return {
    highSeries: highData,
    lowSeries: lowData,
    centerSeries: centerData,
    overlays: [
      { id: `${idPrefix}:zz_long`, color: '#22c55e', lineWidth: 2, data: highData },
      { id: `${idPrefix}:zz_short`, color: '#ef4444', lineWidth: 2, data: lowData },
      { id: `${idPrefix}:zz_mid`, color: '#f59e0b', lineWidth: 1, data: centerData },
    ],
  };
};

export const buildSmaOverlay = (
  payload: unknown[],
  length: number,
  idPrefix: string,
): OverlayLine | null => {
  const candles = payload
    .map(parseCandlePoint)
    .filter((item): item is ParsedCandlePoint => !!item)
    .sort((a, b) => a.time - b.time);
  const period = Math.max(2, Math.floor(length || 20));
  if (candles.length < period) {
    return null;
  }
  const data: Array<{ time: number; value: number }> = [];
  let running = 0;
  for (let i = 0; i < candles.length; i += 1) {
    running += candles[i].close;
    if (i >= period) {
      running -= candles[i - period].close;
    }
    if (i >= period - 1) {
      data.push({ time: candles[i].time, value: running / period });
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { id: `${idPrefix}:sma`, color: '#a855f7', lineWidth: 2, data };
};

const buildTpWaveSnapshot = (
  donchian: DonchianSnapshot | null,
  takeProfitPercent: number,
  idPrefix: string,
): TpWaveSnapshot | null => {
  if (!donchian) {
    return null;
  }

  const factor = 1 + Math.max(0, Number(takeProfitPercent) || 0) / 100;
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
    overlays: [
      { id: `${idPrefix}:tp_long_wave`, color: '#52c41a', lineWidth: 1, data: longSeries },
      { id: `${idPrefix}:tp_short_wave`, color: '#faad14', lineWidth: 1, data: shortSeries },
    ],
  };
};

export const buildOpenPositionMarkers = (
  strategy: Pick<StrategyChartStrategy, 'id' | 'state' | 'base_symbol' | 'quote_symbol' | 'market_mode'>,
  chartData: unknown[],
  entryRatio: number | null | undefined,
): ChartMarker[] => {
  const state = String(strategy.state || 'flat').toLowerCase();
  if (state !== 'long' && state !== 'short') {
    return [];
  }
  const candles = chartData
    .map(parseCandlePoint)
    .filter((item): item is ParsedCandlePoint => !!item)
    .sort((a, b) => a.time - b.time);
  if (candles.length === 0) {
    return [];
  }
  const entry = Number(entryRatio);
  if (!Number.isFinite(entry) || entry <= 0) {
    return [];
  }
  const anchor = candles[Math.max(0, candles.length - 2)];
  const symbol = strategy.market_mode === 'synthetic'
    ? `${strategy.base_symbol}/${strategy.quote_symbol}`
    : `${strategy.base_symbol}${strategy.quote_symbol || 'USDT'}`;
  const isLong = state === 'long';
  return [{
    id: `open-pos-${strategy.id}-${anchor.time}`,
    time: anchor.time,
    color: isLong ? '#16a34a' : '#dc2626',
    shape: isLong ? 'arrowUp' : 'arrowDown',
    position: isLong ? 'belowBar' : 'aboveBar',
    text: `IN ${symbol} @ ${entry.toFixed(4)}`,
  }];
};

export const buildStrategyTradeMarkersFromEvents = (
  events: StrategyTradeEvent[],
  symbols: string[],
  options?: {
    strategyId?: number;
    chartData?: unknown[];
    markerLimit?: number;
  },
): ChartMarker[] => {
  if (!Array.isArray(events) || events.length === 0 || symbols.length === 0) {
    return [];
  }

  const symbolSet = new Set(symbols.map((symbol) => String(symbol || '').toUpperCase()));
  const bounds = options?.chartData ? chartTimeBoundsFromCandles(options.chartData) : null;
  const strategyId = options?.strategyId;
  const markerLimit = Math.max(10, Math.min(3000, options?.markerLimit ?? 800));

  return events
    .filter((event) => {
      if (strategyId !== undefined && Number(event.strategyId) !== strategyId) {
        return false;
      }
      const sym = String(event.symbol || '').toUpperCase();
      if (!symbolSet.has(sym)) {
        return false;
      }
      const timeSec = normalizeTimestampMs(event.timestamp);
      if (timeSec === null) {
        return false;
      }
      const timeUnix = Math.floor(timeSec / 1000);
      if (bounds && (timeUnix < bounds.minSec || timeUnix > bounds.maxSec)) {
        return false;
      }
      return true;
    })
    .map((event) => {
      const timeMs = normalizeTimestampMs(event.timestamp);
      if (timeMs === null) {
        return null;
      }
      const timeSec = Math.floor(timeMs / 1000);
      const usdtLabel = formatTradeUsdtLabel(Number(event.qtyUsdt));
      const isEntry = event.tradeType === 'entry';
      const isLong = event.side === 'long';
      const isBuy = isEntry ? isLong : !isLong;

      return {
        id: `lte-${event.id}-${timeSec}`,
        time: timeSec,
        color: isEntry ? (isLong ? '#16a34a' : '#dc2626') : '#d97706',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        position: isBuy ? 'belowBar' : 'aboveBar',
        text: `${isEntry ? (isLong ? 'L' : 'S') : 'X'}${usdtLabel ? ` ${usdtLabel}` : ''}`,
      } as ChartMarker;
    })
    .filter((marker): marker is ChartMarker => !!marker)
    .sort((left, right) => left.time - right.time)
    .slice(-markerLimit);
};

export const buildStrategyTradeMarkersFromExchange = (
  trades: TradeHistoryRow[],
  symbols: string[],
  options?: {
    chartData?: unknown[];
    markerLimit?: number;
  },
): ChartMarker[] => {
  if (!Array.isArray(trades) || trades.length === 0 || symbols.length === 0) {
    return [];
  }

  const symbolSet = new Set(symbols.map((symbol) => String(symbol || '').toUpperCase()));
  const bounds = options?.chartData ? chartTimeBoundsFromCandles(options.chartData) : null;
  const markerLimit = Math.max(10, Math.min(2000, options?.markerLimit ?? 400));

  return trades
    .filter((trade) => symbolSet.has(String(trade.symbol || '').toUpperCase()))
    .map((trade, index) => {
      const timeMs = normalizeTimestampMs(trade.timestamp);
      if (timeMs === null) {
        return null;
      }
      const timeSec = Math.floor(timeMs / 1000);
      if (bounds && (timeSec < bounds.minSec || timeSec > bounds.maxSec)) {
        return null;
      }

      const sideRaw = String(trade.side || '').toLowerCase();
      const isBuy = sideRaw === 'buy';
      const notional = Number(trade.notional);
      const usdtFromQty = Number(trade.qty) * Number(trade.price);
      const usdtLabel = formatTradeUsdtLabel(
        Number.isFinite(notional) && notional > 0 ? notional : usdtFromQty,
      );

      return {
        id: `ex-${trade.tradeId || trade.orderId || `trade-${index}`}-${trade.symbol}-${timeSec}`,
        time: timeSec,
        color: isBuy ? '#22c55e' : '#ef4444',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        position: isBuy ? 'belowBar' : 'aboveBar',
        text: `${isBuy ? 'B' : 'S'}${usdtLabel ? ` ${usdtLabel}` : ''}`,
      } as ChartMarker;
    })
    .filter((marker): marker is ChartMarker => !!marker)
    .sort((left, right) => left.time - right.time)
    .slice(-markerLimit);
};

export const buildStrategyTradeMarkers = (
  strategyEvents: StrategyTradeEvent[],
  exchangeTrades: TradeHistoryRow[],
  symbols: string[],
  strategyId: number,
  chartData?: unknown[],
): ChartMarker[] => {
  const fromLogs = buildStrategyTradeMarkersFromEvents(strategyEvents, symbols, {
    strategyId,
    chartData,
    markerLimit: 800,
  });
  if (fromLogs.length > 0) {
    return fromLogs;
  }
  return buildStrategyTradeMarkersFromExchange(exchangeTrades, symbols, { chartData, markerLimit: 400 });
};

export type OpenStrategyChartLayers = {
  overlayLines: OverlayLine[];
  markers: ChartMarker[];
  summary?: TradeFlowSummary;
};

export const buildOpenStrategyChartLayers = (
  strategy: StrategyChartStrategy,
  chartData: unknown[],
  strategyEvents: StrategyTradeEvent[],
  _exchangeTrades: TradeHistoryRow[],
  idPrefix: string,
): OpenStrategyChartLayers => {
  const channelLen = strategy.price_channel_length || 20;
  const zzLevels = isZzPivotChartType(String(strategy.strategy_type || ''))
    ? buildZzPivotSnapshot(chartData, channelLen, String(strategy.strategy_type || ''), idPrefix)
    : null;
  const donchian = zzLevels || buildDonchianSnapshot(
    chartData,
    channelLen,
    strategy.detection_source || 'wick',
    idPrefix,
  );
  const tpWave = zzLevels ? null : buildTpWaveSnapshot(donchian, strategy.take_profit_percent, idPrefix);
  const sma = buildSmaOverlay(chartData, channelLen, idPrefix);

  const entryRatioValue = strategy.entry_ratio !== null && strategy.entry_ratio !== undefined
    ? Number(strategy.entry_ratio)
    : null;
  const entryOverlay = entryRatioValue !== null
    && Number.isFinite(entryRatioValue)
    && strategy.state !== 'flat'
    ? buildEntryOverlay(chartData, `${idPrefix}:entry`, entryRatioValue)
    : null;

  const activeTpRatio = entryRatioValue !== null && Number.isFinite(entryRatioValue)
    ? strategy.state === 'long'
      ? entryRatioValue * (1 + strategy.take_profit_percent / 100)
      : strategy.state === 'short'
        ? entryRatioValue / (1 + strategy.take_profit_percent / 100)
        : null
    : null;

  const tpOverlay = strategy.state !== 'flat'
    && activeTpRatio !== null
    && Number.isFinite(activeTpRatio)
    ? buildTpOverlay(chartData, `${idPrefix}:tp`, Number(activeTpRatio))
    : null;

  const strategyEventsFiltered = strategyEvents.filter((e) => e.strategyId === strategy.id);
  const flow = buildTradeFlowLayers(strategy, strategyEventsFiltered, chartData, idPrefix);

  const overlayLines: OverlayLine[] = [
    ...(donchian ? donchian.overlays : []),
    ...(tpWave ? tpWave.overlays : []),
    ...(sma ? [sma] : []),
    ...(entryOverlay ? [entryOverlay] : []),
    ...(tpOverlay ? [tpOverlay] : []),
    ...flow.overlayLines,
  ];

  return {
    overlayLines,
    markers: flow.markers,
    summary: flow.summary,
  };
};

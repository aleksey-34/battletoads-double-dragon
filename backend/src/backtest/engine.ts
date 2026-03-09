import { Strategy } from '../config/settings';
import { getStrategies } from '../bot/strategy';
import { calculateSyntheticOHLC } from '../bot/synthetic';
import { db } from '../utils/database';

export type BacktestMode = 'single' | 'portfolio';

type DetectionSource = 'wick' | 'close';
type Signal = 'long' | 'short' | 'none';
type PositionState = 'flat' | 'long' | 'short';

type ParsedCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type BacktestPoint = {
  time: number;
  equity: number;
};

export type BacktestTrade = {
  strategyId: number;
  strategyName: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  notional: number;
  grossPnl: number;
  netPnl: number;
  pnlPercent: number;
  fees: number;
  funding: number;
  reason: string;
};

export type BacktestSummary = {
  mode: BacktestMode;
  apiKeyName: string;
  strategyIds: number[];
  strategyNames: string[];
  interval: string;
  barsRequested: number;
  barsProcessed: number;
  initialBalance: number;
  finalEquity: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  maxDrawdownAbsolute: number;
  tradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  commissionPercent: number;
  slippagePercent: number;
  fundingRatePercent: number;
};

export type BacktestRunRequest = {
  apiKeyName: string;
  mode?: BacktestMode;
  strategyId?: number;
  strategyIds?: number[];
  bars?: number;
  initialBalance?: number;
  commissionPercent?: number;
  slippagePercent?: number;
  fundingRatePercent?: number;
};

export type BacktestRunResult = {
  request: BacktestRunRequest;
  summary: BacktestSummary;
  equityCurve: BacktestPoint[];
  trades: BacktestTrade[];
  runId?: number;
};

export type BacktestRunListItem = {
  id: number;
  created_at: string;
  api_key_name: string;
  mode: BacktestMode;
  strategy_ids: number[];
  strategy_names: string[];
  interval: string;
  bars: number;
  initial_balance: number;
  final_equity: number;
  total_return_percent: number;
  max_drawdown_percent: number;
  trades_count: number;
  win_rate_percent: number;
  profit_factor: number;
};

const asNumber = (value: any, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const parseCandle = (item: any): ParsedCandle | null => {
  const timeMs = Number(item?.time);
  const open = Number(item?.open);
  const high = Number(item?.high);
  const low = Number(item?.low);
  const close = Number(item?.close);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return {
    timeMs,
    open,
    high,
    low,
    close,
  };
};

const computeSignalAtIndex = (
  candles: ParsedCandle[],
  index: number,
  length: number,
  source: DetectionSource,
  longEnabled: boolean,
  shortEnabled: boolean
): { signal: Signal; current: number; donchianCenter: number } => {
  if (index < length || index >= candles.length) {
    throw new Error(`Invalid index for signal calculation: ${index}`);
  }

  const current = candles[index];
  const window = candles.slice(index - length, index);

  if (window.length < length) {
    throw new Error(`Not enough candles for Donchian signal: need ${length}, got ${window.length}`);
  }

  const highs = source === 'close' ? window.map((bar) => bar.close) : window.map((bar) => bar.high);
  const lows = source === 'close' ? window.map((bar) => bar.close) : window.map((bar) => bar.low);

  const donchianHigh = Math.max(...highs);
  const donchianLow = Math.min(...lows);
  const donchianCenter = (donchianHigh + donchianLow) / 2;

  const longBreakout = source === 'close' ? current.close >= donchianHigh : current.high >= donchianHigh;
  const shortBreakout = source === 'close' ? current.close <= donchianLow : current.low <= donchianLow;

  if (longEnabled && longBreakout) {
    return {
      signal: 'long',
      current: current.close,
      donchianCenter,
    };
  }

  if (shortEnabled && shortBreakout) {
    return {
      signal: 'short',
      current: current.close,
      donchianCenter,
    };
  }

  return {
    signal: 'none',
    current: current.close,
    donchianCenter,
  };
};

type OpenTradeState = {
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  notional: number;
  entryFee: number;
  funding: number;
};

type RuntimeStrategy = {
  strategy: Strategy;
  candles: ParsedCandle[];
  currentPrice: number;
  state: PositionState;
  entryPrice: number | null;
  notional: number;
  openTrade: OpenTradeState | null;
};

type BacktestContext = {
  cashEquity: number;
  commissionRate: number;
  slippageRate: number;
  fundingRate: number;
  trades: BacktestTrade[];
};

const executionPrice = (price: number, side: 'long' | 'short', phase: 'entry' | 'exit', slippageRate: number): number => {
  if (!Number.isFinite(price) || price <= 0) {
    return price;
  }

  if (phase === 'entry') {
    return side === 'long'
      ? price * (1 + slippageRate)
      : price * (1 - slippageRate);
  }

  return side === 'long'
    ? price * (1 - slippageRate)
    : price * (1 + slippageRate);
};

const unrealizedPnl = (runtime: RuntimeStrategy): number => {
  if (runtime.state === 'flat' || !runtime.entryPrice || !Number.isFinite(runtime.notional) || runtime.notional <= 0) {
    return 0;
  }

  if (!Number.isFinite(runtime.currentPrice) || runtime.currentPrice <= 0) {
    return 0;
  }

  if (runtime.state === 'long') {
    return runtime.notional * ((runtime.currentPrice / runtime.entryPrice) - 1);
  }

  return runtime.notional * ((runtime.entryPrice / runtime.currentPrice) - 1);
};

const portfolioEquity = (cashEquity: number, runtimes: RuntimeStrategy[]): number => {
  const unrealized = runtimes.reduce((sum, runtime) => sum + unrealizedPnl(runtime), 0);
  return cashEquity + unrealized;
};

const applyFunding = (ctx: BacktestContext, runtime: RuntimeStrategy): void => {
  if (!runtime.openTrade || runtime.state === 'flat' || runtime.notional <= 0) {
    return;
  }

  if (!Number.isFinite(ctx.fundingRate) || ctx.fundingRate === 0) {
    return;
  }

  const fundingCash = runtime.state === 'long'
    ? -runtime.notional * ctx.fundingRate
    : runtime.notional * ctx.fundingRate;

  ctx.cashEquity += fundingCash;
  runtime.openTrade.funding += fundingCash;
};

const closePosition = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  strategyId: number,
  strategyName: string,
  exitTime: number,
  marketPrice: number,
  reason: string
): void => {
  if (!runtime.openTrade || !runtime.entryPrice || runtime.notional <= 0 || runtime.state === 'flat') {
    runtime.state = 'flat';
    runtime.entryPrice = null;
    runtime.notional = 0;
    runtime.openTrade = null;
    return;
  }

  const side = runtime.openTrade.side;
  const exitPrice = executionPrice(marketPrice, side, 'exit', ctx.slippageRate);
  const entryPrice = runtime.openTrade.entryPrice;
  const notional = runtime.openTrade.notional;

  let grossPnl = 0;
  if (side === 'long') {
    grossPnl = notional * ((exitPrice / entryPrice) - 1);
  } else {
    grossPnl = notional * ((entryPrice / exitPrice) - 1);
  }

  const exitFee = notional * ctx.commissionRate;
  ctx.cashEquity += grossPnl - exitFee;

  const netPnl = grossPnl - runtime.openTrade.entryFee - exitFee + runtime.openTrade.funding;
  const pnlPercent = entryPrice > 0
    ? (side === 'long'
      ? ((exitPrice / entryPrice) - 1) * 100
      : ((entryPrice / exitPrice) - 1) * 100)
    : 0;

  ctx.trades.push({
    strategyId,
    strategyName,
    side,
    entryTime: runtime.openTrade.entryTime,
    exitTime,
    entryPrice,
    exitPrice,
    notional,
    grossPnl,
    netPnl,
    pnlPercent,
    fees: runtime.openTrade.entryFee + exitFee,
    funding: runtime.openTrade.funding,
    reason,
  });

  runtime.state = 'flat';
  runtime.entryPrice = null;
  runtime.notional = 0;
  runtime.openTrade = null;
};

const openPosition = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  signal: 'long' | 'short',
  eventTime: number,
  marketPrice: number,
  portfolioEquityNow: number
): boolean => {
  const strategy = runtime.strategy;
  const leverage = Math.max(1, asNumber(strategy.leverage, 1));

  const lotPercent = signal === 'long'
    ? asNumber(strategy.lot_long_percent, 0)
    : asNumber(strategy.lot_short_percent, 0);

  const lotFraction = Math.max(0, lotPercent) / 100;
  if (lotFraction <= 0) {
    return false;
  }

  const reinvestFactor = strategy.fixed_lot
    ? 1
    : 1 + Math.max(0, asNumber(strategy.reinvest_percent, 0)) / 100;

  const maxDeposit = asNumber(strategy.max_deposit, 0);
  const cappedBalance = maxDeposit > 0
    ? Math.min(portfolioEquityNow, maxDeposit)
    : portfolioEquityNow;

  const baseCapital = strategy.fixed_lot
    ? (maxDeposit > 0 ? maxDeposit : portfolioEquityNow)
    : cappedBalance;

  const notional = baseCapital * lotFraction * reinvestFactor * leverage;
  if (!Number.isFinite(notional) || notional <= 0) {
    return false;
  }

  const entryPrice = executionPrice(marketPrice, signal, 'entry', ctx.slippageRate);
  const entryFee = notional * ctx.commissionRate;

  ctx.cashEquity -= entryFee;

  runtime.state = signal;
  runtime.entryPrice = entryPrice;
  runtime.notional = notional;
  runtime.openTrade = {
    side: signal,
    entryTime: eventTime,
    entryPrice,
    notional,
    entryFee,
    funding: 0,
  };

  return true;
};

type StrategyEvent = {
  strategyIndex: number;
  candleIndex: number;
  timeMs: number;
};

const buildEvents = (runtimes: RuntimeStrategy[]): StrategyEvent[] => {
  const events: StrategyEvent[] = [];

  runtimes.forEach((runtime, strategyIndex) => {
    const length = Math.max(2, Math.floor(asNumber(runtime.strategy.price_channel_length, 50)));

    for (let index = length; index < runtime.candles.length; index += 1) {
      events.push({
        strategyIndex,
        candleIndex: index,
        timeMs: runtime.candles[index].timeMs,
      });
    }
  });

  events.sort((left, right) => {
    if (left.timeMs === right.timeMs) {
      return left.strategyIndex - right.strategyIndex;
    }
    return left.timeMs - right.timeMs;
  });

  return events;
};

const loadRuntimeStrategies = async (
  apiKeyName: string,
  strategies: Strategy[],
  barsRequested: number
): Promise<RuntimeStrategy[]> => {
  const runtimes: RuntimeStrategy[] = [];

  for (const strategy of strategies) {
    const length = Math.max(2, Math.floor(asNumber(strategy.price_channel_length, 50)));
    const candlesLimit = Math.max(length + 40, barsRequested);

    const raw = await calculateSyntheticOHLC(
      apiKeyName,
      strategy.base_symbol,
      strategy.quote_symbol,
      asNumber(strategy.base_coef, 1),
      asNumber(strategy.quote_coef, 1),
      strategy.interval,
      candlesLimit
    );

    const candles = (Array.isArray(raw) ? raw : [])
      .map((item) => parseCandle(item))
      .filter((item): item is ParsedCandle => !!item)
      .sort((a, b) => a.timeMs - b.timeMs);

    if (candles.length <= length) {
      throw new Error(
        `Not enough candles for strategy ${strategy.name} (${strategy.base_symbol}/${strategy.quote_symbol}): got ${candles.length}, need > ${length}`
      );
    }

    runtimes.push({
      strategy,
      candles,
      currentPrice: candles[length].close,
      state: 'flat',
      entryPrice: null,
      notional: 0,
      openTrade: null,
    });
  }

  return runtimes;
};

const normalizeRequest = (raw: BacktestRunRequest): Required<BacktestRunRequest> => {
  const mode: BacktestMode = raw.mode === 'portfolio' ? 'portfolio' : 'single';
  const bars = Math.max(120, Math.floor(asNumber(raw.bars, 1200)));
  const initialBalance = Math.max(10, asNumber(raw.initialBalance, 1000));
  const commissionPercent = clamp(asNumber(raw.commissionPercent, 0.06), 0, 5);
  const slippagePercent = clamp(asNumber(raw.slippagePercent, 0.03), 0, 5);
  const fundingRatePercent = clamp(asNumber(raw.fundingRatePercent, 0), -5, 5);

  return {
    apiKeyName: String(raw.apiKeyName || '').trim(),
    mode,
    strategyId: Number.isFinite(Number(raw.strategyId)) ? Number(raw.strategyId) : 0,
    strategyIds: Array.isArray(raw.strategyIds)
      ? raw.strategyIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
      : [],
    bars,
    initialBalance,
    commissionPercent,
    slippagePercent,
    fundingRatePercent,
  };
};

const pickStrategiesForRequest = async (request: Required<BacktestRunRequest>): Promise<Strategy[]> => {
  const all = await getStrategies(request.apiKeyName);

  if (request.mode === 'single') {
    const id = request.strategyId;
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('strategyId is required for single mode');
    }

    const found = all.find((item) => Number(item.id) === id);
    if (!found) {
      throw new Error(`Strategy ${id} not found for api key ${request.apiKeyName}`);
    }

    return [found];
  }

  const ids = request.strategyIds;
  if (ids.length === 0) {
    throw new Error('strategyIds[] is required for portfolio mode');
  }

  const uniqueIds = Array.from(new Set(ids));
  const selected = all.filter((item) => uniqueIds.includes(Number(item.id)));

  if (selected.length !== uniqueIds.length) {
    const foundIds = selected.map((item) => Number(item.id));
    const missing = uniqueIds.filter((id) => !foundIds.includes(id));
    throw new Error(`Strategies not found for api key ${request.apiKeyName}: ${missing.join(', ')}`);
  }

  return selected;
};

export const runBacktest = async (rawRequest: BacktestRunRequest): Promise<BacktestRunResult> => {
  const request = normalizeRequest(rawRequest);
  if (!request.apiKeyName) {
    throw new Error('apiKeyName is required');
  }

  const strategies = await pickStrategiesForRequest(request);
  const runtimes = await loadRuntimeStrategies(request.apiKeyName, strategies, request.bars);
  const events = buildEvents(runtimes);

  if (events.length === 0) {
    throw new Error('No strategy events available for backtest');
  }

  const ctx: BacktestContext = {
    cashEquity: request.initialBalance,
    commissionRate: request.commissionPercent / 100,
    slippageRate: request.slippagePercent / 100,
    fundingRate: request.fundingRatePercent / 100,
    trades: [],
  };

  const equityCurve: BacktestPoint[] = [];
  let peak = request.initialBalance;
  let maxDrawdownAbsolute = 0;
  let maxDrawdownPercent = 0;

  const pushEquityPoint = (timeMs: number) => {
    const value = portfolioEquity(ctx.cashEquity, runtimes);
    equityCurve.push({
      time: Math.floor(timeMs / 1000),
      equity: value,
    });

    peak = Math.max(peak, value);
    const drawdownAbs = peak - value;
    const drawdownPct = peak > 0 ? (drawdownAbs / peak) * 100 : 0;

    maxDrawdownAbsolute = Math.max(maxDrawdownAbsolute, drawdownAbs);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPct);
  };

  for (const event of events) {
    const runtime = runtimes[event.strategyIndex];
    const strategy = runtime.strategy;
    const candle = runtime.candles[event.candleIndex];
    runtime.currentPrice = candle.close;

    applyFunding(ctx, runtime);

    const length = Math.max(2, Math.floor(asNumber(strategy.price_channel_length, 50)));
    const signalPayload = computeSignalAtIndex(
      runtime.candles,
      event.candleIndex,
      length,
      strategy.detection_source,
      strategy.long_enabled,
      strategy.short_enabled
    );

    const state = runtime.state;
    const entryPrice = runtime.entryPrice;
    const takeProfitFactor = 1 + Math.max(0, asNumber(strategy.take_profit_percent, 0)) / 100;

    if (state === 'long' && entryPrice && signalPayload.current >= entryPrice * takeProfitFactor) {
      closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'take_profit_long');
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (state === 'short' && entryPrice && signalPayload.current <= entryPrice / takeProfitFactor) {
      closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'take_profit_short');
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (state === 'long' && entryPrice && signalPayload.current <= signalPayload.donchianCenter) {
      closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'stop_loss_long_center');
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (state === 'short' && entryPrice && signalPayload.current >= signalPayload.donchianCenter) {
      closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'stop_loss_short_center');
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (signalPayload.signal === 'none') {
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (state === signalPayload.signal) {
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (state !== 'flat') {
      closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'signal_flip');
    }

    const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
    openPosition(ctx, runtime, signalPayload.signal, event.timeMs, signalPayload.current, equityNow);
    pushEquityPoint(event.timeMs);
  }

  const lastTime = events[events.length - 1].timeMs;
  for (const runtime of runtimes) {
    if (runtime.state !== 'flat') {
      const lastCandle = runtime.candles[runtime.candles.length - 1];
      runtime.currentPrice = lastCandle.close;
      closePosition(
        ctx,
        runtime,
        Number(runtime.strategy.id),
        runtime.strategy.name,
        lastCandle.timeMs,
        lastCandle.close,
        'end_of_test'
      );
    }
  }

  pushEquityPoint(lastTime + 1000);

  const finalEquity = portfolioEquity(ctx.cashEquity, runtimes);

  const wins = ctx.trades.filter((trade) => trade.netPnl > 0).length;
  const tradesCount = ctx.trades.length;
  const winRatePercent = tradesCount > 0 ? (wins / tradesCount) * 100 : 0;

  const grossProfit = ctx.trades
    .filter((trade) => trade.netPnl > 0)
    .reduce((sum, trade) => sum + trade.netPnl, 0);

  const grossLoss = Math.abs(
    ctx.trades
      .filter((trade) => trade.netPnl < 0)
      .reduce((sum, trade) => sum + trade.netPnl, 0)
  );

  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0
      ? 999
      : 0;

  const strategyIds = strategies.map((item) => Number(item.id));
  const strategyNames = strategies.map((item) => item.name);

  const uniqueIntervals = Array.from(new Set(strategies.map((item) => String(item.interval || '1h'))));
  const interval = uniqueIntervals.length === 1 ? uniqueIntervals[0] : 'mixed';

  const summary: BacktestSummary = {
    mode: request.mode,
    apiKeyName: request.apiKeyName,
    strategyIds,
    strategyNames,
    interval,
    barsRequested: request.bars,
    barsProcessed: events.length,
    initialBalance: request.initialBalance,
    finalEquity,
    totalReturnPercent: request.initialBalance > 0 ? ((finalEquity / request.initialBalance) - 1) * 100 : 0,
    maxDrawdownPercent,
    maxDrawdownAbsolute,
    tradesCount,
    winRatePercent,
    profitFactor,
    grossProfit,
    grossLoss,
    commissionPercent: request.commissionPercent,
    slippagePercent: request.slippagePercent,
    fundingRatePercent: request.fundingRatePercent,
  };

  return {
    request,
    summary,
    equityCurve,
    trades: ctx.trades,
  };
};

export const saveBacktestRun = async (result: BacktestRunResult): Promise<number> => {
  const summary = result.summary;

  const insert: any = await db.run(
    `INSERT INTO backtest_runs (
      api_key_name,
      mode,
      strategy_ids,
      strategy_names,
      interval,
      bars,
      initial_balance,
      final_equity,
      total_return_percent,
      max_drawdown_percent,
      trades_count,
      win_rate_percent,
      profit_factor,
      commission_percent,
      slippage_percent,
      funding_rate_percent,
      request_json,
      summary_json,
      equity_curve_json,
      trades_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      summary.apiKeyName,
      summary.mode,
      JSON.stringify(summary.strategyIds),
      JSON.stringify(summary.strategyNames),
      summary.interval,
      summary.barsRequested,
      summary.initialBalance,
      summary.finalEquity,
      summary.totalReturnPercent,
      summary.maxDrawdownPercent,
      summary.tradesCount,
      summary.winRatePercent,
      summary.profitFactor,
      summary.commissionPercent,
      summary.slippagePercent,
      summary.fundingRatePercent,
      JSON.stringify(result.request),
      JSON.stringify(result.summary),
      JSON.stringify(result.equityCurve),
      JSON.stringify(result.trades),
    ]
  );

  return Number(insert?.lastID || 0);
};

const parseJsonArray = <T>(value: any, fallback: T[]): T[] => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const parseJsonObject = <T>(value: any, fallback: T): T => {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed as T;
  } catch {
    return fallback;
  }
};

export const listBacktestRuns = async (limit: number = 20, apiKeyName?: string): Promise<BacktestRunListItem[]> => {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(asNumber(limit, 20))));

  const rows = apiKeyName
    ? await db.all(
      `SELECT * FROM backtest_runs WHERE api_key_name = ? ORDER BY id DESC LIMIT ?`,
      [apiKeyName, safeLimit]
    )
    : await db.all(
      `SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?`,
      [safeLimit]
    );

  return (Array.isArray(rows) ? rows : []).map((row: any) => ({
    id: Number(row.id),
    created_at: String(row.created_at || ''),
    api_key_name: String(row.api_key_name || ''),
    mode: String(row.mode || 'single') === 'portfolio' ? 'portfolio' : 'single',
    strategy_ids: parseJsonArray<number>(row.strategy_ids, []),
    strategy_names: parseJsonArray<string>(row.strategy_names, []),
    interval: String(row.interval || ''),
    bars: asNumber(row.bars, 0),
    initial_balance: asNumber(row.initial_balance, 0),
    final_equity: asNumber(row.final_equity, 0),
    total_return_percent: asNumber(row.total_return_percent, 0),
    max_drawdown_percent: asNumber(row.max_drawdown_percent, 0),
    trades_count: Math.floor(asNumber(row.trades_count, 0)),
    win_rate_percent: asNumber(row.win_rate_percent, 0),
    profit_factor: asNumber(row.profit_factor, 0),
  }));
};

export const getBacktestRun = async (id: number): Promise<BacktestRunResult | null> => {
  const runId = Math.floor(asNumber(id, 0));
  if (!Number.isFinite(runId) || runId <= 0) {
    return null;
  }

  const row: any = await db.get(`SELECT * FROM backtest_runs WHERE id = ?`, [runId]);
  if (!row) {
    return null;
  }

  const request = parseJsonObject<BacktestRunRequest>(row.request_json, {
    apiKeyName: String(row.api_key_name || ''),
  });

  const summary = parseJsonObject<BacktestSummary>(row.summary_json, {
    mode: String(row.mode || 'single') === 'portfolio' ? 'portfolio' : 'single',
    apiKeyName: String(row.api_key_name || ''),
    strategyIds: parseJsonArray<number>(row.strategy_ids, []),
    strategyNames: parseJsonArray<string>(row.strategy_names, []),
    interval: String(row.interval || ''),
    barsRequested: asNumber(row.bars, 0),
    barsProcessed: 0,
    initialBalance: asNumber(row.initial_balance, 0),
    finalEquity: asNumber(row.final_equity, 0),
    totalReturnPercent: asNumber(row.total_return_percent, 0),
    maxDrawdownPercent: asNumber(row.max_drawdown_percent, 0),
    maxDrawdownAbsolute: 0,
    tradesCount: Math.floor(asNumber(row.trades_count, 0)),
    winRatePercent: asNumber(row.win_rate_percent, 0),
    profitFactor: asNumber(row.profit_factor, 0),
    grossProfit: 0,
    grossLoss: 0,
    commissionPercent: asNumber(row.commission_percent, 0),
    slippagePercent: asNumber(row.slippage_percent, 0),
    fundingRatePercent: asNumber(row.funding_rate_percent, 0),
  });

  const equityCurve = parseJsonArray<BacktestPoint>(row.equity_curve_json, []);
  const trades = parseJsonArray<BacktestTrade>(row.trades_json, []);

  return {
    runId,
    request,
    summary,
    equityCurve,
    trades,
  };
};

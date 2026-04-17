/**
 * Live vs Backtest Reconciliation Tracker
 * 
 * Сравнивает реальную торговлю с backtest предсказаниями:
 * - Entry timing/price lag
 * - Slippage profiles
 * - Funding/commission drift
 * - Actual vs expected PnL
 * - Drawdown realization
 */

import { db } from '../utils/database';

export type LiveTradeEventOrigin = 'strategy_signal' | 'exchange_fill' | 'external';

export type LiveTradeEvent = {
  id: number;
  strategy_id: number;
  trade_type: 'entry' | 'exit';
  side: 'long' | 'short';
  event_origin?: LiveTradeEventOrigin;
  entry_time: number;
  entry_price: number;
  position_size: number;
  
  // Реальное исполнение
  actual_price: number;
  actual_time: number;
  actual_fee: number;
  slippage_percent: number;
  source_trade_id?: string;
  source_order_id?: string;
  source_symbol?: string;
  
  // Если есть backtest для сравнения
  backtest_predicted_price?: number;
  backtest_predicted_time?: number;
  backtest_predicted_fee?: number;
};

const normalizeEventOrigin = (value: unknown): LiveTradeEventOrigin | null => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'strategy_signal' || raw === 'exchange_fill' || raw === 'external') {
    return raw as LiveTradeEventOrigin;
  }
  return null;
};

export const inferLiveTradeEventOrigin = (event: Partial<LiveTradeEvent> | Record<string, unknown>): LiveTradeEventOrigin => {
  const explicit = normalizeEventOrigin((event as any)?.event_origin);
  if (explicit) {
    return explicit;
  }

  const sourceTradeId = String((event as any)?.source_trade_id || '').trim();
  const sourceOrderId = String((event as any)?.source_order_id || '').trim();
  const actualFee = Number((event as any)?.actual_fee || 0);
  if (sourceTradeId || sourceOrderId || Math.abs(actualFee) > 0) {
    return 'exchange_fill';
  }

  return 'strategy_signal';
};

export type BacktestTradePrediction = {
  strategy_id: number;
  side: 'long' | 'short';
  predicted_entry_price: number;
  predicted_entry_time: number;
  predicted_exit_price: number;
  predicted_exit_time: number;
  predicted_pnl: number;
  predicted_pnl_percent: number;
  predicted_slippage_percent: number;
};

export type ReconciliationMetrics = {
  strategy_id: number;
  
  // Точность
  entry_price_deviation_percent: number;  // |live - backtest| / backtest
  entry_time_lag_seconds: number;         // (actual - predicted)
  exit_price_deviation_percent: number;
  
  // Издержки
  actual_avg_slippage_percent: number;
  actual_avg_fee_percent: number;
  backtest_assumed_slippage_percent: number;
  backtest_assumed_fee_percent: number;
  
  // PnL impact
  pnl_impact_from_slippage: number;       // dollars
  pnl_impact_from_fees: number;
  total_execution_cost: number;
  
  // Потери vs expectation
  realized_vs_predicted_pnl_percent: number;
  win_rate_live: number;
  win_rate_backtest: number;
  
  // Дата за период
  period_start: number;
  period_end: number;
  samples_count: number;
};

export type DriftAlert = {
  id?: number;
  strategy_id: number;
  metric_name: string;  // 'entry_price_deviation', 'pnl_impact', 'win_rate', etc
  severity: 'warning' | 'critical';
  value: number;
  threshold: number;
  drift_percent: number;  // (value - threshold) / threshold * 100
  description: string;
  created_at?: number;
};

/**
 * Сохранить реальное исполнение
 */
export async function recordLiveTradeEvent(
  strategyId: number,
  event: Omit<LiveTradeEvent, 'id' | 'strategy_id'>
): Promise<LiveTradeEvent> {
  const eventOrigin = inferLiveTradeEventOrigin(event as unknown as Record<string, unknown>);
  const result = await db.run(
    `INSERT INTO live_trade_events (
      strategy_id, trade_type, side, event_origin, entry_time, entry_price, 
      position_size, actual_price, actual_time, actual_fee, slippage_percent,
      source_trade_id, source_order_id, source_symbol
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      strategyId,
      event.trade_type,
      event.side,
      eventOrigin,
      event.entry_time,
      event.entry_price,
      event.position_size,
      event.actual_price,
      event.actual_time,
      event.actual_fee,
      event.slippage_percent,
      event.source_trade_id || null,
      event.source_order_id || null,
      event.source_symbol || null,
    ]
  );

  return {
    id: result.lastID as number,
    strategy_id: strategyId,
    event_origin: eventOrigin,
    ...event,
  };
}

/**
 * Сохранить backtest предсказание для стратегии
 */
export async function recordBacktestPrediction(
  strategyId: number,
  prediction: BacktestTradePrediction
): Promise<void> {
  await db.run(
    `INSERT INTO backtest_predictions (
      strategy_id, side, predicted_entry_price, predicted_entry_time,
      predicted_exit_price, predicted_exit_time, predicted_pnl,
      predicted_pnl_percent, predicted_slippage_percent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      strategyId,
      prediction.side,
      prediction.predicted_entry_price,
      prediction.predicted_entry_time,
      prediction.predicted_exit_price,
      prediction.predicted_exit_time,
      prediction.predicted_pnl,
      prediction.predicted_pnl_percent,
      prediction.predicted_slippage_percent,
      Date.now(),
    ]
  );
}

/**
 * Вычислить metrics за период
 */
export async function computeReconciliationMetrics(
  strategyId: number,
  periodStartMs: number,
  periodEndMs: number
): Promise<ReconciliationMetrics> {
  // Получить live события
  const liveEvents = await db.all(
    `SELECT * FROM live_trade_events 
     WHERE strategy_id = ? AND actual_time BETWEEN ? AND ?
     ORDER BY actual_time ASC`,
    [strategyId, periodStartMs, periodEndMs]
  );

  // Получить backtest предсказания
  const predictions = await db.all(
    `SELECT * FROM backtest_predictions
     WHERE strategy_id = ? AND created_at BETWEEN ? AND ?
     ORDER BY created_at ASC`,
    [strategyId, periodStartMs, periodEndMs]
  );

  const normalizedLiveEvents = (Array.isArray(liveEvents) ? liveEvents : []).map((event) => ({
    ...event,
    event_origin: inferLiveTradeEventOrigin(event),
  }));

  if (normalizedLiveEvents.length === 0) {
    return {
      strategy_id: strategyId,
      entry_price_deviation_percent: 0,
      entry_time_lag_seconds: 0,
      exit_price_deviation_percent: 0,
      actual_avg_slippage_percent: 0,
      actual_avg_fee_percent: 0,
      backtest_assumed_slippage_percent: 0,
      backtest_assumed_fee_percent: 0,
      pnl_impact_from_slippage: 0,
      pnl_impact_from_fees: 0,
      total_execution_cost: 0,
      realized_vs_predicted_pnl_percent: 0,
      win_rate_live: 0,
      win_rate_backtest: 0,
      period_start: periodStartMs,
      period_end: periodEndMs,
      samples_count: 0,
    };
  }

  // Вычисления по live событиям
  const strategyEvents = normalizedLiveEvents.filter((event) => event.event_origin === 'strategy_signal');
  const executionEvents = normalizedLiveEvents.filter((event) => event.event_origin === 'exchange_fill');
  const entryEvents = strategyEvents.filter((event) => event.trade_type === 'entry');
  const exitEvents = strategyEvents.filter((event) => event.trade_type === 'exit');

  const entryPriceDeviations: number[] = [];
  const entryTimeLags: number[] = [];
  const exitPriceDeviations: number[] = [];
  let totalSlippage = 0;
  let totalFees = 0;
  let totalFeePercent = 0;
  let totalSlippageCost = 0;

  for (const fill of executionEvents) {
    const price = Math.abs(Number(fill.actual_price || 0));
    const size = Math.abs(Number(fill.position_size || 0));
    const notional = price * size;
    totalSlippage += Number(fill.slippage_percent || 0);
    totalFees += Number(fill.actual_fee || 0);
    if (notional > 0) {
      totalFeePercent += (Number(fill.actual_fee || 0) / notional) * 100;
      totalSlippageCost += Math.abs(Number(fill.slippage_percent || 0)) / 100 * notional;
    }
  }

  for (const entry of entryEvents) {
    // Найти соответствующее backtest предсказание
    const pred = predictions.find(
      (p) =>
        p.side === entry.side &&
        Math.abs(p.predicted_entry_time - entry.actual_time) < 300000 // 5 min window
    );

    if (pred) {
      const priceDev = Math.abs(entry.actual_price - pred.predicted_entry_price) / pred.predicted_entry_price;
      entryPriceDeviations.push(priceDev);
      entryTimeLags.push((entry.actual_time - pred.predicted_entry_time) / 1000);
    }
  }

  for (const exit of exitEvents) {
    const pred = predictions.find(
      (p) =>
        p.side === exit.side &&
        Math.abs(p.predicted_exit_time - exit.actual_time) < 300000
    );

    if (pred) {
      const priceDev = Math.abs(exit.actual_price - pred.predicted_exit_price) / Math.max(pred.predicted_exit_price, 1e-9);
      exitPriceDeviations.push(priceDev);
    }
  }

  // Win rate вычисления
  const closedTrades: Array<{ pnl: number; entry_price: number; exit_price: number }> = [];
  const openEntriesBySide = new Map<'long' | 'short', any[]>([
    ['long', []],
    ['short', []],
  ]);

  for (const event of strategyEvents) {
    const side = event.side as 'long' | 'short';
    if (event.trade_type === 'entry') {
      const queue = openEntriesBySide.get(side) || [];
      queue.push(event);
      openEntriesBySide.set(side, queue);
      continue;
    }

    const queue = openEntriesBySide.get(side) || [];
    const entry = queue.shift();
    openEntriesBySide.set(side, queue);
    if (!entry) {
      continue;
    }

    const qty = Math.max(Number(event.position_size || 0), Number(entry.position_size || 0));
    const pnl = side === 'long'
      ? (Number(event.actual_price || 0) - Number(entry.actual_price || 0)) * qty
      : (Number(entry.actual_price || 0) - Number(event.actual_price || 0)) * qty;

    closedTrades.push({
      pnl,
      entry_price: Number(entry.actual_price || 0),
      exit_price: Number(event.actual_price || 0),
    });
  }

  const winRateLive = closedTrades.length > 0
    ? closedTrades.filter((t) => t.pnl > 0).length / closedTrades.length
    : 0;

  const backtestWins = predictions.filter((p) => p.predicted_pnl > 0).length;
  const winRateBacktest = predictions.length > 0 ? backtestWins / predictions.length : 0;

  const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalBacktestPnL = predictions.reduce((sum, p) => sum + p.predicted_pnl, 0);
  const netLivePnL = totalPnL - totalFees;

  const averageEntryDeviation = entryPriceDeviations.length > 0
    ? entryPriceDeviations.reduce((sum, value) => sum + value, 0) / entryPriceDeviations.length
    : 0;
  const averageEntryLag = entryTimeLags.length > 0
    ? entryTimeLags.reduce((sum, value) => sum + value, 0) / entryTimeLags.length
    : 0;
  const averageExitDeviation = exitPriceDeviations.length > 0
    ? exitPriceDeviations.reduce((sum, value) => sum + value, 0) / exitPriceDeviations.length
    : 0;
  const averageSlippage = executionEvents.length > 0 ? totalSlippage / executionEvents.length : 0;
  const averageFeePercent = executionEvents.length > 0 ? totalFeePercent / executionEvents.length : 0;
  const averageBacktestSlippage = predictions.length > 0
    ? predictions.reduce((sum, item) => sum + Number(item.predicted_slippage_percent || 0), 0) / predictions.length
    : 0;

  return {
    strategy_id: strategyId,
    entry_price_deviation_percent: averageEntryDeviation * 100,
    entry_time_lag_seconds: averageEntryLag,
    exit_price_deviation_percent: averageExitDeviation * 100,
    actual_avg_slippage_percent: averageSlippage,
    actual_avg_fee_percent: averageFeePercent,
    backtest_assumed_slippage_percent: averageBacktestSlippage,
    backtest_assumed_fee_percent: 0.1,
    pnl_impact_from_slippage: totalSlippageCost,
    pnl_impact_from_fees: totalFees,
    total_execution_cost: totalSlippageCost + totalFees,
    realized_vs_predicted_pnl_percent: totalBacktestPnL !== 0
      ? ((netLivePnL - totalBacktestPnL) / Math.abs(totalBacktestPnL)) * 100
      : 0,
    win_rate_live: winRateLive * 100,
    win_rate_backtest: winRateBacktest * 100,
    period_start: periodStartMs,
    period_end: periodEndMs,
    samples_count: Math.min(entryEvents.length, predictions.length),
  };
}

/**
 * Получить alerts по策略 за период
 */
export async function getStrategyAlerts(
  strategyId: number,
  hours: number = 24
): Promise<DriftAlert[]> {
  const since = Date.now() - hours * 3600_000;
  return db.all(
    `SELECT * FROM drift_alerts 
     WHERE strategy_id = ? AND created_at > ?
     ORDER BY created_at DESC`,
    [strategyId, since]
  );
}

/**
 * Сохранить alert
 */
export async function createDriftAlert(alert: Omit<DriftAlert, 'id' | 'created_at'>): Promise<DriftAlert> {
  const result = await db.run(
    `INSERT INTO drift_alerts (strategy_id, metric_name, severity, value, threshold, drift_percent, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [alert.strategy_id, alert.metric_name, alert.severity, alert.value, alert.threshold, alert.drift_percent, alert.description, Date.now()]
  );

  return {
    id: result.lastID as number,
    created_at: Date.now(),
    ...alert,
  };
}

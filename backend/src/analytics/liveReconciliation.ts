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

export type LiveTradeEvent = {
  id: number;
  strategy_id: number;
  trade_type: 'entry' | 'exit';
  side: 'long' | 'short';
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
  const result = await db.run(
    `INSERT INTO live_trade_events (
      strategy_id, trade_type, side, entry_time, entry_price, 
      position_size, actual_price, actual_time, actual_fee, slippage_percent,
      source_trade_id, source_order_id, source_symbol
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      strategyId,
      event.trade_type,
      event.side,
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

  if (liveEvents.length === 0) {
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
  const entryEvents = liveEvents.filter((e) => e.trade_type === 'entry');
  const exitEvents = liveEvents.filter((e) => e.trade_type === 'exit');

  const entryPriceDeviations: number[] = [];
  const entryTimeLags: number[] = [];
  const exitPriceDeviations: number[] = [];
  let totalSlippage = 0;
  let totalFees = 0;

  for (const entry of entryEvents) {
    totalSlippage += entry.slippage_percent || 0;
    totalFees += entry.actual_fee || 0;

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

  // Win rate вычисления
  const closedTrades = liveEvents
    .filter((e) => e.trade_type === 'exit')
    .map((exit) => {
      const entry = liveEvents.find(
        (e) =>
          e.trade_type === 'entry' &&
          e.side === exit.side &&
          e.entry_time < exit.entry_time
      );
      if (!entry) return null;

      const pnl = exit.side === 'long' 
        ? (exit.actual_price - entry.actual_price) * exit.position_size
        : (entry.actual_price - exit.actual_price) * exit.position_size;

      return { pnl, entry_price: entry.actual_price, exit_price: exit.actual_price };
    })
    .filter(Boolean) as any[];

  const winRateLive = closedTrades.length > 0
    ? closedTrades.filter((t) => t.pnl > 0).length / closedTrades.length
    : 0;

  const backtestWins = predictions.filter((p) => p.predicted_pnl > 0).length;
  const winRateBacktest = predictions.length > 0 ? backtestWins / predictions.length : 0;

  const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalBacktestPnL = predictions.reduce((sum, p) => sum + p.predicted_pnl, 0);

  return {
    strategy_id: strategyId,
    entry_price_deviation_percent: entryPriceDeviations.length > 0
      ? entryPriceDeviations.reduce((a, b) => a + b, 0) / entryPriceDeviations.length
      : 0,
    entry_time_lag_seconds: entryTimeLags.length > 0
      ? entryTimeLags.reduce((a, b) => a + b, 0) / entryTimeLags.length
      : 0,
    exit_price_deviation_percent: exitPriceDeviations.length > 0
      ? exitPriceDeviations.reduce((a, b) => a + b, 0) / exitPriceDeviations.length
      : 0,
    actual_avg_slippage_percent: entryEvents.length > 0 ? totalSlippage / entryEvents.length : 0,
    actual_avg_fee_percent: entryEvents.length > 0 ? totalFees / entryEvents.length : 0,
    backtest_assumed_slippage_percent: 0.05, // default, можно получать из backtest config
    backtest_assumed_fee_percent: 0.1,       // default
    pnl_impact_from_slippage: totalPnL * (entryEvents.length > 0 ? totalSlippage / entryEvents.length : 0),
    pnl_impact_from_fees: totalFees,
    total_execution_cost: totalFees + (totalPnL * (entryEvents.length > 0 ? totalSlippage / entryEvents.length : 0)),
    realized_vs_predicted_pnl_percent: totalBacktestPnL !== 0
      ? (totalPnL - totalBacktestPnL) / Math.abs(totalBacktestPnL)
      : 0,
    win_rate_live: winRateLive,
    win_rate_backtest: winRateBacktest,
    period_start: periodStartMs,
    period_end: periodEndMs,
    samples_count: liveEvents.length,
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

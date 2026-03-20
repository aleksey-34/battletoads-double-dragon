import { runBacktest } from '../backtest/engine';
import { db } from '../utils/database';
import {
  computeReconciliationMetrics,
  recordBacktestPrediction,
  recordLiveTradeEvent,
  ReconciliationMetrics,
} from '../analytics/liveReconciliation';
import { analyzeDriftAndRecommend, StrategyRecommendation } from '../analytics/driftAnalyzer';
import { getRecentTrades } from '../bot/exchange';
import { getTradingSystem } from '../bot/tradingSystems';
import { getStrategies, updateStrategy } from '../bot/strategy';
import logger from '../utils/logger';

type ReconciliationRunOptions = {
  periodHours?: number;
  backtestBars?: number;
  autoApplyAdjustments?: boolean;
  autoPauseOnCritical?: boolean;
};

type StrategyReconciliationResult = {
  strategyId: number;
  strategyName: string;
  symbol: string;
  syncedEvents: number;
  generatedPredictions: number;
  metrics: ReconciliationMetrics;
  recommendation: StrategyRecommendation;
  actionNote: string;
};

type TradeRow = {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  price: string;
  fee: string;
  realizedPnl: string;
  timestamp: string;
};

const toFinite = (value: any, fallback: number = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeSide = (side: 'Buy' | 'Sell'): 'long' | 'short' => {
  return side === 'Buy' ? 'long' : 'short';
};

const getApiKeyId = async (apiKeyName: string): Promise<number> => {
  const row = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!row) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }
  return Number(row.id);
};

const syncRecentTradesForStrategy = async (
  apiKeyName: string,
  strategyId: number,
  symbol: string,
  limit: number = 120
): Promise<number> => {
  const trades = (await getRecentTrades(apiKeyName, symbol, limit)) as TradeRow[];
  if (!Array.isArray(trades) || trades.length === 0) {
    return 0;
  }

  const tradeIds = trades
    .map((trade) => String(trade.tradeId || '').trim())
    .filter((id) => id.length > 0);

  const eventIds: string[] = [];
  for (const tradeId of tradeIds) {
    eventIds.push(tradeId);
    eventIds.push(`${tradeId}:entry`);
    eventIds.push(`${tradeId}:exit`);
  }

  const existingIds = new Set<string>();
  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT source_trade_id
       FROM live_trade_events
       WHERE source_trade_id IN (${placeholders})`,
      eventIds
    );

    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row?.source_trade_id || '').trim();
      if (id) {
        existingIds.add(id);
      }
    }
  }

  let inserted = 0;

  // Process oldest -> newest so timeline in db stays coherent.
  const ordered = [...trades].sort((a, b) => toFinite(a.timestamp) - toFinite(b.timestamp));

  const epsilon = 1e-9;
  let positionSignedQty = 0;

  const emitEvent = async (
    sourceTradeId: string,
    tradeType: 'entry' | 'exit',
    side: 'long' | 'short',
    timestamp: number,
    price: number,
    qty: number,
    fee: number,
    trade: TradeRow
  ) => {
    if (qty <= epsilon) {
      return;
    }
    if (existingIds.has(sourceTradeId)) {
      return;
    }

    await recordLiveTradeEvent(strategyId, {
      trade_type: tradeType,
      side,
      entry_time: timestamp,
      entry_price: price,
      position_size: qty,
      actual_price: price,
      actual_time: timestamp,
      actual_fee: fee,
      slippage_percent: 0,
      source_trade_id: sourceTradeId,
      source_order_id: String(trade.orderId || '').trim(),
      source_symbol: String(trade.symbol || symbol || '').trim(),
    });

    inserted += 1;
    existingIds.add(sourceTradeId);
  };

  for (const trade of ordered) {
    const tradeId = String(trade.tradeId || '').trim();
    if (!tradeId) {
      continue;
    }

    const timestamp = toFinite(trade.timestamp, Date.now());
    const price = toFinite(trade.price, 0);
    const qty = Math.abs(toFinite(trade.qty, 0));
    const fee = Math.abs(toFinite(trade.fee, 0));
    if (!(timestamp > 0 && price > 0 && qty > 0)) {
      continue;
    }

    const delta = trade.side === 'Buy' ? qty : -qty;
    const prev = positionSignedQty;
    const next = prev + delta;

    if (Math.abs(prev) <= epsilon) {
      const side = next >= 0 ? 'long' : 'short';
      await emitEvent(`${tradeId}:entry`, 'entry', side, timestamp, price, Math.abs(next), fee, trade);
      positionSignedQty = next;
      continue;
    }

    const prevSide: 'long' | 'short' = prev >= 0 ? 'long' : 'short';
    const nextSide: 'long' | 'short' = next >= 0 ? 'long' : 'short';
    const prevAbs = Math.abs(prev);
    const nextAbs = Math.abs(next);

    // Same direction: either scale in (entry) or scale out (exit)
    if (prevSide === nextSide || Math.abs(next) <= epsilon) {
      if (nextAbs > prevAbs + epsilon) {
        await emitEvent(`${tradeId}:entry`, 'entry', prevSide, timestamp, price, nextAbs - prevAbs, fee, trade);
      } else if (nextAbs + epsilon < prevAbs) {
        await emitEvent(`${tradeId}:exit`, 'exit', prevSide, timestamp, price, prevAbs - nextAbs, fee, trade);
      }
      positionSignedQty = next;
      continue;
    }

    // Direction flip in one fill: close old side + open new side.
    await emitEvent(`${tradeId}:exit`, 'exit', prevSide, timestamp, price, prevAbs, fee, trade);
    await emitEvent(`${tradeId}:entry`, 'entry', nextSide, timestamp, price, nextAbs, fee, trade);
    positionSignedQty = next;
  }

  return inserted;
};

const refreshBacktestPredictions = async (
  apiKeyName: string,
  strategyId: number,
  bars: number
): Promise<number> => {
  const run = await runBacktest({
    apiKeyName,
    mode: 'single',
    strategyId,
    bars,
    initialBalance: 10000,
    commissionPercent: 0.1,
    slippagePercent: 0.05,
    fundingRatePercent: 0,
  });

  const trades = Array.isArray(run.trades) ? run.trades.slice(-40) : [];

  for (const trade of trades) {
    await recordBacktestPrediction(strategyId, {
      strategy_id: strategyId,
      side: trade.side,
      predicted_entry_price: trade.entryPrice,
      predicted_entry_time: trade.entryTime,
      predicted_exit_price: trade.exitPrice,
      predicted_exit_time: trade.exitTime,
      predicted_pnl: trade.netPnl,
      predicted_pnl_percent: trade.pnlPercent,
      predicted_slippage_percent: 0.05,
    });
  }

  const cutoff = Date.now() - 30 * 24 * 3600_000;
  await db.run(
    'DELETE FROM backtest_predictions WHERE strategy_id = ? AND created_at < ?',
    [strategyId, cutoff]
  );

  return trades.length;
};

const saveReconciliationReport = async (
  apiKeyId: number,
  strategyId: number,
  periodHours: number,
  metrics: ReconciliationMetrics,
  recommendation: StrategyRecommendation,
  actionNote: string
): Promise<void> => {
  await db.run(
    `INSERT INTO reconciliation_reports (
      api_key_id,
      strategy_id,
      period_hours,
      samples_count,
      metrics_json,
      recommendation_json,
      action_note,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKeyId,
      strategyId,
      periodHours,
      metrics.samples_count,
      JSON.stringify(metrics),
      JSON.stringify(recommendation),
      String(actionNote || ''),
      Date.now(),
    ]
  );
};

const maybeApplyRecommendation = async (
  apiKeyName: string,
  strategyId: number,
  recommendation: StrategyRecommendation,
  options: ReconciliationRunOptions
): Promise<string> => {
  if (recommendation.recommendation === 'none' || recommendation.recommendation === 'investigate') {
    return 'analyze_only';
  }

  if (recommendation.recommendation === 'adjust_params' && options.autoApplyAdjustments) {
    const patch: Record<string, any> = {};

    if (recommendation.suggested_params?.price_channel_length !== undefined) {
      patch.price_channel_length = Math.max(2, Math.round(recommendation.suggested_params.price_channel_length));
    }

    if (recommendation.suggested_params?.take_profit_percent !== undefined) {
      patch.take_profit_percent = Math.max(0.1, recommendation.suggested_params.take_profit_percent);
    }

    if (recommendation.suggested_params?.zscore_entry !== undefined) {
      patch.zscore_entry = Math.max(0.1, recommendation.suggested_params.zscore_entry);
    }

    if (recommendation.suggested_params?.zscore_exit !== undefined) {
      patch.zscore_exit = Math.max(0.01, recommendation.suggested_params.zscore_exit);
    }

    if (recommendation.suggested_params?.zscore_stop !== undefined) {
      patch.zscore_stop = Math.max(0.1, recommendation.suggested_params.zscore_stop);
    }

    if (Object.keys(patch).length > 0) {
      await updateStrategy(apiKeyName, strategyId, patch);
      return `auto_adjusted:${Object.keys(patch).join(',')}`;
    }

    return 'adjust_requested_but_no_supported_params';
  }

  if (recommendation.recommendation === 'pause' && options.autoPauseOnCritical) {
    await updateStrategy(apiKeyName, strategyId, {
      is_active: false,
      last_action: 'auto_paused_by_reconciliation',
      last_error: recommendation.rationale,
    });
    return 'auto_paused';
  }

  return 'suggest_only';
};

export const runReconciliationForApiKey = async (
  apiKeyName: string,
  options?: ReconciliationRunOptions
): Promise<{
  apiKeyName: string;
  periodHours: number;
  processed: number;
  failed: number;
  reports: StrategyReconciliationResult[];
}> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const periodHours = Math.max(1, Math.floor(toFinite(options?.periodHours, 24)));
  const backtestBars = Math.max(120, Math.floor(toFinite(options?.backtestBars, 336)));

  const strategies = await getStrategies(apiKeyName, { includeLotPreview: false });
  const active = strategies.filter((strategy) => strategy.is_active && strategy.auto_update);

  const periodEnd = Date.now();
  const periodStart = periodEnd - periodHours * 3600_000;

  const reports: StrategyReconciliationResult[] = [];
  let processed = 0;
  let failed = 0;

  for (const strategy of active) {
    const strategyId = Number(strategy.id || 0);
    if (!strategyId) {
      continue;
    }

    try {
      const syncedEvents = await syncRecentTradesForStrategy(
        apiKeyName,
        strategyId,
        String(strategy.base_symbol || ''),
        120
      );

      const generatedPredictions = await refreshBacktestPredictions(apiKeyName, strategyId, backtestBars);
      const metrics = await computeReconciliationMetrics(strategyId, periodStart, periodEnd);
      const recommendation = await analyzeDriftAndRecommend(strategyId, metrics);
      const actionNote = await maybeApplyRecommendation(apiKeyName, strategyId, recommendation, options || {});

      await saveReconciliationReport(apiKeyId, strategyId, periodHours, metrics, recommendation, actionNote);

      reports.push({
        strategyId,
        strategyName: String(strategy.name || ''),
        symbol: String(strategy.base_symbol || ''),
        syncedEvents,
        generatedPredictions,
        metrics,
        recommendation,
        actionNote,
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`Reconciliation failed for strategy ${strategyId} (${apiKeyName}): ${(error as Error).message}`);
    }
  }

  return {
    apiKeyName,
    periodHours,
    processed,
    failed,
    reports,
  };
};

export const runReconciliationForTradingSystem = async (
  apiKeyName: string,
  systemId: number,
  periodHours: number = 24
): Promise<{
  systemId: number;
  systemName: string;
  reports: Array<{
    strategyId: number;
    strategyName: string;
    symbol: string;
    metrics: ReconciliationMetrics;
    recommendation: StrategyRecommendation;
  }>;
}> => {
  const system = await getTradingSystem(apiKeyName, systemId);
  const end = Date.now();
  const start = end - Math.max(1, Math.floor(periodHours)) * 3600_000;

  const reports: Array<{
    strategyId: number;
    strategyName: string;
    symbol: string;
    metrics: ReconciliationMetrics;
    recommendation: StrategyRecommendation;
  }> = [];

  for (const member of system.members.filter((item) => item.is_enabled)) {
    const strategyId = Number(member.strategy_id || 0);
    if (!strategyId) {
      continue;
    }

    const metrics = await computeReconciliationMetrics(strategyId, start, end);
    const recommendation = await analyzeDriftAndRecommend(strategyId, metrics);

    reports.push({
      strategyId,
      strategyName: String(member.strategy?.name || `strategy_${strategyId}`),
      symbol: String(member.strategy?.base_symbol || ''),
      metrics,
      recommendation,
    });
  }

  return {
    systemId,
    systemName: String(system.name || ''),
    reports,
  };
};

export const getLatestReconciliationReports = async (
  apiKeyName: string,
  limit: number = 100
): Promise<any[]> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(toFinite(limit, 100))));

  return db.all(
    `SELECT
       r.id,
       r.strategy_id,
       s.name AS strategy_name,
       s.base_symbol,
       r.period_hours,
       r.samples_count,
       r.metrics_json,
       r.recommendation_json,
       r.action_note,
       r.created_at
     FROM reconciliation_reports r
     JOIN strategies s ON s.id = r.strategy_id
     WHERE r.api_key_id = ?
     ORDER BY r.created_at DESC
     LIMIT ?`,
    [apiKeyId, safeLimit]
  );
};

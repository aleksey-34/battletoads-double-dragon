/**
 * Drift Analyzer & Recommendation Engine
 * 
 * Вместо простой паузы при дрифте >10%:
 * - Анализирует ПОЧЕМУ произошел дрифт
 * - Предлагает optмизированные параметры
 * - Рекомендует: pause vs adjust vs replace vs investigate
 */

import { ReconciliationMetrics, createDriftAlert } from './liveReconciliation';

export type RecommendationType = 'adjust_params' | 'swap_strategy' | 'pause' | 'investigate' | 'none';

export type StrategyRecommendation = {
  strategy_id: number;
  recommendation: RecommendationType;
  confidence: number; // 0-1
  rationale: string;
  severity: 'info' | 'warning' | 'critical';
  
  // Если adjust_params
  suggested_params?: {
    zscore_entry?: number;
    zscore_exit?: number;
    zscore_stop?: number;
    price_channel_length?: number;
    take_profit_percent?: number;
    slippage_tolerance?: number;
  };
  
  // Если swap_strategy
  swap_strategy_id?: number;
  swap_reason?: string;
  
  // Пояснение
  root_cause?: string[];
  validation_steps?: string[];
};

/**
 * Анализировать дрифт и выдать рекомендацию
 */
export async function analyzeDriftAndRecommend(
  strategyId: number,
  metrics: ReconciliationMetrics
): Promise<StrategyRecommendation> {
  const rootCauses: string[] = [];

  // Thresholds для дрифтов
  const ENTRY_PRICE_DEV_THRESHOLD = 0.02; // 2%
  const WIN_RATE_DROP_THRESHOLD = 0.15;   // если backtest 60%, live < 45%
  const PNL_DROP_THRESHOLD = 0.10;        // -10% vs backtest
  const TIME_LAG_THRESHOLD = 30;          // 30 seconds

  let overallDrift = 0;
  let criticalMetrics = 0;

  // 1. Анализировать отклонение по цене входа
  if (Math.abs(metrics.entry_price_deviation_percent) > ENTRY_PRICE_DEV_THRESHOLD) {
    overallDrift += Math.abs(metrics.entry_price_deviation_percent);
    rootCauses.push(`Entry price deviation: ${(metrics.entry_price_deviation_percent * 100).toFixed(2)}%`);
    
    await createDriftAlert({
      strategy_id: strategyId,
      metric_name: 'entry_price_deviation',
      severity: 'warning',
      value: metrics.entry_price_deviation_percent,
      threshold: ENTRY_PRICE_DEV_THRESHOLD,
      drift_percent: (metrics.entry_price_deviation_percent / ENTRY_PRICE_DEV_THRESHOLD - 1) * 100,
      description: `Entry price deviation ${(metrics.entry_price_deviation_percent * 100).toFixed(2)}% exceeds threshold ${(ENTRY_PRICE_DEV_THRESHOLD * 100).toFixed(2)}%`,
    });
    
    if (Math.abs(metrics.entry_price_deviation_percent) > ENTRY_PRICE_DEV_THRESHOLD * 2) {
      criticalMetrics++;
    }
  }

  // 2. Анализировать слипаж против ожиданий backtest
  const slippageRatio = metrics.actual_avg_slippage_percent / metrics.backtest_assumed_slippage_percent;
  if (slippageRatio > 1.5) {
    overallDrift += (slippageRatio - 1) * 0.05;
    rootCauses.push(`Actual slippage (${(metrics.actual_avg_slippage_percent * 100).toFixed(3)}%) > expected (${(metrics.backtest_assumed_slippage_percent * 100).toFixed(3)}%)`);
    criticalMetrics++;
    
    await createDriftAlert({
      strategy_id: strategyId,
      metric_name: 'slippage_drift',
      severity: 'critical',
      value: metrics.actual_avg_slippage_percent,
      threshold: metrics.backtest_assumed_slippage_percent * 1.5,
      drift_percent: (slippageRatio - 1) * 100,
      description: `Slippage ${(metrics.actual_avg_slippage_percent * 100).toFixed(3)}% is 1.5x+ higher than backtest assumption`,
    });
  }

  // 3. Анализировать win rate деградацию
  const winRateDrop = metrics.win_rate_backtest - metrics.win_rate_live;
  if (winRateDrop > WIN_RATE_DROP_THRESHOLD) {
    overallDrift += winRateDrop;
    rootCauses.push(`Win rate dropped from ${(metrics.win_rate_backtest * 100).toFixed(1)}% to ${(metrics.win_rate_live * 100).toFixed(1)}%`);
    criticalMetrics++;
    
    await createDriftAlert({
      strategy_id: strategyId,
      metric_name: 'win_rate_drop',
      severity: 'critical',
      value: metrics.win_rate_live,
      threshold: metrics.win_rate_backtest - WIN_RATE_DROP_THRESHOLD,
      drift_percent: (winRateDrop / metrics.win_rate_backtest) * 100,
      description: `Win rate degradation: ${(winRateDrop * 100).toFixed(1)}% drop`,
    });
  }

  // 4. Анализировать PnL impact
  if (metrics.realized_vs_predicted_pnl_percent < -PNL_DROP_THRESHOLD) {
    overallDrift += Math.abs(metrics.realized_vs_predicted_pnl_percent);
    rootCauses.push(`PnL underperformance: ${(metrics.realized_vs_predicted_pnl_percent * 100).toFixed(1)}%`);
    criticalMetrics++;
    
    await createDriftAlert({
      strategy_id: strategyId,
      metric_name: 'pnl_drop',
      severity: 'critical',
      value: metrics.realized_vs_predicted_pnl_percent,
      threshold: -PNL_DROP_THRESHOLD,
      drift_percent: (metrics.realized_vs_predicted_pnl_percent / (-PNL_DROP_THRESHOLD)) * 100,
      description: `PnL underperformance ${(metrics.realized_vs_predicted_pnl_percent * 100).toFixed(1)}%`,
    });
  }

  // 5. Анализировать timing lag (может быть сигнал что рынок быстрый)
  if (Math.abs(metrics.entry_time_lag_seconds) > TIME_LAG_THRESHOLD) {
    rootCauses.push(`Entry timing lag: ${metrics.entry_time_lag_seconds.toFixed(1)} seconds`);
  }

  // ========== ВЫДАТЬ РЕКОМЕНДАЦИЮ ==========

  // Если дрифт < 10% и нет critical metrics → ок
  if (overallDrift < 0.10 && criticalMetrics === 0) {
    return {
      strategy_id: strategyId,
      recommendation: 'none',
      confidence: 1.0,
      rationale: 'Strategy performance within acceptable thresholds',
      severity: 'info',
    };
  }

  // Если только timing lag или мелкие расхождения → просто investigate
  if (criticalMetrics === 0 && overallDrift < 0.15) {
    return {
      strategy_id: strategyId,
      recommendation: 'investigate',
      confidence: 0.7,
      rationale: 'Minor deviations detected. Recommend monitoring market conditions and execution environment',
      severity: 'warning',
      root_cause: rootCauses,
      validation_steps: [
        'Check network latency and API response times',
        'Verify order book depth at entry times',
        'Monitor exchange funding rates and fees',
        'Review market volatility during trading hours',
      ],
    };
  }

  // === СЛУЧАЙ: High slippage + все остальное нормально → adjust slippage tolerance
  if (
    criticalMetrics === 1 &&
    rootCauses.some((c) => c.includes('slippage'))
  ) {
    return {
      strategy_id: strategyId,
      recommendation: 'adjust_params',
      confidence: 0.8,
      rationale: `Market liquidity differs from backtest assumptions. Increasing slippage tolerance will reduce rejected orders.`,
      severity: 'warning',
      root_cause: rootCauses,
      suggested_params: {
        slippage_tolerance: Math.min(
          (metrics.actual_avg_slippage_percent * 1.2) * 100, // добавить 20% буфер
          5 // макс 5%
        ),
      },
      validation_steps: [
        'Apply suggested slippage tolerance adjustment',
        'Run 4-hour backtest with new parameters',
        'Monitor live trades for 24-48 hours',
        'If successful, promote to production',
      ],
    };
  }

  // === СЛУЧАЙ: Win rate деградация (рынок изменился) → try swap or pause
  if (rootCauses.some((c) => c.includes('Win rate')) && metrics.samples_count > 20) {
    // Если много samples и win rate упал → рынок деградирован
    return {
      strategy_id: strategyId,
      recommendation: 'pause',
      confidence: 0.85,
      rationale: `Significant win rate degradation (${(metrics.win_rate_backtest * 100).toFixed(0)}% → ${(metrics.win_rate_live * 100).toFixed(0)}%) suggests market regime change. Recommend pausing for market analysis.`,
      severity: 'critical',
      root_cause: rootCauses,
      validation_steps: [
        'Pause strategy immediately',
        'Analyze market volatility/trend in last 24-48h',
        'Check if other strategies in portfolio are also affected',
        'Review calendar (news, expiries) for market-moving events',
        'Re-run backtest with recent data to validate fit',
        'If backtest still green, resume with monitoring',
      ],
    };
  }

  // === СЛУЧАЙ: Multiple degradations → also pause but provide swap alternative
  if (criticalMetrics >= 2) {
    return {
      strategy_id: strategyId,
      recommendation: 'pause',
      confidence: 0.9,
      rationale: `Multiple degradations detected (${criticalMetrics} critical metrics). Strategy needs adjustment or replacement.`,
      severity: 'critical',
      root_cause: rootCauses,
      suggested_params: {
        // Suggestion: увеличить z-score threshold для stat_arb или выбрать более консервативный TP
        zscore_entry: 2.2,
        zscore_exit: 1.8,
      },
      validation_steps: [
        'Pause strategy',
        'Review market conditions for the last week',
        'If fundamental change detected (trend reversal, regime shift), recommend strategy swap',
        'Otherwise, apply parameter adjustments and backtest',
        'Resume if backtest shows improvement',
      ],
    };
  }

  // Default: pause for investigation
  return {
    strategy_id: strategyId,
    recommendation: 'pause',
    confidence: 0.7,
    rationale: 'Drift exceeds acceptable threshold. Manual review recommended before resuming.',
    severity: 'critical',
    root_cause: rootCauses,
  };
}

/**
 * Batch анализ всех стратегий в system
 */
export async function recommendForTradingSystem(
  systemId: number,
  allMetrics: Map<number, ReconciliationMetrics>
): Promise<StrategyRecommendation[]> {
  const recommendations: StrategyRecommendation[] = [];

  for (const [strategyId, metrics] of allMetrics) {
    const rec = await analyzeDriftAndRecommend(strategyId, metrics);
    recommendations.push(rec);
  }

  return recommendations;
}

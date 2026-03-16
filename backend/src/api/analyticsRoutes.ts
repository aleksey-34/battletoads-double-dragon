/**
 * Analytics API Routes
 * Live reconciliation, drift analysis, recommendations
 */

import express from 'express';
import {
  recordLiveTradeEvent,
  recordBacktestPrediction,
  computeReconciliationMetrics,
  getStrategyAlerts,
  LiveTradeEvent,
  BacktestTradePrediction,
} from '../analytics/liveReconciliation';
import { analyzeDriftAndRecommend } from '../analytics/driftAnalyzer';
import { getStrategies } from '../bot/strategy';
import {
  getLatestReconciliationReports,
  runReconciliationForApiKey,
  runReconciliationForTradingSystem,
} from '../automation/reconciliationEngine';
import {
  listLiquiditySuggestions,
  runLiquidityScanForApiKey,
  updateLiquiditySuggestionStatus,
} from '../automation/liquidityScanner';

const router = express.Router();

/**
 * POST /analytics/:apiKeyName/trade-events
 * Record a live trade event (entry or exit)
 */
router.post('/:apiKeyName/trade-events', async (req, res) => {
  try {
    const { strategyId, event } = req.body;

    if (!strategyId || !event) {
      return res.status(400).json({ error: 'strategyId and event required' });
    }

    const recorded = await recordLiveTradeEvent(strategyId, event as Omit<LiveTradeEvent, 'id' | 'strategy_id'>);
    res.json(recorded);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /analytics/:apiKeyName/backtest-predictions
 * Record backtest predictions for comparison
 */
router.post('/:apiKeyName/backtest-predictions', async (req, res) => {
  try {
    const { strategyId, predictions } = req.body;

    if (!strategyId || !Array.isArray(predictions)) {
      return res.status(400).json({ error: 'strategyId and predictions[] required' });
    }

    for (const pred of predictions) {
      await recordBacktestPrediction(strategyId, pred as BacktestTradePrediction);
    }

    res.json({ recorded: predictions.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /analytics/:apiKeyName/:strategyId/reconciliation?periodHours=24
 * Get reconciliation metrics for a strategy in a period
 */
router.get('/:apiKeyName/:strategyId/reconciliation', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const periodHours = parseInt(req.query.periodHours as string) || 24;

    const strategyIdNum = parseInt(strategyId);
    if (!strategyIdNum) {
      return res.status(400).json({ error: 'Invalid strategy ID' });
    }

    const periodEnd = Date.now();
    const periodStart = periodEnd - periodHours * 3600_000;

    const metrics = await computeReconciliationMetrics(strategyIdNum, periodStart, periodEnd);

    res.json({
      metric: metrics,
      period_hours: periodHours,
      sample_count: metrics.samples_count,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /analytics/:apiKeyName/:strategyId/recommendations
 * Get drift analysis and recommendation (analyze only, don't execute)
 */
router.get('/:apiKeyName/:strategyId/recommendations', async (req, res) => {
  try {
    const { strategyId, apiKeyName } = req.params;
    const periodHours = parseInt(req.query.periodHours as string) || 24;

    const strategyIdNum = parseInt(strategyId);
    if (!strategyIdNum) {
      return res.status(400).json({ error: 'Invalid strategy ID' });
    }

    const strategies = await getStrategies(apiKeyName, { includeLotPreview: false });
    const strategy = strategies.find((s) => s.id === strategyIdNum);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const periodEnd = Date.now();
    const periodStart = periodEnd - periodHours * 3600_000;

    const metrics = await computeReconciliationMetrics(strategyIdNum, periodStart, periodEnd);
    const recommendation = await analyzeDriftAndRecommend(strategyIdNum, metrics);

    res.json({
      strategy_id: strategyIdNum,
      strategy_name: strategy.name,
      metrics,
      recommendation,
      analysis_period_hours: periodHours,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /analytics/:apiKeyName/:strategyId/alerts
 * Get recent drift alerts
 */
router.get('/:apiKeyName/:strategyId/alerts', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const hours = parseInt(req.query.hours as string) || 24;

    const strategyIdNum = parseInt(strategyId);
    if (!strategyIdNum) {
      return res.status(400).json({ error: 'Invalid strategy ID' });
    }

    const alerts = await getStrategyAlerts(strategyIdNum, hours);

    res.json({
      strategy_id: strategyIdNum,
      alert_count: alerts.length,
      alerts,
      period_hours: hours,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /analytics/:apiKeyName/system/:systemId/analysis
 * Analyze all strategies in a trading system and get recommendations
 */
router.post('/:apiKeyName/system/:systemId/analysis', async (req, res) => {
  try {
    const { apiKeyName, systemId } = req.params;
    const { periodHours = 24 } = req.body;

    const systemIdNum = parseInt(systemId);
    if (!systemIdNum) {
      return res.status(400).json({ error: 'Invalid system ID' });
    }

    const result = await runReconciliationForTradingSystem(apiKeyName, systemIdNum, Number(periodHours));

    res.json({
      system_id: result.systemId,
      system_name: result.systemName,
      period_hours: periodHours,
      recommendations_count: result.reports.length,
      reports: result.reports,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /analytics/:apiKeyName/reconciliation/run
 * Run full reconciliation pipeline now (sync trades + generate predictions + recommendations)
 */
router.post('/:apiKeyName/reconciliation/run', async (req, res) => {
  try {
    const { apiKeyName } = req.params;
    const {
      periodHours = 24,
      backtestBars = 336,
      autoApplyAdjustments = false,
      autoPauseOnCritical = false,
    } = req.body || {};

    const result = await runReconciliationForApiKey(apiKeyName, {
      periodHours: Number(periodHours),
      backtestBars: Number(backtestBars),
      autoApplyAdjustments: Boolean(autoApplyAdjustments),
      autoPauseOnCritical: Boolean(autoPauseOnCritical),
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /analytics/:apiKeyName/reconciliation/reports?limit=100
 * Get latest stored reconciliation reports
 */
router.get('/:apiKeyName/reconciliation/reports', async (req, res) => {
  try {
    const { apiKeyName } = req.params;
    const limit = Number(req.query.limit || 100);
    const rows = await getLatestReconciliationReports(apiKeyName, limit);

    res.json({
      count: rows.length,
      reports: rows,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /analytics/:apiKeyName/liquidity-scan/run
 * Run liquidity scanner for discovery-enabled systems
 */
router.post('/:apiKeyName/liquidity-scan/run', async (req, res) => {
  try {
    const { apiKeyName } = req.params;
    const {
      topUniverseLimit = 120,
      maxAddSuggestions = 3,
      maxReplaceSuggestions = 2,
    } = req.body || {};

    const result = await runLiquidityScanForApiKey(apiKeyName, {
      topUniverseLimit: Number(topUniverseLimit),
      maxAddSuggestions: Number(maxAddSuggestions),
      maxReplaceSuggestions: Number(maxReplaceSuggestions),
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /analytics/:apiKeyName/liquidity-suggestions?status=new&limit=100
 */
router.get('/:apiKeyName/liquidity-suggestions', async (req, res) => {
  try {
    const { apiKeyName } = req.params;
    const status = String(req.query.status || 'new') as 'new' | 'accepted' | 'rejected' | 'applied' | 'all';
    const limit = Number(req.query.limit || 100);

    const suggestions = await listLiquiditySuggestions(apiKeyName, status, limit);
    res.json({
      count: suggestions.length,
      suggestions,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /analytics/:apiKeyName/liquidity-suggestions/:suggestionId/status
 */
router.patch('/:apiKeyName/liquidity-suggestions/:suggestionId/status', async (req, res) => {
  try {
    const { apiKeyName, suggestionId } = req.params;
    const status = String(req.body?.status || '').trim() as 'new' | 'accepted' | 'rejected' | 'applied';

    if (!['new', 'accepted', 'rejected', 'applied'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of: new, accepted, rejected, applied' });
    }

    const id = Number(suggestionId);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid suggestion ID' });
    }

    await updateLiquiditySuggestionStatus(apiKeyName, id, status);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

import { Router } from 'express';
import { deleteBacktestRun, getBacktestRun, listBacktestRuns, runBacktest, saveBacktestRun } from '../../backtest/engine';
import { getStrategies } from '../../bot/strategy';
import { requirePlatformAdmin } from '../../utils/auth';
import logger from '../../utils/logger';
import { backtestState } from './backtestState';

const backtestRouter = Router();

backtestRouter.use(requirePlatformAdmin);

backtestRouter.post('/run', async (req, res) => {
  if (backtestState.runInProgress) {
    return res.status(429).json({
      error: 'Backtest already running. Wait for current run to finish before starting a new one.',
    });
  }

  try {
    backtestState.runInProgress = true;
    const saveResult = req.body?.saveResult !== false;
    const result = await runBacktest(req.body || {});
    let runId: number | null = null;

    if (saveResult) {
      runId = await saveBacktestRun(result);
      result.runId = runId;
    }

    res.json({ success: true, runId, result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error running backtest: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    backtestState.runInProgress = false;
  }
});

backtestRouter.get('/runs', async (req, res) => {
  const apiKeyName = req.query.apiKeyName ? String(req.query.apiKeyName) : undefined;
  const limitRaw = Number.parseInt(String(req.query.limit || '20'), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;

  try {
    const rows = await listBacktestRuns(limit, apiKeyName);
    res.json(rows);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest runs: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

backtestRouter.get('/runs/:id', async (req, res) => {
  const id = Number.parseInt(String(req.params.id || '0'), 10);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }

  try {
    const run = await getBacktestRun(id);
    if (!run) {
      return res.status(404).json({ error: 'Backtest run not found' });
    }
    res.json(run);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest run ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

backtestRouter.delete('/runs/:id', async (req, res) => {
  const id = Number.parseInt(String(req.params.id || '0'), 10);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }

  try {
    const deleted = await deleteBacktestRun(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Backtest run not found' });
    }
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting backtest run ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
backtestRouter.get('/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const strategies = await getStrategies(apiKeyName);
    res.json(strategies);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest strategies: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});


export default backtestRouter;

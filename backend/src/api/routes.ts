import { Router } from 'express';
import {
  getMarketData,
  placeOrder,
  getOrderStatus,
  getBalances,
  getPositions,
  closePosition,
  closePositionPercent as closePositionPercentExchange,
  initExchangeClient,
  get24hVolume,
  getInstrumentInfo,
  getAllSymbols,
  removeExchangeClient,
  getOpenOrders,
  cancelAllOrders,
  closeAllPositions,
} from '../bot/exchange';
import { calculateSyntheticOHLC } from '../bot/synthetic';
import { getRiskSettings, updateRiskSettings } from '../bot/risk';
import {
  getStrategies,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  executeStrategy,
  pauseStrategy,
  stopStrategy,
  closePositionPercent,
  placeManualOrder,
  cancelStrategyOrders,
  closeStrategyPositions,
  setAllStrategiesActive,
  copyStrategyBlock,
} from '../bot/strategy';
import { getMonitoringLatest, getMonitoringSnapshots, recordMonitoringSnapshot } from '../bot/monitoring';
import { getBacktestRun, listBacktestRuns, runBacktest, saveBacktestRun } from '../backtest/engine';
import { loadSettings, saveApiKey, saveRiskSettings, saveChartSettings, ApiKey, RiskSettings, ChartSettings, Strategy } from '../config/settings';
import { db } from '../utils/database';
import { authenticate } from '../utils/auth';
import logger from '../utils/logger';
import { getGitUpdateJobStatus, getGitUpdateStatus, triggerGitUpdate } from '../system/updateManager';
import fs from 'fs';
import path from 'path';

const router = Router();
let backtestRunInProgress = false;

// Применить аутентификацию ко всем маршрутам
router.use(authenticate);

// Получить последние строки логов
router.get('/logs', async (req, res) => {
  const logPath = path.join(__dirname, '../../logs/combined.log');
  try {
    if (!fs.existsSync(logPath)) return res.json([]);
    const data = fs.readFileSync(logPath, 'utf-8').split('\n');
    const lastLines = data.slice(-100);
    res.json(lastLines);
  } catch (error) {
    res.status(500).json({ error: 'Log read error' });
  }
});

// Системные Git-обновления (VPS)
router.get('/system/update/status', async (req, res) => {
  const refresh = String(req.query.refresh || '1') !== '0';

  try {
    const status = await getGitUpdateStatus(refresh);
    res.json(status);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error reading git update status: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/system/update/run', async (req, res) => {
  try {
    const result = await triggerGitUpdate();
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error starting git update: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/system/update/job', async (req, res) => {
  try {
    const job = await getGitUpdateJobStatus();
    res.json(job);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error reading git update job: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// API ключи
router.get('/api-keys', async (req, res) => {
  try {
    const { apiKeys } = await loadSettings();
    res.json(apiKeys);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading API keys: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api-keys', async (req, res) => {
  const key: ApiKey = req.body;
  try {
    await saveApiKey(key);
    // Инициализировать клиент
    const { apiKeys } = await loadSettings();
    const savedKey = apiKeys.find(k => k.name === key.name);
    if (savedKey) initExchangeClient(savedKey);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error saving API key: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/api-keys/:id', async (req, res) => {
  const { id } = req.params;
  const key: ApiKey = req.body;
  try {
    await db.run(
      'UPDATE api_keys SET name = ?, exchange = ?, api_key = ?, secret = ?, passphrase = ?, speed_limit = ?, testnet = ?, demo = ? WHERE id = ?',
      [
        key.name,
        key.exchange,
        key.api_key,
        key.secret,
        key.passphrase || '',
        key.speed_limit || 10,
        key.testnet ? 1 : 0,
        key.demo ? 1 : 0,
        id,
      ]
    );
    // Re-init client if needed
    const { apiKeys } = await loadSettings();
    const updatedKey = apiKeys.find(k => k.id === parseInt(id));
    if (updatedKey) initExchangeClient(updatedKey);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating API key: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api-keys/:id', async (req, res) => {
  const { id } = req.params;
  const apiKeyId = Number.parseInt(id, 10);

  if (Number.isNaN(apiKeyId)) {
    return res.status(400).json({ error: 'Invalid API key id' });
  }

  try {
    const existingKey = await db.get('SELECT * FROM api_keys WHERE id = ?', [apiKeyId]);
    if (!existingKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await db.run('DELETE FROM chart_settings WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM risk_settings WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM strategies WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM monitoring_snapshots WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM api_keys WHERE id = ?', [apiKeyId]);

    removeExchangeClient(existingKey.name);

    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting API key ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Проверка статуса API-ключа (валидность, ошибки)
router.get('/key-status/:key', async (req, res) => {
  const { key } = req.params;
  try {
    await getBalances(key);
    res.json({ status: 'ok' });
  } catch (error) {
    const err = error as Error;
    if (err.message && err.message.match(/invalid|forbidden|apikey|permission|denied/i)) {
      res.json({ status: 'critical', message: err.message });
    } else {
      res.json({ status: 'warning', message: err.message });
    }
  }
});

// Проверка статуса чарта (volume, max lot)
router.get('/chart-status/:apiKeyName/:symbol', authenticate, async (req, res) => {
  const { apiKeyName, symbol } = req.params;
  const { minVolume, lotSize } = req.query;
  try {
    const volume = await get24hVolume(apiKeyName, symbol);
    const info = await getInstrumentInfo(apiKeyName, symbol);
    const maxLot = info?.lotSizeFilter?.maxOrderQty;
    const status: any = { volumeOk: true, lotOk: true };
    if (minVolume && Number(volume) < Number(minVolume)) {
      status.volumeOk = false;
    }
    if (lotSize && maxLot && Number(lotSize) > Number(maxLot)) {
      status.lotOk = false;
    }
    res.json(status);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// Маршруты для риск-настроек
router.get('/risk-settings/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const settings = await getRiskSettings(apiKeyName);
    res.json(settings);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading risk settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/risk-settings/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const settings: RiskSettings = req.body;
  try {
    await updateRiskSettings(apiKeyName, settings);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating risk settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Маршруты для чартов
router.get('/chart-settings/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const { apiKeys, chartSettings } = await loadSettings();
    const apiKey = apiKeys.find(k => k.name === apiKeyName);
    if (!apiKey) return res.status(404).json({ error: 'API key not found' });
    const settings = chartSettings.filter(s => s.api_key_id === apiKey.id);
    res.json(settings);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading chart settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/chart-settings/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const settings: ChartSettings = req.body;
  try {
    const apiKey = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await saveChartSettings({
      ...settings,
      api_key_id: Number(apiKey.id),
    });

    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating chart settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Маршруты для стратегий
router.post('/strategies/copy-block', async (req, res) => {
  const {
    sourceApiKey,
    targetApiKey,
    replaceTarget,
    preserveActive,
    syncSymbols,
  } = req.body || {};

  if (!sourceApiKey || !targetApiKey) {
    return res.status(400).json({ error: 'sourceApiKey and targetApiKey are required' });
  }

  try {
    const result = await copyStrategyBlock(String(sourceApiKey), String(targetApiKey), {
      replaceTarget: replaceTarget !== false,
      preserveActive: preserveActive === true,
      syncSymbols: syncSymbols !== false,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error copying strategy block: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const strategies = await getStrategies(apiKeyName);
    res.json(strategies);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading strategies: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/strategies/:apiKeyName', async (req, res) => {
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

router.post('/backtest/run', async (req, res) => {
  if (backtestRunInProgress) {
    return res.status(429).json({
      error: 'Backtest already running. Wait for current run to finish before starting a new one.',
    });
  }

  try {
    backtestRunInProgress = true;
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
    backtestRunInProgress = false;
  }
});

router.get('/backtest/runs', async (req, res) => {
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

router.get('/backtest/runs/:id', async (req, res) => {
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

router.post('/strategies/:apiKeyName/bulk-activation', async (req, res) => {
  const { apiKeyName } = req.params;
  const isActive = req.body?.isActive === true;

  try {
    const result = await setAllStrategiesActive(apiKeyName, isActive);
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error setting strategies activation for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategies/:apiKeyName/:strategyId/cancel-orders', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    const updated = await cancelStrategyOrders(apiKeyName, Number.parseInt(strategyId, 10));
    res.json({ success: true, strategy: updated });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error cancelling strategy orders: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategies/:apiKeyName/:strategyId/close-positions', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    const updated = await closeStrategyPositions(apiKeyName, Number.parseInt(strategyId, 10));
    res.json({ success: true, strategy: updated });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing strategy positions: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const strategy = req.body;
  try {
    const created = await createStrategy(apiKeyName, strategy);
    res.json(created);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error saving strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/strategies/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  const strategyPatch: Partial<Strategy> = req.body;
  try {
    const updated = await updateStrategy(apiKeyName, Number.parseInt(strategyId, 10), strategyPatch);
    res.json(updated);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/strategies/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    await deleteStrategy(apiKeyName, Number.parseInt(strategyId, 10));
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/execute-strategy/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    const result = await executeStrategy(apiKeyName, parseInt(strategyId));
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error executing strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pause-strategy/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    await pauseStrategy(apiKeyName, parseInt(strategyId));
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error pausing strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/stop-strategy/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    await stopStrategy(apiKeyName, parseInt(strategyId));
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error stopping strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/close-position-percent/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  const { symbol, percent, side } = req.body;
  try {
    await closePositionPercent(apiKeyName, parseInt(strategyId), symbol, percent, side);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing position: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/manual-order/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, side, qty, price } = req.body;
  try {
    const order = await placeManualOrder(apiKeyName, symbol, side, qty, price);
    res.json(order);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error placing manual order: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Маршруты для данных
router.get('/market-data/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, interval, limit } = req.query;
  logger.info(`Market data request: key=${apiKeyName}, symbol=${symbol}, interval=${interval}, limit=${limit}`);
  if (!symbol || !interval) {
    return res.status(400).json({ error: 'Missing required parameters: symbol, interval' });
  }
  try {
    const data = await getMarketData(apiKeyName, symbol as string, interval as string, parseInt(limit as string) || 100);
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`Market data error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/order/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, side, qty, price } = req.body;
  try {
    const order = await placeOrder(apiKeyName, symbol, side, qty, price);
    res.json(order);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

router.get('/order/:apiKeyName/:id', async (req, res) => {
  const { apiKeyName, id } = req.params;
  try {
    const status = await getOrderStatus(apiKeyName, id);
    res.json(status);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

router.get('/balances/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  logger.info(`Balances request for key: ${apiKeyName}`);
  try {
    const balances = await getBalances(apiKeyName);
    logger.info(`Balances response for ${apiKeyName}: ${balances.length} items`);
    res.json(balances);
  } catch (error) {
    const err = error as Error;
    logger.error(`Balances error for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/positions/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol } = req.query;
  try {
    const positions = await getPositions(apiKeyName, symbol as string);
    res.json(positions);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

router.post('/positions/:apiKeyName/close-all', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const result = await closeAllPositions(apiKeyName);
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing all positions for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const symbol = req.query.symbol ? String(req.query.symbol) : undefined;

  try {
    const orders = await getOpenOrders(apiKeyName, symbol);
    res.json(orders);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading open orders for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders/:apiKeyName/cancel-all', async (req, res) => {
  const { apiKeyName } = req.params;
  const symbol = req.body?.symbol ? String(req.body.symbol) : undefined;

  try {
    const result = await cancelAllOrders(apiKeyName, symbol);
    res.json({ success: true, result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error cancelling orders for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/monitoring/:apiKeyName/snapshot', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const snapshot = await recordMonitoringSnapshot(apiKeyName);
    res.json(snapshot);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error recording monitoring snapshot for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/monitoring/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const capture = String(req.query.capture || '0') === '1' || String(req.query.capture || '').toLowerCase() === 'true';
  const limitRaw = Number.parseInt(String(req.query.limit || '240'), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 240;

  try {
    if (capture) {
      await recordMonitoringSnapshot(apiKeyName);
    }

    const points = await getMonitoringSnapshots(apiKeyName, limit);
    const latest = points.length > 0 ? points[points.length - 1] : await getMonitoringLatest(apiKeyName);

    res.json({ points, latest });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading monitoring data for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api-keys/:apiKeyName/actions', async (req, res) => {
  const { apiKeyName } = req.params;
  const action = String(req.body?.action || '').trim();

  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }

  try {
    if (action === 'play-bots') {
      const result = await setAllStrategiesActive(apiKeyName, true);
      return res.json({ success: true, action, ...result });
    }

    if (action === 'pause-bots') {
      const result = await setAllStrategiesActive(apiKeyName, false);
      return res.json({ success: true, action, ...result });
    }

    if (action === 'cancel-orders') {
      const result = await cancelAllOrders(apiKeyName);
      return res.json({ success: true, action, result });
    }

    if (action === 'close-positions') {
      const result = await closeAllPositions(apiKeyName);
      return res.json({ success: true, action, ...result });
    }

    return res.status(400).json({ error: `Unsupported action: ${action}` });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error running key action (${action}) for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/controls/global', async (req, res) => {
  const action = String(req.body?.action || '').trim();
  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }

  const rows = await db.all('SELECT name FROM api_keys ORDER BY id ASC');
  const keyNames = rows.map((row: any) => String(row.name));
  const errors: Array<{ apiKey: string; error: string }> = [];

  for (const apiKeyName of keyNames) {
    try {
      if (action === 'play-bots') {
        await setAllStrategiesActive(apiKeyName, true);
      } else if (action === 'pause-bots') {
        await setAllStrategiesActive(apiKeyName, false);
      } else if (action === 'cancel-orders') {
        await cancelAllOrders(apiKeyName);
      } else if (action === 'close-positions') {
        await closeAllPositions(apiKeyName);
      } else {
        return res.status(400).json({ error: `Unsupported action: ${action}` });
      }
    } catch (error) {
      errors.push({
        apiKey: apiKeyName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (errors.length > 0) {
    return res.status(207).json({ success: false, action, errors, processed: keyNames.length });
  }

  res.json({ success: true, action, processed: keyNames.length });
});

router.post('/positions/:apiKeyName/close-percent', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, side, percent } = req.body;
  try {
    if (!symbol || !side) {
      return res.status(400).json({ error: 'symbol and side are required' });
    }

    await closePositionPercentExchange(
      apiKeyName,
      String(symbol),
      side as 'Buy' | 'Sell',
      Number(percent)
    );

    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing position percent: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/synthetic-chart/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { base, quote, baseCoef, quoteCoef, interval, limit } = req.query;
  logger.info(`Synthetic chart request for key: ${apiKeyName}`);
  try {
    const data = await calculateSyntheticOHLC(apiKeyName, base as string, quote as string, parseFloat(baseCoef as string), parseFloat(quoteCoef as string), interval as string, parseInt(limit as string));
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error calculating synthetic chart: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Получить все доступные пары с биржи
router.get('/symbols/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const symbols = await getAllSymbols(apiKeyName);
    res.json(symbols);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error fetching symbols: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;

import express from 'express';
import cors from 'cors';
import routes from './api/routes';
import researchRoutes from './api/researchRoutes';
import { initDB, getDbFilePath } from './utils/database';
import logger from './utils/logger';
import { runAutoStrategiesCycle } from './bot/strategy';
import { startPreviewWorker } from './workers/previewWorker';
import { startResearchSchedulerWorker } from './workers/researchSchedulerWorker';
import { runLiquidityScanCycle, runMonitoringCycle, runReconciliationCycle } from './automation/scheduler';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use('/api', routes);
app.use('/api/research', researchRoutes);

import { loadSettings } from './config/settings';
import { initExchangeClient } from './bot/exchange';

const startServer = async () => {
  await initDB();
  logger.info(`Database initialized: ${getDbFilePath()}`);

  // Инициализация клиентов Bybit для всех ключей
  try {
    const { apiKeys } = await loadSettings();
    apiKeys.forEach((key: any) => {
      try {
        initExchangeClient(key);
      } catch (e) {
        logger.error(`Error initializing client for key ${key.name}: ${(e as Error).message}`);
      }
    });
  } catch (e) {
    logger.error('Error initializing exchange clients: ' + (e as Error).message);
  }

  // Когда BTDD_DISABLE_RESEARCH_WORKERS=1 — workers запускаются отдельным btdd-research.service
  const researchWorkersEnabled = process.env.BTDD_DISABLE_RESEARCH_WORKERS !== '1';
  // Когда BTDD_DISABLE_TRADING=1 — торговые циклы запускаются отдельным btdd-runtime.service
  const tradingEnabled = process.env.BTDD_DISABLE_TRADING !== '1';

  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);

    if (researchWorkersEnabled) {
      // Research circuit — preview job worker
      void startPreviewWorker();
      // Research circuit — scheduled daily sweep sync
      void startResearchSchedulerWorker();
      logger.info('Research workers started (встроенный режим; для изоляции: BTDD_DISABLE_RESEARCH_WORKERS=1)');
    } else {
      logger.info('Research workers disabled (запускаются отдельным btdd-research.service)');
    }
  });

  const autoRunSecRaw = Number(process.env.STRATEGY_AUTORUN_SEC || 30);
  const autoRunSec = Number.isFinite(autoRunSecRaw) && autoRunSecRaw >= 5 ? Math.floor(autoRunSecRaw) : 30;
  const monitoringSecRaw = Number(process.env.MONITORING_SNAPSHOT_SEC || 300);
  const monitoringSec = Number.isFinite(monitoringSecRaw) && monitoringSecRaw >= 30 ? Math.floor(monitoringSecRaw) : 300;
  const reconciliationMinRaw = Number(process.env.RECONCILIATION_INTERVAL_MIN || 360);
  const reconciliationMin = Number.isFinite(reconciliationMinRaw) && reconciliationMinRaw >= 15 ? Math.floor(reconciliationMinRaw) : 360;
  const liquidityScanMinRaw = Number(process.env.LIQUIDITY_SCAN_INTERVAL_MIN || 180);
  const liquidityScanMin = Number.isFinite(liquidityScanMinRaw) && liquidityScanMinRaw >= 15 ? Math.floor(liquidityScanMinRaw) : 180;
  const reconciliationPeriodHoursRaw = Number(process.env.RECONCILIATION_PERIOD_HOURS || 24);
  const reconciliationPeriodHours = Number.isFinite(reconciliationPeriodHoursRaw) && reconciliationPeriodHoursRaw >= 1
    ? Math.floor(reconciliationPeriodHoursRaw)
    : 24;
  const reconciliationBarsRaw = Number(process.env.RECONCILIATION_BACKTEST_BARS || 336);
  const reconciliationBars = Number.isFinite(reconciliationBarsRaw) && reconciliationBarsRaw >= 120
    ? Math.floor(reconciliationBarsRaw)
    : 336;
  const autoApplyAdjustments = String(process.env.RECONCILIATION_AUTO_APPLY || '0').trim() === '1';
  const autoPauseOnCritical = String(process.env.RECONCILIATION_AUTO_PAUSE || '0').trim() === '1';
  const scannerTopUniverseRaw = Number(process.env.LIQUIDITY_SCANNER_TOP_UNIVERSE || 120);
  const scannerTopUniverse = Number.isFinite(scannerTopUniverseRaw) && scannerTopUniverseRaw >= 20
    ? Math.floor(scannerTopUniverseRaw)
    : 120;
  if (!tradingEnabled) {
    logger.info('Trading cycles disabled (запускаются отдельным btdd-runtime.service)');
    return;
  }

  let autoCycleRunning = false;
  let monitoringCycleRunning = false;
  let reconciliationCycleRunning = false;
  let liquidityScanCycleRunning = false;

  setInterval(async () => {
    if (autoCycleRunning) {
      return;
    }

    autoCycleRunning = true;
    try {
      const result = await runAutoStrategiesCycle();
      if (result.total > 0) {
        logger.info(
          `Auto strategy cycle: total=${result.total}, processed=${result.processed}, failed=${result.failed}`
        );
      }
    } catch (error) {
      logger.error(`Auto strategy cycle error: ${(error as Error).message}`);
    } finally {
      autoCycleRunning = false;
    }
  }, autoRunSec * 1000);

  setInterval(async () => {
    if (monitoringCycleRunning) {
      return;
    }

    monitoringCycleRunning = true;
    try {
      const result = await runMonitoringCycle();
      if (result.processed > 0 || result.failed > 0) {
        logger.info(`Monitoring cycle: processed=${result.processed}, failed=${result.failed}`);
      }
    } catch (error) {
      logger.error(`Monitoring cycle error: ${(error as Error).message}`);
    } finally {
      monitoringCycleRunning = false;
    }
  }, monitoringSec * 1000);

  setInterval(async () => {
    if (reconciliationCycleRunning) {
      return;
    }

    reconciliationCycleRunning = true;
    try {
      const result = await runReconciliationCycle({
        periodHours: reconciliationPeriodHours,
        backtestBars: reconciliationBars,
        autoApplyAdjustments,
        autoPauseOnCritical,
      });

      if (result.processed > 0 || result.failed > 0) {
        logger.info(`Reconciliation cycle: processed=${result.processed}, failed=${result.failed}`);
      }
    } catch (error) {
      logger.error(`Reconciliation cycle error: ${(error as Error).message}`);
    } finally {
      reconciliationCycleRunning = false;
    }
  }, reconciliationMin * 60 * 1000);

  setInterval(async () => {
    if (liquidityScanCycleRunning) {
      return;
    }

    liquidityScanCycleRunning = true;
    try {
      const result = await runLiquidityScanCycle({
        topUniverseLimit: scannerTopUniverse,
      });

      if (result.processed > 0 || result.failed > 0 || result.suggestions > 0) {
        logger.info(
          `Liquidity scan cycle: processed=${result.processed}, failed=${result.failed}, suggestions=${result.suggestions}`
        );
      }
    } catch (error) {
      logger.error(`Liquidity scan cycle error: ${(error as Error).message}`);
    } finally {
      liquidityScanCycleRunning = false;
    }
  }, liquidityScanMin * 60 * 1000);
};

startServer();

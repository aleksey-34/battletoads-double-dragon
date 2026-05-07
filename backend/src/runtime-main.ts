/**
 * BTDD Runtime Process — торговый контур.
 *
 * Запускается как отдельный systemd-сервис (btdd-runtime.service).
 * Не поднимает HTTP-сервер. Только сам торговый цикл:
 *   - runAutoStrategiesCycle
 *   - runMonitoringCycle
 *   - runReconciliationCycle
 *   - runLiquidityScanCycle
 *
 * Env vars:
 *   STRATEGY_AUTORUN_SEC        (default 30)
 *   MONITORING_SNAPSHOT_SEC     (default 300)
 *   RECONCILIATION_INTERVAL_MIN (default 360)
 *   LIQUIDITY_SCAN_INTERVAL_MIN (default 180)
 *   RECONCILIATION_PERIOD_HOURS (default 24)
 *   RECONCILIATION_BACKTEST_BARS (default 336)
 *   RECONCILIATION_AUTO_APPLY   (default 0)
 *   RECONCILIATION_AUTO_PAUSE   (default 0)
 *   LIQUIDITY_SCANNER_TOP_UNIVERSE (default 120)
 */

import { initDB, getDbFilePath, db } from './utils/database';
import logger from './utils/logger';
import { loadSettings } from './config/settings';
import { initExchangeClient } from './bot/exchange';
import { runAutoStrategiesCycle } from './bot/strategy';
import { runLiquidityScanCycle, runMonitoringCycle, runReconciliationCycle } from './automation/scheduler';
import { startAdminTelegramReporter } from './notifications/adminTelegramReporter';

const parseBool = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
};

const getRuntimeFlag = async (key: string, fallback: string): Promise<string> => {
  try {
    const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', [key]);
    const value = String(row?.value || '').trim();
    return value || fallback;
  } catch {
    return fallback;
  }
};

const readCycleEnabled = async (
  dbKey: string,
  envKey: string,
  fallback = false,
): Promise<boolean> => {
  const envValue = process.env[envKey];
  const fallbackValue = envValue !== undefined ? String(envValue) : (fallback ? '1' : '0');
  const flagValue = await getRuntimeFlag(dbKey, fallbackValue);
  return parseBool(flagValue, fallback);
};

const startRuntime = async () => {
  await initDB();
  logger.info(`[runtime] Database initialized: ${getDbFilePath()}`);

  // Инициализация биржевых клиентов
  try {
    const { apiKeys } = await loadSettings();
    apiKeys.forEach((key: any) => {
      try {
        initExchangeClient(key);
      } catch (e) {
        logger.error(`[runtime] Error initializing client for key ${key.name}: ${(e as Error).message}`);
      }
    });
  } catch (e) {
    logger.error('[runtime] Error initializing exchange clients: ' + (e as Error).message);
  }

  try {
    await startAdminTelegramReporter();
  } catch (e) {
    logger.warn('[runtime] Telegram admin reporter failed to start: ' + (e as Error).message);
  }

  // ── Параметры циклов ────────────────────────────────────────────────────────
  const autoRunSec = Math.max(5, Math.floor(Number(process.env.STRATEGY_AUTORUN_SEC || 30) || 30));
  const monitoringSec = Math.max(30, Math.floor(Number(process.env.MONITORING_SNAPSHOT_SEC || 300) || 300));
  const reconciliationMin = Math.max(15, Math.floor(Number(process.env.RECONCILIATION_INTERVAL_MIN || 360) || 360));
  const liquidityScanMin = Math.max(15, Math.floor(Number(process.env.LIQUIDITY_SCAN_INTERVAL_MIN || 180) || 180));
  const reconciliationPeriodHours = Math.max(1, Math.floor(Number(process.env.RECONCILIATION_PERIOD_HOURS || 24) || 24));
  const reconciliationBars = Math.max(120, Math.floor(Number(process.env.RECONCILIATION_BACKTEST_BARS || 336) || 336));
  const autoApplyAdjustments = process.env.RECONCILIATION_AUTO_APPLY === '1';
  const autoPauseOnCritical = process.env.RECONCILIATION_AUTO_PAUSE === '1';
  const scannerTopUniverse = Math.max(20, Math.floor(Number(process.env.LIQUIDITY_SCANNER_TOP_UNIVERSE || 120) || 120));
  const autoCycleEnabled = await readCycleEnabled('runtime.cycle.autorun.enabled', 'BTDD_RUNTIME_AUTORUN_ENABLED', false);
  const monitoringCycleEnabled = await readCycleEnabled('runtime.cycle.monitoring.enabled', 'BTDD_RUNTIME_MONITORING_ENABLED', false);
  const reconciliationCycleEnabled = await readCycleEnabled('runtime.cycle.reconciliation.enabled', 'BTDD_RUNTIME_RECONCILIATION_ENABLED', false);
  const liquidityScanCycleEnabled = await readCycleEnabled('runtime.cycle.liquidity_scan.enabled', 'BTDD_RUNTIME_LIQUIDITY_SCAN_ENABLED', false);

  logger.info(
    `[runtime] Cycle config: autoRun=${autoRunSec}s(${autoCycleEnabled ? 'on' : 'off'}), ` +
    `monitoring=${monitoringSec}s(${monitoringCycleEnabled ? 'on' : 'off'}), ` +
    `reconciliation=${reconciliationMin}min(${reconciliationCycleEnabled ? 'on' : 'off'}), ` +
    `liquidityScan=${liquidityScanMin}min(${liquidityScanCycleEnabled ? 'on' : 'off'})`
  );

  let autoCycleRunning = false;
  let monitoringCycleRunning = false;
  let reconciliationCycleRunning = false;
  let liquidityScanCycleRunning = false;

  // ── Auto trading cycle ───────────────────────────────────────────────────────
  if (autoCycleEnabled) {
    setInterval(async () => {
      if (autoCycleRunning) return;
      autoCycleRunning = true;
      try {
        const result = await runAutoStrategiesCycle();
        if (result.total > 0) {
          logger.info(`[runtime] Auto strategy cycle: total=${result.total}, processed=${result.processed}, failed=${result.failed}`);
        }
      } catch (error) {
        logger.error(`[runtime] Auto strategy cycle error: ${(error as Error).message}`);
      } finally {
        autoCycleRunning = false;
      }
    }, autoRunSec * 1000);
  } else {
    logger.warn('[runtime] Auto strategy cycle is disabled by runtime flag');
  }

  // ── Monitoring cycle ─────────────────────────────────────────────────────────
  if (monitoringCycleEnabled) {
    setInterval(async () => {
      if (monitoringCycleRunning) return;
      monitoringCycleRunning = true;
      try {
        const result = await runMonitoringCycle();
        if (result.processed > 0 || result.failed > 0) {
          logger.info(`[runtime] Monitoring cycle: processed=${result.processed}, failed=${result.failed}`);
        }
      } catch (error) {
        logger.error(`[runtime] Monitoring cycle error: ${(error as Error).message}`);
      } finally {
        monitoringCycleRunning = false;
      }
    }, monitoringSec * 1000);
  } else {
    logger.warn('[runtime] Monitoring cycle is disabled by runtime flag');
  }

  // ── Reconciliation cycle ─────────────────────────────────────────────────────
  if (reconciliationCycleEnabled) {
    setInterval(async () => {
      if (reconciliationCycleRunning) return;
      reconciliationCycleRunning = true;
      try {
        const result = await runReconciliationCycle({
          periodHours: reconciliationPeriodHours,
          backtestBars: reconciliationBars,
          autoApplyAdjustments,
          autoPauseOnCritical,
        });
        if (result.processed > 0 || result.failed > 0) {
          logger.info(`[runtime] Reconciliation cycle: processed=${result.processed}, failed=${result.failed}`);
        }
      } catch (error) {
        logger.error(`[runtime] Reconciliation cycle error: ${(error as Error).message}`);
      } finally {
        reconciliationCycleRunning = false;
      }
    }, reconciliationMin * 60 * 1000);
  } else {
    logger.warn('[runtime] Reconciliation cycle is disabled by runtime flag');
  }

  // ── Liquidity scan cycle ─────────────────────────────────────────────────────
  if (liquidityScanCycleEnabled) {
    setInterval(async () => {
      if (liquidityScanCycleRunning) return;
      liquidityScanCycleRunning = true;
      try {
        const result = await runLiquidityScanCycle({ topUniverseLimit: scannerTopUniverse });
        if (result.processed > 0 || result.failed > 0 || result.suggestions > 0) {
          logger.info(`[runtime] Liquidity scan: processed=${result.processed}, failed=${result.failed}, suggestions=${result.suggestions}`);
        }
      } catch (error) {
        logger.error(`[runtime] Liquidity scan cycle error: ${(error as Error).message}`);
      } finally {
        liquidityScanCycleRunning = false;
      }
    }, liquidityScanMin * 60 * 1000);
  } else {
    logger.warn('[runtime] Liquidity scan cycle is disabled by runtime flag');
  }

  if (!autoCycleEnabled && !monitoringCycleEnabled && !reconciliationCycleEnabled && !liquidityScanCycleEnabled) {
    logger.warn('[runtime] All runtime cycles are disabled by flags; waiting for explicit enable');
    setInterval(() => {
      // keep process alive while all cycles are disabled
    }, 24 * 60 * 60 * 1000);
  }

  logger.info('[runtime] Runtime process started — торговый контур активен');
};

// ── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = (signal: string) => {
  logger.info(`[runtime] Received ${signal} — shutting down gracefully`);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startRuntime().catch((err) => {
  logger.error('[runtime] Fatal startup error: ' + (err as Error).message);
  process.exit(1);
});

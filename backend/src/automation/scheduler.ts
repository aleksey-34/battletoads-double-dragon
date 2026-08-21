import logger from '../utils/logger';
import { db } from '../utils/database';
import { ensureExchangeClientInitialized, hasExchangeClient } from '../bot/exchange';
import { recordMonitoringSnapshot } from '../bot/monitoring';
import { runReconciliationForApiKey, syncExchangeFillsForApiKey } from './reconciliationEngine';
import { runLiquidityScanForApiKey } from './liquidityScanner';

// Maximum concurrency for parallel API key operations.
// Keeps total API load manageable while still being faster than sequential.
const MONITORING_CONCURRENCY = 4;

const loadApiKeysWithActiveStrategies = async (): Promise<string[]> => {
  const rows = await db.all(
    `SELECT DISTINCT a.name
     FROM api_keys a
     JOIN strategies s ON s.api_key_id = a.id
     WHERE s.is_active = 1`
  );

  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.name || '').trim())
    .filter((name) => name.length > 0);
};

/** Keys assigned to client cabinets (even with no active strategies yet). */
const loadApiKeysAssignedToTenants = async (): Promise<string[]> => {
  const rows = await db.all(
    `SELECT DISTINCT key_name FROM (
       SELECT TRIM(COALESCE(NULLIF(ap.execution_api_key_name, ''), ap.assigned_api_key_name, '')) AS key_name
       FROM algofund_profiles ap
       JOIN tenants t ON t.id = ap.tenant_id
       WHERE t.status != 'deleted'
       UNION
       SELECT TRIM(COALESCE(sp.assigned_api_key_name, '')) AS key_name
       FROM strategy_client_profiles sp
       JOIN tenants t ON t.id = sp.tenant_id
       WHERE t.status != 'deleted'
       UNION
       SELECT TRIM(COALESCE(t.assigned_api_key_name, '')) AS key_name
       FROM tenants t
       WHERE t.status != 'deleted'
     ) q
     WHERE key_name IS NOT NULL AND length(key_name) > 0`
  ).catch(() => []);

  return (Array.isArray(rows) ? rows : [])
    .map((row) => String((row as { key_name?: string })?.key_name || '').trim())
    .filter((name) => name.length > 0);
};

const loadMonitoringApiKeys = async (): Promise<string[]> => {
  const [active, assigned] = await Promise.all([
    loadApiKeysWithActiveStrategies(),
    loadApiKeysAssignedToTenants(),
  ]);
  return Array.from(new Set([...active, ...assigned]));
};

const loadAllApiKeys = async (): Promise<string[]> => {
  const rows = await db.all(`SELECT name FROM api_keys`);
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.name || '').trim())
    .filter((name) => name.length > 0);
};

const loadApiKeysWithDiscoverySystems = async (): Promise<string[]> => {
  const rows = await db.all(
    `SELECT DISTINCT a.name
     FROM api_keys a
     JOIN trading_systems ts ON ts.api_key_id = a.id
     WHERE ts.discovery_enabled = 1`
  );

  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.name || '').trim())
    .filter((name) => name.length > 0);
};

export type MonitoringBatchProgress = {
  done: number;
  total: number;
  current?: string;
  failed: number;
};

export const runMonitoringCycleForApiKeys = async (
  apiKeys: string[],
  onProgress?: (progress: MonitoringBatchProgress) => void,
): Promise<{ processed: number; failed: number }> => {
  const uniqueKeys = Array.from(new Set(apiKeys.map((k) => String(k || '').trim()).filter(Boolean)));
  let processed = 0;
  let failed = 0;

  const report = (current?: string) => {
    onProgress?.({
      done: processed + failed,
      total: uniqueKeys.length,
      current,
      failed,
    });
  };

  const keyToExchange = new Map<string, string>();
  try {
    const keyRows = await db.all('SELECT name, exchange FROM api_keys');
    for (const row of keyRows) {
      keyToExchange.set(String(row?.name || ''), String(row?.exchange || ''));
    }
  } catch (e) {
    logger.warn(`Failed to load key-exchange map: ${(e as Error)?.message}`);
  }

  const weexKeys = uniqueKeys.filter((k) => keyToExchange.get(k) === 'weex');
  const otherKeys = uniqueKeys.filter((k) => keyToExchange.get(k) !== 'weex');

  const readyKeys = new Set<string>();
  for (const apiKeyName of uniqueKeys) {
    try {
      await ensureExchangeClientInitialized(apiKeyName);
      if (hasExchangeClient(apiKeyName)) {
        readyKeys.add(apiKeyName);
      } else {
        logger.debug(`[monitoring] Skip ${apiKeyName}: exchange client is not initialized`);
      }
    } catch (e) {
      logger.debug(`[monitoring] Could not initialize ${apiKeyName}: ${(e as Error)?.message}`);
    }
  }

  const activeOtherKeys = otherKeys.filter((k) => readyKeys.has(k));
  const activeWeexKeys = weexKeys.filter((k) => readyKeys.has(k));

  if (activeOtherKeys.length > 0) {
    for (let i = 0; i < activeOtherKeys.length; i += MONITORING_CONCURRENCY) {
      const batch = activeOtherKeys.slice(i, i + MONITORING_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (apiKeyName) => {
          report(apiKeyName);
          await recordMonitoringSnapshot(apiKeyName);
          try {
            await syncExchangeFillsForApiKey(apiKeyName);
          } catch (syncError) {
            logger.debug(`Exchange-fill sync skipped for ${apiKeyName}: ${(syncError as Error).message}`);
          }
          return apiKeyName;
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          processed += 1;
        } else {
          failed += 1;
          logger.warn(`Monitoring cycle failed: ${(r.reason as Error)?.message}`);
        }
        report();
      }
    }
  }

  for (const weexKey of activeWeexKeys) {
    report(weexKey);
    try {
      await recordMonitoringSnapshot(weexKey);
      try {
        await syncExchangeFillsForApiKey(weexKey);
      } catch (syncError) {
        logger.debug(`Exchange-fill sync skipped for WEEX ${weexKey}: ${(syncError as Error).message}`);
      }
      processed += 1;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (e) {
      failed += 1;
      logger.warn(`Monitoring cycle failed for WEEX key ${weexKey}: ${(e as Error)?.message}`);
    }
    report();
  }

  return { processed, failed };
};

export const runMonitoringCycle = async (): Promise<{ processed: number; failed: number }> => {
  const apiKeys = await loadMonitoringApiKeys();
  return runMonitoringCycleForApiKeys(apiKeys);
};

export const runReconciliationCycle = async (
  options?: {
    periodHours?: number;
    backtestBars?: number;
    autoApplyAdjustments?: boolean;
    autoPauseOnCritical?: boolean;
  }
): Promise<{ processed: number; failed: number }> => {
  const apiKeys = await loadApiKeysWithActiveStrategies();
  let processed = 0;
  let failed = 0;

  for (const apiKeyName of apiKeys) {
    try {
      await ensureExchangeClientInitialized(apiKeyName);
      const report = await runReconciliationForApiKey(apiKeyName, options);
      processed += report.processed > 0 ? 1 : 0;
      if (report.failed > 0) {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      logger.warn(`Reconciliation cycle failed for ${apiKeyName}: ${(error as Error).message}`);
    }
  }

  return { processed, failed };
};

export const runLiquidityScanCycle = async (
  options?: {
    topUniverseLimit?: number;
    maxAddSuggestions?: number;
    maxReplaceSuggestions?: number;
  }
): Promise<{ processed: number; failed: number; suggestions: number }> => {
  const apiKeys = await loadApiKeysWithDiscoverySystems();
  let processed = 0;
  let failed = 0;
  let suggestions = 0;

  for (const apiKeyName of apiKeys) {
    try {
      await ensureExchangeClientInitialized(apiKeyName);
      const result = await runLiquidityScanForApiKey(apiKeyName, options);
      processed += 1;
      suggestions += result.createdSuggestions;
    } catch (error) {
      failed += 1;
      logger.warn(`Liquidity scan cycle failed for ${apiKeyName}: ${(error as Error).message}`);
    }
  }

  return { processed, failed, suggestions };
};

import logger from '../utils/logger';
import { db } from '../utils/database';
import { ensureExchangeClientInitialized, hasExchangeClient } from '../bot/exchange';
import { recordMonitoringSnapshot } from '../bot/monitoring';
import { runReconciliationForApiKey } from './reconciliationEngine';
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

export const runMonitoringCycle = async (): Promise<{ processed: number; failed: number }> => {
  // Only monitor keys that have at least one active strategy — avoids spamming logs for orphan/broken keys
  const apiKeys = await loadApiKeysWithActiveStrategies();
  let processed = 0;
  let failed = 0;

  // Fetch exchange info for rate-limit management
  const keyToExchange = new Map<string, string>();
  try {
    const keyRows = await db.all('SELECT name, exchange FROM api_keys');
    for (const row of keyRows) {
      keyToExchange.set(String(row?.name || ''), String(row?.exchange || ''));
    }
  } catch (e) {
    logger.warn(`Failed to load key-exchange map: ${(e as Error)?.message}`);
  }

  // Separate WEEX keys (rate-limit sensitive) from others
  const weexKeys = apiKeys.filter(k => keyToExchange.get(k) === 'weex');
  const otherKeys = apiKeys.filter(k => keyToExchange.get(k) !== 'weex');

  // Ensure all clients initialized first (lightweight, idempotent)
  const readyKeys = new Set<string>();
  for (const apiKeyName of apiKeys) {
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

  // Process non-WEEX keys with normal concurrency
  if (activeOtherKeys.length > 0) {
    for (let i = 0; i < activeOtherKeys.length; i += MONITORING_CONCURRENCY) {
      const batch = activeOtherKeys.slice(i, i + MONITORING_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (apiKeyName) => {
          await recordMonitoringSnapshot(apiKeyName);
          return apiKeyName;
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          processed += 1;
        } else {
          failed += 1;
          logger.warn(`Monitoring cycle failed for ${r.reason}: ${(r.reason as Error)?.message}`);
        }
      }
    }
  }

  // Process WEEX keys with reduced concurrency (1 at a time, 2 sec delay between)
  for (const weexKey of activeWeexKeys) {
    try {
      await recordMonitoringSnapshot(weexKey);
      processed += 1;
      // Stagger WEEX key requests to avoid rate-limit bursts
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      failed += 1;
      logger.warn(`Monitoring cycle failed for WEEX key ${weexKey}: ${(e as Error)?.message}`);
    }
  }

  return { processed, failed };
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

import logger from '../utils/logger';
import { db } from '../utils/database';
import { ensureExchangeClientInitialized } from '../bot/exchange';
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
  const apiKeys = await loadAllApiKeys();
  let processed = 0;
  let failed = 0;

  // Ensure all clients initialized first (lightweight, idempotent)
  for (const apiKeyName of apiKeys) {
    try { await ensureExchangeClientInitialized(apiKeyName); } catch { /* skip */ }
  }

  // Process in parallel batches of MONITORING_CONCURRENCY
  for (let i = 0; i < apiKeys.length; i += MONITORING_CONCURRENCY) {
    const batch = apiKeys.slice(i, i + MONITORING_CONCURRENCY);
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
        logger.warn(`Monitoring cycle failed for batch item: ${(r.reason as Error)?.message}`);
      }
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

import logger from '../utils/logger';
import { db } from '../utils/database';
import { ensureExchangeClientInitialized, hasExchangeClient } from '../bot/exchange';
import { recordMonitoringSnapshot } from '../bot/monitoring';
import { runReconciliationForApiKey } from './reconciliationEngine';
import { runLiquidityScanForApiKey } from './liquidityScanner';

// Maximum concurrency for parallel API key operations.
// Keeps total API load manageable while still being faster than sequential.
const MONITORING_CONCURRENCY = 4;

const parseBool = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
};

const HARD_STOP_MARGIN_ENABLED = parseBool(process.env.HARD_STOP_MARGIN_ENABLED, true);
const HARD_STOP_MARGIN_THRESHOLD = (() => {
  const raw = Number(process.env.HARD_STOP_MARGIN_THRESHOLD || 92);
  if (!Number.isFinite(raw)) {
    return 92;
  }
  return Math.min(100, Math.max(50, raw));
})();
const HARD_STOP_MARGIN_CONSECUTIVE = (() => {
  const raw = Number(process.env.HARD_STOP_MARGIN_CONSECUTIVE || 3);
  if (!Number.isFinite(raw)) {
    return 3;
  }
  return Math.min(10, Math.max(1, Math.floor(raw)));
})();
const HARD_STOP_MARGIN_MIN_EQUITY_USD = (() => {
  const raw = Number(process.env.HARD_STOP_MARGIN_MIN_EQUITY_USD || 50);
  if (!Number.isFinite(raw)) {
    return 50;
  }
  return Math.max(0, raw);
})();
const HARD_STOP_MARGIN_EXCLUDED_KEYS = new Set(
  String(process.env.HARD_STOP_MARGIN_EXCLUDED_KEYS || 'artursk-9542210407-api,954')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0)
);

const hardStoppedApiKeys = new Set<string>();

const isHardStopExcludedKey = (apiKeyName: string): boolean => {
  const lower = String(apiKeyName || '').trim().toLowerCase();
  if (!lower) {
    return false;
  }
  for (const token of HARD_STOP_MARGIN_EXCLUDED_KEYS) {
    if (lower === token || lower.includes(token)) {
      return true;
    }
  }
  return false;
};

const evaluateAndApplyMarginHardStop = async (apiKeyName: string): Promise<void> => {
  if (!HARD_STOP_MARGIN_ENABLED) {
    return;
  }
  if (isHardStopExcludedKey(apiKeyName)) {
    return;
  }
  if (hardStoppedApiKeys.has(apiKeyName)) {
    return;
  }

  const apiKeyRow = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  const apiKeyId = Number(apiKeyRow?.id || 0);
  if (!Number.isFinite(apiKeyId) || apiKeyId <= 0) {
    return;
  }

  const snapshots = await db.all(
    `SELECT margin_load_percent, equity_usd, created_at
     FROM monitoring_snapshots
     WHERE api_key_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [apiKeyId, HARD_STOP_MARGIN_CONSECUTIVE]
  );

  if (!Array.isArray(snapshots) || snapshots.length < HARD_STOP_MARGIN_CONSECUTIVE) {
    return;
  }

  const margins: number[] = snapshots.map((s: any) => Number(s?.margin_load_percent || 0));
  const equities: number[] = snapshots.map((s: any) => Number(s?.equity_usd || 0));
  const minMargin = Math.min(...margins);
  const latestMargin = margins[0];
  const latestEquity = equities[0];

  if (!Number.isFinite(latestMargin) || latestMargin < HARD_STOP_MARGIN_THRESHOLD) {
    return;
  }
  if (!Number.isFinite(minMargin) || minMargin < HARD_STOP_MARGIN_THRESHOLD) {
    return;
  }
  if (!Number.isFinite(latestEquity) || latestEquity < HARD_STOP_MARGIN_MIN_EQUITY_USD) {
    return;
  }

  const triggerAt = Date.now();
  const reason = `hard-stop margin=${latestMargin.toFixed(2)}% threshold=${HARD_STOP_MARGIN_THRESHOLD}% consecutive=${HARD_STOP_MARGIN_CONSECUTIVE}`;

  const rows = await db.all(
    `SELECT s.id, s.name
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ?
       AND COALESCE(s.is_archived, 0) = 0
       AND (s.is_active = 1 OR COALESCE(s.auto_update, 1) = 1)`,
    [apiKeyName]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    hardStoppedApiKeys.add(apiKeyName);
    logger.warn(`[hard-stop] ${apiKeyName}: margin trigger fired but no active strategies found`);
    return;
  }

  await db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const row of rows) {
      const strategyId = Number(row?.id || 0);
      const strategyName = String(row?.name || `strategy_${strategyId}`);
      if (!Number.isFinite(strategyId) || strategyId <= 0) {
        continue;
      }

      await db.run(
        `UPDATE strategies
         SET is_active = 0,
             auto_update = 0,
             state = 'flat',
             last_action = 'hard_stop_margin',
             last_error = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [reason, strategyId]
      );

      await db.run(
        `INSERT INTO strategy_runtime_events
           (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
         VALUES (?, ?, ?, 'hard_stop_margin', ?, ?, 0, ?)`,
        [
          apiKeyName,
          strategyId,
          strategyName,
          reason,
          JSON.stringify({
            marginThreshold: HARD_STOP_MARGIN_THRESHOLD,
            consecutive: HARD_STOP_MARGIN_CONSECUTIVE,
            observedMargins: margins,
            latestEquity,
            triggeredAt: new Date(triggerAt).toISOString(),
          }),
          triggerAt,
        ]
      );
    }

    await db.run(
      `INSERT OR REPLACE INTO app_runtime_flags (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
      [
        `runtime.hard_stop.margin.${apiKeyName}`,
        JSON.stringify({
          triggeredAt: new Date(triggerAt).toISOString(),
          threshold: HARD_STOP_MARGIN_THRESHOLD,
          consecutive: HARD_STOP_MARGIN_CONSECUTIVE,
          latestMargin,
          observedMargins: margins,
        }),
      ]
    );

    await db.run('COMMIT');
    hardStoppedApiKeys.add(apiKeyName);
    logger.error(
      `[hard-stop] Triggered for ${apiKeyName}: latestMargin=${latestMargin.toFixed(2)}%, `
      + `threshold=${HARD_STOP_MARGIN_THRESHOLD}%, consecutive=${HARD_STOP_MARGIN_CONSECUTIVE}, paused=${rows.length}`
    );
  } catch (e) {
    try {
      await db.run('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw e;
  }
};

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
          await evaluateAndApplyMarginHardStop(apiKeyName);
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
      await evaluateAndApplyMarginHardStop(weexKey);
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

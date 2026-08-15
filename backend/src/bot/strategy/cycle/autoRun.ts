import { getExchangeForApiKey, getPositions } from '../../exchange';
import { warmMarketDataCache, type MarketDataWarmupJob } from '../../marketDataCache';
import logger from '../../../utils/logger';
import { normalizeMarketMode, normalizeStrategyType } from '../normalize';
import { formatActionError } from '../crud';
import { resetCycleSignalCache } from './cache';
import { extractSourceSid, loadExpectedAlgofundSidMap } from './algofundSync';
import { closeAllForSymbol, countExchangeOpenPositions, normalizeExchangeSymbolKey } from './positionGuards';
import { isOfflineSymbolMarketDataError, shouldLogOfflineSymbolSkip, shouldLogWeexDelistSkip } from './offlineSymbol';
import { isWeexDelistBlockingSymbolSync } from '../../weexDelistState';

/** 0 = unlimited (legacy). Default 16 softens exchange 429 / SQLite thrash under dense auto. */
const resolveCycleConcurrency = (jobCount: number): number => {
  const raw = Number(process.env.STRATEGY_CYCLE_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 0) {
    return Math.min(16, Math.max(1, jobCount));
  }
  if (raw === 0) {
    return Math.max(1, jobCount);
  }
  return Math.max(1, Math.min(Math.floor(raw), Math.max(1, jobCount)));
};

const mapSettledWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  if (items.length === 0) {
    return;
  }
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      try {
        await worker(items[current]);
      } catch {
        // executeOne already handles/logs; keep pool alive
      }
    }
  };
  await Promise.all(Array.from({ length: safeConcurrency }, () => run()));
};

export const runAutoStrategiesCycle = async () => {
  const { db } = await import('../../../utils/database');
  const { ensureExchangeClientInitialized } = await import('../../exchange');
  const {
    closeStrategyPositions,
    executeStrategy,
    updateStrategy,
  } = await import('../../strategy');

  resetCycleSignalCache();

  try {
    const systems: any[] = (await db.all(
      `SELECT ts.id, ts.max_open_positions, ak.name AS api_key_name
       FROM trading_systems ts
       JOIN api_keys ak ON ak.id = ts.api_key_id
       WHERE ts.max_open_positions > 0 AND ts.is_active = 1`
    )) || [];

    // Aggregate OP/orphan checks per API key — same key can have many TS books
    // (portfolio B3+MRS). Closing orphans once avoids Bybit "position is zero" spam.
    const systemsByKey = new Map<string, Array<{ id: number; maxOpen: number }>>();
    for (const sys of systems) {
      const apiKeyName = String(sys.api_key_name || '').trim();
      const maxOpen = Number(sys.max_open_positions || 0);
      if (!apiKeyName || maxOpen <= 0) continue;
      const list = systemsByKey.get(apiKeyName) || [];
      list.push({ id: Number(sys.id), maxOpen });
      systemsByKey.set(apiKeyName, list);
    }

    for (const [apiKeyName, keySystems] of systemsByKey) {
      const systemIds = keySystems.map((s) => s.id);
      // Exchange-level ceiling = sum of per-book OPs on this key (portfolio books share wallet).
      const maxOpen = keySystems.reduce((sum, s) => sum + s.maxOpen, 0);
      const placeholders = systemIds.map(() => '?').join(',');

      const openStrategies: any[] = (await db.all(
        `SELECT s.id AS strategy_id, s.base_symbol, a.name AS api_key_name, s.updated_at, tsm.system_id
         FROM strategies s
         JOIN trading_system_members tsm ON tsm.strategy_id = s.id
         JOIN api_keys a ON a.id = s.api_key_id
         WHERE tsm.system_id IN (${placeholders}) AND tsm.is_enabled = 1
         AND s.is_active = 1 AND s.state != 'flat'
         AND COALESCE(s.strategy_type, '') NOT IN ('dca', 'dca_futures')
         ORDER BY s.updated_at ASC`,
        systemIds,
      )) || [];

      // Per-system overflow: close excess within each book
      for (const sys of keySystems) {
        const owned = openStrategies.filter((row) => Number(row.system_id) === sys.id);
        if (owned.length <= sys.maxOpen) continue;
        const excess = owned.slice(sys.maxOpen);
        logger.warn(`ОП overflow in system ${sys.id}: ${owned.length}/${sys.maxOpen}, closing ${excess.length} excess`);
        for (const ex of excess) {
          try {
            await ensureExchangeClientInitialized(ex.api_key_name);
            await closeStrategyPositions(ex.api_key_name, ex.strategy_id);
            logger.info(`ОП overflow: closed strategy ${ex.strategy_id} in system ${sys.id}`);
          } catch (closeErr) {
            logger.error(`ОП overflow: failed to close strategy ${ex.strategy_id}: ${formatActionError(closeErr)}`);
          }
        }
      }

      const ownedSymbols = new Set(
        openStrategies
          .map((row) => normalizeExchangeSymbolKey(String(row.base_symbol || '')))
          .filter(Boolean),
      );

      try {
        await ensureExchangeClientInitialized(apiKeyName);
        const exchangePositions = await getPositions(apiKeyName).catch(() => []);
        const exchangeOpen = countExchangeOpenPositions(exchangePositions);
        if (exchangeOpen > maxOpen) {
          logger.warn(
            `ОП exchange overflow on ${apiKeyName}: `
            + `exchange=${exchangeOpen} db=${openStrategies.length} limit=${maxOpen} systems=${systemIds.join(',')}`,
          );
        }
        for (const row of exchangePositions || []) {
          const size = Math.abs(Number(row?.size || 0));
          if (!Number.isFinite(size) || size <= 0) {
            continue;
          }
          const symbol = String(row?.symbol || '').trim();
          const symbolKey = normalizeExchangeSymbolKey(symbol);
          if (!symbolKey || ownedSymbols.has(symbolKey)) {
            continue;
          }
          if (isWeexDelistBlockingSymbolSync(symbolKey)) {
            if (shouldLogWeexDelistSkip(symbolKey)) {
              logger.warn(
                `ОП orphan stuck (WEEX API-delist — manual close): ${apiKeyName}/${symbol}`,
              );
            }
            continue;
          }
          logger.warn(
            `ОП orphan exchange position on ${apiKeyName}: ${symbol} (no non-flat TS owner across systems ${systemIds.join(',')}) — closing`,
          );
          try {
            await closeAllForSymbol(apiKeyName, symbol, { marketType: 'swap' });
          } catch (orphanCloseErr) {
            logger.warn(`ОП orphan close failed for ${apiKeyName} ${symbol}: ${formatActionError(orphanCloseErr)}`);
          }
        }
      } catch (orphanErr) {
        logger.warn(`ОП orphan cleanup failed for key ${apiKeyName}: ${formatActionError(orphanErr)}`);
      }
    }
  } catch (overflowErr) {
    logger.warn(`ОП overflow check failed: ${formatActionError(overflowErr)}`);
  }

  try {
    const staleRows: Array<{ strategy_id: number; api_key_name: string }> = (await db.all(
      `SELECT s.id AS strategy_id, a.name AS api_key_name
       FROM strategies s
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE s.state != 'flat'
         AND (s.is_active = 0 OR COALESCE(s.is_archived, 0) = 1 OR s.auto_update = 0)`
    )) || [];

    let closed = 0;
    for (const row of staleRows) {
      const strategyId = Number(row?.strategy_id || 0);
      const apiKeyName = String(row?.api_key_name || '').trim();
      if (!strategyId || !apiKeyName) {
        continue;
      }
      try {
        await ensureExchangeClientInitialized(apiKeyName);
        await closeStrategyPositions(apiKeyName, strategyId);
        closed += 1;
      } catch (closeErr) {
        logger.warn(
          `Auto-cycle hygiene close failed for strategy ${strategyId} (${apiKeyName}): ${formatActionError(closeErr)}`,
        );
      }
    }

    const fixRes: any = await db.run(
      `UPDATE strategies
       SET state = 'flat',
           entry_ratio = NULL,
           tp_anchor_ratio = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE state != 'flat'
         AND (is_active = 0 OR COALESCE(is_archived, 0) = 1 OR auto_update = 0)`
    );
    const fixed = Number(fixRes?.changes || 0);
    if (closed > 0 || fixed > 0) {
      logger.warn(`Auto-cycle hygiene: closed ${closed} stale exposures, reset ${fixed} orphan states to flat`);
    }
  } catch (e) {
    logger.warn(`Auto-cycle hygiene failed: ${(e as Error).message}`);
  }

  const rows = await db.all(
    `SELECT a.name AS api_key_name, s.id AS strategy_id, COALESCE(s.name, '') AS strategy_name,
            s.market_mode, s.base_symbol, s.quote_symbol, s.interval, s.strategy_type,
            s.price_channel_length, s.base_coef, s.quote_coef
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
      WHERE s.is_active = 1 AND s.auto_update = 1 AND COALESCE(s.is_archived, 0) = 0
     ORDER BY s.id ASC`
  );

  const jobs = Array.isArray(rows) ? rows : [];
  const expectedSidByApiKey = await loadExpectedAlgofundSidMap().catch(() => new Map<string, Set<string>>());
  const syncMismatchRows: any[] = [];

  const syncFilteredJobs = jobs.filter((row) => {
    const apiKeyName = String(row?.api_key_name || '');
    const expected = expectedSidByApiKey.get(apiKeyName);
    if (!expected || expected.size === 0) {
      return true;
    }
    const sid = extractSourceSid(String(row?.strategy_name || ''));
    const ok = !!sid && expected.has(sid);
    if (!ok) {
      syncMismatchRows.push(row);
    }
    return ok;
  });

  if (syncMismatchRows.length > 0) {
    for (const row of syncMismatchRows) {
      const strategyId = Number(row?.strategy_id || 0);
      const apiKeyName = String(row?.api_key_name || '');
      if (!Number.isFinite(strategyId) || strategyId <= 0 || !apiKeyName) continue;
      try {
        await db.run(
          `UPDATE strategies
           SET is_active = 0,
               is_archived = 1,
               auto_update = 0,
               last_action = 'ts_sync_mismatch_archived',
               last_error = 'strict TS-sync: strategy SID not present in published system members',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [strategyId],
        );
      } catch (e) {
        logger.warn(`TS-sync archive failed for strategy ${strategyId} (${apiKeyName}): ${(e as Error).message}`);
      }
    }
    logger.warn(`Auto-cycle TS-sync: archived ${syncMismatchRows.length} strategies not in published TS members`);
  }

  const sidDedupedJobs: any[] = [];
  const sidWinnerByApiKeySid = new Map<string, any>();
  for (const row of syncFilteredJobs) {
    const apiKeyName = String(row?.api_key_name || '');
    const strategyName = String(row?.strategy_name || '');
    const strategyId = Number(row?.strategy_id || 0);
    const sid = extractSourceSid(strategyName);
    if (!apiKeyName || !sid || !Number.isFinite(strategyId) || strategyId <= 0) {
      sidDedupedJobs.push(row);
      continue;
    }
    const key = `${apiKeyName}::SID${sid}`;
    const prev = sidWinnerByApiKeySid.get(key);
    if (!prev || Number(prev.strategy_id || 0) < strategyId) {
      sidWinnerByApiKeySid.set(key, row);
    }
  }
  const hasSid = (row: any): boolean => !!extractSourceSid(String(row?.strategy_name || ''));
  const sidWinnerIds = new Set<number>();
  for (const winner of sidWinnerByApiKeySid.values()) {
    const id = Number(winner?.strategy_id || 0);
    if (id > 0) sidWinnerIds.add(id);
  }
  for (const row of syncFilteredJobs) {
    if (!hasSid(row)) continue;
    const id = Number(row?.strategy_id || 0);
    if (sidWinnerIds.has(id)) {
      sidDedupedJobs.push(row);
    }
  }

  const dedupedJobs = sidDedupedJobs.length > 0 ? sidDedupedJobs : syncFilteredJobs;
  const skippedDuplicateSid = Math.max(0, syncFilteredJobs.length - dedupedJobs.length);
  if (skippedDuplicateSid > 0) {
    logger.warn(`Auto-cycle SID dedupe: skipped ${skippedDuplicateSid} duplicate strategy jobs in this cycle`);
  }
  let processed = 0;
  let failed = 0;
  let skippedOffline = 0;

  const validJobs = dedupedJobs.filter((row) => {
    const apiKeyName = String(row?.api_key_name || '');
    const strategyId = Number(row?.strategy_id || 0);
    return apiKeyName && Number.isFinite(strategyId) && strategyId > 0;
  });

  for (const row of validJobs) {
    const apiKeyName = String(row.api_key_name);
    try {
      await ensureExchangeClientInitialized(apiKeyName);
    } catch (initErr) {
      logger.warn(`Auto-cycle: failed to init exchange client for ${apiKeyName}: ${formatActionError(initErr)}`);
    }
  }

  const warmupJobs: MarketDataWarmupJob[] = [];

  for (const row of validJobs) {
    const apiKeyName = String(row.api_key_name);
    const exchange = getExchangeForApiKey(apiKeyName) || `key:${apiKeyName}`;
    const strategyType = normalizeStrategyType(row.strategy_type);
    if ((row.strategy_type as string) === 'periodic_buy' || (row.strategy_type as string) === 'dca' || (row.strategy_type as string) === 'dca_futures') continue;
    const signalLength = Math.max(2, Math.floor(Number(row.price_channel_length) || 50));
    const lookback = (strategyType === 'stat_arb_zscore' || strategyType === 'CT_Fractal')
      ? Math.max(signalLength + 120, 220)
      : strategyType === 'hideep'
        ? Math.max(signalLength + 110, 220)
        : Math.max(signalLength + 30, 120);

    const marketMode = normalizeMarketMode(row.market_mode);
    const baseSymbol = String(row.base_symbol || '').trim().toUpperCase();
    const quoteSymbol = String(row.quote_symbol || '').trim().toUpperCase();
    const interval = String(row.interval || '').trim();

    if (!baseSymbol || !interval) {
      continue;
    }

    const symbolsToWarm: { symbol: string; limit: number }[] = [{ symbol: baseSymbol, limit: lookback }];
    if (marketMode !== 'mono' && quoteSymbol && quoteSymbol !== baseSymbol) {
      symbolsToWarm.push({ symbol: quoteSymbol, limit: lookback });
    }

    for (const { symbol, limit } of symbolsToWarm) {
      warmupJobs.push({
        exchange,
        apiKeyName,
        symbol,
        interval,
        limit,
      });
    }
  }

  if (warmupJobs.length > 0) {
    const warmed = await warmMarketDataCache(warmupJobs);
    logger.info(`Auto-cycle: warmed candle cache for ${warmed} exchange-scoped symbol combos (from ${warmupJobs.length} leg requests)`);
  }

  const executeOne = async (row: any): Promise<void> => {
    const apiKeyName = String(row.api_key_name);
    const strategyId = Number(row.strategy_id);
    const strategyName = String(row?.strategy_name || '');
    const strategyType = String(row.strategy_type || '');

    try {
      if (strategyType === 'periodic_buy') {
        const { executePeriodicBuy } = await import('../../periodicBuy');
        await executePeriodicBuy(apiKeyName, strategyId);
        processed += 1;
        return;
      }
      if (strategyType === 'dca') {
        const { executeDca } = await import('../../dca');
        await executeDca(apiKeyName, strategyId);
        processed += 1;
        return;
      }
      if (strategyType === 'dca_futures') {
        const { executeDcaFutures } = await import('../../dca-futures');
        await executeDcaFutures(apiKeyName, strategyId);
        processed += 1;
        return;
      }
      await executeStrategy(apiKeyName, strategyId, {
        source: 'auto',
        closedBarOnly: true,
        dedupeClosedBar: true,
      });
      processed += 1;
    } catch (error) {
      const errorText = formatActionError(error);
      const lower = errorText.toLowerCase();
      const isPairPermissionDenied = lower.includes('no permission for this trading pair');
      const pairMatch = errorText.match(/\b([A-Z]{2,}USDT)\b/);
      const deniedPair = String(pairMatch?.[1] || '').toUpperCase();

      if (isPairPermissionDenied) {
        failed += 1;
        logger.error(`Auto-cycle strategy ${strategyId} (${apiKeyName}) blocked by pair permission: ${deniedPair || '-'} (${errorText})`);
        try {
          await updateStrategy(apiKeyName, strategyId, {
            is_active: false,
            auto_update: false,
            state: 'flat',
            last_action: 'auto_disabled_pair_permission_denied',
            last_error: errorText,
          });
        } catch (persistError) {
          logger.warn(
            `Auto-cycle strategy ${strategyId} (${apiKeyName}) failed to persist pair-permission disable: ${formatActionError(persistError)}`
          );
        }

        try {
          await db.run(
            `INSERT INTO strategy_runtime_events
               (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
             VALUES (?, ?, ?, 'pair_permission_block', ?, ?, 0, ?)`,
            [
              apiKeyName,
              strategyId,
              strategyName,
              errorText,
              JSON.stringify({ pair: deniedPair || null, policy: 'auto_disable_strategy' }),
              Date.now(),
            ]
          );
        } catch {
          // Non-critical
        }
        return;
      }

      if (isOfflineSymbolMarketDataError(errorText)) {
        skippedOffline += 1;
        if (shouldLogOfflineSymbolSkip(apiKeyName, strategyId)) {
          logger.warn(`Auto-cycle strategy ${strategyId} (${apiKeyName}) skipped: offline symbol on exchange (${errorText})`);
        }

        // Ghost-delist / copy-blocked / Contract not found: do not leave is_active=1 zombies
        // (remat only filters allowlist membership; cycle previously only skipped forever).
        const hardOffline = /contract not found|market symbol offline|not supported via the api|code["']?\s*[:=]\s*-?1054/i
          .test(errorText);
        try {
          if (hardOffline) {
            await db.run(
              `UPDATE strategies
               SET is_active = 0,
                   is_archived = 1,
                   auto_update = 0,
                   is_runtime = 0,
                   last_action = 'offline_symbol_archived',
                   last_error = ?,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND COALESCE(is_archived, 0) = 0`,
              [errorText.slice(0, 500), strategyId],
            );
            logger.warn(`Auto-cycle strategy ${strategyId} (${apiKeyName}) archived: hard offline symbol`);
          } else {
            await updateStrategy(apiKeyName, strategyId, {
              last_action: 'auto_cycle_skipped_offline_symbol',
              last_error: errorText,
            });
          }
        } catch (persistError) {
          logger.warn(
            `Auto-cycle strategy ${strategyId} (${apiKeyName}) failed to persist offline-skip state: ${formatActionError(persistError)}`
          );
        }
        return;
      }

      failed += 1;
      logger.warn(`Auto-cycle strategy ${strategyId} (${apiKeyName}) failed: ${errorText}`);
      const isLowLot = errorText.toLowerCase().includes('order size too small');

      try {
        await updateStrategy(apiKeyName, strategyId, {
          last_action: 'auto_cycle_failed',
          last_error: errorText,
        });
      } catch (persistError) {
        logger.warn(
          `Auto-cycle strategy ${strategyId} (${apiKeyName}) failed to persist error: ${formatActionError(persistError)}`
        );
      }

      if (isLowLot) {
        try {
          await db.run(
            `INSERT INTO strategy_runtime_events
               (api_key_name, strategy_id, strategy_name, event_type, message, resolved_at, created_at)
             VALUES (?, ?, ?, 'low_lot_error', ?, 0, ?)`,
            [apiKeyName, strategyId, strategyName, errorText, Date.now()]
          );
        } catch {
          // Non-critical
        }
      }
    }
  };

  const cycleConcurrency = resolveCycleConcurrency(validJobs.length);
  if (validJobs.length > cycleConcurrency) {
    logger.info(
      `Auto-cycle concurrency cap: ${cycleConcurrency}/${validJobs.length} `
      + `(STRATEGY_CYCLE_CONCURRENCY=${String(process.env.STRATEGY_CYCLE_CONCURRENCY ?? '16')})`,
    );
  }
  await mapSettledWithConcurrency(validJobs, cycleConcurrency, executeOne);

  return {
    total: syncFilteredJobs.length,
    processed,
    failed,
    skippedOffline,
    concurrency: cycleConcurrency,
  };
};

import { db } from '../utils/database';
import logger from '../utils/logger';
import {
  cancelAllOrders,
  closePosition,
  ensureExchangeClientInitialized,
  getPositions,
  invalidatePositionCache,
} from './exchange';
import {
  createWeexClient,
  getWeexApiTradingSymbolsStrict,
  toWeexOrderSymbol,
} from './weexClient';
import {
  isWeexCopyLikeKey,
  isWeexStockSymbol,
  normalizeWeexSymbolKey,
  WEEX_COPY_STOCK_SYMBOL,
  WEEX_STOCK_SYMBOLS,
} from './weexKeyUtils';
import { filterPollableApiKeyNames, loadPollableApiKeyNames } from './apiKeyPollGate';
import {
  loadWeexDelistState,
  saveWeexDelistState,
  refreshWeexDelistStateCache,
  setWeexDelistStateCache,
  type WeexDelistStateDoc,
  type WeexDelistSymbolState,
} from './weexDelistState';
import { notifyAdminUrgent } from '../notifications/adminTelegramReporter';

const POLL_MS = Math.max(
  300_000,
  Math.floor(Number(process.env.WEEX_DELIST_POLL_SEC || 600) || 600) * 1000,
);
const CONFIRM_MISSES = Math.max(2, Math.floor(Number(process.env.WEEX_DELIST_CONFIRM_MISSES || 3) || 3));
const CONFIRM_WINDOW_MS = Math.max(
  900_000,
  Math.floor(Number(process.env.WEEX_DELIST_CONFIRM_WINDOW_SEC || 2700) || 2700) * 1000,
);
const MIN_ALLOWLIST = Math.max(50, Math.floor(Number(process.env.WEEX_DELIST_MIN_ALLOWLIST || 200) || 200));
const DRY_RUN = process.env.WEEX_DELIST_DRY_RUN === '1';
const COPY_STOCK_HEALTH_MS = Math.max(
  3_600_000,
  Math.floor(Number(process.env.WEEX_COPY_STOCK_HEALTH_SEC || 21_600) || 21_600) * 1000,
);

let watchdogRunning = false;
let lastCopyStockHealthAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isWeexApiPermissionDenied = (error: unknown): boolean => {
  const text = String((error as Error)?.message || error || '');
  if (/stepSize|min limit|minOrder|order price must|order size|FAILED_PRECONDITION|INVALID_ARGUMENT/i.test(text)) {
    return false;
  }
  return /code["']?\s*[:=]\s*-?1058/i.test(text)
    || /not supported via the API/i.test(text)
    || /apiTradingSymbols/i.test(text);
};

const loadWatchedSymbols = async (): Promise<Set<string>> => {
  const out = new Set<string>();
  const rows = await db.all(`
    SELECT DISTINCT COALESCE(s.base_symbol, '') AS sym
    FROM strategies s
    JOIN api_keys a ON a.id = s.api_key_id
    WHERE a.exchange = 'weex'
      AND COALESCE(s.is_archived, 0) = 0
      AND COALESCE(s.is_active, 0) = 1
      AND TRIM(COALESCE(s.base_symbol, '')) != ''
  `) || [];
  for (const row of rows) {
    const sym = normalizeWeexSymbolKey(String(row?.sym || ''));
    if (sym) out.add(sym);
  }

  // Only poll live WEEX keys (skip is_enabled=0 and keys_invalid cabinets).
  const keyNames = await loadPollableApiKeyNames({ exchange: 'weex' });
  for (const name of keyNames) {
    try {
      await ensureExchangeClientInitialized(name);
      const positions = await getPositions(name).catch(() => []);
      for (const p of positions || []) {
        const size = Math.abs(Number(p?.size || p?.contracts || p?.positionAmt || 0));
        if (size <= 0) continue;
        const sym = normalizeWeexSymbolKey(String(p?.symbol || ''));
        if (sym) out.add(sym);
      }
    } catch {
      // ignore auth-dead keys
    }
  }
  return out;
};

const archiveWeexSymbolStrategies = async (symbol: string): Promise<number> => {
  const sym = normalizeWeexSymbolKey(symbol);
  const rows = await db.all(`
    SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.market_mode, s.state, a.name AS api_key_name
    FROM strategies s
    JOIN api_keys a ON a.id = s.api_key_id
    WHERE a.exchange = 'weex'
      AND COALESCE(s.is_archived, 0) = 0
      AND (
        UPPER(REPLACE(REPLACE(COALESCE(s.base_symbol, ''), '/', ''), '-', '')) = ?
        OR UPPER(REPLACE(REPLACE(COALESCE(s.quote_symbol, ''), '/', ''), '-', '')) = ?
      )
  `, [sym, sym]) || [];

  let archived = 0;
  for (const row of rows) {
    const strategyId = Number(row?.id || 0);
    const apiKeyName = String(row?.api_key_name || '').trim();
    if (!strategyId || !apiKeyName) continue;
    if (DRY_RUN) {
      archived += 1;
      continue;
    }
    try {
      await ensureExchangeClientInitialized(apiKeyName);
      await cancelAllOrders(apiKeyName).catch(() => {});
    } catch {
      // continue archive even if cancel fails
    }
    await db.run(
      `UPDATE strategies
       SET is_active = 0,
           is_runtime = 0,
           is_archived = 1,
           auto_update = 0,
           state = 'flat',
           origin = COALESCE(origin, 'weex_delist'),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [strategyId],
    );
    archived += 1;
  }
  return archived;
};

const attemptEmergencyClose = async (symbol: string): Promise<{ openKeys: string[]; stuckKeys: string[] }> => {
  const sym = normalizeWeexSymbolKey(symbol);
  const openKeys: string[] = [];
  const stuckKeys: string[] = [];
  const keyNames = await loadPollableApiKeyNames({ exchange: 'weex' });

  for (const apiKeyName of keyNames) {
    try {
      await ensureExchangeClientInitialized(apiKeyName);
      const positions = await getPositions(apiKeyName).catch(() => []);
      const match = (positions || []).find((p) => {
        const size = Math.abs(Number(p?.size || p?.contracts || p?.positionAmt || 0));
        return size > 0 && normalizeWeexSymbolKey(String(p?.symbol || '')) === sym;
      });
      if (!match) continue;
      openKeys.push(apiKeyName);
      if (DRY_RUN) continue;

      const size = Math.abs(Number(match.size || match.contracts || match.positionAmt || 0));
      const sideRaw = String(match.side || match.positionSide || '').toLowerCase();
      const isShort = sideRaw.includes('sell') || sideRaw.includes('short');
      const closeSide = isShort ? 'buy' : 'sell';

      let closed = false;
      try {
        const keyRow = await db.get('SELECT * FROM api_keys WHERE name = ?', [apiKeyName]);
        if (keyRow) {
          const weex = createWeexClient(keyRow);
          await weex.createOrder(toWeexOrderSymbol(sym), 'market', closeSide, size, undefined, { reduceOnly: true });
          closed = true;
        }
      } catch (e1) {
        if (!isWeexApiPermissionDenied(e1)) {
          try {
            await closePosition(
              apiKeyName,
              sym,
              String(size),
              isShort ? 'Sell' : 'Buy',
              { marketType: 'swap' },
            );
            closed = true;
          } catch {
            /* fall through */
          }
        }
      }
      if (!closed) stuckKeys.push(apiKeyName);
      invalidatePositionCache(apiKeyName);
      await sleep(400);
    } catch {
      /* ignore per-key errors */
    }
  }
  return { openKeys, stuckKeys };
};

const pushMiss = (st: WeexDelistSymbolState, now: number): WeexDelistSymbolState => {
  const prev = Array.isArray(st.missTimestamps) ? st.missTimestamps : [];
  const missTimestamps = [...prev, now].filter((t) => now - t <= CONFIRM_WINDOW_MS);
  return { ...st, phase: 'watching', missTimestamps, lastSeenAt: st.lastSeenAt };
};

const confirmCount = (st: WeexDelistSymbolState, now: number): number =>
  (Array.isArray(st.missTimestamps) ? st.missTimestamps : []).filter((t) => now - t <= CONFIRM_WINDOW_MS).length;

const maybeAlert = async (
  level: 'warn' | 'critical',
  symbol: string,
  text: string,
  st: WeexDelistSymbolState,
): Promise<WeexDelistSymbolState> => {
  const now = Date.now();
  const cooldownMs = level === 'critical' ? 6 * 3600_000 : 24 * 3600_000;
  const last = level === 'critical' ? st.criticalAlertAt : st.warnAlertAt;
  if (last && now - last < cooldownMs) return st;
  if (!DRY_RUN) await notifyAdminUrgent(text);
  return level === 'critical'
    ? { ...st, criticalAlertAt: now }
    : { ...st, warnAlertAt: now };
};

const runCopyStockHealthProbe = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastCopyStockHealthAt < COPY_STOCK_HEALTH_MS) return;
  lastCopyStockHealthAt = now;

  // Copy-like WEEX keys only — skip disabled / keys_invalid.
  const rawCopyKeys = await db.all(`
    SELECT name FROM api_keys
    WHERE exchange = 'weex'
      AND COALESCE(is_enabled, 1) = 1
      AND (LOWER(name) LIKE 'copy_%' OR LOWER(name) LIKE 'arcopy%' OR LOWER(name) LIKE 'icopy%')
  `) || [];
  const copyKeyNames = await filterPollableApiKeyNames(
    rawCopyKeys.map((row: any) => String(row?.name || '').trim()).filter(Boolean),
  );
  if (!copyKeyNames.length) return;

  const summary: Record<string, string> = {};
  const deadSyms: string[] = [];
  for (const apiKeyName of copyKeyNames) {
    try {
      await ensureExchangeClientInitialized(apiKeyName);
      const keyRow = await db.get('SELECT * FROM api_keys WHERE name = ?', [apiKeyName]);
      if (!keyRow) continue;
      const weex = createWeexClient(keyRow);
      for (const sym of WEEX_STOCK_SYMBOLS) {
        if (sym === WEEX_COPY_STOCK_SYMBOL) continue;
        try {
          await weex.createOrder(sym, 'market', 'buy', 1e-8, undefined, {});
          summary[sym] = 'unexpected_open';
        } catch (e) {
          const msg = String((e as Error).message || e);
          if (/Contract not found/i.test(msg)) {
            summary[sym] = 'copy_dead';
            deadSyms.push(sym);
          } else if (/min limit|Trader order size/i.test(msg)) summary[sym] = 'ok_min';
          else if (/not supported via the API|-1058/i.test(msg)) summary[sym] = 'not_api';
          else summary[sym] = 'other';
        }
      }
    } catch {
      summary._key = 'init_fail';
    }
    break; // one representative copy key is enough
  }
  // Soft-archive stock legs that are dead for copy (and personal keys sharing the contract).
  for (const sym of [...new Set(deadSyms)]) {
    if (DRY_RUN) continue;
    try {
      const n = await archiveWeexSymbolStrategies(sym);
      if (n > 0) summary[`${sym}_archived`] = String(n);
    } catch (e) {
      logger.warn(`[weex-copy-stocks] archive ${sym} failed: ${(e as Error).message}`);
    }
  }
  logger.info(`[weex-copy-stocks] health ${JSON.stringify(summary)}`);
};

export const runWeexDelistWatchdog = async (): Promise<void> => {
  if (watchdogRunning) return;
  watchdogRunning = true;
  try {
    const snap = await getWeexApiTradingSymbolsStrict(true, MIN_ALLOWLIST);
    if (!snap.ok) {
      logger.debug(`[weex-delist] allowlist fetch skipped: ${snap.error}`);
      await runCopyStockHealthProbe();
      return;
    }

    const watched = await loadWatchedSymbols();
    const stateDoc = await loadWeexDelistState();
    const now = Date.now();
    let changed = false;

    for (const sym of watched) {
      const prev = stateDoc.symbols[sym] || { phase: 'idle' as const };
      if (prev.phase === 'confirmed' || prev.phase === 'stuck') {
        if (!prev.stuckAt) {
          const { stuckKeys } = await attemptEmergencyClose(sym);
          if (stuckKeys.length) {
            stateDoc.symbols[sym] = {
              ...prev,
              phase: 'stuck',
              stuckAt: prev.stuckAt || now,
            };
            changed = true;
            const text = [
              '🚨 CRITICAL WEEX unclosable after API-delist',
              `symbol: ${sym}`,
              `keys: ${stuckKeys.join(', ')}`,
              'strategies archived; manual / venue UI close required',
            ].join('\n');
            stateDoc.symbols[sym] = await maybeAlert('critical', sym, text, stateDoc.symbols[sym]);
            changed = true;
          }
        }
        continue;
      }

      if (snap.symbols.has(sym)) {
        if (prev.phase !== 'idle') {
          stateDoc.symbols[sym] = { phase: 'idle', lastSeenAt: now };
          changed = true;
        }
        continue;
      }

      let next = pushMiss(prev, now);
      if (confirmCount(next, now) < CONFIRM_MISSES) {
        stateDoc.symbols[sym] = next;
        changed = true;
        continue;
      }

      // Confirmed global API-delist
      const archived = await archiveWeexSymbolStrategies(sym);
      const { openKeys, stuckKeys } = await attemptEmergencyClose(sym);
      next = {
        ...next,
        phase: stuckKeys.length ? 'stuck' : 'confirmed',
        confirmedAt: now,
        stuckAt: stuckKeys.length ? now : undefined,
        strategiesArchived: archived,
      };
      const warnText = [
        '⚠️ WEEX API-DELIST confirmed',
        `symbol: ${sym}`,
        `signal: apiTradingSymbols miss ×${CONFIRM_MISSES}`,
        `strategies archived: ${archived}`,
        `open keys: ${openKeys.length ? openKeys.join(', ') : 'none'}`,
        stuckKeys.length ? `stuck keys: ${stuckKeys.join(', ')}` : 'close: attempted',
        DRY_RUN ? '(dry-run)' : '',
      ].filter(Boolean).join('\n');
      next = await maybeAlert(stuckKeys.length ? 'critical' : 'warn', sym, warnText, next);
      stateDoc.symbols[sym] = next;
      changed = true;
      logger.warn(`[weex-delist] confirmed ${sym} archived=${archived} stuck=${stuckKeys.length}`);
    }

    if (changed) await saveWeexDelistState(stateDoc);
    else setWeexDelistStateCache(stateDoc);
    await runCopyStockHealthProbe();
  } catch (error) {
    logger.error(`[weex-delist] watchdog error: ${(error as Error).message}`);
  } finally {
    watchdogRunning = false;
  }
};

export const startWeexDelistWatchdog = async (): Promise<void> => {
  await refreshWeexDelistStateCache();
  const enabled = process.env.WEEX_DELIST_ENABLED !== '0';
  if (!enabled) {
    logger.info('[weex-delist] watchdog disabled (WEEX_DELIST_ENABLED=0)');
    return;
  }
  logger.info(
    `[weex-delist] watchdog on poll=${POLL_MS / 1000}s confirm=${CONFIRM_MISSES}/${CONFIRM_WINDOW_MS / 1000}s dry=${DRY_RUN}`,
  );
  setTimeout(() => { runWeexDelistWatchdog().catch(() => {}); }, 15_000);
  setInterval(() => { runWeexDelistWatchdog().catch(() => {}); }, POLL_MS);
};

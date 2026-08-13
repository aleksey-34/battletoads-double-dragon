import { db } from '../utils/database';
import logger from '../utils/logger';
import {
  FearBoostConfig,
  DailyClose,
  DEFAULT_FEAR_BOOST,
  computeFearUnionActiveDates,
  dateToUtcDayStartMs,
  lotMultiplierForFearDay,
  parseFearBoost,
} from '../services/fearBoost';

const CONFIG_TTL_MS = 60_000;
const SERIES_TTL_MS = 30 * 60_000;
const FLAG_KEY = 'fear_boost_macro_cache';

type SeriesCache = {
  btc: DailyClose[];
  spx: DailyClose[];
  vix: DailyClose[];
  activeDayStartsMs: Set<number>;
  loadedAt: number;
};

const configCache = new Map<string, { config: FearBoostConfig | null; loadedAt: number }>();
let seriesCache: SeriesCache | null = null;
let seriesInflight: Promise<SeriesCache | null> | null = null;

const loadPublishedSystemName = async (apiKeyName: string): Promise<string> => {
  const row = await db.get<{ published_system_name?: string }>(
    `SELECT published_system_name FROM algofund_profiles
     WHERE COALESCE(execution_api_key_name, assigned_api_key_name) = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [apiKeyName],
  );
  return String(row?.published_system_name || '').trim();
};

const parseMeta = (raw: string | undefined): Record<string, unknown> => {
  try {
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const configFromMeta = (meta: Record<string, unknown>): FearBoostConfig | null => {
  const explicit = parseFearBoost(meta.fearBoost);
  if (explicit) return explicit;
  if (meta.pack === 'hamfive_aug2026' || meta.tierCbOnZzBreakout === true) {
    return { ...DEFAULT_FEAR_BOOST, enabled: true };
  }
  return null;
};

const loadConfigFromCardCode = async (code: string): Promise<FearBoostConfig | null> => {
  const row = await db.get<{ metadata_json?: string }>(
    'SELECT metadata_json FROM master_cards WHERE code = ? AND is_active = 1',
    [code],
  );
  if (!row?.metadata_json) return null;
  return configFromMeta(parseMeta(row.metadata_json));
};

const loadConfigForApiKey = async (apiKeyName: string): Promise<FearBoostConfig | null> => {
  const key = String(apiKeyName || '').trim();
  if (!key) return null;
  const cached = configCache.get(key);
  const now = Date.now();
  if (cached && now - cached.loadedAt < CONFIG_TTL_MS) {
    return cached.config;
  }
  let config: FearBoostConfig | null = null;
  const systemName = await loadPublishedSystemName(key);
  if (systemName) {
    config = await loadConfigFromCardCode(`CARD::${systemName.toUpperCase()}`);
  }
  if (!config) {
    const packRow = await db.get<{ metadata_json?: string }>(
      `SELECT mc.metadata_json FROM algofund_profiles ap
       JOIN algofund_active_portfolios aap ON aap.profile_id = ap.id AND COALESCE(aap.is_enabled,1)=1
       JOIN algofund_portfolio_members m ON m.portfolio_id = aap.portfolio_id AND COALESCE(m.is_enabled,1)=1
       JOIN master_cards mc ON mc.code = ('CARD::' || UPPER(m.system_name)) AND mc.is_active = 1
       WHERE COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name) = ?
       ORDER BY CASE WHEN m.role = 'b3' THEN 0 ELSE 1 END, m.sort_order ASC
       LIMIT 1`,
      [key],
    ).catch(() => null);
    if (packRow?.metadata_json) {
      config = configFromMeta(parseMeta(packRow.metadata_json));
    }
  }
  configCache.set(key, { config, loadedAt: now });
  return config;
};

const fetchText = async (url: string, timeoutMs = 8000): Promise<string> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'btdd-fear-boost/1.0' },
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
};

const parseStooqCsv = (csv: string): DailyClose[] => {
  const lines = String(csv || '').trim().split(/\r?\n/);
  const out: DailyClose[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(',');
    const date = String(parts[0] || '').trim();
    const close = Number(parts[4]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0) {
      out.push({ date, close });
    }
  }
  return out;
};

const fetchBinanceBtcDaily = async (): Promise<DailyClose[]> => {
  const raw = await fetchText(
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30',
  );
  const rows = JSON.parse(raw) as Array<[number, string, string, string, string]>;
  if (!Array.isArray(rows)) return [];
  const now = Date.now();
  const out: DailyClose[] = [];
  for (const row of rows) {
    const openMs = Number(row[0]);
    const close = Number(row[4]);
    if (!Number.isFinite(openMs) || !Number.isFinite(close) || close <= 0) continue;
    // Skip in-progress daily bar (open + 1d > now).
    if (openMs + 86_400_000 > now) continue;
    const d = new Date(openMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    out.push({ date: `${y}-${m}-${day}`, close });
  }
  return out;
};

const loadPersistedSeries = async (): Promise<SeriesCache | null> => {
  try {
    const row = await db.get<{ value?: string }>(
      'SELECT value FROM app_runtime_flags WHERE key = ?',
      [FLAG_KEY],
    );
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as {
      btc?: DailyClose[];
      spx?: DailyClose[];
      vix?: DailyClose[];
      loadedAt?: number;
    };
    const btc = Array.isArray(parsed.btc) ? parsed.btc : [];
    const spx = Array.isArray(parsed.spx) ? parsed.spx : [];
    const vix = Array.isArray(parsed.vix) ? parsed.vix : [];
    if (!btc.length) return null;
    const { active } = computeFearUnionActiveDates(btc, spx, vix);
    return {
      btc,
      spx,
      vix,
      activeDayStartsMs: new Set(active.map(dateToUtcDayStartMs).filter((n) => n > 0)),
      loadedAt: Number(parsed.loadedAt) || 0,
    };
  } catch {
    return null;
  }
};

const persistSeries = async (cache: SeriesCache): Promise<void> => {
  try {
    await db.run(
      `INSERT INTO app_runtime_flags (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [FLAG_KEY, JSON.stringify({
        btc: cache.btc,
        spx: cache.spx,
        vix: cache.vix,
        loadedAt: cache.loadedAt,
      })],
    );
  } catch {
    // non-critical
  }
};

const refreshSeries = async (): Promise<SeriesCache | null> => {
  const btc = await fetchBinanceBtcDaily().catch((err) => {
    logger.warn(`[fearBoost] BTC daily fetch failed: ${String(err?.message || err)}`);
    return [] as DailyClose[];
  });
  const spx = await fetchText('https://stooq.com/q/d/l/?s=^spx&i=d').then(parseStooqCsv).catch((err) => {
    logger.warn(`[fearBoost] SPX fetch failed: ${String(err?.message || err)}`);
    return [] as DailyClose[];
  });
  const vix = await fetchText('https://stooq.com/q/d/l/?s=^vix&i=d').then(parseStooqCsv).catch((err) => {
    logger.warn(`[fearBoost] VIX fetch failed: ${String(err?.message || err)}`);
    return [] as DailyClose[];
  });
  if (!btc.length) {
    return loadPersistedSeries();
  }
  const { active } = computeFearUnionActiveDates(btc, spx, vix);
  const cache: SeriesCache = {
    btc,
    spx,
    vix,
    activeDayStartsMs: new Set(active.map(dateToUtcDayStartMs).filter((n) => n > 0)),
    loadedAt: Date.now(),
  };
  if (!spx.length || !vix.length) {
    logger.warn(`[fearBoost] degraded union: btc=${btc.length} spx=${spx.length} vix=${vix.length}`);
  }
  await persistSeries(cache);
  return cache;
};

const getSeries = async (): Promise<SeriesCache | null> => {
  const now = Date.now();
  if (seriesCache && now - seriesCache.loadedAt < SERIES_TTL_MS) {
    return seriesCache;
  }
  if (!seriesInflight) {
    seriesInflight = refreshSeries()
      .then((c) => {
        if (c) seriesCache = c;
        return c;
      })
      .finally(() => {
        seriesInflight = null;
      });
  }
  const fresh = await seriesInflight;
  if (fresh) return fresh;
  if (seriesCache) return seriesCache;
  return loadPersistedSeries();
};

export const resolveFearBoostLotMultiplier = async (
  apiKeyName: string,
  strategyType?: string,
  timeMs: number = Date.now(),
): Promise<number> => {
  const config = await loadConfigForApiKey(apiKeyName);
  if (!config || config.enabled === false) return 1;
  const series = await getSeries();
  if (!series || series.activeDayStartsMs.size === 0) return 1;
  return lotMultiplierForFearDay(
    config,
    String(strategyType || ''),
    timeMs,
    series.activeDayStartsMs,
  );
};

export const invalidateFearBoostCache = (apiKeyName?: string): void => {
  if (apiKeyName) {
    configCache.delete(String(apiKeyName || '').trim());
    return;
  }
  configCache.clear();
  seriesCache = null;
};

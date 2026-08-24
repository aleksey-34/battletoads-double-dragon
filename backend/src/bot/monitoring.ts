import { fetchExchangeEquityHistory, fetchExchangeFillsHistory, getBalances, getPositions } from './exchange';
import { db as mainDb } from '../utils/database';
import { getMonitoringDb } from '../monitoring/db';
import logger from '../utils/logger';

/** Monitoring history DB (monitoring.db). API keys stay in mainDb. */
const mdb = () => getMonitoringDb();

const toFiniteNumber = (value: any, fallback: number = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const getPositionNotionalUsd = (position: any): number => {
  const positionValue = Math.abs(toFiniteNumber(position?.positionValue, NaN));
  if (Number.isFinite(positionValue) && positionValue > 0) {
    return positionValue;
  }

  const size = Math.abs(toFiniteNumber(position?.size, NaN));
  const markPrice = toFiniteNumber(position?.markPrice, NaN);
  const avgPrice = toFiniteNumber(position?.avgPrice, NaN);
  const price = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : avgPrice;

  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return 0;
  }

  return size * price;
};

const calculateMetrics = (balances: any[], positions: any[]) => {
  const safeBalances = Array.isArray(balances) ? balances : [];
  const safePositions = Array.isArray(positions) ? positions : [];

  const equityUsd = safeBalances.reduce((sum, balance) => {
    const usdValue = toFiniteNumber(balance?.usdValue, NaN);
    if (Number.isFinite(usdValue) && usdValue > 0) {
      return sum + usdValue;
    }

    const coin = String(balance?.coin || '').toUpperCase();
    const walletBalance = toFiniteNumber(balance?.walletBalance, NaN);
    if ((coin === 'USDT' || coin === 'USDC' || coin === 'USD') && Number.isFinite(walletBalance) && walletBalance > 0) {
      return sum + walletBalance;
    }

    return sum;
  }, 0);

  let notionalUsd = 0;
  let marginUsedUsd = 0;
  let unrealizedPnl = 0;

  for (const position of safePositions) {
    const notional = getPositionNotionalUsd(position);
    if (Number.isFinite(notional) && notional > 0) {
      const leverage = Math.max(1, toFiniteNumber(position?.leverage, 1));
      notionalUsd += notional;
      marginUsedUsd += notional / leverage;
    }

    const pnl = toFiniteNumber(position?.unrealisedPnl, NaN);
    if (Number.isFinite(pnl)) {
      unrealizedPnl += pnl;
    }
  }

  const effectiveLeverage = equityUsd > 0 ? notionalUsd / equityUsd : 0;
  const marginLoadPercent = equityUsd > 0 ? (marginUsedUsd / equityUsd) * 100 : 0;

  return {
    equityUsd,
    unrealizedPnl,
    marginUsedUsd,
    marginLoadPercent,
    effectiveLeverage,
    notionalUsd,
  };
};

const getApiKeyRow = async (apiKeyName: string): Promise<{ id: number; exchange: string; name: string }> => {
  const row = await mainDb.get('SELECT id, exchange, name FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!row) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }

  return {
    id: Number(row.id),
    exchange: String(row.exchange || ''),
    name: String(row.name || apiKeyName),
  };
};

export const recordMonitoringSnapshot = async (apiKeyName: string) => {
  const key = await getApiKeyRow(apiKeyName);

  // Fetch balances and positions with error tolerance
  // For WEEX: use sequential calls to avoid hitting the strict rate limit
  let balances = [];
  let positions = [];
  try {
    const isWeex = key.exchange.toLowerCase().includes('weex');
    if (isWeex) {
      balances = await getBalances(apiKeyName).catch(e => {
        const errMsg = (e as Error)?.message || String(e);
        if (!errMsg.includes('Client not initialized')) {
          console.warn(`[monitoring] getBalances ${apiKeyName} failed: ${errMsg}`);
        }
        return [];
      });
      positions = await getPositions(apiKeyName).catch(e => {
        const errMsg = (e as Error)?.message || String(e);
        if (!errMsg.includes('Client not initialized')) {
          console.warn(`[monitoring] getPositions ${apiKeyName} failed: ${errMsg}`);
        }
        return [];
      });
    } else {
      [balances, positions] = await Promise.all([
        getBalances(apiKeyName).catch(e => {
          const errMsg = (e as Error)?.message || String(e);
          if (!errMsg.includes('Client not initialized')) {
            console.warn(`[monitoring] getBalances ${apiKeyName} failed: ${errMsg}`);
          }
          return [];
        }),
        getPositions(apiKeyName).catch(e => {
          const errMsg = (e as Error)?.message || String(e);
          if (!errMsg.includes('Client not initialized')) {
            console.warn(`[monitoring] getPositions ${apiKeyName} failed: ${errMsg}`);
          }
          return [];
        }),
      ]);
    }
  } catch (e) {
    console.error(`[monitoring] Snapshot collection failed for ${apiKeyName}: ${(e as Error)?.message}`);
    return null; // Skip recording if both fail
  }

  const metrics = calculateMetrics(balances, positions);

  // Skip recording if balance fetch returned nothing — avoids false zero-equity spike in chart
  if (metrics.equityUsd === 0 && (balances as unknown[]).length === 0) {
    console.warn(`[monitoring] Skipping snapshot for ${apiKeyName}: balance empty (fetch may have failed)`);
    return null;
  }

  // Skip recording if equity is zero even though balances were returned —
  // this catches edge cases where the API returns empty asset list transiently
  if (metrics.equityUsd <= 0) {
    console.warn(`[monitoring] Skipping snapshot for ${apiKeyName}: equity_usd=${metrics.equityUsd} (anomalous zero, skip to avoid chart spike)`);
    return null;
  }

  // Detect anomalous peaks: filter peaks older than 30 days or unrealistically high (>1.5x current equity)
  // This prevents drawdown from being inflated by initialization bugs or temporary spikes
  const peakRow = await mdb().get(
    `SELECT MAX(equity_usd) AS max_equity, MAX(recorded_at) AS peak_time 
     FROM monitoring_snapshots 
     WHERE api_key_id = ? AND datetime(recorded_at) >= datetime('now', '-30 days')`,
    [key.id]
  );
  
  // Use peak from last 30 days, but filter unrealistic highs (anomalies > 1.5x current equity)
  let peakEquity = toFiniteNumber(peakRow?.max_equity, 0);
  const anomalyThreshold = metrics.equityUsd * 1.5;
  if (peakEquity > anomalyThreshold) {
    // If peak looks anomalous, fall back to 90-day median peak or just use current equity
    const medianPeakRow = await mdb().get(
      `SELECT (
        SELECT equity_usd FROM monitoring_snapshots 
        WHERE api_key_id = ? AND datetime(recorded_at) >= datetime('now', '-90 days')
        ORDER BY equity_usd DESC LIMIT 1 OFFSET (
          SELECT COUNT(*)/2 FROM monitoring_snapshots 
          WHERE api_key_id = ? AND datetime(recorded_at) >= datetime('now', '-90 days')
        )
      ) AS median_peak`,
      [key.id, key.id]
    );
    const medianPeak = toFiniteNumber(medianPeakRow?.median_peak, 0);
    // Use median if it exists and is reasonable, otherwise use current equity as peak
    peakEquity = medianPeak > 0 && medianPeak <= metrics.equityUsd * 1.2 ? medianPeak : metrics.equityUsd;
  }
  
  peakEquity = Math.max(peakEquity, metrics.equityUsd);
  const drawdownPercent = peakEquity > 0
    ? Math.max(0, ((peakEquity - metrics.equityUsd) / peakEquity) * 100)
    : 0;

  // PnL tracking: compute net PnL vs initial deposit.
  // deposit_base_usd = first-ever equity recorded for this account (proxy for starting capital).
  // pnl_net_usd = current equity − unrealized_pnl − deposit_base_usd
  //   → represents cumulative realized PnL since account start, excluding open position unrealized gains.
  // Migration: add columns if not yet present (idempotent, fails silently if already exists).
  try {
    await mdb().exec('ALTER TABLE monitoring_snapshots ADD COLUMN deposit_base_usd REAL DEFAULT NULL');
  } catch { /* column already exists */ }
  try {
    await mdb().exec('ALTER TABLE monitoring_snapshots ADD COLUMN pnl_net_usd REAL DEFAULT NULL');
  } catch { /* column already exists */ }

  const firstSnap = await mdb().get(
    'SELECT equity_usd FROM monitoring_snapshots WHERE api_key_id = ? ORDER BY id ASC LIMIT 1',
    [key.id]
  ) as { equity_usd?: number } | undefined;
  const depositBase = Number(firstSnap?.equity_usd ?? metrics.equityUsd);
  const pnlNet = metrics.equityUsd - metrics.unrealizedPnl - depositBase;

  const insert: any = await mdb().run(
    `INSERT INTO monitoring_snapshots (
      api_key_id,
      api_key_name,
      exchange,
      equity_usd,
      unrealized_pnl,
      margin_used_usd,
      margin_load_percent,
      effective_leverage,
      notional_usd,
      drawdown_percent,
      deposit_base_usd,
      pnl_net_usd,
      source,
      recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', CURRENT_TIMESTAMP)`,
    [
      key.id,
      key.name,
      key.exchange,
      metrics.equityUsd,
      metrics.unrealizedPnl,
      metrics.marginUsedUsd,
      metrics.marginLoadPercent,
      metrics.effectiveLeverage,
      metrics.notionalUsd,
      drawdownPercent,
      depositBase,
      pnlNet,
    ]
  );

  const created = await mdb().get('SELECT * FROM monitoring_snapshots WHERE id = ?', [insert.lastID]);

  try {
    const { syncPortfolioCircuitBreakerEquity } = await import('./portfolioCircuitBreakerRuntime');
    await syncPortfolioCircuitBreakerEquity(apiKeyName, metrics.equityUsd);
  } catch {
    // non-critical
  }

  return created;
};

const MAX_CHART_POINTS = 720;

export type MonitoringPeriodStats = {
  returnPercent: number;
  pnlUsd: number;
  startEquityUsd: number;
  endEquityUsd: number;
  startAt: string | null;
  endAt: string | null;
  pointCount: number;
};

export type MonitoringTradeFrequencyPoint = {
  time: number;
  count: number;
  bucket: 'hour' | 'day';
};

export const getMonitoringTradeFrequency = async (
  apiKeyName: string,
  sinceDays?: number,
  allPeriod: boolean = false,
): Promise<MonitoringTradeFrequencyPoint[]> => {
  const key = await getApiKeyRow(apiKeyName);
  const useHourly = !allPeriod && (!sinceDays || sinceDays <= 1);
  const params: Array<number> = [key.id];
  let timeFilter = '';

  if (!allPeriod) {
    const safeDays = sinceDays && sinceDays > 1
      ? Math.min(365, Math.max(1, Math.floor(sinceDays)))
      : 1;
    timeFilter = 'AND lte.actual_time >= ?';
    params.push(Date.now() - safeDays * 86_400_000);
  }

  // SQLite: actual_time is ms epoch. Bucket in UTC for stable public charts.
  const bucketExpr = useHourly
    ? `strftime('%Y-%m-%dT%H:00:00Z', lte.actual_time / 1000, 'unixepoch')`
    : `strftime('%Y-%m-%dT00:00:00Z', lte.actual_time / 1000, 'unixepoch')`;

  const rows = await mainDb.all(
    `SELECT
       bucket_ts,
       SUM(trade_count) AS trade_count
     FROM (
       SELECT
         ${bucketExpr} AS bucket_ts,
         COUNT(*) AS trade_count
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       WHERE s.api_key_id = ?
         AND lte.actual_time IS NOT NULL
         AND lte.actual_time > 0
         ${timeFilter}
       GROUP BY bucket_ts
       UNION ALL
       SELECT
         ${bucketExpr.replace(/lte\./g, 'efe.')} AS bucket_ts,
         COUNT(*) AS trade_count
       FROM mon.exchange_fill_events efe
       WHERE efe.api_key_id = ?
         AND efe.actual_time IS NOT NULL
         AND efe.actual_time > 0
         ${timeFilter.replace(/lte\./g, 'efe.')}
       GROUP BY bucket_ts
     )
     GROUP BY bucket_ts
     ORDER BY bucket_ts ASC
     LIMIT 400`,
    [...params, ...params],
  ).catch(() => []) as Array<{ bucket_ts?: string; trade_count?: number }>;

  const mapped = rows
    .map((row) => {
      const ts = Date.parse(String(row.bucket_ts || ''));
      const count = toFiniteNumber(row.trade_count, 0);
      if (!Number.isFinite(ts) || ts <= 0 || count < 0) {
        return null;
      }
      return {
        time: Math.floor(ts / 1000),
        count,
        bucket: useHourly ? 'hour' as const : 'day' as const,
      };
    })
    .filter((row): row is MonitoringTradeFrequencyPoint => row !== null);

  return fillTradeFrequencyGaps(mapped, useHourly ? 'hour' : 'day');
};

const fillTradeFrequencyGaps = (
  points: MonitoringTradeFrequencyPoint[],
  bucket: 'hour' | 'day',
): MonitoringTradeFrequencyPoint[] => {
  if (points.length === 0) return [];
  const stepSec = bucket === 'hour' ? 3600 : 86_400;
  const byTime = new Map(points.map((p) => [p.time, p.count]));
  const start = points[0].time;
  const end = points[points.length - 1].time;
  const filled: MonitoringTradeFrequencyPoint[] = [];
  for (let t = start; t <= end; t += stepSec) {
    filled.push({
      time: t,
      count: byTime.get(t) ?? 0,
      bucket,
    });
  }
  return filled;
};

export const computeMonitoringPeriodStats = (points: any[]): MonitoringPeriodStats | null => {
  if (!Array.isArray(points) || points.length < 1) {
    return null;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const startEquity = toFiniteNumber(first?.equity_usd, NaN);
  const endEquity = toFiniteNumber(last?.equity_usd, NaN);

  if (!Number.isFinite(startEquity) || startEquity <= 0 || !Number.isFinite(endEquity)) {
    return null;
  }

  const returnPercent = ((endEquity - startEquity) / startEquity) * 100;
  const pnlUsd = endEquity - startEquity;

  return {
    returnPercent,
    pnlUsd,
    startEquityUsd: startEquity,
    endEquityUsd: endEquity,
    startAt: first?.recorded_at ? String(first.recorded_at) : null,
    endAt: last?.recorded_at ? String(last.recorded_at) : null,
    pointCount: points.length,
  };
};

export type MonitoringQueryOptions = {
  limit?: number;
  days?: number;
  all?: boolean;
  includeTrades?: boolean;
  /** Возвращать полный список сделок (и то, что может быть тяжелым по объёму). */
  includeTradesRows?: boolean;
  /** Запрашивать маркеры сделок на графике (в UI сейчас используется редко/частично). */
  includeTradeMarkers?: boolean;
};

export const getMonitoringSnapshots = async (
  apiKeyName: string,
  limit: number = 240,
  sinceDays?: number,
  allPeriod: boolean = false,
) => {
  const key = await getApiKeyRow(apiKeyName);

  let rows: any[];

  if (allPeriod) {
    rows = await mdb().all(
      `SELECT *
       FROM monitoring_snapshots
       WHERE api_key_id = ?
       ORDER BY datetime(recorded_at) ASC`,
      [key.id],
    );
  } else if (sinceDays && Number.isFinite(sinceDays) && sinceDays > 0) {
    const safeDays = Math.min(365, Math.max(1, Math.floor(sinceDays)));
    rows = await mdb().all(
      `SELECT *
       FROM monitoring_snapshots
       WHERE api_key_id = ?
         AND datetime(recorded_at) >= datetime('now', ? || ' days')
       ORDER BY datetime(recorded_at) ASC`,
      [key.id, `-${safeDays}`]
    );
  } else {
    const safeLimit = Math.max(1, Math.min(5000, Number.isFinite(limit) ? Math.floor(limit) : 240));
    rows = await mdb().all(
      `SELECT *
       FROM monitoring_snapshots
       WHERE api_key_id = ?
       ORDER BY datetime(recorded_at) DESC
       LIMIT ?`,
      [key.id, safeLimit]
    );
    rows.reverse();
  }

  // Downsample to keep chart responsive
  if (rows.length > MAX_CHART_POINTS) {
    const step = Math.ceil(rows.length / MAX_CHART_POINTS);
    rows = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  }

  return rows;
};

export type MonitoringTradeRow = {
  id: number;
  tradeType: 'entry' | 'exit';
  side: 'long' | 'short';
  symbol: string;
  price: number;
  size: number;
  fee: number | null;
  time: string;
  strategyId: number | null;
  entryPrice: number | null;
  /** Closed-bar time from live_trade_events.entry_time (ms). */
  barTime: number | null;
};

export const getMonitoringTrades = async (
  apiKeyName: string,
  sinceDays?: number,
  limit: number = 200,
): Promise<MonitoringTradeRow[]> => {
  const key = await getApiKeyRow(apiKeyName);
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const params: Array<number> = [key.id];
  let timeFilter = '';

  if (sinceDays && Number.isFinite(sinceDays) && sinceDays > 0) {
    const safeDays = Math.max(1, Math.floor(sinceDays));
    timeFilter = 'AND actual_time >= ?';
    params.push(Date.now() - safeDays * 86_400_000);
  }

  const rows = await mainDb.all(
    `SELECT * FROM (
       SELECT
         lte.id,
         lte.trade_type,
         lte.side,
         lte.source_symbol,
         lte.actual_price,
         lte.position_size,
         lte.actual_fee,
         lte.actual_time,
         lte.strategy_id,
         lte.entry_price,
         lte.entry_time,
         s.base_symbol,
         s.quote_symbol
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       WHERE s.api_key_id = ?
         ${timeFilter.replace(/actual_time/g, 'lte.actual_time')}
       UNION ALL
       SELECT
         efe.id,
         efe.trade_type,
         efe.side,
         efe.source_symbol,
         efe.actual_price,
         efe.position_size,
         efe.actual_fee,
         efe.actual_time,
         NULL AS strategy_id,
         NULL AS entry_price,
         NULL AS entry_time,
         efe.source_symbol AS base_symbol,
         NULL AS quote_symbol
       FROM mon.exchange_fill_events efe
       WHERE efe.api_key_id = ?
         ${timeFilter.replace(/actual_time/g, 'efe.actual_time')}
     )
     ORDER BY actual_time DESC
     LIMIT ?`,
    [...params, ...params, safeLimit],
  ).catch(() => []) as Array<{
    id?: number;
    trade_type?: string;
    side?: string;
    source_symbol?: string;
    actual_price?: number;
    position_size?: number;
    actual_fee?: number;
    actual_time?: number;
    strategy_id?: number;
    entry_price?: number;
    entry_time?: number;
    base_symbol?: string;
    quote_symbol?: string;
  }>;

  return rows
    .map((row) => {
      const tradeType = String(row.trade_type || '').toLowerCase();
      const side = String(row.side || '').toLowerCase();
      if (tradeType !== 'entry' && tradeType !== 'exit') {
        return null;
      }
      if (side !== 'long' && side !== 'short') {
        return null;
      }

      const symbol = String(row.source_symbol || row.base_symbol || '').trim().toUpperCase();
      const timeMs = toFiniteNumber(row.actual_time, 0);
      if (timeMs <= 0) {
        return null;
      }

      return {
        id: toFiniteNumber(row.id, 0),
        tradeType: tradeType as 'entry' | 'exit',
        side: side as 'long' | 'short',
        symbol,
        price: toFiniteNumber(row.actual_price, 0),
        size: toFiniteNumber(row.position_size, 0),
        fee: row.actual_fee != null ? toFiniteNumber(row.actual_fee, 0) : null,
        time: new Date(timeMs).toISOString(),
        strategyId: row.strategy_id != null ? toFiniteNumber(row.strategy_id, 0) : null,
        entryPrice: row.entry_price != null && toFiniteNumber(row.entry_price, 0) > 0
          ? toFiniteNumber(row.entry_price, 0)
          : null,
        barTime: row.entry_time != null && toFiniteNumber(row.entry_time, 0) > 0
          ? toFiniteNumber(row.entry_time, 0)
          : null,
      };
    })
    .filter((row): row is MonitoringTradeRow => row !== null);
};

export const getMonitoringBundle = async (
  apiKeyName: string,
  options: MonitoringQueryOptions = {},
) => {
  const limit = options.limit ?? 240;
  const days = options.days ?? 0;
  const allPeriod = options.all === true;
  const includeTrades = options.includeTrades === true;
  const includeTradesRows = options.includeTradesRows === true;
  const includeTradeMarkers = options.includeTradeMarkers === true;

  const points = allPeriod
    ? await getMonitoringSnapshots(apiKeyName, limit, undefined, true)
    : days > 1
      ? await getMonitoringSnapshots(apiKeyName, 5000, days)
      : await getMonitoringSnapshots(apiKeyName, limit);

  const latest = points.length > 0
    ? points[points.length - 1]
    : await getMonitoringLatest(apiKeyName);

  const periodStats = computeMonitoringPeriodStats(points);
  const tradeStats = includeTrades
    ? await getMonitoringTradeStats(apiKeyName).catch(() => ({ trades24h: 0, lastTradeAt: null }))
    : undefined;

  const sinceMs = allPeriod
    ? 0
    : days > 1
      ? Date.now() - days * 86_400_000
      : Date.now() - 86_400_000;

  const tradeMarkers = includeTrades && includeTradeMarkers
    ? await getMonitoringTradeMarkers(apiKeyName, sinceMs).catch(() => [])
    : undefined;

  const trades = includeTradesRows
    ? await getMonitoringTrades(
      apiKeyName,
      allPeriod ? undefined : (days > 1 ? days : 1),
      allPeriod ? 500 : 200,
    ).catch(() => [])
    : undefined;

  const tradeFrequency = includeTrades
    ? await getMonitoringTradeFrequency(
      apiKeyName,
      allPeriod ? undefined : (days > 1 ? days : 1),
      allPeriod,
    ).catch(() => [])
    : undefined;

  return {
    points,
    latest,
    periodStats,
    tradeStats,
    tradeMarkers,
    trades,
    tradeFrequency,
  };
};

export const getMonitoringLatest = async (apiKeyName: string) => {
  const key = await getApiKeyRow(apiKeyName);
  const row = await mdb().get(
    `SELECT *
     FROM monitoring_snapshots
     WHERE api_key_id = ?
     ORDER BY datetime(recorded_at) DESC
     LIMIT 1`,
    [key.id]
  );
  return row || null;
};

/**
 * Latest snapshot per API key in one query (admin monitoring table).
 * Avoids N× getMonitoringBundle(includeTrades) which timed out and showed $0.00.
 */
export const getMonitoringLatestBatch = async (
  apiKeyNames: string[],
): Promise<Record<string, any>> => {
  const names = [...new Set(
    (Array.isArray(apiKeyNames) ? apiKeyNames : [])
      .map((n) => String(n || '').trim())
      .filter(Boolean),
  )];
  if (names.length === 0) return {};

  const placeholders = names.map(() => '?').join(',');
  const keyRows = await mainDb.all(
    `SELECT id, name FROM api_keys WHERE name IN (${placeholders})`,
    names,
  ).catch(() => []) as Array<{ id?: number; name?: string }>;

  const out: Record<string, any> = {};
  for (const name of names) out[name] = null;

  const ids = keyRows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return out;

  const byId = new Map<number, Record<string, unknown>>();
  for (const id of ids) {
    const row = await mdb().get(
      `SELECT * FROM monitoring_snapshots
       WHERE api_key_id = ?
       ORDER BY datetime(recorded_at) DESC
       LIMIT 1`,
      [id],
    ) as Record<string, unknown> | undefined;
    if (row) byId.set(id, row);
  }

  for (const keyRow of keyRows) {
    const name = String(keyRow.name || '').trim();
    const id = Number(keyRow.id);
    if (!name) continue;
    out[name] = byId.get(id) || null;
  }
  return out;
};

export type MonitoringTradeMarker = {
  time: number;
  tradeType: 'entry' | 'exit';
  side: 'long' | 'short';
  symbol: string;
};

export const getMonitoringTradeStats = async (apiKeyName: string) => {
  const key = await getApiKeyRow(apiKeyName);
  const since24h = Date.now() - 86_400_000;
  const stats = await mainDb.get<{
    events_count?: number;
    entries_count?: number;
    last_trade_at?: number;
  }>(
    `SELECT
       SUM(events_count) AS events_count,
       SUM(entries_count) AS entries_count,
       MAX(last_trade_at) AS last_trade_at
     FROM (
       SELECT
         COUNT(*) AS events_count,
         SUM(CASE
           WHEN COALESCE(lte.trade_type, '') = 'entry'
            AND COALESCE(lte.event_origin, 'strategy_signal') = 'strategy_signal'
           THEN 1 ELSE 0
         END) AS entries_count,
         MAX(lte.actual_time) AS last_trade_at
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       WHERE s.api_key_id = ?
         AND lte.actual_time >= ?
       UNION ALL
       SELECT
         COUNT(*) AS events_count,
         SUM(CASE WHEN COALESCE(efe.trade_type, '') = 'entry' THEN 1 ELSE 0 END) AS entries_count,
         MAX(efe.actual_time) AS last_trade_at
       FROM mon.exchange_fill_events efe
       WHERE efe.api_key_id = ?
         AND efe.actual_time >= ?
     )`,
    [key.id, since24h, key.id, since24h],
  ).catch(() => null);

  const entries24h = Math.max(0, toFiniteNumber(stats?.entries_count, 0));
  const events24h = Math.max(0, toFiniteNumber(stats?.events_count, 0));

  return {
    // Honest entry count (matches fair BT / tradeDrift); not fills+exits noise.
    trades24h: entries24h,
    entries24h,
    events24h,
    lastTradeAt: stats?.last_trade_at
      ? new Date(toFiniteNumber(stats.last_trade_at)).toISOString()
      : null,
  };
};

export const getMonitoringTradeMarkers = async (
  apiKeyName: string,
  sinceMs: number,
): Promise<MonitoringTradeMarker[]> => {
  const key = await getApiKeyRow(apiKeyName);
  const safeSince = Math.max(0, Math.floor(sinceMs));
  const rows = await mainDb.all(
    `SELECT trade_type, side, source_symbol, actual_time FROM (
       SELECT lte.trade_type, lte.side, lte.source_symbol, lte.actual_time
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       WHERE s.api_key_id = ?
         AND lte.actual_time >= ?
       UNION ALL
       SELECT efe.trade_type, efe.side, efe.source_symbol, efe.actual_time
       FROM mon.exchange_fill_events efe
       WHERE efe.api_key_id = ?
         AND efe.actual_time >= ?
     )
     ORDER BY actual_time ASC
     LIMIT 500`,
    [key.id, safeSince, key.id, safeSince],
  ).catch(() => []) as Array<{
    trade_type?: string;
    side?: string;
    source_symbol?: string;
    actual_time?: number;
  }>;

  return rows
    .map((row) => {
      const time = Math.floor(toFiniteNumber(row.actual_time, 0) / 1000);
      const tradeType = String(row.trade_type || '').toLowerCase();
      const side = String(row.side || '').toLowerCase();
      const symbol = String(row.source_symbol || '').trim();
      if (time <= 0 || (tradeType !== 'entry' && tradeType !== 'exit')) {
        return null;
      }
      if (side !== 'long' && side !== 'short') {
        return null;
      }
      return {
        time,
        tradeType: tradeType as 'entry' | 'exit',
        side: side as 'long' | 'short',
        symbol,
      };
    })
    .filter((row): row is MonitoringTradeMarker => row !== null);
};

export type BackfillEquityResult = {
  apiKeyName: string;
  exchange: string;
  inserted: number;
  skipped: number;
  rawEvents: number;
  pointsFromExchange: number;
  fillsInserted: number;
  fillsRawEvents: number;
  fromMs: number;
  toMs: number;
  firstAt: string | null;
  lastAt: string | null;
  note: string;
};

const backfillInFlight = new Map<string, Promise<BackfillEquityResult>>();

const toSqliteUtc = (ms: number): string => {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
};

const ensureSnapshotSourceColumn = async () => {
  // Schema is owned by monitoring/db.ts; keep as no-op compatibility shim.
  const { initMonitoringDb } = await import('../monitoring/db');
  await initMonitoringDb();
};

const ensureExchangeFillEventsTable = async () => {
  const { initMonitoringDb } = await import('../monitoring/db');
  await initMonitoringDb();
};

const insertInferredFillEvents = async (
  apiKeyId: number,
  apiKeyName: string,
  fills: Array<{
    tradeId: string;
    orderId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: string;
    price: string;
    fee: string;
    realizedPnl: string;
    isMaker?: boolean;
    timestamp: string;
  }>,
): Promise<number> => {
  const epsilon = 1e-9;
  const positionSignedQtyBySymbol = new Map<string, number>();
  let inserted = 0;

  const emit = async (
    sourceTradeId: string,
    tradeType: 'entry' | 'exit',
    side: 'long' | 'short',
    timestamp: number,
    price: number,
    qty: number,
    fee: number,
    realizedPnl: number,
    isMaker: boolean,
    orderId: string,
    symbol: string,
  ) => {
    if (qty <= epsilon) return;
    try {
      const result: any = await mdb().run(
        `INSERT OR IGNORE INTO exchange_fill_events (
          api_key_id, api_key_name, trade_type, side, source_trade_id, source_order_id, source_symbol,
          actual_price, position_size, actual_fee, realized_pnl, is_maker, actual_time, event_origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exchange_backfill')`,
        [
          apiKeyId,
          apiKeyName,
          tradeType,
          side,
          sourceTradeId,
          orderId || null,
          symbol,
          price,
          qty,
          fee,
          realizedPnl,
          isMaker ? 1 : 0,
          timestamp,
        ],
      );
      if (Number(result?.changes || 0) > 0) {
        inserted += 1;
      }
    } catch (error) {
      logger.warn(`exchange_fill_events insert failed: ${(error as Error).message}`);
    }
  };

  const ordered = [...fills].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  for (const trade of ordered) {
    const tradeId = String(trade.tradeId || '').trim();
    const tradeSymbol = String(trade.symbol || '').trim().toUpperCase();
    if (!tradeId || !tradeSymbol) continue;

    const timestamp = Number(trade.timestamp);
    const price = Number(trade.price);
    const qty = Math.abs(Number(trade.qty));
    const fee = Math.abs(Number(trade.fee));
    const realizedPnl = Number(trade.realizedPnl);
    if (!(timestamp > 0 && price > 0 && qty > 0)) continue;

    const sourceTradeBaseId = `${tradeSymbol}:${tradeId}`;
    const delta = trade.side === 'Buy' ? qty : -qty;
    const prev = positionSignedQtyBySymbol.get(tradeSymbol) || 0;
    const next = prev + delta;
    const isMaker = trade.isMaker === true;
    const orderId = String(trade.orderId || '').trim();

    if (Math.abs(prev) <= epsilon) {
      const side = next >= 0 ? 'long' : 'short';
      await emit(`${sourceTradeBaseId}:entry`, 'entry', side, timestamp, price, Math.abs(next), fee, realizedPnl, isMaker, orderId, tradeSymbol);
      positionSignedQtyBySymbol.set(tradeSymbol, next);
      continue;
    }

    const prevSide: 'long' | 'short' = prev >= 0 ? 'long' : 'short';
    const nextSide: 'long' | 'short' = next >= 0 ? 'long' : 'short';
    const prevAbs = Math.abs(prev);
    const nextAbs = Math.abs(next);

    if (prevSide === nextSide || Math.abs(next) <= epsilon) {
      if (nextAbs > prevAbs + epsilon) {
        await emit(`${sourceTradeBaseId}:entry`, 'entry', prevSide, timestamp, price, nextAbs - prevAbs, fee, realizedPnl, isMaker, orderId, tradeSymbol);
      } else if (nextAbs + epsilon < prevAbs) {
        await emit(`${sourceTradeBaseId}:exit`, 'exit', prevSide, timestamp, price, prevAbs - nextAbs, fee, realizedPnl, isMaker, orderId, tradeSymbol);
      }
      positionSignedQtyBySymbol.set(tradeSymbol, next);
      continue;
    }

    await emit(`${sourceTradeBaseId}:exit`, 'exit', prevSide, timestamp, price, prevAbs, fee / 2, 0, isMaker, orderId, tradeSymbol);
    await emit(`${sourceTradeBaseId}:entry`, 'entry', nextSide, timestamp, price, nextAbs, fee / 2, realizedPnl, isMaker, orderId, tradeSymbol);
    positionSignedQtyBySymbol.set(tradeSymbol, next);
  }

  return inserted;
};

/**
 * On-demand: pull equity + fills history from the exchange.
 * Equity → monitoring_snapshots (before first live). Fills → exchange_fill_events (account-level).
 * Bybit only for now.
 */
export const backfillMonitoringEquityFromExchange = async (
  apiKeyName: string,
  options?: { maxDays?: number; fromMs?: number; toMs?: number },
): Promise<BackfillEquityResult> => {
  const keyName = String(apiKeyName || '').trim();
  if (!keyName) {
    throw new Error('apiKeyName is required');
  }

  const existing = backfillInFlight.get(keyName);
  if (existing) {
    return existing;
  }

  const job = (async (): Promise<BackfillEquityResult> => {
    await ensureSnapshotSourceColumn();
    await ensureExchangeFillEventsTable();
    const key = await getApiKeyRow(keyName);
    const exchangeLower = String(key.exchange || '').toLowerCase();
    if (!exchangeLower.includes('bybit')) {
      throw new Error(`Backfill with exchange history is currently supported only for Bybit (got: ${key.exchange || 'unknown'})`);
    }

    const rangeOpts = {
      maxDays: options?.maxDays,
      fromMs: options?.fromMs,
      toMs: options?.toMs,
    };

    const [history, fillsHistory] = await Promise.all([
      fetchExchangeEquityHistory(keyName, rangeOpts),
      fetchExchangeFillsHistory(keyName, rangeOpts).catch((error) => {
        logger.warn(`fetchExchangeFillsHistory failed for ${keyName}: ${(error as Error).message}`);
        return {
          exchange: 'bybit',
          fills: [] as Awaited<ReturnType<typeof fetchExchangeFillsHistory>>['fills'],
          rawEvents: 0,
          fromMs: 0,
          toMs: 0,
        };
      }),
    ]);

    // Idempotent fills: replace previous backfill fills for this key
    await mdb().run(
      `DELETE FROM exchange_fill_events
       WHERE api_key_id = ? AND COALESCE(event_origin, '') = 'exchange_backfill'`,
      [key.id],
    );
    const fillsInserted = await insertInferredFillEvents(key.id, key.name, fillsHistory.fills);

    const firstLive = await mdb().get(
      `SELECT recorded_at FROM monitoring_snapshots
       WHERE api_key_id = ?
         AND COALESCE(source, 'live') != 'exchange_backfill'
       ORDER BY datetime(recorded_at) ASC
       LIMIT 1`,
      [key.id],
    ) as { recorded_at?: string } | undefined;
    const firstLiveMs = firstLive?.recorded_at
      ? Date.parse(String(firstLive.recorded_at).includes('T')
        ? String(firstLive.recorded_at)
        : `${String(firstLive.recorded_at).replace(' ', 'T')}Z`)
      : NaN;

    await mdb().run(
      `DELETE FROM monitoring_snapshots
       WHERE api_key_id = ? AND source = 'exchange_backfill'`,
      [key.id],
    );

    const usable = history.points.filter((p) => {
      if (!Number.isFinite(p.equityUsd) || p.equityUsd <= 0) return false;
      if (Number.isFinite(firstLiveMs) && firstLiveMs > 0 && p.timeMs >= firstLiveMs) return false;
      return true;
    });

    let inserted = 0;
    let firstAt: string | null = null;
    let lastAt: string | null = null;

    if (usable.length > 0) {
      const depositBase = usable[0].equityUsd;
      let peak = usable[0].equityUsd;
      for (const point of usable) {
        peak = Math.max(peak, point.equityUsd);
        const drawdownPercent = peak > 0
          ? Math.max(0, ((peak - point.equityUsd) / peak) * 100)
          : 0;
        const pnlNet = point.equityUsd - depositBase;
        const recordedAt = toSqliteUtc(point.timeMs);

        await mdb().run(
          `INSERT INTO monitoring_snapshots (
            api_key_id,
            api_key_name,
            exchange,
            equity_usd,
            unrealized_pnl,
            margin_used_usd,
            margin_load_percent,
            effective_leverage,
            notional_usd,
            drawdown_percent,
            deposit_base_usd,
            pnl_net_usd,
            recorded_at,
            source
          ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, 'exchange_backfill')`,
          [
            key.id,
            key.name,
            key.exchange || history.exchange,
            point.equityUsd,
            drawdownPercent,
            depositBase,
            pnlNet,
            recordedAt,
          ],
        );
        inserted += 1;
      }
      firstAt = toSqliteUtc(usable[0].timeMs);
      lastAt = toSqliteUtc(usable[usable.length - 1].timeMs);
    }

    logger.info(
      `backfillMonitoringEquityFromExchange ${keyName}: equity=${inserted} fills=${fillsInserted} rawTx=${history.rawEvents} rawFills=${fillsHistory.rawEvents}`,
    );

    const noteParts = [
      'Bybit: Transaction Log (wallet equity, без UPNL) + Execution List (fills → entry/exit).',
      inserted > 0 ? `Equity +${inserted}` : 'Equity: новых точек нет',
      fillsInserted > 0 ? `Fills +${fillsInserted}` : 'Fills: пусто или уже были',
    ];

    return {
      apiKeyName: keyName,
      exchange: history.exchange,
      inserted,
      skipped: history.points.length - usable.length,
      rawEvents: history.rawEvents,
      pointsFromExchange: history.points.length,
      fillsInserted,
      fillsRawEvents: fillsHistory.rawEvents,
      fromMs: history.fromMs,
      toMs: history.toMs,
      firstAt,
      lastAt,
      note: noteParts.join(' '),
    };
  })();

  backfillInFlight.set(keyName, job);
  try {
    return await job;
  } finally {
    backfillInFlight.delete(keyName);
  }
};

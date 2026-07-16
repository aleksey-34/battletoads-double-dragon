import { getBalances, getPositions } from './exchange';
import { db } from '../utils/database';

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

const getApiKeyRow = async (apiKeyName: string): Promise<{ id: number; exchange: string }> => {
  const row = await db.get('SELECT id, exchange FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!row) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }

  return {
    id: Number(row.id),
    exchange: String(row.exchange || ''),
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
  const peakRow = await db.get(
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
    const medianPeakRow = await db.get(
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
    await db.exec('ALTER TABLE monitoring_snapshots ADD COLUMN deposit_base_usd REAL DEFAULT NULL');
  } catch { /* column already exists */ }
  try {
    await db.exec('ALTER TABLE monitoring_snapshots ADD COLUMN pnl_net_usd REAL DEFAULT NULL');
  } catch { /* column already exists */ }

  const firstSnap = await db.get(
    'SELECT equity_usd FROM monitoring_snapshots WHERE api_key_id = ? ORDER BY id ASC LIMIT 1',
    [key.id]
  ) as { equity_usd?: number } | undefined;
  const depositBase = Number(firstSnap?.equity_usd ?? metrics.equityUsd);
  const pnlNet = metrics.equityUsd - metrics.unrealizedPnl - depositBase;

  const insert: any = await db.run(
    `INSERT INTO monitoring_snapshots (
      api_key_id,
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
      recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      key.id,
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

  const created = await db.get('SELECT * FROM monitoring_snapshots WHERE id = ?', [insert.lastID]);

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

  const rows = await db.all(
    `SELECT
       ${bucketExpr} AS bucket_ts,
       COUNT(*) AS trade_count
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     WHERE s.api_key_id = ?
       AND lte.actual_time IS NOT NULL
       AND lte.actual_time > 0
       ${timeFilter}
     GROUP BY bucket_ts
     ORDER BY bucket_ts ASC
     LIMIT 400`,
    params,
  ).catch(() => []) as Array<{ bucket_ts?: string; trade_count?: number }>;

  return rows
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
    rows = await db.all(
      `SELECT *
       FROM monitoring_snapshots
       WHERE api_key_id = ?
       ORDER BY datetime(recorded_at) ASC`,
      [key.id],
    );
  } else if (sinceDays && Number.isFinite(sinceDays) && sinceDays > 0) {
    const safeDays = Math.min(365, Math.max(1, Math.floor(sinceDays)));
    rows = await db.all(
      `SELECT *
       FROM monitoring_snapshots
       WHERE api_key_id = ?
         AND datetime(recorded_at) >= datetime('now', ? || ' days')
       ORDER BY datetime(recorded_at) ASC`,
      [key.id, `-${safeDays}`]
    );
  } else {
    const safeLimit = Math.max(1, Math.min(5000, Number.isFinite(limit) ? Math.floor(limit) : 240));
    rows = await db.all(
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
};

export const getMonitoringTrades = async (
  apiKeyName: string,
  sinceDays?: number,
  limit: number = 200,
): Promise<MonitoringTradeRow[]> => {
  const key = await getApiKeyRow(apiKeyName);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const params: Array<number> = [key.id];
  let timeFilter = '';

  if (sinceDays && Number.isFinite(sinceDays) && sinceDays > 0) {
    const safeDays = Math.max(1, Math.floor(sinceDays));
    timeFilter = 'AND lte.actual_time >= ?';
    params.push(Date.now() - safeDays * 86_400_000);
  }

  params.push(safeLimit);

  const rows = await db.all(
    `SELECT
       lte.id,
       lte.trade_type,
       lte.side,
       lte.source_symbol,
       lte.actual_price,
       lte.position_size,
       lte.actual_fee,
       lte.actual_time,
       lte.strategy_id,
       s.base_symbol,
       s.quote_symbol
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     WHERE s.api_key_id = ?
       ${timeFilter}
     ORDER BY lte.actual_time DESC
     LIMIT ?`,
    params,
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
      200,
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
  const row = await db.get(
    `SELECT *
     FROM monitoring_snapshots
     WHERE api_key_id = ?
     ORDER BY datetime(recorded_at) DESC
     LIMIT 1`,
    [key.id]
  );
  return row || null;
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
  const stats = await db.get<{
    trades_count?: number;
    last_trade_at?: number;
  }>(
    `SELECT
       COUNT(*) AS trades_count,
       MAX(lte.actual_time) AS last_trade_at
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     WHERE s.api_key_id = ?
       AND lte.actual_time >= ?`,
    [key.id, since24h],
  ).catch(() => null);

  return {
    trades24h: Math.max(0, toFiniteNumber(stats?.trades_count, 0)),
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
  const rows = await db.all(
    `SELECT lte.trade_type, lte.side, lte.source_symbol, lte.actual_time
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     WHERE s.api_key_id = ?
       AND lte.actual_time >= ?
     ORDER BY lte.actual_time ASC
     LIMIT 500`,
    [key.id, safeSince],
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

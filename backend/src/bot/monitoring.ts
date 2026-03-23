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
  const [balances, positions] = await Promise.all([
    getBalances(apiKeyName),
    getPositions(apiKeyName),
  ]);

  const metrics = calculateMetrics(balances, positions);
  
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
      recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
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
    ]
  );

  const created = await db.get('SELECT * FROM monitoring_snapshots WHERE id = ?', [insert.lastID]);
  return created;
};

export const getMonitoringSnapshots = async (apiKeyName: string, limit: number = 240) => {
  const key = await getApiKeyRow(apiKeyName);
  const safeLimit = Math.max(1, Math.min(5000, Number.isFinite(limit) ? Math.floor(limit) : 240));

  const rows = await db.all(
    `SELECT *
     FROM monitoring_snapshots
     WHERE api_key_id = ?
     ORDER BY datetime(recorded_at) DESC
     LIMIT ?`,
    [key.id, safeLimit]
  );

  return rows.reverse();
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

export type MonitoringTradeInput = {
  id: number;
  tradeType: 'entry' | 'exit';
  side: 'long' | 'short';
  symbol: string;
  price: number;
  time: string;
  strategyId: number | null;
  entryPrice?: number | null;
};

export type MonitoringFlowType = 'in' | 'out' | 'reverse';

export type EnrichedMonitoringTrade = MonitoringTradeInput & {
  flowType: MonitoringFlowType;
  pnlPercent: number | null;
  entryPrice: number | null;
};

export const calcTradePnlPercent = (
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
): number | null => {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0 || exitPrice <= 0) {
    return null;
  }
  if (side === 'long') {
    return ((exitPrice / entryPrice) - 1) * 100;
  }
  return ((entryPrice / exitPrice) - 1) * 100;
};

const positionKey = (row: MonitoringTradeInput): string =>
  `${Number(row.strategyId || 0)}::${String(row.symbol || '').toUpperCase()}`;

export const enrichMonitoringTrades = (rows: MonitoringTradeInput[]): EnrichedMonitoringTrade[] => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const sorted = [...rows].sort(
    (a, b) => Date.parse(String(a.time || '')) - Date.parse(String(b.time || '')),
  );

  const open = new Map<string, { side: 'long' | 'short'; entryPrice: number }>();
  const lastSideByKey = new Map<string, 'long' | 'short'>();
  const enriched: EnrichedMonitoringTrade[] = [];

  for (const row of sorted) {
    const key = positionKey(row);
    const dbEntry = row.entryPrice != null && Number.isFinite(Number(row.entryPrice)) && Number(row.entryPrice) > 0
      ? Number(row.entryPrice)
      : null;

    if (row.tradeType === 'exit') {
      const refEntry = dbEntry ?? open.get(key)?.entryPrice ?? null;
      enriched.push({
        ...row,
        flowType: 'out',
        entryPrice: refEntry,
        pnlPercent: refEntry != null ? calcTradePnlPercent(row.side, refEntry, row.price) : null,
      });
      open.delete(key);
      lastSideByKey.set(key, row.side);
      continue;
    }

    let flowType: MonitoringFlowType = 'in';
    const prevSide = open.get(key)?.side ?? lastSideByKey.get(key);
    if (prevSide && prevSide !== row.side) {
      flowType = 'reverse';
    }

    const entryPrice = row.price > 0 ? row.price : (dbEntry ?? open.get(key)?.entryPrice ?? null);
    enriched.push({
      ...row,
      flowType,
      entryPrice,
      pnlPercent: null,
    });

    open.set(key, {
      side: row.side,
      entryPrice: entryPrice ?? row.price,
    });
    lastSideByKey.set(key, row.side);
  }

  return enriched.sort(
    (a, b) => Date.parse(String(b.time || '')) - Date.parse(String(a.time || '')),
  );
};

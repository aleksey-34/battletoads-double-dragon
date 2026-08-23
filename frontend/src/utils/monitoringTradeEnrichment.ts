import type { MonitoringTradeRow } from '../components/MonitoringChartPanel';

export type MonitoringFlowType = 'in' | 'out' | 'reverse';

export type EnrichedMonitoringTradeRow = MonitoringTradeRow & {
  flowType: MonitoringFlowType;
  pnlPercent: number | null;
  entryPrice: number | null;
};

export type MonitoringTradeGroupMode = 'none' | 'symbol' | 'flowType' | 'side' | 'pnl';

export type MonitoringPnlBucket = 'profit' | 'loss' | 'pending';

const positionKey = (row: MonitoringTradeRow): string =>
  `${Number(row.strategyId || 0)}::${String(row.symbol || '').toUpperCase()}`;

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

export const pnlBucket = (pnlPercent: number | null): MonitoringPnlBucket => {
  if (pnlPercent == null || !Number.isFinite(pnlPercent)) {
    return 'pending';
  }
  if (pnlPercent >= 0) {
    return 'profit';
  }
  return 'loss';
};

export const pnlBucketLabel: Record<MonitoringPnlBucket, string> = {
  profit: 'Профит',
  loss: 'Убыток',
  pending: 'Без PnL (вход)',
};

export const flowTypeLabel: Record<MonitoringFlowType, string> = {
  in: 'IN',
  out: 'OUT',
  reverse: 'REV',
};

/** Chronological enrichment: IN / OUT / REVERSE + round-trip PnL% on exits. */
export const enrichMonitoringTrades = (rows: MonitoringTradeRow[]): EnrichedMonitoringTradeRow[] => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const sorted = [...rows].sort(
    (a, b) => Date.parse(String(a.time || '')) - Date.parse(String(b.time || '')),
  );

  const open = new Map<string, { side: 'long' | 'short'; entryPrice: number; entryTimeMs: number }>();
  const enriched: EnrichedMonitoringTradeRow[] = [];

  for (const row of sorted) {
    const key = positionKey(row);
    const cur = open.get(key) || null;
    const dbEntry = row.entryPrice != null && Number.isFinite(Number(row.entryPrice)) && Number(row.entryPrice) > 0
      ? Number(row.entryPrice)
      : null;

    if (row.tradeType === 'exit') {
      const refEntry = dbEntry ?? cur?.entryPrice ?? null;
      const pnlPercent = refEntry != null
        ? calcTradePnlPercent(row.side, refEntry, row.price)
        : null;
      enriched.push({
        ...row,
        flowType: 'out',
        entryPrice: refEntry,
        pnlPercent,
      });
      open.delete(key);
      continue;
    }

    // entry
    let flowType: MonitoringFlowType = 'in';
    if (cur && cur.side !== row.side) {
      flowType = 'reverse';
    } else if (cur && cur.side === row.side) {
      // Pyramid / duplicate leg — still IN, keep first entry for PnL reference.
      flowType = 'in';
    }

    const entryPrice = row.price > 0 ? row.price : (dbEntry ?? cur?.entryPrice ?? null);
    enriched.push({
      ...row,
      flowType,
      entryPrice,
      pnlPercent: null,
    });

    open.set(key, {
      side: row.side,
      entryPrice: entryPrice ?? row.price,
      entryTimeMs: Date.parse(String(row.time || '')),
    });
  }

  // Display newest first (matches API order).
  return enriched.sort(
    (a, b) => Date.parse(String(b.time || '')) - Date.parse(String(a.time || '')),
  );
};

export type MonitoringTradeGroup = {
  key: string;
  label: string;
  rows: EnrichedMonitoringTradeRow[];
  totalPnl: number | null;
};

export const groupMonitoringTrades = (
  rows: EnrichedMonitoringTradeRow[],
  mode: MonitoringTradeGroupMode,
): MonitoringTradeGroup[] | null => {
  if (mode === 'none' || rows.length === 0) {
    return null;
  }

  const buckets = new Map<string, EnrichedMonitoringTradeRow[]>();

  for (const row of rows) {
    let key: string;
    switch (mode) {
      case 'symbol':
        key = String(row.symbol || '?').toUpperCase();
        break;
      case 'flowType':
        key = row.flowType;
        break;
      case 'side':
        key = row.side;
        break;
      case 'pnl':
        key = pnlBucket(row.pnlPercent);
        break;
      default:
        key = 'all';
    }
    const list = buckets.get(key) || [];
    list.push(row);
    buckets.set(key, list);
  }

  const groups: MonitoringTradeGroup[] = Array.from(buckets.entries()).map(([key, groupRows]) => {
    const pnls = groupRows
      .map((r) => r.pnlPercent)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const totalPnl = pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) : null;

    let label = key;
    if (mode === 'flowType') {
      label = flowTypeLabel[key as MonitoringFlowType] || key;
    } else if (mode === 'side') {
      label = key === 'long' ? 'Long' : key === 'short' ? 'Short' : key;
    } else if (mode === 'pnl') {
      label = pnlBucketLabel[key as MonitoringPnlBucket] || key;
    }

    return {
      key,
      label,
      rows: groupRows.sort(
        (a, b) => Date.parse(String(b.time || '')) - Date.parse(String(a.time || '')),
      ),
      totalPnl,
    };
  });

  if (mode === 'pnl') {
    const order: MonitoringPnlBucket[] = ['profit', 'loss', 'pending'];
    groups.sort((a, b) => order.indexOf(a.key as MonitoringPnlBucket) - order.indexOf(b.key as MonitoringPnlBucket));
  } else if (mode === 'flowType') {
    const order: MonitoringFlowType[] = ['in', 'out', 'reverse'];
    groups.sort((a, b) => order.indexOf(a.key as MonitoringFlowType) - order.indexOf(b.key as MonitoringFlowType));
  } else {
    groups.sort((a, b) => a.label.localeCompare(b.label));
  }

  return groups;
};

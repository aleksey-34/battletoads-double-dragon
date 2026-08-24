import type { MonitoringTradeRow } from '../components/MonitoringChartPanel';

export type MonitoringFlowType = 'in' | 'out' | 'reverse';

export type EnrichedMonitoringTradeRow = MonitoringTradeRow & {
  flowType: MonitoringFlowType;
  pnlPercent: number | null;
  entryPrice: number | null;
};

export type SynthStrategyMeta = {
  id: number;
  baseSymbol: string;
  quoteSymbol: string;
};

export type DisplayMonitoringTradeRow = EnrichedMonitoringTradeRow & {
  synthGrouped?: boolean;
  synthPairLabel?: string;
  synthLegs?: EnrichedMonitoringTradeRow[];
};

export type MonitoringTradeGroupMode = 'none' | 'symbol' | 'flowType' | 'side' | 'pnl';

export type MonitoringPnlBucket = 'profit' | 'loss' | 'pending';

/** Legs of one synth signal usually land within 2 minutes. */
export const SYNTH_LEG_BUCKET_MS = 120_000;

export const buildSynthStrategyMap = (
  strategies: Array<Record<string, unknown>>,
): Map<number, SynthStrategyMeta> => {
  const out = new Map<number, SynthStrategyMeta>();
  for (const row of strategies) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (String(row.market_mode || '') !== 'synthetic') continue;
    const baseSymbol = String(row.base_symbol || '').toUpperCase();
    const quoteSymbol = String(row.quote_symbol || '').toUpperCase();
    if (!baseSymbol || !quoteSymbol) continue;
    out.set(id, { id, baseSymbol, quoteSymbol });
  }
  return out;
};

const synthBucketKey = (row: EnrichedMonitoringTradeRow): string => {
  const t = Date.parse(String(row.time || ''));
  const bucket = Number.isFinite(t) ? Math.floor(t / SYNTH_LEG_BUCKET_MS) : 0;
  return `${Number(row.strategyId || 0)}::${row.flowType}::${bucket}`;
};

/** Collapse base+quote fills of the same synth strategy into one list row. */
export const collapseSynthTradeLegs = (
  rows: EnrichedMonitoringTradeRow[],
  synthById: Map<number, SynthStrategyMeta>,
  enabled: boolean,
): DisplayMonitoringTradeRow[] => {
  if (!enabled || synthById.size === 0 || rows.length === 0) {
    return rows.map((row) => ({ ...row }));
  }

  const buckets = new Map<string, EnrichedMonitoringTradeRow[]>();
  const passthrough: DisplayMonitoringTradeRow[] = [];

  for (const row of rows) {
    const meta = synthById.get(Number(row.strategyId || 0));
    if (!meta) {
      passthrough.push({ ...row });
      continue;
    }
    const sym = String(row.symbol || '').toUpperCase();
    if (sym !== meta.baseSymbol && sym !== meta.quoteSymbol) {
      passthrough.push({ ...row, synthPairLabel: `${meta.baseSymbol}/${meta.quoteSymbol}` });
      continue;
    }
    const key = synthBucketKey(row);
    const list = buckets.get(key) || [];
    list.push(row);
    buckets.set(key, list);
  }

  const grouped: DisplayMonitoringTradeRow[] = [];
  for (const legs of Array.from(buckets.values())) {
    if (legs.length === 0) continue;
    const meta = synthById.get(Number(legs[0].strategyId || 0));
    if (!meta) {
      grouped.push(...legs.map((row) => ({ ...row })));
      continue;
    }
    const pairLabel = `${meta.baseSymbol}/${meta.quoteSymbol}`;
    const sortedLegs = [...legs].sort(
      (a, b) => Date.parse(String(b.time || '')) - Date.parse(String(a.time || '')),
    );
    const symbols = new Set(sortedLegs.map((l) => String(l.symbol || '').toUpperCase()));
    const hasBothLegs = symbols.has(meta.baseSymbol) && symbols.has(meta.quoteSymbol);

    if (hasBothLegs && sortedLegs.length >= 2) {
      const pnls = sortedLegs
        .map((l) => l.pnlPercent)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const pnlPercent = pnls.length > 0
        ? pnls.reduce((sum, v) => sum + v, 0) / pnls.length
        : sortedLegs[0].pnlPercent;
      grouped.push({
        ...sortedLegs[0],
        symbol: pairLabel,
        synthGrouped: true,
        synthPairLabel: pairLabel,
        synthLegs: sortedLegs,
        pnlPercent,
      });
    } else {
      grouped.push(...sortedLegs.map((row) => ({
        ...row,
        synthPairLabel: pairLabel,
      })));
    }
  }

  return [...grouped, ...passthrough].sort(
    (a, b) => Date.parse(String(b.time || '')) - Date.parse(String(a.time || '')),
  );
};

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
  const lastSideByKey = new Map<string, 'long' | 'short'>();
  const enriched: EnrichedMonitoringTradeRow[] = [];

  for (const row of sorted) {
    const key = positionKey(row);
    const dbEntry = row.entryPrice != null && Number.isFinite(Number(row.entryPrice)) && Number(row.entryPrice) > 0
      ? Number(row.entryPrice)
      : null;

    if (row.tradeType === 'exit') {
      const refEntry = dbEntry ?? open.get(key)?.entryPrice ?? null;
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
      lastSideByKey.set(key, row.side);
      continue;
    }

    let flowType: MonitoringFlowType = 'in';
    const prevSide = open.get(key)?.side ?? lastSideByKey.get(key);
    if (prevSide && prevSide !== row.side) {
      flowType = 'reverse';
    } else if (open.get(key)?.side === row.side) {
      // Pyramid / duplicate leg — still IN, keep first entry for PnL reference.
      flowType = 'in';
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
      entryTimeMs: Date.parse(String(row.time || '')),
    });
    lastSideByKey.set(key, row.side);
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
      .filter((r) => r.flowType === 'out')
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

import fs from 'fs';
import path from 'path';

type CandleRow = [number, number, number, number, number, number?];

const candleCache = new Map<string, CandleRow[]>();

const normSymbol = (symbol: string): string =>
  String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const normInterval = (interval: string): string => String(interval || '').trim().toLowerCase();

const cacheKey = (interval: string, symbol: string): string =>
  `${normInterval(interval)}|${normSymbol(symbol)}`;

export const getHybridCandleDir = (): string | null => {
  const raw = String(process.env.HYBRID_CANDLE_DIR || '').trim();
  return raw || null;
};

export const hybridCandleFilePath = (interval: string, symbol: string): string => {
  const root = getHybridCandleDir();
  if (!root) throw new Error('HYBRID_CANDLE_DIR is not set');
  return path.join(root, normInterval(interval), `${normSymbol(symbol)}.json`);
};

export const writeHybridCandles = (
  interval: string,
  symbol: string,
  candles: CandleRow[],
  meta?: Record<string, unknown>,
): void => {
  const root = getHybridCandleDir();
  if (!root) throw new Error('HYBRID_CANDLE_DIR is not set');
  const dir = path.join(root, normInterval(interval));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${normSymbol(symbol)}.json`);
  try {
    const st = fs.lstatSync(file);
    // Merged research packs often use symlinks; replace with a real file on write.
    if (st.isSymbolicLink()) fs.unlinkSync(file);
  } catch {
    /* missing */
  }
  const rows = Array.isArray(candles) ? candles.filter((c) => Array.isArray(c) && c.length >= 5) : [];
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  fs.writeFileSync(file, JSON.stringify({
    symbol: normSymbol(symbol),
    interval: normInterval(interval),
    candles: rows,
    exportedAt: new Date().toISOString(),
    ...meta,
  }));
  candleCache.set(cacheKey(interval, symbol), rows);
};

/** Append/overwrite by open-time. Used to roll research bundles to T-1. */
export const mergeHybridCandles = (
  interval: string,
  symbol: string,
  incoming: CandleRow[],
  meta?: Record<string, unknown>,
): { before: number; after: number; added: number } => {
  const existing = loadCachedCandles(interval, symbol) || [];
  const byT = new Map<number, CandleRow>();
  for (const row of existing) {
    const t = Number(row[0]);
    if (Number.isFinite(t)) byT.set(t, row);
  }
  const before = byT.size;
  for (const row of incoming || []) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = Number(row[0]);
    if (!Number.isFinite(t) || t <= 0) continue;
    byT.set(t, row);
  }
  const merged = [...byT.values()].sort((a, b) => Number(a[0]) - Number(b[0]));
  writeHybridCandles(interval, symbol, merged, meta);
  return { before, after: merged.length, added: Math.max(0, merged.length - before) };
};

const sliceCandles = (
  candles: CandleRow[],
  limit: number,
  startMs?: number,
  endMs?: number,
): CandleRow[] => {
  let rows = candles.filter((c) => Array.isArray(c) && c.length >= 5);
  if (startMs !== undefined) rows = rows.filter((c) => Number(c[0]) >= startMs);
  if (endMs !== undefined) rows = rows.filter((c) => Number(c[0]) <= endMs);
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  if (Number.isFinite(limit) && limit > 0 && rows.length > limit) {
    return rows.slice(rows.length - limit);
  }
  return rows;
};

const loadCachedCandles = (interval: string, symbol: string): CandleRow[] | null => {
  const key = cacheKey(interval, symbol);
  const hit = candleCache.get(key);
  if (hit) return hit;

  const root = getHybridCandleDir();
  if (!root) return null;
  const file = path.join(root, normInterval(interval), `${normSymbol(symbol)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as { candles?: CandleRow[] };
    const candles = Array.isArray(doc.candles) ? doc.candles : [];
    if (candles.length === 0) return null;
    candleCache.set(key, candles);
    return candles;
  } catch {
    return null;
  }
};

export const preloadHybridCandles = (intervals?: string[]): { loaded: number; symbols: number } => {
  const root = getHybridCandleDir();
  if (!root) return { loaded: 0, symbols: 0 };
  const ivs = intervals?.length
    ? intervals.map(normInterval)
    : fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory());
  let loaded = 0;
  const symbols = new Set<string>();
  for (const iv of ivs) {
    const dir = path.join(root, iv);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const sym = file.replace(/\.json$/i, '');
      if (loadCachedCandles(iv, sym)) {
        loaded++;
        symbols.add(sym);
      }
    }
  }
  return { loaded, symbols: symbols.size };
};

export const clearHybridCandleCache = (): void => {
  candleCache.clear();
};

export const readHybridCandles = (
  symbol: string,
  interval: string,
  opts?: { limit?: number; startMs?: number; endMs?: number },
): CandleRow[] | null => {
  const candles = loadCachedCandles(interval, symbol);
  if (!candles || candles.length === 0) return null;
  return sliceCandles(candles, Number(opts?.limit || 0) || candles.length, opts?.startMs, opts?.endMs);
};

export const listHybridCandleSymbols = (interval: string): string[] => {
  const root = getHybridCandleDir();
  if (!root) return [];
  const dir = path.join(root, normInterval(interval));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/i, ''));
};

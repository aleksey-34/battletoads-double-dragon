import { db } from '../utils/database';

export type WeexDelistPhase = 'idle' | 'watching' | 'confirmed' | 'stuck';

export type WeexDelistSymbolState = {
  phase: WeexDelistPhase;
  missTimestamps?: number[];
  confirmedAt?: number;
  stuckAt?: number;
  warnAlertAt?: number;
  criticalAlertAt?: number;
  strategiesArchived?: number;
  lastSeenAt?: number;
};

export type WeexDelistStateDoc = {
  version: 1;
  updatedAt: number;
  symbols: Record<string, WeexDelistSymbolState>;
};

const STATE_KEY = 'weex.delist.state';

let delistStateCache: WeexDelistStateDoc | null = null;
let delistStateLoadedAt = 0;

const emptyDoc = (): WeexDelistStateDoc => ({
  version: 1,
  updatedAt: Date.now(),
  symbols: {},
});

export const loadWeexDelistState = async (): Promise<WeexDelistStateDoc> => {
  try {
    const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', [STATE_KEY]);
    if (!row?.value) return emptyDoc();
    const parsed = JSON.parse(String(row.value)) as WeexDelistStateDoc;
    if (!parsed || typeof parsed !== 'object' || !parsed.symbols) return emptyDoc();
    return { ...emptyDoc(), ...parsed, symbols: parsed.symbols || {} };
  } catch {
    return emptyDoc();
  }
};

export const saveWeexDelistState = async (doc: WeexDelistStateDoc): Promise<void> => {
  const payload: WeexDelistStateDoc = {
    ...doc,
    version: 1,
    updatedAt: Date.now(),
  };
  delistStateCache = payload;
  delistStateLoadedAt = Date.now();
  await db.run(
    `INSERT INTO app_runtime_flags (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [STATE_KEY, JSON.stringify(payload)],
  );
};

export const getWeexDelistSymbolState = (
  doc: WeexDelistStateDoc,
  symbol: string,
): WeexDelistSymbolState | null => {
  const key = String(symbol || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return doc.symbols[key] || null;
};

export const isWeexDelistBlockingSymbol = (doc: WeexDelistStateDoc, symbol: string): boolean => {
  const st = getWeexDelistSymbolState(doc, symbol);
  return st?.phase === 'confirmed' || st?.phase === 'stuck';
};

export const isWeexDelistStuckSymbol = (doc: WeexDelistStateDoc, symbol: string): boolean =>
  getWeexDelistSymbolState(doc, symbol)?.phase === 'stuck';

export const refreshWeexDelistStateCache = async (): Promise<WeexDelistStateDoc> => {
  delistStateCache = await loadWeexDelistState();
  delistStateLoadedAt = Date.now();
  return delistStateCache;
};

export const getCachedWeexDelistState = async (): Promise<WeexDelistStateDoc> => {
  if (!delistStateCache || Date.now() - delistStateLoadedAt > 60_000) {
    return refreshWeexDelistStateCache();
  }
  return delistStateCache;
};

export const setWeexDelistStateCache = (doc: WeexDelistStateDoc): void => {
  delistStateCache = doc;
  delistStateLoadedAt = Date.now();
};

export const isWeexDelistBlockingSymbolSync = (symbol: string): boolean => {
  const key = String(symbol || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const st = delistStateCache?.symbols[key];
  return st?.phase === 'confirmed' || st?.phase === 'stuck';
};

export const isWeexDelistStuckSymbolSync = (symbol: string): boolean =>
  delistStateCache?.symbols[String(symbol || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()]?.phase === 'stuck';

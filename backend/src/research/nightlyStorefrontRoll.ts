/**
 * Nightly storefront roll: append hybrid candles through yesterday UTC,
 * re-stamp hamfive P1–P5 equity curves, write algofund snapshot_json,
 * then force-refresh offer-store review snapshots.
 */
import fs from 'fs';
import path from 'path';
import { initDB, db } from '../utils/database';
import logger from '../utils/logger';
import { runBacktest } from '../backtest/engine';
import { ensureExchangeClientInitialized, getMarketData } from '../bot/exchange';
import { mergeHybridCandles, getHybridCandleDir } from '../bot/hybridCandleStore';
import { refreshOfferStoreSnapshotsFromSweep } from '../saas/service';
import {
  loadAlgofundRoleBookMembers,
  normalizePairLabel,
  type AlgofundRoleBookMember,
} from '../bot/strategy/cycle/algofundSync';
import { knobsForRecipeBook } from './hamfiveRecipeKnobs';
import { tradeDriftVsLive } from './tradeDriftVsLive';

type CandleRow = [number, number, number, number, number, number?];

const yesterdayUtc = (): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const repoRoot = (): string => {
  // dist/research → backend → repo
  return path.resolve(__dirname, '..', '..', '..');
};

const resolvePaths = () => {
  const root = repoRoot();
  return {
    root,
    cryptoBundle: path.join(root, 'results/hybrid_candle_bundle_b3_hamster89_merged'),
    stocksBundle: path.join(root, 'results/hybrid_candle_bundle_weex_stocks'),
    mergedBundle: path.join(root, 'results/hybrid_candle_bundle_storefront_live'),
    recipe: path.join(root, 'scripts/hybrid/portfolio_six_data_jul2026/recipes_hamfive_aug2026.json'),
    snaps: path.join(root, 'scripts/hybrid/portfolio_six_data_jul2026/snapshots_hamfive_aug2026.json'),
    fear: path.join(root, 'results/regime_risk_aug2026/fear_boost_schedules.json'),
  };
};

const intervalMs = (iv: string): number => {
  const s = String(iv || '').toLowerCase();
  if (s.endsWith('h')) return (parseInt(s, 10) || 4) * 3_600_000;
  if (s.endsWith('d')) return (parseInt(s, 10) || 1) * 86_400_000;
  if (s.endsWith('m')) return (parseInt(s, 10) || 60) * 60_000;
  return 4 * 3_600_000;
};

const listBundleFiles = (bundleRoot: string): Array<{ interval: string; symbol: string; file: string }> => {
  const out: Array<{ interval: string; symbol: string; file: string }> = [];
  if (!fs.existsSync(bundleRoot)) return out;
  for (const iv of fs.readdirSync(bundleRoot)) {
    const dir = path.join(bundleRoot, iv);
    let st: fs.Stats;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'manifest.json')) {
      const file = path.join(dir, f);
      try {
        const lst = fs.lstatSync(file);
        if (lst.isSymbolicLink() && !fs.existsSync(file)) continue; // dangling
      } catch { continue; }
      out.push({
        interval: iv,
        symbol: f.replace(/\.json$/i, '').toUpperCase(),
        file,
      });
    }
  }
  return out;
};

const lastTsMs = (file: string): number => {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = Array.isArray(doc?.candles) ? doc.candles : [];
    if (!c.length) return 0;
    const t = Number(c[c.length - 1][0]);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
};

const ensureDir = (p: string) => fs.mkdirSync(p, { recursive: true });

const refreshMerged = (cryptoBundle: string, stocksBundle: string, mergedBundle: string): void => {
  ensureDir(mergedBundle);
  for (const src of [cryptoBundle, stocksBundle]) {
    if (!fs.existsSync(src)) continue;
    for (const iv of fs.readdirSync(src)) {
      const d = path.join(src, iv);
      if (!fs.statSync(d).isDirectory()) continue;
      const outIv = path.join(mergedBundle, iv);
      ensureDir(outIv);
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
        const dst = path.join(outIv, f);
        try { fs.unlinkSync(dst); } catch { /* missing */ }
        try { fs.symlinkSync(path.join(d, f), dst); }
        catch { fs.copyFileSync(path.join(d, f), dst); }
      }
    }
  }
};

const downsampleCurve = (curve: any[], maxPts = 120): Array<{ t: number; e: number }> => {
  if (!Array.isArray(curve) || curve.length === 0) return [];
  const mapped = curve
    .map((p) => ({ t: Number(p.t ?? p.time), e: Number(p.e ?? p.equity) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.e));
  if (mapped.length <= maxPts) return mapped.map((p) => ({ t: p.t, e: +p.e.toFixed(2) }));
  const step = Math.ceil(mapped.length / maxPts);
  const out: Array<{ t: number; e: number }> = [];
  for (let i = 0; i < mapped.length; i += step) {
    out.push({ t: mapped[i].t, e: +mapped[i].e.toFixed(2) });
  }
  const last = mapped[mapped.length - 1];
  if (!out.length || out[out.length - 1].t !== last.t) {
    out.push({ t: last.t, e: +last.e.toFixed(2) });
  }
  return out;
};

const windowRet = (curve: any[], fromDate: string, toDate: string) => {
  const fromSec = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const toSec = Date.parse(`${toDate}T23:59:59Z`) / 1000;
  if (!Array.isArray(curve) || !curve.length) return null;
  const pts = curve
    .map((p) => ({ t: Number(p.t ?? p.time), e: Number(p.e ?? p.equity) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.e))
    .sort((a, b) => a.t - b.t);
  const start = pts.find((p) => p.t >= fromSec) || pts[0];
  const inWin = pts.filter((p) => p.t >= fromSec && p.t <= toSec);
  const end = inWin.length ? inWin[inWin.length - 1] : start;
  if (!start || !end || start.e <= 0) return null;
  return {
    dateFrom: fromDate,
    dateTo: toDate,
    startEq: +start.e.toFixed(2),
    endEq: +end.e.toFixed(2),
    ret: +((end.e / start.e - 1) * 100).toFixed(2),
  };
};

const COPY_FAIR_IDS = new Set(['P1', 'P2', 'P3']);
const COPY_FAIR_API_KEY: Record<string, string> = {
  P1: 'Copy_Alex1',
  P2: 'icopy1-api',
  P3: 'arcopy1',
};
const liveFixFrom = (): string => process.env.LIVE_FIX_FROM || '2026-08-10';
const FAIR_COPY_CAPITAL = 1000;
const FAIR_BOOK_ROLES = new Set(['b3', 'ham', 'five', 'stocks']);

const pairLabelFromMember = (m: Pick<AlgofundRoleBookMember, 'baseSymbol' | 'quoteSymbol' | 'marketMode'>): string =>
  normalizePairLabel(m.baseSymbol, m.quoteSymbol, m.marketMode);

const selectFairCopyMembers = (members: AlgofundRoleBookMember[]): AlgofundRoleBookMember[] => {
  const liveRoles = new Set(
    members
      .filter((m) => !m.isArchived && m.isActive && m.autoUpdate && FAIR_BOOK_ROLES.has(m.role))
      .map((m) => m.role),
  );
  const includeStocks = liveRoles.has('stocks');
  const seen = new Set<number>();
  const out: AlgofundRoleBookMember[] = [];
  for (const m of members) {
    if (m.isArchived) continue;
    if (!FAIR_BOOK_ROLES.has(m.role)) continue;
    if (m.role === 'stocks' && !includeStocks) continue;
    if (seen.has(m.strategyId)) continue;
    seen.add(m.strategyId);
    out.push(m);
  }
  return out;
};

const summarizeBtTrades = (
  trades: Array<{ strategyId?: number; netPnl?: number; notional?: number }>,
  idToPair: Map<number, string>,
): { n: number; avgNotional: number; bySym: Record<string, { n: number; pnl: number; vol: number }> } => {
  const bySym: Record<string, { n: number; pnl: number; vol: number }> = {};
  let vol = 0;
  for (const t of trades || []) {
    const sid = Number(t.strategyId || 0);
    const sym = idToPair.get(sid) || '?';
    const ntl = Math.abs(Number(t.notional || 0));
    const pnl = Number(t.netPnl || 0);
    vol += ntl;
    const cur = bySym[sym] || { n: 0, pnl: 0, vol: 0 };
    cur.n += 1;
    cur.pnl += pnl;
    cur.vol += ntl;
    bySym[sym] = cur;
  }
  const n = (trades || []).length;
  return { n, avgNotional: n > 0 ? vol / n : 0, bySym };
};

const fetchLiveEntryStats = async (
  apiKeyName: string,
  fromDate: string,
  toDate: string,
  strategyIds?: number[],
) => {
  const idFilter = (strategyIds || []).filter((id) => Number.isFinite(id) && id > 0);
  const idClause = idFilter.length
    ? ` AND lte.strategy_id IN (${idFilter.map(() => '?').join(',')})`
    : '';
  // Deduplicated count: for synthetic strategies, both legs fire within the same second.
  // We count DISTINCT (strategy_id, second) as one cycle, so synth doesn't double-count.
  const rows = await db.all(
    `SELECT
        lte.strategy_id AS sid,
        COALESCE(s.base_symbol, '') AS base_symbol,
        COALESCE(s.quote_symbol, '') AS quote_symbol,
        COALESCE(s.market_mode, '') AS market_mode,
        COUNT(DISTINCT CAST(lte.actual_time / 1000 AS INTEGER)) AS n,
        SUM(ABS(COALESCE(lte.actual_price, 0) * COALESCE(lte.position_size, 0))) AS vol
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ?
       AND COALESCE(lte.trade_type, '') = 'entry'
       AND COALESCE(lte.event_origin, 'strategy_signal') = 'strategy_signal'
       AND lte.actual_time >= (strftime('%s', ?) * 1000)
       AND lte.actual_time <  (strftime('%s', ?) * 1000)${idClause}
     GROUP BY lte.strategy_id`,
    idFilter.length
      ? [apiKeyName, `${fromDate} 00:00:00`, `${toDate} 23:59:59`, ...idFilter]
      : [apiKeyName, `${fromDate} 00:00:00`, `${toDate} 23:59:59`],
  ) as Array<{
    sid?: number;
    base_symbol?: string;
    quote_symbol?: string;
    market_mode?: string;
    n?: number;
    vol?: number;
  }>;
  const bySym: Record<string, { n: number; vol: number }> = {};
  let n = 0;
  let vol = 0;
  for (const r of rows || []) {
    const pair = normalizePairLabel(
      String(r.base_symbol || ''),
      String(r.quote_symbol || ''),
      String(r.market_mode || ''),
    );
    const cn = Math.max(0, Math.floor(Number(r.n || 0)));
    const cv = Math.max(0, Number(r.vol || 0));
    const cur = bySym[pair] || { n: 0, vol: 0 };
    cur.n += cn;
    cur.vol += cv;
    bySym[pair] = cur;
    n += cn;
    vol += cv;
  }
  return { n, vol, avgNotional: n > 0 ? vol / n : 0, bySym };
};

const packFairRun = (
  r: { summary?: any; equityCurve?: any[]; trades?: any[] },
  fromDate: string,
  toDate: string,
  capital: number,
  idToSym: Map<number, string>,
) => {
  const s = r.summary || {};
  const trades = summarizeBtTrades(r.trades || [], idToSym);
  const skippedDetails = (r.summary as any)?.skippedStrategyDetails as Array<{ strategyId?: number }> | undefined;
  const skippedStrategyIds = (skippedDetails || [])
    .map((item) => Number(item.strategyId || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  return {
    dateFrom: fromDate,
    dateTo: toDate,
    capital,
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    trades: trades.n,
    avgNotional: +trades.avgNotional.toFixed(2),
    skippedOp: Number(s.skippedByPositionLimit || 0),
    skippedPair: Number(s.skippedByPairLock || 0),
    skippedSymbols: Number(s.skippedStrategies || 0),
    skippedStrategyIds,
    bySym: trades.bySym,
  };
};

const collectHamfiveSymbols = (recipe: any): Set<string> => {
  const out = new Set<string>();
  for (const u of Object.values(recipe?.universes || {}) as any[]) {
    for (const s of (u?.symbols || u?.apiSymbols || [])) {
      out.add(String(s).toUpperCase());
    }
  }
  // core legs always kept rolling even if recipe omits them
  for (const s of [
    'BTCUSDT', 'ETHUSDT', 'APEUSDT', 'BCHUSDT', 'INJUSDT', 'SUIUSDT', 'WLDUSDT',
    'ADAUSDT', 'BNBUSDT', 'COMPUSDT', 'EIGENUSDT', 'ONDOUSDT', 'ORDIUSDT', 'TIAUSDT', 'XRPUSDT',
    'ARBUSDT', 'DOGEUSDT', 'NEARUSDT', 'SEIUSDT', 'SPXUSDT',
  ]) out.add(s);
  return out;
};

const appendCandlesThrough = async (opts: {
  dateTo: string;
  cryptoBundle: string;
  stocksBundle: string;
  symbols: Set<string>;
}): Promise<{ series: number; ok: number; fail: number; added: number }> => {
  const dateToMs = Date.parse(`${opts.dateTo}T23:59:59Z`);
  const keys = String(process.env.APPEND_KEYS || 'Copy_Alex1,BTDD_D1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const files = [
    ...listBundleFiles(opts.cryptoBundle).map((f) => ({ ...f, bundle: opts.cryptoBundle })),
    ...listBundleFiles(opts.stocksBundle).map((f) => ({ ...f, bundle: opts.stocksBundle })),
  ].filter((f) => opts.symbols.has(f.symbol));

  const tasks = new Map<string, { interval: string; symbol: string; lastMs: number; files: string[]; bundle: string }>();
  for (const row of files) {
    const key = `${row.interval}|${row.symbol}`;
    const ts = lastTsMs(row.file);
    const prev = tasks.get(key);
    if (!prev || ts > prev.lastMs) {
      tasks.set(key, {
        interval: row.interval,
        symbol: row.symbol,
        lastMs: ts,
        files: [row.file],
        bundle: row.bundle,
      });
    } else {
      prev.files.push(row.file);
    }
  }

  const stale = [...tasks.values()].filter((t) => t.lastMs + intervalMs(t.interval) < dateToMs);
  let ok = 0;
  let fail = 0;
  let added = 0;

  // Process with small concurrency to avoid exchange 429s.
  let idx = 0;
  const worker = async () => {
    while (idx < stale.length) {
      const i = idx;
      idx += 1;
      const task = stale[i];
      if (!task) break;
      const startMs = Number(task.lastMs || 0) + 1;
      const need = Math.min(
        20_000,
        Math.max(50, Math.ceil((dateToMs - startMs) / intervalMs(task.interval)) + 5),
      );
      let best: CandleRow[] = [];
      let via = '';
      for (const key of keys) {
        try {
          await ensureExchangeClientInitialized(key);
          const candles = await getMarketData(key, task.symbol, task.interval, need, {
            startMs,
            endMs: dateToMs,
          } as any);
          const list = (Array.isArray(candles) ? candles : []) as CandleRow[];
          if (list.length > best.length) {
            best = list;
            via = key;
          }
          if (list.length >= Math.max(10, need * 0.5)) break;
        } catch {
          // try next key
        }
      }
      if (!best.length) {
        fail += 1;
        logger.warn(`[nightlyStorefrontRoll] candle miss ${task.interval}/${task.symbol}`);
        continue;
      }
      ok += 1;
      process.env.HYBRID_CANDLE_DIR = task.bundle;
      const r = mergeHybridCandles(task.interval, task.symbol, best, {
        appendedTo: opts.dateTo,
        via,
        source: 'nightly_storefront_roll',
      });
      added += r.added;
      // keep sibling copies in sync when the same series lives in both packs
      for (const file of task.files) {
        if (path.dirname(path.dirname(file)) === task.bundle) continue;
        try {
          const otherRoot = path.dirname(path.dirname(file));
          process.env.HYBRID_CANDLE_DIR = otherRoot;
          mergeHybridCandles(task.interval, task.symbol, best, {
            appendedTo: opts.dateTo,
            via,
            source: 'nightly_storefront_roll',
          });
        } catch {
          /* best-effort */
        }
      }
    }
  };

  await Promise.all([worker(), worker(), worker()]);
  return { series: stale.length, ok, fail, added };
};

const applySnapshotsToDb = async (snapsPath: string, recipePath: string): Promise<number> => {
  const snaps = JSON.parse(fs.readFileSync(snapsPath, 'utf8'));
  const recipes = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
  const now = new Date().toISOString();
  let n = 0;
  for (const pf of recipes.portfolios || []) {
    const snap = snaps[pf.id];
    if (!snap || !pf.setKey) continue;
    const row = await db.get(
      'SELECT id, metadata_json FROM algofund_portfolios WHERE set_key = ?',
      [pf.setKey],
    ) as { id?: number; metadata_json?: string } | undefined;
    if (!row?.id) continue;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(String(row.metadata_json || '{}')); } catch { meta = {}; }
    meta.books = (pf.books || []).map((book: any) => knobsForRecipeBook(recipes, book));
    meta.bt = {
      ret: snap.ret,
      dd: snap.dd,
      capital: snap.capital,
      method: snap.method,
      dateFrom: snap.dateFrom,
      dateTo: snap.dateTo,
      liveWindow: snap.liveWindow,
      fairLive: snap.fairLive || null,
      fairSinceFix: snap.fairSinceFix || null,
      tradeDrift: snap.tradeDrift || null,
    };
    await db.run(
      `UPDATE algofund_portfolios
       SET snapshot_json = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(snap), JSON.stringify(meta), now, row.id],
    );
    const cardCode = `CARD::${String(pf.setKey).toUpperCase()}`;
    const card = await db.get(
      'SELECT id, metadata_json FROM master_cards WHERE code = ?',
      [cardCode],
    ) as { id?: number; metadata_json?: string } | undefined;
    if (card?.id) {
      let cardMeta: Record<string, unknown> = {};
      try { cardMeta = JSON.parse(String(card.metadata_json || '{}')); } catch { cardMeta = {}; }
      cardMeta.books = meta.books;
      cardMeta.pack = cardMeta.pack || meta.pack || 'hamfive_aug2026';
      await db.run(
        `UPDATE master_cards SET metadata_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(cardMeta), now, card.id],
      );
    }
    n += 1;
  }
  return n;
};

const stampPortfolios = async (opts: {
  dateTo: string;
  liveFrom: string;
  dateFrom: string;
  recipePath: string;
  snapsPath: string;
  fearPath: string;
  mergedBundle: string;
  apiKeyName: string;
}): Promise<{ stamped: number; cards: Array<{ id: string; ret: number; dd: number; liveWin: number | null }> }> => {
  if (!fs.existsSync(opts.fearPath)) {
    throw new Error(`missing fear schedule: ${opts.fearPath}`);
  }
  if (!fs.existsSync(opts.recipePath)) {
    throw new Error(`missing recipe: ${opts.recipePath}`);
  }

  process.env.HYBRID_CANDLE_DIR = opts.mergedBundle;
  process.env.HYBRID_QUIET = process.env.HYBRID_QUIET || '1';
  if (!process.env.MRS2_BT_SAME_BAR_EXIT) process.env.MRS2_BT_SAME_BAR_EXIT = 'block';

  const schedules = JSON.parse(fs.readFileSync(opts.fearPath, 'utf8'));
  const fearBoost = {
    enabled: true,
    lotMultiplier: schedules.lotMultiplier || 1.25,
    activeDayStartsMs: schedules?.variants?.fear_union?.activeDayStartsMs || [],
  };
  const recipes = JSON.parse(fs.readFileSync(opts.recipePath, 'utf8'));
  const snaps = fs.existsSync(opts.snapsPath)
    ? JSON.parse(fs.readFileSync(opts.snapsPath, 'utf8'))
    : {};

  const b3Id = Number(recipes?.sharedB3?.systemIdSource || 205);
  const b3Rows = await db.all(
    `SELECT s.id FROM trading_system_members m
     JOIN strategies s ON s.id = m.strategy_id
     WHERE m.system_id = ? AND COALESCE(m.is_enabled, 1) = 1`,
    [b3Id],
  ) || [];
  const b3Ids = b3Rows.map((r: any) => Number(r.id)).filter((n: number) => Number.isFinite(n) && n > 0);

  const hasCandle = (iv: string, sym: string): boolean =>
    fs.existsSync(path.join(opts.mergedBundle, String(iv).toLowerCase(), `${String(sym).toUpperCase()}.json`));

  // Recipe IDs are from the laptop stamp DB and drift on VPS. Resolve live BTDD_D1
  // strategies by (symbol, interval, strategy_type) from hamfive_legs_aug2026.json.
  const legsPath = path.join(path.dirname(opts.recipePath), 'hamfive_legs_aug2026.json');
  const legsDoc = fs.existsSync(legsPath)
    ? JSON.parse(fs.readFileSync(legsPath, 'utf8'))
    : { ham: [], five: [], stocks: [] };
  const legsBySym = new Map<string, any>();
  for (const group of ['ham', 'five', 'stocks']) {
    for (const leg of legsDoc[group] || []) {
      const sym = String(leg?.base_symbol || '').toUpperCase();
      if (sym) legsBySym.set(`${group}|${sym}`, leg);
    }
  }

  const resolveLiveId = async (leg: any): Promise<number | null> => {
    const sym = String(leg?.base_symbol || '').toUpperCase();
    const interval = String(leg?.interval || '').trim();
    const stype = String(leg?.strategy_type || '').trim();
    if (!sym || !interval) return null;
    if (!hasCandle(interval, sym)) return null;
    const row = await db.get(
      `SELECT s.id
       FROM strategies s
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE a.name = ?
         AND UPPER(REPLACE(REPLACE(COALESCE(s.base_symbol,''),'/',''),'-','')) = ?
         AND LOWER(COALESCE(s.interval,'')) = LOWER(?)
         AND (
           ? = '' OR LOWER(COALESCE(s.strategy_type,'')) = LOWER(?)
           OR LOWER(COALESCE(s.name,'')) LIKE '%' || LOWER(?) || '%'
         )
       ORDER BY COALESCE(s.is_archived, 0) ASC,
                COALESCE(s.is_active, 0) DESC,
                s.id DESC
       LIMIT 1`,
      [opts.apiKeyName, sym, interval, stype, stype, stype],
    ) as { id?: number } | undefined;
    const id = Number(row?.id || 0);
    return Number.isFinite(id) && id > 0 ? id : null;
  };

  const uniCache: Record<string, number[]> = {};
  for (const [key, u] of Object.entries(recipes.universes || {}) as Array<[string, any]>) {
    const from = String(u?.from || '').trim().toLowerCase() || 'ham';
    const symbols: string[] = (u?.symbols || u?.apiSymbols || []).map((s: any) => String(s).toUpperCase());
    const out: number[] = [];
    const seen = new Set<number>();

    // 1) Prefer legs catalog matched by universe symbols.
    for (const sym of symbols) {
      const leg = legsBySym.get(`${from}|${sym}`);
      if (!leg) continue;
      const id = await resolveLiveId(leg);
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }

    // 2) Fallback: recipe ids if they still point at the right symbol on this DB.
    for (const id of (u?.ids || [])) {
      const sid = Number(id);
      if (!Number.isFinite(sid) || sid <= 0 || seen.has(sid)) continue;
      const row = await db.get(
        `SELECT s.id, s.base_symbol, s.interval
         FROM strategies s JOIN api_keys a ON a.id = s.api_key_id
         WHERE s.id = ? AND a.name = ?`,
        [sid, opts.apiKeyName],
      ) as any;
      if (!row) continue;
      const sym = String(row.base_symbol || '').toUpperCase();
      if (symbols.length && !symbols.includes(sym)) continue;
      if (!hasCandle(row.interval, sym)) continue;
      seen.add(sid);
      out.push(sid);
    }

    uniCache[key] = out;
    logger.info(`[nightlyStorefrontRoll] universe ${key} resolved=${out.length}/${symbols.length || (u?.ids || []).length}`);
  }

  const tierCb = {
    enabled: true,
    peakWindowDays: 30,
    ddTriggerPercent: 8,
    lotMultiplier: 0.5,
    pauseDays: 14,
    applyToStrategyTypes: ['zz_breakout'],
  };

  const cards: Array<{ id: string; ret: number; dd: number; liveWin: number | null }> = [];
  // Stamp every recipe portfolio that lives in DB (vitrine P1–P5 + whale-personal P6).
  for (const pf of (recipes.portfolios || [])) {
    const ids: number[] = [];
    const maxOpenPositionsByBook: Record<string, number> = {};
    const bookKeyByStrategyId: Record<string, string> = {};
    const lotPercentMultiplierByStrategyId: Record<string, number> = {};
    const reinvestPercentByStrategyId: Record<string, number> = {};
    let anyReinvest = false;
    let deposit = 0;

    for (const book of (pf.books || [])) {
      const knobs = knobsForRecipeBook(recipes, book);
      let bookIds: number[] = [];
      if (book.key === 'b3') {
        bookIds = b3Ids;
      } else if (book.universe) {
        bookIds = uniCache[book.universe] || [];
      }
      if (!bookIds.length) continue;
      if (knobs.ri > 0) anyReinvest = true;
      deposit += Number(book.initial || 0);
      if (knobs.op > 0) maxOpenPositionsByBook[book.key] = knobs.op;
      for (const sid of bookIds) {
        ids.push(sid);
        bookKeyByStrategyId[String(sid)] = book.key;
        if (knobs.lot > 0) lotPercentMultiplierByStrategyId[String(sid)] = knobs.lot;
        reinvestPercentByStrategyId[String(sid)] = knobs.ri;
      }
    }

    const uniqIds = [...new Set(ids)];
    logger.info(`[nightlyStorefrontRoll] BT ${pf.id} n=${uniqIds.length} dep=${deposit} books=${Object.keys(maxOpenPositionsByBook).join(',') || '-'}`);
    if (!uniqIds.length || deposit <= 0) continue;

    const r = await runBacktest({
      apiKeyName: opts.apiKeyName,
      mode: 'portfolio',
      strategyIds: uniqIds,
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      bars: 14000,
      warmupBars: 120,
      skipMissingSymbols: true,
      initialBalance: deposit,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      maxOpenPositions: 0,
      maxOpenPositionsByBook,
      bookKeyByStrategyId,
      lotPercentOverride: 1,
      lotPercentMultiplierByStrategyId,
      enablePairLock: true,
      maxDepositOverride: anyReinvest ? deposit * 50 : 0,
      reinvestPercentByStrategyId,
      portfolioCircuitBreaker: tierCb as any,
      researchLotSchedule: fearBoost as any,
    } as any);

    const s = r.summary || {};
    const rawCurve = r.equityCurve || [];
    const curve = downsampleCurve(rawCurve, 120);
    const liveWindow = windowRet(rawCurve, opts.liveFrom, opts.dateTo);
    const prev = snaps[pf.id] || {};
    const next: Record<string, unknown> = {
      ...prev,
      ret: +Number(s.totalReturnPercent || prev.ret || 0).toFixed(2),
      dd: +Number(s.maxDrawdownPercent || prev.dd || 0).toFixed(2),
      pf: +Number(s.profitFactor || prev.pf || 0).toFixed(3),
      trades: +((s as any).tradesCount || (s as any).totalTrades || prev.trades || 0),
      capital: deposit,
      method: 'hamfive_card_books_lot_ri',
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      liveWindow,
      curve,
    };

    if (COPY_FAIR_IDS.has(String(pf.id))) {
      const copyKey = COPY_FAIR_API_KEY[String(pf.id)];
      const fixFrom = liveFixFrom();
      const lotByRole: Record<string, number> = {};
      const opByRole: Record<string, number> = {};
      const riByRole: Record<string, number> = {};
      for (const book of (pf.books || [])) {
        const knobs = knobsForRecipeBook(recipes, book);
        if (!knobs.key) continue;
        if (knobs.lot > 0) lotByRole[knobs.key] = knobs.lot;
        if (knobs.op > 0) opByRole[knobs.key] = knobs.op;
        riByRole[knobs.key] = knobs.ri;
      }

      const liveMembers = copyKey
        ? selectFairCopyMembers(await loadAlgofundRoleBookMembers(copyKey))
        : [];
      const fairIds = liveMembers.map((m) => m.strategyId);
      const idToPair = new Map<number, string>();
      const fairBookKeyByStrategyId: Record<string, string> = {};
      const fairLotMultByStrategyId: Record<string, number> = {};
      const fairRiByStrategyId: Record<string, number> = {};
      const fairMaxOpenByBook: Record<string, number> = {};
      let fairAnyReinvest = false;
      for (const m of liveMembers) {
        idToPair.set(m.strategyId, pairLabelFromMember(m));
        fairBookKeyByStrategyId[String(m.strategyId)] = m.role;
        const lot = Number(lotByRole[m.role] || 0);
        if (lot > 0) fairLotMultByStrategyId[String(m.strategyId)] = lot;
        const op = Number(opByRole[m.role] || 0);
        if (op > 0) fairMaxOpenByBook[m.role] = op;
        const ri = Number(riByRole[m.role] || 0);
        fairRiByStrategyId[String(m.strategyId)] = ri;
        if (ri > 0) fairAnyReinvest = true;
      }

      const missingCandles: string[] = [];
      for (const m of liveMembers) {
        const iv = String(m.interval || '').trim();
        const base = String(m.baseSymbol || '').replace(/[/-]/g, '').toUpperCase();
        const quote = String(m.quoteSymbol || '').replace(/[/-]/g, '').toUpperCase();
        if (!base || !hasCandle(iv, base)) {
          missingCandles.push(`#${m.strategyId} ${pairLabelFromMember(m)} ${iv || '?'} base`);
        }
        if (String(m.marketMode || '').toLowerCase() !== 'mono' && quote && quote !== base && !hasCandle(iv, quote)) {
          missingCandles.push(`#${m.strategyId} ${pairLabelFromMember(m)} ${iv || '?'} quote=${quote}`);
        }
      }
      const synthPairs = liveMembers
        .filter((m) => String(m.marketMode || '').toLowerCase() !== 'mono' && m.quoteSymbol)
        .map((m) => pairLabelFromMember(m));
      logger.info(
        `[nightlyStorefrontRoll] fair BT ${pf.id} copy=${copyKey || '-'} `
        + `liveIds=${fairIds.length} roles=${[...new Set(liveMembers.map((m) => m.role))].join(',') || '-'} `
        + `synth=${synthPairs.join(',') || 'none'} missingCandles=${missingCandles.length}`,
      );
      if (missingCandles.length) {
        logger.warn(
          `[nightlyStorefrontRoll] fair ${pf.id} hybrid candle gaps (skipMissingSymbols=true): `
          + `${missingCandles.slice(0, 12).join('; ')}`,
        );
      }

      try {
        await ensureExchangeClientInitialized(opts.apiKeyName);
        if (copyKey) await ensureExchangeClientInitialized(copyKey);
      } catch (initErr) {
        logger.warn(`[nightlyStorefrontRoll] fair ${pf.id} exchange init: ${(initErr as Error).message}`);
      }

      const packFailedFair = (fromDate: string, toDate: string, error: string) => ({
        dateFrom: fromDate,
        dateTo: toDate,
        capital: FAIR_COPY_CAPITAL,
        ret: null as number | null,
        dd: null as number | null,
        trades: 0,
        avgNotional: 0,
        skippedOp: 0,
        skippedPair: 0,
        skippedSymbols: 0,
        skippedStrategyIds: [] as number[],
        bySym: {} as Record<string, { n: number; pnl: number; vol: number }>,
        error,
      });

      const runFair = async (fromDate: string) => {
        if (!copyKey) {
          return packFailedFair(fromDate, opts.dateTo, 'no copy api key');
        }
        if (!fairIds.length) {
          logger.error(
            `[nightlyStorefrontRoll] fair ${pf.id} 0 live strategy IDs on ${copyKey} `
            + '(expected ALGOFUND::{slug}::{b3,ham,five,stocks} books). Not a missing-candle issue.',
          );
          return packFailedFair(fromDate, opts.dateTo, `no live book IDs for ${copyKey}`);
        }
        try {
          const result = await runBacktest({
            apiKeyName: copyKey,
            // Copy keys are WEEX; hybrid candles + Bybit history live on BTDD_D1.
            dataApiKeyName: opts.apiKeyName,
            mode: 'portfolio',
            strategyIds: fairIds,
            dateFrom: fromDate,
            dateTo: opts.dateTo,
            bars: 4000,
            warmupBars: 120,
            // Skip legs with short history instead of failing whole fair run (freqX).
            skipMissingSymbols: true,
            initialBalance: FAIR_COPY_CAPITAL,
            commissionPercent: 0.1,
            slippagePercent: 0.05,
            maxOpenPositions: 0,
            maxOpenPositionsByBook: fairMaxOpenByBook,
            bookKeyByStrategyId: fairBookKeyByStrategyId,
            lotPercentOverride: 1,
            lotPercentMultiplierByStrategyId: fairLotMultByStrategyId,
            enablePairLock: true,
            maxDepositOverride: fairAnyReinvest ? FAIR_COPY_CAPITAL * 50 : 0,
            reinvestPercentByStrategyId: fairRiByStrategyId,
            portfolioCircuitBreaker: tierCb as any,
            researchLotSchedule: fearBoost as any,
          } as any);
          const packed = packFairRun(result, fromDate, opts.dateTo, FAIR_COPY_CAPITAL, idToPair);
          if (packed.trades === 0) {
            logger.warn(
              `[nightlyStorefrontRoll] fair ${pf.id} ${fromDate}..${opts.dateTo} produced 0 trades `
              + `on ${fairIds.length} live IDs (copy=${copyKey}). Check skip/ID mapping, not hybrid files `
              + `if BCHUSDT/APEUSDT 4h exist. missingCandles=${missingCandles.length}`,
            );
          }
          return packed;
        } catch (err) {
          const msg = (err as Error).message || String(err);
          logger.error(`[nightlyStorefrontRoll] fair ${pf.id} ${fromDate}..${opts.dateTo} FAILED: ${msg}`);
          return packFailedFair(fromDate, opts.dateTo, msg);
        }
      };

      logger.info(`[nightlyStorefrontRoll] fair BT ${pf.id} $1000 ${opts.liveFrom}..${opts.dateTo} + since ${fixFrom} (live books, skipMissing=false)`);
      const fairLive = await runFair(opts.liveFrom);
      const fairSinceFix = await runFair(fixFrom);
      next.fairLive = fairLive;
      next.fairSinceFix = fairSinceFix;
      if (copyKey) {
        const ranIdsFull = fairIds.filter((id) => !(fairLive.skippedStrategyIds || []).includes(id));
        const ranIdsFix = fairIds.filter((id) => !(fairSinceFix.skippedStrategyIds || []).includes(id));
        const liveFull = await fetchLiveEntryStats(copyKey, opts.liveFrom, opts.dateTo, ranIdsFull);
        const liveFix = await fetchLiveEntryStats(copyKey, fixFrom, opts.dateTo, ranIdsFix);
        next.tradeDrift = {
          full: tradeDriftVsLive(fairLive, liveFull),
          sinceFix: tradeDriftVsLive(fairSinceFix, liveFix),
          liveFull: { n: liveFull.n, avgNotional: +liveFull.avgNotional.toFixed(2) },
          liveSinceFix: { n: liveFix.n, avgNotional: +liveFix.avgNotional.toFixed(2) },
          comparableLegsFull: ranIdsFull.length,
          comparableLegsSinceFix: ranIdsFix.length,
          skippedLegsFull: (fairLive.skippedStrategyIds || []).length,
          skippedLegsSinceFix: (fairSinceFix.skippedStrategyIds || []).length,
        };
      }
    }

    snaps[pf.id] = next;
    cards.push({
      id: String(pf.id),
      ret: Number(next.ret),
      dd: Number(next.dd),
      liveWin: liveWindow ? liveWindow.ret : null,
    });
  }

  fs.writeFileSync(opts.snapsPath, JSON.stringify(snaps, null, 2));
  return { stamped: cards.length, cards };
};

/** Ops: stamp-only / A/B without going through the scheduler wrapper. */
export const stampStorefrontPortfolios = stampPortfolios;
export const applyStorefrontSnapshots = applySnapshotsToDb;
export const getStorefrontRollPaths = resolvePaths;

export const runNightlyStorefrontRoll = async (): Promise<{
  status: 'done' | 'failed';
  details: Record<string, unknown>;
}> => {
  const dateTo = process.env.DATE_TO || yesterdayUtc();
  const liveFrom = process.env.LIVE_FROM || '2026-07-30';
  const dateFrom = process.env.DATE_FROM || '2024-03-17';
  const apiKeyName = process.env.STOREFRONT_BT_KEY || 'BTDD_D1';
  const paths = resolvePaths();
  const skipAppend = String(process.env.SKIP_CANDLE_APPEND || '').trim() === '1';

  if (!fs.existsSync(paths.cryptoBundle) && !fs.existsSync(paths.stocksBundle)) {
    throw new Error(
      `Candle packs missing on VPS. Seed results/hybrid_candle_bundle_b3_hamster89_merged `
      + `and results/hybrid_candle_bundle_weex_stocks first.`,
    );
  }

  await initDB();

  const recipe = JSON.parse(fs.readFileSync(paths.recipe, 'utf8'));
  const symbols = collectHamfiveSymbols(recipe);

  logger.info(`[nightlyStorefrontRoll] start dateTo=${dateTo} symbols=${symbols.size} skipAppend=${skipAppend ? 1 : 0}`);
  const append = skipAppend
    ? { series: 0, ok: 0, fail: 0, added: 0 }
    : await appendCandlesThrough({
      dateTo,
      cryptoBundle: paths.cryptoBundle,
      stocksBundle: paths.stocksBundle,
      symbols,
    });
  if (!skipAppend) {
    refreshMerged(paths.cryptoBundle, paths.stocksBundle, paths.mergedBundle);
  }

  const stamp = await stampPortfolios({
    dateTo,
    liveFrom,
    dateFrom,
    recipePath: paths.recipe,
    snapsPath: paths.snaps,
    fearPath: paths.fear,
    mergedBundle: paths.mergedBundle,
    apiKeyName,
  });
  const applied = await applySnapshotsToDb(paths.snaps, paths.recipe);

  let offerRefresh: Record<string, unknown> = {};
  try {
    const snapshotResult = await refreshOfferStoreSnapshotsFromSweep({
      force: true,
      reason: 'nightly_storefront_roll',
    });
    offerRefresh = {
      ok: snapshotResult.ok,
      skipped: snapshotResult.skipped,
      systemsUpdated: snapshotResult.systemsUpdated,
      offersUpdated: snapshotResult.offersUpdated,
    };
  } catch (err) {
    offerRefresh = { ok: false, error: (err as Error).message };
    logger.error(`[nightlyStorefrontRoll] offer refresh failed: ${(err as Error).message}`);
  }

  // clear hybrid env so runtime doesn't keep research dir
  if (getHybridCandleDir() === paths.mergedBundle || getHybridCandleDir() === paths.cryptoBundle) {
    delete process.env.HYBRID_CANDLE_DIR;
  }

  const details = {
    dateTo,
    append,
    stamped: stamp.stamped,
    cards: stamp.cards,
    portfoliosUpdated: applied,
    offerRefresh,
    hybridCandleDir: paths.mergedBundle,
  };
  logger.info(`[nightlyStorefrontRoll] done ${JSON.stringify({
    dateTo,
    append,
    stamped: stamp.stamped,
    portfoliosUpdated: applied,
    offerRefresh,
  })}`);
  return { status: 'done', details };
};

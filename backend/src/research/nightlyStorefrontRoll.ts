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
    meta.bt = {
      ret: snap.ret,
      dd: snap.dd,
      capital: snap.capital,
      method: snap.method,
      dateFrom: snap.dateFrom,
      dateTo: snap.dateTo,
      liveWindow: snap.liveWindow,
    };
    await db.run(
      `UPDATE algofund_portfolios
       SET snapshot_json = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(snap), JSON.stringify(meta), now, row.id],
    );
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
  for (const pf of (recipes.portfolios || []).filter((p: any) => p.storefront)) {
    const ids: number[] = [];
    const maxOpenPositionsByBook: Record<string, number> = {};
    const bookKeyByStrategyId: Record<string, string> = {};
    const lotPercentMultiplierByStrategyId: Record<string, number> = {};
    let maxRi = 0;
    let deposit = 0;

    for (const book of (pf.books || []).filter((b: any) => b.key !== 'stocks')) {
      let bookIds: number[] = [];
      let lot = book.lot;
      let op = book.op;
      let ri = book.ri || 0;
      if (book.key === 'b3') {
        bookIds = b3Ids;
        lot = recipes.sharedB3.lot;
        op = recipes.sharedB3.op;
        ri = recipes.sharedB3.ri;
      } else if (book.universe) {
        bookIds = uniCache[book.universe] || [];
      }
      if (!bookIds.length) continue;
      maxRi = Math.max(maxRi, ri || 0);
      deposit += Number(book.initial || 0);
      if (op > 0) maxOpenPositionsByBook[book.key] = op;
      for (const sid of bookIds) {
        ids.push(sid);
        bookKeyByStrategyId[String(sid)] = book.key;
        if (lot > 0) lotPercentMultiplierByStrategyId[String(sid)] = lot / 2;
      }
    }

    const uniqIds = [...new Set(ids)];
    logger.info(`[nightlyStorefrontRoll] BT ${pf.id} n=${uniqIds.length} dep=${deposit} ri=${maxRi}`);
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
      lotPercentOverride: 2,
      lotPercentMultiplierByStrategyId,
      enablePairLock: true,
      maxDepositOverride: maxRi > 0 ? deposit * 50 : 0,
      reinvestPercentOverride: maxRi,
      portfolioCircuitBreaker: tierCb as any,
      researchLotSchedule: fearBoost as any,
    } as any);

    const s = r.summary || {};
    const rawCurve = r.equityCurve || [];
    const curve = downsampleCurve(rawCurve, 120);
    const liveWindow = windowRet(rawCurve, opts.liveFrom, opts.dateTo);
    const prev = snaps[pf.id] || {};
    snaps[pf.id] = {
      ...prev,
      ret: +Number(s.totalReturnPercent || prev.ret || 0).toFixed(2),
      dd: +Number(s.maxDrawdownPercent || prev.dd || 0).toFixed(2),
      pf: +Number(s.profitFactor || prev.pf || 0).toFixed(3),
      trades: +((s as any).tradesCount || (s as any).totalTrades || prev.trades || 0),
      capital: deposit,
      method: 'hamfive_cb_fear_union_ri100',
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      liveWindow,
      curve,
    };
    cards.push({
      id: String(pf.id),
      ret: snaps[pf.id].ret,
      dd: snaps[pf.id].dd,
      liveWin: liveWindow ? liveWindow.ret : null,
    });
  }

  fs.writeFileSync(opts.snapsPath, JSON.stringify(snaps, null, 2));
  return { stamped: cards.length, cards };
};

export const runNightlyStorefrontRoll = async (): Promise<{
  status: 'done' | 'failed';
  details: Record<string, unknown>;
}> => {
  const dateTo = process.env.DATE_TO || yesterdayUtc();
  const liveFrom = process.env.LIVE_FROM || '2026-07-30';
  const dateFrom = process.env.DATE_FROM || '2024-03-17';
  const apiKeyName = process.env.STOREFRONT_BT_KEY || 'BTDD_D1';
  const paths = resolvePaths();

  if (!fs.existsSync(paths.cryptoBundle) && !fs.existsSync(paths.stocksBundle)) {
    throw new Error(
      `Candle packs missing on VPS. Seed results/hybrid_candle_bundle_b3_hamster89_merged `
      + `and results/hybrid_candle_bundle_weex_stocks first.`,
    );
  }

  await initDB();

  const recipe = JSON.parse(fs.readFileSync(paths.recipe, 'utf8'));
  const symbols = collectHamfiveSymbols(recipe);

  logger.info(`[nightlyStorefrontRoll] start dateTo=${dateTo} symbols=${symbols.size}`);
  const append = await appendCandlesThrough({
    dateTo,
    cryptoBundle: paths.cryptoBundle,
    stocksBundle: paths.stocksBundle,
    symbols,
  });
  refreshMerged(paths.cryptoBundle, paths.stocksBundle, paths.mergedBundle);

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

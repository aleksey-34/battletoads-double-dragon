#!/usr/bin/env node
/**
 * WEEX stock short-MA sleeve: screen len∈{2,3} shift∈{0.2%,0.5%},
 * book BT, dump-stress, and portfolio before/after (equity-sum dual-OP).
 *
 *   node scripts/hybrid/research_stock_sleeve_shortma_jul2026.cjs
 *   PUBLISH=1 BTDD_DB_PATH=... node scripts/hybrid/research_stock_sleeve_shortma_jul2026.cjs
 */
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const STOCK_BUNDLE = process.env.HYBRID_CANDLE_DIR_STOCKS
  || path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');
const FLAT_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_flat_comp');
const HAM_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_hamster89');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_stocks_merged');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes.json');
const WF = path.join(REPO, 'results/hamster_compound_system89_jul2026/weex_mrs_engine_wf_postfill.json');
const OUT_DIR = path.join(REPO, 'results/weex_mrs_stocks_jul2026');
const OUT = path.join(OUT_DIR, 'stock_sleeve_shortma_portfolio_compare.json');
const OUT_MD = path.join(OUT_DIR, 'stock_sleeve_shortma_portfolio_compare.md');
const SLEEVE_JSON = path.join(__dirname, 'portfolio_six_data_jul2026/stock_sleeve_shortma.json');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');

const KEY = process.env.API_KEY_NAME || 'BTDD_D1';
const B3_SYSTEM_ID = Number(process.env.B3_SYSTEM_ID || 205);
const LOT = Number(process.env.STOCK_LOT || 15);
const STOCK_OP = Number(process.env.STOCK_OP || 6);
const STOCK_INITIAL = Number(process.env.STOCK_INITIAL || 5000);
const STOCK_WEIGHT = Number(process.env.STOCK_WEIGHT || 0.5);
const PUBLISH = String(process.env.PUBLISH || '0') === '1';
const PUBLISH_DB = process.env.BTDD_DB_PATH || process.env.DB_FILE;
const DATE_FROM = process.env.DATE_FROM || '2026-03-19';
const DATE_TO = process.env.DATE_TO || '2026-07-30';
const MASTER = process.env.MASTER_API_KEY || 'BTDD_D1';
const SYSTEM_NAME = `ALGOFUND_MASTER::${MASTER}::addon-mrs-weex-stocks-shortma-jul2026`;

const API_OK = [
  'AMZNUSDT', 'AVGOUSDT', 'BABAUSDT', 'IBMUSDT', 'INTCUSDT', 'MUUSDT',
  'NVDAUSDT', 'RIVNUSDT', 'SOXLUSDT', 'SPXUSDT', 'TSLAUSDT', 'UBERUSDT',
];
const TFS = (process.env.TFS || '1h,4h').split(',').map((s) => s.trim()).filter(Boolean);

const TIER_CB = {
  enabled: true, peakWindowDays: 30, ddTriggerPercent: 8,
  lotMultiplier: 0.5, pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const hasCandle = (bundle, iv, sym) => fs.existsSync(path.join(bundle, iv, `${sym}.json`));

const ensureMerged = () => {
  ensureDir(MERGED);
  for (const src of [FLAT_BUNDLE, HAM_BUNDLE, STOCK_BUNDLE]) {
    if (!fs.existsSync(src)) continue;
    for (const iv of fs.readdirSync(src)) {
      const d = path.join(src, iv);
      if (!fs.statSync(d).isDirectory()) continue;
      const outIv = path.join(MERGED, iv);
      ensureDir(outIv);
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
        const dst = path.join(outIv, f);
        if (fs.existsSync(dst)) continue;
        try { fs.symlinkSync(path.join(d, f), dst); }
        catch { fs.copyFileSync(path.join(d, f), dst); }
      }
    }
  }
  process.env.HYBRID_CANDLE_DIR = MERGED;
};

const paramGrid = () => {
  const out = [];
  for (const len of [2, 3]) {
    for (const shift of [0.002, 0.005]) {
      out.push({
        maLongLen: len, maLongMult: +(1 - shift).toFixed(4),
        maShortLen: len, maShortMult: +(1 + shift).toFixed(4),
        maCloseLongLen: len, maCloseLongMult: 1,
        maCloseShortLen: len, maCloseShortMult: 1,
        distanceFilterPct: Math.max(0.05, +(shift * 100 * 0.5).toFixed(3)),
        slLongPct: 0,
        _shiftPct: +(shift * 100).toFixed(2),
      });
    }
  }
  return out;
};

const sum = (r, initial) => {
  const s = r.summary || {};
  return {
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    pf: +Number(s.profitFactor || 0).toFixed(3),
    trades: +(s.tradesCount || s.totalTrades || 0),
    final: +Number(s.finalEquity || s.finalBalance || initial).toFixed(2),
    skippedOP: +(s.skippedByPositionLimit || 0),
  };
};

const equitySeries = (curve) => {
  const out = [];
  for (const pt of curve || []) {
    const t = Number(pt.time || pt.t || pt.ts || 0);
    const e = Number(pt.equity ?? pt.value ?? pt.balance ?? NaN);
    if (Number.isFinite(t) && Number.isFinite(e)) out.push({ t, e });
  }
  return out.sort((a, b) => a.t - b.t);
};

const combineBooks = (books) => {
  const maps = books.map((b) => new Map(b.series.map((p) => [p.t, p.e])));
  const times = [...new Set(books.flatMap((b) => b.series.map((p) => p.t)))].sort((a, b) => a - b);
  const last = books.map((b) => b.initial);
  let peak = books.reduce((a, b) => a + b.initial, 0);
  let maxDd = 0;
  const curve = [];
  for (const t of times) {
    let eq = 0;
    for (let i = 0; i < books.length; i += 1) {
      const v = maps[i].get(t);
      if (v != null) last[i] = v;
      eq += last[i];
    }
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    curve.push({ t, e: eq });
  }
  const capital = books.reduce((a, b) => a + b.initial, 0);
  const final = curve.length ? curve[curve.length - 1].e : capital;
  return {
    ret: +(((final / capital) - 1) * 100).toFixed(2),
    dd: +maxDd.toFixed(2),
    final: +final.toFixed(2),
    capital,
  };
};

const candleMeta = (symbol, tf) => {
  const file = path.join(STOCK_BUNDLE, tf, `${symbol}.json`);
  if (!fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(doc.candles) ? doc.candles : [];
  if (rows.length < 80) return null;
  return {
    n: rows.length,
    from: new Date(Number(rows[0][0])).toISOString().slice(0, 10),
    to: new Date(Number(rows[rows.length - 1][0])).toISOString().slice(0, 10),
    fromMs: Number(rows[0][0]),
    toMs: Number(rows[rows.length - 1][0]),
  };
};

const upsertMrs = async (db, symbol, tf, params, tag, lot = LOT) => {
  const name = `STOCKSLEEVE::${tag}::${symbol}::${tf}::L${params.maLongLen}::S${params._shiftPct ?? ''}`;
  const existing = await db.get(
    `SELECT id FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name=?) AND name=?`,
    [KEY, name],
  );
  const mrs2 = JSON.stringify({
    maLongLen: params.maLongLen, maLongMult: params.maLongMult,
    maShortLen: params.maShortLen, maShortMult: params.maShortMult,
    maCloseLongLen: params.maCloseLongLen, maCloseLongMult: params.maCloseLongMult ?? 1,
    maCloseShortLen: params.maCloseShortLen, maCloseShortMult: params.maCloseShortMult ?? 1,
    distanceFilterPct: params.distanceFilterPct ?? 0.05,
    slLongPct: params.slLongPct ?? 0, slShortPct: 0,
  });
  if (existing?.id) {
    await db.run(
      `UPDATE strategies SET strategy_type='MeanReversion', base_symbol=?, interval=?,
        price_channel_length=?, zscore_entry=?, zscore_exit=?, zscore_stop=?,
        mrs2_config_json=?, leverage=20, lot_long_percent=?, lot_short_percent=?,
        reinvest_percent=100, market_mode='mono', market_type='futures',
        is_archived=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [
        symbol, tf, params.maLongLen, params.maLongMult, params.maShortMult,
        params.distanceFilterPct, mrs2, lot, lot, existing.id,
      ],
    );
    return Number(existing.id);
  }
  const api = await db.get('SELECT id FROM api_keys WHERE name=?', [KEY]);
  if (!api?.id) throw new Error(`api key ${KEY} missing`);
  const r = await db.run(
    `INSERT INTO strategies (
      name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
      price_channel_length, detection_source, take_profit_percent,
      zscore_entry, zscore_exit, zscore_stop,
      long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
      reinvest_percent, max_deposit, market_mode, market_type, mrs2_config_json,
      is_active, is_archived, is_runtime, origin, created_at, updated_at
    ) VALUES (?,?, 'MeanReversion', ?, '', ?, ?, 'wick', 0, ?,?,?,1,1,20,?,?,100,500000,'mono','futures',?,0,0,0,'research',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      name, api.id, symbol, tf, params.maLongLen, params.maLongMult, params.maShortMult,
      params.distanceFilterPct, lot, lot, mrs2,
    ],
  );
  return Number(r.lastID);
};

const upsertMrsCrypto = async (db, leg, tag) => {
  const name = `PF6::MRS::${tag}::${leg.symbol}::${leg.tf}`;
  const existing = await db.get(
    `SELECT id FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name=?) AND name=?`,
    [KEY, name],
  );
  const p = leg.params || {};
  const lot = 6;
  const mrs2 = JSON.stringify({
    maLongLen: p.maLongLen ?? 5, maLongMult: p.maLongMult ?? 0.95,
    maShortLen: p.maShortLen ?? 5, maShortMult: p.maShortMult ?? 1.05,
    maCloseLongLen: p.maCloseLongLen ?? 5, maCloseLongMult: p.maCloseLongMult ?? 1,
    maCloseShortLen: p.maCloseShortLen ?? 5, maCloseShortMult: p.maCloseShortMult ?? 1,
    distanceFilterPct: p.distanceFilterPct ?? 0.3, slLongPct: p.slLongPct ?? 0, slShortPct: 0,
  });
  if (existing?.id) {
    await db.run(
      `UPDATE strategies SET strategy_type='MeanReversion', base_symbol=?, interval=?,
        price_channel_length=?, zscore_entry=?, zscore_exit=?, zscore_stop=?,
        mrs2_config_json=?, leverage=20, lot_long_percent=?, lot_short_percent=?,
        reinvest_percent=100, market_mode='mono', market_type='futures',
        is_archived=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [leg.symbol, leg.tf, p.maLongLen || 5, p.maLongMult || 0.95, p.maShortMult || 1.05,
        p.distanceFilterPct || 0.3, mrs2, lot, lot, existing.id],
    );
    return Number(existing.id);
  }
  const api = await db.get('SELECT id FROM api_keys WHERE name=?', [KEY]);
  const r = await db.run(
    `INSERT INTO strategies (
      name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
      price_channel_length, detection_source, take_profit_percent,
      zscore_entry, zscore_exit, zscore_stop,
      long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
      reinvest_percent, max_deposit, market_mode, market_type, mrs2_config_json,
      is_active, is_archived, is_runtime, origin, created_at, updated_at
    ) VALUES (?,?, 'MeanReversion', ?, '', ?, ?, 'wick', 0, ?,?,?,1,1,20,?,?,100,500000,'mono','futures',?,0,0,0,'research',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [name, api.id, leg.symbol, leg.tf, p.maLongLen || 5, p.maLongMult || 0.95,
      p.maShortMult || 1.05, p.distanceFilterPct || 0.3, lot, lot, mrs2],
  );
  return Number(r.lastID);
};

const runBook = async (runBacktest, ids, opts) => runBacktest({
  apiKeyName: KEY,
  mode: 'portfolio',
  strategyIds: ids,
  dateFrom: opts.from,
  dateTo: opts.to,
  bars: 14000,
  warmupBars: 40,
  initialBalance: opts.initial,
  commissionPercent: opts.comm,
  slippagePercent: opts.slip,
  maxOpenPositions: opts.op,
  lotPercentOverride: opts.lot,
  reinvestPercentOverride: opts.ri,
  maxDepositOverride: opts.initial * 50,
  enablePairLock: true,
  skipMissingSymbols: true,
  portfolioCircuitBreaker: opts.cb || null,
});

const openPublishDb = (dbPath) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
});
const pGet = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const pAll = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});
const pRun = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID, changes: this.changes });
  });
});

const publishSleeve = async (legs, bookMetrics) => {
  if (!fs.existsSync(PUBLISH_DB)) throw new Error(`publish db missing: ${PUBLISH_DB}`);
  const db = await openPublishDb(PUBLISH_DB);
  const now = new Date().toISOString();
  const ak = await pGet(db, 'SELECT id FROM api_keys WHERE name=?', [MASTER]);
  if (!ak?.id) throw new Error(`master key ${MASTER} missing in ${PUBLISH_DB}`);

  const strategyIds = [];
  for (const leg of legs) {
    const name = `PF6::STOCK::SHORTMA::${leg.symbol}::${leg.tf}`;
    const p = leg.params;
    const mrs2 = JSON.stringify({
      maLongLen: p.maLongLen, maLongMult: p.maLongMult,
      maShortLen: p.maShortLen, maShortMult: p.maShortMult,
      maCloseLongLen: p.maCloseLongLen ?? p.maLongLen, maCloseLongMult: p.maCloseLongMult ?? 1,
      maCloseShortLen: p.maCloseShortLen ?? p.maShortLen, maCloseShortMult: p.maCloseShortMult ?? 1,
      distanceFilterPct: p.distanceFilterPct ?? 0.05, slLongPct: 0, slShortPct: 0,
    });
    const existing = await pGet(db, 'SELECT id FROM strategies WHERE api_key_id=? AND name=?', [ak.id, name]);
    let sid;
    if (existing?.id) {
      sid = existing.id;
      await pRun(db,
        `UPDATE strategies SET strategy_type='MeanReversion', base_symbol=?, interval=?,
          price_channel_length=?, zscore_entry=?, zscore_exit=?, zscore_stop=?,
          mrs2_config_json=?, leverage=20, lot_long_percent=?, lot_short_percent=?,
          reinvest_percent=100, market_mode='mono', market_type='futures',
          is_archived=0, updated_at=? WHERE id=?`,
        [leg.symbol, leg.tf, p.maLongLen, p.maLongMult, p.maShortMult, p.distanceFilterPct,
          mrs2, LOT, LOT, now, sid],
      );
    } else {
      const r = await pRun(db,
        `INSERT INTO strategies (
          name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
          price_channel_length, detection_source, take_profit_percent,
          zscore_entry, zscore_exit, zscore_stop,
          long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
          reinvest_percent, max_deposit, market_mode, market_type, mrs2_config_json,
          is_active, is_archived, is_runtime, origin, created_at, updated_at
        ) VALUES (?,?, 'MeanReversion', ?, '', ?, ?, 'wick', 0, ?,?,?,1,1,20,?,?,100,500000,'mono','futures',?,0,0,0,'research',?,?)`,
        [name, ak.id, leg.symbol, leg.tf, p.maLongLen, p.maLongMult, p.maShortMult,
          p.distanceFilterPct, LOT, LOT, mrs2, now, now],
      );
      sid = r.lastID;
    }
    strategyIds.push(sid);
  }

  let ts = await pGet(db, 'SELECT id FROM trading_systems WHERE api_key_id=? AND name=?', [ak.id, SYSTEM_NAME]);
  let systemId;
  const desc = `WEEX stocks short-MA sleeve OP${STOCK_OP} lot${LOT}`;
  if (ts?.id) {
    systemId = ts.id;
    await pRun(db,
      'UPDATE trading_systems SET max_open_positions=?, description=?, is_active=1, updated_at=? WHERE id=?',
      [STOCK_OP, desc, now, systemId],
    );
  } else {
    const r = await pRun(db,
      `INSERT INTO trading_systems (api_key_id, name, description, max_open_positions, is_active, created_at, updated_at)
       VALUES (?,?,?,?,1,?,?)`,
      [ak.id, SYSTEM_NAME, desc, STOCK_OP, now, now],
    );
    systemId = r.lastID;
  }
  await pRun(db, 'DELETE FROM trading_system_members WHERE system_id=?', [systemId]);
  for (const sid of strategyIds) {
    await pRun(db,
      `INSERT INTO trading_system_members (system_id, strategy_id, weight, is_enabled, member_role, created_at)
       VALUES (?,?,1,1,'addon',?)`,
      [systemId, sid, now],
    );
  }

  const meta = {
    displayLabel: 'WEEX Stocks short-MA',
    lotPercentOverride: LOT,
    reinvestPercentOverride: 100,
    maxOpenPositions: STOCK_OP,
    role: 'stocks_addon',
    universe: 'weex_stocks_shortma',
    bookMetrics,
    legs: legs.map((l) => ({
      symbol: l.symbol, tf: l.tf, params: l.params, full: l.full, score: l.score,
    })),
  };
  const code = `CARD::${SYSTEM_NAME.toUpperCase()}`;
  await pRun(db,
    `INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       name=excluded.name, description=excluded.description,
       source_system_id=excluded.source_system_id, is_active=1,
       metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
    [code, desc, desc, systemId, JSON.stringify(meta), now, now],
  );

  const portfolios = await pAll(db, 'SELECT id, set_key FROM algofund_portfolios WHERE is_enabled=1');
  for (const pf of portfolios) {
    const existing = await pGet(db,
      'SELECT id FROM algofund_portfolio_members WHERE portfolio_id=? AND system_name=?',
      [pf.id, SYSTEM_NAME],
    );
    if (existing?.id) {
      await pRun(db,
        `UPDATE algofund_portfolio_members SET role='stocks', capital_weight=?, is_enabled=1, updated_at=? WHERE id=?`,
        [STOCK_WEIGHT, now, existing.id],
      );
    } else {
      const maxSort = await pGet(db,
        'SELECT COALESCE(MAX(sort_order),-1) AS m FROM algofund_portfolio_members WHERE portfolio_id=?',
        [pf.id],
      );
      await pRun(db,
        `INSERT INTO algofund_portfolio_members
          (portfolio_id, system_name, role, capital_weight, sort_order, is_enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?)`,
        [pf.id, SYSTEM_NAME, 'stocks', STOCK_WEIGHT, Number(maxSort?.m ?? -1) + 1, now, now],
      );
    }
    console.log(`  attached stocks sleeve → ${pf.set_key} weight=${STOCK_WEIGHT}`);
  }

  await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  return { systemId, systemName: SYSTEM_NAME, strategyIds, portfolios: portfolios.length };
};

const main = async () => {
  ensureDir(OUT_DIR);
  ensureMerged();
  const grid = paramGrid();
  console.log(`[stock-sleeve] grid=${grid.length} lot=${LOT} op=${STOCK_OP} window=${DATE_FROM}→${DATE_TO}`);

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const db = database.db;

  // --- 1) per-symbol screen ---
  const screen = [];
  for (const symbol of API_OK) {
    let best = null;
    for (const tf of TFS) {
      const meta = candleMeta(symbol, tf);
      if (!meta) continue;
      for (const params of grid) {
        const id = await upsertMrs(db, symbol, tf, params, 'SCR');
        try {
          const r = await runBook(runBacktest, [id], {
            from: meta.from, to: meta.to, initial: 3000,
            lot: LOT, ri: 100, op: 1, comm: 0.036, slip: 0, cb: null,
          });
          const m = sum(r, 3000);
          if (m.trades < 8) continue;
          const score = +(m.ret * Math.min(2, Math.max(0.2, m.pf)) / (1 + m.dd / 25)).toFixed(3);
          const cand = {
            symbol, tf, params, ...m, score, from: meta.from, to: meta.to, strategyId: id,
          };
          if (!best || cand.score > best.score) best = cand;
        } catch (_) { /* skip */ }
      }
    }
    if (best) {
      screen.push(best);
      console.log(
        `  ${best.symbol}:${best.tf} len=${best.params.maLongLen} shift=${best.params._shiftPct}% `
        + `ret=${best.ret}% dd=${best.dd}% pf=${best.pf} tr=${best.trades}`,
      );
    } else {
      console.log(`  DROP ${symbol}`);
    }
  }
  screen.sort((a, b) => b.score - a.score);

  // Sleeve: positive ret, DD<=12, trades>=20, top 8
  const sleeve = screen
    .filter((r) => r.ret > 0 && r.dd <= 12 && r.trades >= 20 && r.pf >= 1.05)
    .slice(0, 8);
  if (sleeve.length < 4) {
    // relax
    sleeve.length = 0;
    sleeve.push(...screen.filter((r) => r.ret > 0 && r.trades >= 15).slice(0, 6));
  }
  console.log(`\n[sleeve] n=${sleeve.length}: ${sleeve.map((s) => s.symbol).join(', ')}`);

  // Upsert sleeve strategies with stable names for book
  const sleeveIds = [];
  for (const leg of sleeve) {
    const id = await upsertMrs(db, leg.symbol, leg.tf, leg.params, 'LIVE');
    sleeveIds.push(id);
    leg.liveStrategyId = id;
  }

  // --- 2) stock book ---
  const stockBook = await runBook(runBacktest, sleeveIds, {
    from: DATE_FROM, to: DATE_TO, initial: STOCK_INITIAL,
    lot: LOT, ri: 100, op: STOCK_OP, comm: 0.036, slip: 0, cb: null,
  });
  const stockMetrics = sum(stockBook, STOCK_INITIAL);
  const stockSeries = equitySeries(stockBook.equityCurve || []);
  console.log(`\n[stock book] OP${STOCK_OP} lot${LOT} init=${STOCK_INITIAL}: ret=${stockMetrics.ret}% dd=${stockMetrics.dd}% pf=${stockMetrics.pf} tr=${stockMetrics.trades}`);

  // --- 3) dump stress: worst 30d window on SPX close ---
  let dumpStress = null;
  const spxFile = path.join(STOCK_BUNDLE, '4h', 'SPXUSDT.json');
  if (fs.existsSync(spxFile)) {
    const candles = JSON.parse(fs.readFileSync(spxFile, 'utf8')).candles || [];
    let worst = null;
    const step = 6; // ~1d of 4h bars
    for (let i = 0; i + 30 * step < candles.length; i += step) {
      const a = Number(candles[i][4]);
      const b = Number(candles[i + 30 * step][4]);
      if (!(a > 0 && b > 0)) continue;
      const ret = ((b / a) - 1) * 100;
      if (!worst || ret < worst.ret) {
        worst = {
          ret: +ret.toFixed(2),
          from: new Date(Number(candles[i][0])).toISOString().slice(0, 10),
          to: new Date(Number(candles[i + 30 * step][0])).toISOString().slice(0, 10),
        };
      }
    }
    if (worst) {
      const r = await runBook(runBacktest, sleeveIds, {
        from: worst.from, to: worst.to, initial: STOCK_INITIAL,
        lot: LOT, ri: 100, op: STOCK_OP, comm: 0.036, slip: 0, cb: null,
      });
      dumpStress = { spx30d: worst, sleeve: sum(r, STOCK_INITIAL) };
      console.log(`[dump stress] SPX ${worst.from}→${worst.to} ${worst.ret}% | sleeve ${dumpStress.sleeve.ret}%/${dumpStress.sleeve.dd}%`);
    }
  }

  // --- 4) portfolio before/after on short window ---
  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  const durable = wf.durable || wf.cloud || [];

  const b3Rows = await db.all(
    `SELECT s.id FROM trading_system_members m JOIN strategies s ON s.id=m.strategy_id
     WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1`,
    [B3_SYSTEM_ID],
  );
  const b3Ids = b3Rows.map((r) => Number(r.id));
  console.log(`B3 ids=${b3Ids.length}`);

  const mrsCache = new Map();
  for (const n of [20, 25, 30]) {
    const ids = [];
    for (const leg of durable.slice(0, n)) {
      if (!hasCandle(MERGED, leg.tf, leg.symbol)) continue;
      ids.push(await upsertMrsCrypto(db, leg, `N${n}`));
    }
    mrsCache.set(n, ids);
  }

  const zzLegs = (recipes.universes.ham_zz_top5_weex || {}).legs || [];
  const zzIds = [];
  for (const z of zzLegs) {
    const row = await db.get(
      `SELECT s.id FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
       WHERE a.name=? AND s.base_symbol=? AND s.interval=? AND s.name LIKE 'FIVECARDFULL::ZZ%'
       ORDER BY s.id DESC LIMIT 1`,
      [KEY, z.symbol, z.tf],
    );
    if (row?.id && hasCandle(MERGED, z.tf, z.symbol)) zzIds.push(Number(row.id));
  }

  const compare = [];
  for (const pf of recipes.portfolios) {
    console.log(`\n=== ${pf.id} ${pf.label} ===`);
    const beforeBooks = [];
    for (const book of pf.books) {
      if (book.key === 'b3') {
        const r = await runBook(runBacktest, b3Ids, {
          from: DATE_FROM, to: DATE_TO, initial: book.initial,
          lot: recipes.sharedB3.lot, ri: recipes.sharedB3.ri, op: recipes.sharedB3.op,
          comm: 0.1, slip: 0.05, cb: TIER_CB,
        });
        const m = sum(r, book.initial);
        beforeBooks.push({ key: 'b3', initial: book.initial, ...m, series: equitySeries(r.equityCurve || []) });
        console.log(`  B3 ${m.ret}%/${m.dd}%`);
      } else if (book.key === 'mrs') {
        const n = recipes.universes[book.universe]?.n || 30;
        const ids = mrsCache.get(n) || mrsCache.get(30);
        const r = await runBook(runBacktest, ids, {
          from: DATE_FROM, to: DATE_TO, initial: book.initial,
          lot: book.lot, ri: book.ri, op: book.op, comm: 0.036, slip: 0, cb: null,
        });
        const m = sum(r, book.initial);
        beforeBooks.push({ key: 'mrs', initial: book.initial, ...m, series: equitySeries(r.equityCurve || []) });
        console.log(`  MRS${n} OP${book.op} ${m.ret}%/${m.dd}%`);
      } else if (book.key === 'zz' && zzIds.length) {
        const r = await runBook(runBacktest, zzIds, {
          from: DATE_FROM, to: DATE_TO, initial: book.initial,
          lot: book.lot, ri: book.ri, op: book.op, comm: 0.1, slip: 0.05, cb: null,
        });
        const m = sum(r, book.initial);
        beforeBooks.push({ key: 'zz', initial: book.initial, ...m, series: equitySeries(r.equityCurve || []) });
        console.log(`  ZZ ${m.ret}%/${m.dd}%`);
      }
    }
    const before = combineBooks(beforeBooks);
    const afterBooks = [
      ...beforeBooks,
      {
        key: 'stocks', initial: STOCK_INITIAL, ...stockMetrics, series: stockSeries,
      },
    ];
    const after = combineBooks(afterBooks);
    const b3ShareBefore = beforeBooks.find((b) => b.key === 'b3');
    const trendCapPct = b3ShareBefore
      ? +((b3ShareBefore.initial / before.capital) * 100).toFixed(1)
      : null;
    const row = {
      id: pf.id,
      setKey: pf.setKey,
      label: pf.label,
      before: { ret: before.ret, dd: before.dd, capital: before.capital, final: before.final },
      after: { ret: after.ret, dd: after.dd, capital: after.capital, final: after.final },
      deltaRet: +(after.ret - before.ret).toFixed(2),
      deltaDd: +(after.dd - before.dd).toFixed(2),
      trendCapPct,
      booksBefore: beforeBooks.map(({ series, ...x }) => x),
      stock: stockMetrics,
    };
    compare.push(row);
    console.log(`  BEFORE ${before.ret}%/${before.dd}% → AFTER ${after.ret}%/${after.dd}% (Δret ${row.deltaRet}, Δdd ${row.deltaDd})`);
  }

  const sleeveDoc = {
    generatedAt: new Date().toISOString(),
    systemName: SYSTEM_NAME,
    op: STOCK_OP,
    lot: LOT,
    ri: 100,
    capitalWeight: STOCK_WEIGHT,
    initial: STOCK_INITIAL,
    window: { from: DATE_FROM, to: DATE_TO },
    legs: sleeve.map((s) => ({
      symbol: s.symbol, tf: s.tf, params: s.params, full: { ret: s.ret, dd: s.dd, pf: s.pf, trades: s.trades }, score: s.score,
    })),
    book: stockMetrics,
    dumpStress,
  };
  fs.writeFileSync(SLEEVE_JSON, JSON.stringify(sleeveDoc, null, 2));

  const report = {
    generatedAt: new Date().toISOString(),
    settings: { LOT, STOCK_OP, STOCK_INITIAL, STOCK_WEIGHT, DATE_FROM, DATE_TO, grid: grid.length },
    screen,
    sleeve: sleeveDoc,
    dumpStress,
    compare,
    note: 'Window limited by WEEX stock candle history. Before/after = equity-sum of independent books (own OP each). B3 remains the trend sleeve.',
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const md = [
    '# Stock sleeve short-MA — portfolio compare',
    '',
    `Window **${DATE_FROM} → ${DATE_TO}** | sleeve OP${STOCK_OP} lot${LOT} init $${STOCK_INITIAL} weight ${STOCK_WEIGHT}`,
    '',
    '## Sleeve legs',
    '',
    '| Symbol | TF | Len | Shift% | Ret% | DD% | PF | Trades |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...sleeve.map((s) => `| ${s.symbol} | ${s.tf} | ${s.params.maLongLen} | ${s.params._shiftPct} | ${s.ret} | ${s.dd} | ${s.pf} | ${s.trades} |`),
    '',
    `**Book:** ${stockMetrics.ret}% / DD ${stockMetrics.dd}% / PF ${stockMetrics.pf} / trades ${stockMetrics.trades}`,
    '',
    dumpStress
      ? `**Dump stress** (worst SPX ~30d ${dumpStress.spx30d.ret}% ${dumpStress.spx30d.from}→${dumpStress.spx30d.to}): sleeve ${dumpStress.sleeve.ret}% / DD ${dumpStress.sleeve.dd}%`
      : '',
    '',
    '## Portfolio before → after (+stocks)',
    '',
    '| Portfolio | Trend B3 cap% | Before ret/DD | After ret/DD | Δret | ΔDD |',
    '|---|---:|---|---|---:|---:|',
    ...compare.map((c) => `| ${c.label} | ${c.trendCapPct ?? '—'} | ${c.before.ret}% / ${c.before.dd}% | ${c.after.ret}% / ${c.after.dd}% | ${c.deltaRet} | ${c.deltaDd} |`),
    '',
  ].join('\n');
  fs.writeFileSync(OUT_MD, md);
  console.log(`\nWrote ${OUT}`);
  console.log(md);

  let publishInfo = null;
  if (PUBLISH) {
    console.log(`\n[publish] ${PUBLISH_DB}`);
    publishInfo = await publishSleeve(sleeve, stockMetrics);
    console.log('[publish] done', publishInfo);
  }

  report.publish = publishInfo;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

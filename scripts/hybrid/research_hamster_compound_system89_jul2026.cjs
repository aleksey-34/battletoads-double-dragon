#!/usr/bin/env node
/**
 * Reproduce hamster system_89 compound report (zz + MRS2) in BTDD engines.
 *
 * - Parses results/hamster_compound_system89_jul2026/mapped_for_btdd.json
 * - Exports Binance USDM candles (1h base; resamples 2h/3h/6h/8h/12h)
 * - Runs ZZ_Fast / ZZ_Instance + MRS2 singles on window 2026-04-01..2026-07-12
 * - Also screens extra liquid pairs on ZZ grid (maximize coverage)
 *
 * Usage:
 *   node scripts/hybrid/research_hamster_compound_system89_jul2026.cjs
 *   EXPORT_ONLY=1 node ...
 *   SKIP_EXPORT=1 node ...
 *   SCREEN_EXTRA=0 node ...
 *   ZZ_ONLY=1 / MRS2_ONLY=1 node ...
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/hamster_compound_system89_jul2026');
const BUNDLE = process.env.HYBRID_CANDLE_DIR
  || path.join(REPO, 'results/hybrid_candle_bundle_hamster89');
const MAPPED = path.join(OUT_DIR, 'mapped_for_btdd.json');
const MRS2_PARAMS = path.join(OUT_DIR, 'mrs2_params.json');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
process.env.HYBRID_CANDLE_DIR = BUNDLE;

const DATE_FROM = process.env.DATE_FROM || '2026-04-01';
const DATE_TO = process.env.DATE_TO || '2026-07-12';
const INITIAL = Number(process.env.INITIAL || 1000);
// Hamster maker fee ~0.036% (post_only limits); override with COMMISSION=
const COMMISSION = Number(process.env.COMMISSION || 0.036);
const SLIPPAGE = Number(process.env.SLIPPAGE || 0.0);

const INTERVAL_MS = {
  '1h': 3_600_000,
  '2h': 7_200_000,
  '3h': 10_800_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

const warmupForTf = (tf, kind = 'zz') => {
  // MRS2 only needs ~max(MA lens)+2 bars; large warmup eats the hamster window start.
  if (kind === 'mrs2') return 0;
  const t = String(tf || '').toLowerCase();
  if (t === '1d') return 8;
  if (t === '12h' || t === '8h') return 24;
  if (t === '6h') return 40;
  return 60;
};
const EXTRA_SCREEN = String(process.env.SCREEN_EXTRA || '1') !== '0';
const SKIP_EXPORT = String(process.env.SKIP_EXPORT || '0') === '1';
const ZZ_ONLY = String(process.env.ZZ_ONLY || '0') === '1';
const MRS2_ONLY = String(process.env.MRS2_ONLY || '0') === '1';
const EXTRA_SYMBOLS = String(process.env.EXTRA_SYMBOLS || [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT',
  'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'NEARUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT',
  'APTUSDT', 'INJUSDT', 'TIAUSDT', 'SEIUSDT', 'WLDUSDT', 'ORDIUSDT', 'FILUSDT',
  'ATOMUSDT', 'LTCUSDT', 'BCHUSDT', 'UNIUSDT', 'AAVEUSDT', 'MKRUSDT', 'CRVUSDT',
  'PEPEUSDT', 'WIFUSDT', 'PENDLEUSDT', 'JUPUSDT', 'ENAUSDT', 'EIGENUSDT',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const toCcxt = (sym) => `${String(sym).replace(/USDT$/i, '')}/USDT:USDT`;

const loadMapped = () => JSON.parse(fs.readFileSync(MAPPED, 'utf8'));
const loadMrs2Params = () => {
  if (!fs.existsSync(MRS2_PARAMS)) return new Map();
  const arr = JSON.parse(fs.readFileSync(MRS2_PARAMS, 'utf8'));
  const m = new Map();
  for (const row of arr) m.set(row.set, row);
  return m;
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

const writeCandles = (interval, symbol, ohlcv) => {
  const dir = path.join(BUNDLE, interval);
  ensureDir(dir);
  // hybridCandleStore expects array rows [t,o,h,l,c,v]
  const candles = ohlcv.map((c) => [c[0], c[1], c[2], c[3], c[4], c[5] || 0]);
  fs.writeFileSync(path.join(dir, `${symbol}.json`), JSON.stringify({ symbol, interval, candles }));
  return candles.length;
};

const hasCandle = (interval, symbol) => fs.existsSync(path.join(BUNDLE, interval, `${symbol}.json`));

const fetchAll = async (ex, ccxtSymbol, interval, startMs) => {
  const step = INTERVAL_MS[interval] || 3_600_000;
  const all = [];
  let since = startMs;
  const endMs = Date.now();
  while (since < endMs && all.length < 20_000) {
    const batch = await ex.fetchOHLCV(ccxtSymbol, interval, since, 1500);
    if (!batch?.length) break;
    for (const c of batch) {
      if (!all.length || c[0] > all[all.length - 1][0]) all.push(c);
    }
    const last = batch[batch.length - 1][0];
    if (last <= since) break;
    since = last + step;
    if (batch.length < 2) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  return all;
};

const resampleFrom1h = (ohlcv1h, interval) => {
  const step = INTERVAL_MS[interval];
  if (!step || interval === '1h') return ohlcv1h;
  const buckets = new Map();
  for (const c of ohlcv1h) {
    const t0 = Math.floor(c[0] / step) * step;
    const prev = buckets.get(t0);
    if (!prev) {
      buckets.set(t0, [t0, c[1], c[2], c[3], c[4], c[5] || 0]);
    } else {
      prev[2] = Math.max(prev[2], c[2]);
      prev[3] = Math.min(prev[3], c[3]);
      prev[4] = c[4];
      prev[5] += c[5] || 0;
    }
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0]);
};

const exportCandles = async (symbols, intervals) => {
  const ccxt = require(path.join(REPO, 'backend/node_modules/ccxt/dist/ccxt.cjs'));
  const startMs = Date.parse('2025-01-01T00:00:00Z');
  const report = { ok: [], missing: [], errors: [], skipped: [] };
  const need1h = intervals.some((iv) => !['1h', '4h', '1d'].includes(iv));
  let ex = null;
  try {
    ex = new ccxt.binanceusdm({ enableRateLimit: true });
    await ex.loadMarkets();
  } catch (e) {
    console.log(`  WARN loadMarkets failed: ${String(e.message || e).slice(0, 120)}`);
    console.log('  Continuing with existing hybrid candles only');
  }
  for (const sym of symbols) {
    const neededIvs = [...new Set([...intervals, ...(need1h ? ['1h'] : [])])];
    const allPresent = neededIvs.every((iv) => hasCandle(iv, sym));
    if (allPresent) {
      report.skipped.push(sym);
      console.log(`  SKIP_EXISTING ${sym}`);
      continue;
    }
    if (!ex) {
      report.missing.push(sym);
      console.log(`  NO_EXPORT ${sym} (no market client; partial candles only)`);
      continue;
    }
    const ccxtSym = toCcxt(sym);
    if (!ex.markets[ccxtSym]) {
      report.missing.push(sym);
      console.log(`  NO_MARKET ${sym}`);
      continue;
    }
    try {
      let base1h = null;
      if (need1h || intervals.includes('1h')) {
        if (!hasCandle('1h', sym)) {
          base1h = await fetchAll(ex, ccxtSym, '1h', startMs);
          if (intervals.includes('1h') || need1h) writeCandles('1h', sym, base1h);
        }
      }
      for (const iv of intervals) {
        if (iv === '1h') continue;
        if (hasCandle(iv, sym)) continue;
        if (['4h', '1d'].includes(iv)) {
          const raw = await fetchAll(ex, ccxtSym, iv, startMs);
          const n = writeCandles(iv, sym, raw);
          console.log(`  ${sym} ${iv}: ${n}`);
        } else {
          if (!base1h) {
            if (hasCandle('1h', sym)) {
              const cached = JSON.parse(fs.readFileSync(path.join(BUNDLE, '1h', `${sym}.json`), 'utf8'));
              base1h = (cached.candles || []).map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume || 0]);
            } else {
              base1h = await fetchAll(ex, ccxtSym, '1h', startMs);
              writeCandles('1h', sym, base1h);
            }
          }
          const raw = resampleFrom1h(base1h, iv);
          const n = writeCandles(iv, sym, raw);
          console.log(`  ${sym} ${iv}: ${n} (resampled)`);
        }
      }
      report.ok.push(sym);
    } catch (e) {
      report.errors.push({ sym, err: String(e.message || e).slice(0, 160) });
      console.log(`  ERR ${sym}: ${e.message || e}`);
    }
  }
  return report;
};

const upsertStrategy = async (db, draft) => {
  const existing = await db.get(
    `SELECT id FROM strategies
     WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
       AND name = ? LIMIT 1`,
    [draft.apiKeyName, draft.name],
  );
  const mrs2Json = draft.mrs2_config_json || '{}';
  const zEntry = draft.zscore_entry != null ? draft.zscore_entry : 2.0;
  const zExit = draft.zscore_exit != null ? draft.zscore_exit : 0.5;
  const zStop = draft.zscore_stop != null ? draft.zscore_stop : 3.5;
  const tp = draft.take_profit_percent != null ? draft.take_profit_percent : 0;
  const det = draft.detection_source || 'wick';

  if (existing?.id) {
    await db.run(
      `UPDATE strategies SET
         strategy_type=?, base_symbol=?, quote_symbol=?, interval=?,
         price_channel_length=?, detection_source=?, take_profit_percent=?,
         zscore_entry=?, zscore_exit=?, zscore_stop=?,
         long_enabled=1, short_enabled=1, leverage=?, lot_long_percent=?, lot_short_percent=?,
         reinvest_percent=?, max_deposit=?, market_mode='mono', market_type='futures',
         mrs2_config_json=?,
         is_active=0, is_archived=0, is_runtime=0, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [
        draft.strategy_type, draft.symbol, '', draft.interval,
        draft.length, det, tp,
        zEntry, zExit, zStop,
        draft.leverage, draft.lot, draft.lot,
        draft.ri, draft.maxDeposit, mrs2Json, existing.id,
      ],
    );
    return Number(existing.id);
  }
  const api = await db.get('SELECT id FROM api_keys WHERE name = ?', [draft.apiKeyName]);
  if (!api?.id) throw new Error(`api key missing: ${draft.apiKeyName}`);
  const r = await db.run(
    `INSERT INTO strategies (
       name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
       price_channel_length, detection_source, take_profit_percent,
       zscore_entry, zscore_exit, zscore_stop,
       long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
       reinvest_percent, max_deposit, market_mode, market_type, mrs2_config_json,
       is_active, is_archived, is_runtime, origin, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?,?,?,?,0,0,0,'research',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      draft.name, api.id, draft.strategy_type, draft.symbol, '', draft.interval,
      draft.length, det, tp,
      zEntry, zExit, zStop,
      draft.leverage, draft.lot, draft.lot,
      draft.ri, draft.maxDeposit, 'mono', 'futures', mrs2Json,
    ],
  );
  return Number(r.lastID);
};

const sumOf = (r) => {
  const s = r.summary || {};
  return {
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    pf: +Number(s.profitFactor || 0).toFixed(3),
    trades: +(s.tradesCount || s.totalTrades || 0),
    end: +Number(s.finalBalance || s.endingBalance || s.finalEquity || 0).toFixed(2),
  };
};

const buildMrs2ConfigFromParams = (p, leg) => {
  const maLong = p?.ma_long || {};
  const maShort = p?.ma_short || {};
  const maCloseLong = p?.ma_close_long || {};
  const maCloseShort = p?.ma_close_short || {};
  return JSON.stringify({
    maLongLen: Number(maLong.len || leg.mrs_ma_len || 5),
    maLongMult: Number(maLong.multiplier || leg.mrs_mult_long || 0.95),
    maShortLen: Number(maShort.len || leg.mrs_ma_len || 5),
    maShortMult: Number(maShort.multiplier || leg.mrs_mult_short || 1.05),
    maCloseLongLen: Number(maCloseLong.len || leg.mrs_close_len || 5),
    maCloseLongMult: Number(maCloseLong.multiplier ?? 1.0),
    maCloseShortLen: Number(maCloseShort.len || leg.mrs_close_len || 5),
    maCloseShortMult: Number(maCloseShort.multiplier ?? 1.0),
    distanceFilterPct: Number(p?.distance_filter ?? leg.mrs_dist ?? 0.3),
    slLongPct: Number(leg.sl_long || 0),
    slShortPct: Number(leg.sl_short || leg.sl_long || 0),
  });
};

const main = async () => {
  ensureDir(OUT_DIR);
  ensureDir(BUNDLE);
  const mapped = loadMapped();
  const mrs2BySet = loadMrs2Params();
  const zzLegs = mapped.filter((x) => x.strategy === 'zz');
  const mrsLegs = mapped.filter((x) => x.strategy === 'mrs2');

  console.log(`mapped zz=${zzLegs.length} mrs2=${mrsLegs.length}`);

  const symbols = [...new Set([
    ...(!MRS2_ONLY ? zzLegs.map((x) => x.symbol) : []),
    ...(!ZZ_ONLY ? mrsLegs.map((x) => x.symbol) : []),
    ...(EXTRA_SCREEN && !MRS2_ONLY ? EXTRA_SYMBOLS : []),
  ])];
  const intervals = [...new Set([
    ...(!MRS2_ONLY ? zzLegs.map((x) => x.tf) : []),
    ...(!ZZ_ONLY ? mrsLegs.map((x) => x.tf) : []),
    '1h', '4h', '1d', '8h',
  ])];

  let exportReport = { ok: [], missing: [], errors: [], skipped: [] };
  if (!SKIP_EXPORT) {
    console.log('\n=== export candles ===');
    exportReport = await exportCandles(symbols, intervals);
    fs.writeFileSync(path.join(OUT_DIR, 'export_report.json'), JSON.stringify(exportReport, null, 2));
  } else {
    console.log('\n=== SKIP_EXPORT ===');
  }
  if (process.env.EXPORT_ONLY === '1') {
    console.log('EXPORT_ONLY done', exportReport);
    return;
  }

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const db = database.db;

  // ensure API key row exists
  const keyName = 'BTDD_D1';
  const key = await db.get('SELECT id FROM api_keys WHERE name = ?', [keyName]);
  if (!key) {
    await db.run(
      `INSERT INTO api_keys (name, exchange, api_key, secret, passphrase)
       VALUES (?, 'bybit', 'research', 'research', '')`,
      [keyName],
    );
  }

  const results = [];

  if (!MRS2_ONLY) {
    console.log('\n=== reproduce hamster zz legs ===');
    for (const leg of zzLegs) {
      const candlePath = path.join(BUNDLE, leg.tf, `${leg.symbol}.json`);
      if (!fs.existsSync(candlePath)) {
        results.push({
          kind: 'hamster_zz',
          symbol: leg.symbol,
          tf: leg.tf,
          skip: 'no_candles',
          hamster_pnl: leg.bt_pnl,
        });
        console.log(`  SKIP ${leg.symbol} ${leg.tf}: no candles`);
        continue;
      }
      const length = Math.max(2, Number(leg.zz6_len || leg.depth || 5));
      const stype = leg.our_type === 'ZZ_Fast' ? 'ZZ_Fast' : 'ZZ_Instance';
      const balPct = Number(leg.bal_pct || 3);
      const draft = {
        apiKeyName: keyName,
        name: `HAM89::${stype}::${leg.symbol}::${leg.tf}::L${length}`,
        strategy_type: stype,
        // mono: base_symbol = SYMBOLUSDT, quote = ''
        symbol: leg.symbol,
        interval: leg.tf,
        length,
        leverage: Number(leg.leverage || 20),
        lot: balPct,
        ri: 100,
        maxDeposit: INITIAL * 50,
      };
      const id = await upsertStrategy(db, draft);
      try {
        const bt = await runBacktest({
          apiKeyName: keyName,
          mode: 'single',
          strategyId: id,
          dateFrom: DATE_FROM,
          dateTo: DATE_TO,
          bars: 9000,
          warmupBars: warmupForTf(leg.tf),
          initialBalance: INITIAL,
          commissionPercent: COMMISSION,
          slippagePercent: SLIPPAGE,
          lotPercentOverride: balPct,
          reinvestPercentOverride: 100,
          maxDepositOverride: INITIAL * 50,
          skipMissingSymbols: true,
        });
        const m = sumOf(bt);
        const row = {
          kind: 'hamster_zz',
          set: leg.set,
          symbol: leg.symbol,
          tf: leg.tf,
          our_type: stype,
          length,
          bal_pct: balPct,
          hamster_pnl: leg.bt_pnl,
          hamster_wr: leg.bt_wr,
          hamster_trades: leg.bt_trades,
          ...m,
        };
        results.push(row);
        console.log(
          `  ${leg.symbol} ${leg.tf} ${stype}L${length}: ret=${m.ret}% dd=${m.dd}% trades=${m.trades} end=${m.end} | hamster_pnl=${leg.bt_pnl}`,
        );
      } catch (e) {
        results.push({
          kind: 'hamster_zz',
          symbol: leg.symbol,
          tf: leg.tf,
          error: String(e.message || e).slice(0, 200),
          hamster_pnl: leg.bt_pnl,
        });
        console.log(`  ERR ${leg.symbol}: ${e.message || e}`);
      }
    }
  }

  if (!ZZ_ONLY) {
    console.log('\n=== reproduce hamster mrs2 legs (MRS2 engine) ===');
    for (const leg of mrsLegs) {
      const candlePath = path.join(BUNDLE, leg.tf, `${leg.symbol}.json`);
      if (!fs.existsSync(candlePath)) {
        results.push({
          kind: 'hamster_mrs2',
          set: leg.set,
          symbol: leg.symbol,
          tf: leg.tf,
          skip: 'no_candles',
          hamster_pnl: leg.bt_pnl,
        });
        console.log(`  SKIP ${leg.symbol} ${leg.tf}: no candles`);
        continue;
      }
      const full = mrs2BySet.get(leg.set);
      const mrs2Json = buildMrs2ConfigFromParams(full, leg);
      const cfg = JSON.parse(mrs2Json);
      const balPct = Number(leg.bal_pct || 3);
      const draft = {
        apiKeyName: keyName,
        name: `HAM89::MRS2::${leg.symbol}::${leg.tf}::${leg.set}`,
        strategy_type: 'MRS2',
        symbol: leg.symbol,
        interval: leg.tf,
        length: cfg.maLongLen,
        detection_source: 'wick',
        take_profit_percent: 0,
        zscore_entry: cfg.maLongMult,
        zscore_exit: cfg.maShortMult,
        zscore_stop: cfg.distanceFilterPct,
        mrs2_config_json: mrs2Json,
        leverage: Number(leg.leverage || 20),
        lot: balPct,
        ri: 100,
        maxDeposit: INITIAL * 50,
      };
      const id = await upsertStrategy(db, draft);
      try {
        const bt = await runBacktest({
          apiKeyName: keyName,
          mode: 'single',
          strategyId: id,
          dateFrom: DATE_FROM,
          dateTo: DATE_TO,
          bars: 9000,
          warmupBars: warmupForTf(leg.tf, 'mrs2'),
          initialBalance: INITIAL,
          commissionPercent: COMMISSION,
          slippagePercent: SLIPPAGE,
          lotPercentOverride: balPct,
          reinvestPercentOverride: 100,
          maxDepositOverride: INITIAL * 50,
          skipMissingSymbols: true,
        });
        const m = sumOf(bt);
        const row = {
          kind: 'hamster_mrs2',
          set: leg.set,
          symbol: leg.symbol,
          tf: leg.tf,
          our_type: 'MRS2',
          bal_pct: balPct,
          hamster_pnl: leg.bt_pnl,
          hamster_wr: leg.bt_wr,
          hamster_trades: leg.bt_trades,
          cfg,
          ...m,
        };
        results.push(row);
        console.log(
          `  ${leg.symbol} ${leg.tf} MRS2: ret=${m.ret}% dd=${m.dd}% trades=${m.trades} end=${m.end} | hamster_pnl=${leg.bt_pnl}`,
        );
      } catch (e) {
        results.push({
          kind: 'hamster_mrs2',
          set: leg.set,
          symbol: leg.symbol,
          tf: leg.tf,
          error: String(e.message || e).slice(0, 200),
          hamster_pnl: leg.bt_pnl,
        });
        console.log(`  ERR MRS2 ${leg.symbol}: ${e.message || e}`);
      }
    }
  }

  if (EXTRA_SCREEN && !MRS2_ONLY) {
    console.log('\n=== extra liquid screen ZZ_Instance L5 @ 4h/1h ===');
    const grid = [
      { tf: '4h', type: 'ZZ_Instance', length: 5 },
      { tf: '4h', type: 'ZZ_Fast', length: 3 },
      { tf: '1h', type: 'ZZ_Instance', length: 5 },
      { tf: '1d', type: 'ZZ_Instance', length: 5 },
    ];
    for (const sym of EXTRA_SYMBOLS) {
      for (const g of grid) {
        const candlePath = path.join(BUNDLE, g.tf, `${sym}.json`);
        if (!fs.existsSync(candlePath)) continue;
        const draft = {
          apiKeyName: keyName,
          name: `HAM89X::${g.type}::${sym}::${g.tf}::L${g.length}`,
          strategy_type: g.type,
          symbol: sym,
          interval: g.tf,
          length: g.length,
          leverage: 20,
          lot: 3,
          ri: 100,
          maxDeposit: INITIAL * 50,
        };
        const id = await upsertStrategy(db, draft);
        try {
          const bt = await runBacktest({
            apiKeyName: keyName,
            mode: 'single',
            strategyId: id,
            dateFrom: DATE_FROM,
            dateTo: DATE_TO,
            bars: 9000,
            warmupBars: warmupForTf(g.tf),
            initialBalance: INITIAL,
            commissionPercent: COMMISSION,
            slippagePercent: SLIPPAGE,
            lotPercentOverride: 3,
            reinvestPercentOverride: 100,
            maxDepositOverride: INITIAL * 50,
            skipMissingSymbols: true,
          });
          const m = sumOf(bt);
          if (m.trades < 3) continue;
          results.push({
            kind: 'extra_screen',
            symbol: sym,
            tf: g.tf,
            our_type: g.type,
            length: g.length,
            bal_pct: 3,
            ...m,
          });
          console.log(`  ${sym} ${g.tf} ${g.type}L${g.length}: ret=${m.ret}% dd=${m.dd}% n=${m.trades}`);
        } catch (e) {
          // skip
        }
      }
    }
  }

  const outPath = path.join(OUT_DIR, 'btdd_reproduce_results.json');
  const zzRes = results.filter((r) => r.kind === 'hamster_zz' && r.ret != null);
  const mrsRes = results.filter((r) => r.kind === 'hamster_mrs2' && r.ret != null);
  const extra = results.filter((r) => r.kind === 'extra_screen');

  const sumHamsterPnl = (rows) => rows.reduce((a, b) => a + Number(b.hamster_pnl || 0), 0);
  const sumBtddPnl = (rows) => rows.reduce((a, b) => a + (Number(b.end || INITIAL) - INITIAL), 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    window: { from: DATE_FROM, to: DATE_TO, initial: INITIAL, commission: COMMISSION },
    notes: {
      mrs2: 'MRS2 engine: SMA(ohlc4) limit MR; fill at limit on high/low touch; levels from prior bar (no lookahead).',
      zz: 'Hamster ZZ2→ZZ_Instance, ZZ6→ZZ_Fast; level_multiplier / exact zz6_len_slow not modeled (slow=fast×2/×3).',
      mono: 'base_symbol=SYMBOLUSDT, quote_symbol=\'\'',
      hamster_report: {
        equity_start: 1000.35,
        equity_end: 36860.55,
        ret_pct: 3584.8,
        max_dd_pct: 6.87,
        days: 102,
        equiv_daily_compound_pct: 3.599,
      },
      comparison: {
        zz_legs_ok: zzRes.length,
        zz_legs_total: zzLegs.length,
        mrs2_legs_ok: mrsRes.length,
        mrs2_legs_total: mrsLegs.length,
        zz_hamster_pnl_sum: +sumHamsterPnl(zzRes).toFixed(2),
        zz_btdd_pnl_sum: +sumBtddPnl(zzRes).toFixed(2),
        mrs2_hamster_pnl_sum: +sumHamsterPnl(mrsRes).toFixed(2),
        mrs2_btdd_pnl_sum: +sumBtddPnl(mrsRes).toFixed(2),
      },
    },
    exportReport,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log('\n=== DONE ===');
  console.log(`zz reproduced: ${zzRes.length}/${zzLegs.length}`);
  if (zzRes.length) {
    const avgRet = zzRes.reduce((a, b) => a + b.ret, 0) / zzRes.length;
    const pos = zzRes.filter((r) => r.ret > 0).length;
    console.log(`zz avg ret=${avgRet.toFixed(1)}% winners=${pos}/${zzRes.length} btdd_pnl_sum=${sumBtddPnl(zzRes).toFixed(0)} vs hamster=${sumHamsterPnl(zzRes).toFixed(0)}`);
  }
  console.log(`mrs2 reproduced: ${mrsRes.length}/${mrsLegs.length}`);
  if (mrsRes.length) {
    const avgRet = mrsRes.reduce((a, b) => a + b.ret, 0) / mrsRes.length;
    const pos = mrsRes.filter((r) => r.ret > 0).length;
    console.log(`mrs2 avg ret=${avgRet.toFixed(1)}% winners=${pos}/${mrsRes.length} btdd_pnl_sum=${sumBtddPnl(mrsRes).toFixed(0)} vs hamster=${sumHamsterPnl(mrsRes).toFixed(0)}`);
  }
  const topExtra = extra.filter((r) => r.ret > 50).sort((a, b) => b.ret - a.ret).slice(0, 15);
  console.log(`extra winners>50%: ${topExtra.length}`);
  for (const r of topExtra.slice(0, 10)) {
    console.log(`  ${r.symbol} ${r.tf} ${r.our_type}L${r.length}: ${r.ret}% dd=${r.dd}%`);
  }
  console.log('wrote', outPath);
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

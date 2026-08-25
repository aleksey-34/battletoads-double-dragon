#!/usr/bin/env node
/**
 * E: ZZ wick-break vs close-break on storefront copy portfolios (full history).
 *
 * Does NOT change live defaults (ZZ stays wick via detection_source).
 * Override only via BT_ZZ_BREAK_MODE for each run.
 *
 *   node scripts/hybrid/research_zz_wick_vs_close_aug2026.cjs
 *
 * Env:
 *   DATE_FROM (default 2024-03-17)
 *   DATE_TO   (default yesterday UTC)
 *   LIVE_FROM (default 2026-07-30) — short fair window also reported
 *   LIVE_FIX_FROM (default 2026-08-10)
 *   HYBRID_CANDLE_DIR — required for full-history runs
 *   DB_FILE — optional
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/regime_risk_aug2026');
const OUT = path.join(OUT_DIR, 'zz_wick_vs_close_portfolios.json');
const OUT_MD = path.join(OUT_DIR, 'zz_wick_vs_close_portfolios.md');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');

const MERGED_CANDIDATES = [
  process.env.HYBRID_CANDLE_DIR,
  path.join(REPO, 'results/hybrid_candle_bundle_nomrs_pack_aug2026'),
  path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged'),
].filter(Boolean);

process.env.HYBRID_QUIET = process.env.HYBRID_QUIET || '1';
process.env.LOG_CONSOLE_LEVEL = process.env.LOG_CONSOLE_LEVEL || 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db');

const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const LIVE_FROM = process.env.LIVE_FROM || '2026-07-30';
const LIVE_FIX_FROM = process.env.LIVE_FIX_FROM || '2026-08-10';
const FAIR_CAPITAL = 1000;
const FAIR_BOOK_ROLES = new Set(['b3', 'ham', 'five', 'stocks']);

const COPY_FAIR = {
  P1: 'Copy_Alex1',
  P2: 'icopy1-api',
  P3: 'arcopy1',
};

const pack = (r, fromDate, toDate, idToPair) => {
  const s = r.summary || {};
  const trades = Array.isArray(r.trades) ? r.trades : [];
  const closed = trades.filter((t) => t && (t.exitTime || t.exit_time || t.pnl != null));
  const bySym = {};
  for (const t of closed) {
    const sid = Number(t.strategyId || t.strategy_id || 0);
    const pair = idToPair.get(sid) || String(t.symbol || sid);
    const pnl = Number(t.pnl || t.realizedPnl || 0);
    const row = bySym[pair] || (bySym[pair] = { n: 0, pnl: 0 });
    row.n += 1;
    row.pnl += pnl;
  }
  return {
    dateFrom: fromDate,
    dateTo: toDate,
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    trades: closed.length || Number(s.tradesCount || s.totalTrades || 0),
    skippedOp: Number(s.skippedByPositionLimit || 0),
    skippedPair: Number(s.skippedByPairLock || 0),
    skippedSymbols: Number(s.skippedStrategies || 0),
    bySym,
  };
};

const fmtDelta = (a, b) => {
  if (a == null || b == null) return null;
  return {
    ret: +(b.ret - a.ret).toFixed(2),
    dd: +(b.dd - a.dd).toFixed(2),
    trades: b.trades - a.trades,
    tradesPct: a.trades ? +(((b.trades - a.trades) / a.trades) * 100).toFixed(1) : null,
  };
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hybridRoot = MERGED_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!hybridRoot) {
    throw new Error('No HYBRID_CANDLE_DIR / merged candle bundle found');
  }
  process.env.HYBRID_CANDLE_DIR = hybridRoot;

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  await database.initDB();
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  const { loadAlgofundRoleBookMembers } = require(path.join(backendRoot, 'dist/bot/strategy/cycle/algofundSync'));
  const { knobsForRecipeBook } = require(path.join(backendRoot, 'dist/research/hamfiveRecipeKnobs'));
  const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange'));

  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const portfolios = (recipes.portfolios || []).filter((pf) => COPY_FAIR[String(pf.id)]);

  const fearBoost = {
    enabled: true,
    lotMultiplier: 1.25,
    activeDayStartsMs: [],
  };
  try {
    const schedulesPath = path.join(REPO, 'results/regime_risk_aug2026/fear_union_schedules.json');
    if (fs.existsSync(schedulesPath)) {
      const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
      fearBoost.lotMultiplier = schedules.lotMultiplier || 1.25;
      fearBoost.activeDayStartsMs = schedules?.variants?.fear_union?.activeDayStartsMs || [];
    }
  } catch (_) { /* optional */ }

  const tierCb = {
    enabled: true,
    peakWindowDays: 30,
    ddTriggerPercent: 8,
    lotMultiplier: 0.5,
    pauseDays: 14,
    applyToStrategyTypes: ['zz_breakout'],
  };

  const selectMembers = (members) => {
    const liveRoles = new Set(
      members
        .filter((m) => !m.isArchived && m.isActive && m.autoUpdate && FAIR_BOOK_ROLES.has(m.role))
        .map((m) => m.role),
    );
    const includeStocks = liveRoles.has('stocks');
    const seen = new Set();
    const out = [];
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

  const pairLabel = (m) => {
    const b = String(m.baseSymbol || '').toUpperCase();
    const q = String(m.quoteSymbol || '').toUpperCase();
    const mono = String(m.marketMode || '').toLowerCase() === 'mono';
    return mono || !q || q === b ? b : `${b}/${q}`;
  };

  const report = {
    generatedAt: new Date().toISOString(),
    hybridRoot,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    liveFrom: LIVE_FROM,
    liveFixFrom: LIVE_FIX_FROM,
    note: 'close mode only via BT_ZZ_BREAK_MODE; live DB detection_source unchanged (wick)',
    portfolios: {},
  };

  for (const pf of portfolios) {
    const pfId = String(pf.id);
    const copyKey = COPY_FAIR[pfId];
    console.error(`[E] portfolio ${pfId} copy=${copyKey}`);

    const lotByRole = {};
    const opByRole = {};
    const riByRole = {};
    for (const book of pf.books || []) {
      const knobs = knobsForRecipeBook(recipes, book);
      if (!knobs.key) continue;
      if (knobs.lot > 0) lotByRole[knobs.key] = knobs.lot;
      if (knobs.op > 0) opByRole[knobs.key] = knobs.op;
      riByRole[knobs.key] = knobs.ri;
    }

    let members = [];
    try {
      members = selectMembers(await loadAlgofundRoleBookMembers(copyKey));
    } catch (err) {
      console.error(`[E] ${pfId} load members failed: ${err.message}`);
      report.portfolios[pfId] = { error: err.message, copyKey };
      continue;
    }
    const fairIds = members.map((m) => m.strategyId);
    const idToPair = new Map();
    const fairBookKeyByStrategyId = {};
    const fairLotMultByStrategyId = {};
    const fairRiByStrategyId = {};
    const fairMaxOpenByBook = {};
    let fairAnyReinvest = false;
    for (const m of members) {
      idToPair.set(m.strategyId, pairLabel(m));
      fairBookKeyByStrategyId[String(m.strategyId)] = m.role;
      const lot = Number(lotByRole[m.role] || 0);
      if (lot > 0) fairLotMultByStrategyId[String(m.strategyId)] = lot;
      const op = Number(opByRole[m.role] || 0);
      if (op > 0) fairMaxOpenByBook[m.role] = op;
      const ri = Number(riByRole[m.role] || 0);
      fairRiByStrategyId[String(m.strategyId)] = ri;
      if (ri > 0) fairAnyReinvest = true;
    }

    if (!fairIds.length) {
      report.portfolios[pfId] = { error: 'no fair members', copyKey };
      continue;
    }

    try {
      await ensureExchangeClientInitialized(copyKey);
    } catch (e) {
      console.error(`[E] ${pfId} exchange init warn: ${e.message}`);
    }

    const runOnce = async (breakMode, fromDate, useExchangeCandles) => {
      process.env.BT_ZZ_BREAK_MODE = breakMode;
      const prevHybrid = process.env.HYBRID_CANDLE_DIR;
      if (useExchangeCandles) delete process.env.HYBRID_CANDLE_DIR;
      else process.env.HYBRID_CANDLE_DIR = hybridRoot;
      try {
        const result = await runBacktest({
          apiKeyName: copyKey,
          dataApiKeyName: useExchangeCandles ? copyKey : copyKey,
          mode: 'portfolio',
          strategyIds: fairIds,
          dateFrom: fromDate,
          dateTo: DATE_TO,
          bars: 4000,
          warmupBars: 120,
          skipMissingSymbols: true,
          initialBalance: FAIR_CAPITAL,
          commissionPercent: 0.1,
          slippagePercent: 0.05,
          maxOpenPositions: 0,
          maxOpenPositionsByBook: fairMaxOpenByBook,
          bookKeyByStrategyId: fairBookKeyByStrategyId,
          lotPercentOverride: 1,
          lotPercentMultiplierByStrategyId: fairLotMultByStrategyId,
          enablePairLock: true,
          maxDepositOverride: fairAnyReinvest ? FAIR_CAPITAL * 50 : 0,
          reinvestPercentByStrategyId: fairRiByStrategyId,
          portfolioCircuitBreaker: tierCb,
          researchLotSchedule: fearBoost,
        });
        return pack(result, fromDate, DATE_TO, idToPair);
      } finally {
        if (prevHybrid !== undefined) process.env.HYBRID_CANDLE_DIR = prevHybrid;
        else delete process.env.HYBRID_CANDLE_DIR;
        delete process.env.BT_ZZ_BREAK_MODE;
      }
    };

    const windows = [
      { key: 'full_hybrid', from: DATE_FROM, exchange: false },
      { key: 'live_hybrid', from: LIVE_FROM, exchange: false },
      { key: 'fix_hybrid', from: LIVE_FIX_FROM, exchange: false },
      { key: 'live_exchange', from: LIVE_FROM, exchange: true },
      { key: 'fix_exchange', from: LIVE_FIX_FROM, exchange: true },
    ];

    const byWindow = {};
    for (const w of windows) {
      console.error(`[E] ${pfId} ${w.key} wick…`);
      let wick;
      let close;
      try {
        wick = await runOnce('wick', w.from, w.exchange);
        console.error(`[E] ${pfId} ${w.key} close…`);
        close = await runOnce('close', w.from, w.exchange);
      } catch (err) {
        byWindow[w.key] = { error: err.message || String(err) };
        console.error(`[E] ${pfId} ${w.key} FAIL: ${err.message}`);
        continue;
      }
      byWindow[w.key] = {
        candles: w.exchange ? 'exchange' : 'hybrid',
        from: w.from,
        wick,
        close,
        delta_close_minus_wick: fmtDelta(wick, close),
      };
      console.error(
        `[E] ${pfId} ${w.key}: wick trades=${wick.trades} ret=${wick.ret}% dd=${wick.dd}% | `
        + `close trades=${close.trades} ret=${close.ret}% dd=${close.dd}%`,
      );
    }

    report.portfolios[pfId] = {
      copyKey,
      members: fairIds.length,
      roles: [...new Set(members.map((m) => m.role))],
      windows: byWindow,
    };
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const lines = [
    '# ZZ wick vs close — copy portfolios',
    '',
    `Generated: ${report.generatedAt}`,
    `Hybrid: \`${hybridRoot}\``,
    `Full: ${DATE_FROM} → ${DATE_TO}`,
    '',
    '| Portfolio | Window | Candles | Wick trades / ret / dd | Close trades / ret / dd | Δ trades | Δ ret |',
    '|---|---|---|---|---|---:|---:|',
  ];
  for (const [pfId, row] of Object.entries(report.portfolios)) {
    if (row.error) {
      lines.push(`| ${pfId} | - | - | ERROR: ${row.error} | | | |`);
      continue;
    }
    for (const [wkey, w] of Object.entries(row.windows || {})) {
      if (w.error) {
        lines.push(`| ${pfId} | ${wkey} | - | ERROR: ${w.error} | | | |`);
        continue;
      }
      const d = w.delta_close_minus_wick || {};
      lines.push(
        `| ${pfId} (${row.copyKey}) | ${wkey} | ${w.candles} | `
        + `${w.wick.trades} / ${w.wick.ret}% / ${w.wick.dd}% | `
        + `${w.close.trades} / ${w.close.ret}% / ${w.close.dd}% | `
        + `${d.trades ?? ''} | ${d.ret ?? ''}% |`,
      );
    }
  }
  lines.push('');
  lines.push('Δ = close − wick. Negative Δ trades = fewer entries with close-break (closer to “less overtrade”).');
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  console.log(OUT_MD);
  console.log(OUT);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

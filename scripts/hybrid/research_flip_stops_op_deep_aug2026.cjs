#!/usr/bin/env node
/**
 * Deep flip / stop / OP occupancy research — DD vs ZZ, portfolios, stop overlays.
 *
 * Live untouched. Research env flags only.
 *
 *   node scripts/hybrid/research_flip_stops_op_deep_aug2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/regime_risk_aug2026');
const OUT = path.join(OUT_DIR, 'flip_stops_op_deep.json');
const OUT_MD = path.join(OUT_DIR, 'flip_stops_op_deep.md');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');

const MERGED_CANDIDATES = [
  process.env.HYBRID_CANDLE_DIR,
  path.join(REPO, 'results/hybrid_candle_bundle_storefront_live'),
  path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged'),
].filter(Boolean);

process.env.HYBRID_QUIET = process.env.HYBRID_QUIET || '1';
process.env.LOG_CONSOLE_LEVEL = process.env.LOG_CONSOLE_LEVEL || 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db');

const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const LIVE_FROM = process.env.LIVE_FROM || '2026-07-30';
const FAIR_CAPITAL = 1000;
const FAIR_BOOK_ROLES = new Set(['b3', 'ham', 'five', 'stocks']);
const COPY_FAIR = { P1: 'Copy_Alex1', P2: 'icopy1-api', P3: 'arcopy1' };

const isZzType = (t) => {
  const s = String(t || '');
  // Do NOT use /^ZZ_/i — that also matches Donchian `zz_breakout`.
  return s === 'ZZ_Fast' || s === 'ZZ_Instance'
    || /^ZZ_Fast$/i.test(s) || /^ZZ_Instance$/i.test(s);
};
const isDdType = (t) => {
  const s = String(t || '');
  return s === 'zz_breakout' || s === 'DD_BattleToads' || s === 'donchian'
    || /^zz_breakout$/i.test(s);
};

const FRACTAL_OVERLAY = {
  enabled: true,
  rules: [{
    source: 'self',
    mode: 'full',
    fractalWings: 2,
    longExitBearishFractal: true,
    shortExitBullishFractal: true,
    combineWith: 'or',
  }],
};

const clearResearchEnv = () => {
  delete process.env.BT_CHANNEL_EXIT_MODE;
  delete process.env.BT_DONCHIAN_BREAK_MODE;
  delete process.env.BT_ZZ_BREAK_MODE;
  delete process.env.BT_ZZ_EXIT_MODE;
  delete process.env.BT_RESEARCH_STOP;
};

const applyModeEnv = (mode) => {
  clearResearchEnv();
  if (mode.exit) process.env.BT_CHANNEL_EXIT_MODE = mode.exit;
  if (mode.donchianBreak) process.env.BT_DONCHIAN_BREAK_MODE = mode.donchianBreak;
  if (mode.zzBreak) process.env.BT_ZZ_BREAK_MODE = mode.zzBreak;
  if (mode.zzExit) process.env.BT_ZZ_EXIT_MODE = mode.zzExit;
  if (mode.researchStop) process.env.BT_RESEARCH_STOP = mode.researchStop;
};

const occupancyFromTrades = (trades, maxOpenHint) => {
  const closed = (trades || []).filter((t) => t && t.exitTime && t.entryTime);
  if (!closed.length) {
    return {
      n: 0, avgHoldH: null, p50HoldH: null, p90HoldH: null,
      maxConcurrent: 0, avgConcurrent: 0, pctTimeAtOpCap: null, opHint: maxOpenHint || null,
    };
  }
  const holdsH = closed.map((t) => (Number(t.exitTime) - Number(t.entryTime)) / 36e5).filter((x) => x >= 0);
  holdsH.sort((a, b) => a - b);
  const q = (p) => holdsH[Math.min(holdsH.length - 1, Math.floor(p * (holdsH.length - 1)))];
  const events = [];
  for (const t of closed) {
    events.push({ t: Number(t.entryTime), d: 1 });
    events.push({ t: Number(t.exitTime), d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let maxC = 0;
  let area = 0;
  let lastT = events[0].t;
  let atCapMs = 0;
  const cap = Number(maxOpenHint) > 0 ? Number(maxOpenHint) : null;
  for (const e of events) {
    const dt = e.t - lastT;
    if (dt > 0) {
      area += cur * dt;
      if (cap != null && cur >= cap) atCapMs += dt;
    }
    cur += e.d;
    if (cur > maxC) maxC = cur;
    lastT = e.t;
  }
  const span = events[events.length - 1].t - events[0].t;
  return {
    n: closed.length,
    avgHoldH: holdsH.length ? +(holdsH.reduce((a, b) => a + b, 0) / holdsH.length).toFixed(2) : null,
    p50HoldH: holdsH.length ? +q(0.5).toFixed(2) : null,
    p90HoldH: holdsH.length ? +q(0.9).toFixed(2) : null,
    maxConcurrent: maxC,
    avgConcurrent: span > 0 ? +(area / span).toFixed(2) : 0,
    pctTimeAtOpCap: cap != null && span > 0 ? +((atCapMs / span) * 100).toFixed(1) : null,
    opHint: cap,
  };
};

const pack = (result, fromDate, toDate, idMeta, maxOpenSum) => {
  const s = result.summary || {};
  const trades = Array.isArray(result.trades) ? result.trades : [];
  const closed = trades.filter((t) => t && (t.exitTime || t.pnl != null));
  const byFamily = { dd: { n: 0, pnl: 0 }, zz: { n: 0, pnl: 0 }, other: { n: 0, pnl: 0 } };
  const reasons = {};
  for (const t of closed) {
    const sid = Number(t.strategyId || 0);
    const fam = idMeta.get(sid)?.family || 'other';
    const pnl = Number(t.netPnl != null ? t.netPnl : t.pnl || 0);
    byFamily[fam].n += 1;
    byFamily[fam].pnl += pnl;
    const reason = String(t.reason || 'unknown');
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  for (const k of Object.keys(byFamily)) {
    byFamily[k].pnl = +byFamily[k].pnl.toFixed(2);
  }
  const topReasons = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([r, n]) => `${r}:${n}`);
  return {
    dateFrom: fromDate,
    dateTo: toDate,
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    trades: closed.length || Number(s.tradesCount || 0),
    skippedOp: Number(s.skippedByPositionLimit || 0),
    skippedPair: Number(s.skippedByPairLock || 0),
    byFamily,
    topReasons,
    occ: occupancyFromTrades(closed, maxOpenSum),
  };
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hybridRoot = MERGED_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!hybridRoot) throw new Error('No hybrid bundle');
  process.env.HYBRID_CANDLE_DIR = hybridRoot;

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  await database.initDB();
  const { db } = database;
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  const { loadAlgofundRoleBookMembers } = require(path.join(backendRoot, 'dist/bot/strategy/cycle/algofundSync'));
  const { knobsForRecipeBook } = require(path.join(backendRoot, 'dist/research/hamfiveRecipeKnobs'));
  const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange'));

  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const portfolios = (recipes.portfolios || []).filter((pf) => COPY_FAIR[String(pf.id)]);
  const fearBoost = { enabled: true, lotMultiplier: 1.25, activeDayStartsMs: [] };
  const tierCb = {
    enabled: true, peakWindowDays: 30, ddTriggerPercent: 8, lotMultiplier: 0.5,
    pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
  };

  const selectMembers = (members) => {
    const liveRoles = new Set(
      members.filter((m) => !m.isArchived && m.isActive && m.autoUpdate && FAIR_BOOK_ROLES.has(m.role)).map((m) => m.role),
    );
    const includeStocks = liveRoles.has('stocks');
    const seen = new Set();
    const out = [];
    for (const m of members) {
      if (m.isArchived || !FAIR_BOOK_ROLES.has(m.role)) continue;
      if (m.role === 'stocks' && !includeStocks) continue;
      if (seen.has(m.strategyId)) continue;
      seen.add(m.strategyId);
      out.push(m);
    }
    return out;
  };

  const enrichFamily = async (members) => {
    const idMeta = new Map();
    for (const m of members) {
      const row = await db.get(`SELECT strategy_type FROM strategies WHERE id=?`, [m.strategyId]);
      const st = row?.strategy_type || m.strategyType || '';
      const family = isZzType(st) ? 'zz' : (isDdType(st) ? 'dd' : 'other');
      idMeta.set(m.strategyId, { family, strategyType: st, role: m.role });
    }
    return idMeta;
  };

  // Core matrix: structure × mode
  const STRUCTURES = ['all', 'dd', 'zz'];
  const CORE_MODES = [
    { key: 'baseline', exit: 'center' },
    { key: 'flip_wick', exit: 'flip_only', donchianBreak: 'wick' },
    { key: 'flip_close', exit: 'flip_only', donchianBreak: 'close' },
    // ZZ axes (harmless on DD-only books)
    { key: 'zz_mid', exit: 'flip_only', donchianBreak: 'wick', zzExit: 'mid' },
    { key: 'zz_close_sar', exit: 'flip_only', donchianBreak: 'wick', zzBreak: 'close' },
  ];
  // Stop overlays on flip_wick (P3 focus + all structures on live/full for P3; P1/P2 get subset)
  const STOP_MODES = [
    { key: 'flip_wick_cf05', exit: 'flip_only', donchianBreak: 'wick', chanFrac: 0.5 },
    { key: 'flip_wick_cf10', exit: 'flip_only', donchianBreak: 'wick', chanFrac: 1.0 },
    { key: 'flip_wick_cf15', exit: 'flip_only', donchianBreak: 'wick', chanFrac: 1.5 },
    { key: 'flip_wick_ema20', exit: 'flip_only', donchianBreak: 'wick', researchStop: 'ema:20' },
    { key: 'flip_wick_ema50', exit: 'flip_only', donchianBreak: 'wick', researchStop: 'ema:50' },
    { key: 'flip_wick_psar', exit: 'flip_only', donchianBreak: 'wick', researchStop: 'psar:0.02,0.2' },
    { key: 'flip_wick_fractal', exit: 'flip_only', donchianBreak: 'wick', fractal: true },
  ];

  const WINDOWS = [
    { key: 'full', from: DATE_FROM },
    { key: 'live', from: LIVE_FROM },
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    hybridRoot,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    liveFrom: LIVE_FROM,
    answers: {
      donchianWickFlip: 'yes — research mode flip_wick',
      zzFlip: 'ZZ already SAR-flip; zz_mid = early mid exit; zz_close_sar = close-break SAR',
      widthStop: 'chanfrac works under flip_only as disaster cap (fixed engine)',
      cloudOp: 'see occ.* and skippedOp — longer holds raise concurrent & OP pressure',
    },
    portfolios: {},
  };

  for (const pf of portfolios) {
    const pfId = String(pf.id);
    const copyKey = COPY_FAIR[pfId];
    console.error(`\n==== ${pfId} ${copyKey} ====`);

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
      report.portfolios[pfId] = { error: err.message };
      continue;
    }
    const idMeta = await enrichFamily(members);
    const counts = { dd: 0, zz: 0, other: 0 };
    for (const m of members) counts[idMeta.get(m.strategyId)?.family || 'other'] += 1;

    try { await ensureExchangeClientInitialized(copyKey); } catch (_) { /* */ }

    const buildKnobs = (subset) => {
      const fairIds = subset.map((m) => m.strategyId);
      const fairBookKeyByStrategyId = {};
      const fairLotMultByStrategyId = {};
      const fairRiByStrategyId = {};
      const fairMaxOpenByBook = {};
      let fairAnyReinvest = false;
      let maxOpenSum = 0;
      for (const m of subset) {
        fairBookKeyByStrategyId[String(m.strategyId)] = m.role;
        const lot = Number(lotByRole[m.role] || 0);
        if (lot > 0) fairLotMultByStrategyId[String(m.strategyId)] = lot;
        const op = Number(opByRole[m.role] || 0);
        if (op > 0) fairMaxOpenByBook[m.role] = op;
        const ri = Number(riByRole[m.role] || 0);
        fairRiByStrategyId[String(m.strategyId)] = ri;
        if (ri > 0) fairAnyReinvest = true;
      }
      maxOpenSum = Object.values(fairMaxOpenByBook).reduce((a, b) => a + Number(b || 0), 0);
      return {
        fairIds, fairBookKeyByStrategyId, fairLotMultByStrategyId, fairRiByStrategyId,
        fairMaxOpenByBook, fairAnyReinvest, maxOpenSum,
      };
    };

    const subsets = {
      all: members,
      dd: members.filter((m) => idMeta.get(m.strategyId)?.family === 'dd'),
      zz: members.filter((m) => idMeta.get(m.strategyId)?.family === 'zz'),
    };

    const stopModeList = pfId === 'P3' ? STOP_MODES : STOP_MODES.filter((m) => (
      m.key === 'flip_wick_cf10' || m.key === 'flip_wick_ema20' || m.key === 'flip_wick_psar'
    ));

    const runs = {};
    for (const struct of STRUCTURES) {
      const subset = subsets[struct];
      if (!subset.length) {
        runs[struct] = { skip: 'empty' };
        continue;
      }
      const knobs = buildKnobs(subset);
      runs[struct] = { n: subset.length, windows: {} };

      const modesForStruct = [...CORE_MODES];
      if (struct === 'all' || struct === 'dd') {
        for (const sm of stopModeList) modesForStruct.push(sm);
      }

      for (const w of WINDOWS) {
        runs[struct].windows[w.key] = {};
        for (const mode of modesForStruct) {
          // Skip ZZ-specific modes on dd-only; skip some DD-stop noise on zz-only
          if (struct === 'dd' && (mode.key === 'zz_mid' || mode.key === 'zz_close_sar')) continue;
          if (struct === 'zz' && mode.key === 'flip_close') continue;

          applyModeEnv(mode);
          const label = `${struct}/${w.key}/${mode.key}`;
          console.error(`[deep] ${pfId} ${label} (n=${knobs.fairIds.length})…`);
          try {
            const result = await runBacktest({
              apiKeyName: copyKey,
              dataApiKeyName: copyKey,
              mode: 'portfolio',
              strategyIds: knobs.fairIds,
              dateFrom: w.from,
              dateTo: DATE_TO,
              bars: 4000,
              warmupBars: 120,
              skipMissingSymbols: true,
              initialBalance: FAIR_CAPITAL,
              commissionPercent: 0.1,
              slippagePercent: 0.05,
              maxOpenPositions: 0,
              maxOpenPositionsByBook: knobs.fairMaxOpenByBook,
              bookKeyByStrategyId: knobs.fairBookKeyByStrategyId,
              lotPercentOverride: 1,
              lotPercentMultiplierByStrategyId: knobs.fairLotMultByStrategyId,
              enablePairLock: true,
              maxDepositOverride: knobs.fairAnyReinvest ? FAIR_CAPITAL * 50 : 0,
              reinvestPercentByStrategyId: knobs.fairRiByStrategyId,
              portfolioCircuitBreaker: tierCb,
              researchLotSchedule: fearBoost,
              channelWidthStopFraction: mode.chanFrac || 0,
              ...(mode.fractal ? { macroExitOverlay: FRACTAL_OVERLAY } : {}),
            });
            const packed = pack(result, w.from, DATE_TO, idMeta, knobs.maxOpenSum);
            runs[struct].windows[w.key][mode.key] = packed;
            console.error(
              `[deep] ${pfId} ${label}: ret=${packed.ret}% dd=${packed.dd}% trades=${packed.trades} `
              + `skipOp=${packed.skippedOp} avgHoldH=${packed.occ.avgHoldH} maxConc=${packed.occ.maxConcurrent}`,
            );
          } catch (err) {
            runs[struct].windows[w.key][mode.key] = { error: err.message || String(err) };
            console.error(`[deep] FAIL ${pfId} ${label}: ${err.message}`);
          }
        }
      }
    }

    clearResearchEnv();
    report.portfolios[pfId] = { copyKey, counts, opByRole, runs };
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const lines = [
    '# Deep flip / stops / OP — DD vs ZZ',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## How to read',
    '- **flip_wick**: Donchian wick entry + hold until opposite break (no center exit)',
    '- **zz_mid**: ZZ exits at mid between pivots (early) instead of opposite SAR',
    '- **cfXX**: channel-width stop = entry ± width×fraction (disaster cap under flip)',
    '- **ema/psar/fractal**: research stops on top of flip_wick',
    '- **occ**: hold time + concurrent positions vs Σ OP books',
    '',
  ];

  for (const [pfId, row] of Object.entries(report.portfolios)) {
    if (row.error) {
      lines.push(`## ${pfId} ERROR ${row.error}`, '');
      continue;
    }
    lines.push(`## ${pfId} (${row.copyKey}) — DD=${row.counts.dd} ZZ=${row.counts.zz} other=${row.counts.other}`);
    lines.push(`OP by role: ${JSON.stringify(row.opByRole)}`);
    lines.push('');
    lines.push('| Struct | Window | Mode | Trades | Ret% | DD% | skipOp | avgHoldH | maxConc | Δret |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const struct of STRUCTURES) {
      const block = row.runs?.[struct];
      if (!block?.windows) continue;
      for (const [wkey, modes] of Object.entries(block.windows)) {
        const base = modes.baseline || modes.flip_wick;
        for (const [mkey, m] of Object.entries(modes)) {
          if (!m || m.error) {
            lines.push(`| ${struct} | ${wkey} | ${mkey} | ERR | | | | | | |`);
            continue;
          }
          const dRet = base && !base.error ? +(m.ret - base.ret).toFixed(2) : '';
          // Δ vs baseline when baseline exists else vs first
          const ref = modes.baseline && !modes.baseline.error ? modes.baseline : null;
          const d = ref ? +(m.ret - ref.ret).toFixed(2) : dRet;
          lines.push(
            `| ${struct} | ${wkey} | ${mkey} | ${m.trades} | ${m.ret} | ${m.dd} | ${m.skippedOp} | `
            + `${m.occ?.avgHoldH ?? ''} | ${m.occ?.maxConcurrent ?? ''} | ${d} |`,
          );
        }
      }
    }
    lines.push('');
  }

  lines.push('## Takeaways checklist');
  lines.push('1. Donchian: wick+flip_only — primary candidate vs center baseline');
  lines.push('2. ZZ: already flip(SAR); mid-exit = “without flip-hold”; compare skipOp/hold');
  lines.push('3. Width stop: needed if max adverse before opposite level is intolerable');
  lines.push('4. Cloud/OP: longer holds → higher concurrent → more skipOp — see table');
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  console.log(OUT_MD);
  console.log(OUT);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

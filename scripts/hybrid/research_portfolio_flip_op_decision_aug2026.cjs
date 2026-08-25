#!/usr/bin/env node
/**
 * Full portfolio decision matrix: BEFORE vs NEW flip vs OP-B3 variants.
 *
 * Variants:
 *   A_baseline     — live-like (Donchian center exit, DB detection_source)
 *   B_flip_wick    — Donchian wick + flip_only, same OP/lot
 *   C_flip_cf10    — B + channelWidthStopFraction=1.0 disaster cap
 *   D_flip_op16    — B + B3 OP 12→16, lot unchanged (15)
 *   E_flip_op18    — B + B3 OP 12→18, lot unchanged
 *   F_flip_op16_nocb — D + disable tier CB on zz_breakout (no lot cut on DD)
 *   G_flip_op16_cf10 — D + cf1.0
 *
 *   node scripts/hybrid/research_portfolio_flip_op_decision_aug2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/regime_risk_aug2026');
const OUT = path.join(OUT_DIR, 'portfolio_flip_op_decision.json');
const OUT_MD = path.join(OUT_DIR, 'portfolio_flip_op_decision.md');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');

const MERGED = [
  process.env.HYBRID_CANDLE_DIR,
  path.join(REPO, 'results/hybrid_candle_bundle_storefront_live'),
  path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged'),
].filter(Boolean);

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = process.env.LOG_CONSOLE_LEVEL || 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db');

const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const LIVE_FROM = process.env.LIVE_FROM || '2026-07-30';
const LIVE_FIX = process.env.LIVE_FIX_FROM || '2026-08-10';
const FAIR_CAPITAL = 1000;
const FAIR_BOOK_ROLES = new Set(['b3', 'ham', 'five', 'stocks']);
const COPY_FAIR = { P1: 'Copy_Alex1', P2: 'icopy1-api', P3: 'arcopy1' };
const B3_LOT = 15; // sharedB3.lot — never cut in OP-up variants

const VARIANTS = [
  {
    key: 'A_baseline',
    label: 'Было (center + DB detect)',
    exit: 'center',
    donchianBreak: '',
    b3Op: null, // recipe sharedB3
    chanFrac: 0,
    tierCb: true,
  },
  {
    key: 'B_flip_wick',
    label: 'Новое: wick + flip_only',
    exit: 'flip_only',
    donchianBreak: 'wick',
    b3Op: null,
    chanFrac: 0,
    tierCb: true,
  },
  {
    key: 'C_flip_cf10',
    label: 'Новое + cf1.0 cap',
    exit: 'flip_only',
    donchianBreak: 'wick',
    b3Op: null,
    chanFrac: 1.0,
    tierCb: true,
  },
  {
    key: 'D_flip_op16',
    label: 'Flip + B3 OP16 (lot 15)',
    exit: 'flip_only',
    donchianBreak: 'wick',
    b3Op: 16,
    chanFrac: 0,
    tierCb: true,
  },
  {
    key: 'E_flip_op18',
    label: 'Flip + B3 OP18 (lot 15)',
    exit: 'flip_only',
    donchianBreak: 'wick',
    b3Op: 18,
    chanFrac: 0,
    tierCb: true,
  },
  {
    key: 'F_flip_op16_nocb',
    label: 'Flip + OP16 + no tierCB',
    exit: 'flip_only',
    donchianBreak: 'wick',
    b3Op: 16,
    chanFrac: 0,
    tierCb: false,
  },
  {
    key: 'G_flip_op16_cf10',
    label: 'Flip + OP16 + cf1.0',
    exit: 'flip_only',
    donchianBreak: 'wick',
    b3Op: 16,
    chanFrac: 1.0,
    tierCb: true,
  },
];

const WINDOWS = [
  { key: 'full', from: DATE_FROM },
  { key: 'live', from: LIVE_FROM },
  { key: 'fix', from: LIVE_FIX },
];

const clearEnv = () => {
  delete process.env.BT_CHANNEL_EXIT_MODE;
  delete process.env.BT_DONCHIAN_BREAK_MODE;
  delete process.env.BT_ZZ_BREAK_MODE;
  delete process.env.BT_ZZ_EXIT_MODE;
  delete process.env.BT_RESEARCH_STOP;
};

const applyVariant = (v) => {
  clearEnv();
  process.env.BT_CHANNEL_EXIT_MODE = v.exit;
  if (v.donchianBreak) process.env.BT_DONCHIAN_BREAK_MODE = v.donchianBreak;
};

const occupancy = (trades) => {
  const closed = (trades || []).filter((t) => t && t.exitTime && t.entryTime);
  if (!closed.length) return { avgHoldH: null, maxConcurrent: 0, n: 0 };
  const holds = closed.map((t) => (t.exitTime - t.entryTime) / 36e5).filter((x) => x >= 0);
  const avgHoldH = holds.length ? +(holds.reduce((a, b) => a + b, 0) / holds.length).toFixed(2) : null;
  const ev = [];
  for (const t of closed) {
    ev.push({ t: t.entryTime, d: 1 });
    ev.push({ t: t.exitTime, d: -1 });
  }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0; let maxC = 0;
  for (const e of ev) { cur += e.d; if (cur > maxC) maxC = cur; }
  return { avgHoldH, maxConcurrent: maxC, n: closed.length };
};

const pack = (result, from, to, meta) => {
  const s = result.summary || {};
  const trades = result.trades || [];
  const closed = trades.filter((t) => t && t.exitTime);
  const occ = occupancy(closed);
  const reasons = {};
  for (const t of closed) {
    const r = String(t.reason || '?');
    reasons[r] = (reasons[r] || 0) + 1;
  }
  return {
    ...meta,
    dateFrom: from,
    dateTo: to,
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    trades: closed.length,
    skippedOp: Number(s.skippedByPositionLimit || 0),
    skippedPair: Number(s.skippedByPairLock || 0),
    avgHoldH: occ.avgHoldH,
    maxConcurrent: occ.maxConcurrent,
    topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([r, n]) => `${r}:${n}`),
  };
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hybridRoot = MERGED.find((p) => p && fs.existsSync(p));
  if (!hybridRoot) throw new Error('No hybrid bundle');
  process.env.HYBRID_CANDLE_DIR = hybridRoot;

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  await database.initDB();
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  const { loadAlgofundRoleBookMembers } = require(path.join(backendRoot, 'dist/bot/strategy/cycle/algofundSync'));
  const { knobsForRecipeBook } = require(path.join(backendRoot, 'dist/research/hamfiveRecipeKnobs'));
  const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange'));

  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const sharedB3Op = Number(recipes?.sharedB3?.op || 12);
  const fearBoost = { enabled: true, lotMultiplier: 1.25, activeDayStartsMs: [] };
  const tierCbOn = {
    enabled: true, peakWindowDays: 30, ddTriggerPercent: 8, lotMultiplier: 0.5,
    pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
  };
  const tierCbOff = { enabled: false };

  const selectMembers = (members) => {
    const liveRoles = new Set(
      members.filter((m) => !m.isArchived && m.isActive && m.autoUpdate && FAIR_BOOK_ROLES.has(m.role)).map((m) => m.role),
    );
    const includeStocks = liveRoles.has('stocks');
    const seen = new Set(); const out = [];
    for (const m of members) {
      if (m.isArchived || !FAIR_BOOK_ROLES.has(m.role)) continue;
      if (m.role === 'stocks' && !includeStocks) continue;
      if (seen.has(m.strategyId)) continue;
      seen.add(m.strategyId); out.push(m);
    }
    return out;
  };

  const report = {
    generatedAt: new Date().toISOString(),
    hybridRoot,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    liveFrom: LIVE_FROM,
    liveFix: LIVE_FIX,
    sharedB3Op,
    sharedB3Lot: B3_LOT,
    note: 'B3 OP overrides only in D/E/F/G; lot always 15 in OP-up variants (no lot cut).',
    variants: VARIANTS.map((v) => ({ key: v.key, label: v.label, b3Op: v.b3Op ?? sharedB3Op, chanFrac: v.chanFrac, tierCb: v.tierCb })),
    portfolios: {},
  };

  for (const pf of (recipes.portfolios || []).filter((p) => COPY_FAIR[String(p.id)])) {
    const pfId = String(pf.id);
    const copyKey = COPY_FAIR[pfId];
    console.error(`\n======== ${pfId} ${copyKey} ========`);

    const lotByRole = {}; const opByRole = {}; const riByRole = {};
    for (const book of pf.books || []) {
      const knobs = knobsForRecipeBook(recipes, book);
      if (!knobs.key) continue;
      if (knobs.lot > 0) lotByRole[knobs.key] = knobs.lot;
      if (knobs.op > 0) opByRole[knobs.key] = knobs.op;
      riByRole[knobs.key] = knobs.ri;
    }
    // Force shared B3 lot (recipe path already does) — document baseline OP
    lotByRole.b3 = B3_LOT;
    opByRole.b3 = sharedB3Op;

    let members = [];
    try {
      members = selectMembers(await loadAlgofundRoleBookMembers(copyKey));
    } catch (err) {
      report.portfolios[pfId] = { error: err.message, copyKey };
      continue;
    }
    try { await ensureExchangeClientInitialized(copyKey); } catch (_) { /* */ }

    const fairIds = members.map((m) => m.strategyId);
    const fairBookKeyByStrategyId = {};
    const fairLotMultByStrategyId = {};
    const fairRiByStrategyId = {};
    let fairAnyReinvest = false;
    for (const m of members) {
      fairBookKeyByStrategyId[String(m.strategyId)] = m.role;
      const lot = Number(lotByRole[m.role] || 0);
      if (lot > 0) fairLotMultByStrategyId[String(m.strategyId)] = lot;
      const ri = Number(riByRole[m.role] || 0);
      fairRiByStrategyId[String(m.strategyId)] = ri;
      if (ri > 0) fairAnyReinvest = true;
    }

    report.portfolios[pfId] = {
      copyKey,
      members: fairIds.length,
      baselineOpByRole: { ...opByRole },
      baselineLotByRole: { ...lotByRole },
      windows: {},
    };

    for (const w of WINDOWS) {
      report.portfolios[pfId].windows[w.key] = {};
      for (const v of VARIANTS) {
        applyVariant(v);
        const fairMaxOpenByBook = { ...opByRole };
        if (v.b3Op != null) fairMaxOpenByBook.b3 = v.b3Op;
        // Keep lot 15 on B3 explicitly
        for (const m of members) {
          if (m.role === 'b3') fairLotMultByStrategyId[String(m.strategyId)] = B3_LOT;
        }

        const label = `${pfId}/${w.key}/${v.key}`;
        console.error(`[dec] ${label} b3Op=${fairMaxOpenByBook.b3} cb=${v.tierCb}…`);
        try {
          const result = await runBacktest({
            apiKeyName: copyKey,
            dataApiKeyName: copyKey,
            mode: 'portfolio',
            strategyIds: fairIds,
            dateFrom: w.from,
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
            portfolioCircuitBreaker: v.tierCb ? tierCbOn : tierCbOff,
            researchLotSchedule: fearBoost,
            channelWidthStopFraction: v.chanFrac || 0,
          });
          const packed = pack(result, w.from, DATE_TO, {
            variant: v.key,
            label: v.label,
            b3Op: fairMaxOpenByBook.b3,
            b3Lot: B3_LOT,
            tierCb: v.tierCb,
            chanFrac: v.chanFrac,
          });
          report.portfolios[pfId].windows[w.key][v.key] = packed;
          console.error(
            `[dec] ${label}: ret=${packed.ret}% dd=${packed.dd}% n=${packed.trades} `
            + `skipOp=${packed.skippedOp} hold=${packed.avgHoldH} maxC=${packed.maxConcurrent}`,
          );
        } catch (err) {
          report.portfolios[pfId].windows[w.key][v.key] = { error: err.message || String(err), variant: v.key };
          console.error(`[dec] FAIL ${label}: ${err.message}`);
        }
      }
    }
  }

  clearEnv();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const lines = [
    '# Portfolio decision: baseline vs flip vs B3 OP',
    '',
    `Generated: ${report.generatedAt}`,
    `Full: ${DATE_FROM} → ${DATE_TO} · Live: ${LIVE_FROM} · Fix: ${LIVE_FIX}`,
    `sharedB3 OP=${sharedB3Op} lot=${B3_LOT} (OP-up variants keep lot=${B3_LOT})`,
    '',
  ];

  for (const [pfId, row] of Object.entries(report.portfolios)) {
    if (row.error) {
      lines.push(`## ${pfId} ERROR ${row.error}`, '');
      continue;
    }
    lines.push(`## ${pfId} (${row.copyKey}) · n=${row.members}`);
    lines.push(`OP roles: ${JSON.stringify(row.baselineOpByRole)}`);
    lines.push('');
    for (const w of WINDOWS) {
      lines.push(`### ${w.key}`);
      lines.push('| Variant | B3 OP | Ret% | DD% | Trades | skipOp | holdH | maxC | Δret | Δdd |');
      lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
      const modes = row.windows[w.key] || {};
      const base = modes.A_baseline;
      for (const v of VARIANTS) {
        const m = modes[v.key];
        if (!m || m.error) {
          lines.push(`| ${v.key} | | ERR | | | | | | | |`);
          continue;
        }
        const dRet = base && !base.error ? +(m.ret - base.ret).toFixed(2) : '';
        const dDd = base && !base.error ? +(m.dd - base.dd).toFixed(2) : '';
        lines.push(
          `| ${v.key} | ${m.b3Op} | ${m.ret} | ${m.dd} | ${m.trades} | ${m.skippedOp} | `
          + `${m.avgHoldH ?? ''} | ${m.maxConcurrent} | ${dRet} | ${dDd} |`,
        );
      }
      lines.push('');
    }
  }

  lines.push('## How to choose for deploy/remat');
  lines.push('- Prefer variant with ↑ret, ≤dd vs A, skipOp not exploding.');
  lines.push('- If D/E ≈ B on ret but ↓skipOp → OP bump helps cloud without needing lot cut.');
  lines.push('- If F (no CB) ↑dd a lot → keep tierCB even after flip.');
  lines.push('- C/G cf1.0: take if ≈B/D on ret (free disaster cap).');
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  console.log(OUT_MD);
  console.log(OUT);
})().catch((e) => { console.error(e); process.exit(1); });

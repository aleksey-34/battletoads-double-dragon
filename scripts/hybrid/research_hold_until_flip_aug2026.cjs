#!/usr/bin/env node
/**
 * Hold-until-flip vs center-stop (Donchian philosophy research).
 *
 * Thesis: don't "catch clean breakouts" with close-confirm + early center exit;
 * enter and hold until opposite level (signal_flip) — closer to ZZ SAR idea.
 *
 * Modes (env applied per run, live untouched):
 *   baseline          — as live DB (Donchian close+center, ZZ wick+SAR)
 *   flip_only         — BT_CHANNEL_EXIT_MODE=flip_only (no Donchian center exit)
 *   flip_only_wick    — flip_only + BT_DONCHIAN_BREAK_MODE=wick
 *   wick_center       — wick Donchian entry, keep center exit
 *
 *   node scripts/hybrid/research_hold_until_flip_aug2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/regime_risk_aug2026');
const OUT = path.join(OUT_DIR, 'hold_until_flip_portfolios.json');
const OUT_MD = path.join(OUT_DIR, 'hold_until_flip_portfolios.md');
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
const LIVE_FIX_FROM = process.env.LIVE_FIX_FROM || '2026-08-10';
const FAIR_CAPITAL = 1000;
const FAIR_BOOK_ROLES = new Set(['b3', 'ham', 'five', 'stocks']);

const COPY_FAIR = {
  P1: 'Copy_Alex1',
  P2: 'icopy1-api',
  P3: 'arcopy1',
};

const MODES = [
  { key: 'baseline', exit: 'center', donchianBreak: '' },
  { key: 'flip_only', exit: 'flip_only', donchianBreak: '' },
  { key: 'flip_only_wick', exit: 'flip_only', donchianBreak: 'wick' },
  { key: 'wick_center', exit: 'center', donchianBreak: 'wick' },
];

const WINDOWS = [
  { key: 'full', from: DATE_FROM },
  { key: 'live', from: LIVE_FROM },
  { key: 'fix', from: LIVE_FIX_FROM },
];

const pack = (r, fromDate, toDate) => {
  const s = r.summary || {};
  const trades = Array.isArray(r.trades) ? r.trades : [];
  const closed = trades.filter((t) => t && (t.exitTime || t.exit_time || t.pnl != null));
  const reasons = {};
  for (const t of closed) {
    const reason = String(t.exitReason || t.exit_reason || t.reason || 'unknown');
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {
    dateFrom: fromDate,
    dateTo: toDate,
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    trades: closed.length || Number(s.tradesCount || s.totalTrades || 0),
    skippedOp: Number(s.skippedByPositionLimit || 0),
    skippedPair: Number(s.skippedByPairLock || 0),
    exitReasons: reasons,
  };
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hybridRoot = MERGED_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!hybridRoot) throw new Error('No hybrid candle bundle');
  process.env.HYBRID_CANDLE_DIR = hybridRoot;

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  await database.initDB();
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  const { loadAlgofundRoleBookMembers } = require(path.join(backendRoot, 'dist/bot/strategy/cycle/algofundSync'));
  const { knobsForRecipeBook } = require(path.join(backendRoot, 'dist/research/hamfiveRecipeKnobs'));
  const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange'));

  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const portfolios = (recipes.portfolios || []).filter((pf) => COPY_FAIR[String(pf.id)]);

  const fearBoost = { enabled: true, lotMultiplier: 1.25, activeDayStartsMs: [] };
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

  const report = {
    generatedAt: new Date().toISOString(),
    hybridRoot,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    thesis: 'hold until opposite break vs Donchian center early-exit; close-confirm not required',
    note: 'Research-only env flags; live defaults unchanged. ZZ already SAR-flip; flip_only mainly changes Donchian legs.',
    portfolios: {},
  };

  for (const pf of portfolios) {
    const pfId = String(pf.id);
    const copyKey = COPY_FAIR[pfId];
    console.error(`[flip] ${pfId} ${copyKey}`);

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
      report.portfolios[pfId] = { error: err.message, copyKey };
      continue;
    }
    const fairIds = members.map((m) => m.strategyId);
    const fairBookKeyByStrategyId = {};
    const fairLotMultByStrategyId = {};
    const fairRiByStrategyId = {};
    const fairMaxOpenByBook = {};
    let fairAnyReinvest = false;
    for (const m of members) {
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
      report.portfolios[pfId] = { error: 'no members', copyKey };
      continue;
    }
    try { await ensureExchangeClientInitialized(copyKey); } catch (_) { /* ok */ }

    const byWindow = {};
    for (const w of WINDOWS) {
      byWindow[w.key] = { from: w.from, modes: {} };
      for (const mode of MODES) {
        process.env.BT_CHANNEL_EXIT_MODE = mode.exit;
        if (mode.donchianBreak) process.env.BT_DONCHIAN_BREAK_MODE = mode.donchianBreak;
        else delete process.env.BT_DONCHIAN_BREAK_MODE;
        console.error(`[flip] ${pfId} ${w.key}/${mode.key}…`);
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
            portfolioCircuitBreaker: tierCb,
            researchLotSchedule: fearBoost,
          });
          const packed = pack(result, w.from, DATE_TO);
          byWindow[w.key].modes[mode.key] = packed;
          console.error(
            `[flip] ${pfId} ${w.key}/${mode.key}: trades=${packed.trades} ret=${packed.ret}% dd=${packed.dd}%`,
          );
        } catch (err) {
          byWindow[w.key].modes[mode.key] = { error: err.message || String(err) };
          console.error(`[flip] FAIL ${pfId} ${w.key}/${mode.key}: ${err.message}`);
        }
      }
      delete process.env.BT_CHANNEL_EXIT_MODE;
      delete process.env.BT_DONCHIAN_BREAK_MODE;
    }

    report.portfolios[pfId] = {
      copyKey,
      members: fairIds.length,
      windows: byWindow,
    };
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  const lines = [
    '# Hold-until-flip vs Donchian center-stop',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'Modes: `baseline` (live-like) · `flip_only` (no center exit) · `flip_only_wick` · `wick_center`',
    '',
    '| PF | Window | Mode | Trades | Ret% | DD% | Δret vs baseline |',
    '|---|---|---|---:|---:|---:|---:|',
  ];
  for (const [pfId, row] of Object.entries(report.portfolios)) {
    if (row.error) {
      lines.push(`| ${pfId} | - | - | ERROR ${row.error} | | | |`);
      continue;
    }
    for (const [wkey, w] of Object.entries(row.windows || {})) {
      const base = w.modes?.baseline;
      for (const mode of MODES) {
        const m = w.modes?.[mode.key];
        if (!m || m.error) {
          lines.push(`| ${pfId} | ${wkey} | ${mode.key} | ERR | | | |`);
          continue;
        }
        const dRet = base && !base.error ? +(m.ret - base.ret).toFixed(2) : '';
        lines.push(
          `| ${pfId} | ${wkey} | ${mode.key} | ${m.trades} | ${m.ret} | ${m.dd} | ${dRet} |`,
        );
      }
    }
  }
  lines.push('');
  lines.push('Positive Δret = mode beats baseline. flip_only ≈ your “hold short until reverse long / structured stop”.');
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  console.log(OUT_MD);
  console.log(OUT);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

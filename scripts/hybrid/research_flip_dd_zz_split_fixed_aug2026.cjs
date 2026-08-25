#!/usr/bin/env node
/**
 * Corrected DD vs ZZ split (zz_breakout must NOT match /^ZZ_/i).
 * Core modes only — full deep stops already in flip_stops_op_deep.json (all-book valid).
 */
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/regime_risk_aug2026');
const OUT = path.join(OUT_DIR, 'flip_dd_zz_split_fixed.json');
const OUT_MD = path.join(OUT_DIR, 'flip_dd_zz_split_fixed.md');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db');
process.env.HYBRID_CANDLE_DIR = process.env.HYBRID_CANDLE_DIR
  || path.join(REPO, 'results/hybrid_candle_bundle_storefront_live');

const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const LIVE_FROM = process.env.LIVE_FROM || '2026-07-30';
const FAIR_CAPITAL = 1000;
const FAIR_BOOK_ROLES = new Set(['b3', 'ham', 'five', 'stocks']);
const COPY_FAIR = { P1: 'Copy_Alex1', P2: 'icopy1-api', P3: 'arcopy1' };

const isZz = (t) => ['ZZ_Fast', 'ZZ_Instance'].includes(String(t || ''));
const isDd = (t) => ['zz_breakout', 'DD_BattleToads'].includes(String(t || ''));

const clearEnv = () => {
  delete process.env.BT_CHANNEL_EXIT_MODE;
  delete process.env.BT_DONCHIAN_BREAK_MODE;
  delete process.env.BT_ZZ_BREAK_MODE;
  delete process.env.BT_ZZ_EXIT_MODE;
  delete process.env.BT_RESEARCH_STOP;
};

const pack = (result) => {
  const s = result.summary || {};
  const trades = (result.trades || []).filter((t) => t && t.exitTime);
  const reasons = {};
  for (const t of trades) {
    const r = String(t.reason || '?');
    reasons[r] = (reasons[r] || 0) + 1;
  }
  const holds = trades.map((t) => (t.exitTime - t.entryTime) / 36e5).filter((x) => x >= 0);
  const avgHoldH = holds.length ? +(holds.reduce((a, b) => a + b, 0) / holds.length).toFixed(2) : null;
  let cur = 0; let maxC = 0;
  const ev = [];
  for (const t of trades) {
    ev.push({ t: t.entryTime, d: 1 });
    ev.push({ t: t.exitTime, d: -1 });
  }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  for (const e of ev) { cur += e.d; if (cur > maxC) maxC = cur; }
  return {
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    trades: trades.length,
    skippedOp: Number(s.skippedByPositionLimit || 0),
    skippedPair: Number(s.skippedByPairLock || 0),
    avgHoldH,
    maxConcurrent: maxC,
    topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([r, n]) => `${r}:${n}`),
  };
};

(async () => {
  const database = require(path.join(backendRoot, 'dist/utils/database'));
  await database.initDB();
  const { db } = database;
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  const { loadAlgofundRoleBookMembers } = require(path.join(backendRoot, 'dist/bot/strategy/cycle/algofundSync'));
  const { knobsForRecipeBook } = require(path.join(backendRoot, 'dist/research/hamfiveRecipeKnobs'));

  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const fearBoost = { enabled: true, lotMultiplier: 1.25, activeDayStartsMs: [] };
  const tierCb = {
    enabled: true, peakWindowDays: 30, ddTriggerPercent: 8, lotMultiplier: 0.5,
    pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
  };

  const selectMembers = (members) => {
    const liveRoles = new Set(members.filter((m) => !m.isArchived && m.isActive && m.autoUpdate && FAIR_BOOK_ROLES.has(m.role)).map((m) => m.role));
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

  const MODES = [
    { key: 'baseline', env: () => { clearEnv(); process.env.BT_CHANNEL_EXIT_MODE = 'center'; } },
    { key: 'flip_wick', env: () => { clearEnv(); process.env.BT_CHANNEL_EXIT_MODE = 'flip_only'; process.env.BT_DONCHIAN_BREAK_MODE = 'wick'; } },
    { key: 'zz_mid', env: () => { clearEnv(); process.env.BT_CHANNEL_EXIT_MODE = 'flip_only'; process.env.BT_DONCHIAN_BREAK_MODE = 'wick'; process.env.BT_ZZ_EXIT_MODE = 'mid'; } },
    { key: 'zz_close_sar', env: () => { clearEnv(); process.env.BT_ZZ_BREAK_MODE = 'close'; } },
  ];
  const WINDOWS = [{ key: 'full', from: DATE_FROM }, { key: 'live', from: LIVE_FROM }];
  const report = { generatedAt: new Date().toISOString(), note: 'fixed DD/ZZ classifier', portfolios: {} };

  for (const pf of (recipes.portfolios || []).filter((p) => COPY_FAIR[String(p.id)])) {
    const pfId = String(pf.id);
    const copyKey = COPY_FAIR[pfId];
    const lotByRole = {}; const opByRole = {}; const riByRole = {};
    for (const book of pf.books || []) {
      const knobs = knobsForRecipeBook(recipes, book);
      if (!knobs.key) continue;
      if (knobs.lot > 0) lotByRole[knobs.key] = knobs.lot;
      if (knobs.op > 0) opByRole[knobs.key] = knobs.op;
      riByRole[knobs.key] = knobs.ri;
    }
    const members = selectMembers(await loadAlgofundRoleBookMembers(copyKey));
    const typed = [];
    for (const m of members) {
      const row = await db.get('SELECT strategy_type FROM strategies WHERE id=?', [m.strategyId]);
      const st = row?.strategy_type || '';
      const family = isDd(st) ? 'dd' : (isZz(st) ? 'zz' : 'other');
      typed.push({ ...m, strategyType: st, family });
    }
    const counts = { dd: 0, zz: 0, other: 0 };
    for (const m of typed) counts[m.family] += 1;
    console.error(`${pfId} counts`, counts, typed.filter((m) => m.family !== 'other').map((m) => `${m.strategyId}:${m.strategyType}`).join(','));

    report.portfolios[pfId] = { copyKey, counts, opByRole, runs: {} };
    for (const family of ['dd', 'zz']) {
      const subset = typed.filter((m) => m.family === family);
      if (!subset.length) { report.portfolios[pfId].runs[family] = { empty: true }; continue; }
      const fairIds = subset.map((m) => m.strategyId);
      const fairBookKeyByStrategyId = {}; const fairLotMultByStrategyId = {};
      const fairRiByStrategyId = {}; const fairMaxOpenByBook = {};
      let fairAnyReinvest = false;
      for (const m of subset) {
        fairBookKeyByStrategyId[String(m.strategyId)] = m.role;
        if (lotByRole[m.role]) fairLotMultByStrategyId[String(m.strategyId)] = lotByRole[m.role];
        if (opByRole[m.role]) fairMaxOpenByBook[m.role] = opByRole[m.role];
        fairRiByStrategyId[String(m.strategyId)] = riByRole[m.role] || 0;
        if (riByRole[m.role] > 0) fairAnyReinvest = true;
      }
      report.portfolios[pfId].runs[family] = { n: subset.length, types: [...new Set(subset.map((m) => m.strategyType))], windows: {} };
      for (const w of WINDOWS) {
        report.portfolios[pfId].runs[family].windows[w.key] = {};
        for (const mode of MODES) {
          if (family === 'dd' && (mode.key === 'zz_mid' || mode.key === 'zz_close_sar')) continue;
          if (family === 'zz' && mode.key === 'flip_wick') {
            // flip_wick should be ~noop for pure ZZ; still run as control
          }
          mode.env();
          console.error(`[split] ${pfId} ${family}/${w.key}/${mode.key} n=${fairIds.length}`);
          try {
            const result = await runBacktest({
              apiKeyName: copyKey, dataApiKeyName: copyKey, mode: 'portfolio', strategyIds: fairIds,
              dateFrom: w.from, dateTo: DATE_TO, bars: 4000, warmupBars: 120, skipMissingSymbols: true,
              initialBalance: FAIR_CAPITAL, commissionPercent: 0.1, slippagePercent: 0.05,
              maxOpenPositions: 0, maxOpenPositionsByBook: fairMaxOpenByBook,
              bookKeyByStrategyId: fairBookKeyByStrategyId, lotPercentOverride: 1,
              lotPercentMultiplierByStrategyId: fairLotMultByStrategyId, enablePairLock: true,
              maxDepositOverride: fairAnyReinvest ? FAIR_CAPITAL * 50 : 0,
              reinvestPercentByStrategyId: fairRiByStrategyId,
              portfolioCircuitBreaker: tierCb, researchLotSchedule: fearBoost,
            });
            const packed = pack(result);
            report.portfolios[pfId].runs[family].windows[w.key][mode.key] = packed;
            console.error(`[split] ${pfId} ${family}/${w.key}/${mode.key}: ret=${packed.ret} dd=${packed.dd} n=${packed.trades} hold=${packed.avgHoldH}`);
          } catch (err) {
            report.portfolios[pfId].runs[family].windows[w.key][mode.key] = { error: err.message };
            console.error('FAIL', err.message);
          }
        }
      }
    }
  }
  clearEnv();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  const lines = ['# Fixed DD vs ZZ split', '', `Generated ${report.generatedAt}`, ''];
  for (const [pfId, row] of Object.entries(report.portfolios)) {
    lines.push(`## ${pfId} DD=${row.counts.dd} ZZ=${row.counts.zz} other=${row.counts.other}`, '');
    lines.push('| Fam | Win | Mode | Trades | Ret | DD | skipOp | holdH | maxC |', '|---|---|---|---:|---:|---:|---:|---:|---:|');
    for (const fam of ['dd', 'zz']) {
      const block = row.runs[fam];
      if (!block || block.empty) continue;
      for (const [wk, modes] of Object.entries(block.windows || {})) {
        for (const [mk, m] of Object.entries(modes)) {
          if (m.error) { lines.push(`| ${fam} | ${wk} | ${mk} | ERR |`); continue; }
          lines.push(`| ${fam} | ${wk} | ${mk} | ${m.trades} | ${m.ret} | ${m.dd} | ${m.skippedOp} | ${m.avgHoldH} | ${m.maxConcurrent} |`);
        }
      }
    }
    lines.push('');
  }
  fs.writeFileSync(OUT_MD, lines.join('\n') + '\n');
  console.log(OUT_MD);
})().catch((e) => { console.error(e); process.exit(1); });

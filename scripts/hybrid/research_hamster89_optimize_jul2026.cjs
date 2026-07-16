#!/usr/bin/env node
/**
 * Honest portfolio optimization grid for hamster system_89 (ZZ + MRS2), post MRS2 fixes.
 *
 * Reuses the 80 available legs already upserted by run_hamster89_portfolio_bt.cjs
 * (strategies named 'HAM89P::*'). For each of two windows (short = hamster's own
 * 2026-04-01..2026-07-12, long = 2025-06-01..2026-07-12), sweeps:
 *   - book: both / zz-only / mrs2-only
 *   - maxOpenPositions (shared-equity concurrency cap)
 *   - lot sizing: per-leg mapped bal_pct, or a flat global override %
 *   - reinvest % (compounding share)
 *   - Stage 2 refinement: portfolio circuit breaker (dd trigger / pause days /
 *     applyTo zz|mrs2|both) layered on top of the best Stage-1 seeds.
 *
 * Parallelized via child_process worker pool (each worker opens its own sqlite
 * connection in WAL mode; no writes happen during backtests so this is safe).
 *
 * Usage:
 *   node scripts/hybrid/research_hamster89_optimize_jul2026.cjs
 *   WORKERS=10 node scripts/hybrid/research_hamster89_optimize_jul2026.cjs
 *   STAGE1_ONLY=1 node ...   (skip CB refinement)
 *   SEEDS_PER_WINDOW=30 node ...
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/hamster_compound_system89_jul2026');
const BUNDLE = process.env.HYBRID_CANDLE_DIR
  || path.join(REPO, 'results/hybrid_candle_bundle_hamster89');
const CHUNK_DIR = path.join(OUT_DIR, 'optimize_chunks');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
process.env.HYBRID_CANDLE_DIR = BUNDLE;

const INITIAL = 1000;
const COMMISSION = 0.036;
const SLIPPAGE = 0;
const MAX_DEPOSIT_MULT = 5000; // generous so it never becomes an artificial cap
const KEY_NAME = 'BTDD_D1';
const LEG_PREFIX = 'HAM89P::';

const WINDOWS = [
  { key: 'short', from: '2026-04-01', to: '2026-07-12', label: 'hamster window 2026-04-01..07-12 (~102d)' },
  { key: 'long', from: process.env.LONG_FROM || '2025-06-01', to: '2026-07-12', label: 'extended window 2025-06-01..2026-07-12 (~13.5mo)' },
];

const OP_LIST = [6, 8, 10, 12, 16, 20, 24, 32, 40, 89];
const LOT_MODES = ['mapped', 'g1', 'g2', 'g3', 'g4', 'g6', 'g8', 'g10'];
const REINVEST_LIST = [50, 75, 100];
const BOOKS = ['both', 'zz', 'mrs2'];
const CB_DD = [6, 8, 10, 12];
const CB_PAUSE = [7, 14];
const CB_LOT_MULT = 0.5;
const SEEDS_PER_WINDOW = Number(process.env.SEEDS_PER_WINDOW || 12); // per selection criterion
const STAGE1_ONLY = String(process.env.STAGE1_ONLY || '0') === '1';

const lotOverrideFromMode = (mode) => (mode === 'mapped' ? undefined : Number(mode.slice(1)));

const cbConfigFromSpec = (spec) => {
  if (!spec) return undefined;
  const applyToStrategyTypes = spec.applyTo === 'zz'
    ? ['ZZ_Instance', 'ZZ_Fast']
    : spec.applyTo === 'mrs2'
      ? ['MRS2']
      : undefined;
  return {
    enabled: true,
    ddTriggerPercent: spec.dd,
    lotMultiplier: spec.lotMult ?? CB_LOT_MULT,
    pauseDays: spec.pause,
    ...(applyToStrategyTypes ? { applyToStrategyTypes } : {}),
  };
};

const comboLabel = (c) => {
  const cb = c.cb ? `cb(${c.cb.applyTo},dd${c.cb.dd},p${c.cb.pause})` : 'cbNone';
  return `${c.window}|${c.book}|op${c.op}|lot${c.lotMode}|ri${c.reinvest}|${cb}`;
};

const buildStage1Combos = () => {
  const combos = [];
  for (const w of WINDOWS) {
    for (const book of BOOKS) {
      for (const op of OP_LIST) {
        for (const lotMode of LOT_MODES) {
          for (const reinvest of REINVEST_LIST) {
            combos.push({
              stage: 1, window: w.key, book, op, lotMode, reinvest, cb: null,
            });
          }
        }
      }
    }
  }
  return combos;
};

const cbVariantsForBook = (book) => {
  const applyToOptions = book === 'both' ? ['both', 'zz', 'mrs2'] : ['both'];
  const variants = [];
  for (const applyTo of applyToOptions) {
    for (const dd of CB_DD) {
      for (const pause of CB_PAUSE) {
        variants.push({ applyTo, dd, pause, lotMult: CB_LOT_MULT });
      }
    }
  }
  return variants;
};

const dedupeKey = (c) => `${c.window}|${c.book}|${c.op}|${c.lotMode}|${c.reinvest}`;

const selectSeeds = (rows, windowKey) => {
  const pool = rows.filter((r) => r.window === windowKey && !r.error && r.trades >= 5);
  const byRet = (a, b) => b.ret - a.ret;
  const calmar = (r) => r.ret / Math.max(1, r.dd);
  const picks = new Map();
  const take = (arr, n) => arr.slice(0, n).forEach((r) => picks.set(dedupeKey(r), r));

  take([...pool].sort(byRet), SEEDS_PER_WINDOW);
  take([...pool].filter((r) => r.dd <= 20).sort(byRet), SEEDS_PER_WINDOW);
  take([...pool].filter((r) => r.dd <= 12).sort(byRet), SEEDS_PER_WINDOW);
  take([...pool].filter((r) => r.trades >= 30).sort((a, b) => calmar(b) - calmar(a)), SEEDS_PER_WINDOW);

  return [...picks.values()];
};

const buildStage2Combos = (stage1Rows) => {
  const combos = [];
  for (const w of WINDOWS) {
    const seeds = selectSeeds(stage1Rows, w.key);
    for (const seed of seeds) {
      for (const cb of cbVariantsForBook(seed.book)) {
        combos.push({
          stage: 2, window: seed.window, book: seed.book, op: seed.op,
          lotMode: seed.lotMode, reinvest: seed.reinvest, cb,
        });
      }
    }
  }
  return combos;
};

// ---------------------------------------------------------------------------
// Worker mode: process one JSON chunk of combos, write results JSON.
// ---------------------------------------------------------------------------
const runWorker = async (chunkPath, outPath) => {
  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const db = database.db;

  const legRows = await db.all(`SELECT id, strategy_type FROM strategies WHERE name LIKE ?`, [`${LEG_PREFIX}%`]);
  const zzIds = legRows.filter((r) => r.strategy_type === 'ZZ_Instance' || r.strategy_type === 'ZZ_Fast').map((r) => r.id);
  const mrsIds = legRows.filter((r) => r.strategy_type === 'MRS2').map((r) => r.id);
  const allIds = legRows.map((r) => r.id);
  const idsByBook = { both: allIds, zz: zzIds, mrs2: mrsIds };

  const windowByKey = new Map(WINDOWS.map((w) => [w.key, w]));
  const { combos } = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));
  const results = [];

  for (const c of combos) {
    const w = windowByKey.get(c.window);
    const ids = idsByBook[c.book];
    const row = {
      ...c,
      window: c.window,
      label: comboLabel(c),
      legs: ids.length,
    };
    try {
      const bt = await runBacktest({
        apiKeyName: KEY_NAME,
        mode: 'portfolio',
        strategyIds: ids,
        dateFrom: w.from,
        dateTo: w.to,
        bars: 20000,
        warmupBars: 0,
        initialBalance: INITIAL,
        commissionPercent: COMMISSION,
        slippagePercent: SLIPPAGE,
        lotPercentOverride: lotOverrideFromMode(c.lotMode),
        reinvestPercentOverride: c.reinvest,
        maxDepositOverride: INITIAL * MAX_DEPOSIT_MULT,
        maxOpenPositions: c.op,
        portfolioCircuitBreaker: cbConfigFromSpec(c.cb),
        skipMissingSymbols: true,
      });
      const s = bt.summary || {};
      row.ret = +Number(s.totalReturnPercent || 0).toFixed(2);
      row.dd = +Number(s.maxDrawdownPercent || 0).toFixed(2);
      row.pf = +Number(s.profitFactor || 0).toFixed(3);
      row.trades = +(s.tradesCount || 0);
      row.wr = +Number(s.winRatePercent || 0).toFixed(2);
      row.end = +Number(s.finalEquity || 0).toFixed(2);
      row.cbTriggers = +(s.portfolioCircuitBreakerTriggers || 0);
      row.calmar = row.dd > 0 ? +(row.ret / row.dd).toFixed(2) : null;
    } catch (e) {
      row.error = String(e.message || e).slice(0, 200);
    }
    results.push(row);
  }
  fs.writeFileSync(outPath, JSON.stringify({ results }));
};

// ---------------------------------------------------------------------------
// Orchestrator: split combos, spawn workers, merge, rank, write reports.
// ---------------------------------------------------------------------------
const nodeBin = () => process.execPath;

const spawnWorkerProc = (workerId, chunkPath, outPath) => new Promise((resolve, reject) => {
  const child = spawn(nodeBin(), [__filename, '--worker', chunkPath, outPath], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  child.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`worker-${workerId} exit ${code}: ${stderr.slice(-800)}`));
  });
});

const runComboBatch = async (combos, label) => {
  fs.mkdirSync(CHUNK_DIR, { recursive: true });
  const workerCount = Math.max(1, Math.min(16, Number(process.env.WORKERS || Math.max(2, (os.cpus().length || 8) - 2))));
  const chunkSize = Math.ceil(combos.length / workerCount);
  const jobs = [];
  for (let w = 0; w < workerCount; w++) {
    const slice = combos.slice(w * chunkSize, (w + 1) * chunkSize);
    if (!slice.length) continue;
    const chunkPath = path.join(CHUNK_DIR, `${label}_chunk_${w}.json`);
    const outPath = path.join(CHUNK_DIR, `${label}_result_${w}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify({ combos: slice }));
    jobs.push({ id: w, chunkPath, outPath });
  }
  console.log(`[${label}] ${combos.length} combos -> ${jobs.length} workers (~${chunkSize}/worker)`);
  const t0 = Date.now();
  await Promise.all(jobs.map((j) => spawnWorkerProc(j.id, j.chunkPath, j.outPath)));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${label}] done in ${elapsed}s`);

  const merged = [];
  for (const j of jobs) {
    const part = JSON.parse(fs.readFileSync(j.outPath, 'utf8'));
    merged.push(...(part.results || []));
  }
  return merged;
};

const fmtRow = (r) => `| ${r.window} | ${r.book} | ${r.op} | ${r.lotMode} | ${r.reinvest} | ${r.cb ? `${r.cb.applyTo}/dd${r.cb.dd}/p${r.cb.pause}` : '—'} | ${r.ret}% | ${r.dd}% | ${r.pf} | ${r.trades} | ${r.calmar ?? '—'} | $${r.end} |`;

const topTable = (rows, title) => {
  const header = `### ${title}\n\n| window | book | OP | lot | RI% | CB | ret% | maxDD% | PF | trades | ret/dd | end equity |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  return header + rows.map(fmtRow).join('\n') + '\n';
};

// Curated candidates we specifically want surfaced in the report (looked up
// from the actual grid results, not re-simulated) — see COMPARISON write-up.
const RECOMMENDED_PRESETS = [
  {
    name: 'Conservative core (MRS2-only)',
    match: (r) => r.book === 'mrs2' && r.op === 16 && r.lotMode === 'g6' && r.reinvest === 100 && !r.cb,
  },
  {
    name: 'Balanced growth (MRS2-only)',
    match: (r) => r.book === 'mrs2' && r.op === 20 && r.lotMode === 'g8' && r.reinvest === 100 && !r.cb,
  },
  {
    name: 'Max growth, DD-capped (ZZ+MRS2, ZZ-tiered CB)',
    match: (r) => r.book === 'both' && r.op === 89 && r.lotMode === 'g10' && r.reinvest === 100
      && r.cb && r.cb.applyTo === 'zz' && r.cb.dd === 6 && r.cb.pause === 7,
  },
];

const buildRecommendations = (allRows) => {
  const out = [];
  for (const preset of RECOMMENDED_PRESETS) {
    const rows = {};
    for (const w of WINDOWS) {
      const hit = allRows.find((r) => r.window === w.key && preset.match(r));
      if (hit) rows[w.key] = hit;
    }
    out.push({ name: preset.name, rows });
  }
  return out;
};

const main = async () => {
  if (process.argv[2] === '--worker') {
    await runWorker(process.argv[3], process.argv[4]);
    process.exit(0);
    return;
  }

  console.log('=== Stage 1: base grid (book x OP x lot mode x reinvest, no CB) ===');
  const stage1Combos = buildStage1Combos();
  const stage1Rows = await runComboBatch(stage1Combos, 'stage1');

  let stage2Rows = [];
  if (!STAGE1_ONLY) {
    console.log('=== Stage 2: circuit-breaker refinement on top Stage-1 seeds ===');
    const stage2Combos = buildStage2Combos(stage1Rows);
    stage2Rows = await runComboBatch(stage2Combos, 'stage2');
  }

  const allRows = [...stage1Rows, ...stage2Rows].filter((r) => !r.error);
  const errorRows = [...stage1Rows, ...stage2Rows].filter((r) => r.error);

  const byWindow = {};
  for (const w of WINDOWS) {
    const rows = allRows.filter((r) => r.window === w.key);
    const unconstrained = [...rows].sort((a, b) => b.ret - a.ret).slice(0, 10);
    const dd20 = [...rows].filter((r) => r.dd <= 20).sort((a, b) => b.ret - a.ret).slice(0, 10);
    const dd12 = [...rows].filter((r) => r.dd <= 12).sort((a, b) => b.ret - a.ret).slice(0, 10);
    const bestCalmar = [...rows].filter((r) => r.trades >= 30 && r.calmar != null).sort((a, b) => b.calmar - a.calmar).slice(0, 10);
    byWindow[w.key] = { window: w, unconstrained, dd20, dd12, bestCalmar, totalRows: rows.length };
  }

  const recommendations = buildRecommendations(allRows);

  const payload = {
    generatedAt: new Date().toISOString(),
    windows: WINDOWS,
    recommendations,
    grid: {
      op: OP_LIST, lotModes: LOT_MODES, reinvest: REINVEST_LIST, books: BOOKS,
      cbDdTrigger: CB_DD, cbPauseDays: CB_PAUSE, cbLotMultiplier: CB_LOT_MULT,
      seedsPerWindow: SEEDS_PER_WINDOW,
    },
    stage1Count: stage1Rows.length,
    stage2Count: stage2Rows.length,
    errorCount: errorRows.length,
    hamsterBaseline: { ret_pct: 3584.8, max_dd_pct: 6.87, window: '2026-04-01..2026-07-12' },
    naivePortfolioBaseline: { ret_pct: 12941.4, max_dd_pct: 58.87, window: '2026-04-01..2026-07-12', note: 'lotMode=mapped, reinvest=100, OP=89, no CB' },
    byWindow,
    allRows,
    errorRows: errorRows.slice(0, 50),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'optimize_grid.json'), JSON.stringify(payload, null, 2));

  let md = `# Hamster system_89 portfolio optimization (ZZ + MRS2)\n\n`;
  md += `Generated ${payload.generatedAt}. Stage 1 (base grid): ${stage1Rows.length} runs. `;
  md += `Stage 2 (CB refinement): ${stage2Rows.length} runs. Errors: ${errorRows.length}.\n\n`;
  md += `Hamster live baseline (2026-04-01..07-12): **+3584.8% / DD 6.87%**. `;
  md += `Naive BTDD portfolio (mapped lot, OP=89, RI=100, no CB): **+12941.4% / DD 58.87%**.\n\n`;

  md += `## Recommended production candidates\n\n`;
  md += `| preset | window | book | OP | lot | RI% | CB | ret% | maxDD% | PF | trades |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const rec of recommendations) {
    for (const w of WINDOWS) {
      const r = rec.rows[w.key];
      if (!r) { md += `| ${rec.name} | ${w.key} | — | — | — | — | — | n/a | n/a | n/a | n/a |\n`; continue; }
      const cb = r.cb ? `${r.cb.applyTo}/dd${r.cb.dd}/p${r.cb.pause}` : '—';
      md += `| ${rec.name} | ${w.key} | ${r.book} | ${r.op} | ${r.lotMode} | ${r.reinvest} | ${cb} | ${r.ret}% | ${r.dd}% | ${r.pf} | ${r.trades} |\n`;
    }
  }
  md += '\n';

  for (const w of WINDOWS) {
    const b = byWindow[w.key];
    md += `\n## Window: ${w.label}\n\n`;
    md += topTable(b.dd12, `Top by return with maxDD ≤ 12% (${b.dd12.length})`);
    md += '\n';
    md += topTable(b.dd20, `Top by return with maxDD ≤ 20% (${b.dd20.length})`);
    md += '\n';
    md += topTable(b.unconstrained, `Unconstrained best by return (${b.unconstrained.length})`);
    md += '\n';
    md += topTable(b.bestCalmar, `Best return/maxDD ("calmar-like"), trades≥30 (${b.bestCalmar.length})`);
    md += '\n';
  }
  fs.writeFileSync(path.join(OUT_DIR, 'optimize_grid.md'), md);

  console.log('\n=== DONE ===');
  console.log(`wrote ${path.join(OUT_DIR, 'optimize_grid.json')}`);
  console.log(`wrote ${path.join(OUT_DIR, 'optimize_grid.md')}`);
  for (const w of WINDOWS) {
    const b = byWindow[w.key];
    console.log(`\n-- ${w.key} --`);
    console.log('best dd<=12:', b.dd12[0] ? fmtRow(b.dd12[0]) : 'none');
    console.log('best dd<=20:', b.dd20[0] ? fmtRow(b.dd20[0]) : 'none');
    console.log('best unconstrained:', b.unconstrained[0] ? fmtRow(b.unconstrained[0]) : 'none');
  }
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

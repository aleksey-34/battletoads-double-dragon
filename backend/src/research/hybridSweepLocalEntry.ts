/**
 * Local hybrid sweep orchestrator: pre-creates strategies, forks N worker processes.
 *
 * Usage:
 *   HYBRID_CANDLE_DIR=results/hybrid_candle_bundle \
 *   DB_FILE=backend/database.db.vps_snapshot \
 *   HYBRID_SWEEP_WORKERS=12 HYBRID_QUIET=1 LOG_CONSOLE_LEVEL=error \
 *   node dist/research/hybridSweepLocalEntry.js scripts/hybrid/configs/synth_4h_ct_zz_20260701.json
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { initDB } from '../utils/database';
import { getStrategies, createStrategy } from '../bot/strategy';
import { preloadHybridCandles } from '../bot/hybridCandleStore';
import {
  buildHistoricalSweepRunPlans,
  type HistoricalSweepConfig,
} from './fullHistoricalSweepService';
import type { Strategy } from '../config/settings';

type SweepRecord = {
  strategyId: number;
  strategyName: string;
  strategyType: string;
  marketMode: string;
  market: string;
  interval: string;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  tradesCount: number;
  winRatePercent: number;
  score: number;
  robust: boolean;
  runIndex: number;
};

const buildDraft = (plan: ReturnType<typeof buildHistoricalSweepRunPlans>[number], config: HistoricalSweepConfig) => ({
  name: plan.strategyName,
  strategy_type: plan.strategyType,
  market_mode: plan.marketMode === 'mono' ? 'mono' : 'synthetic',
  is_active: false,
  take_profit_percent: plan.takeProfitPercent,
  price_channel_length: plan.length,
  detection_source: plan.detectionSource,
  zscore_entry: plan.zscoreEntry,
  zscore_exit: plan.zscoreExit,
  zscore_stop: plan.zscoreStop,
  base_symbol: plan.baseSymbol,
  quote_symbol: plan.marketMode === 'mono' ? '' : plan.quoteSymbol,
  interval: plan.interval,
  base_coef: 1,
  quote_coef: plan.marketMode === 'mono' ? 0 : 1,
  long_enabled: true,
  short_enabled: !config.longOnly,
  lot_long_percent: config.sweepLotPercent,
  lot_short_percent: config.sweepLotPercent,
  max_deposit: config.sweepMaxDeposit,
  margin_type: 'cross',
  leverage: config.spotMode ? 1 : 20,
  fixed_lot: false,
  reinvest_percent: config.sweepReinvestPercent,
  market_type: config.spotMode ? 'spot' : 'futures',
});

const nodeBin = (): string => {
  const env = String(process.env.NODE_BIN || '').trim();
  if (env && fs.existsSync(env)) return env;
  if (fs.existsSync('/usr/bin/node')) return '/usr/bin/node';
  return process.execPath;
};

const runWorker = (
  workerId: number,
  configPath: string,
  chunkPath: string,
  outPath: string,
): Promise<void> => new Promise((resolve, reject) => {
  const workerJs = path.join(__dirname, 'hybridSweepWorkerEntry.js');
  const memMb = Math.max(768, Number(process.env.HYBRID_WORKER_MEM_MB || 1024));
  const child = spawn(nodeBin(), [workerJs, configPath, chunkPath, outPath], {
    env: {
      ...process.env,
      HYBRID_WORKER_ID: String(workerId),
      HYBRID_QUIET: '1',
      LOG_CONSOLE_LEVEL: 'error',
      NODE_OPTIONS: `--max-old-space-size=${memMb}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  child.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`worker-${workerId} exit ${code}: ${stderr.slice(-500)}`));
  });
});

async function main(): Promise<void> {
  const configPath = path.resolve(process.argv[2] || '');
  if (!configPath || !fs.existsSync(configPath)) {
    console.error('Usage: hybridSweepLocalEntry.js <sweep-config.json>');
    process.exit(2);
  }
  const bundleDir = process.env.HYBRID_CANDLE_DIR;
  if (!bundleDir || !fs.existsSync(bundleDir)) {
    console.error('HYBRID_CANDLE_DIR must point to exported candle bundle');
    process.exit(3);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as HistoricalSweepConfig;
  await initDB();

  const allPlans = buildHistoricalSweepRunPlans(config);
  const maxRuns = Math.max(1, Number(config.maxRuns || allPlans.length));
  const plans = allPlans.slice(0, maxRuns);
  const workerCount = Math.max(1, Math.min(
    16,
    Number(process.env.HYBRID_SWEEP_WORKERS || process.env.HYBRID_SWEEP_CONCURRENCY || Math.max(2, Math.floor((os.cpus().length || 8) / 2))),
  ));

  const intervals = config.intervals?.length ? config.intervals : [config.interval || '4h'];
  const pre = preloadHybridCandles(intervals);
  console.log(`[hybrid-sweep] preloaded ${pre.loaded} candle files (${pre.symbols} symbols)`);

  const existing = await getStrategies(config.apiKeyName, { includeLotPreview: false });
  const strategyMap = new Map<string, Strategy>();
  for (const s of existing) {
    if (s.name) strategyMap.set(String(s.name), s);
  }

  console.log(`[hybrid-sweep] plans=${plans.length}/${allPlans.length} workers=${workerCount} bundle=${bundleDir}`);
  console.log('[hybrid-sweep] ensuring strategies in DB...');

  const workerPlans: Array<{
    index: number;
    strategyId: number;
    strategyName: string;
    strategyType: string;
    marketMode: string;
    market: string;
    interval: string;
  }> = [];

  let created = 0;
  for (const plan of plans) {
    let strategy = strategyMap.get(plan.strategyName);
    if (!strategy?.id) {
      strategy = await createStrategy(config.apiKeyName, buildDraft(plan, config) as any, { allowActivePairConflict: true });
      strategyMap.set(plan.strategyName, strategy);
      created++;
      if (created % 200 === 0) {
        console.log(`  created ${created} strategies...`);
      }
    }
    workerPlans.push({
      index: plan.index,
      strategyId: Number(strategy.id || 0),
      strategyName: plan.strategyName,
      strategyType: plan.strategyType,
      marketMode: plan.marketMode,
      market: plan.market,
      interval: plan.interval,
    });
  }
  console.log(`[hybrid-sweep] strategies ready (new=${created}, total=${workerPlans.length})`);

  const chunkDir = path.join(path.dirname(bundleDir), `hybrid_sweep_chunks_${config.strategyPrefix || 'local'}`);
  fs.mkdirSync(chunkDir, { recursive: true });

  const loadResumeState = (): { done: Set<number>; evaluated: SweepRecord[]; failures: Array<{ runIndex: number; strategyName: string; error: string }> } => {
    const done = new Set<number>();
    const evaluated: SweepRecord[] = [];
    const failures: Array<{ runIndex: number; strategyName: string; error: string }> = [];
    if (!fs.existsSync(chunkDir)) return { done, evaluated, failures };
    for (const file of fs.readdirSync(chunkDir).filter((f) => f.startsWith('result_') && f.endsWith('.json'))) {
      try {
        const part = JSON.parse(fs.readFileSync(path.join(chunkDir, file), 'utf-8')) as {
          evaluated?: SweepRecord[];
          failures?: Array<{ runIndex: number; strategyName: string; error: string }>;
        };
        for (const row of part.evaluated || []) {
          if (row?.runIndex) done.add(Number(row.runIndex));
        }
        evaluated.push(...(part.evaluated || []));
        failures.push(...(part.failures || []));
      } catch { /* ignore */ }
    }
    return { done, evaluated, failures };
  };

  const resumeState = loadResumeState();
  const resumeDone = resumeState.done;
  const resumedEvaluated = resumeState.evaluated;
  const resumedFailures = resumeState.failures;
  const pendingPlans = resumeDone.size
    ? workerPlans.filter((p) => !resumeDone.has(p.index))
    : workerPlans;
  if (resumeDone.size > 0) {
    console.log(`[hybrid-sweep] resume: ${resumeDone.size} done, ${pendingPlans.length} pending`);
    for (const file of fs.readdirSync(chunkDir).filter((f) => f.startsWith('chunk_') || f.startsWith('result_'))) {
      try { fs.unlinkSync(path.join(chunkDir, file)); } catch { /* ignore */ }
    }
  }

  const chunkSize = Math.ceil(pendingPlans.length / workerCount);
  const t0 = Date.now();
  const workerJobs: Array<{ id: number; chunkPath: string; outPath: string }> = [];

  for (let w = 0; w < workerCount; w++) {
    const slice = pendingPlans.slice(w * chunkSize, (w + 1) * chunkSize);
    if (slice.length === 0) continue;
    const chunkPath = path.join(chunkDir, `chunk_${w}.json`);
    const outPath = path.join(chunkDir, `result_${w}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify({ plans: slice }));
    workerJobs.push({ id: w, chunkPath, outPath });
  }

  console.log(`[hybrid-sweep] spawning ${workerJobs.length} worker processes...`);
  const chunkDone = (outPath: string, chunkPath: string): boolean => {
    if (!fs.existsSync(outPath)) return false;
    try {
      const part = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as { evaluated?: unknown[]; partial?: boolean };
      if (part.partial === true) return false;
      const chunk = JSON.parse(fs.readFileSync(chunkPath, 'utf-8')) as { plans?: unknown[] };
      const expected = chunk.plans?.length ?? 0;
      return Array.isArray(part.evaluated) && part.evaluated.length >= expected && expected > 0;
    } catch {
      return false;
    }
  };
  const pendingJobs = workerJobs.filter((job) => {
    if (chunkDone(job.outPath, job.chunkPath)) {
      console.log(`  worker-${job.id}: resume skip (chunk already done)`);
      return false;
    }
    return true;
  });
  if (pendingJobs.length === 0) {
    console.log('[hybrid-sweep] all worker chunks already complete');
  } else {
    const results = await Promise.allSettled(
      pendingJobs.map(async (job) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await runWorker(job.id, configPath, job.chunkPath, job.outPath);
            return;
          } catch (e) {
            if (attempt >= 2) throw e;
            console.warn(`[hybrid-sweep] worker-${job.id} failed, retry: ${(e as Error).message}`);
          }
        }
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`[hybrid-sweep] ${failed.length} worker(s) failed after retry — partial results kept`);
    }
  }

  const evaluated: SweepRecord[] = [...resumedEvaluated];
  const failures: Array<{ runIndex: number; strategyName: string; error: string }> = [...resumedFailures];
  for (const job of workerJobs) {
    if (!fs.existsSync(job.outPath)) continue;
    const part = JSON.parse(fs.readFileSync(job.outPath, 'utf-8')) as {
      evaluated?: SweepRecord[];
      failures?: Array<{ runIndex: number; strategyName: string; error: string }>;
    };
    evaluated.push(...(part.evaluated || []));
    failures.push(...(part.failures || []));
  }
  evaluated.sort((a, b) => a.runIndex - b.runIndex);

  const repoRoot = path.resolve(__dirname, '../../..');
  const outDir = path.join(repoRoot, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `hybrid_sweep_${config.strategyPrefix || 'local'}_${ts}.json`);
  const payload = {
    timestamp: new Date().toISOString(),
    hybrid: true,
    poolWorkers: workerJobs.length,
    apiKeyName: config.apiKeyName,
    config,
    counts: {
      scheduledRuns: plans.length,
      evaluated: evaluated.length,
      failures: failures.length,
      robust: evaluated.filter((r) => r.robust).length,
    },
    evaluated,
    failures,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const rate = (evaluated.length / Math.max(1, Number(elapsed))).toFixed(2);
  console.log(`[hybrid-sweep] done ${evaluated.length}/${plans.length} in ${elapsed}s (${rate} runs/s)`);
  console.log(`[hybrid-sweep] wrote ${outPath}`);
  // cleanup chunk dir optional
  try {
    for (const job of workerJobs) {
      if (fs.existsSync(job.chunkPath)) fs.unlinkSync(job.chunkPath);
    }
  } catch { /* ignore */ }
}

main().catch((err) => {
  console.error('[hybrid-sweep] fatal:', err);
  process.exit(1);
});

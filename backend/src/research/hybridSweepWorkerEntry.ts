/**
 * Hybrid sweep worker subprocess — runs one chunk of backtests with preloaded candles.
 * Invoked by hybridSweepLocalEntry (process pool).
 */
import fs from 'fs';
import { initDB } from '../utils/database';
import { runBacktest } from '../backtest/engine';
import { preloadHybridCandles } from '../bot/hybridCandleStore';
import type { HistoricalSweepConfig } from './fullHistoricalSweepService';

type WorkerPlan = {
  index: number;
  strategyId: number;
  strategyName: string;
  strategyType: string;
  marketMode: string;
  market: string;
  interval: string;
};

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

const computeScore = (ret: number, pf: number, dd: number, wr: number, trades: number): number => {
  const tradeBonus = Math.min(12, Math.log10(Math.max(1, trades)) * 5);
  const ddOverPenalty = dd > 30 ? (dd - 30) * 2.5 : 0;
  const ddUnderBonus = dd <= 30 ? (30 - dd) * 0.35 : 0;
  return Number((ret + pf * 10 + wr * 0.12 - dd * 1.2 - ddOverPenalty + ddUnderBonus + tradeBonus).toFixed(6));
};

const isRobust = (config: HistoricalSweepConfig, r: SweepRecord): boolean =>
  r.profitFactor >= config.robust.minProfitFactor
  && r.maxDrawdownPercent <= config.robust.maxDrawdownPercent
  && r.tradesCount >= config.robust.minTrades;

async function main(): Promise<void> {
  const configPath = process.argv[2];
  const chunkPath = process.argv[3];
  const outPath = process.argv[4];
  if (!configPath || !chunkPath || !outPath) {
    console.error('Usage: hybridSweepWorkerEntry.js <config.json> <chunk.json> <out.json>');
    process.exit(2);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as HistoricalSweepConfig;
  const chunk = JSON.parse(fs.readFileSync(chunkPath, 'utf-8')) as { plans: WorkerPlan[] };
  const plans = Array.isArray(chunk.plans) ? chunk.plans : [];

  const bundleDir = process.env.HYBRID_CANDLE_DIR;
  if (!bundleDir) {
    console.error('HYBRID_CANDLE_DIR required');
    process.exit(3);
  }

  await initDB();
  const intervals = config.intervals?.length ? config.intervals : [config.interval || '4h'];

  const evaluated: SweepRecord[] = [];
  const failures: Array<{ runIndex: number; strategyName: string; error: string }> = [];
  const workerId = process.env.HYBRID_WORKER_ID || '?';
  const progressPath = outPath.replace(/result_(.+)\.json$/, 'progress_$1.json');
  const t0 = Date.now();

  const writeProgress = () => {
    try {
      fs.writeFileSync(progressPath, JSON.stringify({
        workerId,
        done: evaluated.length,
        failures: failures.length,
        total: plans.length,
        elapsedSec: (Date.now() - t0) / 1000,
        updatedAt: new Date().toISOString(),
        phase: evaluated.length > 0 ? 'running' : 'ready',
      }));
    } catch { /* ignore */ }
  };

  preloadHybridCandles(intervals);
  writeProgress(); // heartbeat после загрузки свечей

  const writeCheckpoint = () => {
    try {
      fs.writeFileSync(outPath, JSON.stringify({
        workerId,
        evaluated,
        failures,
        partial: true,
        elapsedSec: (Date.now() - t0) / 1000,
      }));
    } catch { /* ignore */ }
  };

  // Resume from partial checkpoint if worker crashed mid-chunk
  if (fs.existsSync(outPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
        evaluated?: SweepRecord[];
        failures?: Array<{ runIndex: number; strategyName: string; error: string }>;
        partial?: boolean;
      };
      if (prev.partial && Array.isArray(prev.evaluated)) {
        evaluated.push(...prev.evaluated);
        if (Array.isArray(prev.failures)) failures.push(...prev.failures);
        console.log(`[hybrid-worker-${workerId}] resume ${evaluated.length}/${plans.length}`);
      }
    } catch { /* ignore corrupt checkpoint */ }
  }
  const doneIndices = new Set(evaluated.map((r) => r.runIndex));

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (doneIndices.has(plan.index)) continue;
    try {
      const result = await runBacktest({
        apiKeyName: config.apiKeyName,
        mode: 'single',
        strategyId: plan.strategyId,
        bars: config.backtestBars,
        dateFrom: config.dateFrom,
        dateTo: config.dateTo || undefined,
        warmupBars: config.warmupBars,
        skipMissingSymbols: config.skipMissingSymbols,
        initialBalance: config.initialBalance,
        commissionPercent: config.commissionPercent,
        slippagePercent: config.slippagePercent,
        fundingRatePercent: config.fundingRatePercent,
      });
      const s = result.summary;
      const rec: SweepRecord = {
        strategyId: plan.strategyId,
        strategyName: plan.strategyName,
        strategyType: plan.strategyType,
        marketMode: plan.marketMode,
        market: plan.market,
        interval: plan.interval,
        totalReturnPercent: Number(s.totalReturnPercent || 0),
        maxDrawdownPercent: Number(s.maxDrawdownPercent || 0),
        profitFactor: Number(s.profitFactor || 0),
        tradesCount: Number(s.tradesCount || 0),
        winRatePercent: Number(s.winRatePercent || 0),
        score: 0,
        robust: false,
        runIndex: plan.index,
      };
      rec.score = computeScore(rec.totalReturnPercent, rec.profitFactor, rec.maxDrawdownPercent, rec.winRatePercent, rec.tradesCount);
      rec.robust = isRobust(config, rec);
      evaluated.push(rec);
    } catch (e) {
      failures.push({ runIndex: plan.index, strategyName: plan.strategyName, error: (e as Error).message });
    }
    if (i === 0 || (i + 1) % 10 === 0 || i + 1 === plans.length) writeProgress();
    if ((evaluated.length % 50 === 0 && evaluated.length > 0) || i + 1 === plans.length) writeCheckpoint();
  }

  try { fs.unlinkSync(progressPath); } catch { /* ignore */ }
  fs.writeFileSync(outPath, JSON.stringify({ workerId, evaluated, failures, partial: false, elapsedSec: (Date.now() - t0) / 1000 }));
  console.log(`[hybrid-worker-${workerId}] done ${evaluated.length}/${plans.length} fails=${failures.length}`);
}

main().catch((err) => {
  console.error('[hybrid-worker] fatal:', err);
  process.exit(1);
});

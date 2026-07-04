/**
 * Build global chunk manifest for distributed hybrid sweep (no workers).
 *
 * HYBRID_CANDLE_DIR=results/hybrid_candle_bundle_v2 \
 * DB_FILE=backend/database.db.hybrid_slim \
 * HYBRID_GLOBAL_CHUNKS=10 \
 * node dist/research/hybridSweepPlanEntry.js scripts/hybrid/configs/synth_4h_v2_jul2026.json
 */
import fs from 'fs';
import path from 'path';
import { initDB } from '../utils/database';
import { getStrategies, createStrategy } from '../bot/strategy';
import {
  buildHistoricalSweepRunPlans,
  type HistoricalSweepConfig,
} from './fullHistoricalSweepService';
import type { Strategy } from '../config/settings';

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

async function main(): Promise<void> {
  const configPath = path.resolve(process.argv[2] || '');
  if (!configPath || !fs.existsSync(configPath)) {
    console.error('Usage: hybridSweepPlanEntry.js <sweep-config.json>');
    process.exit(2);
  }
  const bundleDir = process.env.HYBRID_CANDLE_DIR;
  if (!bundleDir || !fs.existsSync(bundleDir)) {
    console.error('HYBRID_CANDLE_DIR must point to exported candle bundle');
    process.exit(3);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as HistoricalSweepConfig;
  const globalChunks = Math.max(1, Number(process.env.HYBRID_GLOBAL_CHUNKS || 10));
  const prefix = config.strategyPrefix || 'local';
  const repoRoot = path.resolve(__dirname, '../../..');
  const manifestDir = path.join(
    repoRoot,
    'results',
    `hybrid_sweep_distributed_${prefix}`,
  );

  await initDB();
  const allPlans = buildHistoricalSweepRunPlans(config);
  const maxRuns = Math.max(1, Number(config.maxRuns || allPlans.length));
  const plans = allPlans.slice(0, maxRuns);

  const existing = await getStrategies(config.apiKeyName, { includeLotPreview: false });
  const strategyMap = new Map<string, Strategy>();
  for (const s of existing) {
    if (s.name) strategyMap.set(String(s.name), s);
  }

  console.log(`[hybrid-plan] plans=${plans.length}/${allPlans.length} globalChunks=${globalChunks}`);
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
  console.log(`[hybrid-plan] strategies ready (new=${created}, total=${workerPlans.length})`);

  fs.mkdirSync(manifestDir, { recursive: true });
  const chunkSize = Math.ceil(workerPlans.length / globalChunks);
  const chunkIds: number[] = [];

  for (let c = 0; c < globalChunks; c++) {
    const slice = workerPlans.slice(c * chunkSize, (c + 1) * chunkSize);
    if (slice.length === 0) continue;
    const chunkPath = path.join(manifestDir, `chunk_${String(c).padStart(2, '0')}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify({ chunkId: c, plans: slice }));
    chunkIds.push(c);
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    strategyPrefix: prefix,
    configPath: path.relative(repoRoot, configPath),
    bundleDir: path.relative(repoRoot, bundleDir),
    globalChunks: chunkIds.length,
    totalPlans: workerPlans.length,
    chunkIds,
    nodes: {
      vps: { chunks: '0-1', workers: 2 },
      local: { chunks: '2-5', workers: 4 },
      i5: { chunks: '6-9', workers: 4 },
    },
  };
  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[hybrid-plan] wrote ${chunkIds.length} chunks → ${manifestDir}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error('[hybrid-plan] fatal:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * TV momentum cloud sweep — 4 workers, hybrid 15m candles from VPS bundle.
 *
 *   HYBRID_CANDLE_DIR=results/hybrid_candle_bundle_15m HYBRID_SWEEP_WORKERS=4 \
 *   node scripts/hybrid/sweep_tv_momentum_cloud.mjs
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const backendRoot = path.join(root, 'backend');
const require = createRequire(import.meta.url);
const hybrid = require(path.join(backendRoot, 'dist/bot/hybridCandleStore.js'));

const OUT_DIR = process.env.OUT_DIR || path.join(root, 'results', 'tv_momentum_cloud');
const WORKERS = Math.max(1, Math.min(8, Number(process.env.HYBRID_SWEEP_WORKERS || 4)));
const bundleDir = process.env.HYBRID_CANDLE_DIR || path.join(root, 'results', 'hybrid_candle_bundle_15m');

if (!fs.existsSync(bundleDir)) {
  console.error(`Missing HYBRID_CANDLE_DIR: ${bundleDir}`);
  process.exit(3);
}

process.env.HYBRID_CANDLE_DIR = bundleDir;

const configPath = process.env.TV_CLOUD_CONFIG
  || path.join(root, 'scripts/hybrid/configs/tv_momentum_cloud_15m_jul2026.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const requested = (config.monoMarkets || []).map((s) => String(s).trim().toUpperCase());
const available = new Set(hybrid.listHybridCandleSymbols('15m'));
const symbols = requested.filter((s) => available.has(s.replace(/[^A-Z0-9]/g, '')));
const missing = requested.filter((s) => !available.has(s.replace(/[^A-Z0-9]/g, '')));

console.log(`[tv-cloud-sweep] bundle=${bundleDir} symbols=${symbols.length}/${requested.length} workers=${WORKERS}`);
if (missing.length) console.log(`[tv-cloud-sweep] missing candles (${missing.length}): ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const chunkDir = path.join(OUT_DIR, 'chunks');
fs.mkdirSync(chunkDir, { recursive: true });

const chunks = Array.from({ length: WORKERS }, () => []);
symbols.forEach((s, i) => chunks[i % WORKERS].push(s));

const workerJs = path.join(__dirname, 'sweep_tv_momentum_cloud_worker.mjs');
const nodeBin = process.env.NODE_BIN || process.execPath;
const memMb = Math.max(512, Number(process.env.HYBRID_WORKER_MEM_MB || 768));

const runWorker = (id, syms) => new Promise((resolve, reject) => {
  const symFile = path.join(chunkDir, `symbols_w${id}.json`);
  const outFile = path.join(chunkDir, `result_w${id}.json`);
  fs.writeFileSync(symFile, JSON.stringify(syms));
  const child = spawn(nodeBin, [workerJs, symFile, outFile], {
    env: {
      ...process.env,
      HYBRID_CANDLE_DIR: bundleDir,
      HYBRID_WORKER_ID: String(id),
      NODE_OPTIONS: `--max-old-space-size=${memMb}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr?.on('data', (d) => { err += String(d); process.stderr.write(d); });
  child.on('close', (code) => {
    if (code === 0) resolve(outFile);
    else reject(new Error(`worker-${id} exit ${code}: ${err.slice(-400)}`));
  });
});

const started = Date.now();
const outs = await Promise.all(chunks.map((c, i) => (c.length ? runWorker(i, c) : Promise.resolve(null))));
const allRows = [];
for (const f of outs) {
  if (!f || !fs.existsSync(f)) continue;
  allRows.push(...(JSON.parse(fs.readFileSync(f, 'utf-8')).rows || []));
}

const ok = allRows.filter((r) => !r.skip);
const dual = ok.filter((r) => r.ep4?.ret > 0 && r.ep3?.ret > 0 && r.full?.trades >= 60);
dual.sort((a, b) => {
  const score = (x) => x.ep4.ret + x.ep3.ret + x.full.ret * 0.3 - x.full.dd * 0.5 + Math.min(x.full.trades, 400) * 0.02;
  return score(b) - score(a);
});

const report = {
  generatedAt: new Date().toISOString(),
  bundleDir,
  dateRange: [process.env.DATE_FROM || '2024-06-01', process.env.DATE_TO || '2026-07-04'],
  preset: { emaFast: 8, emaSlow: 21, adxMin: 20, tpPercent: 2, slPercent: 1.2, sideMode: 'both' },
  requested: requested.length,
  withCandles: symbols.length,
  scanned: ok.length,
  dualPositive: dual.length,
  topDual: dual.slice(0, 40),
  all: ok.sort((a, b) => b.full.ret - a.full.ret),
  missingSymbols: missing,
};

const outPath = path.join(OUT_DIR, 'tv_momentum_cloud_sweep_jul2026.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n[tv-cloud-sweep] done in ${((Date.now() - started) / 1000).toFixed(0)}s scanned=${ok.length} dual=${dual.length}`);
console.log(`[tv-cloud-sweep] top: ${dual.slice(0, 8).map((r) => `${r.sym}(${r.full.ret.toFixed(0)}%)`).join(', ')}`);
console.log(`wrote ${outPath}`);

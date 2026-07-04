/**
 * Distributed hybrid sweep node — runs assigned global chunk IDs only.
 *
 * HYBRID_CANDLE_DIR=... DB_FILE=... HYBRID_MANIFEST_DIR=results/hybrid_sweep_distributed_* \
 * HYBRID_NODE_CHUNKS=2-5 HYBRID_SWEEP_WORKERS=4 \
 * node dist/research/hybridSweepNodeEntry.js scripts/hybrid/configs/synth_4h_v2_jul2026.json
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { preloadHybridCandles } from '../bot/hybridCandleStore';
import type { HistoricalSweepConfig } from './fullHistoricalSweepService';

const nodeBin = (): string => {
  const env = String(process.env.NODE_BIN || '').trim();
  if (env && fs.existsSync(env)) return env;
  if (fs.existsSync('/usr/bin/node')) return '/usr/bin/node';
  return process.execPath;
};

const parseChunkSpec = (spec: string): number[] => {
  const out = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((x) => Number(x.trim()));
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(Number(part));
    }
  }
  return [...out].sort((a, b) => a - b);
};

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

const runWorker = (
  workerId: number,
  configPath: string,
  chunkPath: string,
  outPath: string,
): Promise<void> => new Promise((resolve, reject) => {
  const workerJs = path.join(__dirname, 'hybridSweepWorkerEntry.js');
  const memMb = Math.max(512, Number(process.env.HYBRID_WORKER_MEM_MB || 768));
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
    else reject(new Error(`chunk-${workerId} exit ${code}: ${stderr.slice(-500)}`));
  });
});

async function main(): Promise<void> {
  const configPath = path.resolve(process.argv[2] || '');
  const chunkArg = process.argv[3] || '';
  const chunkSpec = String(process.env.HYBRID_NODE_CHUNKS || chunkArg || '').trim();
  if (!configPath || !fs.existsSync(configPath)) {
    console.error('Usage: hybridSweepNodeEntry.js <config.json> [chunk-spec e.g. 2-5]');
    process.exit(2);
  }
  if (!chunkSpec) {
    console.error('HYBRID_NODE_CHUNKS required (e.g. 0-1 or 2,3,4,5)');
    process.exit(2);
  }

  const bundleDir = process.env.HYBRID_CANDLE_DIR;
  const manifestDir = process.env.HYBRID_MANIFEST_DIR;
  if (!bundleDir || !fs.existsSync(bundleDir)) {
    console.error('HYBRID_CANDLE_DIR missing');
    process.exit(3);
  }
  if (!manifestDir || !fs.existsSync(manifestDir)) {
    console.error('HYBRID_MANIFEST_DIR missing');
    process.exit(3);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as HistoricalSweepConfig;
  const chunkIds = parseChunkSpec(chunkSpec);
  const maxParallel = Math.max(1, Number(process.env.HYBRID_SWEEP_WORKERS || chunkIds.length));
  const nodeName = process.env.HYBRID_NODE_NAME || 'node';

  const intervals = config.intervals?.length ? config.intervals : [config.interval || '4h'];
  const pre = preloadHybridCandles(intervals);
  console.log(`[hybrid-node:${nodeName}] chunks=${chunkSpec} parallel=${maxParallel} candles=${pre.symbols}`);

  const jobs = chunkIds.map((id) => {
    const tag = String(id).padStart(2, '0');
    return {
      id,
      chunkPath: path.join(manifestDir, `chunk_${tag}.json`),
      outPath: path.join(manifestDir, `result_${tag}.json`),
    };
  }).filter((j) => {
    if (!fs.existsSync(j.chunkPath)) {
      console.warn(`[hybrid-node] missing ${j.chunkPath}`);
      return false;
    }
    if (chunkDone(j.outPath, j.chunkPath)) {
      console.log(`[hybrid-node] chunk ${j.id} already done`);
      return false;
    }
    return true;
  });

  if (jobs.length === 0) {
    console.log(`[hybrid-node:${nodeName}] nothing to do`);
    return;
  }

  const t0 = Date.now();
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[hybrid-node] start chunk ${job.id} (attempt ${attempt})`);
          await runWorker(job.id, configPath, job.chunkPath, job.outPath);
          break;
        } catch (e) {
          if (attempt >= 2) console.warn(`[hybrid-node] chunk ${job.id} failed: ${(e as Error).message}`);
        }
      }
    }
  };

  const pool = Array.from({ length: Math.min(maxParallel, jobs.length) }, () => runNext());
  await Promise.allSettled(pool);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const done = jobs.filter((j) => chunkDone(j.outPath, j.chunkPath)).length;
  console.log(`[hybrid-node:${nodeName}] finished ${done}/${jobs.length} chunks in ${elapsed}s`);
}

main().catch((err) => {
  console.error('[hybrid-node] fatal:', err);
  process.exit(1);
});

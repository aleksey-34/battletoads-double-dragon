/**
 * VPS: export candle bundle for hybrid local sweep.
 * Usage: HYBRID_CANDLE_DIR=results/hybrid_candle_bundle node dist/research/hybridExportCandlesEntry.js config.json
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDB } from '../utils/database';
import { getMarketData, ensureExchangeClientInitialized } from '../bot/exchange';
import { writeHybridCandles, getHybridCandleDir } from '../bot/hybridCandleStore';
import type { HistoricalSweepConfig } from './fullHistoricalSweepService';
import logger from '../utils/logger';

const parseMarket = (market: string): { baseSymbol: string; quoteSymbol: string } => {
  const raw = String(market || '').trim().toUpperCase().replace('_', '/');
  if (!raw.includes('/')) return { baseSymbol: raw, quoteSymbol: '' };
  const [baseSymbol, quoteSymbol] = raw.split('/');
  return { baseSymbol: baseSymbol.trim(), quoteSymbol: quoteSymbol.trim() };
};

const collectSymbols = (config: HistoricalSweepConfig): Set<string> => {
  const out = new Set<string>();
  for (const m of config.monoMarkets || []) {
    out.add(parseMarket(m).baseSymbol);
  }
  for (const m of config.synthMarkets || []) {
    const { baseSymbol, quoteSymbol } = parseMarket(m);
    if (baseSymbol) out.add(baseSymbol);
    if (quoteSymbol) out.add(quoteSymbol);
  }
  return out;
};

const intervalMs = (interval: string): number => {
  const iv = String(interval || '4h').toLowerCase();
  if (iv.endsWith('h')) return parseInt(iv, 10) * 3600_000;
  if (iv.endsWith('d')) return parseInt(iv, 10) * 86400_000;
  if (iv.endsWith('m')) return parseInt(iv, 10) * 60_000;
  return 4 * 3600_000;
};

async function fetchBest(
  fanKeys: string[],
  symbol: string,
  interval: string,
  needBars: number,
  dateFrom: string,
  dateTo: string | null,
): Promise<{ candles: any[]; fanKey: string } | null> {
  const endMs = dateTo ? Date.parse(dateTo) : Date.now();
  const fromMs = dateFrom ? Date.parse(dateFrom) : 0;
  const windowStart = Math.max(0, endMs - intervalMs(interval) * needBars);
  const startMs = fromMs > 0 ? Math.min(fromMs, windowStart) : windowStart;
  let best: { candles: any[]; fanKey: string } | null = null;
  for (const fanKey of fanKeys) {
    try {
      await ensureExchangeClientInitialized(fanKey);
      const candles = await getMarketData(fanKey, symbol, interval, needBars, {
        startMs,
        endMs,
      });
      const list = Array.isArray(candles) ? candles : [];
      if (!best || list.length > best.candles.length) {
        best = { candles: list, fanKey };
      }
      if (list.length >= needBars * 0.85) break;
    } catch (e) {
      logger.warn(`[hybrid-export] ${fanKey} ${symbol} ${interval}: ${(e as Error).message}`);
    }
  }
  if (best && best.candles.length < needBars * 0.85) {
    logger.warn(`[hybrid-export] SHORT ${symbol} ${interval}: ${best.candles.length}/${needBars} via ${best.fanKey}`);
  }
  return best;
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath || !fs.existsSync(configPath)) {
    console.error('Usage: hybridExportCandlesEntry.js <sweep-config.json>');
    process.exit(2);
  }
  const bundleDir = process.env.HYBRID_CANDLE_DIR?.trim()
    || path.resolve(process.cwd(), '../results/hybrid_candle_bundle');
  fs.mkdirSync(bundleDir, { recursive: true });

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as HistoricalSweepConfig;
  await initDB();

  const intervals = config.intervals?.length ? config.intervals : [config.interval || '4h'];
  const symbols = collectSymbols(config);
  const fanKeys = config.fanApiKeyNames?.length ? config.fanApiKeyNames : [config.apiKeyName];
  const needBars = Math.max(200, Number(config.backtestBars || 4800) + Number(config.warmupBars || 120) + 100);
  const dateFrom = config.dateFrom;
  const dateTo = config.dateTo;

  const manifest: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    bundleDir,
    intervals,
    symbols: Array.from(symbols),
    fanKeys,
    needBars,
    dateFrom,
    dateTo,
    routes: [] as unknown[],
  };

  console.log(`[hybrid-export] ${symbols.size} symbols × ${intervals.length} intervals → ${bundleDir}`);
  console.log(`[hybrid-export] fanKeys=${fanKeys.join(',')} needBars=${needBars}`);

  const exportConcurrency = Math.max(1, Math.min(6, Number(process.env.HYBRID_EXPORT_CONCURRENCY || 3)));
  const tasks: Array<{ symbol: string; interval: string }> = [];
  for (const interval of intervals) {
    for (const symbol of symbols) {
      tasks.push({ symbol, interval });
    }
  }

  let idx = 0;
  let ok = 0;
  let fail = 0;

  const worker = async (): Promise<void> => {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      if (!task) break;
      const hit = await fetchBest(fanKeys, task.symbol, task.interval, needBars, dateFrom, dateTo);
      if (hit && hit.candles.length > 0) {
        process.env.HYBRID_CANDLE_DIR = bundleDir;
        writeHybridCandles(task.interval, task.symbol, hit.candles, {
          fanKey: hit.fanKey,
          count: hit.candles.length,
        });
        (manifest.routes as unknown[]).push({
          symbol: task.symbol,
          interval: task.interval,
          count: hit.candles.length,
          fanKey: hit.fanKey,
        });
        ok++;
        console.log(`  OK ${task.symbol} ${task.interval}: ${hit.candles.length} via ${hit.fanKey}`);
      } else {
        fail++;
        console.log(`  FAIL ${task.symbol} ${task.interval}`);
      }
    }
  };

  await Promise.all(Array.from({ length: exportConcurrency }, () => worker()));

  const manifestPath = path.join(bundleDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, ok, fail }, null, 2));
  console.log(`[hybrid-export] done ok=${ok} fail=${fail} manifest=${manifestPath}`);

  // tarball hint
  const tgz = path.join(path.dirname(bundleDir), 'hybrid_candle_bundle.tgz');
  console.log(`[hybrid-export] pack: tar -czf ${tgz} -C ${path.dirname(bundleDir)} ${path.basename(bundleDir)}`);
}

main().catch((err) => {
  console.error('[hybrid-export] fatal:', err);
  process.exit(1);
});

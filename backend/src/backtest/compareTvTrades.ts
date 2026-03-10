import fs from 'fs';
import path from 'path';
import { initDB } from '../utils/database';
import { runBacktest, BacktestTrade } from './engine';
import { loadSettings } from '../config/settings';
import { initExchangeClient } from '../bot/exchange';

type CliArgs = {
  apiKeyName: string;
  strategyId: number;
  tvCsvPath: string;
  bars: number;
  warmupBars: number;
  dateFrom?: string;
  dateTo?: string;
  commissionPercent?: number;
  slippagePercent?: number;
  fundingRatePercent?: number;
  outputPath?: string;
  limit: number;
  normalizeOneWayTv: boolean;
};

type TvTrade = {
  index: number;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  netPnl: number | null;
};

type TradeDiff = {
  index: number;
  tv: TvTrade | null;
  backtest: BacktestTrade | null;
  sideMatch: boolean | null;
  entryDiffMin: number | null;
  exitDiffMin: number | null;
  pnlSignMatch: boolean | null;
};

type ComparisonSummary = {
  tvTrades: number;
  backtestTrades: number;
  comparedRows: number;
  sideMismatches: number;
  missingInBacktest: number;
  extraInBacktest: number;
  avgAbsEntryDiffMin: number;
  avgAbsExitDiffMin: number;
  pnlSignMismatches: number;
};

const parseNumber = (value: string | undefined): number | null => {
  if (value === undefined || value === null) {
    return null;
  }

  let cleaned = String(value)
    .trim()
    .replace(/[$%\s]/g, '')
    .replace(/'/g, '')
    .replace(/"/g, '');

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      // Example: 1.234,56 -> decimal separator is comma.
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // Example: 1,234.56 -> decimal separator is dot.
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Example: 22,7597
    cleaned = cleaned.replace(/,/g, '.');
  }

  if (!cleaned) {
    return null;
  }

  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
};

const parseTimeMs = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    if (numeric > 1000000000000) {
      return Math.floor(numeric);
    }
    if (numeric > 1000000000) {
      return Math.floor(numeric * 1000);
    }
  }

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.floor(parsed);
};

const parseSide = (value: string | undefined): 'long' | 'short' | null => {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.includes('long') || normalized === 'buy') {
    return 'long';
  }

  if (normalized.includes('short') || normalized === 'sell') {
    return 'short';
  }

  return null;
};

const normalizeHeader = (value: string): string => {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
};

const parseCsvLine = (line: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
};

const findFirst = (map: Record<string, string>, keys: string[]): string | undefined => {
  for (const key of keys) {
    if (map[key] !== undefined && String(map[key]).trim() !== '') {
      return map[key];
    }
  }
  return undefined;
};

const parseTvTrades = (csvPath: string): TvTrade[] => {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    throw new Error(`TV CSV is empty or has no data rows: ${csvPath}`);
  }

  const headers = parseCsvLine(lines[0]).map((header) => normalizeHeader(header));
  const trades: TvTrade[] = [];

  type TvEventRow = {
    tradeNo: number | null;
    eventType: string;
    side: 'long' | 'short' | null;
    timeMs: number | null;
    price: number | null;
    netPnl: number | null;
  };

  const eventRows: TvEventRow[] = [];

  for (let row = 1; row < lines.length; row += 1) {
    const cells = parseCsvLine(lines[row]);
    const map: Record<string, string> = {};

    headers.forEach((header, index) => {
      map[header] = cells[index] || '';
    });

    const tradeNo = parseNumber(
      findFirst(map, ['tradenumber', 'trade', 'tradeno'])
    );

    const eventType = String(
      findFirst(map, ['type', 'signal', 'action']) || ''
    ).trim().toLowerCase();

    const eventTime = parseTimeMs(
      findFirst(map, ['dateandtime', 'datetime', 'time', 'date'])
    );

    const eventPrice = parseNumber(
      findFirst(map, ['price', 'pricedoge', 'priceusdt', 'entryprice', 'exitprice'])
    );

    const eventSide = parseSide(
      findFirst(map, ['signal', 'direction', 'side', 'type'])
    );

    const eventNetPnl = parseNumber(
      findFirst(map, ['netpnl', 'netprofit', 'profitloss', 'profit', 'pnl', 'netpl', 'netpldoge'])
    );

    if (eventType) {
      eventRows.push({
        tradeNo,
        eventType,
        side: eventSide,
        timeMs: eventTime,
        price: eventPrice,
        netPnl: eventNetPnl,
      });
    }

    const side = parseSide(
      findFirst(map, ['side', 'direction', 'position', 'type'])
    );

    const entryTime = parseTimeMs(
      findFirst(map, ['entrytime', 'opentime', 'entrydate', 'entry'])
    );

    const exitTime = parseTimeMs(
      findFirst(map, ['exittime', 'closetime', 'exitdate', 'exit'])
    );

    if (!side || entryTime === null || !Number.isFinite(entryTime)) {
      continue;
    }

    const entryPrice = parseNumber(
      findFirst(map, ['entryprice', 'openprice', 'avgentryprice'])
    );

    const exitPrice = parseNumber(
      findFirst(map, ['exitprice', 'closeprice', 'avgexitprice'])
    );

    const netPnl = parseNumber(
      findFirst(map, ['netpnl', 'netprofit', 'profitloss', 'profit', 'pnl', 'netpl', 'netpldoge'])
    );

    trades.push({
      index: trades.length,
      side,
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      netPnl,
    });
  }

  if (trades.length > 0) {
    return trades;
  }

  // TradingView "List of Trades" often exports two rows per trade: Entry/Exit.
  // This fallback reconstructs one trade from those event rows.
  const grouped = new Map<number, { entry?: TvEventRow; exit?: TvEventRow }>();
  let syntheticTradeNo = 1;

  for (const row of eventRows) {
    const tradeNo = Number.isFinite(row.tradeNo) && row.tradeNo !== null
      ? Math.floor(Number(row.tradeNo))
      : syntheticTradeNo++;

    const current = grouped.get(tradeNo) || {};

    if (row.eventType.includes('entry')) {
      current.entry = row;
    }

    if (row.eventType.includes('exit') || row.eventType.includes('tp') || row.eventType.includes('sl')) {
      current.exit = row;
    }

    grouped.set(tradeNo, current);
  }

  const rebuilt: TvTrade[] = Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([_, pair], index) => {
      const entry = pair.entry;
      const exit = pair.exit;
      const side = (entry?.side || exit?.side || 'long') as 'long' | 'short';
      const entryTime = entry?.timeMs || exit?.timeMs;

      if (!entryTime || !Number.isFinite(entryTime)) {
        return null;
      }

      return {
        index,
        side,
        entryTime,
        exitTime: exit?.timeMs || null,
        entryPrice: entry?.price || null,
        exitPrice: exit?.price || null,
        netPnl: exit?.netPnl ?? entry?.netPnl ?? null,
      };
    })
    .filter((item): item is TvTrade => item !== null);

  if (rebuilt.length > 0) {
    return rebuilt;
  }

  if (trades.length === 0) {
    throw new Error('No parseable trades were found in TV CSV. Check CSV column names.');
  }

  return trades;
};

const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const compareTrades = (tvTrades: TvTrade[], btTrades: BacktestTrade[]): { summary: ComparisonSummary; rows: TradeDiff[] } => {
  const maxRows = Math.max(tvTrades.length, btTrades.length);
  const rows: TradeDiff[] = [];

  const entryDiffs: number[] = [];
  const exitDiffs: number[] = [];

  let sideMismatches = 0;
  let pnlSignMismatches = 0;
  let missingInBacktest = 0;
  let extraInBacktest = 0;

  for (let i = 0; i < maxRows; i += 1) {
    const tv = tvTrades[i] || null;
    const backtest = btTrades[i] || null;

    if (tv && !backtest) {
      missingInBacktest += 1;
    }

    if (!tv && backtest) {
      extraInBacktest += 1;
    }

    const sideMatch = tv && backtest ? tv.side === backtest.side : null;
    if (sideMatch === false) {
      sideMismatches += 1;
    }

    const entryDiffMin = tv && backtest
      ? (backtest.entryTime - tv.entryTime) / (60 * 1000)
      : null;

    if (entryDiffMin !== null && Number.isFinite(entryDiffMin)) {
      entryDiffs.push(Math.abs(entryDiffMin));
    }

    const exitDiffMin = tv && backtest && tv.exitTime !== null
      ? (backtest.exitTime - tv.exitTime) / (60 * 1000)
      : null;

    if (exitDiffMin !== null && Number.isFinite(exitDiffMin)) {
      exitDiffs.push(Math.abs(exitDiffMin));
    }

    const tvPnlSign = tv && tv.netPnl !== null ? Math.sign(tv.netPnl) : null;
    const btPnlSign = backtest ? Math.sign(backtest.netPnl) : null;
    const pnlSignMatch = tvPnlSign !== null && btPnlSign !== null
      ? tvPnlSign === btPnlSign
      : null;

    if (pnlSignMatch === false) {
      pnlSignMismatches += 1;
    }

    rows.push({
      index: i,
      tv,
      backtest,
      sideMatch,
      entryDiffMin,
      exitDiffMin,
      pnlSignMatch,
    });
  }

  return {
    summary: {
      tvTrades: tvTrades.length,
      backtestTrades: btTrades.length,
      comparedRows: maxRows,
      sideMismatches,
      missingInBacktest,
      extraInBacktest,
      avgAbsEntryDiffMin: average(entryDiffs),
      avgAbsExitDiffMin: average(exitDiffs),
      pnlSignMismatches,
    },
    rows,
  };
};

const normalizeTvTradesForOneWay = (tvTrades: TvTrade[]): TvTrade[] => {
  const nonZeroDuration = tvTrades.filter((trade) => {
    if (trade.exitTime === null || trade.exitTime === undefined) {
      return true;
    }
    return trade.exitTime !== trade.entryTime;
  });

  const sorted = [...nonZeroDuration].sort((left, right) => {
    if (left.entryTime === right.entryTime) {
      return left.index - right.index;
    }
    return left.entryTime - right.entryTime;
  });

  const collapsed: TvTrade[] = [];

  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].entryTime === sorted[i].entryTime) {
      j += 1;
    }

    // Keep the last entry in this timestamp bucket to represent one executable entry state.
    collapsed.push({
      ...sorted[j - 1],
      index: collapsed.length,
    });

    i = j;
  }

  return collapsed;
};

const printTopMismatches = (rows: TradeDiff[], limit: number): void => {
  const mismatches = rows.filter((row) => {
    if (!row.tv || !row.backtest) {
      return true;
    }

    if (row.sideMatch === false) {
      return true;
    }

    if (row.pnlSignMatch === false) {
      return true;
    }

    const entryDelta = row.entryDiffMin === null ? 0 : Math.abs(row.entryDiffMin);
    const exitDelta = row.exitDiffMin === null ? 0 : Math.abs(row.exitDiffMin);
    return entryDelta > 0 || exitDelta > 0;
  });

  const sorted = mismatches.sort((a, b) => {
    const score = (item: TradeDiff): number => {
      const sidePenalty = item.sideMatch === false ? 1_000_000 : 0;
      const pnlPenalty = item.pnlSignMatch === false ? 100_000 : 0;
      const entry = item.entryDiffMin === null ? 0 : Math.abs(item.entryDiffMin);
      const exit = item.exitDiffMin === null ? 0 : Math.abs(item.exitDiffMin);
      const missingPenalty = (!item.tv || !item.backtest) ? 10_000_000 : 0;
      return missingPenalty + sidePenalty + pnlPenalty + entry + exit;
    };

    return score(b) - score(a);
  });

  const top = sorted.slice(0, Math.max(1, limit));

  if (top.length === 0) {
    console.log('No mismatches found.');
    return;
  }

  console.log('\nTop mismatches:');
  top.forEach((row) => {
    const tvSide = row.tv ? row.tv.side : 'missing';
    const btSide = row.backtest ? row.backtest.side : 'missing';
    const tvEntry = row.tv ? new Date(row.tv.entryTime).toISOString() : 'n/a';
    const btEntry = row.backtest ? new Date(row.backtest.entryTime).toISOString() : 'n/a';
    const entryDiff = row.entryDiffMin === null ? 'n/a' : row.entryDiffMin.toFixed(2);
    const exitDiff = row.exitDiffMin === null ? 'n/a' : row.exitDiffMin.toFixed(2);

    console.log(
      `#${row.index + 1} side tv=${tvSide} bt=${btSide} entryDiffMin=${entryDiff} exitDiffMin=${exitDiff} tvEntry=${tvEntry} btEntry=${btEntry}`
    );
  });
};

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2);
  const map = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const eqIndex = token.indexOf('=');
    if (eqIndex > -1) {
      map.set(token.slice(2, eqIndex), token.slice(eqIndex + 1));
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, 'true');
    }
  }

  const apiKeyName = String(map.get('api-key') || '').trim();
  const strategyId = Number(map.get('strategy-id') || '0');
  const tvCsvPath = String(map.get('tv-csv') || '').trim();

  if (!apiKeyName) {
    throw new Error('Missing required argument --api-key');
  }

  if (!Number.isFinite(strategyId) || strategyId <= 0) {
    throw new Error('Missing or invalid --strategy-id');
  }

  if (!tvCsvPath) {
    throw new Error('Missing required argument --tv-csv');
  }

  const bars = Number(map.get('bars') || '4000');
  const warmupBars = Number(map.get('warmup-bars') || '200');
  const limit = Number(map.get('limit') || '30');

  const toNumberIfPresent = (value: string | undefined): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  };

  return {
    apiKeyName,
    strategyId,
    tvCsvPath,
    bars: Number.isFinite(bars) && bars > 0 ? Math.floor(bars) : 4000,
    warmupBars: Number.isFinite(warmupBars) && warmupBars >= 0 ? Math.floor(warmupBars) : 200,
    dateFrom: map.get('date-from') || undefined,
    dateTo: map.get('date-to') || undefined,
    commissionPercent: toNumberIfPresent(map.get('commission')),
    slippagePercent: toNumberIfPresent(map.get('slippage')),
    fundingRatePercent: toNumberIfPresent(map.get('funding')),
    outputPath: map.get('out') || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30,
    normalizeOneWayTv: map.get('normalize-one-way-tv') === 'true' || map.get('normalize-one-way-tv') === '1',
  };
};

const initClientForApiKey = async (apiKeyName: string): Promise<void> => {
  const { apiKeys } = await loadSettings();
  const list = Array.isArray(apiKeys) ? apiKeys : [];
  const key = list.find((item: any) => String(item?.name || '').trim() === apiKeyName);

  if (!key) {
    throw new Error(`API key not found in database: ${apiKeyName}`);
  }

  initExchangeClient(key);
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const resolvedCsv = path.resolve(args.tvCsvPath);
  const tvTradesRaw = parseTvTrades(resolvedCsv);
  const tvTrades = args.normalizeOneWayTv
    ? normalizeTvTradesForOneWay(tvTradesRaw)
    : tvTradesRaw;

  await initDB();
  await initClientForApiKey(args.apiKeyName);

  const backtest = await runBacktest({
    apiKeyName: args.apiKeyName,
    mode: 'single',
    strategyId: args.strategyId,
    bars: args.bars,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    warmupBars: args.warmupBars,
    skipMissingSymbols: false,
    commissionPercent: args.commissionPercent,
    slippagePercent: args.slippagePercent,
    fundingRatePercent: args.fundingRatePercent,
  });

  const comparison = compareTrades(tvTrades, backtest.trades);

  console.log('TV vs Backtest comparison summary:');
  console.log(JSON.stringify(comparison.summary, null, 2));

  if (args.normalizeOneWayTv) {
    console.log(`TV one-way normalization: ${tvTradesRaw.length} -> ${tvTrades.length} trades`);
  }

  printTopMismatches(comparison.rows, args.limit);

  if (args.outputPath) {
    const outPath = path.resolve(args.outputPath);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          args,
          summary: comparison.summary,
          rows: comparison.rows,
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`\nDetailed comparison written to ${outPath}`);
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`compareTvTrades failed: ${message}`);
  process.exitCode = 1;
});

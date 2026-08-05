/**
 * Preflight candle coverage for portfolio / TS real backtests.
 * Hybrid-first (readHybridCandles); does not place orders or mutate strategies.
 */
import { db } from '../utils/database';
import { getHybridCandleDir, readHybridCandles } from '../bot/hybridCandleStore';
import logger from '../utils/logger';

export type CandleCoverageLeg = {
  strategyId: number;
  strategyName: string;
  symbol: string;
  interval: string;
  marketMode: string;
  hybridBars: number;
  status: 'ok' | 'short' | 'missing';
  detail?: string;
};

export type CandleCoverageReport = {
  ok: boolean;
  /** True when every leg has enough hybrid bars for the period + warmup. */
  hybridReady: boolean;
  /** Real BT can still attempt live exchange fetch even if hybrid has gaps. */
  canAttemptLiveBt: boolean;
  hybridDir: string | null;
  dateFrom: string;
  dateTo: string;
  warmupBars: number;
  minBarsHint: number;
  systems: Array<{ systemId: number; systemName: string; memberCount: number }>;
  legs: CandleCoverageLeg[];
  summary: {
    total: number;
    ok: number;
    short: number;
    missing: number;
  };
  hint: string;
};

const asYmd = (raw: unknown): string => {
  const s = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};

const intervalToMs = (interval: string): number => {
  const iv = String(interval || '4h').toLowerCase();
  if (iv.endsWith('h')) return Math.max(1, parseInt(iv, 10) || 4) * 3600_000;
  if (iv.endsWith('d')) return Math.max(1, parseInt(iv, 10) || 1) * 86400_000;
  if (iv.endsWith('m')) return Math.max(1, parseInt(iv, 10) || 1) * 60_000;
  return 4 * 3600_000;
};

const collectSymbols = (base: string, quote: string, marketMode: string): string[] => {
  const b = String(base || '').trim().toUpperCase();
  const q = String(quote || '').trim().toUpperCase();
  const mode = String(marketMode || '').toLowerCase();
  const out: string[] = [];
  if (b) out.push(b);
  if (mode === 'synthetic' && q) out.push(q);
  return out;
};

type StrategyRow = {
  id: number;
  name: string;
  base_symbol: string;
  quote_symbol: string;
  interval: string;
  market_mode: string;
  price_channel_length: number;
};

const loadStrategiesForSystem = async (systemId: number): Promise<StrategyRow[]> => {
  const rows = await db.all(
    `SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval, s.market_mode,
            COALESCE(s.price_channel_length, 50) AS price_channel_length
     FROM trading_system_members m
     JOIN strategies s ON s.id = m.strategy_id
     WHERE m.system_id = ? AND COALESCE(m.is_enabled, 1) = 1
     ORDER BY m.id ASC`,
    [systemId],
  );
  return (rows || []) as StrategyRow[];
};

const resolveSystems = async (payload: {
  systemName?: string;
  systemNames?: string[];
  setKey?: string;
}): Promise<Array<{ systemId: number; systemName: string }>> => {
  const out: Array<{ systemId: number; systemName: string }> = [];
  const seen = new Set<string>();

  const pushName = async (nameRaw: string) => {
    const name = String(nameRaw || '').trim();
    if (!name || seen.has(name.toLowerCase())) return;
    const row = await db.get(
      `SELECT id, name FROM trading_systems WHERE name = ? LIMIT 1`,
      [name],
    ) as { id: number; name: string } | undefined;
    if (!row?.id) {
      throw new Error(`Trading system not found: ${name}`);
    }
    seen.add(name.toLowerCase());
    out.push({ systemId: Number(row.id), systemName: String(row.name) });
  };

  for (const n of payload.systemNames || []) {
    await pushName(String(n || ''));
  }
  if (payload.systemName) {
    await pushName(payload.systemName);
  }

  const setKey = String(payload.setKey || '').trim();
  if (setKey) {
    const portfolio = await db.get(
      `SELECT id FROM algofund_portfolios WHERE set_key = ? AND COALESCE(is_enabled,1)=1 LIMIT 1`,
      [setKey],
    ) as { id: number } | undefined;
    if (!portfolio?.id) {
      throw new Error(`Portfolio not found for setKey=${setKey}`);
    }
    const members = await db.all(
      `SELECT system_name FROM algofund_portfolio_members
       WHERE portfolio_id = ? AND COALESCE(is_enabled,1)=1
       ORDER BY sort_order ASC, id ASC`,
      [portfolio.id],
    ) as Array<{ system_name: string }>;
    for (const m of members) {
      await pushName(String(m.system_name || ''));
    }
  }

  if (out.length === 0) {
    throw new Error('systemName, systemNames or setKey is required');
  }
  return out;
};

export const probePortfolioCandleCoverage = async (payload: {
  systemName?: string;
  systemNames?: string[];
  setKey?: string;
  dateFrom?: string;
  dateTo?: string;
  warmupBars?: number;
}): Promise<CandleCoverageReport> => {
  const dateFrom = asYmd(payload.dateFrom) || '2024-06-01';
  const dateTo = asYmd(payload.dateTo) || new Date().toISOString().slice(0, 10);
  const warmupBars = Math.max(0, Math.min(2000, Math.floor(Number(payload.warmupBars) || 120)));
  const fromMs = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const toMs = Date.parse(`${dateTo}T23:59:59.999Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error('Invalid dateFrom/dateTo');
  }

  const systems = await resolveSystems(payload);
  const hybridDir = getHybridCandleDir();
  const legs: CandleCoverageLeg[] = [];
  const systemsMeta: CandleCoverageReport['systems'] = [];

  for (const sys of systems) {
    const strategies = await loadStrategiesForSystem(sys.systemId);
    systemsMeta.push({
      systemId: sys.systemId,
      systemName: sys.systemName,
      memberCount: strategies.length,
    });

    for (const strategy of strategies) {
      const interval = String(strategy.interval || '4h').trim() || '4h';
      const lookback = Math.max(5, Math.floor(Number(strategy.price_channel_length) || 50));
      const minBarsHint = lookback + warmupBars + 5;
      const symbols = collectSymbols(strategy.base_symbol, strategy.quote_symbol, strategy.market_mode);
      if (symbols.length === 0) {
        legs.push({
          strategyId: Number(strategy.id),
          strategyName: String(strategy.name || ''),
          symbol: '(empty)',
          interval,
          marketMode: String(strategy.market_mode || ''),
          hybridBars: 0,
          status: 'missing',
          detail: 'strategy has no symbols',
        });
        continue;
      }

      for (const symbol of symbols) {
        let hybridBars = 0;
        let status: CandleCoverageLeg['status'] = 'missing';
        let detail: string | undefined;
        try {
          const rows = readHybridCandles(symbol, interval, {
            startMs: fromMs - intervalToMs(interval) * (lookback + warmupBars + 50),
            endMs: toMs,
            limit: 50_000,
          }) || [];
          hybridBars = Array.isArray(rows) ? rows.length : 0;
          if (hybridBars <= 0) {
            status = 'missing';
            detail = hybridDir
              ? `no hybrid file/rows for ${symbol}|${interval}`
              : 'HYBRID_CANDLE_DIR not set (live exchange fetch may still work on Real BT)';
          } else if (hybridBars < minBarsHint) {
            status = 'short';
            detail = `have ${hybridBars}, want ≥${minBarsHint} (lookback+warmup)`;
          } else {
            status = 'ok';
          }
        } catch (err) {
          status = 'missing';
          detail = (err as Error).message;
        }

        legs.push({
          strategyId: Number(strategy.id),
          strategyName: String(strategy.name || ''),
          symbol,
          interval,
          marketMode: String(strategy.market_mode || ''),
          hybridBars,
          status,
          detail,
        });
      }
    }
  }

  const summary = {
    total: legs.length,
    ok: legs.filter((l) => l.status === 'ok').length,
    short: legs.filter((l) => l.status === 'short').length,
    missing: legs.filter((l) => l.status === 'missing').length,
  };

  const hybridReady = summary.total > 0 && summary.missing === 0 && summary.short === 0;
  const canAttemptLiveBt = summary.total > 0;
  const ok = hybridReady;
  const hint = hybridReady
    ? 'Hybrid coverage looks sufficient for the selected period (warmup included). Safe for fast Real BT.'
    : summary.missing > 0
      ? 'Hybrid gaps: export via scripts/hybrid/export_portfolio_books_candles.sh, or run Real BT with live exchange fetch (slower; some TF may still fail).'
      : 'Some legs are short vs lookback+warmup — widen dateFrom or lower warmupBars, or export a deeper hybrid bundle.';

  logger.info(
    `[portfolio-candle-coverage] systems=${systems.length} legs=${summary.total} `
    + `ok=${summary.ok} short=${summary.short} missing=${summary.missing} `
    + `${dateFrom}→${dateTo}`,
  );

  return {
    ok,
    hybridReady,
    canAttemptLiveBt,
    hybridDir,
    dateFrom,
    dateTo,
    warmupBars,
    minBarsHint: warmupBars + 55,
    systems: systemsMeta,
    legs,
    summary,
    hint,
  };
};

import { MarketMode, Strategy, StrategyType } from '../config/settings';
import {
  applySymbolRiskSettings,
  cancelAllOrders,
  closePosition,
  getBalances,
  getAllSymbols,
  getInstrumentInfo,
  getMarketData,
  getPositions,
  placeOrder,
} from './exchange';
import { calculateSyntheticOHLC } from './synthetic';
import logger from '../utils/logger';

type StrategySignal = 'long' | 'short' | 'none';

type StrategyDraft = Partial<Strategy> & {
  name?: string;
};

type ParsedSyntheticCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type StrategyExecutionSource = 'manual' | 'auto';

type ExecuteStrategyOptions = {
  source?: StrategyExecutionSource;
  closedBarOnly?: boolean;
  dedupeClosedBar?: boolean;
};

const normalizeStrategyType = (value: any): StrategyType => {
  const normalized = String(value || '').trim();
  if (normalized === 'stat_arb_zscore' || normalized === 'zz_breakout') {
    return normalized;
  }
  return 'DD_BattleToads';
};

const normalizeMarketMode = (value: any): MarketMode => {
  return String(value || '').trim() === 'mono' ? 'mono' : 'synthetic';
};

const normalizeZscoreEntry = (value: any, fallback: number): number => {
  return Math.max(0.1, safeNumber(value, fallback));
};

const normalizeZscoreExit = (value: any, fallback: number, entry: number): number => {
  const raw = Math.max(0, safeNumber(value, fallback));
  return Math.min(raw, Math.max(0, entry - 0.05));
};

const normalizeZscoreStop = (value: any, fallback: number, entry: number): number => {
  return Math.max(entry + 0.05, safeNumber(value, fallback));
};

const DEFAULT_STRATEGY: Omit<Strategy, 'api_key_id' | 'id'> = {
  name: 'DD_BattleToads',
  strategy_type: 'DD_BattleToads',
  market_mode: 'synthetic',
  is_active: true,
  display_on_chart: true,
  show_settings: true,
  show_chart: true,
  show_indicators: true,
  show_positions_on_chart: true,
  show_trades_on_chart: false,
  show_values_each_bar: false,
  auto_update: true,
  take_profit_percent: 7.5,
  price_channel_length: 50,
  detection_source: 'close',
  zscore_entry: 2.0,
  zscore_exit: 0.5,
  zscore_stop: 3.5,
  base_symbol: 'BTCUSDT',
  quote_symbol: 'ETHUSDT',
  interval: '1h',
  base_coef: 1,
  quote_coef: 1,
  long_enabled: true,
  short_enabled: true,
  lot_long_percent: 100,
  lot_short_percent: 100,
  max_deposit: 1000,
  margin_type: 'cross',
  leverage: 1,
  fixed_lot: false,
  reinvest_percent: 0,
  state: 'flat',
  entry_ratio: null,
  tp_anchor_ratio: null,
  last_signal: null,
  last_action: null,
  last_error: null,
};

const safeBoolean = (value: any, fallback: boolean): boolean => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return fallback;
};

const safeNumber = (value: any, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeSymbol = (value: string): string => String(value || '').trim().toUpperCase();

const normalizeInterval = (value: any): string => String(value || '').trim();

const normalizeCoef = (value: any): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const intervalToMs = (interval: string): number => {
  const value = String(interval || '').trim();

  if (value.endsWith('m')) {
    const minutes = Number.parseInt(value.replace('m', ''), 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 1000;
  }

  if (value.endsWith('h')) {
    const hours = Number.parseInt(value.replace('h', ''), 10);
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 60 * 60 * 1000;
  }

  if (value === '1d') {
    return 24 * 60 * 60 * 1000;
  }

  if (value === '1w') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (value === '1M') {
    return 30 * 24 * 60 * 60 * 1000;
  }

  return 60 * 60 * 1000;
};

const validateStrategyBinding = (binding: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol' | 'interval' | 'base_coef' | 'quote_coef'>): void => {
  const base = normalizeSymbol(binding.base_symbol);
  const quote = normalizeSymbol(binding.quote_symbol);
  const interval = String(binding.interval || '').trim();
  const baseCoef = Number(binding.base_coef);
  const quoteCoef = Number(binding.quote_coef);
  const marketMode = normalizeMarketMode((binding as Partial<Strategy>).market_mode);

  if (!base) {
    throw new Error('Strategy requires a base symbol');
  }

  if (!interval) {
    throw new Error('Strategy interval is required');
  }

  if (!Number.isFinite(baseCoef)) {
    throw new Error('Strategy coefficients must be finite numbers');
  }

  if (marketMode === 'mono') {
    return;
  }

  if (!quote) {
    throw new Error('Synthetic strategy requires a quote symbol');
  }

  if (base === quote) {
    throw new Error('Base and quote symbols must be different');
  }

  if (!Number.isFinite(quoteCoef)) {
    throw new Error('Strategy coefficients must be finite numbers');
  }

  if (Math.abs(quoteCoef) < 1e-12) {
    throw new Error('Quote coefficient must not be zero');
  }
};

const normalizeSymbolKey = (value: any): string => {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
};

const normalizeStrategy = (row: any): Strategy => {
  const strategyType = normalizeStrategyType(row.strategy_type);
  const marketMode = normalizeMarketMode(row.market_mode);
  const zscoreEntry = normalizeZscoreEntry(row.zscore_entry, DEFAULT_STRATEGY.zscore_entry);
  const zscoreExit = normalizeZscoreExit(row.zscore_exit, DEFAULT_STRATEGY.zscore_exit, zscoreEntry);
  const zscoreStop = normalizeZscoreStop(row.zscore_stop, DEFAULT_STRATEGY.zscore_stop, zscoreEntry);

  return {
    id: Number(row.id),
    name: String(row.name || DEFAULT_STRATEGY.name),
    api_key_id: Number(row.api_key_id),
    strategy_type: strategyType,
    market_mode: marketMode,
    is_active: safeBoolean(row.is_active, true),
    display_on_chart: safeBoolean(row.display_on_chart, true),
    show_settings: safeBoolean(row.show_settings, true),
    show_chart: safeBoolean(row.show_chart, true),
    show_indicators: safeBoolean(row.show_indicators, true),
    show_positions_on_chart: safeBoolean(row.show_positions_on_chart, true),
    show_trades_on_chart: safeBoolean(row.show_trades_on_chart, false),
    show_values_each_bar: safeBoolean(row.show_values_each_bar, false),
    auto_update: safeBoolean(row.auto_update, true),
    take_profit_percent: safeNumber(row.take_profit_percent, DEFAULT_STRATEGY.take_profit_percent),
    price_channel_length: Math.max(2, Math.floor(safeNumber(row.price_channel_length, DEFAULT_STRATEGY.price_channel_length))),
    detection_source: String(row.detection_source || DEFAULT_STRATEGY.detection_source) === 'wick' ? 'wick' : 'close',
    zscore_entry: zscoreEntry,
    zscore_exit: zscoreExit,
    zscore_stop: zscoreStop,
    base_symbol: normalizeSymbol(String(row.base_symbol || DEFAULT_STRATEGY.base_symbol)),
    quote_symbol: marketMode === 'mono'
      ? normalizeSymbol(String(row.quote_symbol || ''))
      : normalizeSymbol(String(row.quote_symbol || DEFAULT_STRATEGY.quote_symbol)),
    interval: String(row.interval || DEFAULT_STRATEGY.interval),
    base_coef: safeNumber(row.base_coef, DEFAULT_STRATEGY.base_coef),
    quote_coef: marketMode === 'mono' ? safeNumber(row.quote_coef, 0) : safeNumber(row.quote_coef, DEFAULT_STRATEGY.quote_coef),
    long_enabled: safeBoolean(row.long_enabled, true),
    short_enabled: safeBoolean(row.short_enabled, true),
    lot_long_percent: safeNumber(row.lot_long_percent, DEFAULT_STRATEGY.lot_long_percent),
    lot_short_percent: safeNumber(row.lot_short_percent, DEFAULT_STRATEGY.lot_short_percent),
    max_deposit: safeNumber(row.max_deposit, DEFAULT_STRATEGY.max_deposit),
    margin_type: String(row.margin_type || DEFAULT_STRATEGY.margin_type) === 'isolated' ? 'isolated' : 'cross',
    leverage: Math.max(1, safeNumber(row.leverage, DEFAULT_STRATEGY.leverage)),
    fixed_lot: safeBoolean(row.fixed_lot, false),
    reinvest_percent: safeNumber(row.reinvest_percent, DEFAULT_STRATEGY.reinvest_percent),
    state: String(row.state || 'flat') === 'long' ? 'long' : String(row.state || 'flat') === 'short' ? 'short' : 'flat',
    entry_ratio: row.entry_ratio === null || row.entry_ratio === undefined ? null : safeNumber(row.entry_ratio, 0),
    tp_anchor_ratio: row.tp_anchor_ratio === null || row.tp_anchor_ratio === undefined ? null : safeNumber(row.tp_anchor_ratio, 0),
    last_signal: row.last_signal === undefined ? null : row.last_signal,
    last_action: row.last_action === undefined ? null : row.last_action,
    last_error: row.last_error === undefined ? null : row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const getApiKeyId = async (apiKeyName: string): Promise<number> => {
  const { db } = await import('../utils/database');
  const keyRow = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!keyRow) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }
  return Number(keyRow.id);
};

const getStrategyRow = async (apiKeyName: string, strategyId: number): Promise<any> => {
  const { db } = await import('../utils/database');
  const row = await db.get(
    `SELECT s.*
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ? AND s.id = ?`,
    [apiKeyName, strategyId]
  );

  if (!row) {
    throw new Error(`Strategy not found: ${strategyId}`);
  }

  return row;
};

const parseSyntheticCandle = (item: any): ParsedSyntheticCandle | null => {
  const timeMs = Number(item?.time);
  const open = Number(item?.open);
  const high = Number(item?.high);
  const low = Number(item?.low);
  const close = Number(item?.close);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return { timeMs, open, high, low, close };
};

const parseMarketDataCandle = (item: any): ParsedSyntheticCandle | null => {
  if (!Array.isArray(item) || item.length < 5) {
    return null;
  }

  const timeMs = Number(item[0]);
  const open = Number(item[1]);
  const high = Number(item[2]);
  const low = Number(item[3]);
  const close = Number(item[4]);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return { timeMs, open, high, low, close };
};

const getStrategySymbols = (strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>): string[] => {
  const marketMode = normalizeMarketMode(strategy.market_mode);
  if (marketMode === 'mono') {
    return [strategy.base_symbol].filter((symbol) => Boolean(String(symbol || '').trim()));
  }

  return Array.from(
    new Set(
      [strategy.base_symbol, strategy.quote_symbol].filter((symbol) => Boolean(String(symbol || '').trim()))
    )
  );
};

const loadStrategyCandles = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol' | 'base_coef' | 'quote_coef' | 'interval'>,
  limit: number,
  options?: {
    startMs?: number;
    endMs?: number;
  }
): Promise<ParsedSyntheticCandle[]> => {
  const marketMode = normalizeMarketMode(strategy.market_mode);

  if (marketMode === 'mono') {
    const raw = await getMarketData(
      apiKeyName,
      strategy.base_symbol,
      strategy.interval,
      limit,
      options
    );

    return (Array.isArray(raw) ? raw : [])
      .map((item) => parseMarketDataCandle(item))
      .filter((item): item is ParsedSyntheticCandle => !!item)
      .sort((a, b) => a.timeMs - b.timeMs);
  }

  const raw = await calculateSyntheticOHLC(
    apiKeyName,
    strategy.base_symbol,
    strategy.quote_symbol,
    strategy.base_coef,
    strategy.quote_coef,
    strategy.interval,
    limit,
    options
  );

  return (Array.isArray(raw) ? raw : [])
    .map((item) => parseSyntheticCandle(item))
    .filter((item): item is ParsedSyntheticCandle => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);
};

const getLatestMarketClose = async (apiKeyName: string, symbol: string): Promise<number> => {
  const payload = await getMarketData(apiKeyName, symbol, '1m', 5);
  const parsed = (Array.isArray(payload) ? payload : [])
    .map((item: any) => {
      if (!Array.isArray(item) || item.length < 5) {
        return null;
      }
      const timeMs = Number(item[0]);
      const close = Number(item[4]);
      if (!Number.isFinite(timeMs) || !Number.isFinite(close)) {
        return null;
      }
      return { timeMs, close };
    })
    .filter((item): item is { timeMs: number; close: number } => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);

  const latest = parsed[parsed.length - 1];
  if (!latest) {
    throw new Error(`No market data for ${symbol}`);
  }

  return latest.close;
};

const extractUsdtBalance = (balances: any[]): number => {
  const list = Array.isArray(balances) ? balances : [];
  const usdt = list.find((item: any) => String(item?.coin || '').toUpperCase() === 'USDT');

  if (usdt) {
    const available = Number.parseFloat(String(usdt.availableBalance ?? '0'));
    const wallet = Number.parseFloat(String(usdt.walletBalance ?? '0'));
    const fromUsdt = Number.isFinite(available) && available > 0 ? available : wallet;
    if (Number.isFinite(fromUsdt) && fromUsdt > 0) {
      return fromUsdt;
    }
  }

  const fallbackUsd = list
    .map((item: any) => Number.parseFloat(String(item?.usdValue ?? '0')))
    .filter((value: number) => Number.isFinite(value) && value > 0)
    .reduce((acc: number, value: number) => acc + value, 0);

  return Number.isFinite(fallbackUsd) && fallbackUsd > 0 ? fallbackUsd : 0;
};

const computeSignalTotalNotional = (
  strategy: Pick<Strategy, 'max_deposit' | 'fixed_lot' | 'reinvest_percent' | 'lot_long_percent' | 'lot_short_percent'>,
  availableBalance: number,
  signal: 'long' | 'short'
): number => {
  const safeAvailable = Number.isFinite(availableBalance) && availableBalance > 0 ? availableBalance : 0;

  const cappedBalance = strategy.max_deposit > 0
    ? Math.min(safeAvailable, strategy.max_deposit)
    : safeAvailable;

  const lotPercent = signal === 'long' ? strategy.lot_long_percent : strategy.lot_short_percent;
  const lotFraction = Math.max(0, lotPercent) / 100;
  const reinvestFactor = strategy.fixed_lot ? 1 : 1 + Math.max(0, strategy.reinvest_percent) / 100;

  const baseCapital = strategy.fixed_lot
    ? (strategy.max_deposit > 0 ? strategy.max_deposit : cappedBalance)
    : cappedBalance;

  const totalNotional = baseCapital * lotFraction * reinvestFactor;

  return Number.isFinite(totalNotional) && totalNotional > 0 ? totalNotional : 0;
};

const decimalPlaces = (value: string): number => {
  const normalized = String(value || '');
  const scientific = normalized.toLowerCase().match(/e-(\d+)$/);
  if (scientific) {
    const parsed = Number.parseInt(scientific[1], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  if (!normalized.includes('.')) {
    return 0;
  }
  return normalized.split('.')[1].replace(/0+$/, '').length;
};

type QtyRules = {
  symbol: string;
  qtyStep: number;
  minQty: number;
  maxQty: number;
  decimals: number;
};

type QtyCandidate = {
  qty: number;
  notional: number;
  text: string;
};

type BalancedQtyPlan = {
  baseQty: string;
  quoteQty: string;
  baseNotional: number;
  quoteNotional: number;
  totalNotional: number;
  shareError: number;
  totalDeviation: number;
  oversize: number;
  baseTargetNotional: number;
  quoteTargetNotional: number;
};

type SingleQtyPlan = {
  qty: string;
  notional: number;
  targetNotional: number;
  totalDeviation: number;
  oversize: number;
};

type LiveLegBalanceSnapshot = {
  baseNotional: number;
  quoteNotional: number;
  expectedBaseShare: number;
  actualBaseShare: number;
  shareError: number;
};

const SIZING_EPSILON = 1e-9;
const MAX_SHARE_ERROR = 0.03;
const MAX_LEG_DEVIATION = 0.3;
const MAX_OVERSIZE_DEVIATION = 0.2;
const MAX_TOTAL_DEVIATION = 0.3;
const MAX_POST_OPEN_SHARE_ERROR = 0.08;
const BAR_CLOSE_FRESHNESS_MS = 1500;
const TRAILING_RATIO_EPSILON = 1e-12;

const processedClosedBarByStrategy = new Map<string, number>();

const normalizeQtyValue = (value: number, decimals: number): number => {
  const safeDecimals = Math.max(0, Math.min(12, decimals));
  return Number(value.toFixed(safeDecimals));
};

const formatQty = (qty: number, decimals: number): string => {
  return normalizeQtyValue(qty, decimals).toFixed(Math.max(0, decimals)).replace(/\.?0+$/, '');
};

const loadQtyRules = async (apiKeyName: string, symbol: string): Promise<QtyRules> => {
  const info = await getInstrumentInfo(apiKeyName, symbol);

  const qtyStepRaw = String(info?.lotSizeFilter?.qtyStep || '0.001');
  const minQtyRaw = String(info?.lotSizeFilter?.minOrderQty || '0');
  const maxQtyRaw = String(info?.lotSizeFilter?.maxOrderQty || '0');

  const qtyStep = Number.parseFloat(qtyStepRaw);
  const minQty = Number.parseFloat(minQtyRaw);
  const maxQty = Number.parseFloat(maxQtyRaw);

  const safeStep = Number.isFinite(qtyStep) && qtyStep > 0 ? qtyStep : 0.001;
  const safeMin = Number.isFinite(minQty) && minQty > 0 ? minQty : 0;
  const safeMax = Number.isFinite(maxQty) && maxQty > 0 ? maxQty : Number.POSITIVE_INFINITY;

  return {
    symbol,
    qtyStep: safeStep,
    minQty: safeMin,
    maxQty: safeMax,
    decimals: Math.max(0, decimalPlaces(qtyStepRaw)),
  };
};

const qtyFromUnits = (units: number, rules: QtyRules): number => {
  if (!Number.isFinite(units) || units <= 0) {
    return 0;
  }

  return normalizeQtyValue(units * rules.qtyStep, Math.max(rules.decimals, 8));
};

const buildQtyCandidates = (rawQty: number, price: number, rules: QtyRules): QtyCandidate[] => {
  if (!Number.isFinite(rawQty) || rawQty <= 0) {
    throw new Error(`Invalid raw qty for ${rules.symbol}`);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid market price for ${rules.symbol}`);
  }

  const step = rules.qtyStep;
  const maxUnits = Number.isFinite(rules.maxQty)
    ? Math.floor((rules.maxQty + SIZING_EPSILON) / step)
    : Number.POSITIVE_INFINITY;
  const minUnitsByFilter = Math.max(1, Math.ceil((rules.minQty - SIZING_EPSILON) / step));
  const centerUnits = rawQty / step;
  const floorUnits = Math.floor(centerUnits + SIZING_EPSILON);
  const ceilUnits = Math.ceil(centerUnits - SIZING_EPSILON);

  const rawStart = Math.max(minUnitsByFilter, floorUnits - 3);
  const rawEnd = Math.max(rawStart, ceilUnits + 3);

  const unitSet = new Set<number>();
  for (let units = rawStart; units <= rawEnd; units += 1) {
    if (units >= minUnitsByFilter && units > 0 && units <= maxUnits) {
      unitSet.add(units);
    }
  }

  if (minUnitsByFilter <= maxUnits) {
    unitSet.add(minUnitsByFilter);
  }
  if (floorUnits >= minUnitsByFilter && floorUnits <= maxUnits) {
    unitSet.add(floorUnits);
  }
  if (ceilUnits >= minUnitsByFilter && ceilUnits <= maxUnits) {
    unitSet.add(ceilUnits);
  }

  const candidates = Array.from(unitSet)
    .map((units) => qtyFromUnits(units, rules))
    .filter((qty) => Number.isFinite(qty) && qty > 0)
    .filter((qty) => qty + SIZING_EPSILON >= rules.minQty)
    .filter((qty) => qty <= rules.maxQty + SIZING_EPSILON)
    .map((qty) => ({
      qty,
      notional: qty * price,
      text: formatQty(qty, rules.decimals),
    }))
    .sort((left, right) => left.qty - right.qty);

  if (candidates.length === 0) {
    throw new Error(`Unable to build qty candidates for ${rules.symbol}`);
  }

  return candidates;
};

const buildBalancedQtyPlan = async (
  apiKeyName: string,
  baseSymbol: string,
  quoteSymbol: string,
  basePrice: number,
  quotePrice: number,
  totalNotional: number,
  baseWeight: number,
  quoteWeight: number
): Promise<BalancedQtyPlan> => {
  if (!Number.isFinite(totalNotional) || totalNotional <= 0) {
    throw new Error('Trade notional must be positive');
  }

  if (!Number.isFinite(baseWeight) || !Number.isFinite(quoteWeight) || baseWeight <= 0 || quoteWeight <= 0) {
    throw new Error('Both synthetic leg coefficients must be non-zero for balanced execution');
  }

  const totalWeight = baseWeight + quoteWeight;
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error('Synthetic coefficient weights are invalid');
  }

  const baseTargetNotional = totalNotional * (baseWeight / totalWeight);
  const quoteTargetNotional = totalNotional * (quoteWeight / totalWeight);
  const rawBaseQty = baseTargetNotional / basePrice;
  const rawQuoteQty = quoteTargetNotional / quotePrice;

  const [baseRules, quoteRules] = await Promise.all([
    loadQtyRules(apiKeyName, baseSymbol),
    loadQtyRules(apiKeyName, quoteSymbol),
  ]);

  const baseCandidates = buildQtyCandidates(rawBaseQty, basePrice, baseRules);
  const quoteCandidates = buildQtyCandidates(rawQuoteQty, quotePrice, quoteRules);

  const targetBaseShare = baseWeight / totalWeight;

  let best: {
    base: QtyCandidate;
    quote: QtyCandidate;
    totalActual: number;
    baseShare: number;
    shareError: number;
    totalDeviation: number;
    oversize: number;
    baseLegDeviation: number;
    quoteLegDeviation: number;
    score: number;
  } | null = null;

  for (const baseCandidate of baseCandidates) {
    for (const quoteCandidate of quoteCandidates) {
      const totalActual = baseCandidate.notional + quoteCandidate.notional;
      if (!Number.isFinite(totalActual) || totalActual <= 0) {
        continue;
      }

      const baseShare = baseCandidate.notional / totalActual;
      const shareError = Math.abs(baseShare - targetBaseShare);
      const totalDeviation = Math.abs(totalActual - totalNotional) / Math.max(totalNotional, SIZING_EPSILON);
      const oversize = Math.max(0, (totalActual - totalNotional) / Math.max(totalNotional, SIZING_EPSILON));
      const baseLegDeviation = Math.abs(baseCandidate.notional - baseTargetNotional) / Math.max(baseTargetNotional, SIZING_EPSILON);
      const quoteLegDeviation = Math.abs(quoteCandidate.notional - quoteTargetNotional) / Math.max(quoteTargetNotional, SIZING_EPSILON);

      const score = shareError * 1000 + oversize * 200 + totalDeviation * 10;

      if (!best || score < best.score) {
        best = {
          base: baseCandidate,
          quote: quoteCandidate,
          totalActual,
          baseShare,
          shareError,
          totalDeviation,
          oversize,
          baseLegDeviation,
          quoteLegDeviation,
          score,
        };
      }
    }
  }

  if (!best) {
    throw new Error('Unable to find a valid balanced quantity plan');
  }

  if (
    best.shareError > MAX_SHARE_ERROR
    || best.baseLegDeviation > MAX_LEG_DEVIATION
    || best.quoteLegDeviation > MAX_LEG_DEVIATION
    || best.totalDeviation > MAX_TOTAL_DEVIATION
    || best.oversize > MAX_OVERSIZE_DEVIATION
  ) {
    throw new Error(
      `Order size too small for balanced pair execution: shareError=${(best.shareError * 100).toFixed(2)}%, `
      + `baseDev=${(best.baseLegDeviation * 100).toFixed(2)}%, quoteDev=${(best.quoteLegDeviation * 100).toFixed(2)}%, `
      + `totalDev=${(best.totalDeviation * 100).toFixed(2)}%, oversize=${(best.oversize * 100).toFixed(2)}%. `
      + 'Increase lot percent or max_deposit.'
    );
  }

  return {
    baseQty: best.base.text,
    quoteQty: best.quote.text,
    baseNotional: best.base.notional,
    quoteNotional: best.quote.notional,
    totalNotional: best.totalActual,
    shareError: best.shareError,
    totalDeviation: best.totalDeviation,
    oversize: best.oversize,
    baseTargetNotional,
    quoteTargetNotional,
  };
};

const buildSingleQtyPlan = async (
  apiKeyName: string,
  symbol: string,
  price: number,
  targetNotional: number
): Promise<SingleQtyPlan> => {
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) {
    throw new Error('Trade notional must be positive');
  }

  const rules = await loadQtyRules(apiKeyName, symbol);
  const rawQty = targetNotional / price;
  const candidates = buildQtyCandidates(rawQty, price, rules);

  let best: {
    candidate: QtyCandidate;
    totalDeviation: number;
    oversize: number;
    score: number;
  } | null = null;

  for (const candidate of candidates) {
    const totalDeviation = Math.abs(candidate.notional - targetNotional) / Math.max(targetNotional, SIZING_EPSILON);
    const oversize = Math.max(0, (candidate.notional - targetNotional) / Math.max(targetNotional, SIZING_EPSILON));
    const score = oversize * 200 + totalDeviation * 10;

    if (!best || score < best.score) {
      best = {
        candidate,
        totalDeviation,
        oversize,
        score,
      };
    }
  }

  if (!best) {
    throw new Error(`Unable to find a valid quantity plan for ${symbol}`);
  }

  if (best.totalDeviation > MAX_TOTAL_DEVIATION || best.oversize > MAX_OVERSIZE_DEVIATION) {
    throw new Error(
      `Order size too small for mono execution: totalDeviation=${(best.totalDeviation * 100).toFixed(2)}%, `
      + `oversize=${(best.oversize * 100).toFixed(2)}%. Increase lot percent or max_deposit.`
    );
  }

  return {
    qty: best.candidate.text,
    notional: best.candidate.notional,
    targetNotional,
    totalDeviation: best.totalDeviation,
    oversize: best.oversize,
  };
};

const sleepMs = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
};

const extractPositionNotional = (position: any): number => {
  const explicit = Number(position?.positionValue);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.abs(explicit);
  }

  const size = Number(position?.size);
  const markPrice = Number(position?.markPrice);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(markPrice) && markPrice > 0) {
    return Math.abs(size * markPrice);
  }

  const entryPrice = Number(position?.avgPrice ?? position?.entryPrice);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    return Math.abs(size * entryPrice);
  }

  return 0;
};

const validateLiveLegBalance = (
  basePosition: any,
  quotePosition: any,
  baseWeight: number,
  quoteWeight: number,
  maxShareError: number
): { ok: boolean; snapshot: LiveLegBalanceSnapshot } => {
  const safeBaseWeight = Math.abs(baseWeight);
  const safeQuoteWeight = Math.abs(quoteWeight);
  const totalWeight = safeBaseWeight + safeQuoteWeight;

  const baseNotional = extractPositionNotional(basePosition);
  const quoteNotional = extractPositionNotional(quotePosition);
  const totalNotional = baseNotional + quoteNotional;

  const expectedBaseShare = totalWeight > SIZING_EPSILON
    ? safeBaseWeight / totalWeight
    : 0.5;
  const actualBaseShare = totalNotional > SIZING_EPSILON
    ? baseNotional / totalNotional
    : 0;
  const shareError = Math.abs(actualBaseShare - expectedBaseShare);

  return {
    ok: totalNotional > SIZING_EPSILON && shareError <= Math.max(0, maxShareError),
    snapshot: {
      baseNotional,
      quoteNotional,
      expectedBaseShare,
      actualBaseShare,
      shareError,
    },
  };
};

const loadPairPositionsForValidation = async (
  apiKeyName: string,
  baseSymbol: string,
  quoteSymbol: string,
  attempts: number = 3,
  waitMs: number = 300
): Promise<{ basePosition: any | null; quotePosition: any | null }> => {
  const safeAttempts = Math.max(1, Math.floor(attempts));

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const positions = await getPositions(apiKeyName);

    const basePosition = positions.find((position: any) => {
      return (
        String(position?.symbol || '').toUpperCase() === baseSymbol.toUpperCase()
        && Number.parseFloat(String(position?.size || '0')) > 0
      );
    }) || null;

    const quotePosition = positions.find((position: any) => {
      return (
        String(position?.symbol || '').toUpperCase() === quoteSymbol.toUpperCase()
        && Number.parseFloat(String(position?.size || '0')) > 0
      );
    }) || null;

    if (basePosition && quotePosition) {
      return { basePosition, quotePosition };
    }

    if (attempt < safeAttempts - 1) {
      await sleepMs(waitMs);
    }
  }

  return {
    basePosition: null,
    quotePosition: null,
  };
};

const loadSinglePositionForValidation = async (
  apiKeyName: string,
  symbol: string,
  attempts: number = 3,
  waitMs: number = 300
): Promise<any | null> => {
  const safeAttempts = Math.max(1, Math.floor(attempts));

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const positions = await getPositions(apiKeyName);
    const position = positions.find((item: any) => {
      return (
        String(item?.symbol || '').toUpperCase() === symbol.toUpperCase()
        && Number.parseFloat(String(item?.size || '0')) > 0
      );
    }) || null;

    if (position) {
      return position;
    }

    if (attempt < safeAttempts - 1) {
      await sleepMs(waitMs);
    }
  }

  return null;
};

type ExecutionCandleContext = {
  candlesForSignal: ParsedSyntheticCandle[];
  evaluatedBarTimeMs: number;
};

const resolveExecutionCandleContext = (
  candles: ParsedSyntheticCandle[],
  interval: string,
  closedBarOnly: boolean
): ExecutionCandleContext => {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error('No synthetic candles available for execution');
  }

  if (!closedBarOnly) {
    const latest = candles[candles.length - 1];
    return {
      candlesForSignal: candles,
      evaluatedBarTimeMs: latest.timeMs,
    };
  }

  const intervalMs = Math.max(60 * 1000, intervalToMs(interval));
  let closedIndex = candles.length - 1;
  const latest = candles[closedIndex];
  const latestClosesAt = latest.timeMs + intervalMs;

  if (latestClosesAt > Date.now() + BAR_CLOSE_FRESHNESS_MS) {
    closedIndex -= 1;
  }

  if (closedIndex < 0) {
    throw new Error('No closed candles available for execution');
  }

  return {
    candlesForSignal: candles.slice(0, closedIndex + 1),
    evaluatedBarTimeMs: candles[closedIndex].timeMs,
  };
};

type ComputedSignal = {
  signal: StrategySignal;
  currentRatio: number;
  donchianHigh: number;
  donchianLow: number;
  donchianCenter: number;
  zScore: number | null;
};

const mean = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stddev = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  const avg = mean(values);
  const variance = values.reduce((sum, value) => {
    const delta = value - avg;
    return sum + delta * delta;
  }, 0) / values.length;

  return Math.sqrt(Math.max(0, variance));
};

const computeDonchianSignal = (
  candles: ParsedSyntheticCandle[],
  length: number,
  detectionSource: 'wick' | 'close',
  longEnabled: boolean,
  shortEnabled: boolean
): ComputedSignal => {
  if (candles.length < length + 1) {
    throw new Error(`Not enough candles for Donchian channel: need ${length + 1}, got ${candles.length}`);
  }

  const current = candles[candles.length - 1];
  const window = candles.slice(candles.length - 1 - length, candles.length - 1);

  if (window.length === 0) {
    throw new Error('Donchian window is empty');
  }

  const highs = detectionSource === 'close' ? window.map((item) => item.close) : window.map((item) => item.high);
  const lows = detectionSource === 'close' ? window.map((item) => item.close) : window.map((item) => item.low);

  const donchianHigh = Math.max(...highs);
  const donchianLow = Math.min(...lows);
  const donchianCenter = (donchianHigh + donchianLow) / 2;

  const longBreakout = detectionSource === 'close' ? current.close >= donchianHigh : current.high >= donchianHigh;
  const shortBreakout = detectionSource === 'close' ? current.close <= donchianLow : current.low <= donchianLow;

  if (longEnabled && longBreakout) {
    return {
      signal: 'long',
      currentRatio: current.close,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore: null,
    };
  }

  if (shortEnabled && shortBreakout) {
    return {
      signal: 'short',
      currentRatio: current.close,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore: null,
    };
  }

  return {
    signal: 'none',
    currentRatio: current.close,
    donchianHigh,
    donchianLow,
    donchianCenter,
    zScore: null,
  };
};

const computeStatArbSignal = (
  candles: ParsedSyntheticCandle[],
  lookbackLength: number,
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean
): ComputedSignal => {
  if (candles.length < lookbackLength + 1) {
    throw new Error(`Not enough candles for z-score window: need ${lookbackLength + 1}, got ${candles.length}`);
  }

  const current = candles[candles.length - 1];
  const window = candles.slice(candles.length - 1 - lookbackLength, candles.length - 1);
  const series = window.map((item) => item.close);

  const avg = mean(series);
  const sigma = stddev(series);
  const currentRatio = current.close;

  const donchianCenter = avg;
  const donchianHigh = avg + sigma;
  const donchianLow = avg - sigma;

  if (!Number.isFinite(sigma) || sigma <= 1e-12) {
    return {
      signal: 'none',
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore: 0,
    };
  }

  const zScore = (currentRatio - avg) / sigma;

  if (shortEnabled && zScore >= zscoreEntry) {
    return {
      signal: 'short',
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore,
    };
  }

  if (longEnabled && zScore <= -zscoreEntry) {
    return {
      signal: 'long',
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore,
    };
  }

  return {
    signal: 'none',
    currentRatio,
    donchianHigh,
    donchianLow,
    donchianCenter,
    zScore,
  };
};

const computeSignal = (
  strategyType: StrategyType,
  candles: ParsedSyntheticCandle[],
  length: number,
  detectionSource: 'wick' | 'close',
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean
): ComputedSignal => {
  if (strategyType === 'stat_arb_zscore') {
    return computeStatArbSignal(
      candles,
      length,
      zscoreEntry,
      longEnabled,
      shortEnabled
    );
  }

  return computeDonchianSignal(
    candles,
    length,
    detectionSource,
    longEnabled,
    shortEnabled
  );
};

const closeAllForSymbol = async (apiKeyName: string, symbol: string): Promise<void> => {
  const positions = await getPositions(apiKeyName, symbol);
  const relevant = positions.filter((position: any) => {
    return (
      String(position?.symbol || '').toUpperCase() === symbol.toUpperCase() &&
      Number.parseFloat(String(position?.size || '0')) > 0
    );
  });

  for (const position of relevant) {
    await closePosition(apiKeyName, symbol, String(position.size), position.side as 'Buy' | 'Sell');
  }
};

const closeStrategyExposure = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>
): Promise<void> => {
  const symbols = getStrategySymbols(strategy);
  for (const symbol of symbols) {
    await closeAllForSymbol(apiKeyName, symbol);
  }
};

const cancelStrategyWorkingOrders = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>
): Promise<void> => {
  const symbols = getStrategySymbols(strategy);
  for (const symbol of symbols) {
    await cancelAllOrders(apiKeyName, symbol);
  }
};

const inferMonoStateFromPosition = (
  position: any | null
): 'flat' | 'long' | 'short' | 'mixed' => {
  if (!position) {
    return 'flat';
  }

  const side = String(position?.side || '').toLowerCase();
  if (side === 'buy') {
    return 'long';
  }
  if (side === 'sell') {
    return 'short';
  }
  return 'mixed';
};

const inferSyntheticStateFromPair = (
  basePosition: any | null,
  quotePosition: any | null
): 'flat' | 'long' | 'short' | 'mixed' => {
  if (!basePosition && !quotePosition) {
    return 'flat';
  }

  if (!basePosition || !quotePosition) {
    return 'mixed';
  }

  const baseSide = String(basePosition?.side || '').toLowerCase();
  const quoteSide = String(quotePosition?.side || '').toLowerCase();

  if (baseSide === 'buy' && quoteSide === 'sell') {
    return 'long';
  }

  if (baseSide === 'sell' && quoteSide === 'buy') {
    return 'short';
  }

  return 'mixed';
};

const formatActionError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

type GetStrategiesOptions = {
  includeLotPreview?: boolean;
  limit?: number;
  offset?: number;
};

export type StrategySummary = Pick<
  Strategy,
  'id' | 'name' | 'strategy_type' | 'is_active' | 'base_symbol' | 'quote_symbol' | 'interval' | 'state' | 'last_action' | 'last_error'
> & {
  is_runtime: boolean;
  is_archived: boolean;
  origin: string;
};

export const getStrategies = async (apiKeyName: string, options?: GetStrategiesOptions): Promise<Strategy[]> => {
  const { db } = await import('../utils/database');
  const limitRaw = Number(options?.limit);
  const offsetRaw = Number(options?.offset);
  const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;
  const limit = hasLimit ? Math.floor(limitRaw) : 0;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

  const sqlParts = [
    `SELECT s.*`,
    `FROM strategies s`,
    `JOIN api_keys a ON a.id = s.api_key_id`,
    `WHERE a.name = ?`,
    `ORDER BY s.id DESC`,
  ];
  const params: any[] = [apiKeyName];

  if (hasLimit) {
    sqlParts.push('LIMIT ? OFFSET ?');
    params.push(limit, offset);
  }

  const rows = await db.all(sqlParts.join('\n'), params);

  const normalized = rows.map(normalizeStrategy);

  const includeLotPreview = options?.includeLotPreview !== false;
  if (!includeLotPreview) {
    return normalized.map((strategy) => ({
      ...strategy,
      lot_long_usdt: null,
      lot_short_usdt: null,
      lot_balance_usdt: null,
    }));
  }

  let availableBalance: number | null = null;

  try {
    const balances = await getBalances(apiKeyName);
    availableBalance = extractUsdtBalance(balances);
  } catch (error) {
    logger.warn(`Could not compute lot preview balance for ${apiKeyName}: ${formatActionError(error)}`);
  }

  return normalized.map((strategy) => {
    if (availableBalance === null) {
      return {
        ...strategy,
        lot_long_usdt: null,
        lot_short_usdt: null,
        lot_balance_usdt: null,
      };
    }

    return {
      ...strategy,
      lot_long_usdt: computeSignalTotalNotional(strategy, availableBalance, 'long'),
      lot_short_usdt: computeSignalTotalNotional(strategy, availableBalance, 'short'),
      lot_balance_usdt: availableBalance,
    };
  });
};

export const getStrategySummaries = async (
  apiKeyName: string,
  options?: { limit?: number; offset?: number; includeArchived?: boolean; runtimeOnly?: boolean }
): Promise<StrategySummary[]> => {
  const { db } = await import('../utils/database');
  const limitRaw = Number(options?.limit);
  const offsetRaw = Number(options?.offset);
  const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;
  const limit = hasLimit ? Math.floor(limitRaw) : 0;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

  const sqlParts = [
    `SELECT s.id, s.name, s.strategy_type, s.is_active, s.base_symbol, s.quote_symbol, s.interval, s.state, s.last_action, s.last_error,
     COALESCE(s.is_runtime, 0) AS is_runtime, COALESCE(s.is_archived, 0) AS is_archived, COALESCE(s.origin, 'manual') AS origin`,
    `FROM strategies s`,
    `JOIN api_keys a ON a.id = s.api_key_id`,
    `WHERE a.name = ?`,
  ];
  const params: any[] = [apiKeyName];

  if (!options?.includeArchived) {
    sqlParts.push(`AND COALESCE(s.is_archived, 0) = 0`);
  }

  if (options?.runtimeOnly) {
    sqlParts.push(`AND COALESCE(s.is_runtime, 0) = 1`);
  }

  sqlParts.push(`ORDER BY s.is_active DESC, s.id DESC`);

  if (hasLimit) {
    sqlParts.push('LIMIT ? OFFSET ?');
    params.push(limit, offset);
  }

  const rows = await db.all(sqlParts.join('\n'), params);

  return rows.map((row: any) => ({
    id: Number(row.id),
    name: String(row.name || DEFAULT_STRATEGY.name),
    strategy_type: normalizeStrategyType(row.strategy_type),
    is_active: safeBoolean(row.is_active, true),
    base_symbol: normalizeSymbol(String(row.base_symbol || DEFAULT_STRATEGY.base_symbol)),
    quote_symbol: normalizeSymbol(String(row.quote_symbol || DEFAULT_STRATEGY.quote_symbol)),
    interval: String(row.interval || DEFAULT_STRATEGY.interval),
    state: String(row.state || 'flat') === 'long' ? 'long' : String(row.state || 'flat') === 'short' ? 'short' : 'flat',
    last_action: row.last_action === undefined ? null : row.last_action,
    last_error: row.last_error === undefined ? null : row.last_error,
    is_runtime: safeBoolean(row.is_runtime, false),
    is_archived: safeBoolean(row.is_archived, false),
    origin: String(row.origin || 'manual'),
  }));
};

export const getStrategyById = async (
  apiKeyName: string,
  strategyId: number,
  options?: { includeLotPreview?: boolean }
): Promise<Strategy> => {
  const row = await getStrategyRow(apiKeyName, strategyId);
  const normalized = normalizeStrategy(row);
  const includeLotPreview = options?.includeLotPreview !== false;

  if (!includeLotPreview) {
    return {
      ...normalized,
      lot_long_usdt: null,
      lot_short_usdt: null,
      lot_balance_usdt: null,
    };
  }

  try {
    const balances = await getBalances(apiKeyName);
    const availableBalance = extractUsdtBalance(balances);

    return {
      ...normalized,
      lot_long_usdt: computeSignalTotalNotional(normalized, availableBalance, 'long'),
      lot_short_usdt: computeSignalTotalNotional(normalized, availableBalance, 'short'),
      lot_balance_usdt: availableBalance,
    };
  } catch (error) {
    logger.warn(`Could not compute lot preview for strategy ${strategyId} (${apiKeyName}): ${formatActionError(error)}`);
    return {
      ...normalized,
      lot_long_usdt: null,
      lot_short_usdt: null,
      lot_balance_usdt: null,
    };
  }
};

export const createStrategy = async (apiKeyName: string, draft: StrategyDraft): Promise<Strategy> => {
  const { db } = await import('../utils/database');
  const apiKeyId = await getApiKeyId(apiKeyName);

  const strategyType = normalizeStrategyType(draft.strategy_type || DEFAULT_STRATEGY.strategy_type);
  const marketMode = normalizeMarketMode(draft.market_mode || DEFAULT_STRATEGY.market_mode);
  const zscoreEntry = normalizeZscoreEntry(draft.zscore_entry, DEFAULT_STRATEGY.zscore_entry);
  const zscoreExit = normalizeZscoreExit(draft.zscore_exit, DEFAULT_STRATEGY.zscore_exit, zscoreEntry);
  const zscoreStop = normalizeZscoreStop(draft.zscore_stop, DEFAULT_STRATEGY.zscore_stop, zscoreEntry);
  const baseSymbol = normalizeSymbol(String(draft.base_symbol || DEFAULT_STRATEGY.base_symbol));
  const quoteSymbol = marketMode === 'mono'
    ? normalizeSymbol(String(draft.quote_symbol || ''))
    : normalizeSymbol(String(draft.quote_symbol || DEFAULT_STRATEGY.quote_symbol));
  const baseCoef = safeNumber(draft.base_coef, DEFAULT_STRATEGY.base_coef);
  const quoteCoef = marketMode === 'mono' ? safeNumber(draft.quote_coef, 0) : safeNumber(draft.quote_coef, DEFAULT_STRATEGY.quote_coef);

  const strategy: Strategy = {
    ...DEFAULT_STRATEGY,
    name: String(draft.name || DEFAULT_STRATEGY.name),
    api_key_id: apiKeyId,
    strategy_type: strategyType,
    market_mode: marketMode,
    is_active: safeBoolean(draft.is_active, DEFAULT_STRATEGY.is_active),
    display_on_chart: safeBoolean(draft.display_on_chart, DEFAULT_STRATEGY.display_on_chart),
    show_settings: safeBoolean(draft.show_settings, DEFAULT_STRATEGY.show_settings),
    show_chart: safeBoolean(draft.show_chart, DEFAULT_STRATEGY.show_chart),
    show_indicators: safeBoolean(draft.show_indicators, DEFAULT_STRATEGY.show_indicators),
    show_positions_on_chart: safeBoolean(draft.show_positions_on_chart, DEFAULT_STRATEGY.show_positions_on_chart),
    show_trades_on_chart: safeBoolean(draft.show_trades_on_chart, DEFAULT_STRATEGY.show_trades_on_chart || false),
    show_values_each_bar: safeBoolean(draft.show_values_each_bar, DEFAULT_STRATEGY.show_values_each_bar),
    auto_update: safeBoolean(draft.auto_update, DEFAULT_STRATEGY.auto_update),
    take_profit_percent: safeNumber(draft.take_profit_percent, DEFAULT_STRATEGY.take_profit_percent),
    price_channel_length: Math.max(2, Math.floor(safeNumber(draft.price_channel_length, DEFAULT_STRATEGY.price_channel_length))),
    detection_source: draft.detection_source === 'wick' ? 'wick' : 'close',
    zscore_entry: zscoreEntry,
    zscore_exit: zscoreExit,
    zscore_stop: zscoreStop,
    base_symbol: baseSymbol,
    quote_symbol: quoteSymbol,
    interval: String(draft.interval || DEFAULT_STRATEGY.interval).trim() || DEFAULT_STRATEGY.interval,
    base_coef: baseCoef,
    quote_coef: quoteCoef,
    long_enabled: safeBoolean(draft.long_enabled, DEFAULT_STRATEGY.long_enabled),
    short_enabled: safeBoolean(draft.short_enabled, DEFAULT_STRATEGY.short_enabled),
    lot_long_percent: safeNumber(draft.lot_long_percent, DEFAULT_STRATEGY.lot_long_percent),
    lot_short_percent: safeNumber(draft.lot_short_percent, DEFAULT_STRATEGY.lot_short_percent),
    max_deposit: safeNumber(draft.max_deposit, DEFAULT_STRATEGY.max_deposit),
    margin_type: draft.margin_type === 'isolated' ? 'isolated' : 'cross',
    leverage: Math.max(1, safeNumber(draft.leverage, DEFAULT_STRATEGY.leverage)),
    fixed_lot: safeBoolean(draft.fixed_lot, DEFAULT_STRATEGY.fixed_lot),
    reinvest_percent: safeNumber(draft.reinvest_percent, DEFAULT_STRATEGY.reinvest_percent),
    state: 'flat',
    entry_ratio: null,
    tp_anchor_ratio: null,
    last_signal: null,
    last_action: null,
    last_error: null,
  };

  validateStrategyBinding(strategy);

  const result: any = await db.run(
    `INSERT INTO strategies (
      name,
      api_key_id,
      strategy_type,
      market_mode,
      is_active,
      display_on_chart,
      show_settings,
      show_chart,
      show_indicators,
      show_positions_on_chart,
      show_trades_on_chart,
      show_values_each_bar,
      auto_update,
      take_profit_percent,
      price_channel_length,
      detection_source,
      zscore_entry,
      zscore_exit,
      zscore_stop,
      base_symbol,
      quote_symbol,
      interval,
      base_coef,
      quote_coef,
      long_enabled,
      short_enabled,
      lot_long_percent,
      lot_short_percent,
      max_deposit,
      margin_type,
      leverage,
      fixed_lot,
      reinvest_percent,
      state,
      entry_ratio,
      tp_anchor_ratio,
      last_signal,
      last_action,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`,
    [
      strategy.name,
      strategy.api_key_id,
      strategy.strategy_type,
      strategy.market_mode,
      strategy.is_active ? 1 : 0,
      strategy.display_on_chart ? 1 : 0,
      strategy.show_settings ? 1 : 0,
      strategy.show_chart ? 1 : 0,
      strategy.show_indicators ? 1 : 0,
      strategy.show_positions_on_chart ? 1 : 0,
      strategy.show_trades_on_chart ? 1 : 0,
      strategy.show_values_each_bar ? 1 : 0,
      strategy.auto_update ? 1 : 0,
      strategy.take_profit_percent,
      strategy.price_channel_length,
      strategy.detection_source,
      strategy.zscore_entry,
      strategy.zscore_exit,
      strategy.zscore_stop,
      strategy.base_symbol,
      strategy.quote_symbol,
      strategy.interval,
      strategy.base_coef,
      strategy.quote_coef,
      strategy.long_enabled ? 1 : 0,
      strategy.short_enabled ? 1 : 0,
      strategy.lot_long_percent,
      strategy.lot_short_percent,
      strategy.max_deposit,
      strategy.margin_type,
      strategy.leverage,
      strategy.fixed_lot ? 1 : 0,
      strategy.reinvest_percent,
      strategy.state,
      strategy.entry_ratio,
      strategy.tp_anchor_ratio,
      strategy.last_signal,
      strategy.last_action,
      strategy.last_error,
    ]
  );

  const created = await getStrategyRow(apiKeyName, Number(result.lastID));
  return normalizeStrategy(created);
};

export const updateStrategy = async (
  apiKeyName: string,
  strategyId: number,
  patch: Partial<Strategy>,
  options?: {
    allowBindingUpdate?: boolean;
    source?: string;
  }
): Promise<Strategy> => {
  const existing = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  const updateSource = String(options?.source || 'unspecified');

  const updates: Array<{ column: string; value: any }> = [];
  const pushUpdate = (column: string, value: any) => {
    updates.push({ column, value });
  };

  const requestedMarketMode = patch.market_mode !== undefined ? normalizeMarketMode(patch.market_mode) : existing.market_mode;

  if (patch.name !== undefined) {
    pushUpdate('name', String(patch.name || '').trim() || existing.name);
  }
  if (patch.is_active !== undefined) {
    pushUpdate('is_active', safeBoolean(patch.is_active, existing.is_active) ? 1 : 0);
  }
  if (patch.display_on_chart !== undefined) {
    pushUpdate('display_on_chart', safeBoolean(patch.display_on_chart, existing.display_on_chart) ? 1 : 0);
  }
  if (patch.show_settings !== undefined) {
    pushUpdate('show_settings', safeBoolean(patch.show_settings, existing.show_settings) ? 1 : 0);
  }
  if (patch.show_chart !== undefined) {
    pushUpdate('show_chart', safeBoolean(patch.show_chart, existing.show_chart) ? 1 : 0);
  }
  if (patch.show_indicators !== undefined) {
    pushUpdate('show_indicators', safeBoolean(patch.show_indicators, existing.show_indicators) ? 1 : 0);
  }
  if (patch.show_positions_on_chart !== undefined) {
    pushUpdate(
      'show_positions_on_chart',
      safeBoolean(patch.show_positions_on_chart, existing.show_positions_on_chart) ? 1 : 0
    );
  }
  if (patch.show_trades_on_chart !== undefined) {
    pushUpdate(
      'show_trades_on_chart',
      safeBoolean(patch.show_trades_on_chart, existing.show_trades_on_chart || false) ? 1 : 0
    );
  }
  if (patch.show_values_each_bar !== undefined) {
    pushUpdate('show_values_each_bar', safeBoolean(patch.show_values_each_bar, existing.show_values_each_bar) ? 1 : 0);
  }
  if (patch.auto_update !== undefined) {
    pushUpdate('auto_update', safeBoolean(patch.auto_update, existing.auto_update) ? 1 : 0);
  }
  if (patch.take_profit_percent !== undefined) {
    pushUpdate('take_profit_percent', safeNumber(patch.take_profit_percent, existing.take_profit_percent));
  }
  if (patch.strategy_type !== undefined) {
    pushUpdate('strategy_type', normalizeStrategyType(patch.strategy_type));
  }
  if (patch.market_mode !== undefined) {
    pushUpdate('market_mode', requestedMarketMode);
    if (requestedMarketMode === 'mono') {
      pushUpdate('quote_symbol', normalizeSymbol(String(patch.quote_symbol || '')));
      pushUpdate('quote_coef', patch.quote_coef !== undefined ? safeNumber(patch.quote_coef, 0) : 0);
    }
  }
  if (patch.price_channel_length !== undefined) {
    pushUpdate(
      'price_channel_length',
      Math.max(2, Math.floor(safeNumber(patch.price_channel_length, existing.price_channel_length)))
    );
  }
  if (patch.detection_source !== undefined) {
    const nextDetection = patch.detection_source === 'wick' ? 'wick' : patch.detection_source === 'close' ? 'close' : existing.detection_source;
    pushUpdate('detection_source', nextDetection);
  }
  if (patch.zscore_entry !== undefined) {
    const nextEntry = normalizeZscoreEntry(patch.zscore_entry, existing.zscore_entry);
    const exitSource = patch.zscore_exit !== undefined ? patch.zscore_exit : existing.zscore_exit;
    const stopSource = patch.zscore_stop !== undefined ? patch.zscore_stop : existing.zscore_stop;
    pushUpdate('zscore_entry', nextEntry);
    pushUpdate('zscore_exit', normalizeZscoreExit(exitSource, existing.zscore_exit, nextEntry));
    pushUpdate('zscore_stop', normalizeZscoreStop(stopSource, existing.zscore_stop, nextEntry));
  } else {
    if (patch.zscore_exit !== undefined) {
      pushUpdate('zscore_exit', normalizeZscoreExit(patch.zscore_exit, existing.zscore_exit, existing.zscore_entry));
    }
    if (patch.zscore_stop !== undefined) {
      pushUpdate('zscore_stop', normalizeZscoreStop(patch.zscore_stop, existing.zscore_stop, existing.zscore_entry));
    }
  }
  if (patch.base_symbol !== undefined) {
    pushUpdate('base_symbol', normalizeSymbol(String(patch.base_symbol)));
  }
  if (patch.quote_symbol !== undefined) {
    pushUpdate('quote_symbol', requestedMarketMode === 'mono' ? normalizeSymbol(String(patch.quote_symbol || '')) : normalizeSymbol(String(patch.quote_symbol)));
  }
  if (patch.interval !== undefined) {
    pushUpdate('interval', String(patch.interval || '').trim() || existing.interval);
  }
  if (patch.base_coef !== undefined) {
    pushUpdate('base_coef', safeNumber(patch.base_coef, existing.base_coef));
  }
  if (patch.quote_coef !== undefined) {
    pushUpdate('quote_coef', requestedMarketMode === 'mono' ? safeNumber(patch.quote_coef, 0) : safeNumber(patch.quote_coef, existing.quote_coef));
  }
  if (patch.long_enabled !== undefined) {
    pushUpdate('long_enabled', safeBoolean(patch.long_enabled, existing.long_enabled) ? 1 : 0);
  }
  if (patch.short_enabled !== undefined) {
    pushUpdate('short_enabled', safeBoolean(patch.short_enabled, existing.short_enabled) ? 1 : 0);
  }
  if (patch.lot_long_percent !== undefined) {
    pushUpdate('lot_long_percent', safeNumber(patch.lot_long_percent, existing.lot_long_percent));
  }
  if (patch.lot_short_percent !== undefined) {
    pushUpdate('lot_short_percent', safeNumber(patch.lot_short_percent, existing.lot_short_percent));
  }
  if (patch.max_deposit !== undefined) {
    pushUpdate('max_deposit', safeNumber(patch.max_deposit, existing.max_deposit));
  }
  if (patch.margin_type !== undefined) {
    const nextMarginType = patch.margin_type === 'isolated' ? 'isolated' : patch.margin_type === 'cross' ? 'cross' : existing.margin_type;
    pushUpdate('margin_type', nextMarginType);
  }
  if (patch.leverage !== undefined) {
    pushUpdate('leverage', Math.max(1, safeNumber(patch.leverage, existing.leverage)));
  }
  if (patch.fixed_lot !== undefined) {
    pushUpdate('fixed_lot', safeBoolean(patch.fixed_lot, existing.fixed_lot) ? 1 : 0);
  }
  if (patch.reinvest_percent !== undefined) {
    pushUpdate('reinvest_percent', safeNumber(patch.reinvest_percent, existing.reinvest_percent));
  }
  if (patch.state !== undefined) {
    const nextState = patch.state === 'long' || patch.state === 'short' || patch.state === 'flat' ? patch.state : existing.state;
    pushUpdate('state', nextState);
  }
  if (patch.entry_ratio !== undefined) {
    if (patch.entry_ratio === null) {
      pushUpdate('entry_ratio', null);
    } else {
      const currentEntry = existing.entry_ratio === null || existing.entry_ratio === undefined ? 0 : existing.entry_ratio;
      pushUpdate('entry_ratio', safeNumber(patch.entry_ratio, currentEntry));
    }
  }
  if (patch.tp_anchor_ratio !== undefined) {
    if (patch.tp_anchor_ratio === null) {
      pushUpdate('tp_anchor_ratio', null);
    } else {
      const currentAnchor = existing.tp_anchor_ratio === null || existing.tp_anchor_ratio === undefined ? 0 : existing.tp_anchor_ratio;
      pushUpdate('tp_anchor_ratio', safeNumber(patch.tp_anchor_ratio, currentAnchor));
    }
  }
  if (patch.last_signal !== undefined) {
    pushUpdate('last_signal', patch.last_signal ?? null);
  }
  if (patch.last_action !== undefined) {
    pushUpdate('last_action', patch.last_action ?? null);
  }
  if (patch.last_error !== undefined) {
    pushUpdate('last_error', patch.last_error ?? null);
  }

  const bindingTouched = (
    patch.market_mode !== undefined
    || patch.base_symbol !== undefined
    || patch.quote_symbol !== undefined
    || patch.interval !== undefined
    || patch.base_coef !== undefined
    || patch.quote_coef !== undefined
  );

  if (bindingTouched && options?.allowBindingUpdate !== true) {
    throw new Error(
      `Binding update denied for strategyId=${strategyId}, apiKey=${apiKeyName}, source=${updateSource}`
    );
  }

  if (bindingTouched) {
    validateStrategyBinding({
      market_mode: requestedMarketMode,
      base_symbol: patch.base_symbol !== undefined ? normalizeSymbol(String(patch.base_symbol)) : existing.base_symbol,
      quote_symbol: patch.quote_symbol !== undefined
        ? (requestedMarketMode === 'mono' ? normalizeSymbol(String(patch.quote_symbol || '')) : normalizeSymbol(String(patch.quote_symbol)))
        : existing.quote_symbol,
      interval: patch.interval !== undefined ? String(patch.interval || '').trim() || existing.interval : existing.interval,
      base_coef: patch.base_coef !== undefined ? safeNumber(patch.base_coef, existing.base_coef) : existing.base_coef,
      quote_coef: patch.quote_coef !== undefined
        ? (requestedMarketMode === 'mono' ? safeNumber(patch.quote_coef, 0) : safeNumber(patch.quote_coef, existing.quote_coef))
        : existing.quote_coef,
    });
  }

  if (updates.length === 0) {
    return existing;
  }

  const { db } = await import('../utils/database');
  const setClause = updates.map((item) => `${item.column} = ?`).join(', ');
  const params = updates.map((item) => item.value);

  if (!bindingTouched) {
    const updateResult: any = await db.run(
      `UPDATE strategies SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND api_key_id = ?`,
      [...params, strategyId, existing.api_key_id]
    );

    if (Number(updateResult?.changes || 0) !== 1) {
      throw new Error(`Strategy update failed or affected unexpected rows: strategyId=${strategyId}`);
    }
  } else {
    let transactionStarted = false;

    try {
      await db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;

      const beforeRows = await db.all(
        `SELECT id, base_symbol, quote_symbol, interval, base_coef, quote_coef
         FROM strategies
         WHERE api_key_id = ?`,
        [existing.api_key_id]
      );

      const beforeById = new Map<number, any>();
      (Array.isArray(beforeRows) ? beforeRows : []).forEach((row: any) => {
        beforeById.set(Number(row.id), row);
      });

      const updateResult: any = await db.run(
        `UPDATE strategies SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND api_key_id = ?`,
        [...params, strategyId, existing.api_key_id]
      );

      if (Number(updateResult?.changes || 0) !== 1) {
        throw new Error(`Strategy update failed or affected unexpected rows: strategyId=${strategyId}`);
      }

      const afterRows = await db.all(
        `SELECT id, base_symbol, quote_symbol, interval, base_coef, quote_coef
         FROM strategies
         WHERE api_key_id = ?`,
        [existing.api_key_id]
      );

      const offenders: number[] = [];

      (Array.isArray(afterRows) ? afterRows : []).forEach((afterRow: any) => {
        const rowId = Number(afterRow.id);
        if (rowId === strategyId) {
          return;
        }

        const beforeRow = beforeById.get(rowId);
        if (!beforeRow) {
          return;
        }

        const bindingChanged = (
          normalizeSymbol(beforeRow.base_symbol) !== normalizeSymbol(afterRow.base_symbol)
          || normalizeSymbol(beforeRow.quote_symbol) !== normalizeSymbol(afterRow.quote_symbol)
          || normalizeInterval(beforeRow.interval) !== normalizeInterval(afterRow.interval)
          || Math.abs(normalizeCoef(beforeRow.base_coef) - normalizeCoef(afterRow.base_coef)) > 1e-12
          || Math.abs(normalizeCoef(beforeRow.quote_coef) - normalizeCoef(afterRow.quote_coef)) > 1e-12
        );

        if (bindingChanged) {
          offenders.push(rowId);
        }
      });

      if (offenders.length > 0) {
        logger.error(
          `Unsafe binding update blocked: strategyId=${strategyId}, apiKey=${apiKeyName}, source=${updateSource}, offenders=${offenders.join(',')}`
        );
        throw new Error(
          `Unsafe update blocked: binding fields changed for other strategies in api_key_id=${existing.api_key_id} (ids: ${offenders.join(', ')})`
        );
      }

      await db.exec('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await db.exec('ROLLBACK');
      }
      throw error;
    }
  }

  const updated = await getStrategyRow(apiKeyName, strategyId);
  const normalizedUpdated = normalizeStrategy(updated);

  if (bindingTouched) {
    logger.info(
      `Strategy binding updated: source=${updateSource}, apiKey=${apiKeyName}, strategyId=${strategyId}, `
      + `${existing.base_symbol}/${existing.quote_symbol}@${existing.interval} -> `
      + `${normalizedUpdated.base_symbol}/${normalizedUpdated.quote_symbol}@${normalizedUpdated.interval}`
    );
  }

  return normalizedUpdated;
};

export const deleteStrategy = async (apiKeyName: string, strategyId: number): Promise<void> => {
  const { db } = await import('../utils/database');
  await db.run(
    `DELETE FROM strategies
     WHERE id = ?
       AND api_key_id = (SELECT id FROM api_keys WHERE name = ?)`,
    [strategyId, apiKeyName]
  );
};

export const executeStrategy = async (
  apiKeyName: string,
  strategyId: number,
  options?: ExecuteStrategyOptions
) => {
  const existingRow = await getStrategyRow(apiKeyName, strategyId);
  const strategy = normalizeStrategy(existingRow);

  const executionSource: StrategyExecutionSource = options?.source || 'manual';
  const closedBarOnly = options?.closedBarOnly !== false;
  const dedupeClosedBar = options?.dedupeClosedBar === true;

  if (!strategy.is_active) {
    return {
      result: 'Strategy is paused',
      action: 'paused',
    };
  }

  const mergedStrategy: Strategy = {
    ...strategy,
  };
  const marketMode = normalizeMarketMode(mergedStrategy.market_mode);
  const isMono = marketMode === 'mono';
  const positionLabel = isMono ? 'position' : 'synthetic position';

  // Execution must follow persisted strategy settings only.
  // This prevents stale UI/chart payloads from silently mutating strategy pairs.
  const executionBindingPatch: Partial<Strategy> = {};

  if (!mergedStrategy.base_symbol) {
    throw new Error('Strategy requires a base symbol');
  }

  if (!isMono && !mergedStrategy.quote_symbol) {
    throw new Error('Synthetic strategy requires a quote symbol');
  }

  if (!isMono && mergedStrategy.base_symbol === mergedStrategy.quote_symbol) {
    throw new Error('Base and quote symbols must be different');
  }

  const signalLength = Math.max(2, Math.floor(mergedStrategy.price_channel_length));
  const lookback = mergedStrategy.strategy_type === 'stat_arb_zscore'
    ? Math.max(signalLength + 90, 220)
    : Math.max(signalLength + 30, 120);

  const candles = await loadStrategyCandles(apiKeyName, mergedStrategy, lookback);

  const candleContext = resolveExecutionCandleContext(
    candles,
    mergedStrategy.interval,
    closedBarOnly
  );

  const { signal, currentRatio, donchianHigh, donchianLow, donchianCenter, zScore } = computeSignal(
    mergedStrategy.strategy_type || 'DD_BattleToads',
    candleContext.candlesForSignal,
    signalLength,
    mergedStrategy.detection_source,
    mergedStrategy.zscore_entry,
    mergedStrategy.long_enabled,
    mergedStrategy.short_enabled
  );

  const isStatArb = mergedStrategy.strategy_type === 'stat_arb_zscore';
  const zscoreExit = normalizeZscoreExit(mergedStrategy.zscore_exit, DEFAULT_STRATEGY.zscore_exit, mergedStrategy.zscore_entry);
  const zscoreStop = normalizeZscoreStop(mergedStrategy.zscore_stop, DEFAULT_STRATEGY.zscore_stop, mergedStrategy.zscore_entry);

  const takeProfitPercent = Math.max(0, mergedStrategy.take_profit_percent);
  let state: 'flat' | 'long' | 'short' = mergedStrategy.state || 'flat';
  let entryRatio: number | null = mergedStrategy.entry_ratio ?? null;
  type StrategyCloseAction =
    | 'take_profit_long'
    | 'take_profit_short'
    | 'stop_loss_long'
    | 'stop_loss_short'
    | 'mean_revert_exit_long'
    | 'mean_revert_exit_short'
    | 'zscore_stop_long'
    | 'zscore_stop_short';
  let closedAction: StrategyCloseAction | null = null;
  let closedResult: string | null = null;
  const evaluatedBarTimeMs = candleContext.evaluatedBarTimeMs;
  const evaluatedBarIso = new Date(evaluatedBarTimeMs).toISOString();
  const processedBarCacheKey = `${apiKeyName}:${strategyId}`;

  const markProcessedBar = (): void => {
    if (!dedupeClosedBar) {
      return;
    }

    processedClosedBarByStrategy.set(processedBarCacheKey, evaluatedBarTimeMs);
  };

  const returnWithProcessedBar = <T>(payload: T): T => {
    markProcessedBar();
    return payload;
  };

  const persistTpAnchorRatio = async (nextAnchor: number | null): Promise<void> => {
    const currentAnchorRaw = mergedStrategy.tp_anchor_ratio;
    const currentAnchor = Number(currentAnchorRaw);

    if (nextAnchor === null) {
      if (currentAnchorRaw === null || currentAnchorRaw === undefined) {
        return;
      }

      await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        tp_anchor_ratio: null,
      });
      mergedStrategy.tp_anchor_ratio = null;
      return;
    }

    const normalizedAnchor = Number(nextAnchor);
    if (!Number.isFinite(normalizedAnchor) || normalizedAnchor <= 0) {
      return;
    }

    if (Number.isFinite(currentAnchor) && Math.abs(currentAnchor - normalizedAnchor) <= TRAILING_RATIO_EPSILON) {
      return;
    }

    await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      tp_anchor_ratio: normalizedAnchor,
    });
    mergedStrategy.tp_anchor_ratio = normalizedAnchor;
  };

  const persistFlatAfterExit = async (
    action: StrategyCloseAction,
    signalSnapshot: StrategySignal
  ): Promise<void> => {
    await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: `${action}@${currentRatio}`,
      last_signal: signalSnapshot,
      last_error: null,
    });

    state = 'flat';
    entryRatio = null;
    mergedStrategy.state = 'flat';
    mergedStrategy.entry_ratio = null;
    mergedStrategy.tp_anchor_ratio = null;
  };

  const livePositions = await getPositions(apiKeyName);
  const liveBase = livePositions.find((position: any) => {
    return String(position?.symbol || '').toUpperCase() === mergedStrategy.base_symbol.toUpperCase()
      && Number.parseFloat(String(position?.size || '0')) > 0;
  }) || null;
  const liveQuote = !isMono
    ? livePositions.find((position: any) => {
      return String(position?.symbol || '').toUpperCase() === mergedStrategy.quote_symbol.toUpperCase()
        && Number.parseFloat(String(position?.size || '0')) > 0;
    }) || null
    : null;

  const livePairState = isMono
    ? inferMonoStateFromPosition(liveBase)
    : inferSyntheticStateFromPair(liveBase, liveQuote);

  if (livePairState === 'mixed') {
    await closeStrategyExposure(apiKeyName, mergedStrategy);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: 'desync_closed_mixed',
      last_error: null,
    });

    logger.warn(`Detected mixed pair state for strategy ${strategyId}; positions were closed`);
    return returnWithProcessedBar({
      result: 'Mixed pair positions detected and closed',
      action: 'desync_closed_mixed',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state !== 'flat' && livePairState !== 'flat' && state !== livePairState) {
    await closeStrategyExposure(apiKeyName, mergedStrategy);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: 'desync_closed_state_mismatch',
      last_error: null,
    });

    logger.warn(`Detected wrong-side live state for strategy ${strategyId}; positions were closed`);
    return returnWithProcessedBar({
      result: 'Live pair state mismatched strategy state and was closed',
      action: 'desync_closed_state_mismatch',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state === 'flat' && livePairState !== 'flat') {
    if (signal !== 'none' && signal !== livePairState) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_action: 'desync_closed_against_signal',
        last_error: null,
      });

      logger.warn(`Closed manual/out-of-sync positions against current signal for strategy ${strategyId}`);
      return returnWithProcessedBar({
        result: 'Out-of-sync positions against current signal were closed',
        action: 'desync_closed_against_signal',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const synced = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: livePairState,
      entry_ratio: currentRatio,
      tp_anchor_ratio: currentRatio,
      last_action: `state_resynced_${livePairState}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: 'Strategy state resynced from live pair positions',
      action: `state_resynced_${livePairState}`,
      strategy: synced,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (dedupeClosedBar) {
    const lastProcessedBarTimeMs = processedClosedBarByStrategy.get(processedBarCacheKey);
    if (lastProcessedBarTimeMs === evaluatedBarTimeMs) {
      return {
        result: `Bar ${evaluatedBarIso} already processed`,
        action: 'bar_already_processed',
        executionSource,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      };
    }
  }

  if (isStatArb) {
    const hasZScore = Number.isFinite(zScore);

    if (!closedAction && state === 'long' && hasZScore && Number(zScore) <= -zscoreStop) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      await persistFlatAfterExit('zscore_stop_long', 'long');
      closedAction = 'zscore_stop_long';
      closedResult = `Z-score stop hit for long ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'short' && hasZScore && Number(zScore) >= zscoreStop) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      await persistFlatAfterExit('zscore_stop_short', 'short');
      closedAction = 'zscore_stop_short';
      closedResult = `Z-score stop hit for short ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'long' && hasZScore && Number(zScore) >= -zscoreExit) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      await persistFlatAfterExit('mean_revert_exit_long', 'long');
      closedAction = 'mean_revert_exit_long';
      closedResult = `Mean-reversion exit for long ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'short' && hasZScore && Number(zScore) <= zscoreExit) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      await persistFlatAfterExit('mean_revert_exit_short', 'short');
      closedAction = 'mean_revert_exit_short';
      closedResult = `Mean-reversion exit for short ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }
  } else {
    if (!closedAction && state === 'long' && takeProfitPercent > 0) {
      const anchorFromStorage = Number(mergedStrategy.tp_anchor_ratio);
      let trailingAnchor = Number.isFinite(anchorFromStorage) && anchorFromStorage > 0
        ? anchorFromStorage
        : (entryRatio && entryRatio > 0 ? entryRatio : currentRatio);

      const nextAnchor = Math.max(trailingAnchor, currentRatio);
      if (!Number.isFinite(anchorFromStorage) || Math.abs(nextAnchor - anchorFromStorage) > TRAILING_RATIO_EPSILON) {
        await persistTpAnchorRatio(nextAnchor);
      }

      trailingAnchor = Number.isFinite(Number(mergedStrategy.tp_anchor_ratio))
        ? Number(mergedStrategy.tp_anchor_ratio)
        : nextAnchor;

      const trailingStop = trailingAnchor * (1 - takeProfitPercent / 100);
      if (Number.isFinite(trailingStop) && currentRatio <= trailingStop) {
        await closeStrategyExposure(apiKeyName, mergedStrategy);

        await persistFlatAfterExit('take_profit_long', 'long');
        closedAction = 'take_profit_long';
        closedResult = `Take-profit hit for long ${positionLabel}`;

        logger.info(`DD_BattleToads trailing TP long triggered for strategy ${strategyId} (${apiKeyName})`);
      }
    }

    if (!closedAction && state === 'short' && takeProfitPercent > 0) {
      const anchorFromStorage = Number(mergedStrategy.tp_anchor_ratio);
      let trailingAnchor = Number.isFinite(anchorFromStorage) && anchorFromStorage > 0
        ? anchorFromStorage
        : (entryRatio && entryRatio > 0 ? entryRatio : currentRatio);

      const nextAnchor = Math.min(trailingAnchor, currentRatio);
      if (!Number.isFinite(anchorFromStorage) || Math.abs(nextAnchor - anchorFromStorage) > TRAILING_RATIO_EPSILON) {
        await persistTpAnchorRatio(nextAnchor);
      }

      trailingAnchor = Number.isFinite(Number(mergedStrategy.tp_anchor_ratio))
        ? Number(mergedStrategy.tp_anchor_ratio)
        : nextAnchor;

      const trailingStop = trailingAnchor * (1 + takeProfitPercent / 100);
      if (Number.isFinite(trailingStop) && currentRatio >= trailingStop) {
        await closeStrategyExposure(apiKeyName, mergedStrategy);

        await persistFlatAfterExit('take_profit_short', 'short');
        closedAction = 'take_profit_short';
        closedResult = `Take-profit hit for short ${positionLabel}`;

        logger.info(`DD_BattleToads trailing TP short triggered for strategy ${strategyId} (${apiKeyName})`);
      }
    }

    if (!closedAction && state === 'long' && entryRatio && currentRatio <= donchianCenter) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      await persistFlatAfterExit('stop_loss_long', 'long');
      closedAction = 'stop_loss_long';
      closedResult = `Stop-loss (center) hit for long ${positionLabel}`;

      logger.info(`DD_BattleToads SL long triggered for strategy ${strategyId} (${apiKeyName})`);
    }

    if (!closedAction && state === 'short' && entryRatio && currentRatio >= donchianCenter) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      await persistFlatAfterExit('stop_loss_short', 'short');
      closedAction = 'stop_loss_short';
      closedResult = `Stop-loss (center) hit for short ${positionLabel}`;

      logger.info(`DD_BattleToads SL short triggered for strategy ${strategyId} (${apiKeyName})`);
    }
  }

  if (signal === 'none') {
    const noSignalResult = isStatArb ? 'No z-score signal' : 'No Donchian signal';
    const noSignalAction = closedAction
      ? `${closedAction}_then_no_signal@${currentRatio}`
      : `no_signal@${currentRatio}`;

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      ...(closedAction
        ? {
            state: 'flat' as const,
            entry_ratio: null,
            tp_anchor_ratio: null,
          }
        : {}),
      last_signal: 'none',
      last_action: noSignalAction,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: closedResult || noSignalResult,
      action: closedAction ? `${closedAction}_no_signal` : 'no_signal',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state === signal) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: signal,
      last_action: closedAction
        ? `${closedAction}_then_hold_${signal}@${currentRatio}`
        : `hold_${signal}@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: `Signal ${signal} already in position`,
      action: `hold_${signal}`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  const balances = await getBalances(apiKeyName);
  const availableBalance = extractUsdtBalance(balances);

  if (availableBalance <= 0) {
    if (closedAction) {
      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: `${closedAction}_open_skipped_no_balance@${currentRatio}`,
        last_error: null,
      });

      return returnWithProcessedBar({
        result: closedResult || 'Position closed; reopen skipped because balance is unavailable',
        action: `${closedAction}_open_skipped_no_balance`,
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    throw new Error('No available balance for strategy execution');
  }

  const totalNotional = computeSignalTotalNotional(mergedStrategy, availableBalance, signal);

  if (!Number.isFinite(totalNotional) || totalNotional <= 0) {
    if (closedAction) {
      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: `${closedAction}_open_skipped_invalid_notional@${currentRatio}`,
        last_error: null,
      });

      return returnWithProcessedBar({
        result: closedResult || 'Position closed; reopen skipped because notional is invalid',
        action: `${closedAction}_open_skipped_invalid_notional`,
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    throw new Error('Calculated trade notional is invalid');
  }

  const basePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.base_symbol);
  let quotePrice: number | null = null;
  let qtyPlan: BalancedQtyPlan | null = null;
  let singleQtyPlan: SingleQtyPlan | null = null;
  let baseQty = '';
  let quoteQty: string | null = null;

  if (isMono) {
    singleQtyPlan = await buildSingleQtyPlan(
      apiKeyName,
      mergedStrategy.base_symbol,
      basePrice,
      totalNotional
    );
    baseQty = singleQtyPlan.qty;
  } else {
    quotePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.quote_symbol);

    const baseWeight = Math.abs(mergedStrategy.base_coef);
    const quoteWeight = Math.abs(mergedStrategy.quote_coef);

    qtyPlan = await buildBalancedQtyPlan(
      apiKeyName,
      mergedStrategy.base_symbol,
      mergedStrategy.quote_symbol,
      basePrice,
      quotePrice,
      totalNotional,
      baseWeight,
      quoteWeight
    );

    baseQty = qtyPlan.baseQty;
    quoteQty = qtyPlan.quoteQty;
  }

  const latestBeforeOpen = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  if (!latestBeforeOpen.is_active) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      ...(closedAction
        ? {
            state: 'flat' as const,
            entry_ratio: null,
            tp_anchor_ratio: null,
          }
        : {}),
      last_signal: signal,
      last_action: closedAction
        ? `paused_after_${closedAction}@${currentRatio}`
        : `paused_before_open@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: closedResult || 'Strategy paused before opening a new position',
      action: closedAction ? `paused_after_${closedAction}` : 'paused_before_open',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  try {
    for (const symbol of getStrategySymbols(mergedStrategy)) {
      await applySymbolRiskSettings(apiKeyName, symbol, mergedStrategy.margin_type, mergedStrategy.leverage);
    }
  } catch (error) {
    logger.warn(`Could not apply risk settings for strategy ${strategyId}: ${formatActionError(error)}`);
  }

  await closeStrategyExposure(apiKeyName, mergedStrategy);

  const baseSide: 'Buy' | 'Sell' = signal === 'long' ? 'Buy' : 'Sell';
  const quoteSide: 'Buy' | 'Sell' | null = isMono ? null : (signal === 'long' ? 'Sell' : 'Buy');

  const baseOrder = await placeOrder(apiKeyName, mergedStrategy.base_symbol, baseSide, baseQty);

  if (!isMono && quoteSide && quoteQty) {
    try {
      await placeOrder(apiKeyName, mergedStrategy.quote_symbol, quoteSide, quoteQty);
    } catch (error) {
      try {
        await closePosition(apiKeyName, mergedStrategy.base_symbol, baseQty, baseSide);
      } catch (rollbackError) {
        logger.error(`Rollback failed for ${mergedStrategy.base_symbol}: ${formatActionError(rollbackError)}`);
      }
      throw error;
    }

    const livePairAfterOpen = await loadPairPositionsForValidation(
      apiKeyName,
      mergedStrategy.base_symbol,
      mergedStrategy.quote_symbol,
      3,
      350
    );

    if (!livePairAfterOpen.basePosition || !livePairAfterOpen.quotePosition || !qtyPlan) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_missing_leg',
        last_error: 'Opened pair validation failed: one or both legs are missing after entry',
      });

      logger.warn(
        `Post-open validation failed (missing leg): strategy=${strategyId}, apiKey=${apiKeyName}, `
        + `base=${mergedStrategy.base_symbol}, quote=${mergedStrategy.quote_symbol}`
      );

      return returnWithProcessedBar({
        result: 'Pair opened with missing leg and was closed',
        action: 'desync_closed_post_open_missing_leg',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const liveBalanceCheck = validateLiveLegBalance(
      livePairAfterOpen.basePosition,
      livePairAfterOpen.quotePosition,
      Math.abs(mergedStrategy.base_coef),
      Math.abs(mergedStrategy.quote_coef),
      MAX_POST_OPEN_SHARE_ERROR
    );

    if (!liveBalanceCheck.ok) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const liveSnapshot = liveBalanceCheck.snapshot;
      const mismatchReason =
        `Opened pair weight mismatch: base=${liveSnapshot.baseNotional.toFixed(4)} `
        + `quote=${liveSnapshot.quoteNotional.toFixed(4)} `
        + `expectedShare=${(liveSnapshot.expectedBaseShare * 100).toFixed(2)}% `
        + `actualShare=${(liveSnapshot.actualBaseShare * 100).toFixed(2)}% `
        + `shareError=${(liveSnapshot.shareError * 100).toFixed(2)}%`;

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_weight_mismatch',
        last_error: mismatchReason,
      });

      logger.warn(
        `Post-open validation failed (weight mismatch): strategy=${strategyId}, apiKey=${apiKeyName}, ${mismatchReason}`
      );

      return returnWithProcessedBar({
        result: 'Pair opened with weight mismatch and was closed',
        action: 'desync_closed_post_open_weight_mismatch',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }
  } else {
    const livePositionAfterOpen = await loadSinglePositionForValidation(
      apiKeyName,
      mergedStrategy.base_symbol,
      3,
      350
    );

    if (!livePositionAfterOpen) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_missing_leg',
        last_error: 'Opened mono validation failed: live position is missing after entry',
      });

      logger.warn(
        `Post-open validation failed (mono missing position): strategy=${strategyId}, apiKey=${apiKeyName}, `
        + `base=${mergedStrategy.base_symbol}`
      );

      return returnWithProcessedBar({
        result: 'Position opened but was not confirmed and was closed',
        action: 'desync_closed_post_open_missing_leg',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }
  }

  const updated = await updateStrategy(apiKeyName, strategyId, {
    ...executionBindingPatch,
    state: signal,
    entry_ratio: currentRatio,
    tp_anchor_ratio: currentRatio,
    last_signal: signal,
    last_action: closedAction
      ? `reopened_${signal}_after_${closedAction}@${currentRatio}`
      : `opened_${signal}@${currentRatio}`,
    last_error: null,
  });

  if (singleQtyPlan) {
    logger.info(
      `Strategy ${strategyId} mono sizing: target=${singleQtyPlan.targetNotional.toFixed(2)} USDT, `
      + `actual=${singleQtyPlan.notional.toFixed(2)}, totalDeviation=${(singleQtyPlan.totalDeviation * 100).toFixed(2)}%`
    );
  }

  if (qtyPlan) {
    logger.info(
      `Strategy ${strategyId} leg balancing: target=${totalNotional.toFixed(2)} USDT, `
      + `base ${qtyPlan.baseTargetNotional.toFixed(2)} -> ${qtyPlan.baseNotional.toFixed(2)}, `
      + `quote ${qtyPlan.quoteTargetNotional.toFixed(2)} -> ${qtyPlan.quoteNotional.toFixed(2)}, `
      + `shareError=${(qtyPlan.shareError * 100).toFixed(2)}%, totalDeviation=${(qtyPlan.totalDeviation * 100).toFixed(2)}%`
    );
  }

  logger.info(`Executed ${mergedStrategy.strategy_type} strategy ${strategyId} for ${apiKeyName}: ${signal} (${marketMode})`);
  return returnWithProcessedBar({
    result: 'Strategy executed',
    action: closedAction ? `reopened_${signal}_after_${closedAction}` : `opened_${signal}`,
    signal,
    baseOrder,
    baseQty,
    quoteQty,
    currentRatio,
    donchianHigh,
    donchianLow,
    donchianCenter,
    strategy: updated,
  });
};

export const pauseStrategy = async (apiKeyName: string, strategyId: number) => {
  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    last_action: 'paused',
  });
  logger.info(`Paused strategy ${strategyId}`);
  return updated;
};

export const stopStrategy = async (apiKeyName: string, strategyId: number) => {
  const row = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  await closeStrategyExposure(apiKeyName, row);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    state: 'flat',
    entry_ratio: null,
    tp_anchor_ratio: null,
    last_action: 'stopped',
    last_error: null,
  });

  logger.info(`Stopped strategy ${strategyId}`);
  return updated;
};

export const closePositionPercent = async (
  apiKeyName: string,
  strategyId: number,
  symbol: string,
  percent: number,
  side?: 'Buy' | 'Sell'
) => {
  const positions = await getPositions(apiKeyName, symbol);
  const target = positions.find((position: any) => {
    const sameSymbol = String(position?.symbol || '').toUpperCase() === symbol.toUpperCase();
    const hasSize = Number.parseFloat(String(position?.size || '0')) > 0;
    const sideMatches = side ? String(position?.side || '') === side : true;
    return sameSymbol && hasSize && sideMatches;
  });

  if (!target) {
    throw new Error(`Position not found for ${symbol}`);
  }

  const safePercent = Math.max(0.1, Math.min(100, Number.isFinite(percent) ? percent : 100));
  const qtyToClose = (Number.parseFloat(String(target.size || '0')) * safePercent) / 100;
  const qty = qtyToClose.toFixed(8).replace(/\.?0+$/, '');

  await closePosition(apiKeyName, symbol, qty, target.side as 'Buy' | 'Sell');
  logger.info(`Closed ${safePercent}% of position for ${symbol} (strategy ${strategyId})`);
};

export const placeManualOrder = async (
  apiKeyName: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  price?: string
) => {
  return await placeOrder(apiKeyName, symbol, side, qty, price);
};

export const cancelStrategyOrders = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await cancelStrategyWorkingOrders(apiKeyName, strategy);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    last_action: 'orders_cancelled',
    last_error: null,
  });

  logger.info(`Cancelled orders for strategy ${strategyId}`);
  return updated;
};

export const closeStrategyPositions = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await closeStrategyExposure(apiKeyName, strategy);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    state: 'flat',
    entry_ratio: null,
    tp_anchor_ratio: null,
    last_action: 'positions_closed',
    last_error: null,
  });

  logger.info(`Closed strategy exposure for strategy ${strategyId}`);
  return updated;
};

export const setAllStrategiesActive = async (apiKeyName: string, isActive: boolean) => {
  const { db } = await import('../utils/database');
  const apiKeyId = await getApiKeyId(apiKeyName);
  const result: any = await db.run(
    `UPDATE strategies
     SET is_active = ?,
         last_action = ?,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE api_key_id = ?`,
    [isActive ? 1 : 0, isActive ? 'resumed_all' : 'paused_all', apiKeyId]
  );

  const updated = Number(result?.changes || 0);

  return {
    updated,
  };
};

type CopyStrategiesOptions = {
  replaceTarget?: boolean;
  preserveActive?: boolean;
  syncSymbols?: boolean;
};

type CopyChartSuggestion = {
  base: string;
  quote: string;
  interval: string;
  baseCoef: number;
  quoteCoef: number;
};

const buildTargetSymbolMap = (symbols: string[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const symbol of symbols) {
    const normalized = normalizeSymbolKey(symbol);
    if (!normalized) {
      continue;
    }
    if (!map.has(normalized)) {
      map.set(normalized, String(symbol).toUpperCase());
    }
  }
  return map;
};

const mapStrategySymbolForTarget = (symbol: string, symbolMap: Map<string, string>): string | null => {
  const normalized = normalizeSymbolKey(symbol);
  if (!normalized) {
    return null;
  }
  return symbolMap.get(normalized) || null;
};

export const copyStrategyBlock = async (
  sourceApiKeyName: string,
  targetApiKeyName: string,
  options?: CopyStrategiesOptions
) => {
  if (sourceApiKeyName === targetApiKeyName) {
    throw new Error('Source and target API key must be different');
  }

  const sourceStrategies = await getStrategies(sourceApiKeyName);
  if (sourceStrategies.length === 0) {
    return {
      copied: 0,
      deleted: 0,
    };
  }

  const replaceTarget = options?.replaceTarget !== false;
  const preserveActive = options?.preserveActive === true;
  const syncSymbols = options?.syncSymbols !== false;

  const { db } = await import('../utils/database');
  const targetApiKeyId = await getApiKeyId(targetApiKeyName);

  let targetSymbolMap = new Map<string, string>();
  let symbolValidationEnabled = false;

  if (syncSymbols) {
    try {
      const targetSymbols = await getAllSymbols(targetApiKeyName);
      targetSymbolMap = buildTargetSymbolMap(Array.isArray(targetSymbols) ? targetSymbols : []);
      symbolValidationEnabled = targetSymbolMap.size > 0;
    } catch (error) {
      logger.warn(`Symbol sync skipped for copy ${sourceApiKeyName} -> ${targetApiKeyName}: ${formatActionError(error)}`);
    }
  }

  let deleted = 0;
  let copied = 0;
  let adjustedSymbols = 0;
  let disabledStrategies = 0;
  const issues: string[] = [];
  let chartSuggestion: CopyChartSuggestion | null = null;
  let transactionStarted = false;

  try {
    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    transactionStarted = true;

    if (replaceTarget) {
      const removeResult: any = await db.run('DELETE FROM strategies WHERE api_key_id = ?', [targetApiKeyId]);
      deleted = Number(removeResult?.changes || 0);
    }

    for (const source of sourceStrategies) {
      const sourceBase = normalizeSymbol(source.base_symbol);
      const sourceQuote = normalizeSymbol(source.quote_symbol);
      const sourceMarketMode = normalizeMarketMode(source.market_mode);

      const mappedBase = symbolValidationEnabled
        ? mapStrategySymbolForTarget(sourceBase, targetSymbolMap)
        : sourceBase;
      const mappedQuote = symbolValidationEnabled
        ? mapStrategySymbolForTarget(sourceQuote, targetSymbolMap)
        : sourceQuote;

      const pairValid = sourceMarketMode === 'mono'
        ? (symbolValidationEnabled ? Boolean(mappedBase) : Boolean(sourceBase))
        : (symbolValidationEnabled
          ? Boolean(mappedBase && mappedQuote && mappedBase !== mappedQuote)
          : Boolean(sourceBase && sourceQuote && sourceBase !== sourceQuote));

      const targetBase = mappedBase || sourceBase;
      const targetQuote = sourceMarketMode === 'mono' ? '' : (mappedQuote || sourceQuote);

      if (targetBase !== sourceBase || targetQuote !== sourceQuote) {
        adjustedSymbols += 1;
      }

      const created = await createStrategy(targetApiKeyName, {
        name: source.name,
        strategy_type: source.strategy_type || 'DD_BattleToads',
        market_mode: source.market_mode,
        is_active: pairValid ? (preserveActive ? source.is_active : false) : false,
        display_on_chart: source.display_on_chart,
        show_settings: source.show_settings,
        show_chart: source.show_chart,
        show_indicators: source.show_indicators,
        show_positions_on_chart: source.show_positions_on_chart,
        show_trades_on_chart: source.show_trades_on_chart,
        show_values_each_bar: source.show_values_each_bar,
        auto_update: source.auto_update,
        take_profit_percent: source.take_profit_percent,
        price_channel_length: source.price_channel_length,
        detection_source: source.detection_source,
        zscore_entry: source.zscore_entry,
        zscore_exit: source.zscore_exit,
        zscore_stop: source.zscore_stop,
        base_symbol: targetBase,
        quote_symbol: targetQuote,
        interval: source.interval,
        base_coef: source.base_coef,
        quote_coef: source.quote_coef,
        long_enabled: source.long_enabled,
        short_enabled: source.short_enabled,
        lot_long_percent: source.lot_long_percent,
        lot_short_percent: source.lot_short_percent,
        max_deposit: source.max_deposit,
        margin_type: source.margin_type,
        leverage: source.leverage,
        fixed_lot: source.fixed_lot,
        reinvest_percent: source.reinvest_percent,
      });

      if (!pairValid) {
        disabledStrategies += 1;
        const issue = `Strategy ${source.name}: pair ${sourceBase}/${sourceQuote} is not available on ${targetApiKeyName}`;
        issues.push(issue);

        if (created.id) {
          await updateStrategy(targetApiKeyName, Number(created.id), {
            is_active: false,
            state: 'flat',
            entry_ratio: null,
            tp_anchor_ratio: null,
            last_action: 'copied_symbol_mismatch',
            last_error: issue,
          });
        }
      } else if (!chartSuggestion) {
        chartSuggestion = {
          base: targetBase,
          quote: targetQuote,
          interval: source.interval,
          baseCoef: source.base_coef,
          quoteCoef: sourceMarketMode === 'mono' ? 0 : source.quote_coef,
        };
      }

      copied += 1;
    }

    await db.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await db.exec('ROLLBACK');
    }
    throw error;
  }

  logger.info(
    `Copied strategy block from ${sourceApiKeyName} to ${targetApiKeyName}, copied=${copied}, deleted=${deleted}, adjusted=${adjustedSymbols}, disabled=${disabledStrategies}`
  );

  return {
    copied,
    deleted,
    adjustedSymbols,
    disabledStrategies,
    symbolValidationEnabled,
    issues,
    chartSuggestion,
  };
};

export const runAutoStrategiesCycle = async () => {
  const { db } = await import('../utils/database');
  const { ensureExchangeClientInitialized } = await import('./exchange');
  const rows = await db.all(
    `SELECT a.name AS api_key_name, s.id AS strategy_id
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE s.is_active = 1 AND s.auto_update = 1
     ORDER BY s.id ASC`
  );

  const jobs = Array.isArray(rows) ? rows : [];
  let processed = 0;
  let failed = 0;

  for (const row of jobs) {
    const apiKeyName = String(row?.api_key_name || '');
    const strategyId = Number(row?.strategy_id || 0);

    if (!apiKeyName || !Number.isFinite(strategyId) || strategyId <= 0) {
      continue;
    }

    try {
      await ensureExchangeClientInitialized(apiKeyName);
      await executeStrategy(apiKeyName, strategyId, {
        source: 'auto',
        closedBarOnly: true,
        dedupeClosedBar: true,
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`Auto-cycle strategy ${strategyId} (${apiKeyName}) failed: ${formatActionError(error)}`);
    }
  }

  return {
    total: jobs.length,
    processed,
    failed,
  };
};

import { db } from '../utils/database';
import { getMarketData } from './exchange';
import logger from '../utils/logger';
import type { MacroExitOverlay, MacroExitRule, MacroExitVoteConfig } from '../backtest/engine';

/** Legacy live shield (BTC+ETH RSI≥70 long exit). */
export const LEGACY_SHIELD_OVERLAY: MacroExitOverlay = {
  anchorInterval: '4h',
  rules: [
    {
      source: 'anchor',
      anchorSymbol: 'ETHUSDT',
      rsiPeriod: 14,
      longExitRsiAbove: 70,
      label: 'eth_tp',
    },
    {
      source: 'anchor',
      anchorSymbol: 'BTCUSDT',
      rsiPeriod: 14,
      longExitRsiAbove: 70,
      label: 'btc_tp',
    },
  ],
};

/** Research winner (Jun 2026): local pair RSI partial ~35%. */
export const LOCAL_SELF_RSI_PARTIAL_OVERLAY: MacroExitOverlay = {
  anchorInterval: '1h',
  rules: [],
  localSelf: {
    source: 'self',
    rsiPeriod: 14,
    fractalWings: 2,
    mode: 'partial',
    closeFraction: 0.35,
    combineWith: 'or',
    longExitRsiAbove: 70,
    shortExitRsiBelow: 20,
    shortExitRsiAbove: 70,
    label: 'local_rsi1h',
  },
};

/** Candidate after hybrid research: local partial + global 3/3 BTC+ETH+SOL fractal OR rsi. */
export const HYBRID_MACRO_EXIT_OVERLAY: MacroExitOverlay = {
  anchorInterval: '4h',
  rules: [],
  localSelf: LOCAL_SELF_RSI_PARTIAL_OVERLAY.localSelf,
  globalVote: {
    minVotes: 3,
    anchors: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    rsiPeriod: 14,
    fractalWings: 2,
    mode: 'full',
    longExitRsiAbove: 70,
    longExitBearishFractal: true,
    shortExitRsiBelow: 20,
    shortExitRsiAbove: 70,
    shortExitBullishFractal: true,
    label: 'global_3of3',
  },
};

export const DEFAULT_RUNTIME_MACRO_OVERLAY = LOCAL_SELF_RSI_PARTIAL_OVERLAY;

type ParsedCandle = { timeMs: number; open: number; high: number; low: number; close: number };

type CardShieldCacheEntry = {
  macroShield: boolean;
  overlay: MacroExitOverlay | null;
  expiresAtMs: number;
};

const cardShieldCache = new Map<string, CardShieldCacheEntry>();
const partialFiredByStrategy = new Map<number, Set<string>>();
const CACHE_TTL_MS = 60_000;

const parseCandle = (raw: unknown): ParsedCandle | null => {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const timeMs = Number(row.time ?? row.timestamp ?? row.openTime ?? 0);
  const close = Number(row.close ?? 0);
  if (!Number.isFinite(timeMs) || !Number.isFinite(close) || close <= 0) return null;
  return {
    timeMs,
    open: Number(row.open ?? close),
    high: Number(row.high ?? close),
    low: Number(row.low ?? close),
    close,
  };
};

const computeRsiAtIndex = (closes: number[], endIndex: number, period: number): number | null => {
  if (endIndex < period || closes.length <= endIndex) return null;
  let gains = 0;
  let losses = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss <= 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
};

const isBearishFractalAt = (candles: ParsedCandle[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= candles.length) return false;
  const pivotHigh = candles[index].high;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (candles[index - offset].high >= pivotHigh) return false;
    if (candles[index + offset].high >= pivotHigh) return false;
  }
  return true;
};

const isBullishFractalAt = (candles: ParsedCandle[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= candles.length) return false;
  const pivotLow = candles[index].low;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (candles[index - offset].low <= pivotLow) return false;
    if (candles[index + offset].low <= pivotLow) return false;
  }
  return true;
};

const hasConfirmedBearishFractal = (candles: ParsedCandle[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBearishFractalAt(candles, pivotIndex, wings);
};

const hasConfirmedBullishFractal = (candles: ParsedCandle[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBullishFractalAt(candles, pivotIndex, wings);
};

const shouldTriggerRsi = (rule: MacroExitRule, state: 'long' | 'short', rsi: number): boolean => {
  if (state === 'long') {
    if (rule.longExitRsiAbove != null && rsi >= rule.longExitRsiAbove) return true;
    if (rule.longExitRsiBelow != null && rsi <= rule.longExitRsiBelow) return true;
  }
  if (state === 'short') {
    if (rule.shortExitRsiBelow != null && rsi <= rule.shortExitRsiBelow) return true;
    if (rule.shortExitRsiAbove != null && rsi >= rule.shortExitRsiAbove) return true;
  }
  return false;
};

const shouldTriggerFractal = (
  rule: MacroExitRule,
  state: 'long' | 'short',
  candles: ParsedCandle[],
  candleIndex: number,
): boolean => {
  const wings = Math.max(1, Math.floor(rule.fractalWings ?? 2));
  if (state === 'long' && rule.longExitBearishFractal) {
    return hasConfirmedBearishFractal(candles, candleIndex, wings);
  }
  if (state === 'short' && rule.shortExitBullishFractal) {
    return hasConfirmedBullishFractal(candles, candleIndex, wings);
  }
  return false;
};

const shouldTriggerRule = (
  rule: MacroExitRule,
  state: 'long' | 'short',
  candles: ParsedCandle[],
  candleIndex: number,
): boolean => {
  const period = Math.max(2, Math.floor(rule.rsiPeriod ?? 14));
  const hasRsi = rule.longExitRsiAbove != null || rule.longExitRsiBelow != null
    || rule.shortExitRsiBelow != null || rule.shortExitRsiAbove != null;
  const hasFractal = rule.longExitBearishFractal === true || rule.shortExitBullishFractal === true;
  const closes = candles.map((c) => c.close);
  const rsi = hasRsi ? computeRsiAtIndex(closes, candleIndex, period) : null;
  const rsiHit = hasRsi && rsi != null ? shouldTriggerRsi(rule, state, rsi) : false;
  const fractalHit = hasFractal ? shouldTriggerFractal(rule, state, candles, candleIndex) : false;
  if (hasRsi && hasFractal) {
    return rule.combineWith === 'or' ? (rsiHit || fractalHit) : (rsiHit && fractalHit);
  }
  if (hasFractal) return fractalHit;
  return rsiHit;
};

const loadCandles = async (
  apiKeyName: string,
  symbol: string,
  interval: string,
  limit: number,
): Promise<ParsedCandle[]> => {
  const raw = await getMarketData(apiKeyName, symbol, interval, limit, {}).catch(() => []);
  return (Array.isArray(raw) ? raw : [])
    .map((item) => parseCandle(item))
    .filter((item): item is ParsedCandle => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);
};

const evaluateVoteAnchor = (
  vote: MacroExitVoteConfig,
  state: 'long' | 'short',
  candles: ParsedCandle[],
): boolean => {
  const pseudoRule: MacroExitRule = {
    source: 'anchor',
    rsiPeriod: vote.rsiPeriod ?? 14,
    fractalWings: vote.fractalWings ?? 2,
    longExitRsiAbove: vote.longExitRsiAbove,
    longExitBearishFractal: vote.longExitBearishFractal,
    shortExitRsiBelow: vote.shortExitRsiBelow,
    shortExitRsiAbove: vote.shortExitRsiAbove,
    shortExitBullishFractal: vote.shortExitBullishFractal,
    combineWith: 'or',
  };
  const idx = candles.length - 1;
  return shouldTriggerRule(pseudoRule, state, candles, idx);
};

const parseOverlayFromMeta = (meta: Record<string, unknown>): MacroExitOverlay | null => {
  if (meta.macroExitOverlay && typeof meta.macroExitOverlay === 'object') {
    return meta.macroExitOverlay as MacroExitOverlay;
  }
  if (meta.macroShield === true) {
    return LEGACY_SHIELD_OVERLAY;
  }
  return null;
};

export const getMacroExitOverlayForApiKey = async (apiKeyName: string): Promise<MacroExitOverlay | null> => {
  const cached = cardShieldCache.get(apiKeyName);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.overlay;
  }
  let overlay: MacroExitOverlay | null = null;
  let macroShield = false;
  try {
    const row = await db.get<{ published_system_name?: string }>(
      `SELECT published_system_name FROM algofund_profiles
       WHERE TRIM(COALESCE(execution_api_key_name, assigned_api_key_name, '')) = ?
       LIMIT 1`,
      [apiKeyName],
    );
    const systemName = String(row?.published_system_name || '').trim();
    if (systemName) {
      const card = await db.get<{ metadata_json?: string }>(
        `SELECT metadata_json FROM master_cards
         WHERE code = ? AND is_active = 1
         LIMIT 1`,
        [`CARD::${systemName.toUpperCase()}`],
      );
      if (card?.metadata_json) {
        const meta = JSON.parse(String(card.metadata_json)) as Record<string, unknown>;
        overlay = parseOverlayFromMeta(meta);
        macroShield = overlay != null || meta.macroShield === true;
      }
    }
  } catch (error) {
    logger.warn(`[macroExitShield] card lookup failed for ${apiKeyName}: ${(error as Error).message}`);
  }
  cardShieldCache.set(apiKeyName, { macroShield, overlay, expiresAtMs: Date.now() + CACHE_TTL_MS });
  return overlay;
};

export const isMacroShieldEnabledForApiKey = async (apiKeyName: string): Promise<boolean> => {
  const overlay = await getMacroExitOverlayForApiKey(apiKeyName);
  return overlay != null;
};

export type MacroShieldSignal = {
  action: 'full' | 'partial';
  reason: string;
  closePercent: number;
  detail: string;
};

const markPartialFired = (strategyId: number, ruleKey: string): boolean => {
  const set = partialFiredByStrategy.get(strategyId) || new Set<string>();
  if (set.has(ruleKey)) return false;
  set.add(ruleKey);
  partialFiredByStrategy.set(strategyId, set);
  return true;
};

/** Allow ladder partials: clear fired flag when RSI cooled off so next overbought can trim again. */
const clearPartialFiredIfCooled = (
  strategyId: number,
  ruleKey: string,
  state: 'long' | 'short',
  candles: ParsedCandle[],
  rule: MacroExitRule,
): void => {
  const set = partialFiredByStrategy.get(strategyId);
  if (!set?.has(ruleKey)) return;
  const idx = candles.length - 1;
  if (idx < 20) return;
  if (!shouldTriggerRule({ ...rule, source: 'self' }, state, candles, idx)) {
    set.delete(ruleKey);
  }
};

export const clearMacroShieldPartialState = (strategyId: number): void => {
  partialFiredByStrategy.delete(strategyId);
};

/** @deprecated use evaluateMacroShieldExit */
export const evaluateMacroShieldLongExit = async (
  apiKeyName: string,
  overlay: MacroExitOverlay = LEGACY_SHIELD_OVERLAY,
): Promise<{ shouldExit: boolean; reason: string; rsi: number; symbol: string } | null> => {
  const signal = await evaluateMacroShieldExit(apiKeyName, 'long', '', overlay);
  if (!signal || signal.action !== 'full') return null;
  return { shouldExit: true, reason: signal.reason, rsi: 0, symbol: 'MACRO' };
};

export const evaluateMacroShieldExit = async (
  apiKeyName: string,
  state: 'long' | 'short',
  selfSymbol: string,
  overlay: MacroExitOverlay = DEFAULT_RUNTIME_MACRO_OVERLAY,
  strategyId?: number,
): Promise<MacroShieldSignal | null> => {
  if (state !== 'long' && state !== 'short') return null;
  const anchorInterval = String(overlay.anchorInterval || '4h').trim() || '4h';
  // localSelf RSI partial must use 1h (research); hybrid overlay anchorInterval is 4h for BTC/ETH rules.
  const selfInterval = overlay.localSelf
    ? (String(overlay.localSelf.label || '').includes('1h') ? '1h' : '1h')
    : anchorInterval;

  if (overlay.globalVote) {
    const vote = overlay.globalVote;
    let votes = 0;
    const voted: string[] = [];
    for (const sym of vote.anchors) {
      const candles = await loadCandles(apiKeyName, sym, anchorInterval, 120);
      if (candles.length < 20) continue;
      if (evaluateVoteAnchor(vote, state, candles)) {
        votes += 1;
        voted.push(sym.replace('USDT', ''));
      }
    }
    if (votes >= Math.max(1, vote.minVotes)) {
      return {
        action: vote.mode === 'partial' ? 'partial' : 'full',
        reason: `macro_vote_${votes}of${vote.anchors.length}_${voted.join('+')}`,
        closePercent: Math.round((vote.closeFraction ?? 0.5) * 100),
        detail: `global vote ${votes}/${vote.anchors.length}`,
      };
    }
  }

  if (overlay.localSelf && selfSymbol) {
    const rule = overlay.localSelf;
    const ruleKey = `local:${rule.label || 'self'}`;
    const candles = await loadCandles(apiKeyName, selfSymbol, selfInterval, 120);
    if (candles.length >= 20 && strategyId) {
      clearPartialFiredIfCooled(strategyId, ruleKey, state, candles, { ...rule, source: 'self' });
    }
    const alreadyFired = strategyId
      ? partialFiredByStrategy.get(strategyId)?.has(ruleKey)
      : false;
    if (!alreadyFired && candles.length >= 20) {
      const idx = candles.length - 1;
      if (shouldTriggerRule({ ...rule, source: 'self' }, state, candles, idx)) {
        if (strategyId) markPartialFired(strategyId, ruleKey);
        return {
          action: rule.mode === 'partial' ? 'partial' : 'full',
          reason: `macro_local_${rule.label || 'self'}`,
          closePercent: Math.round((rule.closeFraction ?? 0.35) * 100),
          detail: `${selfSymbol} local signal`,
        };
      }
    }
  }

  for (let ruleIdx = 0; ruleIdx < overlay.rules.length; ruleIdx += 1) {
    const rule = overlay.rules[ruleIdx];
    const symbol = rule.source === 'anchor' ? String(rule.anchorSymbol || '') : selfSymbol;
    if (!symbol) continue;
    const interval = rule.source === 'anchor' ? anchorInterval : selfInterval;
    const candles = await loadCandles(apiKeyName, symbol, interval, 80);
    if (candles.length < 20) continue;
    const idx = candles.length - 1;
    if (!shouldTriggerRule(rule, state, candles, idx)) continue;
    const label = rule.label || `${rule.source}_${symbol}`;
    if (rule.mode === 'partial') {
      const ruleKey = `${ruleIdx}:${label}`;
      if (strategyId && !markPartialFired(strategyId, ruleKey)) continue;
      return {
        action: 'partial',
        reason: `macro_partial_${label}`,
        closePercent: Math.round((rule.closeFraction ?? 0.5) * 100),
        detail: `${symbol} RSI/fractal partial`,
      };
    }
    return {
      action: 'full',
      reason: `macro_rsi_${label}`,
      closePercent: 100,
      detail: `${symbol} full exit`,
    };
  }

  return null;
};

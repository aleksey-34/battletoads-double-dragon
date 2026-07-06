import { Strategy } from '../../../config/settings';
import type { ComputedSignal } from '../types';
import { normalizeMarketMode } from '../normalize';

export type CachedSignalEntry = ComputedSignal & { evaluatedBarTimeMs: number };

let _cycleSignalCache: Map<string, CachedSignalEntry> | null = null;
let _cycleSignalCacheExpiry = 0;
const CYCLE_SIGNAL_CACHE_TTL_MS = 60_000;

export const getCycleSignalCache = (): Map<string, CachedSignalEntry> => {
  const now = Date.now();
  if (!_cycleSignalCache || now > _cycleSignalCacheExpiry) {
    _cycleSignalCache = new Map();
    _cycleSignalCacheExpiry = now + CYCLE_SIGNAL_CACHE_TTL_MS;
  }
  return _cycleSignalCache;
};

export const resetCycleSignalCache = (): void => {
  _cycleSignalCache = new Map();
  _cycleSignalCacheExpiry = Date.now() + CYCLE_SIGNAL_CACHE_TTL_MS;
};

export const makeSignalGroupKey = (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol' | 'base_coef' | 'quote_coef' | 'interval' | 'strategy_type' | 'price_channel_length' | 'detection_source' | 'zscore_entry' | 'long_enabled' | 'short_enabled'>
): string => {
  const mode = normalizeMarketMode(strategy.market_mode);
  const base = String(strategy.base_symbol || '').toUpperCase();
  const quote = mode === 'mono' ? '' : String(strategy.quote_symbol || '').toUpperCase();
  const baseCoef = mode === 'mono' ? '' : String(Number(strategy.base_coef || 1).toFixed(6));
  const quoteCoef = mode === 'mono' ? '' : String(Number(strategy.quote_coef || 1).toFixed(6));
  const type = String(strategy.strategy_type || 'DD_BattleToads');
  const len = Math.max(2, Math.floor(Number(strategy.price_channel_length) || 50));
  const src = String(strategy.detection_source || 'close');
  const zEntry = (type === 'stat_arb_zscore' || type === 'CT_Fractal')
    ? Number(strategy.zscore_entry || 2.5).toFixed(4)
    : '';
  const longs = strategy.long_enabled ? '1' : '0';
  const shorts = strategy.short_enabled ? '1' : '0';
  return `${apiKeyName}|${mode}|${base}|${quote}|${baseCoef}|${quoteCoef}|${strategy.interval}|${type}|${len}|${src}|${zEntry}|${longs}|${shorts}`;
};

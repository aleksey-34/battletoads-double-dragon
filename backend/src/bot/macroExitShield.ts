import { db } from '../utils/database';
import { getMarketData } from './exchange';
import logger from '../utils/logger';
import type { MacroExitOverlay, MacroExitRule } from '../backtest/engine';

const SHIELD_OVERLAY: MacroExitOverlay = {
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

type CardShieldCacheEntry = {
  macroShield: boolean;
  expiresAtMs: number;
};

const cardShieldCache = new Map<string, CardShieldCacheEntry>();
const CACHE_TTL_MS = 60_000;

const computeRsi = (closes: number[], period: number): number | null => {
  if (closes.length < period + 1) {
    return null;
  }
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) {
      gains += delta;
    } else {
      losses -= delta;
    }
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss <= 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const shouldTriggerMacroExit = (
  rule: MacroExitRule,
  state: 'long' | 'short',
  rsi: number,
): boolean => {
  if (state === 'long') {
    if (rule.longExitRsiAbove != null && rsi >= rule.longExitRsiAbove) {
      return true;
    }
    if (rule.longExitRsiBelow != null && rsi <= rule.longExitRsiBelow) {
      return true;
    }
  }
  if (state === 'short') {
    if (rule.shortExitRsiBelow != null && rsi <= rule.shortExitRsiBelow) {
      return true;
    }
    if (rule.shortExitRsiAbove != null && rsi >= rule.shortExitRsiAbove) {
      return true;
    }
  }
  return false;
};

export const isMacroShieldEnabledForApiKey = async (apiKeyName: string): Promise<boolean> => {
  const key = String(apiKeyName || '').trim();
  if (!key) {
    return false;
  }
  const cached = cardShieldCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.macroShield;
  }

  let macroShield = false;
  try {
    const row = await db.get<{ published_system_name?: string }>(
      `SELECT published_system_name FROM algofund_profiles
       WHERE TRIM(COALESCE(execution_api_key_name, assigned_api_key_name, '')) = ?
       LIMIT 1`,
      [key],
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
        macroShield = meta.macroShield === true;
      }
    }
  } catch (error) {
    logger.warn(`[macroExitShield] card lookup failed for ${key}: ${(error as Error).message}`);
  }

  cardShieldCache.set(key, { macroShield, expiresAtMs: Date.now() + CACHE_TTL_MS });
  return macroShield;
};

export const evaluateMacroShieldLongExit = async (
  apiKeyName: string,
  overlay: MacroExitOverlay = SHIELD_OVERLAY,
): Promise<{ shouldExit: boolean; reason: string; rsi: number; symbol: string } | null> => {
  const interval = String(overlay.anchorInterval || '4h').trim() || '4h';

  for (let ruleIdx = 0; ruleIdx < overlay.rules.length; ruleIdx += 1) {
    const rule = overlay.rules[ruleIdx];
    if (rule.source !== 'anchor' || !rule.anchorSymbol) {
      continue;
    }
    const period = Math.max(2, Math.floor(Number(rule.rsiPeriod ?? 14)));
    const candles = await getMarketData(apiKeyName, rule.anchorSymbol, interval, period + 5, {}).catch(() => []);
    const closes = (Array.isArray(candles) ? candles : [])
      .map((row) => Number((row as { close?: number }).close ?? NaN))
      .filter((value) => Number.isFinite(value));
    const rsi = computeRsi(closes, period);
    if (rsi == null) {
      continue;
    }
    if (shouldTriggerMacroExit(rule, 'long', rsi)) {
      const label = rule.label || `${rule.anchorSymbol}`;
      return {
        shouldExit: true,
        reason: `macro_rsi_${label}_${rsi.toFixed(1)}`,
        rsi,
        symbol: rule.anchorSymbol,
      };
    }
  }

  return null;
};

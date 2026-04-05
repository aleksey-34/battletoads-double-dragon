// ─── Razgon Types & Interfaces ───────────────────────────────────────────────

export type RazgonSubStrategy = 'momentum' | 'sniper' | 'funding';

export interface RazgonMomentumConfig {
  enabled: boolean;
  allocation: number;           // fraction of balance (0.6 = 60%)
  leverage: number;
  marginType: 'isolated' | 'cross';
  donchianPeriod: number;       // bars (1m each)
  volumeMultiplier: number;     // entry when volume > k * avg
  trailingTpPercent: number;    // trailing TP distance %
  stopLossPercent: number;      // hard SL %
  maxPositionTimeSec: number;   // force-close timeout
  tickIntervalSec: number;      // how often to check
  maxConcurrentPositions: number;
  atrFilterMin: number;         // min normalised ATR to allow entry
  watchlist: string[];          // symbols, e.g. ['PEPEUSDT','WIFUSDT']
}

export interface RazgonSniperConfig {
  enabled: boolean;
  allocation: number;
  leverage: number;
  marginType: 'isolated' | 'cross';
  entryDelayMs: number;         // wait after detecting new listing
  takeProfitPercent: number;
  stopLossPercent: number;
  maxPositionTimeSec: number;
  scanIntervalSec: number;
}

export interface RazgonFundingConfig {
  enabled: boolean;
  allocation: number;
  leverage: number;
  marginType: 'isolated' | 'cross';
  minFundingRate: number;       // absolute, e.g. 0.0005 = 0.05%
  minVolume24h: number;
  maxPositions: number;
  stopLossPercent: number;
  scanIntervalSec: number;      // e.g. 14400 = 4h
}

export interface RazgonRiskConfig {
  maxRiskPerTrade: number;      // fraction, e.g. 0.05 = 5%
  maxDailyLoss: number;         // fraction, e.g. 0.20 = 20%
  rescaleThreshold: number;     // fraction, e.g. 0.25 = +25%
  noAveragingDown: boolean;
  forceIsolatedMargin: boolean;
}

export interface RazgonWithdrawConfig {
  enabled: boolean;
  threshold: number;
  withdrawPercent: number;
  minWithdraw: number;
  targetAddress: string;
  cooldownHours: number;
}

export type RazgonPresetMode = 'low' | 'mid' | 'high';

export interface RazgonApiKeyEntry {
  name: string;          // api key name in DB
  exchange: string;      // 'mexc' | 'bybit' | 'bitget'
  enabled: boolean;
  startBalancePct: number; // % of account balance to use (0.0–1.0)
  label?: string;        // display name
}

export interface RazgonConfig {
  exchange: string;             // primary exchange (legacy, kept for compat)
  apiKeyName: string;           // primary api key name (legacy)
  apiKeys: RazgonApiKeyEntry[]; // multi-key list
  startBalance: number;         // absolute USDT (legacy fallback)
  startBalancePct: number;      // fraction of account equity to use (0 = use startBalance)
  presetMode: RazgonPresetMode; // 'low' | 'mid' | 'high'
  momentum: RazgonMomentumConfig;
  sniper: RazgonSniperConfig;
  funding: RazgonFundingConfig;
  risk: RazgonRiskConfig;
  withdraw: RazgonWithdrawConfig;
}

export type RazgonStatus = 'stopped' | 'running' | 'paused' | 'error';

export interface RazgonPosition {
  id: string;
  subStrategy: RazgonSubStrategy;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  notional: number;
  margin: number;
  leverage: number;
  openedAt: number;             // epoch ms
  tpAnchor: number;             // trailing anchor price
  slPrice: number;              // hard stop-loss price
  unrealizedPnl: number;
}

export interface RazgonTrade {
  id: string;
  subStrategy: RazgonSubStrategy;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  notional: number;
  grossPnl: number;
  fee: number;
  netPnl: number;
  openedAt: number;
  closedAt: number;
  exitReason: 'tp' | 'sl' | 'timeout' | 'manual' | 'daily_limit' | 'signal_flip';
}

export interface RazgonStats {
  status: RazgonStatus;
  balance: number;
  startBalance: number;
  peakBalance: number;
  totalPnl: number;
  todayPnl: number;
  totalTrades: number;
  todayTrades: number;
  winRate: number;
  avgRR: number;
  openPositions: RazgonPosition[];
  lastError?: string;
}

export interface Candle1m {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const DEFAULT_RAZGON_CONFIG: RazgonConfig = {
  exchange: 'mexc',
  apiKeyName: 'BTDD_MEX_1',
  apiKeys: [{ name: 'BTDD_MEX_1', exchange: 'mexc', enabled: true, startBalancePct: 0.9, label: 'MEXC Main' }],
  startBalance: 40,
  startBalancePct: 0,
  presetMode: 'high',

  momentum: {
    enabled: true,
    allocation: 0.25,
    leverage: 20,
    marginType: 'isolated',
    donchianPeriod: 5,
    volumeMultiplier: 1.5,
    trailingTpPercent: 0.45,
    stopLossPercent: 0.30,
    maxPositionTimeSec: 900,
    tickIntervalSec: 5,
    maxConcurrentPositions: 2,
    atrFilterMin: 0.0015,
    watchlist: ['PEPEUSDT', 'WIFUSDT', 'SUIUSDT', 'DOGEUSDT', 'SOLUSDT', 'ARBUSDT', 'ORDIUSDT'],
  },

  sniper: {
    enabled: true,
    allocation: 0.25,
    leverage: 10,
    marginType: 'isolated',
    entryDelayMs: 60_000,
    takeProfitPercent: 15,
    stopLossPercent: 5,
    maxPositionTimeSec: 300,
    scanIntervalSec: 30,
  },

  funding: {
    enabled: false,
    allocation: 0.15,
    leverage: 10,
    marginType: 'isolated',
    minFundingRate: 0.0005,
    minVolume24h: 5_000_000,
    maxPositions: 3,
    stopLossPercent: 3,
    scanIntervalSec: 14_400,
  },

  risk: {
    maxRiskPerTrade: 0.05,
    maxDailyLoss: 0.10,
    rescaleThreshold: 0.25,
    noAveragingDown: true,
    forceIsolatedMargin: true,
  },

  withdraw: {
    enabled: false,
    threshold: 100,
    withdrawPercent: 0.30,
    minWithdraw: 10,
    targetAddress: '',
    cooldownHours: 24,
  },
};

// ── Preset Configs ────────────────────────────────────────────────────────

type MomentumPreset = Pick<RazgonMomentumConfig, 'leverage' | 'allocation' | 'stopLossPercent' | 'trailingTpPercent' | 'maxConcurrentPositions' | 'atrFilterMin' | 'volumeMultiplier'>;
type RiskPreset = Pick<RazgonRiskConfig, 'maxDailyLoss' | 'maxRiskPerTrade'>;

export const RAZGON_PRESETS: Record<RazgonPresetMode, { label: string; color: string; momentum: MomentumPreset; risk: RiskPreset }> = {
  low: {
    label: 'Low (Safe)',
    color: 'green',
    momentum: { leverage: 10, allocation: 0.20, stopLossPercent: 0.50, trailingTpPercent: 0.60, maxConcurrentPositions: 2, atrFilterMin: 0.002, volumeMultiplier: 1.8 },
    risk: { maxDailyLoss: 0.08, maxRiskPerTrade: 0.03 },
  },
  mid: {
    label: 'Mid (Balanced)',
    color: 'orange',
    momentum: { leverage: 15, allocation: 0.22, stopLossPercent: 0.40, trailingTpPercent: 0.50, maxConcurrentPositions: 2, atrFilterMin: 0.0018, volumeMultiplier: 1.6 },
    risk: { maxDailyLoss: 0.10, maxRiskPerTrade: 0.04 },
  },
  high: {
    label: 'High (Turbo)',
    color: 'red',
    momentum: { leverage: 20, allocation: 0.25, stopLossPercent: 0.30, trailingTpPercent: 0.45, maxConcurrentPositions: 2, atrFilterMin: 0.0015, volumeMultiplier: 1.5 },
    risk: { maxDailyLoss: 0.10, maxRiskPerTrade: 0.05 },
  },
};

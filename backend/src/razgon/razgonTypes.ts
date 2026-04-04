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

export interface RazgonConfig {
  exchange: string;             // 'mexc' | 'bitget' | ...
  apiKeyName: string;
  startBalance: number;
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
  apiKeyName: 'razgon_mexc',
  startBalance: 40,

  momentum: {
    enabled: true,
    allocation: 0.60,
    leverage: 25,
    marginType: 'isolated',
    donchianPeriod: 10,
    volumeMultiplier: 1.3,
    trailingTpPercent: 0.3,
    stopLossPercent: 0.2,
    maxPositionTimeSec: 900,    // 15 min
    tickIntervalSec: 5,
    maxConcurrentPositions: 3,
    atrFilterMin: 0.002,
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
    maxPositionTimeSec: 300,    // 5 min
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
    scanIntervalSec: 14_400,    // 4h
  },

  risk: {
    maxRiskPerTrade: 0.05,
    maxDailyLoss: 0.20,
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

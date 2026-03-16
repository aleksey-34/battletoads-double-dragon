/**
 * Strategy Mapping & Backtest Validation Plan
 * 
 * Three PineScript strategies mapped to mono/synthetic architecture
 */

// ==================== STRATEGY 1: Donchian Breakout ====================
/*
PINESCRIPT PARAMETERS:
  - pclen: price channel length (default 50)
  - tp: take profit percent (default 7.5%)
  - tptype: TP behavior (Fix, Trailing, None)
  - sltype: SL behavior (Center, None)
  - sizelong/sizeshort: lot percent (default 100%)
  - needlong/needshort: enable long/short

MAPPING TO BACKEND /config/settings.ts:
  strategy_type: 'DD_BattleToads'
  market_mode: 'mono' or 'synthetic'
  price_channel_length: 50
  take_profit_percent: 7.5
  detection_source: 'close' (high/low in Pinescript)
  zscore_entry: null (not used)
  base_symbol: 'BTCUSDT' (for mono)
  quote_symbol: '' (empty for mono)

LOGIC FLOW:
  1. Load candles: high/low over pclen bars
  2. Compute: h = max(high, pclen), l = min(low, pclen), center = (h+l)/2
  3. Signal: when close crosses h (LONG entry) or l (SHORT entry)
  4. Entry: market order at breakout
  5. Exit: 
     - TP: h * (1 + tp/100) for long, l * (1 - tp/100) for short
     - SL: center line
     - Trailing: TP moves with new channel highs/lows

MONO Example:
  - Symbol: BTCUSDT
  - Entry: close > highest(50) → LONG
  - Exit: TP = entry * 1.075, SL = channel_center

SYNTHETIC Example (RATIO-BASED):
  - Symbols: BTCUSDT / ETHUSDT
  - Compute ratio: close_BTC / close_ETH
  - Entry: ratio > highest(50) → pair is overheated, go short ratio
  - Exit: ratio reverts to mean + TP/SL

STATUS: ✅ READY for MONO backtest immediately
RISK: 🟢 LOW - universal price logic
*/

// ==================== STRATEGY 2: hamster-bot ZZ ====================
/*
PINESCRIPT VARIANTS:
  ZZ6: Zigzag breakout (simpler)
    - len: zigzag depth (default 5)
    - risklong/riskshort: risk percent (default 1%)
    
  ZZ2: MA-based levels (complex)
    - Depth, Detection, MA types, RSI filter
    - Distance filter: pause if levels too close
    - Flat filter: pause if choppy market
    - MA crossing filters
    - Trailing stop via MA

MAPPING TO BACKEND:
  strategy_type: 'zz_breakout'  (or could be 'stat_arb_zscore' for ZZ2 variant)
  market_mode: 'mono' or 'synthetic'
  price_channel_length: 5 (for zigzag)
  zscore_entry/exit/stop: for ZZ2 MA-based variant
  base_symbol: single or pair base
  quote_symbol: pair quote or ''

LOGIC FLOW (ZZ6):
  1. Calculate zigzag levels (high/low extrema)
  2. Entry: price breaks level + distance filter OK + flat filter OK
  3. Exit: reverse zigzag level or TP/SL
  4. Pyramiding: multiple entries until max_risk

MONO Example:
  - Symbol: ETHUSDT
  - ZZ6 depth: 5
  - Entry: break of zigzag level (after reversal)
  - Filters: distance < 1000 (level spread OK), flat > 0.5% (not choppy)
  - Exit: next reversal level or TP = entry * 1.04

SYNTHETIC Example:
  - Symbols: ETHUSDT / LTCUSDT  
  - Zigzag on ratio
  - Entry/exit as above but on ratio breakout

STATUS: ⚠️  MEDIUM - needs verification of zigzag calculation
RISK: 🟡 MEDIUM - many filters, parameter-sensitive
*/

// ==================== STRATEGY 3: hamster-bot HiDeep ====================
/*
PINESCRIPT PARAMETERS:
  HiDeep Oscillator:
    - up1/up2, dn1/dn2: fastRSI periods for two levels
    - mac1/mac2: SMA periods for center
    - sma1/sma2: SMA for deviation
    
  Filters:
    - MA Trigger: optional higher-level MA for trend
    - Trend filter: optional ADX-like logic
    - Trail stop: MA-based exit

MAPPING TO BACKEND:
  strategy_type: 'DD_BattleToads' or new 'hideep'
  market_mode: 'mono' or 'synthetic'
  price_channel_length: mac1 (default 10)
  zscore_entry: up1 threshold (when fastRSI < 10)
  zscore_exit: dn1 threshold (when fastRSI > 90)
  base_symbol: single symbol or pair base
  quote_symbol: pair quote or ''

LOGIC FLOW:
  1. Calculate: fastRSI1 = fast RSI over up1/dn1
  2. Calculate: MAC1 = SMA(close, mac1), len1 = |close - MAC1|
  3. Calculate: SMA1 = SMA(len1, sma1)
  4. Entry (LONG): close < open AND len1 > sma1 * upsma1 AND fastRSI1 < 10
  5. Entry (SHORT): close > open AND len1 > sma1 * dnsma1 AND fastRSI1 > 90
  6. Pyramiding: multiple entries if room
  7. Exit: TP/SL, Trail stop, or MA trigger crossover

MONO Example:
  - Symbol: STXUSDT
  - HiDeep [1]: up1=2, mac1=10, sma1=100
  - Entry (LONG): deep oversold detected (fastRSI<10, volatility high)
  - Exit: TP=+4%, SL=-2.5% or trail SMA

SYNTHETIC Example:
  - Symbols: INJUSDT / TLMUSDT
  - HiDeep on ratio decay
  - Entry when ratio oversold (fastRSI<10)
  - Exit: ratio mean reversion

STATUS: ✅ READY for MONO backtest
RISK: 🔴 HIGH - complex, presets for specific instruments needed
*/

// ==================== BACKTEST VALIDATION PLAN ====================
/*

PHASE 1: BACKTEST VALIDATION (1-2 days)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1: Select 5-7 TOP CANDIDATES
  C1 (MONO): STX, TRU, VET (low-cap, high volatility - good for channel breakout)
  C2 (MONO): ARKM, IMX (medium, trendy - good for HiDeep)
  C4 (MONO): GRT, INJ (high-cap, liquid - good baseline)

STEP 2: TEST STRATEGY 1 (Donchian Breakout)
  For each candidate:
    - Run backtest: 2 weeks historical (14 bars if 4h = 56 hours)
    - Parameters: pclen=50, tp=7.5%, sl_type=center, tptype=trailing
    - Metrics: win_rate (target >50%), profit_factor (target >1.2), max_dd (target <20%)
    - Accept if: win_rate > 45% AND profit_factor > 1.0
    - Rank candidates by profit_factor
    
STEP 3: TEST STRATEGY 2 (ZZ Breakout)
  Test ZZ6 variant (simpler):
    - Parameters: len=5, risklong=1%, distance_filter=1000%
    - Compare with Strategy 1 results
    - Rank top 3 candidates
    
STEP 4: TEST STRATEGY 3 (HiDeep)
  For top candidates from Step 3:
    - Parameters: up1=2, dn1=2, mac1=10, sma1=100, trail_stop=SMA(14)
    - Compare with Strategy 1 & 2
    - Rank final portfolio candidates

STEP 5: SYNTHESIZE RESULTS
  Top 3-5 candidates per strategy type
  Group into TRADING_SYSTEM:
    - "Channel Breakout Mono" = [STX + TRU + VET] + Donchian
    - "Momentum Mono" = [GRT + INJ] + HiDeep
    - (Optional) "Hybrid" = mix strategies

OUTPUT:
  ✅ Backtest report per strategy
  ✅ Ranked candidates (PnL, win_rate, drawdown)
  ✅ Trading system definitions
  ✅ Parameter sets for production

LIVE DEPLOYMENT (Phase 2):
  1. Deploy ONE trading system to testnet
  2. Run for 24-48 hours
  3. Compare live vs backtest (NEW: LiveReconciliation + DriftAnalyzer)
  4. If green (deviation <10%), promote to live with monitoring
  5. If yellow (deviation 10-20%), analyze drift + adjust params
  6. If red (deviation >20%), investigate or swap strategy

*/

// ==================== CANDIDATE TOP SCORING ====================

export const BACKTEST_VALIDATION_CANDIDATES = {
  C1_MONO: [
    { symbol: 'STXUSDT', tier: 1, reason: 'Low-cap, high volatility - good for breakout' },
    { symbol: 'TRUUSDT', tier: 1, reason: 'Medium-cap, trending - good for HiDeep' },
    { symbol: 'VETUSDT', tier: 1, reason: 'Low-cap, liquid - test baseline' },
    { symbol: 'THETAUSDT', tier: 2, reason: 'Medium-cap, stable - secondary test' },
  ],
  C2_MONO: [
    { symbol: 'ARKMUSDT', tier: 1, reason: 'Medium-cap, volatile - good for momentum' },
    { symbol: 'IMXUSDT', tier: 1, reason: 'Medium-cap, trendy - good fit' },
    { symbol: 'HOOKUSDT', tier: 2, reason: 'Secondary candidate' },
  ],
  C4_MONO: [
    { symbol: 'GRTUSDT', tier: 1, reason: 'High-cap, liquid - baseline test' },
    { symbol: 'INJUSDT', tier: 1, reason: 'High-cap, correlated with major moves' },
    { symbol: 'TLMUSDT', tier: 2, reason: 'High-cap, less volatile' },
  ],
};

export const BACKTEST_CONFIG = {
  PERIOD_DAYS: 14,
  INTERVAL: '4h',
  INITIAL_BALANCE: 10000,
  COMMISSION_PERCENT: 0.1,
  SLIPPAGE_PERCENT: 0.05,
  FUNDING_RATE_PERCENT: 0.0,
  
  // Pass criteria
  MIN_WIN_RATE: 0.45,
  MIN_PROFIT_FACTOR: 1.0,
  MAX_DRAWDOWN: 0.25,
  
  // Strategy params to test
  STRATEGIES: {
    DONCHIAN: {
      price_channel_length: [30, 50, 70],
      take_profit_percent: [5, 7.5, 10],
      detection_source: ['close', 'hl2'],
    },
    ZZ6: {
      len: [3, 5, 8],
      risklong: [0.5, 1.0, 1.5],
      distance_filter: [500, 1000, 2000],
    },
    HIDEEP: {
      up1: [1, 2, 3],
      mac1: [8, 10, 15],
      sma1: [50, 100, 150],
    },
  },
};

export const VALIDATION_RULES = {
  ENTRY_TIME_LAG_MAX_SECONDS: 30,      // If live entry >30s after backtest: warning
  SLIPPAGE_RATIO_MAX: 1.5,              // If actual slippage > backtest * 1.5x: critical
  WIN_RATE_DROP_MAX: 0.15,              // If win_rate drops >15% points: pause
  PNL_DROP_MAX: 0.10,                   // If PnL drops >10%: pause
};

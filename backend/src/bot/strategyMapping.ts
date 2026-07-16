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

// ==================== STRATEGY: MRS2 (hamster MA-limit MR) ====================
/*
PINESCRIPT / HAMSTER MRS 2:
  - Entry long limit:  SMA(ohlc4, len) * long_mult  (e.g. 0.95)
  - Entry short limit: SMA(ohlc4, len) * short_mult (e.g. 1.05)
  - Exit limits at close MA * mult (~1.0)
  - distance_filter between open band and close MA (pct)
  - Fill: limit touch (high/low)

MAPPING:
  strategy_type: 'MRS2'
  mrs2_config_json: { maLongLen, maLongMult, maShortLen, maShortMult,
                      maCloseLongLen, maCloseLongMult, maCloseShortLen, maCloseShortMult,
                      distanceFilterPct, slLongPct, slShortPct }
  Fallback remap: price_channel_length, zscore_entry/exit/stop

STATUS: ✅ BT engine + research harness
*/

// ==================== STRATEGY 2: ZZ pivot (ZZ_Fast / ZZ_Instance) ====================
/*
VARIANTS:
  ZZ_Fast: fast pivot len, slow = len × 3, SAR exit at opposite level
  ZZ_Instance: fast pivot len, slow = len × 2, SAR exit

MAPPING TO BACKEND:
  strategy_type: 'ZZ_Fast' | 'ZZ_Instance'
  market_mode: 'mono' or 'synthetic'
  price_channel_length: pivot fast length (e.g. 3, 5, 6)
  take_profit_percent: 0 (SAR exit only)
  detection_source: 'wick'

LOGIC FLOW:
  1. Track pivot levels (fast/slow high/low alignment)
  2. Entry: wick breaks levelLong (long) or levelShort (short)
  3. Exit: SAR — long stops at levelShort, short at levelLong

STATUS: ✅ implemented in backend/src/bot/zzPivotLevels.ts
*/

// ==================== STRATEGY 3: stat_arb_zscore (pair / ratio mean reversion) ====================
/*
NOT the same as HiDeep Pine (that is `hideep`). Classic stat-arb on TV = z-score of spread/ratio.

OUR ENGINE (backend stat_arb_zscore):
  - Series: synthetic ratio close (base/quote) or mono close
  - Window: price_channel_length bars BEFORE current bar (no look-ahead)
  - z = (close - mean(window)) / stdev(window)
  - Entry SHORT: z >= zscore_entry (ratio rich vs history)
  - Entry LONG:  z <= -zscore_entry (ratio cheap)
  - Exit mean-revert LONG:  z >= -zscore_exit
  - Exit mean-revert SHORT: z <= +zscore_exit
  - Stop LONG:  z <= -zscore_stop ( deeper cheap )
  - Stop SHORT: z >= +zscore_stop

OPTIONAL statArbEntryGate (card / v2 synth — NOT in raw sweep):
  - Fractal confirmation on self or anchor (4h, wings=2, lookback=12)
  - Optional RSI oversold/overbought on gate TF
  - Mirrors TV idea of “don’t fade until local swing confirms”

TV HiDeep extras we do NOT map to stat_arb (separate hideep type):
  - ATR trend channel, MA bands, pyramiding, trail MA exit, PDD flip mode

SWEEP (honest sizing): lot 100%, reinvest 100%, score penalizes DD > 30%.
*/

// ==================== STRATEGY 4: HiDeep (TV overlay oscillator) ====================
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

// ==================== STRATEGY 4: CT_Fractal (contrarian synth combo) ====================
/*
Triple confluence on synthetic ratio pairs — fewer but higher-conviction entries.

COMPONENTS (all three required for entry):
  1. stat_arb_zscore: ratio z-score extreme (|z| >= zscore_entry)
  2. HiDeep deep: bear/bull candle + momentum (len1 > sma1) + fastRSI < 10 / > 90
  3. Fractal: confirmed Bill Williams fractal (wings=2) within lookback=12 bars
     — bullish fractal for long, bearish for short

EXITS:
  - Z mean-revert / z-score stop (same as stat_arb)
  - HiDeep RSI exit: fastRSI > 90 closes long, < 10 closes short
  - No separate statArbEntryGate (fractal already built into entry)

SWEEP GRID (1d synth):
  strategyTypes: ['CT_Fractal']
  statLengths / statEntry / statExit / statStop — same fields as stat_arb
  lot 100%, reinvest 100%, DD scoring ≤ 30%

STATUS: ✅ wired in backtest + sweep pipeline step [4/4]
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
    ZZ_Fast: {
      len: [3, 5, 6, 8],
    },
    ZZ_Instance: {
      len: [2, 3, 5],
    },
    HIDEEP: {
      up1: [1, 2, 3],
      mac1: [8, 10, 15],
      sma1: [50, 100, 150],
    },
    MRS2: {
      // Full params in mrs2_config_json; remap fallbacks below
      ma_long_mult: [0.94, 0.95, 0.96],
      ma_short_mult: [1.04, 1.05, 1.06],
      distance_filter: [0.3],
    },
  },
};

export const VALIDATION_RULES = {
  ENTRY_TIME_LAG_MAX_SECONDS: 30,      // If live entry >30s after backtest: warning
  SLIPPAGE_RATIO_MAX: 1.5,              // If actual slippage > backtest * 1.5x: critical
  WIN_RATE_DROP_MAX: 0.15,              // If win_rate drops >15% points: pause
  PNL_DROP_MAX: 0.10,                   // If PnL drops >10%: pause
};

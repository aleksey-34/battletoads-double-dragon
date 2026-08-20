# Portfolio tick-auction research (Aug 2026)

## Verdict

On the conflict-focused offline sleeve (B3 mono↔synth overlaps + FIVE JUP quote clash), **auction_A** wins the short live-like window (`2026-07-30..2026-08-19`) by return/DD, and **auction_B** wins the full window (`2024-03-17..2026-08-19`).

Auction ranking beats pure first-wins when conflicts are dense inside B3 (INJ/SUI/WLD mono 1h vs synth 4h). Recipe priority (A) is stable; expectancy (B) can overfit the solo subset; synth-vs-mono (C) is secondary.

## Method

1. **Code paths reviewed (no production auction shipped)**
   - Live symbol-lock: `backend/src/bot/strategy.ts` (`PAIR_LOCK_SCOPE` default = symbol; `acquireApiKeyPairEntryLock` then cross-TS hold check).
   - Live concurrency: `backend/src/bot/strategy/cycle/autoRun.ts` (`STRATEGY_CYCLE_CONCURRENCY`, default 16) → first strategy to pass lock/OP wins (race).
   - BT parity: `backend/src/backtest/engine.ts` `isPairLocked` + `buildEvents` seeded random tie-break (`pairLockSeed`) on same `timeMs`.

2. **Data reality on this cloud VM**
   - No `results/hybrid_candle_bundle_*`, no `database.db*`, Binance/Bybit geo-blocked.
   - Used **public Bitget USDT-M history candles** into `results/tick_auction_research_aug2026/candles/`.
   - Strategy sleeve is a **conflict subset**, not full P1 rematerialization (B3 system 205 members not present without DB).

3. **Universe (conflict sleeve)**
   - B3 mono Donchian 1h L55: INJ, SUI, WLD, ORDI, NEAR, ARB
   - B3 synth ZZ 4h L3 proxies: INJ/TIA, SUI/SEI, WLD/JUP, BCH/APE, ZEN/ALGO
   - B3 ORDI 4h momentum **proxy** (Donch L20 — TV burst unavailable offline)
   - FIVE MRS JUP 4h from `hamfive_legs_aug2026.json` (symbol-lock clash with WLD/JUP synth quote)
   - HAM ENA 2h control (should rarely conflict)

4. **Variants**
   - `first_wins`: shuffle candidates per closed-bar tick (seed `1759827600`) then symbol-lock — proxy for live race / BT RNG tie-break.
   - `auction_A`: recipe book priority **b3 (400) > ham (300) > five (200) > stocks (100)** from `recipes_hamfive_aug2026.json`.
   - `auction_B`: score = `10*soloPF + ret÷DD` from lock-free solo runs on the same window.
   - `auction_C_synth` / `auction_C_mono`: prefer synth or mono, then recipe as weak tie-break.

5. **Capital / sizing**
   - Shared cash `1000` USDT (Copy_Alex1-like fair book), per-leg lot 10–15%, commission `8.0` bps round-trip.
   - `skipMissingSymbols` N/A (only symbols successfully fetched).

## Recipe priority table (score A)

```json
{
  "source": "scripts/hybrid/portfolio_six_data_jul2026/recipes_hamfive_aug2026.json",
  "priorityOrder": [
    "b3",
    "ham",
    "five",
    "stocks"
  ],
  "scores": {
    "b3": 400,
    "ham": 300,
    "five": 200,
    "stocks": 100
  },
  "rationale": "Storefront recipes always lead with sharedB3 (core sleeve), then HAM ZZ, then FIVE MRS, then stocks ZZ as optional overlay (initial often 0 on stamps). Explicit numeric table used for auction A.",
  "P1_books": [
    {
      "key": "b3",
      "ref": "sharedB3",
      "initial": 10000
    },
    {
      "key": "ham",
      "universe": "ham_zz_weex4",
      "op": 8,
      "lot": 10,
      "ri": 100,
      "initial": 5000,
      "tsTag": "ham-ham_zz_weex4-op8-lot10"
    },
    {
      "key": "five",
      "universe": "five_weex4",
      "op": 6,
      "lot": 8,
      "ri": 100,
      "initial": 5000,
      "tsTag": "five-five_weex4-op6-lot8"
    },
    {
      "key": "stocks",
      "universe": "stocks_zz_4h_l30",
      "op": 6,
      "lot": 15,
      "ri": 100,
      "initial": 0,
      "tsTag": "stocks-zz-4h-l30"
    }
  ],
  "P1_snapshot": {
    "ret": 5804.29,
    "dd": 31.43,
    "pf": 1.359,
    "trades": 4387,
    "window": "2024-03-17..2026-08-13"
  }
}
```

## Solo expectancy inputs (score B)

```json
{
  "b3_mono_donch1h_INJUSDT": {
    "book": "b3",
    "mode": "mono",
    "symbols": [
      "INJUSDT"
    ],
    "ret": 9.13,
    "dd": 15.26,
    "pf": 1.112,
    "trades": 189,
    "retOverDd": 0.598,
    "candles": 21158
  },
  "b3_mono_donch1h_SUIUSDT": {
    "book": "b3",
    "mode": "mono",
    "symbols": [
      "SUIUSDT"
    ],
    "ret": 25.49,
    "dd": 14.18,
    "pf": 1.276,
    "trades": 183,
    "retOverDd": 1.797,
    "candles": 21158
  },
  "b3_mono_donch1h_WLDUSDT": {
    "book": "b3",
    "mode": "mono",
    "symbols": [
      "WLDUSDT"
    ],
    "ret": 26.55,
    "dd": 15.59,
    "pf": 1.244,
    "trades": 187,
    "retOverDd": 1.702,
    "candles": 21158
  },
  "b3_mono_donch1h_ORDIUSDT": {
    "book": "b3",
    "mode": "mono",
    "symbols": [
      "ORDIUSDT"
    ],
    "ret": -18.65,
    "dd": 31.38,
    "pf": 0.825,
    "trades": 195,
    "retOverDd": -0.594,
    "candles": 21158
  },
  "b3_mono_donch1h_NEARUSDT": {
    "book": "b3",
    "mode": "mono",
    "symbols": [
      "NEARUSDT"
    ],
    "ret": 1.81,
    "dd": 18.5,
    "pf": 1.02,
    "trades": 210,
    "retOverDd": 0.098,
    "candles": 21158
  },
  "b3_mono_donch1h_ARBUSDT": {
    "book": "b3",
    "mode": "mono",
    "symbols": [
      "ARBUSDT"
    ],
    "ret": 15.87,
    "dd": 19.34,
    "pf": 1.205,
    "trades": 185,
    "retOverDd": 0.821,
    "candles": 21158
  },
  "b3_synth_zz4h_INJUSDT_TIAUSDT": {
    "book": "b3",
    "mode": "synth",
    "symbols": [
      "INJUSDT",
      "TIAUSDT"
    ],
    "ret": -31.58,
    "dd": 45.37,
    "pf": 0.557,
    "trades": 118,
    "retOverDd": -0.696,
    "candles": 5289
  },
  "b3_synth_zz4h_SUIUSDT_SEIUSDT": {
    "book": "b3",
    "mode": "synth",
    "symbols": [
      "SEIUSDT",
      "SUIUSDT"
    ],
    "ret": -4.45,
    "dd": 35.57,
    "pf": 0.92,
    "trades": 88,
    "retOverDd": -0.125,
    "candles": 5289
  },
  "b3_synth_zz4h_WLDUSDT_JUPUSDT": {
    "book": "b3",
    "mode": "synth",
    "symbols": [
      "JUPUSDT",
      "WLDUSDT"
    ],
    "ret": -18.39,
    "dd": 37.77,
    "pf": 0.795,
    "trades": 139,
    "retOverDd": -0.487,
    "candles": 5289
  },
  "b3_synth_zz4h_BCHUSDT_APEUSDT": {
    "book": "b3",
    "mode": "synth",
    "symbols": [
      "APEUSDT",
      "BCHUSDT"
    ],
    "ret": 1.38,
    "dd": 23.7,
    "pf": 1.013,
    "trades": 210,
    "retOverDd": 0.058,
    "candles": 5289
  },
  "b3_synth_zz4h_ZENUSDT_ALGOUSDT": {
    "book": "b3",
    "mode": "synth",
    "symbols": [
      "ALGOUSDT",
      "ZENUSDT"
    ],
    "ret": 2.72,
    "dd": 20.43,
    "pf": 1.038,
    "trades": 110,
    "retOverDd": 0.133,
    "candles": 3526
  },
  "b3_mono_mom4h_ORDIUSDT": {
    "book": "b3",
    "mode": "mono",
    "symbols": [
      "ORDIUSDT"
    ],
    "ret": -18.12,
    "dd": 26.35,
    "pf": 0.753,
    "trades": 126,
    "retOverDd": -0.688,
    "candles": 5289
  },
  "five_mrs_255460": {
    "book": "five",
    "mode": "mono",
    "symbols": [
      "JUPUSDT"
    ],
    "ret": 5.35,
    "dd": 14.42,
    "pf": 1.058,
    "trades": 431,
    "retOverDd": 0.371,
    "candles": 5289
  },
  "ham_zz_254962": {
    "book": "ham",
    "mode": "mono",
    "symbols": [
      "ENAUSDT"
    ],
    "ret": -79.0,
    "dd": 86.94,
    "pf": 0.815,
    "trades": 1027,
    "retOverDd": -0.909,
    "candles": 10363
  }
}
```

## Metrics — short window `2026-07-30..2026-08-19`

| Variant | totalReturn% | maxDD% | trades | skippedByPairLock | conflictResolutions | PF |
|---|---:|---:|---:|---:|---:|---:|
| first_wins | -6.1 | 71.84 | 88 | 69 | 7 | 0.545 |
| auction_A | -5.52 | 71.84 | 89 | 58 | 7 | 0.585 |
| auction_B | -5.73 | 71.96 | 89 | 58 | 7 | 0.571 |
| auction_C_synth | -5.86 | 71.83 | 89 | 64 | 7 | 0.556 |
| auction_C_mono | -5.58 | 71.84 | 89 | 58 | 7 | 0.585 |

## Metrics — full window `2024-03-17..2026-08-19`

| Variant | totalReturn% | maxDD% | trades | skippedByPairLock | conflictResolutions | PF |
|---|---:|---:|---:|---:|---:|---:|
| first_wins | -51.39 | 84.51 | 2737 | 2940 | 104 | 0.905 |
| auction_A | -46.68 | 82.38 | 2897 | 1487 | 101 | 0.924 |
| auction_B | -43.47 | 81.36 | 2921 | 1383 | 100 | 0.932 |
| auction_C_synth | -65.55 | 89.05 | 2282 | 5354 | 116 | 0.844 |
| auction_C_mono | -45.71 | 82.44 | 2921 | 1383 | 100 | 0.927 |

## Which score wins and why

- **Short window winner: `auction_A`** — ret `-5.52%`, DD `71.84%`, trades `89`, skips `58`.
- **Full window winner: `auction_B`** — ret `-43.47%`, DD `81.36%`.
- First-wins wastes edge when a low-priority mono 1h Donch grabs INJ/SUI/WLD before the 4h synth (or vice versa) on the same closed-bar cluster.
- Auction A encodes the storefront economic intent (B3 is the paid core). Auction B helps when solo ret÷DD ranking disagrees with book labels (e.g. a hot FIVE leg), but needs OOS scores — here solos are same-window (optimistic).
- Variant C matters mainly on mono↔synth ties inside B3; cross-book FIVE↔synth quote clashes are rarer but real under symbol-lock.

## Implementation sketch (research → production later)

Do **not** ship unless product asks. Minimal touch list:

1. `backend/src/backtest/engine.ts`
   - Extend `buildEvents` / per-`timeMs` entry gate: collect flat+signal candidates, run `resolveSymbolAuction(candidates)`, losers count `skippedByPairLock`.
   - New request fields: `pairAuctionMode?: 'off'|'recipe'|'expectancy'|'synth'|'mono'`, `recipePriorityByBook?`, `expectancyByStrategyId?`.
2. `backend/src/bot/strategy.ts` + `cycle/autoRun.ts`
   - Per `api_key` cycle: phase-1 dry signal collection; phase-2 auction; phase-3 execute winners only (replaces lock-race first-wins).
3. `backend/src/bot/strategy/normalize.ts` — reuse `getStrategyExchangeSymbols`.
4. Config: `PAIR_AUCTION_MODE` alongside `PAIR_LOCK_SCOPE`; keep symbol-lock as hard constraint, auction only ranks simultaneous candidates.
5. Parity tests: same seed/scores → identical BT vs live deferred counts.

## Confidence / limitations

| Item | Note |
|---|---|
| Confidence | **Medium-low for absolute ret/DD**; **medium-high for relative ranking** among variants on this sleeve |
| Candle source | Bitget public futures (not WEEX/hybrid pack); synth ratio OHLC is an envelope proxy |
| Strategies | Conflict subset proxies — not system 205 remat; momentum_tv is Donch proxy |
| Capital | `$1000` shared, not full P1 `$20k` multi-book OP |
| Expectancy B | Same-window solo scores (in-sample); production needs stamped snapshots / rolling OOS |
| Missing full BT | No local hybrid packs / DB; full `runBacktest` P1 stamp not runnable in this VM |
| Script | `scripts/hybrid/research_tick_auction_aug2026.py` |
| Raw JSON | `docs/TICK_AUCTION_RESEARCH_AUG2026_summary.json` (mirror under gitignored `results/tick_auction_research_aug2026/summary.json`) |

## Current vs proposed (behavioral)

| | Current | Proposed tick-auction |
|---|---|---|
| Live | Concurrent cycle; first lock acquirer wins | Collect candidates → score → winners enter, losers defer |
| BT | Seeded shuffle on same `timeMs` then first lock | Deterministic score order on same `timeMs` |
| Lock scope | Symbol-lock default (mono↔synth block) | Unchanged; auction only replaces random/race among conflicts |

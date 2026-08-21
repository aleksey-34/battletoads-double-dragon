# Tick-auction vs first-wins symbol-lock research (Aug 2026)

Research only — **no production auction shipped**. Redo of aborted cloud research on branch `cursor/tick-auction-research-7aeb`.

## Verdict

| Question | Answer |
|----------|--------|
| Does auction recover the fair-book pair→symbol-lock ret drop? | **Only a small slice.** VPS A/B lost **2141 pp** (5102% → 2961%). Auction ceiling ≈ **≤300 pp** (~14.0% of the gap). |
| Reintroduce double exposure? | **No** — symbol-lock stays; auction only ranks simultaneous candidates while the symbol is free. |
| Best score on conflict sleeve | Short `2026-07-30..2026-08-19`: **auction_A**. Full `2024-03-17..2026-08-19`: **auction_B** (+7.92 pp vs first_wins on the sleeve). |
| Better lever than auction | Recipe **dedup** of contended symbols (INJUSDT, JUPUSDT, ORDIUSDT, SEIUSDT, SUIUSDT, TIAUSDT, WLDUSDT), not tie-break scoring. |

## Method

1. **Code paths (current first-wins)**
   - Live symbol-lock: `backend/src/bot/strategy.ts` — `PAIR_LOCK_SCOPE` default = symbol; `acquireApiKeyPairEntryLock` then cross-TS hold check via `getStrategyExchangeSymbols`.
   - Live concurrency: `backend/src/bot/strategy/cycle/autoRun.ts` (`STRATEGY_CYCLE_CONCURRENCY`, default 16) → first strategy to pass lock/OP wins (race).
   - BT parity: `backend/src/backtest/engine.ts` `isPairLocked` + `buildEvents` seeded random tie-break (`pairLockSeed`) on same `timeMs`.

2. **Prior VPS evidence (cited, not re-stamped here)**
   - Fair-book full depth `2024-03-17..2026-08-19`: pair-lock vs symbol-lock (table below).
   - Recipe P1–P6 `ab_stamp_symbol_lock_all_portfolios.mjs` also showed large ret drops under symbol-lock; in-repo `snapshots_hamfive_aug2026.json` still at pair-/pre-lock shelf levels (P1 **5804%**).

3. **Overlap graph (static, recipe + B3 audit)**
   - Fair/P1 membership: sharedB3 (21) + ham4 + five4 + stocks12 = **41 legs**.
   - Symbol-lock edges vs pair-lock edges; occupancy vs same-tick conflict mass.

4. **Offline conflict-sleeve replay** (this VM)
   - No `results/hybrid_candle_bundle_*`, no `database.db*` → cannot run full `runBacktest` / nightly stamp.
   - Public **Bitget USDT-M** candles → `results/tick_auction_research_aug2026/candles/`.
   - Conflict subset only (B3 mono↔synth + FIVE JUP), shared cash `1000` USDT, lot ~10–15%, commission `8.0` bps RT.
   - Variants: `first_wins` (seed `1759827600` shuffle) vs `auction_A` (recipe) / `auction_B` (expectancy) / `auction_C_synth` / `auction_C_mono`.

5. **Score definitions**
   - **A (recipe):** book priority b3 **400** > ham **300** > five **200** > stocks **100** (`recipes_hamfive_aug2026.json` order).
   - **B (expectancy):** `10*soloPF + ret÷DD` from lock-free solo runs on the full window (in-sample — optimistic).
   - **C:** prefer synth or mono, recipe as weak tie-break.

## Metric table — VPS fair-book A/B (prior evidence)

| Scope | Lock | totalReturn% | maxDD% | Notes |
|-------|------|-------------:|-------:|-------|
| Copy fair-book full depth | pair | **5102.0** | **46.5** | Dual mono+synth co-hold allowed on shared coins |
| Copy fair-book full depth | symbol | **2961.0** | **37.7** | Default production scope |
| Δ (symbol − pair) | — | **-2141.0** (-41.96%) | **-8.8** | Window `2024-03-17..2026-08-19` |
| P1–P6 recipe stamp | pair → symbol | large ret drops (same direction) | — | `ab_stamp_symbol_lock_all_portfolios.mjs`; AFTER applied to vitrine |
| Committed shelf P1 snap | (pre-/pair-era) | 5804.29 | 31.43 | `snapshots_hamfive_aug2026.json` dateTo 2026-08-13 — **not** symbol-lock AFTER |

## Metric table — fair-book overlap graph

| Portfolio | Legs | Exch. symbols | Multi-owner | Pair edges | Symbol edges | New vs pair | Mono↔synth new | Edge density |
|-----------|-----:|--------------:|------------:|-----------:|-------------:|------------:|---------------:|-------------:|
| P1 fair-like | 41 | 39 | 7 (17.9%) | 1 | 7 | **6** | 6 | 0.0085 |

Contended symbols:

| Symbol | Owners | Sample leg ids |
|--------|-------:|----------------|
| INJUSDT | 2 | `b3_zz1h_INJUSDT, b3_synth_INJUSDT_TIAUSDT` |
| JUPUSDT | 2 | `b3_synth_WLDUSDT_JUPUSDT, five_255460` |
| ORDIUSDT | 2 | `b3_zz1h_ORDIUSDT, b3_mom4h_ORDIUSDT` |
| SEIUSDT | 2 | `b3_zz1h_SEIUSDT, b3_synth_SUIUSDT_SEIUSDT` |
| SUIUSDT | 2 | `b3_zz1h_SUIUSDT, b3_synth_SUIUSDT_SEIUSDT` |
| TIAUSDT | 2 | `b3_synth_INJUSDT_TIAUSDT, b3_mom4h_TIAUSDT` |
| WLDUSDT | 2 | `b3_zz1h_WLDUSDT, b3_synth_WLDUSDT_JUPUSDT` |

Conflict mass over `2024-03-17..2026-08-19` (estimate from graph + entry priors; ~886.0d):

| Mass | Estimate | Share |
|------|---------:|------:|
| Holding / occupancy blocks | ~538 | ~96% |
| Same-tick co-entry races | ~23 | ~4% |

**Read:** sparse graph, but every B3 synth that shares a liquid alt with zz-1h / mom / five is serialized. Almost all skips are “already holding,” not “two flats fired together.”

## Metric table — auction uplift vs the VPS gap (bounds)

| Variant | Plausible fair-book uplift vs symbol-lock first-wins | Rationale |
|---------|-----------------------------------------------------:|-----------|
| A. Recipe `b3 > ham > five > stocks` | **+20…150 pp** | Helps JUP cross-role + future cross-book ties |
| B. Expectancy / PF | **+50…250 pp** (optimistic) | Only if scored SID systematically beats loser |
| C. Prefer synth or mono | **-100…+100 pp** | Sign uncertain without measured PF |
| Oracle combined ceiling | **≲ +300 pp** | Same-tick ceiling (~14.0% of 2141 pp gap) |

**Bottom line:** auction might move symbol-lock fair ret from ~2961% toward ~3111–3261% in a good case — **not** back toward ~5102%. Missing ~1841 pp is **forbidden concurrent exposure**.

## Metric table — offline conflict-sleeve replay (`$1000`)

### Short window `2026-07-30..2026-08-19`

| Variant | totalReturn% | maxDD% | trades | skippedByPairLock | conflictResolutions | PF |
|---|---:|---:|---:|---:|---:|---:|
| first_wins | -6.1 | 71.84 | 88 | 69 | 7 | 0.545 |
| auction_A | -5.52 | 71.84 | 89 | 58 | 7 | 0.585 |
| auction_B | -5.73 | 71.96 | 89 | 58 | 7 | 0.571 |
| auction_C_synth | -5.86 | 71.83 | 89 | 64 | 7 | 0.556 |
| auction_C_mono | -5.58 | 71.84 | 89 | 58 | 7 | 0.585 |

| Variant | Δret pp vs first_wins | ΔDD pp | Δtrades | Δskips |
|---|---:|---:|---:|---:|
| auction_A | 0.58 | 0.0 | 1 | -11 |
| auction_B | 0.37 | 0.12 | 1 | -11 |
| auction_C_synth | 0.24 | -0.01 | 1 | -5 |
| auction_C_mono | 0.52 | 0.0 | 1 | -11 |

### Full window `2024-03-17..2026-08-19`

| Variant | totalReturn% | maxDD% | trades | skippedByPairLock | conflictResolutions | PF |
|---|---:|---:|---:|---:|---:|---:|
| first_wins | -51.39 | 84.51 | 2737 | 2940 | 104 | 0.905 |
| auction_A | -46.68 | 82.38 | 2897 | 1487 | 101 | 0.924 |
| auction_B | -43.47 | 81.36 | 2921 | 1383 | 100 | 0.932 |
| auction_C_synth | -65.55 | 89.05 | 2282 | 5354 | 116 | 0.844 |
| auction_C_mono | -45.71 | 82.44 | 2921 | 1383 | 100 | 0.927 |

| Variant | Δret pp vs first_wins | ΔDD pp | Δtrades | Δskips |
|---|---:|---:|---:|---:|
| auction_A | 4.71 | -2.13 | 160 | -1453 |
| auction_B | 7.92 | -3.15 | 184 | -1557 |
| auction_C_synth | -14.16 | 4.54 | -455 | 2414 |
| auction_C_mono | 5.68 | -2.07 | 184 | -1557 |

Absolute sleeve returns are **not** comparable to fair-book ~2961% (conflict-only book, Bitget proxy, Donch stand-in for momentum_tv). Use **relative ranking / Δpp** only.

## Recipe priority (score A)

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

## Which score wins on the sleeve (and why)

- **Short:** `auction_A` — ret `-5.52%`, DD `71.84%`, skips `58`.
- **Full:** `auction_B` — ret `-43.47%`, DD `81.36%` (**+7.92 pp** vs first_wins).
- First-wins wastes edge when a low-priority mono 1h Donch and a 4h synth race on INJ/SUI/WLD in the same closed-bar cluster.
- Auction A matches storefront economics (B3 is the paid core). Auction B can beat A when solo ret÷DD disagrees with book labels — treat as in-sample optimistic.
- Prefer-synth (C) was worst on the full sleeve under symbol-lock in this redo.

## Confidence

| Claim | Confidence | Why |
|-------|------------|-----|
| VPS A/B magnitude (~5102→2961, DD 46.5→37.7) | **High** | Direct prior VPS measurement; cited as prior evidence |
| Most gap = dual-exposure removal | **High** | Graph: 6/7 new edges are mono↔synth; occupancy ≫ same-tick |
| Auction recovers ≲~300 pp of gap | **Medium** | Order-of-magnitude from conflict-mass mix + sleeve Δ; not a full fair stamp |
| Sleeve absolute ret/DD | **Low** | Bitget ≠ WEEX hybrid; proxies; $1000 conflict subset |
| Sleeve variant ranking (A/B > first_wins > C_synth) | **Medium-high** | Replayed offline; relative only |
| Full `runBacktest` P1 auction stamp | **Not run** | No hybrid packs / DB in this cloud VM |

## Implementation sketch (research → production later)

Do **not** ship unless product asks. Minimal touch list:

1. `backend/src/backtest/engine.ts` — per-`timeMs` collect candidates → `resolveSymbolAuction`; losers → `skippedByPairLock`. Fields: `pairAuctionMode`, `recipePriorityByBook`, `expectancyByStrategyId`.
2. `backend/src/bot/strategy.ts` + `cycle/autoRun.ts` — per api_key: dry signals → auction → execute winners (replace lock-race).
3. Reuse `getStrategyExchangeSymbols`; keep `PAIR_LOCK_SCOPE=symbol` as hard constraint.
4. Config `PAIR_AUCTION_MODE` beside `PAIR_LOCK_SCOPE`.
5. Parity tests: identical deferred counts BT vs live for same scores.

## Artifacts

| Path | Role |
|------|------|
| `scripts/hybrid/research_tick_auction_aug2026.py` | Harness (Bitget fetch + sleeve replay + overlap bounds) |
| `docs/TICK_AUCTION_RESEARCH_AUG2026_summary.json` | Machine-readable tables |
| `results/tick_auction_research_aug2026/` | Candles + summary (gitignored under `results/`) |

## Current vs proposed

| | Current | Proposed tick-auction |
|---|---|---|
| Live | Concurrent cycle; first lock acquirer wins | Collect → score → winners enter, losers defer |
| BT | Seeded shuffle on same `timeMs` then first lock | Deterministic score order on same `timeMs` |
| Lock scope | Symbol-lock default (mono↔synth block) | **Unchanged** — no double exposure |

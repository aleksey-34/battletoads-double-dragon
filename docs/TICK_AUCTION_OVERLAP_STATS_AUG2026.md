# Tick-auction overlap stats (Aug 2026)

Research only — no deploy. Quantifies mono↔synth / multi-leg **symbol conflicts** on the hamfive fair book, and whether a **tick auction** (vs first-wins) could recover the historical pair-lock → symbol-lock return drop.

## Verdict

| Question | Answer |
|----------|--------|
| Overlap density | **Low graph density, high local contention.** Fair/P1: 41 legs, 39 exchange symbols, **7 multi-owner symbols (17.9%)**, **7 symbol-lock edges** vs **1 pair-lock edge**. Edge density ≈ **0.85%**. |
| What symbol-lock newly blocks | **6 new edges** (all mono↔synth). Only pre-existing pair-lock edge is ORDI 1h zz ↔ ORDI 4h momentum. |
| Concurrent conflict shape | Dominated by **holding / occupancy** (~**540** est. blocked entries over full depth), not same-tick races (~**23**, **~4%** of conflict mass). |
| Auction vs first-wins uplift | **Cannot recover most of the ~42% relative ret drop.** Order-of-magnitude: **+10² pp**, not **+10³ pp**, on the fair-book gap (~5100% → ~2960%). |
| Better levers | Recipe **dedup** of contended symbols (INJ/SUI/WLD/SEI/TIA/JUP), not auction scoring. |

## 1. Fair-book / recipe membership

### Copy fair book (`nightlyStorefrontRoll.ts`)

- Cards: **P1 / P2 / P3** → api keys `Copy_Alex1` / `icopy1-api` / `arcopy1`
- Roles kept: **`b3`, `ham`, `five`, `stocks`** (`FAIR_BOOK_ROLES`)
- Capital: **$1000**; `enablePairLock: true`; default `PAIR_LOCK_SCOPE` = **symbol** (rollback: `pair`)
- Recipe source: `scripts/hybrid/portfolio_six_data_jul2026/recipes_hamfive_aug2026.json`
- Legs catalog: `.../hamfive_legs_aug2026.json`

### Shared B3 (system `205`, 21 legs)

From `docs/B3_ZZ_BREAKOUT_1H_AUDIT_AUG2026.md` + WEEX-safe synth pairs used in runtime comments:

| Sleeve | n | Mode | Symbols / pairs |
|--------|--:|------|-----------------|
| zz_breakout 1h | 8 | mono | SUI, DOGE, INJ, NEAR, ARB, WLD, ORDI, SEI |
| ZZ_Fast 4h | 5 | synth | BCH/APE, INJ/TIA, SUI/SEI, WLD/JUP, ZEN/ALGO |
| momentum_scalp_tv 4h | 8 | mono | ADA, ORDI, BNB, XRP, EIGEN, COMP, TIA, ONDO |

> Cloud VM has **no SQLite** with live SIDs for system 205; B3 composition is reconstructed from the audit + known WEEX-safe quotes. Ham/five/stocks SIDs come from `hamfive_legs_aug2026.json`.

### Addon books (recipe universes)

| Book | P1 (thin) | P2–P6 (full WEEX) |
|------|-----------|-------------------|
| ham | 4 mono ZZ (ENA, TAO, THETA, ZEC) | +H, HOME, 1000PEPE, PAXG |
| five | 4 mono MRS (MANTA, JUP, KAS, JTO) | +APT, ETHFI |
| stocks | 12 mono zz_breakout 4h equities (AMZN…UBER) | same |

**P1 fair-like size:** 21 + 4 + 4 + 12 = **41 legs**. **P2–P6:** **47 legs**.

Committed stamp snaps (`snapshots_hamfive_aug2026.json`, dateTo 2026-08-13) still show pre-/pair-era shelf numbers (P1 **5804%**). Symbol-lock A/B script exists (`scripts/hybrid/ab_stamp_symbol_lock_all_portfolios.mjs`) but **no stamped JSON artifact is in-repo**.

## 2. Symbol overlap graph

Lock key logic (live + BT):

- **Pair-lock:** `mono:BASE` vs `synthetic:BASE/QUOTE` — different keys ⇒ **no** mutual block.
- **Symbol-lock (default):** `getStrategyExchangeSymbols` — mono `{BASE}`, synth `{BASE,QUOTE}` — any shared exchange symbol blocks.

### Contended symbols (fair / P1–P6 identical clique)

| Symbol | Owners | New under symbol-lock? |
|--------|--------|------------------------|
| INJUSDT | b3 zz 1h mono ↔ b3 ZZ_Fast INJ/TIA | **yes** (mono↔synth) |
| SUIUSDT | b3 zz 1h mono ↔ b3 ZZ_Fast SUI/SEI | **yes** |
| WLDUSDT | b3 zz 1h mono ↔ b3 ZZ_Fast WLD/JUP | **yes** |
| SEIUSDT | b3 zz 1h mono ↔ quote of SUI/SEI | **yes** |
| TIAUSDT | b3 mom 4h mono ↔ quote of INJ/TIA | **yes** |
| JUPUSDT | five MRS mono ↔ quote of WLD/JUP | **yes** (cross-role) |
| ORDIUSDT | b3 zz 1h ↔ b3 mom 4h | **no** (already `mono:ORDIUSDT` pair-lock) |

Ham and stocks symbols are **disjoint** from this clique in the current recipe. Cross-book contention is **only JUP** (five ↔ b3 synth quote).

### Density table

| Portfolio | Legs | Exch. symbols | Multi-owner syms | Pair edges | Symbol edges | New vs pair | Mono↔synth edges | Edge density |
|-----------|-----:|--------------:|-----------------:|-----------:|-------------:|------------:|-----------------:|-------------:|
| P1 (fair-like) | 41 | 39 | 7 (17.9%) | 1 | 7 | **6** | 6 | 0.0085 |
| P2–P6 | 47 | 45 | 7 (15.6%) | 1 | 7 | **6** | 6 | 0.0065 |

**Read:** sparse portfolio graph, but **every** B3 synth leg that shares a liquid alt with a 1h Donchian or mom/five mono is now serialized. That is exactly the exposure the Aug 18–20 churn audit flagged (INJ/SUI/WLD double books).

## 3. How often concurrent opens would conflict

No local trade/BT artifact with `skippedByPairLock` counts was available in this cloud checkout (no `results/hybrid_candle_*`, no `tmp/ab_stamp_*.json`, no DB). Estimates below are from **code semantics + recipe graph + entry/hold priors** calibrated to `docs/B3_ZZ_BREAKOUT_1H_AUDIT_AUG2026.md` (~1.5 zz-1h entries/day across 8 legs).

Window: **2024-03-17 → 2026-08-19** (~886d), matching `ab_stamp_symbol_lock_all_portfolios.mjs` defaults.

### Model (NEW symbol-lock edges only)

| Mass | Estimate over full depth | Share |
|------|-------------------------:|------:|
| Holding / occupancy blocks | **~538** | **~96%** |
| Same-tick co-entry races | **~23** | **~4%** |

Hottest new edges (holding blocks est.):

1. **TIA** — synth INJ/TIA ↔ mom TIA (~149)
2. **JUP** — synth WLD/JUP ↔ five JUP (~106) — only cross-role edge
3. **INJ / SUI / WLD / SEI** — zz 1h ↔ matching synth (~71 each)

### Code path notes

- BT: `enablePairLock` + `isPairLocked` increments `skippedByPairLock`; same-bar ties use **seeded RNG** (`pairLockSeed`), not raw `strategyIndex` order.
- Live: `STRATEGY_CYCLE_CONCURRENCY` (default **16**) + `acquireApiKeyPairEntryLock` → **true first-wins** race among candidates that reach the lock while the symbol is free.
- Fair pack already surfaces `skippedPair` in snapshot metadata when a stamp runs.

**Implication:** almost all symbol-lock skips are “other SID already open on this coin,” not “two SIDs fired on the same closed bar.”

## 4. Auction vs first-wins vs the historical ret drop

### Historical A/B (stated; not re-stamped here)

| Run | Scope | Pair-lock | Symbol-lock | Δ |
|-----|-------|----------:|------------:|---|
| Copy fair-book full depth | $1000, live roles b3/ham/five/stocks | **~+5100%** | **~+2960%** | **≈ −2140 pp (−42% rel.)** |
| P1–P6 shelf stamp | `ab_stamp_symbol_lock_all_portfolios.mjs` | large drops (same direction) | — | — |

In-repo snaps still at pair-/pre-lock levels (P1 5804%); treat the ~5100/2960 fair-book pair as the **working A/B** for this note until AFTER snaps are committed.

### Can auction recover that gap?

**No — not at the order of magnitude of the drop.**

Decomposition of the ~2140 pp gap:

1. **Structural serialization (~majority)**  
   Under symbol-lock you **cannot** hold mono INJ and synth INJ/TIA together. Pair-lock fair-book return included that dual exposure. An auction still allows **only one** winner while the lock is held. Recovering dual PnL would require **dropping symbol-lock** or **deduping the recipe**, not better tie-breaks.

2. **Same-tick winner choice (~few percent of conflict mass)**  
   ~4% of estimated conflicts are simultaneous entries while flat. Even if first-wins / RNG always picks the worse SID and an oracle auction always picks the better one with **2×** path expectancy, uplift is **O(10–10²) return points**, not O(10³).

3. **Live vs BT first-wins mismatch**  
   Auction is still valuable for **parity** (live race vs BT shuffle) and for **preferring b3 over five on JUP**, but that is a **hygiene / small-edge** story, not a path back to ~5100%.

### Candidate auction uplift hypothesis

| Variant | Plausible fair-book uplift vs current symbol-lock first-wins | Rationale |
|---------|--------------------------------------------------------------|-----------|
| A. Book priority `b3 > ham > five > stocks` | **~+20–150 pp** | Helps JUP + any future cross-role ties; tiny vs gap |
| B. Expectancy / PF score | **~+50–250 pp** (optimistic) | Only if scored SID systematically beats loser on contended alts |
| C. Prefer synth (or mono) | **~±100 pp**, sign uncertain | 1h Donchian churn vs 4h ZZ — direction needs measured PF |
| Combined oracle | **≲ +300 pp** (≲ **~15% of the 2140 pp gap**) | Same-tick ceiling |

**Bottom line:** auction might move symbol-lock fair ret from ~2960% toward ~3000–3200% in a good case — **not** back toward ~5100%. The missing ~2000 pp is **forbidden concurrent exposure**, not mis-ordered ticks.

## 5. Risks

1. **Phantom pair-lock return** — ~5100% embeds mono+synth co-holding on the same coin; exchange-safe books cannot keep it.
2. **Score misspecification** — static PF can pick the wrong SID in regime shifts; worse than RNG.
3. **Starvation** — hard `b3 > five` can zero five’s JUP sleeve whenever WLD/JUP is active.
4. **Cycle latency** — gather-all-then-auction fights `STRATEGY_CYCLE_CONCURRENCY` throughput; must stay per-api_key and bounded.
5. **BT/live divergence** — if auction ships only in BT or only live, stamps lie again.
6. **Recipe churn** — wrong synth quotes (if ZEN/ALGO etc. differ on VPS vs this reconstruction) shift the graph; re-run against live `system_id=205` before implementation.
7. **Sibling work** — parallel agent researching full metric tables (`TICK_AUCTION_RESEARCH_AUG2026`); this doc is the **overlap / uplift-bounds** half.

## 6. Recommended next measurements (still research)

1. On VPS: run `SKIP_CANDLE_APPEND=1 node scripts/hybrid/ab_stamp_symbol_lock_all_portfolios.mjs` and commit `tmp/ab_stamp_symbol_lock_all_portfolios.json` + PAIR_LOCK snaps.
2. Dump fair `skippedPair` under `PAIR_LOCK_SCOPE=pair` vs default symbol for Copy_Alex1 full depth.
3. Replay contended SIDs only (INJ/SUI/WLD/SEI/TIA/JUP/ORDI) with auction A/B/C on a short window; compare `skippedByPairLock` and ret — expect small Δ.
4. Recipe experiment: drop zz-1h on INJ/SUI/WLD (audit option) **or** change WLD quote away from JUP — measure how much of the 2140 pp returns **without** dual-holding.

## Sources

- `backend/src/bot/strategy/normalize.ts` — `getStrategyExchangeSymbols`
- `backend/src/bot/strategy.ts` — cross-TS symbol lock + mutex
- `backend/src/bot/strategy/cycle/autoRun.ts` — `STRATEGY_CYCLE_CONCURRENCY`
- `backend/src/backtest/engine.ts` — `isPairLocked`, seeded tie-break, `skippedByPairLock`
- `backend/src/research/nightlyStorefrontRoll.ts` — fair book roles / Copy_Alex1
- `scripts/hybrid/portfolio_six_data_jul2026/recipes_hamfive_aug2026.json`
- `scripts/hybrid/portfolio_six_data_jul2026/hamfive_legs_aug2026.json`
- `scripts/hybrid/ab_stamp_symbol_lock_all_portfolios.mjs`
- `docs/B3_ZZ_BREAKOUT_1H_AUDIT_AUG2026.md`
- Commits: `ea415d3` (symbol-lock), `7809d8d` (A/B stamp), `6f1a33f` (seeded pair-lock tie-break)

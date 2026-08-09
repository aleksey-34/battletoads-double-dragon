# BT ↔ runtime honesty audit (Aug 2026)

Internal truth note. Not a storefront stamp. Not client-facing marketing.

## Plain verdict

1. **July “MRS” cards on the vitrine are mislabeled.** Those numbers are **DoubleDragon (channel + center stop)** on the same legs, because `MeanReversion` was not recognized by the stamp-time engine and fell through to `DD_BattleToads`. Forced-DD reproduces July MRS books to the decimal (1899.17 / 2068.9 / 6645.95).
2. **This is not “MRS broke.”** Today’s engine runs real MeanReversion/MRS2 and prints **higher** BT returns on the same recipe. Gap = wrong label + stale dist at stamp time.
3. **B3 still matches July** (`630.81% / 22.95%`). Candles + equity-sum method are fine for that book.
4. **What clients trade now ≠ July “MRS” shelf.** Live mono MRS uses sticky limits + often **market** entry on closed-bar touch. July shelf was DD under an MRS name.
5. **Stocks sleeve is not stamp-safe.** Path-aware fills lose (strict −65% / lenient −21%). Join-window maker/taker already negative. Published +47% is void.
6. **Portfolio “totals” are research fiction vs live wallet:** per-book equity-sum, OP per book, `capital_weight` as lot scale (not capital carve-out), mixed fee models (B3 0.1/0.05 vs MRS 0.036/0).
7. **Material optimism elsewhere:** close±slip fills for DD/ZZ/StatArb; synth wick envelope wider than simultaneous ratio; CT HiDeep RSI exits live-only; funding default 0; pair-lock optional in many BTs.
8. **Live MRS config landmine was real and fixed** (`mrs2_config_json` empty + DD zscore clamps on materialize). That was a live bug, orthogonal to the July DD mislabel.

## Severity

| Sev | Item | Action |
|-----|------|--------|
| Critical | July MRS = DD under MRS label | Document / freeze claims; do not “fix” by restamping higher MRS |
| Critical | Optimistic stamps sold as live-equivalent | Gate stamps; match BT flags to live or banner “not live-equivalent” |
| High | MRS same-bar exit default `allow` in BT; live never entry→exit same cycle | Document; set research default closer to live before sellable MRS stamps |
| High | Live MRS market-after-touch; postOnly not set on exchange Limit | Document or harden execution |
| High | Stocks path fills / short window / void +47% | Do not stamp |
| High | Equity-sum ≠ shared margin; capital_weight semantics | Fix accounting before portfolio restamp |
| Medium | Synth wick envelope; CT RSI exit BT gap; ZZ pivot wick/close; funding 0 | Document; harden before next catalog |
| Low | B3 match | Keep as regression anchor |

## Sources

- Explore: MRS July gap — forced-DD decimal match  
- Explore: BT optimism catalog across families  
- Explore: Live vs BT MRS/B3  
- Judge synthesis  
- Artifacts: `results/stocks_hf_research_aug2026/{path_accurate_rebaseline,staggered_portfolio_bt,stamp_candidate_aug2026}.*`

## Shipped fixes (2026-08-09 night)

1. `normalizeStrategyType` **throws** on unknown types (no silent DD).
2. MRS2 BT same-bar default = **`block`** (live-closer); `MRS2_BT_SAME_BAR_EXIT=allow` for legacy research.
3. Admin preferReal portfolio default aggregation = **`shared_margin`** (one stream + per-book OP). `portfolioAggregation=equity_sum` keeps the old independent-books path.
4. Exchange-fill sync stores **`is_maker`** + logs `[mrs2-maker-fill]` when maker.
5. Truth note: `docs/JULY_MRS_WAS_DD_TRUTH_AUG2026.md`.

## Rematerialize

**Not required** for copy trio after SQL `mrs2_config` repair. Full rematerialize risks orphan closes / duplicates — avoid for param-only refresh.

## Next (ordered)

1. Internal/comms: July MRS = DD mislabel (cite decimal repro).
2. Freeze sellable MRS/stocks stamps until BT defaults match live contract (or explicit research banner).
3. Guard: unknown `strategy_type` must **fail**, never silently become DD.
4. Portfolio accounting honesty (shared margin or labeled equity-sum; capital_weight meaning).
5. Forward maker-fill recorder for MRS mono before any “production” sleeve number.

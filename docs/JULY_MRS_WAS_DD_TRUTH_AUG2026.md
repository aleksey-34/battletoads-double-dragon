# July 2026 MRS vitrine = DD (truth note)

**Date:** 2026-08-09  
**Audience:** internal / team only

## What happened

The July portfolio stamp labeled a book **MRS / MeanReversion**, but the backtest engine that produced those numbers did **not** recognize `strategy_type=MeanReversion` (only `MRS2` at that build). Unknown types fell through to **`DD_BattleToads`**.

Falsification (same legs / window / OP / lot / candles):

| Book | July stamp | Forced DD | Current MeanReversion |
|------|----------:|----------:|----------------------:|
| Cons top20 | **1899.17** | **1899.17** | ~4510 |
| Bal top30 | **2068.9** | **2068.9** | ~15k |
| Agg top30 | **6645.95** | **6645.95** | ~24k |

B3 on the same stamp still matches (`630.81%`) — candles/method OK; only the MRS label was wrong.

## Live copy clients (arcopy1 / icopy1-api / Copy_Alex1)

- DB type is **`MeanReversion`**, not DD. They were **not** running Donchian DD on MRS legs.
- Real live bug was empty `mrs2_config_json` + DD zscore clamps → broken MRS bands (fixed `cd59826` + SQL repair).
- They also run `zz_breakout` / `ZZ_Fast` / momentum — those are separate books.

So: **vitrine lied (DD under MRS name). Live MRS was broken mean-reversion, not double-trend.**

## Guard (shipped)

`backend/src/backtest/engine.ts` `normalizeStrategyType` now **throws** on unknown types instead of silent DD fallback.

## Do not

- Restamp July MRS cards with current MeanReversion numbers and call it “fixed”
- Tell clients “you were on DD and now MRS will print July×3”

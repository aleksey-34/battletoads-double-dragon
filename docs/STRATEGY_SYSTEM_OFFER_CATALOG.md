# Strategy / Trading System / Offer Catalog

## Purpose
This document is the admin reference for:
- what strategy families exist,
- how trading systems are composed,
- how offer metrics are interpreted,
- how to run Research tasks in `light` or `heavy` mode,
- how to generate high-frequency systems for rhythm-driven products.

## Execution Modes
All new sweep entry points support `mode`:
- `light`: conservative server load, smaller task batches.
- `heavy`: maximum throughput, broader task processing.

Applied in:
- `POST /api/research/tasks/run-sweep`
- `POST /api/research/tasks/run-sweep/manual`
- `POST /api/research/scheduler/daily_incremental_sweep/backfill-now`
- `POST /api/research/tasks/high-frequency-system`

Operational note:
- `daily_incremental_sweep` is still a snapshot-sync layer (fast import path).
- for full historical recompute, use heavy sweep workflow and then re-import/refresh catalog.

## Strategy Families (Current)
### DD_BattleToads
- Type: breakout/trend-following.
- Typical params: `price_channel_length`, `take_profit_percent`, `detection_source`.
- Use case: directional momentum across mono and synthetic pairs.

### stat_arb_zscore
- Type: mean-reversion spread model.
- Typical params: `zscore_entry`, `zscore_exit`, `zscore_stop`.
- Use case: synthetic pair dislocations and convergence trades.

### zz_breakout
- Type: structural breakout variant.
- Use case: directional bursts and regime transitions.

## Trading System Assembly Rules
Current admin trading system controls:
- member list with per-member `weight`, `role`, enable/disable,
- live activation and safe apply,
- backtest run from Trading Systems UI,
- liquidity suggestions and monitoring overlays.

Recommended naming pattern:
- `HF LIGHT 10tpd YYYY-MM-DD`
- `HF HEAVY 10tpd YYYY-MM-DD`
- `BALANCED PF-DD YYYY-MM-DD`

## New Frequency Diagnostics
Endpoint:
- `GET /api/trading-systems/:apiKeyName/:systemId/frequency-diagnostics`

Returns:
- current estimated trades over sweep window,
- estimated trades/day,
- min/max range among enabled members,
- `adjustable` flag,
- `nearTarget` flag,
- candidate suggestions from sweep.

UI usage:
- Trading Systems page shows if frequency is adjustable near the selected target.

## New High-Frequency Generation Task
Endpoint:
- `POST /api/research/tasks/high-frequency-system`

Input:
- `apiKeyName`
- `mode: light | heavy`
- `targetTradesPerDay`
- `maxMembers`
- `minPf`, `maxDd`

Output:
- created trading system,
- selected member diagnostics,
- preview backtest summary,
- candidate sample for manual follow-up.

## Offer Layer Improvement Direction
Current offer stack is metric-driven (ret/pf/dd/wr/trades/score). To improve attractiveness and clarity (inspired by managed-strategy platforms):
- add concise strategy card narrative (style + market regime fit),
- expose risk posture and expected rhythm (`trades/day` and variance band),
- add consistency block (rolling windows, drawdown behavior),
- add transparent constraints (max DD guardrail and PF floor),
- show simple onboarding path: conservative/balanced/aggressive presets.

## Client Product Behavior (Current vs Target)
### Strategy Client
Current:
- chooses offers,
- sets risk + trade-frequency preference,
- gets preview/materialization.

Target extension:
- user-composed mini trading systems by plan limits,
- sweep-backed portfolio preview without heavy runtime compute.

### Algofund Client
Current:
- managed mode with request flow and risk controls.

Target extension:
- select between admin-published managed trading systems,
- inspect short profile + backtest summary before selection.

## Admin Checklist (Daily)
1. Check scheduler status and gap.
2. Run `backfill-now` in `light` during active trading hours.
3. Run `heavy` windows off-peak.
4. Generate at least one high-frequency candidate TS and compare diagnostics.
5. Promote only systems that keep acceptable PF/DD while increasing trade rhythm.

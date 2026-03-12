# TODO - VPS Real Validation and Trading System Build

## Current Status (2026-03-11)
- VPS code is updated and backend service is running.
- New analytics/scheduler code is active.
- `BTDD_D1` A+B run succeeded on VPS.
- Trading system created and active: `AB BTDD_D1 Mono Portfolio`.
- Selected members: `TRUUSDT`, `GRTUSDT`, `INJUSDT`.

## Progress Checklist
- [x] Phase 1 - Bootstrap Candidate Strategies
- [x] Phase 2 - Baseline Backtests
- [x] Phase 3 - Optimize Top-3
- [x] Phase 4 - Build Trading System
- [x] Phase 5 - Live Demo Soak (24-48h)

## Main Goal
- First: validate strategy behavior on real market data (demo mode, controlled risk).
- Then: build a real trading system from top performers.

## One-Command Run (VPS)
Run from repository root on VPS:

```bash
AUTH_PASSWORD='<YOUR_DASHBOARD_PASSWORD>' \
BASE_URL='http://127.0.0.1:3001/api' \
API_KEY_NAME='BTDD_D1' \
node scripts/run_btdd_d1_ab_http.mjs
```

Output file after run:
- `results/btdd_d1_ab_results.json`

## One-Command Phase 5 Check (VPS)
Run from repository root on VPS:

```bash
AUTH_PASSWORD='<YOUR_DASHBOARD_PASSWORD>' \
BASE_URL='http://127.0.0.1:3001/api' \
API_KEY_NAME='BTDD_D1' \
node scripts/run_btdd_d1_phase5_http.mjs
```

If summary shows `Liquidity scan: systems=0`, run with discovery auto-enable:

```bash
AUTH_PASSWORD='<YOUR_DASHBOARD_PASSWORD>' \
BASE_URL='http://127.0.0.1:3001/api' \
API_KEY_NAME='BTDD_D1' \
ENABLE_DISCOVERY='1' \
DISCOVERY_INTERVAL_HOURS='6' \
node scripts/run_btdd_d1_phase5_http.mjs
```

Output file after run:
- `results/btdd_d1_phase5_<timestamp>.json`

## Execution Plan

### Phase 1 - Bootstrap Candidate Strategies (VPS)
1. Create 5 mono candidates for `BTDD_D1`:
   - `STXUSDT`
   - `TRUUSDT`
   - `VETUSDT`
   - `GRTUSDT`
   - `INJUSDT`
2. Base params:
   - `strategy_type=DD_BattleToads`
   - `market_mode=mono`
   - `interval=4h`
   - `price_channel_length=50`
   - `take_profit_percent=7.5`
   - `detection_source=close`
3. Keep `is_active=false` until backtests are done.
4. Check in dashboard: `BTDD_D1` must show 5 strategies.

### Phase 2 - Baseline Backtests (VPS)
Run 5 single-strategy backtests with:
- `bars=336`
- `initialBalance=10000`
- `commission=0.1%`
- `slippage=0.05%`
- `funding=0`

Pass criteria (minimum):
- `winRate >= 45%`
- `profitFactor >= 1.0`
- `maxDrawdown <= 25%`

Ranking score:
- `score = totalReturn + profitFactor*10 + winRate*0.05 - maxDrawdown*0.7`

### Phase 3 - Optimize Top-3
For best 3 symbols from baseline:
- Grid:
  - `price_channel_length in [30, 50, 70]`
  - `take_profit_percent in [5, 7.5, 10]`
- Save best pair of params per symbol.

### Phase 4 - Build Trading System
1. Create system: `AB BTDD_D1 Mono Portfolio`.
2. Add top 3 optimized strategies as members.
3. Weights:
   - Core winners `1.0-1.2`
   - Satellite `0.8`
4. Activate system in demo mode.

### Phase 5 - Live Demo Soak (24-48h)
1. Keep system active in demo.
2. Observe:
   - monitoring snapshots
   - reconciliation reports
   - liquidity suggestions
3. If drift is high:
   - adjust params or pause weak members
   - rerun backtests with last 14 days

Phase 5 check #1 (2026-03-11):
- Active strategies: `3`
- Active systems: `1`
- Discovery-enabled systems: `1`
- Reconciliation: `processed=3`, `failed=0`
- Liquidity scan: `systems=1`, `suggestionsCreated=3`
- Critical/pause recommendations: `0`
- Stored reports: `6`
- New suggestions: `3`
- Snapshot: `results/btdd_d1_phase5_2026-03-11T05-36-42-152Z.json`

Decision after check #1:
- Continue soak for next 24-48h.
- No strategy pause needed now.
- Review liquidity suggestions manually before applying.

Phase 5 check #2 (2026-03-11 19:29 UTC):
- Active strategies: `3`
- Active systems: `1`
- Discovery-enabled systems: `1` (`autoEnabled=false`)
- Reconciliation: `processed=3`, `failed=0`
- Liquidity scan: `systems=1`, `suggestionsCreated=0`
- Critical/pause recommendations: `0`
- Stored reports: `10`
- New suggestions: `4`
- Snapshot: `results/btdd_d1_phase5_2026-03-11T19-29-38-456Z.json`

Decision after check #2:
- Keep system active unchanged.
- Continue soak to full 24-48h window.
- Next checkpoint (check #3): run phase5 script again after ~12h.

Phase 5 check #3 (2026-03-12 03:25 UTC):
- Active strategies: `2`
- Active systems: `1`
- Discovery-enabled systems: `1` (`autoEnabled=false`)
- Reconciliation: `processed=2`, `failed=0`
- Liquidity scan: `systems=1`, `suggestionsCreated=0`
- Critical/pause recommendations: `1`
- Flagged: `AB_DONCH TRUUSDT` (`rec=pause`, `severity=critical`, `samples=3`)
- Stored reports: `10`
- New suggestions: `4`
- Snapshot: `results/btdd_d1_phase5_2026-03-12T03-25-26-157Z.json`

Decision after check #3:
- TRU strategy is already paused, but still appears in system analysis because member remains enabled.
- Keep 2-strategy soak running.
- Disable TRU member in trading system to remove stale critical signal from member analysis.
- Re-check phase5 after member disable.

Phase 5 check #4 (2026-03-12 15:06 UTC):
- Active strategies: `2`
- Active systems: `1`
- Discovery-enabled systems: `1` (`autoEnabled=false`)
- Reconciliation: `processed=2`, `failed=0`
- Liquidity scan: `systems=1`, `suggestionsCreated=0`
- Critical/pause recommendations (all members): `0`
- Critical/pause recommendations (active only): `0`
- Stored reports: `10`
- New suggestions: `8`
- Snapshot: `results/btdd_d1_phase5_2026-03-12T15-06-39-968Z.json`

Decision after check #4:
- Phase 5 is complete.
- Active 2-member system is stable.
- Continue running demo-live on `GRTUSDT` + `INJUSDT`.
- Treat TRU as paused candidate for re-entry, not as active system member yet.

If any checkpoint shows `critical/pause recommendations > 0`:
1. Re-run phase5 script (latest version) to print the exact flagged strategy.
2. Pause only the flagged strategy (do not stop entire system):
   - `PUT /api/strategies/BTDD_D1/:strategyId` with `{ "is_active": false }`
3. Continue soak with remaining members for 12h and re-check.
4. Re-optimize paused strategy offline, then re-add only if stable.

Helper command A (pause first active critical strategy):

```bash
AUTH_PASSWORD='<YOUR_DASHBOARD_PASSWORD>' \
BASE_URL='http://127.0.0.1:3001/api' \
API_KEY_NAME='BTDD_D1' \
MAX_TO_PAUSE='1' \
DISABLE_MEMBER='0' \
node scripts/run_btdd_d1_apply_critical_pause_http.mjs
```

Helper command B (disable flagged member even if already paused):

```bash
AUTH_PASSWORD='<YOUR_DASHBOARD_PASSWORD>' \
BASE_URL='http://127.0.0.1:3001/api' \
API_KEY_NAME='BTDD_D1' \
MAX_TO_PAUSE='1' \
DISABLE_MEMBER='1' \
INCLUDE_PAUSED_FOR_MEMBER_DISABLE='1' \
node scripts/run_btdd_d1_apply_critical_pause_http.mjs
```

## Backtest Record Template (fill after each run)

| symbol | len | tp | trades | winRate% | PF | maxDD% | return% | score | status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| STXUSDT | 50 | 7.5 |  |  |  |  |  |  | pending |
| TRUUSDT | 50 | 7.5 |  |  |  |  |  |  | pending |
| VETUSDT | 50 | 7.5 |  |  |  |  |  |  | pending |
| GRTUSDT | 50 | 7.5 |  |  |  |  |  |  | pending |
| INJUSDT | 50 | 7.5 |  |  |  |  |  |  | pending |

## Optimization Record Template (Top-3 only)

| symbol | best_len | best_tp | trades | winRate% | PF | maxDD% | return% | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| TBD |  |  |  |  |  |  |  |  |
| TBD |  |  |  |  |  |  |  |  |
| TBD |  |  |  |  |  |  |  |  |

## Latest Run Snapshot (2026-03-11, VPS)
Source: `results/btdd_d1_ab_results.json`

Baseline (len=50, tp=7.5):
- `STXUSDT`: WR `0.00`, PF `0.00`, DD `4.83`, RET `-4.01`, SCORE `-7.39`
- `TRUUSDT`: WR `50.00`, PF `2.10`, DD `2.04`, RET `2.05`, SCORE `24.15`
- `VETUSDT`: WR `28.57`, PF `0.63`, DD `2.44`, RET `-0.60`, SCORE `5.43`
- `GRTUSDT`: WR `33.33`, PF `1.28`, DD `3.29`, RET `0.61`, SCORE `12.76`
- `INJUSDT`: WR `37.50`, PF `1.14`, DD `3.45`, RET `0.35`, SCORE `11.18`

Optimized top-3:
- `TRUUSDT`: len `70`, tp `5`, WR `83.33`, PF `4.81`, DD `1.42`, RET `2.37`, SCORE `53.66`
- `GRTUSDT`: len `70`, tp `7.5`, WR `33.33`, PF `2.43`, DD `2.34`, RET `2.01`, SCORE `26.32`
- `INJUSDT`: len `70`, tp `10`, WR `20.00`, PF `1.97`, DD `3.76`, RET `1.77`, SCORE `19.81`

Selected system members:
- `TRUUSDT`
- `GRTUSDT`
- `INJUSDT`

Portfolio summary (system backtest):
- RET `6.15%`
- PF `2.59`
- DD `5.56%`
- WR `50.00%`
- trades `14`

## Reference (previous local dry run, not VPS)
These are reference numbers from an earlier local run to compare direction, not final VPS truth:

- Top baseline:
  - `TRUUSDT`: WR `50.0`, PF `2.10`, DD `2.04`, RET `2.06`
  - `GRTUSDT`: WR `33.3`, PF `1.38`, DD `3.28`, RET `0.85`
  - `INJUSDT`: WR `37.5`, PF `1.22`, DD `3.44`, RET `0.55`

- Top optimized:
  - `TRUUSDT`: len `70`, tp `5`, WR `83.3`, PF `4.81`, DD `1.42`, RET `2.37`
  - `GRTUSDT`: len `70`, tp `7.5`, WR `33.3`, PF `2.43`, DD `2.34`, RET `2.01`
  - `INJUSDT`: len `70`, tp `10`, WR `20.0`, PF `1.89`, DD `3.76`, RET `1.69`

- Portfolio reference:
  - RET `6.07%`, PF `2.54`, DD `5.56%`, WR `50%`, trades `14`

## Go/No-Go for "real" system promotion
Promote from demo only if all are true:
- 24-48h demo run stable (no repeated execution errors)
- Reconciliation has no critical persistent drift
- Portfolio drawdown remains within planned limit
- At least 2 of 3 members keep PF >= 1 on rolling checks

## Phase 6 - Stabilize and Reintroduce Third Member
Current mode:
- Run stable soak on 2 active members while TRU is paused.

Current achieved system metrics:
- Original 3-member portfolio backtest: `RET 6.15%`, `PF 2.59`, `DD 5.56%`, `WR 50.00%`, `trades 14`
- Stable current live-demo composition: `GRTUSDT + INJUSDT`
- Soak result after TRU removal: `reconciliation failed=0`, `critical(active only)=0`

Goal:
- Re-optimize paused TRU candidate and re-introduce only after clean checks.

TRU reoptimization command (VPS):

```bash
AUTH_PASSWORD='<YOUR_DASHBOARD_PASSWORD>' \
BASE_URL='http://127.0.0.1:3001/api' \
API_KEY_NAME='BTDD_D1' \
SYMBOL='TRUUSDT' \
APPLY_BEST='1' \
node scripts/run_btdd_reopt_symbol_http.mjs
```

Expected output:
- `results/btdd_d1_truusdt_reopt_<timestamp>.json`

Latest TRU reopt result:
- Variants tested: `70`
- Profitable variants: `65`
- Robust variants (`PF>=1`, `DD<=12`): `65`
- Best candidate: `len=90`, `tp=3`, `src=wick`, `WR=100.00`, `PF=999.00`, `DD=0.69`, `RET=2.64`

Interpretation of TRU reopt:
- The best score is very strong, but `PF=999` and `WR=100%` are likely sample-size-sensitive.
- Do not re-enable TRU in live-demo only from this backtest line.
- First use it as a paused candidate with one extra verification cycle.

Re-entry gate for TRU:
1. Reopt best config has `PF >= 1.2` and `DD <= 12` with positive return.
2. TRU run in paused-candidate mode for one extra phase5 check cycle.
3. If no new critical for TRU in next cycle, re-enable TRU member in system.

When to start real trading:
1. On this exact API key: never with real money, because it is a Bybit demo key.
2. On real-money mainnet key: after one explicit promotion step using a separate non-demo Bybit API key.
3. Recommended promotion moment: now for `soft-live` on the 2-member version if you accept reduced diversification and conservative size.
4. Recommended capital/risk policy for first real-money launch:
   - start with `GRTUSDT` + `INJUSDT` only
   - keep TRU disabled until re-entry gate passes
   - use lower size than demo plan for first 24h
   - watch reconciliation every 12h during first real-money day

## Phase 7 - Sweep Candidate Portfolio (Diversification Path)
Why screenshot pairs were missing in active TS:
- A+B runner `scripts/run_btdd_d1_ab_http.mjs` uses hardcoded mono candidates (`STX/TRU/VET/GRT/INJ`) and does not import `third_strategy_sweep` JSON automatically.

New automation added:
- `scripts/run_btdd_import_sweep_candidates_http.mjs`
- Reads latest `backend/logs/backtests/third_strategy_sweep_*.json`
- Takes top unique synth + mono markets
- Creates/updates strategies
- Runs single backtests for each candidate
- Builds separate candidate trading system
- Runs portfolio backtest

Local validation snapshots for sweep candidate system:
- Short window (`bars=336`): portfolio `RET 2.23%`, `PF 1.41`, `DD 1.04%`, `WR 33.52%`, `trades 355`
- Long window (`bars=2500`): portfolio `RET 10.67%`, `PF 1.56`, `DD 1.53%`, `WR 34.44%`, `trades 996`
- Selected markets (long-window run): `ORDIUSDT/ZECUSDT`, `BERAUSDT`, `IPUSDT/ZECUSDT`, `IPUSDT`

VPS command to build sweep candidate system (safe mode, no activation):

```bash
AUTH_PASSWORD='<YOUR_DASHBOARD_PASSWORD>' \
BASE_URL='http://127.0.0.1:3001/api' \
API_KEY_NAME='BTDD_D1' \
TOP_SYNTH='3' \
TOP_MONO='3' \
MAX_MEMBERS='4' \
BARS='2500' \
ACTIVATE_SYSTEM='0' \
node scripts/run_btdd_import_sweep_candidates_http.mjs
```

Expected output:
- `results/btdd_d1_sweep_candidate_<timestamp>.json`

Decision gate for applying sweep system:
1. Sweep candidate portfolio must beat current stable 2-member system on risk-adjusted basis (`PF` and `DD`) on the same bar window.
2. No critical active recommendations in one phase5 check cycle after activation.
3. If gate passes, promote sweep system to active demo-live.

Fast-track promotion command (AB -> SWEEP + immediate safety check):

```bash
node scripts/run_btdd_promote_sweep_fasttrack_http.mjs
```

Optional overrides:
- `TARGET_SYSTEM_NAME='SWEEP BTDD_D1 Candidate Portfolio'`
- `SOURCE_SYSTEM_NAME='AB BTDD_D1 Mono Portfolio'`
- `DEACTIVATE_OTHER_ACTIVE='1'`
- `RUN_PHASE5_CHECK='1'`

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
- [ ] Phase 5 - Live Demo Soak (24-48h)

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
- If check #3 also has `critical/pause=0` and `reconciliation failed=0`, mark Phase 5 complete.

If any checkpoint shows `critical/pause recommendations > 0`:
1. Re-run phase5 script (latest version) to print the exact flagged strategy.
2. Pause only the flagged strategy (do not stop entire system):
   - `PUT /api/strategies/BTDD_D1/:strategyId` with `{ "is_active": false }`
3. Continue soak with remaining members for 12h and re-check.
4. Re-optimize paused strategy offline, then re-add only if stable.

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

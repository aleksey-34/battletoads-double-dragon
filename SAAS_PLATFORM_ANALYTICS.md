# SaaS Platform Analytics and Decisions

## 1) Direct Answers to Your Questions

### Will we get mono and synthetic strategies for parameter selection and trading system composition?
Yes.
- Current sweep logic already evaluates both mono and synthetic markets.
- It outputs robust candidates and selected members for a trading system.
- That means we can build strategy catalogs from real backtest outputs.

### Can all of this be backtested?
Yes.
- Single strategy and portfolio backtests are already available.
- Fixed date range backtests are supported.
- Optimization is supported through grid sweep scripts.
- Latest upgrade adds checkpoint/resume so long jobs survive restarts.

### Can backtester optimize, not only validate one range?
Yes.
- Optimization is done by parameter grids (`length`, TP, source, zscore params).
- You can run exhaustive or sampled modes.
- Candidate selection and portfolio assembly are already automated.

## 2) Product Split: Admin vs Client

## Admin Product (maximum functionality)
Scope:
- Full API key and strategy management.
- Full strategy settings and system composition.
- Full backtest and optimization controls.
- Billing and customer lifecycle management.
- Server and exchange load observability.

Must-have backend modules:
- Tenancy + RBAC.
- Subscription and invoice engine.
- Payment ingestion and reconciliation.
- Plan enforcement middleware.
- Operational controls (pause, cancel, close).

## Client Product (rental mode)
Scope:
- Simple strategy catalog.
- Equity chart and short strategy explanation.
- Two sliders per strategy: risk and trade frequency.
- No advanced internal parameters exposed.
- Plan-based limits visible in UI.

Mechanics for sliders:
- Offline: generate preset surfaces from historical sweeps.
- Runtime: map slider values to nearest preset tuple.
- Display: precomputed equity curve and key metrics update.

## 3) Data Needed for Client Sliders
You will have most of the needed data after the running sweep, but production-ready slider UX needs one more layer:
- Current sweep gives candidate-level metrics and equity summaries.
- Slider UX requires a normalized catalog with dense parameter grid and chart artifacts.
- Action: persist optimized result cubes per strategy family and market.

Recommended result artifact per preset:
- `preset_id`
- parameter tuple
- return, PF, DD, win rate, trades
- equity curve points (compressed)
- confidence score (sample quality + stability windows)

## 4) Payment Model (Aptos USDT)

Recommended flow:
1. Client binds payout wallet in cabinet.
2. Platform creates invoice with unique reference (memo/tag or dedicated address mapping).
3. Watcher scans Aptos transactions and matches invoice.
4. On match + confirmations => mark as paid and extend subscription.
5. If unpaid after due date:
- send warnings (T-3d, T-1d, overdue)
- enter grace period (e.g. 48h)
- then suspend automatically.

Suspension sequence (idempotent):
1. Pause all strategies.
2. Cancel all open orders.
3. Close all open positions.
4. Mark account state `suspended_non_payment`.

Notification channels:
- Primary: Telegram bot (fast and cheap).
- Secondary: email.
- Optional: in-app + webhook.

## 5) Tariff Plan Review

Your current plan ladder has strong intent but needs cleanup.
Main issues:
- Price steps are tight in the 15/20/25/30 range, differences may look unclear.
- Feature boundaries overlap too much between 25 and 30.
- Expensive resources (custom backtests) should be quota-based, not only tier text.

Recommendation: keep your prices but sharpen differentiators.

### Revised interpretation of your tiers
- 15 USDT: starter, 1 exchange, 1 key, 1 strategy, no custom backtests.
- 20 USDT: small trader, up to 3 keys, up to 3 strategies, basic orders/positions view.
- 25 USDT: multi-exchange entry, 2 exchanges, monitoring enabled.
- 30 USDT: advanced multi-exchange, 3 exchanges, priority execution queue.
- 50 USDT: pro, more keys, mono+synth pack, 5 custom pair requests per month.
- 100 USDT: business, highest limits, 10 custom requests per month, 1 extra exchange request.

Important enforcement fields per plan:
- max exchanges
- max API keys
- max active strategies
- max deposit per API key
- monthly backtest request credits
- queue priority

## 6) Capacity Estimate for Current VPS Class
Assumption from current node:
- 4 vCPU class, ~8 GB RAM (similar to shown Contabo profile).
- Auto cycle every 30s.
- Average client profile: 1-3 active strategies.

Estimated safe ranges for live trading workload (without heavy backtests):
- Conservative: 15-25 client accounts.
- With optimizations + stricter scheduling: 30-45 client accounts.
- With split architecture (separate backtest worker host): 50-80 client accounts.

Why range, not one number:
- Depends on exchange latency and API rate limits.
- Depends on strategy interval mix and active strategy count.
- Depends on how often monitoring/reconciliation/discovery run.

Capacity rule of thumb:
- Keep CPU p95 < 65%, RAM < 75%, exchange error rate < 1%.
- If exceeded for 3 consecutive days, scale horizontally.

## 7) How to Make It Faster and Lighter

Immediate optimizations:
- Keep heavy backtests off the live execution process.
- Use queued backtest workers with concurrency=1 per API key.
- Cache historical candles by symbol/interval/date window.
- Increase scheduler intervals for low tiers.
- Disable discovery scans for low tiers by default.

Medium-term optimizations:
- Split into three planes: control, execution, research.
- Add Redis queue for backtests and billing checks.
- Add read replicas or time-series store for monitoring snapshots.

## 8) Suggested Infrastructure Split

Stage 1 (now):
- Single VPS, but separate worker process for backtests.

Stage 2:
- VPS A: admin/control + billing API + frontend.
- VPS B: execution runtime (strategies, order management).
- VPS C (optional): research/backtest workers.

This prevents backtests from delaying live trading cycles.

## 9) Execution Risks and Mitigation
- Risk: billing false negatives on chain parsing.
  - Mitigation: confirmation threshold + manual review queue.
- Risk: forced close during exchange outage.
  - Mitigation: retry policy + emergency state machine.
- Risk: client confusion with simplified sliders.
  - Mitigation: show expected DD/trade count bands per slider level.
- Risk: noisy optimization overfitting.
  - Mitigation: robustness filters + rolling window validation.

## 10) What to Build First
1. Tenancy, plan limits, and billing states in DB/API.
2. Non-payment suspension workflow end-to-end.
3. Client catalog page with equity previews from backtest artifacts.
4. Queued periodic custom pair backtest requests.
5. Admin load dashboard and scaling triggers.

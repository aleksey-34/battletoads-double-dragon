# TODO SaaS Admin and Client Platform

## Goal
Build two product modes on one codebase:
- Admin mode: full control panel for operations, clients, billing, strategies, backtest factory, server load.
- Client mode: simplified strategy experience with payment-gated access and safe automation.

## Confirmed Inputs From Current Work
- Historical sweep produces mono and synthetic candidates across strategy types.
- Trading system composition from selected candidates is already implemented.
- Backtest engine supports fixed ranges and parameter optimization via sweep scripts.
- Historical sweep now has checkpoint/resume and turbo mode in `scripts/run_btdd_historical_system_sweep_http.mjs`.

## Phase 0: Product Boundaries and Security
- [ ] Define tenant model: admin tenant vs client tenants.
- [ ] Add RBAC roles: `platform_admin`, `client_owner`, `client_viewer`.
- [ ] Split API surface into admin-only and client-safe routes.
- [ ] Add audit logging for billing, plan changes, force pause, and close positions.

## Phase 1: Data Model for SaaS
- [ ] Add tables: `tenants`, `users`, `user_tenants`, `plans`, `subscriptions`, `invoices`, `payments`, `wallet_bindings`, `plan_limits`.
- [ ] Add `tenant_id` to `api_keys`, `strategies`, `trading_systems`, `monitoring_snapshots`.
- [ ] Add indexes for tenant filters and billing lookups.
- [ ] Add migration scripts with rollback notes.

## Phase 2: Billing and Payment Control
- [ ] Add Aptos USDT payment watcher service (scheduled poll + confirmation depth).
- [ ] Support invoice states: `pending`, `paid`, `overdue`, `grace`, `suspended`.
- [ ] Add billing actions: notify client, pause bots, cancel orders, close positions.
- [ ] Add grace period policy and idempotent suspension logic.

## Phase 3: Plan Limits and Enforcement
- [ ] Add middleware that enforces plan caps before writes and activation.
- [ ] Caps to enforce: exchanges, API keys, strategies, max deposit, backtest request quota.
- [ ] Add server-side guard rails for strategy count and exchange usage.
- [ ] Show remaining limits in client UI.

## Phase 4: Client Strategy UX (No Advanced Settings)
- [ ] Build strategy catalog with short description, risk notes, and equity chart preview.
- [ ] Replace advanced config with two sliders per strategy:
- `risk: lower <-> higher`
- `trade_frequency: fewer <-> more`
- [ ] Map slider positions to precomputed parameter presets.
- [ ] Show predicted equity curve update from precomputed surfaces.

## Phase 5: Backtest Factory and Request Queue
- [ ] Add queued backtest jobs: `queued`, `running`, `done`, `failed`, `canceled`.
- [ ] Add periodic batch run for custom pair requests (e.g. daily or every 12h).
- [ ] Add result artifacts: summary JSON, equity CSV, chart image, candidate list.
- [ ] Add per-plan quota for custom pair requests.

## Phase 6: Admin Control Plane
- [ ] Client table: plan, status, last payment, active keys, active strategies, debt risk.
- [ ] Actions: force pause, force resume, close all positions, cancel all orders, lock account.
- [ ] Billing panel: invoice timeline, payment proof, retries, manual override.
- [ ] Load panel: CPU, RAM, API RPS per exchange, queue depth, latency, error rates.

## Phase 7: Notifications
- [ ] Add notification channels: Telegram bot, email, in-app notifications.
- [ ] Trigger events: upcoming expiry, overdue, suspended, resumed, backtest complete.
- [ ] Add message templates for RU and EN.

## Phase 8: Deployment Topology
- [ ] Split roles into services:
- `control-plane` (admin UI/API, billing)
- `execution-plane` (live strategy cycles)
- `research-plane` (backtests and optimization)
- [ ] Start with one VPS profile and define migration path to 2+ servers.
- [ ] Add queue (Redis or DB queue) to isolate heavy jobs from live trading.

## Phase 9: Compliance, Reliability, and QA
- [ ] Add integration tests for suspension flow (pause + close positions).
- [ ] Add backtest regression suite for catalog presets.
- [ ] Add billing reconciliation tests for duplicate transactions.
- [ ] Add chaos tests for restart/recovery (checkpoint resume).

## Immediate Sprint (Start Now)
- [ ] Create SaaS schema migrations (Phase 1 baseline tables).
- [ ] Add tenant-aware auth and RBAC middleware skeleton.
- [ ] Build payment watcher skeleton for Aptos USDT with mocked parser.
- [ ] Define first strategy catalog format and two-slider preset mapping.
- [ ] Add backtest job queue table and worker skeleton.

## Delivery Milestones
- Milestone A (1-2 weeks): tenant model + plan limits + manual billing controls.
- Milestone B (2-4 weeks): automated Aptos payment watcher + suspension workflow.
- Milestone C (4-6 weeks): client strategy catalog with sliders + precomputed equity curves.
- Milestone D (6-8 weeks): queued batch backtest factory + admin load dashboard.

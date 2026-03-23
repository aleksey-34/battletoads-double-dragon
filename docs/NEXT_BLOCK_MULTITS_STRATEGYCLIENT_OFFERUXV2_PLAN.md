# Next Block Plan: Multi-TS + Strategy Client Builder + Offer UX v2

## Scope
- Algofund: multi-TS selection + backtest passport.
- Strategy Client: self-build trading system by plan limits.
- Offer UX v2: copytrading-style selection flow.

## Stream 1: Algofund Multi-TS
- Add server model for portfolio of multiple TS candidates per tenant.
- Add selection policy: balanced, aggressive, conservative presets.
- Add backtest passport payload for each candidate and combined portfolio.
- Add approval flow with clear block reasons when materialization is impossible.

## Stream 2: Strategy Client TS Builder
- Add plan-aware constraints (max symbols, mono/synth caps, max members).
- Add constructor UI: pick offers, set weights, validate risk profile.
- Add preview backtest API and explainability summary before publish.
- Add publish path to runtime with rollback on partial failure.

## Stream 3: Offer UX v2
- Rework offer cards to copytrading-style: return/DD/PF/trades/day and risk tags.
- Add onboarding flow: goal -> risk -> pace -> recommended set.
- Add comparison panel up to N offers with clear differences and warnings.
- Add trust panel: source sweep, period coverage, update timestamp.

## Milestones
- M1: Data contracts and API skeletons.
- M2: Backend logic (selection, constraints, preview, publish).
- M3: Frontend flows for all three streams.
- M4: E2E verification on VPS with tenant scenarios.

## Acceptance Criteria
- Admin sees global request queues and can process at scale.
- Algofund can pick and validate multiple TS with passport preview.
- Strategy client can build own TS without violating tariff constraints.
- Offer UX v2 reduces steps from discovery to publish decision.

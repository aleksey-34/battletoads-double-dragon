# BTDD Platform — Whitepaper v1.1

**Algorithmic Trading SaaS for Crypto Markets**

*April 2026 (Updated v1.1)*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Solution Overview](#3-solution-overview)
4. [Trading Engine & Strategies](#4-trading-engine--strategies)
5. [Backtesting & Validation Pipeline](#5-backtesting--validation-pipeline)
6. [Platform Architecture](#6-platform-architecture)
7. [Client Modes & Offerings](#7-client-modes--offerings)
8. [Risk Management](#8-risk-management)
9. [Exchange Integrations](#9-exchange-integrations)
10. [Performance Metrics](#10-performance-metrics)
11. [Technology Stack](#11-technology-stack)
12. [Roadmap](#12-roadmap)
13. [Team & Contact](#13-team--contact)

---

## 1. Executive Summary

BTDD Platform is a multi-tenant algorithmic trading SaaS that automates portfolio-level cryptocurrency trading for retail investors, fund managers, and copy-traders.

The platform delivers a complete pipeline: **market data collection → parametric strategy optimization → robustness filtering → portfolio construction → live execution** — fully automated with institutional-grade backtesting rigor applied at retail scale.

**Key results (runtime storefront snapshot, updated on 19 Apr 2026):**

| Metric | Value |
|---|---|
| Historical backtests completed | 10,000+ |
| Public runtime snapshots | 349 |
| Active TS portfolios | 10 |
| Best TS return / 90d | **+210.17%** |
| Best Profit Factor | **12.03** |
| Minimum DD | **1.5%** |
| Exchanges connected | 6 (live) |

---

## 2. Problem Statement

Retail crypto traders face compounding disadvantages:

- **Emotional trading** leads to average retail loss rates of 70–90% across leveraged products
- **Strategy validation** requires infrastructure (data feeds, backtest engines, cost modeling) that individual traders cannot easily build
- **Execution discipline** — even profitable strategies underperform when manually executed due to missed entries, premature exits, and revenge trading
- **Multi-exchange complexity** — each exchange has different APIs, fee structures, order types, and rate limits
- **Statistical illiteracy** — most "profitable" strategies promoted online suffer from lookahead bias, curve fitting, or commission-free backtesting

The core problem: **there is no accessible, transparent platform where retail investors can invest in rigorously validated algorithmic strategies without trusting a black box.**

---

## 3. Solution Overview

BTDD Platform bridges the gap between institutional quantitative trading and retail accessibility:

### 3.1 Transparent Backtesting
Every performance number published on the platform is **verifiable**:
- Commissions included (0.06% entry + 0.06% exit)
- Slippage modeled (0.03% bid-ask spread)
- No lookahead bias — each bar processed sequentially
- Full parameter-to-result traceability

### 3.2 Multi-Strategy Portfolios
Rather than betting on a single strategy, the platform constructs **portfolios** of uncorrelated strategies across different markets and timeframes, reducing drawdown through diversification.

### 3.3 Multi-Tenant Isolation
Each client operates in an isolated environment with:
- Dedicated API key management
- Per-client risk parameters
- Separate monitoring and audit logs
- No cross-client data leakage

### 3.4 Three Access Modes
The platform serves different investor profiles through three distinct modes: Algofund (managed), Strategy Client (self-directed), and Copy Trading (social).

---

## 4. Trading Engine & Strategies

### 4.1 Strategy Types

The platform currently operates three validated strategy families:

#### DoubleDragon Breakout (DD_BattleToads)
- **Type:** Trend-following breakout
- **Signal:** Donchian channel breakout (N-bar high/low penetration)
- **Entry detection:** Close-based (conservative) or Wick-based (aggressive)
- **Exit — Profit:** Trailing stop from equity peak (TP = 2–10%)
- **Exit — Loss:** Donchian channel center as hard stop-loss
- **Modes:** Mono (single asset) and Synthetic (pair trading)
- **Optimal parameters:** Length 12–36 bars, TP 5–7.5%, 4h timeframe
- **Best conditions:** Trending markets with clear directional impulses

#### ZigZag Breakout (zz_breakout)
- **Type:** Structural breakout, faster variant
- **Signal:** Same Donchian mechanism as DD with shorter lookback periods
- **Differentiator:** Length 5–16 bars for quicker reaction to regime changes
- **Exit:** Tighter trailing TP (2–5%) generating higher trade frequency
- **Win Rate:** 43–51% on robust candidates
- **Best conditions:** High-volatility choppy markets

#### Statistical Arbitrage Z-Score (stat_arb_zscore)
- **Type:** Mean-reversion / statistical arbitrage
- **Signal:** Z-score deviation on synthetic instrument pair
  - **Entry Long:** Z < −2.0σ (pair undervalued)
  - **Entry Short:** Z > +2.0σ (pair overvalued)
  - **Exit (revert):** Z returns within ±0.5σ of mean
  - **Stop (trend break):** Z exceeds ±3.5σ (regime change)
- **Formula:** `Z = (price − mean[120 bars]) / σ`
- **Ideal Pairs:** Correlated crypto ecosystems — DeFi tokens, Layer-2 protocols, oracle networks
- **Example pairs:** ORDI/ZEC, IP/ZEC, GRT/INJ, BERA/ZEC

### 4.2 Market Modes

**Mono Mode** — Single instrument execution (BTCUSDT, ETHUSDT, etc.). Standard OHLCV data, single order fills.

**Synthetic Mode** — Two-instrument pair trading. The platform constructs a synthetic price:

$$P_{synthetic} = \frac{\alpha \cdot P_{base}}{\beta \cdot P_{quote}}$$

where α, β are balancing coefficients. Execution requires parallel orders on both legs with balanced notional. This mode **reduces market beta** and increases signal stationarity — an edge unavailable to single-coin platforms.

### 4.3 Position Sizing

Target notional is calculated as:

$$N_{target} = Balance \times \frac{lot\%}{100} \times R_{reinvest}$$

The engine performs a grid search over quantity candidates (±3 steps from raw quantity) with multi-criteria scoring: share error (1000 pts) + leg deviation (200 pts) + oversize penalty (10 pts). Maximum share error tolerance: 50%.

---

## 5. Backtesting & Validation Pipeline

### 5.1 Event Loop Architecture

```
For each closed bar:
  1. Load candle (OHLCV or synthetic computed)
  2. Deduplicate — process each final bar exactly once
  3. Compute signal (Donchian breakout or Z-score threshold)
  4. Check exit conditions (TP trailing, center SL, Z thresholds)
  5. Check entry conditions (signal ≠ 'none')
  6. Record state, equity, and realized PnL
```

### 5.2 Cost Model

Every backtest includes realistic execution costs:

| Cost Component | Value |
|---|---|
| Maker/Taker commission | 0.06% per side |
| Slippage (bid-ask model) | 0.03% |
| Funding rate | Per-bar accrual if leveraged |
| **Total round-trip cost** | **~0.15%** |

### 5.3 Historical Sweep (10,000+ Variants)

The platform performed an exhaustive parametric sweep across all strategy families:

| Strategy | Parameter Grid | Variants per Market |
|---|---|---|
| DoubleDragon | length[5,8,12,16,24,36] × TP[2–10%] × source[close,wick] | 72 |
| ZigZag | length[5,8,12,16] × TP[2–5%] × source[close,wick] | 48 |
| StatArb | length[24–120] × ZE[1.25–2.25] × ZX[0.5–1.0] × ZS[2.5–3.5] | 270 |

Applied across 12 mono markets + N² synthetic pairs on 4h Bybit historical data (Jan 2025 – Mar 2026).

### 5.4 Robustness Filter

A strategy candidate passes the robustness filter only if ALL criteria are met:

- **Profit Factor ≥ 1.15** (gross profit / gross loss)
- **Max Drawdown ≤ 22%** (peak-to-trough equity decline)
- **Trade Count ≥ 40** (statistical significance threshold)

**Result:** hundreds of robust candidates were selected, then assembled into 349 runtime snapshots and 10 TS portfolios for the storefront.

### 5.5 Portfolio Construction

The top 8 candidates per market type are selected for portfolio construction. Portfolio equity is the aggregate of all constituent strategies:

$$Equity_{portfolio}(t) = Cash(t) + \sum_{i=1}^{N} UPnL_i(t)$$

$$Drawdown(t) = \frac{Peak(t) - Equity(t)}{Peak(t)} \times 100\%$$

Current storefront TS portfolios span conservative to aggressive profiles: up to **+210.17% over 90 days** with drawdown controlled by selected profile.

---

## 6. Platform Architecture

### 6.1 Three-Circuit Isolation

The platform is designed with strict domain-level isolation:

```
┌─────────────────────────────────────────────────────┐
│                    BTDD Platform                     │
│                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ RUNTIME  │  │ RESEARCH  │  │  PRODUCTION/SaaS │  │
│  │ Circuit  │  │ Circuit   │  │     Circuit       │  │
│  │          │  │           │  │                   │  │
│  │runtime.db│  │research.db│  │     main.db       │  │
│  │          │  │           │  │                   │  │
│  │• Execute │  │• Backtest │  │• Tenant mgmt     │  │
│  │• Monitor │  │• Sweep    │  │• Subscriptions   │  │
│  │• Risk    │  │• Optimize │  │• Client catalog  │  │
│  │• Trade   │  │• Publish  │  │• RBAC & auth     │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │              API Gateway (Express)               ││
│  │  /api/admin/*  /api/research/*  /api/client/*    ││
│  └──────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

**Runtime Circuit** handles live trade execution with zero-downtime guarantees. It runs as an isolated systemd service with its own database, ensuring that research or SaaS operations never interfere with order execution.

**Research Circuit** manages backtesting, parametric sweeps, and strategy optimization. It includes checkpoint/resume for long-running sweeps and a publish gate that promotes validated candidates to the runtime circuit.

**Production Circuit** serves the multi-tenant SaaS layer — tenant management, subscription billing, client catalogs, and role-based access control.

### 6.2 API Gateway

| Endpoint Pattern | Access | Purpose |
|---|---|---|
| `/api/admin/*` | Admin auth | Runtime + research read/write |
| `/api/research/*` | Admin auth | Backtest, sweep, candidates |
| `/api/client/*` | Client auth | Catalog, preview, subscribe |
| `/api/saas/*` | Admin/Client | Tenant management, algofund |

---

## 7. Client Modes & Offerings

### 7.1 Algofund (Managed Account)

The simplest entry point for investors. The client connects their exchange API key (trade-only, **no withdrawal permission**) — funds always remain on the client's own exchange account. The platform trades automatically, generating passive income.

- **Key principle:** Your money never leaves your exchange. Simple, secure API connection.
- **Admin controls:** Strategy selection, parameters, rebalancing
- **Client sees:** Equity curve, return %, key metrics, risk multiplier
- **Client actions:** Start/stop requests, risk cap adjustment
- **Dual Mode pricing:** Start/Pro/Scale (post-beta: $39/$129/$399), current beta price = $0
- **Alternative:** 40% profit-share from net profit (high-watermark)
- **Risk cap range:** 0–2.5× (client-adjustable within admin bounds)

### 7.2 Strategy Client (Self-Directed)

For those who want to explore deeper:

- **Easy setup:** Connect API key, pick individual strategies from the catalog, and build your own trading system in a few clicks
- **Two-slider UX:** Risk level (1–5) × Trade frequency (1–5) → maps to optimized preset
- **Equity preview:** Backtest results for selected configuration before going live
- **Strategy quota:** 3 / 10 / 30 strategies (Start/Pro/Scale tiers)
- **Limits:** up to 1 / 3 / 10 TS and deposit up to $5k / $50k / extended mode
- **Payment model:** Dual subscription or 40% profit-share

### 7.3 Copy Trading (Social)

1 API key — multiple copied accounts. Trade with your own software and share with friends. No hassle like copy-trading on exchanges.

- **Auto-scaling:** Adjusts position sizes proportionally to the copier's deposit
- **Independent risk control:** The copier can set their own risk limits
- **Transparency:** Full visibility into the signal source's track record

---

## 8. Risk Management

### 8.1 Strategy-Level Controls

Each active strategy has configurable risk parameters:

| Parameter | Description | Typical Range |
|---|---|---|
| `lot_percent` | Position size as % of balance | 3–15% |
| `leverage` | Exchange margin leverage | 1–10× |
| `margin_type` | Cross or Isolated margin | Per strategy |
| `max_deposit` | Maximum capital per strategy | 500–5,000 USDT |
| `emergency_stop_dd` | Auto-stop drawdown threshold | 15–25% |

### 8.2 Portfolio-Level Controls

- **Monitoring snapshots:** Equity, unrealized PnL, drawdown, and margin load sampled every N seconds
- **Emergency stop:** If portfolio drawdown exceeds threshold → automatic pause → close all positions
- **Margin load tracking:** Alerts when total margin utilization approaches exchange limits

### 8.3 Client-Level Isolation

- Each client has independent API keys stored encrypted
- Position actions are scoped to the client's sub-account
- No shared order books or cross-client exposure
- Audit log for every trade action, start/stop, parameter change

---

## 9. Exchange Integrations

| Exchange | Integration | Status | Notes |
|---|---|---|---|
| **Bybit** | Native (RestClientV5) | ✅ Live Primary | Full feature support, derivatives + spot |
| **Binance** | ccxt + native extensions | ✅ Live | USDt-M Futures |
| **Bitget** | ccxt | ✅ Live | USDT-M Contracts |
| **BingX** | ccxt | ✅ Live | Standard contracts |
| **MEXC** | ccxt | ✅ Live | USDT-M Futures |
| **Weex** | Native client | ✅ Live | Custom connector |

The platform uses a unified exchange abstraction layer (`detectExchange()`) that routes orders to the correct connector based on the client's configured exchange. Adding new exchanges requires only implementing the connector interface — no changes to strategy or risk logic.

---

## 10. Performance Metrics

### 10.1 Portfolio Summary (Full Range)

| Metric | Value |
|---|---|
| Measurement period | Last 90 days, storefront snapshot |
| Timeframe | 1h/4h (module-dependent) |
| Data source | Runtime snapshots + storefront metrics |
| Total backtests | 10,000+ |
| Public runtime snapshots | 349 |
| **Best TS return / 90d** | **+210.17%** |
| **Best Profit Factor** | **12.03** |
| **Minimum DD** | **1.5%** |
| Active TS portfolios | 10 |
| Exchanges connected | 6 |
| **Public storefront** | **349 snapshot cards** |

### 10.2 Interpretation

- Best PF of 12.03 means the top storefront module earned **$12.03 gross profit for each $1 gross loss** in the measured period.
- Minimum DD of 1.5% reflects the lowest-drawdown profile in the current storefront lineup.
- Storefront metrics now represent a **profile range** (conservative to aggressive) rather than a single static portfolio metric.

### 10.3 Out-of-Sample Validation

The robustness filter requires a minimum of 40 trades to ensure statistical significance. Candidates are evaluated on the **full historical range** — there is no in-sample/out-of-sample split in the current methodology. Walk-forward validation is planned for v2.0.

---

## 11. Technology Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js 20, TypeScript, Express |
| Database | SQLite (3 isolated databases) |
| Frontend | React 18, Ant Design 5, TypeScript |
| Charts | Lightweight Charts (TradingView) |
| Exchange SDK | Bybit RestClientV5 (native), ccxt (multi-exchange) |
| Process management | systemd (3 services: api, runtime, research) |
| Reverse proxy | nginx |
| SSL/CDN | Cloudflare Tunnel |
| CI/CD | GitHub → VPS pull-deploy |
| Monitoring | Internal snapshots + audit log |
| Localization | RU / EN / TR |

---

## 12. Roadmap

### Phase 1 — Current (Q1 2026) ✅
- ✅ Live MVP with 3 strategy types
- ✅ 10,000+ backtest sweep completed
- ✅ 6 exchange integrations
- ✅ Multi-tenant SaaS with 3 client modes
- ✅ Admin panel + client cabinet
- ✅ Dark theme, professional UI
- ✅ Landing page with real metrics

### Phase 2 — Growth (Q2 2026)
- Walk-forward out-of-sample validation
- Telegram bot notifications for trades & alerts
- On-boarding funnel with automated KYC-light
- OKX exchange integration
- Payment integration (crypto billing)
- Client referral program

### Phase 3 — Scale (Q3–Q4 2026)
- Redis-based event queue for horizontal scaling
- Separate execution-plane and research-plane VPS instances
- Reinforcement learning for dynamic parameter adjustment
- Mobile-responsive client dashboard
- Institutional API access tier
- Compliance audit & security penetration testing
- Multi-language documentation expansion

### Phase 4 — Ecosystem (2027)
- DEX integration (on-chain execution)
- Strategy marketplace (third-party strategy submission)
- Social trading leaderboard
- DAO governance for fee parameters (optional)

---

## 13. Team & Contact

**Founder & CTO:** Алексей Лазарев / Aleksei Lazarev
- 5+ years in algorithmic trading systems development
- Node.js / TypeScript specialist
- Crypto derivatives market experience

**Contact:**
- **Email:** aiaetrade17@gmail.com
- **Telegram:** @yakovbyakov
- **Platform:** https://btdd.trade
- **Whitepaper (web):** https://btdd.trade/whitepaper
- **Telegram Channel:** https://t.me/BTDD_Live
- **Telegram Chat:** https://t.me/BTDD_Discuss
- **Medium:** https://medium.com/@foresterufa
- **LinkedIn:** https://www.linkedin.com/in/alekseilazarev
- **Threads:** https://www.threads.com/@foresterufa
- **GitHub:** Private repository (available upon request for due diligence)

**Investment inquiries:** aiaetrade17@gmail.com — Seed round open ($150K–$300K)

---

## Disclaimer

Past performance does not guarantee future results. All metrics presented are based on historical backtesting with simulated execution costs. Live trading involves additional risks including but not limited to: exchange downtime, API rate limits, liquidity gaps, regulatory changes, and black swan events. Users should only invest capital they can afford to lose. BTDD Platform does not provide financial advice.

---

*BTDD Platform Whitepaper v1.1 — April 2026*
*© 2026 BTDD Platform. All rights reserved.*

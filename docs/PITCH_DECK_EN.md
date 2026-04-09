# BTDD Platform — Pitch Deck
**Date:** April 2026  
**Version:** 1.0 (EN)  
**Status:** Ready for distribution to partners and exchange grant programs

---

## Slide 1 — Problem

### Algorithmic Trading Is Inaccessible to Most

- **High barrier to entry**: developing a trading bot requires programming skills, mathematics, and exchange API expertise. 95% of retail traders lack these skills.
- **No validation**: most off-the-shelf "bots" have no transparent backtesting methodology and publish only cherry-picked results.
- **No infrastructure**: even when a strategy is found — you need a VPS, monitoring, emergency position closing, and key management. This operational burden kills the trader.
- **Closed ecosystems**: existing solutions (3commas, Cryptohopper) are expensive, opaque, and non-customizable.

---

## Slide 2 — Solution

### BTDD Platform — Algorithmic Trading as a Service

A full-featured SaaS platform that gives clients access to **validated algorithmic strategies** without needing to understand trading mechanics.

**Three modes for different clients:**

| Mode | Target User | What They Get |
|---|---|---|
| **Algofund** | Passive investor | Delegates portfolio management. Sees equity, stats, requests start/stop |
| **Strategy Client** | Advanced trader | Connects own API key, selects strategies, configures risk |
| **Admin** | Fund manager / partner | Full platform control: sweep, publishing, clients, billing |

---

## Slide 3 — Product

### What's Already Built (v2.0)

#### Trading Engine
- 3 strategy types: **DoubleDragon Breakout**, **StatArb Z-Score**, **ZigZag Breakout**
- Mono and synthetic instruments (2 assets → one price ticker)
- Trailing TP, Donchian Channel, Z-score with lookahead-free implementation
- Isolated runtime service: trading continues during API restarts

#### Research & Backtesting
- Historical sweep: **9,108 runs**, **0 failures**
- Robustness filtering: **3,129 candidates** passed PF/DD/WR/trades filters
- Checkpoint/resume for long-running sweeps
- Parallel grid-search over hyperparameters

#### SaaS Architecture
- Multi-tenant isolation by API key
- Subscription plans with limits
- Offer catalog (TS) independent from runtime
- Audit log for critical actions

#### Frontend
- React + Ant Design SPA
- Dashboard, Research, SaaS Admin, Client Cabinet
- Support for RU / EN / TR

---

## Slide 4 — Backtest Results

### Portfolio Backtest: Admin TS (6 members)

> Full-range, 4H timeframe, Bybit, **January 2025 — March 2026**

| Metric | Value | Assessment |
|---|---|---|
| Return | **+15.43%** | Strong |
| Profit Factor | **2.71** | Excellent (>2.0) |
| Max Drawdown | **1.39%** | Excellent (<5%) |
| Win Rate | **51.7%** | Normal |
| Trades | **362** | Sufficient sample |

**Portfolio composition:**
- `IPUSDT` — DD_BattleToads, mono
- `IPUSDT/ZECUSDT` — DD_BattleToads, synthetic
- `VETUSDT/GRTUSDT` — stat_arb_zscore, synthetic
- `BERAUSDT/ZECUSDT` — DD_BattleToads, synthetic
- `ORDIUSDT/ZECUSDT` — DD_BattleToads, synthetic
- + 1 stat_arb_zscore member

> *Historical backtest. Past results do not guarantee future performance.*

---

## Slide 5 — Market

### Market Size

- Global algo trading market: **$21.6B in 2024** → **$31.8B by 2028** (CAGR ~10%)
- Crypto algo trading growing faster: estimated **>$5B ARR** potential for B2C/B2B SaaS
- Bybit alone exceeds **$10B** daily volume. At 0.3% fee rebate from $1M client volume → $3K/day.

### Target Segments

1. **Retail traders** with $1K–$50K deposits seeking automated strategies
2. **Small fund managers** with $100K–$2M client capital
3. **Crypto enthusiasts** from CIS, Turkey, SEA — key Bybit markets

---

## Slide 6 — Business Model

### Three Revenue Streams

#### 1. SaaS Subscription (B2C)
| Plan | Price/mo | Key Limits |
|---|---|---|
| Starter | $49 | 1 exchange, 3 strategies, max $5K deposit |
| Pro | $149 | 3 exchanges, 10 strategies, max $50K deposit |
| Enterprise | $499+ | Unlimited, priority support |

#### 2. Algofund (B2C, performance-based)
- Management fee: **2% per month** of AUM
- Performance fee: **20%** of profit (high-watermark)
- Minimum deposit: $1,000

#### 3. Exchange Partnership / Grant (B2B)
- API Volume Rebate from exchanges (Bybit, OKX, Gate.io)
- Co-marketing with exchanges for client acquisition
- Grant support for new exchange integrations

---

## Slide 7 — Competitive Analysis

| Criterion | BTDD Platform | 3commas | Cryptohopper | Mudrex | Pionex |
|---|---|---|---|---|---|
| Transparent backtest | ✅ 9,108 runs | ❌ | ❌ | ⚠️ partial | ❌ |
| Synthetic pairs | ✅ StatArb | ❌ | ❌ | ❌ | ❌ |
| Multi-tenant SaaS | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| Algofund mode | ✅ | ❌ | ❌ | ✅ | ❌ |
| Open Research | ✅ sweep + UI | ❌ | ❌ | ❌ | ❌ |
| Price | $49–$499/mo | $14–$59/mo | $19–$99/mo | $0–$99/mo | Free |
| Data control | ✅ self-hosted | ❌ SaaS-only | ❌ SaaS-only | ❌ | ❌ |

**Key advantage**: transparent methodology, synthetic instruments, and full data control.

---

## Slide 8 — Roadmap

### Q2 2026
- [ ] Verified onboarding flow: Algofund client in < 10 minutes
- [ ] Payment gateway (Aptos/USDT on-chain billing)
- [ ] Walk-forward strategy validation (out-of-sample score)
- [ ] Binance API integration

### Q3 2026
- [ ] Market regime filter (ATR/ADX adaptation)
- [ ] OKX, Gate.io integration
- [ ] Client TS Builder (Strategy Client TS Constructor)
- [ ] Telegram notifications for clients (start/stop, alerts)

### Q4 2026
- [ ] Mobile-friendly interface
- [ ] Copy-trading style offer UX
- [ ] Public API for partners
- [ ] 50+ active clients

### 2027
- [ ] Expansion: $5M AUM under management
- [ ] Listing on Exchange Builder programs (Bybit Builders, OKX Ventures)

---

## Slide 9 — Grant & Partnership Request

### What We're Seeking

#### From Crypto Exchanges:
| Exchange | Program | Request |
|---|---|---|
| **Bybit** | Bybit Builder Grant | $10K–$50K grant + API rebate + co-marketing |
| **OKX** | OKX Ventures | $25K integration grant |
| **Binance** | Binance Labs BUIDL | API Integration Grant + developer support |
| **Gate.io** | API Partner | Volume rebate + joint promotion |
| **KuCoin** | KuCoin Labs | $15K grant + ecosystem support |

#### From Infrastructure Providers:
| Provider | Program | Amount |
|---|---|---|
| **AWS Activate** | Startup credits | $10K–$100K |
| **Google for Startups** | Cloud credits | up to $200K |
| **Microsoft for Startups** | Azure credits | up to $150K |

#### Total Support Sought:
- **$150K–$300K** total in grants/credits
- **API partner status** on 3+ exchanges (for volume rebate)
- **Co-marketing** → 200+ client acquisition in first 6 months

---

## Slide 10 — Team & Status

### Current Status
- ✅ **MVP in production**: live VPS, backend + frontend operational
- ✅ **Bybit integration**: live trading active
- ✅ **9,108 backtests** completed, catalog of 12 offers ready
- ✅ **SaaS backend**: multi-tenant, subscription plans, audit log
- ✅ **Client cabinet**: registration, auth, strategy management

### What's Needed for Scaling
- Marketing campaign (content + paid) → **$30K**
- Additional exchange integrations → **$50K dev**
- Compliance / legal for client deposits → **$20K**
- Infrastructure for 100+ clients → **$20K/year**

---

## Contact

**Platform**: BTDD Platform — Algorithmic Trading SaaS  
**Founder**: Aleksei Lazarev  
**Telegram**: @yakovbyakov  
**Email**: aiaetrade17@gmail.com  
**Demo**: https://btdd.trade  
**GitHub**: (private, available on request)

---

*Document prepared for distribution to crypto exchange grant and partnership programs.*  
*Version 1.0 (EN), April 2026.*

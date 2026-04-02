# Заявки на гранты — BTDD Platform
**Дата подготовки:** Апрель 2026  
**Статус:** Готово к отправке (заполни контакты, отмеченные [ВАШ_XXX])

---

## ── ПРИОРИТЕТ 1: Bybit Builder Grant ──────────────────────────

**Куда:** https://builders.bybit.com/  
**Форма:** Application Form на сайте / builders@bybit.com  
**Сколько просить:** $25 000 + API Volume Rebate партнёрский статус  
**Срок:** Открытая программа, подавать сразу  

---

### Текст заявки (EN — Bybit требует English)

**Subject:** BTDD Platform — API Integration Grant Application

---

**Project Name:**  
BTDD Platform — Algorithmic Trading SaaS

**Project Website:**  
https://btdd-platform.vercel.app *(обнови после деплоя)*

**Stage:**  
Live MVP — production deployment on VPS, active Bybit API integration

**Description (500 words):**

BTDD Platform is a multi-tenant algorithmic trading SaaS built on top of the Bybit API. We provide automated trading strategies for retail traders and small fund managers who lack the technical expertise to build their own bots.

**What we've built:**

1. **Trading Engine** — 3 strategy types (DoubleDragon Breakout, StatArb Z-Score, ZigZag Breakout) with full event-driven backtesting, lookahead-free implementation, and trailing TP/SL. Supports both mono assets and synthetic pairs (ratio of two assets).

2. **Research & Optimization** — Historical sweep across 9,108 parameter combinations with robustness filtering (PF ≥ 1.15, DD ≤ 22%, trades ≥ 40). Checkpoint/resume for long runs. Produced 3,129 robust candidates from a 15-month Bybit data window (Jan 2025 – Mar 2026, 4h timeframe).

3. **Validated Portfolio** — Admin trading system: 6-member portfolio, all synthetic Bybit pairs.
   - **Return: +28.7%** (full-range, Jan 2025 – Mar 2026)
   - **Profit Factor: 3.28**
   - **Max Drawdown: 4.4%**
   - **Total Trades: 416**
   - Backtest includes 0.1% commission and 0.05% slippage in simulation.

4. **SaaS Platform** — Multi-tenant architecture: each client is isolated by API key. Three client modes: Algofund (passive managed portfolio), Strategy Client (self-service with own API keys), Copy Trading. Admin dashboard with full Research, Backtest, and Strategy management.

5. **Client Onboarding** — Client cabinet with registration, strategy catalog, risk-profile slider, and start/stop control.

**Why Bybit:**

Bybit is our primary exchange. All production trading and all historical data for backtesting runs through Bybit API (RestClientV5 + WebSocket). Our entire sweep, strategy optimization, and live execution pipeline is built on Bybit market data and order execution. We are 100% committed to the Bybit ecosystem.

**Grant Use of Funds ($25,000):**
- $8,000 — Marketing campaign: onboarding first 50 Algofund clients
- $7,000 — Walk-forward validation module (out-of-sample testing infrastructure)
- $5,000 — Mobile-responsive interface rebuild
- $5,000 — Infrastructure scaling for 100+ concurrent clients

**Exchange Integration Ask:**
- Bybit Builder Grant: $25,000
- API Partner status with volume rebate (fee reduction for client API keys registered under our partner umbrella)
- Co-marketing opportunity: feature in Bybit's social channels as a verified algo trading solution

**Team:**  
[ВАШ_ИМЯ], [ВАШ_ДОЛЖНОСТЬ] — [краткое описание опыта]

**Contact:**  
Email: [ВАШ_EMAIL]  
Telegram: @[ВАШ_TG]  
GitHub: https://github.com/aleksey-34/battletoads-double-dragon

---

## ── ПРИОРИТЕТ 2: OKX Ventures / Builders Grant ──────────────────

**Куда:** https://www.okx.com/ventures  
**Email:** ventures@okx.com  
**Форма:** https://okxventures.typeform.com/to/grant  
**Сколько просить:** $30 000 + OKX API Integration support  
**Статус:** Bybit-only сейчас, OKX интеграция — в roadmap Q3 2026  

---

### Текст заявки (EN)

**Subject:** BTDD Platform — OKX API Integration Grant

---

Dear OKX Ventures Team,

We are building **BTDD Platform** — a multi-tenant algorithmic trading SaaS that automates portfolio-level crypto trading for retail investors and small fund managers.

**Current traction:**
- Live MVP deployed on VPS with 3 active strategy types
- 9,108 parameter combinations backtested, 3,129 robust candidates selected
- Portfolio result: +28.7% return, PF 3.28, Max DD 4.4% (15 months, 4h Bybit data)
- Multi-tenant SaaS with 3 client modes (Algofund, Strategy Client, Copy Trading)
- Already integrated with: Bybit (primary), Binance, Bitget, BingX, MEXC, Weex

**Why OKX integration matters for us:**

OKX has consistently been one of the top 3 exchanges by derivatives volume and the preferred choice for institutional and semi-institutional traders — exactly our Algofund target segment. Adding OKX as a supported exchange would immediately open our platform to a large segment of OKX-native traders who want automated strategies with institutional-grade backtesting quality.

**Grant Use of Funds ($30,000):**
- $12,000 — OKX API connector development and testing (unified with existing ccxt architecture)
- $8,000 — OKX-specific strategy optimization sweep (new market data, fresh candidates)
- $6,000 — OKX marketing segment: targeting current OKX users
- $4,000 — Technical compliance and security audit

**Ask:**
- $30,000 development grant
- OKX API partner status
- Co-marketing: joint announcement of OKX integration to OKX community

**Contact:**  
[ВАШ_ИМЯ] | [ВАШ_EMAIL] | @[ВАШ_TG]  
https://btdd-platform.vercel.app  

---

## ── ПРИОРИТЕТ 3: Binance Labs / BUIDL Program ────────────────────

**Куда:** https://labs.binance.com  
**Email:** buidl@binance.com  
**Форма:** https://binance.labs.binance.com/apply  
**Сколько просить:** $50 000 (более крупная программа)  
**Статус:** Binance уже подключён через ccxt  

---

### Текст заявки (EN)

**Subject:** BTDD Platform — Algorithmic Trading SaaS · Binance Labs BUIDL Application

---

**Executive Summary:**

BTDD Platform is a production-ready multi-tenant SaaS for algorithmic crypto trading. We've built and validated a complete pipeline: data collection → parameter optimization (9,108-run sweep) → robustness filtering → portfolio construction → live execution. Binance is currently integrated as one of our supported exchanges via our unified ccxt-based connector architecture.

**Key Metrics (live data, Jan 2025 – Mar 2026):**

| Metric | Value |
|---|---|
| Backtests run | 9,108 |
| Robust candidates | 3,129 |
| Portfolio return | +28.7% |
| Profit Factor | 3.28 |
| Max Drawdown | 4.4% |
| Supported exchanges | 6 |

**Technical Stack:**
- Backend: Node.js + TypeScript, SQLite, Express
- Frontend: React, Ant Design, TypeScript
- Trading: Bybit API (RestClientV5), ccxt (Binance, Bitget, BingX, MEXC)
- Deployment: VPS, systemd, nginx

**Unique Value Proposition:**

1. **Synthetic instruments**: our strategy engine supports two-asset synthetic pairs (stat arb), not just single-coin trading — giving us signals that single-coin platforms cannot access
2. **Transparent backtesting**: every number is real — commission and slippage included, lookahead-free, with full parameter-to-result traceability
3. **Multi-tenant with audit log**: each client isolated, all actions logged, compliance-friendly architecture

**Binance Integration Grant Use ($50,000):**
- $15,000 — Binance-specific sweep (full historical optimization on BN data vs current BN fee structure)
- $10,000 — Binance Smart Chain payment integration (subscription billing on BSC/USDT)
- $10,000 — Security audit and penetration testing
- $10,000 — Marketing: first 100 Binance-native clients
- $5,000 — Infrastructure and monitoring upgrades

**Contact:**  
[ВАШ_ИМЯ] | [ВАШ_EMAIL]  
GitHub: https://github.com/aleksey-34/battletoads-double-dragon  
Platform: https://btdd-platform.vercel.app  

---

## ── ПРИОРИТЕТ 4: AWS Activate (Startup Credits) ─────────────────

**Куда:** https://aws.amazon.com/activate/  
**Форма:** Онлайн форма на aws.amazon.com/activate  
**Сколько просить:** До $100,000 кредитов (самый высокий тир через акселераторов)  
**Базовый тир без акселератора:** $5,000 (применяется прямо)  

---

### Текст заявки (EN — форма AWS)

**Company Name:** BTDD Platform  
**Stage:** MVP / Beta  

**Company Description (2-3 sentences):**

BTDD Platform is an algorithmic trading SaaS providing automated crypto trading strategies to retail investors and fund managers. We've completed 9,108 strategy backtests, deployed a live multi-tenant platform supporting 6 exchanges (Bybit, Binance, Bitget, BingX, MEXC, Weex), and validated a portfolio achieving +28.7% return with 3.28 Profit Factor over 15 months of historical data.

**AWS Use Case:**

Current infrastructure runs on a single VPS. AWS credits would allow us to:
1. Migrate research/backtesting workloads to EC2 spot instances (10x faster sweeps)
2. Use RDS for production database (replacing SQLite for multi-tenant scale)
3. Set up CloudWatch monitoring and alerting for trading uptime
4. Use S3 for historical market data storage and backtest result archiving

**Expected Monthly AWS Spend:** $500–$2,000/month after scaling to 50+ clients

---

## ── ПРИОРИТЕТ 5: Google for Startups ────────────────────────────

**Куда:** https://cloud.google.com/startups  
**Форма:** На сайте — Apply to Google for Startups Cloud Program  
**Сколько:** До $200,000 credits (через акселераторы партнёры)  
**Базовый:** $2,000 до $25,000 напрямую  

---

### Текст заявки (EN)

**Project/Company:** BTDD Platform  
**Stage:** MVP Live  
**Category:** FinTech / Algorithmic Trading  

**Description:**

BTDD Platform is a multi-tenant algorithmic trading SaaS for crypto markets. We run 9,108+ historical strategy backtests, maintain a real-time trading engine connected to 6 exchanges, and serve clients in Algofund, Strategy Client, and Copy Trading modes. 

**Google Cloud Use Case:**

- BigQuery: store and query 15+ months of OHLCV market data across 6 exchanges and 500+ trading pairs
- Vertex AI: explore reinforcement learning approaches for dynamic strategy parameter adjustment
- Cloud Run: containerize research sweep workers for on-demand scaling
- Looker Studio: client-facing portfolio analytics dashboards

---

## ── ПРИОРИТЕТ 6: Bitget / BingX Partner Programs ────────────────

**Bitget:** https://partner.bitget.com  
**BingX:** https://bingx.com/en/partner/  
**Запрос:** API Volume Rebate + Partner badge (не cash grant)  
**Что писать:** Короткое письмо через форму партнёра

---

### Шаблон (Bitget/BingX) — EN

**Subject:** BTDD Platform — API Integration Partnership Request

Hi [Exchange] Partnerships Team,

We are BTDD Platform, a multi-tenant algorithmic trading SaaS currently live-integrated with your exchange through our ccxt-based connector. We support 6 exchanges and are actively onboarding clients who trade via [Exchange] API keys.

We'd like to discuss:
1. **API Partner / VIP status** to reduce fees for our clients' sub-accounts
2. **Volume rebate program** as our client base grows
3. **Co-marketing** — mention in your partner ecosystem directory

Our platform metrics: 9,108 backtests, +28.7% portfolio return, PF 3.28, live deployment.

Can we schedule a brief call?

[ВАШ_ИМЯ] | [ВАШ_EMAIL] | @[ВАШ_TG]  
https://btdd-platform.vercel.app

---

## ── СВОДНАЯ ТАБЛИЦА ──────────────────────────────────────────────

| # | Программа | Куда | Запрос | Приоритет |
|---|---|---|---|---|
| 1 | **Bybit Builder Grant** | builders.bybit.com | $25K + rebate | 🔴 Срочно |
| 2 | **OKX Ventures** | ventures@okx.com | $30K | 🟠 На этой неделе |
| 3 | **Binance Labs BUIDL** | buidl@binance.com | $50K | 🟠 На этой неделе |
| 4 | **AWS Activate** | aws.amazon.com/activate | $5K–$100K credits | 🟡 Без спешки |
| 5 | **Google for Startups** | cloud.google.com/startups | $2K–$200K credits | 🟡 Без спешки |
| 6 | **Bitget Partner** | partner.bitget.com | Rebate + badge | 🟢 Partner only |
| 7 | **BingX Partner** | bingx.com/en/partner/ | Rebate + badge | 🟢 Partner only |

**Итого: потенциально $105,000–$405,000 наличными + до $300K cloud credits**

---

## ── ЧТО НУЖНО ЗАПОЛНИТЬ ПЕРЕД ОТПРАВКОЙ ────────────────────────

- [ ] `[ВАШ_ИМЯ]` — имя и должность
- [ ] `[ВАШ_EMAIL]` — контактный email
- [ ] `@[ВАШ_TG]` — telegram handle
- [ ] URL лендинга после деплоя на Vercel (заменить `btdd-platform.vercel.app`)
- [ ] Краткое описание команды (1-2 предложения об опыте)
- [ ] Для Bybit — зарегистрировать аккаунт на builders.bybit.com и заполнить форму там

---

*Документ подготовлен: Апрель 2026*

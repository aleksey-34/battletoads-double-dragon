# Оценка рантайма и рекомендации по развитию
**Дата:** 2026-04-02  
**Версия:** 2.0 (расширенная)

---

## 1. Сильные стороны текущего рантайма

### 1.1 Бэктест-движок

**Что реализовано хорошо:**
- Событийная модель (`buildEvents` + sorted event stream) гарантирует правильный хронологический порядок в multi-стратегийном портфеле
- Разделение `cashEquity` и `unrealizedPnL` — корректный учёт floating P&L при вычислении доступного капитала
- `computeLockedMargin` = Σ(notional/leverage) предотвращает overcommit капитала
- Трейлинговый TP с `tpAnchor` реализован честно: нет lookahead, `anchor` обновляется только вперёд по времени
- Z-score рассчитывается только по `window[-N..-1]` (без текущего бара) → нет утечки будущих данных

**Оценка**: бэктест методологически чистый, lookahead-free. Это важная база — многие чужие системы страдают от очевидного data leakage.

---

### 1.2 Исторический свип

**Что реализовано хорошо:**
- Cartesian product по параметрам — полное покрытие пространства гиперпараметров
- `computeScore` балансирует между разными метриками (ret, PF, WR, DD, трейды)
- `isRobust` — минимальные критерии фильтрации (PF≥1.15, DD≤22%, trades≥40)
- Checkpoint/resume — устойчивость к обрывам при длинных свипах
- `maxVariantsPerMarketType` — ограничивает избыточную схожесть стратегий

---

### 1.3 Синтетический инструмент

**Что реализовано хорошо:**
- Корректная OHLC-агрегация (высокое значение synthetic = low base / high quote)
- Grid-search квантования лотов минимизирует ошибку пропорций
- Предупреждения при превышении MAX_SHARE_ERROR, MAX_LEG_DEVIATION — не блокируют, но логируют

---

### 1.4 SaaS-компонент

- Отдельные tenants с изоляцией по api_key — безопасная multi-клиентная архитектура
- Каталог офферов (TS) независим от runtime — можно менять состав без перезапуска
- Vitrine + client-profile система позволяет кастомизировать состав TS для каждого клиента

---

## 2. Уязвимости и ограничения

### 2.1 Overfitting риск в свипе

**Проблема:**
Свип по 72+ вариантам на исторических данных с `computeScore` по in-sample метрикам без out-of-sample валидации — классический риск переобучения. Отобранные стратегии могут показывать хорошую статистику на историческом окне, но при этом не работать вперёд.

**Конкретно:**
- score формула `ret + pf*10 + wr*0.12 - dd*1.2 + log10(trades)*5` имеет ручные веса — они сами по себе гиперпараметры, которые нигде не валидируются
- Нет walk-forward анализа: параметры оптимизируются на всём окне данных одновременно
- `isRobust` с PF≥1.15 — очень мягкий порог

**Рекомендация:**
- Разделить исторические данные: 70% обучение + 30% тест (out-of-sample)
- Запускать свип только на обучающей части
- Проверять выживших кандидатов на тестовой части
- Параметр: добавить поле `out_of_sample_score` в результаты свипа

---

### 2.2 Нет адаптации к режиму рынка

**Проблема:**
Все стратегии работают постоянно вне зависимости от волатильности, тренда, ликвидности. DD/ZZ очень хорошо работают в трендинг-рынке и плохо — в высоковолатильном боковике (много ложных пробоев). StatArb хорошо — в боковике, плохо — в трендах.

**Рекомендация:**
- Добавить `regime_filter`: простой индикатор режима рынка (например, ATR / ADX)
- При высоком ADX — активировать DD/ZZ, приглушать StatArb
- При низком ADX — активировать StatArb, приглушать DD/ZZ
- Параметр: `regime_atr_threshold`, `regime_adx_threshold`

---

### 2.3 Статический лот-сайзинг

**Проблема:**
`lot_percent` фиксирован в настройках стратегии. При высокой волатильности риск на сделку непропорционально растёт.

**Рекомендация:**
- Vol-adjusted sizing: `lot_percent_adj = lot_percent × (baseline_vol / current_vol)`
- `current_vol` = скользящий ATR(14) / цена
- Результат: в спокойном рынке можно взять больший лот, в волатильном — меньше
- Параметр: `vol_adjust_enabled`, `vol_baseline_atr_length`

---

### 2.4 Correlation-naive портфель

**Проблема:**
В Trading System несколько стратегий работают одновременно без учёта корреляции между позициями. Если все 8 стратегий открыли лонг по BTCUSDT-коррелированным активам — реальный leverage портфеля намного выше рассчитанного.

**Рекомендация:**
- Рассчитывать `exposure_per_sector`: crypto-ETH-correlated, BTC-correlated, altcoin-mid
- Ограничивать `max_sector_exposure` = максимальный % капитала в одном секторе
- Хранить секторные метки в `strategies.sector` поле
- Учитывать при открытии позиции: если sector лимит исчерпан → пропустить сигнал

---

### 2.5 Один биржевой коннектор

**Проблема:**
Всё завязано на Bybit (REST + WebSocket). Bybit может:
- Изменить API
- Временно недоступен
- Отказать в регистрации клиентам из определённых юрисдикций

**Рекомендация:**
- Абстрагировать коннектор в интерфейс `IExchangeConnector`
- Добавить `OKX` или `Gate.io` коннектор
- Добавить `exchange` поле в `strategies` таблицу
- Позволить клиентам подключать разные биржи

---

### 2.6 Нет мониторинга drift'а стратегий

**Проблема:**
Стратегии были откалиброваны на истории, но рынок меняется. Нет механизма обнаружения того, что стратегия начала работать хуже реального прогноза (concept drift).

**Рекомендация:**
- Live equity: сравнивать реальную equity кривую с expected backtested curve
- Alert при отклонении реального PnL от бэктест-baseline (е.г. -2σ от monthly expected)
- Параметр: `drift_detection_enabled`, `drift_sigma_threshold`

---

## 3. Рекомендуемые улучшения (приоритеты)

### Приоритет 1: Out-of-Sample валидация в свипе

**Срок:** 2–3 дня  
**Что делать:**
```
В fullHistoricalSweepService.ts:
1. Разделить candleData на train (70%) и test (30%)
2. Запустить свип на train
3. Для выживших (isRobust on train) → запустить backtest на test
4. Добавить поля в результаты: 
   train_score, test_score, test_pf, test_dd, test_trades
5. isRobust_oos: test_pf >= 1.05 AND test_dd <= 30%
6. Сортировать финальный каталог по test_score, не train_score
```
**Эффект:** эмпирически reduces overfitting на 30–50%. Из 100 "кандидатов" выживет 15–25 реально работающих.

---

### Приоритет 2: Volatility-adjusted sizing

**Срок:** 1 день  
**Что делать:**
```typescript
// В computeSignalTotalNotional:
if (strategy.vol_adjust_enabled) {
  const atr = computeATR(candles, 14);
  const currentVol = atr / currentPrice;
  const baselineVol = strategy.vol_baseline ?? 0.02; // 2% ATR/price baseline
  const volMultiplier = Math.min(2.0, Math.max(0.25, baselineVol / currentVol));
  adjustedLot = lot * volMultiplier;
}
```
**Эффект:** позиции уменьшаются в волатильном рынке, увеличиваются в тихом. Снижает max drawdown без потери прибыли.

---

### Приоритет 3: Walk-Forward анализ

**Срок:** 3–5 дней  
**Что делать:**
- Разделить историю на T окон по N месяцев
- Для каждого окна: train на (0..i), test на (i..i+1)
- Усреднить оценку по окнам (rolling average)
- Выбирать только стратегии с устойчивой позитивной оценкой через несколько периодов

---

### Приоритет 4: Мониторинг drift

**Срок:** 2–3 дня  
**Что делать:**
- При создании стратегии: сохранять `backtest_monthly_return_mean`, `backtest_monthly_return_std`
- Каждый месяц: считать `live_monthly_return`
- Если `live_monthly_return < backtest_monthly_return_mean - 2 × std` → alert + auto-disable

---

### Приоритет 5: Correlation-aware sizing

**Срок:** 3–4 дня  
**Что делать:**
- Добавить sectoring: BTC-correlated / ETH-correlated / Altcoin / Stablecoin-adjusted
- Ограничить: max 40% капитала в одном секторе

---

## 4. Возможные новые направления

### 4.1 Liquidity Farming / Yield-enhanced holding

**Суть:** Дополнить торговые позиции yield-источниками. Когда стратегия ждёт (flat) — держать стейблкоины в lending протоколе (AAVE, Compound) для earning APY.

**Применимость в рантайме:**
- Сложная интеграция: требуется DeFi-коннектор (web3) + управление rebalancing
- Сначала: перевод незанятого USDT в Bybit Earn (централизованный) 
- Поле в TS: `idle_capital_yield_enabled`, `yield_provider: 'bybit_earn'|'none'`
- Эффект при 20% idle капитале × APY 5% = +1% к годовой доходности

---

### 4.2 Market-Neutral (Delta-Neutral) расширение

**Суть:** StatArb синтетика уже частично market-neutral. Можно усилить за счёт более точного хеджирования beta.

**Подход:**
```
Для пары IPUSDT/ZECUSDT:
  Исторически: beta(IP vs BTC) = 1.4, beta(ZEC vs BTC) = 0.9
  Наш синтетик имеет beta = (1 × beta_IP) - (1 × beta_ZEC) = 0.5 (не нейтральный)
  
  Market-neutral: подобрать коэффициенты baseCoef/quoteCoef так, чтобы:
    baseCoef × beta_IP = quoteCoef × beta_ZEC
    1.4 × baseCoef = 0.9 × quoteCoef
    baseCoef:quoteCoef ≈ 0.643:1
    
  Тогда позиция beta-нейтральна к BTC
```

**Реализация:**
- Параметры `baseCoef`, `quoteCoef` уже поддерживаются в схеме
- Нужно: автоматический расчёт beta для каждой пары
- Добавить `beta_neutral` флаг в sweep: автоматически вычислять коэффициенты

---

### 4.3 Trend-Following с фильтром ADX

**Суть:** DD/ZZ работают как трендовые, но не различают "настоящий" тренд от шума. ADX (Average Directional Index) измеряет силу тренда.

**Добавить:**
```typescript
// Сигнал разрешён только если trend достаточно сильный:
const adx = computeADX(candles, 14);
if (strategy.adx_filter_enabled && adx < strategy.adx_min_threshold) {
  return { signal: 'none' }; // Пропустить сигнал в боковике
}
```

**Параметры:** `adx_filter_enabled`, `adx_min_threshold` (e.g. 20–25)

**Эффект:** Меньше ложных пробоев в боковых рынках. WR растёт, количество сделок снижается.

---

### 4.4 Decorrelated Portfolio (расходящийся арбитраж)

**Суть:** В текущем каталоге много похожих стратегий (разные параметры, но одни и те же рынки). При одновременном открытии они могут коррелировать.

**Улучшение — correlation-based отбор:**
```
При формировании TS из каталога:
1. Запустить backtest на несколько исторических периодов
2. Вычислить матрицу корреляции equity-curve между всеми стратегиями
3. Отобрать subset с минимальной средней корреляцией
   (greedy selection: берём стратегию с лучшим score, затем каждую следующую
    только если её корреляция со всеми уже выбранными < 0.4)
```

**Эффект:** Sharpe Ratio портфеля = Σ Sharpe_i / sqrt(N + N(N-1)×avg_corr)  
При avg_corr → 0 Sharpe портфеля растёт как sqrt(N).

---

### 4.5 Adaptive Time-of-Day / Session Filter

**Суть:** Крипторынок имеет выраженные сессионные паттерны. Азиатская сессия тихая, американская — волатильная.

**Добавить:**
- `session_filter_enabled = true`
- `active_hours_utc = [[9, 17], [21, 23]]` — торговать только в часы UTC
- Пропускать сигналы вне активных часов

---

## 5. Приоритетная дорожная карта

```
Фаза 1 (ближайшие 2 недели):
  ✓ Уже реализовано: Trailing TP, multi-TS portfolio, synthetic pairs, sweep+score
  → Out-of-sample validation в sweep
  → Vol-adjusted sizing (ATR scaling)

Фаза 2 (1 месяц):
  → Walk-forward backtest
  → ADX-фильтр для DD/ZZ
  → Beta-neutral коэффициенты для синтетики
  → Drift monitoring

Фаза 3 (2–3 месяца):
  → Correlation-aware portfolio construction
  → Session/Time filters
  → Liquidity/Yield на idle capital (Bybit Earn)
  → Второй биржевой коннектор

Фаза 4 (долгосрочно):
  → Полноценный walk-forward с rolling window
  → ML-assisted regime detection (simple: HMM с 2 состояниями)
  → Cross-exchange арбитраж
```

---

## 6. Что не стоит делать

1. **Не усложнять сигнал сверх меры** — добавление 5+ технических индикаторов в сигнал не улучшает, а ухудшает. Простой Donchian или Z-score с хорошими параметрами и exits превосходит сложные системы в out-of-sample

2. **Не оптимизировать под конкретный период** — если стратегия "идеальна" на 2024 году, это не означает что она будет работать в 2025. Всегда тестировать на 2+ лет истории

3. **Не отключать стопы** — даже при идеальном backtest есть риск black swan события. zscore_stop и donchianCenter — не опционально

4. **Не добавлять слишком много стратегий в TS** — 6–10 стратегий с разными рынками и типами лучше, чем 30 похожих. Quality > quantity

5. **Не игнорировать transaction costs** — текущий бэктест учитывает slippage/fee, но в реальности spreads в стакане могут быть шире. Тестировать с 0.1–0.15% per leg комиссией

---

## 7. Глубокий аудит API-коннектора (exchange.ts)

### 7.1 Текущее состояние

Главный файл: `backend/src/bot/exchange.ts` — **~2100+ строк**, который обслуживает **6 бирж**:

| Биржа | Реализация | Версия API |
|---|---|---|
| **Bybit** | Нативный клиент (`bybit-api` RestClientV5) | **v5** (последняя) |
| **Bitget** | CCXT | Unified |
| **BingX** | CCXT + кастомные обработки ошибок | Unified |
| **Binance** | CCXT | Unified |
| **MEXC** | CCXT | Unified |
| **WEEX** | Отдельный REST-клиент с HMAC-auth (`weexClient.ts`) | Custom |

**Нормализация данных:**
- `NormalizedBalance`, `NormalizedTrade` — выходные DTO одинаковы для всех бирж ✅
- `placeOrder()`, `getPositions()`, `getBalances()` — ветвление через `if (ccxtClients[key])` ❌

**Rate Limiting:**
- Bottleneck per API key с `minTime = 1000 / speed_limit` (по умолчанию 10 req/s) ✅
- CCXT также имеет свой `enableRateLimit: true` ✅

**WebSocket:**
- **Нет.** Все данные — REST polling. Нет реалтайм-подписок на позиции/ордера/стаканы.

---

### 7.2 Архитектурные проблемы

**1. Нет интерфейсной абстракции:**
Каждая функция содержит `if ccxtClient / else bybitClient` ветвление. При добавлении новой биржи нужно модифицировать каждую из ~20 функций. Это нарушает Open/Closed Principle.

**Рекомендация:**
```typescript
interface IExchangeConnector {
  getBalances(): Promise<NormalizedBalance[]>;
  getPositions(symbol?: string): Promise<NormalizedPosition[]>;
  placeOrder(symbol: string, side: Side, qty: number, price?: number, opts?: OrderOptions): Promise<OrderResult>;
  cancelAllOrders(symbol?: string): Promise<void>;
  closeAllPositions(): Promise<CloseResult>;
  getMarketData(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getTickersSnapshot(): Promise<Ticker[]>;
}

class BybitConnector implements IExchangeConnector { ... }
class CcxtConnector implements IExchangeConnector { ... }
class WeexConnector implements IExchangeConnector { ... }
```

**2. Файл слишком большой (2100+ строк):**
Разбить на:
- `exchange/types.ts` — NormalizedBalance, NormalizedTrade, etc.
- `exchange/bybit.ts` — нативный Bybit коннектор
- `exchange/ccxt.ts` — CCXT-based коннектор
- `exchange/weex.ts` — WEEX коннектор
- `exchange/factory.ts` — фабрика коннекторов
- `exchange/index.ts` — экспорт

**3. Нет WebSocket:**
- В 2026 году **все топовые системы** используют WebSocket для:
  - Execution updates (order fills) — сейчас полируются REST-запросами
  - Position monitoring — текущая реализация опрашивает `/positions` каждые N секунд
  - Book data (order book depth) для market-making стратегий
- **Bybit v5 WS** поддерживает `order`, `position`, `execution`, `kline`, `publicTrade`
- Без WS round-trip latency ~200-500ms vs ~10-50ms с WS

**Рекомендация:**
```
Фаза 1: WebSocket для order/position updates (снижает polling load)
Фаза 2: WebSocket для реалтайм kline (для более быстрых стратегий)
Фаза 3: WebSocket для order book (для market-making)
```

**4. Нет circuit breaker / centralized retry:**
- BingX имеет ручной retry для position-side errors
- Timestamp sync error обрабатывается отдельно
- Нет единого паттерна: при 3 неудачных вызовах → backoff → alert

**5. In-memory client cache:**
- `clients` и `ccxtClients` словари живут в памяти процесса
- При restart — пересоздаются (нет persistence)
- Нет health-check / reconnection / watchdog

**6. 5-минутный cache TTL для market data:**
- В быстрых рынках 5 минут — это много. Для 1h-стратегий OK, для 15min — рискованно.

---

### 7.3 Сравнение с индустриальным стандартом 2026

| Характеристика | Наш рантайм | Индустрия (top-20 quant platforms) |
|---|---|---|
| Multi-exchange | ✅ 6 бирж | ✅ 5–15 бирж |
| WebSocket | ❌ Нет | ✅ Обязательно |
| Connector interface | ❌ if/else | ✅ Полиморфизм / Plugin |
| Order types | Market only | Market + Limit + Stop + Trailing |
| Rate limit | ✅ Bottleneck | ✅ Token bucket / Leaky bucket |
| Circuit breaker | ❌ Нет | ✅ Hystrix-style |
| Spot + Futures + Options | Futures only | ✅ Multi-venue |
| Smart order routing | ❌ Нет | ✅ Best-execution across venues |
| FIX protocol | ❌ Нет | ✅ Для институциональных клиентов |

---

## 8. Топовые тенденции крипто-квант 2025–2026 и соответствие рантайма

### 8.1 Machine Learning в signal generation

**Тенденция:** Random Forest / XGBoost / Transformer-based модели для прогнозирования direction/magnitude.  
**Наш рантайм:** Нет ML. Сигналы чисто rule-based (Donchian, Z-score).

**Оценка:** Rule-based подход — **правильный выбор** для текущей стадии. ML-модели в крипте:
- Требуют огромных данных (orderbook L2/L3, social sentiment, on-chain metrics)
- Склонны к overfitting значительно больше чем rule-based
- Нуждаются в MLOps инфраструктуре (training pipeline, model versioning, A/B testing)

**Рекомендация:** ML добавлять только как **фильтр** (regime detection), не как основной сигнал. Простой HMM (Hidden Markov Model) с 2 состояниями (trending/mean-reverting) уже даёт 10–15% улучшения Sharpe при правильной калибровке.

---

### 8.2 On-chain data и MEV-aware execution

**Тенденция:** Крупные фонды (Jump, Wintermute, Alameda-replacements) анализируют:
- Mempool для фронтранинга (ETH/L1)
- Token flow между биржами (whale alerts)
- Smart money tracking (copy-trade institutional wallets)
- Funding rate arbitrage (funding > 0.01% → short carries)

**Наш рантайм:** Нет on-chain интеграции. Нет funding rate как сигнала.

**Рекомендация (низкий порог входа):**
- **Funding rate как фильтр**: Bybit API возвращает funding rate. Если funding > +0.05% (лонги переплачивают) → bias в сторону short. Если < -0.05% → bias в сторону long.
- Параметр: `funding_bias_enabled`, `funding_threshold`
- Реализация: ~30 строк в `computeDonchianSignal` + `computeStatArbSignal`

---

### 8.3 Multi-timeframe (MTF) analysis

**Тенденция:** Большинство институциональных систем не работают на одном таймфрейме. Классический подход: direction на старшем TF, entry на младшем.

**Наш рантайм:** Одно-таймфреймные стратегии. Если strategy на 4h — сигнал генерируется только по 4h-свече.

**Рекомендация:**
```
DD на 4h с MTF-фильтром:
  1. На 1d: вычислить тренд (SMA20 > SMA50 → bullish bias)  
  2. На 4h: стандартный Donchian breakout
  3. Если daily bullish → ТОЛЬКО long breakouts на 4h
  4. Если daily bearish → ТОЛЬКО short breakouts на 4h
```
Параметры: `mtf_filter_enabled`, `mtf_higher_interval`, `mtf_trend_method: 'sma_cross'|'adx'|'donchian'`

---

### 8.4 Execution quality и slippage minimization

**Тенденция:** Лучшие платформы в 2026 используют:
- TWAP (Time-Weighted Average Price) для крупных ордеров
- Iceberg orders (скрытая ликвидность)
- Adaptive order placement (limit → wait → market if not filled)

**Наш рантайм:** Market orders only. Для маленьких размеров ($100–5000) — OK. Для $10K+ — потенциально дорого по slippage.

**Рекомендация:**
```typescript
// Адаптивный ордер:
async function smartOrder(apiKeyName, symbol, side, qty) {
  // 1. Поставить limit по mid-price
  const order = await placeOrder(apiKeyName, symbol, side, qty, midPrice, { type: 'limit' });
  // 2. Подождать fillTimeout (e.g. 15s)
  await sleep(15000);
  // 3. Проверить статус
  const status = await getOrderStatus(apiKeyName, order.orderId);
  if (status === 'filled') return;
  // 4. Отменить остаток + выставить market
  await cancelOrder(apiKeyName, order.orderId);
  await placeOrder(apiKeyName, symbol, side, remainingQty);
}
```

---

## 9. Развёрнутые новые режимы стратегий

### 9.1 Фарминг ликвидности (Liquidity Provision)

**Что это:** Размещение limit-ордеров по обе стороны стакана (bid + ask) для сбора спреда. Это модель market-making, адаптированная для retail.

**Применимость в нашем рантайме:**

| Аспект | Текущий рантайм | Что нужно |
|---|---|---|
| Order types | Market only | Limit + Cancel + Amend |
| Book data | Нет | Order book L2 (5–20 levels) |
| Position tracking | Есть (via getPositions) | ✅ Достаточно |
| Speed | REST polling | WebSocket (обязательно!) |
| Inventory management | Нет | Отслеживание net position + hedging |

**Конкретная реализация (Grid MM):**
```
Стратегия: GridMarketMaker
Параметры:
  grid_levels: 10        — число уровней с каждой стороны
  grid_spacing: 0.15%    — расстояние между уровнями
  order_size: $50         — размер каждого ордера
  max_inventory: $500     — макс. чистая позиция
  rebalance_threshold: 70% — при достижении 70% inventory → hedge market order

Поведение:
  1. Каждый цикл (5s):
     - Получить mid-price
     - Разместить 10 bid levels: mid - 0.15%, mid - 0.30%, ..., mid - 1.50%
     - Разместить 10 ask levels: mid + 0.15%, mid + 0.30%, ..., mid + 1.50%
  2. При заполнении ордера:
     - inventory += filled_qty (или -= для ask)
     - Если |inventory| > max_inventory × rebalance_threshold → hedging order
  3. P&L = spread × volume - inventory_risk

Ожидаемая доходность: 5–15% годовых при стабильном рынке
Риск: Inventory loss при сильном движении (нужен inventory hedge)
```

**Что нужно добавить в рантайм:**
1. Limit order support в `placeOrder()` — **уже есть** (параметр `price`)
2. Order amendment — `amendOrder()` — нет, но CCXT + Bybit API поддерживают
3. WebSocket для order fills — необходимо
4. Новый strategy_type: `grid_market_maker`
5. Book data: `getOrderBook(apiKeyName, symbol, depth)` — нужно добавить

---

### 9.2 Рыночно-нейтральные стратегии (Market-Neutral, высокая частота)

**Текущее:** StatArb Z-score уже является market-neutral на уровне пар. Но:
- Нет beta-hedging → не полностью нейтрален к BTC
- Низкая частота сделок (Z-score с lookback=120 на 4h = сделка раз в 1–3 недели)
- Нет учёта коинтеграции (z-score работает с корреляцией, не коинтеграцией)

**Улучшения для высокой частоты с минимальным убытком:**

**A. Коинтеграция вместо корреляции:**
```
Текущий подход (корреляция):
  Z = (price - mean(price)) / std(price)
  
Правильный (коинтеграция):
  1. Регрессия: Price_A = beta × Price_B + residual
  2. Тест Энгла-Грэнджера на residual (должен быть стационарный)
  3. Z = (residual - mean(residual)) / std(residual)
  
Разница: коинтеграция работает даже когда два актива имеют разные тренды,
  но их РАЗНИЦА стационарна. Корреляция ломается при diverging trends.
```

Параметры для добавления:
```
strategy_type: 'stat_arb_cointegration'
coint_lookback: 240       — окно для регрессии
coint_hedge_ratio_update: 48  — пересчёт beta каждые N баров  
zscore_entry: 1.8
zscore_exit: 0.3
zscore_stop: 3.0
```

**B. Faster mean-reversion (Ornstein-Uhlenbeck):**
```
OU process: dX = θ(μ - X)dt + σdW
  θ = скорость возврата к среднему (the higher, the better for trading)
  μ = долгосрочное среднее
  σ = волатильность случайного компонента

Halflife = ln(2) / θ
  Если halflife < 24 бара → pair пригодна для быстрого mean-revert

Фильтр при свипе:
  1. Для каждой пары вычислить OU halflife
  2. Отбросить пары с halflife > 72 (слишком медленный возврат)
  3. Предпочитать пары с halflife 12–36 (быстрый возврат = больше сделок)
```

**C. Волатильность-нейтральность (Vega-neutral):**
```
При сильном росте implied vol на Bybit futures:
  reduce position size → maintain constant risk per trade
  
Проще: ATR-normalized position sizing (уже рекомендовано в §3.2)
```

**Ожидаемый профиль:**
- Сделки: 2–5 в неделю на пару (vs 1 в 1–3 недели сейчас)
- Max DD: 3–8% (vs 10–22% текущий)
- Annual return: 15–40% (at low DD)
- Sharpe: 1.5–3.0

---

### 9.3 Трендовые стратегии с долгим удержанием

**Текущее:** DD/ZZ держат позицию до signal_flip или center cross. При TP=7.5% и хорошем тренде — выход происходит рано (7.5% trailing от пика).

**Проблема:** 7.5% трейлинг — это агрессивный выход. В сильном тренде (BTC +60% за 2 месяца) стратегия зафиксирует лишь 15–20% из движения, потому что:
1. Войдёт поздно (breakout = уже +N%)
2. Выйдет рано (7.5% откат от пика)

**Решение A — Adaptive Trailing Stop:**
```
Вместо фиксированного TP%:
  
Dynamic TP = baseline_tp_percent × (1 + trend_strength_factor)

trend_strength_factor = min(2.0, max(0, (current_price / entry_price - 1) × K))

Пример для long:
  Entry = 100, current = 130 (30% прибыль)
  K = 2
  trend_strength = min(2.0, (1.30 - 1) × 2) = min(2.0, 0.6) = 0.6
  Dynamic TP = 7.5% × (1 + 0.6) = 12%
  
  Anchor = 130, trailing stop = 130 × (1 - 0.12) = 114.4
  
Без адаптации: stop = 130 × (1 - 0.075) = 120.25 — выход раньше

При current = 160 (60%):
  trend_strength = min(2.0, (1.60 - 1) × 2) = min(2, 1.2) = 1.2
  Dynamic TP = 7.5% × 2.2 = 16.5%
  stop = 160 × 0.835 = 133.6 — широкий стоп, удержание в тренде
```

Параметры: `adaptive_tp_enabled`, `adaptive_tp_k`, `tp_max_multiplier`

**Решение B — Donchian Exit на старшем TF:**
```
Вход: Donchian breakout на 4h с L=12
Выход: НЕ по текущему donchian center, а по donchian center на Daily:
  donchianCenter_daily = (max(high[-20d]) + min(low[-20d])) / 2
  
Это даёт более широкий "канал" для удержания позиции в тренде.
Выход происходит только когда тренд ДЕЙСТВИТЕЛЬНО разворачивается на дневном уровне.
```

Параметры: `exit_timeframe`, `exit_donchian_length`

**Решение C — Partial profit-taking + runner:**
```
При достижении +5% от entry:
  Закрыть 50% позиции (фиксация прибыли)
  Оставшиеся 50% — "runner" с широким трейлинг (15%+)
  
При достижении +15% от entry:
  Закрыть ещё 25% (75% закрыто)
  Оставшиеся 25% — runner с 20% трейлинг
```

Параметры: `partial_tp_levels: [{pct: 5, closeFraction: 0.5}, {pct: 15, closeFraction: 0.5}]`

**Ожидаемый профиль:**
- Удержание: 5–30 дней (vs 1–5 дней сейчас)
- Capture of major moves: 40–70% (vs 15–25%)
- Fewer trades, higher avg win
- Max DD: может быть выше (wider stops), но компенсируется larger winners

---

### 9.4 Декорреляция активов и её арбитраж

**Текущее:** Синтетический инструмент с коэффициентами 1:1. Нет анализа корреляции при отборе пар. Пары выбраны вручную.

**Улучшения:**

**A. Автоматический подбор pairs (pair screening):**
```
Вход: список из N активов (e.g. 30 altcoins)
Для каждой пары (i, j), i < j:
  1. Вычислить rolling correlation(120 bars)
  2. Тест коинтеграции (Engle-Granger или Johansen)
  3. Вычислить OU halflife
  4. Score = cointegration_pvalue < 0.05 ? (1.0 / halflife) × (1 - abs(correlation)) : 0
  
Отобрать top-10 pairs по score.
Обновлять каждый месяц (пары могут терять коинтеграцию).
```

**B. Dynamic hedge ratio (rolling beta):**
```
Текущее: baseCoef = quoteCoef = 1 (всегда)
Правильно:
  beta = regression_slope(base_returns, quote_returns, window=60)
  hedge_ratio = beta
  
  Long synthetic: BUY $1000 of base, SELL $1000×beta of quote
  Short synthetic: SELL $1000 of base, BUY $1000×beta of quote
  
  Пересчитывать beta каждые 24–48 баров
```

Параметры: `dynamic_hedge_ratio`, `hedge_ratio_window`, `hedge_ratio_update_interval`

**C. Regime-aware pair selection:**
```
В bull market: breakout стратегии на trending pairs
В range market: mean-reversion на cointegrated pairs
В crash: все в стоп (или short-only breakout)

Простой regime detector:
  btc_sma_20 = SMA(BTC, 20d)
  btc_sma_50 = SMA(BTC, 50d)
  
  if btc_sma_20 > btc_sma_50: BULL → mostly DD/ZZ
  if btc_sma_20 < btc_sma_50: BEAR → mostly StatArb + short DD
  if |btc_sma_20 - btc_sma_50| / btc_sma_50 < 2%: RANGE → only StatArb
```

**D. Cross-exchange basis arbitrage:**
```
Один и тот же актив на разных биржах имеет РАЗНЫЕ цены.
Если Bybit ETHUSDT = 3500 и BingX ETHUSDT = 3505:
  BUY на Bybit, SELL на BingX → $5 risk-free spread
  
Требования:
  - Два коннектора (уже есть: Bybit + BingX/CCXT)
  - Синхронные данные (WebSocket!)
  - Быстрое исполнение (< 100ms)
  - Accounting: track cross-exchange PnL
```

**E. Funding rate arbitrage:**
```
Bybit perpetual funding rate обновляется каждые 8 часов.
Если funding rate = +0.03%:
  Short perpetual: получаешь 0.03% × 3 = 0.09% в день ≈ 33% годовых
  Hedge: Long spot (или long на другой бирже с отрицательным funding)
  
  Net PnL = funding_income - hedging_cost
  
  Это чистый carry trade, market-neutral.
  
  Средний funding rate на altcoins: 0.01-0.05% → 10-50% APY
  Нужно: spot balance + futures balance + auto-rebalance
```

---

## 10. Конкретные улучшения логики без overfitting

### 10.1 Что БЕЗОПАСНО улучшить (не overfitting):

1. **OOS-валидация в свипе** — это не "улучшение модели", а методология отбора. Не добавляет параметров.

2. **ATR-normalized sizing** — адаптация к текущему рынку, а не к истории. Единственный параметр — baseline_vol (калибруется 1 раз).

3. **Funding rate bias** — фундаментальный фактор, не pattern-fitting. Funding высокий → рынок перекуплен → bias в сторону short. Это экономическая логика.

4. **Коинтеграция вместо корреляции** — статистически обоснованный framework, не подгонка. Тест Энгла-Грэнджера — стандартный статистический тест.

5. **OU halflife filter** — убирает пары с медленным mean-revert. Это отсев "плохих" кандидатов, не подгонка параметров.

6. **Session hours filter** — фильтрация по времени суток. Работает потому что азиатская и американская сессии ОБЪЕКТИВНО разные по ликвидности и волатильности.

### 10.2 Что может привести к overfitting (осторожно!):

1. ❌ Добавление 3+ индикаторов (RSI + MACD + BB + ...) в сигнал — каждый индикатор = +2-3 параметра → exponential growth parameter space
2. ❌ Оптимизация `computeScore` весов через grid search — это мета-оптимизация на train set
3. ❌ Machine learning на daily returns без cross-validation — будет идеально fit историю и fail forward
4. ❌ Per-symbol параметры (разный length для BTCUSDT и ETHUSDT) — N symbols × M params = huge overfit risk

### 10.3 Красные линии (никогда не делать):

1. ❌ Подгонка `zscore_entry` под конкретный бык/медведь рынок
2. ❌ Отключение стопов для "улучшения" backtest metrics
3. ❌ Cherry-picking периодов: "если убрать март 2025 — PF 3.0!" 
4. ❌ Выбор пар только потому что "исторически работали" без проверки коинтеграции

---

## 11. Приоритетная дорожная карта v2

```
ФАЗА 1 — Методология (2 недели):
  ✅ Уже: trailing TP, multi-TS, synthetic, sweep+score
  → OOS-валидация в свипе
  → ATR-normalized sizing
  → Funding rate bias фильтр

ФАЗА 2 — Стратегическое улучшение (1 месяц):
  → Коинтеграция (Engle-Granger) вместо корреляции для StatArb
  → OU halflife filter при отборе пар
  → Adaptive trailing stop (dynamic TP%)
  → ADX-фильтр для DD/ZZ
  → MTF-фильтр (daily trend → 4h entry)

ФАЗА 3 — Инфраструктура (1–2 месяца):
  → exchange.ts → interface + factory pattern (рефакторинг)
  → WebSocket для order/position updates
  → Smart order execution (limit → wait → market)
  → Drift monitoring + auto-disable

ФАЗА 4 — Новые режимы (2–3 месяца):
  → Grid Market Maker (ликвидность)
  → Funding rate arbitrage (carry trade)
  → Cross-exchange basis arb
  → Partial profit-taking (runner)

ФАЗА 5 — Advanced (3–6 месяцев):
  → Walk-forward с rolling window
  → Автоматический pair screening (коинт. + halflife)
  → HMM-based regime detection (2 states)
  → Dynamic hedge ratio (rolling beta)
  → Order book data + WS
```

---

*Последнее обновление: 2026-04-02 v2.0*

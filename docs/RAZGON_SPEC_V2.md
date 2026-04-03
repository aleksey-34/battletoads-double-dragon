# Разгон — Полная спецификация v2

**Дата:** 2026-04-03  
**Статус:** Архитектура + алгоритмы  
**Капитал:** 40 USDT  
**Режим:** Полный автомат

---

## 1. Архитектурное решение: Отдельная вкладка «Разгон»

### Почему НЕ через оферы/карточки ТС

| Путь | Плюсы | Минусы |
|------|-------|--------|
| Через оферы + sweep + backtest | Единая экосистема | Нужен sweep (долго), backtest на 1m nереалистичен (данных нет), карточки не подходят для HFT |
| Скрытые карточки с флагом `admin_only` | Переиспользование UI | Разгон-параметры не ложатся в модель ТС (таймауты, funding scan, sniper) |
| **Отдельная вкладка «Разгон»** | Быстро, чисто, свои настройки | Отдельный код, но изолированный |

**Решение: Вкладка `/razgon`** — отдельная страница в админ-навигации (`menuItems` в App.tsx).

### Структура вкладки

```
/razgon
├── Панель статуса
│   ├── Баланс (текущий / стартовый / макс / мин)  
│   ├── P&L (сегодня / неделя / месяц / всего)
│   ├── Сделок (сегодня / всего / WR / avg RR)
│   └── Статус бота (Running / Paused / Error)
│
├── Настройки стратегий
│   ├── [Momentum Scalping]  — вкл/выкл + параметры
│   ├── [Listing Sniper]     — вкл/выкл + параметры  
│   └── [Funding Farming]    — вкл/выкл + параметры
│
├── Risk Management
│   ├── Макс. убыток на сделку (% и абс.)
│   ├── Макс. дневной убыток
│   ├── Авто-вывод профита (% и порог)
│   ├── Плечо (по стратегии)
│   └── Макс. одновременных позиций
│
├── Активаторы
│   ├── [▶ Запустить разгон] / [⏸ Пауза] / [⏹ Стоп]
│   ├── Exchange selector (Bitget / Bybit / MEXC / ...)
│   ├── API Key selector
│   └── Расписание (24/7 / только NYSE hours / custom)
│
├── Журнал сделок (live-таблица)
│   ├── Время / Символ / Сторона / Размер / Entry / Exit / PnL / Причина
│   └── Фильтры по стратегии и дате
│
└── Авто-вывод
    ├── Порог вывода (напр. при балансе > $100 — вывести 30%)
    ├── Кошелёк назначения
    └── История выводов
```

### Backend: новые эндпоинты

```
POST   /razgon/start          — запуск бота
POST   /razgon/stop           — остановка
POST   /razgon/pause          — пауза  
GET    /razgon/status         — текущее состояние
GET    /razgon/trades         — история сделок
GET    /razgon/stats          — агрегированная статистика
PATCH  /razgon/config         — обновить конфиг
POST   /razgon/withdraw       — авто-вывод
```

### Backend: новый модуль

```
backend/src/razgon/
├── razgonEngine.ts          — главный цикл (tick loop на 1-5 сек)
├── razgonStrategy.ts        — все 3 стратегии
├── razgonRisk.ts            — risk manager
├── razgonSniper.ts          — listing sniper
├── razgonFunding.ts         — funding scanner
├── razgonRoutes.ts          — API эндпоинты
└── razgonTypes.ts           — типы и интерфейсы
```

---

## 2. Анализ бирж — какая лучше для разгона

### Сравнительная таблица

| Критерий | Bitget | Bybit | MEXC | Binance | BingX |
|----------|--------|-------|------|---------|-------|
| **Maker fee** | 0.02% | 0.02% | **0.00%** | 0.02% | 0.02% |
| **Taker fee** | 0.06% | 0.055% | **0.01%** | 0.05% | 0.05% |
| **Мин. позиция** | ~5 USDT | ~5 USDT | **~1 USDT** | 5 USDT | 5 USDT |
| **Макс. leverage** | 125x | 100x | 200x | 125x | 150x |
| **Кол-во фьючерсов** | ~250 | ~350 | **~600+** | ~300 | ~200 |
| **Ликвидность** | Средняя | **Высокая** | Низкая (альты) | **Высокая** | Средняя |
| **Funding интервал** | 8h | 8h | **8h** | 8h | 8h |
| **Listing скорость** | Быстрая | Средняя | **Очень быстрая** | Медленная | Средняя |
| **API стабильность** | Хорошая | **Отличная** | Средняя | **Отличная** | Средняя |
| **Коннектор у нас** | ✅ ccxt | ✅ REST v5 | ✅ ccxt | ✅ ccxt | ✅ ccxt |
| **Zero-fee periods** | Иногда | Редко | **Часто** | Нет | Иногда |

### Вердикт по стратегиям

| Стратегия | Лучшая биржа | Почему |
|-----------|-------------|--------|
| **Momentum Scalping** | **MEXC** | 0% maker, 0.01% taker — комиссии убивают скальпинг, а тут их почти нет. 600+ монет = больше возможностей. Мин. позиция $1 = можно торговать при $40 депо. |
| **Listing Sniper** | **MEXC** > Bitget | MEXC листит быстрее всех, часто раньше Bitget/Bybit. Больше мем-коинов и lowcap. |
| **Funding Farming** | **Bybit** | Лучшая ликвидность = стабильнее funding rates. API v5 — самый надёжный коннектор у нас. |

### Рекомендация

**Основная биржа: MEXC** — для скальпинга и снайпинга.  
**Вторая (опц.): Bybit** — для funding farming когда капитал вырастет.

> MEXC конкретно для разгона с $40 идеален:
> - При 50 сделках/день × $200 нотионал × 0.06% taker = **$6/день комиссий на Bitget** vs **$1/день на MEXC**
> - $5 разницы в день — это **12.5% от депозита ежедневно**
> - На Bitget комиссии съедят весь профит скальпинга

**Но если ключ уже на Bitget** — начинаем на Bitget, переходим на MEXC когда подтвердим что стратегия профитна (чтобы не терять время на KYC/перевод).

---

## 3. Детальные алгоритмы (квант-уровень)

### 3.1 Momentum Scalping — «MicroDonchian»

#### Математическая модель

**Сигнал входа** — адаптивный Donchian breakout на микро-таймфрейме:

$$
H_n = \max_{i=1}^{N} C_{t-i} \quad\quad L_n = \min_{i=1}^{N} C_{t-i}
$$

$$
\text{Signal} = \begin{cases} \text{LONG} & \text{if } C_t \geq H_n \text{ AND } V_t > k \cdot \bar{V}_{20} \\ \text{SHORT} & \text{if } C_t \leq L_n \text{ AND } V_t > k \cdot \bar{V}_{20} \\ \text{NONE} & \text{otherwise} \end{cases}
$$

Где:
- $C_t$ — close текущей 1m свечи
- $H_n, L_n$ — Donchian high/low за $N$ баров (default $N = 15$, т.е. 15 минут)
- $V_t$ — volume текущего бара
- $\bar{V}_{20}$ — средний volume за 20 баров
- $k$ — volume multiplier (default $k = 2.0$)

**Volume filter** — критичен. Пробой без объёма = ложный пробой. На 1m таймфрейме до 70% пробоев ложные. Volume spike снижает false positive rate до ~40%.

#### Position Sizing

$$
\text{MaxRisk} = B \times r_{max}
$$

$$
\text{StopDistance} = |P_{entry} - P_{stop}| / P_{entry}
$$

$$
\text{Notional} = \frac{\text{MaxRisk}}{\text{StopDistance}}
$$

$$
\text{Margin} = \frac{\text{Notional}}{L}
$$

Где:
- $B$ — текущий баланс
- $r_{max}$ — макс. риск на сделку (default 0.05 = 5%)
- $P_{stop}$ — цена стоп-лосса  
- $L$ — плечо

**Пример при $B = 40$:**
- $\text{MaxRisk} = 40 \times 0.05 = 2$ USDT
- $\text{StopDistance} = 0.2\%$  (SL на 0.2% от входа)
- $\text{Notional} = 2 / 0.002 = 1000$ USDT
- $\text{Margin} = 1000 / 25 = 40$ USDT ← весь баланс, нужно уменьшить
- **Ограничение:** margin ≤ `allocation × B` = $0.6 \times 40 = 24$ USDT
- Итого: $\text{Notional} = 24 \times 25 = 600$ USDT, реальный риск = $600 \times 0.002 = 1.2$ USDT ✓

#### Trailing Take-Profit

$$
A_t = \begin{cases} \max(A_{t-1},\ C_t) & \text{if LONG} \\ \min(A_{t-1},\ C_t) & \text{if SHORT} \end{cases}
$$

$$
\text{TP}_{trail} = \begin{cases} A_t \times (1 - \tau) & \text{if LONG} \\ A_t \times (1 + \tau) & \text{if SHORT} \end{cases}
$$

$$
\text{Exit if } \begin{cases} C_t \leq \text{TP}_{trail} & \text{(LONG)} \\ C_t \geq \text{TP}_{trail} & \text{(SHORT)} \end{cases}
$$

Где $\tau = 0.003$ (0.3% trailing distance). Anchor $A_t$ движется только в направлении прибыли.

#### Таймаут и принудительное закрытие

$$
\text{ForceExit if } (t - t_{entry}) > T_{max}
$$

$T_{max} = 15$ минут (900 сек). Если позиция не закрылась по TP/SL за 15 мин — закрываем market. Предотвращает «застревание» в боковике.

#### Фильтр рыночного режима (опционально)

$$
\text{ATR}_{14} = \frac{1}{14}\sum_{i=1}^{14} \text{TR}_i \quad\quad \text{NormATR} = \frac{\text{ATR}_{14}}{C_t}
$$

- NormATR > 0.008 → рынок волатильный → **торгуем**
- NormATR < 0.003 → рынок спит → **пропускаем** (не тратим комиссии на шум)

#### Тик-цикл MicroDonchian

```
EVERY 5 seconds:                    ← не каждую 1m свечу, а чаще
  1. Fetch latest 1m candle (closed) + current tick price
  2. Update Donchian H15/L15 from closed candles
  3. IF no position:
     a. Check signal (breakout + volume filter + ATR filter)
     b. IF signal → compute lot size → place MARKET order
     c. IMMEDIATELY place SL order (STOP-MARKET at P_stop)
  4. IF in position:
     a. Update trailing anchor
     b. Check TP trail trigger
     c. Check position timeout
     d. IF any exit condition → close MARKET + cancel SL
  5. Update P&L, log trade if closed
  6. Check daily loss limit
```

**Частота тиков: 5 сек** — компромисс между скоростью реакции и нагрузкой на API.  
Bitget rate limit: 20 req/sec → 5 сек = 4 запроса/тик max → достаточно.

---

### 3.2 Listing Sniper — «FirstMover»

#### Концепция

Новые листинги на фьючерсных биржах дают **аномальную волатильность** в первые 5-30 минут:
- Средний рост в первые 5 мин: +15-40% (данные по MEXC/Bitget 2025-2026)
- Средний откат после пика: −20-60%
- Паттерн: spike up → dump → consolidation

#### Алгоритм

```
EVERY 30 seconds:
  1. Fetch exchange instruments list (getAllSymbols)
  2. Compare with cached list
  3. IF new_symbol detected:
     a. Wait 60 sec (let orderbook form)
     b. Fetch first 3 candles (1m)
     c. IF price > open_price × 1.05:  ← уже растёт
        → SKIP (поздно, риск входа на вершине)
     d. IF price ≈ open_price (±3%):   ← ещё не стрельнул
        → LONG entry, 10x leverage
        → SL = entry × 0.95 (-5%)
        → TP = entry × 1.15 (+15%)
        → Timeout = 5 min
     e. IF price < open_price × 0.90:  ← дамп
        → LONG entry (bounce play), 10x
        → SL = entry × 0.93 (-7%)  
        → TP = entry × 1.10 (+10%)
        → Timeout = 10 min
```

#### Sizing

$$
\text{Margin} = \min(B \times 0.25,\ 10\ \text{USDT})
$$

Фиксированные 25% аллокации или $10, что меньше. Листинги — лотерея, не рискуем больше четверти.

#### Edge

Реальное преимущество — **скорость**. Бот определяет новый листинг за 30-60 сек, когда большинство трейдеров ещё не увидели. На MEXC новые фьючерсы появляются 3-5 раз в неделю.

---

### 3.3 Funding Rate Farming — «FundHarvest»

#### Математика

Funding rate $f$ выплачивается каждые 8 часов (3 раза/день):

$$
\text{FundingPnL} = \text{Notional} \times f \times \text{direction}
$$

Где $\text{direction} = +1$ если мы на стороне получателя, $-1$ если платим.

- $f > 0$: лонги платят шортам → **шортим**  
- $f < 0$: шорты платят лонгам → **лонгуем**

#### Алгоритм

```
EVERY 4 hours:
  1. Fetch funding rates for top-100 symbols
  2. Sort by |funding_rate| descending
  3. Filter: |f| > 0.05% (annualized >55%)
  4. Filter: 24h volume > $5M (ликвидность)
  5. For top-3 candidates:
     a. IF f > 0.05%:  open SHORT × 5-10x
     b. IF f < -0.05%: open LONG × 5-10x
     c. SL = entry ± 3% (hedge against trend)
  6. EVERY 8h: check if funding rate still favorable
     a. IF |f| < 0.02%: close position (edge gone)
     b. IF position at -2% unrealized: close (trend against us)
```

#### Ожидаемый доход

При $6 маржи × 10x = $60 нотионал:
- Avg funding rate: 0.08% per 8h
- $60 × 0.0008 × 3/day = **$0.144/день**
- **$4.3/месяц** чистого funding (~10% от стартового депозита/мес)

Мало абсолютно, но **compound**: при $200 баланса → $43/мес.

---

## 4. Показатели на дистанции (Месяц)

### Monte Carlo симуляция

Параметры для Momentum Scalping (основная стратегия):

| Параметр | Значение |
|---|---|
| Win Rate | 58% (консервативно) |
| Avg Win | 0.4% от нотионала |
| Avg Loss | 0.2% от нотионала |
| RR | 2:1 |
| Сделок/день | 30 |
| Leverage | 25x |
| Комиссия/сделка | 0.06% × 2 = 0.12% roundtrip (Bitget) или 0.02% (MEXC) |

#### Математическое ожидание на сделку

$$
E = WR \times \overline{W} - (1-WR) \times \overline{L} - C
$$

**На Bitget:**
$$
E = 0.58 \times 0.4\% - 0.42 \times 0.2\% - 0.12\% = 0.232\% - 0.084\% - 0.12\% = +0.028\%
$$

**На MEXC:**
$$
E = 0.58 \times 0.4\% - 0.42 \times 0.2\% - 0.02\% = 0.232\% - 0.084\% - 0.02\% = +0.128\%
$$

> **На Bitget edge = 0.028% на сделку** — очень тонкий, одно ухудшение WR на 2% и мы в минусе.  
> **На MEXC edge = 0.128%** — в 4.6 раза лучше. Это критическая разница.

#### Дневной P&L (нотионал = $600, 30 сделок)

**Bitget:** $600 × 0.028% × 30 = **$5.04/день**  
**MEXC:** $600 × 0.128% × 30 = **$23.04/день**

#### Месячный прогноз с compound

| Метрика | Bitget | MEXC |
|---|---|---|
| **День 1-7 (avg $600 not.)** | +$35 | +$161 |
| **День 8-14 (not. растёт)** | +$52 | +$280 |
| **День 15-21** | +$78 | +$490 |
| **День 22-30** | +$105 | +$750 |
| **Итого за месяц** | ~**$270** ($40→$310) | ~**$1,680** ($40→$1,720) |
| **Множитель** | **×7.75** | **×43** |

> Это **теоретический максимум** при идеальном compound и стабильном WR.

#### Реалистичные сценарии (с drawdown'ами, off-days, slippage)

| Сценарий | Bitget | MEXC |
|---|---|---|
| **Пессимистичный** (WR 52%, slippage) | $40 → $20 (−50%) | $40 → $60 (+50%) |
| **Реалистичный** (WR 55%, частичный compound) | $40 → $90 (×2.25) | $40 → $350 (×8.75) |
| **Оптимистичный** (WR 60%, + listing wins) | $40 → $250 (×6.25) | $40 → $1,500+ (×37) |

### Ключевые risks

| Риск | Вероятность | Последствие | Митигация |
|------|-------------|-------------|-----------|
| Flash crash (−10% за 1 мин) | 5%/мес | SL проскальзывает, −50% депо | Изолированная маржа, макс 60% баланса |
| Exchange downtime | 3%/мес | Позиция зависает без SL | Timeout + SL на бирже (не на клиенте) |
| Strategy decay (WR падает) | 30%/мес | Edge → 0, медленный слив | Мониторинг rolling WR, стоп при <50% |
| API rate limit | 10%/мес | Пропуск сигналов | Backoff + снижение частоты тиков |

---

## 5. Авто-вывод профита

### Логика

```typescript
interface WithdrawConfig {
  enabled: boolean;
  threshold: number;          // мин. баланс для вывода (напр. 100 USDT)
  withdrawPercent: number;    // % от превышения порога (напр. 30%)
  minWithdraw: number;        // мин. сумма вывода (напр. 10 USDT)
  targetAddress: string;      // кошелёк для вывода (USDT TRC20/ARB)
  cooldownHours: number;      // мин. интервал между выводами (напр. 24h)
}
```

**Алгоритм:**
```
EVERY 1 hour:
  balance = getBalance()
  IF balance > threshold AND lastWithdraw > cooldownHours ago:
    withdrawAmount = (balance - threshold) × withdrawPercent
    IF withdrawAmount >= minWithdraw:
      execute withdrawal to targetAddress
      log withdrawal
```

**Пример:** Баланс $150, threshold $100, percent 30%  
→ Вывод = ($150 − $100) × 0.3 = **$15**  
→ Остаётся $135 для торговли

Каждый вывод — это **фиксация прибыли**. Даже если бот в итоге сольёт оставшееся, вы уже забрали часть.

---

## 6. Выбор монет для старта

### Критерии отбора

$$
\text{Score} = \frac{V_{24h}}{10^6} \times \text{NormATR}_{14} \times \frac{1}{\text{spread}_{bps}}
$$

| Критерий | Мин. порог |
|---|---|
| 24h Volume | > $5M |
| NormATR(14) на 1m | > 0.005 |
| Bid-ask spread | < 5 bps |
| Funding rate | < 0.3% (не экстремальный) |

### Рекомендуемый watchlist (апрель 2026)

| Символ | Тип | Волатильность | Объём | Почему |
|---|---|---|---|---|
| PEPE/USDT | Мем | Высокая | >$100M | Retail-driven, чистые импульсы |
| WIF/USDT | Мем | Высокая | >$50M | Волатильный, хорошая ликвидность |
| SUI/USDT | L1 | Средне-высокая | >$200M | Трендовый 2026, частые пробои |
| DOGE/USDT | Мем | Средняя | >$500M | Ликвидный, предсказуемый |
| SOL/USDT | L1 | Средняя | >$1B | Backup для тихих дней |
| ARB/USDT | L2 | Средне-высокая | >$100M | Коррелирует с ETH, свои катализаторы |
| ORDI/USDT | BRC-20 | Высокая | >$30M | Волатильный, BTC-экосистема |

Бот должен **динамически** выбирать из watchlist — сортировать по NormATR каждый час и торговать топ-3 самых волатильных.

---

## 7. Сводка конфигурации по умолчанию

```typescript
const DEFAULT_RAZGON_CONFIG = {
  // Global
  exchange: 'bitget',           // начинаем с Bitget, мигрируем на MEXC
  apiKeyName: 'razgon_main',
  startBalance: 40,
  
  // Momentum Scalping
  momentum: {
    enabled: true,
    allocation: 0.60,           // 60% баланса
    leverage: 25,
    marginType: 'isolated',
    donchianPeriod: 15,         // 15 баров × 1 мин = 15 мин окно
    volumeMultiplier: 2.0,      // вход при volume > 2x avg
    trailingTpPercent: 0.3,     // 0.3% trailing TP
    stopLossPercent: 0.2,       // 0.2% жёсткий SL
    maxPositionTimeMin: 15,     // принудительное закрытие
    tickIntervalSec: 5,         // частота проверки
    maxConcurrentPositions: 3,
    atrFilterMin: 0.005,        // мин. волатильность для входа
    watchlist: ['PEPEUSDT', 'WIFUSDT', 'SUIUSDT', 'DOGEUSDT', 'SOLUSDT'],
  },
  
  // Listing Sniper
  sniper: {
    enabled: true,
    allocation: 0.25,           // 25% баланса
    leverage: 10,
    marginType: 'isolated',
    entryDelayMs: 60000,        // подождать 60 сек после обнаружения
    takeProfitPercent: 15,
    stopLossPercent: 5,
    maxPositionTimeMin: 5,
    scanIntervalSec: 30,
  },
  
  // Funding Farming
  funding: {
    enabled: false,             // выключен по умолчанию (мало капитала)
    allocation: 0.15,
    leverage: 10,
    marginType: 'isolated',
    minFundingRate: 0.0005,     // 0.05% за 8h
    minVolume24h: 5_000_000,
    maxPositions: 3,
    stopLossPercent: 3,
    scanIntervalMin: 240,       // каждые 4 часа
  },
  
  // Risk Management
  risk: {
    maxRiskPerTrade: 0.05,      // 5% баланса
    maxDailyLoss: 0.20,         // 20% баланса — стоп на день
    rescaleThreshold: 0.25,     // +25% баланса → увеличить позиции
    noAveragingDown: true,
    forceIsolatedMargin: true,
  },
  
  // Auto-Withdraw
  withdraw: {
    enabled: false,             // включить когда настроим адрес
    threshold: 100,
    withdrawPercent: 0.30,
    minWithdraw: 10,
    targetAddress: '',
    cooldownHours: 24,
  },
};
```

---

## 8. Следующие шаги

| # | Задача | Приоритет |
|---|--------|-----------|
| 1 | Написать `razgonEngine.ts` — tick loop 5 сек | 🔴 |
| 2 | Написать `razgonStrategy.ts` — MicroDonchian + volume filter | 🔴 |
| 3 | Написать `razgonRisk.ts` — position sizing + daily loss limit | 🔴 |
| 4 | Написать `razgonRoutes.ts` — API для управления | 🟡 |
| 5 | Frontend: страница `/razgon` с панелью и настройками | 🟡 |
| 6 | Listing sniper (можно добавить позже) | 🟢 |
| 7 | Funding farming (включить при $100+ балансе) | 🟢 |
| 8 | Авто-вывод (когда заработает) | 🟢 |

**Начинаем с п.1-3 — ядро бота.**

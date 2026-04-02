# BTDD Runtime Architecture
**Дата:** 2026-04-02  
**Версия:** 2.0 (post-commit 436771b)

---

## 1. Общая схема системы

```
┌────────────────────────────────────────────────────────────────────┐
│                         VPS 176.57.184.98                          │
│                                                                    │
│  ┌──────────────────────┐   ┌───────────────────────────────────┐  │
│  │   btdd-api.service   │   │      btdd-runtime.service         │  │
│  │  Express HTTP :3001  │   │  Торговые стратегии + мониторинг  │  │
│  │                      │   │                                   │  │
│  │  /api/strategies     │   │  SchedulerService → executeAll()  │  │
│  │  /api/backtest       │   │  MonitoringService                │  │
│  │  /api/saas/*         │   │  AutoUpdateManager                │  │
│  └──────────┬───────────┘   └──────────────┬────────────────────┘  │
│             │                              │                        │
│  ┌──────────▼──────────────────────────────▼────────────────────┐  │
│  │                SQLite database.db                            │  │
│  │  strategies · api_keys · tenants · algofund_profiles         │  │
│  │  backtest_runs · trading_systems · ts_members                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │   btdd-research.service  (отдельный процесс)                │   │
│  │   Research DB (research.db) · Sweep Scheduler               │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
             ↕ nginx port 80                ↕ Bybit REST API
         React SPA (admin + client)      Биржевые операции
```

---

## 2. Торговый движок (Trading Engine)

### 2.1 Цикл исполнения

```
SchedulerService.tick()
  └─► getActiveStrategies()           # список стратегий с is_active=true
  └─► для каждой стратегии:
        └─► executeStrategy(strategy, apiKeyName, { dedupeClosedBar: true })
```

`executeStrategy()` — основная функция исполнения одной стратегии:

```
1. loadStrategyCandles(apiKeyName, strategy, limit)
      │
      ├── [моно-режим]   getMarketData(base_symbol, interval)
      │                  → raw OHLCV array
      │
      └── [синт-режим]   calculateSyntheticOHLC(base, quote, baseCoef, quoteCoef, interval)
                         → массив синтетических свечей

2. resolveExecutionCandleContext(candles, interval, closedBarOnly)
      │   closedBarlOnly=true → использовать только закрытый бар
      │   (проверка freshness: bar_time + interval_ms > now + 1500ms → skip)
      └── → { candlesForSignal, evaluatedBarTimeMs }

3. dedupeClosedBar-проверка
      └── если этот бар уже обработан (processedClosedBarByStrategy) → skip

4. computeSignal(strategyType, candles, length, source, zscoreEntry, ...)
      │
      ├── DD_BattleToads / zz_breakout → computeDonchianSignal()
      └── stat_arb_zscore              → computeStatArbSignal()
      → { signal, currentRatio, donchianHigh, donchianLow, donchianCenter, zScore }

5. Проверка выхода из позиции (если state != 'flat')
      ├── [DD/ZZ] Trailing TP: current <= peak*(1-tp%) → close
      ├── [DD/ZZ] Center SL:   current <= donchianCenter (long) → close
      ├── [StatArb] ZScore exit: zScore >= -zscore_exit (long) → close
      └── [StatArb] ZScore stop: zScore <= -zscore_stop (long) → close

6. Проверка входа (если signal != 'none')
      ├── если state == противоположное → закрыть позицию (signal flip)
      └── openPosition(signal) → size, orders

7. Обновить state, entry_ratio, tp_anchor_ratio в БД
```

### 2.2 Моно-режим (mono)

- Один актив: `base_symbol` (например, `BTCUSDT`)
- Данные: стандартный OHLCV от биржи
- Открытие позиции: `placeOrder(symbol, side, qty)` — одним ордером
- Размер: `buildSingleQtyPlan(symbol, price, targetNotional)`

### 2.3 Синтетический режим (synthetic)

- Два актива: `base_symbol / quote_symbol` (например, `BTCUSDT/ETHUSDT`)
- Цена = `(baseCoef × base_price) / (quoteCoef × quote_price)`
- Синтетическая свеча строится попарно по timestamp

**Long synthetic** = BUY base + SELL quote  
**Short synthetic** = SELL base + BUY quote

**Порядок исполнения**:
1. Получить цены base и quote
2. Рассчитать `buildBalancedQtyPlan()` → `baseQty, quoteQty`
3. Разместить два ордера (base и quote) параллельно
4. Валидация: `validateLiveLegBalance()` — проверка что соотношение ног в допуске

### 2.4 Многопозиционный режим (Trading System, TS)

Когда несколько стратегий объединены в `TradingSystem`:

```
TradingSystem
  ├── member[0]: DD_BattleToads BTCUSDT/ETHUSDT 4h
  ├── member[1]: zz_breakout ORDIUSDT mono 4h
  └── member[2]: stat_arb_zscore IPUSDT/ZECUSDT 4h

Каждый member — независимая стратегия с собственным:
  - state (flat/long/short)
  - entry_price
  - tp_anchor_ratio
  - size (определяется своим max_deposit и lot_percent)

Позиции не конфликтуют по символу, если символы разные.
Если символы пересекаются — ответственность за корректность на конфигураторе.
```

**Начало работы TS**: `setTradingSystemActivation(tsId, true)` → устанавливает `is_active=true` у всех членов

**Замена состава**: `replaceTradingSystemMembersSafely()` →
1. Найти стратегии, которые будут удалены
2. Для каждой: `cancelAllOrders()` → `closeAllPositions()`
3. Обновить `ts_members` в БД

---

## 3. Расчёт размера позиции и квантование

### 3.1 Расчёт целевого нотионала

```
availableBalance = min(walletBalance, max_deposit)
targetNotional   = availableBalance × lot_percent/100 × reinvest_factor

reinvest_factor  = 1 + reinvest_percent/100  (если fixed_lot = false)
                 = 1                          (если fixed_lot = true)

Leverage ≠ мультипликатор размера.
Leverage — только параметр маржи биржи (изолированная/крест).
Notional = фактический размер ставки в USDT.
```

### 3.2 Квантование (синтетика — buildBalancedQtyPlan)

```
Задача: разбить targetNotional между base и quote так, чтобы:
  - base_notional : quote_notional ≈ baseCoef : quoteCoef
  - Каждый размер кратен qtyStep биржи
  - Итого минимально превышает targetNotional

Алгоритм:
  1. Загрузить lot rules: qtyStep, minQty, maxQty (getInstrumentInfo)
  2. rawBaseQty = baseTargetNotional / basePrice
  3. Сгенерировать кандидатов: floor(rawQty) ± 3 шага, minQty (buildQtyCandidates)
  4. Перебрать все пары (baseCand × quoteCand)
  5. Для каждой пары score = shareError×1000 + oversize×200 + totalDeviation×10
  6. Выбрать минимальный score → (baseQty, quoteQty)

Допуски:
  MAX_SHARE_ERROR    = 50%   (предупреждение, не блок)
  MAX_LEG_DEVIATION  = 30%   (предупреждение)
  MAX_TOTAL_DEVIATION= 30%
  MAX_OVERSIZE       = 20%
```

### 3.3 Квантование (моно — buildSingleQtyPlan)

```
rawQty = targetNotional / price
→ ближайший кратный qtyStep кандидат
→ если слишком мал (MIN_QTY) → использовать minQty + предупреждение (low_lot_warning)
```

---

## 4. Бэктест движок (Backtest Engine)

### 4.1 Архитектура

```
runBacktest(request)
  │
  ├── normalizeRequest() — валидация параметров
  ├── pickStrategiesForRequest() — single|portfolio
  ├── loadRuntimeStrategies() — загрузка свечей + диапазон дат
  │     ├── [mono]  getMarketData() → ParsedCandle[]
  │     └── [synth] calculateSyntheticOHLC() → ParsedCandle[]
  │     └── кэш syntheticCandleCache (во время одного запроса)
  │
  ├── buildEvents() — сортированная очередь событий
  │     [(strategyIndex0, candleIndex_warmup..end),
  │      (strategyIndex1, candleIndex_warmup..end), ...]
  │     → сортировка по timeMs, затем по strategyIndex
  │
  └── Основной цикл (event loop):
        для каждого event:
          1. applyFunding(ctx, runtime)
          2. computeSignalAtIndex(candles, candleIndex, ...)
          3. Проверить выходы (TP/SL/mean-revert)
          4. Если signal != none → открыть позицию
          5. pushEquityPoint(time)
        После всех событий: закрыть все открытые позиции (end_of_test)
```

### 4.2 Equity и Drawdown

```
portfolioEquity(t) = cashEquity + Σ unrealizedPnL(strategy_i)

unrealizedPnL(long)  = notional × (currentPrice/entryPrice - 1)
unrealizedPnL(short) = notional × (entryPrice/currentPrice - 1)

peak = max(equity_всех_точек)
drawdown(t) = (peak - equity(t)) / peak × 100
maxDrawdown = max(drawdown(t) для всех t)
```

### 4.3 Komissia, slippage, funding

```
entryPrice = price × (1 + slippage) для long
           = price × (1 - slippage) для short

exitPrice  = price × (1 - slippage) для long
           = price × (1 + slippage) для short

commissionFee = notional × commissionRate (на вход И выход)

funding (каждый бар пока позиция открыта):
  long:  cashEquity -= notional × fundingRate
  short: cashEquity += notional × fundingRate
```

### 4.4 Запуск и сохранение

| Параметр | Описание |
|---|---|
| `mode` | `single` — 1 стратегия, `portfolio` — несколько |
| `bars` | Количество баров (min 120, default 1200) |
| `dateFrom/dateTo` | Временной диапазон (ISO или timestamp) |
| `warmupBars` | Прогрев сигнала (исключаются из старта) |
| `initialBalance` | Стартовая эквити (default 1000) |
| `commissionPercent` | Комиссия (default 0.06%) |
| `slippagePercent` | Проскальзывание (default 0.03%) |
| `fundingRatePercent` | Ставка финансирования на бар (default 0%) |

Результат сохраняется через `saveBacktestRun()` в таблицу `backtest_runs` + HTML-отчёт в `logs/backtests/`.

---

## 5. Свеп-алгоритм (Historical Sweep)

### 5.1 Назначение

Массовый перебор комбинаций параметров на исторических данных с целью отбора перспективных стратегий для включения в торговую систему.

### 5.2 Параметрическое пространство

```
StrategyTypes:  [ DD_BattleToads, zz_breakout, stat_arb_zscore ]
MonoMarkets:    [ BERAUSDT, IPUSDT, ORDIUSDT, GRTUSDT, INJUSDT, TRUUSDT, STXUSDT,
                  VETUSDT, AUCTIONUSDT, MERLUSDT, ZECUSDT, SOMIUSDT ]
SynthMarkets:   [ IPUSDT/ZECUSDT, ORDIUSDT/ZECUSDT, MERLUSDT/SOMIUSDT, ... ]

DD/ZZ параметры:
  lengths:       [ 5, 8, 12, 16, 24, 36 ]
  takeProfits:   [ 2, 3, 4, 5, 7.5, 10 ] %
  sources:       [ close, wick ]
  → 6 × 6 × 2 = 72 вариантов НА рынок НА интервал

StatArb параметры:
  lengths:       [ 24, 36, 48, 72, 96, 120 ]
  zscoreEntry:   [ 1.25, 1.5, 1.75, 2.0, 2.25 ]
  zscoreExit:    [ 0.5, 0.75, 1.0 ]
  zscoreStop:    [ 2.5, 3.0, 3.5 ]
  → 6 × 5 × 3 × 3 = 270 вариантов НА рынок НА интервал
```

### 5.3 Алгоритм отбора

```
1. buildRunPlans(config) → массив всех комбинаций (SweepRunPlan[])
2. Для каждой комбинации:
   a. runBacktest(plan) → { summary }
   b. Фильтр robust:
      PF >= 1.15 AND maxDD <= 22% AND trades >= 40
   c. Расчёт score:
      score = return + PF×10 + winRate×0.12 - DD×1.2 + log10(trades)×5
   d. Сохраняем в research.db

3. Группировка: top N (maxVariantsPerMarketType=8) по score
   в каждой группе (marketType = mono|synth × market)

4. Материализация: перенос победителей в strategies таблицу
   (createStrategy или updateStrategy)

5. Checkpoint/resume каждые 25 прогонов:
   - Сохраняет текущий прогресс в JSON
   - При restart: пропускает уже выполненные planKey
```

### 5.4 Пример имени стратегии-кандидата

```
HISTSWEEP_DD_S_IPUSDT_ZECUSDT_4h_L12_TP5_SRCclose
    │      │  │  │         │    │  │   │    │
    │      │  │  base     quote │  len  tp   src
    │      │  mode(S=synth)     interval
    prefix type(DD)
    
HISTSWEEP_SZ_M_BERAUSDT_4h_L36_ZE2_ZX0_5_ZS3_5
    stat_arb z-score, mono, BERA, length=36, entry=2, exit=0.5, stop=3.5
```

---

## 6. Алгофонд (Algofund SaaS)

```
Algofund = управляемый торговый счёт клиента

Архитектура:
  AdminTradingSystem (ALGOFUND_MASTER::btdd-d1::hash)
    ├── members: [ strategy1, strategy2, ... ]
    └── publishedAlgofundSystem → runtime system

  AlgofundProfile (на клиента):
    ├── tenant_id
    ├── published_system_name → привязка к TS
    ├── actual_enabled / requested_enabled
    ├── risk_multiplier
    └── latestPreview (equity curve snapshot)

Жизненный цикл клиента:
  1. Создать tenant → algofund_profile создаётся автоматически
  2. Админ подключает клиента к TS (assignAlgofundSystems)
  3. Клиент одобряет запрос (requestAlgofundAction: 'start')
  4. Система копирует trades на API-ключ клиента
  5. Мониторинг equity, drawdown, margin load

Бэктест для Алгофонда:
  - previewAdminSweepBacktest() → algofund-ts тип
  - Снимок метрик сохраняется в tsBacktestSnapshots
  - Публикация: publishAdminTradingSystem() → создаёт/обновляет ALGOFUND_MASTER TS
```

---

## 7. Мониторинг и риск-контроль

### 7.1 MonitoringService

```
Каждые N секунд для каждого клиента:
  1. getPositions(apiKeyName) → list
  2. getBalances(apiKeyName) → equity
  3. Расчёт:
     - equity_usd
     - unrealized_pnl
     - drawdown_percent = (max_equity - equity) / max_equity × 100
     - margin_load_percent = lockedMargin / equity × 100
     - effective_leverage = positionsNotional / equity
  4. Сохранить в algofund_monitoring
  5. Если drawdown > порог → emergencyStop(tenant)
```

### 7.2 Risk параметры (на стратегию)

| Параметр | Описание |
|---|---|
| `max_deposit` | Максимальный капитал на стратегию (USDT) |
| `lot_long_percent` / `lot_short_percent` | Доля капитала на позицию (%) |
| `leverage` | Плечо биржи (1x–10x) |
| `margin_type` | `cross` / `isolated` |
| `reinvest_percent` | Процент реинвестирования прибыли |
| `fixed_lot` | Фиксированный размер (игнорирует equity) |

---

## 8. API коннекторы

Основной коннектор — **Bybit** (V5 API):
- `getMarketData(symbol, interval, limit)` → свечи
- `getPositions(apiKeyName)` → открытые позиции
- `getBalances(apiKeyName)` → баланс аккаунта
- `placeOrder(symbol, side, qty, ...)` → рыночный ордер
- `closePosition(symbol, qty, side)` → закрытие
- `cancelAllOrders(symbol)` → отмена ордеров
- `getInstrumentInfo(symbol)` → правила лота (qtyStep, minQty)
- `applySymbolRiskSettings(symbol, leverage, marginType)` → настройка рычага

Дополнительно: **Bitget**, **WEEX** (через аналогичные клиенты с passphrase для Bitget/WEEX).

---

*Последнее обновление: 2026-04-02*

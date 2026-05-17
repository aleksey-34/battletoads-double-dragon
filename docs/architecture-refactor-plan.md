# Архитектурное упрощение BTDD Platform

**Дата:** Май 2026  
**Статус:** План  
**Приоритет:** Средний (можно в Q2–Q3 2026)

---

## Проблема

Файл `backend/src/bot/strategy.ts` разросся до ~5000+ строк и содержит:
- CRUD-операции (создание, обновление, архивация стратегий)
- Mutex-ы (блокировки для предотвращения состояний гонки)
- Sizing / Risk (расчёт notional, partial TP, SL/TP)
- Сами стратегии (DoubleDragon, StatArb, ZigZag)
- Вспомогательные функции

**Последствия:**
- VSCode виснет при открытии файла
- Сложно тестировать отдельные компоненты
- Высокий порог входа для новых разработчиков
- Невозможно распараллелить работу над разными частями

---

## План рефакторинга

### 1. Модуль CRUD (`backend/src/services/strategy/crud.ts`)

```typescript
// Вынести из strategy.ts:
function createStrategy(...)
function updateStrategy(...)
function archiveStrategy(...)
function deleteStrategy(...)
function listStrategies(...)
```

**Зачем:** изолировать операции с БД от торговой логики.  
**Тестирование:** unit-тесты с in-memory SQLite.

---

### 2. Модуль Mutex (`backend/src/services/strategy/mutex.ts`)

```typescript
// Вынести из strategy.ts:
function acquireStrategyLock(strategyId: string): Promise<void>
function releaseStrategyLock(strategyId: string): void
function isStrategyLocked(strategyId: string): boolean
function withStrategyLock<T>(strategyId: string, fn: () => Promise<T>): Promise<T>
```

**Зачем:** предотвратить race conditions при параллельном исполнении.  
**Тестирование:** concurrency tests с параллельными вызовами.

---

### 3. Модуль Sizing (`backend/src/services/strategy/sizing.ts`)

```typescript
// Вынести из strategy.ts:
function computeSignalTotalNotional(strategy, balance, signal, riskMultiplier): number
function computePartialTakeProfit(position, strategy): CloseAction | null
function computeStopLoss(position, strategy): CloseAction | null
function computeTakeProfit(position, strategy): CloseAction | null
```

**Зачем:** risk-менеджмент — самая чувствительная часть, должна быть изолирована.  
**Тестирование:** unit-тесты с фиксированными входными данными.

---

### 4. Модули стратегий (`backend/src/bot/strategies/`)

```
bot/strategies/
  double-dragon.ts   — DoubleDragon Breakout
  stat-arb.ts        — StatArb Z-Score
  zigzag.ts          — ZigZag Breakout
  index.ts           — реестр стратегий
```

**Зачем:** каждая стратегия — независимый модуль со своими параметрами и логикой.  
**Тестирование:** backtest на исторических данных.

---

## План миграции

1. **Создать модули** с сигнатурами, экспортируемыми из нового файла
2. **Перенести код** из `strategy.ts` в соответствующие модули (не меняя логику)
3. **Обновить импорты** в `strategy.ts` и всех зависимых файлах
4. **Добавить unit-тесты** для каждого модуля
5. **Удалить старый код** из `strategy.ts`, оставив только фасад
6. **Прогнать полный sweep** (10 000+ прогонов) для верификации

## Ожидаемый результат

- `strategy.ts`: ~800 строк (только executeStrategy + фасад)
- Все модули: < 500 строк каждый
- VSCode больше не виснет
- Параллельная разработка возможна

---

*Документ создан для планирования. Не является блокером для production.*

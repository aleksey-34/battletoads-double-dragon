# Cloud OP3 Proposal — 2026-04-15

## Короткий Вывод

- Новый strongest signal после нижне-TF sweep: `OPUSDT/SEIUSDT` + `stat_arb_zscore`.
- Лучший основной кандидат: `MEXC 15m`.
- Лучший быстрый satellite-кандидат: `WEEX 5m` как confirm path и `MEXC 5m` как high-turnover satellite, но не как основной storefront anchor.
- Для новой cloud TS не надо делать ещё один узкий single-cluster set. Нужен **диверсифицированный cloud set** с OP-контролем и повышенной частотой сделок.

## Предлагаемая Новая TS

### Имя

- Source system: `ALGOFUND_MASTER::BTDD_D1::cloud-op3-diversified`
- Storefront card label: `Cloud OP3 Diversified`

### Роль

- Основная роль: `high-turnover diversified cloud TS`.
- Не заменяет `cloud-op2` немедленно.
- Сначала идёт как `beta cloud candidate`, затем при нормальном 12-24h runtime sample становится вторым published cloud card.

### Exchange / TF Логика

- Основной execution anchor: `MEXC 15m`.
- Быстрые satellites для увеличения turnover: `MEXC 5m`.
- Cross-exchange confirm path: `WEEX 5m`.

Причина:

- `MEXC 15m` дал лучший баланс `score / PF / DD` среди новых проверок.
- `MEXC 5m` добавляет частоту, но сам по себе слишком агрессивен, поэтому его лучше использовать с пониженным весом.
- `WEEX 5m` не главный anchor, но полезен как независимое подтверждение, что идея не полностью завязана на один execution path.

## Предлагаемая Композиция Cloud OP3

### Целевой Размер

- `6 members`
- `max_open_positions = 2`

### Целевая Структура

1. `2 core members` — `stat_arb_zscore`, `OPUSDT/SEIUSDT`, `MEXC 15m`.
2. `2 fast satellite members` — `stat_arb_zscore`, `OPUSDT/SEIUSDT`, `MEXC 5m`.
3. `1 diversifier member` — лучший валидированный `DD_BattleToads` member из текущего production shortlist, не на `OPUSDT/SEIUSDT`.
4. `1 diversifier member` — лучший валидированный `zz_breakout` member из текущего production shortlist, не на `OPUSDT/SEIUSDT`.

### Почему Не Делать 6 Из 6 На Одной Паре

- Это даст псевдо-диверсификацию: визуально много участников, фактически один и тот же risk cluster.
- При live drift это приводит к синхронной просадке всех членов.
- Пользовательский запрос был на `диверсифицированную` cloud TS, а не на просто усиленный one-pair bundle.

### Почему Всё Равно Держим OP/SEI В Ядре

- Именно этот cluster повторился во всех трёх свежих sweep-срезах.
- Это сейчас единственный новый lower-TF signal, который выглядит достаточно устойчиво, чтобы стать core.

## Предлагаемые Веса

- Core 15m #1: `0.24`
- Core 15m #2: `0.24`
- Satellite 5m #1: `0.16`
- Satellite 5m #2: `0.16`
- DD_BattleToads diversifier: `0.10`
- zz_breakout diversifier: `0.10`

## OP / Risk Настройки

- `max_open_positions = 2`
- Не поднимать OP выше `2` на старте.
- Цель OP здесь: не душить trade count полностью, но и не пускать систему в uncontrolled multi-entry cascade.
- Важно: OP ограничивает **новые входы**, но не чинит уже открытый избыток позиций задним числом.

## Что Считать Main Card Прямо Сейчас

### Main Storefront Card

- Оставить `cloud-op2` как текущую main card до конца runtime validation окна.

Причина:

- Она уже интегрирована в live и по ней есть production context.
- После наших fixes сравнение runtime vs backtest стало корректнее, но это не равно автоматическому live profitability.
- Резко менять main storefront card до первой живой выборки по новой TS слишком рискованно.

### New Secondary Card

- Подготовить `cloud-op3-diversified` как `beta / new cloud` card.
- Не делать её main card до прохождения runtime gate.

## Что Публиковать, А Что Оставить В Research-Only

### Publish Candidate

- `Cloud OP3 Diversified` — после 12-24h runtime gate, если проходит пороги ниже.

### Research-Only

- `MEXC 5m` single-cluster bundle без диверсификаторов.
- `WEEX 5m` single-cluster bundle как standalone storefront card.
- Любая новая OP/SEI-only TS из 4-6 близких параметрических копий.

Причина:

- Эти варианты полезны для research и live shadowing, но пока недостаточно хороши как retail storefront product.

## Runtime Audit Plan На 12-24 Часа

### Цель

- Проверить, что после fixes runtime действительно приблизился к backtest/reconciliation-модели.
- Отдельно проверить, что `cloud-op2` не деградирует, пока мы вводим `cloud-op3`.

### Объекты Наблюдения

1. `cloud-op2` source + materialized runtime copies.
2. Новый `cloud-op3-diversified` source.
3. Materialized runtime copies для `MEXC` и при необходимости `WEEX`.

### Ключевые Метрики

1. `matched samples` по runtime copies, а не по source-layer.
2. `exchange_fill` vs `strategy_signal` coverage.
3. Реальное число fills на обеих synthetic ногах.
4. Hit-rate по `max_open_positions`.
5. Доля rejected / skipped entries из-за OP.
6. Средний fee и slippage на leg.
7. Per-market concentration: сколько PnL и сколько fills даёт один cluster.
8. Drift между expected and executed entry/exit.
9. Open position carry duration и overlap.

### Runtime Gate Для Перевода Из Beta В Published

Минимальный gate через `12-24h`:

1. Нет новых synthetic reconciliation holes.
2. Есть реальные fills по обеим ногам synthetic entries.
3. Нет uncontrolled OP overshoot.
4. Нет одного dominant loser, который съедает весь gross PnL.
5. Execution slippage и fees не ломают thesis полностью.

### Stop Conditions

1. Если почти весь flow идёт только из одного 5m satellite и он же делает основной negative drift, уменьшать его вес или выключать.
2. Если `DD_BattleToads` или `zz_breakout` diversifier только добавляет шум и не улучшает correlation profile, заменять его, а не держать “для красоты”.
3. Если `OPUSDT/SEIUSDT` cluster даёт профит в backtest, но на runtime consistently теряется на execution cost, storefront publication откладывать.

## Практический Rollout

### Stage 1

- Собрать `cloud-op3-diversified` source system.
- Поставить `max_open_positions = 2`.
- Материализовать на `MEXC`.
- Не делать main storefront switch.

### Stage 2

- Прогнать `12-24h` runtime audit.
- Отдельно сравнить `cloud-op2` vs `cloud-op3` по real fills и drift.

### Stage 3

Если gate пройден:

- Публиковать `cloud-op3-diversified` как новую secondary cloud card.
- Оставить `cloud-op2` как main ещё на один цикл наблюдения.

### Stage 4

Если `cloud-op3` устойчиво лучше по `execution-adjusted` live quality:

- Переводить `cloud-op3` в main card.
- `cloud-op2` либо оставлять как conservative legacy card, либо пересобирать.

## Честный Ожидаемый Результат

- После fixes runtime должен стать **значительно ближе** к backtest по структуре сравнения.
- Но это не означает автоматический профит.
- Правильная формулировка: теперь мы наконец-то будем видеть, где стратегия реально зарабатывает или теряет, а не теряться в артефактах reconciliation и stale sweep.

## Итоговое Решение

1. Не делать сейчас новый storefront main card из чистого `MEXC 5m` winner.
2. Собрать `cloud-op3-diversified` с ядром из `OPUSDT/SEIUSDT stat_arb_zscore`, но с обязательными диверсификаторами по типу стратегии и рынку.
3. Держать `OP=2`.
4. Использовать `cloud-op2` как текущий main, пока новый set не пройдёт 12-24h runtime gate.
5. `MEXC 5m` и `WEEX 5m` single-cluster варианты оставить в research-only до накопления live evidence.
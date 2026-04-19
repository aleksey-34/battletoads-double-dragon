# Landing And Docs Update Proposal — 2026-04-15

## Зачем Обновлять

За текущую серию работ появились новые сильные продуктовые тезисы, которых нет в лендинге и ряде документов:

1. Research и runtime реально изолированы и это подтверждено операционно.
2. Stale daily sweep больше не подсовывает старые артефакты.
3. Synthetic live-vs-backtest сравнение больше не ломается из-за одной ноги.
4. Появился новый lower-TF cloud candidate family на `MEXC` / `WEEX`.
5. Витрина и cloud cards теперь снова синхронизированы корректно.

## Что Стоит Обновить На Лендинге

## Файл

- [frontend/src/pages/Landing.tsx](frontend/src/pages/Landing.tsx)

## Что Там Сейчас Смотрится Устаревшим

1. Акцент только на `9,108 backtests` и старую Bybit-ориентированную proof framing.
2. Недостаточно подчёркнуто, что платформа уже реально работает с `MEXC` и `WEEX`, а не только поддерживает их формально.
3. Не вынесен сильный operational тезис: `runtime не зависит от research`.

## Предлагаемые Новые Тезисы Для Hero / Proof

### Hero RU

Вместо общей формулировки можно добавить более сильный operational copy:

`Алготрейдинг-платформа с изолированным runtime, живым research-контуром и cloud-портфелями для нескольких бирж. MEXC, WEEX, Bybit и другие биржи подключаются через единый TS-слой.`

### Proof Block RU

Добавить 3 новые proof cards:

1. `Runtime isolated from research`
   - текст: `Перезапуск API и research sweep не вмешиваются в live execution.`
2. `Synthetic reconciliation fixed`
   - текст: `Для synthetic TS live fills теперь сверяются по обеим ногам, а не только по base leg.`
3. `Cloud candidates on lower TF`
   - текст: `Новые MEXC/WEEX lower-TF sweep-кандидаты уже готовы к live validation.`

### FAQ RU

Добавить вопрос:

- `Чем вы отличаетесь от обычного “наборa бэктестов”?`

Ответ:

- `Мы разделяем research, runtime и client contour. Поэтому подбор кандидатов, публикация карточек и live execution не живут в одном хрупком процессе.`

## Что Стоит Обновить В Документах

## 1. Whitepaper / Pitch / Media

### Основные Новые Тезисы

1. `Multi-exchange cloud trading systems`:
   - одна source TS materialize’ится в разные execution venues.
2. `Research-safe architecture`:
   - stale sweep fixes,
   - отдельный research DB,
   - runtime unaffected by research refresh.
3. `Execution-aware analytics`:
   - `strategy_signal` отдельно от `exchange_fill`.
4. `Synthetic pair correctness`:
   - reconciliation по двум ногам.

### Где Это Особенно Полезно Обновить

1. [docs/WHITEPAPER_RU.md](docs/WHITEPAPER_RU.md)
2. [docs/WHITEPAPER_EN.md](docs/WHITEPAPER_EN.md)
3. [docs/PITCH_DECK_RU.md](docs/PITCH_DECK_RU.md)
4. [docs/PITCH_DECK_EN.md](docs/PITCH_DECK_EN.md)

## 2. Runtime / Architecture Docs

### Что Добавить

1. `event_origin` model:
   - `strategy_signal`
   - `exchange_fill`
   - `external`
2. Что synthetic reconciliation теперь тянет обе ноги.
3. Что storefront whitelist cloud cards теперь синхронизируется и с active cloud systems.

### Целевые Файлы

1. [docs/RUNTIME_ARCHITECTURE.md](docs/RUNTIME_ARCHITECTURE.md)
2. [docs/PROJECT_ARCHITECTURE.md](docs/PROJECT_ARCHITECTURE.md)
3. [docs/SAAS_ADMIN_OPERATIONS_RU.md](docs/SAAS_ADMIN_OPERATIONS_RU.md)

## 3. SaaS / Storefront Messaging

### Что Стоит Подсветить

1. Cloud TS теперь можно позиционировать не как статичную сборку, а как `curated + materialized multi-exchange cloud card`.
2. Есть режимы:
   - published storefront cards,
   - research-only candidates,
   - runtime validation candidates.

Это важно для handoff в media/info updates, потому что платформа уже выглядит зрелее, чем просто “marketplace офферов”.

## Готовые Формулировки Для Media / PR

### RU Short Version

`BTDD развивает multi-exchange cloud trading systems: одна торговая система собирается на source-слое, затем материализуется на нескольких биржах. Research, storefront и live runtime изолированы, а synthetic execution теперь сверяется по обеим ногам сделки.`

### EN Short Version

`BTDD now operates multi-exchange cloud trading systems: one source trading system can be materialized across multiple exchanges. Research, storefront, and live runtime are isolated, while synthetic execution is now reconciled on both legs rather than a single base leg.`

## Что Не Надо Пока Писать Слишком Смело

1. Не обещать, что новый lower-TF cloud family уже доказал live profitability.
2. Не писать, что backtest и runtime теперь совпадают `1:1`.
3. Не подавать `WEEX 5m` как fully validated production winner.

Корректная формулировка:

- lower-TF family identified,
- architecture fixes completed,
- live validation now technically meaningful.
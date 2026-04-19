# Cloud OP3 Shortlist + Publish Runbook — 2026-04-15

## Базовый Принцип

- `Cloud OP3` должен быть **source-level TS**, а не бирже-специфичной MEXC-копией.
- Source TS живёт в `BTDD_D1`, а затем материализуется на `MEXC`, `WEEX` и на другие поддержанные биржи, где доступны обе synthetic ноги и нормальная ликвидность.
- То есть логика `как обычно`: одна исходная TS, несколько runtime copies по биржам.

## Что Сейчас Подтверждено

### Cloud-OP2 Baseline

- Source system: `ALGOFUND_MASTER::BTDD_D1::cloud-op2`
- `trading_systems.id = 72`
- `max_open_positions = 2`
- `enabled_members = 8`

Текущий состав `cloud-op2` целиком synthetic Z-score 5m:

1. `80300` — `ONDOUSDT/TIAUSDT`, `ZScore_StatArb`, `5m`
2. `80301` — `FETUSDT/OPUSDT`, `ZScore_StatArb`, `5m`
3. `80302` — `UNIUSDT/LINKUSDT`, `ZScore_StatArb`, `5m`
4. `80303` — `GRTUSDT/INJUSDT`, `ZScore_StatArb`, `5m`
5. `80304` — `UNIUSDT/TIAUSDT`, `ZScore_StatArb`, `5m`
6. `80305` — `UNIUSDT/SOLUSDT`, `ZScore_StatArb`, `5m`
7. `80306` — `RENDERUSDT/TIAUSDT`, `ZScore_StatArb`, `5m`
8. `80307` — `OPUSDT/SEIUSDT`, `ZScore_StatArb`, `5m`

### Новый Lower-TF Winner Cluster

По свежим sweep-результатам strongest family сейчас:

- `OPUSDT/SEIUSDT`
- `stat_arb_zscore`
- strongest anchor: `15m`
- fast satellite path: `5m`

### Точные 15m Кандидаты, Уже Подтверждённые В Prod Research

Лучшие найденные параметры по `OPUSDT/SEIUSDT`:

1. `163724`
   - interval: `15m`
   - length: `24`
   - zscoreEntry: `2.25`
   - zscoreExit: `0.75`
   - zscoreStop: `3.5`
   - score: `25.763`
2. `163721`
   - interval: `15m`
   - length: `24`
   - zscoreEntry: `2.25`
   - zscoreExit: `0.5`
   - zscoreStop: `3.5`
   - score: `24.449`
3. `163727`
   - interval: `15m`
   - length: `24`
   - zscoreEntry: `2.25`
   - zscoreExit: `1.0`
   - zscoreStop: `3.5`
   - score: `23.604`

## Concrete Member Shortlist Для Cloud OP3

## Имя TS

- Source system name: `ALGOFUND_MASTER::BTDD_D1::cloud-op3-diversified`

## Целевой Размер И Риск

- `6 members`
- `max_open_positions = 2`

## Core Members

### Core-1

- market: `OPUSDT/SEIUSDT`
- strategyType: `stat_arb_zscore`
- interval: `15m`
- params:
  - `price_channel_length = 24`
  - `zscore_entry = 2.25`
  - `zscore_exit = 0.75`
  - `zscore_stop = 3.5`
- source template from validated research winner: runtime analogue `163724`
- target weight: `0.24`
- role: `core`

### Core-2

- market: `OPUSDT/SEIUSDT`
- strategyType: `stat_arb_zscore`
- interval: `15m`
- params:
  - `price_channel_length = 24`
  - `zscore_entry = 2.25`
  - `zscore_exit = 0.5`
  - `zscore_stop = 3.5`
- source template from validated research winner: runtime analogue `163721`
- target weight: `0.24`
- role: `core`

## Fast Satellites

### Satellite-1

- market: `OPUSDT/SEIUSDT`
- strategyType: `ZScore_StatArb`
- interval: `5m`
- source candidate: current live-tested `80307`
- target weight: `0.16`
- role: `satellite`

### Satellite-2

- market: `FETUSDT/OPUSDT`
- strategyType: `ZScore_StatArb`
- interval: `5m`
- source candidate: current live-tested `80301`
- target weight: `0.14`
- role: `satellite`

Причина выбора второго satellite:

- он сохраняет fast-turnover профиль,
- но не дублирует точь-в-точь тот же OP/SEI cluster,
- и всё ещё остаётся synthetic z-score member, пригодным для materialization на нескольких биржах.

## Diversifiers

### Diversifier-1

- market: `GRTUSDT/INJUSDT`
- strategyType: `ZScore_StatArb`
- interval: `5m`
- source candidate: `80303`
- target weight: `0.11`
- role: `diversifier`

### Diversifier-2

- market: `RENDERUSDT/TIAUSDT`
- strategyType: `ZScore_StatArb`
- interval: `5m`
- source candidate: `80306`
- target weight: `0.11`
- role: `diversifier`

## Почему Diversifier Не DD/ZZ Прямо Сейчас

- Свежий lower-TF shortlist в текущем production offer-store почти полностью состоит из нового `stat_arb_zscore` family.
- На live source-layer `cloud-op2` сейчас тоже целиком состоит из `ZScore_StatArb` members.
- При `OP = 2` более медленные `DD_BattleToads` / `zz_breakout` members могут дольше держать слоты и физически душить быстрый z-score flow.
- Поэтому на текущем шаге корректнее делать **market diversification внутри рабочей synthetic family**, а не вставлять слабый или неподтверждённый `DD_BattleToads` / `zz_breakout` только ради формальной галочки.

Практически:

- `Cloud OP3 v1` = diversified by market cluster and speed profile.
- `Cloud OP3 v2` = после следующего HF sweep добавить настоящий `DD` и `ZZ` member, если они пройдут live-quality gate.

## Что С DD / ZZ При OP = 2

- Да, проблема реальная: если добавить в одну TS более медленные `DD` / `ZZ`, они могут держать позицию дольше, чем быстрые synthetic z-score members.
- При `OP = 2` это создаёт starvation effect: slow members занимают слоты, а fast members не могут войти в рынок.
- Значит смешанный `DD + ZZ + ZScore` cloud-set имеет смысл только если:
   1. либо повышаем `OP`,
   2. либо вводим раздельные per-role caps,
   3. либо доказываем на runtime, что slow members не съедают execution bandwidth.

Вывод на сейчас:

- для `Cloud OP3 v1` не смешивать slow-style members с fast z-score family при `OP = 2`.
- сначала запускаем fast diversified synthetic set.

## Биржевой Принцип Развёртывания

- Source shortlist выше является **exchange-agnostic template**.
- Он должен материализоваться:
  1. в `MEXC` как primary execution venue,
  2. в `WEEX` как secondary execution venue,
  3. затем на другие поддержанные биржи только если обе ноги доступны и liquidity/fees приемлемы.

Не надо обещать идентичный performance на всех биржах.

Надо обещать следующее:

- одна и та же source TS может быть стандартно материализована на все поддержанные venue,
- а live quality для каждой биржи валидируется отдельно.

## Publish Checklist Для VPS

## Stage 0 — Preflight

1. Подтвердить, что `cloud-op2` остаётся active и `max_open_positions = 2`.
2. Подтвердить, что API и runtime сервисы `active`.
3. Подтвердить, что storefront cloud-card list не потерял текущие cards.
4. Подтвердить, что latest research artifacts свежие и не stale.

## Stage 1 — Source Strategy Creation

1. Проверить pair-conflict на source key `BTDD_D1`:
   - сейчас active strategy `80307` уже использует `OPUSDT/SEIUSDT`.
   - backend не позволит создать вторую active strategy на той же паре на одном `api_key`, даже на другом TF.
2. Поэтому перед созданием новых `15m` source members выбрать один из путей:
   - Path A: временно деактивировать `80307`, создать `15m` cores на `BTDD_D1`, затем пересобрать source set;
   - Path B: создать отдельный source API key alias для `Cloud OP3` family и держать там новые `OP/SEI 15m` members;
   - Path C: не создавать новые source members сразу, а сначала обкатать новую композицию на runtime/materialized alias key.
3. Только после выбора path создавать два `15m` core members по параметрам `163724` и `163721`.
4. Проверить, что они созданы как `synthetic`, `stat_arb_zscore`, `auto_update=1`, корректный `interval=15m`.
5. Не удалять текущий `80307`, если не выбран explicit Path A с controlled replacement.

## Stage 2 — Source System Assembly

1. Создать source TS `ALGOFUND_MASTER::BTDD_D1::cloud-op3-diversified` или equivalent alias-source TS, если выбран Path B.
2. Добавить 6 members:
   - two new 15m OP/SEI core members,
   - `80307`,
   - `80301`,
   - `80303`,
   - `80306`.
3. Проставить веса как в shortlist.
4. Проставить `max_open_positions = 2`.
5. Не архивировать и не трогать `cloud-op2` на этой стадии.

## Stage 3 — Materialization

1. Материализовать `cloud-op3-diversified` в `BTDD_MEX_1`.
2. Материализовать `cloud-op3-diversified` в `ivan_weex_1`.
3. Проверить, что все 6 members развернулись без missing-symbol / duplicate / inactive errors.

## Stage 4 — Activation

1. Сначала включить только `MEXC` runtime copy.
2. Проверить первые циклы runtime.
3. Затем включить `WEEX` runtime copy.
4. Не переключать storefront main card на этом шаге.

## Stage 5 — Storefront State

1. `cloud-op2` остаётся main card.
2. `cloud-op3-diversified` публикуется как secondary / beta card только после прохождения runtime gate.
3. `MEXC 5m only` и `WEEX 5m only` single-cluster variants не публиковать как отдельные retail cards.

## Runtime Audit Runbook

## Цель

- Сравнить `cloud-op2` и `cloud-op3` по живому исполнению в первые `12-24h`.
- Подтвердить, что fixes по reconciliation и event-origin действительно дают адекватную live картину.

## Наблюдаемые Объекты

1. Source system `cloud-op2`.
2. Source system `cloud-op3-diversified`.
3. Materialized `MEXC` copies.
4. Materialized `WEEX` copies.

## Что Снимать Каждые 4-6 Часов

1. `service state`:
   - `btdd-api`
   - `btdd-runtime`
2. `trading_systems`:
   - `is_active`
   - `max_open_positions`
   - enabled members count
3. `live_trade_events`:
   - split `strategy_signal` vs `exchange_fill`
   - coverage by strategy and by symbol
4. `open positions`:
   - count by system
   - count by symbol pair
5. `OP gate behavior`:
   - skipped entries due to open-position cap
6. `execution quality`:
   - fills on both synthetic legs
   - fees
   - slippage
7. `PnL concentration`:
   - what percent of total comes from one pair

## Success Gate Через 12-24h

1. Обе runtime copies `active` и stable.
2. Есть реальные `exchange_fill` events по обеим ногам для synthetic entries.
3. Нет нового evidence, что reconciliation again misses one leg.
4. `OP` не допускает runaway multi-entry.
5. `cloud-op3` даёт trade count выше или не хуже `cloud-op2`, но без явного blow-up по drawdown/fees.

## Failure Gate

1. Если `cloud-op3` почти весь turnover получает из одного fast satellite и он же делает основной negative drift, уменьшать satellite weight.
2. Если `WEEX` materially хуже по fill quality, оставлять `WEEX` как shadow venue, не как storefront evidence.
3. Если новые `15m` core members не materialize cleanly, откатываться на `cloud-op2`-style source family и не ломать main card.

## Recommended First Audit Questions

1. Дал ли `cloud-op3` больше real fills, чем `cloud-op2`?
2. Насколько `OP=2` ограничивает turnover в новой композиции?
3. Кто тащит live PnL: `15m core` или `5m satellites`?
4. Есть ли систематический MEXC-vs-WEEX drift по той же source TS?

## Решение На Сейчас

1. `cloud-op3-diversified` собирать как `6-member` source TS.
2. Делать её exchange-agnostic source set.
3. Материализовать минимум на `MEXC` и `WEEX`.
4. `cloud-op2` пока не выключать.
5. Только после runtime gate решать, переводить ли `cloud-op3` в storefront beta card.
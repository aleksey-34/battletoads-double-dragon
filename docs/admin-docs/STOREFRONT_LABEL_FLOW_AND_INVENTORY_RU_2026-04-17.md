# Storefront Label Flow And Inventory — 2026-04-17

## Цель

- Одна витрина `Клиент стратегий`.
- Одна витрина `Алгофонд`.
- Те же две витрины видны и в ЛК клиента, но с клиентским функционалом.
- Вместо текущей неявной смеси `curated/published/review snapshot/fallback` вводится одна явная продуктовая метка карточки.

## Простая Модель Меток

### Метки

1. `research_catalog`
   - карточка пришла из research/sweep/catalog;
   - видна только админу;
   - это очередь кандидатов после нового sweep.

2. `runtime_snapshot`
   - карточка одобрена админом для реальной витрины;
   - видна админу и клиенту;
   - к ней можно подключать клиентов;
   - при снятии метки нужно оценивать, есть ли подключенные клиенты, и предлагать controlled offboarding.

3. `fallback_preset`
   - архивная или запасная карточка;
   - по умолчанию не должна попадать в клиентскую витрину;
   - может храниться как бэкап/история;
   - может удаляться из базы после ручного решения.

## Продуктовая Логика

### Клиент стратегий

- Research после sweep создаёт новые candidate cards с меткой `research_catalog`.
- Админ на витрине видит фильтр: `research_catalog | runtime_snapshot | fallback_preset | all`.
- Чтобы карточка попала в клиентский storefront и в ЛК, админ меняет метку на `runtime_snapshot`.
- Если карточка перестаёт быть пригодной для live storefront, админ снимает `runtime_snapshot`.
- Если карточка нужна только как исторический/запасной артефакт, ей ставится `fallback_preset`.

### Алгофонд

- Для ТС логика та же, но объектом является не одиночный offer, а storefront TS card.
- `research_catalog` = кандидатная TS после research/assembly.
- `runtime_snapshot` = витринная TS, доступная клиентам Алгофонда.
- `fallback_preset` = старая или резервная TS-карточка.

## Что Это Заменяет

- Вкладка `offer-ts` перестаёт быть отдельным редуцентом с неочевидным state machine.
- Основной рабочий экран становится витриной админа с фильтром по метке.
- `curated/published` как вторичные внутренние флаги можно оставить только как техническое наследие миграционного этапа, но продуктово основная сущность должна быть одна: `label`.

## Реальный Начальный Inventory

Ниже не абстрактные идеи, а карточки, которые уже подтверждены локальными research-артефактами и текущими runtime-доками.

## 1. Клиент стратегий

### 1.1 Предлагаемый `runtime_snapshot`

Это сильные research-backed strategy cards, которыми можно заполнить админскую витрину стратегий сразу после перевода на label-модель.

1. `offer_synth_dd_battletoads_75093`
   - market: `IPUSDT/ZECUSDT`
   - type: `DD_BattleToads`
   - tf: `4h`
   - ret: `5.016`
   - dd: `0.778`
   - pf: `3.506`
   - trades: `67`
   - score: `53.644`

2. `offer_synth_zz_breakout_75435`
   - market: `IPUSDT/ZECUSDT`
   - type: `zz_breakout`
   - tf: `4h`
   - ret: `5.016`
   - dd: `0.778`
   - pf: `3.506`
   - trades: `67`
   - score: `53.644`

3. `offer_synth_dd_battletoads_76749`
   - market: `BERAUSDT/ZECUSDT`
   - type: `DD_BattleToads`
   - tf: `4h`
   - ret: `3.040`
   - dd: `0.508`
   - pf: `2.511`
   - trades: `73`
   - score: `42.286`

4. `offer_synth_zz_breakout_77091`
   - market: `BERAUSDT/ZECUSDT`
   - type: `zz_breakout`
   - tf: `4h`
   - ret: `3.040`
   - dd: `0.508`
   - pf: `2.511`
   - trades: `73`
   - score: `42.286`

5. `offer_mono_dd_battletoads_70541`
   - market: `IPUSDT`
   - type: `DD_BattleToads`
   - tf: `4h`
   - ret: `2.797`
   - dd: `0.611`
   - pf: `2.713`
   - trades: `50`
   - score: `42.972`

6. `offer_mono_zz_breakout_70883`
   - market: `IPUSDT`
   - type: `zz_breakout`
   - tf: `4h`
   - ret: `2.797`
   - dd: `0.611`
   - pf: `2.713`
   - trades: `50`
   - score: `42.972`

7. `offer_mono_dd_battletoads_70115`
   - market: `BERAUSDT`
   - type: `DD_BattleToads`
   - tf: `4h`
   - ret: `2.599`
   - dd: `0.944`
   - pf: `2.285`
   - trades: `67`
   - score: `38.106`

8. `offer_mono_zz_breakout_70457`
   - market: `BERAUSDT`
   - type: `zz_breakout`
   - tf: `4h`
   - ret: `2.599`
   - dd: `0.944`
   - pf: `2.285`
   - trades: `67`
   - score: `38.106`

9. `offer_mono_dd_battletoads_73433`
   - market: `AUCTIONUSDT`
   - type: `DD_BattleToads`
   - tf: `4h`
   - ret: `1.970`
   - dd: `0.537`
   - pf: `2.281`
   - trades: `74`
   - score: `38.183`

10. `offer_mono_zz_breakout_73775`
   - market: `AUCTIONUSDT`
   - type: `zz_breakout`
   - tf: `4h`
   - ret: `1.970`
   - dd: `0.537`
   - pf: `2.281`
   - trades: `74`
   - score: `38.183`

11. `offer_mono_stat_arb_zscore_70393`
   - market: `BERAUSDT`
   - type: `stat_arb_zscore`
   - tf: `4h`
   - ret: `1.531`
   - dd: `0.586`
   - pf: `2.223`
   - trades: `46`
   - score: `38.679`

12. `offer_synth_stat_arb_zscore_75968`
   - market: `MERLUSDT/SOMIUSDT`
   - type: `stat_arb_zscore`
   - tf: `4h`
   - ret: `1.472`
   - dd: `0.476`
   - pf: `2.309`
   - trades: `42`
   - score: `39.530`

13. `offer_synth_dd_battletoads_77145`
   - market: `IPUSDT/SOMIUSDT`
   - type: `DD_BattleToads`
   - tf: `4h`
   - ret: `1.357`
   - dd: `0.500`
   - pf: `2.635`
   - trades: `40`
   - score: `39.613`

14. `offer_synth_zz_breakout_77487`
   - market: `IPUSDT/SOMIUSDT`
   - type: `zz_breakout`
   - tf: `4h`
   - ret: `1.357`
   - dd: `0.500`
   - pf: `2.635`
   - trades: `40`
   - score: `39.613`

### 1.2 Предлагаемый `research_catalog`

Это кандидаты, которых логично показать только админу после sweep как очередь на перевод в storefront.

1. `stat_arb_zscore` `GRTUSDT/INJUSDT` `4h`
   - pf: `2.189`
   - dd: `0.285`
   - trades: `58`
   - score: `39.183`

2. `stat_arb_zscore` `MERLUSDT/SOMIUSDT` `4h`
   - pf: `2.281`
   - dd: `0.476`
   - trades: `40`
   - score: `39.193`

3. `stat_arb_zscore` `BERAUSDT` `4h`
   - pf: `2.223`
   - dd: `0.586`
   - trades: `46`
   - score: `38.679`

4. `stat_arb_zscore` `TRUUSDT/GRTUSDT` `4h`
   - pf: `1.723`
   - dd: `0.261`
   - trades: `159`
   - score: `37.740`

5. `DD_BattleToads` `ORDIUSDT/ZECUSDT` `4h`
   - pf: `2.083`
   - dd: `0.522`
   - trades: `238`
   - score: `41.843`

6. `zz_breakout` `ORDIUSDT/ZECUSDT` `4h`
   - pf: `2.083`
   - dd: `0.522`
   - trades: `238`
   - score: `41.843`

### 1.3 Предлагаемый `fallback_preset`

- На стартовом переходе лучше держать пустым.
- Если нужно сохранить текущие слабые live-карточки как исторический хвост, их можно временно массово перевести сюда, но в клиентской витрине их показывать не надо.
- Сюда же можно перевести старые офферы с микрорезультатом уровня `0.3%` за большой период, stale артефакты и карточки без живой research-поддержки.

## 2. Алгофонд

### 2.1 Предлагаемый `runtime_snapshot`

Это реальные storefront TS cards, которые имеют смысл на клиентской витрине Алгофонда.

1. `cloud-op2`
   - system id: `72`
   - family: `ZScore_StatArb`, `5m`
   - baseline members: `80300..80307`
   - max_open_positions: `2`
   - статус: текущая основная runtime storefront card

2. `cloud-op3-diversified`
   - статус: публиковать как secondary/beta only после runtime gate
   - core research winners:
     - `163724` `OPUSDT/SEIUSDT` `15m` `score 25.763`
     - `163721` `OPUSDT/SEIUSDT` `15m` `score 24.449`
   - fast satellites/runtime anchors:
     - `80307` `OPUSDT/SEIUSDT` `5m`
     - `80301` `FETUSDT/OPUSDT` `5m`
   - diversifiers:
     - `80303` `GRTUSDT/INJUSDT` `5m`
     - `80306` `RENDERUSDT/TIAUSDT` `5m`
   - max_open_positions: `2`

### 2.2 Предлагаемый `research_catalog`

Это TS или member-level кандидаты, которые админ должен видеть, но клиенту до одобрения не показывать.

1. `OPUSDT/SEIUSDT` `15m` core-1
   - strategy id: `163724`
   - z-entry `2.25`
   - z-exit `0.75`
   - z-stop `3.5`
   - score `25.763`

2. `OPUSDT/SEIUSDT` `15m` core-2
   - strategy id: `163721`
   - z-entry `2.25`
   - z-exit `0.5`
   - z-stop `3.5`
   - score `24.449`

3. `OPUSDT/SEIUSDT` `15m` core-3 reserve
   - strategy id: `163727`
   - z-entry `2.25`
   - z-exit `1.0`
   - z-stop `3.5`
   - score `23.604`

### 2.3 Предлагаемый `fallback_preset`

- Старые cloud cards, снятые с витрины, но оставленные как история.
- Любые TS-карточки, которые проиграли runtime gate, но нужны для аудита.

## Минимальный Quality Gate Для Strategy Storefront

Чтобы снова не тащить в storefront мусор уровня `5% за 450 дней`, нужно перевести витрину на понятный gate перед публикацией в `runtime_snapshot`.

### Базовый Gate

1. `ret >= 1.0`
2. `pf >= 1.5`
3. `trades >= 20`
4. research source не stale
5. карточка не теряет метрики из-за snapshot overwrite

### Более Жёсткий Gate Для Цели `>= 3% в месяц`

Нужна отдельная нормализация по месячной доходности, а не просто total return.

Формула:

- `monthly_return = total_return_percent / max(1, period_days / 30)`

Практический вывод:

- текущие сильные `4h` research cards уже вменяемы для storefront,
- но чтобы честно отбирать под цель `>= 3%/месяц`, в модели оффера надо хранить и показывать:
  - `periodDays`,
  - `returnPer30d`,
  - `tradesPer30d`.

Без этого админ по одной total return цифре не видит, где сильный compound-like кандидат, а где длинный слабый хвост.

## Что Делать Дальше

### Stage 1

- Добавить в offer/TS модель явное поле `label`.
- Значения: `research_catalog | runtime_snapshot | fallback_preset`.

### Stage 2

- На админской витрине сделать фильтр по `label`.
- Убрать product-смысл из пары `curated/published`.

### Stage 3

- Для `Клиент стратегий` перенести слабые текущие storefront cards из live в `fallback_preset`.
- Сильные research-backed cards перевести в `runtime_snapshot`.

### Stage 4

- Для `Алгофонда` оставить `cloud-op2` как текущий `runtime_snapshot`.
- `cloud-op3-diversified` держать в `research_catalog`, пока не пройдёт runtime gate.

### Stage 5

- Добавить в UI столбцы и теги:
  - `label`
  - `source`
  - `periodDays`
  - `retPer30d`
  - `updatedAt`

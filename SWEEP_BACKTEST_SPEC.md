# BTDD Sweep/Backtest Spec (RU)

> Дата фиксации: 2026-03-18
> Статус: draft для утверждения алгоритмов alpha

## Статус внедрения (обновлено 2026-03-18)

Уже внедрено в код:
- strict L/M/H валидация для `riskLevel` и `tradeFrequencyLevel` в client/admin API;
- scheduler таблица `research_scheduler_jobs` в `research.db`;
- scheduler API:
  - `GET /api/research/scheduler`
  - `PATCH /api/research/scheduler/daily_incremental_sweep`
  - `POST /api/research/scheduler/daily_incremental_sweep/run-now`
- DB observability endpoint:
  - `GET /api/research/observability/db`;
- background worker `researchSchedulerWorker` (периодический запуск due job);
- Research UI: карточка управления scheduler + базовая DB observability.
- manual bootstrap import endpoint:
  - `POST /api/research/sweeps/import-from-file`
  - импортирует существующие `client_catalog`/`historical_sweep` JSON в `research.db`.

---

## 1) Коротко: что уже реализовано

1. Research-контур уже создан:
- `research.db` со схемой (`strategy_profiles`, `sweep_runs`, `sweep_artifacts`, `preview_jobs`, `client_presets`, `publish_log`, `backtest_runs`).
- API `/api/research/*` для profiles/sweeps/preview/publish/presets.
- Preview worker (очередь + background обработка).

2. Publish Gate реализован:
- Профиль из research публикуется в runtime-стратегию через `publishProfileToRuntime`.
- Есть revoke, есть `publish_log`.

3. Client/Algofund materialization уже идет в runtime-контур:
- Для strategy-client и algofund создаются/обновляются реальные стратегии и/или trading system в runtime API key.
- То есть да, клиентские сеты и algofund в итоге работают через runtime.

---

## 2) Ответы на ключевые уточнения

### 2.1 «В runtime только явно опубликованные из Research?»

Целевая модель: да, только явно опубликованные.

Фактическая модель сейчас (alpha):
- Для research-профилей это уже так (publish gate обязателен).
- Для SaaS strategy-client/algofund также есть отдельная materialize-логика, которая пишет в runtime-стратегии по выбранным офферам и плану.
- Значит, runtime уже является единой точкой исполнения для live-торговли.

Решение на закрепление:
- Ввести policy: любая стратегия в runtime должна иметь один из проверяемых origin (`published`, `saas_materialize`, `manual_admin`).
- В админ-панели добавить фильтры и счетчики по `origin`.

### 2.2 «Клиенты могут сами запускать sweep/backtest других пар?»

Сейчас:
- Клиент не запускает произвольный sweep по новым парам напрямую.
- Клиент работает с каталогом офферов и пресетами.
- Клиент может инициировать preview/materialize в рамках своего плана и доступных офферов.

Правильный процесс запроса новой пары:
1. Клиент отправляет «запрос на расширение universe» (тикер/пара/рынок/ТФ/мотив).
2. Админ валидирует и запускает research-sweep/reopt.
3. Результаты sweep попадают в `sweep_runs/artifacts` + `strategy_profiles`.
4. После проверки новые офферы и пресеты включаются в каталог.

---

## 3) Что такое «multiplexer sweep» в текущем проекте

Рабочее определение:
- Multiplexer sweep — это пакетная проверка множества комбинаций (стратегия × рынок × параметры × ТФ) с единым scoring и последующей агрегацией в наборы для runtime и client catalog.

Фактически в коде сейчас:
- Backend SaaS берет latest historical sweep JSON и latest client catalog JSON из `results/`.
- Дальше использует эти данные для:
  - выбора пресетов,
  - preview,
  - materialize в runtime,
  - algofund системы.

Важно:
- В репозитории есть shell/HTTP скрипты-обертки, но часть `.mjs` сейчас пустые файлы.
- Поэтому алгоритм sweep как «одна официальная спецификация» до этого документа не был формализован.

---

## 4) Риск и «крутилка сделок»: что реально влияет

### 4.1 Risk

Реально влияет уже сейчас:
- В materialize стратегиям меняется lot sizing (например через `lot_long_percent/lot_short_percent` и связанный риск-профиль).
- В algofund risk multiplier влияет на масштаб equity/весов.

### 4.2 Trade Frequency

Сейчас частично:
- В SaaS выбирается пресет по рангу trades/DD среди доступных кандидатов.
- В `presetBuilder` частота в 3x3 матрице задается эвристически (например через `price_channel_length`).

Ограничение:
- Это не полный причинно-следственный «пересчет» всех KPI на лету при изменении частоты.
- Это выбор из заранее подготовленных точек/пресетов + часть приближений.

Решение (обязательное для alpha+):
1. Зафиксировать `tradeFrequency` как discrete-переменную пресета (L/M/H) и честно показывать это в UI.
2. Не обещать непрерывный live-recompute, пока не построена dense lookup-сетка.
3. Либо временно скрыть «тонкую крутилку», оставив только 3 фиксированные ступени.

---

## 5) 4D/ND-модель данных (ваша идея «Интерстеллар») — как сделать правильно

Цель: убрать тяжелые live-вычисления и работать по готовым связям.

Базовые измерения (`dims`) для precomputed базы:
- `asset_pair` (base/quote)
- `strategy_type`
- `timeframe`
- `param_bucket` (length/tp/zscore/...)
- `risk_level`
- `freq_level`
- `cost_model` (commission/slippage/funding regime)
- `market_regime_tag` (optional)

Факт-таблица (`facts`) на каждую точку:
- `ret`, `dd`, `pf`, `wr`, `trades`, `equity_curve_ref`, `stability_score`.

Индексный ключ:
- `(pair, strategy, tf, param_bucket, risk, freq, cost_model)`.

Идея:
- Клиентский запрос = lookup в многомерной сетке + очень легкий post-processing.
- Без тяжелого пересчета в runtime API.

---

## 6) Ежедневный фоновый sweep

Да, нужен. Это часть Research Circuit.

### 6.1 Минимальная схема планировщика

Новая таблица `research_scheduler_jobs`:
- `id`, `job_type`, `cron_expr`, `timezone`, `is_enabled`, `last_run_at`, `last_status`, `last_error`, `next_run_at`.

Режимы:
- `daily_incremental_sweep` (по умолчанию 1 раз в сутки ночью).
- `weekly_full_recompute` (1 раз в неделю).

### 6.2 Админ-управление

В Research UI:
- Вкл/выкл фонового sweep.
- Время и TZ.
- Кнопка `Run now`.
- Статус: `done/failed`, время, длительность, сколько комбинаций обновлено.

### 6.3 Ограничения безопасности

- Максимум 1 heavy sweep одновременно.
- Throttle по CPU/RAM.
- При активной торговой нагрузке — снижение приоритета или перенос окна.

---

## 7) Сложность и размер БД: текущий факт и прогноз

### 7.1 Что подтверждено локально (workspace на 2026-03-18)

- Файл: `backend/database.db`
- Размер: `57,344 bytes`
- LastWriteTimeUtc: `2026-03-16 19:49:06`

Локальная dev-база не содержит полный production-объем SaaS/strategy данных.

### 7.2 Почему «апокалипсиса» не должно быть (при правильной схеме)

Рост управляется:
1. Архивацией старых sweep-артефактов (cold storage).
2. TTL для preview cache.
3. Партиционированием по `sweep_run_id`/дате (логически, через индексы и retention).
4. Хранением `equity_curve` отдельно (gzip/jsonl/blob) с ссылкой, а не дублированием в каждой таблице.

### 7.3 Практическая оценка

Если хранить только агрегаты + ссылки на артефакты:
- десятки тысяч комбинаций = обычно сотни МБ, не десятки ГБ.

Если хранить полные кривые в каждой записи без дедупа:
- рост может стать нелинейным и уйти в ГБ довольно быстро.

Решение:
- one-source хранение кривой + reference id в `facts`.

---

## 8) План реализации (добавка к INFRASTRUCTURE_PLAN)

1. Зафиксировать клиентскую частоту как L/M/H и убрать неоднозначный «continuous» режим до dense sweep-grid.
2. Создать scheduler для daily incremental sweep + weekly full sweep.
3. Перевести клиентский каталог на чтение только из `client_presets` (без fallback heavy compute для стандартного UX).
4. Добавить DB observability:
- размер файлов БД,
- row counts по ключевым таблицам,
- retention stats,
- lag от последнего sweep.

---

## 9) Решение по ветке Git

На момент фиксации:
- Активная ветка: `main`.
- Доп. ветка `feature/virtual-strategy-list` существует, но под этот апдейт отдельная ветка не использовалась.

Рекомендация:
- Для следующих крупных шагов сделать отдельную ветку, например:
  - `feature/research-sweep-spec-and-scheduler`
  - `feature/client-presets-runtime-hardening`

---

## 10) Truth Snapshot 2026-03-25 (обновленная «истина» по Sweep)

Этот блок фиксирует текущее фактическое поведение системы по коду и проверкам живого VPS.

### 10.1 Что действительно прогоняется в Full Historical Sweep

1. Типы стратегий:
- `DD_BattleToads`
- `zz_breakout` (в названиях стратегий токен `ZZ`)
- `stat_arb_zscore` (в названиях токен `SZ`)

2. Режимы рынков:
- `mono` (один рынок, например `BERAUSDT`)
- `synth` (синтетическая пара, например `BERAUSDT/ZECUSDT`)

3. Сетки параметров:
- Для DD/ZZ:
  - `length`: `[5, 8, 12, 16, 24, 36]`
  - `takeProfitPercent`: `[2, 3, 4, 5, 7.5, 10]`
  - `detectionSource`: `['close', 'wick']`
- Для StatArb:
  - `length`: `[24, 36, 48, 72, 96, 120]`
  - `zscoreEntry`: `[1.25, 1.5, 1.75, 2, 2.25]`
  - `zscoreExit`: `[0.5, 0.75, 1]`
  - `zscoreStop`: `[2.5, 3, 3.5]`

4. Таймфреймы:
- Поддерживаются массивом `intervals` (например `4h`, `1h`, `15m` и т.д. при валидном формате).

### 10.2 Как стратегии сопоставляются и комбинируются

1. Этап Sweep:
- Каждая комбинация (тип × рынок × mode × TF × параметры) считается как отдельный run.
- На выходе формируется `evaluated[]` с KPI каждой стратегии.

2. Этап ранжирования:
- Score считается формулой:

$$
score = ret + 10 \cdot pf + 0.12 \cdot wr - 1.2 \cdot dd + tradeBonus
$$

где:

$$
tradeBonus = \min(12, 5 \cdot \log_{10}(\max(1, trades)))
$$

3. Этап robust-фильтра:
- По умолчанию: `PF >= 1.15`, `DD <= 22`, `trades >= 40`.

4. Этап TS-кандидатов:
- Берутся top robust записи, затем выбираются `selectedMembers` (до `maxMembers`, обычно 6).
- Для них запускается портфельный backtest (`mode='portfolio'`) и пишется `portfolioResults[0].summary`.

### 10.3 Ответы на ключевые вопросы «верно ли?»

1. «Прогонялись ZigZag, HiDeep, DoubleDragon, mono/synth, разные TF и настройки?»
- Да по сути, но с уточнением имен:
  - ZigZag: да, это `zz_breakout`.
  - DoubleDragon: да, это `DD_BattleToads`.
  - Третья ветка сейчас в коде называется `stat_arb_zscore` (если ранее называлась иначе, это rename/эволюция).
- Да, прогоняются `mono` и `synth`.
- Да, прогоняются разные TF (через `intervals`) и разные параметры по сетке.

2. «Использовались ли ТП/СЛ в комплексном портфельном анализе?»
- Да, но поэтапно:
  - На уровне стратегии в sweep:
    - DD/ZZ: используется `take_profit_percent` + stop-выходы по donchian center (логика в движке).
    - StatArb: используется `zscore_exit` и `zscore_stop`.
  - На уровне портфеля:
    - Портфельный прогон использует уже зафиксированные параметры каждой выбранной стратегии.
    - Дополнительной «портфельной оптимизации TP/SL поверх стратегий» сейчас нет.

3. «Есть ли общий маржинальный/капитальный эффект по ТС?»
- Да, в backtest engine есть общая `cashEquity` + суммарный `unrealizedPnL` по всем открытым позициям.
- Это уже не сумма независимых одиночных backtest, а единая портфельная динамика.

### 10.4 Нелинейность, реинвест и текущий статус presetBuilder

1. В честном portfolio backtest нелинейность есть:
- При открытии позиции notional зависит от текущего капитала и настроек стратегии (`lot%`, `fixed_lot`, `reinvest_percent`, `max_deposit`).
- Поэтому динамика по доходности/просадке нелинейная, с эффектом реинвеста.

2. В `presetBuilder` сейчас:
- Это cache-слой для карточек/быстрого UI.
- После фикса 2026-03-25 scaling equity curve выполняется через относительную доходность от стартовой equity, а не прямым умножением абсолютов.
- Но это все равно approximation, а не полноценный повторный портфельный backtest.

3. Вывод:
- Для «истинных» цифр при изменении `risk × freq` нужен rerun portfolio backtest по кнопке.
- Preset cache оставляем как быстрый preview/lookup.

### 10.5 Что такое client_presets (и почему это не «клиентская привязка»)

`client_presets` в `research.db` это cache-таблица предвычисленных пресетов для витрины офферов:
- ключ: `(offer_id, risk_level, freq_level)`
- payload: `config_json`, `metrics_json`, `equity_curve_json`, `sweep_run_id`

Важно:
- Таблица не содержит `user_id`, `tenant_id`, `api_key`.
- Название историческое: «client» = «для клиентского UI», а не «пресеты конкретного клиента».

### 10.6 Что за «12 витринных офферов»

Это текущий стандартный build каталога из sweep:
- `monoCatalog = 6`
- `synthCatalog = 6`
- итого 12 офферов

Откуда берутся:
- Из `evaluated[]` latest sweep, с robust-приоритетом и дедупликацией по market при первичном выборе.
- Затем формируется витрина (офферы) + draft TS members.

### 10.7 Найденный важный инсайт (почему это действительно «открытие»)

На практике подтверждено:
- Одиночные офферы в последнем sweep в основном дают невысокий ret.
- Портфельный TS из `selectedMembers` дает существенно иной профиль (лучше по ret/pf при контролируемом dd).

Это важный исследовательский вывод:
- Носитель edge находится не только в «лучшей одной стратегии», а в структуре диверсифицированного портфеля и взаимодействии стратегий.
- С инженерной точки зрения это тянет на сильный продуктовый инсайт для следующего поколения sweep.

### 10.8 Что можно выцепить уже из проведенного sweep (без нового прогона)

1. Корреляционная карта кандидатов:
- pairwise корреляции PnL/equity между robust-кандидатами.

2. Кластеры «взаимозаменяемых» офферов:
- внутри каждого market/mode/type для уменьшения дублирования в TS.

3. Pareto-фронты:
- `ret vs dd`, `pf vs trades/day`, `score vs stability`.

4. Regime-устойчивость:
- разбиение периода на окна и проверка дрейфа KPI (rolling diagnostics).

5. Библиотека TS-шаблонов:
- conservative / balanced / aggressive наборы с зафиксированными constraints.

### 10.9 Следующая итерация sweep (более грандиозная)

1. Portfolio rerun on demand (кнопка в админке):
- Выбор `risk × freq` -> запуск честного портфельного backtest.
- Результат записывать в отдельный журнал run-ов и в snapshots витрины.

2. Двухконтурная модель UI:
- Fast path: cache (`client_presets`) для мгновенной карточки.
- Truth path: on-demand rerun для финального подтверждения и публикации.

3. Расширенный sweep-профиль:
- Добавить быстрые TF (например `15m`, `30m`) отдельным профилем.
- Разделить базовый long-horizon sweep и HF-sweep как разные продуктовые режимы.

4. Portfolio-aware scoring:
- Добавить штраф за корреляцию в score на этапе подбора TS,
- чтобы ранжировать не только «сильные одиночки», но и «сильные связки».

5. Материализация витрины без подмены:
- Писать в `client_presets` только честные значения из sweep/rerun.
- Approximation маркировать явно (`approx=true`) и не публиковать как final KPI.

6. Семантика контролов TS (добавить в grand sweep как обязательное правило):
- `risk` меняет размер позиции / вес / capital allocation (не состав TS).
- `freq` меняет variant внутри семейства стратегии (`low/medium/high`),
  но не уменьшает число стратегий в TS.
- Состав TS меняется отдельной сущностью (ребаланс/редактор состава),
  а не ползунком `freq`.

### 10.10 Операционный вывод

Текущая целевая схема:
1. Sweep собирает большой исследовательский массив.
2. Из массива строятся офферы и draft TS.
3. Быстрые карточки работают через presets/cache.
4. Финальная проверка и публикация в витрину делаются через честный portfolio rerun по кнопке.

Это дает баланс между скоростью UX и математической честностью результата.

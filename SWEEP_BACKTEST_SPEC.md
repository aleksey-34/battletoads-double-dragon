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

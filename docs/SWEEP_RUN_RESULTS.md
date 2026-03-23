# Лог Результатов Sweep-Прогонов

## Цель
Фиксировать каждый крупный sweep/backfill-прогон в воспроизводимом виде, чтобы потом было на что опираться при:
- ранжировании стратегий;
- генерации офферов;
- продуктовых и runtime-решениях.

## Шаблон Прогона
- Run ID:
- Время старта (UTC):
- Время завершения (UTC):
- Режим: light | heavy
- Объём: missing days / full recompute / manual pair batch
- Запрошено дней:
- Проанализировано дней:
- Пропущенных дней до старта:
- Обработано дней:
- Создано run:
- Пропущено дней:
- Кол-во сбоев:
- Поведение ETA: стабильное / нестабильное

### Проверки Качества Данных
- Артефакты sweep сохранены: да/нет
- Чекпоинты прогресса сохранены: да/нет
- Последний обработанный day key:
- Остались ли пробелы:

### Результаты Ранжирования
- Топ по PF:
- Топ по proxy Sharpe / стабильности:
- Топ по контролю DD:
- Топ по ритму trades/day:
- Топ сбалансированный (PF + DD + WR + trades):

### Кандидаты В Офферы
- Шортлист mono-офферов:
- Шортлист synth-офферов:
- Рекомендуемое продуктовое сопоставление:
- Strategy Client:
- Algofund:

### Кандидаты В Торговые Системы
- TS-1 (balanced):
- TS-2 (high-frequency):
- TS-3 (conservative):

### Решение Админа
- Продвигаем в runtime: да/нет
- Причина:
- Follow-up задачи:

---

## Run ID: full_historical_sweep_2026-03-20_btdd_d1

- Время старта (UTC): 2026-03-20 19:16:55
- Время завершения (UTC): 2026-03-20 22:06:14
- Режим: heavy (full historical sweep)
- Объём: full recompute (grid) + import в Research
- Запрошено дней (backfill-job fields): 9108 runs
- Проанализировано: 9108/9108 runs
- Кол-во сбоев: 0
- Статус: done, progress 100%

### Расшифровка Полей (как читать этот блок)

- Run ID:
	- Уникальный идентификатор конкретного запуска.
	- Нужен для однозначной привязки к логу, артефактам и записи в БД.

- Время старта / завершения (UTC):
	- Фиксирует реальную длительность прогона и окно выполнения.
	- Всегда хранится в UTC, чтобы не путаться с локальными часовыми поясами.

- Режим: heavy (full historical sweep):
	- Heavy = полный пересчет большой сетки параметров/пар/интервалов.
	- В отличие от daily incremental, здесь цель не "досчитать хвост", а пересобрать полный baseline.

- Объем: full recompute (grid) + import в Research:
	- Full recompute (grid) означает, что пересчитывается вся заданная сетка сценариев, а не выборочные точки.
	- Import в Research означает, что после расчета кандидаты загружаются в исследовательский слой для ранжирования/отбора.

- Запрошено дней (backfill-job fields): 9108 runs:
	- Технически это счетчик единиц работы (runs), а не буквальные календарные дни.
	- Исторически поле называется через "days", но фактически хранит размер очереди прогонов.

- Проанализировано: 9108/9108 runs:
	- Числитель = сколько runs реально обработано.
	- Знаменатель = сколько runs было запланировано в этом job.
	- 9108/9108 означает, что очередь отработана полностью.

- Кол-во сбоев: 0:
	- Количество runs, завершившихся ошибкой выполнения или валидации.
	- 0 означает отсутствие зафиксированных ошибок на уровне прогонов.

- Статус: done, progress 100%:
	- done = job завершен корректно.
	- progress 100% = обработанный объем равен запланированному.
	- Для принятия продуктовых решений это базовый признак валидного завершенного источника.

### Быстрый Чек-Лист Валидности Результата

- Статус должен быть done.
- Progress должен быть 100%.
- Проанализировано должно совпадать с запрошенным объемом.
- Кол-во сбоев должно быть 0 или заранее приемлемым по регламенту.
- Должны существовать финальные артефакты sweep/catalog и лог запуска.

### Важно Про Термин "дней"

- В некоторых полях backfill-job слово "days" используется исторически.
- Для full historical sweep корректнее читать это как "единицы работ (runs)".
- Поэтому строка "Запрошено дней: 9108 runs" интерпретируется как "в очередь поставлено 9108 прогонов".

### Проверки Качества Данных
- Артефакты sweep сохранены: да
- Чекпоинты прогресса сохранены: да
- Последний обработанный key: сохранялся в job details, финальный прогон завершён
- Остались ли пробелы: нет

### Артефакты
- Sweep JSON: /opt/battletoads-double-dragon/results/btdd_d1_historical_sweep_2026-03-20T22-06-14-758Z.json
- Catalog JSON: /opt/battletoads-double-dragon/results/btdd_d1_client_catalog_2026-03-20T22-06-14-758Z.json
- Лог: /opt/battletoads-double-dragon/logs/historical_2026-03-20T19-16-55-323Z.log
- Import в Research: sweepRunId=366, imported=12, skipped=0, candidates=12

### Сводные Метрики (из sweep)
- potentialRuns: 9108
- scheduledRuns: 9108
- evaluated: 9108
- failures: 0
- robust: 3099
- durationSec: 10159
- period: 2025-01-01T00:00:00Z -> latest (dateTo=null)
- interval: 4h
- strategyTypes: DD_BattleToads, stat_arb_zscore, zz_breakout

### Сводные Метрики (из catalog)
- monoCatalog: 6
- synthCatalog: 6
- adminTsMembers: 6
- evaluated/robust в каталоге: 9108 / 3099

### Пояснение По "365 Дней" В UI
- Блок "Планировщик Research (ежедневный incremental sweep)" показывает daily backfill-job, не full historical grid.
- Для daily backfill в коде включён лимит окна до 365 дней (schedulerService), поэтому там можно увидеть 365/365.
- Полный historical sweep с dateFrom=2025-01-01 выполнен отдельно и завершён (9108/9108), это и есть требуемый полный прогон.

### Решение Админа
- Продвигаем в runtime: частично (через каталог/офферы и admin TS draft после ручной валидации)
- Причина: sweep завершён без ошибок, robust-пул достаточный (3099), импорт в Research выполнен
- Follow-up задачи:
	- Собрать slow/medium/fast офферы и TS из нового run
	- Вынести global request queue в SaaS Admin (выполнено)
	- Запустить следующий продуктовый блок: Algofund multi-TS, Strategy Client TS builder, Offer UX v2

---

## Run ID: full_historical_sweep_hf_2026-03-21_btdd_d1

- Время старта (UTC): 2026-03-21 05:35:11
- Режим: heavy (expanded, hi-frequency aware)
- Статус: running
- totalRuns: 18216 (больше прежних 9108)
- processed на момент фиксации: 32
- failures: 0
- Конфиг: intervals=[4h,1h], period=2025-01-01 -> latest

### Причина расширения относительно 9108
- Ранее full historical runner имел жёсткий ceiling `maxRuns=9108` и один интервал `4h`.
- После правки runner теперь поддерживает multi-interval grid и динамический run-cap.
- Запуск с `4h,1h` удвоил размер сетки: 18216.

### Про связь с ползунком ожидаемых сделок в TS
- Ползунок `targetTrades` в меню Trading Systems влияет на frequency diagnostics/рекомендации и подбор состава TS.
- Этот ползунок не управляет автоматически full historical sweep grid.
- Для sweep-уровня частотность теперь задаётся явно через интервалы (например `4h,1h`).

---

## Update: HF Диагностика И Продуктовый План (2026-03-21)

### Факт По Текущему Бегущему Full Sweep
- Источник: VPS `research.db`, таблица `research_backfill_jobs`.
- Последняя строка на момент проверки: `id=6`, `status=running`, `processed_days=22567`, `requested_max_days=18216`, `progress_percent=123.89`.
- Это некорректная пропорция (`processed > total`) и именно она визуально даёт в UI «невозможный прогресс».
- Последний завершённый валидный артефакт sweep/catalog остаётся от `2026-03-20T22:06:14Z`.

### Срез Артефактов (VPS)
- Checkpoint (`btdd_d1_historical_sweep_checkpoint.json`):
	- total evaluated: `22612`
	- robust: `6104`
	- by interval: `4h=15988`, `1h=6624`
	- by mode: `mono=14904`, `synth=7708`
	- PF/DD фильтр (`PF>=1.15`, `DD<=22`): `6808`
- Последний completed sweep (`btdd_d1_historical_sweep_2026-03-20T22-06-14-758Z.json`):
	- evaluated: `9108`, robust: `3099`, failures: `0`
	- interval: `4h` (single-interval run)
- Последний completed catalog (`btdd_d1_client_catalog_2026-03-20T22-06-14-758Z.json`):
	- mono offers: `6`
	- synth offers: `6`
	- admin TS members: `6`

### Почему «No candidates» Даже При Цели 10/day И 1/day
- В HF генераторе частота считается как `tradesPerDay = tradesCount / inferredDays`.
- Для текущего sweep `inferredDays` получается `365` (dateTo не задан), поэтому даже хорошие стратегии с десятками/сотнями сделок дают низкий `trades/day`.
- Диагностический срез по checkpoint при фильтре `PF>=1.05`, `DD<=28` (`9258` кандидатов):
	- `<0.25/day`: `3115`
	- `0.25-0.5/day`: `3349`
	- `0.5-1/day`: `1925`
	- `1-2/day`: `711`
	- `2-4/day`: `148`
	- `4-8/day`: `10`
	- `8-12/day`: `0`
- Вывод: для текущего горизонта/набора интервалов target `10/day` почти недостижим, поэтому система закономерно возвращает «No candidates».

### Что Делать Для Прибыльных Offer/TS (Обычных)
- Рабочая базовая воронка:
	- Шаг 1: `PF>=1.15`, `DD<=22`, `trades>=40` (robust baseline).
	- Шаг 2: Отдельные shortlist по `mono` и `synth`, не смешивать до этапа TS-композиции.
	- Шаг 3: Внутри shortlist ограничивать кластеризацию по одному маркету (не брать много вариантов одной и той же пары).
	- Шаг 4: В TS держать минимум 1 стратегию из каждого типа (`DD_BattleToads`, `stat_arb_zscore`, `zz_breakout`) для диверсификации.
- Практически: текущий completed catalog (6 mono + 6 synth) уже пригоден как стартовый production shortlist после ручной проверки корреляций/дублирования.

### Что Делать Для HF Цели Около 10/day
- Для реального достижения `~10/day` нужен отдельный HF sweep-профиль:
	- Сократить горизонт оценки (например, 60-120 дней вместо полного исторического окна).
	- Добавить более быстрые интервалы (`15m`, `30m`), а не только `1h/4h`.
	- Ослабить пороги на первом проходе (`PF>=1.0..1.05`, `DD<=30..35`), затем ужесточать после отбора по стабильности.
- Рекомендуемая лестница fallback при генерации HF TS:
	- A: target `10/day`, `PF>=1.05`, `DD<=28`, maxMembers `6`.
	- B: если пусто -> target `6/day`, `PF>=1.02`, `DD<=30`.
	- C: если пусто -> target `4/day`, `PF>=1.0`, `DD<=35`.
	- D: если пусто -> разрешить гибридный TS из fast+medium (часть 1-2/day, часть 2-4/day).

### Операционное Решение На Сейчас
- Для Strategy Client/Algofund прямо сейчас использовать validated completed catalog от `2026-03-20` как основной источник офферов и TS-кандидатов.
- Текущий running full sweep (#6) не использовать как финальный источник, пока не завершится корректно и не сформирует финальный артефакт без рассинхрона progress.

---

## Update: Статус И Контуры Управления (2026-03-21, позже)

### Актуальная Проверка VPS (повторная)
- Проверка SQL по `research_backfill_jobs`:
	- `id=6`, `status=running`, `processed_days=23252`, `requested_max_days=18216`, `progress_percent=127.65`.
- Вывод:
	- running job #6 всё ещё невалиден по прогрессу (`processed > total`),
	- финальным источником для витрины остаётся completed catalog/sweep от `2026-03-20T22:06:14Z`.

### Что Изменено В Коде По Запросу
- HF генерация:
	- добавлена fallback-лестница профилей `A/B/C`:
		- A: target как запрошен (`10/day`), базовые PF/DD,
		- B: target `6/day`, слегка мягче PF/DD,
		- C: target `4/day`, ещё мягче PF/DD;
	- добавлено окно пересчёта частоты `windowDays` (вместо жёсткой логики по inferredDays=365);
	- в ошибке теперь даётся конкретная подсказка запускать отдельный HF sweep-профиль `60-120d` + `15m/30m`.
- Витрина офферов (Admin):
	- добавлены `approve/unpublish` для каждого offer,
	- добавлены admin-defaults витрины (periodDays, targetTradesPerDay, riskLevel),
	- Strategy Client/Algofund получают только опубликованные офферы.
- Отчёты Admin:
	- добавлены переключатели daily/weekly/monthly по TS и offers,
	- добавлен API performance report со сравнением expected(backtest/sweep) vs live (по доступным reconciliation данным).

### Пояснение По Периоду И Малому Trades/Day
- Если в карточке видно `trades=11` и низкий `trades/day`, это не «за день», а за весь период backtest/sweep.
- Для витрины и HF-диагностики теперь учитывается настраиваемое окно `windowDays/periodDays`, чтобы сравнение по частоте было практически осмысленным.

---

## Update: VPS Verification Snapshot (2026-03-21 16:08 UTC)

### DB Статус Full Sweep
- Проверка через `research.db` (`research_backfill_jobs`):
	- `id=6`, `status=running`, `processed_days=23521`, `requested_max_days=18216`, `progress_percent=129.12`.
	- `details_json`: `processedRuns=23521`, `totalRuns=18216`, `resumedFromCheckpoint=true`, `skippedFromCheckpoint=9108`.
- Вывод:
	- рассинхрон `processed > total` сохраняется,
	- текущий job #6 не подходит как финальный источник продуктового каталога.

### Состояние Сервисов
- `btdd-api`: `active (running)`.
- `btdd-research`: `active (running)`.
- `btdd-runtime`: `active (running)`.
- Последний рестарт сервисов: около `15:13 UTC`.

### Проверка Лога Бегущего Job
- Файл: `/opt/battletoads-double-dragon/logs/historical_2026-03-21T07-14-07-332Z.log`.
- Последняя активность на момент проверки: `2026-03-21 16:08:36 UTC`.
- В хвосте лога видны актуальные записи `RUN 14418/18216`, что подтверждает активный пересчёт.

### Операционное Решение
- Продолжаем использовать completed артефакты `2026-03-20T22:06:14Z` для Strategy Client/Algofund offer-store.
- Job #6 считаем рабочим только как промежуточный фон до чистого финала (без некорректного прогресса и с корректными итоговыми артефактами).

---

## Update: Dedicated HF10DAY Profile Launch (2026-03-21 17:31 UTC)

### Что Сделано
- Запущен отдельный full historical HF-профиль с отдельным `strategyPrefix=HF10DAY`.
- Конфиг запуска:
	- `dateFrom=2025-11-21` (примерно 120 дней окна),
	- `intervals=15m,30m,1h`,
	- `checkpointEvery=40`,
	- `systemName=HF10DAY BTDD_D1 Candidate`.

### Подтверждение По БД
- `research_backfill_jobs`:
	- `id=7`, `status=running`, `processed_days=16`, `progress_percent=0.06`,
	- `details_json.totalRuns=27324`, `config.intervals=[15m,30m,1h]`, `config.dateFrom=2025-11-21`.

### Подтверждение По Логу
- Лог запуска: `/opt/battletoads-double-dragon/logs/hf10day_launch_20260321T173050Z.log`.
- В логе есть явный `started=true, jobId=7`, а также первые backtest-шаги по `BERAUSDT` на `15m`.

### Важный Риск (остался)
- Исторический job `id=6` продолжает обновляться параллельно и остается невалидным по прогрессу (`processed > total`).
- Следствие:
	- HF профиль `id=7` запущен и подтвержден,
	- но при принятии продуктовых решений по-прежнему использовать только completed артефакты и новый HF-профиль после его корректного финала.

---

## Update: HF10DAY Full Sweep Completion (2026-03-23)

### Финальный Статус
- Полный Historical Sweep (heavy pipeline): `done`.
- Режим: `heavy`.
- Конфиг: `BTDD_D1; 2025-11-21 -> latest; 15m,30m,1h`.
- Job `#7`: `processed 27324/27324`, `success 27324`, `failed 0`.
- Resume from checkpoint: `да`, пропущено готовых runs: `0`.

### Артефакты Финального Прогона
- Лог: `/opt/battletoads-double-dragon/logs/historical_2026-03-21T17-30-51-633Z.log`.
- Sweep JSON: `/opt/battletoads-double-dragon/results/btdd_d1_historical_sweep_2026-03-23T04-21-59-187Z.json`.
- Catalog JSON: `/opt/battletoads-double-dragon/results/btdd_d1_client_catalog_2026-03-23T04-21-59-187Z.json`.
- Import в Research: `sweepRunId=370`, `imported=12`, `skipped=0`.

### Что Это Означает Для Продуктового Потока
- Источник для витрины и admin-review теперь валидный и завершенный (100%).
- Можно проводить shortlist и approve/unpublish офферов в SaaS Admin на базе нового каталога.
- Следующий шаг: вручную проверить TS/офферы (PF/DD/ret/trades/day + live drift), после чего публиковать selected offers в витрину.

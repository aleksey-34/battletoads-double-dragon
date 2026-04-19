# Anchor discovery results 2026-04-17

## Что уже произошло

Запущена новая ветка `anchor discovery`:

- `job 42`: `ANCHOR_MEXC`
- `job 43`: `ANCHOR_BITGET`

Оба прогона стартовали честно:

- `resumeEnabled = false`
- отдельные `anchor_*_checkpoint.json`
- `1h/4h`
- families: `DD_BattleToads`, `zz_breakout`

## Первый реальный сигнал

В отличие от закрытой low-TF stat-arb ветки, anchor branch уже на первом проходе показывает положительные candidates.

Наблюдения по первым локально снятым catalog-файлам:

- `MEXC`:
  - top `DD_BattleToads` / `zz_breakout` rows по `OPUSDT`
  - `ret` около `0.42 - 0.50`
  - `pf` около `2.37 - 2.62`
  - `dd` около `0.19 - 0.29`
- `Bitget`:
  - top `DD_BattleToads` / `zz_breakout` rows по `OPUSDT`
  - `ret` около `0.45 - 0.46`
  - `pf` около `2.41 - 2.51`
  - `dd` около `0.28`

Это уже намного ближе к нормальной базе, чем low-TF `5m mono stat-arb`, где honest promotion дал устойчиво отрицательную математику.

## Metadata blocker устранен

Проблема была не в самих данных, а в extraction logic:

- `tf` лежал в `strategy.params.interval`
- после восстановления этого поля anchor rows начали классифицироваться корректно

Промежуточный пересчет по локально снятым `MEXC` и `Bitget` catalog-файлам дал:

- `anchor_core`: 11
- `anchor_candidate`: 1
- `telemetry_only`: 0 в этом локальном shortlisted срезе

Лучшие подтвержденные anchor-core rows сейчас:

- `MEXC`, `OPUSDT`, `4h`, `DD_BattleToads`
- `MEXC`, `OPUSDT`, `4h`, `zz_breakout`
- `Bitget`, `OPUSDT`, `4h`, `DD_BattleToads`
- `Bitget`, `OPUSDT`, `4h`, `zz_breakout`

Типичный профиль top rows:

- `ret`: примерно `0.42 - 0.50`
- `pf`: примерно `2.37 - 2.62`
- `dd`: примерно `0.19 - 0.29`
- `tf`: стабильно `4h`

Появился и первый `anchor_candidate` второго уровня:

- `Bitget`, `FETUSDT`, `1h`, `DD_BattleToads`
- `ret` около `0.109`
- `pf` около `1.116`

Это уже первый реальный product-grade сигнал для новой базы.

## Промежуточный вывод

- Новая `anchor` гипотеза уже выглядит существенно сильнее закрытой low-TF stat-arb ветки.
- `DD_BattleToads` и `zz_breakout` на `MEXC` и `Bitget` уже дают реальный `anchor_core` pool.
- Главный рабочий anchor слой сейчас формируется вокруг `4h` mono breakout logic, прежде всего по `OPUSDT`.

## Первый deduped TS shortlist

После удаления зеркальных дублей `DD/ZZ` по ключу `exchange + market + tf` первый рабочий shortlist выглядит так:

- `Bitget`, `OPUSDT`, `4h`, `DD_BattleToads`, `retPer30d 0.461`, `pf 2.508`, `dd 0.280`
- `MEXC`, `OPUSDT`, `4h`, `DD_BattleToads`, `retPer30d 0.496`, `pf 2.615`, `dd 0.247`

Резервный слой второго эшелона:

- `Bitget`, `FETUSDT`, `1h`, `DD_BattleToads`, `retPer30d 0.109`, `pf 1.116`, `dd 0.255`

Практический смысл такой:

- в текущую TS-базу логично брать именно два `OPUSDT 4h` anchor-core на разных venue
- `zz_breakout` пока считать зеркальной вариацией той же идеи, а не отдельным самостоятельным блоком базы
- `FETUSDT 1h` пока держать как reserve candidate для следующего validation слоя, а не как основной storefront anchor

## После expansion batch

Expansion batch завершился полностью:

- `job 44`: `ANCHORX_MEXC`
- `job 45`: `ANCHORX_BITGET`
- `320/320` runs на каждом venue
- `failedRuns = 0`

Главный вывод после объединения `ANCHOR_*` и `ANCHORX_*` в единый base:

- новый expansion не отменил исходный `OPUSDT 4h` anchor-core
- expansion добавил новый живой слой по `SEIUSDT 1h`
- для витрины теперь есть уже не один, а два разных типа сильных anchor-сигналов

Текущий unified deduped shortlist для витрины/TS:

- `Bitget`, `OPUSDT`, `4h`, `DD_BattleToads`, `retPer30d 0.461`, `pf 2.508`, `dd 0.280`
- `MEXC`, `OPUSDT`, `4h`, `DD_BattleToads`, `retPer30d 0.496`, `pf 2.615`, `dd 0.247`
- `Bitget`, `SEIUSDT`, `1h`, `DD_BattleToads`, `retPer30d 0.248`, `pf 1.661`, `dd 0.136`
- `MEXC`, `OPUSDT`, `1h`, `DD_BattleToads`, `retPer30d 0.363`, `pf 1.243`, `dd 0.322`

В процентах это надо читать так:

- `Bitget`, `OPUSDT`, `4h`: `retPer30d 46.1%`, `pf 2.508`, `dd 28.0%`
- `MEXC`, `OPUSDT`, `4h`: `retPer30d 49.6%`, `pf 2.615`, `dd 24.7%`
- `Bitget`, `SEIUSDT`, `1h`: `retPer30d 24.8%`, `pf 1.661`, `dd 13.6%`
- `MEXC`, `OPUSDT`, `1h`: `retPer30d 36.3%`, `pf 1.243`, `dd 32.2%`

Практически это означает:

- storefront base уже можно строить не только вокруг `OPUSDT 4h`
- `SEIUSDT 1h` выглядит как первый новый expansion-win, который реально расширяет ассортимент витрины
- `MEXC OPUSDT 1h` выглядит сильным по доходности и частоте, но требует более аккуратной risk-подачи из-за `dd 0.322`

## Карточки vs ТС

Важно не смешивать два разных слоя:

- `карточка стратегии` = одна конкретная offer-card из sweep/catalog
- `ТС` = собранный набор из нескольких карточек, разложенных по роли и риску

То есть текущий результат уже достаточен, чтобы делать не только карточки, но и первые ТС-паки.

Практически ТС здесь должны собираться так:

- `vitrine_core TS`: только low-dd и понятные anchor cards
- `growth TS`: более доходные, но с более глубокой просадкой
- `reserve TS`: кандидаты второго эшелона для следующей validation волны

По текущему builder output это уже выглядит так:

- `vitrine_core TS`: `Bitget SEIUSDT 1h`, `dd 13.6%`
- `growth TS`: `Bitget OPUSDT 4h`, `MEXC OPUSDT 4h`, `MEXC OPUSDT 1h` с `dd` примерно `24.7% - 32.2%`
- `reserve TS`: `SEIUSDT 4h`, `FETUSDT 1h` и следующие кандидаты

## Почему стратегий пока не так много

На текущем этапе число итоговых карточек режется не рынком, а архитектурой отбора:

- backend sweep сейчас умеет только `DD_BattleToads`, `zz_breakout`, `stat_arb_zscore`
- из них low-TF `stat_arb_zscore` как storefront-core уже честно провалился
- `DD` и `ZZ` часто оказываются зеркальными дублями одной и той же идеи
- unified shortlist специально дедупится по `exchange + market + tf`, чтобы витрина не состояла из псевдо-разнообразия

То есть мало не потому, что больше нечего искать.
Мало потому, что мы сначала фильтруем на честную базу, а не тащим в витрину шум.

Следующая волна должна расширять именно три вещи:

- больше markets
- больше synth combinations
- отдельный growth-tier с контролируемо большей просадкой, а не только ultra-clean vitrine-core

## Следующее действие

1. Прогнать следующий anchor discovery batch уже вокруг расширения market universe при сохранении `4h anchor core` как стандарта.
2. Поверх текущих `OPUSDT 4h` anchor-core запустить hybrid validation для `5m/15m` только как entry/telemetry layer.
3. После этого вернуться к storefront/label/UI и привязать витрину уже к подтвержденной базе, а не к сырому sweep pool.
# LOWTF baseline results 2026-04-17

Собран первый нормализованный baseline по завершенным lower-TF historical sweeps за 2026-04-17:

- MEXC
- Bitget `HDB_17`
- BingX `HDB_15`
- BingX `HDB_18`
- WEEX `IVAN_WEEX_RESEARCH`

Всего в объединенной базе: `30` candidate rows.

Распределение по биржам:

- `weex`: 6
- `bitget`: 6
- `bingx`: 12
- `mexc`: 6

Распределение по ролям по текущим правилам baseline:

- `storefront_candidate`: 0
- `ts_candidate_core`: 0
- `ts_candidate_satellite`: 0
- `analytics_only`: 30
- `reject`: 0

Главный вывод: текущий lower-TF прогон не дал ни одного кандидата, который можно честно положить в storefront или в TS assembly pool. Даже верхушка shortlist остается отрицательной по `retPer30d`.

Что это значит по сути:

- Гипотеза "5m/15m уже готовы быть product-layer" в текущей конфигурации не подтверждена.
- Текущие каталоги полезны как research telemetry, но не как база витрины.
- Собирать TS из этих результатов сейчас нельзя: получится красивая упаковка вокруг отрицательной математики.

Top baseline observations:

- WEEX top rows имеют малую просадку, но все равно отрицательный `retPer30d`.
- Bitget rows дают много трейдов, но отрицательный return при `pf < 1`.
- В этом срезе сильнее всего доминирует `mono stat_arb_zscore`, а не диверсифицированная смесь DD/ZZ/stat-arb.

Практическая логика базы после этого прогона:

- `5m/15m` оставляем как discovery / telemetry слой.
- `1h/4h` пока не списываем; наоборот, они нужны как anchor-layer, с которым lower-TF должен сравниваться, а не автоматически вытеснять его.
- Новый storefront base нельзя строить по raw top-N из этих каталогов.
- Следующая база должна строиться только после второго прохода фильтрации и ресвипа, где мы режем пространство параметров по причинам текущего провала.

Что менять в логике следующего sweep stage:

- Убрать слепой широкий перебор для lower-TF как основной режим принятия решений.
- Разделить sweeps на две роли:
  - `discovery sweep`: ищет живые паттерны, допускает широкий перебор.
  - `promotion sweep`: проверяет только узкий shortlist гипотез-кандидатов на устойчивость.
- Не продвигать стратегию в storefront, пока она не проходит минимум:
  - положительный `retPer30d`
  - `pf > 1`
  - приемлемую drawdown-геометрию
  - повторяемость хотя бы на нескольких venue / market setups

Нормальная база ТС после этого должна выглядеть так:

- `research_pool`: все discovery candidates, включая отрицательные, если они объясняют поведение рынка.
- `promotion_pool`: только кандидаты, прошедшие узкий повторный прогон.
- `storefront_base`: только кандидаты из `promotion_pool`, а не из discovery output.
- `ts_assembly_pool`: только кандидаты, у которых есть доказанная роль `core` или `satellite` после promotion stage.

Следующий практический шаг:

1. Снять не просто top rows, а reasoned failure segmentation по всем 30 кандидатам.
2. Выделить, какие family / market / venue combinations дают наименьший вред и где есть почти-ноль вместо явного минуса.
3. На основе этого собрать узкий resweep batch, а не повторять широкий 240-run шаблон еще раз.

Update after backend fix:

- Найден и исправлен infrastructural bug в backend route `/research/sweeps/full-historical/start`: route не пробрасывал `resumeEnabled`, `checkpointFile`, `maxMembers` и соседние override-поля в sweep service.
- Из-за этого первые promotion artifacts были ложными и не должны использоваться как новый evidence.
- После deploy route fix live job уже стартует корректно: в статусе видны `resumeEnabled: false`, отдельный promotion checkpoint и `maxMembers: 1`.
- То есть база теперь снова валидна методологически: следующий verdict будет строиться уже по честному promotion run, а не по replay baseline checkpoint.

Update after completed honest Bitget promotion:

- `HDB_17` promotion run завершился честно:
  - `resumeEnabled: false`
  - `checkpointFile: lowtf_promo_bitget_promotion_checkpoint.json`
  - `maxMembers: 1`
  - artifact: `hdb_17_client_catalog_2026-04-17T15-58-25-208Z.json`
- Результат не улучшил baseline, а ухудшил его:
  - лучший `ret` около `-0.3447`
  - лучший `pf` около `0.8001`
  - `dd` около `0.9071`
  - `trades` около `335`
- Практический вывод: `Bitget` нужно вывести из ближайшего promotion focus. Он не подтверждает low-TF product hypothesis даже после честного rerun.
- `WEEX` остается единственным venue, который еще нужно перепроверить честным rerun после backend fix, потому что доступный artifact `15:56:59` все еще старый replay с `resumeEnabled: true`.

Final update after honest WEEX promotion:

- `WEEX` тоже получил честный promotion rerun после backend fix:
  - `resumeEnabled: false`
  - `checkpointFile: lowtf_promo_weex_promotion_checkpoint.json`
  - `maxMembers: 1`
  - artifact: `ivan_weex_research_client_catalog_2026-04-17T17-38-38-369Z.json`
- `WEEX` оказался менее плохим, чем `Bitget`, но гипотезу все равно не подтвердил:
  - лучший `ret` около `-0.00865`
  - лучший `pf` около `0.8896`
  - `dd` около `0.0483`
  - `trades` около `14`
- Итого оба честных promotion venue дали один и тот же вывод:
  - все candidate rows отрицательные
  - у всех `pf < 1`
  - storefront base не появляется
  - `ts_assembly_pool` не появляется

Финальный вывод по текущей гипотезе:

- Narrow low-TF `5m` `mono OPUSDT stat_arb_zscore` hypothesis для storefront/promotion слоя не подтверждена.
- Эту ветку не нужно дальше расширять ни по grid, ни по additional venue в текущем виде.
- Дальнейшее движение должно быть не "еще один такой же sweep", а смена hypothesis:
  - другой strategy family
  - другой role для low-TF
  - либо возврат `1h/4h` как anchor layer и использование `5m` только как supplementary analytics layer

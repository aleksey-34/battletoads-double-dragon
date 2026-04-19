# LOWTF promotion resweep plan 2026-04-17

Ниже зафиксирована логика второго этапа после baseline sweep.

## Что уже понятно

- В объединенной lower-TF базе сейчас `30` rows.
- Все `30` rows находятся в `analytics_only`.
- В catalog вообще не попал `synth`; весь baseline-факт сейчас фактически равен `mono + OPUSDT + stat_arb_zscore`.
- Это значит, что текущий широкий sweep почти не дал diversification surface для будущей витрины и ТС.

## Найденный infrastructural blocker

- Первый promotion resweep дал ложный сигнал: новые artifacts были созданы, но сам backend route `/research/sweeps/full-historical/start` не пробрасывал `resumeEnabled`, `checkpointFile`, `maxMembers` и часть других override-полей в service.
- Из-за этого promotion job фактически стартовал с дефолтным checkpoint по `apiKeyName` и поднимал старое состояние вместо честного fresh rerun.
- Симптомы были прямые:
	- `skippedFromCheckpoint = 24`
	- ответ job содержал `resumeEnabled: true`, хотя в payload отправлялось `false`
	- WEEX и Bitget promotion catalogs оказались идентичными baseline-проходу

Вывод: artifacts `15:16`, `15:17`, `15:18` нельзя считать новым promotion evidence. Это только checkpoint replay.

## Failure segmentation

По уже собранным агрегатам видно следующее:

- Лучшая по venue зона сейчас `WEEX`: маленький абсолютный минус, малая просадка, но слишком слабая доходность и слишком мало сделок для promotion.
- `Bitget` выглядит как второй приоритет: математика все еще отрицательная, но ближе к нейтрали, чем `MEXC` и `BingX`.
- `MEXC` и `BingX` в текущем sweep-конфиге дают устойчиво более плохой профиль и должны быть выведены из первого promotion batch.
- По длине лучше смотрятся `72`, затем `96`. Длины `24` и `120` не нужно тащить в следующий узкий прогон.
- По `zscoreExit` наименее плохие зоны сейчас `1` и `0.75`; `0.5` выглядит как слишком шумный выход для текущего lower-TF режима.

## Что считать promotion batch

Promotion batch не должен быть широким поиском. Это только перепроверка уже найденных почти-живых зон.

Первый узкий promotion batch:

- venues: `WEEX`, `Bitget`
- market: `OPUSDT`
- family: `stat_arb_zscore`
- interval: `5m`
- lengths: `72`, `96`
- zscoreExit: `1`, `0.75`
- zscoreEntry: брать только near-zero baseline candidates, а не весь grid

## Что исключить из ближайшего resweep

- `MEXC` из promotion batch
- `BingX` из promotion batch
- `length=24`
- `length=120`
- `zscoreExit=0.5` как массовый default
- повтор полного 240-run broad sweep без новой гипотезы

## Нормальная логика базы после этого шага

- `discovery_pool`: широкий поиск и отрицательные гипотезы тоже сохраняются для статистики.
- `promotion_pool`: только near-zero или positive зоны, которые проверяем повторно и уже уже уже уже не расширяем grid без причины.
- `storefront_base`: строится только из promotion winners.
- `ts_assembly_pool`: строится только из promotion winners с доказанной ролью `core` или `satellite`.

## Следующее практическое действие

1. Сформировать конкретный узкий JSON batch по `WEEX + Bitget`, `L72/L96`, `ZX=1/0.75`.
2. Прогнать его как отдельный promotion sweep после backend fix в route, чтобы `resumeEnabled=false` и отдельный `checkpointFile` реально дошли до service.
3. Только после этого решать, есть ли вообще lower-TF candidates для storefront и multi-TS.

## Update after honest Bitget rerun

- `Bitget` уже получил честный promotion rerun после backend fix.
- Он не дал улучшения против baseline: математика осталась отрицательной и даже ухудшилась по лучшему `ret`.
- Поэтому ближайший следующий action должен быть уже не `WEEX + Bitget`, а только `WEEX` как последний venue для честной перепроверки в этом narrow setup.
- В data pipeline теперь добавлено явное правило: promotion-слой считается валидным только если artifact показывает одновременно:
	- `resumeEnabled = false`
	- отдельный promotion `checkpointFile`
	- `maxMembers = 1`
- Все artifacts, которые не проходят этот фильтр, считаются replay/noise и не должны влиять на strategy-base verdict.

Следующий узкий шаг теперь такой:

1. Запустить отдельный honest `WEEX` promotion rerun с тем же narrow config.
2. Если `WEEX` тоже остается отрицательным, закрыть текущую low-TF stat-arb hypothesis для storefront/promotion слоя.
3. После этого не расширять sweep-grid, а менять саму hypothesis: либо другой family, либо другой timeframe role, либо вернуть `1h/4h` как anchor layer.

## Final outcome of current promotion branch

- Honest `WEEX` rerun завершен и тоже остался отрицательным.
- Значит текущая ветка `5m + mono + OPUSDT + stat_arb_zscore` закрывается как неподтвержденная для storefront и TS promotion.
- Следующий этап исследований должен идти уже по новой логике, а не по расширению этого же narrow grid.

Нормальный следующий research branch:

1. Рассматривать `5m` не как product layer, а как telemetry / microstructure layer.
2. Вернуть `1h/4h` в роль anchor layer для product/storefront decisions.
3. Для нового sweep branch взять не тот же `stat_arb_zscore`, а другой family или hybrid logic, где `5m` служит фильтром/entry timing, а не единственным источником alpha.

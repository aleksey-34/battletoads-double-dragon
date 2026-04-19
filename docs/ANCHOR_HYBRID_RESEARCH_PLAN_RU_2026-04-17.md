# Anchor + Hybrid Research Plan 2026-04-17

## Задача

После закрытия ветки `5m + mono + OPUSDT + stat_arb_zscore` как неподтвержденной, следующая research-база должна строиться не вокруг еще одного low-TF brute-force sweep, а вокруг более устойчивой архитектуры:

- `1h/4h` = anchor layer
- `5m/15m` = telemetry / entry timing layer
- storefront и TS-кандидаты появляются только после согласования этих двух слоев

## Новая рабочая гипотеза

Надежная и доходная база не должна зависеть от одного low-TF режима.

Рабочая конструкция:

- Anchor-стратегии ищут устойчивую направленную или структурную логику на `1h/4h`.
- Low-TF слой не обязан сам зарабатывать как отдельный продукт.
- Low-TF слой используется как фильтр качества входа, насыщенности сделками и микроструктурного шума.

То есть вопрос меняется:

- было: `умеет ли 5m stat-arb сам быть продуктом?`
- становится: `какие 1h/4h конструкции дают продуктовую основу, и как 5m/15m помогает их улучшить по входу и риску?`

## Что считать anchor candidate

Anchor candidate должен быть:

- понятным по логике;
- устойчивым на `1h/4h`;
- не полностью съедаемым комиссиями;
- пригодным для сборки TS, а не только для одиночного бэктеста.

Приоритетные families для следующего branch:

- `DD_BattleToads`
- `zz_breakout`

С меньшим приоритетом:

- `stat_arb_zscore`, но уже не как storefront-core, а только как дополнительный слой или synth-specific filter.

## Что надо проверить первым

### Branch A. Anchor discovery

Цель:

- найти устойчивые `1h/4h` кандидаты на mono и synth;
- проверить, есть ли вообще продуктовый anchor слой без принудительного low-TF форсинга.

Начальный sweep должен быть уже, чем прошлый broad low-TF branch:

- venues: сначала `MEXC`, затем `Bitget`
- intervals: `1h`, `4h`
- families: `DD_BattleToads`, `zz_breakout`
- stat-arb в этот branch не тащить как core family

### Branch B. Hybrid validation

Цель:

- взять только лучшие anchor candidates;
- для них проверить, улучшает ли `5m/15m` слой качество входа или просто добавляет шум.

Здесь уже не нужен full discovery.
Нужен validation branch для ограниченного shortlist.

## Принципы отбора для качественной базы

### 1. Доходность без иллюзий

- Никаких кандидатов с `pf < 1` в storefront base.
- Никаких кандидатов с красивым `ret`, если он живет на слишком коротком окне.
- Никаких low-TF карточек, которые выглядят живыми только за счет темпа сделок.

### 2. Надежность важнее частоты

- Лучше меньше сделок, но понятнее edge.
- `1h/4h` могут давать более редкие, но структурно честные сигналы.
- `5m/15m` имеет смысл только если улучшает execution quality, а не подменяет alpha.

### 3. Архитектурная роль важнее raw ranking

Нужны три отдельные корзины:

- `anchor_core`
- `hybrid_candidate`
- `telemetry_only`

Без этого любой следующий storefront снова превратится в свалку случайных лидеров sweep-а.

## Следующий практический пакет

### Пакет 1. Anchor discovery sweeps

Собрать и прогнать VPS-side queue для:

- `MEXC Anchor Candidate`
- `Bitget Anchor Candidate`

Параметры:

- `intervals`: `1h`, `4h`
- `strategyTypes`: `DD_BattleToads`, `zz_breakout`
- умеренные `ddLengths`
- умеренные `takeProfit`
- акцент на mono + select synth pairs

### Пакет 2. Unified anchor table

Нормализовать результаты в таблицу с ролями:

- `anchor_core`
- `anchor_candidate`
- `telemetry_only`
- `reject`

Важно:

- если export/catalog не несет надежный `tf`, такие rows нельзя автоматически продвигать в `anchor_core`, даже если математика выглядит сильной;
- сначала восстанавливаем metadata, потом двигаем их в продуктовый слой.

### Пакет 3. Hybrid validation

Для 2-4 лучших anchor candidates проверить, дает ли `5m/15m` улучшение по:

- качеству входа
- снижению drawdown
- удержанию PF

## Критерий успеха новой ветки

Новая ветка считается успешной, если на выходе появляется хотя бы один из двух результатов:

1. Небольшой, но честный `anchor_core` pool для storefront/TS.
2. Доказательство, что hybrid entry layer реально улучшает anchor candidates.

Если этого нет, то проблема уже не в sweep-config, а в самой текущей strategy family set.

## Expansion batch after first anchor-core confirmation

После подтверждения первого `anchor_core` pool следующим правильным шагом стал не повтор первого discovery, а controlled expansion вокруг уже найденного стандарта.

Новый batch:

- prefixes: `ANCHORX_MEXC`, `ANCHORX_BITGET`
- purpose: `anchor_expansion`
- intervals: `1h`, `4h`
- families: `DD_BattleToads`, `zz_breakout`
- maxRuns: `320`
- anchor standard: сохраняем `4h` как основной reference layer

Расширенный `monoMarkets`:

- `OPUSDT`
- `FETUSDT`
- `SEIUSDT`
- `GRTUSDT`
- `INJUSDT`
- `TRUUSDT`
- `SUIUSDT`
- `WLDUSDT`
- `TIAUSDT`
- `ARBUSDT`
- `APTUSDT`
- `1000PEPEUSDT`

Расширенный `synthMarkets`:

- `OPUSDT/SEIUSDT`
- `FETUSDT/OPUSDT`
- `GRTUSDT/INJUSDT`
- `TRUUSDT/GRTUSDT`
- `SUIUSDT/OPUSDT`
- `WLDUSDT/TIAUSDT`
- `ARBUSDT/OPUSDT`
- `APTUSDT/SUIUSDT`

Operational status на момент фиксации:

- `job 44` запущен как `ANCHOR MEXC Expansion`
- очередь ожидает завершения `MEXC`, после чего должна автоматически стартовать `Bitget`

Смысл этого батча:

- не ломать уже найденный `OPUSDT 4h` anchor-core
- проверить, расширяется ли база на соседние market clusters
- получить следующий shortlist для витрины без возврата к шумному low-TF brute-force подходу

## Broad growth batch after expansion

После того как confirmed base перестал быть пустым, следующий честный шаг — не размывать витрину, а отдельно расширять growth-pool.

Новый batch:

- prefixes: `ANCHORG_MEXC`, `ANCHORG_BITGET`
- purpose: `anchor_growth_broad`
- venues: `MEXC`, затем `Bitget`
- `job 46` уже стартовал на `MEXC`
- `maxRuns`: `900`
- intervals: `1h`, `4h`
- families: `DD_BattleToads`, `zz_breakout`, `stat_arb_zscore`
- `maxMembers = 8`
- robust `maxDrawdownPercent = 35`

Зачем это нужно:

- получить больше честных стратегий, а не только ultra-clean витринные anchor-cards
- расширить число будущих ТС
- увеличить число сделок через `1h` и synth-ветку, но без возврата к провалившемуся low-TF storefront-core

Расширенный universe:

- mono: `OPUSDT`, `FETUSDT`, `SEIUSDT`, `GRTUSDT`, `INJUSDT`, `TRUUSDT`, `SUIUSDT`, `WLDUSDT`, `TIAUSDT`, `ARBUSDT`, `APTUSDT`, `1000PEPEUSDT`, `WIFUSDT`, `BONKUSDT`, `FLOKIUSDT`, `JUPUSDT`, `LINKUSDT`, `AVAXUSDT`
- synth: `OPUSDT/SEIUSDT`, `FETUSDT/OPUSDT`, `GRTUSDT/INJUSDT`, `TRUUSDT/GRTUSDT`, `SUIUSDT/OPUSDT`, `WLDUSDT/TIAUSDT`, `ARBUSDT/OPUSDT`, `APTUSDT/SUIUSDT`, `WIFUSDT/BONKUSDT`, `FLOKIUSDT/1000PEPEUSDT`, `JUPUSDT/WIFUSDT`, `LINKUSDT/ARBUSDT`, `AVAXUSDT/INJUSDT`, `TIAUSDT/SEIUSDT`
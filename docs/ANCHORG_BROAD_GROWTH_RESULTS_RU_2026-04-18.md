# Broad Growth Results 2026-04-18

## Что именно завершилось

Завершен новый широкий growth batch:

- `ANCHORG_MEXC`
- `ANCHORG_BITGET`
- по `900` runs на каждую площадку
- `failedRuns = 0`

Этот batch уже не смешивается со старой anchor-базой.
Ниже только результаты нового широкого прогона.

## Какие каталоги вошли в summary

- `ANCHORG_BITGET`: `hdb_17_client_catalog_2026-04-17T19-04-28-197Z.json`
- `ANCHORG_MEXC`: `btdd_mex_research_client_catalog_2026-04-17T19-01-52-862Z.json`

## Общий итог по новому batch

- всего shortlisted rows: `12`
- `anchor_core`: `3`
- `anchor_candidate`: `9`
- `telemetry_only`: `0`
- `reject`: `0` в этом shortlisted output

## Главный вывод

Broad growth batch реально расширил базу, но не по старым `DD/ZZ` mono anchor-паттернам, а прежде всего по `stat_arb_zscore` на `4h`.

Это важно:

- ранний low-TF `stat_arb_zscore` как storefront-core провалился честно
- но в новом `4h` broad growth batch тот же family уже дает рабочие growth и даже vitrine-like candidates
- значит проблема была не в family как таковом, а в предыдущем placement и слишком узкой гипотезе

## Top rows нового growth batch

### Growth winners

1. `Bitget`, `FETUSDT`, `4h`, `stat_arb_zscore`
   - `retPer30d = 40.6%`
   - `pf = 2.194`
   - `dd = 32.9%`
   - `tradesPer30d = 24`
   - статус: `anchor_core`, `growth`

2. `Bitget`, `FETUSDT`, `4h`, `stat_arb_zscore`
   - `retPer30d = 39.1%`
   - `pf = 1.851`
   - `dd = 27.9%`
   - `tradesPer30d = 24`
   - статус: `anchor_core`, `growth`

3. `Bitget`, `FETUSDT`, `4h`, `stat_arb_zscore`
   - `retPer30d = 30.9%`
   - `pf = 2.270`
   - `dd = 34.8%`
   - `tradesPer30d = 16`
   - статус: `anchor_core`, `growth`

### Vitrine-like winners

1. `Bitget`, `OPUSDT`, `4h`, `stat_arb_zscore`
   - `retPer30d = 14.6%`
   - `pf = 3.109`
   - `dd = 7.8%`
   - `tradesPer30d = 12`
   - статус: `anchor_candidate`, `vitrine_core`

2. `MEXC`, `OPUSDT`, `4h`, `stat_arb_zscore`
   - `retPer30d = 12.7%`
   - `pf = 2.839`
   - `dd = 3.7%`
   - `tradesPer30d = 12`
   - статус: `anchor_candidate`, `vitrine_core`

3. `Bitget`, `OPUSDT`, `4h`, `stat_arb_zscore`
   - `retPer30d = 11.8%`
   - `pf = 2.706`
   - `dd = 12.1%`
   - `tradesPer30d = 12`
   - статус: `anchor_candidate`, `vitrine_core`

### Speculative winner

1. `MEXC`, `FETUSDT`, `4h`, `stat_arb_zscore`
   - `retPer30d = 38.5%`
   - `pf = 2.089`
   - `dd = 35.4%`
   - `tradesPer30d = 23`
   - статус: `anchor_candidate`, `speculative`

## ТС-паки только по новому broad growth batch

### Vitrine Core TS

- `Bitget`, `OPUSDT`, `4h`, `stat_arb_zscore`, `retPer30d 14.6%`, `pf 3.109`, `dd 7.8%`

### Growth TS

- `Bitget`, `FETUSDT`, `4h`, `stat_arb_zscore`, `retPer30d 40.6%`, `pf 2.194`, `dd 32.9%`
- `Bitget`, `OPUSDT`, `1h`, `DD_BattleToads`, `retPer30d 8.8%`, `pf 1.153`, `dd 21.3%`
- `MEXC`, `OPUSDT`, `4h`, `stat_arb_zscore`, `retPer30d 14.1%`, `pf 1.636`, `dd 15.0%`

### Speculative TS

- `MEXC`, `FETUSDT`, `4h`, `stat_arb_zscore`, `retPer30d 38.5%`, `pf 2.089`, `dd 35.4%`

## Что это меняет стратегически

Теперь база уже точно не сводится только к `DD_BattleToads` и `zz_breakout`.

Новый честный вывод:

- `DD/ZZ` дали anchor foundation
- `stat_arb_zscore` вернулся как полезный `4h growth / vitrine-like` слой
- ключевой growth market нового батча сейчас: `FETUSDT`
- ключевой clean vitrine market нового батча сейчас: `OPUSDT 4h`

## Практический next step

1. Объединить старый anchor foundation и новый broad growth слой в единую TS-матрицу.
2. Для витрины держать отдельно `clean vitrine core` и отдельно `growth lineup`.
3. Не смешивать `speculative` с витриной, даже если там высокая доходность.
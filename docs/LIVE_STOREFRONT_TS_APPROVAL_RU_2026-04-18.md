# LIVE STOREFRONT + TS APPROVAL · 2026-04-18

## Что сейчас live

По состоянию на 2026-04-18 live summary и storefront приведены к новому curated-набору.

- Live mono catalog: 6 карточек
- Live synth catalog: 0 карточек
- Live admin TS draft: 6 стратегий
- API service: `btdd-api` active
- Backup старого storefront/TS state: `/opt/battletoads-double-dragon/results/storefront_ts_backup_2026-04-17T19-26-23Z.json`

## Что должно быть видно на телефоне

В админской витрине должны отображаться только эти 6 карточек:

1. `offer_mono_stat_arb_zscore_172020` — `MONO • stat_arb_zscore • OPUSDT`
   - strategyId: `172020`
   - strategy: `ANCHORG_BITGET_SZ_M_OPUSDT_4h_L96_ZE2_ZX0_5_ZS2_5`
   - ret: `14.6%`
   - pf: `3.109`
   - dd: `7.8%`
   - score: `41.540`

2. `offer_mono_stat_arb_zscore_172407` — `MONO • stat_arb_zscore • FETUSDT`
   - strategyId: `172407`
   - strategy: `ANCHORG_BITGET_SZ_M_FETUSDT_4h_L36_ZE1_25_ZX0_5_ZS3_5`
   - ret: `30.9%`
   - pf: `2.270`
   - dd: `34.8%`
   - score: `38.361`

3. `offer_mono_stat_arb_zscore_172011` — `MONO • stat_arb_zscore • OPUSDT`
   - strategyId: `172011`
   - strategy: `ANCHORG_BITGET_SZ_M_OPUSDT_4h_L96_ZE1_75_ZX0_5_ZS2_5`
   - ret: `11.8%`
   - pf: `2.706`
   - dd: `12.1%`
   - score: `37.430`

4. `offer_mono_stat_arb_zscore_172370` — `MONO • stat_arb_zscore • FETUSDT`
   - strategyId: `172370`
   - strategy: `ANCHORG_BITGET_SZ_M_FETUSDT_4h_L24_ZE1_25_ZX0_5_ZS3`
   - ret: `40.6%`
   - pf: `2.194`
   - dd: `32.9%`
   - score: `37.354`

5. `offer_mono_stat_arb_zscore_172405` — `MONO • stat_arb_zscore • FETUSDT`
   - strategyId: `172405`
   - strategy: `ANCHORG_BITGET_SZ_M_FETUSDT_4h_L36_ZE1_25_ZX0_5_ZS2_5`
   - ret: `39.1%`
   - pf: `1.851`
   - dd: `27.9%`
   - score: `33.964`

6. `offer_mono_dd_battletoads_171520` — `MONO • DD_BattleToads • OPUSDT`
   - strategyId: `171520`
   - strategy: `ANCHORG_BITGET_DD_M_OPUSDT_1h_L12_TP5_SRCwick`
   - ret: `8.8%`
   - pf: `1.153`
   - dd: `21.3%`
   - score: `24.626`

## Draft TS, который должен быть виден в admin UI

После фикса summary path admin UI должен показывать 6 членов draft TS:

1. `172020` — `ANCHORG_BITGET_SZ_M_OPUSDT_4h_L96_ZE2_ZX0_5_ZS2_5` — weight `1.15`
2. `172011` — `ANCHORG_BITGET_SZ_M_OPUSDT_4h_L96_ZE1_75_ZX0_5_ZS2_5` — weight `1.05`
3. `172370` — `ANCHORG_BITGET_SZ_M_FETUSDT_4h_L24_ZE1_25_ZX0_5_ZS3` — weight `0.95`
4. `172407` — `ANCHORG_BITGET_SZ_M_FETUSDT_4h_L36_ZE1_25_ZX0_5_ZS3_5` — weight `0.92`
5. `172405` — `ANCHORG_BITGET_SZ_M_FETUSDT_4h_L36_ZE1_25_ZX0_5_ZS2_5` — weight `0.88`
6. `171520` — `ANCHORG_BITGET_DD_M_OPUSDT_1h_L12_TP5_SRCwick` — weight `0.85`

## Что было исправлено

- Ранее `/admin/curated-draft-members` уже хранил 6 членов draft TS, но `summary.catalog.adminTradingSystemDraft` показывал только 2 source-members.
- Причина была в том, что `getSaasAdminSummary()` не инжектил `admin.catalog.extra_draft_members`.
- Backend исправлен: extra draft members теперь добавляются и в admin summary path.
- После реального rebuild/restart `btdd-api` summary начал возвращать `summaryDraftMembersCount = 6`.

## Что проверять вручную

1. В разделе storefront нет старых карточек, только 6 карточек из списка выше.
2. В блоке draft TS счетчик показывает `6 members`.
3. Внутри draft TS совпадают strategyId и веса.
4. Нет synth-карточек в live catalog.

## Техническое замечание

Поле `offerStore.publishedOfferIds / curatedOfferIds / labels` сейчас остается `null`, но это не ломает live storefront, потому что текущий merged live catalog уже физически состоит только из нового набора из 6 офферов.
# B3 zz_breakout 1h — аудит churn (Aug 2026)

## TL;DR

- **8× zz_breakout @ 1h в b3 — это не баг remat**, они в `sharedB3` (system 205) с мастера BTDD_D1.
- Это **Donchian breakout 1h** (`FREQ_STACK_20260710_DONCH_*_1h_L55`), не ZZ-pivot; тип стратегии `zz_breakout`.
- **12 sig entries / 48h** на copy-ключ ≈ **1.5 входа/день на 8 ног** — шумно на воле, но не «96× BT».
- Реальная проблема UI: **111 «сделок» = все events** (fills+exits+signals); честных входов **~30/24ч**.
- **Дубли экспозиции**: INJ/SUI/WLD есть и в **zz_breakout 1h mono**, и в **ZZ_Fast 4h synth** — двойная ставка на одни символы.
- **ORDI** в b3 дважды: zz_breakout 1h + momentum_scalp_tv 4h.

## Состав b3 (21 нога, все copy-ключи одинаково)

| interval | strategy_type      | count | symbols |
|----------|-------------------|------:|---------|
| 1h       | zz_breakout       | 8     | SUI, DOGE, INJ, NEAR, ARB, WLD, ORDI, SEI |
| 4h       | ZZ_Fast (synth)   | 5     | BCH, INJ, SUI, WLD, ZEN |
| 4h       | momentum_scalp_tv | 8     | ADA, ORDI, BNB, XRP, EIGEN, COMP, TIA, ONDO |

Источник: `recipes_hamfive_aug2026.json` → `sharedB3.systemIdSource = 205`.

## Почему «1h ZZ» шумят

1. **1h Donchian** — быстрый TF; на импульсе (19 Aug 16:00–21:00 UTC) ловят flip long/short.
2. **NEAR** — этalon churn: ~1 sig entry/день, flip по closed bar; на движении 19 Aug 16:08 long entry после серии short — **ожидаемо для breakout**, не intra-bar spam.
3. **Fill inflation**: BCH ZZ_Fast 4h = 16 fills / 4 entries (partial/pyramid), не лишние сигналы.
4. **Overlap synth+mono** на WLD/INJ/SUI: zz_breakout 1h long **и** ZZ_Fast 4h synth cycle — **две независимые книги на один символ**.

## Live vs BT (Aug 18–20, Copy_Alex1)

| Метрика | Значение |
|---------|----------|
| UI «сделок 24ч» (старое) | 111 events |
| **Честные sig entries 24ч** | **30** |
| zz_breakout 1h entries 48h | 12 (8 символов) |
| Импульс 19 Aug 15–21 UTC Δequity | +$65 ($808→$873) |

Fair BT до фикса падал: copy WEEX key без свечей → `freqX=null`. Фикс: `dataApiKeyName=BTDD_D1` + `skipMissingSymbols` в nightly fair run.

## Рекомендации (на обсуждение)

1. **Не удалять вслепую** — 1h Donch в рецепте; на отскоке 19 Aug дали uPnL через open longs (SEI, ARB, DOGE…).
2. **Рассмотреть dedup экспозиции**: убрать zz_breakout 1h на символах где уже ZZ_Fast 4h synth (INJ, SUI, WLD) — −3 ноги, −overlap risk.
3. **ORDI**: zz_breakout 1h + momentum 4h — оставить один sleeve или снизить lot на одном.
4. **Мониторинг**: показывать `sig entries 24h`, не raw events (fix Aug 2026).
5. **Tier CB** на zz_breakout уже в рецепте (`tierCbOnZzBreakout: true`) — проверить что live применяет pause после dd8.

## Команды проверки (VPS)

```bash
# b3 zz_breakout 1h legs
sqlite3 backend/database.db "SELECT s.base_symbol FROM strategies s
  JOIN trading_system_members tsm ON tsm.strategy_id=s.id
  JOIN trading_systems ts ON ts.id=tsm.system_id
  JOIN api_keys a ON a.id=ts.api_key_id
  WHERE a.name='Copy_Alex1' AND ts.name LIKE '%::b3'
    AND s.strategy_type='zz_breakout' AND s.interval='1h';"

# честные входы 24ч
sqlite3 backend/database.db "SELECT COUNT(*) FROM live_trade_events lte
  JOIN strategies s ON s.id=lte.strategy_id JOIN api_keys a ON a.id=s.api_key_id
  WHERE a.name='Copy_Alex1' AND lte.trade_type='entry'
    AND lte.event_origin='strategy_signal'
    AND lte.actual_time >= (strftime('%s','now','-24 hours')*1000);"
```

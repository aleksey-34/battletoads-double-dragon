# Почему balanced-portfolio-v2 — в основном Mono

## Как собирается TS backtest в SaaS

1. Для `ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2` подтягивается **сохранённый snapshot** (`offer.store.ts_backtest_snapshots`).
2. Список `offerIds` из snapshot **подменяет** выбор из sweep (если не передан `forceOfferIds: true`).
3. При публикации карточки в curated обычно попадали **top mono** (DD/zz_breakout) — проще витрина, меньше синтетики в одном наборе.

Синтетика (`stat_arb_zscore`, пара base/quote, decorrelation) в **sweep** есть (`topByMode.synth`), но в **этой** TS она не была выбрана при сохранении snapshot.

## Как читать результаты compare (частая путаница)

| Прогон | Что значит |
|--------|------------|
| **SYNTHETIC ~1%**, 5 offers, 153 trades | Часто **сломанный** прогон: в логе `Client not initialized for BTDD_D1` — стратегии пропущены, портфель из оставшихся 5 synth. **Не сравнивать** с balanced. |
| **MONO ~1.8%**, 10 offers | То же: часть skip, неполный real rerun. |
| **BALANCED-V2 ~278%**, 38 offers | **Полный** real rerun: snapshot + `ensureExchangeClient` + все 38 mono-офферов за 732d. Это **клиентская карточка**, не «top-5 synth». |

**Вывод:** 1% vs 278% — не «синтетика хуже mono», а **разный состав (5 vs 38)** и **баг инициализации** на research-прогонах. После фикса перезапусти скрипт — в строке должно быть `src admin_sweep_rerun`, `skip 0` (или мало).

Синтетика в sweep не хуже по определению — в balanced-v2 её просто **нет в snapshot**.

## Отдельный прогон только Synthetic TS

```bash
cd backend && npm run build && cd ..
node scripts/run_synthetic_ts_backtest.mjs
```

Переменные: `TS_DATE_FROM`, `TS_DATE_TO`, `TS_SYNTH_LIMIT`, `TS_API_KEY`, `TS_REINVEST`.

Скрипт выводит три строки:

| Прогон | Смысл |
|--------|--------|
| SYNTHETIC TS | Top-N synth из sweep, `forceOfferIds` |
| MONO TS | Top-N mono для сравнения |
| BALANCED-V2 | Текущий snapshot клиентской карточки |

На VPS (**git только от `ubuntu`**, не от root):

```bash
# 1. Обновить код (root → sudo -u ubuntu)
sudo -u ubuntu git -C /opt/battletoads-double-dragon fetch origin main
sudo -u ubuntu git -C /opt/battletoads-double-dragon reset --hard origin/main

# 2. Собрать backend
cd /opt/battletoads-double-dragon/backend && npm run build

# 3. Запуск — из КОРНЯ репо (не backend!)
cd /opt/battletoads-double-dragon
node scripts/run_synthetic_ts_backtest.mjs 2>&1 | tee logs/synthetic_ts_compare_v2.log
```

**Не** `git pull` от root (Permission denied).  
**Не** `node ../scripts/...` из корня реpo — путь станет `/opt/scripts/...` и MODULE_NOT_FOUND.

## DCA и деплой

- **DCA combined** считается на бэкенде (`btdd-api`). После фикса sizing нужен **новый** «Сканировать DCA» + combined preview (не старый кэш UI).
- Подписи в SaaS (`trades = циклы`, `base % + compound`) — во **frontend build**; если на VPS старый `main.*.js`, обновить: `npm run build` в `frontend` → nginx.

## Чарт Dashboard 524

524 = таймаут Cloudflare, API не ответил вовремя (часто cold exchange / два запроса synth).

Исправление: timeout 45s на `/api/market-data` и `/api/synthetic-chart`, init клиента до запроса, axios timeout 50s в Dashboard.

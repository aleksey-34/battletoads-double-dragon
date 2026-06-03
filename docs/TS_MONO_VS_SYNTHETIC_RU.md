# Почему balanced-portfolio-v2 — в основном Mono

## Как собирается TS backtest в SaaS

1. Для `ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2` подтягивается **сохранённый snapshot** (`offer.store.ts_backtest_snapshots`).
2. Список `offerIds` из snapshot **подменяет** выбор из sweep (если не передан `forceOfferIds: true`).
3. При публикации карточки в curated обычно попадали **top mono** (DD/zz_breakout) — проще витрина, меньше синтетики в одном наборе.

Синтетика (`stat_arb_zscore`, пара base/quote, decorrelation) в **sweep** есть (`topByMode.synth`), но в **этой** TS она не была выбрана при сохранении snapshot.

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

На VPS:

```bash
cd /opt/battletoads-double-dragon/backend && npm run build
cd .. && node scripts/run_synthetic_ts_backtest.mjs 2>&1 | tee logs/synthetic_ts_compare.log
```

## DCA и деплой

- **DCA combined** считается на бэкенде (`btdd-api`). После фикса sizing нужен **новый** «Сканировать DCA» + combined preview (не старый кэш UI).
- Подписи в SaaS (`trades = циклы`, `base % + compound`) — во **frontend build**; если на VPS старый `main.*.js`, обновить: `npm run build` в `frontend` → nginx.

## Чарт Dashboard 524

524 = таймаут Cloudflare, API не ответил вовремя (часто cold exchange / два запроса synth).

Исправление: timeout 45s на `/api/market-data` и `/api/synthetic-chart`, init клиента до запроса, axios timeout 50s в Dashboard.

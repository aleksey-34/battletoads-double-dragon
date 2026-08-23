# Monitoring chart — roadmap

## Сейчас (Aug 2026)

- График мониторинга: equity, PnL, UPNL, DD; режим **% доходности за период**.
- Интервалы: 1д / 7д / 30д / 90д / **Всё** (вся история снимков).
- За период: **% доходности** и **результат в USDT** (из equity snapshots).
- Список сделок под графиком (из `live_trade_events` + `exchange_fill_events`).
- API: `GET /api/monitoring/:key?days=&all=1&includeTrades=1` → `periodStats`, `trades`.
- Маркеры сделок на графике **отключены** — читаемость.
- **Хранение:** `backend/monitoring.db` (отдельно от `database.db`) — snapshots + fills.
  Строки ссылаются на `api_keys.id` из main (и дублируют `api_key_name` для удобства).
- On-demand backfill Bybit: кнопка «С биржи» (Transaction Log + Execution List).
- **Open-position charts** (Positions monitoring modal): synthetic/mono candles, Donchian, Entry/TP, fill arrows — lazy load.
- **Retention:** one-time purge snapshots/fills older than 30d on boot (`ensureMonitoringRetentionPurge`); full demat deletes key monitoring rows.

## Позже

1. **Депозиты/выводы** — таблица `account_cashflows` для TWR/MWR вместо proxy `deposit_base_usd`.
2. **Публичная витрина** — shareable URL как tradelink.pro (без авторизации).
3. **Опционально на графике** — sparse markers по чекбоксу.
4. ~~**Импорт истории** — backfill equity~~ — **сделано (Bybit)**. Дальше: BingX/WEEX/Binance adapters.

Файлы: `MonitoringChartPanel.tsx`, `monitoring.ts`, `monitoring/db.ts`, `Positions.tsx`, `PartnerCabinet.tsx`.

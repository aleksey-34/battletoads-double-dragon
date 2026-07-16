# Monitoring chart — roadmap

## Сейчас (Jul 2026)

- График мониторинга: equity, PnL, UPNL, DD; режим **% доходности за период**.
- Интервалы: 1д / 7д / 30д / 90д / **Всё** (вся история снимков).
- За период: **% доходности** и **результат в USDT** (из equity snapshots).
- Список сделок под графиком (из `live_trade_events`, sync с биржи).
- API: `GET /api/monitoring/:key?days=&all=1&includeTrades=1` → `periodStats`, `trades`.
- Маркеры сделок на графике **отключены** — читаемость.

## Позже

1. **Депозиты/выводы** — таблица `account_cashflows` для TWR/MWR вместо proxy `deposit_base_usd`.
2. **Публичная витрина** — shareable URL как tradelink.pro (без авторизации).
3. **Опционально на графике** — sparse markers по чекбоксу.
4. **Импорт истории** — backfill equity до первого снимка из exchange fills.

Файлы: `MonitoringChartPanel.tsx`, `monitoring.ts`, `Positions.tsx`, `PartnerCabinet.tsx`.

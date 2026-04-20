# Новая TS-модель (runtime-first), 21.04.2026

## Цель
Сделать модель, которая совпадает с реальным runtime на VPS, не ломается на pair-conflict и не рисует недостижимую диверсификацию.

## Базовая боевая конфигурация (уже совместима с runtime)
- Engine: `ALGOFUND::<tenant>`
- `max_open_positions = 4`
- Members (core, 1 стратегия на символ):
  - BERAUSDT (DD_BattleToads)
  - OPUSDT (DD_BattleToads)
  - FETUSDT (stat_arb_zscore)

## Почему именно так
- Runtime ограничивает одновременно открытые позиции, поэтому модель с дублирующимися одинаковыми рынками неустойчива.
- Убрали зависимость от отсутствующего master-row: materialize теперь может переиспользовать active same-pair стратегию на API key.
- Текущая тройка symbols проходит через реальную materialization + retry-path.

## Рекомендуемая целевая диверсификация (v2)
При следующем расширении добавлять только символы, подтвержденные на конкретной бирже клиента:
- Core (всегда): BERAUSDT, OPUSDT, FETUSDT
- Satellite (по доступности/ликвидности): ORDIUSDT
- `max_open_positions`: 4
- Ограничения:
  - не больше 1 активной стратегии на символ
  - не больше 40% веса на один символ
  - при конфликте pair -> reuse active strategy (не падать в 500)

## KPI для прод-готовности
- Retry materialize: 200 для всех целевых tenant
- Members в каждом `ALGOFUND::<tenant>`: >= 3 и unique symbols >= 3
- 24h активность: entries > 0 хотя бы у 2 из 3 tenant
- Отсутствие пустых engine-members после перезапуска API

## Что считать честной метрикой сейчас
Пока в `live_trade_events` exit события приходят с `position_size = 0`, PnL/PF из этой таблицы использовать нельзя.
Допустимые runtime KPI до фикса схемы:
- events/entries/exits
- unique active symbols
- availability materialize/retry path

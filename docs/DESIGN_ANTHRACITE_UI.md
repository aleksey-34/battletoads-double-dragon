# Design branch: Anthracite UI

Фирменная тёмная тема платформы: антрацит, текстурный фон, золотые акценты (BTDD signature).

## Тема **Anthracite** (`anthracite`)

- В списке тем: **⬛ Anthracite** (по умолчанию для новых сессий)
- Старые темы сохранены: Classic, Neon, Fire, Light
- Legacy `zignaly` в localStorage автоматически мапится на `anthracite`

## Компоненты витрины

`frontend/src/components/storefront/`

- `StrategyOfferCard` — оферы стратегий
- `TradingSystemCard` — торговые системы (badge «N стратегий»)
- `StorefrontGrid` — ровная CSS-grid

Подключено: **ClientCabinet**, **SaaS admin vitrine** (стратегии + ТС, futures/spot).

## Деплой

После merge в `main` — обычный git-deploy на VPS.

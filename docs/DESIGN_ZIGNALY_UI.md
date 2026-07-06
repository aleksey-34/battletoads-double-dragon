# Design branch: `design/zignaly-ui`

Отдельная ветка для редизайна UI в духе Zignaly. **`main` не трогаем** до ревью.

## Что в ветке

- Тема **Zignaly** (deep navy + purple gradient) — в списке тем вместе с Classic / Neon / Fire / Light
- Общие компоненты витрины: `frontend/src/components/storefront/*`
- Клиентский ЛК (`ClientCabinet`) — карточки + ровная CSS-grid
- Админка — sidebar вместо горизонтального меню
- Лендинг — тема Zignaly по умолчанию

## Что пока НЕ трогали (чтобы не мешать параллельной работе)

- **`frontend/src/pages/SaaS.tsx`** — spot/futures вкладки и переименования витрин (другой агент)
- После мержа spot-изменений: подключить `StrategyOfferCard` / `TradingSystemCard` в admin vitrine

## Как смотреть локально

```bash
git checkout design/zignaly-ui
cd frontend && npm start
```

В шапке выбрать тему **🟣 Zignaly**.

## Мерж в main

1. Дождаться завершения spot-витрины в `SaaS.tsx`
2. `git checkout main && git merge design/zignaly-ui`
3. Разрешить конфликты только в `SaaS.tsx` (подключить shared cards)
4. `npm run build` → commit → deploy

## Откат

```bash
git checkout main
```

Старая вёрстка остаётся в `main` до явного merge.

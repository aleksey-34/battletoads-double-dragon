# BTDD (Battletoads Double Dragon) — Архитектура проекта

> Последнее обновление: 2026-04-03  
> Ветка: `feature/ts-architecture-refactor`

## Назначение
SaaS-платформа автоматизированной торговли криптовалютами. Алгоритмические стратегии (mono/synth) собираются в торговые системы (TS), клиенты подключаются через управляемые тарифы.

---

## Стек
| Слой | Технология |
|------|-----------|
| Frontend | React 18 + Ant Design + TypeScript, CRA-сборка |
| Backend | Node.js + Express + TypeScript |
| БД | SQLite (файл `backend/database.db`) |
| Биржевой коннектор | ccxt (Binance, Bybit, MEXC, Bitget, BingX, Weex) |
| Хостинг | VPS 176.57.184.98, nginx → static + proxy `/api` |
| CDN/DNS | Cloudflare (прокси-мост) |
| CI/CD | Ручной: git push → ssh pull → npm run build → systemctl restart |

---

## Структура репозитория

```
/
├── backend/
│   ├── src/
│   │   ├── api/
│   │   │   ├── routes.ts            # Основные API (dashboard, strategies, positions)
│   │   │   ├── saasRoutes.ts        # SaaS API (~1080 строк, 56 эндпоинтов)
│   │   │   ├── analyticsRoutes.ts   # Аналитика
│   │   │   └── researchRoutes.ts    # Исследования/свипы
│   │   ├── saas/
│   │   │   └── service.ts           # Главный SaaS сервис (~9200 строк)
│   │   ├── utils/
│   │   │   ├── database.ts          # SQLite обёртка
│   │   │   ├── auth.ts              # Авторизация, magic-links
│   │   │   └── ...
│   │   ├── engine/                   # Торговый движок, стратегии
│   │   └── ...
│   ├── logs/                         # combined.log, error.log
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── SaaS.tsx             # Главная SaaS-страница (~11 560 строк)
│   │   │   ├── Dashboard.tsx        # Дашборд трейдера
│   │   │   ├── ClientCabinet.tsx    # Вход клиента через magic-link
│   │   │   ├── ClientAuth.tsx       # Авторизация клиента
│   │   │   ├── Positions.tsx        # Позиции / мониторинг
│   │   │   ├── TradingSystems.tsx   # Управление ТС
│   │   │   ├── Settings.tsx         # Настройки API-ключей
│   │   │   └── ...
│   │   └── components/
│   ├── build/                        # Сборка → /var/www/battletoads-double-dragon/
│   ├── package.json
│   └── tsconfig.json
├── schema-init.sql                   # DDL всех таблиц (499 строк, 29 таблиц)
├── scripts/                          # Утилиты: бэктесты, каталоги, проверки
├── docs/                             # Документация
└── deploy.sh                         # Скрипт деплоя
```

---

## БД — Ключевые таблицы

### Торговля
| Таблица | Назначение |
|---------|-----------|
| `api_keys` | Биржевые API-ключи (name, key, secret) |
| `strategies` | Стратегии (привязаны к api_key_id) |
| `trading_systems` | Торговые системы (набор стратегий, привязаны к api_key_id) |
| `trading_system_members` | Связь TS↔strategies |
| `live_trade_events` | Реальные сделки |
| `monitoring_snapshots` | Снимки equity/PnL/DD по api_key |

### SaaS-платформа
| Таблица | Назначение |
|---------|-----------|
| `plans` | Тарифные планы (strategy/algofund/copytrading/synctrade/combined) |
| `tenants` | Клиенты (slug, display_name, product_mode, status) |
| `subscriptions` | Привязка tenant↔plan |
| `strategy_client_profiles` | Профиль strategy-клиента (offer_ids, risk, frequency, api_key) |
| `strategy_client_system_profiles` | Пользовательские TS-профили клиента (TS composer) |
| `algofund_profiles` | Профиль algofund-клиента (risk_multiplier, api_key, enabled) |
| `algofund_start_stop_requests` | Очередь запросов старт/стоп алгофонда |
| `copytrading_profiles` | Копитрейдинг (master + followers) |
| `synctrade_profiles` | Синхрон-трейдинг |
| `client_users` / `client_sessions` / `client_magic_links` | Авторизация клиентов |
| `saas_audit_log` | Аудит-лог действий |

---

## Продуктовые режимы (product_mode)

| Режим | Описание | Frontend tab |
|-------|----------|-------------|
| `strategy_client` | Клиент выбирает оферы, строит TS, настраивает риск/частоту | `strategy-client` |
| `algofund_client` | Управляемый портфель, клиент настраивает только риск | `algofund` |
| `copytrading_client` | Копирование сделок мастера | `copytrading` |
| `synctrade_client` | Синхрон-торговля между аккаунтами | `synctrade` |

### Ключевые переменные в SaaS.tsx
- `surfaceMode`: `'admin' | 'strategy-client' | 'algofund' | 'copytrading' | 'synctrade'`
- `isAdminSurface = surfaceMode === 'admin'`
- `activeTab`: текущий таб  
- `adminTab`: подтаб админа (`'overview' | 'monitoring' | 'clients' | 'create-user'`)

---

## API — Структура эндпоинтов

Все SaaS-маршруты зарегистрированы в `saasRoutes.ts`, база `/api/saas/`.

### Admin (28 routes)
- `GET/PATCH /admin/telegram-controls` — Telegram-уведомления
- `GET/PATCH /admin/reports/settings` — настройки отчётов
- `GET /admin/reports/performance?period=` — отчёт (daily/weekly/monthly)
- `GET /admin/summary` — сводка по всем клиентам
- `GET/PATCH /admin/offer-store` — управление офферами (публикация, метрики)
- `POST /admin/sweep-backtest-preview` — бэктест для админа
- `POST /admin/publish` — публикация TS на витрину
- `POST /admin/tenants` — создание клиента
- `POST /admin/tenants/:id/magic-link` — генерация ссылки входа
- `POST /admin/algofund-batch-actions` — пакетные операции

### Strategy Client (10 routes)
- `GET/PATCH /strategy-clients/:id` — состояние/обновление профиля
- `POST /strategy-clients/:id/materialize` — материализация стратегий
- `CRUD /strategy-clients/:id/system-profiles` — TS composer (профили)

### Algofund (9 routes)
- `GET/PATCH /algofund/:id` — состояние/обновление профиля
- `PUT /algofund/:id/active-systems` — назначение систем
- `PATCH /algofund/:id/active-systems/:name/toggle` — вкл/выкл системы
- `POST /algofund/:id/request` — запрос старт/стоп

---

## Клиентский кабинет (ЛК)

### Algofund клиент видит:
- Витрину алгофонда (карточки TS с графиками equity, метриками Ret/DD/PF)
- Кнопку «Бэктест» → упрощённый drawer (риск-слайдер, equity-график)
- Свой API-ключ + статус (подключён / не активен)
- Тариф, лимиты, метрики мониторинга (equity, PnL, DD, margin)

### Strategy клиент видит:
- Витрину стратегий (карточки оферов с графиками equity)
- TS composer: «Мои торговые системы» — создание/удаление/активация профилей
- Каталог оферов с чекбоксами (выбор стратегий в ТС)
- Ограничения конструктора (слоты, mono/synth лимиты, депозит)
- Слайдеры риска и частоты
- Кнопки «Сохранить» + «Материализовать»
- Бэктест drawer (риск + частота, equity-график)

### Админ дополнительно видит:
- Все вкладки всех клиентов
- Мониторинг (таблица клиентов, equity, DD, margin, toggle вкл/выкл)
- Витрину с возможностью публикации/снятия TS
- Полный backtest drawer (все метрики, P/L график, DD график, overlay'и, таблица офферов, веса)
- Создание клиентов, magic-links, пакетные операции

---

## Бизнес-логика — Ключевые правила

### D1: Один API-ключ = один клиент
При назначении ключа проверяется `validateApiKeyNotAssigned()` — ключ не может быть назначен двум разным тенантам (ни в algofund, ни в strategy).

### D2: Кросс-мод блокировка
Ключ из algofund нельзя использовать в strategy и наоборот. Один ключ = один режим.

### D3: Combined-тарифы
Планы `combined_70` / `combined_120` — Algofund + Strategy в одном тарифе (feature `strategyAddon: true`). Тенант может иметь оба профиля с **разными** ключами.

### E1: Отключение клиента
При toggle OFF → Modal.confirm с предупреждением (ордера отменяются, позиции закрываются).

### Бэктест
- Админ: полный sweep-backtest с метриками, графиками P/L и DD, overlay BTC, таблицей офферов
- Клиент: упрощённый — слайдер риска (+ частота для strategy), equity-график, базовые метрики

---

## Деплой

### Сервисы на VPS (systemd)
- `btdd-api` — Express API (порт 3001)
- `btdd-runtime` — торговый движок

### Процедура
```bash
# На VPS:
cd /opt/battletoads-double-dragon
git pull origin feature/ts-architecture-refactor
cd backend && npm run build
systemctl restart btdd-api
cd ../frontend && npm run build
cp -r build/* /var/www/battletoads-double-dragon/
```

### Nginx
- `/` → static из `/var/www/battletoads-double-dragon/`
- `/api/` → proxy_pass `http://localhost:3001`

---

## Тарифные планы (seed)

### Strategy Client
| Код | Цена | Макс стратегий | Депозит | Custom TS |
|-----|------|---------------|---------|-----------|
| strategy_15 | $15 | 2 | $1000 | 1 профиль, 2 оферов |
| strategy_20 | $20 | 3 | $1000 | 1 профиль, 3 оферов |
| strategy_50 | $50 | 5 | $5000 | 3 профиля, 5 оферов |
| strategy_100 | $100 | 6 | $10000 | 3 профиля, 6 оферов |

### Algofund
| Код | Цена | Риск макс | Депозит |
|-----|------|----------|---------|
| algofund_20 | $20 | 1x | $1000 |
| algofund_50 | $50 | 1.2x | $5000 |
| algofund_100 | $100 | 2x | $5000 |
| algofund_200 | $200 | 2.5x | $10000 |

### Combined (Algofund + Strategy)
| Код | Цена | Риск | Стратегий | Депозит |
|-----|------|------|----------|---------|
| combined_70 | $70 | 1.5x | 3 | $5000 |
| combined_120 | $120 | 2x | 5 | $10000 |

---

## Соглашения для разработчиков и AI-ассистентов

1. **Язык UI**: русский для клиентских блоков, английский допустим во внутренних тегах
2. **SaaS.tsx** — мега-файл (~11 500 строк). Не пытайся прочитать целиком. Ищи по ключевым словам (grep)
3. **service.ts** — второй мега-файл (~9 200 строк). Содержит ВСЮ бизнес-логику SaaS
4. **Типы оферов**: `{ offerId, titleRu, mode, market, ret, dd, pf, trades, tradesPerDay, periodDays, equityPoints? }` — метрики на верхнем уровне, НЕ вложены в `.strategy` или `.metrics`
5. **Типы TS (витрина)**: `{ systemName, summary: { totalReturnPercent, maxDrawdownPercent, profitFactor, tradesCount, periodDays }, equityCurve, tenants }`
6. **Деплой**: через `ssh root@176.57.184.98` + bash -s (here-string в PowerShell). Не использовать pm2 — только systemd
7. **Ветка**: `feature/ts-architecture-refactor` — основная рабочая
8. **Перед редактированием**: всегда `grep_search` / `read_file` — файлы большие, контекст важен
9. **Бэкенд TS ошибки**: в service.ts есть pre-existing TS errors (строки ~9800-9900) — игнорировать, не связаны с новым кодом

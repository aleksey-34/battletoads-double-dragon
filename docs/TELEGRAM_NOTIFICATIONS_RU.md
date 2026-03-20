# Telegram уведомления: админ и клиенты

Дата: 2026-03-20

## Что уже реализовано

1. Админ-репортер запускается внутри runtime процесса.
2. Периодический отчет (по умолчанию 12h) включает:
   - Accounts: сделки, equity, delta equity, margin load, drawdown.
   - Drift alerts: конкретные причины из drift_alerts.
   - Low-lot signals: конкретные причины из strategies.last_error (order size too small) + action hints.
3. Алерты по новым логинам клиентов отправляются периодически.
4. Есть one-shot тест-команда для немедленной отправки тестового отчета.

## Env переменные (backend/runtime)

Обязательные:
- TELEGRAM_ADMIN_BOT_TOKEN
- TELEGRAM_ADMIN_CHAT_ID

Опциональные:
- TELEGRAM_ADMIN_REPORT_HOURS (по умолчанию 12)
- TELEGRAM_ADMIN_POLL_MINUTES (по умолчанию 10)

## Быстрый запуск на VPS

1. Обновить код и пересобрать backend:
- cd /opt/battletoads-double-dragon/backend
- npm ci --silent
- npm run build

2. Добавить env в systemd unit runtime:
- sudo systemctl edit btdd-runtime

Пример override:
[Service]
Environment=TELEGRAM_ADMIN_BOT_TOKEN=123456:ABCDEF
Environment=TELEGRAM_ADMIN_CHAT_ID=123456789
Environment=TELEGRAM_ADMIN_REPORT_HOURS=12
Environment=TELEGRAM_ADMIN_POLL_MINUTES=10

3. Перезапустить runtime:
- sudo systemctl daemon-reload
- sudo systemctl restart btdd-runtime
- sudo systemctl status btdd-runtime --no-pager

4. Отправить тестовый отчет сразу:
- cd /opt/battletoads-double-dragon/backend
- npm run telegram:test-admin

## Рекомендации по низкой нагрузке VPS

1. Не запускать отдельный сервис под Telegram, использовать встроенный reporter в runtime.
2. Poll interval держать >= 5 минут (рекомендуется 10-15 минут).
3. В отчете ограничивать количество строк по блокам (уже ограничено).
4. Не включать heavy backfill/агрессивные частые выборки только ради Telegram.

## Что добавить для клиентского Telegram (следующий этап)

1. Подписки клиентов:
- Таблица telegram_client_subscriptions:
  - tenant_id, chat_id, is_enabled, report_hours, include_balance, include_positions, include_signals.

2. Привязка Telegram к пользователю:
- Без хранения паролей в Telegram.
- Через magic link токен:
  - Бот выдает одноразовую ссылку на текущий login endpoint.
  - Пользователь подтверждает привязку в вебе.

3. Клиентские отчеты:
- Периодический краткий отчет по tenant/account.
- Триггеры: high margin load, no trades N часов, order size too small.

4. Ограничение ресурсов:
- Один polling loop на все tenant subscriptions.
- Батчевые SQL запросы вместо per-tenant polling.
- Дефолтный период клиентских отчетов не чаще 6h.

## Что добавить для админки по min-lot

1. Отдельный endpoint рекомендаций по low-lot:
- Проблемные клиенты/стратегии.
- Эвристика min deposit и целевой lot.
- Кандидаты замены пары из liquidity_scan_suggestions/sweep.

2. Действия из UI:
- Применить только одному клиенту.
- Применить всем клиентам этого TS (bulk).
- Запустить ретест и safe-apply.

3. Аудит:
- Логировать кто/когда применил рекомендацию и итог (успех/ошибка).

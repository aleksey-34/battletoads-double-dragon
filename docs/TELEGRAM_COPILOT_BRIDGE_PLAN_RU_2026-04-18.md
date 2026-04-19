# TELEGRAM ↔ VS CODE COPILOT BRIDGE PLAN · 2026-04-18

## Короткий ответ

Да, устроить общение через наш Telegram-бот с тем, что ты делаешь в VS Code, можно. Но не как прямой канал в сам GitHub Copilot.

Правильная архитектура такая:

- Telegram = внешний чат-интерфейс
- наш backend/bot = шлюз, авторизация, аудит, команды
- локальный VS Code агент = исполнитель запросов
- Copilot в VS Code = LLM внутри локального рабочего контура

То есть Telegram не общается с Copilot напрямую. Telegram общается с нашим bridge-сервисом, а bridge уже дергает локальный агент/процессы в твоем VS Code окружении.

## Почему нельзя делать "напрямую в Copilot"

- GitHub Copilot Chat в VS Code не дает стабильный публичный серверный API вида "пошли сообщение в локальную сессию и верни ответ".
- Даже если пытаться автоматизировать UI VS Code, это будет хрупко, небезопасно и плохо поддерживается.
- Прямой доступ Telegram к локальному VS Code без промежуточного слоя опасен: утечка секретов, произвольные shell-команды, неаудируемые правки.

## Что у нас уже есть в репо

В проекте уже существует Telegram-контур для админских уведомлений:

- [backend/src/notifications/adminTelegramReporter.ts](backend/src/notifications/adminTelegramReporter.ts)
- [backend/src/runtime-main.ts](backend/src/runtime-main.ts#L29)
- [backend/src/api/saasRoutes.ts](backend/src/api/saasRoutes.ts#L180)
- [backend/src/api/saasRoutes.ts](backend/src/api/saasRoutes.ts#L501)

Это хороший фундамент. Значит не нужно придумывать Telegram с нуля. Нужно добавить второй контур: не уведомления, а команды/диалог.

## Практичная архитектура v1

### Контур 1. Telegram bot gateway

Новый сервис или модуль принимает апдейты от Telegram webhook и умеет:

- аутентифицировать только твой chat id или whitelist админов
- создавать `conversation session`
- складывать запросы в очередь
- логировать все входы/выходы
- резать опасные команды по policy

### Контур 2. Local agent bridge

На твоем рабочем компьютере или на выделенной dev-машине крутится небольшой агент-процесс:

- периодически читает очередь задач из backend
- запускает разрешенные локальные действия
- может дергать локальные скрипты, git, тесты, деплой-команды
- может отправлять запрос в LLM-слой
- возвращает результат обратно в backend, а backend пересылает его в Telegram

### Контур 3. LLM execution layer

Есть 2 реалистичных варианта:

1. Использовать не Copilot напрямую, а отдельную LLM API-модель в нашем bridge-сервисе.
2. Использовать локальный VS Code workflow как операторский режим: Telegram ставит задачу, а локальный bridge открывает ее в твоем dev-контуре и возвращает статус/result.

Для надежной продовой схемы я бы закладывал вариант 1 как базовый, а Copilot оставлял как основной инструмент внутри VS Code, но не как backend API.

## Рекомендуемая модель работы

Лучше сделать 3 класса Telegram-команд.

### Класс A. Safe read-only

Команды без права менять код или прод:

- `/status`
- `/runtime`
- `/storefront`
- `/draft_ts`
- `/logs api 200`
- `/summary ali`

Эти команды можно выполнять автоматически и сразу отвечать в Telegram.

### Класс B. Assisted engineering

Команды для инженерной работы, но без auto-apply:

- `/ask почему draft ts показывает 2 вместо 6`
- `/analyze service.ts summary path`
- `/plan deploy storefront cleanup`
- `/review last changes`

Тут bridge формирует задачу, прогоняет анализ, но код не меняет без подтверждения.

### Класс C. Mutating actions

Команды, которые меняют код, БД или прод:

- `/apply patch ...`
- `/deploy backend`
- `/restart api`
- `/set storefront curated ...`

Их нужно пускать только через двухфазное подтверждение:

- фаза 1: бот показывает diff/plan/risk
- фаза 2: ты отвечаешь `CONFIRM <jobId>`

Без этого делать нельзя.

## Минимальный MVP за разумное время

Я бы делал так:

### Этап 1. Telegram command gateway

- webhook endpoint `/api/telegram/copilot/webhook`
- whitelist по `chat_id`
- таблица `telegram_agent_jobs`
- команды: `/status`, `/storefront`, `/draft_ts`, `/runtime`, `/ask`

### Этап 2. Local bridge worker

- отдельный python или node worker на твоем компьютере
- long-poll к backend
- исполнение только safe-команд
- возврат текста и файлов-артефактов

### Этап 3. Controlled mutations

- `proposed_patch`
- `proposed_command`
- `requires_confirmation = 1`
- подтверждение только из твоего Telegram chat id

### Этап 4. VS Code quality loop

- если задача требует реальной инженерной работы, worker создает локальную задачу
- открывает нужные файлы/скрипты
- либо запускает заранее разрешенный pipeline
- результат возвращается в Telegram как summary + ссылки на артефакты

## Что я бы НЕ делал

- Не привязывал бы Telegram напрямую к UI VS Code.
- Не парсил бы окно Copilot/VS Code через automation scripts.
- Не давал бы Telegram-командам raw shell без allowlist.
- Не давал бы Telegram-командам прямой доступ к продовым секретам в ответах.

## Идеальная версия для BTDD

Для нашего проекта оптимальна двухконтурная схема:

- BTDD backend хранит job queue, audit log и permissions.
- Telegram bot принимает твои команды.
- Local bridge worker на твоей dev-машине исполняет инженерные задачи.
- Продовые операции идут только через policy + confirm.
- Для простых запросов backend отвечает сам, без VS Code.

Так ты получаешь из Telegram:

- быстрый статус платформы
- ручной запуск проверок
- запросы на анализ
- подтверждаемые deploy/update actions

Но без иллюзии, что Telegram "напрямую разговаривает с Copilot API".

## Что стоит делать следующим шагом

Если реализовывать это всерьез, следующий правильный шаг такой:

1. Сначала описать command contract и security policy.
2. Потом добавить backend job queue + Telegram webhook.
3. Потом поднять local bridge worker в твоем dev-контуре.
4. Только после этого добавлять LLM-assisted команды.

## Предлагаемый command contract v1

- `/status`
- `/storefront`
- `/draft_ts`
- `/runtime`
- `/service api`
- `/ask <question>`
- `/plan <task>`
- `/confirm <jobId>`
- `/cancel <jobId>`

## Вывод

Сделать это можно и для BTDD это даже полезно. Но делать надо как свой Telegram Agent Gateway поверх backend и локального worker, а не как попытку влезть напрямую в закрытый внутренний канал Copilot внутри VS Code.
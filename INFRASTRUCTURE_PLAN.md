# BTDD Platform — Infrastructure Plan (3-Circuit Architecture)

> **Целевой контекст:** Альфа-тест, один VPS, готовность к горизонтальному масштабированию.
> **Дата:** 2026-03-18  
> **Статус:** Active Design → Implementation

---

## 1. Концептуальная картина трёх контуров

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          BTDD Platform (VPS)                             │
│                                                                          │
│  ┌─────────────────────┐   ┌─────────────────── ───┐   ┌──────────────┐  │
│  │   RUNTIME CIRCUIT   │   │  RESEARCH CIRCUIT     │   │  PROD/CLIENT │  │
│  │   (торговый контур) │   │  (исследоват. контур) │   │   CIRCUIT    │  │
│  │                     │   │                       │   │  (клиентский)│  │
│  │  100% надёжность    │   │  Backtesting          │   │              │  │
│  │  Isolated DB        │   │  Sweep/Optimize       │   │  Лёгкие      │  │
│  │  Zero downtime      │   │  Preview models       │   │  предрасч.   │  │
│  │  No heavy compute   │   │  Candidate profiles   │   │  модели      │  │
│  │                     │   │  Exchange access OK   │   │  Read-only   │  │
│  │  DB: runtime.db     │   │  DB: research.db      │   │  DB: main.db │  │
│  │                     │   │                       │   │  (saas-)     │  │
│  └────────┬────────────┘   └──────────┬────────────┘   └──────┬───────┘  │
│           │                           │                       │          │
│           └──────────────┬────────────┘                       │          │
│                          │                                    │          │
│              ┌───────────▼────────────────────────────────────▼────────┐ │
│              │          API GATEWAY (backend/src/server.ts)            │ │
│              │                                                         │ │
│              │  /api/admin/*     → runtime DB (R/W) + research (R/W)   │ │
│              │  /api/research/*  → research DB (admin-only)            │ │
│              │  /api/client/*    → saas + catalog (client auth)        │ │
│              │  /api/saas/*      → saas management (admin)             │ │
│              └──────────────────────────────┬──────────────────────────│ │
│                                             │                          │ │
│              ┌──────────────────────────────▼───────────────────────┐  │ │
│              │                  Frontend (React)                    │  │ │
│              │  /dashboard      Runtime status + strategy control   │  │ │
│              │  /backtest       Research: sweep results, re-run     │  │ │
│              │  /saas           Client mgmt + catalog + algofund    │  │ │
│              │  /research       NEW: profiles, sweep, publish gate  │  │ │
│              └──────────────────────────────────────────────────────┘  │ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Детальное описание контуров

### 2.1 Runtime Circuit — «торговый контур»

**Назначение:** Исполнение live-стратегий. Никаких тяжёлых вычислений, никакого бектеста, никаких sweep.

**Изоляция:**
- Собственная база данных `runtime.db` (SQLite, отдельный файл)
- Отдельный systemd-сервис `btdd-runtime.service` (сейчас: `battletoads-backend.service`)
- Перезапуск API-сервера не затрагивает торговый цикл
- Стратегии в runtime — только те, что **явно опубликованы** из Research

**Таблицы runtime.db:**

| Таблица | Описание |
|---------|----------|
| `rt_api_keys` | Биржевые ключи (только runtime) |
| `rt_strategies` | Активные live-стратегии (`is_runtime=1`, `is_active=1`) |
| `rt_risk_settings` | Риск-параметры per-key |
| `rt_monitoring_snapshots` | Последние снимки PnL/позиций |
| `rt_signals` | Журнал последних сигналов (rolling 7d) |
| `rt_positions_state` | Кешированное состояние позиций |

**Процесс:**
```
btdd-runtime.service
  ├── Торговый цикл (executeStrategy loop)
  ├── runAutoStrategiesCycle() — каждые N секунд
  ├── Monitoring snapshots
  └── Risk enforcement
```

**Правила:**
- НЕ запускает бектест — только исполнение
- НЕ читает research.db напрямую
- НЕ имеет прямого клиентского доступа
- Остановка trading engine = отдельное действие, не влияет на API

---

### 2.2 Research Circuit — «исследовательский контур»

**Назначение:** Real backtesting со связью с биржей по необходимости, candidate-профили, клиентские пресеты, sweep/backtest результаты.

**Таблицы research.db:**

| Таблица | Описание |
|---------|----------|
| `strategy_profiles` | Кандидат-профили: config JSON, статус, origin |
| `profile_metrics_cache` | Кешированные KPI (пересчитывается preview worker'ом) |
| `sweep_runs` | Записи исторических sweep-запусков |
| `sweep_artifacts` | JSON-артефакты: shortlist, equity CSV, summary |
| `preview_jobs` | Очередь preview-задач от слайдеров клиента/админа |
| `preview_results` | Результаты preview (KPI, equity curve) + TTL cache |
| `backtest_runs` | Отдельные бектест-задачи (не sweep) |
| `backtest_artifacts` | Артефакты бектест-запусков |
| `client_presets` | Предрасчитанные пресеты (risk×freq матрица) per offer |
| `publish_log` | Журнал публикаций из research → runtime |

**Процесс:**
```
btdd-research.service (NEW — на начальном этапе: worker_thread / child_process)
  ├── Preview Worker: poll preview_jobs → computeKPI → store preview_results
  ├── Sweep Runner: выполняет historical sweep по запросу
  ├── Backtest Worker: выполняет отдельные backtest по запросу
  └── Preset Builder: rebuild client_presets при новом sweep
```

**Publish Gate (ключевой элемент):**
```
Admin нажимает [Publish to Runtime]
  → POST /api/research/profiles/:id/publish
  → Создаёт/обновляет запись в rt_strategies (runtime.db)
  → is_runtime=1, origin='published_from_profile'
  → Логирует в publish_log
  → Runtime engine подхватывает на следующем цикле
```

---

### 2.3 Production/Client Circuit — «продакшн контур»

**Назначение:** Лёгкое отображение клиентам на основе предрасчитанных бектестов, проведённых админом. Никакой live-вычислительной нагрузки.

**Принцип:**
- Клиент двигает слайдер → маппинг в `client_presets` (предрасчитанный JSON)
- Preview — НЕ вычисляется в момент запроса, берётся из кеша
- Algofund equity curve — загружается из `sweep_artifacts` или `profile_metrics_cache`
- Клиент НЕ создаёт runtime-записи: только `start/stop requests`

**Таблицы (уже существует в main.db — SaaS):**

| Таблица | Статус |
|---------|--------|
| `tenants` | ✅ Реализована |
| `client_users` | ✅ Реализована |
| `client_sessions` | ✅ Реализована |
| `plans` | ✅ Реализована |
| `subscriptions` | ✅ Реализована |
| `strategy_client_profiles` | ✅ Реализована |
| `algofund_profiles` | ✅ Реализована |
| `algofund_start_stop_requests` | ✅ Реализована |
| `saas_audit_log` | ✅ Реализована |
| `client_presets` | ⚠️ Реализована в `research.db`, но пока не подключена в `/api/client/catalog` |

**Данные в клиентском контуре:**
- Все KPI, эквити-кривые, описания — из `sweep_artifacts` / `client_presets`
- Обновляются: при публикации нового sweep admin'ом
- НЕ пересчитываются в реальном времени на клиентский запрос

---

## 3. Схема баз данных

### 3.1 runtime.db (целевое состояние)

```sql
-- Хранит только live-стратегии, перенесённые из research
CREATE TABLE rt_strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key_id INTEGER NOT NULL,
  origin TEXT DEFAULT 'manual',           -- 'manual' | 'published_from_profile'
  source_profile_id INTEGER,              -- research.strategy_profiles.id
  published_at TEXT,
  is_active BOOLEAN DEFAULT 1,
  is_runtime BOOLEAN DEFAULT 1,          -- всегда 1 в этой таблице
  -- все существующие поля стратегии...
  strategy_type TEXT,
  market_mode TEXT,
  base_symbol TEXT,
  quote_symbol TEXT,
  interval TEXT,
  -- ... остальные параметры
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rt_monitoring_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rt_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  signal_type TEXT NOT NULL,
  payload_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### 3.2 research.db (новое)

```sql
CREATE TABLE strategy_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  origin TEXT DEFAULT 'sweep_candidate',  -- 'sweep_candidate' | 'manual' | 'imported'
  strategy_type TEXT NOT NULL,
  market_mode TEXT DEFAULT 'mono',
  base_symbol TEXT,
  quote_symbol TEXT,
  interval TEXT,
  config_json TEXT NOT NULL DEFAULT '{}', -- полный конфиг параметров
  metrics_summary_json TEXT DEFAULT '{}', -- последний KPI snapshot
  sweep_run_id INTEGER,                   -- из какого sweep взят
  published_strategy_id INTEGER,          -- rt_strategies.id если опубликован
  status TEXT DEFAULT 'candidate',        -- 'candidate'|'published'|'archived'
  tags_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sweep_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                     -- 'btdd_d1_2026-03-14'
  description TEXT DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}', -- параметры sweep
  status TEXT DEFAULT 'queued',           -- 'queued'|'running'|'done'|'failed'
  progress_json TEXT DEFAULT '{}',        -- checkpoint/resume state
  result_summary_json TEXT DEFAULT '{}',  -- итог: total/evaluated/robust
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sweep_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sweep_run_id INTEGER NOT NULL,
  artifact_type TEXT NOT NULL,            -- 'shortlist'|'equity_csv'|'client_catalog'|'full_results'
  file_path TEXT,                         -- путь если файл на диске
  content_json TEXT,                      -- или встроенный JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sweep_run_id) REFERENCES sweep_runs(id)
);

CREATE TABLE profile_metrics_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL UNIQUE,
  config_hash TEXT NOT NULL,             -- hash(config_json) — для инвалидации
  metrics_json TEXT NOT NULL,            -- {ret, pf, dd, wr, sharpe, equity_curve[]}
  computed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES strategy_profiles(id)
);

CREATE TABLE preview_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER,                    -- опционально: привязка к профилю
  config_json TEXT NOT NULL,             -- параметры для preview
  config_hash TEXT NOT NULL,             -- для дедупликации
  status TEXT DEFAULT 'queued',          -- 'queued'|'running'|'done'|'failed'
  priority INTEGER DEFAULT 0,            -- 10=high (клиент), 0=low (фон)
  result_json TEXT,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE client_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,                -- из client_catalog
  risk_level TEXT NOT NULL,              -- 'low'|'medium'|'high'
  freq_level TEXT NOT NULL,              -- 'low'|'medium'|'high'
  config_json TEXT NOT NULL,             -- итоговый конфиг стратегии
  metrics_json TEXT NOT NULL,            -- KPI для этого пресета
  equity_curve_json TEXT DEFAULT '[]',
  sweep_run_id INTEGER,                  -- источник данных
  is_current BOOLEAN DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (offer_id, risk_level, freq_level)
);

CREATE TABLE publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  runtime_strategy_id INTEGER,           -- rt_strategies.id
  published_by TEXT DEFAULT 'admin',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES strategy_profiles(id)
);

CREATE TABLE backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  profile_id INTEGER,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT DEFAULT 'queued',
  result_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

---

## 4. API Маршруты

### 4.1 Runtime API (admin — читает runtime.db)
```
GET  /api/admin/runtime/strategies         — список live-стратегий
GET  /api/admin/runtime/monitoring         — моментальный снимок производительности
POST /api/admin/runtime/strategies/:id/pause
POST /api/admin/runtime/strategies/:id/resume
POST /api/admin/runtime/strategies/:id/close-positions
```

### 4.2 Research API (admin-only)
```
GET  /api/research/profiles                — список кандидат-профилей
GET  /api/research/profiles/:id            — детальный профиль + метрики
POST /api/research/profiles                — создать профиль вручную
PATCH /api/research/profiles/:id           — обновить конфиг
DELETE /api/research/profiles/:id          — архивировать

POST /api/research/profiles/:id/preview    — запустить preview worker для профиля
GET  /api/research/profiles/:id/preview    — получить статус/результат preview

POST /api/research/profiles/:id/publish    — опубликовать → runtime
DELETE /api/research/profiles/:id/publish  — отозвать из runtime

GET  /api/research/sweeps                  — список sweep-запусков
GET  /api/research/sweeps/:id              — детали sweep + артефакты
POST /api/research/sweeps                  — запустить новый sweep
DELETE /api/research/sweeps/:id            — отменить sweep

GET  /api/research/sweeps/:id/catalog      — client_catalog артефакт
POST /api/research/sweeps/:id/build-presets — перестроить client_presets

POST /api/research/preview                 — ad-hoc preview (без профиля)
GET  /api/research/preview/:jobId          — статус preview-задачи
```

### 4.3 Client API (client auth — только чтение + запросы)
```
GET  /api/client/catalog                   — список офферов из client_presets
GET  /api/client/catalog/:offerId/preset   — KPI + equity для risk/freq комбо
GET  /api/client/workspace                 — профиль клиента + статус
PATCH /api/client/profile                  — обновить risk/freq слайдеры
POST /api/client/algofund/start-request    — запрос на старт
POST /api/client/algofund/stop-request     — запрос на стоп
GET  /api/client/algofund/state            — текущий статус algofund
```

### 4.4 SaaS Admin API (уже есть, дополнения)
```
GET  /api/saas/summary                     — ✅ Реализован
POST /api/saas/setup                       — ✅ Реализован
POST /api/saas/tenants/:id/materialize     — ✅ Реализован
POST /api/saas/catalog/build               — ✅ Реализован
GET  /api/saas/catalog                     — ✅ Реализован
POST /api/saas/catalog/presets/rebuild     — ❌ Новый (перестроить из research)
GET  /api/saas/algofund/requests           — ✅ Реализован
PATCH /api/saas/algofund/requests/:id      — ✅ Реализован
```

---

## 5. Директории и файлы

```
backend/src/
├── server.ts                          ← точка входа, монтирует роутеры
├── api/
│   ├── routes.ts                      ← основные маршруты (admin dashboard)
│   ├── researchRoutes.ts              ← NEW: /api/research/*
│   └── clientRoutes.ts                ← NEW: /api/client/* (выделить из routes.ts)
├── bot/
│   ├── strategy.ts                    ← НЕ ТРОГАТЬ (торговый движок)
│   ├── exchange.ts                    ← НЕ ТРОГАТЬ
│   ├── monitoring.ts                  ← НЕ ТРОГАТЬ
│   ├── risk.ts                        ← НЕ ТРОГАТЬ
│   ├── synthetic.ts                   ← НЕ ТРОГАТЬ
│   └── tradingSystems.ts              ← НЕ ТРОГАТЬ
├── backtest/
│   ├── engine.ts                      ← существующий движок бектеста
│   └── compareTvTrades.ts
├── saas/
│   └── service.ts                     ← SaaS логика (расширить)
├── research/                          ← NEW модуль
│   ├── db.ts                          ← research.db подключение
│   ├── profileService.ts              ← CRUD профилей, publish gate
│   ├── sweepService.ts                ← управление sweep-запусками
│   ├── previewService.ts              ← управление очередью preview
│   └── presetBuilder.ts               ← построение client_presets
├── workers/                           ← NEW
│   ├── previewWorker.ts               ← worker_thread или child_process
│   └── researchScheduler.ts           ← планировщик research-задач
├── system/
│   ├── updateManager.ts               ← git update (уже улучшен)
│   └── runtimeGuard.ts                ← NEW: мониторинг изоляции runtime
├── utils/
│   ├── database.ts                    ← main.db (SaaS)
│   ├── auth.ts                        ← аутентификация
│   └── logger.ts
└── config/
    └── settings.ts

frontend/src/
├── pages/
│   ├── Dashboard.tsx                  ← Runtime статус (уже доработан)
│   ├── Backtest.tsx                   ← Расширить: sweep управление
│   ├── Research.tsx                   ← NEW: profiles, publish gate
│   ├── SaaS.tsx                       ← Client mgmt (уже есть)
│   ├── Settings.tsx                   ← уже доработан
│   ├── Login.tsx
│   ├── Logs.tsx
│   └── Positions.tsx
├── components/
│   ├── ChartComponent.tsx
│   ├── StatusIndicator.tsx
│   ├── ResearchProfileCard.tsx        ← NEW
│   ├── SweepStatusPanel.tsx           ← NEW
│   └── PublishGateModal.tsx           ← NEW
└── tests/
    └── e2e/
        ├── navigation-smoke.spec.js   ← уже есть
        └── research-publish.spec.js   ← NEW

scripts/
├── update_vps_from_git.sh             ← уже исправлен (CI=false)
├── run_btdd_historical_system_sweep_http.mjs
├── run_btdd_build_client_catalog_http.mjs
└── run_btdd_promote_sweep_fasttrack_http.mjs
```

---

## 6. Фазы реализации

### ✅ Фаза 0 (DONE) — Stop-gap OOM fix
- Chunked strategy rendering (80 per chunk)
- Lazy panel content + destroyInactivePanel
- Summary API split (lightweight list + lazy detail)
- `STRATEGY_FETCH_LIMIT = 120`

### 🚀 Фаза 1 — Границы runtime (СЕЙЧАС)
**Цель:** Разделить live-стратегии от research-кандидатов в существующей БД

| Задача | Файл | Описание |
|--------|------|----------|
| Добавить `is_runtime` поле | `database.ts` | `ensureColumn` migration |
| Добавить `is_archived` поле | `database.ts` | `ensureColumn` migration |
| Добавить `origin` поле | `database.ts` | `'manual'`/`'sweep_candidate'`/`'published'` |
| Фильтрация в summary API | `routes.ts` | По умолчанию только `is_archived=0` |
| Bulk-archive маршрут | `routes.ts` | `POST /strategies/:key/bulk-archive` + dry-run |
| Dashboard фильтр UI | `Dashboard.tsx` | Переключатель: показать archived |
| Пометить существующие live | migration script | 2 активных = `is_runtime=1` |

**Результат:** Dashboard показывает только рабочие стратегии. 9115 paused → archived → не видны.

---

### 🚀 Фаза 2 — Research DB + модуль (СЛЕДУЮЩАЯ)
**Цель:** Изолировать research-данные в отдельную БД, migrate sweep artifacts

| Задача | Файл | Описание |
|--------|------|----------|
| `research/db.ts` | NEW | Открытие research.db, инициализация схемы |
| Таблицы research.db | `research/db.ts` | strategy_profiles, sweep_runs, sweep_artifacts, preview_jobs, client_presets, publish_log |
| Import существующего sweep | migration script | btdd_d1_historical_sweep JSON → sweep_runs + sweep_artifacts |
| Import client catalog | migration script | btdd_d1_client_catalog JSON → strategy_profiles (кандидаты) |
| `research/profileService.ts` | NEW | CRUD профилей + архивирование |
| `research/sweepService.ts` | NEW | Управление sweep-запусками |
| `researchRoutes.ts` | NEW | /api/research/* маршруты |
| Монтирование роутера | `server.ts` | `app.use('/api/research', researchRouter)` |

---

### 🚀 Фаза 3 — Preview Worker
**Цель:** Вычисление KPI на основе конфига в background, без блокировки основного сервера

| Задача | Файл | Описание |
|--------|------|----------|
| `research/previewService.ts` | NEW | Создание jobs, получение результатов |
| `workers/previewWorker.ts` | NEW | `worker_threads` основанный worker |
| Config hash + dedup | `previewService.ts` | SHA256 от config_json → пропуск дублей |
| TTL cache (60s) | `preview_results` | Повторное использование recent results |
| Priority queue | `preview_jobs` | priority=10 для клиентских запросов |
| REST endpoints | `researchRoutes.ts` | POST /preview, GET /preview/:jobId |
| Worker запуск из server.ts | `server.ts` | `startPreviewWorker()` при старте |

---

### 🚀 Фаза 4 — Publish Gate (Runtime ← Research)
**Цель:** Явная публикация профиля из research → runtime, с журналом и rollback

| Задача | Файл | Описание |
|--------|------|----------|
| `publishToRuntime()` | `research/profileService.ts` | Создаёт/обновляет запись в rt_strategies |
| Добавить поля в strategies | `database.ts` | `is_runtime`, `origin`, `source_profile_id`, `published_at` |
| Publish API endpoint | `researchRoutes.ts` | POST /profiles/:id/publish |
| Revoke API endpoint | `researchRoutes.ts` | DELETE /profiles/:id/publish |
| publish_log запись | `profileService.ts` | каждое действие логируется |
| Research page UI | `Research.tsx` | Таблица профилей + [Publish] / [Revoke] кнопки |
| PublishGateModal | `PublishGateModal.tsx` | Подтверждение с предпросмотром конфига |
| Dashboard фильтр | `Dashboard.tsx` | Показывать бейдж `origin` рядом с именем |

---

### 🚀 Фаза 5 — Client Preset Circuit
**Цель:** Клиент видит KPI из предрасчитанных пресетов, не вызывая live-вычисления

| Задача | Файл | Описание |
|--------|------|----------|
| `research/presetBuilder.ts` | NEW | Строит 9 пресетов (3×3 risk×freq) per offer из sweep artifacts |
| Rebuild presets endpoint | `researchRoutes.ts` | POST /sweeps/:id/build-presets |
| Client catalog endpoint | `clientRoutes.ts` | GET /api/client/catalog — из client_presets |
| Preset lookup | `clientRoutes.ts` | GET /api/client/catalog/:offerId/preset?risk=high&freq=low |
| Слайдер mapping | `SaaS.tsx` | risk/freq → preset, мгновенное обновление KPI без API |
| Equity curve display | `SaaS.tsx` | Отрисовка equity из preset JSON |
| Algofund KPI | `SaaS.tsx` | Equity curve из sweep_artifacts (algofund системный профиль) |

---

### 🚀 Фаза 6 — SaaS Auth + RBAC (для alpha)
**Цель:** Разделить admin-only маршруты от client-accessible, tenancy isolation

| Задача | Файл | Описание |
|--------|------|----------|
| RBAC middleware | `utils/auth.ts` | `requireRole('platform_admin')` guard |
| Защита /api/research/* | `researchRoutes.ts` | Только `platform_admin` |
| Защита /api/admin/* | `routes.ts` | Только `platform_admin` |
| Client routes isolation | `clientRoutes.ts` | `authenticateClient` + tenant_id filter |
| Tenancy context | all client routes | Все запросы фильтруются по tenant_id |
| Audit log | `saas/service.ts` | Publish, revoke, materialize → saas_audit_log |

---

### 🚀 Фаза 7 — VPS Process Isolation (пост-альфа)
```
[x] Реализовано:

btdd-runtime.service   ← исключительно торговый цикл (runtime-main.ts)
btdd-research.service  ← sweep + preview workers (research-main.ts)
btdd-api.service       ← Express API + frontend serve (server.ts, BTDD_DISABLE_TRADING=1 + BTDD_DISABLE_RESEARCH_WORKERS=1)

Деплой runtime-обновлений без остановки торговли: RESTART_RUNTIME=0
Скрипт установки: scripts/btdd_setup_services.sh
Деплой: scripts/update_vps_from_git.sh с DEPLOY_MODE=multi
Документация: scripts/VPS_UBUNTU20.md
```

---

### 🚀 Фаза 8 — Notifications (Telegram + in-app)
| Задача | Описание |
|--------|----------|
| Telegram bot | Уведомления: стратегия упала, клиент оплатил, бектест готов |
| In-app уведомления | Badge/toast в UI |
| Billing triggers | Срок оплаты, просрочка, блокировка |
| Algofund triggers | Start/stop request accepted/rejected |

---

## 7. Data Flow — полная картина

```
ADMIN: Запускает Historical Sweep
  ↓
Research Circuit (btdd-research / worker)
  btdd_d1_historical_sweep_http.mjs
  → sweep_runs row (status: running)
  → checkpoint/resume → progress_json
  → done: sweep_artifacts (shortlist JSON, equity CSV)
  → done: → strategy_profiles для каждого кандидата
  ↓
ADMIN: Просматривает профили в /research
  → Видит список strategy_profiles с metrics_summary
  → Нажимает [Preview] на профиле → preview_job → worker → result
  → Нажимает [Publish to Runtime] → publishToRuntime()
  ↓
Runtime Circuit
  → rt_strategies: новая запись с is_runtime=1
  → Следующий торговый цикл подхватывает новую стратегию
  → Мониторинг: rt_monitoring_snapshots
  ↓
ADMIN: Строит Client Catalog
  → POST /api/research/sweeps/:id/build-presets
  → presetBuilder: 3×3 пресеты для каждого offer
  → client_presets: 9 записей per offer
  → SaaS catalog обновлён
  ↓
CLIENT: Открывает стратегический ЛК
  → GET /api/client/catalog
  → Видит офферы с KPI (из client_presets, мгновенно)
  → Двигает слайдер risk/freq → frontend маппинг → другой preset
  → KPI обновляется без API-вызова (preset JSON получен заранее)
  → Выбирает оффер → PATCH /api/client/profile
  → ADMIN materialize → создаёт rt_strategy → торговля начинается
```

---

## 8. Инварианты безопасности

### Runtime изоляция
- `btdd-runtime.service` имеет `PrivateTmp=yes`, `NoNewPrivileges=true`
- Runtime DB — отдельный файл (`runtime.db`), read-write только runtime процессу
- API-сервер читает runtime.db только через доверенный internal socket / localhost
- **Правило:** Перезапуск API не перезапускает торговый цикл

### Research изоляция
- Preview worker — отдельный process/thread с таймаутом 120s per job
- Sweep — отдельный child_process с возможностью `kill`
- Exchange API в research — read-only (только цены/история), никаких ордеров
- Квота: max 3 одновременных preview jobs, max 1 sweep

### Client isolation
- Каждый API-запрос клиента фильтруется по `tenant_id` из JWT
- Клиентские маршруты не имеют доступа к `strategies` таблице напрямую
- Rate limiting: 60 req/min per tenant

### Publish Gate
- Нет автоматической публикации из research → runtime
- Требуется явное действие `platform_admin`
- Каждая публикация логируется с timestamp, admin_id, конфигом
- Откат: DELETE /publish — стратегия получает `is_runtime=0`, не удаляется

---

## 9. Чеклист для Alpha

### Готово ✅
- [x] VPS deploy pipeline (CI=false fix)
- [x] Strategy OOM fix (chunked render + lazy load + destroyInactivePanel)
- [x] Summary/Detail API split
- [x] SaaS schema: tenants, plans, subscriptions, profiles, algofund
- [x] SaaS service: materialize, catalog build, start/stop requests
- [x] Client auth: JWT sessions, registrering, tenant provisioning
- [x] Admin SaaS UI: /saas page with 3 zones
- [x] E2E smoke: all 7 tabs passing

### Фаза 1 — Boundaries (блокер) ⚠️
- [x] `is_runtime` + `is_archived` + `origin` поля в strategies
- [x] Dashboard default filter: is_archived=0
- [x] Bulk-archive API + UI button
- [ ] Пометить 2 активных стратегии as is_runtime=1 (операционный шаг на VPS)

### Фаза 2 — Research DB ⚠️
- [x] `research/db.ts` + схема
- [x] Import существующего sweep JSON → research DB (manual endpoint + UI: `/api/research/sweeps/import-from-file`)
- [x] `researchRoutes.ts` базовые маршруты
- [x] Research страница в frontend

### Фаза 3 — Preview Worker ⚠️
- [x] `workers/previewWorker.ts`
- [x] Очередь и статус preview jobs
- [ ] Client KPI из presets (не live compute) — частично, ещё есть fallback на live backtest в SaaS service

### Фаза 4 — Publish Gate ⚠️
- [x] `publishToRuntime()` функция
- [x] Publish/Revoke API endpoints
- [ ] `PublishGateModal` UI компонент (пока базовый modal в Research.tsx)
- [x] `publish_log` запись каждого действия

### Фаза 5 — Client Presets ⚠️
- [x] `presetBuilder.ts` (3×3 матрица)
- [ ] Client catalog из presets (мгновенно, без compute)
- [ ] Equity curve из artifact JSON

### Фаза 6 — Auth/RBAC ❌
- [x] `requireRole('platform_admin')` guard (инкрементально: `requirePlatformAdmin` с fallback по dashboard password)
- [x] Research routes: admin-only
- [x] Tenant isolation на всех client routes
- [x] Audit log для критических действий

---

## 10. Порядок начала реализации

**Начинаем прямо сейчас — в этом порядке:**

1. **`database.ts`** — добавить `is_runtime`, `is_archived`, `origin` (ensureColumn)
2. **`routes.ts`** — фильтр archived в summary API + bulk-archive endpoint
3. **`Dashboard.tsx`** — UI переключатель + визуальные бейджи origin
4. **`research/db.ts`** — create research.db + schema DDL
5. **`research/profileService.ts`** — CRUD профилей
6. **`api/researchRoutes.ts`** — /api/research/* маршруты
7. **`server.ts`** — монтировать researchRouter
8. **`Research.tsx`** — новая страница: список профилей, preview, publish gate
9. **`workers/previewWorker.ts`** — фоновый worker для KPI
10. **`research/presetBuilder.ts`** — построение 3×3 client_presets
11. Deploy → VPS alpha test

---

## 11. Доп. спецификация по Sweep/Backtest

- Детальное описание текущей реализации multiplexer-sweep, ограничений и следующих решений: `SWEEP_BACKTEST_SPEC.md`.
- В этом документе также зафиксированы:
  - статус крутилки `tradeFrequency` (где реальное влияние, где эвристика),
  - вариант ежедневного фонового sweep в `Research Circuit`,
  - оценка сложности и роста объёма БД.

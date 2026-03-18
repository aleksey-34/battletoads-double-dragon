# BTDD Platform — VPS Ubuntu 20.04/22.04: Руководство по эксплуатации

## Архитектура процессов (Phase 7 — три сервиса)

```
btdd-api.service       — HTTP API (Express) + serve frontend
                         BTDD_DISABLE_TRADING=1
                         BTDD_DISABLE_RESEARCH_WORKERS=1

btdd-runtime.service   — Торговый контур
                         runAutoStrategiesCycle
                         runMonitoringCycle
                         runReconciliationCycle
                         runLiquidityScanCycle

btdd-research.service  — Research circuit workers
                         startPreviewWorker
                         startResearchSchedulerWorker
```

---

## Первоначальная установка трёх сервисов

### 1. Задеплоить код на VPS

```bash
# На сервере (первый деплой):
git clone https://github.com/aleksey-34/battletoads-double-dragon /opt/battletoads-double-dragon
cp /opt/battletoads-double-dragon/.env.example /opt/battletoads-double-dragon/.env
nano /opt/battletoads-double-dragon/.env   # заполнить переменные
```

### 2. Создать директорию для данных

```bash
mkdir -p /opt/battletoads-double-dragon/data
chown ubuntu:ubuntu /opt/battletoads-double-dragon/data
```

### 3. Запустить скрипт установки сервисов

```bash
cd /opt/battletoads-double-dragon
sudo bash scripts/btdd_setup_services.sh
```

Скрипт:
- Собирает backend (`npm ci && npm run build`)
- Копирует unit-файлы в `/etc/systemd/system/`
- Останавливает старый `battletoads-backend.service` (если есть)
- Включает и запускает три новых сервиса

---

## Обновление кода (деплой нового релиза)

### Автоматически через UI (рекомендуется)

В панели `/settings` → кнопка "Update from Git" запустит скрипт через `systemd-run`.

Переключить в multi-service режим: добавить в `.env`:
```env
DEPLOY_MODE=multi
RESTART_RUNTIME=1
```

При `RESTART_RUNTIME=0` — btdd-runtime **не перезапускается** (торговля не прерывается).

### Вручную

```bash
# Деплой с перезапуском всех трёх сервисов:
sudo DEPLOY_MODE=multi bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh

# Деплой без остановки торговли:
sudo DEPLOY_MODE=multi RESTART_RUNTIME=0 bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh
```

---

## Мониторинг

```bash
# Статус всех трёх сервисов
systemctl status btdd-api btdd-runtime btdd-research

# Логи в реальном времени
journalctl -u btdd-api -f
journalctl -u btdd-runtime -f
journalctl -u btdd-research -f

# Логи всех трёх вместе
journalctl -u btdd-api -u btdd-runtime -u btdd-research -f --no-pager
```

---

## Управление сервисами

```bash
# Перезапуск API без остановки торговли
sudo systemctl restart btdd-api btdd-research

# Перезапуск только торговли
sudo systemctl restart btdd-runtime

# Остановить торговлю (аварийно)
sudo systemctl stop btdd-runtime

# Полная остановка
sudo systemctl stop btdd-api btdd-runtime btdd-research
```

---

## Переменные окружения (.env)

| Переменная | Описание | Default |
|-----------|----------|---------|
| `PORT` | HTTP порт API | `3001` |
| `DB_PATH` | Путь к main.db | автоопределение |
| `RESEARCH_DB_PATH` | Путь к research.db | `./data/research.db` |
| `BTDD_DISABLE_TRADING` | `1` = выключить торговые циклы в этом процессе | `0` |
| `BTDD_DISABLE_RESEARCH_WORKERS` | `1` = выключить research workers в этом процессе | `0` |
| `DEPLOY_MODE` | `single` / `multi` | `single` |
| `RESTART_RUNTIME` | `0` = не рестартовать btdd-runtime при деплое | `1` |
| `STRATEGY_AUTORUN_SEC` | Интервал торгового цикла (сек) | `30` |
| `MONITORING_SNAPSHOT_SEC` | Интервал мониторинга (сек) | `300` |
| `RECONCILIATION_INTERVAL_MIN` | Интервал реконсиляции (мин) | `360` |
| `LIQUIDITY_SCAN_INTERVAL_MIN` | Интервал ликвидности-сканера (мин) | `180` |
| `ADMIN_PLATFORM_TOKEN` | Bearer токен для platform_admin API | (пусто = password auth) |
| `ENABLE_GIT_UPDATE` | `1` = кнопка update в UI активна | `0` |

---

## Rollback / обратная совместимость

Если нужно вернуться к одному сервису:

```bash
sudo systemctl stop btdd-api btdd-runtime btdd-research
sudo systemctl disable btdd-api btdd-runtime btdd-research
sudo systemctl enable battletoads-backend
sudo systemctl start battletoads-backend
```

---

## Структура файлов systemd

```
scripts/systemd/
  btdd-api.service       # HTTP API (без толинга и workers)
  btdd-runtime.service   # Торговый контур
  btdd-research.service  # Research workers
scripts/btdd_setup_services.sh  # Установщик (один раз)
scripts/update_vps_from_git.sh  # Деплой обновлений (многократно)
```

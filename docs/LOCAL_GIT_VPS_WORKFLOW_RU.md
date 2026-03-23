# Рабочий процесс: Локальная разработка → Git → VPS

## Общий принцип

Все изменения идут через git. Ручные SCP-копии файлов — только крайний случай.

```
Локально: разработка + git commit + git push
VPS:      git pull (reset --hard) + npm install + build + systemctl restart
```

---

## Команда обновления VPS (стандартная)

```bash
ssh root@176.57.184.98 'cd /opt/battletoads-double-dragon; \
  BRANCH=feature/research-sweep-spec-and-scheduler \
  DEPLOY_MODE=multi \
  RESTART_RUNTIME=0 \
  ALLOW_DIRTY_TRACKED=1 \
  bash ./update_vps_from_git.sh'
```

Переменные окружения:
- `BRANCH` — какую ветку тянуть (обычно `main` в продакшне)
- `DEPLOY_MODE=multi` — три отдельных сервиса (`btdd-api`, `btdd-runtime`, `btdd-research`)
- `RESTART_RUNTIME=0` — не перезапускать торговый контур при деплое API/frontend
- `ALLOW_DIRTY_TRACKED=1` — продолжать даже при локальных tracked-изменениях на VPS

Скрипт делает:
1. `git fetch --prune origin`
2. `git reset --hard origin/<BRANCH>`
3. backend: `npm ci` (или `npm install` если ci падает) + `tsc`
4. frontend: `npm ci` (или `npm install`) + `CI=false npm run build`
5. Sync frontend build в nginx root: `rsync -a --delete build/ /var/www/battletoads-double-dragon/`
6. `systemctl reload nginx`
7. Restart нужных сервисов

---

## Локальный workflow (шаг за шагом)

### 1. Разрабатываем, проверяем

```powershell
# Проверить ошибки TypeScript — обязательно перед коммитом
# (иначе frontend build на VPS не пройдёт)
```

### 2. Коммитим только нужные файлы

```powershell
git add backend/src/api/routes.ts frontend/src/pages/SaaS.tsx docs/...
git commit -m "feat: ..."
```

Не добавляем в коммит:
- `scripts/tmp_*` — временные диагностические скрипты
- `.db-shm`, `.db-wal` — runtime SQLite WAL-файлы
- `frontend/build/` — артефакты сборки (они собираются на VPS)

### 3. Пушим на ветку

```powershell
git push origin feature/research-sweep-spec-and-scheduler
```

### 4. Деплоим на VPS через скрипт выше

---

## Известные ловушки

### Frontend не обновляется на VPS

**Симптом:** Браузер показывает старый UI, даже если source обновлён.

**Диагностика:**
```bash
# Проверить mtime build/index.html vs source/SaaS.tsx
stat -c '%y %n' /opt/battletoads-double-dragon/frontend/build/index.html \
                /opt/battletoads-double-dragon/frontend/src/pages/SaaS.tsx

# Проверить что nginx отдаёт
curl -s http://127.0.0.1/asset-manifest.json
```

**Причины и решения:**

| Причина | Решение |
|---|---|
| Build не был пересобран после git pull | Запустить `CI=false npm run build` вручную |
| Nginx root пустой (нет `index.html`) | `mkdir -p /var/www/battletoads-double-dragon; rsync -a build/ /var/www/...` |
| `npm ci` падает из-за lockfile mismatch | Скрипт автоматически fallback → `npm install` |
| TS ошибка в компоненте — весь build silent fail | Проверить локально `npm run build`, исправить ошибку |

**Быстрое ручное исправление (если всё совсем сломалось):**
```bash
# Залить локально собранный build напрямую
scp -r frontend/build/* root@176.57.184.98:/var/www/battletoads-double-dragon/
ssh root@176.57.184.98 "systemctl reload nginx"
```

### npm ci падает на VPS с "out of sync"

**Симптом:**
```
npm error Missing: yaml@2.8.3 from lock file
```
или
```
npm ci can only install packages when package.json and package-lock.json are in sync
```

**Причины:**
- Разные версии npm локально и на VPS (v10.x vs более старый)
- Peer-зависимость, которая не записана явно (`yaml`, `fsevents`, и т.п.)
- Lockfile был сгенерирован в Windows и содержит `\r\n`

**Решения:**
1. Добавить проблемный пакет явно в `package.json` + переснять lock локально через `npm install`
2. Починить в [frontend/package.json](../frontend/package.json), `npm install`, закоммитить и запушить
3. Скрипт `update_vps_from_git.sh` теперь автоматически откатывается на `npm install` если `npm ci` падает

### Nginx root исчез / пустой

**Симптом:** `500 Internal Server Error` для всех запросов,
в `/var/log/nginx/error.log`:
```
rewrite or internal redirection cycle while internally redirecting to "/index.html"
```

**Причина:** В nginx.conf указан `try_files $uri /index.html` и root пустой или вообще не существует.

**Активный nginx root на текущем VPS:**
```
/var/www/battletoads-double-dragon
```
Если папки нет — создать и залить build:
```bash
mkdir -p /var/www/battletoads-double-dragon
rsync -a --delete /opt/battletoads-double-dragon/frontend/build/ /var/www/battletoads-double-dragon/
systemctl reload nginx
```

### TypeScript ошибка тихо ломает весь frontend build

CRA (Create React App) воспринимает TS ошибки как compile error и не выдаёт `build/index.html`.
При этом лог часто просто не отображается (SSH stdout обрывается).

**Правило:** перед любым деплоем быть уверенным, что `npm run build` проходит локально без ошибок.

Пример ошибки, замеченной 2026-03-23:
```
TS2322: Type 'TradingSystem[] | readonly []' is not assignable to type 'TradingSystem[]'
```
Исправление: не использовать `as const` для кортежей, которые кладутся в `Record<string, T[]>`.

---

## Память VPS

**Текущий VPS:** 7.9 GB RAM, swap 10 GB.

**Нормальное состояние (после перезапуска):**
| Процесс | RSS |
|---|---|
| `btdd-runtime` (node) | 800–900 MB |
| `btdd-api` (node) | 50–450 MB |
| `btdd-research` (node) | 15–70 MB |

**Увеличенный API-процесс до ~1.3 GB RSS:**
- Симптом накопленного состояния после длительного uptime (больше суток без рестарта).
- Решение: `systemctl restart btdd-api`. После рестарта возвращается к норме.
- Не является аварией: swap почти пустой, available > 5 GB.

**Порты:**
- `btdd-api` слушает порт `3001` (HTTP API + проксируется nginx)
- `btdd-research` и `btdd-runtime` не слушают внешние порты
- nginx слушает `80`
- Порты `3000`, `3001` — это только battletoads-double-dragon, не пересекаются с другими проектами на этом сервере

---

## Сервисы и статус

```bash
# Быстрая проверка всех трёх
systemctl is-active btdd-api btdd-research btdd-runtime

# Детальный статус + хвост логов
systemctl --no-pager --full status btdd-api
```

**Имена сервисов:**
- `btdd-api` — HTTP API + Frontend (порт 3001, nginx вперёд)
- `btdd-research` — Research + daily sweep scheduler
- `btdd-runtime` — Торговый контур (auto strategies + monitoring)

**Порядок рестарта (если нужно всё):**
```bash
# btdd-runtime НЕ рестартуем без явной нужды — там активные торговые позиции
systemctl restart btdd-api btdd-research
```

---

## Диагностика

```bash
# Размер build
du -sh /opt/battletoads-double-dragon/frontend/build

# Что реально отдаёт nginx
curl -s http://127.0.0.1/asset-manifest.json

# VPS git HEAD
cd /opt/battletoads-double-dragon; git rev-parse --short HEAD

# Память
free -m
ps -eo pid,cmd,%mem,rss --sort=-rss | head -n 12

# OOM-убийства (если build тихо падает)
dmesg -T | grep -i -E 'killed process|out of memory|oom' | tail -n 20

# nginx error log
tail -n 40 /var/log/nginx/error.log
```

---

## Быстрая самопроверка перед деплоем

- [ ] `npm run build` локально проходит без ошибок
- [ ] Изменения закоммичены и запушены
- [ ] `git log --oneline -3` на VPS показывает нужный коммит после деплоя
- [ ] `curl -s http://127.0.0.1/asset-manifest.json` показывает новый hash JS-файла
- [ ] `systemctl is-active btdd-api btdd-research btdd-runtime` — всё `active`

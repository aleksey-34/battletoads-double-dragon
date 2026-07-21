# Миграция BTDD на новый VPS

Актуально: **2026-07-21**. Старый VPS: `176.57.184.98` / `battletoads.top`.

## 1. Git — что в репозитории

| Статус | Детали |
|--------|--------|
| **Локаль ↔ GitHub** | Синхронно: `HEAD` = `origin/main` = `f309b70` |
| **Prod-код** | Весь прод-деплой идёт из `main` на GitHub |
| **Не в git** | `.env`, `database.db*`, `research.db`, `.auth-password.json`, `results/`, `logs/`, локальные sweep-артефакты |

### Незакоммиченные локальные правки (7 файлов)

Если VPS ещё успеете достать — **решите, коммитить ли до миграции**:

- `backend/src/api/analyticsRoutes.ts` — sync-fills endpoint
- `backend/src/research/fullHistoricalSweepService.ts` — momentum_scalp_tv в sweep
- `backend/src/research/hybridSweepLocalEntry.ts`
- `scripts/admin_tools/storefront/cleanup_bad_synth_cards.py`
- `scripts/admin_tools/storefront/fix_v2_synth_snapshot.py`
- `scripts/hybrid/build_tv_cloud_stars_card_jul2026.py`
- `tmp/WEEX_Copy_Alex1_support_packet.txt`

Сотни research-скриптов в `scripts/hybrid/` — **не в git**, на прод не влияют (только R&D).

---

## 2. Что обязательно перенести (не в git)

| Артефакт | Путь на VPS | Зачем |
|----------|-------------|--------|
| **Основная БД** | `/opt/battletoads-double-dragon/backend/database.db` | Клиенты, API-ключи, стратегии, витрина, offer store |
| **Research БД** | `backend/research.db` или `data/research.db` | Presets / sweep-кэш |
| **`.env`** | `/opt/battletoads-double-dragon/.env` | Пароли, Telegram, JWT, порты |
| **`.auth-password.json`** | `backend/.auth-password.json` | Хэш пароля админ-дашборда |
| **SSL** | `/etc/letsencrypt/` | HTTPS для `battletoads.top` |
| **Deploy key** | `/home/ubuntu/.ssh/id_ed25519_btdd_deploy` | Git pull на VPS |
| **Nginx root** | `/var/www/battletoads-double-dragon/` | Можно пересобрать из git, но быстрее rsync |

### Локальные копии БД (на этой машине)

| Файл | Размер | Комментарий |
|------|--------|-------------|
| `backend/database.db` | ~504 MB | Актуальная локальная копия |
| `backend/database.db.vps_snapshot` | ~2.5 GB | Снимок с VPS (июл 2026) |
| `backend/database.db.vps_full` | ~22 GB | Полный дамп (тяжёлый) |

Если старый VPS недоступен — **минимум для восстановления prod**: `database.db` + `.env` + `.auth-password.json`.

---

## 3. Экспорт со старого VPS (пока доступен)

```bash
# На старом VPS (root)
bash /opt/battletoads-double-dragon/scripts/vps_migration_export.sh

# Скачать архив на локальную машину
scp root@176.57.184.98:/opt/battletoads-double-dragon/backups/migration/btdd_migration_*.tar.gz ./
```

Если SSH уже не работает — используйте локальные `backend/database.db` + корневой `.env`.

---

## 4. Новый VPS — минимальные требования

- Ubuntu 22.04+
- Node.js **18+** (`/usr/bin/node`)
- nginx, git, sqlite3, rsync
- RAM **≥ 4 GB** (frontend build нужен ~3 GB)
- Диск **≥ 50 GB** (БД + results + logs)
- Открыты порты **80, 443** (443 после certbot)

---

## 5. Bootstrap на новом VPS

```bash
# 1. Базовые пакеты
apt update && apt install -y git nginx curl rsync sqlite3 certbot python3-certbot-nginx

# 2. Node 20 (если нет)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 3. Пользователь ubuntu + каталог
id ubuntu || useradd -m -s /bin/bash ubuntu
mkdir -p /opt/battletoads-double-dragon
chown -R ubuntu:ubuntu /opt/battletoads-double-dragon

# 4. Клон репозитория (или deploy key — scripts/vps_setup_github_deploy_key.sh)
sudo -u ubuntu git clone git@github.com:aleksey-34/battletoads-double-dragon.git /opt/battletoads-double-dragon

# 5. Положить .env и database.db (из архива миграции)
#    scp btdd_migration_*.tar.gz root@NEW_VPS:/tmp/
bash /opt/battletoads-double-dragon/scripts/vps_migration_import.sh /tmp/btdd_migration_YYYYMMDD.tar.gz

# 6. Restore nginx + systemd + build
bash /opt/battletoads-double-dragon/scripts/vps_fresh_restore.sh

# 7. SSL (когда DNS уже на новый IP)
certbot --nginx -d battletoads.top -d www.battletoads.top

# 8. Deploy key для будущих обновлений
bash /opt/battletoads-double-dragon/scripts/vps_setup_github_deploy_key.sh
# → добавить pubkey в GitHub Deploy keys
```

---

## 6. DNS и биржи

1. **DNS** `battletoads.top` → новый IP (TTL лучше снизить заранее до 300s).
2. **Биржи (WEEX/BingX/Bybit)**: если использовался whitelist IP — добавить **новый egress IP** VPS.
   - В `.env`: `VPS_PUBLIC_IP` / `BTDD_EGRESS_IP`
3. **Telegram webhooks** (если есть) — обновить URL на новый домен.

---

## 7. Проверка после миграции

```bash
systemctl is-active btdd-api btdd-runtime btdd-research nginx
curl -sS http://127.0.0.1:3001/api/health
grep -o 'main\.[a-z0-9]*\.js' /var/www/battletoads-double-dragon/index.html
journalctl -u btdd-runtime -n 30 --no-pager
```

Снаружи: `https://battletoads.top`, логин в дашборд, клиентский `/client/login`, один тестовый API-key ping.

---

## 8. Деплой после миграции (обычный режим)

```bash
# Локально
git push origin main

# На новом VPS
sudo -u ubuntu git -C /opt/battletoads-double-dragon fetch origin main
sudo ALLOW_DIRTY_TRACKED=1 DEPLOY_MODE=multi SYNC_FRONTEND_NGINX=1 \
  bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh
```

---

## 9. Чеклист «день X»

- [ ] Архив миграции скачан локально (мин. `database.db` + `.env`)
- [ ] DNS TTL уменьшен
- [ ] Новый VPS поднят, bootstrap выполнен
- [ ] БД импортирована, сервисы active
- [ ] SSL выпущен
- [ ] IP whitelist на биржах обновлён
- [ ] GitHub deploy key на новом VPS
- [ ] Smoke: health, login, runtime logs без ошибок
- [ ] Старый VPS — только read-only до подтверждения, потом выключить

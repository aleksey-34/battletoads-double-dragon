# Миграция BTDD на новый VPS

Актуально: **2026-08-23**. Prod VPS: `176.57.184.98` / `battletoads.top`.

## 1. Git — что в репозитории

| Статус | Детали |
|--------|--------|
| **Prod-код** | Деплой из `main` на GitHub |
| **Не в git** | `.env`, `database.db*`, `monitoring.db`, `research.db`, `.auth-password.json`, `results/`, `logs/` |

Research-скрипты в `scripts/hybrid/` — локальный R&D, на prod не влияют.

---

## 2. Что обязательно перенести (не в git)

| Артефакт | Путь на VPS | Зачем |
|----------|-------------|--------|
| **Основная БД** | `backend/database.db` | Клиенты, ключи, стратегии, витрина, TS |
| **Monitoring БД** | `backend/monitoring.db` | Equity snapshots + fills (отдельно от main) |
| **Research БД** | `backend/research.db` | Presets / sweep-кэш (обычно пустая) |
| **`.env`** | корень репо | Секреты |
| **`.auth-password.json`** | `backend/` | Пароль админ-дашборда |
| **SSL** | `/etc/letsencrypt/` | HTTPS |
| **Deploy key** | `/home/ubuntu/.ssh/id_ed25519_btdd_deploy` | Git pull |

### Размеры (после retention Aug 2026)

| Путь | Типичный размер | Примечание |
|------|-----------------|------------|
| `database.db` | **~0.5–2 GB** после cleanup | Было ~21 GB (backtest JSON blobs) |
| `monitoring.db` | **~7 MB** | Retention 30d |
| `database.db.vps_full` (локально) | ~22 GB | **Устаревший дамп Jul 2026** — перекачать после cleanup |

---

## 3. Retention / autoklean (main DB)

**Причина 21 GB:** таблица `backtest_runs` (~95%) — JSON equity/trades от старых свипов.

**Сохраняется:**
- Все strategy_id из active master cards, active TS, portfolios, runtime
- Full JSON: pinned run **#360**, portfolio runs, latest single-strategy run per protected sid
- `live_trade_events`, tenants, api_keys

**Скрипты:**

```bash
# Dry-run
python3 scripts/admin_tools/db_retention_cleanup.py --dry-run

# Prod (backup + stop + apply + VACUUM)
bash scripts/vps_db_retention.sh --apply

# Export bundle после cleanup (меньший архив)
PRE_RETENTION_CLEAN=1 bash scripts/vps_migration_export.sh
```

**Autoklean:** `btdd-runtime` — weekly strip (`DB_RETENTION_AUTO=1`, default). VACUUM только в maintenance (`vps_db_retention.sh`).

Env: `DB_RETENTION_DAYS=90`, `PINNED_BACKTEST_RUN_IDS=360`, `DB_RETENTION_INTERVAL_HOURS=168`.

---

## 4. Скачать свежий prod (локальная машина)

```bash
chmod +x scripts/vps_migration_pull_to_local.sh
bash scripts/vps_migration_pull_to_local.sh btdd
# → backups/migration/prod_YYYYMMDDTHHMMSSZ/
#   config/.env, db/database.db.gz, db/monitoring.db, db/research.db
```

После pull можно обновить dev-копию:

```bash
gunzip -c backups/migration/prod_*/db/database.db.gz > backend/database.db
cp backups/migration/prod_*/db/monitoring.db backend/monitoring.db
# Старый backend/database.db.vps_full (~22G) можно удалить вручную
```

---

## 5. Экспорт со старого VPS

```bash
# На VPS
bash /opt/battletoads-double-dragon/scripts/vps_migration_export.sh
# или с pre-clean:
PRE_RETENTION_CLEAN=1 bash /opt/battletoads-double-dragon/scripts/vps_migration_export.sh

scp root@176.57.184.98:/opt/battletoads-double-dragon/backups/migration/btdd_migration_*.tar.gz ./
```

---

## 6. Bootstrap на новом VPS

```bash
scp -r backups/migration/prod_YYYYMMDD root@NEW_IP:/tmp/btdd_bundle
bash /opt/battletoads-double-dragon/scripts/vps_bootstrap_new_server.sh --bundle /tmp/btdd_bundle
```

Или:

```bash
bash scripts/vps_migration_import.sh /tmp/btdd_migration_*.tar.gz
bash scripts/vps_fresh_restore.sh
```

---

## 7. Проверка после миграции / retention

```bash
systemctl is-active btdd-api btdd-runtime btdd-research nginx
du -h /opt/battletoads-double-dragon/backend/database.db
du -h /opt/battletoads-double-dragon/backend/monitoring.db
journalctl -u btdd-runtime -n 20 --no-pager | grep db-retention
```

Smoke: login, Positions monitoring, один клиентский cabinet, runtime logs без SQLITE_BUSY.

---

## 8. Обычный деплой

```bash
git push origin main
sudo -u ubuntu git -C /opt/battletoads-double-dragon fetch origin main
sudo ALLOW_DIRTY_TRACKED=1 DEPLOY_MODE=multi SYNC_FRONTEND_NGINX=1 \
  bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh
```

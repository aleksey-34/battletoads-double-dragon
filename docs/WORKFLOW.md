"""# BTDD Workflow — надёжный метод работы с VPS и большими файлами

**Дата:** 2026-05-19
**Проблема:** `run_terminal_command` нестабилен с кавычками, heredoc'ами и длинными командами.
**Решение:** Всегда использовать цепочку `create_new_file` → `scp` → `ssh python3`.

---

## Правило №1: никаких кавычек в терминале

❌ **Плохо:**
```bash
ssh root@176.57.184.98 'sqlite3 ... "SELECT ... WHERE name LIKE '%artursk%';"'
```
→ ломается на вложенных кавычках.

✅ **Хорошо:**
```bash
scp script.py root@176.57.184.98:/tmp/
ssh root@176.57.184.98 python3 /tmp/script.py
```
→ ноль проблем с экранированием.

---

## Правило №2: для SQL-запросов — Python скрипт

Вместо прямого `sqlite3` через ssh, пишем Python-скрипт с `subprocess`:

```python
import subprocess
r = subprocess.run(
    ['sqlite3', '/opt/battletoads-double-dragon/backend/database.db', query],
    capture_output=True, text=True
)
print(r.stdout)
```

---

## Правило №3: для правки огромных файлов — Python скрипт на VPS

1. `create_new_file` → создаём Python-скрипт в `scripts/`
2. `scp scripts/файл.py root@176.57.184.98:/tmp/`
3. `ssh root@176.57.184.98 python3 /tmp/файл.py`
4. Читаем stdout с результатами

---

## Правило №4: сборка TypeScript

```bash
scp fix_script.py root@176.57.184.98:/tmp/
ssh root@176.57.184.98 python3 /tmp/fix_script.py
```

Скрипт внутри делает:
```python
import subprocess
os.chdir('/opt/battletoads-double-dragon/backend')
r = subprocess.run(['npx', 'tsc'], capture_output=True, text=True, timeout=120)
print(r.stdout)
print(r.stderr)
```

---

## Шпаргалка по частым командам

| Задача | Команда |
|--------|---------|
| Копировать скрипт на VPS | `scp scripts/имя.py root@176.57.184.98:/tmp/` |
| Запустить скрипт на VPS | `ssh root@176.57.184.98 python3 /tmp/имя.py` |
| Копировать + запустить | `scp ... && ssh ... python3 ...` |
| Сборка backend | `ssh root@176.57.184.98 'cd /opt/battletoads-double-dragon/backend && npx tsc'` (простая команда без кавычек внутри — работает) |
| Рестарт сервисов | `ssh root@176.57.184.98 systemctl restart btdd-api btdd-runtime` |
| Git pull на VPS | `ssh root@176.57.184.98 'cd /opt/battletoads-double-dragon && git pull'` |

---

*Записал для себя и будущих сессий. Больше никакой борьбы с кавычками.*
"""
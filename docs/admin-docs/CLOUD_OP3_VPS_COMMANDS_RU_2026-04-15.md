# Cloud OP3 VPS Commands — 2026-04-15

## Зачем Этот Файл

- Здесь собраны точные команды для первого execution pass.
- Это не означает, что все команды надо запускать бездумно подряд.
- Главный стоп-фактор сейчас: pair-conflict на source key `BTDD_D1` для `OPUSDT/SEIUSDT`.

## Текущее Baseline Состояние

- `btdd-api = active`
- `btdd-runtime = active`
- `btdd-research = active`
- `cloud-op2`:
  - `system_id = 72`
  - `max_open_positions = 2`
  - `enabled_members = 8`

## Path Decision Перед Сборкой Cloud OP3

### Path A — Replace On Same Source Key

- Временно отключаем `80307` на `BTDD_D1`.
- Создаём новые `OP/SEI 15m` members на том же key.
- Риск: трогаем existing source family.

### Path B — New Source Alias Key

- Создаём новый source API key alias для `Cloud OP3` family.
- Создаём там `15m` core members без конфликта с `80307`.
- Это safest path для параллельного существования `cloud-op2` и `cloud-op3`.

### Path C — Runtime-Only Pilot

- Не создаём source members сразу.
- Сначала делаем runtime/materialized pilot на alias key.
- Source-layer собираем после подтверждения runtime thesis.

## Рекомендуемый Path Сейчас

- Рекомендуется `Path B`.

Причина:

- `cloud-op2` остаётся нетронутым.
- Нет конфликта по одной и той же паре на одном key.
- Можно спокойно валидировать новый family параллельно.

## Команды Baseline Snapshot

### Services

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "systemctl is-active btdd-api; systemctl is-active btdd-runtime; systemctl is-active btdd-research"
```

### Cloud OP2 System State

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "python3 - <<'PY'
import sqlite3, json
conn=sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
conn.row_factory=sqlite3.Row
rows=conn.execute('''
select ts.id as system_id, ts.name, ts.max_open_positions, ts.is_active,
       count(case when tsm.is_enabled=1 then 1 end) as enabled_members
from trading_systems ts
left join trading_system_members tsm on tsm.system_id = ts.id
where ts.name like 'ALGOFUND_MASTER::BTDD_D1::cloud-op2%'
group by ts.id, ts.name, ts.max_open_positions, ts.is_active
order by ts.id
''').fetchall()
for r in rows:
    print(json.dumps(dict(r), ensure_ascii=False))
PY"
```

## Команды Для Проверки Pair Conflict

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "python3 - <<'PY'
import sqlite3, json
conn=sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
conn.row_factory=sqlite3.Row
rows=conn.execute('''
select s.id, s.name, s.base_symbol, s.quote_symbol, s.interval, s.is_active, ak.name as api_key
from strategies s
join api_keys ak on ak.id = s.api_key_id
where s.base_symbol='OPUSDT' and s.quote_symbol='SEIUSDT'
order by ak.name, s.id
''').fetchall()
for r in rows:
    print(json.dumps(dict(r), ensure_ascii=False))
PY"
```

## Команды Для Path B — Source Alias Preparation

### 1. Посмотреть API Keys

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "python3 - <<'PY'
import sqlite3, json
conn=sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
conn.row_factory=sqlite3.Row
rows=conn.execute('select id,name,exchange,is_demo from api_keys order by id').fetchall()
for r in rows:
    print(json.dumps(dict(r), ensure_ascii=False))
PY"
```

### 2. Если Нужен Новый Alias Key

Идея:

- создать alias вроде `BTDD_D1_OP3_SOURCE`,
- с теми же credentials, что у `BTDD_D1`,
- но отдельным `name`, чтобы избежать pair-conflict.

Команду вставлять только после ручной проверки схемы `api_keys` и полей credential storage в prod.

## Команды Для Создания Новых 15m Core Members Через API

Ниже пример POST на backend API. Запускать после того, как выбран source key без pair-conflict.

### Core-1

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "curl -s -X POST http://127.0.0.1:3001/api/strategies/BTDD_D1_OP3_SOURCE \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"OP/SEI 15m cloud-op3 core-1",
    "strategy_type":"stat_arb_zscore",
    "market_mode":"synthetic",
    "base_symbol":"OPUSDT",
    "quote_symbol":"SEIUSDT",
    "interval":"15m",
    "price_channel_length":24,
    "take_profit_percent":0,
    "detection_source":"close",
    "zscore_entry":2.25,
    "zscore_exit":0.75,
    "zscore_stop":3.5,
    "base_coef":1,
    "quote_coef":1,
    "is_active":1,
    "auto_update":1,
    "long_enabled":1,
    "short_enabled":1
  }'"
```

### Core-2

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "curl -s -X POST http://127.0.0.1:3001/api/strategies/BTDD_D1_OP3_SOURCE \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"OP/SEI 15m cloud-op3 core-2",
    "strategy_type":"stat_arb_zscore",
    "market_mode":"synthetic",
    "base_symbol":"OPUSDT",
    "quote_symbol":"SEIUSDT",
    "interval":"15m",
    "price_channel_length":24,
    "take_profit_percent":0,
    "detection_source":"close",
    "zscore_entry":2.25,
    "zscore_exit":0.5,
    "zscore_stop":3.5,
    "base_coef":1,
    "quote_coef":1,
    "is_active":1,
    "auto_update":1,
    "long_enabled":1,
    "short_enabled":1
  }'"
```

## Команды Для Сборки Source TS

После получения точных `strategy_id`:

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "curl -s -X POST http://127.0.0.1:3001/api/trading-systems/BTDD_D1_OP3_SOURCE \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"ALGOFUND_MASTER::BTDD_D1::cloud-op3-diversified",
    "description":"Cloud OP3 diversified source TS",
    "is_active":1,
    "auto_sync_members":0,
    "discovery_enabled":0,
    "max_members":6,
    "max_open_positions":2,
    "members":[
      {"strategy_id":CORE1_ID,"weight":0.24,"member_role":"core","is_enabled":true,"notes":"cloud-op3 core"},
      {"strategy_id":CORE2_ID,"weight":0.24,"member_role":"core","is_enabled":true,"notes":"cloud-op3 core"},
      {"strategy_id":SAT1_ID,"weight":0.16,"member_role":"satellite","is_enabled":true,"notes":"cloud-op3 satellite"},
      {"strategy_id":SAT2_ID,"weight":0.14,"member_role":"satellite","is_enabled":true,"notes":"cloud-op3 satellite"},
      {"strategy_id":DIV1_ID,"weight":0.11,"member_role":"satellite","is_enabled":true,"notes":"cloud-op3 diversifier"},
      {"strategy_id":DIV2_ID,"weight":0.11,"member_role":"satellite","is_enabled":true,"notes":"cloud-op3 diversifier"}
    ]
  }'"
```

## Команды Для First Audit Snapshot После Запуска

### Event-Origin Split

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "python3 - <<'PY'
import sqlite3, json
conn=sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
conn.row_factory=sqlite3.Row
rows=conn.execute('''
select coalesce(event_origin,'unknown') as origin, count(*) as cnt
from live_trade_events
where created_at >= datetime('now','-24 hours')
group by coalesce(event_origin,'unknown')
order by cnt desc
''').fetchall()
for r in rows:
    print(json.dumps(dict(r), ensure_ascii=False))
PY"
```

### Open Positions By System

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "python3 - <<'PY'
import sqlite3, json
conn=sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
conn.row_factory=sqlite3.Row
rows=conn.execute('''
select ts.name as system_name, count(*) as open_positions
from positions p
join strategies s on s.id = p.strategy_id
join trading_system_members tsm on tsm.strategy_id = s.id and coalesce(tsm.is_enabled,1)=1
join trading_systems ts on ts.id = tsm.system_id
where coalesce(p.state,'') in ('open','opened')
group by ts.name
order by open_positions desc
''').fetchall()
for r in rows:
    print(json.dumps(dict(r), ensure_ascii=False))
PY"
```

### Source / Runtime Systems State

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' root@176.57.184.98 "python3 - <<'PY'
import sqlite3, json
conn=sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
conn.row_factory=sqlite3.Row
rows=conn.execute('''
select id,name,max_open_positions,is_active,updated_at
from trading_systems
where name like 'ALGOFUND_MASTER::%cloud-op2%' or name like 'ALGOFUND_MASTER::%cloud-op3%'
order by id
''').fetchall()
for r in rows:
    print(json.dumps(dict(r), ensure_ascii=False))
PY"
```
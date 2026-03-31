#!/usr/bin/env python3
import sqlite3
import json
from datetime import datetime, timedelta

db_path = '/opt/battletoads-double-dragon/backend/database.db'
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

print("=" * 80)
print("НОЧНАЯ ТОРГОВЛЯ: ДИАГНОСТИКА")
print("=" * 80)

# 1. Стратегии с ошибками
print("\n1. СТРАТЕГИИ С last_error:")
cursor.execute("""
    SELECT s.id, a.name as api_key_name, s.name, s.base_symbol, s.quote_symbol, 
           s.last_error, s.is_active
    FROM strategies s
    LEFT JOIN api_keys a ON s.api_key_id = a.id
    WHERE s.last_error IS NOT NULL AND s.last_error != ''
    ORDER BY s.id DESC
    LIMIT 20
""")
rows = cursor.fetchall()
if rows:
    for r in rows:
        print(f"  ID {r[0]:6} | Key {r[1]:20} | Active={r[6]} | Error: {r[5][:70]}")
else:
    print("  ✓ Нет ошибок в last_error")

# 2. Trade history за ночь (последние 12 часов)
print("\n2. ИСТОРИИ СДЕЛОК (последние 12 часов):")
try:
    cursor.execute("""
        SELECT COUNT(*), SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
        FROM trades
        WHERE created_at > datetime('now', '-12 hours')
    """)
    count_row = cursor.fetchone()
    total_trades = count_row[0] or 0
    completed_trades = count_row[1] or 0
    print(f"  Всего сделок: {total_trades}, из них завершено: {completed_trades}")

    if total_trades == 0:
        print("  ⚠️  ТОРГОВЛИ НЕ БЫЛО!")
except Exception as e:
    print(f"  (Ошибка запроса trades: {e})")

# 3. Unresolved low_lot_error events
print("\n3. НЕРЕШЁННЫЕ LOW-LOT СОБЫТИЯ:")
try:
    cursor.execute("""
        SELECT COUNT(*) FROM strategy_runtime_events
        WHERE event_type = 'low_lot_error' AND resolved_at IS NULL
    """)
    unresolved_lowlot = cursor.fetchone()[0]
    print(f"  Нерешённых low_lot_error: {unresolved_lowlot}")

    if unresolved_lowlot > 0:
        cursor.execute("""
            SELECT strategy_id, details FROM strategy_runtime_events
            WHERE event_type = 'low_lot_error' AND resolved_at IS NULL
            LIMIT 5
        """)
        for r in cursor.fetchall():
            print(f"    Стратегия {r[0]}: {str(r[1])[:60]}")
except Exception as e:
    print(f"  (Ошибка запроса runtime_events: {e})")

# 4. Активные стратегии
print("\n4. АКТИВНЫЕ СТРАТЕГИИ:")
cursor.execute("SELECT COUNT(*) FROM strategies WHERE is_active = 1")
active_count = cursor.fetchone()[0]
print(f"  Всего: {active_count} стратегий включено")

# 5. Распределение по API ключам
print("\n5. АКТИВНЫЕ СТРАТЕГИИ ПО КЛЮЧАМ:")
cursor.execute("""
    SELECT a.name, COUNT(*) as cnt
    FROM strategies s
    LEFT JOIN api_keys a ON s.api_key_id = a.id
    WHERE s.is_active = 1
    GROUP BY a.name
    ORDER BY cnt DESC
""")
for r in cursor.fetchall():
    print(f"  {r[0]:20} : {r[1]:3} стратегий")

print("\n6. ПОСЛЕДНИЕ СИГНАЛЫ (Sample):")
cursor.execute("""
    SELECT s.id, s.last_signal, s.last_action, s.updated_at
    FROM strategies s
    WHERE s.is_active = 1
    ORDER BY s.updated_at DESC
    LIMIT 5
""")
for r in cursor.fetchall():
    print(f"  ID {r[0]:6} | Signal: {str(r[1])[:30]:30} | Action: {str(r[2])[:20]:20} | {r[3]}")

conn.close()

print("\n" + "=" * 80)

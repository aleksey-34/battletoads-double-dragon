#!/usr/bin/env python3
import sqlite3

db_path = '/opt/battletoads-double-dragon/backend/database.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Проблемные стратегии с low-lot ошибками
problem_ids = [80127, 80126, 80111, 80110, 80100, 80090]

print("=" * 100)
print("АНАЛИЗ СТРАТЕГИЙ С LOW-LOT ОШИБКАМИ")
print("=" * 100)

cursor.execute("""
    SELECT 
        s.id,
        a.name as api_key,
        s.base_symbol,
        s.quote_symbol,
        s.max_deposit,
        s.leverage,
        s.lot_long_percent,
        s.lot_short_percent,
        s.reinvest_percent,
        s.last_error
    FROM strategies s
    LEFT JOIN api_keys a ON s.api_key_id = a.id
    WHERE s.id IN (80127, 80126, 80111, 80110, 80100, 80090)
    ORDER BY s.id
""")

rows = cursor.fetchall()
for r in rows:
    id_s, key, base, quote, max_dep, lev, lot_long, lot_short, reinv, err = r
    
    # Расчет notional
    base_capital = max_dep
    lot_frac = max(lot_long, lot_short) / 100.0
    reinv_factor = 1.0 + (reinv / 100.0) if reinv else 1.0
    lev_factor = max(1, lev) if lev else 1
    
    notional_old = base_capital * lot_frac  # Без лeverageFactor
    notional_new = base_capital * lot_frac * lev_factor  # С leverageFactor
    
    print(f"\nID {id_s:6} | {key:15} | {base:10} / {quote:10}")
    print(f"  max_deposit={max_dep:8.2f}, leverage={lev:5.1f}, lot={lot_long:6.1f}%")
    print(f"  reinvest={reinv:5.1f}%, calc: {reinv_factor:.2f}x")
    print(f"  Notional (без leverage): {notional_old:8.2f} USDT")
    print(f"  Notional (с leverage):   {notional_new:8.2f} USDT")
    print(f"  Error: {err[:80]}")

conn.close()
print("\n" + "=" * 100)

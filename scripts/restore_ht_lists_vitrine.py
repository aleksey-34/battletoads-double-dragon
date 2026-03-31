#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('=== ВОССТАНАВЛИВАЮ HIGH-TRADE-CURATED (удаленную версию) ===')
print()

# Восстанавливаю архивированную версию (ID=25)
c.execute("SELECT id, name FROM trading_systems WHERE id = 25")
r = c.fetchone()
if r:
    archived_name = r[1]
    print(f'Found archived ID=25: {archived_name}')
    
    # Extract original name
    parts = archived_name.split('::')
    if len(parts) >= 4:
        original_name = '::'.join(parts[1:4])
    else:
        original_name = archived_name
    
    print(f'Original name: {original_name}')
    print()
    
    # Unarchive in trading_systems
    print('✓ Activating in trading_systems (Offer/TS lists)...')
    c.execute("UPDATE trading_systems SET name = ?, is_active = 1 WHERE id = 25", (original_name,))
    db.commit()
    
    c.execute("SELECT id, name, is_active FROM trading_systems WHERE id = 25")
    restored_ts = c.fetchone()
    print(f'  TS ID={restored_ts[0]}: ACTIVE={restored_ts[2]}, Name={restored_ts[1][:50]}')
    print()
    
    # Check if in vitrine
    print('✓ Checking algofund_active_systems (Витрина)...')
    c.execute("SELECT id FROM algofund_active_systems WHERE system_name LIKE ?", (f'%{original_name}%',))
    vitrine = c.fetchone()
    
    if vitrine:
        print(f'  Already in vitrine (ID={vitrine[0]})')
    else:
        print('  NOT in vitrine - adding entry...')
        c.execute("""INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
                      VALUES (0, ?, 1.0, 1, 'admin_restore', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""", (original_name,))
        db.commit()
        print('  ✓ Added to vitrine')
    
    print()
    print('✓ RESTORED HIGH-TRADE-CURATED')
    print(f'  - In Offer/TS Lists: ID=25, ACTIVE')
    print(f'  - In Витрина: ON (is_enabled=1)')
    
else:
    print('ERROR: ID=25 not found')

db.close()

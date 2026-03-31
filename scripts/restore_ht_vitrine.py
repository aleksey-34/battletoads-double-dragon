#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('=== RESTORING HIGH-TRADE CURATED (ID=27) ===')
print()

# Get the archived record
c.execute("SELECT id, name FROM trading_systems WHERE id = 27")
r = c.fetchone()
if r:
    archived_name = r[1]
    print(f'Found ID=27: {archived_name}')
    
    # Extract original name from ARCHIVED:: prefix
    # Format: ARCHIVED::ALGOFUND_MASTER::BTDD_D1::high-trade-curated-r0pf9x::archived_XXXXXXX
    parts = archived_name.split('::')
    if len(parts) >= 4:
        original_name = '::'.join(parts[1:4])  # ALGOFUND_MASTER::BTDD_D1::high-trade-curated-r0pf9x
    else:
        original_name = archived_name
    
    print(f'Original name: {original_name}')
    print()
    
    # Restore by renaming and activating
    print('✓ Unarchiving...')
    c.execute("UPDATE trading_systems SET name = ?, is_active = 1 WHERE id = 27", (original_name,))
    db.commit()
    
    # Verify
    c.execute("SELECT id, name, is_active FROM trading_systems WHERE id = 27")
    restored = c.fetchone()
    print(f'  Restored: ID={restored[0]}, Name={restored[1]}, Active={restored[2]}')
    print()
    
    # Check if it's in active systems
    print('✓ Checking algofund_active_systems...')
    c.execute("SELECT id, system_name FROM algofund_active_systems WHERE system_name LIKE ?", (f'%{original_name}%',))
    active = c.fetchall()
    if active:
        print(f'  Already in active systems: {len(active)} records')
        for a in active:
            print(f'    ID={a[0]}, Name={a[1]}')
    else:
        print('  NOT in active_systems - adding entry...')
        # Add to active systems if missing
        c.execute("""INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
                      VALUES (0, ?, 1.0, 1, 'admin_restore', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""", 
                  (original_name,))
        db.commit()
        print(f'  ✓ Added to active_systems')
    
    print()
    print('✓ HIGH-TRADE CURATED ID=27 RESTORED TO VITRINE')

else:
    print('ERROR: ID=27 not found!')

db.close()

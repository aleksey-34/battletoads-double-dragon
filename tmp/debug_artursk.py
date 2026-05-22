"#!/usr/bin/env python3
import subprocess, sys

def ssh(cmd):
    r = subprocess.run(['ssh', 'root@176.57.184.98', cmd], capture_output=True, text=True, timeout=30)
    return r.stdout.strip(), r.stderr.strip()

# 1. Check api_keys for this name
out, err = ssh('sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, name, exchange_id, active FROM api_keys WHERE name LIKE \'%5374535192%\';"')
print('=== api_keys ===')
print(out or '(empty)')
if err: print('ERR:', err)

# 2. Check if there are multiple keys with similar names
out, err = ssh('sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, name, exchange_id, active FROM api_keys WHERE name LIKE \'%artursk%\' ORDER BY id DESC LIMIT 10;"')
print('\n=== all artursk keys ===')
print(out or '(empty)')
if err: print('ERR:', err)

# 3. What tenant_id is 69205? Check slug
out, err = ssh('sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, slug FROM tenants WHERE id = 69205;"')
print('\n=== tenant 69205 ===')
print(out or '(empty)')
if err: print('ERR:', err)

# 4. Check if any snapshot exists for this tenant's published_system_name
out, err = ssh('sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, snapshot_key FROM ts_backtest_snapshots WHERE snapshot_key LIKE \'%5374535192%\' OR snapshot_key LIKE \'%artursk%\' LIMIT 5;"')
print('\n=== snapshots for this key ===')
print(out or '(empty)')
if err: print('ERR:', err)
"
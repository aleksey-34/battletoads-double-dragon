#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "UPDATE trading_systems SET name = 'ALGOFUND_MASTER::BTDD_D1::btdd-d1-ts-multiset-v2-spd-h6e6sh' WHERE id = 55"
echo "Updated rows: $?"
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, name FROM trading_systems WHERE id = 55"

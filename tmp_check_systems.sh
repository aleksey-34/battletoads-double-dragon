#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT name FROM trading_systems WHERE name LIKE 'ALGOFUND_MASTER%'"

#!/bin/bash
echo "=== TABLES ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".tables"

echo ""
echo "=== ALGOFUND PROFILES SCHEMA ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".schema algofund_profiles"

echo ""
echo "=== STRATEGY CLIENT PROFILES SCHEMA ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".schema strategy_client_profiles"

echo ""
echo "=== ALGOFUND PROFILES DATA ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" "SELECT * FROM algofund_profiles"

echo ""
echo "=== STRATEGY CLIENT PROFILES DATA ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" "SELECT * FROM strategy_client_profiles"

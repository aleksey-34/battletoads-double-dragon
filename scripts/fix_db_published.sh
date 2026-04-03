#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "UPDATE algofund_profiles SET published_system_name = '' WHERE tenant_id = 41003;"
echo "Updated rows for 41003"
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT tenant_id, published_system_name, actual_enabled FROM algofund_profiles WHERE tenant_id IN (41003, 43430);"
echo "DONE"

#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/database.db "SELECT id, slug, product_mode FROM tenants"
echo "---"
sqlite3 /opt/battletoads-double-dragon/database.db "SELECT * FROM synctrade_profiles"

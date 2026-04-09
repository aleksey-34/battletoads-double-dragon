#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT value FROM app_runtime_flags WHERE key='offer.store.published_ids';"

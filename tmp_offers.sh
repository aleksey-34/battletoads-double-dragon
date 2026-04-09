#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT value FROM app_runtime_flags WHERE key='admin.catalog.latest_json'" | python3 -c '
import sys, json
d = json.loads(sys.stdin.read())
for o in d.get("offers", [])[:15]:
    print(o["offerId"], "|", o.get("titleRu",""))
'

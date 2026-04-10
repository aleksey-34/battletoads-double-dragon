#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k, v in d.items():
    print(f'{k}: ret={v.get(\"ret\")}, pf={v.get(\"pf\")}, dd={v.get(\"dd\")}, trades={v.get(\"trades\")}, days={v.get(\"periodDays\")}, finalEq={v.get(\"finalEquity\")}, eqPts={len(v.get(\"equityPoints\",[]))}')
"

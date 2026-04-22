#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

rows = cur.execute(
    """
    SELECT ts.id AS system_id, ts.name AS system_name, ts.api_key_id,
           ak.name AS api_key_name, t.slug, t.id AS tenant_id
    FROM trading_systems ts
    JOIN api_keys ak ON ak.id = ts.api_key_id
    LEFT JOIN tenants t ON ts.name = ('ALGOFUND::' || t.slug)
    WHERE ts.name IN ('ALGOFUND::ruslan','ALGOFUND::ali','ALGOFUND::ivan-weex')
    ORDER BY ts.id
    """
).fetchall()

out = []
for r in rows:
    api_key_id = int(r["api_key_id"])
    active = [
        dict(x)
        for x in cur.execute(
            """
            SELECT id,name,base_symbol,quote_symbol,updated_at
            FROM strategies
            WHERE api_key_id=? AND COALESCE(is_runtime,1)=1 AND COALESCE(is_archived,0)=0 AND COALESCE(is_active,0)=1
            ORDER BY updated_at DESC, id DESC
            """,
            (api_key_id,),
        ).fetchall()
    ]

    by_symbol = {}
    for s in active:
        sym = (s.get("base_symbol") or "").strip().upper()
        if not sym:
            continue
        if sym not in by_symbol:
            by_symbol[sym] = s

    out.append(
        {
            "tenantId": r["tenant_id"],
            "slug": r["slug"],
            "systemId": r["system_id"],
            "systemName": r["system_name"],
            "apiKeyName": r["api_key_name"],
            "activeCount": len(active),
            "uniqueSymbolCount": len(by_symbol),
            "uniqueTop": list(by_symbol.values())[:20],
        }
    )

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

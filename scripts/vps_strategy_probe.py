#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

out = {}
out["strategiesColumns"] = [dict(name=r[1], type=r[2]) for r in cur.execute("PRAGMA table_info(strategies)").fetchall()]
out["apiKeys"] = [dict(r) for r in cur.execute("SELECT id,name,exchange FROM api_keys ORDER BY id LIMIT 200").fetchall()]
out["strategyCountsByApi"] = [dict(r) for r in cur.execute("SELECT api_key_id, COUNT(*) c FROM strategies GROUP BY api_key_id ORDER BY c DESC").fetchall()]

# first rows with likely identifiers
out["strategySample"] = [
    dict(r)
    for r in cur.execute(
        "SELECT id,api_key_id,name,base_symbol,quote_symbol,is_active,is_runtime,is_archived,created_at,updated_at FROM strategies ORDER BY id DESC LIMIT 80"
    ).fetchall()
]

# find likely mega portfolio offer ids in text fields
patterns = ["offer_mono_dd_battletoads_163468", "offer_mono_dd_battletoads_163462", "offer_synth_dd_battletoads_166842", "mega-portfolio"]
found = []
for p in patterns:
    rows = [
        dict(r)
        for r in cur.execute(
            """
            SELECT id,api_key_id,name,base_symbol,quote_symbol
            FROM strategies
            WHERE COALESCE(name,'') LIKE ? OR COALESCE(base_symbol,'') LIKE ? OR COALESCE(quote_symbol,'') LIKE ?
            LIMIT 20
            """,
            (f"%{p}%", f"%{p}%", f"%{p}%"),
        ).fetchall()
    ]
    found.append({"pattern": p, "rows": rows})
out["patternHits"] = found

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TARGET_MASTER = "ALGOFUND_MASTER::BTDD_D1::mega-portfolio"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

out = {}

out["masterRow"] = dict(cur.execute("SELECT * FROM trading_systems WHERE name=?", (TARGET_MASTER,)).fetchone() or {})

# Candidate: master_cards by name/system_name (schema-aware)
mc_cols = [r[1] for r in cur.execute("PRAGMA table_info(master_cards)").fetchall()]
select_cols = [c for c in ["id", "card_key", "card_name", "system_name", "api_key_name", "status", "updated_at"] if c in mc_cols]
if "id" not in select_cols:
    select_cols.insert(0, "id")
where_parts = []
params = []
if "system_name" in mc_cols:
    where_parts.append("COALESCE(system_name,'') = ?")
    params.append(TARGET_MASTER)
if "card_name" in mc_cols:
    where_parts.append("COALESCE(card_name,'') LIKE '%mega-portfolio%'")
if "card_key" in mc_cols:
    where_parts.append("COALESCE(card_key,'') LIKE '%mega-portfolio%'")

out["masterCards"] = []
if where_parts and select_cols:
    sql = f"SELECT {', '.join(select_cols)} FROM master_cards WHERE {' OR '.join(where_parts)} ORDER BY id DESC"
    out["masterCards"] = [dict(r) for r in cur.execute(sql, tuple(params)).fetchall()]

card_ids = [int(r["id"]) for r in out["masterCards"] if r.get("id")]
card_members = []
for cid in card_ids:
    rows = cur.execute(
        """
        SELECT m.card_id, m.strategy_id, m.weight, m.is_enabled, s.name AS strategy_name, s.base_symbol, s.quote_symbol
        FROM master_card_members m
        LEFT JOIN strategies s ON s.id = m.strategy_id
        WHERE m.card_id = ?
        ORDER BY m.id
        """,
        (cid,),
    ).fetchall()
    card_members.extend([dict(x) for x in rows])
out["masterCardMembers"] = card_members

# Candidate: BTDD_D1 active runtime strategies
btdd_active = cur.execute(
    """
    SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.is_active, s.origin, s.updated_at
    FROM strategies s
    JOIN api_keys ak ON ak.id = s.api_key_id
    WHERE ak.name = 'BTDD_D1'
      AND COALESCE(s.is_runtime, 1) = 1
      AND COALESCE(s.is_archived, 0) = 0
      AND COALESCE(s.is_active, 0) = 1
    ORDER BY s.updated_at DESC
    LIMIT 80
    """
).fetchall()
out["btddActiveCount"] = len(btdd_active)
out["btddActiveSample"] = [dict(r) for r in btdd_active[:25]]

# Candidate: app runtime flags keys
flags = cur.execute(
    "SELECT key, LENGTH(COALESCE(value,'')) AS len FROM app_runtime_flags WHERE key LIKE 'offer.store.%' ORDER BY key"
).fetchall()
out["offerStoreFlags"] = [dict(r) for r in flags]

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

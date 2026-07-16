#!/usr/bin/env python3
"""
Publish Aggressive (#3) + Whale (#6) dual-book packs as SINGLE master TS each
(B3 core members + MRS2 legs; separate OP/lot via TS meta + strategy lots),
then cut over active clients → Aggressive, BTDD_D1 → Whale.

  # on VPS:
  python3 scripts/hybrid/cutover_aggressive_whale_jul2026.py --dry-run
  python3 scripts/hybrid/cutover_aggressive_whale_jul2026.py --run --yes

Never mutates live B3 system 205 members — only reads them as clone source.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW if _RAW.lower().startswith("bearer ") else f"Bearer {_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
MAPPED = os.path.join(REPO, "results/hamster_compound_system89_jul2026/mapped_for_btdd.json")
WEEX_AVAIL = os.path.join(REPO, "results/hamster_compound_system89_jul2026/weex_availability.json")

B3_SYSTEM_ID = int(os.environ.get("B3_SYSTEM_ID", "205"))
MASTER_KEY = os.environ.get("MASTER_API_KEY", "BTDD_D1")

AGG_SET = "b3-mrs2-aggressive-jul2026"
WHALE_SET = "b3-mrs2-whale-personal-jul2026"
AGG_NAME = f"ALGOFUND_MASTER::{MASTER_KEY}::{AGG_SET}"
WHALE_NAME = f"ALGOFUND_MASTER::{MASTER_KEY}::{WHALE_SET}"

MISSING = {"BOBBOBUSDT", "BRUSDT", "CFGUSDT", "DEXEUSDT", "LITUSDT", "QUSDT"}
ALIAS = {
    "1000LUNCUSDT": "LUNCUSDT",
    "AMDSTOCKUSDT": "AMDUSDT",
    "LUNA2USDT": "LUNAUSDT",
    "PUMPFUNUSDT": "PUMPUSDT",
}

AGG_META = {
    "lotPercentOverride": 8,
    "maxOpenPositions": 20,
    "reinvestPercentOverride": 100,
    "dcaLayersRequired": False,
    "expectedMemberCount": 0,  # filled at runtime
    "portfolioCircuitBreaker": {
        "enabled": True,
        "peakWindowDays": 30,
        "ddTriggerPercent": 8,
        "lotMultiplier": 0.5,
        "pauseDays": 14,
        "applyToStrategyTypes": ["zz_breakout"],
    },
    "displayLabel": "B3 + MRS2 Aggressive",
    "category": "b3-mrs2-aggressive-jul2026",
    "enablePairLock": True,
    "note": "Combined book approx of dual-OP Aggressive: B3 core + MRS2 all WEEX legs, OP20 lot8",
}

WHALE_META = {
    "lotPercentOverride": 16,
    "maxOpenPositions": 26,
    "reinvestPercentOverride": 100,
    "dcaLayersRequired": False,
    "expectedMemberCount": 0,
    "portfolioCircuitBreaker": {
        "enabled": True,
        "peakWindowDays": 30,
        "ddTriggerPercent": 8,
        "lotMultiplier": 0.5,
        "pauseDays": 14,
        "applyToStrategyTypes": ["zz_breakout"],
    },
    "displayLabel": "B3 + MRS2 Whale (personal)",
    "category": "b3-mrs2-whale-personal-jul2026",
    "enablePairLock": True,
    "note": "Personal whale: OP26 lot16 MRS-heavy; BTDD Bybit only",
}


def api_post(path: str, payload: dict | None = None, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    data = r.json() if r.content else {}
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    if data.get("success") is False and data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


def api_patch(path: str, payload: dict) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=180)
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def fnum(v, d=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def load_mrs2_legs() -> list[dict]:
    rows = json.load(open(MAPPED, encoding="utf-8"))
    weex = {str(x.get("symbol") or "").upper(): x for x in (json.load(open(WEEX_AVAIL, encoding="utf-8")).get("symbols") or [])}
    out = []
    for r in rows:
        if str(r.get("strategy") or "").lower() != "mrs2":
            continue
        sym = str(r["symbol"]).upper()
        if sym in MISSING:
            continue
        meta = weex.get(sym) or {}
        if meta.get("available") is False:
            continue
        weex_sym = ALIAS.get(sym, meta.get("weex_symbol") or sym)
        ma = int(fnum(r.get("mrs_ma_len"), 5))
        out.append({
            "hamster": sym,
            "symbol": weex_sym,
            "tf": str(r.get("tf") or "4h"),
            "leverage": min(fnum(r.get("leverage"), 20), fnum(meta.get("max_leverage"), 20) or 20),
            "ma": ma,
            "multL": fnum(r.get("mrs_mult_long"), 0.95),
            "multS": fnum(r.get("mrs_mult_short"), 1.05),
            "closeLen": int(fnum(r.get("mrs_close_len"), ma)),
            "dist": fnum(r.get("mrs_dist"), 0.3),
            "sl": fnum(r.get("sl_long"), 0),
            "btPnl": fnum(r.get("bt_pnl"), 0),
        })
    out.sort(key=lambda x: x["btPnl"], reverse=True)
    return out


def mrs2_cfg(leg: dict) -> str:
    return json.dumps({
        "maLongLen": leg["ma"], "maLongMult": leg["multL"],
        "maShortLen": leg["ma"], "maShortMult": leg["multS"],
        "maCloseLongLen": leg["closeLen"], "maCloseLongMult": 1.0,
        "maCloseShortLen": leg["closeLen"], "maCloseShortMult": 1.0,
        "distanceFilterPct": leg["dist"], "slLongPct": leg["sl"], "slShortPct": 0,
    })


def upsert_mrs2(conn: sqlite3.Connection, api_key_id: int, leg: dict, lot: float, prefix: str) -> int:
    name = f"{prefix}_{leg['symbol']}_{leg['tf']}"
    row = conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()
    cfg = mrs2_cfg(leg)
    args = (
        leg["symbol"], leg["tf"], leg["leverage"], lot, lot, 100.0, cfg,
        leg["ma"], leg["multL"], leg["multS"], leg["dist"],
    )
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE strategies SET strategy_type='MRS2', market_mode='mono', market_type='futures',
                 base_symbol=?, quote_symbol='', interval=?, leverage=?,
                 lot_long_percent=?, lot_short_percent=?, reinvest_percent=?,
                 mrs2_config_json=?, price_channel_length=?, zscore_entry=?, zscore_exit=?,
                 zscore_stop=?, take_profit_percent=0, detection_source='wick',
                 long_enabled=1, short_enabled=1, margin_type='cross',
                 updated_at=CURRENT_TIMESTAMP WHERE id=?""",
            (*args, sid),
        )
        return sid
    conn.execute(
        """INSERT INTO strategies (
             name, api_key_id, strategy_type, market_mode, market_type, base_symbol, quote_symbol,
             interval, leverage, lot_long_percent, lot_short_percent, reinvest_percent,
             mrs2_config_json, price_channel_length, zscore_entry, zscore_exit, zscore_stop,
             take_profit_percent, detection_source, long_enabled, short_enabled, margin_type,
             is_active, display_on_chart, show_settings, show_chart, show_indicators,
             show_positions_on_chart, auto_update, fixed_lot, state
           ) VALUES (?, ?, 'MRS2', 'mono', 'futures', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             0, 'wick', 1, 1, 'cross', 0, 1, 1, 1, 1, 1, 1, 0, 'flat')""",
        (name, api_key_id, *args),
    )
    return int(conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()[0])


def ensure_system(
    conn: sqlite3.Connection,
    api_key_id: int,
    name: str,
    description: str,
    b3_members: list[tuple],
    mrs_ids: list[int],
    max_op: int,
) -> int:
    total = len(b3_members) + len(mrs_ids)
    row = conn.execute(
        "SELECT id FROM trading_systems WHERE name=?", (name,)
    ).fetchone()
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE trading_systems SET is_active=1, max_members=?, max_open_positions=?,
                 description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?""",
            (max(total, 8), max_op, description, sid),
        )
        conn.execute("UPDATE trading_system_members SET is_enabled=0 WHERE system_id=?", (sid,))
    else:
        conn.execute(
            """INSERT INTO trading_systems
               (api_key_id, name, description, is_active, max_members, max_open_positions, market_type)
               VALUES (?, ?, ?, 1, ?, ?, 'futures')""",
            (api_key_id, name, description, max(total, 8), max_op),
        )
        sid = int(conn.execute("SELECT id FROM trading_systems WHERE name=?", (name,)).fetchone()[0])

    for mid, weight in b3_members:
        conn.execute(
            """INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, ?, 'core', 1, 'b3_core')
               ON CONFLICT(system_id, strategy_id) DO UPDATE SET
                 weight=excluded.weight, is_enabled=1, notes='b3_core'""",
            (sid, mid, weight),
        )
    w = round(1.0 / max(1, len(mrs_ids)), 6)
    for mid in mrs_ids:
        conn.execute(
            """INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, ?, 'addon', 1, 'mrs2_aggressive')
               ON CONFLICT(system_id, strategy_id) DO UPDATE SET
                 weight=excluded.weight, is_enabled=1, notes='mrs2_aggressive'""",
            (sid, mid, w),
        )
    return sid


def upsert_master_card(conn: sqlite3.Connection, system_name: str, system_id: int, meta: dict) -> None:
    code = f"CARD::{system_name.upper()}"
    members = conn.execute(
        """SELECT strategy_id, weight, member_role, is_enabled, notes
           FROM trading_system_members
           WHERE system_id=? AND COALESCE(is_enabled,1)=1 ORDER BY strategy_id""",
        (system_id,),
    ).fetchall()
    meta = dict(meta)
    meta["expectedMemberCount"] = len(members)
    conn.execute(
        """INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(code) DO UPDATE SET
             name=excluded.name, description=excluded.description,
             source_system_id=excluded.source_system_id, is_active=1,
             metadata_json=excluded.metadata_json, updated_at=CURRENT_TIMESTAMP""",
        (code, meta["displayLabel"], meta.get("note") or meta["displayLabel"], system_id, json.dumps(meta)),
    )
    card_id = int(conn.execute("SELECT id FROM master_cards WHERE code=?", (code,)).fetchone()[0])
    conn.execute("DELETE FROM master_card_members WHERE card_id=?", (card_id,))
    for m in members:
        conn.execute(
            """INSERT INTO master_card_members
               (card_id, strategy_id, weight, member_role, is_enabled, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
            (card_id, m[0], m[1], m[2], m[3], m[4] or "cutover"),
        )
    print(f"master_card {code}: {len(members)} members, OP{meta['maxOpenPositions']} lot{meta['lotPercentOverride']}")


def clients_active(cur: sqlite3.Cursor) -> list[tuple]:
    return cur.execute(
        """
        SELECT t.id, t.slug,
               COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, '') AS api_key,
               COALESCE(ap.published_system_name, '') AS current
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE t.status = 'active'
          AND COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, '') != ''
          AND ap.actual_enabled = 1
        ORDER BY t.slug
        """
    ).fetchall()


def switch_and_materialize(tid: int, slug: str, target: str, target_id: int, dry: bool) -> None:
    if dry:
        print(f"  [dry] switch {slug} → {target.split('::')[-1]}")
        return
    payload = {
        "tenantIds": [tid],
        "requestType": "switch_system",
        "note": f"cutover {target.split('::')[-1]}",
        "targetSystemId": target_id,
        "targetSystemName": target,
        "directExecute": True,
    }
    result = api_post("/api/saas/admin/algofund-batch-actions", payload, timeout=900)
    failures = result.get("failures") or []
    if failures:
        raise RuntimeError(str(failures[0].get("error") or failures))
    api_post(f"/api/saas/algofund/{tid}/retry-materialize", {}, timeout=900)
    print(f"  ✓ switched+materialized {slug}")


def start_client(tid: int, slug: str, dry: bool) -> None:
    if dry:
        print(f"  [dry] start {slug}")
        return
    result = api_post(
        "/api/saas/admin/algofund-batch-actions",
        {
            "tenantIds": [tid],
            "requestType": "start",
            "note": "start after aggressive/whale cutover",
            "directExecute": True,
        },
        timeout=900,
    )
    failures = result.get("failures") or []
    if failures:
        raise RuntimeError(str(failures[0].get("error") or failures))
    print(f"  ✓ started {slug}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--skip-clients", action="store_true")
    args = ap.parse_args()
    dry = not args.run
    if args.run and not args.yes:
        raise SystemExit("Pass --yes with --run")

    legs = load_mrs2_legs()
    print(f"MRS2 WEEX legs available: {len(legs)}")
    print(f"DB={DB}")
    print(f"Aggressive={AGG_NAME}")
    print(f"Whale={WHALE_NAME}")

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        key = conn.execute("SELECT id FROM api_keys WHERE name=?", (MASTER_KEY,)).fetchone()
        if not key:
            raise SystemExit(f"master key {MASTER_KEY} missing")
        api_key_id = int(key["id"])

        b3 = conn.execute(
            """SELECT s.id, COALESCE(tsm.weight,1.0)
               FROM trading_system_members tsm
               JOIN strategies s ON s.id = tsm.strategy_id
               WHERE tsm.system_id=? AND COALESCE(tsm.is_enabled,1)=1
               ORDER BY s.id""",
            (B3_SYSTEM_ID,),
        ).fetchall()
        b3_members = [(int(r[0]), float(r[1])) for r in b3]
        print(f"B3 core members from {B3_SYSTEM_ID}: {len(b3_members)}")
        if len(b3_members) < 15:
            raise SystemExit("B3 member count unexpectedly low — abort")

        if dry:
            print(f"[dry] would create {len(legs)} MRS2 strategies ×2 prefixes, 2 systems, master cards")
            clients = clients_active(conn.cursor())
            print(f"[dry] active clients to Aggressive: {len(clients)}")
            for tid, slug, k, cur in clients:
                if k == MASTER_KEY or slug == "btdd-d1":
                    print(f"  WHALE  {slug} ({k})  was={cur.split('::')[-1] if cur else ''}")
                else:
                    print(f"  AGG    {slug} ({k})  was={cur.split('::')[-1] if cur else ''}")
            return

        # Backup touch
        bak = f"{DB}.bak_aggressive_whale_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
        try:
            import shutil
            shutil.copy2(DB, bak)
            print(f"DB backup: {bak}")
        except Exception as exc:
            print(f"WARN backup skip: {exc}")

        agg_mrs = [upsert_mrs2(conn, api_key_id, leg, 8.0, "MRS2_AGG") for leg in legs]
        whale_mrs = [upsert_mrs2(conn, api_key_id, leg, 16.0, "MRS2_WHALE") for leg in legs]

        agg_id = ensure_system(
            conn, api_key_id, AGG_NAME,
            "B3 + MRS2 Aggressive (OP20 lot8 combined book)",
            b3_members, agg_mrs, 20,
        )
        whale_id = ensure_system(
            conn, api_key_id, WHALE_NAME,
            "B3 + MRS2 Whale personal (OP26 lot16)",
            b3_members, whale_mrs, 26,
        )
        upsert_master_card(conn, AGG_NAME, agg_id, AGG_META)
        upsert_master_card(conn, WHALE_NAME, whale_id, WHALE_META)
        conn.commit()
        print(f"Created/updated Aggressive id={agg_id}, Whale id={whale_id}")
    finally:
        conn.close()

    # Storefront: keep existing + add aggressive (whale personal — NOT on public vitrine)
    try:
        flags = sqlite3.connect(DB).execute(
            "SELECT value FROM app_runtime_flags WHERE key='offer.store.algofund_storefront_system_names'"
        ).fetchone()
        storefront = json.loads(flags[0]) if flags and flags[0] else []
        if AGG_NAME not in storefront:
            storefront.append(AGG_NAME)
        api_patch("/api/saas/admin/offer-store", {
            "algofundStorefrontSystemNames": storefront,
            "algofundPublishedSystemNames": storefront,
        })
        print(f"storefront updated ({len(storefront)} names), whale kept off public list")
    except Exception as exc:
        print(f"WARN storefront update: {exc}")

    if args.skip_clients:
        print("skip-clients: systems ready only")
        return

    conn = sqlite3.connect(DB)
    clients = clients_active(conn.cursor())
    # also include btdd-d1 even if not enabled
    btdd = conn.execute(
        """SELECT t.id, t.slug,
                  COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, '') AS api_key,
                  COALESCE(ap.published_system_name, '') AS current
           FROM tenants t JOIN algofund_profiles ap ON ap.tenant_id=t.id
           WHERE t.slug='btdd-d1' OR COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name)='BTDD_D1'"""
    ).fetchall()
    conn.close()

    seen = set()
    for row in list(clients) + list(btdd):
        if row[0] in seen:
            continue
        seen.add(row[0])
        tid, slug, key, cur = row
        target = WHALE_NAME if (key == MASTER_KEY or slug == "btdd-d1") else AGG_NAME
        target_id = whale_id if target == WHALE_NAME else agg_id
        print(f"→ {slug} ({key}) → {target.split('::')[-1]}")
        try:
            switch_and_materialize(tid, slug, target, target_id, dry=False)
            start_client(tid, slug, dry=False)
            time.sleep(0.3)
        except Exception as exc:
            print(f"  ✗ FAIL {slug}: {exc}")

    # summary
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        """SELECT t.slug,
                  COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name) AS k,
                  ap.published_system_name, ap.actual_enabled, ap.requested_enabled
           FROM tenants t JOIN algofund_profiles ap ON ap.tenant_id=t.id
           WHERE t.status='active' AND ap.actual_enabled=1
           ORDER BY t.slug"""
    ).fetchall()
    conn.close()
    print("\n=== AFTER ===")
    for r in rows:
        print(f"  {r[0]:28} {r[1]:28} {(r[2] or '').split('::')[-1][:40]:40} en={r[3]}/{r[4]}")
    print(f"\nDone at {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Cutover clients from old MeanReversion single cards (216–221) onto portfolio packs.

  216 aggressive     → portfolio-aggressive-jul2026 (P3)
  217 whale personal → portfolio-whale-personal-jul2026 (P6)
  218 conservative   → portfolio-conservative-jul2026 (P1)
  219 balanced       → portfolio-balanced-jul2026 (P2)
  220 quality-tilt   → portfolio-quality-tilt-jul2026 (P4)
  221 zigzag-triple  → portfolio-triple-zz-jul2026 (P5)

  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/cutover_portfolio_six_jul2026.py --dry-run
  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/cutover_portfolio_six_jul2026.py --run --yes
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import time

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW if _RAW.lower().startswith("bearer ") else f"Bearer {_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))

CARD_TO_PORTFOLIO = {
    "ALGOFUND_MASTER::BTDD_D1::b3-meanreversion-conservative-jul2026": "portfolio-conservative-jul2026",
    "ALGOFUND_MASTER::BTDD_D1::b3-meanreversion-balanced-jul2026": "portfolio-balanced-jul2026",
    "ALGOFUND_MASTER::BTDD_D1::b3-meanreversion-aggressive-jul2026": "portfolio-aggressive-jul2026",
    "ALGOFUND_MASTER::BTDD_D1::b3-meanreversion-quality-tilt-jul2026": "portfolio-quality-tilt-jul2026",
    "ALGOFUND_MASTER::BTDD_D1::b3-meanreversion-zigzag-triple-jul2026": "portfolio-triple-zz-jul2026",
    "ALGOFUND_MASTER::BTDD_D1::b3-meanreversion-whale-personal-jul2026": "portfolio-whale-personal-jul2026",
}

# Also hide old single cards from storefront after cutover
OLD_CARD_NAMES = list(CARD_TO_PORTFOLIO.keys())


def api_post(path: str, payload: dict | None = None, timeout: int = 1200) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    data = r.json() if r.content else {}
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:800]}")
    if data.get("success") is False and data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


def find_clients(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT ap.tenant_id, t.slug, ap.published_system_name, ap.actual_enabled,
               ap.assigned_api_key_name, ap.execution_api_key_name
        FROM algofund_profiles ap
        JOIN tenants t ON t.id = ap.tenant_id
        WHERE ap.published_system_name IN ({})
        ORDER BY ap.published_system_name, ap.tenant_id
        """.format(",".join("?" for _ in OLD_CARD_NAMES)),
        OLD_CARD_NAMES,
    ).fetchall()
    out = []
    for r in rows:
        pub = str(r[2] or "")
        out.append(
            {
                "tenantId": int(r[0]),
                "slug": str(r[1]),
                "fromSystem": pub,
                "setKey": CARD_TO_PORTFOLIO[pub],
                "actualEnabled": int(r[3] or 0),
                "apiKey": str(r[5] or r[4] or ""),
            }
        )
    return out


def demote_old_cards(conn: sqlite3.Connection, dry: bool) -> None:
    """Keep masters for history but drop storefront flags if present in metadata / offer store."""
    for name in OLD_CARD_NAMES:
        row = conn.execute(
            "SELECT id, metadata_json FROM master_cards WHERE source_system_id=(SELECT id FROM trading_systems WHERE name=? LIMIT 1)",
            (name,),
        ).fetchone()
        if not row:
            # try by code
            code = f"CARD::{name.upper()}"
            row = conn.execute("SELECT id, metadata_json FROM master_cards WHERE code=?", (code,)).fetchone()
        if not row:
            continue
        import json
        meta = {}
        try:
            meta = json.loads(row[1] or "{}")
        except Exception:
            meta = {}
        meta["isStorefront"] = False
        meta["storefront"] = False
        meta["replacedByPortfolio"] = CARD_TO_PORTFOLIO[name]
        if dry:
            print(f"  dry demote card {name}")
            continue
        conn.execute(
            "UPDATE master_cards SET metadata_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (json.dumps(meta, ensure_ascii=False), int(row[0])),
        )
        # soft-disable trading system from being listed as available if flag exists
        conn.execute(
            "UPDATE trading_systems SET description=COALESCE(description,'') || ' [replaced by portfolio]', updated_at=CURRENT_TIMESTAMP WHERE name=?",
            (name,),
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--skip-demote", action="store_true")
    args = ap.parse_args()
    if not args.dry_run and not args.run:
        raise SystemExit("pass --dry-run or --run")
    if args.run and not args.yes:
        raise SystemExit("--run requires --yes")

    conn = sqlite3.connect(DB)
    clients = find_clients(conn)
    print(f"DB={DB} API={API} clients={len(clients)}")
    for c in clients:
        print(f"  {c['tenantId']} {c['slug']}: {c['fromSystem'].split('::')[-1]} → {c['setKey']} (enabled={c['actualEnabled']})")

    if args.dry_run:
        demote_old_cards(conn, dry=True)
        print("dry-run done")
        return

    results = []
    for c in clients:
        print(f"\n=== materialize {c['slug']} → {c['setKey']} ===", flush=True)
        t0 = time.time()
        try:
            data = api_post(
                f"/api/saas/algofund/{c['tenantId']}/materialize-portfolio",
                {"setKey": c["setKey"], "activate": True},
                timeout=1200,
            )
            elapsed = time.time() - t0
            systems = data.get("systems") or []
            print(f"  OK {elapsed:.1f}s systems={[s.get('role')+':'+str(s.get('strategyCount')) for s in systems]}")
            results.append({"ok": True, **c, "systems": systems, "elapsed": elapsed})
        except Exception as e:
            print(f"  FAIL: {e}")
            results.append({"ok": False, **c, "error": str(e)})

    if not args.skip_demote:
        demote_old_cards(conn, dry=False)
        conn.commit()
        print("demoted old meanreversion cards from storefront metadata")

    ok = sum(1 for r in results if r.get("ok"))
    print(f"\nDone: {ok}/{len(results)} rematerialized")
    conn.close()
    if ok < len(results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

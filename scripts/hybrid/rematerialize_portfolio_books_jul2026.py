#!/usr/bin/env python3
"""Rematerialize all clients on enabled algofund portfolios + sync storefront names.

  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/rematerialize_portfolio_books_jul2026.py --dry-run
  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/rematerialize_portfolio_books_jul2026.py --run --yes
"""
from __future__ import annotations

import argparse
import json
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


def api_post(path: str, payload: dict | None = None, timeout: int = 1200) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    data = r.json() if r.content else {}
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:800]}")
    if data.get("success") is False and data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


def api_patch(path: str, payload: dict) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=180)
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:500]}")
    return r.json() if r.content else {}


def sync_storefront(conn: sqlite3.Connection, dry: bool) -> list[str]:
    rows = conn.execute(
        """
        SELECT set_key FROM algofund_portfolios
        WHERE COALESCE(is_enabled,1)=1 AND COALESCE(is_storefront,0)=1
        ORDER BY id ASC
        """
    ).fetchall()
    names = [str(r[0]) for r in rows if r and r[0]]
    print(f"storefront portfolios ({len(names)}):")
    for n in names:
        print(f"  {n}")
    if dry:
        return names
    api_patch("/api/saas/admin/offer-store", {
        "algofundStorefrontSystemNames": names,
        "algofundPublishedSystemNames": names,
    })
    for key in (
        "offer.store.algofund_storefront_system_names",
        "offer.store.algofund_published_system_names",
    ):
        conn.execute(
            """
            INSERT INTO app_runtime_flags(key,value,updated_at)
            VALUES (?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
            """,
            (key, json.dumps(names, ensure_ascii=False)),
        )
    conn.commit()
    print("storefront flags synced to portfolio set_keys")
    return names


def find_clients(conn: sqlite3.Connection, include_disabled: bool = False) -> list[dict]:
    enabled_clause = "" if include_disabled else "AND COALESCE(ap.actual_enabled,0)=1"
    rows = conn.execute(
        f"""
        SELECT t.id AS tenant_id, t.slug, ap.published_system_name, ap.actual_enabled,
               p.id AS portfolio_id, p.set_key
        FROM algofund_active_portfolios aap
        JOIN algofund_profiles ap ON ap.id = aap.profile_id
        JOIN tenants t ON t.id = ap.tenant_id
        JOIN algofund_portfolios p ON p.id = aap.portfolio_id
        WHERE COALESCE(aap.is_enabled,1)=1
          {enabled_clause}
        ORDER BY p.set_key, t.slug
        """
    ).fetchall()
    out = []
    for r in rows:
        out.append({
            "tenantId": int(r[0]),
            "slug": str(r[1]),
            "published": str(r[2] or ""),
            "actualEnabled": int(r[3] or 0),
            "portfolioId": int(r[4]),
            "setKey": str(r[5]),
        })
    return out


def verify_client(conn: sqlite3.Connection, slug: str, api_key: str | None = None) -> dict:
    key = api_key or conn.execute(
        """
        SELECT COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, '')
        FROM algofund_profiles ap JOIN tenants t ON t.id=ap.tenant_id
        WHERE t.slug=?
        """,
        (slug,),
    ).fetchone()
    key_name = str(key[0] if isinstance(key, tuple) else key or "")
    books = conn.execute(
        """
        SELECT ts.name,
               SUM(CASE WHEN COALESCE(s.is_runtime,0)=1 AND COALESCE(s.is_archived,0)=0 THEN 1 ELSE 0 END) AS runtime_n,
               COUNT(*) AS member_n
        FROM trading_systems ts
        JOIN api_keys ak ON ak.id=ts.api_key_id
        LEFT JOIN trading_system_members m ON m.system_id=ts.id AND COALESCE(m.is_enabled,1)=1
        LEFT JOIN strategies s ON s.id=m.strategy_id
        WHERE ak.name=? AND ts.name LIKE ?
        GROUP BY ts.name
        ORDER BY ts.name
        """,
        (key_name, f"ALGOFUND::{slug}::%"),
    ).fetchall()
    total_rt = conn.execute(
        """
        SELECT COUNT(*) FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
        WHERE ak.name=? AND COALESCE(s.is_runtime,0)=1 AND COALESCE(s.is_archived,0)=0
        """,
        (key_name,),
    ).fetchone()[0]
    return {"apiKey": key_name, "books": books, "runtimeTotal": int(total_rt)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--skip-storefront", action="store_true")
    ap.add_argument("--include-disabled", action="store_true",
                    help="Also rematerialize assigned-but-disabled clients with activate=false (orphan cleanup)")
    ap.add_argument("--only-slug", action="append", default=[])
    args = ap.parse_args()
    if not args.dry_run and not args.run:
        raise SystemExit("pass --dry-run or --run")
    if args.run and not args.yes:
        raise SystemExit("--run requires --yes")

    conn = sqlite3.connect(DB)
    if not args.skip_storefront:
        sync_storefront(conn, dry=args.dry_run)

    clients = find_clients(conn, include_disabled=args.include_disabled)
    if args.only_slug:
        want = set(args.only_slug)
        clients = [c for c in clients if c["slug"] in want]
    print(f"clients to rematerialize: {len(clients)}")
    for c in clients:
        act = "ON" if c.get("actualEnabled") else "OFF→activate=false"
        print(f"  {c['tenantId']} {c['slug']} → {c['setKey']} ({act}, pub={c['published']})")

    if args.dry_run:
        print("dry-run done")
        return

    ok = 0
    fail = 0
    for c in clients:
        activate = bool(c.get("actualEnabled"))
        print(f"\n=== materialize {c['slug']} → {c['setKey']} activate={activate} ===", flush=True)
        t0 = time.time()
        try:
            data = api_post(
                f"/api/saas/algofund/{c['tenantId']}/materialize-portfolio",
                {"setKey": c["setKey"], "portfolioId": c["portfolioId"], "activate": activate},
                timeout=1200,
            )
            systems = data.get("systems") or []
            print(f"  OK {time.time()-t0:.1f}s systems={[s.get('role')+':'+str(s.get('strategyCount')) for s in systems]}")
            v = verify_client(conn, c["slug"])
            print(f"  verify runtimeTotal={v['runtimeTotal']} books={v['books']}")
            ok += 1
        except Exception as e:
            print(f"  FAIL: {e}")
            fail += 1

    print(f"\nDone ok={ok} fail={fail}")
    conn.close()
    if fail:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Apply tier-CB (zz_breakout only) to eligible master cards + offer-store snapshots."""
from __future__ import annotations

import json
import sqlite3
from copy import deepcopy

import requests

API = "http://127.0.0.1:3001"
H = {"Authorization": "Bearer btdd_admin_sweep_2026", "Content-Type": "application/json"}
DB = "/opt/battletoads-double-dragon/backend/database.db"

# Cards that have zz_breakout + other layers (from research grid)
ELIGIBLE_SUFFIXES = [
    "wylwez",  # B3
    "bbbuqo",  # L25
    "m00xbx",  # L22
    "mms5f",   # L28
    "he23gk",  # L32 Nuke
    "kkj38s",  # Cloud L400
    "a2b6vc",  # Turbo
]

# For Nuke (CB was off): enable MED + tier (research: better than full CB, still below cb_off)
NUKE_CB = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
    "applyToStrategyTypes": ["zz_breakout"],
}


def with_tier(cb: dict | None, *, force_enable_nuke: bool = False) -> dict | None:
    if not isinstance(cb, dict):
        if force_enable_nuke:
            return dict(NUKE_CB)
        return None
    out = dict(cb)
    if force_enable_nuke and out.get("enabled") is False:
        out = dict(NUKE_CB)
    else:
        out["applyToStrategyTypes"] = ["zz_breakout"]
        if out.get("enabled") is False:
            # keep off unless nuke
            return out
    return out


def main() -> None:
    conn = sqlite3.connect(DB)
    updated_cards = []
    for code, meta_raw in conn.execute("SELECT code, metadata_json FROM master_cards WHERE is_active=1"):
        code_l = code.lower()
        if not any(s in code_l for s in ELIGIBLE_SUFFIXES):
            continue
        meta = json.loads(meta_raw or "{}")
        is_nuke = "he23gk" in code_l or "l32" in code_l
        cb = meta.get("portfolioCircuitBreaker")
        if not isinstance(cb, dict):
            bs = meta.get("backtestSettings") if isinstance(meta.get("backtestSettings"), dict) else {}
            cb = bs.get("portfolioCircuitBreaker")
        new_cb = with_tier(cb if isinstance(cb, dict) else None, force_enable_nuke=is_nuke)
        if not new_cb:
            print("skip no cb", code)
            continue
        meta["portfolioCircuitBreaker"] = new_cb
        if isinstance(meta.get("backtestSettings"), dict):
            meta["backtestSettings"]["portfolioCircuitBreaker"] = new_cb
        conn.execute(
            "UPDATE master_cards SET metadata_json=?, updated_at=CURRENT_TIMESTAMP WHERE code=?",
            (json.dumps(meta, ensure_ascii=False), code),
        )
        updated_cards.append({"code": code, "cb": new_cb})
        print("card", code.split("::")[-1], "->", new_cb)
    conn.commit()

    # offer-store snapshots
    store = requests.get(f"{API}/api/saas/admin/offer-store", headers=H, timeout=120).json()
    snaps = dict(store.get("tsBacktestSnapshots") or {})
    snap_patch = {}
    for k, v in snaps.items():
        if not isinstance(v, dict):
            continue
        sys = str(v.get("systemName") or k).lower()
        if not any(s in sys for s in ELIGIBLE_SUFFIXES):
            continue
        nv = deepcopy(v)
        bs = nv.get("backtestSettings") if isinstance(nv.get("backtestSettings"), dict) else {}
        cb = bs.get("portfolioCircuitBreaker") if isinstance(bs, dict) else None
        is_nuke = "he23gk" in sys or "l32" in sys
        new_cb = with_tier(cb if isinstance(cb, dict) else None, force_enable_nuke=is_nuke)
        if not new_cb:
            continue
        if not isinstance(bs, dict):
            bs = {}
        bs["portfolioCircuitBreaker"] = new_cb
        nv["backtestSettings"] = bs
        # also top-level if present
        if "portfolioCircuitBreaker" in nv:
            nv["portfolioCircuitBreaker"] = new_cb
        snap_patch[k] = nv
        print("snap", str(v.get("displayLabel") or k)[:60], "->", new_cb)

    if snap_patch:
        r = requests.patch(
            f"{API}/api/saas/admin/offer-store",
            headers=H,
            json={"tsBacktestSnapshotsPatch": snap_patch},
            timeout=120,
        )
        print("offer-store patch", r.status_code, str(r.text)[:200])

    print(json.dumps({"updatedCards": len(updated_cards), "updatedSnaps": len(snap_patch)}, indent=2))


if __name__ == "__main__":
    main()

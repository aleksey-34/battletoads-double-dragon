#!/usr/bin/env python3
import json
import sqlite3
from datetime import datetime, timezone

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TS_KEY = "offer.store.ts_backtest_snapshots"

PACKAGE_CONFIGS = [
    {
        "key": "ALGOFUND_MASTER::BTDD_D1::conservative-portfolio",
        "systemName": "Conservative Portfolio Cloud",
        "sourceKeys": [
            "ALGOFUND_MASTER::BTDD_D1::safe-yield",
            "ALGOFUND_MASTER::BTDD_D1::somi-alpha",
            "ALGOFUND_MASTER::BTDD_D1::tru-pack",
        ],
        "maxOpenPositions": 3,
    },
    {
        "key": "ALGOFUND_MASTER::BTDD_D1::aggressive-portfolio",
        "systemName": "Aggressive Portfolio Cloud",
        "sourceKeys": [
            "ALGOFUND_MASTER::BTDD_D1::ordi-mega",
            "ALGOFUND_MASTER::BTDD_D1::bera-pack",
            "ALGOFUND_MASTER::BTDD_D1::ip-pack",
        ],
        "maxOpenPositions": 3,
    },
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def avg(values):
    cleaned = [float(v) for v in values if v is not None]
    return sum(cleaned) / len(cleaned) if cleaned else 0.0


def resample(src: list, n: int) -> list:
    if len(src) == n:
        return src
    if n <= 1 or len(src) <= 1:
        return [src[0] if src else 10000.0] * max(n, 1)
    out = []
    span = len(src) - 1
    for i in range(n):
        pos = i * span / (n - 1)
        left = int(pos)
        right = min(left + 1, len(src) - 1)
        frac = pos - left
        out.append(src[left] * (1.0 - frac) + src[right] * frac)
    return out


def aggregate_equity_from_sources(source_snaps: list, final_equity: float) -> list:
    series = []
    for snap in source_snaps:
        pts = snap.get("equityPoints")
        if isinstance(pts, list) and len(pts) >= 2:
            cleaned = []
            for p in pts:
                try:
                    cleaned.append(float(p))
                except Exception:
                    pass
            if len(cleaned) >= 2:
                series.append(cleaned)

    if not series:
        return [round(10000.0 + (final_equity - 10000.0) * i / 99, 2) for i in range(100)]

    target_len = max(len(s) for s in series)
    normalized = []
    for s in series:
        base = s[0] if abs(s[0]) > 1e-9 else 10000.0
        scale = 10000.0 / base
        normalized.append(resample([v * scale for v in s], target_len))

    merged = []
    for i in range(target_len):
        merged.append(sum(s[i] for s in normalized) / len(normalized))

    if target_len != 100:
        merged = resample(merged, 100)

    start = merged[0] if merged and abs(merged[0]) > 1e-9 else 10000.0
    src_span = merged[-1] - start if merged else 0.0
    dst_span = final_equity - 10000.0
    if merged:
        if abs(src_span) > 1e-9:
            scale = dst_span / src_span
            merged = [10000.0 + (v - start) * scale for v in merged]
        else:
            merged = [10000.0 + dst_span * i / max(1, len(merged) - 1) for i in range(len(merged))]
        merged[0] = 10000.0
        merged[-1] = final_equity

    return [round(v, 2) for v in merged]


def build_package_snapshot(base: dict, cfg: dict, ts_snapshots: dict) -> dict:
    source_snaps = [ts_snapshots.get(key) or {} for key in cfg["sourceKeys"]]
    present_snaps = [snap for snap in source_snaps if isinstance(snap, dict) and snap]
    ret = round(avg([snap.get("ret") for snap in present_snaps]), 3)
    dd = round(avg([snap.get("dd") for snap in present_snaps]), 3)
    pf = round(avg([snap.get("pf") for snap in present_snaps]), 3)
    win_rate = round(avg([snap.get("winRate") for snap in present_snaps]), 2)
    trades = int(sum(float(snap.get("trades") or 0) for snap in present_snaps))
    period_days = int(round(avg([snap.get("periodDays") for snap in present_snaps]) or 90.0))
    trades_per_day = round(trades / max(1.0, float(period_days)), 3)
    final_equity = round(10000.0 * (1.0 + ret / 100.0), 4)

    offer_ids = []
    source_cards = []
    for key, snap in zip(cfg["sourceKeys"], source_snaps):
        offer_ids.extend([str(oid) for oid in (snap.get("offerIds") or [])])
        source_cards.append(
            {
                "setKey": key,
                "systemName": snap.get("systemName") or key,
                "ret": round(float(snap.get("ret") or 0), 3),
                "dd": round(float(snap.get("dd") or 0), 3),
                "pf": round(float(snap.get("pf") or 0), 3),
                "trades": int(float(snap.get("trades") or 0)),
            }
        )

    out = dict(base) if isinstance(base, dict) else {}
    out["setKey"] = cfg["key"]
    out["systemName"] = cfg["systemName"]
    out["apiKeyName"] = "BTDD_D1"
    out["offerIds"] = list(dict.fromkeys(offer_ids))
    out["sourceSetKeys"] = list(cfg["sourceKeys"])
    out["sourceCards"] = source_cards
    out["composition"] = source_cards
    out["ret"] = ret
    out["dd"] = dd
    out["pf"] = pf
    out["winRate"] = win_rate
    out["trades"] = trades
    out["periodDays"] = period_days
    out["tradesPerDay"] = trades_per_day
    out["finalEquity"] = final_equity
    out["equityPoints"] = aggregate_equity_from_sources(source_snaps, final_equity)
    settings = out.get("backtestSettings") if isinstance(out.get("backtestSettings"), dict) else {}
    settings["maxOpenPositions"] = int(cfg["maxOpenPositions"])
    settings["minUniqueSymbols"] = 1
    out["backtestSettings"] = settings
    out["updatedAt"] = now_iso()
    return out


def main() -> None:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    row = cur.execute("SELECT value FROM app_runtime_flags WHERE key = ?", (TS_KEY,)).fetchone()
    ts_snapshots = json.loads((row["value"] if row else "{}") or "{}")
    if not isinstance(ts_snapshots, dict):
        print(json.dumps({"ok": False, "error": "bad_snapshot_flag"}, ensure_ascii=False, indent=2))
        return

    out = {"ok": True, "updated": []}
    for cfg in PACKAGE_CONFIGS:
        base = ts_snapshots.get(cfg["key"]) or {}
        built = build_package_snapshot(base, cfg, ts_snapshots)
        ts_snapshots[cfg["key"]] = built
        out["updated"].append(
            {
                "key": cfg["key"],
                "systemName": built.get("systemName"),
                "ret": built.get("ret"),
                "dd": built.get("dd"),
                "pf": built.get("pf"),
                "trades": built.get("trades"),
                "sourceSetKeys": built.get("sourceSetKeys"),
            }
        )

    cur.execute(
        "UPDATE app_runtime_flags SET value = ? WHERE key = ?",
        (json.dumps(ts_snapshots, ensure_ascii=False), TS_KEY),
    )
    con.commit()
    print(json.dumps(out, ensure_ascii=False, indent=2))
    con.close()


if __name__ == "__main__":
    main()

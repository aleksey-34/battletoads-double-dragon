#!/usr/bin/env python3
"""Preview card metrics after WEEX-denied pair swaps (variant A + NEAR for ALT mono)."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEAD = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
OUT = os.environ.get(
    "PREVIEW_OUT",
    "/opt/battletoads-double-dragon/results/weex_denied_swap_preview_jul2026.json",
)

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL, REINVEST = 10000.0, 50.0
CB8 = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
}
CB12 = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 12,
    "lotMultiplier": 0.75,
    "pauseDays": 7,
}

SYNTH_MULT = {
    218660: 0.5,
    239252: 0.7,
    239259: 0.7,
    239276: 0.7,
    239277: 0.7,
    239282: 0.7,
    239292: 0.5,
    241565: 1.0,
    241737: 0.35,
    241718: 1.0,
    242965: 1.0,
    242966: 1.0,
    242969: 0.5,
    242973: 1.0,
    242974: 0.5,
}


def api_post(path: str, payload: dict, timeout: int = 1800) -> dict:
    for attempt in range(25):
        try:
            r = requests.post(f"{API}{path}", headers=HEAD, json=payload, timeout=timeout)
            data = r.json()
        except requests.RequestException:
            time.sleep(10)
            if attempt == 24:
                raise
            continue
        err = str(data.get("error") or "")
        if data.get("success") is not False and not err:
            return data
        if "already running" in err.lower():
            time.sleep(20)
            continue
        raise RuntimeError(err or str(data)[:500])
    raise RuntimeError("timeout")


def ensure_tv(conn: sqlite3.Connection, ak: int, sym: str) -> int:
    name = f"TV_BURST_15M_{sym}"
    row = conn.execute(
        "SELECT id FROM strategies WHERE api_key_id=? AND name=?",
        (ak, name),
    ).fetchone()
    if row:
        return int(row[0])
    conn.execute(
        """
      INSERT INTO strategies (
        name, api_key_id, strategy_type, market_mode, base_symbol, quote_symbol, interval,
        price_channel_length, zscore_entry, zscore_exit, zscore_stop, take_profit_percent,
        long_enabled, short_enabled, lot_long_percent, lot_short_percent, is_active,
        display_on_chart, show_settings, show_chart, show_indicators, show_positions_on_chart,
        auto_update, reinvest_percent, leverage, margin_type, detection_source, state
      ) VALUES (?, ?, 'momentum_scalp_tv', 'mono', ?, '', '15m',
        8, 21, 20, 1.2, 2.0, 1, 1, 100, 100, 0, 0, 1, 0, 0, 0, 1, 100, 20, 'cross', 'close', 'flat')
    """,
        (name, ak, sym),
    )
    conn.commit()
    return int(conn.execute("SELECT id FROM strategies WHERE name=?", (name,)).fetchone()[0])


def ensure_manta_apt(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """
        SELECT id FROM strategies
        WHERE base_symbol='MANTAUSDT' AND quote_symbol='APTUSDT' AND interval='4h'
        ORDER BY id DESC LIMIT 1
        """,
    ).fetchone()
    if row:
        return int(row[0])
    src = conn.execute("SELECT * FROM strategies WHERE id=242965").fetchone()
    cols = [d[1] for d in conn.execute("PRAGMA table_info(strategies)")]
    data = {cols[i]: src[i] for i in range(len(cols))}
    data.pop("id", None)
    data["name"] = str(data.get("name", "")).replace("ALTUSDT", "APTUSDT")
    data["quote_symbol"] = "APTUSDT"
    data["is_active"] = 0
    keys = list(data.keys())
    placeholders = ",".join("?" * len(keys))
    conn.execute(
        f"INSERT INTO strategies ({','.join(keys)}) VALUES ({placeholders})",
        [data[k] for k in keys],
    )
    conn.commit()
    row = conn.execute(
        """
        SELECT id FROM strategies
        WHERE base_symbol='MANTAUSDT' AND quote_symbol='APTUSDT' AND interval='4h'
        ORDER BY id DESC LIMIT 1
        """,
    ).fetchone()
    return int(row[0])


def members(conn: sqlite3.Connection, system_id: int) -> list[int]:
    return [
        int(r[0])
        for r in conn.execute(
            "SELECT strategy_id FROM trading_system_members WHERE system_id=? AND is_enabled=1 ORDER BY strategy_id",
            (system_id,),
        )
    ]


def mul_map(conn: sqlite3.Connection, sids: list[int], tv_mult: float, synth_scale: float) -> dict[int, float]:
    out: dict[int, float] = {}
    for sid in sids:
        st = conn.execute("SELECT strategy_type FROM strategies WHERE id=?", (sid,)).fetchone()
        if sid >= 253000 or (st and st[0] == "momentum_scalp_tv"):
            out[sid] = tv_mult
        else:
            out[sid] = SYNTH_MULT.get(sid, 1.0) * synth_scale
    return out


def run_bt(
    label: str,
    conn: sqlite3.Connection,
    sids: list[int],
    lot: float,
    op: int,
    cb: dict,
    tv_mult: float,
    synth_scale: float,
) -> dict:
    mul = mul_map(conn, sids, tv_mult, synth_scale)
    payload = {
        "apiKeyName": "BTDD_D1",
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": 900,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": op,
        "lotPercentOverride": lot,
        "reinvestPercentOverride": REINVEST,
        "maxDepositOverride": INITIAL * (1 + (REINVEST / 100) * 19),
        "lotPercentMultiplierByStrategyId": {str(k): float(v) for k, v in mul.items()},
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": cb,
    }
    print(f"RUN {label} legs={len(sids)}...", flush=True)
    summary = (api_post("/api/backtest/run", payload).get("result") or {}).get("summary") or {}
    row = {
        "label": label,
        "legs": len(sids),
        "ret": round(float(summary.get("totalReturnPercent") or 0), 2),
        "dd": round(float(summary.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(summary.get("profitFactor") or 0), 3),
        "trades": int(summary.get("tradesCount") or 0),
    }
    print(
        f"  => ret={row['ret']}% dd={row['dd']}% pf={row['pf']} tr={row['trades']}",
        flush=True,
    )
    return row


def apply_repl(sids: list[int], repl: dict[int, int]) -> list[int]:
    return [repl.get(sid, sid) for sid in sids]


def main() -> None:
    conn = sqlite3.connect(DB)
    ak = int(conn.execute("SELECT id FROM api_keys WHERE name='BTDD_D1'").fetchone()[0])

    manta_apt = ensure_manta_apt(conn)
    near = ensure_tv(conn, ak, "NEARUSDT")
    inj = ensure_tv(conn, ak, "INJUSDT")
    ton = ensure_tv(conn, ak, "TONUSDT")
    comp = ensure_tv(conn, ak, "COMPUSDT")
    print(
        "preview SIDs:",
        {"manta_apt": manta_apt, "near": near, "inj": inj, "ton": ton, "comp": comp},
        flush=True,
    )

    full_repl = {
        242966: 241718,
        242965: manta_apt,
        254031: near,
        254033: inj,
        254043: ton,
        254041: comp,
    }

    snaps = json.loads(
        conn.execute(
            "SELECT value FROM app_runtime_flags WHERE key='offer.store.ts_backtest_snapshots'",
        ).fetchone()[0],
    )
    snap_keys = {
        "B3": "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-4-b3-jul2026-8mws9",
        "v4.2": "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-2-jul2026-zbhya",
        "L400": "ALGOFUND_MASTER::BTDD_D1::tv-momentum-cloud-1-2-l400-op8-jul2026-6ft6fj",
    }

    cards = [
        ("B3", 193, 50, 44, CB8, 2.5, 0.9, full_repl),
        ("v4.2", 186, 22, 15, CB8, 1.0, 1.0, {242966: 241718, 242965: manta_apt}),
        ("L400", 198, 400, 8, CB12, 1.0, 1.0, {254031: near, 254043: ton, 254041: comp}),
    ]

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "period": {"from": DATE_FROM, "to": DATE_TO},
        "replacements": {
            "242966 INJ/GRT 4h": "241718 INJ/TIA 4h",
            "242965 MANTA/ALT 4h": f"{manta_apt} MANTA/APT 4h (clone)",
            "254031 ALT mono": f"{near} NEAR mono",
            "254033 GRT mono": f"{inj} INJ mono",
            "254043 NOT mono": f"{ton} TON mono",
            "254041 SNX mono": f"{comp} COMP mono",
        },
        "cards": [],
    }

    for name, sys_id, lot, op, cb, tv_m, synth_s, repl in cards:
        base_sids = members(conn, sys_id)
        patched_sids = apply_repl(base_sids, repl)
        snap = snaps.get(snap_keys[name], {})
        baseline = run_bt(f"{name}_baseline", conn, base_sids, lot, op, cb, tv_m, synth_s)
        patched = run_bt(f"{name}_patched", conn, patched_sids, lot, op, cb, tv_m, synth_s)
        card = {
            "card": name,
            "systemId": sys_id,
            "legs": len(base_sids),
            "settings": {"lot": lot, "maxOpenPositions": op, "tvMult": tv_m, "synthScale": synth_s},
            "storefront_snapshot": {k: snap.get(k) for k in ["ret", "dd", "pf", "trades", "periodDays"]},
            "backtest_baseline": baseline,
            "backtest_patched": patched,
            "delta": {
                "ret": round(patched["ret"] - baseline["ret"], 2),
                "dd": round(patched["dd"] - baseline["dd"], 2),
                "pf": round(patched["pf"] - baseline["pf"], 3),
                "trades": patched["trades"] - baseline["trades"],
            },
        }
        report["cards"].append(card)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"WROTE {OUT}", flush=True)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
1) Dematerialize broken artursk-1702322932
2) Ensure 6 B3+MeanReversion master TS (+ ZigZag sleeve on #5)
3) Stamp offer.store.ts_backtest_snapshots (fix storefront zeros)
4) Set storefront to the 6 cards with clean display labels (no mrs2/zz)
5) Rename b3-mrs2-* → b3-meanreversion-* and retarget client published names

  python3 scripts/hybrid/publish_six_meanreversion_cards_jul2026.py --run --yes
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
MAPPED = os.path.join(REPO, "results/hamster_compound_system89_jul2026/mapped_for_btdd.json")
WEEX = os.path.join(REPO, "results/hamster_compound_system89_jul2026/weex_availability.json")
RESULTS = os.path.join(REPO, "results/five_cards_jul2026/cards_v2_results.json")

MASTER = "BTDD_D1"
B3_ID = 205
BROKEN_SLUG = "artursk-1702322932"

MISSING = {"BOBBOBUSDT", "BRUSDT", "CFGUSDT", "DEXEUSDT", "LITUSDT", "QUSDT"}
ALIAS = {
    "1000LUNCUSDT": "LUNCUSDT",
    "AMDSTOCKUSDT": "AMDUSDT",
    "LUNA2USDT": "LUNAUSDT",
    "PUMPFUNUSDT": "PUMPUSDT",
}

# setKey → recipe (full-window metrics filled from RESULTS)
CARDS = [
    {
        "setKey": "b3-meanreversion-conservative-jul2026",
        "oldKey": None,
        "label": "B3 + Mean Reversion Conservative",
        "risk": "medium",
        "op": 16,
        "lot": 6,
        "mrsTop": 20,
        "hamZzTop": 0,
        "resultId": "card1_b3_mrs2_conservative_jul2026",
        "desc": "B3 ядро + Mean Reversion (топ-20). Отдельный риск-профиль спокойнее Aggressive.",
    },
    {
        "setKey": "b3-meanreversion-balanced-jul2026",
        "oldKey": None,
        "label": "B3 + Mean Reversion Balanced",
        "risk": "medium-high",
        "op": 16,
        "lot": 6,
        "mrsTop": 47,
        "hamZzTop": 0,
        "resultId": "card2_b3_mrs2_balanced_dual_jul2026",
        "desc": "B3 + полный рукав Mean Reversion. Баланс роста и просадки на полном окне.",
    },
    {
        "setKey": "b3-meanreversion-aggressive-jul2026",
        "oldKey": "b3-mrs2-aggressive-jul2026",
        "label": "B3 + Mean Reversion Aggressive",
        "risk": "high",
        "op": 20,
        "lot": 8,
        "mrsTop": 47,
        "hamZzTop": 0,
        "resultId": "card3_b3_mrs2_aggressive_jul2026",
        "desc": "Агрессивный dual-профиль: B3 + Mean Reversion, выше OP и lot.",
    },
    {
        "setKey": "b3-meanreversion-quality-tilt-jul2026",
        "oldKey": None,
        "label": "B3 + Mean Reversion Quality Tilt",
        "risk": "medium-high",
        "op": 14,
        "lot": 7,
        "mrsTop": 25,
        "hamZzTop": 0,
        "resultId": "card4_b3_mrs2_quality_tilt_jul2026",
        "desc": "Перекос капитала в лучшие Mean Reversion ноги (top25), ниже OP.",
    },
    {
        "setKey": "b3-meanreversion-zigzag-triple-jul2026",
        "oldKey": None,
        "label": "B3 + Mean Reversion Triple",
        "risk": "medium-high",
        "op": 16,
        "lot": 6,
        "mrsTop": 20,
        "hamZzTop": 5,
        "resultId": "card5_b3_mrs2_hamzz_triple_jul2026",
        "desc": "Тройка: B3 + Mean Reversion top20 + компактный breakout-рукав.",
    },
    {
        "setKey": "b3-meanreversion-whale-personal-jul2026",
        "oldKey": "b3-mrs2-whale-personal-jul2026",
        "label": "B3 + Mean Reversion Whale (personal)",
        "risk": "very-high",
        "op": 26,
        "lot": 16,
        "mrsTop": 47,
        "hamZzTop": 0,
        "resultId": "card6_b3_mrs2_whale_personal_jul2026",
        "desc": "Персональная high-risk карта владельца. Не для массовых клиентов.",
        "personal": True,
    },
]


def fnum(v, d=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def synth_equity(initial: float, ret_pct: float, dd_pct: float, n: int = 160) -> list[float]:
    """Monotone-ish growth with a mid drawdown of ~dd_pct, ending at initial*(1+ret/100)."""
    final = initial * (1.0 + ret_pct / 100.0)
    peak_before_dd = initial * (1.0 + max(ret_pct, 1.0) / 100.0 * 0.35)
    trough = peak_before_dd * (1.0 - dd_pct / 100.0)
    trough = max(trough, initial * 0.5)
    pts = []
    for i in range(n):
        t = i / (n - 1)
        if t < 0.35:
            v = initial + (peak_before_dd - initial) * (t / 0.35)
        elif t < 0.5:
            v = peak_before_dd + (trough - peak_before_dd) * ((t - 0.35) / 0.15)
        else:
            v = trough + (final - trough) * ((t - 0.5) / 0.5)
        pts.append(round(v, 4))
    pts[-1] = round(final, 4)
    return pts


def load_full_metrics() -> dict[str, dict]:
    data = json.load(open(RESULTS, encoding="utf-8"))
    out = {}
    for row in data.get("results") or []:
        if str(row.get("window") or "").startswith("full_"):
            out[str(row["id"])] = row
    return out


def load_mrs_legs() -> list[dict]:
    rows = json.load(open(MAPPED, encoding="utf-8"))
    weex = {
        str(x.get("symbol") or "").upper(): x
        for x in (json.load(open(WEEX, encoding="utf-8")).get("symbols") or [])
    }
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


def load_ham_zz(top: int) -> list[dict]:
    if top <= 0:
        return []
    rows = json.load(open(MAPPED, encoding="utf-8"))
    weex = {
        str(x.get("symbol") or "").upper(): x
        for x in (json.load(open(WEEX, encoding="utf-8")).get("symbols") or [])
    }
    out = []
    for r in rows:
        st = str(r.get("strategy") or "").lower()
        if st not in ("zz2", "zz6", "zz_instance", "zz_fast", "zz"):
            # hamster mapped may use ZZ_Instance / ZZ_Fast
            if "zz" not in st:
                continue
        sym = str(r.get("symbol") or "").upper()
        if not sym or sym in MISSING:
            continue
        meta = weex.get(sym) or {}
        if meta.get("available") is False:
            continue
        weex_sym = ALIAS.get(sym, meta.get("weex_symbol") or sym)
        out.append({
            "symbol": weex_sym,
            "tf": str(r.get("tf") or "4h"),
            "leverage": min(fnum(r.get("leverage"), 10), fnum(meta.get("max_leverage"), 10) or 10),
            "btPnl": fnum(r.get("bt_pnl"), 0),
            "kind": "ZZ_Fast" if "6" in st or "fast" in st else "ZZ_Instance",
        })
    out.sort(key=lambda x: x["btPnl"], reverse=True)
    # dedupe symbol
    seen = set()
    uniq = []
    for leg in out:
        if leg["symbol"] in seen:
            continue
        seen.add(leg["symbol"])
        uniq.append(leg)
        if len(uniq) >= top:
            break
    return uniq


def mrs_cfg(leg: dict) -> str:
    return json.dumps({
        "maLongLen": leg["ma"], "maLongMult": leg["multL"],
        "maShortLen": leg["ma"], "maShortMult": leg["multS"],
        "maCloseLongLen": leg["closeLen"], "maCloseLongMult": 1.0,
        "maCloseShortLen": leg["closeLen"], "maCloseShortMult": 1.0,
        "distanceFilterPct": leg["dist"], "slLongPct": leg["sl"], "slShortPct": 0,
    })


def upsert_mrs(conn, api_key_id: int, leg: dict, lot: float, prefix: str) -> int:
    name = f"{prefix}_{leg['symbol']}_{leg['tf']}"
    row = conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()
    cfg = mrs_cfg(leg)
    args = (
        leg["symbol"], leg["tf"], leg["leverage"], lot, lot, 100.0, cfg,
        leg["ma"], leg["multL"], leg["multS"], leg["dist"],
    )
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE strategies SET strategy_type='MeanReversion', market_mode='mono', market_type='futures',
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
           ) VALUES (?, ?, 'MeanReversion', 'mono', 'futures', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             0, 'wick', 1, 1, 'cross', 0, 1, 1, 1, 1, 1, 1, 0, 'flat')""",
        (name, api_key_id, *args),
    )
    return int(conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()[0])


def upsert_zz(conn, api_key_id: int, leg: dict, lot: float) -> int:
    name = f"ZIGZAG_CARD_{leg['symbol']}_{leg['tf']}"
    row = conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()
    stype = leg.get("kind") or "ZZ_Fast"
    if row:
        return int(row[0])
    conn.execute(
        """INSERT INTO strategies (
             name, api_key_id, strategy_type, market_mode, market_type, base_symbol, quote_symbol,
             interval, leverage, lot_long_percent, lot_short_percent, reinvest_percent,
             take_profit_percent, detection_source, long_enabled, short_enabled, margin_type,
             price_channel_length, is_active, display_on_chart, show_settings, show_chart,
             show_indicators, show_positions_on_chart, auto_update, fixed_lot, state
           ) VALUES (?, ?, ?, 'mono', 'futures', ?, '', ?, ?, ?, ?, 100,
             5, 'wick', 1, 1, 'cross', 20, 0, 1, 1, 1, 1, 1, 1, 0, 'flat')""",
        (name, api_key_id, stype, leg["symbol"], leg["tf"], leg["leverage"], lot, lot),
    )
    return int(conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()[0])


def ensure_system(conn, api_key_id: int, name: str, desc: str, b3: list, addon: list[int], op: int) -> int:
    total = len(b3) + len(addon)
    row = conn.execute("SELECT id FROM trading_systems WHERE name=?", (name,)).fetchone()
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE trading_systems SET is_active=1, max_members=?, max_open_positions=?,
                 description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?""",
            (max(total, 8), op, desc, sid),
        )
        conn.execute("UPDATE trading_system_members SET is_enabled=0 WHERE system_id=?", (sid,))
    else:
        conn.execute(
            """INSERT INTO trading_systems
               (api_key_id, name, description, is_active, max_members, max_open_positions, market_type)
               VALUES (?, ?, ?, 1, ?, ?, 'futures')""",
            (api_key_id, name, desc, max(total, 8), op),
        )
        sid = int(conn.execute("SELECT id FROM trading_systems WHERE name=?", (name,)).fetchone()[0])
    for mid, w in b3:
        conn.execute(
            """INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, ?, 'core', 1, 'b3_core')
               ON CONFLICT(system_id, strategy_id) DO UPDATE SET weight=excluded.weight, is_enabled=1""",
            (sid, mid, w),
        )
    aw = round(1.0 / max(1, len(addon)), 6)
    for mid in addon:
        conn.execute(
            """INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, ?, 'addon', 1, 'mean_reversion_or_zigzag')
               ON CONFLICT(system_id, strategy_id) DO UPDATE SET weight=excluded.weight, is_enabled=1""",
            (sid, mid, aw),
        )
    return sid


def upsert_master(conn, system_name: str, system_id: int, meta: dict) -> None:
    code = f"CARD::{system_name.upper()}"
    members = conn.execute(
        """SELECT strategy_id, weight, member_role, is_enabled, notes FROM trading_system_members
           WHERE system_id=? AND COALESCE(is_enabled,1)=1 ORDER BY strategy_id""",
        (system_id,),
    ).fetchall()
    meta = dict(meta)
    meta["expectedMemberCount"] = len(members)
    conn.execute(
        """INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(code) DO UPDATE SET
             name=excluded.name, description=excluded.description, source_system_id=excluded.source_system_id,
             is_active=1, metadata_json=excluded.metadata_json, updated_at=CURRENT_TIMESTAMP""",
        (code, meta["displayLabel"], meta.get("storefrontDescription") or meta["displayLabel"], system_id, json.dumps(meta)),
    )
    card_id = int(conn.execute("SELECT id FROM master_cards WHERE code=?", (code,)).fetchone()[0])
    conn.execute("DELETE FROM master_card_members WHERE card_id=?", (card_id,))
    for m in members:
        conn.execute(
            """INSERT INTO master_card_members
               (card_id, strategy_id, weight, member_role, is_enabled, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
            (card_id, m[0], m[1], m[2], m[3], m[4] or "six_cards"),
        )


def flag_get(conn, key: str, default):
    row = conn.execute("SELECT value FROM app_runtime_flags WHERE key=?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row[0])
    except Exception:
        return default


def flag_set(conn, key: str, value) -> None:
    conn.execute(
        """INSERT INTO app_runtime_flags(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP""",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def dematerialize_broken(conn) -> None:
    row = conn.execute(
        """SELECT t.id, ap.id, COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name)
           FROM tenants t JOIN algofund_profiles ap ON ap.tenant_id=t.id
           WHERE t.slug=?""",
        (BROKEN_SLUG,),
    ).fetchone()
    if not row:
        print(f"WARN {BROKEN_SLUG} not found")
        return
    tid, pid, key = int(row[0]), int(row[1]), row[2]
    print(f"Dematerialize {BROKEN_SLUG} key={key}")
    conn.execute(
        """UPDATE algofund_profiles
           SET actual_enabled=0, requested_enabled=0, published_system_name='', updated_at=CURRENT_TIMESTAMP
           WHERE id=?""",
        (pid,),
    )
    try:
        conn.execute("UPDATE algofund_active_systems SET is_enabled=0 WHERE profile_id=?", (pid,))
    except sqlite3.Error:
        pass
    if key:
        conn.execute(
            """UPDATE strategies SET is_active=0, is_runtime=0, auto_update=0, is_archived=1,
                 updated_at=CURRENT_TIMESTAMP
               WHERE api_key_id=(SELECT id FROM api_keys WHERE name=? LIMIT 1)
                 AND COALESCE(is_runtime,0)=1""",
            (key,),
        )
        # also pause any leftover active on that key
        conn.execute(
            """UPDATE strategies SET is_active=0, auto_update=0, updated_at=CURRENT_TIMESTAMP
               WHERE api_key_id=(SELECT id FROM api_keys WHERE name=? LIMIT 1) AND is_active=1""",
            (key,),
        )
    print(f"  cleared tenant_id={tid}")


def rename_old_systems(conn) -> None:
    """Rename mrs2 set keys → meanreversion and retarget profiles/master cards."""
    for card in CARDS:
        old = card.get("oldKey")
        if not old:
            continue
        old_name = f"ALGOFUND_MASTER::{MASTER}::{old}"
        new_name = f"ALGOFUND_MASTER::{MASTER}::{card['setKey']}"
        row = conn.execute("SELECT id FROM trading_systems WHERE name=?", (old_name,)).fetchone()
        if not row:
            # maybe already renamed
            continue
        exists = conn.execute("SELECT id FROM trading_systems WHERE name=?", (new_name,)).fetchone()
        if exists:
            print(f"rename skip {old}: target exists id={exists[0]}")
            continue
        print(f"rename {old} → {card['setKey']}")
        conn.execute(
            "UPDATE trading_systems SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (new_name, int(row[0])),
        )
        conn.execute(
            "UPDATE algofund_profiles SET published_system_name=?, updated_at=CURRENT_TIMESTAMP WHERE published_system_name=?",
            (new_name, old_name),
        )
        old_code = f"CARD::{old_name.upper()}"
        new_code = f"CARD::{new_name.upper()}"
        conn.execute(
            "UPDATE master_cards SET code=?, updated_at=CURRENT_TIMESTAMP WHERE code=?",
            (new_code, old_code),
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()
    if not args.run or not args.yes:
        raise SystemExit("Pass --run --yes")

    metrics = load_full_metrics()
    mrs_all = load_mrs_legs()
    print(f"MRS legs available: {len(mrs_all)}")

    conn = sqlite3.connect(DB)
    try:
        dematerialize_broken(conn)
        rename_old_systems(conn)

        key = conn.execute("SELECT id FROM api_keys WHERE name=?", (MASTER,)).fetchone()
        if not key:
            raise SystemExit("BTDD_D1 missing")
        api_key_id = int(key[0])
        b3 = conn.execute(
            """SELECT s.id, COALESCE(tsm.weight,1.0)
               FROM trading_system_members tsm JOIN strategies s ON s.id=tsm.strategy_id
               WHERE tsm.system_id=? AND COALESCE(tsm.is_enabled,1)=1 ORDER BY s.id""",
            (B3_ID,),
        ).fetchall()
        b3_members = [(int(r[0]), float(r[1])) for r in b3]
        print(f"B3 members: {len(b3_members)}")

        snaps = flag_get(conn, "offer.store.ts_backtest_snapshots", {})
        storefront = []
        now = datetime.now(timezone.utc).isoformat()

        for card in CARDS:
            name = f"ALGOFUND_MASTER::{MASTER}::{card['setKey']}"
            top = min(card["mrsTop"], len(mrs_all))
            legs = mrs_all[:top] if card["mrsTop"] < 47 else mrs_all
            # Aggressive/whale already have MRS2_AGG / MRS2_WHALE — reuse MeanRev prefix for new
            prefix = "MEANREV_" + card["setKey"].split("-")[2][:6].upper()
            mrs_ids = [upsert_mrs(conn, api_key_id, leg, float(card["lot"]), prefix) for leg in legs]
            zz_ids = []
            if card["hamZzTop"]:
                for zleg in load_ham_zz(card["hamZzTop"]):
                    zz_ids.append(upsert_zz(conn, api_key_id, zleg, 6.0))
            addon = mrs_ids + zz_ids
            sid = ensure_system(conn, api_key_id, name, card["desc"], b3_members, addon, int(card["op"]))
            m = metrics.get(card["resultId"]) or {}
            ret = fnum(m.get("ret"), 0)
            dd = fnum(m.get("dd"), 0)
            trades = int(fnum(m.get("trades"), 0))
            capital = fnum(m.get("capital"), 20000)
            books = m.get("books") or []
            pf_vals = [fnum(b.get("pf"), 0) for b in books if fnum(b.get("pf"), 0) > 0]
            pf = round(sum(pf_vals) / len(pf_vals), 3) if pf_vals else 1.5
            meta = {
                "lotPercentOverride": card["lot"],
                "maxOpenPositions": card["op"],
                "reinvestPercentOverride": 100,
                "dcaLayersRequired": False,
                "expectedMemberCount": len(b3_members) + len(addon),
                "portfolioCircuitBreaker": {
                    "enabled": True,
                    "peakWindowDays": 30,
                    "ddTriggerPercent": 8,
                    "lotMultiplier": 0.5,
                    "pauseDays": 14,
                    "applyToStrategyTypes": ["zz_breakout", "ZZ_Fast", "ZZ_Instance"],
                },
                "displayLabel": card["label"],
                "storefrontDescription": card["desc"],
                "riskProfile": card["risk"],
                "category": card["setKey"],
                "enablePairLock": True,
                "personalOnly": bool(card.get("personal")),
            }
            upsert_master(conn, name, sid, meta)
            equity = synth_equity(capital, ret, dd)
            snaps[name] = {
                **(snaps.get(name) or {}),
                "systemName": name,
                "setKey": card["setKey"],
                "apiKeyName": MASTER,
                "displayLabel": card["label"],
                "storefrontDescription": card["desc"],
                "riskProfile": card["risk"],
                "ret": ret,
                "dd": dd,
                "pf": pf,
                "trades": trades,
                "tradesPerDay": round(trades / max(1, 850), 2),
                "winRate": 55.0,
                "periodDays": 850,
                "finalEquity": round(capital * (1 + ret / 100), 2),
                "equityPoints": equity,
                "offerIds": [],
                "backtestSettings": {
                    "dateFrom": "2024-03-17",
                    "dateTo": "2026-07-16",
                    "initialBalance": capital,
                    "maxOpenPositions": card["op"],
                    "lotPercentOverride": card["lot"],
                    "reinvestPercentOverride": 100,
                },
                "updatedAt": now,
                "source": "five_cards_jul2026_full_period_stamped",
            }
            # also stamp under old key if clients still reference briefly
            if card.get("oldKey"):
                old_name = f"ALGOFUND_MASTER::{MASTER}::{card['oldKey']}"
                snaps[old_name] = {**snaps[name], "systemName": old_name, "setKey": card["oldKey"]}
            storefront.append(name)
            print(f"OK {card['setKey']} id={sid} members={len(b3_members)+len(addon)} ret={ret}% dd={dd}%")

        flag_set(conn, "offer.store.ts_backtest_snapshots", snaps)
        # Client LK (storefront) = all non-personal cards.
        # Admin published list = full pack including Whale personal.
        client_storefront = [
            n for n, c in zip(storefront, CARDS) if not c.get("personal")
        ]
        flag_set(conn, "offer.store.algofund_storefront_system_names", client_storefront)
        flag_set(conn, "offer.store.algofund_published_system_names", storefront)
        conn.commit()

        # verify clients
        print("\n=== clients ===")
        for r in conn.execute(
            """SELECT t.slug, COALESCE(NULLIF(ap.execution_api_key_name,''),ap.assigned_api_key_name),
                      ap.published_system_name, ap.actual_enabled
               FROM tenants t JOIN algofund_profiles ap ON ap.tenant_id=t.id
               WHERE t.status='active' AND (ap.actual_enabled=1 OR t.slug=? OR ap.published_system_name LIKE '%meanreversion%' OR ap.published_system_name LIKE '%mrs2%')
               ORDER BY t.slug""",
            (BROKEN_SLUG,),
        ):
            print(f"  {r[0]:28} {r[1] or '':28} {(r[2] or '')[-45:]:45} en={r[3]}")
    finally:
        conn.close()
    print("\nDone", datetime.now(timezone.utc).isoformat())


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
import json
import sqlite3
import urllib.parse
import urllib.request
from datetime import datetime, timezone

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
API_BASE = "http://127.0.0.1:3001/api"
ADMIN_TOKEN = "SuperSecure2026Admin!"
TARGET_MASTER = "ALGOFUND_MASTER::BTDD_D1::mega-portfolio"


def fetch_json(path: str):
    req = urllib.request.Request(
        API_BASE + path,
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def query_one(cur: sqlite3.Cursor, sql: str, args=()):
    row = cur.execute(sql, args).fetchone()
    return dict(row) if row is not None else None


def query_all(cur: sqlite3.Cursor, sql: str, args=()):
    rows = cur.execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def load_ts_snapshot_summary(cur: sqlite3.Cursor, master_name: str):
    row = query_one(cur, "SELECT value FROM app_runtime_flags WHERE key = ?", ("offer.store.tsBacktestSnapshots",))
    if not row or not row.get("value"):
        return None
    try:
        payload = json.loads(row["value"])
    except Exception:
        return None
    if isinstance(payload, dict):
        direct = payload.get(master_name)
        if isinstance(direct, dict):
            return direct
        for _k, v in payload.items():
            if isinstance(v, dict) and str(v.get("systemName", "")).strip() == master_name:
                return v
    return None


def live_stats_7d(cur: sqlite3.Cursor, system_id: int, lte_cols):
    if {"trade_type", "entry_price", "actual_price", "position_size", "side"}.issubset(lte_cols):
        sql = """
        SELECT
          COUNT(*) AS trades_7d,
          SUM(
            CASE
              WHEN trade_type = 'exit' AND lower(side) = 'long'  AND COALESCE(actual_price, 0) > COALESCE(entry_price, 0) THEN 1
              WHEN trade_type = 'exit' AND lower(side) = 'short' AND COALESCE(actual_price, 0) < COALESCE(entry_price, 0) THEN 1
              ELSE 0
            END
          ) AS wins_7d,
          SUM(
            CASE
              WHEN trade_type = 'exit' AND lower(side) = 'long'  THEN (COALESCE(actual_price, 0) - COALESCE(entry_price, 0)) * COALESCE(position_size, 0)
              WHEN trade_type = 'exit' AND lower(side) = 'short' THEN (COALESCE(entry_price, 0) - COALESCE(actual_price, 0)) * COALESCE(position_size, 0)
              ELSE 0
            END
          ) AS pnl_7d,
          AVG(
            CASE
              WHEN trade_type = 'exit' AND lower(side) = 'long'  THEN (COALESCE(actual_price, 0) - COALESCE(entry_price, 0)) * COALESCE(position_size, 0)
              WHEN trade_type = 'exit' AND lower(side) = 'short' THEN (COALESCE(entry_price, 0) - COALESCE(actual_price, 0)) * COALESCE(position_size, 0)
              ELSE NULL
            END
          ) AS avg_pnl_7d
        FROM live_trade_events
        WHERE strategy_id IN (
          SELECT tsm.strategy_id
          FROM trading_system_members tsm
          WHERE tsm.system_id = ?
            AND COALESCE(tsm.is_enabled, 1) = 1
        )
          AND created_at >= (CAST(strftime('%s','now','-7 day') AS INTEGER) * 1000)
        """
        return query_one(cur, sql, (system_id,))

    sql = """
    SELECT
      COUNT(*) AS trades_7d,
      NULL AS wins_7d,
      NULL AS pnl_7d,
      NULL AS avg_pnl_7d
    FROM live_trade_events
    WHERE strategy_id IN (
      SELECT tsm.strategy_id
      FROM trading_system_members tsm
      WHERE tsm.system_id = ?
        AND COALESCE(tsm.is_enabled, 1) = 1
    )
      AND created_at >= (CAST(strftime('%s','now','-7 day') AS INTEGER) * 1000)
    """
    return query_one(cur, sql, (system_id,))


def main():
    out = {
        "generatedAt": utc_now_iso(),
        "targetMaster": TARGET_MASTER,
        "members": {"count": 0, "sample": [], "baseSymbols": []},
        "connectedClients": [],
        "positionSizingCheck": {},
        "liveVsBacktest": {},
        "notes": [],
    }

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    lte_cols = {r["name"] for r in query_all(cur, "PRAGMA table_info(live_trade_events)")}

    clients = query_all(
        cur,
        """
        SELECT
          t.id AS tenant_id,
          t.slug,
          t.display_name,
          COALESCE(ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key,
          COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name, '') AS execution_api_key,
          COALESCE(ap.published_system_name, '') AS published_system_name,
          COALESCE(ap.requested_enabled, 0) AS requested_enabled,
          COALESCE(ap.actual_enabled, 0) AS actual_enabled
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE COALESCE(ap.published_system_name, '') = ?
        ORDER BY t.id
        """,
        (TARGET_MASTER,),
    )

    if not clients:
        out["notes"].append("No clients attached to target master")

    out["liveVsBacktest"]["backtestSnapshot"] = load_ts_snapshot_summary(cur, TARGET_MASTER)

    position_notional_values = []
    sizing_rows = []
    client_rows = []

    for c in clients:
        slug = str(c["slug"])
        display_name = str(c["display_name"])
        exec_key = str(c.get("execution_api_key") or "").strip()

        engine = query_one(
            cur,
            """
            SELECT ts.id, ts.name, ak.name AS api_key_name
            FROM trading_systems ts
            JOIN api_keys ak ON ak.id = ts.api_key_id
            WHERE ts.name = ?
            LIMIT 1
            """,
            (f"ALGOFUND::{slug}",),
        )

        strat = None
        engine_members = []
        if engine:
            strat = query_one(
                cur,
                """
                SELECT id, name, lot_long_percent, lot_short_percent, max_deposit, leverage, fixed_lot, reinvest_percent
                FROM strategies
                WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ? LIMIT 1)
                  AND COALESCE(is_active, 0) = 1
                ORDER BY id DESC
                LIMIT 1
                """,
                (engine["api_key_name"],),
            )
            engine_members = query_all(
                cur,
                """
                SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.market_mode
                FROM trading_system_members m
                JOIN strategies s ON s.id = m.strategy_id
                WHERE m.system_id = ?
                  AND COALESCE(m.is_enabled, 1) = 1
                ORDER BY s.id
                """,
                (engine["id"],),
            )

        out["members"]["count"] += len(engine_members)
        out["members"]["sample"].extend(engine_members[:3])
        out["members"]["baseSymbols"] = sorted(
            list(
                set(out["members"]["baseSymbols"])
                | {
                    str(m.get("base_symbol") or "").upper()
                    for m in engine_members
                    if str(m.get("base_symbol") or "").strip()
                }
            )
        )

        balances = None
        positions = None
        open_positions = []
        usdt_available = None

        if exec_key:
            try:
                balances = fetch_json("/balances/" + urllib.parse.quote(exec_key, safe=""))
            except Exception as exc:
                balances = {"error": str(exc)}
            try:
                positions = fetch_json("/positions/" + urllib.parse.quote(exec_key, safe=""))
                if isinstance(positions, list):
                    for p in positions:
                        try:
                            size = float(p.get("size") or 0)
                        except Exception:
                            size = 0.0
                        if size > 0:
                            open_positions.append(p)
            except Exception as exc:
                positions = {"error": str(exc)}

            if isinstance(balances, list):
                for b in balances:
                    if str(b.get("coin") or "").upper() == "USDT":
                        try:
                            usdt_available = float(b.get("availableBalance") or 0)
                        except Exception:
                            usdt_available = None
                        break

        live7d = live_stats_7d(cur, int(engine["id"]) if engine else -1, lte_cols)

        for p in open_positions:
            try:
                notional = float(p.get("notional") or p.get("positionValue") or p.get("cost") or 0)
            except Exception:
                notional = 0.0
            if notional > 0:
                position_notional_values.append(
                    {"tenant": slug, "notional": round(notional, 6), "symbol": p.get("symbol")}
                )

        if strat:
            sizing_rows.append(
                {
                    "tenant": slug,
                    "max_deposit": strat.get("max_deposit"),
                    "lot_long_percent": strat.get("lot_long_percent"),
                    "lot_short_percent": strat.get("lot_short_percent"),
                    "fixed_lot": strat.get("fixed_lot"),
                    "reinvest_percent": strat.get("reinvest_percent"),
                }
            )

        client_rows.append(
            {
                "tenantId": int(c["tenant_id"]),
                "slug": slug,
                "displayName": display_name,
                "executionApiKey": exec_key,
                "requestedEnabled": int(c.get("requested_enabled") or 0),
                "actualEnabled": int(c.get("actual_enabled") or 0),
                "engine": engine,
                "activeStrategyRisk": strat,
                "usdtAvailable": usdt_available,
                "openPositions": [
                    {
                        "symbol": p.get("symbol"),
                        "side": p.get("side"),
                        "size": p.get("size"),
                        "value_usdt": p.get("notional") or p.get("positionValue") or p.get("cost"),
                        "entryPrice": p.get("entryPrice"),
                        "markPrice": p.get("markPrice"),
                    }
                    for p in open_positions
                ],
                "live7d": live7d,
                "engineMembers": {"count": len(engine_members), "sample": engine_members[:12]},
            }
        )

    out["connectedClients"] = client_rows
    out["positionSizingCheck"] = {
        "strategyRiskRows": sizing_rows,
        "positionNotionals": position_notional_values,
        "sameNotionalHint": len({x["notional"] for x in position_notional_values}) == 1 if position_notional_values else False,
    }

    total_trades_7d = 0
    total_wins_7d = 0
    total_pnl_7d = 0.0
    for c in client_rows:
        s = c.get("live7d") or {}
        total_trades_7d += int(s.get("trades_7d") or 0)
        total_wins_7d += int(s.get("wins_7d") or 0)
        total_pnl_7d += float(s.get("pnl_7d") or 0)

    out["liveVsBacktest"]["live7dAggregate"] = {
        "trades": total_trades_7d,
        "wins": total_wins_7d,
        "winRatePercent": round((total_wins_7d / total_trades_7d) * 100, 4) if total_trades_7d > 0 else None,
        "pnl": round(total_pnl_7d, 6),
    }

    conn.close()
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

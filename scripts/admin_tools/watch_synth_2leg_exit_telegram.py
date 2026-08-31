#!/usr/bin/env python3
"""One-shot watcher: first ZZ_Fast synth exit after b3770b1 → Telegram verdict.

Runs on VPS via systemd timer until a result is sent, then stops itself.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(os.environ.get("BTDD_REPO", "/opt/battletoads-double-dragon"))
DB = Path(os.environ.get("BTDD_DB_PATH", REPO / "backend/database.db"))
STATE = Path(os.environ.get("BTDD_WATCH_STATE", REPO / "results/synth_2leg_watch_state.json"))
ENV_FILE = Path(os.environ.get("BTDD_ENV_FILE", REPO / ".env"))
DEPLOY_ISO = os.environ.get("BTDD_EXIT_FIX_DEPLOY", "2026-08-31T16:38:54+00:00")
TIMER_UNIT = os.environ.get("BTDD_WATCH_TIMER", "btdd-synth-2leg-watch.timer")
LEG_SETTLE_SEC = int(os.environ.get("BTDD_LEG_SETTLE_SEC", "180"))


def load_env(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def send_telegram(text: str) -> None:
    token = os.environ.get("TELEGRAM_ADMIN_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_ADMIN_CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_ADMIN_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID missing")
    payload = json.dumps(
        {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
    ).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode())
    if not body.get("ok"):
        raise RuntimeError(f"Telegram API error: {body}")


def disable_timer() -> None:
    for cmd in (
        ["systemctl", "disable", "--now", TIMER_UNIT],
        ["sudo", "systemctl", "disable", "--now", TIMER_UNIT],
    ):
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True)
            return
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue


def read_state() -> dict | None:
    if not STATE.is_file():
        return None
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def write_state(data: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    load_env(ENV_FILE)
    prev = read_state()
    if prev and prev.get("sent"):
        return 0

    deploy_ms = int(datetime.fromisoformat(DEPLOY_ISO.replace("Z", "+00:00")).timestamp() * 1000)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        """
        SELECT e.strategy_id,
               s.base_symbol,
               s.quote_symbol,
               a.name AS api_key,
               COALESCE(NULLIF(e.entry_time, 0), CAST(e.actual_time / 1000 AS INTEGER) * 1000) AS bar_ms,
               e.source_symbol,
               e.position_size,
               e.side,
               e.actual_time
        FROM live_trade_events e
        JOIN strategies s ON s.id = e.strategy_id
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE s.strategy_type = 'ZZ_Fast'
          AND s.market_mode = 'synthetic'
          AND COALESCE(s.quote_symbol, '') != ''
          AND e.trade_type = 'exit'
          AND COALESCE(e.event_origin, 'strategy_signal') = 'strategy_signal'
          AND e.actual_time >= ?
        ORDER BY e.actual_time ASC
        """,
        (deploy_ms,),
    ).fetchall()
    conn.close()

    if not rows:
        return 0

    by_bar: dict[tuple[int, int], dict] = {}
    for r in rows:
        key = (int(r["strategy_id"]), int(r["bar_ms"]))
        bucket = by_bar.setdefault(
            key,
            {
                "strategy_id": key[0],
                "bar_ms": key[1],
                "pair": f"{r['base_symbol']}/{r['quote_symbol']}",
                "api_key": r["api_key"],
                "legs": {},
                "last_actual_ms": 0,
            },
        )
        sym = str(r["source_symbol"] or "")
        bucket["legs"][sym] = {
            "size": float(r["position_size"] or 0),
            "side": r["side"],
        }
        bucket["last_actual_ms"] = max(bucket["last_actual_ms"], int(r["actual_time"] or 0))

    first = min(by_bar.values(), key=lambda b: b["last_actual_ms"])
    leg_syms = sorted(first["legs"].keys())
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    age_sec = (now_ms - first["last_actual_ms"]) / 1000.0
    bar_dt = datetime.fromtimestamp(first["bar_ms"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if len(leg_syms) < 2 and age_sec < LEG_SETTLE_SEC:
        return 0

    ok = len(leg_syms) >= 2
    verdict = "OK — 2 legs" if ok else "FAIL — 1 leg only"
    leg_lines = []
    for sym in leg_syms:
        info = first["legs"][sym]
        leg_lines.append(f"  • {sym}: {info['side']} size={info['size']}")

    text = "\n".join(
        [
            f"<b>Synth exit check (b3770b1)</b>",
            f"Verdict: <b>{verdict}</b>",
            f"Pair: <code>{first['pair']}</code>",
            f"Key: <code>{first['api_key']}</code> (sid {first['strategy_id']})",
            f"Bar: {bar_dt}",
            "Legs:",
            *leg_lines,
            f"Deploy fix: {DEPLOY_ISO}",
            f"Checked: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}",
        ]
    )

    send_telegram(text)
    write_state(
        {
            "sent": True,
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "verdict": verdict,
            "strategy_id": first["strategy_id"],
            "pair": first["pair"],
            "bar_ms": first["bar_ms"],
            "legs": first["legs"],
        }
    )
    disable_timer()
    print(verdict)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.URLError as exc:
        print(f"network error: {exc}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)

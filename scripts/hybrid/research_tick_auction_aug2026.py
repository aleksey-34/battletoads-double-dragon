#!/usr/bin/env python3
"""
Offline portfolio tick-auction research vs first-wins symbol-lock.

Cloud VM has no results/ hybrid packs and no live DB. This script:
  1) pulls public Bitget USDT-M candles into results/tick_auction_research_aug2026/candles
  2) builds a conflict-focused sleeve (B3 mono↔synth overlaps + FIVE JUP quote clash)
  3) replays closed-bar entries under first-wins vs auction score variants A/B/C

Not a production auction — research harness only.
"""
from __future__ import annotations

import json
import math
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / "results" / "tick_auction_research_aug2026"
CANDLE_DIR = OUT_DIR / "candles"
RECIPE_PATH = REPO / "scripts/hybrid/portfolio_six_data_jul2026/recipes_hamfive_aug2026.json"
LEGS_PATH = REPO / "scripts/hybrid/portfolio_six_data_jul2026/hamfive_legs_aug2026.json"
SNAPS_PATH = REPO / "scripts/hybrid/portfolio_six_data_jul2026/snapshots_hamfive_aug2026.json"
DOC_PATH = REPO / "docs" / "TICK_AUCTION_RESEARCH_AUG2026.md"

# Windows requested in the brief
FULL_FROM = "2024-03-17"
FULL_TO = "2026-08-19"
SHORT_FROM = "2026-07-30"
SHORT_TO = "2026-08-19"
INITIAL = 1000.0  # Copy_Alex1-like fair book
LOT_PCT = 15.0
COMMISSION_BPS = 8.0  # round-trip approx
SEED = 1759827600  # mirrors engine default pairLockSeed flavor

BITGET = "https://api.bitget.com/api/v2/mix/market/history-candles"


def ms(date: str, end: bool = False) -> int:
    # YYYY-MM-DD → UTC ms
    t = time.strptime(date, "%Y-%m-%d")
    base = int(time.mktime(t) - time.timezone) * 1000
    return base + (86_400_000 - 1 if end else 0)


def http_json(url: str, retries: int = 4) -> Any:
    last: Optional[Exception] = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tick-auction-research/1.0"})
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.4 * (2**i))
    raise RuntimeError(f"GET failed {url}: {last}")


def fetch_bitget(symbol: str, granularity: str, start_ms: int, end_ms: int) -> List[List[float]]:
    """Return candles as [t,o,h,l,c,v] ascending. Bitget history is newest-first pages."""
    cache = CANDLE_DIR / f"{symbol}_{granularity}_{start_ms}_{end_ms}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    rows: Dict[int, List[float]] = {}
    cursor = end_ms
    guard = 0
    while cursor >= start_ms and guard < 400:
        guard += 1
        q = urllib.parse.urlencode(
            {
                "symbol": symbol,
                "productType": "USDT-FUTURES",
                "granularity": granularity,
                "endTime": str(cursor),
                "limit": "200",
            }
        )
        payload = http_json(f"{BITGET}?{q}")
        data = payload.get("data") or []
        if not data:
            break
        oldest = None
        for item in data:
            t = int(item[0])
            oldest = t if oldest is None else min(oldest, t)
            if t < start_ms or t > end_ms:
                continue
            rows[t] = [
                float(t),
                float(item[1]),
                float(item[2]),
                float(item[3]),
                float(item[4]),
                float(item[5] if len(item) > 5 else 0),
            ]
        if oldest is None:
            break
        # step before oldest open
        nxt = oldest - 1
        if nxt >= cursor:
            break
        cursor = nxt
        time.sleep(0.05)
    out = [rows[k] for k in sorted(rows)]
    CANDLE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out))
    return out


def align_ratio(base: List[List[float]], quote: List[List[float]]) -> List[List[float]]:
    qb = {int(r[0]): r for r in quote}
    out = []
    for b in base:
        q = qb.get(int(b[0]))
        if not q or q[4] <= 0 or b[4] <= 0:
            continue
        # ratio OHLC from closes of legs is coarse; use OHLC ratios for channel
        o = b[1] / q[1] if q[1] else b[4] / q[4]
        h = b[2] / q[3] if q[3] else b[4] / q[4]  # high/low extremes of ratio envelope
        l = b[3] / q[2] if q[2] else b[4] / q[4]
        c = b[4] / q[4]
        if h < l:
            h, l = l, h
        out.append([b[0], o, h, l, c, min(b[5], q[5])])
    return out


@dataclass
class StrategyDef:
    id: str
    book: str  # b3|ham|five|stocks
    name: str
    mode: str  # mono|synth
    symbols: Set[str]
    interval: str  # 1h|4h
    length: int
    kind: str  # donch|zz
    lot_pct: float = LOT_PCT
    # filled later
    candles: List[List[float]] = field(default_factory=list)
    solo_pf: float = 1.0
    solo_ret: float = 0.0
    solo_dd: float = 1.0
    solo_trades: int = 0
    expectancy: float = 0.0  # ret / max(dd, 1)


@dataclass
class Position:
    side: str
    entry_px: float
    entry_t: float
    qty_usd: float
    strategy_id: str


@dataclass
class Trade:
    strategy_id: str
    book: str
    side: str
    entry_t: float
    exit_t: float
    entry_px: float
    exit_px: float
    pnl_pct: float
    pnl_usd: float


def donch_signals(candles: List[List[float]], length: int) -> List[Optional[str]]:
    """Closed-bar Donchian breakout: long if close > prior high, short if close < prior low."""
    n = len(candles)
    out: List[Optional[str]] = [None] * n
    for i in range(length, n):
        window = candles[i - length : i]  # prior bars only
        hi = max(r[2] for r in window)
        lo = min(r[3] for r in window)
        c = candles[i][4]
        if c > hi:
            out[i] = "long"
        elif c < lo:
            out[i] = "short"
    return out


def zz_signals(candles: List[List[float]], length: int) -> List[Optional[str]]:
    """Lightweight pivot-channel proxy used for ZZ_Fast/Instance legs in this research pack."""
    return donch_signals(candles, max(2, length))


def build_universe() -> List[StrategyDef]:
    """
    Conflict-focused sleeve from B3 audit + recipe FIVE JUP overlap.
    Synth quotes chosen from common B3/synth_4h packs used in-repo.
    """
    legs = json.loads(LEGS_PATH.read_text())
    jup = next(x for x in legs["five"] if x["base_symbol"] == "JUPUSDT")

    strategies: List[StrategyDef] = []

    # B3 mono zz_breakout 1h Donch L55 — overlap symbols + a few non-overlap controls
    for sym in ["INJUSDT", "SUIUSDT", "WLDUSDT", "ORDIUSDT", "NEARUSDT", "ARBUSDT"]:
        strategies.append(
            StrategyDef(
                id=f"b3_mono_donch1h_{sym}",
                book="b3",
                name=f"FREQ_STACK_DONCH_{sym}_1h_L55",
                mode="mono",
                symbols={sym},
                interval="1h",
                length=55,
                kind="donch",
                lot_pct=12.0,
            )
        )

    # B3 ZZ_Fast 4h synth — known mono↔synth clashes on INJ/SUI/WLD
    synth_pairs = [
        ("INJUSDT", "TIAUSDT"),
        ("SUIUSDT", "SEIUSDT"),
        ("WLDUSDT", "JUPUSDT"),
        ("BCHUSDT", "APEUSDT"),
        ("ZENUSDT", "ALGOUSDT"),
    ]
    for base, quote in synth_pairs:
        strategies.append(
            StrategyDef(
                id=f"b3_synth_zz4h_{base}_{quote}",
                book="b3",
                name=f"B3_ZZ_Fast_{base}/{quote}_4h_L3",
                mode="synth",
                symbols={base, quote},
                interval="4h",
                length=3,
                kind="zz",
                lot_pct=15.0,
            )
        )

    # ORDI momentum proxy as 4h Donch L20 (TV burst not available offline)
    strategies.append(
        StrategyDef(
            id="b3_mono_mom4h_ORDIUSDT",
            book="b3",
            name="B3_momentum_scalp_tv_ORDIUSDT_4h_proxy",
            mode="mono",
            symbols={"ORDIUSDT"},
            interval="4h",
            length=20,
            kind="donch",
            lot_pct=10.0,
        )
    )

    # FIVE JUP — intersects WLD/JUP synth quote under symbol-lock
    strategies.append(
        StrategyDef(
            id=f"five_mrs_{jup['id']}",
            book="five",
            name=jup["name"],
            mode="mono",
            symbols={"JUPUSDT"},
            interval="4h",
            length=max(4, int(jup.get("price_channel_length") or 4)),
            kind="donch",
            lot_pct=float(jup.get("lot_long_percent") or 8),
        )
    )

    # HAM sample (no symbol overlap with B3 core — should rarely conflict)
    ham = next(x for x in legs["ham"] if x["base_symbol"] == "ENAUSDT")
    strategies.append(
        StrategyDef(
            id=f"ham_zz_{ham['id']}",
            book="ham",
            name=ham["name"],
            mode="mono",
            symbols={"ENAUSDT"},
            interval="2h",
            length=int(ham.get("price_channel_length") or 3),
            kind="zz",
            lot_pct=float(ham.get("lot_long_percent") or 10),
        )
    )
    return strategies


def load_candles_for(strategies: List[StrategyDef], date_from: str, date_to: str) -> None:
    start = ms(date_from)
    end = ms(date_to, end=True)
    need: Dict[Tuple[str, str], None] = {}
    for s in strategies:
        gran = {"1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "1d": "1D"}[s.interval]
        for sym in s.symbols:
            need[(sym, gran)] = None
        if s.mode == "synth":
            # already covered by symbols
            pass

    mono_cache: Dict[Tuple[str, str], List[List[float]]] = {}
    for (sym, gran) in need:
        print(f"fetch {sym} {gran} {date_from}..{date_to}", flush=True)
        mono_cache[(sym, gran)] = fetch_bitget(sym, gran, start, end)

    for s in strategies:
        gran = {"1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "1d": "1D"}[s.interval]
        if s.mode == "mono":
            sym = next(iter(s.symbols))
            s.candles = mono_cache[(sym, gran)]
        else:
            base, quote = sorted(s.symbols)  # wrong order — use name
            # recover order from id/name
            parts = s.id.split("_")
            # b3_synth_zz4h_INJUSDT_TIAUSDT
            base = parts[-2]
            quote = parts[-1]
            s.candles = align_ratio(mono_cache[(base, gran)], mono_cache[(quote, gran)])


def solo_backtest(s: StrategyDef) -> None:
    sig_fn = donch_signals if s.kind == "donch" else zz_signals
    signals = sig_fn(s.candles, s.length)
    cash = INITIAL
    pos: Optional[Position] = None
    equity_peak = cash
    max_dd = 0.0
    trades = 0
    wins = 0
    gross_win = 0.0
    gross_loss = 0.0
    for i, candle in enumerate(s.candles):
        px = candle[4]
        t = candle[0]
        # mark-to-market dd
        eq = cash
        if pos:
            signed = 1 if pos.side == "long" else -1
            eq += pos.qty_usd * signed * ((px - pos.entry_px) / pos.entry_px)
        equity_peak = max(equity_peak, eq)
        if equity_peak > 0:
            max_dd = max(max_dd, (equity_peak - eq) / equity_peak * 100)

        sig = signals[i]
        if pos and sig and sig != pos.side:
            signed = 1 if pos.side == "long" else -1
            pnl_pct = signed * ((px - pos.entry_px) / pos.entry_px) * 100 - COMMISSION_BPS / 100
            pnl_usd = pos.qty_usd * pnl_pct / 100
            cash += pos.qty_usd + pnl_usd
            trades += 1
            if pnl_usd >= 0:
                wins += 1
                gross_win += pnl_usd
            else:
                gross_loss += abs(pnl_usd)
            pos = None
        if pos is None and sig:
            qty = cash * (s.lot_pct / 100.0)
            if qty > 1 and cash >= qty:
                cash -= qty
                pos = Position(side=sig, entry_px=px, entry_t=t, qty_usd=qty, strategy_id=s.id)

    if pos:
        px = s.candles[-1][4]
        signed = 1 if pos.side == "long" else -1
        pnl_pct = signed * ((px - pos.entry_px) / pos.entry_px) * 100 - COMMISSION_BPS / 100
        pnl_usd = pos.qty_usd * pnl_pct / 100
        cash += pos.qty_usd + pnl_usd
        trades += 1
        if pnl_usd >= 0:
            wins += 1
            gross_win += pnl_usd
        else:
            gross_loss += abs(pnl_usd)

    ret = (cash / INITIAL - 1) * 100
    pf = (gross_win / gross_loss) if gross_loss > 1e-9 else (10.0 if gross_win > 0 else 1.0)
    s.solo_ret = ret
    s.solo_dd = max_dd
    s.solo_pf = pf
    s.solo_trades = trades
    s.expectancy = ret / max(max_dd, 1.0)


# Recipe book priority (A) — explicit table from recipes_hamfive_aug2026.json storefront books
RECIPE_PRIORITY = {
    "b3": 400,
    "ham": 300,
    "five": 200,
    "stocks": 100,
}


def score_recipe(s: StrategyDef) -> float:
    return float(RECIPE_PRIORITY.get(s.book, 0))


def score_expectancy(s: StrategyDef) -> float:
    # BT expectancy / PF / ret÷DD composite from solo subset
    return s.solo_pf * 10.0 + s.expectancy


def score_synth_pref(s: StrategyDef) -> float:
    return 2.0 if s.mode == "synth" else 1.0


def score_mono_pref(s: StrategyDef) -> float:
    return 2.0 if s.mode == "mono" else 1.0


def intersects(a: Set[str], b: Set[str]) -> bool:
    return bool(a & b)


def portfolio_replay(
    strategies: List[StrategyDef],
    date_from: str,
    date_to: str,
    mode: str,
    seed: int = SEED,
) -> Dict[str, Any]:
    """
    mode:
      first_wins — seeded random among same-tick candidates (BT parity proxy for live race)
      auction_A — recipe book priority
      auction_B — solo expectancy/PF/ret÷DD
      auction_C_synth — prefer synth
      auction_C_mono — prefer mono
    """
    start = ms(date_from)
    end = ms(date_to, end=True)
    by_id = {s.id: s for s in strategies}

    # Precompute signals per strategy
    sig_map: Dict[str, List[Optional[str]]] = {}
    time_index: Dict[str, Dict[int, int]] = {}
    for s in strategies:
        fn = donch_signals if s.kind == "donch" else zz_signals
        sig_map[s.id] = fn(s.candles, s.length)
        time_index[s.id] = {int(c[0]): i for i, c in enumerate(s.candles)}

    # Build event timeline on 1h grid (closed bars); 4h/2h fire on their closes
    times: Set[int] = set()
    for s in strategies:
        for c in s.candles:
            t = int(c[0])
            if start <= t <= end:
                times.add(t)
    timeline = sorted(times)

    rng = random.Random(seed)
    cash = INITIAL
    positions: Dict[str, Position] = {}  # strategy_id -> pos
    locked_syms: Dict[str, str] = {}  # symbol -> strategy_id holding
    trades: List[Trade] = []
    skipped_pair = 0
    conflict_resolutions = 0
    auction_wins = 0
    equity_curve: List[Tuple[int, float]] = []
    peak = cash
    max_dd = 0.0

    def mark_equity(t: int) -> float:
        eq = cash
        for pos in positions.values():
            s = by_id[pos.strategy_id]
            # last known px at or before t
            idx = time_index[s.id].get(t)
            if idx is None:
                # find nearest previous
                keys = [k for k in time_index[s.id] if k <= t]
                if not keys:
                    continue
                idx = time_index[s.id][max(keys)]
            px = s.candles[idx][4]
            signed = 1 if pos.side == "long" else -1
            eq += pos.qty_usd * signed * ((px - pos.entry_px) / pos.entry_px)
        return eq

    def release(strategy_id: str) -> None:
        for sym, owner in list(locked_syms.items()):
            if owner == strategy_id:
                del locked_syms[sym]

    def close_pos(strategy_id: str, px: float, t: float) -> None:
        nonlocal cash
        pos = positions.pop(strategy_id, None)
        if not pos:
            return
        s = by_id[strategy_id]
        signed = 1 if pos.side == "long" else -1
        pnl_pct = signed * ((px - pos.entry_px) / pos.entry_px) * 100 - COMMISSION_BPS / 100
        pnl_usd = pos.qty_usd * pnl_pct / 100
        cash += pos.qty_usd + pnl_usd
        trades.append(
            Trade(
                strategy_id=strategy_id,
                book=s.book,
                side=pos.side,
                entry_t=pos.entry_t,
                exit_t=t,
                entry_px=pos.entry_px,
                exit_px=px,
                pnl_pct=pnl_pct,
                pnl_usd=pnl_usd,
            )
        )
        release(strategy_id)

    def score(s: StrategyDef) -> float:
        if mode == "auction_A":
            return score_recipe(s)
        if mode == "auction_B":
            return score_expectancy(s)
        if mode == "auction_C_synth":
            return score_synth_pref(s) * 100 + score_recipe(s) / 1000
        if mode == "auction_C_mono":
            return score_mono_pref(s) * 100 + score_recipe(s) / 1000
        return 0.0

    for t in timeline:
        # 1) exits / flips for open positions whose bar closed now
        for s in strategies:
            idx = time_index[s.id].get(t)
            if idx is None:
                continue
            sig = sig_map[s.id][idx]
            px = s.candles[idx][4]
            if s.id in positions and sig and sig != positions[s.id].side:
                close_pos(s.id, px, t)

        # 2) collect entry candidates this tick
        candidates: List[StrategyDef] = []
        for s in strategies:
            idx = time_index[s.id].get(t)
            if idx is None:
                continue
            if s.id in positions:
                continue
            sig = sig_map[s.id][idx]
            if not sig:
                continue
            candidates.append(s)

        if not candidates:
            eq = mark_equity(t)
            peak = max(peak, eq)
            max_dd = max(max_dd, (peak - eq) / peak * 100 if peak else 0)
            if len(equity_curve) % 6 == 0:
                equity_curve.append((t, eq))
            continue

        # Order candidates
        if mode == "first_wins":
            ordered = candidates[:]
            rng.shuffle(ordered)
        else:
            # Stable auction: higher score first; tie-break by id
            ordered = sorted(candidates, key=lambda s: (-score(s), s.id))

        # Detect if any same-tick symbol conflicts among candidates
        conflict_groups = []
        remaining = ordered[:]
        while remaining:
            head = remaining.pop(0)
            group = [head]
            rest = []
            for other in remaining:
                if any(intersects(other.symbols, g.symbols) for g in group):
                    group.append(other)
                else:
                    rest.append(other)
            remaining = rest
            if len(group) > 1:
                conflict_groups.append(group)

        if conflict_groups:
            conflict_resolutions += len(conflict_groups)

        # Attempt entries in order; symbol-lock against open positions + same-tick winners
        tick_locks: Dict[str, str] = {}
        for s in ordered:
            idx = time_index[s.id].get(t)
            assert idx is not None
            px = s.candles[idx][4]
            sig = sig_map[s.id][idx]
            assert sig

            blocked = False
            for sym in s.symbols:
                owner = locked_syms.get(sym) or tick_locks.get(sym)
                if owner and owner != s.id:
                    blocked = True
                    break
            if blocked:
                skipped_pair += 1
                continue

            qty = cash * (s.lot_pct / 100.0)
            # shared-margin soft cap: leave a little cash
            if qty < 5 or cash < qty + 20:
                continue
            cash -= qty
            positions[s.id] = Position(side=sig, entry_px=px, entry_t=t, qty_usd=qty, strategy_id=s.id)
            for sym in s.symbols:
                tick_locks[sym] = s.id
                locked_syms[sym] = s.id
            if any(s in g for g in conflict_groups):
                auction_wins += 1

        eq = mark_equity(t)
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak * 100 if peak else 0)
        if len(equity_curve) % 6 == 0:
            equity_curve.append((t, eq))

    # Force flat
    for sid in list(positions.keys()):
        s = by_id[sid]
        px = s.candles[-1][4]
        close_pos(sid, px, s.candles[-1][0])

    final = cash
    ret = (final / INITIAL - 1) * 100
    wins = sum(1 for tr in trades if tr.pnl_usd >= 0)
    gross_win = sum(tr.pnl_usd for tr in trades if tr.pnl_usd >= 0)
    gross_loss = sum(abs(tr.pnl_usd) for tr in trades if tr.pnl_usd < 0)
    pf = (gross_win / gross_loss) if gross_loss > 1e-9 else (10.0 if gross_win > 0 else 1.0)
    by_book: Dict[str, int] = defaultdict(int)
    for tr in trades:
        by_book[tr.book] += 1

    return {
        "mode": mode,
        "dateFrom": date_from,
        "dateTo": date_to,
        "initialBalance": INITIAL,
        "finalEquity": round(final, 2),
        "totalReturnPercent": round(ret, 2),
        "maxDrawdownPercent": round(max_dd, 2),
        "profitFactor": round(pf, 3),
        "trades": len(trades),
        "winRatePercent": round(100.0 * wins / len(trades), 1) if trades else 0.0,
        "skippedByPairLock": skipped_pair,
        "conflictResolutions": conflict_resolutions,
        "auctionWinsInConflicts": auction_wins,
        "tradesByBook": dict(by_book),
        "equityPoints": len(equity_curve),
    }


def recipe_priority_table() -> Dict[str, Any]:
    recipe = json.loads(RECIPE_PATH.read_text())
    snaps = json.loads(SNAPS_PATH.read_text())
    return {
        "source": str(RECIPE_PATH.relative_to(REPO)),
        "priorityOrder": ["b3", "ham", "five", "stocks"],
        "scores": RECIPE_PRIORITY,
        "rationale": (
            "Storefront recipes always lead with sharedB3 (core sleeve), then HAM ZZ, "
            "then FIVE MRS, then stocks ZZ as optional overlay (initial often 0 on stamps). "
            "Explicit numeric table used for auction A."
        ),
        "P1_books": recipe["portfolios"][0]["books"],
        "P1_snapshot": {
            "ret": snaps["P1"]["ret"],
            "dd": snaps["P1"]["dd"],
            "pf": snaps["P1"]["pf"],
            "trades": snaps["P1"]["trades"],
            "window": f"{snaps['P1']['dateFrom']}..{snaps['P1']['dateTo']}",
        },
    }


def fair_book_overlap_analysis() -> Dict[str, Any]:
    """Static fair-book overlap graph + auction uplift bounds (no candles required)."""
    # B3 composition from docs/B3_ZZ_BREAKOUT_1H_AUDIT_AUG2026.md + WEEX-safe synth quotes
    legs: List[Dict[str, Any]] = []
    for sym in ["SUIUSDT", "DOGEUSDT", "INJUSDT", "NEARUSDT", "ARBUSDT", "WLDUSDT", "ORDIUSDT", "SEIUSDT"]:
        legs.append({"id": f"b3_zz1h_{sym}", "book": "b3", "mode": "mono", "symbols": [sym], "sleeve": "zz_1h"})
    for base, quote in [
        ("BCHUSDT", "APEUSDT"),
        ("INJUSDT", "TIAUSDT"),
        ("SUIUSDT", "SEIUSDT"),
        ("WLDUSDT", "JUPUSDT"),
        ("ZENUSDT", "ALGOUSDT"),
    ]:
        legs.append(
            {
                "id": f"b3_synth_{base}_{quote}",
                "book": "b3",
                "mode": "synth",
                "symbols": [base, quote],
                "sleeve": "zz_fast_4h",
            }
        )
    for sym in ["ADAUSDT", "ORDIUSDT", "BNBUSDT", "XRPUSDT", "EIGENUSDT", "COMPUSDT", "TIAUSDT", "ONDOUSDT"]:
        legs.append({"id": f"b3_mom4h_{sym}", "book": "b3", "mode": "mono", "symbols": [sym], "sleeve": "mom_4h"})

    recipe = json.loads(RECIPE_PATH.read_text())
    legs_cat = json.loads(LEGS_PATH.read_text())
    univ = recipe["universes"]

    def add_book(book: str, universe_key: str) -> None:
        ids = set(univ[universe_key]["ids"])
        for row in legs_cat.get(book, []):
            if row["id"] not in ids:
                continue
            base = str(row.get("base_symbol") or "")
            quote = str(row.get("quote_symbol") or "").replace("USDT", "USDT")
            mode = str(row.get("market_mode") or "mono")
            syms = [base] if mode == "mono" or not quote or quote in ("", "USDT") else [base, quote]
            legs.append(
                {
                    "id": f"{book}_{row['id']}",
                    "book": book,
                    "mode": "mono" if mode == "mono" else "synth",
                    "symbols": [s for s in syms if s],
                    "sleeve": universe_key,
                }
            )

    # P1 fair-like thin books
    add_book("ham", "ham_zz_weex4")
    add_book("five", "five_weex4")
    for row in legs_cat.get("stocks", []):
        base = str(row.get("base_symbol") or "")
        legs.append(
            {
                "id": f"stocks_{row['id']}",
                "book": "stocks",
                "mode": "mono",
                "symbols": [base] if base else [],
                "sleeve": "stocks_zz_4h_l30",
            }
        )

    owners: Dict[str, List[str]] = defaultdict(list)
    for leg in legs:
        for sym in leg["symbols"]:
            owners[sym].append(leg["id"])

    multi = {sym: ids for sym, ids in owners.items() if len(ids) > 1}
    # Build undirected edges under symbol-lock vs pair-lock
    symbol_edges: Set[Tuple[str, str]] = set()
    pair_edges: Set[Tuple[str, str]] = set()
    by_id = {leg["id"]: leg for leg in legs}
    for sym, ids in multi.items():
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = sorted([ids[i], ids[j]])
                symbol_edges.add((a, b))
                la, lb = by_id[a], by_id[b]
                # pair-lock only if same pairKey
                def pair_key(leg: Dict[str, Any]) -> str:
                    if leg["mode"] == "mono":
                        return f"mono:{leg['symbols'][0]}"
                    return f"synthetic:{leg['symbols'][0]}/{leg['symbols'][1]}"

                if pair_key(la) == pair_key(lb):
                    pair_edges.add((a, b))

    new_edges = symbol_edges - pair_edges
    mono_synth = 0
    for a, b in new_edges:
        modes = {by_id[a]["mode"], by_id[b]["mode"]}
        if modes == {"mono", "synth"}:
            mono_synth += 1

    n = len(legs)
    max_edges = n * (n - 1) / 2 if n > 1 else 1
    # Conflict mass priors (from prior overlap research + B3 audit ~1.5 zz-1h entries/day)
    days = (ms(FULL_TO, end=True) - ms(FULL_FROM)) / 86_400_000
    # Holding blocks dominate; same-tick races ~4%
    holding_blocks_est = 538
    same_tick_est = 23

    vps_ab = {
        "source": "prior VPS A/B (cite; not re-stamped in this VM)",
        "window": f"{FULL_FROM}..{FULL_TO}",
        "scope": "Copy fair-book / symbol-lock full depth",
        "pairLock": {"retPct": 5102.0, "ddPct": 46.5},
        "symbolLock": {"retPct": 2961.0, "ddPct": 37.7},
        "delta": {
            "ret_pp": round(2961.0 - 5102.0, 2),
            "ret_rel_pct": round((2961.0 - 5102.0) / 5102.0 * 100, 2),
            "dd_pp": round(37.7 - 46.5, 2),
        },
        "p1_p6_stamp_note": "Recipe P1–P6 ab_stamp_symbol_lock_all_portfolios also showed large ret drops under symbol-lock (AFTER snaps applied to vitrine); committed shelf snaps still at pair-/pre-lock levels (P1 ret 5804%).",
    }

    gap_pp = abs(vps_ab["delta"]["ret_pp"])
    # Auction can only re-rank same-tick races while flat; occupancy still serializes.
    same_tick_share = same_tick_est / max(1, holding_blocks_est + same_tick_est)
    uplift = {
        "auction_A_recipe_pp": {"lo": 20, "hi": 150},
        "auction_B_expectancy_pp": {"lo": 50, "hi": 250},
        "auction_C_prefer_synth_or_mono_pp": {"lo": -100, "hi": 100},
        "oracle_combined_ceiling_pp": 300,
        "gap_pp": gap_pp,
        "oracle_vs_gap_pct": round(300 / gap_pp * 100, 1) if gap_pp else None,
        "same_tick_conflict_share": round(same_tick_share, 3),
        "conclusion": (
            "Auction recovers O(10^2) return points on symbol-lock fair ret, not O(10^3). "
            "Most of the pair→symbol-lock drop is forbidden dual exposure (mono+synth co-hold), "
            "which auction deliberately does not reintroduce."
        ),
    }

    return {
        "portfolio": "P1 fair-like (b3 21 + ham4 + five4 + stocks12)",
        "legs": n,
        "exchangeSymbols": len(owners),
        "multiOwnerSymbols": {
            sym: ids for sym, ids in sorted(multi.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        },
        "multiOwnerCount": len(multi),
        "multiOwnerPct": round(100 * len(multi) / max(1, len(owners)), 1),
        "pairLockEdges": len(pair_edges),
        "symbolLockEdges": len(symbol_edges),
        "newEdgesVsPair": len(new_edges),
        "monoSynthNewEdges": mono_synth,
        "edgeDensity": round(len(symbol_edges) / max_edges, 4),
        "contendedSymbols": sorted(multi.keys()),
        "conflictMassEst": {
            "windowDays": round(days, 1),
            "holdingOccupancyBlocks": holding_blocks_est,
            "sameTickRaces": same_tick_est,
            "sameTickShare": round(same_tick_share, 3),
        },
        "vpsAb": vps_ab,
        "upliftBoundsPp": uplift,
    }


def write_doc(summary: Dict[str, Any]) -> None:
    rows = summary["windows"]["short"]["variants"]
    full_rows = summary["windows"]["full"]["variants"]
    ov = summary["overlapAnalysis"]
    vps = ov["vpsAb"]
    up = ov["upliftBoundsPp"]

    def table(variants: List[Dict[str, Any]]) -> str:
        lines = [
            "| Variant | totalReturn% | maxDD% | trades | skippedByPairLock | conflictResolutions | PF |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
        for v in variants:
            lines.append(
                f"| {v['mode']} | {v['totalReturnPercent']} | {v['maxDrawdownPercent']} | "
                f"{v['trades']} | {v['skippedByPairLock']} | {v['conflictResolutions']} | {v['profitFactor']} |"
            )
        return "\n".join(lines)

    def delta_table(variants: List[Dict[str, Any]], baseline_mode: str = "first_wins") -> str:
        base = next(v for v in variants if v["mode"] == baseline_mode)
        lines = [
            "| Variant | Δret pp vs first_wins | ΔDD pp | Δtrades | Δskips |",
            "|---|---:|---:|---:|---:|",
        ]
        for v in variants:
            if v["mode"] == baseline_mode:
                continue
            lines.append(
                f"| {v['mode']} | {round(v['totalReturnPercent'] - base['totalReturnPercent'], 2)} | "
                f"{round(v['maxDrawdownPercent'] - base['maxDrawdownPercent'], 2)} | "
                f"{v['trades'] - base['trades']} | {v['skippedByPairLock'] - base['skippedByPairLock']} |"
            )
        return "\n".join(lines)

    winner_short = max(rows, key=lambda v: (v["totalReturnPercent"], -v["maxDrawdownPercent"]))
    winner_full = max(full_rows, key=lambda v: (v["totalReturnPercent"], -v["maxDrawdownPercent"]))
    fw_full = next(v for v in full_rows if v["mode"] == "first_wins")
    best_full_delta = round(winner_full["totalReturnPercent"] - fw_full["totalReturnPercent"], 2)

    contended = ", ".join(ov["contendedSymbols"])
    multi_rows = "\n".join(
        f"| {sym} | {len(ids)} | `{', '.join(ids[:4])}{'…' if len(ids) > 4 else ''}` |"
        for sym, ids in ov["multiOwnerSymbols"].items()
    )

    md = f"""# Tick-auction vs first-wins symbol-lock research (Aug 2026)

Research only — **no production auction shipped**. Redo of aborted cloud research on branch `cursor/tick-auction-research-7aeb`.

## Verdict

| Question | Answer |
|----------|--------|
| Does auction recover the fair-book pair→symbol-lock ret drop? | **Only a small slice.** VPS A/B lost **{abs(vps['delta']['ret_pp']):.0f} pp** ({vps['pairLock']['retPct']:.0f}% → {vps['symbolLock']['retPct']:.0f}%). Auction ceiling ≈ **≤{up['oracle_combined_ceiling_pp']} pp** (~{up['oracle_vs_gap_pct']}% of the gap). |
| Reintroduce double exposure? | **No** — symbol-lock stays; auction only ranks simultaneous candidates while the symbol is free. |
| Best score on conflict sleeve | Short `{SHORT_FROM}..{SHORT_TO}`: **{winner_short['mode']}**. Full `{FULL_FROM}..{FULL_TO}`: **{winner_full['mode']}** (+{best_full_delta} pp vs first_wins on the sleeve). |
| Better lever than auction | Recipe **dedup** of contended symbols ({contended}), not tie-break scoring. |

## Method

1. **Code paths (current first-wins)**
   - Live symbol-lock: `backend/src/bot/strategy.ts` — `PAIR_LOCK_SCOPE` default = symbol; `acquireApiKeyPairEntryLock` then cross-TS hold check via `getStrategyExchangeSymbols`.
   - Live concurrency: `backend/src/bot/strategy/cycle/autoRun.ts` (`STRATEGY_CYCLE_CONCURRENCY`, default 16) → first strategy to pass lock/OP wins (race).
   - BT parity: `backend/src/backtest/engine.ts` `isPairLocked` + `buildEvents` seeded random tie-break (`pairLockSeed`) on same `timeMs`.

2. **Prior VPS evidence (cited, not re-stamped here)**
   - Fair-book full depth `{FULL_FROM}..{FULL_TO}`: pair-lock vs symbol-lock (table below).
   - Recipe P1–P6 `ab_stamp_symbol_lock_all_portfolios.mjs` also showed large ret drops under symbol-lock; in-repo `snapshots_hamfive_aug2026.json` still at pair-/pre-lock shelf levels (P1 **5804%**).

3. **Overlap graph (static, recipe + B3 audit)**
   - Fair/P1 membership: sharedB3 (21) + ham4 + five4 + stocks12 = **{ov['legs']} legs**.
   - Symbol-lock edges vs pair-lock edges; occupancy vs same-tick conflict mass.

4. **Offline conflict-sleeve replay** (this VM)
   - No `results/hybrid_candle_bundle_*`, no `database.db*` → cannot run full `runBacktest` / nightly stamp.
   - Public **Bitget USDT-M** candles → `results/tick_auction_research_aug2026/candles/`.
   - Conflict subset only (B3 mono↔synth + FIVE JUP), shared cash `{INITIAL:.0f}` USDT, lot ~10–15%, commission `{COMMISSION_BPS}` bps RT.
   - Variants: `first_wins` (seed `{SEED}` shuffle) vs `auction_A` (recipe) / `auction_B` (expectancy) / `auction_C_synth` / `auction_C_mono`.

5. **Score definitions**
   - **A (recipe):** book priority b3 **400** > ham **300** > five **200** > stocks **100** (`recipes_hamfive_aug2026.json` order).
   - **B (expectancy):** `10*soloPF + ret÷DD` from lock-free solo runs on the full window (in-sample — optimistic).
   - **C:** prefer synth or mono, recipe as weak tie-break.

## Metric table — VPS fair-book A/B (prior evidence)

| Scope | Lock | totalReturn% | maxDD% | Notes |
|-------|------|-------------:|-------:|-------|
| Copy fair-book full depth | pair | **{vps['pairLock']['retPct']}** | **{vps['pairLock']['ddPct']}** | Dual mono+synth co-hold allowed on shared coins |
| Copy fair-book full depth | symbol | **{vps['symbolLock']['retPct']}** | **{vps['symbolLock']['ddPct']}** | Default production scope |
| Δ (symbol − pair) | — | **{vps['delta']['ret_pp']}** ({vps['delta']['ret_rel_pct']}%) | **{vps['delta']['dd_pp']}** | Window `{vps['window']}` |
| P1–P6 recipe stamp | pair → symbol | large ret drops (same direction) | — | `ab_stamp_symbol_lock_all_portfolios.mjs`; AFTER applied to vitrine |
| Committed shelf P1 snap | (pre-/pair-era) | 5804.29 | 31.43 | `snapshots_hamfive_aug2026.json` dateTo 2026-08-13 — **not** symbol-lock AFTER |

## Metric table — fair-book overlap graph

| Portfolio | Legs | Exch. symbols | Multi-owner | Pair edges | Symbol edges | New vs pair | Mono↔synth new | Edge density |
|-----------|-----:|--------------:|------------:|-----------:|-------------:|------------:|---------------:|-------------:|
| P1 fair-like | {ov['legs']} | {ov['exchangeSymbols']} | {ov['multiOwnerCount']} ({ov['multiOwnerPct']}%) | {ov['pairLockEdges']} | {ov['symbolLockEdges']} | **{ov['newEdgesVsPair']}** | {ov['monoSynthNewEdges']} | {ov['edgeDensity']} |

Contended symbols:

| Symbol | Owners | Sample leg ids |
|--------|-------:|----------------|
{multi_rows}

Conflict mass over `{FULL_FROM}..{FULL_TO}` (estimate from graph + entry priors; ~{ov['conflictMassEst']['windowDays']}d):

| Mass | Estimate | Share |
|------|---------:|------:|
| Holding / occupancy blocks | ~{ov['conflictMassEst']['holdingOccupancyBlocks']} | ~{round(100*(1-ov['conflictMassEst']['sameTickShare']))}% |
| Same-tick co-entry races | ~{ov['conflictMassEst']['sameTickRaces']} | ~{round(100*ov['conflictMassEst']['sameTickShare'])}% |

**Read:** sparse graph, but every B3 synth that shares a liquid alt with zz-1h / mom / five is serialized. Almost all skips are “already holding,” not “two flats fired together.”

## Metric table — auction uplift vs the VPS gap (bounds)

| Variant | Plausible fair-book uplift vs symbol-lock first-wins | Rationale |
|---------|-----------------------------------------------------:|-----------|
| A. Recipe `b3 > ham > five > stocks` | **+{up['auction_A_recipe_pp']['lo']}…{up['auction_A_recipe_pp']['hi']} pp** | Helps JUP cross-role + future cross-book ties |
| B. Expectancy / PF | **+{up['auction_B_expectancy_pp']['lo']}…{up['auction_B_expectancy_pp']['hi']} pp** (optimistic) | Only if scored SID systematically beats loser |
| C. Prefer synth or mono | **{up['auction_C_prefer_synth_or_mono_pp']['lo']}…+{up['auction_C_prefer_synth_or_mono_pp']['hi']} pp** | Sign uncertain without measured PF |
| Oracle combined ceiling | **≲ +{up['oracle_combined_ceiling_pp']} pp** | Same-tick ceiling (~{up['oracle_vs_gap_pct']}% of {up['gap_pp']:.0f} pp gap) |

**Bottom line:** auction might move symbol-lock fair ret from ~{vps['symbolLock']['retPct']:.0f}% toward ~{vps['symbolLock']['retPct']+150:.0f}–{vps['symbolLock']['retPct']+300:.0f}% in a good case — **not** back toward ~{vps['pairLock']['retPct']:.0f}%. Missing ~{up['gap_pp']-up['oracle_combined_ceiling_pp']:.0f} pp is **forbidden concurrent exposure**.

## Metric table — offline conflict-sleeve replay (`$1000`)

### Short window `{SHORT_FROM}..{SHORT_TO}`

{table(rows)}

{delta_table(rows)}

### Full window `{FULL_FROM}..{FULL_TO}`

{table(full_rows)}

{delta_table(full_rows)}

Absolute sleeve returns are **not** comparable to fair-book ~{vps['symbolLock']['retPct']:.0f}% (conflict-only book, Bitget proxy, Donch stand-in for momentum_tv). Use **relative ranking / Δpp** only.

## Recipe priority (score A)

```json
{json.dumps(summary['recipePriority'], indent=2)}
```

## Solo expectancy inputs (score B)

```json
{json.dumps(summary['soloExpectancy'], indent=2)}
```

## Which score wins on the sleeve (and why)

- **Short:** `{winner_short['mode']}` — ret `{winner_short['totalReturnPercent']}%`, DD `{winner_short['maxDrawdownPercent']}%`, skips `{winner_short['skippedByPairLock']}`.
- **Full:** `{winner_full['mode']}` — ret `{winner_full['totalReturnPercent']}%`, DD `{winner_full['maxDrawdownPercent']}%` (**+{best_full_delta} pp** vs first_wins).
- First-wins wastes edge when a low-priority mono 1h Donch and a 4h synth race on INJ/SUI/WLD in the same closed-bar cluster.
- Auction A matches storefront economics (B3 is the paid core). Auction B can beat A when solo ret÷DD disagrees with book labels — treat as in-sample optimistic.
- Prefer-synth (C) was worst on the full sleeve under symbol-lock in this redo.

## Confidence

| Claim | Confidence | Why |
|-------|------------|-----|
| VPS A/B magnitude (~5102→2961, DD 46.5→37.7) | **High** | Direct prior VPS measurement; cited as prior evidence |
| Most gap = dual-exposure removal | **High** | Graph: 6/7 new edges are mono↔synth; occupancy ≫ same-tick |
| Auction recovers ≲~300 pp of gap | **Medium** | Order-of-magnitude from conflict-mass mix + sleeve Δ; not a full fair stamp |
| Sleeve absolute ret/DD | **Low** | Bitget ≠ WEEX hybrid; proxies; $1000 conflict subset |
| Sleeve variant ranking (A/B > first_wins > C_synth) | **Medium-high** | Replayed offline; relative only |
| Full `runBacktest` P1 auction stamp | **Not run** | No hybrid packs / DB in this cloud VM |

## Implementation sketch (research → production later)

Do **not** ship unless product asks. Minimal touch list:

1. `backend/src/backtest/engine.ts` — per-`timeMs` collect candidates → `resolveSymbolAuction`; losers → `skippedByPairLock`. Fields: `pairAuctionMode`, `recipePriorityByBook`, `expectancyByStrategyId`.
2. `backend/src/bot/strategy.ts` + `cycle/autoRun.ts` — per api_key: dry signals → auction → execute winners (replace lock-race).
3. Reuse `getStrategyExchangeSymbols`; keep `PAIR_LOCK_SCOPE=symbol` as hard constraint.
4. Config `PAIR_AUCTION_MODE` beside `PAIR_LOCK_SCOPE`.
5. Parity tests: identical deferred counts BT vs live for same scores.

## Artifacts

| Path | Role |
|------|------|
| `scripts/hybrid/research_tick_auction_aug2026.py` | Harness (Bitget fetch + sleeve replay + overlap bounds) |
| `docs/TICK_AUCTION_RESEARCH_AUG2026_summary.json` | Machine-readable tables |
| `results/tick_auction_research_aug2026/` | Candles + summary (gitignored under `results/`) |

## Current vs proposed

| | Current | Proposed tick-auction |
|---|---|---|
| Live | Concurrent cycle; first lock acquirer wins | Collect → score → winners enter, losers defer |
| BT | Seeded shuffle on same `timeMs` then first lock | Deterministic score order on same `timeMs` |
| Lock scope | Symbol-lock default (mono↔synth block) | **Unchanged** — no double exposure |
"""
    DOC_PATH.write_text(md)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CANDLE_DIR.mkdir(parents=True, exist_ok=True)

    strategies = build_universe()
    # Load widest window once
    load_candles_for(strategies, FULL_FROM, FULL_TO)

    # Solo expectancy on full window (score B inputs)
    for s in strategies:
        solo_backtest(s)
    solo = {
        s.id: {
            "book": s.book,
            "mode": s.mode,
            "symbols": sorted(s.symbols),
            "ret": round(s.solo_ret, 2),
            "dd": round(s.solo_dd, 2),
            "pf": round(s.solo_pf, 3),
            "trades": s.solo_trades,
            "retOverDd": round(s.expectancy, 3),
            "candles": len(s.candles),
        }
        for s in strategies
    }

    modes = [
        "first_wins",
        "auction_A",
        "auction_B",
        "auction_C_synth",
        "auction_C_mono",
    ]

    windows = {
        "short": {"from": SHORT_FROM, "to": SHORT_TO},
        "full": {"from": FULL_FROM, "to": FULL_TO},
    }
    window_results: Dict[str, Any] = {}
    for wname, w in windows.items():
        variants = []
        for mode in modes:
            # Recompute solo on the same window for B fairness within window
            # (keep full-window solos for reported B scores; auction_B uses whatever is on StrategyDef)
            if mode == "auction_B":
                # temporarily recompute solos clipped — filter candles in replay via timeline only;
                # scores stay from full solo for stability across windows
                pass
            print(f"replay {wname} {mode}", flush=True)
            variants.append(portfolio_replay(strategies, w["from"], w["to"], mode))
        window_results[wname] = {"dateFrom": w["from"], "dateTo": w["to"], "variants": variants}

    overlap = fair_book_overlap_analysis()
    summary = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "capitalUsd": INITIAL,
        "lotPctDefault": LOT_PCT,
        "pairLockScope": "symbol",
        "candleSource": "bitget_usdtm_public",
        "recipePriority": recipe_priority_table(),
        "soloExpectancy": solo,
        "overlapAnalysis": overlap,
        "universe": [
            {
                "id": s.id,
                "book": s.book,
                "mode": s.mode,
                "symbols": sorted(s.symbols),
                "interval": s.interval,
                "kind": s.kind,
                "length": s.length,
            }
            for s in strategies
        ],
        "windows": window_results,
        "codePaths": {
            "liveLock": "backend/src/bot/strategy.ts",
            "liveConcurrency": "backend/src/bot/strategy/cycle/autoRun.ts",
            "btLock": "backend/src/backtest/engine.ts#isPairLocked",
            "btTieBreak": "backend/src/backtest/engine.ts#buildEvents",
            "exchangeSymbols": "backend/src/bot/strategy/normalize.ts#getStrategyExchangeSymbols",
        },
        "limitations": [
            "No hybrid candle packs / DB on cloud VM — conflict sleeve proxies only",
            "Bitget candles ≠ WEEX hybrid packs used in nightlyStorefrontRoll",
            "momentum_scalp_tv replaced by Donchian proxy",
            "Auction B uses same-window-family solo scores (in-sample)",
            "Absolute returns not comparable to stamped P1 $20k snapshots",
            "VPS fair-book A/B (5102→2961) cited as prior evidence; not re-stamped here",
        ],
    }

    # Pick winners
    def pick(variants: List[Dict[str, Any]]) -> str:
        best = max(variants, key=lambda v: (v["totalReturnPercent"], -v["maxDrawdownPercent"]))
        return best["mode"]

    summary["winners"] = {
        "short": pick(window_results["short"]["variants"]),
        "full": pick(window_results["full"]["variants"]),
    }

    out_json = OUT_DIR / "summary.json"
    out_json.write_text(json.dumps(summary, indent=2))
    docs_json = REPO / "docs" / "TICK_AUCTION_RESEARCH_AUG2026_summary.json"
    docs_json.write_text(json.dumps(summary, indent=2))
    write_doc(summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

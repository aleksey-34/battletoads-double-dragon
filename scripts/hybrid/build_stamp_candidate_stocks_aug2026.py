#!/usr/bin/env python3
"""Build the human-review stamp candidate from the staggered BT artifact.

Writes results/stocks_hf_research_aug2026/stamp_candidate_aug2026.json. Nothing here
touches the database — the candidate exists so a human can decide what, if anything,
goes on the vitrine.

  python3 scripts/hybrid/build_stamp_candidate_stocks_aug2026.py
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(REPO, "results", "stocks_hf_research_aug2026")
SRC = os.path.join(OUT_DIR, "staggered_portfolio_bt.json")
OUT = os.path.join(OUT_DIR, "stamp_candidate_aug2026.json")

# Read from the live VPS DB on 2026-08-09 after the concurrent metadata repair.
LIVE_STATE = {
    "portfolio-conservative-jul2026": {"capital": 20000, "books": ["b3", "mrs", "stocks"], "stampedRet": 1264.99, "stampedDd": 16.47},
    "portfolio-balanced-jul2026": {"capital": 20000, "books": ["b3", "mrs", "stocks"], "stampedRet": 1349.85, "stampedDd": 17.41},
    "portfolio-aggressive-jul2026": {"capital": 30000, "books": ["b3", "mrs", "stocks"], "stampedRet": 4640.9, "stampedDd": 29.2},
}


def main() -> None:
    with open(SRC, encoding="utf-8") as fh:
        bt = json.load(fh)

    by_key = {}
    for r in bt["results"]:
        by_key.setdefault(r["setKey"], {})[r["window"]] = r

    candidates = []
    for set_key, live in LIVE_STATE.items():
        windows = by_key.get(set_key)
        if not windows:
            continue
        full, short = windows.get("full"), windows.get("short")
        repro = (full or {}).get("reproVsJulyStamp") or {}
        candidates.append({
            "setKey": set_key,
            "live": live,
            "candidateShortWindow": {
                "label": f"Real BT {short['from']} → {short['to']} · stocks join {short['stocksJoin']}",
                "from": short["from"],
                "to": short["to"],
                "capital": short["withStocks"]["maker"]["capital"],
                "ret": short["withStocks"]["maker"]["ret"],
                "dd": short["withStocks"]["maker"]["dd"],
                "retTakerStress": short["withStocks"]["taker_stress"]["ret"],
                "ddTakerStress": short["withStocks"]["taker_stress"]["dd"],
                "coreRet": short["core"]["ret"],
                "coreDd": short["core"]["dd"],
                "deltaFromStocks": short["withStocks"]["maker"]["deltaRet"],
            },
            "candidateFullWindow": {
                "label": f"Real BT {full['from']} → {full['to']} · stocks join {full['stocksJoin']}",
                "capital": full["withStocks"]["maker"]["capital"],
                "ret": full["withStocks"]["maker"]["ret"],
                "dd": full["withStocks"]["maker"]["dd"],
                "deltaFromStocks": full["withStocks"]["maker"]["deltaRet"],
            },
            "reproVsJulyStamp": repro,
        })

    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "DO_NOT_APPLY — for human review only",
        "productionStampApplied": False,
        "source": os.path.relpath(SRC, REPO),
        "method": bt["method"],
        "stocksJoin": bt["stocksJoin"],
        "stocksParticipationDays": bt["stocksParticipationDays"],
        "blockers": [
            {
                "id": "mrs-not-reproducible",
                "severity": "blocking",
                "detail": (
                    "Rerunning the July recipe on the current engine reproduces the B3 book to "
                    "the decimal (630.81% / 22.95%) but returns 2.4x-7.3x more on the MRS book. "
                    "Either the live vitrine numbers are stale or the current MeanReversion path "
                    "is wrong. Both totals cannot be true; neither may be stamped until resolved."
                ),
            },
            {
                "id": "stocks-edge-not-established",
                "severity": "blocking",
                "detail": (
                    "On the only window where all 8 legs exist (2026-06-17 onward) the sleeve "
                    "returns -2.08% at maker fees and -5.27% at taker. Path-accurate fill checks "
                    "did not establish the edge. The July +47.15% sleeve figure is void."
                ),
            },
            {
                "id": "stocks-window-too-short",
                "severity": "material",
                "detail": (
                    "The sleeve has ~29 days inside the backtest window. Any portfolio delta it "
                    "produces is dominated by the idle-cash effect, not by sleeve performance."
                ),
            },
        ],
        "capitalDecision": {
            "question": "What should PortfolioCard show as capital now that the stocks book is funded?",
            "liveValue": "core capital (20k/20k/30k) — matches the basis of the stamped ret%",
            "recipeValue": "25k/25k/35k — what a client actually funds once the 5k sleeve is on",
            "note": (
                "These disagree by the 5k sleeve. Showing recipe capital against a core-only ret% "
                "overstates return per funded dollar; showing core capital understates the deposit "
                "a client needs. Only an honest with-stocks rerun removes the choice."
            ),
            "resolvedBy": "human",
        },
        "ifApprovedRequire": [
            "Label the card explicitly as short-window Real BT with the exact dates.",
            "Show the taker-stress figure next to the maker figure, not the maker figure alone.",
            "State that the stocks sleeve joined on 2026-06-17 and did not run the full window.",
            "Resolve the MRS reproducibility gap first — it moves the totals far more than stocks does.",
        ],
        "candidates": candidates,
    }

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
    print(f"Wrote {OUT}")
    for c in candidates:
        s = c["candidateShortWindow"]
        print(f"  {c['setKey']}: short {s['ret']}% / DD {s['dd']}% (taker {s['retTakerStress']}%) vs live stamp {c['live']['stampedRet']}%")


if __name__ == "__main__":
    main()

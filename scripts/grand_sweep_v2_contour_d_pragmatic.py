#!/usr/bin/env python3
"""Contour D pragmatic: anti-dup shortlist from top-100 robust without equity curves.

Reason: sweep artifacts don't include equity curves per candidate, so strict rho-based
pairwise matrix cannot be computed directly without 100+ extra backtests.
This script applies a robust anti-dup proxy and outputs 35-50 finalists.
"""

import json
from pathlib import Path
from datetime import datetime
from collections import Counter

SWEEP_FILE = Path('/opt/battletoads-double-dragon/results/btdd_d1_historical_sweep_2026-03-20T22-06-14-758Z.json')
OUT_DIR = Path('/tmp/grand_sweep_v2')


def key(item):
    return (
        str(item.get('market', '')),
        str(item.get('strategyType', '')),
        str(item.get('interval', '')),
        int(item.get('length', 0) or 0),
    )


def diversity_penalty(item, selected):
    market = str(item.get('market', ''))
    strategy_type = str(item.get('strategyType', ''))
    interval = str(item.get('interval', ''))

    p = 0.0
    for s in selected:
        if str(s.get('market', '')) == market:
            p += 0.9
        if str(s.get('strategyType', '')) == strategy_type:
            p += 0.2
        if str(s.get('interval', '')) == interval:
            p += 0.1
    return p


def main():
    data = json.loads(SWEEP_FILE.read_text(encoding='utf-8'))
    robust = [x for x in data.get('evaluated', []) if x.get('robust')]
    robust.sort(key=lambda x: float(x.get('score', 0)), reverse=True)
    candidate_pool = robust[:400]

    selected = []
    seen = set()
    market_counts = Counter()
    type_counts = Counter()
    interval_counts = Counter()

    max_per_market = 6
    max_per_type = 16
    max_per_interval = 24

    # Greedy diversity selection over expanded robust pool, target 42 (inside 35-50)
    for item in candidate_pool:
        # quality baseline
        pf = float(item.get('profitFactor', 0))
        dd = float(item.get('maxDrawdownPercent', 100))
        if pf < 0.95 or dd > 35:
            continue

        item_key = key(item)
        if item_key in seen:
            continue

        market = str(item.get('market', ''))
        strategy_type = str(item.get('strategyType', ''))
        interval = str(item.get('interval', ''))

        if market_counts[market] >= max_per_market:
            continue
        if type_counts[strategy_type] >= max_per_type:
            continue
        if interval_counts[interval] >= max_per_interval:
            continue

        score = float(item.get('score', 0)) - diversity_penalty(item, selected)
        if score < -1.0:
            continue

        selected.append(item)
        seen.add(item_key)
        market_counts[market] += 1
        type_counts[strategy_type] += 1
        interval_counts[interval] += 1
        if len(selected) >= 42:
            break

    # Backfill if strict filter kept too few
    if len(selected) < 35:
        relaxed_market_cap = max_per_market + 2
        relaxed_type_cap = max_per_type + 2
        for item in candidate_pool:
            if item in selected:
                continue
            item_key = key(item)
            if item_key in seen:
                continue
            market = str(item.get('market', ''))
            strategy_type = str(item.get('strategyType', ''))
            if market_counts[market] >= relaxed_market_cap:
                continue
            if type_counts[strategy_type] >= relaxed_type_cap:
                continue
            selected.append(item)
            seen.add(item_key)
            market_counts[market] += 1
            type_counts[strategy_type] += 1
            if len(selected) >= 42:
                break

    out = {
        'timestamp': datetime.utcnow().isoformat(),
        'contour': 'D',
        'method': 'pragmatic anti-duplication proxy (market/type/interval diversity)',
        'strictRhoNote': 'equity curves are absent in sweep artifact; rho matrix requires separate per-candidate backtests',
        'input': {
            'sourceSweep': str(SWEEP_FILE),
            'candidatePool': len(candidate_pool),
            'robustTotal': len(robust),
        },
        'finalistsCount': len(selected),
        'finalists': [
            {
                'strategyId': int(x.get('strategyId', 0) or 0),
                'strategyName': x.get('strategyName', ''),
                'strategyType': x.get('strategyType', ''),
                'marketMode': x.get('marketMode', ''),
                'market': x.get('market', ''),
                'interval': x.get('interval', ''),
                'length': x.get('length', 0),
                'profitFactor': x.get('profitFactor', 0),
                'maxDrawdownPercent': x.get('maxDrawdownPercent', 0),
                'tradesCount': x.get('tradesCount', 0),
                'score': x.get('score', 0),
            }
            for x in selected
        ],
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f'grand_sweep_v2_contour_d_pragmatic_{datetime.utcnow().strftime("%Y%m%d_%H%M%S")}.json'
    out_path.write_text(json.dumps(out, ensure_ascii=True, indent=2), encoding='utf-8')
    print(f'saved {out_path} finalists={len(selected)}')


if __name__ == '__main__':
    main()

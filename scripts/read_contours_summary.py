#!/usr/bin/env python3
"""Grand Sweep v2 - final per-contour report + merged shortlist."""
import json
import glob
import collections
import os
import datetime


def avg_regime(d):
    """Average a regime-dict or return float."""
    if isinstance(d, dict):
        vals = [v for v in d.values() if isinstance(v, (int, float))]
        return sum(vals) / len(vals) if vals else 0.0
    return float(d or 0)


def dedup_key(st, mk, iv):
    return (str(st), str(mk), str(iv))


# ── C: regime-reranked (top30, uses pf/dd as regime dicts, regimeScore)
c_files = sorted(glob.glob('/tmp/grand_sweep_v2/grand_sweep_v2_contour_c_*.json'))
c_items = []
if c_files:
    c = json.load(open(c_files[-1]))
    raw = c.get('top30', [])
    for x in raw:
        pf = avg_regime(x.get('pf', 0))
        dd = avg_regime(x.get('dd', 0))
        rs = float(x.get('regimeScore', 0))
        c_items.append({
            'contour': 'C',
            'strategyType': x.get('strategyType', ''),
            'market': x.get('market', ''),
            'interval': x.get('interval', ''),
            'length': x.get('length', 0),
            'profitFactor': round(pf, 4),
            'maxDrawdownPercent': round(dd, 2),
            'tradesCount': 0,
            'score': round(rs, 4),  # regimeScore for C
            'regimesProfitable': x.get('regimesProfitable', 0),
        })
    c_items.sort(key=lambda x: x['score'], reverse=True)
    print(f'=== C (regime-rerank): {len(c_items)} finalists [score=regimeScore, pf=avg across regimes]')
    hdr = f'  {"strategyType":22} {"market":28} {"rScore":>8} {"pf_avg":>7} {"dd_avg":>6} regimes'
    print(hdr)
    for x in c_items[:12]:
        print(f'  {x["strategyType"]:<22} {x["market"]:<28} {x["score"]:8.4f} {x["profitFactor"]:7.3f} {x["maxDrawdownPercent"]:6.2f}  {x["regimesProfitable"]}')
else:
    print('=== C: NO FILE')
print()

# ── D: anti-dup pragmatic (uses score/profitFactor/maxDrawdownPercent)
d_files = sorted(glob.glob('/tmp/grand_sweep_v2/grand_sweep_v2_contour_d_pragmatic_*.json'))
d_items = []
if d_files:
    d = json.load(open(d_files[-1]))
    raw = d.get('finalists', [])
    for x in raw:
        d_items.append({
            'contour': 'D',
            'strategyType': x.get('strategyType', ''),
            'market': x.get('market', ''),
            'interval': x.get('interval', ''),
            'length': x.get('length', 0),
            'profitFactor': float(x.get('profitFactor', 0)),
            'maxDrawdownPercent': float(x.get('maxDrawdownPercent', 0)),
            'tradesCount': int(x.get('tradesCount', 0)),
            'score': float(x.get('score', 0)),
            'regimesProfitable': None,
        })
    print(f'=== D (anti-dup pragmatic): {len(d_items)} finalists')
    hdr = f'  {"strategyType":22} {"market":28} {"score":>7} {"pf":>6} {"dd":>6} trades'
    print(hdr)
    for x in d_items[:12]:
        print(f'  {x["strategyType"]:<22} {x["market"]:<28} {x["score"]:7.2f} {x["profitFactor"]:6.2f} {x["maxDrawdownPercent"]:6.2f} {x["tradesCount"]:6}')
else:
    print('=== D: NO FILE')
print()

# ── B: stat_arb synth-only job-13 Mar-27
b_items = []
b_f = '/opt/battletoads-double-dragon/results/btdd_d1_historical_sweep_2026-03-27T08-46-25-565Z.json'
try:
    b = json.load(open(b_f))
    b_ev = [x for x in b.get('evaluated', []) if x.get('robust')]
    b_ev.sort(key=lambda x: float(x.get('score', 0)), reverse=True)
    for x in b_ev:
        b_items.append({
            'contour': 'B',
            'strategyType': x.get('strategyType', ''),
            'market': x.get('market', ''),
            'interval': x.get('interval', ''),
            'length': x.get('length', 0),
            'profitFactor': float(x.get('profitFactor', 0)),
            'maxDrawdownPercent': float(x.get('maxDrawdownPercent', 0)),
            'tradesCount': int(x.get('tradesCount', 0)),
            'score': float(x.get('score', 0)),
            'regimesProfitable': None,
        })
    print(f'=== B (stat_arb synth-only job-13): {len(b_items)} robust finalists')
    hdr = f'  {"strategyType":22} {"market":28} {"score":>7} {"pf":>6} {"dd":>6} trades'
    print(hdr)
    for x in b_items[:12]:
        print(f'  {x["strategyType"]:<22} {x["market"]:<28} {x["score"]:7.2f} {x["profitFactor"]:6.2f} {x["maxDrawdownPercent"]:6.2f} {x["tradesCount"]:6}')
except Exception as e:
    print(f'=== B: ERROR {e}')
print()

# ── A: large Mar-20 sweep top12 for reference
a_items = []
a_f = '/opt/battletoads-double-dragon/results/btdd_d1_historical_sweep_2026-03-20T22-06-14-758Z.json'
try:
    a = json.load(open(a_f))
    a_ev = [x for x in a.get('evaluated', []) if x.get('robust')]
    a_ev.sort(key=lambda x: float(x.get('score', 0)), reverse=True)
    for x in a_ev:
        a_items.append({
            'contour': 'A',
            'strategyType': x.get('strategyType', ''),
            'market': x.get('market', ''),
            'interval': x.get('interval', ''),
            'length': x.get('length', 0),
            'profitFactor': float(x.get('profitFactor', 0)),
            'maxDrawdownPercent': float(x.get('maxDrawdownPercent', 0)),
            'tradesCount': int(x.get('tradesCount', 0)),
            'score': float(x.get('score', 0)),
            'regimesProfitable': None,
        })
    print(f'=== A (full sweep Mar-20): {len(a_items)} robust — top-12 by score:')
    for x in a_items[:12]:
        print(f'  {x["strategyType"]:<22} {x["market"]:<28} {x["score"]:7.2f} {x["profitFactor"]:6.2f} {x["maxDrawdownPercent"]:6.2f} {x["tradesCount"]:6}')
except Exception as e:
    print(f'=== A: ERROR {e}')
print()

# ── FINAL MERGED SHORTLIST
# Strategy: pick top unique per contour by rank, deduplicate by (strat,market,interval)
# C uses regimeScore (0-4 scale), D/B use abs score (0-55 scale) — normalize by rank
print('=== FINAL MERGED SHORTLIST (C:top10 + D:top10 + B:top5, dedup by sig) ===')
seen = set()
picks = []

limits = [('C', c_items, 10), ('D', d_items, 10), ('B', b_items, 5)]
for label, items, lim in limits:
    count = 0
    for x in items:
        k = dedup_key(x['strategyType'], x['market'], x['interval'])
        if k not in seen:
            seen.add(k)
            picks.append(dict(x))
            count += 1
            if count >= lim:
                break

print(f'Total unique picks: {len(picks)}')
print()
print(f'  {"#":3} {"SRC":3} {"strategyType":22} {"market":28} {"pf":>6} {"dd":>6} {"trades":>6}  notes')
for i, x in enumerate(picks, 1):
    rs = x.get('regimesProfitable')
    note = f'regimes={rs}' if rs is not None else f'score={x["score"]:.2f}'
    print(f'  {i:3} {x["contour"]:3} {x["strategyType"]:<22} {x["market"]:<28} {x["profitFactor"]:6.2f} {x["maxDrawdownPercent"]:6.2f} {x["tradesCount"]:6}  {note}')

# Save output
os.makedirs('/tmp/grand_sweep_v2', exist_ok=True)
ts = datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')
out = {
    'timestamp': datetime.datetime.utcnow().isoformat(),
    'description': 'Grand Sweep v2 — final merged shortlist C+D+B',
    'countsPerContour': {'C': len(c_items), 'D': len(d_items), 'B': len(b_items), 'A_robust': len(a_items)},
    'finalPicks': len(picks),
    'picks': picks,
}
out_f = f'/tmp/grand_sweep_v2/grand_sweep_v2_FINAL_MERGED_{ts}.json'
json.dump(out, open(out_f, 'w'), indent=2)
print(f'\nSaved to {out_f}')

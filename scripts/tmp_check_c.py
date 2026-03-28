#!/usr/bin/env python3
import json
d = json.load(open('/tmp/grand_sweep_v2/grand_sweep_v2_contour_c_proper_20260326_174951.json'))
print("keys:", list(d.keys()))
print("finalists len:", len(d.get('finalists', [])))
print("top len:", len(d.get('top', [])))
print("reranked len:", len(d.get('reranked', [])))
for k in d.keys():
    v = d[k]
    if isinstance(v, list):
        print(f"  {k}: {len(v)} items")
    elif isinstance(v, dict):
        print(f"  {k}: dict with keys {list(v.keys())[:5]}")
    else:
        print(f"  {k}: {str(v)[:80]}")

#!/usr/bin/env python3
import json
d = json.load(open('/tmp/grand_sweep_v2/grand_sweep_v2_contour_c_proper_20260326_174951.json'))
x = d['top30'][0]
print("keys:", list(x.keys()))
print("sample:", json.dumps(x, indent=2)[:600])

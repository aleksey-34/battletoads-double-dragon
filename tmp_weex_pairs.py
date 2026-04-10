#!/usr/bin/env python3
import json, urllib.request

url = "https://api-contract.weex.com/capi/v3/market/exchangeInfo"
data = json.loads(urllib.request.urlopen(url).read())
# debug structure
if "data" in data:
    root = data["data"]
elif "symbols" in data:
    root = data
else:
    print("KEYS:", list(data.keys())[:10])
    import sys; sys.exit(1)
symbols = sorted([s["symbol"] for s in root["symbols"]])
print(json.dumps(symbols))

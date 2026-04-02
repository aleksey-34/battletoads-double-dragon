import urllib.request, json

# Raw response from run
body = json.dumps({
    "apiKeyName": "BTDD_D1",
    "mode": "portfolio",
    "strategyIds": [80156,80157,80158,80159,80160,80161,80162,80163,80164,80165,80166,80167,80168,80169,80170,80171],
    "bars": 1200,
    "warmupBars": 100,
    "saveResult": False
}).encode()
req = urllib.request.Request("http://localhost:3001/api/backtest/run", data=body, headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=180) as resp:
    data = json.loads(resp.read())
    r = data.get("result", {})
    s = r.get("summary", {})
    
    print("=== Result keys:", list(r.keys()))
    print("=== Summary keys:", list(s.keys()))
    print()
    print("apiKeyName:", s.get("apiKeyName"))
    print("mode:", s.get("mode"))
    print("barsRequested:", s.get("barsRequested"))
    print("interval:", s.get("interval"))
    print("strategyNames:", s.get("strategyNames"))
    print("totalReturnPercent:", s.get("totalReturnPercent"))
    print("maxDrawdownPercent:", s.get("maxDrawdownPercent"))
    print("tradesCount:", s.get("tradesCount"))
    print("winRatePercent:", s.get("winRatePercent"))
    print("profitFactor:", s.get("profitFactor"))
    print()
    skipped = r.get("skipped", [])
    print("skipped count:", len(skipped))
    for sk in skipped:
        print(" -", sk.get("strategyId"), sk.get("strategyName"), "->", sk.get("reason"))
    print()
    trades = r.get("trades", [])
    print("trades count:", len(trades))
    if trades:
        print("First trade:", json.dumps(trades[0])[:300])

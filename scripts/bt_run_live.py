import urllib.request, json
body = json.dumps({
    "apiKeyName": "BTDD_D1",
    "mode": "portfolio",
    "strategyIds": [80156,80157,80158,80159,80160,80161,80162,80163,80164,80165,80166,80167,80168,80169,80170,80171],
    "bars": 1200,
    "warmupBars": 100
}).encode()
req = urllib.request.Request("http://localhost:3001/api/backtest/run", data=body, headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=180) as resp:
    data = json.loads(resp.read())
    r = data.get("result", {})
    print("runId:", data.get("runId"))
    print("return:", round(r.get("totalReturnPercent", 0), 2), "%")
    print("maxDD:", round(r.get("maxDrawdownPercent", 0), 2), "%")
    print("trades:", r.get("tradesCount", 0))
    print("winRate:", round(r.get("winRatePercent", 0), 2), "%")
    print("PF:", round(r.get("profitFactor", 0), 2))
    sk = r.get("skipped", [])
    print("skipped:", len(sk))
    for s in sk:
        print(" -", s.get("strategyName", ""), ":", s.get("reason", ""))

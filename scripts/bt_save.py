import urllib.request, json

body = json.dumps({
    "apiKeyName": "BTDD_D1",
    "mode": "portfolio",
    "strategyIds": [80156,80157,80158,80159,80160,80161,80162,80163,80164,80165,80166,80167,80168,80169,80170,80171],
    "bars": 1200,
    "warmupBars": 100,
    "saveResult": True
}).encode()
req = urllib.request.Request("http://localhost:3001/api/backtest/run", data=body, headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=180) as resp:
    data = json.loads(resp.read())
    r = data.get("result", {})
    s = r.get("summary", {})
    print("runId:", data.get("runId"))
    print("return:", round(s.get("totalReturnPercent", 0), 2), "%")
    print("maxDD:", round(s.get("maxDrawdownPercent", 0), 2), "%")
    print("trades:", s.get("tradesCount", 0))
    print("winRate:", round(s.get("winRatePercent", 0), 2), "%")
    print("PF:", round(s.get("profitFactor", 0), 2))
    print("initialBalance:", s.get("initialBalance"))
    print("finalEquity:", round(s.get("finalEquity", 0), 2))
    sk = s.get("skippedStrategies", [])
    print("skipped:", len(sk))

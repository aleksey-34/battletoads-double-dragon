import urllib.request, json

# Сначала смотрим детали бэктеста #61
req = urllib.request.Request("http://localhost:3001/api/backtest/runs/61", method="GET")
with urllib.request.urlopen(req, timeout=30) as resp:
    data = json.loads(resp.read())
    print("=== Backtest run #61 ===")
    print("strategy_names:", data.get("strategy_names"))
    print("interval:", data.get("interval"))
    print("bars:", data.get("bars"))
    print("return:", data.get("total_return_percent"))
    print("trades_count:", data.get("trades_count"))
    
    # trades_json
    trades_raw = data.get("trades_json")
    if trades_raw:
        trades = json.loads(trades_raw) if isinstance(trades_raw, str) else trades_raw
        print("trades in json:", len(trades) if isinstance(trades, list) else "not list")
        if isinstance(trades, list) and len(trades) > 0:
            print("First trade:", json.dumps(trades[0], indent=2)[:500])

#!/bin/bash
echo "=== EXECUTE SESSION ==="
curl -s -X POST "http://localhost:3001/api/saas/synctrade/47949/execute" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"DOGEUSDT","masterSide":"long","leverageMaster":50,"leverageHedge":50,"lotPercent":100}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(json.dumps(d, indent=2, default=str)[:2000])
"

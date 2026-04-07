#!/bin/bash
cd /opt/battletoads-double-dragon/backend
echo "=== Current open positions entry_ratio ==="
sqlite3 database.db "
SELECT s.id, ak.name, s.base_symbol, s.state, s.entry_ratio, s.last_action
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE s.is_runtime=1 AND s.is_archived=0 AND s.entry_ratio IS NOT NULL AND s.entry_ratio != '';
"

echo ""
echo "=== Entry events for these ==="
sqlite3 database.db "
SELECT lte.id, ak.name, s.base_symbol, lte.trade_type, lte.side, lte.entry_price, lte.actual_price, datetime(lte.actual_time/1000, 'unixepoch') AS t
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE lte.trade_type = 'entry'
ORDER BY lte.id DESC LIMIT 15;
"

echo ""
echo "=== Specific exit example: id 1286 BERAUSDT ==="
echo "Exit entry_price=0.3896, actual_price=0.3896"
echo "Matching entry for this position:"
sqlite3 database.db "
SELECT lte.id, lte.trade_type, lte.side, lte.entry_price, lte.actual_price, datetime(lte.actual_time/1000, 'unixepoch')
FROM live_trade_events lte
WHERE lte.strategy_id = (SELECT strategy_id FROM live_trade_events WHERE id=1286)
AND lte.id BETWEEN 1280 AND 1286
ORDER BY lte.id;
"

echo ""
echo "=== What entry_ratio was stored for BERAUSDT entries? ==="
sqlite3 database.db "
SELECT s.id, s.base_symbol, s.entry_ratio, s.last_action
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE ak.name='BTDD_D1' AND s.base_symbol='BERAUSDT' AND s.is_runtime=1;
"

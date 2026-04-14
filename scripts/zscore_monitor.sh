#!/bin/bash
# Z-Score TS Live Monitor — run every N minutes via cron or watch
# Usage: watch -n 60 bash /opt/battletoads-double-dragon/zscore_monitor.sh
# Or cron: */5 * * * * bash /opt/battletoads-double-dragon/zscore_monitor.sh >> /opt/battletoads-double-dragon/backend/logs/zscore_monitor.log 2>&1

DB=/opt/battletoads-double-dragon/backend/database.db
LOG=/opt/battletoads-double-dragon/backend/logs/combined.log
NOW=$(date '+%Y-%m-%d %H:%M:%S')
HR="========================================"

echo "$HR"
echo "  Z-Score TS Monitor | $NOW"
echo "$HR"

# 1. Services alive
API_STATUS=$(systemctl is-active btdd-api)
RT_STATUS=$(systemctl is-active btdd-runtime)
echo ""
echo "[Services] btdd-api=$API_STATUS  btdd-runtime=$RT_STATUS"
if [ "$API_STATUS" != "active" ] || [ "$RT_STATUS" != "active" ]; then
  echo "  ⚠️  SERVICE DOWN! Attempting restart..."
  [ "$API_STATUS" != "active" ] && systemctl restart btdd-api
  [ "$RT_STATUS" != "active" ] && systemctl restart btdd-runtime
fi

# 2. Balance
BAL=$(tail -200 "$LOG" | grep -oP '"bal=\$[\d.]+"' | tail -1 | grep -oP '[\d.]+' || echo "?")
BAL2=$(tail -200 "$LOG" | grep -oP 'bal=\$[\d.]+' | tail -1 | grep -oP '[\d.]+' || echo "?")
echo "[Balance] MEXC: \$$BAL2"

# 3. Runtime cycle
LAST_CYCLE=$(tail -500 "$LOG" | grep 'Auto strategy cycle' | tail -1)
if [ -n "$LAST_CYCLE" ]; then
  CYCLE_TIME=$(echo "$LAST_CYCLE" | grep -oP '"timestamp":"[^"]+' | cut -d'"' -f4)
  CYCLE_STATS=$(echo "$LAST_CYCLE" | grep -oP 'total=\d+, processed=\d+, failed=\d+')
  echo "[Runtime] Last cycle: $CYCLE_TIME | $CYCLE_STATS"
else
  echo "[Runtime] ⚠️  No recent cycle found!"
fi

# 4. Strategy states
echo ""
echo "[Strategies]"
sqlite3 "$DB" <<'SQL'
SELECT printf('  #%d %-25s state=%-6s signal=%-20s lev=%dx max_dep=$%.0f', 
  id, name, COALESCE(state,'?'), COALESCE(last_signal,'?'), CAST(leverage AS INT), max_deposit)
FROM strategies WHERE id IN (80199, 80201, 80202, 80203);
SQL

# 5. Z-Score signal activity (last 10 min)
echo ""
echo "[Z-Score Signals (last 10 min)]"
SIGNALS=$(tail -2000 "$LOG" | python3 -c "
import sys, json, re
from datetime import datetime, timedelta
cutoff = datetime.utcnow() - timedelta(minutes=10)
signals = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
    except: continue
    msg = d.get('message', '')
    ts = d.get('timestamp', '')
    if not ts: continue
    try:
        t = datetime.fromisoformat(ts.replace('Z', '+00:00').replace('+00:00', ''))
    except: continue
    if t < cutoff: continue
    if any(kw in msg.lower() for kw in ['zscore', 'stat_arb', 'entry', 'exit', 'signal', 'open', 'close']):
        if 'fetching' not in msg.lower() and 'fetched' not in msg.lower():
            signals.append(f'  {ts[11:19]} {msg[:120]}')
for s in signals[-15:]:
    print(s)
if not signals:
    print('  (no Z-Score signals in last 10 min)')
" 2>/dev/null)
echo "$SIGNALS"

# 6. Razgon status
echo ""
echo "[Razgon]"
RAZGON=$(tail -500 "$LOG" | grep 'Razgon' | grep -E 'tick|ENTRY|EXIT|ORDER|PnL' | tail -5)
if [ -n "$RAZGON" ]; then
  echo "$RAZGON" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        ts = d.get('timestamp','')[11:19]
        msg = d.get('message','')
        print(f'  {ts} {msg[:120]}')
    except:
        print(f'  {line.strip()[:130]}')
" 2>/dev/null
else
  echo "  (no razgon activity)"
fi

# 7. Open positions on exchange
echo ""
echo "[Exchange Positions]"
POS_LOGS=$(tail -500 "$LOG" | grep -iE 'Max positions reached|pos=[1-9]' | tail -5)
if [ -n "$POS_LOGS" ]; then
  echo "$POS_LOGS" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        ts = d.get('timestamp','')[11:19]
        msg = d.get('message','')
        print(f'  {ts} {msg[:120]}')
    except:
        print(f'  {line.strip()[:130]}')
" 2>/dev/null
else
  echo "  (no open positions detected)"
fi

# 8. Errors
echo ""
echo "[Errors (last 30 min)]"
ERRORS=$(tail -5000 "$LOG" | python3 -c "
import sys, json
from datetime import datetime, timedelta
cutoff = datetime.utcnow() - timedelta(minutes=30)
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        ts = d.get('timestamp', '')
        level = d.get('level', '')
        if level != 'error': continue
        t = datetime.fromisoformat(ts.replace('Z', '').replace('+00:00', ''))
        if t < cutoff: continue
        msg = d.get('message', '')[:150]
        print(f'  {ts[11:19]} {msg}')
    except: pass
" 2>/dev/null)
if [ -n "$ERRORS" ]; then
  echo "$ERRORS" | tail -5
else
  echo "  (no errors)"
fi

# 9. Algofund client status
echo ""
echo "[Algofund Clients]"
sqlite3 "$DB" <<'SQL'
SELECT printf('  profile=%d tenant=%d system=%s enabled=%d',
  aas.profile_id, COALESCE(ap.tenant_id, 0), aas.system_name, aas.is_enabled)
FROM algofund_active_systems aas
LEFT JOIN algofund_profiles ap ON aas.profile_id = ap.id
WHERE aas.system_name LIKE '%zscore%';
SQL

echo ""
echo "$HR"

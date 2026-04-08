#!/usr/bin/env bash
set -euo pipefail
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== Fix ruslan and ali: add algofund sub, remove duplicate strategy ==="

# ruslan (41170): has 2 strategy subs, need 1 algofund
ALGO100=$(sqlite3 "$DB" "SELECT id FROM plans WHERE code = 'algofund_100' AND is_active = 1 LIMIT 1;")
echo "algofund_100 plan_id = $ALGO100"

for TID in 41170 41232; do
  SLUG=$(sqlite3 "$DB" "SELECT slug FROM tenants WHERE id = $TID;")
  
  # Count strategy subs
  STRAT_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.product_mode = 'strategy_client';")
  ALGO_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.product_mode = 'algofund_client';")
  echo "$SLUG ($TID): strat=$STRAT_COUNT algo=$ALGO_COUNT"
  
  # Remove duplicate strategy (keep lowest id)
  if [ "$STRAT_COUNT" -gt 1 ]; then
    EXTRA_SUB=$(sqlite3 "$DB" "SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.product_mode = 'strategy_client' ORDER BY s.id DESC LIMIT 1;")
    sqlite3 "$DB" "DELETE FROM subscriptions WHERE id = $EXTRA_SUB;"
    echo "  -removed duplicate strategy sub $EXTRA_SUB"
  fi
  
  # Add algofund if missing
  if [ "$ALGO_COUNT" -eq 0 ]; then
    sqlite3 "$DB" "INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at) VALUES ($TID, $ALGO100, 'active', datetime('now'), '', datetime('now'), datetime('now'));"
    echo "  +algofund subscription"
  fi
done

echo ""
echo "=== Verify all dual subs ==="
sqlite3 "$DB" -header -column "SELECT t.slug, p.code, p.product_mode FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id JOIN plans p ON p.id=s.plan_id WHERE t.product_mode='dual' ORDER BY t.id, p.product_mode;"
echo "=== DONE ==="

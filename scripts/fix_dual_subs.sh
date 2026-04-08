#!/usr/bin/env bash
set -euo pipefail
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== Deactivate combined plans ==="
sqlite3 "$DB" "UPDATE plans SET is_active = 0 WHERE code LIKE 'combined_%';"
echo "Deactivated: $(sqlite3 "$DB" "SELECT COUNT(*) FROM plans WHERE code LIKE 'combined_%' AND is_active = 0;")"

echo "=== Create missing subscriptions for dual tenants ==="
for TID in $(sqlite3 "$DB" "SELECT id FROM tenants WHERE product_mode = 'dual';"); do
  SLUG=$(sqlite3 "$DB" "SELECT slug FROM tenants WHERE id = $TID;")
  HAS_STRAT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.product_mode = 'strategy_client';")
  HAS_ALGO=$(sqlite3 "$DB" "SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.product_mode = 'algofund_client';")
  echo "Tenant $TID ($SLUG): strat=$HAS_STRAT algo=$HAS_ALGO"
  
  if [ "$HAS_STRAT" -eq 0 ]; then
    PLAN_ID=$(sqlite3 "$DB" "SELECT id FROM plans WHERE code = 'strategy_100' AND is_active = 1 LIMIT 1;")
    if [ -n "$PLAN_ID" ]; then
      sqlite3 "$DB" "INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at) VALUES ($TID, $PLAN_ID, 'active', datetime('now'), '', datetime('now'), datetime('now'));"
      echo "  +strategy subscription (plan=$PLAN_ID)"
    fi
  fi
  
  if [ "$HAS_ALGO" -eq 0 ]; then
    PLAN_ID=$(sqlite3 "$DB" "SELECT id FROM plans WHERE code = 'algofund_100' AND is_active = 1 LIMIT 1;")
    if [ -n "$PLAN_ID" ]; then
      sqlite3 "$DB" "INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at) VALUES ($TID, $PLAN_ID, 'active', datetime('now'), '', datetime('now'), datetime('now'));"
      echo "  +algofund subscription (plan=$PLAN_ID)"
    fi
  fi

  # Replace combined subs with strategy plan
  COMBINED_SUB=$(sqlite3 "$DB" "SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.code LIKE 'combined_%' LIMIT 1;")
  if [ -n "$COMBINED_SUB" ]; then
    STRAT_ID=$(sqlite3 "$DB" "SELECT id FROM plans WHERE code = 'strategy_100' AND is_active = 1 LIMIT 1;")
    if [ -n "$STRAT_ID" ]; then
      sqlite3 "$DB" "UPDATE subscriptions SET plan_id = $STRAT_ID WHERE id = $COMBINED_SUB;"
      echo "  ~replaced combined sub $COMBINED_SUB -> strategy_100"
    fi
  fi
done

echo ""
echo "=== Verify subscriptions ==="
sqlite3 "$DB" -header -column "SELECT t.slug, p.code, p.product_mode FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id JOIN plans p ON p.id=s.plan_id WHERE t.product_mode='dual' ORDER BY t.id, p.product_mode;"
echo ""
echo "=== DONE ==="

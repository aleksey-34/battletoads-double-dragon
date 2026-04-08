#!/usr/bin/env bash
set -euo pipefail

echo "=== 1. Git pull ==="
cd /opt/battletoads-double-dragon
git pull origin feature/ts-architecture-refactor

echo "=== 2. Backend compile + restart ==="
cd backend
npx tsc
pm2 restart btdd-api
echo "Backend restarted"

echo "=== 3. Frontend build ==="
cd ../frontend
rm -rf node_modules/.cache
rm -rf build
CI=true npx react-scripts build 2>&1 | tail -10

echo "=== 4. Deploy frontend ==="
cp -r build/* /var/www/battletoads-double-dragon/
BUNDLE=$(grep -o 'main\.[a-z0-9]*\.js' /var/www/battletoads-double-dragon/index.html | head -1)
echo "Deployed bundle: $BUNDLE"

echo "=== 5. Deactivate combined plans ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "UPDATE plans SET is_active = 0 WHERE code IN ('combined_120', 'combined_70');"
echo "Combined plans deactivated"

echo "=== 6. Create separate subscriptions for dual tenants ==="
# For each dual tenant that only has one subscription, create the missing second one
# First find all dual tenants
DUAL_TENANTS=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id FROM tenants WHERE product_mode = 'dual';")

for TID in $DUAL_TENANTS; do
  SLUG=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT slug FROM tenants WHERE id = $TID;")
  
  # Check if has strategy subscription
  HAS_STRAT=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.product_mode = 'strategy_client';")
  
  # Check if has algofund subscription
  HAS_ALGO=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.product_mode = 'algofund_client';")
  
  echo "Tenant $TID ($SLUG): strategy_subs=$HAS_STRAT, algofund_subs=$HAS_ALGO"
  
  if [ "$HAS_STRAT" -eq 0 ]; then
    # Get strategy_100 plan id
    STRAT_PLAN_ID=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id FROM plans WHERE code = 'strategy_100' AND is_active = 1 LIMIT 1;")
    if [ -n "$STRAT_PLAN_ID" ]; then
      sqlite3 /opt/battletoads-double-dragon/backend/database.db "INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at) VALUES ($TID, $STRAT_PLAN_ID, 'active', datetime('now'), '', datetime('now'), datetime('now'));"
      echo "  -> Created strategy subscription (plan_id=$STRAT_PLAN_ID)"
    fi
  fi
  
  if [ "$HAS_ALGO" -eq 0 ]; then
    # Get algofund_100 plan id
    ALGO_PLAN_ID=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id FROM plans WHERE code = 'algofund_100' AND is_active = 1 LIMIT 1;")
    if [ -n "$ALGO_PLAN_ID" ]; then
      sqlite3 /opt/battletoads-double-dragon/backend/database.db "INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, notes, created_at, updated_at) VALUES ($TID, $ALGO_PLAN_ID, 'active', datetime('now'), '', datetime('now'), datetime('now'));"
      echo "  -> Created algofund subscription (plan_id=$ALGO_PLAN_ID)"
    fi
  fi
  
  # If current subscription is on a combined plan, switch it to the right mode plan
  COMBINED_SUB=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $TID AND p.code LIKE 'combined_%' LIMIT 1;")
  if [ -n "$COMBINED_SUB" ]; then
    # Replace combined with strategy_100
    STRAT_PLAN_ID=$(sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id FROM plans WHERE code = 'strategy_100' AND is_active = 1 LIMIT 1;")
    if [ -n "$STRAT_PLAN_ID" ]; then
      sqlite3 /opt/battletoads-double-dragon/backend/database.db "UPDATE subscriptions SET plan_id = $STRAT_PLAN_ID WHERE id = $COMBINED_SUB;"
      echo "  -> Switched combined subscription $COMBINED_SUB to strategy_100"
    fi
  fi
done

echo "=== 7. Verify ==="
echo "Plans:"
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT code, product_mode, is_active FROM plans ORDER BY id;"
echo ""
echo "Dual tenant subscriptions:"
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT t.slug, p.code, p.product_mode FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id JOIN plans p ON p.id = s.plan_id WHERE t.product_mode = 'dual' ORDER BY t.id, p.product_mode;"

echo ""
echo "=== DEPLOY COMPLETE ==="

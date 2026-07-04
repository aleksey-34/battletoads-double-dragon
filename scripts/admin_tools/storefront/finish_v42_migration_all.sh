#!/usr/bin/env bash
# Finish v4.2 migration: rematerialize partial + migrate remaining shield clients.
set -o pipefail
LOG=/tmp/finish_v42_all.log
API="${BTDD_API:-http://127.0.0.1:3001}"
DB="${BTDD_DB_PATH:-/opt/battletoads-double-dragon/backend/database.db}"
REPO="${BTDD_REPO:-/opt/battletoads-double-dragon}"
cd "$REPO"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) finish v4.2 all ===" | tee "$LOG"

unarchive_saas() {
  local api="$1"
  sqlite3 "$DB" "
    UPDATE strategies SET is_archived=0, is_active=1, updated_at=CURRENT_TIMESTAMP
    WHERE api_key_id=(SELECT id FROM api_keys WHERE name='$api')
      AND name LIKE 'SAAS::%'
      AND COALESCE(strategy_type,'') NOT IN ('dca','dca_futures')
      AND id IN (
        SELECT id FROM strategies
        WHERE api_key_id=(SELECT id FROM api_keys WHERE name='$api')
          AND name LIKE 'SAAS::%'
        ORDER BY id DESC LIMIT 25
      );
  "
}

retry_mat() {
  local tid="$1" slug="$2"
  echo "--- retry-materialize $slug ($tid) ---" | tee -a "$LOG"
  curl -sS -m 900 -X POST "$API/api/saas/algofund/$tid/retry-materialize" | tee -a "$LOG"
  echo | tee -a "$LOG"
  sqlite3 -header -column "$DB" "
    SELECT '$slug' slug,
      CASE WHEN ap.published_system_name LIKE '%v4-2%' THEN 'v4.2' ELSE 'OLD' END card,
      (SELECT COUNT(*) FROM trading_system_members m JOIN trading_systems ts ON ts.id=m.system_id WHERE ts.name='ALGOFUND::$slug') ts_n
    FROM tenants t JOIN algofund_profiles ap ON ap.tenant_id=t.id WHERE t.slug='$slug';
  " | tee -a "$LOG"
}

migrate_slug() {
  local slug="$1"
  local api="$2"
  echo "--- migrate $slug --no-close ---" | tee -a "$LOG"
  unarchive_saas "$api" | tee -a "$LOG"
  BTDD_API="$API" python3 scripts/admin_tools/storefront/migrate_clients_to_synth_v42.py \
    --pilot "$slug" --skip-card --no-close 2>&1 | tee -a "$LOG" || true
  sqlite3 -header -column "$DB" "
    SELECT t.slug,
      CASE WHEN ap.published_system_name LIKE '%v4-2%' THEN 'v4.2' ELSE 'OLD' END card,
      (SELECT COUNT(*) FROM trading_system_members m JOIN trading_systems ts ON ts.id=m.system_id WHERE ts.name='ALGOFUND::'||t.slug) ts_n
    FROM tenants t JOIN algofund_profiles ap ON ap.tenant_id=t.id WHERE t.slug='$slug';
  " | tee -a "$LOG"
  sleep 3
}

# Partial v4.2
retry_mat 69199 artursk-4149120679
retry_mat 41170 ruslan

# Remaining shield → v4.2
migrate_slug artursk-6323499563 artursk-6323499563-api
migrate_slug artursk-6659194994 artursk-6659194994-api
migrate_slug artursk-8018546252 artursk-8018546252-api
migrate_slug artursk-9592571500 artursk-9592571500-api
migrate_slug artursk-5374535192 artursk-5374535192-api
migrate_slug ivan-weex ivan_weex_1

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) done ===" | tee -a "$LOG"

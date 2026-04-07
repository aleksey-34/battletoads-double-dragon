#!/bin/bash
cd /opt/battletoads-double-dragon
node -e "
const db = require('better-sqlite3')('backend/database.db');
console.log('=== PLANS ===');
const plans = db.prepare('SELECT id,code,title,product_mode,max_deposit_total,risk_cap_max FROM plans').all();
plans.forEach(p => console.log(JSON.stringify(p)));

console.log('=== TENANTS ===');
const tenants = db.prepare('SELECT id,slug,product_mode,status,plan_id FROM tenants').all();
tenants.forEach(t => console.log(JSON.stringify(t)));

console.log('=== MASTER materialization source ===');
// Check where BTDD_D1 strategies were materialized from
const strats = db.prepare(\"SELECT id,name,base_symbol,max_deposit,lot_long_percent,lot_short_percent FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') AND is_runtime=1 LIMIT 3\").all();
strats.forEach(s => console.log(JSON.stringify(s)));
"

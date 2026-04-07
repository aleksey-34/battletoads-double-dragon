#!/bin/bash
cd /opt/battletoads-double-dragon/backend
node -e "
const db = require('better-sqlite3')('../backend/database.db');
console.log('=== PLANS ===');
db.prepare('SELECT id,code,title,product_mode,max_deposit_total,risk_cap_max FROM plans').all().forEach(p => console.log(JSON.stringify(p)));
console.log('=== TENANTS ===');
db.prepare('SELECT id,slug,product_mode,status,plan_id FROM tenants').all().forEach(t => console.log(JSON.stringify(t)));
console.log('=== BTDD_D1 strats sample ===');
db.prepare(\"SELECT id,name,base_symbol,max_deposit,lot_long_percent,lot_short_percent,fixed_lot,reinvest_percent FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') AND is_runtime=1 LIMIT 3\").all().forEach(s => console.log(JSON.stringify(s)));
"

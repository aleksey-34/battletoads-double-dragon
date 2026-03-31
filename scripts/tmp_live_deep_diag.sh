set -e
DB=/opt/battletoads-double-dragon/database.db
echo '=== TENANTS / MODES / API / PUBLISHED ==='
sqlite3 -header -column "$DB" "select t.id,t.display_name,t.slug,t.product_mode,t.status,t.assigned_api_key_name,coalesce(ap.published_system_name,'') as published_system_name,coalesce(ap.actual_enabled,0) as actual_enabled,coalesce(ap.requested_enabled,0) as requested_enabled from tenants t left join algofund_profiles ap on ap.tenant_id=t.id order by t.id;"

echo '=== ACTIVE SYSTEMS BY PROFILE ==='
sqlite3 -header -column "$DB" "select ap.tenant_id,aas.profile_id,aas.system_name,aas.weight,aas.is_enabled,aas.assigned_by,aas.updated_at from algofund_active_systems aas join algofund_profiles ap on ap.id=aas.profile_id order by ap.tenant_id,aas.id;"

echo '=== MASTER SYSTEMS ==='
sqlite3 -header -column "$DB" "select ts.id,ts.name,ak.name as api_key,ts.is_active,ts.updated_at from trading_systems ts join api_keys ak on ak.id=ts.api_key_id where ts.name like 'ALGOFUND_MASTER::%' order by ts.id desc limit 30;"

echo '=== TABLE INFO STRATEGIES ==='
sqlite3 -header -column "$DB" "pragma table_info(strategies);"

echo '=== TABLE INFO LIVE_TRADE_EVENTS ==='
sqlite3 -header -column "$DB" "pragma table_info(live_trade_events);"

echo '=== RECENT LIVE EVENTS 48H (MASTER SYSTEMS) ==='
sqlite3 -header -column "$DB" "select datetime(event_ts/1000,'unixepoch') as ts_utc,api_key_name,system_id,strategy_id,event_type,side,symbol from live_trade_events where event_ts >= (strftime('%s','now')-48*3600)*1000 and system_id in (select id from trading_systems where name like 'ALGOFUND_MASTER::%') order by event_ts desc limit 120;"

echo '=== STRATEGY LAST STATES FOR ACTIVE MASTER MEMBERS ==='
sqlite3 -header -column "$DB" "select ts.name as system_name, s.id as strategy_id, s.name as strategy_name, s.base_symbol||'/'||s.quote_symbol as symbol, s.is_active, s.last_error, s.signal, s.position_side, s.position_size_usd, datetime(s.updated_at) as updated_at from trading_systems ts join trading_system_members tsm on tsm.system_id=ts.id and tsm.is_enabled=1 join strategies s on s.id=tsm.strategy_id where ts.name like 'ALGOFUND_MASTER::%' and ts.is_active=1 order by ts.id desc, s.id asc limit 400;"
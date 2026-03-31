set -e
DB=/opt/battletoads-double-dragon/backend/database.db
echo '=== TENANTS / MODES / API / PUBLISHED ==='
sqlite3 -header -column "$DB" "select t.id,t.display_name,t.slug,t.product_mode,t.status,t.assigned_api_key_name,coalesce(ap.published_system_name,'') as published_system_name,coalesce(ap.actual_enabled,0) as actual_enabled,coalesce(ap.requested_enabled,0) as requested_enabled from tenants t left join algofund_profiles ap on ap.tenant_id=t.id order by t.id;"

echo '=== ACTIVE SYSTEMS BY PROFILE ==='
sqlite3 -header -column "$DB" "select ap.tenant_id,aas.profile_id,aas.system_name,aas.weight,aas.is_enabled,aas.assigned_by,aas.updated_at from algofund_active_systems aas join algofund_profiles ap on ap.id=aas.profile_id order by ap.tenant_id,aas.id;"

echo '=== MASTER SYSTEMS ==='
sqlite3 -header -column "$DB" "select ts.id,ts.name,ak.name as api_key,ts.is_active,ts.updated_at from trading_systems ts join api_keys ak on ak.id=ts.api_key_id where ts.name like 'ALGOFUND_MASTER::%' order by ts.id desc limit 30;"

echo '=== STRATEGIES COLUMNS OF INTEREST ==='
sqlite3 -header -column "$DB" "pragma table_info(strategies);"

echo '=== RECENT LIVE EVENTS 72H (MASTER SYSTEMS) ==='
sqlite3 -header -column "$DB" "select datetime(event_ts/1000,'unixepoch') as ts_utc,api_key_name,system_id,strategy_id,event_type,side,symbol from live_trade_events where event_ts >= (strftime('%s','now')-72*3600)*1000 and system_id in (select id from trading_systems where name like 'ALGOFUND_MASTER::%') order by event_ts desc limit 200;"

echo '=== ACTIVE MASTER MEMBERS: STATE ==='
sqlite3 -header -column "$DB" "select ts.id as system_id,ts.name as system_name,s.id as strategy_id,s.name as strategy_name,s.base_symbol||'/'||s.quote_symbol as symbol,s.is_active,coalesce(s.last_error,'') as last_error,coalesce(s.signal,'') as signal,coalesce(s.position_side,'') as position_side,coalesce(s.position_size_usd,0) as position_size_usd,s.updated_at from trading_systems ts join trading_system_members tsm on tsm.system_id=ts.id and tsm.is_enabled=1 join strategies s on s.id=tsm.strategy_id where ts.name like 'ALGOFUND_MASTER::%' and ts.is_active=1 order by ts.id desc, s.id asc limit 500;"
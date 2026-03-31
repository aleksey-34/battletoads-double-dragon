DB=/opt/battletoads-double-dragon/backend/database.db
echo '=== LIVE_TRADE_EVENTS COLUMNS ==='
sqlite3 -header -column "$DB" "pragma table_info(live_trade_events);"

echo '=== SAMPLE LIVE_TRADE_EVENTS RECENT ==='
sqlite3 -header -column "$DB" "select * from live_trade_events order by id desc limit 20;"

echo '=== ACTIVE MASTER MEMBERS: STATE ==='
sqlite3 -header -column "$DB" "select ts.id as system_id,ts.name as system_name,s.id as strategy_id,s.name as strategy_name,s.base_symbol||'/'||s.quote_symbol as symbol,s.is_active,coalesce(s.state,'') as state,coalesce(s.last_signal,'') as last_signal,coalesce(s.last_action,'') as last_action,coalesce(s.last_error,'') as last_error,s.updated_at from trading_systems ts join trading_system_members tsm on tsm.system_id=ts.id and tsm.is_enabled=1 join strategies s on s.id=tsm.strategy_id where ts.name like 'ALGOFUND_MASTER::%' and ts.is_active=1 order by ts.id desc, s.id asc limit 500;"

echo '=== OPEN POSITIONS BY ALGOFUND API KEYS ==='
sqlite3 -header -column "$DB" "select p.api_key_name,p.base_symbol||'/'||p.quote_symbol as symbol,p.side,p.qty,p.entry_price,p.mark_price,p.unrealized_pnl,p.updated_at from positions p where p.api_key_name in (select distinct assigned_api_key_name from tenants where product_mode='algofund_client' and trim(coalesce(assigned_api_key_name,''))!='') order by p.api_key_name,p.base_symbol,p.quote_symbol;"

echo '=== RECENT STRATEGY RUNTIME EVENTS 24H ==='
sqlite3 -header -column "$DB" "select id,tenant_id,strategy_id,api_key_name,event_type,severity,substr(message,1,140) as message,created_at,resolved_at from strategy_runtime_events where datetime(created_at) >= datetime('now','-24 hours') order by id desc limit 200;"
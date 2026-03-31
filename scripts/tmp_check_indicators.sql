.headers on
.mode column
SELECT
  ts.id AS system_id,
  ts.name AS system_name,
  s.id AS strategy_id,
  s.name AS strategy_name,
  s.show_indicators,
  s.show_chart,
  s.show_positions_on_chart,
  s.show_trades_on_chart,
  s.updated_at
FROM trading_systems ts
JOIN trading_system_members tsm ON tsm.system_id = ts.id AND COALESCE(tsm.is_enabled,1)=1
JOIN strategies s ON s.id = tsm.strategy_id
WHERE ts.name = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
ORDER BY s.id;

SELECT id, name, is_active
FROM trading_systems
WHERE lower(name) LIKE '%multiset%'
ORDER BY id;
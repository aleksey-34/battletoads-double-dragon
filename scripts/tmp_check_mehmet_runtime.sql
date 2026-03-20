SELECT id, name, exchange, api_key, secret, passphrase, testnet, demo
FROM api_keys
WHERE name = 'Mehmet_Bingx';

SELECT ts.id, ts.name, ts.api_key_id, ts.is_active, ts.created_at, ts.updated_at
FROM trading_systems ts
JOIN api_keys ak ON ak.id = ts.api_key_id
WHERE ak.name = 'Mehmet_Bingx'
ORDER BY ts.id DESC
LIMIT 20;

SELECT s.id, s.name, s.api_key_id, s.is_active, s.created_at, s.updated_at
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE ak.name = 'Mehmet_Bingx'
ORDER BY s.id DESC
LIMIT 20;

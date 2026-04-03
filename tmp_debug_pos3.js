// Run: cd /opt/battletoads-double-dragon/backend && node tmp_debug_pos3.js
const ccxt = require('ccxt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

db.all("SELECT name, api_key, secret FROM api_keys WHERE name IN ('aliseyilmaz07fb', 'leventyilmaz07fb')", async (err, keys) => {
  if (err) { console.error(err); process.exit(1); }
  db.close();
  
  for (const k of keys) {
    console.log('\n=== ' + k.name + ' ===');
    const ex = new ccxt.mexc({ apiKey: k.api_key, secret: k.secret, options: { defaultType: 'swap' } });
    try {
      const positions = await ex.fetchPositions(['DOGE/USDT:USDT']);
      for (const p of positions) {
        if (Math.abs(Number(p.contracts || 0)) > 0) {
          console.log('UNIFIED:', JSON.stringify({
            unrealizedPnl: p.unrealizedPnl,
            markPrice: p.markPrice,
            entryPrice: p.entryPrice,
            side: p.side,
            contracts: p.contracts,
            contractSize: p.contractSize,
            leverage: p.leverage,
          }, null, 2));
          console.log('RAW info:', JSON.stringify(p.info, null, 2));
        }
      }
    } catch (e) { console.error(e.message); }
  }
  process.exit(0);
});

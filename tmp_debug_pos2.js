// Run from backend/ dir: cd backend && node ../tmp_debug_pos2.js
const ccxt = require('ccxt');
const Database = require('better-sqlite3');
const path = require('path');

(async () => {
  const db = new Database(path.join(__dirname, 'backend', 'database.db'), { readonly: true });
  const keys = db.prepare("SELECT name, exchange, api_key, api_secret FROM api_keys WHERE name IN ('aliseyilmaz07fb', 'leventyilmaz07fb')").all();
  db.close();
  
  for (const key of keys) {
    console.log(`\n=== ${key.name} ===`);
    const ex = new ccxt.mexc({ apiKey: key.api_key, secret: key.api_secret, options: { defaultType: 'swap' } });
    try {
      const positions = await ex.fetchPositions(['DOGE/USDT:USDT']);
      for (const p of positions) {
        if (Math.abs(Number(p.contracts || 0)) > 0) {
          console.log('UNIFIED:', JSON.stringify({ symbol: p.symbol, side: p.side, contracts: p.contracts, contractSize: p.contractSize, entryPrice: p.entryPrice, markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl, leverage: p.leverage, liquidationPrice: p.liquidationPrice }, null, 2));
          console.log('RAW info:', JSON.stringify(p.info, null, 2));
        }
      }
    } catch (e) { console.error(e.message); }
  }
  process.exit(0);
})();

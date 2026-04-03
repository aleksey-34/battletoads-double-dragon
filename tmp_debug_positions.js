// Debug: raw CCXT fetchPositions for MEXC
// Upload to VPS, run: node tmp_debug_positions.js
const path = require('path');
const ccxt = require(path.join(__dirname, 'backend', 'node_modules', 'ccxt', 'js', 'ccxt.js'));

// Load .env  
require(path.join(__dirname, 'backend', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, 'backend', '.env') });

(async () => {
  // Read keys from DB
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'backend', 'database.db'), { readonly: true });
  
  const keys = db.prepare("SELECT name, exchange, api_key, api_secret FROM api_keys WHERE name IN ('aliseyilmaz07fb', 'leventyilmaz07fb')").all();
  db.close();
  
  for (const key of keys) {
    console.log(`\n=== ${key.name} (${key.exchange}) ===`);
    const ex = new ccxt.mexc({
      apiKey: key.api_key,
      secret: key.api_secret,
      options: { defaultType: 'swap' },
    });
    
    try {
      const positions = await ex.fetchPositions(['DOGE/USDT:USDT']);
      for (const p of positions) {
        if (Math.abs(Number(p.contracts || 0)) > 0) {
          console.log('CCXT unified:', JSON.stringify({
            symbol: p.symbol,
            side: p.side,
            contracts: p.contracts,
            contractSize: p.contractSize,
            entryPrice: p.entryPrice,
            markPrice: p.markPrice,
            unrealizedPnl: p.unrealizedPnl,
            liquidationPrice: p.liquidationPrice,
            leverage: p.leverage,
          }, null, 2));
          console.log('Raw info:', JSON.stringify(p.info, null, 2));
        }
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  }
  process.exit(0);
})();

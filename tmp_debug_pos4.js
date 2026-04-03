// Full position dump
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
          // Print ALL unified fields
          console.log('unrealizedPnl:', p.unrealizedPnl, typeof p.unrealizedPnl);
          console.log('markPrice:', p.markPrice, typeof p.markPrice);
          console.log('entryPrice:', p.entryPrice);
          console.log('side:', p.side);
          console.log('contracts:', p.contracts);
          console.log('contractSize:', p.contractSize);

          // Try to get ticker for mark price
          const ticker = await ex.fetchTicker('DOGE/USDT:USDT');
          console.log('Ticker last:', ticker.last, 'mark:', ticker.info?.fairPrice || ticker.info?.markPrice);
          
          // Manual PnL calc
          const cs = Number(p.contractSize || 1);
          const entry = Number(p.entryPrice);
          const mark = Number(ticker.last);
          const qty = Number(p.contracts);
          const side = p.side;
          let manualPnl;
          if (side === 'long') {
            manualPnl = (mark - entry) * qty * cs;
          } else {
            manualPnl = (entry - mark) * qty * cs;
          }
          console.log('Manual UPNL:', manualPnl.toFixed(4), 'USDT');
        }
      }
    } catch (e) { console.error(e.message); }
  }
  process.exit(0);
});

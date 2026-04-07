const ccxt = require('ccxt');
const db = require('better-sqlite3')('/opt/battletoads-double-dragon/backend/data/main.db');
const keys = db.prepare('SELECT name, exchange, api_key, api_secret FROM api_keys').all();
(async () => {
  for (const k of keys) {
    try {
      const Ex = ccxt[k.exchange];
      if (!Ex) { console.log(k.name, k.exchange, 'unknown exchange'); continue; }
      const ex = new Ex({ apiKey: k.api_key, secret: k.api_secret, options: { defaultType: 'swap' } });
      const bal = await ex.fetchBalance();
      const usdt = bal.USDT || {};
      console.log(k.name, k.exchange, 'total:', usdt.total, 'free:', usdt.free, 'used:', usdt.used);
      // Check open positions
      try {
        const pos = await ex.fetchPositions();
        const open = pos.filter(p => parseFloat(p.contracts) > 0);
        if (open.length) {
          for (const p of open) {
            console.log('  POSITION:', p.symbol, p.side, 'size:', p.contracts, 'pnl:', p.unrealizedPnl, 'lev:', p.leverage);
          }
        } else {
          console.log('  No open positions');
        }
      } catch(e2) { console.log('  positions err:', e2.message?.slice(0,60)); }
    } catch(e) { console.log(k.name, k.exchange, 'ERR:', e.message?.slice(0,100)); }
  }
  db.close();
})();

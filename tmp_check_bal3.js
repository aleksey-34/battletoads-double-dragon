process.chdir('/opt/battletoads-double-dragon/backend');
const ccxt = require('ccxt');
const Database = require('better-sqlite3');
const db = new Database('/opt/battletoads-double-dragon/backend/data/main.db');

const keys = db.prepare('SELECT name, exchange, api_key, api_secret, label FROM api_keys').all();
console.log('=== API KEYS ===');
keys.forEach(k => console.log(k.name, '|', k.exchange, '|', k.label || ''));

(async () => {
  console.log('\n=== BALANCES & POSITIONS ===');
  for (const k of keys) {
    try {
      const ExClass = ccxt[k.exchange];
      if (!ExClass) { console.log(k.name, k.exchange, '- unknown exchange class'); continue; }
      const ex = new ExClass({
        apiKey: k.api_key,
        secret: k.api_secret,
        options: { defaultType: 'swap' }
      });
      const bal = await ex.fetchBalance();
      const u = bal.USDT || {};
      console.log('\n' + k.name, '(' + k.exchange + '):', 'total=' + u.total, 'free=' + u.free, 'used=' + u.used);
      
      try {
        const positions = await ex.fetchPositions();
        const open = positions.filter(p => Math.abs(parseFloat(p.contracts || 0)) > 0);
        if (open.length) {
          open.forEach(p => {
            console.log('  POS:', p.symbol, p.side, 'contracts=' + p.contracts, 'uPnL=' + p.unrealizedPnl, 'lev=' + p.leverage);
          });
        } else {
          console.log('  No open positions');
        }
      } catch(e2) { console.log('  pos err:', e2.message?.slice(0,80)); }
    } catch(e) {
      console.log(k.name, k.exchange, 'ERR:', e.message?.slice(0,120));
    }
  }
  
  // Check razgon config if exists
  try {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('/opt/battletoads-double-dragon/backend/data/razgon_config.json', 'utf8'));
    console.log('\n=== RAZGON CONFIG ===');
    console.log('running:', cfg.running, 'presetMode:', cfg.presetMode);
    console.log('apiKeys:', JSON.stringify(cfg.apiKeys));
  } catch(e) { console.log('\nNo razgon_config.json found'); }
  
  db.close();
  process.exit(0);
})();

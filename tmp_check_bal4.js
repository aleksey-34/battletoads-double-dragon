// Run from /opt/battletoads-double-dragon/backend
// Uses sqlite3 CLI instead of better-sqlite3 module

const { execSync } = require('child_process');

// Get API keys via sqlite3 CLI
const keysRaw = execSync('sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT name, exchange, api_key, secret FROM api_keys"', { encoding: 'utf8' });
const keys = keysRaw.trim().split('\n').filter(Boolean).map(line => {
  const [name, exchange, api_key, secret] = line.split('|');
  return { name, exchange, api_key, secret };
});

console.log('=== API KEYS (' + keys.length + ') ===');
keys.forEach(k => console.log(' ', k.name, '|', k.exchange));

const ccxt = require('ccxt');

(async () => {
  console.log('\n=== BALANCES & POSITIONS ===');
  for (const k of keys) {
    try {
      const ExClass = ccxt[k.exchange.toLowerCase()];
      if (!ExClass) { console.log(k.name, '- unknown exchange:', k.exchange); continue; }
      const ex = new ExClass({
        apiKey: k.api_key,
        secret: k.secret,
        options: { defaultType: 'swap' }
      });
      const bal = await ex.fetchBalance();
      const u = bal.USDT || {};
      console.log('\n' + k.name + ' (' + k.exchange + '): total=' + u.total + ' free=' + u.free + ' used=' + u.used);
      
      try {
        const positions = await ex.fetchPositions();
        const open = positions.filter(p => Math.abs(parseFloat(p.contracts || 0)) > 0);
        if (open.length) {
          open.forEach(p => {
            console.log('  POS:', p.symbol, p.side, 'qty=' + p.contracts, 'uPnL=' + p.unrealizedPnl, 'lev=' + p.leverage);
          });
        } else {
          console.log('  No open positions');
        }
      } catch(e2) { console.log('  pos err:', e2.message?.slice(0,80)); }
    } catch(e) {
      console.log(k.name, k.exchange, 'ERR:', e.message?.slice(0,120));
    }
  }
  
  // Check razgon config
  const fs = require('fs');
  for (const p of ['razgon_config.json', 'data/razgon_config.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log('\n=== RAZGON CONFIG (' + p + ') ===');
      console.log(JSON.stringify(cfg, null, 2));
    } catch(e) {}
  }
  
  process.exit(0);
})();

// Uses the compiled dist to check balances via the app's own exchange client layer
process.chdir('/opt/battletoads-double-dragon/backend');
const path = require('path');

// Load the compiled app modules
const { getBalances } = require('./dist/exchange/balances');
const db = require('better-sqlite3')('./data/main.db');

const keys = db.prepare('SELECT name, exchange, label FROM api_keys').all();
console.log('API keys in DB:', keys.length);
keys.forEach(k => console.log(' -', k.name, k.exchange, k.label || ''));

(async () => {
  for (const k of keys) {
    try {
      const bal = await getBalances(k.name);
      console.log(k.name, ':', JSON.stringify(bal));
    } catch(e) {
      console.log(k.name, 'ERR:', e.message?.slice(0,120));
    }
  }
  db.close();
  process.exit(0);
})();

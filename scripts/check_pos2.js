const ccxt = require('ccxt');
const { execSync } = require('child_process');

const rawOutput = execSync('sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT name, api_key, secret, exchange FROM api_keys;"').toString().trim();
const rows = rawOutput.split('\n').filter(Boolean).map(line => {
  const [name, api_key, secret, exchange] = line.split('|');
  return { name, api_key, secret, exchange: exchange || 'binance' };
});
console.log('Keys:', rows.map(r => r.name).join(', '));

async function check(row) {
  try {
    const ExClass = ccxt[row.exchange.toLowerCase()];
    if (!ExClass) { console.log(row.name + ': unknown exchange ' + row.exchange); return; }
    const ex = new ExClass({apiKey: row.api_key, secret: row.secret, options:{defaultType:'swap'}});
    const ps = await ex.fetchPositions();
    const open = ps.filter(p => Math.abs(parseFloat(p.contracts||0)) > 0);
    if (!open.length) { console.log(row.name + ': no open positions'); return; }
    open.forEach(p => console.log(row.name + ':', p.symbol, p.side, 'qty=' + p.contracts, 'pnl=' + p.unrealizedPnl));
  } catch(e) { console.log(row.name + ': error ' + e.message.substring(0,100)); }
}

(async () => {
  for (const row of rows) {
    await check(row);
  }
})();

const ccxt = require('/opt/battletoads-double-dragon/backend/node_modules/ccxt');

async function check(name, apiKey, secret) {
  try {
    const ex = new ccxt.binance({apiKey, secret, options:{defaultType:'swap'}});
    const ps = await ex.fetchPositions();
    const open = ps.filter(p => Math.abs(parseFloat(p.contracts||0)) > 0);
    if (!open.length) { console.log(name + ': no positions'); return; }
    open.forEach(p => console.log(name + ':', p.symbol, p.side, 'qty=' + p.contracts, 'pnl=' + p.unrealizedPnl));
  } catch(e) { console.log(name + ': error ' + e.message.substring(0,80)); }
}

(async () => {
  const configMod = require('/opt/battletoads-double-dragon/backend/dist/config');
  const config = configMod.default || configMod;
  const keys = config.apiKeys || {};
  for (const [name, k] of Object.entries(keys)) {
    if (k.apiKey && k.secret) await check(name, k.apiKey, k.secret);
  }
})();

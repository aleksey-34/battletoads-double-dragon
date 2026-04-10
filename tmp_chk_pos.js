const ccxt = require('ccxt');
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('/opt/battletoads-double-dragon/backend/database.db');
db.get("SELECT * FROM api_keys WHERE name='BTDD_MEX_1'", async (err, row) => {
  if (err) { console.error(err); return; }
  const ex = new ccxt.mexc({apiKey: row.api_key, secret: row.secret});
  ex.setSandboxMode(false);
  try {
    await ex.loadMarkets();
    const pos = await ex.fetchPositions();
    const open = pos.filter(p => parseFloat(p.contracts) > 0);
    console.log('Open:', open.length);
    open.forEach(p => console.log(p.symbol, p.side, p.contracts, 'entry='+p.entryPrice, 'notional='+p.notional));

    // Try to close SUI short (79 contracts) with a buy order
    if (open.length > 0) {
      const p = open[0]; // SUI/USDT:USDT short
      console.log('\nTrying to close:', p.symbol, p.side, p.contracts);
      try {
        const order = await ex.createOrder(p.symbol, 'market', 'buy', parseFloat(p.contracts), undefined, {reduceOnly: true});
        console.log('SUCCESS:', JSON.stringify(order));
      } catch(e2) {
        console.log('FAIL reduceOnly:', e2.message);
        // Try without reduceOnly
        try {
          const order2 = await ex.createOrder(p.symbol, 'market', 'buy', parseFloat(p.contracts));
          console.log('SUCCESS no reduceOnly:', JSON.stringify(order2));
        } catch(e3) {
          console.log('FAIL no reduceOnly:', e3.message);
        }
      }
    }
  } catch(e) { console.error(e.message); }
});

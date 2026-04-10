const ccxt = require('ccxt');
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('/opt/battletoads-double-dragon/backend/database.db');
db.get("SELECT * FROM api_keys WHERE name='BTDD_MEX_1'", async (err, row) => {
  if (err) { console.error(err); return; }
  const ex = new ccxt.mexc({apiKey: row.api_key, secret: row.secret});
  ex.setSandboxMode(false);
  try {
    await ex.loadMarkets();
    
    // Check position mode
    const pos = await ex.fetchPositions();
    const open = pos.filter(p => parseFloat(p.contracts) > 0);
    console.log('Open:', open.length);
    open.forEach(p => console.log(p.symbol, p.side, p.contracts, 'hedged='+p.hedged, 'info.positionSide='+((p.info||{}).positionSide)));

    // Try to close first position with reduceOnly but NO positionSide (like engine does)
    if (open.length > 0) {
      const p = open[0];
      const closeSide = p.side === 'short' ? 'buy' : 'sell';
      console.log('\nTest 1: close WITHOUT positionSide');
      try {
        const order = await ex.createOrder(p.symbol, 'market', closeSide, parseFloat(p.contracts), undefined, {reduceOnly: true});
        console.log('OK:', order.id);
      } catch(e) {
        console.log('FAIL:', e.message.substring(0, 300));
        // Now try with positionSide
        console.log('\nTest 2: close WITH positionSide');
        const posSide = p.side === 'long' ? 'LONG' : 'SHORT';
        try {
          const order2 = await ex.createOrder(p.symbol, 'market', closeSide, parseFloat(p.contracts), undefined, {reduceOnly: true, positionSide: posSide});
          console.log('OK with positionSide:', order2.id);
        } catch(e2) {
          console.log('FAIL with positionSide:', e2.message.substring(0, 300));
        }
      }
    }
  } catch(e) { console.error(e.message); }
});

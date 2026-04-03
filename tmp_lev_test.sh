#!/bin/bash
cd /opt/battletoads-double-dragon/backend
node -e "
const ccxt = require('ccxt');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');
db.get(\"SELECT * FROM api_keys WHERE name='alisanyilmaz2407'\", (err, row) => {
  if(err){console.log('DB err:',err.message);process.exit(1);}
  console.log('Key name:', row.name);
  const ex = new ccxt.mexc({apiKey: row.api_key, secret: row.secret, options:{defaultType:'swap'}});
  ex.loadMarkets().then(async () => {
    try { const r = await ex.setLeverage(20,'DOGE/USDT:USDT',{openType:2,positionType:1}); console.log('long resp:', JSON.stringify(r)); } catch(e){ console.log('long err:',e.message); }
    try { const r = await ex.setLeverage(20,'DOGE/USDT:USDT',{openType:2,positionType:2}); console.log('short resp:', JSON.stringify(r)); } catch(e){ console.log('short err:',e.message); }
    try { const r = await ex.setLeverage(20,'DOGE/USDT:USDT'); console.log('both resp:', JSON.stringify(r)); } catch(e){ console.log('both err:',e.message); }
    const pos = await ex.fetchPositions(['DOGE/USDT:USDT']);
    pos.forEach(p => console.log('side:', p.side, 'lev:', p.leverage, 'info.lev:', p.info?.leverage, 'openType:', p.info?.openType));
    db.close();
    process.exit(0);
  }).catch(e => {console.error(e.message);process.exit(1);});
});
" 2>&1

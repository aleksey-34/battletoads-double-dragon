#!/bin/bash
cd /opt/battletoads-double-dragon/backend
node -e "
const ccxt = require('ccxt');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');
db.get(\"SELECT * FROM api_keys WHERE name='alisanyilmaz2407'\", (err, row) => {
  const ex = new ccxt.mexc({apiKey: row.api_key, secret: row.secret, options:{defaultType:'swap'}});
  ex.loadMarkets().then(async () => {
    const pos = await ex.fetchPositions(['DOGE/USDT:USDT']);
    pos.forEach(p => console.log('side:', p.side, 'leverage:', p.leverage, 'info.leverage:', p.info?.leverage));
    db.close();
    process.exit(0);
  });
});
" 2>&1

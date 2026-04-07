#!/bin/bash
cd /opt/battletoads-double-dragon/backend
node -e "
const ccxt = require('ccxt');
const {execSync} = require('child_process');
const rows = execSync(\"sqlite3 database.db \\\"SELECT name,exchange,api_key,secret,passphrase FROM api_keys WHERE name IN ('BTDD_MEX_1','HDB_14');\\\"\").toString().trim().split('\n');
(async()=>{
  for(const row of rows){
    const [name,exchange,api_key,secret,passphrase] = row.split('|');
    try{
      const Ex = ccxt[exchange.toLowerCase()];
      const ex = new Ex({apiKey:api_key, secret:secret, password:passphrase||undefined});
      ex.options = ex.options||{};
      ex.options.defaultType='swap';
      const pos = await ex.fetchPositions();
      const open = pos.filter(p=>Math.abs(parseFloat(p.contracts||0))>0);
      console.log(name+': '+open.length+' open positions');
      for(const p of open){
        const sym = p.symbol;
        const side = p.side; // 'long' or 'short'
        const contracts = Math.abs(parseFloat(p.contracts));
        const closeSide = side === 'long' ? 'sell' : 'buy';
        console.log('  Closing '+sym+' '+side+' '+contracts+' contracts...');
        try {
          const order = await ex.createOrder(sym, 'market', closeSide, contracts, undefined, {reduceOnly: true});
          console.log('  CLOSED '+sym+' OK, orderId='+order.id);
        } catch(e2) {
          console.log('  CLOSE FAILED '+sym+': '+e2.message);
        }
      }
    }catch(e){console.log(name+' ERR: '+e.message)}
  }
})()
" 2>&1

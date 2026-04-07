#!/bin/bash
cd /opt/battletoads-double-dragon/backend
node -e "
const ccxt = require('ccxt');
const Database = require('better-sqlite3');
const db = new Database('database.db');
const keys = db.prepare(\"SELECT * FROM api_keys WHERE name IN ('BTDD_MEX_1','HDB_14')\").all();
(async()=>{
  for(const k of keys){
    try{
      const Ex = ccxt[k.exchange.toLowerCase()];
      const ex = new Ex({apiKey:k.api_key, secret:k.secret, password:k.passphrase});
      ex.options = ex.options||{};
      ex.options.defaultType='swap';
      const bal = await ex.fetchBalance({type:'swap'});
      const pos = await ex.fetchPositions();
      const open = pos.filter(p=>Math.abs(parseFloat(p.contracts||0))>0);
      console.log(k.name+' ('+k.exchange+'): total=\$'+parseFloat(bal.total?.USDT||0).toFixed(2)+' free=\$'+parseFloat(bal.free?.USDT||0).toFixed(2));
      for(const p of open){
        console.log('  '+p.symbol+' '+p.side+' contracts='+p.contracts+' entry='+p.entryPrice+' pnl='+(p.unrealizedPnl||'?'));
      }
      if(!open.length) console.log('  No positions');
    }catch(e){console.log(k.name+' ERR: '+e.message)}
  }
})()
" 2>&1

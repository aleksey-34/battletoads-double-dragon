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
      const bal = await ex.fetchBalance({type:'swap'});
      const pos = await ex.fetchPositions();
      const open = pos.filter(p=>Math.abs(parseFloat(p.contracts||0))>0);
      console.log(name+' ('+exchange+'): total=\$'+parseFloat(bal.total?.USDT||0).toFixed(2)+' free=\$'+parseFloat(bal.free?.USDT||0).toFixed(2));
      for(const p of open){
        console.log('  '+p.symbol+' '+p.side+' contracts='+p.contracts+' entry='+p.entryPrice+' pnl='+(p.unrealizedPnl||'?'));
      }
      if(!open.length) console.log('  No positions');
    }catch(e){console.log(name+' ERR: '+e.message)}
  }
})()
" 2>&1

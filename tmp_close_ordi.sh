#!/bin/bash
cd /opt/battletoads-double-dragon/backend
node -e "
const ccxt=require('ccxt');
const {execSync}=require('child_process');
const r=execSync(\"sqlite3 database.db \\\"SELECT api_key,secret FROM api_keys WHERE name='BTDD_MEX_1';\\\"\").toString().trim().split('|');
(async()=>{
  const ex=new ccxt.mexc({apiKey:r[0],secret:r[1]});
  ex.options={defaultType:'swap'};
  const o=await ex.createOrder('ORDI/USDT:USDT','market','sell',228,undefined,{reduceOnly:true});
  console.log('CLOSED ORDI',o.id);
})()
" 2>&1

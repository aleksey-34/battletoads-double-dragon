const ccxt = require('ccxt');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('../database.db');
function dbGet(sql, params) { return new Promise((res,rej) => db.get(sql, params, (e,r) => e ? rej(e) : res(r))); }
(async()=>{
  const row = await dbGet('SELECT * FROM api_keys WHERE name = ?', ['alisanyilmaz2407']);
  const ex = new ccxt.mexc({apiKey: row.api_key, secret: row.secret, options:{defaultType:'swap'}});
  await ex.loadMarkets();
  // setLeverage and log FULL response
  try { const r = await ex.setLeverage(20,'DOGE/USDT:USDT',{side:'long'}); console.log('long resp:', JSON.stringify(r)); } catch(e){ console.log('long err:',e.message); }
  try { const r = await ex.setLeverage(20,'DOGE/USDT:USDT',{side:'short'}); console.log('short resp:', JSON.stringify(r)); } catch(e){ console.log('short err:',e.message); }
  try { const r = await ex.setLeverage(20,'DOGE/USDT:USDT'); console.log('both resp:', JSON.stringify(r)); } catch(e){ console.log('both err:',e.message); }
  // Check positions
  const pos = await ex.fetchPositions(['DOGE/USDT:USDT']);
  pos.forEach(p => console.log('side:', p.side, 'leverage:', p.leverage, 'info.leverage:', p.info?.leverage, 'info.openType:', p.info?.openType));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});

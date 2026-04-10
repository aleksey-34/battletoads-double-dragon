const ccxt = require('ccxt');
(async () => {
  const ex = new ccxt.mexc({ enableRateLimit: true });
  await ex.loadMarkets();
  // Try different symbol formats
  for (const sym of ['PEPE/USDT:USDT', 'PEPE/USDT', 'PEPEUSDT']) {
    const has = ex.markets[sym] ? 'YES' : 'NO';
    console.log(sym, '→', has);
  }
  // Fetch candles
  try {
    const c = await ex.fetchOHLCV('PEPE/USDT:USDT', '1m', undefined, 3);
    console.log('PEPE/USDT:USDT candles:', c.length, c[0]);
  } catch(e) { console.log('ERR swap:', e.message.slice(0,200)); }
  try {
    const c = await ex.fetchOHLCV('PEPE/USDT', '1m', undefined, 3);
    console.log('PEPE/USDT candles:', c.length, c[0]);
  } catch(e) { console.log('ERR spot:', e.message.slice(0,200)); }
  // Try with since
  const since = Date.now() - 3600000; // 1h ago
  try {
    const c = await ex.fetchOHLCV('PEPE/USDT:USDT', '1m', since, 10);
    console.log('With since:', c.length, c[0]);
  } catch(e) { console.log('ERR since:', e.message.slice(0,200)); }
})();

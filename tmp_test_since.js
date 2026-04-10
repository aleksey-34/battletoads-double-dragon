const ccxt = require('ccxt');
(async () => {
  const ex = new ccxt.mexc({ enableRateLimit: true });
  const since3mo = Date.now() - 90 * 24 * 3600 * 1000;
  const since1w = Date.now() - 7 * 24 * 3600 * 1000;
  console.log('3mo since:', new Date(since3mo).toISOString());
  console.log('1w since:', new Date(since1w).toISOString());

  try {
    const c = await ex.fetchOHLCV('PEPE/USDT:USDT', '1m', since3mo, 5);
    console.log('3mo swap:', c.length, c[0]);
  } catch(e) { console.log('3mo swap ERR:', e.message.slice(0,200)); }

  try {
    const c = await ex.fetchOHLCV('PEPE/USDT:USDT', '1m', since1w, 5);
    console.log('1w swap:', c.length, c[0]);
  } catch(e) { console.log('1w swap ERR:', e.message.slice(0,200)); }

  try {
    const c = await ex.fetchOHLCV('PEPE/USDT', '1m', since3mo, 5);
    console.log('3mo spot:', c.length, c[0]);
  } catch(e) { console.log('3mo spot ERR:', e.message.slice(0,200)); }
})();

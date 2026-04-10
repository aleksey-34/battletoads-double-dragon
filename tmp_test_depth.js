const ccxt = require('ccxt');
(async () => {
  const ex = new ccxt.mexc({ enableRateLimit: true });
  const periods = [
    { label: '1 week', ms: 7 * 86400000 },
    { label: '2 weeks', ms: 14 * 86400000 },
    { label: '1 month', ms: 30 * 86400000 },
    { label: '2 months', ms: 60 * 86400000 },
    { label: '3 months', ms: 90 * 86400000 },
  ];
  const timeframes = ['1m', '5m', '15m', '1h'];
  
  for (const tf of timeframes) {
    console.log(`\n=== ${tf} ===`);
    for (const p of periods) {
      const since = Date.now() - p.ms;
      try {
        const c = await ex.fetchOHLCV('PEPE/USDT:USDT', tf, since, 3);
        const firstDate = c.length > 0 ? new Date(c[0][0]).toISOString().slice(0,10) : 'none';
        console.log(`  ${p.label}: ${c.length} candles, first=${firstDate}`);
      } catch(e) { console.log(`  ${p.label}: ERR ${e.message.slice(0,100)}`); }
    }
  }
})();

const ccxt = require('ccxt');

async function main() {
  const m = new ccxt.mexc({
    options: { defaultType: 'swap' }
  });
  await m.loadMarkets();
  
  const market = m.market('BTC/USDT:USDT');
  console.log('BTC/USDT:USDT contractSize:', market.contractSize);
  console.log('BTC/USDT:USDT precision:', JSON.stringify(market.precision));
  
  const doge = m.market('DOGE/USDT:USDT');
  console.log('DOGE/USDT:USDT contractSize:', doge.contractSize);
}

main().catch(e => console.error(e.message));

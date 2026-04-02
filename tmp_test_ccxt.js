const ccxt = require('ccxt');
const m = new ccxt.mexc({
  options: { defaultType: 'swap', unavailableContracts: {} }
});
console.log('ccxt version:', ccxt.version);
console.log('unavailableContracts after init:', JSON.stringify(m.options.unavailableContracts));

m.loadMarkets().then(() => {
  console.log('unavailableContracts after loadMarkets:', JSON.stringify(m.options.unavailableContracts));
  try {
    const s = m.market('BTC/USDT:USDT');
    console.log('BTC/USDT:USDT market found:', s.id);
  } catch (e) {
    console.log('BTC/USDT:USDT market error:', e.message);
  }
}).catch(e => console.log('loadMarkets error:', e.message));

const fs = require('fs');

(async () => {
  // Get tickers (works)
  console.log('Fetching WEEX tickers...');
  const res = await fetch('https://api-contract.weex.com/capi/v2/market/tickers');
  const json = await res.json();
  const tickers = Array.isArray(json.data) ? json.data : [];
  console.log('Total tickers:', tickers.length);
  
  // Extract USDT symbols
  const weexSymbols = tickers
    .map(t => String(t.symbol || '').replace(/^cmt_/i, '').toUpperCase())
    .filter(s => s.endsWith('USDT'))
    .sort();
  console.log('WEEX USDT symbols:', weexSymbols.length);

  // Load local
  const localPath = String.raw`C:\Users\Aleksei\Downloads\Telegram Desktop\apiTradingSymbols.json`;
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8')).sort();
  console.log('Local file symbols:', local.length);

  // Compare
  const weexSet = new Set(weexSymbols);
  const localSet = new Set(local);
  
  const onlyLocal = local.filter(s => !weexSet.has(s));
  const onlyWeex = weexSymbols.filter(s => !localSet.has(s));
  const both = local.filter(s => weexSet.has(s));
  
  console.log(`\nMatched: ${both.length}`);
  console.log(`Only in local file (NOT on WEEX): ${onlyLocal.length}`);
  if (onlyLocal.length > 0) console.log('  ', onlyLocal.join(', '));
  console.log(`Only on WEEX (new, not in file): ${onlyWeex.length}`);
  if (onlyWeex.length > 0) console.log('  ', onlyWeex.join(', '));
})().catch(e => console.error(e.message));


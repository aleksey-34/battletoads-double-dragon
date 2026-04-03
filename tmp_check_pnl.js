const {getPositions} = require('./backend/dist/bot/exchange');
(async () => {
  try {
    const p1 = await getPositions('aliseyilmaz07fb', 'DOGEUSDT');
    console.log('MASTER:', JSON.stringify(p1, null, 2));
    const p2 = await getPositions('leventyilmaz07fb', 'DOGEUSDT');
    console.log('HEDGE:', JSON.stringify(p2, null, 2));
  } catch(e) { console.error(e.message); }
  process.exit(0);
})();

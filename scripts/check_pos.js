const {getPositions} = require('/opt/battletoads-double-dragon/backend/dist/bot/exchange');
async function run() {
  for (const key of ['Mehmet_Bingx','HDB_15','HDB_18','BTDD_D1','mustafa']) {
    try {
      const pos = await getPositions(key);
      const open = pos.filter(p => Math.abs(parseFloat(p.size || p.contracts || 0)) > 0);
      if (!open.length) { console.log(key + ': no open positions'); continue; }
      open.forEach(p => console.log(key + ':', p.symbol, p.side, 'size=' + (p.size||p.contracts), 'pnl=' + (p.unrealizedPnl||p.pnl||'?')));
    } catch(e) { console.log(key + ': ' + e.message.substring(0,100)); }
  }
}
run().then(() => process.exit(0));

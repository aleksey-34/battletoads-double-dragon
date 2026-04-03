/**
 * Razgon MEXC Fresh Scan v3 — 2026-04-03
 * All pages: positions, orders, funding, spot trades (all symbols), spot account, futures assets
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const API_KEY = 'mx0vglapWbKfPYn9rU';
const API_SECRET = 'f4e896d8e37c4e69ad1f09d79df20754';
const BASE_SPOT = 'https://api.mexc.com';
const BASE_FUT = 'https://contract.mexc.com';
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = `/opt/btdd/razgon/scan_${TS}`;
fs.mkdirSync(OUT, { recursive: true });

function signSpot(p: Record<string, string|number>): string {
  const qs = Object.entries(p).map(([k,v])=>`${k}=${v}`).join('&');
  return `${qs}&signature=${crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex')}`;
}
async function spotGet(ep: string, p: Record<string, string|number> = {}) {
  const all = { ...p, timestamp: Date.now(), recvWindow: 60000 };
  const res = await fetch(`${BASE_SPOT}${ep}?${signSpot(all)}`, { headers: { 'X-MEXC-APIKEY': API_KEY } });
  if (!res.ok) { const t = await res.text(); throw new Error(`SPOT ${ep} ${res.status}: ${t}`); }
  return res.json();
}
function signFut(ts: string, p: Record<string, string|number> = {}): string {
  const qs = Object.entries(p).map(([k,v])=>`${k}=${v}`).join('&');
  return crypto.createHmac('sha256', API_SECRET).update(qs ? `${API_KEY}${ts}${qs}` : `${API_KEY}${ts}`).digest('hex');
}
async function futGet(ep: string, p: Record<string, string|number> = {}) {
  const ts = String(Date.now());
  const qs = Object.entries(p).map(([k,v])=>`${k}=${v}`).join('&');
  const res = await fetch(`${BASE_FUT}${ep}${qs ? '?'+qs : ''}`, {
    headers: { 'ApiKey': API_KEY, 'Request-Time': ts, 'Signature': signFut(ts, p), 'Content-Type': 'application/json' },
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`FUT ${ep} ${res.status}: ${t}`); }
  return res.json();
}
function save(n: string, d: unknown) {
  fs.writeFileSync(path.join(OUT, `${n}.json`), JSON.stringify(d, null, 2));
  const sz = Array.isArray(d) ? d.length : (d && typeof d === 'object' ? Object.keys(d).length : '?');
  console.log(`  ✓ ${n} (${sz})`);
}
async function safe<T>(l: string, fn: () => Promise<T>): Promise<T|null> {
  try { return await fn(); } catch(e: any) { console.error(`  ✗ ${l}: ${e.message}`); return null; }
}
async function allPages(ep: string, label: string, ps = 100): Promise<any[]> {
  const all: any[] = [];
  for (let p = 1; p <= 100; p++) {
    try {
      const res = await futGet(ep, { page_num: p, page_size: ps });
      const list = res?.data?.resultList || (Array.isArray(res?.data) ? res.data : []);
      if (!Array.isArray(list) || list.length === 0) break;
      all.push(...list);
      const tp = res?.data?.totalPage || '?';
      console.log(`    ${label} p${p}/${tp}: +${list.length} = ${all.length}`);
      if (p >= (res?.data?.totalPage || 1)) break;
      await new Promise(r => setTimeout(r, 250));
    } catch(e: any) { console.error(`    ${label} p${p}: ${e.message}`); break; }
  }
  return all;
}

async function main() {
  console.log(`\n🔍 Fresh Scan v3 — ${TS}\n   OUT: ${OUT}\n`);

  // 1. Spot account
  console.log('[SPOT ACCOUNT]');
  const acct = await safe('spot_acct', () => spotGet('/api/v3/account'));
  if (acct) save('spot_account', acct);

  // 2. Spot trades — all symbols from balances + default list
  console.log('[SPOT TRADES]');
  const balances = (acct as any)?.balances?.filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0) || [];
  save('spot_nonzero_balances', balances);
  
  const defaultPairs = ['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','PEPEUSDT','SHIBUSDT',
    'XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','ARBUSDT','SUIUSDT','APTUSDT',
    'WLDUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','JUPUSDT','STOUSDT','SIRENUSDT',
    'PIPPINUSDT','PALMAIUSDT','CUSDT','MXUSDT'];
  const syms = new Set(defaultPairs);
  for (const b of balances) {
    if (!['USDT','USDC'].includes(b.asset)) syms.add(`${b.asset}USDT`);
  }
  
  const allSpot: any[] = [];
  for (const sym of syms) {
    const trades = await safe(`spot_${sym}`, () => spotGet('/api/v3/myTrades', { symbol: sym, limit: 1000 }));
    if (trades && Array.isArray(trades) && trades.length > 0) {
      allSpot.push(...trades);
      console.log(`    ${sym}: ${trades.length} trades`);
    }
  }
  save('spot_all_trades', allSpot);

  // 3. Spot open orders
  const openOrders = await safe('open_orders', () => spotGet('/api/v3/openOrders'));
  if (openOrders) save('spot_open_orders', openOrders);

  // 4. Futures assets
  console.log('\n[FUTURES ASSETS]');
  const futAssets = await safe('fut_assets', () => futGet('/api/v1/private/account/assets'));
  if (futAssets) save('futures_assets', futAssets);

  // 5. Futures open positions
  const openPos = await safe('open_pos', () => futGet('/api/v1/private/position/open_positions'));
  if (openPos) save('futures_open_positions', openPos);

  // 6. ALL position history
  console.log('\n[FUTURES POSITION HISTORY]');
  const posHist = await allPages('/api/v1/private/position/list/history_positions', 'pos');
  save('futures_all_positions', posHist);

  // 7. ALL order history
  console.log('\n[FUTURES ORDER HISTORY]');
  const ordHist = await allPages('/api/v1/private/order/list/history_orders', 'ord');
  save('futures_all_orders', ordHist);

  // 8. ALL funding
  console.log('\n[FUTURES FUNDING]');
  const funding = await allPages('/api/v1/private/position/funding_records', 'fund');
  save('futures_all_funding', funding);

  // 9. Transfers
  console.log('\n[TRANSFERS]');
  const tr1 = await safe('transfers_SPOT_FUTURES', () => spotGet('/api/v3/capital/transfer', {
    fromAccountType: 'SPOT', toAccountType: 'FUTURES', size: 100
  }));
  if (tr1) save('transfers_spot_to_futures', tr1);
  const tr2 = await safe('transfers_FUTURES_SPOT', () => spotGet('/api/v3/capital/transfer', {
    fromAccountType: 'FUTURES', toAccountType: 'SPOT', size: 100
  }));
  if (tr2) save('transfers_futures_to_spot', tr2);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Spot trades: ${allSpot.length}`);
  console.log(`Futures positions (closed): ${posHist.length}`);
  console.log(`Futures orders: ${ordHist.length}`);
  console.log(`Funding records: ${funding.length}`);
  console.log(`Open positions: ${Array.isArray((openPos as any)?.data) ? (openPos as any).data.length : 0}`);
  
  // USDT balance
  const usdtFut = ((futAssets as any)?.data || []).find((a: any) => a.currency === 'USDT');
  console.log(`Futures USDT: cash=${usdtFut?.cashBalance}, equity=${usdtFut?.equity}`);
  const usdtSpot = (acct as any)?.balances?.find((b: any) => b.asset === 'USDT');
  console.log(`Spot USDT: ${usdtSpot?.free}`);
  
  console.log(`\n✅ Scan saved to: ${OUT}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

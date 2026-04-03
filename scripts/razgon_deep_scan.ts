/**
 * Razgon MEXC Deep Scan - all pages, all history
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const API_KEY = 'mx0vglapWbKfPYn9rU';
const API_SECRET = 'f4e896d8e37c4e69ad1f09d79df20754';

const BASE_SPOT = 'https://api.mexc.com';
const BASE_FUTURES = 'https://contract.mexc.com';
const OUT = '/opt/btdd/razgon/client1_deep';
fs.mkdirSync(OUT, { recursive: true });

function signSpot(params: Record<string, string | number>): string {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${qs}&signature=${sig}`;
}

async function spotGet(ep: string, params: Record<string, string | number> = {}) {
  const all = { ...params, timestamp: Date.now(), recvWindow: 60000 };
  const qs = signSpot(all);
  const res = await fetch(`${BASE_SPOT}${ep}?${qs}`, { headers: { 'X-MEXC-APIKEY': API_KEY } });
  if (!res.ok) throw new Error(`SPOT ${ep} ${res.status}: ${await res.text()}`);
  return res.json();
}

function signFut(ts: string, params: Record<string, string | number> = {}): string {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  return crypto.createHmac('sha256', API_SECRET).update(qs ? `${API_KEY}${ts}${qs}` : `${API_KEY}${ts}`).digest('hex');
}

async function futGet(ep: string, params: Record<string, string | number> = {}) {
  const ts = String(Date.now());
  const sig = signFut(ts, params);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const res = await fetch(`${BASE_FUTURES}${ep}${qs ? '?' + qs : ''}`, {
    headers: { 'ApiKey': API_KEY, 'Request-Time': ts, 'Signature': sig, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`FUT ${ep} ${res.status}: ${await res.text()}`);
  return res.json();
}

function save(name: string, data: unknown) {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
  const n = Array.isArray(data) ? data.length : '?';
  console.log(`  ✓ ${name} (${n})`);
}

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e: any) { console.error(`  ✗ ${label}: ${e.message}`); return null; }
}

async function getAllFuturesPages(ep: string, label: string, pageSize = 100): Promise<any[]> {
  const all: any[] = [];
  for (let p = 1; p <= 50; p++) {
    const res = await safe(`${label}_p${p}`, () => futGet(ep, { page_num: p, page_size: pageSize }));
    if (!res || !res.data) break;
    const list = res.data.resultList || res.data || [];
    if (!Array.isArray(list) || list.length === 0) break;
    all.push(...list);
    console.log(`    page ${p}: ${list.length} items (total ${all.length})`);
    const totalPage = res.data.totalPage || 1;
    if (p >= totalPage) break;
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }
  return all;
}

async function main() {
  console.log('\n🔍 Deep Scan\n');

  // 1. Futures - ALL order history pages
  console.log('[FUTURES ORDERS - all pages]');
  const allOrders = await getAllFuturesPages('/api/v1/private/order/list/history_orders', 'fut_orders');
  save('futures_all_orders', allOrders);

  // 2. Futures - ALL deal history pages
  console.log('\n[FUTURES DEALS - all pages]');
  const allDeals = await getAllFuturesPages('/api/v1/private/order/list/history_deals', 'fut_deals');
  save('futures_all_deals', allDeals);

  // 3. Futures account transaction records (deposits, transfers, PnL)
  console.log('\n[FUTURES TRANSACTIONS - all pages]');
  const allTx = await getAllFuturesPages('/api/v1/private/account/asset_records', 'fut_tx');
  save('futures_all_transactions', allTx);

  // 4. Spot - deposit history (no time limit)
  console.log('\n[SPOT DEPOSITS]');
  const deps = await safe('deposits', () => spotGet('/api/v3/capital/deposit/hisrec'));
  if (deps) save('spot_deposits_all', deps);

  // 5. Spot - withdraw history
  console.log('\n[SPOT WITHDRAWALS]');
  const wd = await safe('withdrawals', () => spotGet('/api/v3/capital/withdraw/history'));
  if (wd) save('spot_withdrawals_all', wd);

  // 6. Spot transfers (internal)
  console.log('\n[SPOT TRANSFERS]');
  const tr = await safe('transfers', () => spotGet('/api/v3/capital/transfer', { size: 100 }));
  if (tr) save('spot_transfers_all', tr);

  // 7. Spot - all trades for PALMAIUSDT (no time limit to get full history)
  console.log('\n[SPOT TRADES FULL]');
  const spotTrades = await safe('spot_full', () => spotGet('/api/v3/myTrades', { symbol: 'PALMAIUSDT', limit: 1000 }));
  if (spotTrades) save('spot_palmai_all_trades', spotTrades);

  // 8. Futures assets
  const assets = await safe('assets', () => futGet('/api/v1/private/account/assets'));
  if (assets) save('futures_assets', assets);

  // 9. Futures position history / closed positions
  console.log('\n[FUTURES POSITION HISTORY]');
  const posHist = await getAllFuturesPages('/api/v1/private/position/list/history_positions', 'pos_hist');
  save('futures_position_history', posHist);

  // 10. Futures funding records
  console.log('\n[FUTURES FUNDING]');
  const funding = await safe('funding', () => futGet('/api/v1/private/position/funding_records', { page_num: 1, page_size: 100 }));
  if (funding) save('futures_funding', funding);

  console.log('\n✅ Deep scan complete:', OUT);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

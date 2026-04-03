/**
 * Razgon MEXC - get ALL position history (paginated) + more funding
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const API_KEY = 'mx0vglapWbKfPYn9rU';
const API_SECRET = 'f4e896d8e37c4e69ad1f09d79df20754';
const BASE = 'https://contract.mexc.com';
const OUT = '/opt/btdd/razgon/client1_deep';

function sign(ts: string, params: Record<string, string | number> = {}): string {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  return crypto.createHmac('sha256', API_SECRET).update(qs ? `${API_KEY}${ts}${qs}` : `${API_KEY}${ts}`).digest('hex');
}

async function futGet(ep: string, params: Record<string, string | number> = {}) {
  const ts = String(Date.now());
  const sig = sign(ts, params);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const res = await fetch(`${BASE}${ep}${qs ? '?' + qs : ''}`, {
    headers: { 'ApiKey': API_KEY, 'Request-Time': ts, 'Signature': sig, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`${ep} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getAllPages(ep: string, label: string, pageSize = 100): Promise<any[]> {
  const all: any[] = [];
  for (let p = 1; p <= 100; p++) {
    try {
      const res = await futGet(ep, { page_num: p, page_size: pageSize });
      const list = res?.data?.resultList || res?.data || [];
      if (!Array.isArray(list) || list.length === 0) break;
      all.push(...list);
      const tp = res?.data?.totalPage || '?';
      console.log(`  ${label} page ${p}/${tp}: +${list.length} = ${all.length}`);
      if (p >= (res?.data?.totalPage || 1)) break;
      await new Promise(r => setTimeout(r, 200));
    } catch (e: any) {
      console.error(`  ${label} page ${p}: ${e.message}`);
      break;
    }
  }
  return all;
}

async function main() {
  console.log('=== Extended data collection ===\n');

  // All position history
  console.log('[POSITION HISTORY - all pages]');
  const positions = await getAllPages('/api/v1/private/position/list/history_positions', 'positions');
  fs.writeFileSync(path.join(OUT, 'ALL_positions.json'), JSON.stringify(positions, null, 2));
  console.log(`  Total positions: ${positions.length}\n`);

  // All funding - paginated
  console.log('[FUNDING - all pages]');
  const funding = await getAllPages('/api/v1/private/position/funding_records', 'funding');
  fs.writeFileSync(path.join(OUT, 'ALL_funding.json'), JSON.stringify(funding, null, 2));
  console.log(`  Total funding records: ${funding.length}\n`);

  // All order history
  console.log('[ORDER HISTORY - all pages]');
  const orders = await getAllPages('/api/v1/private/order/list/history_orders', 'orders');
  fs.writeFileSync(path.join(OUT, 'ALL_orders.json'), JSON.stringify(orders, null, 2));
  console.log(`  Total orders: ${orders.length}\n`);

  // Summary stats
  const totalPnl = positions.reduce((s: number, p: any) => s + (p.realised || 0), 0);
  const firstTime = Math.min(...positions.map((p: any) => p.openTime || p.createTime || Infinity));
  const lastTime = Math.max(...positions.map((p: any) => p.closeTime || p.updateTime || 0));
  console.log(`\nPositions PnL total: ${totalPnl.toFixed(4)} USDT`);
  console.log(`First position: ${new Date(firstTime).toISOString()}`);
  console.log(`Last position: ${new Date(lastTime).toISOString()}`);

  // Symbols breakdown
  const bySymbol: Record<string, number> = {};
  for (const p of positions) {
    const sym = p.symbol || '?';
    bySymbol[sym] = (bySymbol[sym] || 0) + (p.realised || 0);
  }
  console.log('\nP&L by symbol:');
  for (const [sym, pnl] of Object.entries(bySymbol).sort((a, b) => a[1] - b[1])) {
    console.log(`  ${sym}: ${pnl.toFixed(4)} USDT`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

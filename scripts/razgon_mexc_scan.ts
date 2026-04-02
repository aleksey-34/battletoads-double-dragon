/**
 * Разгон MEXC Scanner
 * Скачивает все торговые данные по API ключам MEXC:
 *  - Баланс (спот + фьючерсы)
 *  - История ордеров (спот + фьючерсы)
 *  - История трейдов (спот + фьючерсы)
 *  - Текущие позиции фьючерсов
 *  - Transfers между спотом и фьючерсами
 *
 * Использование:
 *   npx ts-node scripts/razgon_mexc_scan.ts --key=<API_KEY> --secret=<API_SECRET> [--label=client1]
 *
 * Данные сохраняются в /opt/btdd/razgon/<label>/<timestamp>/
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ──────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'];
  })
);

const API_KEY = args.key || process.env.MEXC_API_KEY || '';
const API_SECRET = args.secret || process.env.MEXC_API_SECRET || '';
const LABEL = args.label || 'default';

if (!API_KEY || !API_SECRET) {
  console.error('Usage: --key=<API_KEY> --secret=<API_SECRET> [--label=<name>]');
  process.exit(1);
}

const BASE_SPOT = 'https://api.mexc.com';
const BASE_FUTURES = 'https://contract.mexc.com';

const OUT_DIR = `/opt/btdd/razgon/${LABEL}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Signing ─────────────────────────────────────────────────
function signSpot(params: Record<string, string | number>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${qs}&signature=${signature}`;
}

async function spotGet(endpoint: string, params: Record<string, string | number> = {}) {
  const ts = Date.now();
  const allParams = { ...params, timestamp: ts, recvWindow: 60000 };
  const qs = signSpot(allParams);
  const url = `${BASE_SPOT}${endpoint}?${qs}`;
  const res = await fetch(url, { headers: { 'X-MEXC-APIKEY': API_KEY } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SPOT ${endpoint} ${res.status}: ${text}`);
  }
  return res.json();
}

function signFutures(ts: string, params: Record<string, string | number> = {}): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const toSign = qs ? `${API_KEY}${ts}${qs}` : `${API_KEY}${ts}`;
  return crypto.createHmac('sha256', API_SECRET).update(toSign).digest('hex');
}

async function futuresGet(endpoint: string, params: Record<string, string | number> = {}) {
  const ts = String(Date.now());
  const sig = signFutures(ts, params);
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const url = `${BASE_FUTURES}${endpoint}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: {
      'ApiKey': API_KEY,
      'Request-Time': ts,
      'Signature': sig,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FUTURES ${endpoint} ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Helpers ─────────────────────────────────────────────────
function save(name: string, data: unknown) {
  const fp = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  const size = Array.isArray(data) ? data.length : typeof data === 'object' && data ? Object.keys(data).length : '?';
  console.log(`  ✓ ${name}.json (${size} items)`);
}

async function safeCall(label: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const data = await fn();
    return data;
  } catch (e: any) {
    console.error(`  ✗ ${label}: ${e.message}`);
    save(`${label}_ERROR`, { error: e.message });
    return null;
  }
}

// ── Data collection ─────────────────────────────────────────
async function main() {
  console.log(`\n🔍 Razgon MEXC Scan — ${LABEL}`);
  console.log(`   Output: ${OUT_DIR}\n`);

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;

  // 1. Spot account info + balances
  console.log('[SPOT]');
  const spotAccount = await safeCall('spot_account', () => spotGet('/api/v3/account'));
  if (spotAccount) save('spot_account', spotAccount);

  // 2. Spot trades — iterate common pairs
  const defaultPairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'PEPEUSDT', 'SHIBUSDT',
    'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT', 'MATICUSDT', 'DOTUSDT',
    'LINKUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'APTUSDT', 'WLDUSDT',
    'FLOKIUSDT', '1000PEPEUSDT', 'BONKUSDT', 'WIFUSDT', 'JUPUSDT'];

  // First, get all spot symbols this account traded (from open orders too)
  const allSpotTrades: any[] = [];
  const spotOpenOrders = await safeCall('spot_open_orders', () => spotGet('/api/v3/openOrders'));
  if (spotOpenOrders) save('spot_open_orders', spotOpenOrders);

  // Get spot order history for last 7 days — MEXC v3 /api/v3/allOrders requires symbol
  // We'll try common pairs + anything from balances
  const balances = (spotAccount as any)?.balances?.filter((b: any) =>
    parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
  ) || [];
  save('spot_nonzero_balances', balances);

  const tradedSymbols = new Set(defaultPairs);
  for (const b of balances) {
    if (b.asset !== 'USDT' && b.asset !== 'USDC') {
      tradedSymbols.add(`${b.asset}USDT`);
    }
  }

  console.log(`  Checking ${tradedSymbols.size} spot pairs for trades...`);
  for (const sym of tradedSymbols) {
    const trades = await safeCall(`spot_trades_${sym}`, () =>
      spotGet('/api/v3/myTrades', { symbol: sym, startTime: weekAgo, limit: 1000 })
    );
    if (trades && Array.isArray(trades) && trades.length > 0) {
      allSpotTrades.push(...trades);
      console.log(`    ${sym}: ${trades.length} trades`);
    }
  }
  save('spot_all_trades', allSpotTrades);

  // Spot all orders for traded symbols
  const allSpotOrders: any[] = [];
  for (const sym of tradedSymbols) {
    const orders = await safeCall(`spot_orders_${sym}`, () =>
      spotGet('/api/v3/allOrders', { symbol: sym, startTime: weekAgo, limit: 1000 })
    );
    if (orders && Array.isArray(orders) && orders.length > 0) {
      allSpotOrders.push(...orders);
    }
  }
  save('spot_all_orders', allSpotOrders);

  // 3. Futures
  console.log('\n[FUTURES]');

  // Futures account info
  const futuresAssets = await safeCall('futures_assets', () => futuresGet('/api/v1/private/account/assets'));
  if (futuresAssets) save('futures_assets', futuresAssets);

  // Open positions
  const futuresPositions = await safeCall('futures_positions', () =>
    futuresGet('/api/v1/private/position/open_positions')
  );
  if (futuresPositions) save('futures_open_positions', futuresPositions);

  // Futures order history
  const futuresOrders = await safeCall('futures_orders', () =>
    futuresGet('/api/v1/private/order/list/history_orders', {
      page_num: 1, page_size: 100,
    })
  );
  if (futuresOrders) save('futures_order_history', futuresOrders);

  // Futures deals (trades)
  const futuresDeals = await safeCall('futures_deals', () =>
    futuresGet('/api/v1/private/order/list/history_deals', {
      page_num: 1, page_size: 100,
    })
  );
  if (futuresDeals) save('futures_deal_history', futuresDeals);

  // Additional pages if available
  const futuresData = futuresDeals as any;
  if (futuresData?.data?.totalPage > 1) {
    const allDeals = [...(futuresData.data.resultList || [])];
    for (let p = 2; p <= Math.min(futuresData.data.totalPage, 20); p++) {
      const page = await safeCall(`futures_deals_p${p}`, () =>
        futuresGet('/api/v1/private/order/list/history_deals', {
          page_num: p, page_size: 100,
        })
      );
      if (page && (page as any).data?.resultList) {
        allDeals.push(...(page as any).data.resultList);
      }
    }
    save('futures_all_deals', allDeals);
  }

  // Futures transaction records (transfers, funding, etc.)
  const futuresTransactions = await safeCall('futures_transactions', () =>
    futuresGet('/api/v1/private/account/asset_records', {
      page_num: 1, page_size: 100,
    })
  );
  if (futuresTransactions) save('futures_transactions', futuresTransactions);

  // 4. Transfer history (spot <-> futures)
  console.log('\n[TRANSFERS]');
  const transfers = await safeCall('transfers', () =>
    spotGet('/api/v3/capital/transfer', { startTime: weekAgo, size: 100 })
  );
  if (transfers) save('transfers', transfers);

  // Internal transfers
  const internalTransfers = await safeCall('internal_transfers', () =>
    spotGet('/api/v3/capital/transfer/internal', { startTime: weekAgo, size: 100 })
  );
  if (internalTransfers) save('internal_transfers', internalTransfers);

  // 5. Deposit & Withdraw history
  console.log('\n[DEPOSIT/WITHDRAW]');
  const deposits = await safeCall('deposits', () =>
    spotGet('/api/v3/capital/deposit/hisrec', { startTime: weekAgo })
  );
  if (deposits) save('deposit_history', deposits);

  const withdrawals = await safeCall('withdrawals', () =>
    spotGet('/api/v3/capital/withdraw/history', { startTime: weekAgo })
  );
  if (withdrawals) save('withdrawal_history', withdrawals);

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n✅ Scan complete. Data saved to: ${OUT_DIR}`);
  console.log(`   Spot trades: ${allSpotTrades.length}`);
  console.log(`   Spot orders: ${allSpotOrders.length}`);
  console.log(`   Non-zero balances: ${balances.length}`);

  // Create quick summary
  const summary = {
    label: LABEL,
    scannedAt: new Date().toISOString(),
    outDir: OUT_DIR,
    spotTradeCount: allSpotTrades.length,
    spotOrderCount: allSpotOrders.length,
    nonZeroBalances: balances.map((b: any) => `${b.asset}: ${b.free}`),
    futuresPositionCount: Array.isArray((futuresPositions as any)?.data) ? (futuresPositions as any).data.length : 0,
  };
  save('_summary', summary);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

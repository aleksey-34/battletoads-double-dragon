import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearOpenOrdersCacheForTests,
  filterOpenOrdersBySymbol,
  getCachedOpenOrders,
  invalidateOpenOrdersCache,
} from './openOrdersPollCache';

describe('openOrdersPollCache — batch/reuse for dense MRS2', () => {
  beforeEach(() => {
    clearOpenOrdersCacheForTests();
  });

  it('filterOpenOrdersBySymbol keeps only matching UI symbols', () => {
    const orders = [
      { orderId: '1', symbol: 'BTCUSDT' },
      { orderId: '2', symbol: 'ETH/USDT:USDT' },
      { orderId: '3', symbol: 'SOLUSDT' },
    ];
    const filtered = filterOpenOrdersBySymbol(orders, 'ethusdt');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].orderId, '2');
  });

  it('first symbol fetch uses account-wide snapshot; siblings reuse without second API call', async () => {
    let allCalls = 0;
    let symCalls = 0;
    const fetchAll = async () => {
      allCalls += 1;
      return [
        { orderId: 'a', symbol: 'AAAUSDT' },
        { orderId: 'b', symbol: 'BBBUSDT' },
      ];
    };
    const fetchSymbol = async () => {
      symCalls += 1;
      return [{ orderId: 'x', symbol: 'AAAUSDT' }];
    };

    const first = await getCachedOpenOrders('pilotKey', 'AAAUSDT', fetchAll, fetchSymbol);
    const second = await getCachedOpenOrders('pilotKey', 'BBBUSDT', fetchAll, fetchSymbol);
    const third = await getCachedOpenOrders('pilotKey', 'AAAUSDT', fetchAll, fetchSymbol);

    assert.equal(allCalls, 1, 'must fetch account book once');
    assert.equal(symCalls, 0, 'must not fan-out per symbol while cache warm');
    assert.deepEqual(first.map((o) => o.orderId), ['a']);
    assert.deepEqual(second.map((o) => o.orderId), ['b']);
    assert.deepEqual(third.map((o) => o.orderId), ['a']);
  });

  it('falls back to per-symbol fetch when account-wide fails', async () => {
    const fetchAll = async () => {
      throw new Error('symbol required');
    };
    let symCalls = 0;
    const fetchSymbol = async (sym?: string) => {
      symCalls += 1;
      return [{ orderId: 'solo', symbol: String(sym || '') }];
    };

    const orders = await getCachedOpenOrders('key', 'FOOUSDT', fetchAll, fetchSymbol);
    assert.equal(symCalls, 1);
    assert.equal(orders[0].orderId, 'solo');
  });

  it('invalidateOpenOrdersCache drops reuse so next call refetches', async () => {
    let allCalls = 0;
    const fetchAll = async () => {
      allCalls += 1;
      return [{ orderId: String(allCalls), symbol: 'XUSDT' }];
    };
    const fetchSymbol = async () => [];

    await getCachedOpenOrders('k', 'XUSDT', fetchAll, fetchSymbol);
    invalidateOpenOrdersCache('k');
    const after = await getCachedOpenOrders('k', 'XUSDT', fetchAll, fetchSymbol);
    assert.equal(allCalls, 2);
    assert.equal(after[0].orderId, '2');
  });

  it('inflight dedupe: concurrent callers share one fetchAll', async () => {
    let allCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchAll = async () => {
      allCalls += 1;
      await gate;
      return [{ orderId: 'shared', symbol: 'AUSDT' }, { orderId: 'other', symbol: 'BUSDT' }];
    };
    const fetchSymbol = async () => [];

    const p1 = getCachedOpenOrders('k2', 'AUSDT', fetchAll, fetchSymbol);
    const p2 = getCachedOpenOrders('k2', 'BUSDT', fetchAll, fetchSymbol);
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(allCalls, 1);
    assert.equal(a[0].orderId, 'shared');
    assert.equal(b[0].orderId, 'other');
  });
});

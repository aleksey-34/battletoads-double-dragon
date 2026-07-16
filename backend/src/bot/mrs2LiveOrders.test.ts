import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMatchingRestingOrders,
  reconcileRestingDuplicates,
  normalizeOpenOrders,
  type OpenOrderLite,
} from './mrs2LiveOrders';

const order = (id: string, side: 'Buy' | 'Sell', price: number, orderType = 'limit'): OpenOrderLite => (
  { id, side, price, orderType }
);

describe('mrs2LiveOrders duplicate-order reconciliation', () => {
  it('normalizeOpenOrders extracts id/side/price and drops malformed entries', () => {
    const raw = [
      { id: '1', side: 'Buy', price: '100.5', orderType: 'Limit' },
      { orderId: '2', info: { side: 'sell', price: '101' } },
      { id: '', side: 'Buy', price: '99' }, // missing id -> dropped
      { id: '3', side: 'Buy', price: 'not-a-number' }, // bad price -> dropped
    ];
    const normalized = normalizeOpenOrders(raw);
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].id, '1');
    assert.equal(normalized[0].side, 'Buy');
    assert.equal(normalized[0].price, 100.5);
    assert.equal(normalized[1].id, '2');
    assert.equal(normalized[1].side, 'Sell');
  });

  it('findMatchingRestingOrders matches side + price within epsilon, excludes market orders', () => {
    const orders = [
      order('a', 'Buy', 100),
      order('b', 'Buy', 100.02), // within 0.05% eps of 100
      order('c', 'Buy', 105), // too far
      order('d', 'Sell', 100), // wrong side
      order('e', 'Buy', 100, 'market'), // market type excluded
    ];
    const matches = findMatchingRestingOrders(orders, 'Buy', 100);
    const ids = matches.map((m) => m.id).sort();
    assert.deepEqual(ids, ['a', 'b']);
  });

  it('findMatchingRestingOrders returns empty for invalid target price', () => {
    const orders = [order('a', 'Buy', 100)];
    assert.deepEqual(findMatchingRestingOrders(orders, 'Buy', 0), []);
    assert.deepEqual(findMatchingRestingOrders(orders, 'Buy', NaN), []);
  });

  it('reconcileRestingDuplicates: no matches -> nothing to keep or cancel', () => {
    const result = reconcileRestingDuplicates([], 'tracked-id');
    assert.deepEqual(result, { keepId: null, cancelIds: [] });
  });

  it('reconcileRestingDuplicates: single match with no tracked id -> adopt it, cancel nothing', () => {
    const matches = [order('orphan-1', 'Buy', 100)];
    const result = reconcileRestingDuplicates(matches, null);
    assert.equal(result.keepId, 'orphan-1');
    assert.deepEqual(result.cancelIds, []);
  });

  it('reconcileRestingDuplicates: crash/restart duplicate — untracked order exists alongside stale-tracked id gone from book', () => {
    // Simulates: placeOrder() succeeded pre-crash but id was never persisted.
    // Next cycle has no tracked id, but the real resting order is still on the book.
    const matches = [order('real-resting-order', 'Buy', 100)];
    const result = reconcileRestingDuplicates(matches, null);
    assert.equal(result.keepId, 'real-resting-order');
    assert.deepEqual(result.cancelIds, [], 'must NOT place a second order when one is already resting');
  });

  it('reconcileRestingDuplicates: two resting duplicates + a tracked id -> keep tracked, cancel the other', () => {
    const matches = [order('untracked-dup', 'Buy', 100), order('tracked', 'Buy', 100.01)];
    const result = reconcileRestingDuplicates(matches, 'tracked');
    assert.equal(result.keepId, 'tracked');
    assert.deepEqual(result.cancelIds, ['untracked-dup']);
  });

  it('reconcileRestingDuplicates: multiple untracked duplicates -> keep exactly one, cancel the rest', () => {
    const matches = [order('dup-1', 'Buy', 100), order('dup-2', 'Buy', 100), order('dup-3', 'Buy', 100)];
    const result = reconcileRestingDuplicates(matches, null);
    assert.equal(result.keepId, 'dup-1');
    assert.deepEqual(result.cancelIds, ['dup-2', 'dup-3']);
  });

  it('when oversize-blocked, sync must not place: keep tracked id, cancel only true duplicates', () => {
    // Strategy gate (entryOversizeCooldown) skips calling syncMrs2RestingEntryLimits when
    // min-lot > 1.5×. If sync did run with an already-tracked id, reconcile must still
    // adopt/keep that id and never invent a "need to place" signal (keepId non-null).
    const matches = [order('already-resting', 'Buy', 100)];
    const result = reconcileRestingDuplicates(matches, 'already-resting');
    assert.equal(result.keepId, 'already-resting');
    assert.deepEqual(result.cancelIds, []);
  });
});

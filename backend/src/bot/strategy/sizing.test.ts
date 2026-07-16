import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ENTRY_OVERSIZE_FRACTION } from './sizing';
import { decideEntryOversizeGate, ENTRY_OVERSIZE_SKIP_ACTION } from './cycle/entryOversizeCooldown';

describe('position-size ceiling constant', () => {
  it('caps entries at 1.5x target notional (50% oversize fraction)', () => {
    assert.equal(MAX_ENTRY_OVERSIZE_FRACTION, 0.5);
  });

  it('oversize fraction semantics: actual/target - 1 must stay <= cap to pass', () => {
    const target = 100;
    const passingActual = 149; // 1.49x — allowed
    const blockedActual = 151; // 1.51x — blocked
    const passingOversize = (passingActual - target) / target;
    const blockedOversize = (blockedActual - target) / target;
    assert.ok(passingOversize <= MAX_ENTRY_OVERSIZE_FRACTION);
    assert.ok(blockedOversize > MAX_ENTRY_OVERSIZE_FRACTION);
  });

  it('minLot forces qty > 1.5× target → gate blocks once (skip_min_lot_over_cap), no allow', () => {
    // Example: target $6 lot, exchange minOrderQty notionals to $18 → oversize = 2.0
    const target = 6;
    const minLotNotional = 18;
    const oversize = (minLotNotional - target) / target;
    assert.ok(oversize > MAX_ENTRY_OVERSIZE_FRACTION);
    const gate = decideEntryOversizeGate({
      coolingDown: false,
      oversize,
      maxOversizeFraction: MAX_ENTRY_OVERSIZE_FRACTION,
    });
    assert.equal(gate.action, 'block_oversize');
    if (gate.action === 'block_oversize') {
      assert.equal(gate.reason, ENTRY_OVERSIZE_SKIP_ACTION);
    }
  });
});

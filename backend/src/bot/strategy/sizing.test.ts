import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ENTRY_OVERSIZE_FRACTION } from './sizing';
import { decideEntryOversizeGate, ENTRY_OVERSIZE_SKIP_ACTION } from './cycle/entryOversizeCooldown';
import { computeSignalTotalNotional } from './crud';

describe('compound reinvest sizing (live ↔ BT)', () => {
  const base = {
    max_deposit: 5000,
    fixed_lot: false,
    reinvest_percent: 100,
    lot_long_percent: 10,
    lot_short_percent: 10,
    leverage: 10,
  };

  it('ri=0 sizes off baseline only (not free margin float)', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 0 },
      8000, // free margin
      'long',
      1,
      { walletEquity: 12000 },
    );
    // base = 5000, ×10% = 500; free margin does not inflate
    assert.equal(n, 500);
  });

  it('ri=100 compounds off wallet equity, capped by free margin', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 100 },
      4000,
      'long',
      1,
      { walletEquity: 12000 },
    );
    // equityBase = 12000, ×10% = 1200, freeMargin cap → 4000 keeps 1200
    assert.equal(n, 1200);
  });

  it('ri=50 partial compound: baseline + half of profit', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 50 },
      50_000,
      'long',
      1,
      { walletEquity: 9000 },
    );
    // base = 5000 + (9000-5000)*0.5 = 7000; ×10% = 700
    assert.equal(n, 700);
  });

  it('does not apply legacy ×(1+ri%) multiplier', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 100, max_deposit: 1000 },
      1000,
      'long',
      1,
      { walletEquity: 1000 },
    );
    // Old bug: 1000 × 0.1 × 2 = 200; correct: 1000 × 0.1 = 100
    assert.equal(n, 100);
  });

  it('hard-caps notional by free margin when compound would exceed it', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 100 },
      50,
      'long',
      1,
      { walletEquity: 20_000 },
    );
    assert.equal(n, 50);
  });
});

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

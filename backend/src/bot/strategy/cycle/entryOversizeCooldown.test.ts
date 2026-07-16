import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ENTRY_OVERSIZE_FRACTION } from '../sizing';
import {
  ENTRY_OVERSIZE_SKIP_ACTION,
  clearEntryOversizeCooldown,
  decideEntryOversizeGate,
  isEntryOversizeCoolingDown,
  markEntryOversizeBlocked,
  shouldLogEntryOversizeBlock,
} from './entryOversizeCooldown';

describe('entryOversizeCooldown — min-lot vs 1.5× cap', () => {
  beforeEach(() => {
    clearEntryOversizeCooldown();
  });

  it('decideEntryOversizeGate: oversize > 1.5× target → block_oversize (no place)', () => {
    const decision = decideEntryOversizeGate({
      coolingDown: false,
      oversize: 0.51,
      maxOversizeFraction: MAX_ENTRY_OVERSIZE_FRACTION,
    });
    assert.equal(decision.action, 'block_oversize');
    if (decision.action === 'block_oversize') {
      assert.equal(decision.reason, ENTRY_OVERSIZE_SKIP_ACTION);
    }
  });

  it('decideEntryOversizeGate: oversize at exactly 1.5× is allowed', () => {
    const decision = decideEntryOversizeGate({
      coolingDown: false,
      oversize: 0.5,
      maxOversizeFraction: MAX_ENTRY_OVERSIZE_FRACTION,
    });
    assert.equal(decision.action, 'allow');
  });

  it('mark + cool-down: first block arms cool-down; subsequent ticks skip without re-evaluating oversize', () => {
    const t0 = 1_000_000;
    markEntryOversizeBlocked('keyA', 42, {
      oversize: 2.0,
      targetNotional: 10,
      actualNotional: 30,
      detail: 'min-lot too large',
    }, t0, 60_000);

    const during = isEntryOversizeCoolingDown('keyA', 42, t0 + 30_000);
    assert.equal(during.active, true);
    assert.ok((during.remainingMs || 0) > 0);

    const gate = decideEntryOversizeGate({
      coolingDown: during.active,
      cooldownReason: during.reason,
      remainingMs: during.remainingMs,
      oversize: 0, // must not matter while cooling down
      maxOversizeFraction: MAX_ENTRY_OVERSIZE_FRACTION,
    });
    assert.equal(gate.action, 'skip_cooldown');
    if (gate.action === 'skip_cooldown') {
      assert.match(gate.reason, /min-lot/i);
    }

    const after = isEntryOversizeCoolingDown('keyA', 42, t0 + 61_000);
    assert.equal(after.active, false);
  });

  it('cool-down is per strategy — sibling instrument is unaffected', () => {
    markEntryOversizeBlocked('keyA', 1, {
      oversize: 3,
      targetNotional: 5,
      actualNotional: 20,
    }, 0, 60_000);
    assert.equal(isEntryOversizeCoolingDown('keyA', 1, 1).active, true);
    assert.equal(isEntryOversizeCoolingDown('keyA', 2, 1).active, false);
  });

  it('shouldLogEntryOversizeBlock throttles repeat logs (blocked once, not every tick)', () => {
    const t0 = 5_000_000;
    assert.equal(shouldLogEntryOversizeBlock('keyB', 7, t0), true);
    assert.equal(shouldLogEntryOversizeBlock('keyB', 7, t0 + 1_000), false);
    assert.equal(shouldLogEntryOversizeBlock('keyB', 7, t0 + 6 * 60_000), true);
  });

  it('reconcile path semantics: while cool-down active, gate never returns allow (no duplicate place)', () => {
    markEntryOversizeBlocked('keyC', 9, {
      oversize: 1.2,
      targetNotional: 8,
      actualNotional: 17.6,
    }, 10_000, 120_000);

    for (let tick = 0; tick < 5; tick += 1) {
      const cd = isEntryOversizeCoolingDown('keyC', 9, 10_000 + tick * 5_000);
      const gate = decideEntryOversizeGate({
        coolingDown: cd.active,
        cooldownReason: cd.reason,
        remainingMs: cd.remainingMs,
        // Simulate plan still oversized every tick — must not flip to allow.
        oversize: 1.2,
        maxOversizeFraction: MAX_ENTRY_OVERSIZE_FRACTION,
      });
      assert.notEqual(gate.action, 'allow');
      assert.equal(gate.action, 'skip_cooldown');
    }
  });
});

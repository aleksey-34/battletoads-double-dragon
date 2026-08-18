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

  it('ri=0 sizes off min(baseline, equity) — never invents capital above wallet', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 0 },
      8000, // free margin
      'long',
      1,
      { walletEquity: 12000 },
    );
    // baseline 5000, equity 12k, ri=0 → base stays 5000; ×10% = 500
    assert.equal(n, 500);
  });

  it('when max_deposit is a 250k ceiling, sizes off wallet not the ceiling', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 82, max_deposit: 250_000, lot_long_percent: 10 },
      800,
      'long',
      1,
      { walletEquity: 900 },
    );
    assert.equal(n, 90);
  });

  it('when max_deposit ≫ equity, sizes off equity (not max_deposit)', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 82, max_deposit: 5000 },
      800,
      'long',
      1,
      { walletEquity: 900 },
    );
    // Must NOT be 5000×10%=500; equity base 900×10%=90, free margin 800 keeps 90
    assert.equal(n, 90);
  });

  it('copy 250k max_deposit is never the live deposit — wallet × recipe lot%', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 100, max_deposit: 250_000, lot_long_percent: 10 },
      5_000,
      'long',
      1,
      { walletEquity: 900 },
    );
    // 10% of $900 wallet, not 10% of 250k. Free margin 5k must not lift size above wallet.
    assert.equal(n, 90);
  });

  it('hard-caps notional by wallet even when free margin is larger', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 100, max_deposit: 250_000, lot_long_percent: 82 },
      8_000,
      'long',
      1,
      { walletEquity: 900 },
    );
    // Leftover lot% of wallet, but never above wallet (740-class size is lot metadata, not 250k).
    assert.equal(n, 738);
  });

  it('ri=100 compounds off wallet equity, capped by free margin', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 100 },
      4000,
      'long',
      1,
      { walletEquity: 12000 },
    );
    // equityBase = min(12000, 12000)=12000 but soft-capped by max_deposit 5000 → 500
    assert.equal(n, 500);
  });

  it('ri=50 partial compound above baseline, never above equity, soft-capped by max_deposit', () => {
    const n = computeSignalTotalNotional(
      { ...base, reinvest_percent: 50, max_deposit: 5000 },
      50_000,
      'long',
      1,
      { walletEquity: 9000 },
    );
    // base = 5000 + (9000-5000)*0.5 = 7000; min(equity, max_deposit)=5000; ×10% = 500
    assert.equal(n, 500);
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
      { ...base, reinvest_percent: 100, max_deposit: 50_000 },
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

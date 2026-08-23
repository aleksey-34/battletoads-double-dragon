import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSameBarNoReentry } from './sameBarNoReentry';

describe('evaluateSameBarNoReentry', () => {
  const barMs = Date.parse('2026-08-22T12:00:00.000Z');

  it('blocks in-cycle re-entry after closedAction exit on same bar', () => {
    const res = evaluateSameBarNoReentry({
      state: 'flat',
      signal: 'long',
      closedAction: 'take_profit',
      lastAction: null,
      updatedAtMs: null,
      evaluatedBarTimeMs: barMs,
    });
    assert.equal(res.block, true);
    if (res.block) {
      assert.equal(res.action, 'take_profit_same_bar_no_reentry');
    }
  });

  it('blocks cross-cycle post-exit re-entry when updated_at is on current bar', () => {
    const res = evaluateSameBarNoReentry({
      state: 'flat',
      signal: 'short',
      closedAction: null,
      lastAction: 'desync_closed@1.02',
      updatedAtMs: barMs + 60_000,
      evaluatedBarTimeMs: barMs,
    });
    assert.equal(res.block, true);
    if (res.block) {
      assert.equal(res.action, 'post_exit_same_bar_no_reentry');
    }
  });

  it('allows entry on next bar after post-exit marker', () => {
    const res = evaluateSameBarNoReentry({
      state: 'flat',
      signal: 'long',
      closedAction: null,
      lastAction: 'post_exit_same_bar_no_reentry@1.01',
      updatedAtMs: barMs - 4 * 3600_000,
      evaluatedBarTimeMs: barMs,
    });
    assert.equal(res.block, false);
  });

  it('allows first entry when flat with no recent exit markers', () => {
    const res = evaluateSameBarNoReentry({
      state: 'flat',
      signal: 'long',
      closedAction: null,
      lastAction: 'entry_long',
      updatedAtMs: barMs - 3600_000,
      evaluatedBarTimeMs: barMs,
    });
    assert.equal(res.block, false);
  });
});

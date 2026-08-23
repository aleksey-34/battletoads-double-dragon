import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tradeDriftVsLive } from './tradeDriftVsLive';

describe('tradeDriftVsLive', () => {
  it('computes freqX as live/bt ratio', () => {
    const res = tradeDriftVsLive(
      { trades: 10, bySym: { BCHUSDT: { n: 2 } } },
      { n: 18, bySym: { BCHUSDT: { n: 12 } } },
    );
    assert.equal(res.freqX, 1.8);
    assert.ok(res.hot.some((h) => h.sym === 'BCHUSDT'));
  });

  it('returns null freqX when backtest has zero trades', () => {
    const res = tradeDriftVsLive(
      { trades: 0, bySym: {} },
      { n: 5, bySym: {} },
    );
    assert.equal(res.freqX, null);
  });

  it('flags hot symbol when live >> bt and live >= 8', () => {
    const res = tradeDriftVsLive(
      { trades: 2, bySym: { APEUSDT: { n: 2 } } },
      { n: 48, bySym: { APEUSDT: { n: 48 } } },
    );
    assert.equal(res.hot[0]?.sym, 'APEUSDT');
    assert.equal(res.hot[0]?.live, 48);
    assert.equal(res.hot[0]?.bt, 2);
  });

  it('does not flag low-volume drift', () => {
    const res = tradeDriftVsLive(
      { trades: 5, bySym: { BTCUSDT: { n: 3 } } },
      { n: 7, bySym: { BTCUSDT: { n: 5 } } },
    );
    assert.equal(res.hot.length, 0);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFearUnionActiveDates,
  lag1ActiveDates,
  lotMultiplierForFearDay,
  parseFearBoost,
} from './fearBoost';

describe('fearBoost lag-1', () => {
  it('activates D+1 and D+2 after a trigger close, not D itself', () => {
    assert.deepEqual(lag1ActiveDates(['2024-08-05'], 2), ['2024-08-06', '2024-08-07']);
  });

  it('unions BTC dump / SPX dump / VIX spike', () => {
    const btc = [
      { date: '2024-08-01', close: 100 },
      { date: '2024-08-02', close: 96 }, // −4%
      { date: '2024-08-03', close: 96 },
    ];
    const spx = [
      { date: '2024-08-01', close: 100 },
      { date: '2024-08-02', close: 100 },
      { date: '2024-08-03', close: 98 }, // −2%
    ];
    const vix = [
      { date: '2024-08-01', close: 10 },
      { date: '2024-08-02', close: 10 },
      { date: '2024-08-03', close: 10 },
      { date: '2024-08-04', close: 12 }, // +20%
    ];
    const { triggers, active } = computeFearUnionActiveDates(btc, spx, vix);
    assert.ok(triggers.includes('2024-08-02'));
    assert.ok(triggers.includes('2024-08-03'));
    assert.ok(triggers.includes('2024-08-04'));
    assert.ok(active.includes('2024-08-03'));
    assert.ok(!active.includes('2024-08-02'));
  });

  it('scales lot only on active days', () => {
    const cfg = parseFearBoost({ enabled: true, lotMultiplier: 1.25 });
    const active = new Set([Date.UTC(2024, 7, 6)]);
    const on = lotMultiplierForFearDay(cfg, 'ZZ_Fast', Date.UTC(2024, 7, 6, 15), active);
    const off = lotMultiplierForFearDay(cfg, 'ZZ_Fast', Date.UTC(2024, 7, 5, 15), active);
    assert.equal(on, 1.25);
    assert.equal(off, 1);
  });
});

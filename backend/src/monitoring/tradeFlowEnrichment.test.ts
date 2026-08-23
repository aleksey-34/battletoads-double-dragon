import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calcTradePnlPercent, enrichMonitoringTrades } from './tradeFlowEnrichment';

describe('monitoring trade flow enrichment', () => {
  it('classifies IN / OUT / REV and PnL on round-trip', () => {
    const rows = enrichMonitoringTrades([
      {
        id: 1,
        tradeType: 'entry',
        side: 'long',
        symbol: 'BCHUSDT',
        price: 100,
        time: '2026-08-10T00:00:00.000Z',
        strategyId: 256750,
      },
      {
        id: 2,
        tradeType: 'exit',
        side: 'long',
        symbol: 'BCHUSDT',
        price: 110,
        time: '2026-08-10T01:00:00.000Z',
        strategyId: 256750,
        entryPrice: 100,
      },
      {
        id: 3,
        tradeType: 'entry',
        side: 'short',
        symbol: 'BCHUSDT',
        price: 110,
        time: '2026-08-10T02:00:00.000Z',
        strategyId: 256750,
      },
    ]);

    const out = rows.find((r) => r.id === 2);
    const rev = rows.find((r) => r.id === 3);
    assert.equal(out?.flowType, 'out');
    assert.ok(out?.pnlPercent != null && Math.abs(out.pnlPercent - 10) < 0.001);
    assert.equal(rev?.flowType, 'reverse');
    assert.equal(rev?.pnlPercent, null);
  });

  it('calcTradePnlPercent short uses entry/exit inversion', () => {
    assert.equal(calcTradePnlPercent('short', 100, 90), 11.11111111111111);
  });
});

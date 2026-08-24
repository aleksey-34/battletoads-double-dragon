import {
  collapseEventsPerBar,
  reconstructMissingEntries,
  snapToChartCandle,
  StrategyTradeEvent,
} from './strategyChartOverlays';

const twoHourBars = () => {
  const start = Date.UTC(2026, 7, 24, 14, 0, 0);
  const bars: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const t = start + i * 2 * 3600 * 1000;
    const close = 0.10 + i * 0.02;
    bars.push([t, close, close + 0.01, close - 0.01, close]);
  }
  return bars;
};

describe('monitoring chart snap', () => {
  it('snaps a mid-bar fill onto the closed 2h candle', () => {
    const bars = twoHourBars();
    const fill = Date.UTC(2026, 7, 24, 17, 2, 0);
    const snap = snapToChartCandle(bars, fill);
    expect(snap?.time).toBe(bars[1][0]);
    expect(snap?.close).toBeCloseTo(0.12, 8);
  });

  it('keeps one event per closed bar', () => {
    const bars = twoHourBars();
    const events: StrategyTradeEvent[] = [
      {
        id: 1,
        strategyId: 1,
        tradeType: 'entry',
        side: 'short',
        symbol: 'ORDIUSDT',
        price: 5,
        qtyUsdt: 10,
        timestamp: bars[1][0] + 60_000,
      },
      {
        id: 2,
        strategyId: 1,
        tradeType: 'exit',
        side: 'short',
        symbol: 'ORDIUSDT',
        price: 4.8,
        qtyUsdt: 10,
        timestamp: bars[1][0] + 90_000,
      },
    ];
    const collapsed = collapseEventsPerBar(events, bars);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].tradeType).toBe('exit');
  });

  it('reconstructs a missing IN from exit entryPrice', () => {
    const bars = twoHourBars();
    const events: StrategyTradeEvent[] = [{
      id: 9,
      strategyId: 44,
      tradeType: 'exit',
      side: 'long',
      symbol: 'ENAUSDT',
      price: 0.16,
      qtyUsdt: 20,
      timestamp: bars[3][0] + 62_000,
      entryPrice: 0.10,
    }];
    const withEntry = reconstructMissingEntries(events, bars);
    expect(withEntry.some((e) => e.tradeType === 'entry' && e.side === 'long')).toBe(true);
  });
});

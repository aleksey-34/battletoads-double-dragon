import {
  buildSynthStrategyMap,
  calcTradePnlPercent,
  collapseSynthTradeLegs,
  enrichMonitoringTrades,
  synthRatioFromCoins,
} from './monitoringTradeEnrichment';

describe('synth monitoring PnL', () => {
  const synthMap = buildSynthStrategyMap([{
    id: 256751,
    market_mode: 'synthetic',
    base_symbol: 'INJUSDT',
    quote_symbol: 'TIAUSDT',
    base_coef: 1,
    quote_coef: 1,
  }]);

  it('rebuilds list PnL from synth ratio, not mixed coin/ratio', () => {
    const rows = enrichMonitoringTrades([
      {
        id: 1,
        tradeType: 'exit',
        side: 'long',
        symbol: 'INJUSDT',
        price: 5.47,
        size: 1,
        fee: 0,
        time: '2026-08-24T10:00:00.000Z',
        strategyId: 256751,
        entryPrice: 12.2,
      },
      {
        id: 2,
        tradeType: 'exit',
        side: 'short',
        symbol: 'TIAUSDT',
        price: 0.37,
        size: 1,
        fee: 0,
        time: '2026-08-24T10:00:05.000Z',
        strategyId: 256751,
        entryPrice: 12.2,
      },
    ], synthMap);

    const grouped = collapseSynthTradeLegs(rows, synthMap, true);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].synthGrouped).toBe(true);
    const exitRatio = synthRatioFromCoins(5.47, 0.37, 1, 1);
    expect(grouped[0].pnlPercent).toBeCloseTo(
      Number(calcTradePnlPercent('long', 12.2, Number(exitRatio))),
      5,
    );
  });

  it('keeps coin PnL on expanded legs when fills exist', () => {
    const rows = enrichMonitoringTrades([
      {
        id: 1,
        tradeType: 'entry',
        side: 'long',
        symbol: 'INJUSDT',
        price: 5.0,
        size: 1,
        fee: 0,
        time: '2026-08-24T09:00:00.000Z',
        strategyId: 256751,
      },
      {
        id: 2,
        tradeType: 'exit',
        side: 'long',
        symbol: 'INJUSDT',
        price: 5.5,
        size: 1,
        fee: 0,
        time: '2026-08-24T10:00:00.000Z',
        strategyId: 256751,
        entryPrice: 14,
      },
    ], synthMap);

    const injOut = rows.find((row) => row.id === 2);
    expect(injOut?.pnlPercent).toBeCloseTo(10, 5);
  });

  it('does not treat ratio vs coin fill as a valid %', () => {
    expect(calcTradePnlPercent('long', 14, 5.47)).toBeNull();
  });
});

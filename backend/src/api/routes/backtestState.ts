/** Shared mutex for concurrent backtest runs (API + trading-system backtest). */
export const backtestState = {
  runInProgress: false,
};

/**
 * Shared strategy types (extracted from bot/strategy.ts).
 */
import type { Strategy, StrategyType } from '../../config/settings';

export type StrategySignal = 'long' | 'short' | 'none';

export type StrategyDraft = Partial<Strategy> & {
  name?: string;
};

export type ParsedSyntheticCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type StrategyExecutionSource = 'manual' | 'auto';

export type ExecuteStrategyOptions = {
  source?: StrategyExecutionSource;
  closedBarOnly?: boolean;
  dedupeClosedBar?: boolean;
};

export type ExecutionCandleContext = {
  candlesForSignal: ParsedSyntheticCandle[];
  evaluatedBarTimeMs: number;
};

export type ComputedSignal = {
  signal: StrategySignal;
  currentRatio: number;
  donchianHigh: number;
  donchianLow: number;
  donchianCenter: number;
  zScore: number | null;
  fastRsi?: number | null;
};

export type GetStrategiesOptions = {
  includeLotPreview?: boolean;
  limit?: number;
  offset?: number;
  marketType?: 'futures' | 'spot' | 'all';
};

export type StrategySummary = Pick<
  Strategy,
  'id' | 'name' | 'strategy_type' | 'market_mode' | 'is_active' | 'base_symbol' | 'quote_symbol' | 'interval' | 'base_coef' | 'quote_coef' | 'state' | 'last_action' | 'last_error' | 'updated_at'
> & {
  is_runtime: boolean;
  is_archived: boolean;
  origin: string;
};
